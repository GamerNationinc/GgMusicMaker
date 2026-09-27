<script lang="ts">
  // Header switch between the web audio engine and the native (Rust) one.
  // Desktop app only; the choice is applied at startup (switching reloads).
  import { engineKind, nativeEngineAvailable, engineNote, setEngineKind, canCalibrate, recordLatency, calibrateRecording } from "../state/store";
</script>

{#if nativeEngineAvailable}
  <div class="engine-switch" title="Audio engine. NATIVE (default) runs the whole mix in Rust on its own real-time thread; WEB uses the built-in browser audio.">
    <button class="seg" class:on={engineKind === "web"} data-role="engine-web" onclick={() => void setEngineKind("web")}>WEB</button>
    <button class="seg" class:on={engineKind === "native"} data-role="engine-native" onclick={() => void setEngineKind("native")}>NATIVE</button>
    {#if canCalibrate && !$engineNote}
      <button
        class="seg lat"
        class:uncal={$recordLatency == null}
        data-role="calibrate"
        onclick={() => void calibrateRecording()}
        title={$recordLatency == null
          ? "Recording latency not calibrated: takes may land a little late. Click to measure it (plays clicks, listens with the mic)."
          : `Recording latency ${$recordLatency.toFixed(1)} ms, taken out of every take. Click to measure again.`}
      >{$recordLatency == null ? "⏱ CAL" : `⏱ ${Math.round($recordLatency)}ms`}</button>
    {/if}
    {#if $engineNote}<span class="note" data-role="engine-note">{$engineNote}</span>{/if}
  </div>
{/if}

<style>
  .engine-switch {
    display: flex;
    align-items: center;
    gap: 3px;
    flex: 0 0 auto;
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
  .seg.lat {
    margin-left: 4px;
    color: var(--green);
  }
  .seg.lat.uncal {
    color: var(--amber);
    border-color: var(--amber);
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
