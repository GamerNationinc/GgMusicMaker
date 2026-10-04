// The pad sequencer's data (docs/sampler-research.md §3.4, with Elektron-
// style parameter locks §4.2 and conditional trigs §4.3 designed in). Pure.
//
// Sixteen patterns per project, each 16–64 sixteenth steps long with its own
// swing. A note hits one pad on one step, with velocity, micro-timing (±½
// step), a length (gate pads let go after it), a chance and a condition
// (which loops it plays on), and optional locks — pad settings that apply to
// that hit only.

import { stepSeconds, type Tempo } from "./tempo";

export const PATTERNS = 16;
export const STEP_CHOICES = [16, 32, 48, 64] as const;
export const DEFAULT_VEL = 0.8;

/** Pad settings a step can override for its own hit. */
export interface StepLock {
  gain?: number;
  pan?: number;
  pitch?: number;
  reverse?: boolean;
}
export const LOCK_KEYS = ["gain", "pan", "pitch", "reverse"] as const;

/** Which loops a note plays on: "" always, "A:B" on loop A of every B
 *  (1:2 = 1st, 3rd, 5th…), "first" only the first loop, "!first" all but. */
export const CONDITIONS = ["", "1:2", "2:2", "1:3", "2:3", "3:3", "1:4", "2:4", "3:4", "4:4", "first", "!first"] as const;
export type StepCond = (typeof CONDITIONS)[number];

export interface SeqNote {
  id: string;
  /** The pad (src/pads/pads.ts slot). */
  slot: number;
  /** 0 .. pattern.steps - 1. */
  step: number;
  vel: number;
  /** Timing offset, fraction of a step (-0.5 .. 0.5). */
  micro: number;
  /** Steps until a gate pad lets go. */
  len: number;
  /** 0..1. */
  prob: number;
  cond: StepCond;
  lock?: StepLock;
}

export interface Pattern {
  /** 0 .. PATTERNS - 1. */
  index: number;
  steps: number;
  /** 0..0.5 of a step: how late every other sixteenth lands. */
  swing: number;
  notes: SeqNote[];
}

let noteCounter = 0;
export const newNoteId = () => `note_${Date.now().toString(36)}_${(noteCounter++).toString(36)}`;

export function emptyPattern(index: number): Pattern {
  return { index, steps: 16, swing: 0, notes: [] };
}

export const patternAt = (patterns: readonly Pattern[] | undefined, index: number): Pattern => patterns?.find((p) => p.index === index) ?? emptyPattern(index);

/** Put a pattern in its place; empty patterns aren't stored. */
export function setPattern(patterns: readonly Pattern[] | undefined, p: Pattern): Pattern[] {
  const rest = (patterns ?? []).filter((x) => x.index !== p.index);
  const keep = p.notes.length > 0 || p.steps !== 16 || p.swing !== 0;
  return (keep ? [...rest, p] : rest).sort((a, b) => a.index - b.index);
}

export function noteAt(p: Pattern, slot: number, step: number): SeqNote | undefined {
  return p.notes.find((n) => n.slot === slot && n.step === step);
}

