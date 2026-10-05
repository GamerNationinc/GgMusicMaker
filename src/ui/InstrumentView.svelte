<script lang="ts">
  // Instrument mode: what the Deck's controls are doing, and the same
  // instrument playable on the touchscreen (src/input/instrument.ts has the
  // mapping; this only draws it and forwards screen touches).
  import {
    instrumentView,
    controllerSource,
    deckPerforming,
    screenNoteOn,
    screenNoteOff,
    screenDrum,
    setInstrument,
    screenOnly,
    toggleDeckRecording,
  } from "../input/controller";
  import { transport, togglePlay, project, canRecordDeck, metronome, toggleMetronome, canClick } from "../state/store";
  import { formatBarsBeats } from "../audio/tempo";
  import { SCALES, NOTE_NAMES, GRID_ROWS, DRUM_NAMES, cellNote, chordNotes, chordName, scaleOf } from "../input/instrument";
  import { LIVE_PATCHES } from "../audio/live";

  const v = $derived($instrumentView);
  const cols = $derived(scaleOf(v).length);
  const noteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
  /** Pads laid out like the face buttons: Y top, X left, B right, A bottom. */
  const PAD_SLOTS = [
    { i: 3, btn: "Y", area: "y" },
    { i: 2, btn: "X", area: "x" },
    { i: 1, btn: "B", area: "b" },
    { i: 0, btn: "A", area: "a" },
  ];
  const CHORD_DEGREES = [0, 3, 4, 5];
  let screenChords = $state(false);
  const bank = $derived(v.bank === "chords" || screenChords ? "chords" : "drums");

  const sourceLabel = $derived(
    $controllerSource === "deck" ? "DECK CONTROLS · RAW" : $controllerSource === "gamepad" ? "GAMEPAD" : "TOUCH ONLY",
  );

  // Steam's desktop layout turns R2 into a mouse click at the drifting
  // cursor; while the Deck plays, only touch/pen play the screen.
  const accept = (e: PointerEvent) => !($deckPerforming && e.pointerType === "mouse");

  const held = new Map<number, number[]>();
  function press(e: PointerEvent, ids: () => number[]) {
    if (!accept(e)) return;
    try {
      // Keep the note when the finger slides off the cell (lift releases it).
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (synthetic events): nothing to capture.
    }
    held.set(e.pointerId, ids());
  }
  function release(e: PointerEvent) {
    for (const id of held.get(e.pointerId) ?? []) screenNoteOff(id);
    held.delete(e.pointerId);
  }
  function padDown(e: PointerEvent, i: number) {
    if (!accept(e)) return;
    if (bank === "drums") return screenDrum(i);
    press(e, () => chordNotes(v, CHORD_DEGREES[i]).map((n) => screenNoteOn(n, 0.65)));
  }
</script>

