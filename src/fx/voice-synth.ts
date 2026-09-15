// Voice Synth — the VocalSynth-style vocal engine's data model.
//
// Pure data + mapping: the parameter set the `voice-synth-processor` worklet
// takes (one AudioParam per key), UI ranges for each, the factory presets,
// the surround layouts the field can be rendered into, and the migration
// from the v1 "voice preset" FX. No Web Audio in here so it unit-tests
// without an AudioContext.

/** Every knob on the synth. Keys match the worklet's AudioParam names. */
export interface VoiceSynthParams {
  /** Dry/wet, 0..1. 0 is a bit-exact bypass. */
  mix: number;

  // --- pitch -------------------------------------------------------------
  /** Transpose of every shifted layer and the carrier root, in semitones. */
  pitch: number;
  /** Formant shift in semitones, independent of pitch. */
  formant: number;
  /** Index into CHORDS: intervals for the carrier and the Polyvox harmonies. */
  chord: number;
  /** Portamento on pitch changes, 0 (instant) .. 1 (~0.6 s). */
  glide: number;

  // --- engines (all run at once; each is a level 0..1) --------------------
  shift: number;
  vocoder: number;
  talkbox: number;
  compuvox: number;
  polyvox: number;
  /** Shared flavour: vocoder Q / noise, talkbox drive, compuvox crush, polyvox detune. */
  character: number;

  // --- stack -------------------------------------------------------------
  /** Voices on the Shift layer, 1..8. */
  unison: number;
  /** Cents the unison voices spread over, 0..100. */
  detune: number;
  /** Level of the octave-down layer. */
  sub: number;
  /** Level of the octave-up layer. */
  shimmer: number;

  // --- modulation --------------------------------------------------------
  vibratoRate: number;
  /** Vibrato depth in cents, 0..100. */
  vibratoDepth: number;
  /** Slow random pitch wander in cents, 0..100; each stacked voice drifts on its own. */
  drift: number;
  formantRate: number;
  /** Formant LFO depth in semitones, 0..6. */
  formantDepth: number;
  /** Loudness → pitch (±2 st at full level), -1..1. */
  envPitch: number;
  /** Loudness → formant (±6 st at full level), -1..1. */
  envFormant: number;
  /** Loudness → width, 0..1. */
  envWidth: number;

  // --- space -------------------------------------------------------------
  /** How far the layers spread around the listener, 0 (mono) .. 1. */
  width: number;
  /** Speed at which the whole field rotates, Hz. */
  orbitRate: number;
  /** Rotation depth, 0 (still) .. 1 (full circle). */
  orbitDepth: number;
  /** Ensemble chorus amount, 0..1. */
  ensemble: number;
  /** How far behind the listener the field reaches, 0 (±60°) .. 1 (±180°). Surround only in effect. */
  rear: number;
  /** Low-passed sub send to the LFE channel (5.1/7.1). */
  lfe: number;
  /** Dry voice to the centre speaker (5.1/7.1). */
  center: number;
  /** Ring-modulation carrier in Hz, 0 = off. */
  ring: number;
  /** Rotates the whole field, -1..1 = ±180°. In stereo: left .. right. */
  pan: number;
}

export type SynthKey = keyof VoiceSynthParams;

export const DEFAULT_SYNTH: VoiceSynthParams = {
  mix: 0,
  pitch: 0, formant: 0, chord: 0, glide: 0,
  shift: 1, vocoder: 0, talkbox: 0, compuvox: 0, polyvox: 0, character: 0.5,
  unison: 1, detune: 12, sub: 0, shimmer: 0,
  vibratoRate: 5, vibratoDepth: 0, drift: 0, formantRate: 0.5, formantDepth: 0,
  envPitch: 0, envFormant: 0, envWidth: 0,
  width: 0.6, orbitRate: 0.2, orbitDepth: 0, ensemble: 0, rear: 0.3, lfe: 0, center: 0, ring: 0, pan: 0,
};

export const CHORD_NAMES = ["Unison", "Octave", "Fifth", "Major", "Minor", "Sus4", "Wide"] as const;

/** UI metadata for one parameter. */
export interface ParamSpec {
  key: SynthKey;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Unit suffix for the readout. */
  unit?: string;
}

const spec = (key: SynthKey, label: string, min: number, max: number, step: number, unit?: string): ParamSpec => ({
  key, label, min, max, step, unit,
});

