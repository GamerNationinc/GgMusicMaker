// MORPH — a rack of completely different sound engines ("plugins inside the
// plugin"), one picked at a time, each with its own four macro knobs.
//
// Pure data + mapping, like voice-synth.ts: the parameter set the
// `morph-processor` worklet takes (one AudioParam per key), the engines and
// what their knobs mean, tuning references, surround motion paths and the
// factory presets. No Web Audio in here so it unit-tests without a context.
//
// Every engine renders several *voices* (grains, strings, formants, spectral
// bands, partials…) and each voice gets its own spot on the speaker ring, so
// on a 5.1/7.1 bus the engine itself is spread around the listener; SPREAD,
// PATH and MOTION move those spots.

export interface MorphParams {
  /** Dry/wet, 0..1. 0 is a bit-exact bypass. */
  mix: number;
  /** Index into MORPH_ALGOS. */
  algo: number;
  /** The engine's four macro knobs, 0..1 each; meaning depends on `algo`. */
  a: number;
  b: number;
  c: number;
  d: number;
  /** Root note in semitones from C3 for the tuned engines. */
  note: number;
  /** Index into TUNINGS: the reference the tuned engines are built on. */
  tuning: number;
  /** How far the engine's voices spread round the listener, 0 (front) .. 1 (full ring). */
  spread: number;
  /** Index into PATHS: how the voices move. */
  path: number;
  /** Movement speed, 0..1 (≈ 0 .. 2 Hz). */
  motion: number;
  /** Per-speaker decorrelation (all-pass diffusion) so the field envelops instead of pin-pointing. */
  diffuse: number;
}

export type MorphKey = keyof MorphParams;

export const DEFAULT_MORPH: MorphParams = {
  mix: 0, algo: 0, a: 0.5, b: 0.5, c: 0.5, d: 0.5,
  note: 0, tuning: 0, spread: 0.7, path: 0, motion: 0.2, diffuse: 0,
};

export interface MorphAlgo {
  name: string;
  /** What the maths is, for the screen. */
  blurb: string;
  /** Labels for knobs a, b, c, d. */
  knobs: [string, string, string, string];
  /** Whether NOTE / TUNING mean anything for this engine. */
  tuned: boolean;
}

/** The engines, in worklet index order. Never reorder — sessions store the index. */
export const MORPH_ALGOS: MorphAlgo[] = [
  {
    name: "FM VOX",
    blurb: "2-op phase modulation: your voice is the modulator, a tuned sine the carrier",
    knobs: ["RATIO", "INDEX", "FEEDBACK", "VOICE→MOD"],
    tuned: true,
  },
  {
    name: "GRAIN CLOUD",
    blurb: "granular: 2 s memory, Hann grains re-pitched and sprayed round the ring",
    knobs: ["DENSITY", "GRAIN", "PITCH SCAT", "TIME SCAT"],
    tuned: false,
  },
  {
    name: "STRINGS",
    blurb: "Karplus-Strong waveguides tuned to a chord, bowed by the input",
    knobs: ["DECAY", "BRIGHT", "CHORD", "BOW NOISE"],
    tuned: true,
  },
  {
    name: "VOWEL",
    blurb: "3-formant vocal tract that morphs A-E-I-O-U; each formant has its own speaker spot",
    knobs: ["VOWEL", "MORPH RATE", "MORPH DEPTH", "TRACT SIZE"],
    tuned: false,
  },
  {
    name: "FOLD",
    blurb: "Buchla sine wavefolder + Chebyshev polynomial harmonic generator",
    knobs: ["DRIVE", "FOLDS", "SYMMETRY", "CHEBYSHEV"],
    tuned: false,
  },
  {
    name: "CHAOS",
    blurb: "Lorenz attractor drives a resonant filter, loudness and the voice's flight path",
    knobs: ["SPEED", "FILTER", "RHO", "AMP MOD"],
    tuned: false,
  },
  {
    name: "SPECTRAL",
    blurb: "phase-vocoder STFT: freeze, smear, bin-shift, robot/whisper phase; 4 bands panned apart",
    knobs: ["FREEZE", "SMEAR", "PHASE", "SHIFT"],
    tuned: false,
  },
  {
    name: "HARMONIC",
    blurb: "resonator bank on the natural harmonic series (just intonation), binaural beat, ear-soft",
    knobs: ["PARTIALS", "RESONANCE", "BEAT Hz", "EAR SOFT"],
    tuned: true,
  },
];

export interface Tuning {
  name: string;
  /** Frequency of the root at `note` 0. */
  root: number;
  /** One line for the screen. */
  info: string;
}

/** Tuning references for the tuned engines. The HARMONIC engine always stacks
 *  whole-number (just) ratios on the root; this picks the root. PHI swaps the
 *  harmonic series for golden-ratio partials (inharmonic, bell-like). */
