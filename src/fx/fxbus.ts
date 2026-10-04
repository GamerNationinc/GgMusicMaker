// FX BUSES — the SP-style performance effects (docs/sampler-research.md
// §3.2), as data. The DSP is public/fxbus-core.js (worklet) and its port
// native/src/fxbus.rs; what each effect and macro does is described there.
//
// Four buses, like the SP-404MKII:
//   BUS 1, BUS 2   pad buses — a pad plays DRY, or into bus 1 or 2
//   BUS 3, BUS 4   master buses — the whole mix goes through them (3 then
//                  4) before the limiter
// A bus's effect and macros are part of the project (saved, undoable).
// Whether it's engaged is performance: latched ON, or grabbed (R2 in the
// PADS kit: depth = how far it's pulled). Export renders without them —
// RESAMPLE prints them.

export const FX_EFFECTS = ["off", "vinyl", "cassette", "lofi", "filter", "echo", "looper"] as const;
export type FxEffect = (typeof FX_EFFECTS)[number];

export const FX_INFO: Record<FxEffect, { label: string; a: string; b: string }> = {
  off: { label: "OFF", a: "—", b: "—" },
  vinyl: { label: "VINYL", a: "AGE", b: "NOISE" },
  cassette: { label: "CASSETTE", a: "WEAR", b: "HISS" },
  lofi: { label: "LO-FI", a: "BITS", b: "RATE" },
  filter: { label: "FILTER", a: "CUTOFF", b: "RESO" },
  echo: { label: "ECHO", a: "TIME", b: "FEEDBACK" },
  looper: { label: "LOOPER", a: "LENGTH", b: "SPEED" },
};

export interface FxBusSettings {
  effect: FxEffect;
  /** Macros, 0..1. */
  a: number;
  b: number;
}

export const FX_BUS_COUNT = 4;
/** Buses pads can play into (index 0, 1 = BUS 1, 2). */
export const PAD_BUSES = 2;
export const busLabel = (i: number) => `BUS ${i + 1}`;
export const busRole = (i: number) => (i < PAD_BUSES ? "pads" : "master");

/** What a new project has: something to play with on every bus. */
export const DEFAULT_FX_BUSES: readonly FxBusSettings[] = [
  { effect: "lofi", a: 0.6, b: 0.5 },
  { effect: "echo", a: 0.45, b: 0.45 },
  { effect: "filter", a: 0.25, b: 0.35 },
  { effect: "vinyl", a: 0.5, b: 0.5 },
];

/** Live engagement of one bus (not saved). */
export interface FxLive {
  on: boolean;
  /** Grab depth 0..1 (R2 / the GRAB button). */
  grab: number;
}

export const fxDepth = (l: FxLive) => (l.on ? 1 : l.grab);

/** The buses of a project (absent = the defaults). */
export function fxBusesOf(project: { fxBuses?: FxBusSettings[] }): FxBusSettings[] {
  return project.fxBuses ?? DEFAULT_FX_BUSES.map((b) => ({ ...b }));
}

const clamp01 = (v: unknown) => Math.min(1, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 0.5));

/** Buses from a session file: four, valid; null when the file had none. */
export function normalizeFxBuses(raw: unknown): FxBusSettings[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return Array.from({ length: FX_BUS_COUNT }, (_, i) => {
    const r = (raw[i] ?? {}) as Partial<FxBusSettings>;
    const effect = FX_EFFECTS.includes(r.effect as FxEffect) ? (r.effect as FxEffect) : DEFAULT_FX_BUSES[i].effect;
    return { effect, a: clamp01(r.a ?? DEFAULT_FX_BUSES[i].a), b: clamp01(r.b ?? DEFAULT_FX_BUSES[i].b) };
  });
}

/** The engines' view of a bus (numeric effect id). */
export function fxSpec(b: FxBusSettings) {
  return { effect: FX_EFFECTS.indexOf(b.effect), a: b.a, b: b.b };
}
