import { describe, it, expect } from "vitest";
import { CATEGORIES, RACKS, STACK_RECIPES, findRack, rackReferences, rackTrack } from "./racks";
import { SYNTH_PRESETS, synthIsActive } from "./voice-synth";
import { MORPH_PRESETS } from "./morph";
import { PUNCH_PRESETS, punchIsActive, clampPunchValue } from "./punch";
import type { Track } from "../audio/types";
import { DEFAULT_SYNTH } from "./voice-synth";
import { DEFAULT_MORPH } from "./morph";
import { DEFAULT_PUNCH } from "./punch";
import { BASS_PRESETS, DEFAULT_BASS, clampBassValue } from "./bass";
import { FX_ALL_ON } from "./chain";

const track: Track = {
  id: "t", name: "vox", gain: 0.3, muted: true, soloed: false, armed: false, reverbSend: 0.9, pan: 0.5, width: 2,
  reverbPan: 1, reverbWidth: 0, eq: { low: 9, mid: 9, high: 9, lowCut: 900, highCut: 900 },
  synth: { ...DEFAULT_SYNTH, mix: 1, vocoder: 1 }, morph: { ...DEFAULT_MORPH, mix: 1 }, punch: { ...DEFAULT_PUNCH, boom: 1 }, bass: { ...DEFAULT_BASS, widen: 1, bpm: 96 },
  fx: { ...FX_ALL_ON, eq: false }, stackId: "s", linked: true, role: "", color: "#fff", clips: [],
};

describe("instrument racks", () => {
  it("every category has racks and a stack recipe", () => {
    for (const c of CATEGORIES) {
      expect(RACKS.filter((r) => r.category === c).length, c).toBeGreaterThanOrEqual(4);
      expect(STACK_RECIPES.filter((r) => r.category === c).length, c).toBeGreaterThanOrEqual(1);
    }
  });

  it("names are unique and every preset a rack names exists", () => {
    expect(new Set(RACKS.map((r) => r.name)).size).toBe(RACKS.length);
    const lists = { synth: SYNTH_PRESETS, morph: MORPH_PRESETS, punch: PUNCH_PRESETS, bass: BASS_PRESETS };
    for (const r of RACKS) for (const ref of rackReferences(r)) expect(lists[ref.kind].some((p) => p.name === ref.name), `${r.name} → ${ref.name}`).toBe(true);
  });

  it("every recipe layer is a rack of that category, and recipes stack ≥ 2 layers", () => {
    for (const s of STACK_RECIPES) {
      expect(s.layers.length).toBeGreaterThanOrEqual(2);
      for (const l of s.layers) expect(findRack(l)?.category, `${s.name}: ${l}`).toBe(s.category);
    }
  });

  it("applying a rack resets the whole layer, then dials it in", () => {
    const t = rackTrack(track, findRack("Sub Boom")!);
    expect(t.eq).toEqual({ low: 0, mid: 0, high: 0, lowCut: 20, highCut: 150 });
    expect(t.synth).toEqual(DEFAULT_SYNTH);
    expect(t.morph).toEqual(DEFAULT_MORPH);
    expect(t.bass).toEqual({ ...DEFAULT_BASS, bpm: 96 });
    expect(punchIsActive(t.punch)).toBe(true);
    expect(t).toMatchObject({ gain: 0.8, pan: 0, width: 1, reverbSend: 0, role: "Sub Boom", stackId: "s", linked: true, muted: true });
    expect(t.fx.eq).toBe(true);
  });

  it("overrides land on top of the named preset", () => {
    const t = rackTrack(track, findRack("Octave Down")!);
    expect(t.synth.pitch).toBe(-12);
    expect(synthIsActive(t.synth)).toBe(true);
  });

  it("every rack's values are in range", () => {
    for (const r of RACKS) {
      const t = rackTrack(track, r);
      for (const [k, v] of Object.entries(t.punch)) expect(clampPunchValue(k as never, v), `${r.name}.${k}`).toBe(v);
      for (const [k, v] of Object.entries(t.bass)) expect(clampBassValue(k as never, v), `${r.name}.bass.${k}`).toBe(v);
      expect(t.gain).toBeLessThanOrEqual(1.5);
      expect(Math.abs(t.pan)).toBeLessThanOrEqual(1);
    }
  });
});
