// PUNCH: the shared core (public/punch-core.js), the worklet wrapper run in
// Node, the timeline preview, and the model.
import { describe, it, expect, beforeAll } from "vitest";
import coreSource from "../../public/punch-core.js?raw";
import workletSource from "../../public/punch-processor.js?raw";
import {
  DEFAULT_PUNCH,
  PUNCH_PRESETS,
  PUNCH_SPECS,
  clampPunchValue,
  matchingPunchPreset,
  normalizePunch,
  punchIsActive,
  punchPresetParams,
  type PunchCoreCtor,
  type PunchParams,
} from "./punch";
import { PunchPreviewJob, lowGainDb } from "../render/punchPreview";

const SR = 48000;
// The same file the worklet and the app load, evaluated as plain JS.
const Core = new Function("sampleRate", `${coreSource.replace(/^export /m, "")}\nreturn PunchCore;`)(SR) as PunchCoreCtor;

/** Four-on-the-floor: 55 Hz kick thumps + a bassline + hats, ~-6 dBFS peaks. */
function beat(seconds: number): [Float32Array, Float32Array] {
  const n = Math.floor(SR * seconds);
  const l = new Float32Array(n), r = new Float32Array(n);
  let seed = 3;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const tk = t % 0.5;
    const kick = Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-tk * 40)) * tk) * Math.exp(-tk * 9) * 0.35;
    const bass = Math.sin(2 * Math.PI * 82 * t) * 0.12;
    const th = t % 0.25;
    const hat = (((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5) * Math.exp(-th * 60) * 0.25;
    l[i] = kick + bass + hat;
    r[i] = kick + bass - hat * 0.5;
  }
  return [l, r];
}

function process(p: Partial<PunchParams>, [l, r]: [Float32Array, Float32Array]) {
  const c = new Core(SR);
  c.set({ ...DEFAULT_PUNCH, ...p });
  const ol = new Float32Array(l.length), or = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) {
    c.step(l[i], r[i]);
    ol[i] = c.l;
    or[i] = c.r;
  }
  return [ol, or];
}

const rms = (a: Float32Array, from = SR * 0.25) => {
  let s = 0;
  for (let i = from; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / (a.length - from));
};
const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
/** Energy below ~120 Hz via a crude one-pole low-pass. */
const lowRms = (a: Float32Array) => {
  const k = 1 - Math.exp((-2 * Math.PI * 120) / SR);
  let y = 0, s = 0;
  for (let i = 0; i < a.length; i++) {
    y += k * (a[i] - y);
    if (i >= SR * 0.25) s += y * y;
  }
  return Math.sqrt(s / (a.length - SR * 0.25));
};

describe("punch core", () => {
  const input = beat(2);

  it("at rest the crossover sums back to (nearly) the input level", () => {
    const [l] = process({ output: 0 }, input);
    expect(rms(l) / rms(input[0])).toBeGreaterThan(0.85);
    expect(rms(l) / rms(input[0])).toBeLessThan(1.15);
  });

  it("BOOM and SUB add bass", () => {
    const base = lowRms(process({}, input)[0]);
    expect(lowRms(process({ boom: 1 }, input)[0])).toBeGreaterThan(base * 2.5);
    expect(lowRms(process({ sub: 1 }, input)[0])).toBeGreaterThan(base * 1.3);
  });

  it("KICK PUNCH raises the kick's attack more than its tail", () => {
    const [l] = process({ punch: 1 }, input);
    const [d] = process({}, input);
    const at = (a: Float32Array, from: number, to: number) => rms(a.subarray(0, Math.floor(SR * to)), Math.floor(SR * from));
    const attackGain = at(l, 1.0, 1.02) / at(d, 1.0, 1.02);
    const tailGain = at(l, 1.25, 1.45) / at(d, 1.25, 1.45);
    expect(attackGain).toBeGreaterThan(tailGain * 1.3);
  });

  it("SAFE keeps even Speaker Killer under 0 dBFS; LET IT CLIP goes over", () => {
    const killer = punchPresetParams(PUNCH_PRESETS.find((p) => p.name === "Speaker Killer")!);
    const [safeL] = process({ ...killer, safe: 1 }, input);
    expect(peak(safeL)).toBeLessThan(1);
    const [hotL] = process(killer, input);
    expect(peak(hotL)).toBeGreaterThan(1);
  });

  it("every preset is finite", () => {
    for (const p of PUNCH_PRESETS) {
      const [l, r] = process(punchPresetParams(p), input);
      expect(l.every(Number.isFinite) && r.every(Number.isFinite), p.name).toBe(true);
    }
  });
});

