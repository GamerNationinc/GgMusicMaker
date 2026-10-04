<script lang="ts">
  import { tempoOf, barSeconds, beatSeconds } from "../seq/tempo";
  import {
    project,
    transport,
    pixelsPerSecond,
    selectedClipId,
    engine,
    seek,
    selectClip,
    moveClipTo,
    trimClipTo,
    liveRecording,
  } from "../state/store";
  import { getSummary, columnStats, type ColumnStats } from "../render/peaks";
  import { clipEnd, projectDuration } from "../audio/edits";
  import type { Clip, Track } from "../audio/types";
  import { LANE_HEIGHT, HEAD_WIDTH, RULER_HEIGHT, ZOOM_MIN, ZOOM_MAX } from "./constants";
  import { nav, registerTimeline, follow, followHeld } from "./timelineNav";
  import { Glide, fitRange, followScroll, zoomAround } from "./navMath";
  import { wheelGuard } from "../input/controller";
  import TrackHead from "./TrackHead.svelte";
  import { theme } from "./themeStore";
  import { laneColor } from "./themes";
  import { punchPreviewFor, previewTick } from "./punchPreviewStore";
  import type { PunchPreview } from "../render/punchPreview";
  import { onMount, tick } from "svelte";

  let laneCanvas: HTMLCanvasElement;
  let rulerCanvas: HTMLCanvasElement;
  let lanesScroll: HTMLDivElement;
  let rulerScroll: HTMLDivElement;
  let bodyEl: HTMLDivElement;
  let lanesEl: HTMLDivElement;

  const EDGE = 8; // px hit zone for edge-trim

  /** Where the take being recorded ends right now (it may run past the song). */
  const liveEnd = $derived.by(() => {
    if (!$liveRecording) return 0;
    void $liveRecording.tick;
    return $liveRecording.start + (engine.liveTake()?.seconds ?? 0);
  });
  let contentWidth = $derived(Math.max(projectDuration($project) + 4, liveEnd + 4, 30) * $pixelsPerSecond);
  let contentHeight = $derived(Math.max(1, $project.tracks.length) * LANE_HEIGHT);

  // The canvases only ever cover what is on screen. One canvas the size of
  // the whole song × every layer blew past WebKit's canvas-size limit
  // (≈ 16 M pixels) at around ten layers or a few minutes of audio, and a
  // canvas over the limit silently draws nothing — that was the missing
  // waveforms. The .lanes div still has the full size, for the scrollbars.
  let view = $state({ x: 0, y: 0, w: 0, h: 0 });

  function measure() {
    if (!lanesScroll || !bodyEl) return;
    const x = lanesScroll.scrollLeft;
    const y = bodyEl.scrollTop;
    const w = Math.max(1, Math.min(lanesScroll.clientWidth, contentWidth - x));
    const h = Math.max(1, Math.min(bodyEl.clientHeight, contentHeight - y));
    if (x !== view.x || y !== view.y || w !== view.w || h !== view.h) view = { x, y, w, h };
  }

  /** Ruler/grid spacing so labels stay ~70 px apart at any zoom. */
  const STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  function gridStep(pps: number): number {
    for (const s of STEPS) if (s * pps >= 70) return s;
    return 600;
  }
  function timeLabel(t: number, step: number): string {
    const m = Math.floor(t / 60);
    const sec = t - m * 60;
    const digits = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
    const ss = sec.toFixed(digits).padStart(digits ? 3 + digits : 2, "0");
    return m > 0 ? `${m}:${ss}` : `${sec.toFixed(digits)}s`;
  }

  // ---- drawing ------------------------------------------------------------

  function sizeCanvas(c: HTMLCanvasElement, w: number, h: number) {
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function drawLanes() {
    if (!laneCanvas) return;
    const { x: vx, y: vy, w, h } = view;
    if (w <= 1 && h <= 1) return;
    const pps = $pixelsPerSecond;
    const ctx = sizeCanvas(laneCanvas, w, h);
    laneCanvas.style.left = `${vx}px`;
    laneCanvas.style.top = `${vy}px`;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(-vx, -vy);
    const k = $theme.tokens;
    const step = gridStep(pps);
    const first = Math.max(0, Math.floor(vy / LANE_HEIGHT));
    const last = Math.min($project.tracks.length - 1, Math.floor((vy + h) / LANE_HEIGHT));

    for (let ti = first; ti <= last; ti++) {
      const track = $project.tracks[ti];
      const y = ti * LANE_HEIGHT;
      ctx.fillStyle = ti % 2 ? k["lane-b"] : k["lane-a"];
      ctx.fillRect(vx, y, w, LANE_HEIGHT);
      ctx.strokeStyle = k.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let t = Math.floor(vx / pps / step) * step; t * pps < vx + w; t += step) {
        const x = Math.round(t * pps) + 0.5;
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + LANE_HEIGHT);
      }
      ctx.stroke();
      for (const clip of track.clips) {
        const cx = clip.startTime * pps;
        if (cx > vx + w || cx + clip.duration * pps < vx) continue;
        drawClip(ctx, track, clip, laneColor($theme, track.color), y);
      }
      if ($liveRecording?.trackId === track.id) drawLiveTake(ctx, y);
    }
    ctx.restore();
  }

  const st: ColumnStats = { min: 0, max: 0, rms: 0 };
  const SILENT = 0.0032; // −50 dBFS: drawn as a flat line so dead space stands out

  function drawClip(ctx: CanvasRenderingContext2D, track: Track, clip: Clip, color: string, laneY: number) {
    const pps = $pixelsPerSecond;
    const x = clip.startTime * pps;
    const cw = Math.max(2, clip.duration * pps);
    const pad = 4;
    const top = laneY + pad;
    const clipH = LANE_HEIGHT - pad * 2;
    const selected = clip.id === $selectedClipId;
    const k = $theme.tokens;
    const { x: vx, w: vw } = view;
    // Only the on-screen part of a long clip is drawn (rects clipped to the view).
    const x0 = Math.max(x, vx - 2), x1 = Math.min(x + cw, vx + vw + 2);

    if (k.extrude !== "none") {
      ctx.fillStyle = "#000";
      ctx.fillRect(x0 + 2, top + 2, x1 - x0, clipH);
    }
    ctx.fillStyle = k["clip-bg"];
    ctx.fillRect(x0, top, x1 - x0, clipH);
    if (selected) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.14;
      ctx.fillRect(x0, top, x1 - x0, clipH);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = selected ? k.ink : color;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(x + 0.5, top + 0.5, cw - 1, clipH - 1);

    // Header strip + name (the name follows the view so a long clip keeps it visible).
    ctx.fillStyle = color;
    ctx.fillRect(x0, top, x1 - x0, 13);
    ctx.fillStyle = k["on-accent"];
    ctx.font = "bold 10px 'DejaVu Sans Mono', monospace";
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 3, top, cw - 6, 13);
    ctx.clip();
    ctx.fillText(clip.name, Math.max(x, vx) + 4, top + 10);
    ctx.restore();

    const buffer = engine.getBuffer(clip.bufferId);
    if (!buffer) return;
    const sum = getSummary(buffer);
    const sr = buffer.sampleRate;
    const spp = sr / pps; // samples per pixel
    const wfTop = top + 15;
    const wfH = clipH - 17;
    const punch = punchPreviewFor(track, clip.bufferId);

    const colStart = Math.floor(Math.max(0, x0 - x));
    const colEnd = Math.ceil(Math.min(cw, x1 - x));
    const sampleAt = (col: number) => (clip.offset + col / pps) * sr;

    if (punch) {
      drawPunched(ctx, punch.preview, punch.fresh, sum, buffer, x, colStart, colEnd, sampleAt, spp, wfTop, wfH, color);
      return;
    }

    // Ableton-style: one band per channel, peak envelope filled at half
    // strength with the RMS body solid inside it.
    // Split L/R only when the lane is tall enough for both to read; on the
    // Deck's 96 px lanes one combined band shows the shape twice as big.
    const lanesN = sum.channels === 2 && wfH >= 120 ? 2 : 1;
    const bandH = wfH / lanesN;
    // Display gain (like Ableton's lane): the file's loudest peak fills the
    // band, so quiet recordings are readable. Capped so noise stays low;
    // silence stays a flat line either way.
    const disp = Math.min(8, 0.95 / Math.max(1e-4, sum.peak));
    for (let ch = 0; ch < lanesN; ch++) {
      const mid = wfTop + bandH * ch + bandH / 2;
      const half = bandH / 2 - 1;
      for (let col = colStart; col < colEnd; col++) {
        const s0 = sampleAt(col);
        if (lanesN === 1 && sum.channels === 2) {
          // Mono view of a stereo file: the louder side wins.
          columnStats(sum, buffer, 0, s0, s0 + spp, st);
          const a = { ...st };
          columnStats(sum, buffer, 1, s0, s0 + spp, st);
          st.min = Math.min(a.min, st.min);
          st.max = Math.max(a.max, st.max);
          st.rms = Math.max(a.rms, st.rms);
        } else columnStats(sum, buffer, ch, s0, s0 + spp, st);
        const px = x + col;
        if (st.max - st.min < SILENT * 2) {
          ctx.fillStyle = k.grid;
          ctx.fillRect(px, mid, 1, 1);
          continue;
        }
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.45;
        const yTop = mid - Math.min(1, st.max * disp) * half;
        const yBot = mid - Math.max(-1, st.min * disp) * half;
        ctx.fillRect(px, yTop, 1, Math.max(1, yBot - yTop));
        ctx.globalAlpha = 1;
        const r = Math.min(1, st.rms * disp) * half;
        ctx.fillRect(px, mid - r, 1, Math.max(1, 2 * r));
      }
    }
    // Faint centre line(s) through the whole visible clip.
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.25;
    for (let ch = 0; ch < lanesN; ch++) ctx.fillRect(x + colStart, wfTop + bandH * ch + bandH / 2, colEnd - colStart, 1);
    ctx.globalAlpha = 1;
  }

  /** PUNCH engaged: draw what it does — the processed waveform against
   *  full-scale guides, the bass body before (outline) and after (solid),
   *  and red where samples would go over 0 dBFS. */
  function drawPunched(
    ctx: CanvasRenderingContext2D,
    pv: PunchPreview,
    fresh: boolean,
    sum: ReturnType<typeof getSummary>,
    buffer: AudioBuffer,
    x: number,
    colStart: number,
    colEnd: number,
    sampleAt: (col: number) => number,
    spp: number,
    wfTop: number,
    wfH: number,
    color: string,
  ) {
    const k = $theme.tokens;
    const mid = wfTop + wfH / 2;
    const half = wfH / 2 - 1;
    const fs = half * 0.78; // full scale sits inside the lane so "over" has room to show
    ctx.globalAlpha = fresh ? 1 : 0.5; // stale while the new preview renders
    for (let col = colStart; col < colEnd; col++) {
      const s0 = sampleAt(col);
      const b0 = Math.max(0, Math.floor(s0 / pv.bucket));
      const b1 = Math.min(pv.buckets, Math.max(b0 + 1, Math.ceil((s0 + spp) / pv.bucket)));
      let mn = 0, mx = 0, over = 0, li = 0, lo = 0;
      for (let b = b0; b < b1; b++) {
        if (pv.min[b] < mn) mn = pv.min[b];
        if (pv.max[b] > mx) mx = pv.max[b];
        over += pv.over[b];
        li += pv.lowIn[b];
        lo += pv.lowOut[b];
      }
      const n = Math.max(1, (b1 - b0) * pv.bucket);
      const px = x + col;
      // Processed envelope.
      ctx.fillStyle = color;
      const saved = ctx.globalAlpha;
      ctx.globalAlpha = saved * 0.5;
      const yTop = mid - Math.min(1.25, mx) * fs;
      const yBot = mid - Math.max(-1.25, mn) * fs;
      ctx.fillRect(px, yTop, 1, Math.max(1, yBot - yTop));
      ctx.globalAlpha = saved;
      // Bass: solid body after PUNCH, the original level as a tick.
      const lowAfter = Math.min(1.25, Math.sqrt(lo / n) * 1.6) * fs;
      const lowBefore = Math.min(1.25, Math.sqrt(li / n) * 1.6) * fs;
      ctx.fillStyle = k.magenta;
      ctx.fillRect(px, mid - lowAfter, 1, Math.max(1, 2 * lowAfter));
      ctx.fillStyle = k.ink;
      ctx.fillRect(px, mid - lowBefore, 1, 1);
      ctx.fillRect(px, mid + lowBefore, 1, 1);
      // Over full scale: red caps top and bottom.
      if (over > 0) {
        ctx.fillStyle = k.danger;
        ctx.fillRect(px, wfTop, 1, 4);
        ctx.fillRect(px, wfTop + wfH - 4, 1, 4);
        ctx.globalAlpha = saved * 0.35;
        ctx.fillRect(px, wfTop + 4, 1, wfH - 8);
        ctx.globalAlpha = saved;
      }
    }
    ctx.globalAlpha = 1;
    // 0 dBFS guides.
    ctx.strokeStyle = k.danger;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x + colStart, Math.round(mid - fs) + 0.5);
    ctx.lineTo(x + colEnd, Math.round(mid - fs) + 0.5);
    ctx.moveTo(x + colStart, Math.round(mid + fs) + 0.5);
    ctx.lineTo(x + colEnd, Math.round(mid + fs) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    void sum;
    void buffer;
  }

  /** The take being recorded, drawn as it grows (Ableton-style): a red clip
   *  from where recording began to now, its waveform filled in as audio
   *  arrives. Replaced by the real clip when recording stops. */
  function drawLiveTake(ctx: CanvasRenderingContext2D, laneY: number) {
    const rec = $liveRecording;
    const live = engine.liveTake();
    if (!rec || !live) return;
    const pps = $pixelsPerSecond;
    const k = $theme.tokens;
    const red = k.danger;
    const x = rec.start * pps;
    const cw = Math.max(2, live.seconds * pps);
    const { x: vx, w: vw } = view;
    const x0 = Math.max(x, vx - 2), x1 = Math.min(x + cw, vx + vw + 2);
    if (x1 <= x0) return;
    const pad = 4;
    const top = laneY + pad;
    const clipH = LANE_HEIGHT - pad * 2;
    ctx.fillStyle = k["clip-bg"];
    ctx.fillRect(x0, top, x1 - x0, clipH);
    ctx.fillStyle = red;
    ctx.globalAlpha = 0.16;
    ctx.fillRect(x0, top, x1 - x0, clipH);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = red;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, top + 0.5, cw - 1, clipH - 1);
    // Header: blinking dot + running length.
    ctx.fillStyle = red;
    ctx.fillRect(x0, top, x1 - x0, 13);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 3, top, Math.max(0, cw - 6), 13);
    ctx.clip();
    ctx.fillStyle = k["on-accent"];
    ctx.font = "bold 10px 'DejaVu Sans Mono', monospace";
    const dot = rec.tick % 10 < 6 ? "●" : "○";
    ctx.fillText(`${dot} REC ${live.seconds.toFixed(1)}s`, Math.max(x + 3, vx + 3), top + 10);
    ctx.restore();
    // Waveform, one column per pixel, from the live min/max summary.
    const wfTop = top + 15, wfH = clipH - 17, mid = wfTop + wfH / 2;
    ctx.strokeStyle = red;
    ctx.beginPath();
    for (let px = Math.floor(x0); px < x1; px++) {
      const r = live.range((px - x) / pps, (px + 1 - x) / pps);
      if (!r) break;
      const lo = Math.max(-1, r[0]), hi = Math.min(1, r[1]);
      ctx.moveTo(px + 0.5, mid - hi * (wfH / 2));
      ctx.lineTo(px + 0.5, mid - lo * (wfH / 2) + 1);
    }
    ctx.stroke();
  }

  function drawRuler() {
    if (!rulerCanvas) return;
    const pps = $pixelsPerSecond;
    const vx = view.x;
    const w = Math.max(1, rulerScroll?.clientWidth ?? view.w);
    const ctx = sizeCanvas(rulerCanvas, w, RULER_HEIGHT);
    rulerCanvas.style.left = `${vx}px`;
    const k = $theme.tokens;
    ctx.fillStyle = k["panel-lo"];
    ctx.fillRect(0, 0, w, RULER_HEIGHT);
    ctx.fillStyle = k["ink-dim"];
    ctx.strokeStyle = k.box;
    ctx.font = "10px 'DejaVu Sans Mono', monospace";
    // Bars at the project tempo: a tick and the bar number, thinned out
    // when they'd crowd (every 2nd, 4th… bar), beats when there's room.
    const tempo = tempoOf($project);
    const bar = barSeconds(tempo);
    let every = 1;
    while (bar * every * pps < 28) every *= 2;
    const beatPx = beatSeconds(tempo) * pps;
    ctx.save();
    ctx.strokeStyle = k.amber ?? k.box;
    ctx.fillStyle = k.amber ?? k["ink-dim"];
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for (let b = Math.max(0, Math.floor(vx / pps / bar)); b * bar * pps < vx + w; b++) {
      const x = Math.round(b * bar * pps - vx) + 0.5;
      if (b % every === 0) {
        ctx.moveTo(x, RULER_HEIGHT - 14);
        ctx.lineTo(x, RULER_HEIGHT);
        ctx.fillText(String(b + 1), x + 3, RULER_HEIGHT - 4);
      }
      if (beatPx >= 10) {
        for (let q = 1; q < tempo.beatsPerBar; q++) {
          const bx = Math.round(x + q * beatPx);
          ctx.moveTo(bx + 0.5, RULER_HEIGHT - 4);
          ctx.lineTo(bx + 0.5, RULER_HEIGHT);
        }
      }
    }
    ctx.stroke();
    ctx.restore();
    const step = gridStep(pps);
    ctx.beginPath();
    for (let t = Math.floor(vx / pps / step) * step; t * pps < vx + w; t += step) {
      const x = Math.round(t * pps - vx) + 0.5;
      ctx.moveTo(x, RULER_HEIGHT - 8);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.fillText(timeLabel(Math.round(t / step) * step, step), x + 3, 12);
    }
    ctx.stroke();
  }

  // Redraw whenever structure / zoom / selection / view / previews change.
  $effect(() => {
    void $project;
    void $pixelsPerSecond;
    void $selectedClipId;
    void $theme;
    void $previewTick;
    void $liveRecording;
    void view;
    drawLanes();
    drawRuler();
  });
  // Content size changes (zoom, new layers) move the visible window too.
  $effect(() => {
    void contentWidth;
    void contentHeight;
    queueMicrotask(measure);
  });

  // Scroll events already arrive at most once per frame; measuring straight
  // away (no rAF) also keeps the lanes right in a window that isn't painting
  // (hidden, or a test run), where animation frames never fire.
  function onScroll() {
    if (rulerScroll && lanesScroll) rulerScroll.scrollLeft = lanesScroll.scrollLeft;
    measure();
  }

  onMount(() => {
    const ro = new ResizeObserver(() => measure());
    ro.observe(lanesScroll);
    ro.observe(bodyEl);
    measure();
    registerTimeline({ apply, fit });
    // Not passive: ctrl+wheel must not zoom the whole page.
    timelineEl.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      registerTimeline(null);
      timelineEl.removeEventListener("wheel", onWheel);
    };
  });

  // ---- navigation (see timelineNav.ts) -------------------------------------

  let timelineEl: HTMLDivElement;
  let rulerRow: HTMLDivElement;

  /** Zoom anchor when none is given: the playhead if it's on screen, else the middle. */
  function defaultAnchor(): number {
    const w = lanesScroll.clientWidth;
    const x = $transport.playhead * $pixelsPerSecond - lanesScroll.scrollLeft;
    return x >= 0 && x <= w ? x : w / 2;
  }

  /** Set zoom + horizontal scroll together: the scroll has to wait for the
   *  lanes to take their new width, or the browser clamps it to the old one. */
  async function setView(pps: number, scrollLeft: number) {
    if (pps !== $pixelsPerSecond) {
      pixelsPerSecond.set(pps);
      await tick();
    }
    lanesScroll.scrollLeft = scrollLeft;
    measure();
  }

  function apply(dx: number, dy: number, zoom: number, anchorPx: number | null) {
    if (!lanesScroll || !bodyEl) return;
    bodyEl.scrollTop += dy;
    if (zoom === 1) {
      lanesScroll.scrollLeft += dx;
      return;
    }
    const r = zoomAround($pixelsPerSecond, lanesScroll.scrollLeft + dx, anchorPx ?? defaultAnchor(), zoom, ZOOM_MIN, ZOOM_MAX);
    void setView(r.pps, r.scrollLeft);
  }

  function fit(range?: [number, number]) {
    if (!lanesScroll) return;
    const w = lanesScroll.clientWidth - 2;
    if (range) {
      const r = fitRange(range[0], range[1], w, ZOOM_MIN, ZOOM_MAX);
      void setView(r.pps, r.scrollLeft);
    } else {
      // The timeline always shows 4 s past the end (min 30 s) — fit that.
      void setView(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, w / Math.max(projectDuration($project) + 4, 30))), 0);
    }
  }

  /** Mouse wheel / touchpad. Ctrl (or a touchpad pinch) zooms at the pointer;
   *  Shift, the ruler, or a timeline with no layers to scroll through scroll
   *  sideways; otherwise the layers scroll as usual. */
  function onWheel(e: WheelEvent) {
    if (wheelGuard()) {
      // The Deck's left pad is driving the timeline itself; Steam's own
      // scroll-wheel emulation of that pad must not scroll it twice.
      e.preventDefault();
      return;
    }
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? lanesScroll.clientWidth : 1;
    const dy = e.deltaY * unit, dx = e.deltaX * unit;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      nav.zoomBy(Math.exp(-dy * 0.002), e.clientX - lanesScroll.getBoundingClientRect().left);
      return;
    }
    const noLayersToScroll = bodyEl.scrollHeight <= bodyEl.clientHeight + 1;
    if (e.shiftKey || rulerRow.contains(e.target as Node) || (noLayersToScroll && dx === 0)) {
      e.preventDefault();
      nav.scrollBy(dy + dx, 0);
    }
  }

  // Follow: turn the page when the playhead runs off the view.
  $effect(() => {
    const ph = $transport.playhead;
    if (!$transport.isPlaying || !$follow || !lanesScroll || followHeld() || drag || pinch || pan || rulerDrag) return;
    const s = followScroll(ph * $pixelsPerSecond, lanesScroll.scrollLeft, lanesScroll.clientWidth);
    if (s !== null) {
      lanesScroll.scrollLeft = s;
      measure();
    }
  });

  // ---- interaction --------------------------------------------------------

  type Drag =
    | { kind: "move"; trackId: string; clipId: string; grab: number }
    | { kind: "trim-l" | "trim-r"; trackId: string; clipId: string; fixedStart: number; fixedEnd: number }
    | null;
  let drag: Drag = null;

  function eventTime(e: PointerEvent): number {
    const rect = lanesEl.getBoundingClientRect();
    return Math.max(0, (e.clientX - rect.left) / $pixelsPerSecond);
  }

  /** Capture can refuse (a pointer that has already gone): carry on uncaptured. */
  function capture(el: Element, id: number) {
    try {
      el.setPointerCapture(id);
    } catch {
      /* not capturable */
    }
  }

  function onPointerDown(e: PointerEvent) {
    nav.stopGlide();
    const touch = e.pointerType === "touch";
    if (touch) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      capture(lanesEl, e.pointerId);
      if (touches.size === 2) {
        // Second finger: whatever the first one started becomes a pinch.
        drag = null;
        pan = null;
        startPinch();
        return;
      }
      if (touches.size > 2) return;
    }
    const rect = lanesEl.getBoundingClientRect();
    const time = eventTime(e);
    const ti = Math.floor((e.clientY - rect.top) / LANE_HEIGHT);
    const track = $project.tracks[ti];
    const empty = () => {
      if (touch) {
        pan = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, time };
        return;
      }
      selectClip(null);
      seek(time);
    };
    if (!track) {
      empty();
      return;
    }
    const pps = $pixelsPerSecond;
    const x = time * pps;
    // Find the clip under the cursor (topmost / last wins).
    let hit: Clip | undefined;
    for (const clip of track.clips) {
      const cx = clip.startTime * pps;
      const cxEnd = clipEnd(clip) * pps;
      if (x >= cx && x <= cxEnd) hit = clip;
    }
    if (!hit) {
      empty();
      return;
    }
    selectClip(hit.id);
    const cx = hit.startTime * pps;
    const cxEnd = clipEnd(hit) * pps;
    if (Math.abs(x - cx) <= EDGE) {
      drag = { kind: "trim-l", trackId: track.id, clipId: hit.id, fixedStart: hit.startTime, fixedEnd: clipEnd(hit) };
    } else if (Math.abs(x - cxEnd) <= EDGE) {
      drag = { kind: "trim-r", trackId: track.id, clipId: hit.id, fixedStart: hit.startTime, fixedEnd: clipEnd(hit) };
    } else {
      drag = { kind: "move", trackId: track.id, clipId: hit.id, grab: time - hit.startTime };
    }
    capture(lanesEl, e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (e.pointerType === "touch" && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size >= 2) {
        movePinch();
        return;
      }
      if (pan) {
        const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
        pan.x = e.clientX;
        pan.y = e.clientY;
        if (!pan.moved && Math.hypot(e.clientX - pan.sx, e.clientY - pan.sy) < 8) return;
        pan.moved = true;
        // Content follows the finger.
        lanesScroll.scrollLeft -= dx;
        bodyEl.scrollTop -= dy;
        touchGlide.track(performance.now(), -dx, -dy);
        return;
      }
    }
    if (!drag) return;
    const time = eventTime(e);
    if (drag.kind === "move") {
      moveClipTo(drag.trackId, drag.clipId, time - drag.grab);
    } else if (drag.kind === "trim-l") {
      trimClipTo(drag.trackId, drag.clipId, Math.min(time, drag.fixedEnd - 0.02), drag.fixedEnd);
    } else {
      trimClipTo(drag.trackId, drag.clipId, drag.fixedStart, Math.max(time, drag.fixedStart + 0.02));
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (e.pointerType === "touch") {
      touches.delete(e.pointerId);
      if (pinch && touches.size < 2) {
        pinch = null;
        // The finger left behind doesn't start anything new.
        touches.clear();
      }
      if (pan) {
        if (!pan.moved) {
          selectClip(null);
          seek(pan.time);
        } else if (touchGlide.release(performance.now())) {
          nav.fling(touchGlide.vx, touchGlide.vy);
        }
        touchGlide.stop();
        pan = null;
      }
    }
    drag = null;
    try {
      lanesEl.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  }

  // Ruler: click = jump there. Drag = Ableton's zoom drag: down zooms in,
  // up zooms out, and the time you grabbed stays under the pointer, so
  // sideways scrolls. Double-click = whole song.
  let rulerDrag: { x0: number; y0: number; pps0: number; t: number; moved: boolean } | null = null;

  function rulerX(e: PointerEvent): number {
    return e.clientX - rulerScroll.getBoundingClientRect().left;
  }

  function onRulerDown(e: PointerEvent) {
    nav.stopGlide();
    const t = Math.max(0, (rulerX(e) + lanesScroll.scrollLeft) / $pixelsPerSecond);
    rulerDrag = { x0: e.clientX, y0: e.clientY, pps0: $pixelsPerSecond, t, moved: false };
    capture(rulerCanvas, e.pointerId);
  }

  function onRulerMove(e: PointerEvent) {
    if (!rulerDrag) return;
    const dy = e.clientY - rulerDrag.y0;
    if (!rulerDrag.moved && Math.hypot(e.clientX - rulerDrag.x0, dy) < 4) return;
    rulerDrag.moved = true;
    const pps = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, rulerDrag.pps0 * Math.exp(dy * 0.012)));
    void setView(pps, Math.max(0, rulerDrag.t * pps - rulerX(e)));
  }

  function onRulerUp(e: PointerEvent) {
    if (rulerDrag && !rulerDrag.moved) seek(rulerDrag.t);
    rulerDrag = null;
    try {
      rulerCanvas.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  }

  // ---- touch: one finger on empty lane pans (flick to glide), tap seeks;
  // two fingers pinch-zoom round their midpoint and pan together. A finger
  // on a clip still moves / trims it.
  const touches = new Map<number, { x: number; y: number }>();
  let pan: { x: number; y: number; sx: number; sy: number; moved: boolean; time: number } | null = null;
  let pinch: { d0: number; pps0: number; t: number; my: number } | null = null;
  const touchGlide = new Glide();

  function startPinch() {
    const [a, b] = [...touches.values()];
    const mx = (a.x + b.x) / 2 - lanesScroll.getBoundingClientRect().left;
    pinch = {
      d0: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)),
      pps0: $pixelsPerSecond,
      t: (lanesScroll.scrollLeft + mx) / $pixelsPerSecond,
      my: (a.y + b.y) / 2,
    };
  }

  function movePinch() {
    if (!pinch) return;
    const [a, b] = [...touches.values()];
    const d = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
    const mx = (a.x + b.x) / 2 - lanesScroll.getBoundingClientRect().left;
    const my = (a.y + b.y) / 2;
    const pps = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (pinch.pps0 * d) / pinch.d0));
    bodyEl.scrollTop -= my - pinch.my;
    pinch.my = my;
    void setView(pps, Math.max(0, pinch.t * pps - mx));
  }
