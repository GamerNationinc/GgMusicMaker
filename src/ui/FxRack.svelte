<script lang="ts">
  import {
    project,
    selectedTrackId,
    setEq,
    setVoicePreset,
    setVoiceMix,
    setReverbSend,
    setReverbSpace,
    reverbSpace,
  } from "../state/store";
  import { VOICE_PRESET_ORDER, VOICE_PRESETS } from "../fx/voice";
  import type { ReverbSpace } from "../audio/reverb";

  let track = $derived($project.tracks.find((t) => t.id === $selectedTrackId));
  const spaces: ReverbSpace[] = ["room", "hall", "plate"];
</script>

{#if track}
  <div class="rack panel">
    <div class="rack-title" style:color={track.color}>
      ▚ FX — {track.name}
      <button class="chip" onclick={() => selectedTrackId.set(null)} title="Close">✕</button>
    </div>

    <div class="modules">
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

      <!-- Voice manipulation -->
      <section class="module voice">
        <span class="label">VOICE FX</span>
        <div class="presets">
          {#each VOICE_PRESET_ORDER as preset}
            <button
              class="btn"
              class:magenta={track.voice.preset === preset}
              onclick={() => void setVoicePreset(track!.id, preset)}
            >
              {VOICE_PRESETS[preset].label}
            </button>
          {/each}
        </div>
        <div class="mix">
          <span class="tiny">AMOUNT</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={track.voice.mix}
            oninput={(e) => setVoiceMix(track!.id, Number((e.target as HTMLInputElement).value))}
          />
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
        <div class="mix">
          <span class="tiny">SEND</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={track.reverbSend}
            oninput={(e) => setReverbSend(track!.id, Number((e.target as HTMLInputElement).value))}
          />
        </div>
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
  .voice {
    min-width: 240px;
  }
  .presets,
  .spaces {
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
  .mix {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .mix input {
    flex: 1 1 auto;
  }
</style>
