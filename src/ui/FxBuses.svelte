<script lang="ts">
  // The four FX buses (src/fx/fxbus.ts) in Instrument mode → PADS: effect,
  // the two macros, latch ON, and hold-to-GRAB. The Deck: L3 picks the bus
  // (outlined), L5 latches, R2 grabs, the left pad moves its macros.
  import { project, fxLive, fxMacros, toggleFxOn, setFxGrab, setFxEffect, moveFxMacros, commitFxMacros } from "../state/store";
  import { FX_EFFECTS, FX_INFO, busRole, fxBusesOf, fxDepth, type FxEffect } from "../fx/fxbus";

  let { selected, onselect }: { selected: number; onselect: (bus: number) => void } = $props();

  const buses = $derived(fxBusesOf($project));
  const macros = (k: number) => $fxMacros[k] ?? buses[k];

  function grab(k: number, on: boolean, e?: PointerEvent) {
    if (on && e) {
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* not a live pointer */
      }
    }
    setFxGrab(k, on ? 1 : 0);
  }
</script>

<div class="box fx" data-title="fx buses" data-title-right="L3 pick · L5 on · R2 grab · L-pad xy" data-role="fx-buses">
  {#each buses as bus, k (k)}
    {@const live = $fxLive[k]}
    {@const m = macros(k)}
    <div class="bus" class:sel={selected === k} class:live={fxDepth(live) > 0} data-role="fx-bus-{k + 1}">
      <button class="name" onclick={() => onselect(k)} title={busRole(k) === "pads" ? "Pads set to this bus play through it" : "The whole mix goes through it"}>
        <b>{k + 1}</b>
        <small>{busRole(k)}</small>
      </button>
      <select
        class="btn effect"
        value={bus.effect}
        data-role="fx-effect-{k + 1}"
        onchange={(e) => setFxEffect(k, (e.target as HTMLSelectElement).value as FxEffect)}
      >
        {#each FX_EFFECTS as fx (fx)}
          <option value={fx}>{FX_INFO[fx].label}</option>
        {/each}
      </select>
      {#each ["a", "b"] as const as key (key)}
        <label class="macro" title={FX_INFO[bus.effect][key]}>
          <small>{FX_INFO[bus.effect][key]}</small>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={m[key]}
            disabled={bus.effect === "off"}
            data-role="fx-{key}-{k + 1}"
            oninput={(e) => moveFxMacros(k, key === "a" ? Number((e.target as HTMLInputElement).value) : undefined, key === "b" ? Number((e.target as HTMLInputElement).value) : undefined)}
            onchange={() => commitFxMacros(k)}
          />
        </label>
      {/each}
      <button class="btn small" class:accent={live.on} data-role="fx-on-{k + 1}" onclick={() => toggleFxOn(k)} disabled={bus.effect === "off"}>ON</button>
      <button
        class="btn small grab"
        class:accent={live.grab > 0}
        data-role="fx-grab-{k + 1}"
        disabled={bus.effect === "off"}
        onpointerdown={(e) => grab(k, true, e)}
        onpointerup={() => grab(k, false)}
        onpointercancel={() => grab(k, false)}
        title="Engaged while held (R2 on the Deck: depth = how far it's pulled)"
      >GRAB</button>
    </div>
  {/each}
</div>

<style>
  .fx {
    padding: 10px 8px 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .bus {
    display: grid;
    grid-template-columns: 50px 104px 1fr 1fr 42px 54px;
    align-items: center;
    gap: 5px;
    padding: 2px 4px;
    border: 1px solid transparent;
  }
  .bus.sel {
    border-color: var(--amber);
  }
  .bus.live {
    background: var(--panel-hi);
    box-shadow: inset 3px 0 0 var(--magenta);
  }
  .name {
    font-family: var(--font);
    display: flex;
    align-items: baseline;
    gap: 4px;
    background: none;
    border: none;
    color: var(--ink);
    cursor: pointer;
    padding: 0;
  }
  .name b {
    font-size: 16px;
    color: var(--magenta);
  }
  small {
    font-size: 9px;
    color: var(--ink-dim);
    text-transform: uppercase;
  }
  .btn.effect {
    min-height: 32px;
    font-size: 11px;
    padding: 0 4px;
  }
  .macro {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .macro input {
    width: 100%;
  }
  .btn.small {
    min-height: 32px;
    padding: 0 4px;
    font-size: 11px;
  }
  .grab {
    touch-action: none;
  }
</style>
