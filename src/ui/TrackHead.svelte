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
    addStackLayer,
    toggleLinked,
  } from "../state/store";
  import { LANE_HEIGHT } from "./constants";
  import { anyFxLit } from "../fx/chain";
  import { theme } from "./themeStore";
  import { laneColor } from "./themes";

  let { track }: { track: Track } = $props();
</script>

<div
  class="head"
  class:stacked={!!track.stackId}
  style:height="{LANE_HEIGHT}px"
  style:border-left="{track.stackId ? 10 : 4}px {track.stackId && !track.linked ? 'dashed' : 'solid'} {laneColor($theme, track.color)}"
>
  <div class="row top">
    <input
      class="name"
      value={track.name}
      title={track.name}
      oninput={(e) => renameTrack(track.id, (e.target as HTMLInputElement).value)}
    />
    <button
      class="chip fx"
      class:on={$selectedTrackId === track.id}
      class:lit={anyFxLit(track)}
      onclick={() => toggleFxRack(track.id)}
      title={anyFxLit(track) ? "FX rack (effects active)" : "Open FX rack"}
    >FX</button>
    <button class="chip stack" onclick={() => void addStackLayer(track.id)} title="Stack: add a linked layer of this audio (own FX, shared edits)">⊞</button>
    {#if track.stackId}
      <button class="chip link" class:on={track.linked} onclick={() => toggleLinked(track.id)} title={track.linked ? "Linked to its stack — click to unlink" : "Unlinked — click to relink"}>{track.linked ? "🔗" : "⛓‍💥"}</button>
    {:else}
      <button class="chip dup" onclick={() => duplicateTrack(track.id)} title="Duplicate as an independent layer (Ctrl+D)">⧉</button>
    {/if}
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
    border-bottom: 1px solid var(--box);
    padding: 4px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
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
    border: 1px solid var(--box);
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
  .top {
    gap: 3px;
  }
  .top .chip {
    min-width: 28px;
    padding: 0;
  }
  .chip.stack {
    color: var(--green);
  }
  .chip {
    min-width: 30px;
    min-height: 30px;
    font-size: 12px;
  }
  /* Lit = some effect is engaged on this layer; on = its rack is open. */
  .chip.fx.lit {
    color: var(--magenta);
    border-color: var(--magenta);
    text-shadow: var(--glow);
  }
  .chip.fx.on {
    background: var(--magenta);
    border-color: var(--magenta);
    color: var(--on-accent);
    text-shadow: none;
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
