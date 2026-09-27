<script lang="ts">
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
  } from "../state/store";
  import { getSummary, columnStats, type ColumnStats } from "../render/peaks";
  import { clipEnd, projectDuration } from "../audio/edits";
  import type { Clip, Track } from "../audio/types";
  import { LANE_HEIGHT, HEAD_WIDTH, RULER_HEIGHT } from "./constants";
  import TrackHead from "./TrackHead.svelte";
  import { theme } from "./themeStore";
  import { laneColor } from "./themes";
  import { punchPreviewFor, previewTick } from "./punchPreviewStore";
  import type { PunchPreview } from "../render/punchPreview";
  import { onMount } from "svelte";

  let laneCanvas: HTMLCanvasElement;
  let rulerCanvas: HTMLCanvasElement;
  let lanesScroll: HTMLDivElement;
  let rulerScroll: HTMLDivElement;
  let bodyEl: HTMLDivElement;
  let lanesEl: HTMLDivElement;

  const EDGE = 8; // px hit zone for edge-trim

  let contentWidth = $derived(Math.max(projectDuration($project) + 4, 30) * $pixelsPerSecond);
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

  let raf = 0;
  function onScroll() {
    if (rulerScroll && lanesScroll) rulerScroll.scrollLeft = lanesScroll.scrollLeft;
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
  }

  onMount(() => {
    const ro = new ResizeObserver(() => measure());
    ro.observe(lanesScroll);
    ro.observe(bodyEl);
    measure();
    return () => ro.disconnect();
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

  function onPointerDown(e: PointerEvent) {
    const rect = lanesEl.getBoundingClientRect();
    const time = eventTime(e);
    const ti = Math.floor((e.clientY - rect.top) / LANE_HEIGHT);
    const track = $project.tracks[ti];
    if (!track) {
      selectClip(null);
      seek(time);
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
      selectClip(null);
      seek(time);
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
    lanesEl.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
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
    drag = null;
    try {
      lanesEl.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  }

  function onRulerDown(e: PointerEvent) {
    const rect = rulerCanvas.getBoundingClientRect();
    seek(Math.max(0, (e.clientX - rect.left + view.x) / $pixelsPerSecond));
  }
</script>

<div class="timeline">
  <!-- Ruler row: corner + scrollable ruler -->
  <div class="ruler-row" style:height="{RULER_HEIGHT}px">
    <div class="corner" style:width="{HEAD_WIDTH}px">
      <span class="label">LAYERS</span>
    </div>
    <div class="ruler-scroll" bind:this={rulerScroll}>
      <div class="ruler-track" style:width="{contentWidth}px" style:height="{RULER_HEIGHT}px">
        <canvas
          bind:this={rulerCanvas}
          onpointerdown={onRulerDown}
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
      <div class="lanes" bind:this={lanesEl} style:width="{contentWidth}px" style:height="{contentHeight}px" onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} role="presentation">
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
    padding-left: 10px;
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
