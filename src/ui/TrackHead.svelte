<script lang="ts">
  import type { Track } from "../audio/types";
  import {
    setTrackGain,
    setReverbSend,
    toggleMute,
    toggleSolo,
    armTrack,
    removeTrack,
    renameTrack,
    duplicateTrack,
    toggleFxRack,
    selectedTrackId,
  } from "../state/store";
  import { LANE_HEIGHT } from "./constants";

  let { track }: { track: Track } = $props();
</script>

<div class="head" style:height="{LANE_HEIGHT}px" style:border-left="4px solid {track.color}">
  <div class="row top">
    <input
      class="name"
      value={track.name}
      oninput={(e) => renameTrack(track.id, (e.target as HTMLInputElement).value)}
    />
    <button
      class="chip fx"
      class:on={$selectedTrackId === track.id}
      onclick={() => toggleFxRack(track.id)}
      title="Open FX rack"
    >FX</button>
    <button class="chip dup" onclick={() => duplicateTrack(track.id)} title="Duplicate layer (Ctrl+D)">⧉</button>
    <button class="chip" onclick={() => removeTrack(track.id)} title="Remove layer">✕</button>
  </div>

  <div class="row chips">
    <button class="chip mute" class:on={track.muted} onclick={() => toggleMute(track.id)}>M</button>
    <button class="chip solo" class:on={track.soloed} onclick={() => toggleSolo(track.id)}>S</button>
    <button class="chip arm" class:on={track.armed} onclick={() => armTrack(track.id)}>●</button>

    <div class="knob">
      <span class="label">VOL</span>
      <input
        type="range"
        min="0"
        max="1.5"
        step="0.01"
        value={track.gain}
        oninput={(e) => setTrackGain(track.id, Number((e.target as HTMLInputElement).value))}
      />
    </div>
    <div class="knob">
      <span class="label">RVB</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={track.reverbSend}
        oninput={(e) => setReverbSend(track.id, Number((e.target as HTMLInputElement).value))}
      />
    </div>
  </div>
</div>

<style>
  .head {
    background: var(--panel);
    border-bottom: 2px solid var(--panel-lo);
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    justify-content: center;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .name {
    flex: 1 1 auto;
    background: var(--panel-lo);
    border: 2px solid var(--bevel-dark);
    color: var(--ink);
    font-family: var(--font);
    font-weight: bold;
    padding: 4px 6px;
    min-width: 0;
    font-size: 13px;
  }
  .chips {
    gap: 4px;
  }
  .chip {
    min-width: 30px;
    min-height: 30px;
    font-size: 12px;
  }
  .chip.fx.on {
    background: var(--magenta);
    color: #10121a;
  }
  .knob {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 1px;
    min-width: 40px;
  }
</style>
