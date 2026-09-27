import { describe, it, expect } from "vitest";
import { audibleStems, rms, stemLayerName, stemSummary } from "./stems";

describe("stems", () => {
  it("rms covers every channel", () => {
    expect(rms([new Float32Array([1, -1]), new Float32Array([0, 0])])).toBeCloseTo(Math.SQRT1_2);
    expect(rms([])).toBe(0);
  });

  it("keeps audible stems in layer order and drops bleed", () => {
    const levels = [
      { name: "drums", rms: 0.09 },
      { name: "bass", rms: 0.0001 },
      { name: "other", rms: 0.14 },
      { name: "vocals", rms: 0.05 },
      { name: "guitar", rms: 0.002 },
      { name: "piano", rms: 0.0001 },
    ];
    // mix 0.17 → floor 0.0017 (-40 dB): guitar at -38.6 dB stays.
    expect(audibleStems(levels, 0.17)).toEqual({ keep: ["vocals", "drums", "guitar", "other"], dropped: ["bass", "piano"] });
  });

  it("names layers after the source", () => {
    expect(stemLayerName("Fat Guy", "vocals")).toBe("Fat Guy · Vocals");
    expect(stemLayerName("x", "kazoo")).toBe("x · kazoo");
  });

  it("summarises what happened", () => {
    expect(stemSummary("Song", ["vocals", "drums"], ["piano"])).toBe(
      "Song → 2 stems: vocals, drums. No piano found (silent, skipped). The original layer is muted.",
    );
  });
});
