import { describe, expect, it } from "vitest";
import { TapTempo, barBeat, clampBpm, normalizeTempo, stepSeconds, DEFAULT_TEMPO } from "./tempo";
import {
  chance,
  condPasses,
  emptyPattern,
  normalizePatterns,
  noteOffset,
  plays,
  quantize,
  recordHit,
  setLock,
  setPattern,
  setSteps,
  toggleStep,
  updateNote,
  type Pattern,
} from "./pattern";
import { clicksBetween, eventsBetween, reanchor, stepAt } from "./schedule";

const T = { bpm: 120, beatsPerBar: 4 }; // a step = 0.125 s, a 16-step loop = 2 s

describe("tempo", () => {
  it("bars, beats, sixteenths; clamping; taps", () => {
    expect(stepSeconds(T)).toBe(0.125);
    expect(barBeat(T, 0)).toEqual({ bar: 1, beat: 1, sixteenth: 1 });
    expect(barBeat(T, 2.625)).toEqual({ bar: 2, beat: 2, sixteenth: 2 });
    expect(clampBpm(999)).toBe(240);
    expect(normalizeTempo({ bpm: 93.333, beatsPerBar: 99 })).toEqual({ bpm: 93.3, beatsPerBar: 4 });
    expect(normalizeTempo(null)).toBeUndefined();
    const tap = new TapTempo();
    expect(tap.tap(0)).toBeNull();
    expect(tap.tap(500)).toBe(120);
    expect(tap.tap(1000)).toBe(120);
    expect(tap.tap(5000)).toBeNull(); // a long pause starts over
    expect(tap.tap(5400)).toBe(150);
    expect(DEFAULT_TEMPO.bpm).toBe(120);
  });
});

describe("pattern editing", () => {
  it("toggles, edits, locks, shortens", () => {
    let p = toggleStep(emptyPattern(0), 3, 4);
    expect(p.notes).toHaveLength(1);
    const id = p.notes[0].id;
    p = updateNote(p, id, { vel: 9, micro: -2, len: 99, prob: 0.5 });
    expect(p.notes[0]).toMatchObject({ vel: 1, micro: -0.5, len: 16, prob: 0.5 });
    p = setLock(p, id, "pitch", 7);
    expect(p.notes[0].lock).toEqual({ pitch: 7 });
    p = setLock(p, id, "pitch", undefined);
    expect(p.notes[0].lock).toBeUndefined();
    p = toggleStep(toggleStep(p, 3, 20 % 16), 3, 4); // add one, remove the first
    expect(p.notes.map((n) => n.step)).toEqual([4]);
    p = setSteps({ ...p, notes: [...p.notes, { ...p.notes[0], id: "x", step: 30 }], steps: 32 }, 16);
    expect(p.notes.map((n) => n.step)).toEqual([4]);
  });

  it("empty patterns aren't stored", () => {
    const p = toggleStep(emptyPattern(2), 0, 0);
    let all = setPattern([], p);
    expect(all).toHaveLength(1);
    all = setPattern(all, toggleStep(p, 0, 0));
    expect(all).toHaveLength(0);
  });

  it("quantises hits, keeping some feel below full strength", () => {
    expect(quantize(3.4, 16)).toEqual({ step: 3, micro: 0 });
    expect(quantize(15.7, 16)).toEqual({ step: 0, micro: 0 }); // wraps to the next loop's first step
    expect(quantize(3.4, 16, 0.5)).toEqual({ step: 3, micro: 0.2 });
    const { pattern, note } = recordHit(toggleStep(emptyPattern(0), 1, 3), 1, 2.9, 0.7);
    expect(pattern.notes).toHaveLength(1); // replaced the note on that step
    expect(note).toMatchObject({ slot: 1, step: 3, vel: 0.7 });
  });

  it("conditions and chance", () => {
    expect([0, 1, 2, 3].map((l) => condPasses("1:2", l))).toEqual([true, false, true, false]);
    expect([0, 1, 2, 3].map((l) => condPasses("3:4", l))).toEqual([false, false, true, false]);
    expect([0, 1].map((l) => condPasses("first", l))).toEqual([true, false]);
    expect([0, 1].map((l) => condPasses("!first", l))).toEqual([false, true]);
    expect(chance("a", 3)).toBe(chance("a", 3));
    const n = { id: "n1", slot: 0, step: 0, vel: 1, micro: 0, len: 1, prob: 0.5, cond: "" as const };
    let hits = 0;
    for (let l = 0; l < 400; l++) if (plays(n, l)) hits++;
    expect(hits).toBeGreaterThan(160);
    expect(hits).toBeLessThan(240);
  });

  it("swing pushes odd steps late", () => {
    const p: Pattern = { ...emptyPattern(0), swing: 0.25 };
    expect(noteOffset(p, T, 2)).toBe(0.25);
    expect(noteOffset(p, T, 3)).toBeCloseTo(0.375 + 0.03125);
    expect(noteOffset(p, T, 4, -0.5)).toBeCloseTo(0.4375);
  });

  it("normalises patterns from a session", () => {
    const n = normalizePatterns([
      { index: 3, steps: 32, swing: 2, notes: [{ slot: 1, step: 31, vel: 3, cond: "bogus", lock: { pitch: 99, gain: "x" } }, { slot: 1, step: 40 }] },
      { index: 99 },
    ])!;
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ index: 3, steps: 32, swing: 0.5 });
    expect(n[0].notes).toHaveLength(1);
    expect(n[0].notes[0]).toMatchObject({ step: 31, vel: 1, cond: "", lock: { pitch: 24 } });
    expect(normalizePatterns("nope")).toBeUndefined();
  });
});

