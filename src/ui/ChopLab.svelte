<script lang="ts">
  // The chop lab (docs/sampler-research.md §2.4): a sample's region on a
  // zoomable waveform, cut with markers — by hand (tap to hear a slice, drag
  // a marker's handle to move it), into equal parts, or at the transients —
  // then laid onto consecutive pads in one step (undoable). Pure logic in
  // src/pads/chop.ts.
  import { onMount } from "svelte";
  import { closeChop, applyChop, auditionSlice, engine, type ChopSource } from "../state/store";
  import { addMarker, cleanMarkers, detectOnsets, equalMarkers, markersToSlices, nearestMarker, sliceAt } from "../pads/chop";
  import { BANKS, SLOTS, padLabel } from "../pads/pads";

  let { src }: { src: ChopSource } = $props();

  const buffer = $derived(engine.getBuffer(src.bufferId));
  /** The region being cut (transients may trim silence off its start). */
  let rs = $state(0);
  let re = $state(1);

  let markers = $state<number[]>([]);
  let view = $state({ a: 0, b: 1 });
  let selected = $state(0);
  let lastTap = $state<number | null>(null);
  let sensitivity = $state(0.5);
  let first = $state(0);
  let canvas: HTMLCanvasElement;
  let wrap: HTMLDivElement;

  const slices = $derived(markersToSlices(markers, rs, re));
  const fits = $derived(Math.min(slices.length, SLOTS - first));

  // A new source (another pad) starts fresh.
  let srcKey = "";
  $effect(() => {
    const key = `${src.bufferId}:${src.start}:${src.end}:${src.slot}`;
    if (key === srcKey) return;
    srcKey = key;
    rs = src.start;
    re = src.end;
    markers = [];
    view = { a: src.start, b: src.end };
    selected = 0;
    lastTap = null;
    first = src.slot;
  });

  const HANDLE = 14;
  const xOf = (t: number, w: number) => ((t - view.a) / (view.b - view.a)) * w;
  const tOf = (x: number, w: number) => view.a + (x / w) * (view.b - view.a);

  function color(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#3ff08a";
  }

  function draw() {
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = color("--panel-lo");
    ctx.fillRect(0, 0, w, h);
    // Slices: alternate shading, the selected one lit.
    slices.forEach((s, i) => {
      const x0 = Math.max(0, xOf(s.start, w));
      const x1 = Math.min(w, xOf(s.end, w));
      if (x1 <= x0) return;
      ctx.globalAlpha = i === selected ? 0.28 : i % 2 ? 0.1 : 0.04;
      ctx.fillStyle = i === selected ? color("--amber") : color("--green");
      ctx.fillRect(x0, 0, x1 - x0, h);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color("--ink-dim");
      ctx.font = "11px monospace";
      if (x1 - x0 > 18) ctx.fillText(String(i + 1), x0 + 4, h - 6);
    });
    // Outside the region: dimmed.
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    const ra = xOf(rs, w);
    const rb = xOf(re, w);
    if (ra > 0) ctx.fillRect(0, 0, ra, h);
    if (rb < w) ctx.fillRect(rb, 0, w - rb, h);
    // Waveform: min/max per pixel column (sampled when zoomed far out).
    if (buffer) {
      const chans = [buffer.getChannelData(0), buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1))];
      const sr = buffer.sampleRate;
      const mid = h / 2;
      ctx.strokeStyle = color("--green");
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const i0 = Math.max(0, Math.floor(tOf(x, w) * sr));
        const i1 = Math.min(buffer.length, Math.floor(tOf(x + 1, w) * sr));
        if (i1 <= i0) continue;
        const step = Math.max(1, Math.floor((i1 - i0) / 256));
        let lo = 0;
        let hi = 0;
        for (let i = i0; i < i1; i += step) {
          const s = (chans[0][i] + chans[1][i]) / 2;
          if (s < lo) lo = s;
          if (s > hi) hi = s;
        }
        ctx.moveTo(x + 0.5, mid - hi * mid * 0.95);
        ctx.lineTo(x + 0.5, mid - lo * mid * 0.95 + 1);
      }
      ctx.stroke();
    }
    // Markers with a grab handle on top.
    ctx.fillStyle = ctx.strokeStyle = color("--magenta");
    for (const m of markers) {
      const x = xOf(m, w);
      if (x < -HANDLE || x > w + HANDLE) continue;
      ctx.fillRect(x - 0.5, 0, 1.5, h);
      ctx.beginPath();
      ctx.moveTo(x - HANDLE / 2, 0);
      ctx.lineTo(x + HANDLE / 2, 0);
      ctx.lineTo(x, HANDLE);
      ctx.fill();
    }
    if (lastTap !== null) {
      ctx.fillStyle = color("--amber");
      ctx.fillRect(xOf(lastTap, w) - 0.5, h - 10, 1.5, 10);
    }
  }

  $effect(() => {
    // Redraw on any change the picture depends on.
    void [markers, view, selected, lastTap, slices, buffer];
    draw();
  });
  onMount(() => {
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    return () => ro.disconnect();
  });

  // ---- pointer: tap = hear the slice, drag a handle = move a marker,
  // drag elsewhere = scroll a zoomed view ----
  let drag: { id: number; marker: number | null; x0: number; a0: number; b0: number; moved: boolean } | null = null;

  function onDown(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let marker: number | null = null;
    if (y < HANDLE * 2.5) {
      const near = nearestMarker(markers, tOf(x, r.width), ((HANDLE * 1.2) / r.width) * (view.b - view.a));
      marker = near;
    }
    drag = { id: e.pointerId, marker, x0: x, a0: view.a, b0: view.b, moved: false };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not a live pointer */
    }
  }
  function onMove(e: PointerEvent) {
    if (!drag || drag.id !== e.pointerId) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (Math.abs(x - drag.x0) > 6) drag.moved = true;
    if (!drag.moved) return;
    if (drag.marker !== null) {
      const t = Math.min(re, Math.max(rs, tOf(x, r.width)));
      markers = markers.map((m, i) => (i === drag!.marker ? t : m));
    } else {
      const dt = ((drag.x0 - x) / r.width) * (drag.b0 - drag.a0);
      pan(drag.a0 + dt, drag.b0 + dt);
    }
  }
  function onUp(e: PointerEvent) {
    if (!drag || drag.id !== e.pointerId) return;
    const r = canvas.getBoundingClientRect();
    const t = tOf(e.clientX - r.left, r.width);
    if (!drag.moved && t >= rs && t <= re) {
      lastTap = t;
      selected = sliceAt(slices, t);
      play(selected);
    }
    if (drag.marker !== null) markers = cleanMarkers(markers, rs, re);
    drag = null;
  }

  function pan(a: number, b: number) {
    const span = b - a;
    const lo = Math.min(rs, view.a);
    a = Math.max(rs - span * 0.02, Math.min(a, re + span * 0.02 - span));
    view = { a: Math.max(lo, a), b: Math.max(lo, a) + span };
  }
  function zoom(f: number) {
    const s = slices[selected];
    const c = s ? (s.start + s.end) / 2 : (view.a + view.b) / 2;
    const span = Math.min(re - rs, Math.max(0.01, (view.b - view.a) / f));
    const a = Math.max(rs, Math.min(re - span, c - span / 2));
    view = { a, b: a + span };
  }

  function play(i: number) {
    const s = slices[i];
    if (s) auditionSlice(src.bufferId, s.start, s.end);
  }

  // ---- cutting ----
  function cutHere() {
    const s = slices[selected];
    const t = lastTap ?? (s ? (s.start + s.end) / 2 : (rs + re) / 2);
    markers = addMarker(markers, t, rs, re);
    selected = sliceAt(markersToSlices(markers, rs, re), t);
  }
  function removeCut() {
    if (!markers.length) return;
    const s = slices[selected];
    const t = lastTap ?? s?.start ?? rs;
    let i = nearestMarker(markers, t, (view.b - view.a) * 0.05);
    if (i === null && s) i = markers.findIndex((m) => Math.abs(m - s.start) < 1e-9);
    if (i === null || i < 0) return;
    markers = markers.filter((_, k) => k !== i);
    selected = Math.min(selected, markers.length);
    lastTap = null;
  }
  function transients() {
    if (!buffer) return;
    const chans = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer!.getChannelData(c));
    rs = src.start;
    const found = detectOnsets(chans, buffer.sampleRate, rs, re, sensitivity);
    // Nothing before the first hit (silence, a count-in click): start there.
    if (found.length && quiet(chans, buffer.sampleRate, rs, found[0])) rs = found.shift()!;
    markers = found;
    selected = 0;
  }
  /** True when [a, b) is far below the region's loudest sample (-36 dB). */
  function quiet(chans: Float32Array[], sr: number, a: number, b: number): boolean {
    const peakOf = (x: number, y: number) => {
      let p = 0;
      for (const c of chans) for (let i = Math.floor(x * sr); i < Math.min(c.length, Math.floor(y * sr)); i++) p = Math.max(p, Math.abs(c[i]));
      return p;
    };
    return peakOf(a, b) < peakOf(src.start, src.end) * 0.016;
  }

  function equal(n: number) {
    rs = src.start;
    markers = equalMarkers(rs, re, n);
    selected = 0;
  }

  const bankOfFirst = $derived(Math.floor(first / 16));
  const stepFirst = (d: number) => (first = Math.max(0, Math.min(SLOTS - 1, first + d)));

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") closeChop();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" role="dialog" aria-modal="true" aria-label="Chop lab" data-role="chop-lab">
  <div class="lab box" data-title="chop lab · {src.name}" data-title-right="{slices.length} slice{slices.length === 1 ? '' : 's'}">
    <div class="tools">
      <button class="btn" onclick={cutHere} data-role="chop-cut" title="Cut at the last tap (or the middle of the selected slice)">✂ CUT</button>
      <button class="btn" onclick={removeCut} data-role="chop-uncut" disabled={!markers.length} title="Remove the cut nearest the last tap">⌫ CUT</button>
      <span class="divider"></span>
      <button class="btn magenta" onclick={transients} data-role="chop-transients" title="Cut at every hit">⚡ TRANSIENTS</button>
      <label class="sens" title="Higher finds softer hits">
        <small>SENS</small>
        <input type="range" min="0" max="1" step="0.05" bind:value={sensitivity} data-role="chop-sens" />
      </label>
      <span class="divider"></span>
      {#each [2, 4, 8, 16] as n (n)}
        <button class="btn small" onclick={() => equal(n)} data-role="chop-equal-{n}" title="{n} equal slices">÷{n}</button>
      {/each}
      <button class="btn small" onclick={() => ((markers = []), (selected = 0), (rs = src.start))} title="No cuts">CLEAR</button>
      <span class="spacer"></span>
      <button class="btn small" onclick={() => zoom(1 / 2)} aria-label="Zoom out">−</button>
      <button class="btn small" onclick={() => (view = { a: rs, b: re })}>FIT</button>
      <button class="btn small" onclick={() => zoom(2)} aria-label="Zoom in">＋</button>
    </div>

    <div class="wave" bind:this={wrap}>
      <canvas
        bind:this={canvas}
        onpointerdown={onDown}
        onpointermove={onMove}
        onpointerup={onUp}
        onpointercancel={() => (drag = null)}
        data-role="chop-wave"
      ></canvas>
    </div>
    <p class="hint">Tap to hear a slice · drag a ▼ handle to move a cut · drag elsewhere to scroll when zoomed</p>

    <div class="foot">
      <button class="btn small" onclick={() => play(selected)} disabled={!slices.length}>▶ SLICE {selected + 1}</button>
      <span class="spacer"></span>
      <span class="lbl">SLICES → PADS FROM</span>
      <button class="btn small" onclick={() => stepFirst(-16)} title="Bank down">◀</button>
      <span class="val screen" data-role="chop-first">{padLabel(first)}</span>
      <button class="btn small" onclick={() => stepFirst(16)} title="Bank up">▶</button>
      <button class="btn small" onclick={() => stepFirst(-1)} title="Pad down">−</button>
      <button class="btn small" onclick={() => stepFirst(1)} title="Pad up">+</button>
      <small class="range">{fits > 1 ? `${padLabel(first)}–${padLabel(first + fits - 1)}` : padLabel(first)}{bankOfFirst !== Math.floor((first + fits - 1) / 16) ? ` (into bank ${BANKS[Math.floor((first + fits - 1) / 16)]})` : ""}</small>
      <button class="btn accent" onclick={() => applyChop(src, slices, first)} data-role="chop-apply">✓ CHOP → {fits} PAD{fits === 1 ? "" : "S"}</button>
      <button class="btn" onclick={closeChop} data-role="chop-cancel">CANCEL</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .lab {
    width: min(1240px, 100%);
    height: min(640px, 100%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 12px 10px;
    background: var(--panel);
  }
  .tools,
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
  }
  .btn {
    min-height: 38px;
    font-size: 12px;
  }
  .btn.small {
    min-width: 40px;
    padding: 0 8px;
  }
  .divider {
    width: 1px;
    align-self: stretch;
    background: var(--box);
    margin: 0 4px;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .sens {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .sens input {
    width: 90px;
  }
  small {
    font-size: 10px;
    color: var(--ink-dim);
  }
  .wave {
    position: relative;
    flex: 1 1 auto;
    min-height: 120px;
    border: 1px solid var(--box);
  }
  canvas {
    position: absolute;
    inset: 0;
    touch-action: none;
    cursor: crosshair;
  }
  .hint {
    margin: 0;
    font-size: 11px;
    color: var(--ink-dim);
  }
  .lbl {
    font-size: 11px;
    font-weight: bold;
    letter-spacing: 1px;
    color: var(--box-title);
  }
  .val {
    min-width: 44px;
    text-align: center;
    padding: 6px;
    font-weight: bold;
    color: var(--green);
  }
</style>