export const TUNINGS: Tuning[] = [
  { name: "A440 · 12-TET", root: 130.81, info: "Concert pitch; C3 = 130.81 Hz" },
  { name: "A432", root: 128.43, info: "'Verdi' pitch; C3 = 128.43 Hz" },
  { name: "528 SOLFEGGIO", root: 132, info: "Root 132 Hz = 528 / 4" },
  { name: "SCHUMANN ×16", root: 125.28, info: "Root 125.28 Hz = 7.83 Hz × 16" },
  { name: "PHI PARTIALS", root: 130.81, info: "Partials at φ^n — inharmonic, bell-like" },
];

/** Motion paths for the engine's voices. Index order is the worklet's. */
export const PATHS = ["STATIC", "CIRCLE", "PENDULUM", "FLY-OVER", "FIGURE-8", "SWARM", "LORENZ"] as const;

export interface MorphSpec {
  key: MorphKey;
  min: number;
  max: number;
  step: number;
}

export const MORPH_SPECS: Record<MorphKey, MorphSpec> = {
  mix: { key: "mix", min: 0, max: 1, step: 0.01 },
  algo: { key: "algo", min: 0, max: MORPH_ALGOS.length - 1, step: 1 },
  a: { key: "a", min: 0, max: 1, step: 0.01 },
  b: { key: "b", min: 0, max: 1, step: 0.01 },
  c: { key: "c", min: 0, max: 1, step: 0.01 },
  d: { key: "d", min: 0, max: 1, step: 0.01 },
  note: { key: "note", min: -24, max: 24, step: 1 },
  tuning: { key: "tuning", min: 0, max: TUNINGS.length - 1, step: 1 },
  spread: { key: "spread", min: 0, max: 1, step: 0.01 },
  path: { key: "path", min: 0, max: PATHS.length - 1, step: 1 },
  motion: { key: "motion", min: 0, max: 1, step: 0.01 },
  diffuse: { key: "diffuse", min: 0, max: 1, step: 0.01 },
};

/** Params that pick a mode and must never glide through in-between values. */
export const MORPH_DISCRETE: MorphKey[] = ["algo", "note", "tuning", "path"];

export function clampMorphValue(key: MorphKey, value: number): number {
  const s = MORPH_SPECS[key];
  if (!Number.isFinite(value)) return DEFAULT_MORPH[key];
  const v = Math.min(s.max, Math.max(s.min, value));
  return s.step >= 1 ? Math.round(v) : v;
}

export function morphIsActive(p: MorphParams): boolean {
  return p.mix > 0;
}

/** Fill in / clamp a morph block from any (possibly old or partial) track data. */
export function normalizeMorph(morph: unknown): MorphParams {
  const out = { ...DEFAULT_MORPH };
  if (!morph || typeof morph !== "object") return out;
  const src = morph as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_MORPH) as MorphKey[]) {
    if (typeof src[key] === "number") out[key] = clampMorphValue(key, src[key] as number);
  }
  return out;
}

/** Knob readout: most macros are percentages; a few mean something concrete. */
export function knobText(p: MorphParams, knob: "a" | "b" | "c" | "d"): string {
  const v = p[knob];
  const algo = MORPH_ALGOS[p.algo]?.name;
  if (algo === "FM VOX" && knob === "a") return `×${FM_RATIOS[Math.min(FM_RATIOS.length - 1, Math.floor(v * FM_RATIOS.length))]}`;
  if (algo === "STRINGS" && knob === "c") return STRING_CHORDS[Math.min(STRING_CHORDS.length - 1, Math.floor(v * STRING_CHORDS.length))].name;
  if (algo === "VOWEL" && knob === "a") return VOWEL_NAMES[Math.min(4, Math.round(v * 4))];
  if (algo === "SPECTRAL" && knob === "c") return v < 1 / 3 ? "NATURAL" : v < 2 / 3 ? "ROBOT" : "WHISPER";
  if (algo === "SPECTRAL" && knob === "d") return `${Math.round((v - 0.5) * 48) > 0 ? "+" : ""}${Math.round((v - 0.5) * 48)} bins`;
  if (algo === "HARMONIC" && knob === "a") return `${1 + Math.round(v * 7)} of 8`;
  if (algo === "HARMONIC" && knob === "c") return v < 0.01 ? "off" : `${(v * 12).toFixed(1)} Hz`;
  return `${Math.round(v * 100)}%`;
}

/** Shared with the worklet (kept in sync by a unit test). */
export const FM_RATIOS = [0.5, 1, 1.5, 2, 3, 3.5, 5, 7];
export const STRING_CHORDS = [
  { name: "UNISON", iv: [0, 0.07, -0.07, 12] },
  { name: "FIFTHS", iv: [0, 7, 12, 19] },
  { name: "MAJOR", iv: [0, 4, 7, 12] },
  { name: "MINOR", iv: [0, 3, 7, 12] },
  { name: "SUS", iv: [0, 5, 7, 14] },
  { name: "CLUSTER", iv: [0, 1, 2, 3] },
];
export const VOWEL_NAMES = ["A", "E", "I", "O", "U"];

