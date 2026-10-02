import { describe, it, expect } from "vitest";
import { LIVE_BUCKET, LivePeaks } from "./liveTake";

describe("live take waveform", () => {
  it("summarises min / max per bucket over all channels, across block edges", () => {
    const p = new LivePeaks(48000);
    const n = LIVE_BUCKET * 3;
    const l = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 10) * (i < LIVE_BUCKET ? 0.1 : 0.8));
    const r = l.map((v) => -v * 0.5);
    for (let i = 0; i < n; i += 100) p.feedPlanar([l.subarray(i, i + 100), r.subarray(i, i + 100)]);
    expect(p.pairs).toBe(3);
    expect(p.frames).toBe(n);
    expect(p.data[1]).toBeLessThanOrEqual(0.1 + 1e-6); // quiet first bucket
    expect(p.data[3]).toBeGreaterThan(0.7);
    const all = p.range(0, n / 48000)!;
    expect(all[0]).toBeLessThan(-0.7);
    expect(all[1]).toBeGreaterThan(0.7);
    expect(p.range(1, 2)).toBeNull();
  });

  it("grows without limit and takes the native engine's pairs", () => {
    const p = new LivePeaks(48000);
    const big = new Float32Array(20000).map((_, i) => (i % 2 ? 0.5 : -0.5));
    p.appendPairs(big, 10000 * LIVE_BUCKET);
    expect(p.pairs).toBe(10000);
    expect(p.seconds).toBeCloseTo((10000 * LIVE_BUCKET) / 48000);
    expect(p.range(0, p.seconds)).toEqual([-0.5, 0.5]);
  });
});