<section class="instrument" data-role="instrument">
  <div class="settings box" data-title="instrument" data-title-right={sourceLabel.toLowerCase()}>
    <div class="group">
      <span class="lbl">KEY <small>d-pad ←→</small></span>
      <button class="btn step" onclick={screenOnly(() => setInstrument({ key: (v.key + 11) % 12 }))}>◀</button>
      <span class="val screen" data-role="inst-key">{NOTE_NAMES[v.key]}</span>
      <button class="btn step" onclick={screenOnly(() => setInstrument({ key: (v.key + 1) % 12 }))}>▶</button>
    </div>
    <div class="group">
      <span class="lbl">SCALE <small>d-pad ↑↓</small></span>
      <button class="btn step" onclick={screenOnly(() => setInstrument({ scale: (v.scale + SCALES.length - 1) % SCALES.length }))}>◀</button>
      <span class="val screen wide" data-role="inst-scale">{SCALES[v.scale].name}</span>
      <button class="btn step" onclick={screenOnly(() => setInstrument({ scale: (v.scale + 1) % SCALES.length }))}>▶</button>
    </div>
    <div class="group">
      <span class="lbl">OCTAVE <small>L4 / R4</small></span>
      <button class="btn step" onclick={screenOnly(() => setInstrument({ octave: Math.max(1, v.octave - 1) }))}>−</button>
      <span class="val screen" data-role="inst-octave">{v.octave}</span>
      <button class="btn step" onclick={screenOnly(() => setInstrument({ octave: Math.min(6, v.octave + 1) }))}>+</button>
    </div>
    <div class="group take" data-role="inst-transport">
      <button
        class="btn rec"
        class:on={$transport.isRecording}
        onclick={screenOnly(toggleDeckRecording)}
        disabled={!canRecordDeck}
        title={canRecordDeck ? "Record what you play onto a layer, in time with the song (Menu on the Deck)" : "Recording the Deck needs the native engine"}
        data-role="inst-rec"
      >{$transport.isRecording ? "● REC…" : "● REC"} <small>menu</small></button>
      <button class="btn" onclick={screenOnly(togglePlay)} data-role="inst-play">{$transport.isPlaying ? "■ STOP" : "▶ PLAY"} <small>view</small></button>
      <button class="btn" class:accent={$metronome} onclick={screenOnly(toggleMetronome)} disabled={!canClick} aria-pressed={$metronome} data-role="inst-click">♩</button>
      <span class="val screen wide" data-role="inst-bars">{formatBarsBeats($transport.playhead, $project.tempo)}</span>
    </div>
    <div class="group">
      <span class="lbl">SOUND <small>L3</small></span>
      {#each LIVE_PATCHES as p, i (p)}
        <button class="btn patch" class:accent={v.patch === i} data-role="inst-patch-{p}" onclick={screenOnly(() => setInstrument({ patch: i }))}>{p}</button>
      {/each}
    </div>
  </div>

  <div class="stage">
    <div class="box left" data-title="left pad · macro">
      <div class="xy" class:live={v.lpad.touch}>
        <span class="axis x">CUTOFF →</span>
        <span class="axis y">REVERB →</span>
        <span class="dot" style="left:{((v.lpad.x + 1) / 2) * 100}%; top:{(1 - (v.lpad.y + 1) / 2) * 100}%"></span>
      </div>
      <div class="bars">
        {#each [["BEND", (v.controls.bend + 4) / 8, "L-stick"], ["MOD", v.controls.mod, "R-stick ↑"], ["EXPR", v.controls.expr, "R2"]] as [name, frac, hint] (name)}
          <div class="bar">
            <span class="lbl">{name} <small>{hint}</small></span>
            <span class="track"><span class="fill" style="width:{Math.max(0, Math.min(1, Number(frac))) * 100}%"></span></span>
          </div>
        {/each}
        <div class="flags">
          <span class="flag" class:on={v.controls.sustain}>SUSTAIN · L5</span>
          <span class="flag" class:on={v.tiltArmed}>TILT BEND · R5</span>
        </div>
      </div>
    </div>

    <div class="box pads-box" data-title="pads · abxy">
      <div class="pads">
        {#each PAD_SLOTS as p (p.i)}
          <button
            class="pad"
            class:hit={v.pads[p.i]}
            style="grid-area:{p.area}"
            data-role="inst-pad-{p.btn.toLowerCase()}"
            onpointerdown={(e) => padDown(e, p.i)}
            onpointerup={release}
            onpointercancel={release}
          >
            <b>{p.btn}</b>
            <span>{bank === "drums" ? DRUM_NAMES[p.i] : chordName(v, CHORD_DEGREES[p.i])}</span>
          </button>
        {/each}
      </div>
      <button class="btn bank" class:accent={bank === "chords"} onclick={screenOnly(() => (screenChords = !screenChords))} title="On the Deck: hold L1 or R1">
        {bank === "chords" ? "CHORDS" : "DRUMS"} <small>hold L1/R1</small>
      </button>
    </div>

    <div class="box right" data-title="right pad · notes">
      <div class="grid" style="grid-template-columns: repeat({cols}, 1fr)" data-role="inst-grid">
        {#each Array.from({ length: GRID_ROWS }, (_, k) => GRID_ROWS - 1 - k) as row (row)}
          {#each Array.from({ length: cols }, (_, c) => c) as col (col)}
            {@const n = cellNote(v, col, row)}
            <button
              class="cell"
              class:root={col === 0}
              class:on={v.cell?.col === col && v.cell?.row === row}
              data-note={n}
              onpointerdown={(e) => press(e, () => [screenNoteOn(n)])}
              onpointerup={release}
              onpointercancel={release}
            >{noteName(n)}</button>
          {/each}
        {/each}
        {#if v.rpad.touch}
          <span class="thumb" style="left:{((v.rpad.x + 1) / 2) * 100}%; top:{(1 - (v.rpad.y + 1) / 2) * 100}%"></span>
        {/if}
      </div>
    </div>
  </div>
</section>

<style>
  .instrument {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0 6px;
  }
  .take .rec.on {
    color: var(--danger);
    border-color: var(--danger);
  }
  .take small {
    opacity: 0.6;
    font-size: 9px;
  }
  .settings {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 18px;
    padding: 8px 10px 6px;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .lbl {
    font-size: 11px;
    font-weight: bold;
    letter-spacing: 1px;
    color: var(--box-title);
    margin-right: 4px;
  }
  small {
    font-size: 9px;
    font-weight: normal;
    color: var(--ink-dim);
  }
  .btn.step {
    min-height: 34px;
    padding: 0 10px;
  }
  .btn.patch {
    min-height: 34px;
    padding: 0 8px;
    font-size: 11px;
  }
  .val {
    min-width: 34px;
    text-align: center;
    padding: 6px 6px;
    font-weight: bold;
    color: var(--green);
  }
  .val.wide {
    min-width: 92px;
  }
  .stage {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 0.8fr 1.5fr;
    gap: 8px;
  }
  .stage > .box {
    padding: 12px 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }
  .xy {
    position: relative;
    flex: 1 1 auto;
    min-height: 90px;
    border: 1px dashed var(--box);
    background: var(--panel-lo);
  }
  .xy.live {
    border-style: solid;
    border-color: var(--green);
  }
  .axis {
    position: absolute;
    font-size: 9px;
    color: var(--ink-dim);
  }
  .axis.x {
    bottom: 3px;
    right: 5px;
  }
  .axis.y {
    top: 5px;
    left: 3px;
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    top: auto;
    bottom: 5px;
  }
  .dot,
  .thumb {
    position: absolute;
    width: 14px;
    height: 14px;
    margin: -7px 0 0 -7px;
    border-radius: 50%;
    background: var(--magenta);
    box-shadow: var(--glow);
    pointer-events: none;
  }
  .bars {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bar {
    display: grid;
    grid-template-columns: 96px 1fr;
    align-items: center;
  }
  .track {
    height: 8px;
    background: var(--panel-lo);
    border: 1px solid var(--box);
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--green);
  }
  .flags {
    display: flex;
    gap: 6px;
  }
  .flag {
    font-size: 10px;
    padding: 3px 6px;
    border: 1px solid var(--box);
    color: var(--ink-dim);
  }
  .flag.on {
    background: var(--amber);
    border-color: var(--amber);
    color: var(--on-accent);
  }
  .pads-box {
    align-items: center;
    justify-content: center;
  }
  .pads {
    display: grid;
    grid-template-areas: ". y ." "x . b" ". a .";
    grid-template-columns: repeat(3, 72px);
    grid-template-rows: repeat(3, 72px);
    gap: 4px;
  }
  .pad {
    font-family: var(--font);
    border: 1px solid var(--box);
    background: var(--panel-hi);
    color: var(--ink);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    font-size: 11px;
    cursor: pointer;
    touch-action: none;
    box-shadow: var(--extrude);
  }
  .pad b {
    font-size: 18px;
    color: var(--magenta);
  }
  .pad.hit,
  .pad:active {
    background: var(--magenta);
    color: var(--on-accent);
  }
  .pad.hit b,
  .pad:active b {
    color: var(--on-accent);
  }
  .btn.bank {
    min-height: 34px;
    font-size: 11px;
  }
  .btn.accent small {
    color: inherit;
    opacity: 0.75;
  }
  .grid {
    position: relative;
    flex: 1 1 auto;
    display: grid;
    grid-auto-rows: 1fr;
    gap: 3px;
    min-height: 0;
    touch-action: none;
  }
  .cell {
    font-family: var(--font);
    font-size: 12px;
    font-weight: bold;
    border: 1px solid var(--box);
    background: var(--panel-lo);
    color: var(--ink-dim);
    cursor: pointer;
    touch-action: none;
  }
  .cell.root {
    background: var(--panel-hi);
    color: var(--ink);
  }
  .cell.on,
  .cell:active {
    background: var(--green);
    color: var(--on-accent);
    box-shadow: var(--glow);
  }
</style>
