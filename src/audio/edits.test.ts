import { describe, it, expect, beforeEach } from "vitest";
import {
  splitClip,
  trimClip,
  moveClip,
  clipEnd,
  projectDuration,
  isTrackAudible,
  anySoloed,
  replaceClip,
} from "./edits";
import { __resetIds } from "./types";
import type { Clip, Project, Track } from "./types";

function makeClip(over: Partial<Clip> = {}): Clip {
  return {
    id: "clip_a",
    bufferId: "buf1",
    startTime: 2,
    offset: 0.5,
    duration: 4,
    name: "clip",
    ...over,
  };
}

beforeEach(() => __resetIds());

describe("splitClip", () => {
  it("splits into two clips covering the same audio", () => {
    const clip = makeClip(); // timeline [2, 6), offset 0.5
    const [left, right] = splitClip(clip, 4);
    expect(left.startTime).toBe(2);
    expect(left.duration).toBe(2);
    expect(left.offset).toBe(0.5);

    expect(right.startTime).toBe(4);
    expect(right.duration).toBe(2);
    // offset advances by the left half's length so audio is continuous
    expect(right.offset).toBeCloseTo(2.5);
    // total duration preserved
    expect(left.duration + right.duration).toBeCloseTo(clip.duration);
    // right gets a fresh id
    expect(right.id).not.toBe(left.id);
  });

  it("does not split on the edges or outside", () => {
    const clip = makeClip();
    expect(splitClip(clip, 2)).toHaveLength(1);
    expect(splitClip(clip, 6)).toHaveLength(1);
    expect(splitClip(clip, 99)).toHaveLength(1);
  });

  it("does not mutate the input", () => {
    const clip = makeClip();
    const snapshot = { ...clip };
    splitClip(clip, 4);
    expect(clip).toEqual(snapshot);
  });
});

describe("trimClip", () => {
  it("trims the right edge", () => {
    const clip = makeClip(); // [2,6)
    const t = trimClip(clip, 2, 5);
    expect(t.startTime).toBe(2);
    expect(t.duration).toBeCloseTo(3);
    expect(t.offset).toBe(0.5);
  });

  it("trims the left edge and advances the offset", () => {
    const clip = makeClip(); // start 2, offset 0.5
    const t = trimClip(clip, 3, 6);
    expect(t.startTime).toBe(3);
    expect(t.offset).toBeCloseTo(1.5); // +1s into the source
    expect(t.duration).toBeCloseTo(3);
  });

  it("clamps the offset so it never reads before the buffer start", () => {
    const clip = makeClip({ offset: 0.2 });
    const t = trimClip(clip, 1, 6); // would push offset negative
    expect(t.offset).toBe(0);
    expect(t.startTime).toBeGreaterThanOrEqual(clip.startTime - 0.2 - 1e-9);
  });

  it("enforces a minimum length", () => {
    const clip = makeClip();
    const t = trimClip(clip, 4, 4);
    expect(t.duration).toBeGreaterThan(0);
  });
});

describe("moveClip", () => {
  it("moves and clamps to zero", () => {
    expect(moveClip(makeClip(), 5).startTime).toBe(5);
    expect(moveClip(makeClip(), -3).startTime).toBe(0);
  });
});

describe("clipEnd + projectDuration", () => {
  it("computes clip end", () => {
    expect(clipEnd(makeClip())).toBe(6);
  });

  it("computes project duration as the furthest clip end", () => {
    const project: Project = {
      sampleRate: 48000,
      tracks: [
        { clips: [makeClip({ startTime: 0, duration: 3 })] } as Track,
        { clips: [makeClip({ startTime: 5, duration: 4 })] } as Track,
      ],
    };
    expect(projectDuration(project)).toBe(9);
  });

  it("is zero for an empty project", () => {
    expect(projectDuration({ sampleRate: 48000, tracks: [] })).toBe(0);
  });
});

describe("solo / mute audibility", () => {
  const base = (over: Partial<Track>): Track => ({
    id: "t",
    name: "t",
    gain: 1,
    muted: false,
    soloed: false,
    armed: false,
    reverbSend: 0,
    color: "#fff",
    clips: [],
    ...over,
  });

  it("muted tracks are never audible", () => {
    expect(isTrackAudible(base({ muted: true }), false)).toBe(false);
    expect(isTrackAudible(base({ muted: true, soloed: true }), true)).toBe(false);
  });

  it("with a solo active only soloed tracks play", () => {
    expect(isTrackAudible(base({ soloed: true }), true)).toBe(true);
    expect(isTrackAudible(base({ soloed: false }), true)).toBe(false);
  });

  it("with no solo active, unmuted tracks play", () => {
    expect(isTrackAudible(base({}), false)).toBe(true);
  });

  it("anySoloed detects solo state", () => {
    const p: Project = {
      sampleRate: 48000,
      tracks: [base({}), base({ soloed: true })],
    };
    expect(anySoloed(p)).toBe(true);
    expect(anySoloed({ sampleRate: 48000, tracks: [base({})] })).toBe(false);
  });
});

describe("replaceClip", () => {
  it("replaces one clip with several, preserving order", () => {
    const clips = [makeClip({ id: "a" }), makeClip({ id: "b" }), makeClip({ id: "c" })];
    const result = replaceClip(clips, "b", [
      makeClip({ id: "b1" }),
      makeClip({ id: "b2" }),
    ]);
    expect(result.map((c) => c.id)).toEqual(["a", "b1", "b2", "c"]);
  });
});
