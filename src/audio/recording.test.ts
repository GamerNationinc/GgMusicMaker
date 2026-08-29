import { describe, it, expect } from "vitest";
import { assembleTake } from "./recording";

const chunk = (...chans: number[][]) => chans.map((c) => new Float32Array(c));

describe("assembleTake", () => {
  it("concatenates chunks in order, per channel", () => {
    const take = assembleTake([
      chunk([1, 2], [-1, -2]),
      chunk([3, 4], [-3, -4]),
    ]);
    expect(take.frames).toBe(4);
    expect(take.channels).toHaveLength(2);
    expect(Array.from(take.channels[0])).toEqual([1, 2, 3, 4]);
    expect(Array.from(take.channels[1])).toEqual([-1, -2, -3, -4]);
  });

  it("returns an empty take when nothing was captured", () => {
    const take = assembleTake([]);
    expect(take.frames).toBe(0);
    expect(take.channels[0].length).toBe(0);
  });

  it("ignores empty chunks rather than corrupting the timeline", () => {
    const take = assembleTake([chunk([1, 2]), chunk([]), chunk([3])]);
    expect(take.frames).toBe(3);
    expect(Array.from(take.channels[0])).toEqual([1, 2, 3]);
  });

  it("widens to the largest channel count, filling short chunks from channel 0", () => {
    // A device that reports mono for one block then stereo for the next.
    const take = assembleTake([chunk([1, 1]), chunk([2, 2], [9, 9])]);
    expect(take.channels).toHaveLength(2);
    expect(Array.from(take.channels[0])).toEqual([1, 1, 2, 2]);
    // First (mono) block is duplicated into channel 1, not left silent.
    expect(Array.from(take.channels[1])).toEqual([1, 1, 9, 9]);
  });

  it("produces channels that are all the same length", () => {
    const take = assembleTake([chunk([1], [2]), chunk([3], [4]), chunk([5], [6])]);
    const lengths = new Set(take.channels.map((c) => c.length));
    expect(lengths.size).toBe(1);
    expect(take.frames).toBe(3);
  });
});
