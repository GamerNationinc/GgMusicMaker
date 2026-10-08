<script lang="ts">
  // One DJ deck: the scrolling waveform (beat grid, cues, loop; drag it to
  // scratch), the whole-track overview (click to jump), transport, hot cues,
  // tempo fader and loading. The controller mapping is in src/input/dj.ts;
  // this draws the desk's view and forwards screen actions.
  import { djView, djAct, screenOnly, deckPerforming } from "../input/controller";
  import { HOT_CUES, TEMPO_RANGE } from "../input/dj";
  import { djLibrary, loadDeck, loadFileToDeck, deckPeaks, PEAKS_PER_SEC } from "../state/djLibrary";

  let { deck }: { deck: number } = $props();
  const side = $derived(deck === 0 ? "A" : "B");
  const d = $derived($djView.decks[deck]);
  /** Seconds either side of the playhead in the scrolling waveform. */
  const WIN = 4;

  let wave: HTMLCanvasElement;
  let overview: HTMLCanvasElement;
  let fileInput: HTMLInputElement;

  const fmt = (t: number) => {
    const s = Math.max(0, t);
    return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
  };
  const accept = (e: PointerEvent) => !($deckPerforming && e.pointerType === "mouse");

  function colors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim() || "#3ff08a";
    return { wave: v("--green"), dim: v("--ink-dim"), grid: v("--box"), bar: v("--box-title"), cue: v("--amber"), hot: v("--magenta"), head: v("--danger"), bg: v("--panel-lo") };
  }

  function fit(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return c.getContext("2d");
  }

  function drawWave() {
    const ctx = wave && fit(wave);
    if (!ctx) return;
    const { width: W, height: H } = wave;
    const col = colors();
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, W, H);
    const t = d.track;
    if (!t) return;
    const pps = W / (2 * WIN);
    const t0 = d.pos - WIN;
    const x = (time: number) => (time - t0) * pps;
    // Loop region.
    if (d.loop) {
      ctx.fillStyle = col.cue;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(x(d.loop.from), 0, (d.loop.to - d.loop.from) * pps, H);
      ctx.globalAlpha = 1;
    }
    // Beat grid: bars brighter.
    if (t.bpm) {
      const beat = 60 / t.bpm;
      const k0 = Math.ceil((t0 - t.firstBeat) / beat);
      for (let k = k0; ; k++) {
        const bt = t.firstBeat + k * beat;
        if (bt > d.pos + WIN) break;
        if (bt < 0) continue;
        ctx.fillStyle = k % 4 === 0 ? col.bar : col.grid;
        ctx.fillRect(Math.round(x(bt)), 0, k % 4 === 0 ? 2 : 1, H);
      }
    }
    // The waveform (played part dimmer).
    const peaks = deckPeaks(t.bufferId);
    if (peaks) {
      const n = peaks.length / 2;
      const mid = H / 2;
      for (let px = 0; px < W; px++) {
        const a = Math.floor((t0 + px / pps) * PEAKS_PER_SEC);
        const b = Math.max(a + 1, Math.floor((t0 + (px + 1) / pps) * PEAKS_PER_SEC));
        if (b <= 0 || a >= n) continue;
        let lo = 0, hi = 0;
        for (let i = Math.max(0, a); i < Math.min(n, b); i++) {
          lo = Math.min(lo, peaks[i * 2]);
          hi = Math.max(hi, peaks[i * 2 + 1]);
        }
        ctx.fillStyle = px < W / 2 ? col.dim : col.wave;
        ctx.fillRect(px, mid - hi * mid * 0.95, 1, Math.max(1, (hi - lo) * mid * 0.95));
      }
    }
    // Cue and hot cues.
    const marker = (time: number, color: string, label: string) => {
      const mx = Math.round(x(time));
      if (mx < -20 || mx > W + 20) return;
      ctx.fillStyle = color;
      ctx.fillRect(mx, 0, 2, H);
      ctx.font = `bold ${Math.round(11 * (window.devicePixelRatio || 1))}px monospace`;
      ctx.fillText(label, mx + 3, 12 * (window.devicePixelRatio || 1));
    };
    marker(d.cue, col.cue, "C");
    d.hotCues.forEach((h, i) => h != null && marker(h, col.hot, String(i + 1)));
    // Playhead.
    ctx.fillStyle = col.head;
    ctx.fillRect(Math.round(W / 2) - 1, 0, 2, H);
  }

  function drawOverview() {
    const ctx = overview && fit(overview);
    if (!ctx) return;
    const { width: W, height: H } = overview;
    const col = colors();
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, W, H);
    const t = d.track;
    const peaks = t && deckPeaks(t.bufferId);
    if (!t || !peaks) return;
    const n = peaks.length / 2;
    const mid = H / 2;
    const played = (d.pos / t.duration) * W;
    for (let px = 0; px < W; px++) {
      const a = Math.floor((px / W) * n);
      const b = Math.max(a + 1, Math.floor(((px + 1) / W) * n));
      let lo = 0, hi = 0;
      for (let i = a; i < Math.min(n, b); i++) {
        lo = Math.min(lo, peaks[i * 2]);
        hi = Math.max(hi, peaks[i * 2 + 1]);
      }
      ctx.fillStyle = px < played ? col.dim : col.wave;
      ctx.fillRect(px, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
    }
    d.hotCues.forEach((h) => {
      if (h == null) return;
      ctx.fillStyle = col.hot;
      ctx.fillRect(Math.round((h / t.duration) * W), 0, 2, H);
    });
    ctx.fillStyle = col.head;
    ctx.fillRect(Math.round(played) - 1, 0, 2, H);
  }

  $effect(() => {
    void $djView;
    drawWave();
    drawOverview();
  });
  $effect(() => {
    const ro = new ResizeObserver(() => {
      drawWave();
      drawOverview();
    });
    ro.observe(wave);
    ro.observe(overview);
    return () => ro.disconnect();
  });

  // Drag the waveform = hand on the platter (the audio follows the finger).
  let drag: { id: number; x: number; at: number } | null = null;
  function waveDown(e: PointerEvent) {
    if (!accept(e) || !d.track) return;
    try {
      wave.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic event */
    }
    drag = { id: e.pointerId, x: e.clientX, at: e.timeStamp };
    djAct((desk) => desk.screenScratch(deck, 0));
  }
  function waveMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const dt = (e.timeStamp - drag.at) / 1000;
    if (dt <= 0.004) return;
    const pps = wave.clientWidth / (2 * WIN);
    const speed = -(e.clientX - drag.x) / pps / dt;
    drag = { id: e.pointerId, x: e.clientX, at: e.timeStamp };
    djAct((desk) => desk.screenScratch(deck, Math.max(-8, Math.min(8, speed))));
  }
  function waveUp(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    djAct((desk) => desk.screenScratch(deck, null));
  }
  function overviewDown(e: PointerEvent) {
    if (!accept(e) || !d.track) return;
    const r = overview.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    djAct((desk) => desk.seek(deck, f * d.track!.duration));
  }

  // Hot cue: tap = set / jump; hold ~0.6 s = clear.
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let held = false;
  function hotDown(e: PointerEvent, i: number) {
    if (!accept(e)) return;
    held = false;
    holdTimer = setTimeout(() => {
      held = true;
      djAct((desk) => desk.clearHotCue(deck, i));
    }, 600);
  }
  function hotUp(e: PointerEvent, i: number) {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    if (!accept(e) || held) return;
    djAct((desk) => desk.hotCue(deck, i));
  }

  function onPick(e: Event) {
    const sel = e.target as HTMLSelectElement;
    const entry = $djLibrary.find((x) => x.bufferId === sel.value);
    sel.value = "";
    if (entry) void loadDeck(deck, entry);
  }
  function onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (f) void loadFileToDeck(deck, f);
  }

  const pitch = $derived((d.rate - 1) * 100);
  const backButtons = $derived(deck === 0 ? ["L4", "L5"] : ["R4", "R5"]);
