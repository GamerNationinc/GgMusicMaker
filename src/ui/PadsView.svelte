<script lang="ts">
  // Instrument mode → PADS: the bank's 4×4 pads and the selected pad's
  // settings. The Deck mapping is in src/input/instrument.ts; this draws it
  // and plays the pads from the touchscreen.
  import { project, playPad, releasePad, setPadParam, setPadMode, togglePadFlag, renamePad, clearPadSlot, loadPadFromClip, loadPadFiles, openChopForPad } from "../state/store";
  import { setInstrument, deckPerforming } from "../input/controller";
  import { PAD_KEY_LABELS, type InstrumentView } from "../input/instrument";
  import { PAD_MODES, PAD_MODE_LABEL, PAD_RANGES, padAt, padLabel, slotOf, type PadKnob } from "../pads/pads";

  let { v }: { v: InstrumentView } = $props();

  const slots = $derived(Array.from({ length: 16 }, (_, i) => slotOf(v.padBank, i)));
  const sel = $derived(padAt($project.pads, v.pad));
  let fileInput: HTMLInputElement;

  /** Screen-held pads (pointer id → slot). */
  let held = $state<Record<number, number>>({});

  // Steam's R2 is a mouse click at a drifting cursor: while the Deck plays,
  // only touch / pen play the screen.
  const accept = (e: PointerEvent) => !($deckPerforming && e.pointerType === "mouse");

  function down(e: PointerEvent, slot: number) {
    if (!accept(e)) return;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* a pointer the browser no longer tracks: no capture, still plays */
    }
    held = { ...held, [e.pointerId]: slot };
    setInstrument({ pad: slot });
    if (padAt($project.pads, slot)) playPad(slot);
  }
  function up(e: PointerEvent) {
    const slot = held[e.pointerId];
    if (slot === undefined) return;
    const { [e.pointerId]: _, ...rest } = held;
    held = rest;
    releasePad(slot);
  }

  const KNOBS: { key: PadKnob; label: string; step: number; fmt: (x: number) => string }[] = [
    { key: "gain", label: "GAIN", step: 0.01, fmt: (x) => `${x <= 0 ? "-∞" : (20 * Math.log10(x)).toFixed(1)} dB` },
    { key: "pan", label: "PAN", step: 0.01, fmt: (x) => (Math.abs(x) < 0.005 ? "C" : `${x < 0 ? "L" : "R"} ${Math.round(Math.abs(x) * 100)}`) },
    { key: "pitch", label: "PITCH", step: 1, fmt: (x) => `${x > 0 ? "+" : ""}${x} st` },
    { key: "attack", label: "ATTACK", step: 0.001, fmt: (x) => `${Math.round(x * 1000)} ms` },
    { key: "release", label: "RELEASE", step: 0.005, fmt: (x) => `${Math.round(x * 1000)} ms` },
  ];
  const keyHint = (i: number) => (i < 8 ? PAD_KEY_LABELS[i] : `L1 ${PAD_KEY_LABELS[i - 8]}`);

  function onFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) void loadPadFiles(v.pad, input.files);
    input.value = "";
  }
</script>

