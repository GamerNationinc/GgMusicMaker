import { describe, expect, it } from "vitest";
import { nextLayerName, songTimeAt, soundSpan, trimGrab, type SkipGrab } from "./skipback";

const sr = 1000;
function grab(samples: number[], songTime: number | null = null): SkipGrab {
  const l = Float32Array.from(samples);
  return { sampleRate: sr, channels: [l, l.map((v) => -v)], songTime };
}

describe("soundSpan", () => {
  it("is null for silence", () => {
    expect(soundSpan([new Float32Array(500), new Float32Array(500)], sr)).toBeNull();
  });

  it("finds the sound, padded, clamped to the buffer", () => {
    const a = new Float32Array(1000);
    a[300] = 0.5;
    a[600] = -0.2;
    expect(soundSpan([a, new Float32Array(1000)], sr)).toEqual({ start: 250, end: 651 });
    const b = new Float32Array(100);
    b[10] = 1;
    expect(soundSpan([b], sr)).toEqual({ start: 0, end: 61 });
  });

  it("listens to either channel", () => {
    const r = new Float32Array(1000);
    r[400] = 0.1;
    expect(soundSpan([new Float32Array(1000), r], sr, 0.001, 0)).toEqual({ start: 400, end: 401 });
  });
});

describe("trimGrab", () => {
  it("cuts to the sound and moves the song time with it", () => {
    const s = new Array(1000).fill(0);
    s[500] = 0.9;
    const t = trimGrab(grab(s, 10))!;
    expect(t.channels[0].length).toBe(101);
    expect(t.channels[0][50]).toBeCloseTo(0.9);
    expect(t.channels[1][50]).toBeCloseTo(-0.9);
    expect(t.songTime).toBeCloseTo(10.45);
  });

  it("keeps a stopped transport stopped, and gives up on silence", () => {
    const s = new Array(1000).fill(0);
    s[0] = 0.5;
    expect(trimGrab(grab(s, null))!.songTime).toBeNull();
    expect(trimGrab(grab(new Array(1000).fill(0.0001), 3))).toBeNull();
  });
});

describe("songTimeAt", () => {
  const log = [
    { ctxStart: 10, ctxEnd: 20, song: 0 },
    { ctxStart: 25, ctxEnd: Infinity, song: 4 },
  ];
  it("maps context time inside a play span", () => {
    expect(songTimeAt(log, 12.5)).toBeCloseTo(2.5);
    expect(songTimeAt(log, 30)).toBeCloseTo(9);
  });
  it("is null while stopped", () => {
    expect(songTimeAt(log, 5)).toBeNull();
    expect(songTimeAt(log, 22)).toBeNull();
    expect(songTimeAt([], 1)).toBeNull();
  });
});

describe("nextLayerName", () => {
  it("counts up past taken names", () => {
    expect(nextLayerName("Skip-back", [])).toBe("Skip-back 1");
    expect(nextLayerName("Skip-back", ["Skip-back 1", "Skip-back 3"])).toBe("Skip-back 2");
  });
});
