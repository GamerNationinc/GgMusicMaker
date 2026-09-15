import { describe, it, expect } from "vitest";
import { frameUtilisation, ema, audioDropout, loadBand } from "./load";

describe("frameUtilisation", () => {
  it("is busy over interval, clamped to 1", () => {
    expect(frameUtilisation(4, 16)).toBeCloseTo(0.25);
    expect(frameUtilisation(40, 16)).toBe(1);
  });
  it("is 0 for nonsense input", () => {
    expect(frameUtilisation(-1, 16)).toBe(0);
    expect(frameUtilisation(5, 0)).toBe(0);
    expect(frameUtilisation(NaN, 16)).toBe(0);
  });
});

describe("ema", () => {
  it("moves toward the sample by alpha", () => {
    expect(ema(0, 1, 0.5)).toBe(0.5);
    expect(ema(0.5, 1, 0.5)).toBe(0.75);
    expect(ema(1, 1, 0.1)).toBe(1);
  });
});

describe("audioDropout", () => {
  it("passes when the audio clock keeps up", () => {
    expect(audioDropout(1.0, 1.0)).toBe(false);
    expect(audioDropout(0.99, 1.0)).toBe(false); // within tolerance
  });
  it("flags a clock that fell behind", () => {
    expect(audioDropout(0.9, 1.0)).toBe(true);
    expect(audioDropout(0, 1.0)).toBe(true);
  });
  it("ignores intervals too short to judge", () => {
    expect(audioDropout(0, 0.1)).toBe(false);
  });
});

describe("loadBand", () => {
  it("maps load to the three colour bands", () => {
    expect(loadBand(0.1)).toBe("ok");
    expect(loadBand(0.6)).toBe("warn");
    expect(loadBand(0.9)).toBe("hot");
  });
});