describe("schedule", () => {
  const p: Pattern = {
    index: 0,
    steps: 16,
    swing: 0,
    notes: [
      { id: "k", slot: 0, step: 0, vel: 1, micro: 0, len: 2, prob: 1, cond: "" },
      { id: "s", slot: 1, step: 4, vel: 0.5, micro: 0, len: 1, prob: 1, cond: "1:2", lock: { pitch: 12 } },
      { id: "e", slot: 2, step: 0, vel: 1, micro: -0.2, len: 1, prob: 1, cond: "" },
    ],
  };

  it("finds hits and releases in a window, across loop ends", () => {
    const ev = eventsBetween(p, T, 10, 10, 12.1);
    const ons = ev.filter((e) => !e.off).map((e) => [e.slot, e.at, e.loop]);
    // Loop 0 from t=10: kick at 10, snare (1:2 → loop 0) at 10.5; the early
    // hit at -0.2 step can't play before the start. Loop 1 begins at 12:
    // the early hit lands at 11.975, the kick at 12.
    expect(ons).toEqual([
      [0, 10, 0],
      [1, 10.5, 0],
      [2, 11.975, 1],
      [0, 12, 1],
    ]);
    const offs = ev.filter((e) => e.off).map((e) => [e.slot, e.at]);
    expect(offs).toEqual([
      [0, 10.25],
      [1, 10.625],
    ]);
    expect(ev.find((e) => e.slot === 1)!.lock).toEqual({ pitch: 12 });
  });

  it("windows add up to the whole, each event once", () => {
    const whole = eventsBetween(p, T, 0, 0, 8);
    let parts: typeof whole = [];
    for (let t = 0; t < 8; t += 0.025) parts = parts.concat(eventsBetween(p, T, 0, t, Math.min(8, t + 0.025)));
    expect(parts.map((e) => `${e.slot}${e.off}${e.at.toFixed(6)}`)).toEqual(whole.map((e) => `${e.slot}${e.off}${e.at.toFixed(6)}`));
    // The 1:2 snare plays on loops 0 and 2 only.
    expect(whole.filter((e) => e.slot === 1 && !e.off).map((e) => e.loop)).toEqual([0, 2]);
  });

  it("metronome, playhead step, tempo change keeps the place", () => {
    expect(clicksBetween(T, 1, 1, 3.1)).toEqual([
      { at: 1, accent: true },
      { at: 1.5, accent: false },
      { at: 2, accent: false },
      { at: 2.5, accent: false },
      { at: 3, accent: true },
    ]);
    expect(stepAt(p, T, 10, 9)).toBe(-1);
    expect(stepAt(p, T, 10, 10.13)).toBe(1);
    expect(stepAt(p, T, 10, 12.01)).toBe(0);
    // Halfway through a step at 120 → the same place at 60 BPM.
    const a = reanchor(0, 1.0625, 0.125, 0.25);
    expect((1.0625 - a) / 0.25).toBeCloseTo(8.5);
  });
});
