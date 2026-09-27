// Runs the MORPH AudioWorklet's DSP in Node (faked worklet globals): every
// engine and every preset must produce finite, audible, non-clipping sound at
// a level close to the input's, spread onto the speakers it is asked for.
// The TS model (clamping, presets, knob readouts) is covered at the bottom.
import { describe, it, expect, beforeAll } from "vitest";
import workletSource from "../../public/morph-processor.js?raw";
import {
  DEFAULT_MORPH,
  MORPH_ALGOS,
  MORPH_PRESETS,
  FM_RATIOS,
  STRING_CHORDS,
  TUNINGS,
  PATHS,
  clampMorphValue,
  knobText,
  matchingMorphPreset,
  morphPresetParams,
  normalizeMorph,
  type MorphKey,
  type MorphParams,
} from "./morph";

const SR = 48000;
type Proc = {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
};
type ProcClass = (new () => Proc) & { parameterDescriptors: { name: string; defaultValue: number; maxValue: number }[] };
let Processor: ProcClass;

beforeAll(() => {
  const registry: Record<string, ProcClass> = {};
  new Function("sampleRate", "AudioWorkletProcessor", "registerProcessor", workletSource)(
    SR,
    class {},
    (name: string, cls: ProcClass) => (registry[name] = cls),
  );
  Processor = registry["morph-processor"];
  expect(Processor).toBeDefined();
});

/** A crude sung "voice": gliding pulse train through two resonances. */
export function voice(seconds: number): Float32Array {
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  let y1 = 0, y2 = 0, z1 = 0, z2 = 0, ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f0 = 150 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
    ph += f0 / SR;
    const pulse = ph >= 1 ? ((ph -= 1), 1) : 0;
    const y = pulse + 1.6 * Math.cos((2 * Math.PI * 700) / SR) * 0.97 * y1 - 0.94 * y2;
    y2 = y1; y1 = y;
    const z = pulse + 1.9 * Math.cos((2 * Math.PI * 1800) / SR) * 0.98 * z1 - 0.96 * z2;
    z2 = z1; z1 = z;
    out[i] = (y + 0.5 * z) * Math.min(1, t / 0.05);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * 0.5;
  return out;
}

export function runMorph(p: Partial<MorphParams>, input: Float32Array, nCh = 2): Float32Array[] {
  const proc = new Processor();
  const outs: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) outs.push(new Float32Array(input.length));
  const params: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries({ ...DEFAULT_MORPH, mix: 1, ...p })) params[k] = new Float32Array([v as number]);
  for (let i = 0; i < input.length; i += 128) {
    const block = input.subarray(i, i + 128);
    const o = outs.map(() => new Float32Array(block.length));
    proc.process([[block, block]], [o], params);
    o.forEach((ch, c) => outs[c].set(ch, i));
  }
  return outs;
}

const rms = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const fieldRms = (outs: Float32Array[], from: number) => Math.sqrt(outs.reduce((s, o) => s + rms(o, from) ** 2, 0));
const maxAbs = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe("morph-processor", () => {
  const input = voice(1.5);
  const settle = SR * 0.4;
  const inRms = rms(input, settle);

  it("declares one AudioParam per model key, with the model's defaults and ranges", () => {
    const names = Processor.parameterDescriptors.map((d) => d.name).sort();
    expect(names).toEqual(Object.keys(DEFAULT_MORPH).sort());
    for (const d of Processor.parameterDescriptors) {
      const key = d.name as MorphKey;
      expect(d.defaultValue).toBe(DEFAULT_MORPH[key]);
      expect(clampMorphValue(key, 1e9)).toBe(d.maxValue);
    }
  });

  it("mix 0 is a bit-exact passthrough", () => {
    const [l, r] = runMorph({ mix: 0, algo: 6 }, input);
    expect(l).toEqual(input);
    expect(r).toEqual(input);
  });

  for (const preset of MORPH_PRESETS.filter((p) => p.name !== "Off")) {
    it(`preset "${preset.name}" is finite, audible, level-matched and in range`, () => {
      const outs = runMorph({ ...morphPresetParams(preset), mix: 1 }, input);
      for (const o of outs) {
        expect(o.every(Number.isFinite)).toBe(true);
        expect(maxAbs(o)).toBeLessThanOrEqual(1);
      }
      const ratio = fieldRms(outs, settle) / inRms;
      // Within ~-10 .. +6 dB of the dry voice: no engine vanishes or blasts.
      expect(ratio).toBeGreaterThan(0.3);
      expect(ratio).toBeLessThan(2);
    });
  }

  it("every engine differs from every other (they really are different plugins)", () => {
    const renders = MORPH_ALGOS.map((_, algo) => runMorph({ algo, spread: 0 }, input)[0]);
    for (let i = 0; i < renders.length; i++)
      for (let j = i + 1; j < renders.length; j++) {
        let s = 0;
        for (let n = settle; n < input.length; n++) s += (renders[i][n] - renders[j][n]) ** 2;
        expect(Math.sqrt(s / (input.length - settle))).toBeGreaterThan(0.01);
      }
  });

  it("in 7.1 a full-spread engine reaches the rear and side speakers", () => {
    for (const algo of [1, 2, 6, 7]) {
      // (HARMONIC with its beat off: a binaural beat deliberately pins to the two ears.)
      const outs = runMorph({ algo, spread: 1, path: 1, motion: 0.5, c: algo === 7 ? 0 : 0.5 }, input, 8);
      for (const c of [4, 5, 6, 7]) expect(rms(outs[c], settle), `algo ${algo} ch ${c}`).toBeGreaterThan(1e-3);
      expect(rms(outs[3], settle)).toBe(0); // LFE untouched
    }
  });

  it("the binaural beat pins its two banks to opposite ears", () => {
    const [l, r] = runMorph({ algo: 7, a: 0, c: 0.5, b: 0.8, spread: 1 }, input);
    // One partial per ear: left rings at the root, right at root + 6 Hz; they must differ.
    let s = 0;
    for (let n = settle; n < input.length; n++) s += (l[n] - r[n]) ** 2;
    expect(Math.sqrt(s / (input.length - settle))).toBeGreaterThan(0.01);
  });

  it("goes idle after the input stops and wakes again cleanly", () => {
    const withGap = new Float32Array(SR * 5);
    withGap.set(input.subarray(0, SR * 0.5));
    withGap.set(input.subarray(0, SR * 0.5), SR * 4.2);
    const [l] = runMorph({ algo: 2, a: 1 }, withGap);
    expect(maxAbs(l.subarray(SR * 3.8, SR * 4.2))).toBe(0);
    expect(rms(l, SR * 4.3, SR * 4.7)).toBeGreaterThan(0.01);
  });

  it("renders identically twice (seeded randomness)", () => {
    const a = runMorph({ algo: 1, c: 1, d: 1 }, input)[0];
    const b = runMorph({ algo: 1, c: 1, d: 1 }, input)[0];
    expect(a).toEqual(b);
  });
});