</script>

<div class="timeline" bind:this={timelineEl}>
  <!-- Ruler row: corner + scrollable ruler -->
  <div class="ruler-row" style:height="{RULER_HEIGHT}px" bind:this={rulerRow}>
    <div class="corner" style:width="{HEAD_WIDTH}px">
      <span class="label">LAYERS</span>
      <button
        class="follow"
        class:on={$follow}
        onclick={() => nav.toggleFollow()}
        aria-pressed={$follow}
        title="Follow: the view turns the page with the playhead (F)">⇥ FOLLOW</button>
    </div>
    <div class="ruler-scroll" bind:this={rulerScroll}>
      <div class="ruler-track" style:width="{contentWidth}px" style:height="{RULER_HEIGHT}px">
        <canvas
          bind:this={rulerCanvas}
          onpointerdown={onRulerDown}
          onpointermove={onRulerMove}
          onpointerup={onRulerUp}
          onpointercancel={onRulerUp}
          ondblclick={() => nav.fit()}
          title="Click: jump · drag down/up: zoom in/out · drag sideways: scroll · double-click: whole song"
          style:height="{RULER_HEIGHT}px"
        ></canvas>
      </div>
    </div>
  </div>

  <!-- Body: heads + lanes share vertical scroll -->
  <div class="body" bind:this={bodyEl} onscroll={onScroll}>
    <div class="heads" style:width="{HEAD_WIDTH}px">
      {#each $project.tracks as track (track.id)}
        <TrackHead {track} />
      {/each}
      {#if $project.tracks.length === 0}
        <div class="empty label">Import audio or add a layer to start.</div>
      {/if}
    </div>

    <div class="lanes-scroll" bind:this={lanesScroll} onscroll={onScroll}>
      <div class="lanes" bind:this={lanesEl} style:width="{contentWidth}px" style:height="{contentHeight}px" onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp} role="presentation">
        <canvas bind:this={laneCanvas}></canvas>
        <div class="playhead" style:left="{$transport.playhead * $pixelsPerSecond}px"></div>
      </div>
    </div>
  </div>
</div>

<style>
  .timeline {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    background: transparent; /* the rain shows through the void */
  }
  .ruler-row {
    display: flex;
    flex: 0 0 auto;
    background: var(--panel-lo);
  }
  .corner {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 0 10px;
    border-right: 1px solid var(--box);
    border-bottom: 1px solid var(--box);
  }
  .ruler-scroll {
    flex: 1 1 auto;
    overflow: hidden;
  }
  .body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .heads {
    flex: 0 0 auto;
    border-right: 1px solid var(--box);
    background: var(--panel);
  }
  .empty {
    padding: 20px 12px;
    line-height: 1.6;
  }
  .lanes-scroll {
    flex: 1 1 auto;
    overflow-x: auto;
    overflow-y: hidden;
    /* Size to the lanes, not to the visible body. WebKit (the Deck's engine)
       stretches a flex item that is a scroll container to the parent's
       *visible* height, so with overflow-y hidden every lane below the
       first screenful was clipped away — the blank layers past ~5-10.
       Chromium grows it to the content, which is why only WebKit showed it. */
    align-self: flex-start;
  }
  .lanes {
    position: relative;
  }
  .lanes {
    touch-action: none;
    cursor: crosshair;
  }
  .lanes canvas,
  .ruler-track canvas {
    position: absolute;
    top: 0;
    left: 0;
  }
  .ruler-track {
    position: relative;
  }
  .ruler-track canvas {
    cursor: zoom-in;
    touch-action: none;
  }
  .follow {
    font-family: var(--font);
    font-size: 9px;
    letter-spacing: 1px;
    min-height: 20px;
    padding: 0 6px;
    border: 1px solid var(--box, var(--bevel-dark));
    background: var(--panel-lo);
    color: var(--ink-dim);
    cursor: pointer;
  }
  .follow.on {
    color: var(--green);
    border-color: var(--green);
  }
  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--green);
    box-shadow: var(--glow);
    pointer-events: none;
  }
</style>
