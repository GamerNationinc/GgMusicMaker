<script lang="ts">
  // The FX rack: a chain strip (LAYER ▸ EQ ▸ MORPH ▸ VOICE SYNTH ▸ REVERB) that
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
    setMorphParam,
    applyMorphPreset,
    selectMorphAlgo,
    headphones3d,
    binauralLive,
    toggleHeadphones3d,
    setPunchParam,
    applyPunchPreset,
  } from "../state/store";
  import { PUNCH_SPECS, PUNCH_PRESETS, matchingPunchPreset, punchText, type PunchKey } from "../fx/punch";
  import { punchPreviewFor, previewTick } from "./punchPreviewStore";
  import {
    MORPH_ALGOS,
    MORPH_PRESETS,
    TUNINGS,
    PATHS,
    knobText,
    matchingMorphPreset,
    type MorphKey,
  } from "../fx/morph";
  import { theme } from "./themeStore";
  import { laneColor } from "./themes";
  import {
    SYNTH_PRESETS,
    SYNTH_SECTIONS,
    PRESET_CATEGORIES,
    CHORD_NAMES,
    ORBIT_PATHS,
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
  const accent = $derived(track ? laneColor($theme, track.color) : "");

  // PUNCH: what it does to this layer's audio, from the preview.
  const punchPreset = $derived(track ? matchingPunchPreset(track.punch) : null);
  const punchStats = $derived.by(() => {
    void $previewTick;
    if (!track) return null;
    let peak = 0, over = 0, li = 0, lo = 0, fresh = true, any = false;
    for (const id of new Set(track.clips.map((c) => c.bufferId))) {
      const r = punchPreviewFor(track, id);
      if (!r) { fresh = false; continue; }
      any = true;
      fresh &&= r.fresh;
      peak = Math.max(peak, r.preview.peak);
      over += r.preview.overTotal;
      li += r.preview.lowInSq;
      lo += r.preview.lowOutSq;
    }
    if (!any) return null;
    const peakDb = 20 * Math.log10(peak + 1e-9);
    return {
      peakDb,
      over,
      lowDb: li > 0 ? 10 * Math.log10((lo + 1e-12) / li) : 0,
      fresh,
    };
  });
  function onPunch(key: PunchKey, e: Event) {
    if (track) setPunchParam(track.id, key, Number((e.target as HTMLInputElement).value));
  }

  // MORPH
  let morphBrowsing = $state(false);
  let morphTab = $state<"engine" | "space">("engine");
  const morphPreset = $derived(track ? matchingMorphPreset(track.morph) : null);
  const morphAlgo = $derived(track ? MORPH_ALGOS[track.morph.algo] : MORPH_ALGOS[0]);
  const KNOBS = ["a", "b", "c", "d"] as const;
  /** Motion speed as Hz, or as seconds per cycle when slower than 0.1 Hz. */
  function motionText(m: number): string {
    const hz = m * m * 2;
    if (hz <= 0) return "still";
    return hz >= 0.1 ? `${hz.toFixed(2)}Hz` : `${Math.round(1 / hz)}s/cyc`;
  }

  function onMorph(key: MorphKey, e: Event) {
    if (track) setMorphParam(track.id, key, Number((e.target as HTMLInputElement).value));
  }

  function stepMorphPreset(dir: 1 | -1) {
    if (!track) return;
    const n = MORPH_PRESETS.length;
    const i = MORPH_PRESETS.findIndex((p) => p.name === morphPreset);
    const next = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
    void applyMorphPreset(track.id, MORPH_PRESETS[next].name);
  }

  // Speaker ring for the field map (azimuth°, label), per live layout.
  const RING: Record<string, [number, string][]> = {
    stereo: [[-30, "L"], [30, "R"]],
    "5.1": [[-30, "L"], [30, "R"], [0, "C"], [-110, "Ls"], [110, "Rs"]],
    "7.1": [[-30, "L"], [30, "R"], [0, "C"], [-90, "Ls"], [90, "Rs"], [-150, "Lb"], [150, "Rb"]],
  };
  const pt = (az: number, r: number) => [50 + r * Math.sin((az * Math.PI) / 180), 50 - r * Math.cos((az * Math.PI) / 180)];
  /** SVG arc path covering ±reach° round the front (a full ring at 180°). */
  function arc(reach: number, r: number): string {
    if (reach >= 179.5) return `M ${50 - r} 50 a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
    const [x0, y0] = pt(-reach, r);
    const [x1, y1] = pt(reach, r);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${reach > 90 ? 1 : 0} 1 ${x1} ${y1}`;
  }

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
    if (e.key === "Escape") {
      browsing = false;
      morphBrowsing = false;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if track}
  <div class="rack panel">
    <div class="rack-title" style:color={accent}>
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
          style:--accent={accent}
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

      {:else if slot === "punch"}
        <div class="choices punch-presets">
          {#each PUNCH_PRESETS as p (p.name)}
            <button class="btn small" class:accent={punchPreset === p.name} onclick={() => void applyPunchPreset(track!.id, p.name)}>{p.name}</button>
          {/each}
        </div>
        <div class="morph-body">
          <div class="params two morph-knobs">
            {#each PUNCH_SPECS as spec (spec.key)}
              <label class="param" title={spec.hint}>
                <span class="tiny">{spec.label}</span>
                <input
                  type="range"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={track.punch[spec.key]}
                  oninput={(e) => onPunch(spec.key, e)}
                />
                <span class="readout">{punchText(spec.key, track.punch[spec.key])}</span>
              </label>
            {/each}
            <div class="param row">
              <span class="tiny">CEILING</span>
              <div class="choices">
                <button class="btn small" class:accent={track.punch.safe === 1} onclick={() => setPunchParam(track!.id, "safe", 1)}>SAFE · NEVER OVER 0 dB</button>
                <button class="btn small" class:danger={track.punch.safe === 0} onclick={() => setPunchParam(track!.id, "safe", 0)}>LET IT CLIP</button>
              </div>
            </div>
          </div>
          <div class="punch-meter" aria-live="polite">
            {#if punchStats}
              <span class="tiny">PEAK{punchStats.fresh ? "" : " …"}</span>
              <div class="gbar" style="--fill:{Math.max(0, Math.min(1, (punchStats.peakDb + 24) / 30))}"></div>
              <span class="big" class:hot={punchStats.peakDb > 0}>{punchStats.peakDb > 0 ? "+" : ""}{punchStats.peakDb.toFixed(1)} dBFS</span>
              <span class="tiny">{punchStats.over > 0 ? `${punchStats.over.toLocaleString()} samples CLIP` : "no clipping"}</span>
              <span class="tiny">BASS</span>
              <span class="big bass">{punchStats.lowDb >= 0 ? "+" : ""}{punchStats.lowDb.toFixed(1)} dB</span>
              <span class="tiny">in the lane: solid body = bass after · ticks = bass before · red = over 0 dB</span>
            {:else if track.clips.length === 0}
              <span class="tiny">add audio to this layer to see the preview</span>
            {:else}
              <span class="tiny">turn a knob — the lane shows the result</span>
            {/if}
          </div>
        </div>

      {:else if slot === "morph"}
        <div class="engines" role="tablist" aria-label="MORPH engine">
          {#each MORPH_ALGOS as algo, i (algo.name)}
            <button
              class="engine"
              class:on={track.morph.algo === i}
              role="tab"
              aria-selected={track.morph.algo === i}
              onclick={() => void selectMorphAlgo(track!.id, i)}
              title={algo.blurb}
            >{algo.name}</button>
          {/each}
        </div>

        <div class="synth-head">
          <div class="preset-nav">
            <button class="btn small" onclick={() => stepMorphPreset(-1)} aria-label="Previous morph preset">◀</button>
            <button class="preset-screen screen" onclick={() => (morphBrowsing = !morphBrowsing)} title="Browse MORPH presets">
              <span class="preset-name">{morphPreset ?? "custom"}</span>
              <span class="preset-cat">{morphAlgo.name}</span>
            </button>
            <button class="btn small" onclick={() => stepMorphPreset(1)} aria-label="Next morph preset">▶</button>
            <button class="btn small preset-browse" class:on={morphBrowsing} onclick={() => (morphBrowsing = !morphBrowsing)}>BROWSE ▾</button>
            {#if morphBrowsing}
              <div class="browser panel" role="listbox" aria-label="MORPH presets">
                {#each MORPH_ALGOS as algo, i (algo.name)}
                  {@const list = MORPH_PRESETS.filter((p) => p.params.algo === i && (p.params.mix ?? 0) > 0)}
                  {#if list.length}
                    <div class="cat">
                      <span class="label">{algo.name}</span>
                      <div class="cat-presets">
                        {#each list as p (p.name)}
                          <button
                            class="btn small"
                            class:magenta={morphPreset === p.name}
                            onclick={() => {
                              void applyMorphPreset(track!.id, p.name);
                              morphBrowsing = false;
                            }}>{p.name}</button>
                        {/each}
                      </div>
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
          <span class="blurb">{morphAlgo.blurb}</span>
          <label class="param mix">
            <span class="tiny">MIX</span>
            <input type="range" min="0" max="1" step="0.01" value={track.morph.mix} oninput={(e) => onMorph("mix", e)} />
            <span class="readout">{Math.round(track.morph.mix * 100)}%</span>
          </label>
        </div>

        <div class="tabs">
          <button class="tab" class:on={morphTab === "engine"} onclick={() => (morphTab = "engine")}>ENGINE</button>
          <button class="tab" class:on={morphTab === "space"} onclick={() => (morphTab = "space")}>SPACE · 7.1</button>
        </div>

        <div class="morph-body">
          <div class="params two morph-knobs">
            {#if morphTab === "engine"}
            {#each KNOBS as k, i (k)}
              <label class="param">
                <span class="tiny">{morphAlgo.knobs[i]}</span>
                <input type="range" min="0" max="1" step="0.01" value={track.morph[k]} oninput={(e) => onMorph(k, e)} />
                <span class="readout">{knobText(track.morph, k)}</span>
              </label>
            {/each}
            {#if morphAlgo.tuned}
              <label class="param">
                <span class="tiny">NOTE</span>
                <input type="range" min="-24" max="24" step="1" value={track.morph.note} oninput={(e) => onMorph("note", e)} />
                <span class="readout">{track.morph.note > 0 ? "+" : ""}{track.morph.note}st</span>
              </label>
              <div class="param row">
                <span class="tiny">TUNING</span>
                <div class="choices">
                  {#each TUNINGS as t, i (t.name)}
                    <button class="btn small" class:accent={track.morph.tuning === i} title={t.info} onclick={() => setMorphParam(track!.id, "tuning", i)}>{t.name}</button>
                  {/each}
                </div>
              </div>
            {/if}
            {:else}
            <label class="param">
              <span class="tiny">SPREAD</span>
              <input type="range" min="0" max="1" step="0.01" value={track.morph.spread} oninput={(e) => onMorph("spread", e)} />
              <span class="readout">{Math.round(track.morph.spread * 180)}°</span>
            </label>
            <label class="param">
              <span class="tiny">MOTION</span>
              <input type="range" min="0" max="1" step="0.01" value={track.morph.motion} oninput={(e) => onMorph("motion", e)} />
              <span class="readout">{motionText(track.morph.motion)}</span>
            </label>
            <label class="param">
              <span class="tiny">DIFFUSE</span>
              <input type="range" min="0" max="1" step="0.01" value={track.morph.diffuse} oninput={(e) => onMorph("diffuse", e)} />
              <span class="readout">{Math.round(track.morph.diffuse * 100)}%</span>
            </label>
            <div class="param row">
              <span class="tiny">PATH</span>
              <div class="choices">
                {#each PATHS as name, i (name)}
                  <button class="btn small" class:accent={track.morph.path === i} onclick={() => setMorphParam(track!.id, "path", i)}>{name}</button>
                {/each}
              </div>
            </div>
            {/if}
          </div>

          <svg class="field" viewBox="0 0 100 100" role="img" aria-label="Where the MORPH voices sit around you">
            <circle cx="50" cy="50" r="38" class="ring" />
            <path d={arc(track.morph.spread * 180, 38)} class="spread" />
            {#each RING[$project.surround] as [az, name] (name)}
              {@const [x, y] = pt(az, 38)}
              {@const [tx, ty] = pt(az, 47)}
              <rect x={x - 4} y={y - 3} width="8" height="6" class="spk" />
              <text x={tx} y={ty + 2} class="spk-name">{name}</text>
            {/each}
            <circle cx="50" cy="50" r="4" class="head" />
            <text x="50" y="98" class="spk-name">{PATHS[track.morph.path]}</text>
          </svg>
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
              <span class="tiny">ORBIT PATH</span>
              <div class="choices">
                {#each ORBIT_PATHS as name, i (name)}
                  <button class="btn small" class:accent={track.synth.path === i} onclick={() => setSynthParam(track!.id, "path", i)}>{name}</button>
                {/each}
              </div>
            </div>
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
              <button
                class="btn small"
                class:accent={$headphones3d}
                onclick={() => void toggleHeadphones3d()}
                title="On a stereo device, render 5.1/7.1 binaurally for headphones instead of a flat fold-down"
              >🎧 3D {$headphones3d ? "ON" : "OFF"}</button>
              <span class="readout note" title="Export always renders every channel of the layout.">
                {#if $binauralLive}
                  3D headphones · {SURROUND[$project.surround].names.join(" ")}
                {:else if folded}
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
    text-shadow: var(--glow);
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

  /* PUNCH */
  .punch-presets {
    margin-bottom: 2px;
  }
  .punch-meter {
    flex: 0 0 190px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 8px;
    border: 1px solid var(--box, var(--bevel-dark));
    background: var(--panel);
  }
  .punch-meter .big {
    font-size: 16px;
    font-weight: bold;
    color: var(--green);
    font-variant-numeric: tabular-nums;
  }
  .punch-meter .big.hot {
    color: var(--danger);
  }
  .punch-meter .big.bass {
    color: var(--magenta);
  }

  /* MORPH */
  .engines {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 3px;
  }
  .engine {
    font-family: var(--font);
    font-size: 10px;
    font-weight: bold;
    letter-spacing: 1px;
    min-height: 32px;
    padding: 0 4px;
    border: 1px solid var(--box, var(--bevel-dark));
    background: var(--panel-lo);
    color: var(--ink-dim);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .engine.on {
    background: var(--green);
    color: var(--on-accent, #000);
    border-color: var(--green);
  }
  .blurb {
    font-size: 10px;
    color: var(--ink-dim);
    flex: 1 1 200px;
    min-width: 0;
  }
  .morph-body {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .morph-knobs {
    flex: 1 1 auto;
  }
  .field {
    flex: 0 0 104px;
    width: 104px;
    height: 104px;
  }
  .field .ring {
    fill: none;
    stroke: var(--ink-dim);
    stroke-width: 0.6;
    stroke-dasharray: 2 2;
  }
  .field .spread {
    fill: none;
    stroke: var(--green);
    stroke-width: 4;
    opacity: 0.55;
  }
  .field .spk {
    fill: var(--panel-lo);
    stroke: var(--ink);
    stroke-width: 0.8;
  }
  .field .head {
    fill: var(--ink);
  }
  .field .spk-name {
    fill: var(--ink-dim);
    font-size: 7px;
    text-anchor: middle;
    font-family: var(--font);
  }
</style>