// ---- presets ---------------------------------------------------------------

export interface MorphPreset {
  name: string;
  params: Partial<MorphParams>;
}

/** Two or three per engine, each a different use of it. */
export const MORPH_PRESETS: MorphPreset[] = [
  { name: "Off", params: { mix: 0 } },
  { name: "FM Bell Voice", params: { mix: 0.7, algo: 0, a: 0.45, b: 0.35, c: 0.1, d: 0.8, note: 12, spread: 0.6, path: 1, motion: 0.1 } },
  { name: "FM Growl", params: { mix: 0.8, algo: 0, a: 0.1, b: 0.8, c: 0.6, d: 1, note: -12, spread: 0.3, path: 2, motion: 0.3 } },
  { name: "Grain Halo", params: { mix: 0.6, algo: 1, a: 0.6, b: 0.7, c: 0.35, d: 0.3, spread: 1, path: 1, motion: 0.05, diffuse: 0.5 } },
  { name: "Grain Storm", params: { mix: 0.8, algo: 1, a: 1, b: 0.15, c: 0.8, d: 0.8, spread: 1, path: 5, motion: 0.6, diffuse: 0.3 } },
  { name: "Harp Strings", params: { mix: 0.6, algo: 2, a: 0.7, b: 0.75, c: 0.45, d: 0, spread: 0.8, path: 0 } },
  { name: "Drone Sitar", params: { mix: 0.7, algo: 2, a: 0.95, b: 0.9, c: 0.2, d: 0.4, note: -12, spread: 1, path: 1, motion: 0.05, diffuse: 0.4 } },
  { name: "Talking Tract", params: { mix: 0.9, algo: 3, a: 0, b: 0.35, c: 1, d: 0.5, spread: 0.8, path: 0 } },
  { name: "Throat Giant", params: { mix: 0.9, algo: 3, a: 0.75, b: 0.1, c: 0.3, d: 0.1, spread: 1, path: 3, motion: 0.1 } },
  { name: "Buchla Fold", params: { mix: 0.7, algo: 4, a: 0.5, b: 0.55, c: 0.2, d: 0.15, spread: 0.4, path: 0 } },
  { name: "Harmonic Crush", params: { mix: 0.8, algo: 4, a: 0.8, b: 0.2, c: 0.5, d: 0.9, spread: 0.7, path: 4, motion: 0.3 } },
  { name: "Lorenz Flight", params: { mix: 0.8, algo: 5, a: 0.4, b: 0.6, c: 0.5, d: 0.3, spread: 1, path: 6, motion: 0.4, diffuse: 0.3 } },
  { name: "Strange Weather", params: { mix: 0.9, algo: 5, a: 0.9, b: 0.9, c: 1, d: 0.7, spread: 1, path: 6, motion: 0.8 } },
  { name: "Spectral Freeze", params: { mix: 0.7, algo: 6, a: 0.9, b: 0.6, c: 0.1, d: 0.5, spread: 1, path: 1, motion: 0.03, diffuse: 0.6 } },
  { name: "Robot Prism", params: { mix: 0.9, algo: 6, a: 0, b: 0.1, c: 0.5, d: 0.62, spread: 0.9, path: 0 } },
  { name: "Whisper Swarm", params: { mix: 0.8, algo: 6, a: 0.2, b: 0.4, c: 0.9, d: 0.5, spread: 1, path: 5, motion: 0.5, diffuse: 0.5 } },
  { name: "Just Choir 432", params: { mix: 0.6, algo: 7, a: 0.7, b: 0.7, c: 0, d: 0.5, tuning: 1, spread: 1, path: 1, motion: 0.04, diffuse: 0.5 } },
  { name: "Solfeggio 528", params: { mix: 0.6, algo: 7, a: 0.5, b: 0.8, c: 0, d: 0.6, tuning: 2, spread: 0.9, path: 0, diffuse: 0.4 } },
  { name: "Schumann Beat", params: { mix: 0.6, algo: 7, a: 0.4, b: 0.85, c: 0.65, d: 0.7, tuning: 3, spread: 1, path: 0 } },
  { name: "Golden Bells", params: { mix: 0.7, algo: 7, a: 1, b: 0.9, c: 0, d: 0.3, tuning: 4, spread: 1, path: 5, motion: 0.2 } },
];

export function morphPresetParams(preset: MorphPreset): MorphParams {
  return { ...DEFAULT_MORPH, ...preset.params };
}

export function matchingMorphPreset(p: MorphParams): string | null {
  for (const preset of MORPH_PRESETS) {
    const q = morphPresetParams(preset);
    if ((Object.keys(q) as MorphKey[]).every((k) => q[k] === p[k])) return preset.name;
  }
  return null;
}
