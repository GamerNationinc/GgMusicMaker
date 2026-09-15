import { describe, it, expect } from "vitest";
import type { Track } from "../audio/types";
import { DEFAULT_SYNTH, SYNTH_PRESETS, presetParams } from "./voice-synth";
import { FX_ALL_ON, anyFxLit, normalizeFx, panText, slotEngaged, slotLit, slotSummary, widthText } from "./chain";

const base = (over: Partial<Track> = {}): Track => ({
  id: "t",
  name: "t",
  gain: 1,
  muted: false,
  soloed: false,
  armed: false,
  reverbSend: 0,
  pan: 0,
  width: 1,
  reverbPan: 0,
  reverbWidth: 1,
  eq: { low: 0, mid: 0, high: 0 },
  synth: { ...DEFAULT_SYNTH },
  fx: { ...FX_ALL_ON },
  color: "#fff",
  clips: [],
  ...over,
});

describe("fx chain strip", () => {
  it("a fresh layer has nothing engaged and every summary reads neutral", () => {
    const t = base();
    for (const s of ["place", "eq", "synth", "reverb"] as const) {
      expect(slotEngaged(t, s)).toBe(false);
      expect(slotLit(t, s)).toBe(false);
    }
    expect(slotSummary(t, "place", "hall")).toBe("C · 100%");
    expect(slotSummary(t, "eq", "hall")).toBe("0 / 0 / 0 dB");
    expect(slotSummary(t, "synth", "hall")).toBe("off");
    expect(slotSummary(t, "reverb", "hall")).toBe("no send");
    expect(anyFxLit(t)).toBe(false);
  });

  it("summaries follow the settings", () => {
    const choir = SYNTH_PRESETS.find((p) => p.name === "Choir")!;
    const t = base({
      pan: -0.4,
      width: 1.2,
      eq: { low: 2, mid: 0, high: -3.5 },
      synth: presetParams(choir),
      reverbSend: 0.3,
    });
    expect(slotSummary(t, "place", "hall")).toBe("L 40 · 120%");
    expect(slotSummary(t, "eq", "hall")).toBe("+2 / 0 / -3.5 dB");
    expect(slotSummary(t, "synth", "hall")).toBe("Choir · 70%");
    expect(slotSummary(t, "reverb", "plate")).toBe("plate · 30%");
    expect(slotSummary({ ...t, synth: { ...t.synth, detune: 99 } }, "synth", "hall")).toBe("custom · 70%");
    expect(anyFxLit(t)).toBe(true);
  });

  it("the lamp needs the module on *and* engaged", () => {
    const t = base({ eq: { low: 6, mid: 0, high: 0 } });
    expect(slotLit(t, "eq")).toBe(true);
    expect(slotLit({ ...t, fx: { ...t.fx, eq: false } }, "eq")).toBe(false);
    expect(slotEngaged({ ...t, fx: { ...t.fx, eq: false } }, "eq")).toBe(true); // still set, just bypassed
  });

  it("readouts", () => {
    expect(panText(0)).toBe("C");
    expect(panText(-1)).toBe("L 100");
    expect(panText(0.33)).toBe("R 33");
    expect(widthText(1.5)).toBe("150%");
  });

  it("normalizeFx defaults missing switches to on and ignores junk", () => {
    expect(normalizeFx(undefined)).toEqual(FX_ALL_ON);
    expect(normalizeFx({ eq: false, synth: "yes" })).toEqual({ place: true, eq: false, synth: true, reverb: true });
  });
});
