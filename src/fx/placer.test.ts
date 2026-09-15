// Runs the placer AudioWorklet's DSP in Node (fake worklet globals): the
// pan/width stage every layer and reverb send goes through.
import { describe, it, expect, beforeAll } from "vitest";
import workletSource from "../../public/placer-processor.js?raw";

type Proc = {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
};
let Processor: new () => Proc;

beforeAll(() => {
  const registry: Record<string, new () => Proc> = {};
  new Function("sampleRate", "AudioWorkletProcessor", "registerProcessor", workletSource)(
    48000,
    class {},
    (name: string, cls: new () => Proc) => (registry[name] = cls),
  );
  Processor = registry["placer-processor"];
  expect(Processor).toBeDefined();
});

/** Process one 128-frame block of `channels` through the placer. */
function place(channels: Float32Array[], pan: number, width: number): Float32Array[] {
  const proc = new Processor();
  const out = channels.map(() => new Float32Array(128));
  proc.process([channels], [out], { pan: new Float32Array([pan]), width: new Float32Array([width]) });
  return out;
}

const ramp = (scale: number) => new Float32Array(128).map((_, i) => scale * Math.sin(i * 0.1));
const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe("placer-processor: stereo", () => {
  const L = ramp(0.5), R = ramp(-0.3);

  it("pan 0 / width 1 is a bit-exact identity", () => {
    const [l, r] = place([L, R], 0, 1);
    expect(l).toEqual(L);
    expect(r).toEqual(R);
  });

  it("width 0 collapses to mono, width 2 doubles the side", () => {
    const [l0, r0] = place([L, R], 0, 0);
    expect(l0).toEqual(r0);
    for (let i = 0; i < 128; i += 17) expect(l0[i]).toBeCloseTo(0.5 * (L[i] + R[i]), 6);
    const [l2, r2] = place([L, R], 0, 2);
    for (let i = 0; i < 128; i += 17) expect(l2[i] - r2[i]).toBeCloseTo(2 * (L[i] - R[i]), 6);
  });

  it("hard pan silences the far side; centre is unity, extremes +3 dB", () => {
    const [l, r] = place([L, R], -1, 1);
    expect(peak(r)).toBeLessThan(1e-9);
    expect(peak(l)).toBeCloseTo(peak(L) * Math.SQRT2, 5);
    const [l1, r1] = place([L, R], 1, 1);
    expect(peak(l1)).toBeLessThan(1e-9);
    expect(peak(r1)).toBeCloseTo(peak(R) * Math.SQRT2, 5);
  });

  it("empty input (upstream gone quiet) is silence", () => {
    const proc = new Processor();
    const out = [ramp(1), ramp(1)];
    proc.process([[]], [out], { pan: new Float32Array([0]), width: new Float32Array([1]) });
    expect(peak(out[0])).toBe(0);
  });
});

describe("placer-processor: surround", () => {
  const field6 = () => [ramp(0.1), ramp(0.2), ramp(0.3), ramp(0.4), ramp(0.5), ramp(0.6)];

  it("5.1 identity at rest, every speaker back on itself", () => {
    const src = field6();
    const out = place(src, 0, 1);
    out.forEach((ch, c) => expect(ch).toEqual(src[c]));
  });

  it("width 0 folds every speaker onto centre, LFE untouched", () => {
    const src = field6();
    const out = place(src, 0, 0);
    // C gets the sum of L, R, C, Ls, Rs (each at unity, all at azimuth 0).
    for (let i = 0; i < 128; i += 13) {
      expect(out[2][i]).toBeCloseTo(src[0][i] + src[1][i] + src[2][i] + src[4][i] + src[5][i], 5);
    }
    expect(out[3]).toEqual(src[3]);
    for (const c of [0, 1, 4, 5]) expect(peak(out[c])).toBe(0);
  });

  it("pan rotates the field: half a turn swaps front and back", () => {
    // A source on L only (−30°), rotated by 180° → 150°, between Rs (110°)
    // and Ls (250°): lands on the surrounds, nothing on the fronts.
    const src = [ramp(1), new Float32Array(128), new Float32Array(128), new Float32Array(128), new Float32Array(128), new Float32Array(128)];
    const out = place(src, 1, 1);
    expect(peak(out[4]) + peak(out[5])).toBeGreaterThan(0.9);
    expect(peak(out[0]) + peak(out[1]) + peak(out[2])).toBe(0);
    // Constant power across the pair.
    expect(peak(out[4]) ** 2 + peak(out[5]) ** 2).toBeCloseTo(1, 3);
  });

  it("7.1 identity at rest", () => {
    const src = [...field6(), ramp(0.7), ramp(0.8)];
    const out = place(src, 0, 1);
    out.forEach((ch, c) => expect(ch).toEqual(src[c]));
  });
});
