<script lang="ts">
  import { transport, togglePlay, stop, seek, masterLevel, engine, project } from "../state/store";
  import { formatBarsBeats } from "../audio/tempo";

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

  <div class="time screen" data-role="clock" data-time={$transport.playhead}>
    <span class="clock">{fmt($transport.playhead)}</span>
    <span class="bars" title="Bar . beat . 16th" data-role="bars">{formatBarsBeats($transport.playhead, $project.tempo)}</span>
  </div>

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
  .time {
    display: flex;
    flex-direction: column;
    align-items: center;
    line-height: 1;
    min-width: 130px;
  }
  .clock {
    font-size: 18px;
    letter-spacing: 2px;
  }
  .bars {
    font-size: 10px;
    letter-spacing: 1px;
    color: var(--ink-dim);
    margin-top: 1px;
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