</script>

<div class="box deck" data-title="deck {side}" data-title-right={deck === 0 ? "left pad · jog" : "right pad · jog"} data-role="dj-deck-{deck}">
  <div class="head">
    <span class="name screen" title={d.track?.name ?? ""} data-role="dj-name-{deck}">{d.track?.name ?? "— empty —"}</span>
    <span class="bpm screen" data-role="dj-bpm-{deck}">{d.bpm ? d.bpm.toFixed(2) : "---.--"}<small>BPM</small></span>
    <span class="time screen" data-role="dj-time-{deck}">{fmt(d.pos)} <small>−{fmt((d.track?.duration ?? 0) - d.pos)}</small></span>
  </div>
  <canvas
    class="wave"
    class:scratch={d.jog.scratch}
    bind:this={wave}
    onpointerdown={waveDown}
    onpointermove={waveMove}
    onpointerup={waveUp}
    onpointercancel={waveUp}
    data-role="dj-wave-{deck}"
  ></canvas>
  <canvas class="overview" bind:this={overview} onpointerdown={overviewDown} data-role="dj-overview-{deck}"></canvas>

  <div class="row">
    <button class="btn big" class:accent={d.playing} disabled={!d.track} onclick={screenOnly(() => djAct((desk) => desk.playPause(deck)))} data-role="dj-play-{deck}"
      >{d.playing ? "❚❚" : "▶"} <small>{deck === 0 ? "L1" : "R1"}</small></button
    >
    <button class="btn big" disabled={!d.track} onclick={screenOnly(() => djAct((desk) => desk.cue(deck)))} data-role="dj-cue-{deck}"
      >CUE <small>{deck === 0 ? "←" : "→"}</small></button
    >
    <button class="btn" disabled={!d.bpm} onclick={screenOnly(() => djAct((desk) => desk.sync(deck)))} title="Match the other deck's tempo and line the beats up" data-role="dj-sync-{deck}"
      >SYNC <small>{deck === 0 ? "X" : "B"}</small></button
    >
    <button class="btn" class:accent={!!d.loop} disabled={!d.track} onclick={screenOnly(() => djAct((desk) => desk.loop(deck)))} title="Loop 4 beats from here (again = off)" data-role="dj-loop-{deck}"
      >LOOP 4 <small>{deck === 0 ? "Y" : "A"}</small></button
    >
  </div>
  <div class="row hot">
    {#each Array(HOT_CUES) as _, i (i)}
      <button
        class="btn"
        class:set={d.hotCues[i] != null}
        disabled={!d.track}
        onpointerdown={(e) => hotDown(e, i)}
        onpointerup={(e) => hotUp(e, i)}
        onpointercancel={() => holdTimer && clearTimeout(holdTimer)}
        title={d.hotCues[i] == null ? `Hot cue ${i + 1}: tap to set it here` : `Hot cue ${i + 1}: tap to jump, hold to clear`}
        data-role="dj-hot-{deck}-{i + 1}"
        >{i + 1}{#if i < 2}<small>{backButtons[i]}</small>{/if}</button
      >
    {/each}
  </div>
  <div class="row tempo">
    <span class="lbl">TEMPO</span>
    <input
      type="range"
      min={-TEMPO_RANGE * 100}
      max={TEMPO_RANGE * 100}
      step="0.01"
      value={pitch}
      oninput={(e) => djAct((desk) => desk.setRate(deck, 1 + Number((e.target as HTMLInputElement).value) / 100))}
      ondblclick={() => djAct((desk) => desk.setRate(deck, 1))}
      title="Tempo ±8 % (double-click: back to 0)"
      data-role="dj-tempo-{deck}"
    />
    <span class="val screen" data-role="dj-pitch-{deck}">{pitch >= 0 ? "+" : ""}{pitch.toFixed(2)}%</span>
  </div>
  <div class="row load">
    <select onchange={onPick} value="" aria-label="Load a track on deck {side}" data-role="dj-load-{deck}">
      <option value="" disabled>LOAD ▾ {$djLibrary.length ? `(${$djLibrary.length} in this project)` : "(import songs in Studio, or FILE)"}</option>
      {#each $djLibrary as e (e.bufferId)}
        <option value={e.bufferId}>{e.name} · {fmt(e.duration)}</option>
      {/each}
    </select>
    <button class="btn" onclick={screenOnly(() => fileInput.click())} data-role="dj-file-{deck}">FILE…</button>
    <input type="file" accept="audio/*" bind:this={fileInput} onchange={onFile} hidden data-role="dj-file-input-{deck}" />
  </div>
</div>

<style>
  .deck {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    min-height: 0;
  }
  .head {
    display: flex;
    gap: 6px;
    align-items: baseline;
    min-width: 0;
  }
  .name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    color: var(--ink);
  }
  .bpm {
    font-size: 16px;
    color: var(--green);
  }
  .bpm small,
  .time small {
    font-size: 9px;
    color: var(--ink-dim);
    margin-left: 2px;
  }
  .time {
    font-size: 12px;
    color: var(--ink);
  }
  canvas {
    display: block;
    width: 100%;
    border: 1px solid var(--box);
    touch-action: none;
  }
  .wave {
    flex: 1 1 auto;
    min-height: 90px;
    cursor: grab;
  }
  .wave.scratch {
    border-color: var(--amber);
  }
  .overview {
    height: 28px;
    flex: 0 0 auto;
    cursor: pointer;
  }
  .row {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .row .btn {
    flex: 1 1 0;
    min-height: 36px;
    font-size: 12px;
  }
  .row .btn small {
    font-size: 9px;
    opacity: 0.7;
    margin-left: 3px;
  }
  .btn.big {
    font-size: 15px;
    font-weight: bold;
  }
  .hot .btn.set {
    background: var(--magenta);
    border-color: var(--magenta);
    color: var(--on-accent);
  }
  .tempo input {
    flex: 1 1 auto;
    accent-color: var(--green);
  }
  .lbl {
    font-size: 10px;
    color: var(--ink-dim);
    letter-spacing: 1px;
  }
  .val {
    font-size: 12px;
    min-width: 58px;
    text-align: right;
    color: var(--green);
  }
  .load select {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 32px;
    font-family: var(--font);
    font-size: 11px;
    background: var(--panel-lo);
    color: var(--ink);
    border: 1px solid var(--box);
  }
  .load .btn {
    flex: 0 0 auto;
    min-height: 32px;
  }
</style>
