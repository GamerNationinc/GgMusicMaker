<script lang="ts">
  // Header switch between the app's modes (docs/deck-dual-mode.md). The
  // same switch is on the controller: View + Menu together.
  // While the Deck is performing, mouse clicks are Steam's R2 emulation at
  // a drifting cursor: only touch switches modes then (screenOnly).
  import { MODES, mode, setMode, screenOnly } from "../input/controller";
</script>

<div class="mode-switch" title="Mode. On the Deck: press View + Menu together to switch.">
  {#each MODES as m (m.id)}
    <button
      class="mode"
      class:on={$mode === m.id}
      class:soon={!m.ready}
      data-role="mode-{m.id}"
      onclick={screenOnly(() => setMode(m.id))}
      title={m.ready ? `${m.label} mode` : `${m.label} mode — next milestone`}
    >{m.label.toUpperCase()}</button>
  {/each}
</div>

<style>
  .mode-switch {
    display: flex;
    gap: 3px;
    flex: 0 0 auto;
  }
  .mode {
    font-family: var(--font);
    font-size: 10px;
    font-weight: bold;
    letter-spacing: 0.5px;
    min-height: 30px;
    padding: 0 6px;
    border: 1px solid var(--box);
    background: var(--panel-lo);
    color: var(--ink-dim);
    cursor: pointer;
  }
  .mode.on {
    background: var(--magenta);
    border-color: var(--magenta);
    color: var(--on-accent);
  }
  .mode.soon {
    opacity: 0.45;
  }
</style>
