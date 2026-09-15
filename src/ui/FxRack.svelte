<script lang="ts">
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
    reverbSpace,
    liveChannels,
  } from "../state/store";
  import {
    SYNTH_PRESETS,
    SYNTH_SECTIONS,
    CHORD_NAMES,
    SURROUND,
    SURROUND_ORDER,
    matchingPreset,
    synthIsActive,
    type ParamSpec,
    type SynthKey,
  } from "../fx/voice-synth";
  import type { ReverbSpace } from "../audio/reverb";

  let track = $derived($project.tracks.find((t) => t.id === $selectedTrackId));
  const spaces: ReverbSpace[] = ["room", "hall", "plate"];

  // One section of the synth visible at a time keeps the rack short enough
  // for the Deck's 800 px screen; the preset row + MIX are always shown.
  let tab = $state(0);
  const preset = $derived(track ? matchingPreset(track.synth) : null);
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

  // Pan reads L 50 … C … R 50; width reads as a percentage (100% = as is).
  const panText = (v: number) => (Math.abs(v) < 0.005 ? "C" : `${v < 0 ? "L" : "R"} ${Math.round(Math.abs(v) * 100)}`);
  const widthText = (v: number) => `${Math.round(v * 100)}%`;
</script>

{#if track}
  <div class="rack panel">
    <div class="rack-title" style:color={track.color}>
      ▚ FX — {track.name}
      <button class="chip" onclick={() => selectedTrackId.set(null)} title="Close">✕</button>
    </div>

    <div class="modules">
      <!-- Layer placement: where the whole layer (dry + FX) sits -->
      <section class="module place">
        <span class="label">LAYER</span>
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
        <span class="tiny hint">{$liveChannels > 2 ? "pan turns the field" : "M/S width · balance"}</span>
      </section>

      <!-- 3-band EQ -->
      <section class="module">
        <span class="label">EQUALIZER</span>
        <div class="eq">
          {#each [["low", "LOW"], ["mid", "MID"], ["high", "HIGH"]] as [band, name]}
            <div class="band">
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
      </section>

      <!-- Voice Synth -->
      <section class="module synth" class:live={active}>
        <div class="synth-head">
          <span class="label">VOICE SYNTH</span>
          <span class="lamp" class:on={active}>●</span>
          <div class="mix">
            <span class="tiny">MIX</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={track.synth.mix}
              oninput={(e) => onSlider("mix", e)}
            />
            <span class="readout">{Math.round(track.synth.mix * 100)}%</span>
          </div>
        </div>

        <div class="presets">
          {#each SYNTH_PRESETS as p}
            <button
              class="btn"
              class:magenta={preset === p.name}
              onclick={() => void applySynthPreset(track!.id, p.name)}
            >
              {p.name}
            </button>
          {/each}
        </div>

        <div class="tabs">
          {#each SYNTH_SECTIONS as section, i}
            <button class="tab" class:on={tab === i} onclick={() => (tab = i)}>{section.title}</button>
          {/each}
        </div>

        <div class="params">
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
                  <button
                    class="btn small"
                    class:accent={track.synth.chord === i}
                    onclick={() => setSynthParam(track!.id, "chord", i)}
                  >{name}</button>
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
      </section>

      <!-- Reverb -->
      <section class="module">
        <span class="label">REVERB</span>
        <div class="spaces">
          {#each spaces as space}
            <button
              class="btn"
              class:accent={$reverbSpace === space}
              onclick={() => setReverbSpace(space)}
            >{space}</button>
          {/each}
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
      </section>
    </div>
  </div>
{/if}

<style>
  .rack {
    flex: 0 0 auto;
    margin: 6px;
    padding: 8px 12px;
  }
  .rack-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: bold;
    letter-spacing: 1px;
    margin-bottom: 8px;
  }
  .rack-title .chip {
    margin-left: auto;
    min-width: 28px;
    min-height: 28px;
  }
  .modules {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .module {
    background: var(--panel-lo);
    border: 2px solid var(--bevel-dark);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .eq {
    display: flex;
    gap: 14px;
    height: 90px;
  }
  .band {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  /* Vertical EQ faders. */
  .vert {
    writing-mode: vertical-lr;
    direction: rtl;
    width: 10px;
    height: 70px;
  }
  .tiny {
    font-size: 9px;
    letter-spacing: 1px;
    color: var(--ink-dim);
  }
  .readout {
    font-size: 10px;
    color: var(--green);
    min-width: 44px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  /* --- Voice Synth ------------------------------------------------------ */
  .synth {
    flex: 1 1 520px;
    min-width: 320px;
  }
  .synth.live {
    border-color: var(--magenta);
  }
  .synth-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .lamp {
    color: var(--bevel-dark);
    font-size: 10px;
  }
  .lamp.on {
    color: var(--magenta);
    text-shadow: 0 0 6px var(--magenta);
  }
  .synth-head .mix {
    margin-left: auto;
    min-width: 180px;
  }
  .presets,
  .spaces,
  .choices {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .presets .btn,
  .spaces .btn {
    min-height: 34px;
    padding: 0 8px;
    font-size: 11px;
    text-transform: uppercase;
  }
  .btn.small {
    min-height: 26px;
    padding: 0 6px;
    font-size: 10px;
    text-transform: uppercase;
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
  .params {
    display: grid;
    grid-template-columns: repeat(2, minmax(220px, 1fr));
    gap: 2px 16px;
  }
  .param {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
  }
  .param .tiny {
    min-width: 88px;
  }
  .place,
  .module:last-child {
    min-width: 230px;
  }
  .place .param .tiny,
  .module:last-child .param .tiny {
    min-width: 44px;
  }
  .hint {
    margin-top: auto;
    color: var(--amber);
  }
  .param input {
    flex: 1 1 auto;
  }
  .param.row {
    grid-column: 1 / -1;
  }
  .note {
    min-width: 0;
    text-align: left;
    color: var(--amber);
    text-transform: uppercase;
    letter-spacing: 1px;
    font-size: 9px;
  }
  .mix {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .mix input {
    flex: 1 1 auto;
  }
</style>