describe("morph model", () => {
  it("keeps the worklet's tables in sync", () => {
    expect(workletSource).toContain(`const FM_RATIOS = ${JSON.stringify(FM_RATIOS).replace(/,/g, ", ")}`);
    expect(workletSource).toContain(
      `const STRING_CHORDS = ${JSON.stringify(STRING_CHORDS.map((c) => c.iv)).replace(/,/g, ", ").replace(/\], \[/g, "], [")}`,
    );
    expect(workletSource).toContain(`const TUNING_ROOTS = ${JSON.stringify(TUNINGS.map((t) => t.root)).replace(/,/g, ", ")}`);
    expect(workletSource).toContain(`kParam("algo", 0, 0, ${MORPH_ALGOS.length - 1})`);
    expect(workletSource).toContain(`kParam("path", 0, 0, ${PATHS.length - 1})`);
  });

  it("clamps and rounds bad values", () => {
    expect(clampMorphValue("algo", 3.6)).toBe(4);
    expect(clampMorphValue("mix", -2)).toBe(0);
    expect(clampMorphValue("a", Number.NaN)).toBe(DEFAULT_MORPH.a);
  });

  it("normalises old sessions (no morph block) to off", () => {
    expect(normalizeMorph(undefined)).toEqual(DEFAULT_MORPH);
    expect(normalizeMorph({ mix: 0.5, algo: 99, junk: 1 })).toEqual({ ...DEFAULT_MORPH, mix: 0.5, algo: MORPH_ALGOS.length - 1 });
  });

  it("recognises each preset and nothing else", () => {
    const names = new Set<string>();
    for (const p of MORPH_PRESETS) {
      expect(matchingMorphPreset(morphPresetParams(p))).toBe(p.name);
      names.add(p.name);
    }
    expect(names.size).toBe(MORPH_PRESETS.length);
    expect(matchingMorphPreset({ ...DEFAULT_MORPH, mix: 0.33 })).toBeNull();
  });

  it("covers every engine with at least two presets", () => {
    MORPH_ALGOS.forEach((_, algo) => {
      expect(MORPH_PRESETS.filter((p) => (p.params.algo ?? 0) === algo && (p.params.mix ?? 0) > 0).length).toBeGreaterThanOrEqual(2);
    });
  });

  it("gives concrete knob readouts", () => {
    expect(knobText({ ...DEFAULT_MORPH, algo: 0, a: 0 }, "a")).toBe("×0.5");
    expect(knobText({ ...DEFAULT_MORPH, algo: 3, a: 1 }, "a")).toBe("U");
    expect(knobText({ ...DEFAULT_MORPH, algo: 6, c: 0.5 }, "c")).toBe("ROBOT");
    expect(knobText({ ...DEFAULT_MORPH, algo: 7, c: 0 }, "c")).toBe("off");
    expect(knobText({ ...DEFAULT_MORPH, algo: 1, a: 0.25 }, "a")).toBe("25%");
  });
});
