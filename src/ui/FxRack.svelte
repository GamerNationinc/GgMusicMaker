<script lang="ts">
  // The FX rack: a chain strip (LAYER ▸ EQ ▸ VOICE SYNTH ▸ REVERB) that
  // summarises every module and one full-width editor for the picked slot.
  // Each slot has a power switch (bypass) and a lamp that only lights when
  // the module is on and actually doing something.
  import {
    project,
    selectedTrackId,
    setEq,
    setPlacement,
    setSynthParam,
    applySynthPreset,
    setSurround,
    setReverbSend,
    setReverbSpace,
    toggleFx,
    reverbSpace,
    liveChannels,
  } from "../state/store";
  import {
    SYNTH_PRESETS,
    SYNTH_SECTIONS,
    PRESET_CATEGORIES,
    CHORD_NAMES,
    SURROUND,
    SURROUND_ORDER,
    matchingPreset,
    synthIsActive,
    type ParamSpec,
    type SynthKey,
  } from "../fx/voice-synth";
  import { FX_SLOTS, slotLit, slotSummary, panText, widthText, type FxSlot } from "../fx/chain";
  import type { ReverbSpace } from "../audio/reverb";

  let track = $derived($project.tracks.find((t) => t.id === $selectedTrackId));
  const spaces: ReverbSpace[] = ["room", "hall", "plate"];

  let slot = $state<FxSlot>("synth");
  // One section of the synth visible at a time keeps the rack short enough
  // for the Deck's 800 px screen; the preset screen + MIX are always shown.
  let tab = $state(0);
  let browsing = $state(false);

  const preset = $derived(track ? matchingPreset(track.synth) : null);
  const presetIndex = $derived(SYNTH_PRESETS.findIndex((p) => p.name === preset));
  const active = $derived(track ? synthIsActive(track.synth) : false);
  const surroundWant = $derived(SURROUND[$project.surround].channels);
  const folded = $derived($liveChannels < surroundWant);

  function fmt(spec: ParamSpec, v: number): string {
    const digits = spec.step >= 1 ? 0 : spec.step >= 0.1 ? 1 : 2;
    const s = v.toFixed(digits);
    return spec.unit ? `${s}${spec.unit}` : s;
  }

  function onSlider(key: SynthKey, e: Event) {
    if (track) setSynthParam(track.id, key, Number((e.target as HTMLInputElement).value));
  }

  /** Step through the presets like a hardware synth; "custom" steps to the first. */
  function stepPreset(dir: 1 | -1) {
    if (!track) return;
    const n = SYNTH_PRESETS.length;
    const next = presetIndex < 0 ? (dir > 0 ? 0 : n - 1) : (presetIndex + dir + n) % n;
    void applySynthPreset(track.id, SYNTH_PRESETS[next].name);
  }

  function pickPreset(name: string) {
    if (track) void applySynthPreset(track.id, name);
    browsing = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && browsing) browsing = false;
  }
</script>

<svelte:window onkeydown={onKey} />

