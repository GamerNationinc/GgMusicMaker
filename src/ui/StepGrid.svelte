<script lang="ts">
  // Instrument mode → PADS → STEPS: the selected pattern as a grid — the
  // bank's 16 pads down, 16 steps across (pages for longer patterns). Tap an
  // empty step to add a note (and select it), tap a note to select it, tap
  // the selected note again to take it away. The playhead column follows.
  import { project, seq, currentPattern, toggleSeqStep, setPatternSteps, setSwing, clearPattern } from "../state/store";
  import { patternAt } from "../seq/pattern";
  import { selectedNote, stepPage } from "./seqView";
  import { STEP_CHOICES, noteAt } from "../seq/pattern";
  import { padAt, padLabel, slotOf } from "../pads/pads";
  import type { InstrumentView } from "../input/instrument";
  import { screenOnly } from "../input/controller";

  let { v }: { v: InstrumentView } = $props();

  const pattern = $derived(patternAt($project.patterns, $seq.pattern));
  const pages = $derived(pattern.steps / 16);
  const page = $derived(Math.min($stepPage, pages - 1));
  const steps = $derived(Array.from({ length: 16 }, (_, i) => page * 16 + i));
  const rows = $derived(Array.from({ length: 16 }, (_, i) => slotOf(v.padBank, i)));

  function tap(slot: number, step: number) {
    const n = noteAt(pattern, slot, step);
    if (n && $selectedNote !== n.id) {
      selectedNote.set(n.id);
      return;
    }
    toggleSeqStep(slot, step);
    selectedNote.set(n ? null : (noteAt(currentPattern(), slot, step)?.id ?? null));
  }
</script>

<div class="box steps-box" data-title="pattern {$seq.pattern + 1} · bank {'ABCDEFGHIJ'[v.padBank]}" data-title-right="tap: add · select · remove" data-role="step-grid">
  <div class="head">
    <span class="lbl">LEN</span>
    {#each STEP_CHOICES as n (n)}
      <button class="btn small" class:accent={pattern.steps === n} data-role="seq-len-{n}" onclick={() => setPatternSteps(n)}>{n}</button>
    {/each}
    {#if pages > 1}
      <span class="lbl">PAGE</span>
      {#each Array.from({ length: pages }, (_, i) => i) as i (i)}
        <button class="btn small" class:accent={page === i} onclick={() => stepPage.set(i)}>{i + 1}</button>
      {/each}
    {/if}
    <label class="swing">
      <span class="lbl">SWING</span>
      <input type="range" min="0" max="0.5" step="0.01" value={pattern.swing} data-role="seq-swing" oninput={(e) => setSwing(Number((e.target as HTMLInputElement).value))} />
      <small>{Math.round(50 + pattern.swing * 50)}%</small>
    </label>
    <button class="btn small danger" onclick={clearPattern}>CLEAR</button>
  </div>
  <div class="grid">
    {#each rows as slot, r (slot)}
      {@const pad = padAt($project.pads, slot)}
      <span class="row-name" class:empty={!pad} class:held={v.padsHeld.includes(slot)} title={pad?.name ?? "empty pad"}>
        <b>{r + 1}</b>{pad ? pad.name : "—"}
      </span>
      {#each steps as step (step)}
        {@const n = noteAt(pattern, slot, step)}
        <button
          class="cell"
          class:beat={step % 4 === 0}
          class:on={!!n}
          class:sel={!!n && n.id === $selectedNote}
          class:now={$seq.step === step}
          style={n ? `--vel:${0.35 + 0.65 * n.vel}` : ""}
          data-role="step-{padLabel(slot)}-{step + 1}"
          onclick={screenOnly(() => tap(slot, step))}
          aria-label="{padLabel(slot)} step {step + 1}"
        >
          {#if n?.lock}<i class="lock"></i>{/if}
          {#if n && (n.cond || n.prob < 1)}<i class="cond"></i>{/if}
        </button>
      {/each}
    {/each}
  </div>
</div>

<style>
  .steps-box {
    padding: 12px 8px 8px;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .lbl {
    font-size: 11px;
    font-weight: bold;
    letter-spacing: 1px;
    color: var(--box-title);
    margin: 0 2px 0 8px;
  }
  .lbl:first-child {
    margin-left: 0;
  }
  .btn.small {
    min-height: 30px;
    min-width: 36px;
    padding: 0 6px;
    font-size: 11px;
  }
  .swing {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
  }
  .swing input {
    width: 90px;
  }
  small {
    font-size: 10px;
    color: var(--ink-dim);
    min-width: 28px;
  }
  .grid {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: 88px repeat(16, 1fr);
    grid-auto-rows: 1fr;
    gap: 2px;
    touch-action: manipulation;
  }
  .row-name {
    font-size: 10px;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .row-name b {
    color: var(--magenta);
    min-width: 16px;
  }
  .row-name.empty {
    color: var(--ink-dim);
    opacity: 0.6;
  }
  .row-name.held b {
    color: var(--amber);
  }
  .cell {
    position: relative;
    border: 1px solid var(--box);
    background: var(--panel-lo);
    min-height: 0;
    padding: 0;
    cursor: pointer;
  }
  .cell.beat {
    background: var(--panel-hi);
  }
  .cell.on {
    background: var(--magenta);
    opacity: var(--vel);
  }
  .cell.sel {
    box-shadow: inset 0 0 0 2px var(--amber);
    opacity: 1;
  }
  .cell.now {
    border-color: var(--amber);
  }
  .lock,
  .cond {
    position: absolute;
    width: 5px;
    height: 5px;
    border-radius: 50%;
  }
  .lock {
    top: 2px;
    right: 2px;
    background: var(--amber);
  }
  .cond {
    bottom: 2px;
    left: 2px;
    background: var(--cyan);
  }
</style>
