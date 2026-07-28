import { describe, it, expect } from "vitest";
import {
  VOICE_PRESETS,
  VOICE_PRESET_ORDER,
  pitchMixFor,
  ringDepthFor,
} from "./voice";

describe("voice presets", () => {
  it("covers every preset in the order list", () => {
    for (const p of VOICE_PRESET_ORDER) {
      expect(VOICE_PRESETS[p]).toBeDefined();
      expect(VOICE_PRESETS[p].label.length).toBeGreaterThan(0);
    }
  });

  it("off is a clean passthrough", () => {
    expect(VOICE_PRESETS.off.pitch).toBe(1);
    expect(VOICE_PRESETS.off.ringHz).toBe(0);
  });

  it("chipmunk shifts up, deep shifts down", () => {
    expect(VOICE_PRESETS.chipmunk.pitch).toBeGreaterThan(1);
    expect(VOICE_PRESETS.deep.pitch).toBeLessThan(1);
  });

  it("robot rings without pitch shift", () => {
    expect(VOICE_PRESETS.robot.pitch).toBe(1);
    expect(VOICE_PRESETS.robot.ringHz).toBeGreaterThan(0);
  });
});

describe("pitchMixFor", () => {
  it("keeps unity-pitch presets fully dry regardless of the user mix", () => {
    expect(pitchMixFor("off", 1)).toBe(0);
    expect(pitchMixFor("robot", 1)).toBe(0);
  });

  it("passes the user mix through for pitched presets", () => {
    expect(pitchMixFor("chipmunk", 0.8)).toBe(0.8);
    expect(pitchMixFor("deep", 0.5)).toBe(0.5);
  });
});

describe("ringDepthFor", () => {
  it("is 1 only for ring-mod presets", () => {
    expect(ringDepthFor("robot")).toBe(1);
    expect(ringDepthFor("alien")).toBe(1);
    expect(ringDepthFor("off")).toBe(0);
    expect(ringDepthFor("chipmunk")).toBe(0);
  });
});
