// Runs the binaural headphone monitor worklet in Node: a 7.1 bus rendered
// to two ears must keep left/right, and tell front from back.
import { describe, it, expect, beforeAll } from "vitest";
import workletSource from "../../public/binaural-processor.js?raw";

const SR = 48000;
type Proc = { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
let Processor: new () => Proc;

beforeAll(() => {
  const registry: Record<string, new () => Proc> = {};
  new Function("sampleRate", "AudioWorkletProcessor", "registerProcessor", workletSource)(
    SR,
    class {},
    (name: string, cls: new () => Proc) => (registry[name] = cls),
  );
  Processor = registry["binaural-processor"];
});

/** Noise on one speaker channel of an `n`-channel bus → [L, R] ears. */
function render(n: number, channel: number): [Float32Array, Float32Array] {
  const proc = new Processor();
  const len = 128 * 190;
  const L = new Float32Array(len), R = new Float32Array(len);
  let seed = 7;
  for (let i = 0; i < len; i += 128) {
    const ins = Array.from({ length: n }, () => new Float32Array(128));
    for (let k = 0; k < 128; k++) ins[channel][k] = ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 0.5;
    const out = [new Float32Array(128), new Float32Array(128)];
    proc.process([ins], [out]);
    L.set(out[0], i);
    R.set(out[1], i);
  }
  return [L, R];
}
const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
/** Rough brightness: RMS of the first difference over RMS. */
const bright = (a: Float32Array) => {
  let s = 0;
  for (let i = 1; i < a.length; i++) s += (a[i] - a[i - 1]) ** 2;
  return Math.sqrt(s / a.length) / rms(a);
};

describe("binaural-processor", () => {
  it("puts a side speaker in its own ear, louder and earlier", () => {
    const [l, r] = render(8, 6); // 7.1 Ls, -90°
    expect(rms(l)).toBeGreaterThan(rms(r) * 1.5);
    const [l2, r2] = render(8, 7); // Rs
    expect(rms(r2)).toBeGreaterThan(rms(l2) * 1.5);
  });

  it("keeps the centre speaker centred", () => {
    const [l, r] = render(8, 2);
    expect(Math.abs(rms(l) - rms(r))).toBeLessThan(1e-6);
  });

  it("tells back from front: rear speakers are darker than their front twins", () => {
    const front = render(8, 0)[0]; // L  -30°
    const back = render(8, 4)[0];  // Lb -150°
    expect(bright(back)).toBeLessThan(bright(front) * 0.9);
  });

  it("handles 5.1 and passes LFE to both ears", () => {
    const [l, r] = render(6, 3);
    expect(rms(l)).toBeGreaterThan(0.05);
    expect(Math.abs(rms(l) - rms(r))).toBeLessThan(1e-6);
  });
});
