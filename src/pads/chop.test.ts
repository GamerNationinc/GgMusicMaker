import { describe, expect, it } from "vitest";
import { addMarker, cleanMarkers, detectOnsets, equalMarkers, markersToSlices, nearestMarker, sliceAt } from "./chop";

const SR = 48000;

/** Silence with decaying noise hits at `at` seconds (amplitudes `amp`). */
function hits(seconds: number, at: number[], amp: number[] = at.map(() => 0.8)): Float32Array[] {
  const l = new Float32Array(seconds * SR);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  at.forEach((t, h) => {
    const s = Math.round(t * SR);
    for (let i = 0; i < 0.15 * SR && s + i < l.length; i++) l[s + i] += amp[h] * rnd() * Math.exp(-i / (0.03 * SR));
  });
  // A held low tone underneath: must not count as a hit.
  for (let i = 0; i < l.length; i++) l[i] += 0.2 * Math.sin((2 * Math.PI * 55 * i) / SR);
  return [l, l.slice()];
}

describe("markers and slices", () => {
  it("cleans, cuts and finds", () => {
    expect(cleanMarkers([0.5, 0.2, 0.2005, 0.001, 0.999, 2], 0, 1)).toEqual([0.2, 0.5]);
    expect(markersToSlices([0.5, 0.25], 0, 1)).toEqual([
      { start: 0, end: 0.25 },
      { start: 0.25, end: 0.5 },
      { start: 0.5, end: 1 },
    ]);
    expect(markersToSlices([], 2, 3)).toEqual([{ start: 2, end: 3 }]);
    const s = markersToSlices(equalMarkers(0, 2, 4), 0, 2);
    expect(s.map((x) => x.end)).toEqual([0.5, 1, 1.5, 2]);
    expect(sliceAt(s, 1.2)).toBe(2);
    expect(sliceAt(s, 9)).toBe(3);
    expect(addMarker([0.5], 0.5001, 0, 1)).toEqual([0.5]);
    expect(addMarker([0.5], 0.7, 0, 1)).toEqual([0.5, 0.7]);
    expect(nearestMarker([0.2, 0.5, 0.8], 0.52, 0.05)).toBe(1);
    expect(nearestMarker([0.2, 0.5, 0.8], 0.65, 0.05)).toBeNull();
  });
});

describe("detectOnsets", () => {
  it("finds the hits, not the held tone, a few ms early", () => {
    const at = [0.3, 0.75, 1.1, 1.6];
    const found = detectOnsets(hits(2, at), SR, 0, 2);
    expect(found.length).toBe(at.length);
    found.forEach((t, i) => {
      expect(t).toBeLessThanOrEqual(at[i] + 0.002);
      expect(t).toBeGreaterThan(at[i] - 0.012);
    });
  });

  it("sensitivity decides whether soft hits count", () => {
    const ch = hits(2, [0.3, 0.8, 1.4], [0.8, 0.05, 0.8]);
    const low = detectOnsets(ch, SR, 0, 2, 0);
    const high = detectOnsets(ch, SR, 0, 2, 1);
    expect(high.length).toBeGreaterThan(low.length);
    expect(high.length).toBe(3);
  });

  it("only looks inside the region, and silence has none", () => {
    const ch = hits(2, [0.3, 0.75, 1.1, 1.6]);
    expect(detectOnsets(ch, SR, 0.5, 1.3).length).toBe(2);
    expect(detectOnsets([new Float32Array(SR)], SR, 0, 1)).toEqual([]);
  });
});
