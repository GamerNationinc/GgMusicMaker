<script lang="ts">
  import { project, setBpm, setBeatsPerBar, snapToGrid, toggleSnap, autoTempo } from "../state/store";
  import { BEATS_PER_BAR, BPM_MIN, BPM_MAX, formatBpm, tapTempo } from "../audio/tempo";

  let taps: number[] = [];
  function onTap() {
    const r = tapTempo(taps, performance.now());
    taps = r.taps;
    if (r.bpm) setBpm(r.bpm);
  }

  // Wheel over the BPM: ±1, Shift ±0.1 (Ableton nudges the same way).
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const dir = e.deltaY < 0 || e.deltaX < 0 ? 1 : -1;
    setBpm($project.tempo.bpm + dir * (e.shiftKey ? 0.1 : 1));
  }

  function onBpmChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const v = Number(input.value);
    if (input.value.trim() !== "" && Number.isFinite(v)) setBpm(v);
    // Show what it was clamped to (or put back what was there).
    input.value = formatBpm($project.tempo.bpm);
  }
</script>

<div class="tempo" data-role="tempo">
  <input
    class="bpm screen"
    type="number"
    min={BPM_MIN}
    max={BPM_MAX}
    step="0.01"
    value={formatBpm($project.tempo.bpm)}
    onchange={onBpmChange}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
    }}
    onwheel={onWheel}
    aria-label="Song tempo, BPM"
    title="Song tempo (BPM): the ruler's bars, the grid and every layer's BASS MOD follow it. Wheel: ±1 · Shift+wheel: ±0.1"
    data-role="bpm"
  />
  <button class="mini" onclick={onTap} title="Tap along with the beat to set the tempo" data-role="tap">TAP</button>
  <button
    class="mini"
    onclick={() => void autoTempo()}
    title="Listen to the selected clip (or the longest one) and set the song tempo and bar 1 from it"
    data-role="auto-tempo">AUTO</button>
  <select
    class="mini sig"
    value={$project.tempo.beatsPerBar}
    onchange={(e) => setBeatsPerBar(Number((e.target as HTMLSelectElement).value))}
    aria-label="Time signature"
    title="Beats in a bar"
    data-role="signature"
  >
    {#each BEATS_PER_BAR as n (n)}
      <option value={n}>{n}/4</option>
    {/each}
  </select>
  <button
    class="mini"
    class:on={$snapToGrid}
    onclick={toggleSnap}
    aria-pressed={$snapToGrid}
    title="Snap to grid (Ctrl+4): clips and clicks land on the grid lines you can see. Hold Alt while dragging to place freely."
    data-role="snap">SNAP</button>
</div>

<style>
  .tempo {
    display: flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
  }
  .bpm {
    width: 40px;
    height: 20px;
    padding: 0 3px;
    font-family: var(--font);
    font-size: 11px;
    text-align: right;
    color: var(--green);
    background: var(--panel-lo);
    border: 1px solid var(--box);
    -moz-appearance: textfield;
    appearance: textfield;
  }
  .bpm::-webkit-inner-spin-button,
  .bpm::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .mini {
    font-family: var(--font);
    font-size: 9px;
    letter-spacing: 1px;
    height: 20px;
    padding: 0 4px;
    border: 1px solid var(--box, var(--bevel-dark));
    background: var(--panel-lo);
    color: var(--ink-dim);
    cursor: pointer;
    white-space: nowrap;
    flex: 0 0 auto;
  }
  /* No dropdown arrow: "4/4" is the whole control. */
  .sig {
    letter-spacing: 0;
    padding: 0 3px;
    appearance: none;
    -webkit-appearance: none;
    text-align: center;
  }
  .mini.on {
    color: var(--green);
    border-color: var(--green);
  }
</style>
