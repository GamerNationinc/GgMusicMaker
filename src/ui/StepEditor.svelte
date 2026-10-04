<script lang="ts">
  // The selected step (STEPS view): its velocity, timing, length, chance and
  // condition, and its parameter locks — pad settings for this hit only
  // (Elektron's p-locks). An unlocked setting shows the pad's own value.
  import { project, seq, updateSeqNote, lockSeqNote, toggleSeqStep } from "../state/store";
  import { selectedNote } from "./seqView";
  import { CONDITIONS, patternAt, type StepCond, type StepLock } from "../seq/pattern";
  import { PAD_RANGES, padAt, padLabel } from "../pads/pads";

  const pattern = $derived(patternAt($project.patterns, $seq.pattern));
  const note = $derived(pattern.notes.find((n) => n.id === $selectedNote));
  const pad = $derived(note ? padAt($project.pads, note.slot) : undefined);

  const COND_LABEL: Record<StepCond, string> = {
    "": "ALWAYS",
    "1:2": "1:2", "2:2": "2:2", "1:3": "1:3", "2:3": "2:3", "3:3": "3:3",
    "1:4": "1:4", "2:4": "2:4", "3:4": "3:4", "4:4": "4:4",
    first: "1ST", "!first": "NOT 1ST",
  };
  const LOCKS: { key: "gain" | "pan" | "pitch"; label: string; step: number; fmt: (x: number) => string }[] = [
    { key: "gain", label: "GAIN", step: 0.01, fmt: (x) => `${x <= 0 ? "-∞" : (20 * Math.log10(x)).toFixed(1)} dB` },
    { key: "pan", label: "PAN", step: 0.01, fmt: (x) => (Math.abs(x) < 0.005 ? "C" : `${x < 0 ? "L" : "R"} ${Math.round(Math.abs(x) * 100)}`) },
    { key: "pitch", label: "PITCH", step: 1, fmt: (x) => `${x > 0 ? "+" : ""}${x} st` },
  ];
  const num = (e: Event) => Number((e.target as HTMLInputElement).value);
  const lockVal = (key: keyof StepLock) => note?.lock?.[key];
</script>

<div class="box step-edit" data-title={note ? `step ${note.step + 1} · pad ${padLabel(note.slot)}` : "step"} data-role="step-editor">
  <div class="body">
    {#if note}
      <label class="knob">
        <span class="lbl">VEL</span>
        <input type="range" min="0.05" max="1" step="0.01" value={note.vel} data-role="step-vel" oninput={(e) => updateSeqNote(note.id, { vel: num(e) }, `vel:${note.id}`)} />
        <span class="val">{Math.round(note.vel * 127)}</span>
      </label>
      <label class="knob">
        <span class="lbl">NUDGE</span>
        <input type="range" min="-0.5" max="0.5" step="0.01" value={note.micro} oninput={(e) => updateSeqNote(note.id, { micro: num(e) }, `micro:${note.id}`)} />
        <span class="val">{note.micro > 0 ? "+" : ""}{Math.round(note.micro * 100)}%</span>
      </label>
      <label class="knob">
        <span class="lbl">LENGTH</span>
        <input type="range" min="1" max={pattern.steps} step="1" value={note.len} oninput={(e) => updateSeqNote(note.id, { len: num(e) }, `len:${note.id}`)} />
        <span class="val">{note.len} step{note.len === 1 ? "" : "s"}</span>
      </label>
      <label class="knob">
        <span class="lbl">CHANCE</span>
        <input type="range" min="0" max="1" step="0.05" value={note.prob} data-role="step-prob" oninput={(e) => updateSeqNote(note.id, { prob: num(e) }, `prob:${note.id}`)} />
        <span class="val">{Math.round(note.prob * 100)}%</span>
      </label>
      <div class="row">
        <span class="lbl">PLAYS</span>
        <select class="btn cond" value={note.cond} data-role="step-cond" onchange={(e) => updateSeqNote(note.id, { cond: (e.target as HTMLSelectElement).value as StepCond })}>
          {#each CONDITIONS as c (c)}
            <option value={c}>{COND_LABEL[c]}</option>
          {/each}
        </select>
        <small>{note.cond.includes(":") ? `loop ${note.cond.replace(":", " of every ")}` : ""}</small>
      </div>
      <p class="sub">LOCKS <small>this hit only — tap 🔒 to unlock</small></p>
      {#each LOCKS as k (k.key)}
        {@const locked = lockVal(k.key) !== undefined}
        {@const value = (lockVal(k.key) as number | undefined) ?? (pad ? pad[k.key] : 0)}
        <label class="knob" class:unlocked={!locked}>
          <span class="lbl">{k.label}</span>
          <input type="range" min={PAD_RANGES[k.key][0]} max={PAD_RANGES[k.key][1]} step={k.step} {value} data-role="lock-{k.key}" oninput={(e) => lockSeqNote(note.id, k.key, num(e))} />
          <button class="lockbtn" class:on={locked} disabled={!locked} onclick={() => lockSeqNote(note.id, k.key, undefined)} title="Unlock: use the pad's setting">{locked ? "🔒" : ""} {k.fmt(value)}</button>
        </label>
      {/each}
      <div class="row">
        <span class="lbl">REVERSE</span>
        {#each [["pad", undefined], ["on", true], ["off", false]] as const as [label, val] (label)}
          <button class="btn seg" class:accent={note.lock?.reverse === val} onclick={() => lockSeqNote(note.id, "reverse", val)}>{label === "pad" ? "PAD'S" : label.toUpperCase()}</button>
        {/each}
      </div>
      <div class="row">
        <button class="btn danger" onclick={() => (toggleSeqStep(note.slot, note.step), selectedNote.set(null))}>REMOVE STEP</button>
      </div>
    {:else}
      <p class="hint">Tap a step to add a note, tap it again to edit it here: velocity, nudge, length, chance, which loops it plays on, and locks — pad settings for that one hit.</p>
    {/if}
  </div>
</div>

<style>
  .step-edit {
    display: flex;
    flex-direction: column;
    padding: 12px 10px 10px;
    min-height: 0;
    flex: 1 1 auto;
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .body > * {
    flex-shrink: 0;
  }
  .knob {
    display: grid;
    grid-template-columns: 64px 1fr 92px;
    align-items: center;
    gap: 6px;
  }
  .knob.unlocked input {
    opacity: 0.45;
  }
  .lbl {
    font-size: 11px;
    font-weight: bold;
    letter-spacing: 1px;
    color: var(--box-title);
  }
  .val,
  small {
    font-size: 11px;
    color: var(--ink-dim);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .btn.cond,
  .btn.seg {
    min-height: 30px;
    font-size: 11px;
    padding: 0 6px;
  }
  .sub {
    margin: 4px 0 0;
    font-size: 11px;
    font-weight: bold;
    color: var(--box-title);
  }
  .lockbtn {
    font-family: var(--font);
    font-size: 11px;
    text-align: left;
    background: none;
    border: none;
    color: var(--ink-dim);
    padding: 0;
    cursor: pointer;
  }
  .lockbtn.on {
    color: var(--amber);
  }
  .hint {
    font-size: 12px;
    color: var(--ink-dim);
  }
</style>