/** Parameter groups as the rack shows them. `chord` is a button row, not a slider. */
export const SYNTH_SECTIONS: { title: string; params: ParamSpec[] }[] = [
  {
    title: "ENGINES",
    params: [
      spec("shift", "SHIFT", 0, 1, 0.01),
      spec("vocoder", "VOCODER", 0, 1, 0.01),
      spec("talkbox", "TALKBOX", 0, 1, 0.01),
      spec("compuvox", "COMPUVOX", 0, 1, 0.01),
      spec("polyvox", "POLYVOX", 0, 1, 0.01),
      spec("character", "CHARACTER", 0, 1, 0.01),
    ],
  },
  {
    title: "PITCH",
    params: [
      spec("pitch", "PITCH", -24, 24, 1, "st"),
      spec("formant", "FORMANT", -12, 12, 0.5, "st"),
      spec("glide", "GLIDE", 0, 1, 0.01),
      spec("ring", "RING", 0, 400, 1, "Hz"),
    ],
  },
  {
    title: "STACK",
    params: [
      spec("unison", "UNISON", 1, 8, 1, "vc"),
      spec("detune", "DETUNE", 0, 100, 1, "ct"),
      spec("sub", "SUB −8VB", 0, 1, 0.01),
      spec("shimmer", "SHIMMER +8VA", 0, 1, 0.01),
    ],
  },
  {
    title: "MODULATION",
    params: [
      spec("vibratoRate", "VIB RATE", 0, 12, 0.1, "Hz"),
      spec("vibratoDepth", "VIB DEPTH", 0, 100, 1, "ct"),
      spec("drift", "DRIFT", 0, 100, 1, "ct"),
      spec("formantRate", "FMT RATE", 0, 12, 0.1, "Hz"),
      spec("formantDepth", "FMT DEPTH", 0, 6, 0.1, "st"),
      spec("envPitch", "DYN→PITCH", -1, 1, 0.01),
      spec("envFormant", "DYN→FORMANT", -1, 1, 0.01),
      spec("envWidth", "DYN→WIDTH", 0, 1, 0.01),
    ],
  },
  {
    title: "SPACE",
    params: [
      spec("pan", "PAN", -1, 1, 0.01),
      spec("width", "WIDTH", 0, 1, 0.01),
      spec("orbitRate", "ORBIT RATE", 0, 4, 0.01, "Hz"),
      spec("orbitDepth", "ORBIT", 0, 1, 0.01),
      spec("ensemble", "ENSEMBLE", 0, 1, 0.01),
      spec("rear", "REAR", 0, 1, 0.01),
      spec("center", "CENTER", 0, 1, 0.01),
      spec("lfe", "LFE", 0, 1, 0.01),
    ],
  },
];

export const SYNTH_SPECS: Record<SynthKey, ParamSpec> = Object.fromEntries(
  [...SYNTH_SECTIONS.flatMap((s) => s.params), spec("mix", "MIX", 0, 1, 0.01), spec("chord", "CHORD", 0, 6, 1)].map(
    (s) => [s.key, s],
  ),
) as Record<SynthKey, ParamSpec>;

/** Clamp + step-round a value to its spec so bad session data can't reach the worklet. */
export function clampSynthValue(key: SynthKey, value: number): number {
  const s = SYNTH_SPECS[key];
  if (!Number.isFinite(value)) return DEFAULT_SYNTH[key];
  const v = Math.min(s.max, Math.max(s.min, value));
  return s.step >= 1 ? Math.round(v) : v;
}

/** True when the synth produces anything: some wet mix and at least one engine up. */
export function synthIsActive(p: VoiceSynthParams): boolean {
  return p.mix > 0 && (p.shift > 0 || p.vocoder > 0 || p.talkbox > 0 || p.compuvox > 0 || p.polyvox > 0);
}

// ---- presets ---------------------------------------------------------------

export type PresetCategory = "Classic" | "Stacks" | "Synth" | "Space";
export const PRESET_CATEGORIES: PresetCategory[] = ["Classic", "Stacks", "Synth", "Space"];

export interface SynthPreset {
  name: string;
  category: PresetCategory;
  params: Partial<VoiceSynthParams>;
}

/** Factory presets. The first five keep the v1 voice-FX names so muscle
 *  memory (and the browser test) still find "Chipmunk". */