<div class="pads-stage">
  <div class="box grid-box" data-title="pads · bank {'ABCDEFGHIJ'[v.padBank]}" data-title-right="right pad · d-pad · xyab">
    <div class="grid" data-role="pad-grid">
      {#each slots as slot, i (slot)}
        {@const pad = padAt($project.pads, slot)}
        <button
          class="pad"
          class:empty={!pad}
          class:hit={v.padsHeld.includes(slot) || Object.values(held).includes(slot)}
          class:sel={v.pad === slot}
          data-role="pad-{padLabel(slot)}"
          onpointerdown={(e) => down(e, slot)}
          onpointerup={up}
          onpointercancel={up}
        >
          <span class="num">{i + 1}</span>
          <span class="key">{keyHint(i)}</span>
          <span class="name">{pad ? pad.name : "empty"}</span>
        </button>
      {/each}
    </div>
  </div>

  <div class="box edit" data-title="pad {padLabel(v.pad)}" data-role="pad-editor">
    <div class="edit-body">
    {#if sel}
      <input
        class="pad-name screen"
        value={sel.name}
        onchange={(e) => renamePad(v.pad, (e.target as HTMLInputElement).value)}
        aria-label="Pad name"
      />
      <div class="row">
        {#each PAD_MODES as m (m)}
          <button class="btn seg" class:accent={sel.mode === m} data-role="pad-mode-{m}" onclick={() => setPadMode(v.pad, m)}>{PAD_MODE_LABEL[m]}</button>
        {/each}
      </div>
      <div class="row">
        <button class="btn seg" class:accent={sel.reverse} data-role="pad-reverse" onclick={() => togglePadFlag(v.pad, "reverse")}>⇄ REVERSE</button>
        <button class="btn seg" class:accent={sel.mono} onclick={() => togglePadFlag(v.pad, "mono")} title="Mono: hitting it again cuts the last hit">{sel.mono ? "MONO" : "POLY"}</button>
        <span class="lbl">CHOKE</span>
        {#each [0, 1, 2, 3, 4] as c (c)}
          <button class="btn seg small" class:accent={sel.choke === c} onclick={() => setPadParam(v.pad, "choke", c)} title={c ? `Choke group ${c}: pads in it cut each other` : "No choke group"}>{c || "–"}</button>
        {/each}
      </div>
      {#each KNOBS as k (k.key)}
        <label class="knob">
          <span class="lbl">{k.label}</span>
          <input
            type="range"
            min={PAD_RANGES[k.key][0]}
            max={PAD_RANGES[k.key][1]}
            step={k.step}
            value={sel[k.key]}
            data-role="pad-{k.key}"
            oninput={(e) => setPadParam(v.pad, k.key, Number((e.target as HTMLInputElement).value))}
          />
          <span class="val">{k.fmt(sel[k.key])}</span>
        </label>
      {/each}
      <div class="row">
        <span class="region">{sel.start.toFixed(3)}–{sel.end.toFixed(3)} s · {(sel.end - sel.start).toFixed(2)} s</span>
      </div>
      <div class="row actions">
        <button class="btn magenta" data-role="pad-chop" onclick={() => openChopForPad(v.pad)}>✂ CHOP</button>
        <button class="btn" onclick={() => loadPadFromClip(v.pad)} title="The clip selected in Studio">⇠ CLIP</button>
        <button class="btn" onclick={() => fileInput.click()}>⇠ FILE</button>
        <button class="btn danger" data-role="pad-clear" onclick={() => clearPadSlot(v.pad)}>CLEAR</button>
      </div>
    {:else}
      <p class="hint">Empty. Load a sample onto it:</p>
      <div class="row actions">
        <button class="btn" data-role="pad-load-clip" onclick={() => loadPadFromClip(v.pad)} title="The clip selected in Studio">⇠ SELECTED CLIP</button>
        <button class="btn" data-role="pad-load-file" onclick={() => fileInput.click()}>⇠ AUDIO FILE…</button>
      </div>
      <p class="hint">…or play something and press <b>R3</b> (skip back) / <b>L1+R3</b> (resample) — it lands here.</p>
    {/if}
    </div>
    <input bind:this={fileInput} type="file" accept="audio/*" multiple hidden data-role="pad-file" onchange={onFiles} />
  </div>
</div>

<style>
  .pads-stage {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: 1.35fr 1fr;
    gap: 8px;
  }
  .pads-stage > .box {
    padding: 12px 10px 10px;
    min-height: 0;
  }
  .grid {
    height: 100%;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    grid-auto-rows: 1fr;
    gap: 5px;
    touch-action: none;
  }
  .pad {
    position: relative;
    font-family: var(--font);
    border: 1px solid var(--box);
    background: var(--panel-hi);
    color: var(--ink);
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: flex-start;
    padding: 4px 6px;
    min-height: 44px;
    overflow: hidden;
    cursor: pointer;
    touch-action: none;
    box-shadow: var(--extrude);
    text-align: left;
  }
  .pad.empty {
    background: var(--panel-lo);
    color: var(--ink-dim);
  }
  .pad.sel {
    box-shadow: inset 0 0 0 2px var(--amber);
  }
  .pad.hit {
    background: var(--magenta);
    color: var(--on-accent);
  }
  .num {
    position: absolute;
    top: 3px;
    left: 6px;
    font-size: 15px;
    font-weight: bold;
    color: var(--magenta);
  }
  .pad.hit .num,
  .pad.hit .key {
    color: var(--on-accent);
  }
  .key {
    position: absolute;
    top: 4px;
    right: 6px;
    font-size: 10px;
    color: var(--ink-dim);
  }
  .name {
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  /* The box title sits above the border: the scrolling is inside. */
  .edit {
    display: flex;
    flex-direction: column;
  }
  .edit-body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow-y: auto;
  }
  .pad-name {
    font-family: var(--font);
    font-size: 13px;
    padding: 5px 8px;
    color: var(--green);
    border: 1px solid var(--box);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .btn.seg {
    min-height: 32px;
    padding: 0 8px;
    font-size: 11px;
  }
  .btn.seg.small {
    min-width: 30px;
    padding: 0 4px;
  }
  .lbl {
    font-size: 11px;
    font-weight: bold;
    letter-spacing: 1px;
    color: var(--box-title);
    margin: 0 2px 0 6px;
  }
  .knob {
    display: grid;
    grid-template-columns: 70px 1fr 74px;
    align-items: center;
    gap: 6px;
  }
  .knob .lbl {
    margin: 0;
  }
  .val,
  .region {
    font-size: 11px;
    color: var(--ink-dim);
  }
  .actions .btn {
    min-height: 36px;
    font-size: 11px;
  }
  .hint {
    margin: 4px 0;
    font-size: 12px;
    color: var(--ink-dim);
  }
</style>
