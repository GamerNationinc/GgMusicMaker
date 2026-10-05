import { describe, it, expect } from "vitest";
import {
  DEFAULT_TEMPO,
  barsBeats,
  clampBpm,
  foldOffset,
  followSongTempo,
  formatBarsBeats,
  gridBeats,
  gridLines,
  normalizeTempo,
  snapTime,
  type Tempo,
} from "./tempo";

const t120: Tempo = { bpm: 120, beatsPerBar: 4, offset: 0 }; // beat 0.5 s, bar 2 s

describe("tempo", () => {
  it("clamps and rounds the BPM", () => {
    expect(clampBpm(10)).toBe(40);
    expect(clampBpm(999)).toBe(240);
    expect(clampBpm(92.456)).toBe(92.46);
    expect(clampBpm(Number.NaN)).toBe(120);
  });

  it("folds the downbeat offset into one bar", () => {
    expect(foldOffset(2.25, t120)).toBeCloseTo(0.25);
    expect(foldOffset(-0.5, t120)).toBeCloseTo(1.5);
    expect(foldOffset(4, t120)).toBe(0);
  });

  it("normalizes anything into a valid tempo, falling back to a given BPM", () => {
    expect(normalizeTempo(undefined)).toEqual(DEFAULT_TEMPO);
    expect(normalizeTempo(undefined, 87)).toEqual({ bpm: 87, beatsPerBar: 4, offset: 0 });
    expect(normalizeTempo({ bpm: 90, beatsPerBar: 11, offset: 9 })).toEqual({ bpm: 90, beatsPerBar: 4, offset: 9 % (8 / 3) });
    expect(normalizeTempo({ bpm: "fast", beatsPerBar: 3 })).toEqual({ bpm: 120, beatsPerBar: 3, offset: 0 });
  });

  it("picks the finest grid that stays readable, coarser as you zoom out", () => {
    expect(gridBeats(t120, 400)).toBe(0.25); // 16ths are 50 px apart
    expect(gridBeats(t120, 40)).toBe(1); // a beat is 20 px
    expect(gridBeats(t120, 10)).toBe(4); // a bar is 20 px
    expect(gridBeats(t120, 2)).toBe(16); // a bar is 4 px: every 4th bar
    expect(gridBeats({ ...t120, beatsPerBar: 3 }, 10)).toBe(3); // a 3/4 bar is 15 px
  });

  it("snaps to the grid, counted from bar 1", () => {
    expect(snapTime(1.3, t120, 1)).toBe(1.5);
    expect(snapTime(1.2, t120, 1)).toBe(1);
    const shifted = { ...t120, offset: 0.2 };
    expect(snapTime(1.3, shifted, 1)).toBeCloseTo(1.2);
    expect(snapTime(0.05, shifted, 4)).toBeCloseTo(0.2); // never before 0
  });

  it("lists grid lines with bars, beats and sub-beats marked", () => {
    const lines = gridLines(t120, 0.5, 0, 2.5);
    expect(lines.map((l) => l.time)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25]);
    expect(lines.map((l) => l.kind)).toEqual(["bar", "sub", "beat", "sub", "beat", "sub", "beat", "sub", "bar", "sub"]);
    expect(lines[8].bar).toBe(1);
    // With bar 1 late, the pickup before it is bar −1 and nothing before 0 is drawn.
    const late = gridLines({ ...t120, offset: 1 }, 1, 0, 1.6);
    expect(late.map((l) => [l.time, l.bar, l.kind])).toEqual([[0, -1, "beat"], [0.5, -1, "beat"], [1, 0, "bar"], [1.5, 0, "beat"]]);
  });

  it("reads out bar.beat.16th like Ableton", () => {
    expect(formatBarsBeats(0, t120)).toBe("1.1.1");
    expect(formatBarsBeats(2.75, t120)).toBe("2.2.3");
    expect(barsBeats(0.5, { ...t120, offset: 1 })).toEqual({ bar: 0, beat: 4, sixteenth: 1 });
  });

  it("keeps every layer's BASS MOD at the song BPM", () => {
    const p = { tempo: { ...t120, bpm: 92 }, tracks: [{ bass: { bpm: 140 } }, { bass: { bpm: 92 } }] };
    const q = followSongTempo(p);
    expect(q.tracks.map((t) => t.bass.bpm)).toEqual([92, 92]);
    expect(q.tracks[1]).toBe(p.tracks[1]);
    expect(followSongTempo(q)).toBe(q);
  });
});
