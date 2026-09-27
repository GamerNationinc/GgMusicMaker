// PUNCH — drums + bass enhancer (iZotope Neutron-style), as data.
//
// The DSP is public/punch-core.js (shared by the worklet and the timeline
// preview). This file is the parameter model, UI ranges and presets.

export interface PunchParams {
  /** Low-band boost, 0..1 = 0..+12 dB below FREQ. */
  boom: number;
  /** Octave-down sub-harmonic level, 0..1. */
  sub: number;
  /** Kick attack emphasis (low-band transient shaper), 0..1. */
  punch: number;
  /** Transient shaper above FREQ: -1 soften .. +1 crack. */
  snap: number;
  /** Low-band saturation, 0..1. */
  drive: number;
  /** Whole-signal tanh wall, 0..1: "completely blown out". */
  blowout: number;
  /** Crossover between the bass and everything else, Hz. */
  freq: number;
  /** Output level, dB. */
  output: number;
  /** 1 = soft ceiling keeps it under 0 dBFS; 0 = let it go over (the lane shows the red). */
  safe: number;
}

export type PunchKey = keyof PunchParams;

export const DEFAULT_PUNCH: PunchParams = {
  boom: 0, sub: 0, punch: 0, snap: 0, drive: 0, blowout: 0, freq: 110, output: 0, safe: 1,
};

export interface PunchSpec {
  key: PunchKey;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}

export const PUNCH_SPECS: PunchSpec[] = [
  { key: "boom", label: "BOOM", min: 0, max: 1, step: 0.01, hint: "more bass below the crossover (up to +12 dB)" },
  { key: "punch", label: "KICK PUNCH", min: 0, max: 1, step: 0.01, hint: "exaggerates each kick's hit against its tail" },
  { key: "sub", label: "SUB −8VB", min: 0, max: 1, step: 0.01, hint: "synthesises an octave below the bass" },
  { key: "drive", label: "DRIVE", min: 0, max: 1, step: 0.01, hint: "saturates the bass so small speakers can hear it" },
  { key: "snap", label: "SNAP", min: -1, max: 1, step: 0.01, hint: "drum crack above the crossover (− softens)" },
  { key: "blowout", label: "BLOWOUT", min: 0, max: 1, step: 0.01, hint: "slams everything into a wall — blown-speaker sound" },
  { key: "freq", label: "CROSSOVER", min: 40, max: 250, step: 1, hint: "where 'bass' ends" },
  { key: "output", label: "OUTPUT", min: -18, max: 12, step: 0.5, hint: "set the level exactly" },
];

const SPEC_BY_KEY: Record<string, { min: number; max: number; step: number }> = {
  ...Object.fromEntries(PUNCH_SPECS.map((s) => [s.key, s])),
  safe: { min: 0, max: 1, step: 1 },
};

export function clampPunchValue(key: PunchKey, value: number): number {
  const s = SPEC_BY_KEY[key];
  if (!Number.isFinite(value)) return DEFAULT_PUNCH[key];
  const v = Math.min(s.max, Math.max(s.min, value));
  return s.step >= 1 ? Math.round(v) : v;
}

/** True when the module changes the sound (the chain routes around it otherwise). */
export function punchIsActive(p: PunchParams): boolean {
  return p.boom > 0 || p.sub > 0 || p.punch > 0 || p.snap !== 0 || p.drive > 0 || p.blowout > 0 || p.output !== 0;
}

export function normalizePunch(punch: unknown): PunchParams {
  const out = { ...DEFAULT_PUNCH };
  if (!punch || typeof punch !== "object") return out;
  const src = punch as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_PUNCH) as PunchKey[]) {
    if (typeof src[key] === "number") out[key] = clampPunchValue(key, src[key] as number);
  }
  return out;
}

export function punchText(key: PunchKey, v: number): string {
  if (key === "freq") return `${Math.round(v)}Hz`;
  if (key === "output") return `${v > 0 ? "+" : ""}${v.toFixed(1)}dB`;
  if (key === "boom") return `+${(20 * Math.log10(1 + v * 3)).toFixed(1)}dB`;
  if (key === "snap") return `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;
  return `${Math.round(v * 100)}%`;
}

export interface PunchPreset {
  name: string;
  params: Partial<PunchParams>;
}

export const PUNCH_PRESETS: PunchPreset[] = [
  { name: "Off", params: {} },
  { name: "Tight Kick", params: { punch: 0.6, boom: 0.25, snap: 0.2, freq: 90 } },
  { name: "Knock", params: { punch: 0.9, boom: 0.4, drive: 0.25, snap: 0.4, freq: 120 } },
  { name: "808 Boom", params: { boom: 0.6, sub: 0.6, drive: 0.35, punch: 0.3, freq: 100 } },
  { name: "Club Sub", params: { sub: 0.8, boom: 0.35, punch: 0.4, freq: 80, output: -1 } },
  { name: "Snap Drums", params: { snap: 0.8, punch: 0.5, boom: 0.15, freq: 150 } },
  { name: "Soft Room", params: { snap: -0.6, punch: 0, boom: 0.2, freq: 130 } },
  { name: "Lo-Fi Crush", params: { drive: 0.7, boom: 0.3, snap: -0.2, blowout: 0.25, freq: 180, output: -3 } },
  { name: "Blown Out", params: { boom: 0.8, sub: 0.5, punch: 0.7, drive: 0.8, blowout: 0.6, freq: 120, output: 3, safe: 0 } },
  { name: "Speaker Killer", params: { boom: 1, sub: 1, punch: 1, drive: 1, blowout: 1, freq: 140, output: 4, safe: 0 } },
];

export function punchPresetParams(p: PunchPreset): PunchParams {
  return { ...DEFAULT_PUNCH, ...p.params };
}

export function matchingPunchPreset(p: PunchParams): string | null {
  for (const preset of PUNCH_PRESETS) {
    const q = punchPresetParams(preset);
    if ((Object.keys(q) as PunchKey[]).every((k) => q[k] === p[k])) return preset.name;
  }
  return null;
}

/** Structural type of public/punch-core.js's class, for the preview. */
export interface PunchCoreLike {
  set(p: PunchParams): void;
  reset(): void;
  step(l: number, r: number): void;
  l: number;
  r: number;
  lowIn: number;
  lowOut: number;
}
export type PunchCoreCtor = new (sampleRate: number) => PunchCoreLike;
