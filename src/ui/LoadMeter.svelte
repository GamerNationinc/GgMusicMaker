<script lang="ts">
  // Ableton-style load readout for the header: a CPU percentage with a short
  // block bar, a "D" lamp that flashes when the audio clock fell behind
  // (a dropout), and an ECO toggle for battery — off goes the backdrop, down
  // go the meter rates. The number is UI-thread utilisation: a WebView cannot
  // read the audio thread, so the lamp is the audio-side truth.
  import { systemLoad, lowPower, toggleLowPower } from "../state/store";
  import { loadBand } from "../state/load";

  const CELLS = 6;
  const pct = $derived(Math.round($systemLoad.cpu * 100));
  const filled = $derived(Math.min(CELLS, Math.round($systemLoad.cpu * CELLS)));
  const band = $derived(loadBand($systemLoad.cpu));
</script>

<div class="load screen" title="UI-thread load. D lights when the audio thread could not keep up (dropout).">
  <span class="label">CPU</span>
  <span class="bar {band}" aria-hidden="true">{"▮".repeat(filled)}{"▯".repeat(CELLS - filled)}</span>
  <span class="pct" data-role="cpu">{String(pct).padStart(3, " ")}%</span>
  <span
    class="lamp"
    class:lit={$systemLoad.dropout}
    title={`Audio dropouts: ${$systemLoad.dropouts}`}
    data-role="dropout"
  >D</span>
  <button
    class="eco"
    class:on={$lowPower}
    onclick={toggleLowPower}
    title="Low-power mode: turns off the backdrop and slows the meters (saves battery)"
    aria-pressed={$lowPower}
  >ECO</button>
</div>

<style>
  .load {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    font-size: 12px;
    white-space: nowrap;
  }
  .label {
    color: var(--ink-dim);
    letter-spacing: 1px;
  }
  .bar {
    letter-spacing: -1px;
  }
  .bar.ok {
    color: var(--green);
  }
  .bar.warn {
    color: var(--amber);
  }
  .bar.hot {
    color: var(--danger);
  }
  .pct {
    min-width: 4ch;
    text-align: right;
  }
  .lamp {
    padding: 0 4px;
    border: 1px solid var(--bevel-dark);
    color: var(--ink-dim);
    font-weight: bold;
  }
  .lamp.lit {
    color: #000;
    background: var(--danger);
    border-color: var(--danger);
    text-shadow: none;
  }
  .eco {
    font-family: var(--font);
    font-size: 11px;
    font-weight: bold;
    letter-spacing: 1px;
    padding: 1px 6px;
    color: var(--ink-dim);
    background: transparent;
    border: 1px solid var(--bevel-dark);
    cursor: pointer;
    min-height: 0;
  }
  .eco.on {
    color: #000;
    background: var(--green);
    border-color: var(--green);
  }
</style>
