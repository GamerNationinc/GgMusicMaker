// BASS MOD — modulate and thicken a bass line or an 808, as data.
//
// The DSP is public/bass-core.js (worklet) and native/src/bass.rs (its
// port). This file is the parameter model, UI ranges and presets.

export interface BassParams {
  /** Tempo the LFO locks to (the project has no tempo of its own yet). */
  bpm: number;
  /** LFO length: index into BASS_RATES (1/1 … 1/16T). */
  rate: number;
  /** LFO shape: index into BASS_SHAPES. */
  shape: number;
  /** How far the LFO sweeps the filter down from CUTOFF, 0..1 = 0..6 octaves. */
  wobble: number;
  /** Filter cutoff at the top of the sweep, Hz (20000 = filter off). */
  cutoff: number;
  /** Filter resonance, 0..1. */
  reso: number;
  /** TALK: each hit opens (+) or closes (−) the filter, up to 5 octaves. */
  env: number;
  /** Pitch wobble at the LFO rate, 0..1 = 0..±50 cents. */
  vibrato: number;
  /** Clean sine tracking the bass's fundamental, 0..1. */
  deepen: number;
  /** 0 = DEEPEN at the bass's pitch, 1 = an octave below. */
  octave: number;
  /** Saturated harmonics so small speakers hear the bass, 0..1. */
  grit: number;
  /** Stereo width above 150 Hz (the sub stays mono), 0..1. */
  widen: number;
  /** Sidechain-style duck on every LFO cycle, 0..1. */
  pump: number;
  /** Output level, dB. */
  output: number;
}

export type BassKey = keyof BassParams;

export const DEFAULT_BASS: BassParams = {
  bpm: 140, rate: 3, shape: 0, wobble: 0, cutoff: 20000, reso: 0.2, env: 0,
  vibrato: 0, deepen: 0, octave: 0, grit: 0, widen: 0, pump: 0, output: 0,
};

export const BASS_RATES = ["1/1", "1/2", "1/4", "1/8", "1/16", "1/4T", "1/8T", "1/16T"];
/** LFO length per rate, in beats (the same table as bass-core.js and bass.rs). */
export const BASS_RATE_BEATS = [4, 2, 1, 0.5, 0.25, 2 / 3, 1 / 3, 1 / 6];
export const BASS_SHAPES = ["SINE", "TRI", "SAW", "SQUARE", "RANDOM"];

export interface BassSpec {
  key: BassKey;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
  /** Slider moves along a log scale (frequencies). */
  log?: boolean;
}

/** The knobs, grouped as the rack shows them. */
export const BASS_GROUPS: { title: string; specs: BassSpec[] }[] = [
  {
    title: "MODULATE",
    specs: [
      { key: "wobble", label: "WOBBLE", min: 0, max: 1, step: 0.01, hint: "the LFO sweeps the filter: classic wub" },
      { key: "cutoff", label: "CUTOFF", min: 40, max: 20000, step: 1, hint: "filter at the top of the sweep", log: true },
      { key: "reso", label: "RESO", min: 0, max: 1, step: 0.01, hint: "filter resonance: the vowel in the wobble" },
      { key: "env", label: "TALK", min: -1, max: 1, step: 0.01, hint: "each hit opens the filter (− closes it)" },
      { key: "vibrato", label: "VIBRATO", min: 0, max: 1, step: 0.01, hint: "pitch wobble at the LFO rate" },
      { key: "pump", label: "PUMP", min: 0, max: 1, step: 0.01, hint: "sidechain duck on every LFO cycle" },
    ],
  },
  {
    title: "THICKEN",
    specs: [
      { key: "deepen", label: "DEEPEN", min: 0, max: 1, step: 0.01, hint: "adds a clean sine that follows the bass's pitch" },
      { key: "grit", label: "GRIT", min: 0, max: 1, step: 0.01, hint: "harmonics so phones and laptops hear the bass" },
      { key: "widen", label: "WIDEN", min: 0, max: 1, step: 0.01, hint: "spreads everything above 150 Hz; the sub stays mono" },
      { key: "output", label: "OUTPUT", min: -18, max: 12, step: 0.5, hint: "set the level exactly" },
    ],
  },
];

export const BASS_SPECS: BassSpec[] = BASS_GROUPS.flatMap((g) => g.specs);

const SPEC_BY_KEY: Record<BassKey, { min: number; max: number; step: number }> = {
  ...(Object.fromEntries(BASS_SPECS.map((s) => [s.key, s])) as Record<BassKey, BassSpec>),
  bpm: { min: 40, max: 240, step: 1 },
  rate: { min: 0, max: BASS_RATES.length - 1, step: 1 },
  shape: { min: 0, max: BASS_SHAPES.length - 1, step: 1 },
  octave: { min: 0, max: 1, step: 1 },
};

