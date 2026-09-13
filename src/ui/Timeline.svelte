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
  import { getPeaks } from "../render/peaks";
  import { clipEnd, projectDuration } from "../audio/edits";
  import type { Clip } from "../audio/types";
  import { LANE_HEIGHT, HEAD_WIDTH, RULER_HEIGHT } from "./constants";
  import TrackHead from "./TrackHead.svelte";

  let laneCanvas: HTMLCanvasElement;
  let rulerCanvas: HTMLCanvasElement;
  let lanesScroll: HTMLDivElement;
  let rulerScroll: HTMLDivElement;

  const EDGE = 8; // px hit zone for edge-trim

  let contentWidth = $derived(Math.max(projectDuration($project) + 4, 30) * $pixelsPerSecond);
  let contentHeight = $derived(Math.max(1, $project.tracks.length) * LANE_HEIGHT);

  // ---- drawing ------------------------------------------------------------

  function drawLanes() {
    if (!laneCanvas) return;
    const pps = $pixelsPerSecond;
    const dpr = window.devicePixelRatio || 1;
    const w = contentWidth;
    const h = contentHeight;
    laneCanvas.width = w * dpr;
    laneCanvas.height = h * dpr;
    laneCanvas.style.width = `${w}px`;
    laneCanvas.style.height = `${h}px`;
    const ctx = laneCanvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    $project.tracks.forEach((track, ti) => {
      const y = ti * LANE_HEIGHT;
      // Lane background stripes.
      ctx.fillStyle = ti % 2 ? "#06140b" : "#051009";
      ctx.fillRect(0, y, w, LANE_HEIGHT);
      // Bar gridlines every second.
      ctx.strokeStyle = "rgba(55,224,122,0.07)";
      ctx.lineWidth = 1;
      for (let s = 0; s * pps < w; s++) {
        const x = Math.round(s * pps) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + LANE_HEIGHT);
        ctx.stroke();
      }

      for (const clip of track.clips) {
        drawClip(ctx, clip, track.color, y);
      }
    });
  }

  function drawClip(ctx: CanvasRenderingContext2D, clip: Clip, color: string, laneY: number) {
    const pps = $pixelsPerSecond;
    const x = clip.startTime * pps;
    const cw = Math.max(2, clip.duration * pps);
    const pad = 6;
    const top = laneY + pad;
    const clipH = LANE_HEIGHT - pad * 2;
    const selected = clip.id === $selectedClipId;

    // DOOM-style extrusion: a hard black drop behind the clip.
    ctx.fillStyle = "#000";
    ctx.fillRect(x + 3, top + 3, cw, clipH);
    // Clip body.
    ctx.fillStyle = selected ? "rgba(184,255,208,0.14)" : "rgba(2,10,5,0.85)";
    ctx.fillRect(x, top, cw, clipH);
    ctx.strokeStyle = selected ? "#ffffff" : color;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(x + 0.5, top + 0.5, cw - 1, clipH - 1);

    // Header strip + name.
    ctx.fillStyle = color;
    ctx.fillRect(x, top, cw, 14);
    ctx.fillStyle = "#10121a";
    ctx.font = "bold 10px monospace";
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 3, top, cw - 6, 14);
    ctx.clip();
    ctx.fillText(clip.name, x + 4, top + 11);
    ctx.restore();

    // Waveform.
    const buffer = engine.getBuffer(clip.bufferId);
    if (buffer) {
      const buckets = Math.max(1, Math.floor(cw));
      const peaks = getPeaks(buffer, buckets);
      const wfTop = top + 16;
      const wfH = clipH - 18;
      const mid = wfTop + wfH / 2;
      // Map the clip's offset window onto the peaks (peaks span whole buffer).
      const startFrac = clip.offset / buffer.duration;
      const endFrac = (clip.offset + clip.duration) / buffer.duration;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      for (let i = 0; i < buckets; i++) {
        const frac = startFrac + (endFrac - startFrac) * (i / buckets);
        const pi = Math.min(peaks.length / 2 - 1, Math.max(0, Math.floor(frac * (peaks.length / 2))));
        const min = peaks[pi * 2];
        const max = peaks[pi * 2 + 1];
        const px = x + i;
        ctx.moveTo(px, mid + min * (wfH / 2));
        ctx.lineTo(px, mid + max * (wfH / 2));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawRuler() {
    if (!rulerCanvas) return;
    const pps = $pixelsPerSecond;
    const dpr = window.devicePixelRatio || 1;
    const w = contentWidth;
    rulerCanvas.width = w * dpr;
    rulerCanvas.height = RULER_HEIGHT * dpr;
    rulerCanvas.style.width = `${w}px`;
    rulerCanvas.style.height = `${RULER_HEIGHT}px`;
    const ctx = rulerCanvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#020704";
    ctx.fillRect(0, 0, w, RULER_HEIGHT);
    ctx.fillStyle = "#3f9a62";
    ctx.strokeStyle = "rgba(55,224,122,0.25)";
    ctx.font = "10px monospace";
    // Label every second; tick every second.
    const step = pps < 40 ? 5 : 1;
    for (let s = 0; s * pps < w; s += step) {
      const x = Math.round(s * pps) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 8);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();
      ctx.fillText(`${s}s`, x + 3, 12);
    }
  }

  // Redraw whenever structure / zoom / selection change.
  $effect(() => {
    // touch reactive deps
    void $project;
    void $pixelsPerSecond;
    void $selectedClipId;
    drawLanes();
    drawRuler();
  });

  // ---- interaction --------------------------------------------------------

  type Drag =
    | { kind: "move"; trackId: string; clipId: string; grab: number }
    | { kind: "trim-l" | "trim-r"; trackId: string; clipId: string; fixedStart: number; fixedEnd: number }
    | null;
  let drag: Drag = null;

  function eventTime(e: PointerEvent): number {
    const rect = laneCanvas.getBoundingClientRect();
    return Math.max(0, (e.clientX - rect.left) / $pixelsPerSecond);
  }

  function onPointerDown(e: PointerEvent) {
    const rect = laneCanvas.getBoundingClientRect();
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
    laneCanvas.setPointerCapture(e.pointerId);
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
      laneCanvas.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  }

  function onRulerDown(e: PointerEvent) {
    const rect = rulerCanvas.getBoundingClientRect();
    seek(Math.max(0, (e.clientX - rect.left) / $pixelsPerSecond));
  }

  function syncScroll() {
    if (rulerScroll && lanesScroll) rulerScroll.scrollLeft = lanesScroll.scrollLeft;
  }
</script>

<div class="timeline">
  <!-- Ruler row: corner + scrollable ruler -->
  <div class="ruler-row" style:height="{RULER_HEIGHT}px">
    <div class="corner" style:width="{HEAD_WIDTH}px">
      <span class="label">LAYERS</span>
    </div>
    <div class="ruler-scroll" bind:this={rulerScroll}>
      <canvas
        bind:this={rulerCanvas}
        onpointerdown={onRulerDown}
        style:height="{RULER_HEIGHT}px"
      ></canvas>
    </div>
  </div>

  <!-- Body: heads + lanes share vertical scroll -->
  <div class="body">
    <div class="heads" style:width="{HEAD_WIDTH}px">
      {#each $project.tracks as track (track.id)}
        <TrackHead {track} />
      {/each}
      {#if $project.tracks.length === 0}
        <div class="empty label">Import audio or add a layer to start.</div>
      {/if}
    </div>

    <div class="lanes-scroll" bind:this={lanesScroll} onscroll={syncScroll}>
      <div class="lanes" style:width="{contentWidth}px" style:height="{contentHeight}px">
        <canvas
          bind:this={laneCanvas}
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
        ></canvas>
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
    border-right: 2px solid var(--bevel-dark);
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
    border-right: 2px solid var(--bevel-dark);
    background: var(--panel);
    box-shadow: 4px 0 0 #000; /* the LAYERS column stands proud of the void */
  }
  .empty {
    padding: 20px 12px;
    line-height: 1.6;
  }
  .lanes-scroll {
    flex: 1 1 auto;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .lanes {
    position: relative;
  }
  .lanes canvas {
    touch-action: none;
    cursor: crosshair;
  }
  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--green);
    box-shadow: 0 0 8px rgba(90, 240, 150, 0.8);
    pointer-events: none;
  }
</style>
