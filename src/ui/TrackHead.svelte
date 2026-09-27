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
  import { FX_SLOTS, SLOT_SHORT, activeSlots, slotState } from "../fx/chain";
  import { rackView, rackSlot } from "./FxRack.svelte";
  import type { FxSlot } from "../fx/chain";
  import { theme } from "./themeStore";
  import { laneColor } from "./themes";

  let { track }: { track: Track } = $props();

  const active = $derived(activeSlots(track));
  const selected = $derived($selectedTrackId === track.id);
  const STATE_WORD = { active: "ON", bypassed: "bypassed", idle: "off" } as const;

  /** Click a badge: open this layer's rack straight on that module. */
  function openSlot(slot: FxSlot) {
    selectedTrackId.set(track.id);
    rackView.set("chain");
    rackSlot.set(slot);
  }
</script>

<div
  class="head"
  class:stacked={!!track.stackId}
  class:selected
  style:--lane={laneColor($theme, track.color)}
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
      class:on={selected}
      class:lit={active.length > 0}
      onclick={() => toggleFxRack(track.id)}
      title={active.length ? `${active.length} effect${active.length === 1 ? "" : "s"} active — open the FX rack` : "No effects active — open the FX rack"}
    >FX<span class="count">{active.length}</span></button>
    <button class="chip stack" onclick={() => void addStackLayer(track.id)} title="Stack: add a linked layer of this audio (own FX, shared edits)">⊞</button>
    {#if track.stackId}
      <button class="chip link" class:on={track.linked} onclick={() => toggleLinked(track.id)} title={track.linked ? "Linked to its stack — click to unlink" : "Unlinked — click to relink"}>{track.linked ? "🔗" : "⛓‍💥"}</button>
    {:else}
      <button class="chip dup" onclick={() => duplicateTrack(track.id)} title="Duplicate as an independent layer (Ctrl+D)">⧉</button>
    {/if}
    <button class="chip" onclick={() => removeTrack(track.id)} title="Remove layer">✕</button>
  </div>

  <div class="row badges" aria-label="Effects on this layer">
    {#each FX_SLOTS as s (s.key)}
      {@const st = slotState(track, s.key)}
      <button class="badge {st}" onclick={() => openSlot(s.key)} title="{s.label}: {STATE_WORD[st]}">{SLOT_SHORT[s.key]}</button>
    {/each}
  </div>

  <div class="row chips">
    <button class="chip mute" class:on={track.muted} onclick={() => toggleMute(track.id)}>M</button>
    <button
      class="chip solo"
      class:on={track.soloed}
      onclick={(e) => toggleSolo(track.id, e.ctrlKey || e.shiftKey || e.metaKey)}
      title="Solo this layer only (Ctrl/Shift-click: add to the solos)"
    >S</button>
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
    padding: 3px 8px;
    display: flex;
    flex-direction: column;
    gap: 3px;
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
  .chip.fx {
    min-width: 40px;
    gap: 3px;
  }
  .count {
    display: inline-block;
    min-width: 14px;
    padding: 0 2px;
    font-size: 11px;
    line-height: 14px;
    background: var(--panel-lo);
    color: var(--ink-dim);
    border: 1px solid var(--bevel-dark);
  }
  .chip.fx.lit .count {
    background: var(--magenta);
    color: var(--on-accent);
    border-color: var(--magenta);
  }
  .chip.fx.on .count {
    background: var(--on-accent);
    color: var(--magenta);
  }

  /* One badge per module: filled = changing the sound, struck = set up but
     bypassed, faint = neutral. You should never have to open the rack to
     know what is on a layer. */
  .badges {
    gap: 2px;
  }
  .badge {
    flex: 1 1 0;
    min-width: 0;
    padding: 1px 0;
    font-family: var(--font);
    font-size: 10px;
    font-weight: bold;
    letter-spacing: 0;
    line-height: 12px;
    border: 1px solid var(--bevel-dark);
    background: transparent;
    color: var(--ink-dim);
    opacity: 0.3;
    cursor: pointer;
    overflow: hidden;
  }
  .badge.active {
    opacity: 1;
    background: var(--magenta);
    border-color: var(--magenta);
    color: var(--on-accent);
    box-shadow: 0 0 6px var(--magenta);
  }
  .badge.bypassed {
    opacity: 0.9;
    color: var(--magenta);
    border-color: var(--magenta);
    border-style: dashed;
    text-decoration: line-through;
  }

  /* The layer whose rack is open: unmistakable. */
  .head.selected {
    background: color-mix(in srgb, var(--lane) 22%, var(--panel));
    box-shadow: inset 0 0 0 2px var(--lane), inset 0 0 14px color-mix(in srgb, var(--lane) 45%, transparent);
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
