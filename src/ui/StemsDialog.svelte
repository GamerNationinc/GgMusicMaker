<script lang="ts">
  // Stem separation progress: same retro popup as the export, with a real
  // progress bar (segments done in the native engine) and a Cancel button.
  import { stemState, cancelStems, dismissStems } from "../state/store";

  const CELLS = 28;
  const label = $derived(
    {
      idle: "",
      preparing: "PREPARING",
      separating: "SEPARATING STEMS",
      loading: "LOADING STEMS",
      done: "STEMS READY",
      error: "SEPARATION FAILED",
      cancelled: "CANCELLED",
    }[$stemState.phase],
  );
  const filled = $derived(Math.round($stemState.fraction * CELLS));
  const bar = $derived("█".repeat(filled) + "░".repeat(CELLS - filled));
  const pct = $derived(String(Math.round($stemState.fraction * 100)).padStart(3, " "));
  const busy = $derived($stemState.phase === "preparing" || $stemState.phase === "separating" || $stemState.phase === "loading");

  function onKey(e: KeyboardEvent) {
    if (!busy && (e.key === "Escape" || e.key === "Enter")) dismissStems();
  }
</script>

<svelte:window on:keydown={onKey} />

{#if $stemState.phase !== "idle"}
  <div class="backdrop" role="dialog" aria-modal="true" aria-label="Stem separation">
    <div class="dialog panel" class:done={$stemState.phase === "done"} class:error={$stemState.phase === "error"}>
      <div class="title"><span class="icon">⋔</span> STEM SEPARATION</div>

      <div class="screen readout">
        <div class="phase">
          {label}{#if busy}<span class="cursor">▮</span>{/if}
        </div>
        <div class="bar">[{bar}] {pct}%</div>
        {#if $stemState.message}
          <div class="msg">{$stemState.message}</div>
        {/if}
      </div>

      {#if busy}
        <div class="row">
          <span class="label hint">HTDemucs · vocals / drums / bass / guitar / piano / other</span>
          <button class="btn" onclick={cancelStems} disabled={$stemState.phase === "loading"}>Cancel</button>
        </div>
      {:else}
        <button class="btn accent" onclick={dismissStems}>OK</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .dialog {
    width: 520px;
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
    white-space: pre;
  }
  .msg {
    font-size: 12px;
    color: var(--ink-dim);
    text-shadow: none;
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
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .hint {
    font-size: 11px;
  }
  .error .title,
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
