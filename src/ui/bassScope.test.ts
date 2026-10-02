import { describe, it, expect } from "vitest";
import { lfoAt, lfoPath, tapTempo } from "./bassScope";

describe("BASS MOD scope helpers", () => {
  it("every shape stays in −1..1 and the path has every point", () => {
    for (let s = 0; s < 5; s++) for (let i = 0; i <= 20; i++) expect(Math.abs(lfoAt(s, i / 20))).toBeLessThanOrEqual(1);
    expect(lfoPath(0, 120, 32, 10).split(" ")).toHaveLength(11);
    expect(lfoAt(0, 0)).toBe(1); // sine starts open, on the beat
  });

  it("tap tempo averages the gaps and forgets stale taps", () => {
    let r = tapTempo([], 0);
    expect(r.bpm).toBeNull();
    r = tapTempo(r.taps, 500);
    r = tapTempo(r.taps, 1000);
    expect(r.bpm).toBe(120);
    r = tapTempo(r.taps, 10000); // a long pause starts over
    expect(r.bpm).toBeNull();
  });
});