describe("punch worklet", () => {
  type Proc = { process(i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>): boolean };
  let Processor: (new () => Proc) & { parameterDescriptors: { name: string; defaultValue: number; minValue: number; maxValue: number }[] };

  beforeAll(() => {
    const registry: Record<string, typeof Processor> = {};
    const g = globalThis as { PunchCore?: unknown };
    const saved = g.PunchCore;
    // The worklet finds the core on the shared global scope, as in the browser.
    new Function("sampleRate", coreSource.replace(/^export /m, ""))(SR);
    new Function("sampleRate", "AudioWorkletProcessor", "registerProcessor", workletSource)(
      SR,
      class {},
      (name: string, cls: typeof Processor) => (registry[name] = cls),
    );
    Processor = registry["punch-processor"];
    if (saved) g.PunchCore = saved;
  });

  it("declares one param per model key with the model's defaults and ranges", () => {
    expect(Processor.parameterDescriptors.map((d) => d.name).sort()).toEqual(Object.keys(DEFAULT_PUNCH).sort());
    for (const d of Processor.parameterDescriptors) {
      const key = d.name as keyof PunchParams;
      expect(d.defaultValue).toBe(DEFAULT_PUNCH[key]);
      expect(clampPunchValue(key, 1e9)).toBe(d.maxValue);
      expect(clampPunchValue(key, -1e9)).toBe(d.minValue);
    }
  });

  it("renders exactly what the preview core renders", () => {
    const p = punchPresetParams(PUNCH_PRESETS.find((x) => x.name === "808 Boom")!);
    const [l, r] = beat(0.5);
    const proc = new Processor();
    const params: Record<string, Float32Array> = {};
    for (const [k, v] of Object.entries(p)) params[k] = new Float32Array([v]);
    const out = new Float32Array(l.length);
    for (let i = 0; i < l.length; i += 128) {
      const o = [new Float32Array(128), new Float32Array(128)];
      proc.process([[l.subarray(i, i + 128), r.subarray(i, i + 128)]], [o], params);
      out.set(o[0].subarray(0, Math.min(128, l.length - i)), i);
    }
    const [ref] = process(p, [l, r]);
    for (let i = 0; i < l.length; i += 131) expect(out[i]).toBeCloseTo(ref[i], 6);
  });
});

describe("punch preview", () => {
  it("reports peak, clipping and bass gain, in slices, identical to one pass", () => {
    const input = beat(1.5);
    const p = punchPresetParams(PUNCH_PRESETS.find((x) => x.name === "Blown Out")!);
    const sliced = new PunchPreviewJob(Core, SR, input, p, 1);
    let guard = 0;
    while (!sliced.step(10_000)) guard++;
    expect(guard).toBeGreaterThan(3);
    const whole = new PunchPreviewJob(Core, SR, input, p, 1);
    whole.step(1e9);
    expect(sliced.result.peak).toBeCloseTo(whole.result.peak, 9);
    expect(sliced.result.overTotal).toBe(whole.result.overTotal);
    expect(sliced.result.lowOutSq).toBeCloseTo(whole.result.lowOutSq, 3);
    expect(whole.result.peak).toBeGreaterThan(1);
    expect(whole.result.overTotal).toBeGreaterThan(0);
    expect(lowGainDb(whole.result)).toBeGreaterThan(6);
    // Every clipped sample is attributed to a bucket.
    expect(whole.result.over.reduce((a, b) => a + b, 0)).toBe(whole.result.overTotal);
  });
});

describe("punch model", () => {
  it("is off by default and on for every preset but Off", () => {
    expect(punchIsActive(DEFAULT_PUNCH)).toBe(false);
    for (const p of PUNCH_PRESETS) expect(punchIsActive(punchPresetParams(p))).toBe(p.name !== "Off");
  });
  it("normalises old sessions and junk", () => {
    expect(normalizePunch(undefined)).toEqual(DEFAULT_PUNCH);
    expect(normalizePunch({ boom: 9, freq: "x" })).toEqual({ ...DEFAULT_PUNCH, boom: 1 });
  });
  it("recognises each preset", () => {
    for (const p of PUNCH_PRESETS.slice(1)) expect(matchingPunchPreset(punchPresetParams(p))).toBe(p.name);
  });
  it("labels every knob", () => {
    expect(PUNCH_SPECS.map((s) => s.key).sort()).toEqual(Object.keys(DEFAULT_PUNCH).filter((k) => k !== "safe").sort());
  });
});
