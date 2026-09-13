import { describe, it, expect } from "vitest";
import { toDb, blockLevels, logBands, ballistics } from "./spectrum";

describe("toDb", () => {
  it("maps full scale to 0 dB and halves to about -6 dB", () => {
    expect(toDb(1)).toBeCloseTo(0, 5);
    expect(toDb(0.5)).toBeCloseTo(-6.02, 1);
  });
  it("clamps silence to the floor", () => {
    expect(toDb(0)).toBe(-60);
    expect(toDb(1e-9, -40)).toBe(-40);
  });
  it("goes above 0 dB for a hot signal", () => {
    expect(toDb(2)).toBeCloseTo(6.02, 1);
  });
});

describe("blockLevels", () => {
  it("returns peak and RMS", () => {
    const { peak, rms } = blockLevels([0.5, -1, 0.5, -0.5]);
    expect(peak).toBe(1);
    expect(rms).toBeCloseTo(Math.sqrt((0.25 + 1 + 0.25 + 0.25) / 4), 6);
  });
  it("handles empty input", () => {
    expect(blockLevels([])).toEqual({ peak: 0, rms: 0 });
  });
});

describe("logBands", () => {
  const sampleRate = 48000;
  const bins = new Uint8Array(512); // 46.875 Hz per bin

  it("puts a low tone in the first band and a high tone in the last", () => {
    bins.fill(0);
    bins[1] = 255; // ~47 Hz
    bins[300] = 128; // ~14 kHz
    const out = logBands(bins, sampleRate, new Float32Array(16));
    expect(out[0]).toBe(1);
    expect(out[15]).toBeCloseTo(128 / 255, 6);
    // The ~47 Hz bin is wider than the lowest bands, so it may light bands
    // 0-2; everything between there and the top band must stay dark.
    expect(out.slice(3, 15).every((v) => v === 0)).toBe(true);
  });

  it("covers every band even when bands are narrower than a bin", () => {
    bins.fill(100);
    const out = logBands(bins, sampleRate, new Float32Array(32));
    expect(Array.from(out).every((v) => v > 0.39 && v < 0.4)).toBe(true);
  });
});

describe("ballistics", () => {
  it("rises faster than it falls", () => {
    const up = ballistics(0, 1);
    const down = ballistics(1, 0);
    expect(up).toBeGreaterThan(1 - down);
  });
  it("converges", () => {
    let v = 0;
    for (let i = 0; i < 50; i++) v = ballistics(v, 1);
    expect(v).toBeCloseTo(1, 3);
  });
});
