// The sequencer's clock, pure: which pad hits (and gate releases) fall in a
// window of engine time, for a pattern looping from `anchor`. The driver in
// the store asks for the next ~120 ms every 25 ms and hands the hits to the
// engine time-stamped, so playback timing never depends on the page's
// timers — only on the audio clock (native/src/mixer.rs, src/audio/sampler.ts).

import { stepSeconds, beatSeconds, type Tempo } from "./tempo";
import { loopSeconds, noteOffset, plays, type Pattern, type StepLock } from "./pattern";

export interface SeqEvent {
  /** Engine time, seconds. */
  at: number;
  slot: number;
  /** A hit (with velocity) or a gate release. */
  off: boolean;
  vel: number;
  lock?: StepLock;
  noteId: string;
  loop: number;
}

/** Hits and releases with `from <= at < to`, in time order (a release
 *  before a hit at the same moment). */
export function eventsBetween(p: Pattern, t: Tempo, anchor: number, from: number, to: number): SeqEvent[] {
  const loopDur = loopSeconds(p, t);
  const s = stepSeconds(t);
  if (!(loopDur > 0) || to <= from) return [];
  // A hit can land up to a step late (micro + swing); a release up to a
  // whole pattern after its hit.
  const first = Math.max(0, Math.floor((from - anchor) / loopDur) - 2);
  const last = Math.floor((to - anchor) / loopDur) + 1;
  const out: SeqEvent[] = [];
  for (let loop = first; loop <= last; loop++) {
    const base = anchor + loop * loopDur;
    for (const n of p.notes) {
      if (n.step >= p.steps || !plays(n, loop)) continue;
      const on = base + noteOffset(p, t, n.step, n.micro);
      if (on < anchor) continue;
      if (on >= from && on < to) out.push({ at: on, slot: n.slot, off: false, vel: n.vel, lock: n.lock, noteId: n.id, loop });
      const off = on + n.len * s;
      if (off >= from && off < to) out.push({ at: off, slot: n.slot, off: true, vel: 0, noteId: n.id, loop });
    }
  }
  return out.sort((a, b) => a.at - b.at || Number(b.off) - Number(a.off));
}

/** Metronome clicks in the window: every beat from `anchor`, accented on the bar. */
export function clicksBetween(t: Tempo, anchor: number, from: number, to: number): { at: number; accent: boolean }[] {
  const b = beatSeconds(t);
  const out: { at: number; accent: boolean }[] = [];
  for (let k = Math.max(0, Math.ceil((from - anchor) / b - 1e-9)); anchor + k * b < to; k++) {
    out.push({ at: anchor + k * b, accent: k % t.beatsPerBar === 0 });
  }
  return out;
}

/** Steps since the anchor (fractional), or -1 before it. */
export function stepsSince(t: Tempo, anchor: number, now: number): number {
  return now < anchor ? -1 : (now - anchor) / stepSeconds(t);
}

/** The step playing now (0 .. steps-1), or -1 before the start. */
export function stepAt(p: Pattern, t: Tempo, anchor: number, now: number): number {
  const k = stepsSince(t, anchor, now);
  return k < 0 ? -1 : Math.floor(k + 1e-9) % p.steps;
}

/** Keep the place in the pattern when the tempo changes mid-play. */
export function reanchor(anchor: number, now: number, oldStep: number, newStep: number): number {
  if (now <= anchor) return anchor;
  return now - ((now - anchor) / oldStep) * newStep;
}
