<script lang="ts">
  // Header switch between the web audio engine and the native (Rust) one.
  // Desktop app only; the choice is applied at startup (switching reloads).
  import { engineKind, nativeEngineAvailable, engineNote, setEngineKind } from "../state/store";
</script>

{#if nativeEngineAvailable}
  <div class="engine-switch" title="Audio engine. NATIVE (default) runs the whole mix in Rust on its own real-time thread; WEB uses the built-in browser audio.">
    <span class="label">ENGINE</span>
    <button class="seg" class:on={engineKind === "web"} data-role="engine-web" onclick={() => void setEngineKind("web")}>WEB</button>
    <button class="seg" class:on={engineKind === "native"} data-role="engine-native" onclick={() => void setEngineKind("native")}>NATIVE</button>
    {#if $engineNote}<span class="note" data-role="engine-note">{$engineNote}</span>{/if}
  </div>
{/if}

<style>
  .engine-switch {
    display: flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
  }
  .seg {
    font-family: var(--font);
    font-size: 10px;
    font-weight: bold;
    letter-spacing: 1px;
    min-height: 30px;
    padding: 0 8px;
    border: 1px solid var(--box);
    background: var(--panel-lo);
    color: var(--ink-dim);
    cursor: pointer;
  }
  .seg.on {
    background: var(--green);
    border-color: var(--green);
    color: var(--on-accent);
  }
  .note {
    font-size: 9px;
    color: var(--amber);
    max-width: 150px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-left: 4px;
  }
</style>
