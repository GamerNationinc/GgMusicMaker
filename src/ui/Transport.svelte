<script lang="ts">
  import { transport, togglePlay, stop, seek, masterLevel, engine, skipBack, toggleResample, resampling } from "../state/store";

  function fmt(t: number): string {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    const cs = Math.floor((t * 100) % 100);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  }

  let masterVol = $state(0.9);
  function onMaster(e: Event) {
    masterVol = Number((e.target as HTMLInputElement).value);
    engine.setMasterGain(masterVol);
  }

  // 12-segment LED meter.
  const segments = Array.from({ length: 12 }, (_, i) => i);
  // btop gradient: low → mid → high across the 12 cells.
  function segColor(i: number): string {
    if (i > 9) return "var(--meter-hi)";
    if (i > 6) return "var(--meter-mid)";
    return "var(--meter-lo)";
  }
</script>

<div class="transport">
  <button class="btn accent" onclick={togglePlay} aria-label="Play or pause">
    {$transport.isPlaying ? "❚❚" : "▶"}
  </button>
  <button class="btn" onclick={() => { stop(); seek(0); }} aria-label="Stop">■</button>
  <!-- Skip-back + resample (audio/skipback.ts): glyphs like ▶ ■, the words are in the tooltips. -->
  <button
    class="btn cap"
    data-role="skip-back"
    onclick={() => void skipBack()}
    aria-label="Skip back"
    title="Skip back (B): the last minute of whatever played — even unrecorded — onto a new layer"
  >⟲</button>
  <button
    class="btn danger cap"
    class:on={!!$resampling}
    data-role="resample"
    onclick={() => void toggleResample()}
    aria-label="Resample"
    title={$resampling ? "Resampling — press again (Shift+B) to land it on a new layer" : "Resample (Shift+B): bounce the output, effects and all, onto a new layer — press again to stop"}
  >◉</button>

  <div class="time screen">{fmt($transport.playhead)}</div>

  <div class="meter" title="Master level">
    {#each segments as i}
      <span
        class="seg"
        style:background={$masterLevel * 12 > i ? segColor(i) : "var(--panel-hi)"}
      ></span>
    {/each}
  </div>

  <div class="master">
    <span class="label">MASTER</span>
    <input type="range" min="0" max="1.2" step="0.01" value={masterVol} oninput={onMaster} />
  </div>
</div>

<style>
  .transport {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-left: auto;
  }
  .btn {
    min-width: 54px;
    font-size: 18px;
  }
  /* Skip-back / resample: narrower, the header is full in the desktop app. */
  .btn.cap {
    min-width: 40px;
  }
  .time {
    font-size: 22px;
    letter-spacing: 2px;
    min-width: 130px;
    text-align: center;
  }
  .meter {
    display: flex;
    gap: 2px;
    padding: 4px;
    background: var(--panel-lo);
    border: 1px solid var(--box);
  }
  .seg {
    width: 6px;
    height: 22px;
    opacity: 0.95;
  }
  .master {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 120px;
    gap: 2px;
  }
  /* Narrow screens (a default-size window, the Deck's own screen): the footer's
     VU already shows the level, so the header keeps room for the controls. */
  @media (max-width: 1400px) {
    .meter {
      display: none;
    }
  }
</style>
