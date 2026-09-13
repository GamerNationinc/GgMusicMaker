<script lang="ts">
  // Retro export popup: a chunky panel over the app with an ASCII block
  // progress bar. The bar is real — it follows OfflineAudioContext render
  // checkpoints — then steps through ENCODING / SAVING and shows the result.
  import { exportState, dismissExport } from "../state/store";

  const CELLS = 28;

  const label = $derived(
    {
      idle: "",
      rendering: "RENDERING MIX",
      encoding: "ENCODING WAV",
      saving: "SAVING",
      done: "EXPORT COMPLETE",
      error: "EXPORT FAILED",
    }[$exportState.phase],
  );
  const filled = $derived(Math.round($exportState.fraction * CELLS));
  const bar = $derived("█".repeat(filled) + "░".repeat(CELLS - filled));
  const pct = $derived(String(Math.round($exportState.fraction * 100)).padStart(3, " "));
  const busy = $derived(
    $exportState.phase === "rendering" ||
      $exportState.phase === "encoding" ||
      $exportState.phase === "saving",
  );

  function onKey(e: KeyboardEvent) {
    if (!busy && (e.key === "Escape" || e.key === "Enter")) dismissExport();
  }
</script>

<svelte:window on:keydown={onKey} />

{#if $exportState.phase !== "idle"}
  <div class="backdrop" role="dialog" aria-modal="true" aria-label="Export progress">
    <div class="dialog panel" class:done={$exportState.phase === "done"} class:error={$exportState.phase === "error"}>
      <div class="title">
        <span class="icon">⭳</span> EXPORT WAV
      </div>

      <div class="screen readout">
        <div class="phase">
          {label}{#if busy}<span class="cursor">▮</span>{/if}
        </div>
        <div class="bar">[{bar}] {pct}%</div>
        {#if $exportState.message}
          <div class="msg">{$exportState.message}</div>
        {/if}
      </div>

      {#if !busy}
        <button class="btn accent" onclick={dismissExport}>OK</button>
      {:else}
        <div class="label hint">please wait…</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(5, 4, 12, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .dialog {
    width: 460px;
    max-width: 92vw;
    padding: 14px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 8px 8px 0 rgba(0, 0, 0, 0.6);
  }
  .title {
    font-weight: bold;
    letter-spacing: 2px;
    color: var(--green);
    text-shadow: 2px 2px 0 var(--panel-lo);
    font-size: 15px;
  }
  .icon {
    color: var(--magenta);
  }
  .readout {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 14px;
  }
  .phase {
    letter-spacing: 1px;
  }
  .bar {
    font-size: 15px;
    letter-spacing: 0;
    white-space: pre;
  }
  .msg {
    font-size: 12px;
    color: var(--ink-dim);
    text-shadow: none;
    word-break: break-all;
  }
  .cursor {
    animation: blink 0.8s steps(2, start) infinite;
    margin-left: 2px;
  }
  @keyframes blink {
    to {
      visibility: hidden;
    }
  }
  .hint {
    text-align: right;
  }
  .error .title {
    color: var(--danger);
  }
  .error .readout {
    color: var(--danger);
  }
  .done .readout {
    color: var(--green);
  }
  .btn {
    align-self: flex-end;
    min-width: 90px;
  }
</style>
