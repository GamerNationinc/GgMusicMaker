import { describe, it, expect } from "vitest";
import { applyOffset, calibrationClicks, findLag, trimBefore } from "./record-align";

const SR = 48000;

/** `ref` as a mic would hear it: `late` samples behind, placed at `start`. */
function recording(ref: Float32Array, start: number, late: number, gain = 0.3, noise = 0): Float32Array {
  const rec = new Float32Array(ref.length);
  let seed = 1;
  for (let i = 0; i < rec.length; i++) {
    const j = start + i - late;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rec[i] = (j >= 0 && j < ref.length ? ref[j] * gain : 0) + noise * (seed / 0x7fffffff - 0.5);
  }
  return rec;
}

describe("record-align", () => {
  const clicks = calibrationClicks(SR);

  it("clicks are sparse, uneven and fit in the length", () => {
    const onsets: number[] = [];
    for (let i = 1; i < clicks.length; i++) if (clicks[i] !== 0 && clicks[i - 1] === 0) onsets.push(i);
    expect(onsets.length).toBeGreaterThan(5);
    const gaps = new Set(onsets.slice(1).map((o, k) => o - onsets[k]));
    expect(gaps.size).toBeGreaterThan(3);
  });

  it("finds a round-trip latency to the sample, through noise", () => {
    const rec = recording(clicks, 0, 1793, 0.2, 0.02);
    const { lag, confidence } = findLag(rec, clicks, 0, -480, 24000);
    expect(lag).toBe(1793);
    expect(confidence).toBeGreaterThan(0.5);
  });

  it("accounts for where the take was placed", () => {
    const rec = recording(clicks, 4800, 900);
    expect(findLag(rec, clicks, 4800, -480, 24000).lag).toBe(900);
  });

  it("silence has no confidence", () => {
    expect(findLag(new Float32Array(clicks.length), clicks, 0, 0, 2000).confidence).toBe(0);
  });

  it("applyOffset moves a take earlier, trimming what falls before 0", () => {
    const ch = [Float32Array.from([1, 2, 3, 4, 5])];
    expect(applyOffset(ch, 1.0, 0.25, 4).start).toBeCloseTo(0.75);
    const cut = applyOffset(ch, 0.25, 0.75, 4); // 0.5 s = 2 samples before 0
    expect(cut.start).toBe(0);
    expect([...cut.channels[0]]).toEqual([3, 4, 5]);
  });

  it("trimBefore drops a count-in: the take starts where Record was pressed", () => {
    const ch = [Float32Array.from([1, 2, 3, 4, 5]), Float32Array.from([6, 7, 8, 9, 10])];
    const t = trimBefore(ch, 1.0, 1.5, 4); // 0.5 s = 2 samples of count-in
    expect(t.start).toBe(1.5);
    expect([...t.channels[0]]).toEqual([3, 4, 5]);
    expect([...t.channels[1]]).toEqual([8, 9, 10]);
    expect(trimBefore(ch, 2, 1.5, 4).channels).toBe(ch); // started after: untouched
  });
});