{#if track}
  <div class="rack panel">
    <div class="rack-title" style:color={track.color}>
      ▚ FX — {track.name}
      <button class="chip" onclick={() => selectedTrackId.set(null)} title="Close">✕</button>
    </div>

    <!-- Chain strip -->
    <div class="chain">
      {#each FX_SLOTS as s, i (s.key)}
        {#if i > 0}<span class="arrow">▸</span>{/if}
        <div
          class="slot {s.key}"
          class:selected={slot === s.key}
          class:off={!track.fx[s.key]}
          style:--accent={track.color}
        >
          <button
            class="power"
            class:on={track.fx[s.key]}
            onclick={() => toggleFx(track!.id, s.key)}
            title={track.fx[s.key] ? "Bypass" : "Enable"}
            aria-label="{s.label} power"
          >⏻</button>
          <button class="pick" onclick={() => (slot = s.key)} aria-label="Edit {s.label}">
            <span class="led" class:on={slotLit(track, s.key)}>●</span>
            <span class="slot-name">{s.label}</span>
            <span class="summary">{slotSummary(track, s.key, $reverbSpace)}</span>
          </button>
        </div>
      {/each}
    </div>

    <!-- Editor for the picked slot -->
    <div class="editor {slot}" class:bypassed={!track.fx[slot]}>
      {#if !track.fx[slot]}
        <span class="bypass-tag">BYPASSED — settings kept</span>
      {/if}

      {#if slot === "place"}
        <div class="params two">
          <label class="param">
            <span class="tiny">PAN</span>
            <input
              class="pan"
              type="range"
              min="-1"
              max="1"
              step="0.01"
              value={track.pan}
              oninput={(e) => setPlacement(track!.id, "pan", Number((e.target as HTMLInputElement).value))}
            />
            <span class="readout">{panText(track.pan)}</span>
          </label>
          <label class="param">
            <span class="tiny">WIDTH</span>
            <input
              class="width"
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={track.width}
              oninput={(e) => setPlacement(track!.id, "width", Number((e.target as HTMLInputElement).value))}
            />
            <span class="readout">{widthText(track.width)}</span>
          </label>
        </div>
        <span class="tiny hint">
          Where the whole layer (dry + FX) sits. {$liveChannels > 2 ? "Pan turns the field around you." : "Mid/side width, constant-power balance."}
        </span>

      {:else if slot === "eq"}
        <div class="eq-bands">
          {#each [["low", "LOW 220"], ["mid", "MID 1.2k"], ["high", "HIGH 4.5k"]] as [band, name]}
            <div class="band">
              <span class="readout">{track.eq[band as "low" | "mid" | "high"] > 0 ? "+" : ""}{track.eq[band as "low" | "mid" | "high"]} dB</span>
              <input
                class="vert"
                type="range"
                min="-18"
                max="18"
                step="0.5"
                value={track.eq[band as "low" | "mid" | "high"]}
                oninput={(e) =>
                  setEq(track!.id, band as "low" | "mid" | "high", Number((e.target as HTMLInputElement).value))}
              />
              <span class="tiny">{name}</span>
            </div>
          {/each}
        </div>

      {:else if slot === "synth"}
        <div class="synth-head">
          <div class="preset-nav">
            <button class="btn small" onclick={() => stepPreset(-1)} aria-label="Previous preset">◀</button>
            <button class="preset-screen screen" onclick={() => (browsing = !browsing)} title="Browse presets">
              <span class="preset-name">{preset ?? "custom"}</span>
              <span class="preset-cat">{preset ? SYNTH_PRESETS[presetIndex].category : "edited"}</span>
            </button>
            <button class="btn small" onclick={() => stepPreset(1)} aria-label="Next preset">▶</button>
            <button class="btn small preset-browse" class:on={browsing} onclick={() => (browsing = !browsing)}>BROWSE ▾</button>
            {#if browsing}
              <div class="browser panel" role="listbox" aria-label="Voice Synth presets">
                {#each PRESET_CATEGORIES as cat}
                  <div class="cat">
                    <span class="label">{cat}</span>
                    <div class="cat-presets">
                      {#each SYNTH_PRESETS.filter((p) => p.category === cat) as p (p.name)}
                        <button class="btn small" class:magenta={preset === p.name} onclick={() => pickPreset(p.name)}>{p.name}</button>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
          <span class="led big" class:on={active}>●</span>
          <label class="param mix">
            <span class="tiny">MIX</span>
            <input type="range" min="0" max="1" step="0.01" value={track.synth.mix} oninput={(e) => onSlider("mix", e)} />
            <span class="readout">{Math.round(track.synth.mix * 100)}%</span>
          </label>
        </div>

        <div class="tabs">
          {#each SYNTH_SECTIONS as section, i}
            <button class="tab" class:on={tab === i} onclick={() => (tab = i)}>{section.title}</button>
          {/each}
        </div>

        <div class="params three">
          {#each SYNTH_SECTIONS[tab].params as spec (spec.key)}
            <label class="param">
              <span class="tiny">{spec.label}</span>
              <input
                type="range"
                min={spec.min}
                max={spec.max}
                step={spec.step}
                value={track.synth[spec.key]}
                oninput={(e) => onSlider(spec.key, e)}
              />
              <span class="readout">{fmt(spec, track.synth[spec.key])}</span>
            </label>
          {/each}

          {#if SYNTH_SECTIONS[tab].title === "PITCH"}
            <div class="param row">
              <span class="tiny">CHORD</span>
              <div class="choices">
                {#each CHORD_NAMES as name, i}
                  <button class="btn small" class:accent={track.synth.chord === i} onclick={() => setSynthParam(track!.id, "chord", i)}>{name}</button>
                {/each}
              </div>
            </div>
          {/if}

          {#if SYNTH_SECTIONS[tab].title === "SPACE"}
            <div class="param row">
              <span class="tiny">OUTPUT</span>
              <div class="choices">
                {#each SURROUND_ORDER as layout}
                  <button
                    class="btn small surround"
                    class:accent={$project.surround === layout}
                    onclick={() => void setSurround(layout)}
                    title={SURROUND[layout].names.join(" ")}
                  >{SURROUND[layout].label}</button>
                {/each}
              </div>
              <span class="readout note" title="Export always renders every channel of the layout.">
                {#if folded}
                  device: {$liveChannels} ch fold-down
                {:else}
                  {SURROUND[$project.surround].names.join(" ")}
                {/if}
              </span>
            </div>
          {/if}
        </div>

      {:else}
        <div class="params two">
          <div class="param row">
            <span class="tiny">SPACE</span>
            <div class="choices">
              {#each spaces as space}
                <button class="btn small" class:accent={$reverbSpace === space} onclick={() => setReverbSpace(space)}>{space}</button>
              {/each}
            </div>
            <span class="tiny hint">shared by every layer</span>
          </div>
          <label class="param">
            <span class="tiny">SEND</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={track.reverbSend}
              oninput={(e) => setReverbSend(track!.id, Number((e.target as HTMLInputElement).value))}
            />
            <span class="readout">{Math.round(track.reverbSend * 100)}%</span>
          </label>
          <label class="param">
            <span class="tiny">PAN</span>
            <input
              class="reverb-pan"
              type="range"
              min="-1"
              max="1"
              step="0.01"
              value={track.reverbPan}
              oninput={(e) => setPlacement(track!.id, "reverbPan", Number((e.target as HTMLInputElement).value))}
            />
            <span class="readout">{panText(track.reverbPan)}</span>
          </label>
          <label class="param">
            <span class="tiny">WIDTH</span>
            <input
              class="reverb-width"
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={track.reverbWidth}
              oninput={(e) => setPlacement(track!.id, "reverbWidth", Number((e.target as HTMLInputElement).value))}
            />
            <span class="readout">{widthText(track.reverbWidth)}</span>
          </label>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .rack {
    flex: 0 0 auto;
    margin: 6px;
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .rack-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: bold;
    letter-spacing: 1px;
  }
  .rack-title .chip {
    margin-left: auto;
    min-width: 28px;
    min-height: 28px;
  }

  /* --- chain strip -------------------------------------------------------- */
  .chain {
    display: flex;
    align-items: stretch;
    gap: 6px;
    flex-wrap: wrap;
  }
  .arrow {
    align-self: center;
    color: var(--ink-dim);
    font-size: 16px;
  }
  .slot {
    display: flex;
    align-items: stretch;
    background: var(--panel-lo);
    border: 2px solid var(--bevel-dark);
    box-shadow: 2px 2px 0 #000;
    flex: 1 1 180px;
    min-width: 0;
  }
  .slot.selected {
    border-color: var(--accent, var(--green));
    box-shadow: 2px 2px 0 #000, inset 0 0 0 1px var(--accent, var(--green));
  }
  .slot.off .pick {
    opacity: 0.45;
  }
  .power {
    font-family: var(--font);
    font-size: 14px;
    min-width: var(--touch);
    border: none;
    border-right: 2px solid var(--bevel-dark);
    background: var(--panel-lo);
    color: var(--ink-dim);
    cursor: pointer;
  }
  .power.on {
    color: var(--green);
    text-shadow: 0 0 6px rgba(90, 240, 150, 0.7);
  }
  .pick {
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-rows: auto auto;
    column-gap: 6px;
    align-items: center;
    text-align: left;
    padding: 4px 8px;
    min-height: 44px;
    border: none;
    background: transparent;
    color: var(--ink);
    font-family: var(--font);
    cursor: pointer;
    min-width: 0;
  }
  .led {
    grid-row: 1 / 3;
    color: var(--bevel-dark);
    font-size: 10px;
  }
  .led.on {
    color: var(--magenta);
    text-shadow: 0 0 6px var(--magenta);
  }
  .led.big {
    font-size: 12px;
    grid-row: auto;
  }
  .slot-name {
    font-size: 11px;
    font-weight: bold;
    letter-spacing: 1px;
  }
  .summary {
    font-size: 10px;
    color: var(--green);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* --- editor ------------------------------------------------------------- */
  .editor {
    position: relative;
    background: var(--panel-lo);
    border: 2px solid var(--bevel-dark);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .editor.bypassed > :not(.bypass-tag) {
    opacity: 0.5;
  }
  .bypass-tag {
    position: absolute;
    top: 4px;
    right: 8px;
    font-size: 9px;
    letter-spacing: 1px;
    color: var(--amber);
  }
  .tiny {
    font-size: 9px;
    letter-spacing: 1px;
    color: var(--ink-dim);
  }
  .hint {
    color: var(--amber);
  }
  .readout {
    font-size: 10px;
    color: var(--green);
    min-width: 44px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .params {
    display: grid;
    gap: 2px 16px;
  }
  .params.two {
    grid-template-columns: repeat(2, minmax(220px, 1fr));
  }
  .params.three {
    grid-template-columns: repeat(3, minmax(200px, 1fr));
  }
  .param {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
    min-width: 0;
  }
  .param .tiny {
    min-width: 88px;
  }
  .param input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .param.row {
    grid-column: 1 / -1;
  }
  .choices {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .btn.small {
    min-height: 26px;
    padding: 0 6px;
    font-size: 10px;
    text-transform: uppercase;
  }
  .note {
    min-width: 0;
    text-align: left;
    color: var(--amber);
    text-transform: uppercase;
    letter-spacing: 1px;
    font-size: 9px;
  }

  /* EQ */
  .eq-bands {
    display: flex;
    gap: 28px;
    justify-content: center;
    height: 110px;
  }
  .band {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .band .readout {
    text-align: center;
  }
  .vert {
    writing-mode: vertical-lr;
    direction: rtl;
    width: 10px;
    height: 66px;
  }

  /* Synth */
  .synth-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .preset-nav {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .preset-screen {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 150px;
    min-height: 34px;
    padding: 3px 10px;
    border: 2px solid var(--bevel-dark);
    font-family: var(--font);
    cursor: pointer;
    text-align: left;
  }
  .preset-name {
    font-size: 13px;
    font-weight: bold;
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  .preset-cat {
    font-size: 9px;
    letter-spacing: 1px;
    opacity: 0.7;
  }
  .preset-browse.on {
    box-shadow: inset 0 0 0 2px var(--amber);
  }
  .browser {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 5;
    margin-top: 4px;
    padding: 8px 10px;
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    min-width: 520px;
  }
  .cat {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cat-presets {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cat-presets .btn {
    justify-content: flex-start;
    min-height: 30px;
  }
  .synth-head .mix {
    margin-left: auto;
    min-width: 200px;
  }
  .tabs {
    display: flex;
    gap: 2px;
    border-bottom: 2px solid var(--bevel-dark);
  }
  .tab {
    font-family: var(--font);
    font-size: 10px;
    letter-spacing: 1px;
    min-height: 28px;
    padding: 0 10px;
    border: 2px solid var(--bevel-dark);
    border-bottom: none;
    background: var(--panel-lo);
    color: var(--ink-dim);
    cursor: pointer;
  }
  .tab.on {
    background: var(--panel);
    color: var(--green);
  }
</style>