export const SYNTH_PRESETS: SynthPreset[] = [
  { name: "Off", category: "Classic", params: { mix: 0 } },
  { name: "Chipmunk", category: "Classic", params: { mix: 1, shift: 1, pitch: 7, formant: 3, width: 0.2 } },
  { name: "Deep", category: "Classic", params: { mix: 1, shift: 1, pitch: -7, formant: -4, sub: 0.3, lfe: 0.5, width: 0.2 } },
  { name: "Robot", category: "Classic", params: { mix: 1, shift: 0, vocoder: 1, chord: 0, character: 0.6, width: 0.3 } },
  { name: "Alien", category: "Classic", params: { mix: 1, shift: 1, pitch: 5, formant: 6, ring: 90, formantRate: 0.3, formantDepth: 2, width: 0.5 } },
  {
    name: "Choir",
    category: "Stacks",
    params: {
      mix: 0.7, shift: 1, unison: 6, detune: 18, drift: 8, polyvox: 0.7, chord: 3, shimmer: 0.25,
      vibratoRate: 5.5, vibratoDepth: 12, ensemble: 0.5, width: 1, rear: 0.6, center: 0.4, lfe: 0.2,
    },
  },
  {
    name: "Daft",
    category: "Synth",
    params: { mix: 1, shift: 0, talkbox: 1, chord: 3, character: 0.7, unison: 1, width: 0.6, envFormant: 0.5, glide: 0.2 },
  },
  {
    name: "Speak & Spell",
    category: "Synth",
    params: { mix: 1, shift: 0, compuvox: 1, chord: 0, character: 0.8, width: 0 },
  },
  {
    name: "Cathedral",
    category: "Stacks",
    params: {
      mix: 0.6, shift: 1, unison: 4, detune: 8, sub: 0.6, shimmer: 0.5, vocoder: 0.4, chord: 6,
      ensemble: 0.8, width: 1, rear: 1, center: 0.5, lfe: 0.6, orbitRate: 0.05, orbitDepth: 0.4,
    },
  },
  {
    name: "Orbit",
    category: "Space",
    params: {
      mix: 0.8, shift: 1, unison: 3, detune: 25, polyvox: 0.5, chord: 2,
      orbitRate: 0.5, orbitDepth: 1, width: 1, rear: 1, envWidth: 0.6, envPitch: 0.3, vibratoDepth: 8,
    },
  },
  {
    name: "Swarm",
    category: "Stacks",
    params: {
      mix: 1, shift: 1, unison: 8, detune: 60, drift: 40, glide: 0.4, ensemble: 1, width: 1, rear: 0.8,
      envPitch: -0.5, vibratoRate: 0.8, vibratoDepth: 30,
    },
  },
];

/** Apply a preset over the defaults. Presets are absolute (a preset that
 *  says nothing about `sub` gets the default 0), so switching is predictable. */
export function presetParams(preset: SynthPreset): VoiceSynthParams {
  return { ...DEFAULT_SYNTH, ...preset.params };
}

/** Name of the preset whose params match exactly, or null when edited. */
export function matchingPreset(p: VoiceSynthParams): string | null {
  for (const preset of SYNTH_PRESETS) {
    const q = presetParams(preset);
    if ((Object.keys(q) as SynthKey[]).every((k) => q[k] === p[k])) return preset.name;
  }
  return null;
}

// ---- surround --------------------------------------------------------------

export type SurroundLayout = "stereo" | "5.1" | "7.1";

export interface SurroundInfo {
  channels: number;
  label: string;
  /** WAVE_FORMAT_EXTENSIBLE speaker mask (SMPTE channel order). */
  mask: number;
  /** Channel names in order, for the UI. */
  names: string[];
}

export const SURROUND: Record<SurroundLayout, SurroundInfo> = {
  stereo: { channels: 2, label: "Stereo", mask: 0x3, names: ["L", "R"] },
  "5.1": { channels: 6, label: "5.1", mask: 0x3f, names: ["L", "R", "C", "LFE", "Ls", "Rs"] },
  "7.1": { channels: 8, label: "7.1", mask: 0x63f, names: ["L", "R", "C", "LFE", "Lb", "Rb", "Ls", "Rs"] },
};

export const SURROUND_ORDER: SurroundLayout[] = ["stereo", "5.1", "7.1"];

export function surroundChannels(layout: SurroundLayout | undefined): number {
  return SURROUND[layout ?? "stereo"]?.channels ?? 2;
}

// ---- migration -------------------------------------------------------------

/** v1 tracks carried `voice: { preset, mix }` driving a pitch worklet + ring
 *  mod. Map those onto the synth so old sessions open sounding the same. */
export function migrateVoiceParams(voice: unknown): VoiceSynthParams {
  const v = (voice ?? {}) as { preset?: string; mix?: number };
  const mix = typeof v.mix === "number" ? Math.min(1, Math.max(0, v.mix)) : 1;
  switch (v.preset) {
    case "chipmunk": return { ...DEFAULT_SYNTH, mix, shift: 1, pitch: 7, width: 0 };
    case "deep":     return { ...DEFAULT_SYNTH, mix, shift: 1, pitch: -7, width: 0 };
    case "robot":    return { ...DEFAULT_SYNTH, mix, shift: 1, ring: 45, width: 0 };
    case "alien":    return { ...DEFAULT_SYNTH, mix, shift: 1, pitch: 5, ring: 90, width: 0 };
    default:         return { ...DEFAULT_SYNTH, mix: 0 };
  }
}

/** Fill in / clamp a synth block from any (possibly old or partial) track data. */
export function normalizeSynth(synth: unknown, legacyVoice?: unknown): VoiceSynthParams {
  if (!synth || typeof synth !== "object") return migrateVoiceParams(legacyVoice);
  const out = { ...DEFAULT_SYNTH };
  const src = synth as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SYNTH) as SynthKey[]) {
    if (typeof src[key] === "number") out[key] = clampSynthValue(key, src[key] as number);
  }
  return out;
}