export function clampBassValue(key: BassKey, value: number): number {
  const s = SPEC_BY_KEY[key];
  if (!s || !Number.isFinite(value)) return DEFAULT_BASS[key];
  const v = Math.min(s.max, Math.max(s.min, value));
  return s.step >= 1 ? Math.round(v) : v;
}

/** True when the module changes the sound (the chain routes around it otherwise). */
export function bassIsActive(p: BassParams): boolean {
  return (
    p.wobble > 0 || p.env !== 0 || p.cutoff < 20000 || p.vibrato > 0 || p.deepen > 0 ||
    p.grit > 0 || p.widen > 0 || p.pump > 0 || p.output !== 0
  );
}

export function normalizeBass(bass: unknown): BassParams {
  const out = { ...DEFAULT_BASS };
  if (!bass || typeof bass !== "object") return out;
  const src = bass as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_BASS) as BassKey[]) {
    if (typeof src[key] === "number") out[key] = clampBassValue(key, src[key] as number);
  }
  return out;
}

/** Slider position (0..1000) ↔ value, for the log-scaled cutoff. */
export function bassToSlider(spec: BassSpec, v: number): number {
  if (!spec.log) return v;
  return (Math.log(v / spec.min) / Math.log(spec.max / spec.min)) * 1000;
}
export function bassFromSlider(spec: BassSpec, s: number): number {
  if (!spec.log) return s;
  return Math.round(spec.min * Math.pow(spec.max / spec.min, s / 1000));
}

export function bassText(key: BassKey, v: number): string {
  if (key === "cutoff") return v >= 20000 ? "OPEN" : v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${Math.round(v)}Hz`;
  if (key === "output") return `${v > 0 ? "+" : ""}${v.toFixed(1)}dB`;
  if (key === "env") return `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;
  if (key === "bpm") return `${Math.round(v)}`;
  if (key === "rate") return BASS_RATES[v] ?? "?";
  if (key === "shape") return BASS_SHAPES[v] ?? "?";
  if (key === "octave") return v ? "−8VB" : "UNISON";
  return `${Math.round(v * 100)}%`;
}

export interface BassPreset {
  name: string;
  params: Partial<BassParams>;
}

export const BASS_PRESETS: BassPreset[] = [
  { name: "Off", params: {} },
  { name: "Wobble 1/8", params: { wobble: 0.7, cutoff: 1800, reso: 0.55, rate: 3 } },
  { name: "Yoi Growl", params: { wobble: 0.85, cutoff: 2600, reso: 0.75, rate: 6, shape: 1, grit: 0.45 } },
  { name: "Glitch Steps", params: { wobble: 0.8, cutoff: 3000, reso: 0.5, rate: 4, shape: 4 } },
  { name: "Talking 808", params: { env: 0.7, cutoff: 260, reso: 0.5, deepen: 0.3 } },
  { name: "Deep 808", params: { deepen: 0.6, grit: 0.25 } },
  { name: "Sub Drop", params: { deepen: 0.8, octave: 1, output: -1 } },
  { name: "Wide Bass", params: { widen: 0.8, grit: 0.3 } },
  { name: "Pump 1/4", params: { pump: 0.7, rate: 2 } },
  { name: "Vibrato 808", params: { vibrato: 0.6, rate: 3, deepen: 0.3 } },
  { name: "Phone Killer", params: { grit: 0.75, deepen: 0.25, widen: 0.3 } },
  { name: "Festival", params: { wobble: 0.6, cutoff: 2200, reso: 0.6, rate: 3, pump: 0.5, widen: 0.6, deepen: 0.4, grit: 0.3 } },
];

export function bassPresetParams(p: BassPreset, keep?: Pick<BassParams, "bpm">): BassParams {
  return { ...DEFAULT_BASS, ...(keep ?? {}), ...p.params };
}

/** Preset name when everything but the tempo matches one, else null. */
export function matchingBassPreset(p: BassParams): string | null {
  for (const preset of BASS_PRESETS) {
    const q = bassPresetParams(preset, { bpm: p.bpm });
    if ((Object.keys(q) as BassKey[]).every((k) => q[k] === p[k])) return preset.name;
  }
  return null;
}

/** Structural type of public/bass-core.js's class, for tests. */
export interface BassCoreLike {
  set(p: BassParams): void;
  reset(): void;
  block(t: number): void;
  step(l: number, r: number): void;
  l: number;
  r: number;
}
export type BassCoreCtor = new (sampleRate: number) => BassCoreLike;
