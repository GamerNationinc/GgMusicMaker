import { describe, expect, it } from "vitest";
import { clearPad, firstEmpty, newPad, normalizePads, padAt, padLabel, padSpecs, setPad, slicesToPads, slotOf } from "./pads";

describe("pads", () => {
  it("labels slots by bank and pad", () => {
    expect(padLabel(0)).toBe("A1");
    expect(padLabel(slotOf(1, 15))).toBe("B16");
    expect(padLabel(159)).toBe("J16");
  });

  it("sets, replaces, clears and finds empty slots", () => {
    let pads = setPad([], newPad(3, "b1", 0, 1, "x"));
    pads = setPad(pads, newPad(1, "b1", 0, 1, "y"));
    pads = setPad(pads, { ...newPad(3, "b2", 0, 1, "z") });
    expect(pads.map((p) => [p.slot, p.name])).toEqual([[1, "y"], [3, "z"]]);
    expect(firstEmpty(pads, 0)).toBe(0);
    expect(firstEmpty(pads, 0, 1)).toBe(2);
    expect(padAt(clearPad(pads, 3), 3)).toBeUndefined();
    const full = Array.from({ length: 16 }, (_, i) => newPad(16 + i, "b", 0, 1, ""));
    expect(firstEmpty(full, 1)).toBeNull();
  });

  it("lays slices onto consecutive pads, spilling into the next bank", () => {
    const slices = [0, 1, 2].map((i) => ({ start: i, end: i + 1 }));
    const pads = slicesToPads([newPad(14, "old", 0, 1, "old")], "buf", slices, 14, "chop", { mode: "gate" });
    expect(pads.map((p) => [padLabel(p.slot), p.name, p.start, p.mode])).toEqual([
      ["A15", "chop 1", 0, "gate"],
      ["A16", "chop 2", 1, "gate"],
      ["B1", "chop 3", 2, "gate"],
    ]);
    expect(slicesToPads([], "b", slices, 159, "c").length).toBe(1);
  });

  it("normalises pads from a session, dropping broken ones", () => {
    const pads = normalizePads([
      { slot: 2, bufferId: "b", start: 0, end: 1, mode: "weird", gain: 9, choke: 2.4, pitch: -99 },
      { slot: 200, bufferId: "b", start: 0, end: 1 },
      { slot: 1, bufferId: "b", start: 1, end: 1 },
      null,
    ]);
    expect(pads.length).toBe(1);
    expect(pads[0]).toMatchObject({ slot: 2, mode: "oneshot", gain: 1.5, choke: 2, pitch: -24, mono: true });
    expect(normalizePads(undefined)).toEqual([]);
  });

  it("specs carry what the native sampler reads", () => {
    expect(padSpecs([newPad(5, "b", 0.1, 0.2, "n")])[0]).toEqual({
      slot: 5, buffer: "b", start: 0.1, end: 0.2, mode: "oneshot", reverse: false, gain: 1, pan: 0, pitch: 0, attack: 0, release: 0.05, choke: 0, mono: true,
    });
  });
});
