<script lang="ts">
  import { transport, togglePlay, stop, seek, masterLevel, engine } from "../state/store";

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
  function segColor(i: number): string {
    if (i > 9) return "var(--danger)";
    if (i > 7) return "var(--amber)";
    return "var(--green)";
  }
</script>

<div class="transport">
  <button class="btn accent" onclick={togglePlay} aria-label="Play or pause">
    {$transport.isPlaying ? "❚❚" : "▶"}
  </button>
  <button class="btn" onclick={() => { stop(); seek(0); }} aria-label="Stop">■</button>

  <div class="time screen">{fmt($transport.playhead)}</div>

  <div class="meter" title="Master level">
    {#each segments as i}
      <span
        class="seg"
        style:background={$masterLevel * 12 > i ? segColor(i) : "var(--panel-lo)"}
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
    border: 2px solid var(--bevel-dark);
  }
  .seg {
    width: 6px;
    height: 22px;
  }
  .master {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 120px;
    gap: 2px;
  }
</style>
