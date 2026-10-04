// Sampler pads — the data (docs/sampler-research.md §2). Pure.
//
// Ten banks (A–J) of sixteen pads, SP-404-style. A pad plays a region of an
// audio buffer from the engine's buffer store; only pads with a sample are
// stored, in `Project.pads`, so they save with the session and undo like any
// other edit. Played by native/src/pads.rs and src/audio/sampler.ts — see
// there for exactly how each setting sounds.

export const BANKS = "ABCDEFGHIJ";
export const PADS_PER_BANK = 16;
export const SLOTS = BANKS.length * PADS_PER_BANK;

export const PAD_MODES = ["oneshot", "gate", "loop"] as const;
export type PadMode = (typeof PAD_MODES)[number];
export const PAD_MODE_LABEL: Record<PadMode, string> = { oneshot: "ONE-SHOT", gate: "GATE", loop: "LOOP" };

export interface Pad {
  /** 0..159: bank * 16 + pad. */
  slot: number;
  name: string;
  bufferId: string;
  /** Region of the buffer, seconds. */
  start: number;
  end: number;
  mode: PadMode;
  reverse: boolean;
  /** Linear, 0..1.5. */
  gain: number;
  /** -1..1. */
  pan: number;
  /** Semitones, -24..24 (repitch: speed and pitch together). */
  pitch: number;
  /** Seconds. */
  attack: number;
  release: number;
  /** 0 = none, 1..4: pads in a group cut each other (open/closed hat). */
  choke: number;
  /** A retrigger cuts the pad's previous voice. */
  mono: boolean;
  /** 0 dry, 1 / 2 = into FX bus 1 / 2 (src/fx/fxbus.ts). Absent = dry. */
  bus?: number;
}

/** The knobs, with their ranges (UI + clamping on load). */
export const PAD_RANGES = {
  gain: [0, 1.5],
  pan: [-1, 1],
  pitch: [-24, 24],
  attack: [0, 2],
  release: [0, 4],
  choke: [0, 4],
} as const;
export type PadKnob = keyof typeof PAD_RANGES;

export function newPad(slot: number, bufferId: string, start: number, end: number, name: string): Pad {
  return { slot, name, bufferId, start, end, mode: "oneshot", reverse: false, gain: 1, pan: 0, pitch: 0, attack: 0, release: 0.05, choke: 0, mono: true, bus: 0 };
}

export const bankOf = (slot: number) => Math.floor(slot / PADS_PER_BANK);
export const indexInBank = (slot: number) => slot % PADS_PER_BANK;
export const slotOf = (bank: number, index: number) => bank * PADS_PER_BANK + index;
/** "A1" … "J16". */
export const padLabel = (slot: number) => `${BANKS[bankOf(slot)]}${indexInBank(slot) + 1}`;

export const padAt = (pads: readonly Pad[] | undefined, slot: number): Pad | undefined => pads?.find((p) => p.slot === slot);

/** Put `pad` in its slot (replacing what was there), kept in slot order. */
export function setPad(pads: readonly Pad[] | undefined, pad: Pad): Pad[] {
  return [...(pads ?? []).filter((p) => p.slot !== pad.slot), pad].sort((a, b) => a.slot - b.slot);
}

export function clearPad(pads: readonly Pad[] | undefined, slot: number): Pad[] {
  return (pads ?? []).filter((p) => p.slot !== slot);
}

/** First empty slot in `bank` at or after `from` (then from its start); null when full. */
export function firstEmpty(pads: readonly Pad[] | undefined, bank: number, from = 0): number | null {
  for (let k = 0; k < PADS_PER_BANK; k++) {
    const slot = slotOf(bank, (from + k) % PADS_PER_BANK);
    if (!padAt(pads, slot)) return slot;
  }
  return null;
}

/** Slices of one buffer laid onto consecutive slots from `firstSlot`
 *  (spilling into the next banks), named "<name> 1…N". */
export function slicesToPads(
  pads: readonly Pad[] | undefined,
  bufferId: string,
  slices: readonly { start: number; end: number }[],
  firstSlot: number,
  name: string,
  template?: Partial<Pad>,
): Pad[] {
  let out = [...(pads ?? [])];
  slices.slice(0, SLOTS - firstSlot).forEach((s, i) => {
    const slot = firstSlot + i;
    const pad = { ...newPad(slot, bufferId, s.start, s.end, `${name} ${i + 1}`), ...template, slot, bufferId, start: s.start, end: s.end, name: `${name} ${i + 1}` };
    out = setPad(out, pad);
  });
  return out;
}

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

export function clampPadValue(key: PadKnob, v: number): number {
  const r = clamp(Number.isFinite(v) ? v : 0, PAD_RANGES[key]);
  return key === "choke" ? Math.round(r) : r;
}

/** A pad from a session file (any version), or null if it can't be one. */
export function normalizePad(raw: unknown): Pad | null {
  const p = raw as Partial<Pad> | null;
  if (!p || typeof p.bufferId !== "string" || !Number.isInteger(p.slot) || p.slot! < 0 || p.slot! >= SLOTS) return null;
  const d = newPad(p.slot!, p.bufferId, Number(p.start) || 0, Number(p.end) || 0, typeof p.name === "string" ? p.name : padLabel(p.slot!));
  const pad: Pad = {
    ...d,
    mode: PAD_MODES.includes(p.mode as PadMode) ? (p.mode as PadMode) : d.mode,
    reverse: !!p.reverse,
    mono: p.mono !== false,
    bus: [1, 2].includes(Number(p.bus)) ? Number(p.bus) : 0,
  };
  for (const k of Object.keys(PAD_RANGES) as PadKnob[]) pad[k] = clampPadValue(k, p[k] ?? d[k]);
  if (!(pad.end > pad.start)) return null;
  return pad;
}

export function normalizePads(raw: unknown): Pad[] {
  if (!Array.isArray(raw)) return [];
  let out: Pad[] = [];
  for (const r of raw) {
    const p = normalizePad(r);
    if (p) out = setPad(out, p);
  }
  return out;
}

/** What the native mixer needs (native/src/pads.rs PadSpec). */
export function padSpecs(pads: readonly Pad[] | undefined) {
  return (pads ?? []).map((p) => ({
    slot: p.slot,
    buffer: p.bufferId,
    start: p.start,
    end: p.end,
    mode: p.mode,
    reverse: p.reverse,
    gain: p.gain,
    pan: p.pan,
    pitch: p.pitch,
    attack: p.attack,
    release: p.release,
    choke: p.choke,
    mono: p.mono,
    bus: p.bus ?? 0,
  }));
}