/** Tap a step: add a note there, or take it away. */
export function toggleStep(p: Pattern, slot: number, step: number, vel = DEFAULT_VEL): Pattern {
  const hit = noteAt(p, slot, step);
  if (hit) return { ...p, notes: p.notes.filter((n) => n !== hit) };
  return { ...p, notes: [...p.notes, { id: newNoteId(), slot, step, vel, micro: 0, len: 1, prob: 1, cond: "" }] };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

export function updateNote(p: Pattern, id: string, patch: Partial<Omit<SeqNote, "id">>): Pattern {
  return {
    ...p,
    notes: p.notes.map((n) => {
      if (n.id !== id) return n;
      const m = { ...n, ...patch };
      return { ...m, vel: clamp(m.vel, 0.05, 1), micro: clamp(m.micro, -0.5, 0.5), len: clamp(Math.round(m.len), 1, p.steps), prob: clamp(m.prob, 0, 1) };
    }),
  };
}

/** Lock (or unlock: undefined) one pad setting on one note. */
export function setLock<K extends keyof StepLock>(p: Pattern, id: string, key: K, value: StepLock[K] | undefined): Pattern {
  return {
    ...p,
    notes: p.notes.map((n) => {
      if (n.id !== id) return n;
      const lock: StepLock = { ...n.lock, [key]: value };
      if (value === undefined) delete lock[key];
      const { lock: _, ...rest } = n;
      return Object.keys(lock).length ? { ...rest, lock } : rest;
    }),
  };
}

/** Change the length; notes past the end go (they come back on undo). */
export function setSteps(p: Pattern, steps: number): Pattern {
  const s = STEP_CHOICES.includes(steps as (typeof STEP_CHOICES)[number]) ? steps : 16;
  return { ...p, steps: s, notes: p.notes.filter((n) => n.step < s).map((n) => ({ ...n, len: Math.min(n.len, s) })) };
}

/** Where a hit `pos` steps into the loop lands: the nearest step, keeping
 *  (1 - strength) of the offset as micro-timing. */
export function quantize(pos: number, steps: number, strength = 1): { step: number; micro: number } {
  const k = Math.round(pos);
  const micro = Math.round((pos - k) * (1 - clamp(strength, 0, 1)) * 1000) / 1000;
  return { step: ((k % steps) + steps) % steps, micro: micro || 0 };
}

/** A recorded hit: replaces a note already on that pad + step. */
export function recordHit(p: Pattern, slot: number, pos: number, vel: number, strength = 1): { pattern: Pattern; note: SeqNote } {
  const { step, micro } = quantize(pos, p.steps, strength);
  const note: SeqNote = { id: newNoteId(), slot, step, vel: clamp(vel, 0.05, 1), micro, len: 1, prob: 1, cond: "" };
  return { pattern: { ...p, notes: [...p.notes.filter((n) => !(n.slot === slot && n.step === step)), note] }, note };
}

/** Does a condition let the note play on loop `loop` (0 = the first)? */
export function condPasses(cond: StepCond, loop: number): boolean {
  if (cond === "") return true;
  if (cond === "first") return loop === 0;
  if (cond === "!first") return loop > 0;
  const [a, b] = cond.split(":").map(Number);
  return loop % b === a - 1;
}

/** Deterministic 0..1 for a note on a loop (so chance is repeatable). */
export function chance(id: string, loop: number): number {
  let h = 2166136261 ^ loop;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export function plays(n: SeqNote, loop: number): boolean {
  return condPasses(n.cond, loop) && (n.prob >= 1 || chance(n.id, loop) < n.prob);
}

/** Seconds from the loop's start to a note (swing moves odd steps late). */
export function noteOffset(p: Pattern, t: Tempo, step: number, micro = 0): number {
  const s = stepSeconds(t);
  return (step + micro + (step % 2 === 1 ? p.swing : 0)) * s;
}

export const loopSeconds = (p: Pattern, t: Tempo) => p.steps * stepSeconds(t);

export function normalizePatterns(raw: unknown): Pattern[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  let out: Pattern[] = [];
  for (const r of raw as Partial<Pattern>[]) {
    if (!r || !Number.isInteger(r.index) || r.index! < 0 || r.index! >= PATTERNS) continue;
    const steps = STEP_CHOICES.includes(r.steps as (typeof STEP_CHOICES)[number]) ? r.steps! : 16;
    const notes: SeqNote[] = [];
    for (const n of Array.isArray(r.notes) ? r.notes : []) {
      if (!n || !Number.isInteger(n.slot) || !Number.isInteger(n.step) || n.step < 0 || n.step >= steps) continue;
      const lock: StepLock = {};
      if (n.lock && typeof n.lock === "object") {
        if (Number.isFinite(n.lock.gain)) lock.gain = clamp(n.lock.gain!, 0, 1.5);
        if (Number.isFinite(n.lock.pan)) lock.pan = clamp(n.lock.pan!, -1, 1);
        if (Number.isFinite(n.lock.pitch)) lock.pitch = clamp(n.lock.pitch!, -24, 24);
        if (typeof n.lock.reverse === "boolean") lock.reverse = n.lock.reverse;
      }
      notes.push({
        id: typeof n.id === "string" ? n.id : newNoteId(),
        slot: n.slot,
        step: n.step,
        vel: clamp(Number(n.vel ?? DEFAULT_VEL), 0.05, 1),
        micro: clamp(Number(n.micro ?? 0), -0.5, 0.5),
        len: clamp(Math.round(Number(n.len ?? 1)), 1, steps),
        prob: clamp(Number(n.prob ?? 1), 0, 1),
        cond: CONDITIONS.includes(n.cond as StepCond) ? (n.cond as StepCond) : "",
        ...(Object.keys(lock).length ? { lock } : {}),
      });
    }
    out = setPattern(out, { index: r.index!, steps, swing: clamp(Number(r.swing ?? 0), 0, 0.5), notes });
  }
  return out.length ? out : undefined;
}
