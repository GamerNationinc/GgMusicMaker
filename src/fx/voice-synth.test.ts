// Runs the Voice Synth AudioWorklet's DSP in Node by faking the worklet
// globals, so every engine, the stack, the modulators and the surround
// placement are exercised without a browser. The TS model (presets,
// migration, clamping) is covered at the bottom.
import { describe, it, expect, beforeAll } from "vitest";
import workletSource from "../../public/voice-synth-processor.js?raw";
import {
  DEFAULT_SYNTH,
  SYNTH_PRESETS,
  SYNTH_SPECS,
  SURROUND,
  clampSynthValue,
  matchingPreset,
  migrateVoiceParams,
  normalizeSynth,
  presetParams,
  synthIsActive,
  type SynthKey,
  type VoiceSynthParams,
} from "./voice-synth";

const SR = 48000;
type Proc = {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
};
type ProcClass = (new () => Proc) & { parameterDescriptors: { name: string; defaultValue: number }[] };
let Processor: ProcClass;

beforeAll(() => {
  const registry: Record<string, ProcClass> = {};
  const run = new Function(
    "sampleRate",
    "AudioWorkletProcessor",
    "registerProcessor",
    workletSource,
  );
  run(SR, class {}, (name: string, cls: ProcClass) => (registry[name] = cls));
  Processor = registry["voice-synth-processor"];
  expect(Processor).toBeDefined();
});

/** A crude "voice": 140 Hz pulse train through a formant-ish resonance. */
function voice(seconds: number): Float32Array {
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  let y1 = 0, y2 = 0;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const pulse = (i % Math.round(SR / 140)) < 20 ? 1 : 0;
    const y = pulse + 1.6 * Math.cos((2 * Math.PI * 700) / SR) * 0.97 * y1 - 0.94 * y2;
    y2 = y1; y1 = y;
    out[i] = y * Math.sin((Math.PI / 2) * Math.min(1, t / 0.05)) + 0.02 * (rnd() - 0.5);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * 0.5;
  return out;
}

/** Run the processor over `input` (fed to both L and R) into `nCh` outputs. */
function run(
  p: Partial<VoiceSynthParams>,
  input: Float32Array,
  nCh = 2,
  /** Optional per-sample-offset param changes (e.g. a pitch jump mid-way). */
  at?: (offset: number) => Partial<VoiceSynthParams> | undefined,
): Float32Array[] {
  const proc = new Processor();
  const outs: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) outs.push(new Float32Array(input.length));
  const params: Record<string, Float32Array> = {};
  // Tests start from "wet, shift only" unless they say otherwise.
  const base: VoiceSynthParams = { ...DEFAULT_SYNTH, mix: 1, shift: 1 };
  for (const [k, v] of Object.entries({ ...base, ...p })) params[k] = new Float32Array([v as number]);
  for (let i = 0; i < input.length; i += 128) {
    const change = at?.(i);
    if (change) for (const [k, v] of Object.entries(change)) params[k][0] = v as number;
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
  return Math.sqrt(s / (to - from));
};
const maxAbs = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const diff = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length);
};
const finite = (outs: Float32Array[]) => outs.every((o) => o.every(Number.isFinite));

describe("voice-synth-processor", () => {
  const input = voice(0.6);
  const settle = SR * 0.1;

  it("declares one AudioParam per model key, with the model's defaults", () => {
    const names = Processor.parameterDescriptors.map((d) => d.name).sort();
    expect(names).toEqual(Object.keys(DEFAULT_SYNTH).sort());
    for (const d of Processor.parameterDescriptors) {
      expect(d.defaultValue).toBe(DEFAULT_SYNTH[d.name as SynthKey]);
    }
  });

  it("mix 0 is a bit-exact passthrough, and silent on the surround channels", () => {
    const [l, r] = run({ mix: 0, vocoder: 1, unison: 8 }, input);
    expect(l).toEqual(input);
    expect(r).toEqual(input);
    const six = run({ mix: 0 }, input, 6);
    expect(six[0]).toEqual(input);
    expect(six[1]).toEqual(input);
    for (let c = 2; c < 6; c++) expect(maxAbs(six[c])).toBe(0);
  });

  it("an unmodulated shift at pitch 0 is the dry voice, centre-panned at -3 dB", () => {
    const [l, r] = run({ pitch: 0, formant: 0 }, input);
    const g = Math.cos(Math.PI / 4);
    for (let i = 0; i < input.length; i += 97) {
      expect(l[i]).toBeCloseTo(input[i] * g, 5);
      expect(r[i]).toBeCloseTo(input[i] * g, 5);
    }
  });

  for (const [name, p] of [
    ["shift +7", { pitch: 7 }],
    ["shift formant -6", { formant: -6 }],
    ["vocoder major", { shift: 0, vocoder: 1, chord: 3 }],
    ["talkbox", { shift: 0, talkbox: 1, character: 0.8 }],
    ["compuvox", { shift: 0, compuvox: 1, character: 0.7 }],
    ["polyvox major", { shift: 0, polyvox: 1, chord: 3, character: 0.5 }],
    ["everything stacked", { pitch: 3, vocoder: 0.5, talkbox: 0.5, compuvox: 0.3, polyvox: 0.6, chord: 6, unison: 8, sub: 0.5, shimmer: 0.5 }],
  ] as const) {
    it(`${name}: finite, bounded, non-silent and different from dry`, () => {
      const [l, r] = run(p, input);
      expect(finite([l, r])).toBe(true);
      expect(maxAbs(l)).toBeLessThanOrEqual(1.0);
      const level = rms(l, settle);
      expect(level).toBeGreaterThan(0.01);
      // Within an order of magnitude of the input: no runaway, no vanishing.
      expect(level / rms(input, settle)).toBeGreaterThan(0.1);
      expect(level / rms(input, settle)).toBeLessThan(10);
      expect(diff(l, input)).toBeGreaterThan(0.01);
      expect(finite([r])).toBe(true);
    });
  }

  it("vocoder is silent when the voice is silent (envelopes gate the carrier)", () => {
    const silence = new Float32Array(SR * 0.3);
    const [l] = run({ shift: 0, vocoder: 1 }, silence);
    expect(rms(l, settle)).toBeLessThan(1e-3);
  });

  it("compuvox output is quantised (few distinct levels)", () => {
    const [l] = run({ shift: 0, compuvox: 1, character: 1, width: 0 }, input);
    const levels = new Set<number>();
    for (let i = settle; i < l.length; i++) levels.add(Math.round(l[i] * 1e4));
    expect(levels.size).toBeLessThan(200);
  });

  it("pitch changes the vocoder carrier, not just the mix", () => {
    const [low] = run({ shift: 0, vocoder: 1, pitch: -12 }, input);
    const [high] = run({ shift: 0, vocoder: 1, pitch: 12 }, input);
    expect(diff(low, high)).toBeGreaterThan(0.01);
  });

  it("rings out its tail when the host stops delivering input, then idles", () => {
    // Web Audio hands a worklet an input with *no channels* once upstream
    // nodes go quiet. That must sound like silence (tails ring out), not a
    // hard cut, and must render the same as explicit zeros.
    const feed = (proc: Proc, blocks: number, src: Float32Array | null, params: Record<string, Float32Array>) => {
      const out: Float32Array[] = [];
      for (let b = 0; b < blocks; b++) {
        const o = [new Float32Array(128), new Float32Array(128)];
        const inp = src ? [src.subarray(b * 128, b * 128 + 128), src.subarray(b * 128, b * 128 + 128)] : [];
        proc.process([inp], [o], params);
        out.push(o[0]);
      }
      return out;
    };
    const params: Record<string, Float32Array> = {};
    for (const [k, v] of Object.entries({ ...DEFAULT_SYNTH, mix: 1, shift: 1, pitch: 5, ensemble: 0.5 })) params[k] = new Float32Array([v]);
    const head = input.subarray(0, 128 * 100);
    const zeros = new Float32Array(128 * 300);

    const a = new Processor(); feed(a, 100, head, params);
    const tailEmpty = feed(a, 300, null, params);
    const b = new Processor(); feed(b, 100, head, params);
    const tailZeros = feed(b, 300, zeros, params);
    expect(tailEmpty).toEqual(tailZeros);

    // Tail is audible right after the cut…
    expect(maxAbs(tailEmpty[1])).toBeGreaterThan(1e-3);
    // …and exactly zero once the silence has outlasted every tail (0.6 s ≈ 225 blocks).
    expect(maxAbs(tailEmpty[299])).toBe(0);
    // Waking up again works, from a clean state (no stale grains).
    const wake = feed(a, 100, head, params);
    expect(maxAbs(wake[50])).toBeGreaterThan(1e-3);
    expect(finite(wake)).toBe(true);
  });

  it("renders deterministically (seeded noise + drift)", () => {
    const p = { vocoder: 0.7, drift: 50, unison: 4, ensemble: 0.5 };
    const [a] = run(p, input);
    const [b] = run(p, input);
    expect(a).toEqual(b);
  });

  describe("stack", () => {
    it("unison voices with detune thicken the layer (differs from a single voice)", () => {
      const [one] = run({ pitch: 4, unison: 1 }, input);
      const [six] = run({ pitch: 4, unison: 6, detune: 30 }, input);
      expect(diff(one, six)).toBeGreaterThan(0.005);
      expect(rms(six, settle) / rms(one, settle)).toBeGreaterThan(0.5);
      expect(rms(six, settle) / rms(one, settle)).toBeLessThan(2);
    });

    it("sub and shimmer layers add energy", () => {
      const [dry] = run({ pitch: 0, width: 0 }, input);
      const [sub] = run({ pitch: 0, width: 0, sub: 1 }, input);
      const [shim] = run({ pitch: 0, width: 0, shimmer: 1 }, input);
      expect(rms(sub, settle)).toBeGreaterThan(rms(dry, settle) * 1.05);
      expect(rms(shim, settle)).toBeGreaterThan(rms(dry, settle) * 1.05);
    });
  });

  describe("modulation", () => {
    let still: Float32Array;
    beforeAll(() => {
      still = run({ pitch: 2, width: 0 }, input)[0];
    });
    for (const [name, p] of [
      ["vibrato", { vibratoRate: 6, vibratoDepth: 60 }],
      ["drift", { drift: 80 }],
      ["formant LFO", { formantRate: 3, formantDepth: 5 }],
      ["dynamics → pitch", { envPitch: 1 }],
      ["dynamics → formant", { envFormant: 1 }],
    ] as const) {
      it(`${name} changes the sound and stays bounded`, () => {
        const [l] = run({ pitch: 2, width: 0, ...p }, input);
        expect(finite([l])).toBe(true);
        expect(maxAbs(l)).toBeLessThanOrEqual(1);
        expect(diff(l, still)).toBeGreaterThan(1e-4);
      });
    }

    it("glide slews a pitch jump instead of stepping it", () => {
      const jumpAt = 128 * 112; // ~0.3 s, block-aligned so the change lands
      const jump = (i: number) => (i === jumpAt ? { pitch: 12 } : undefined);
      const [step] = run({ pitch: 0, width: 0, glide: 0 }, input, 2, jump);
      const [slew] = run({ pitch: 0, width: 0, glide: 1 }, input, 2, jump);
      // Identical before the jump, different right after it while gliding.
      expect(slew.subarray(0, jumpAt)).toEqual(step.subarray(0, jumpAt));
      const after = (a: Float32Array) => a.subarray(jumpAt + 128, jumpAt + SR * 0.1);
      expect(diff(after(slew), after(step))).toBeGreaterThan(1e-3);
      expect(finite([slew])).toBe(true);
    });

    it("ring modulation at 0 Hz is off, above 0 changes the sound", () => {
      const [off] = run({ width: 0 }, input);
      const [on] = run({ width: 0, ring: 90 }, input);
      expect(diff(off, on)).toBeGreaterThan(0.01);
    });
  });

  describe("stereo field", () => {
    it("width 0 is mono; a wide unison stack is not", () => {
      const [l0, r0] = run({ width: 0, unison: 8, detune: 40 }, input);
      expect(l0).toEqual(r0);
      const [l1, r1] = run({ width: 1, unison: 8, detune: 40 }, input);
      expect(diff(l1, r1)).toBeGreaterThan(0.005);
    });

    it("orbit moves the field between the speakers over time", () => {
      const [l, r] = run({ width: 1, orbitRate: 2, orbitDepth: 1, unison: 1, pitch: 3 }, input);
      // Over one 2 Hz revolution the voice must sit hard left and hard right
      // at some point (10 ms windows, after the fade-in).
      const win = SR * 0.01;
      let lo = 1, hi = 0;
      for (let i = settle; i + win <= input.length; i += win) {
        const a = rms(l, i, i + win), b = rms(r, i, i + win);
        const share = a / (a + b + 1e-9);
        lo = Math.min(lo, share); hi = Math.max(hi, share);
      }
      expect(hi).toBeGreaterThan(0.9);
      expect(lo).toBeLessThan(0.1);
    });

    it("rear layers fold forward into stereo rather than vanishing", () => {
      const [l, r] = run({ width: 1, rear: 1, unison: 8, detune: 20 }, input);
      expect(rms(l, settle) + rms(r, settle)).toBeGreaterThan(0.05);
    });

    it("ensemble adds a chorused copy", () => {
      const [dry] = run({ width: 0 }, input);
      const [wet] = run({ width: 0, ensemble: 1 }, input);
      expect(diff(dry, wet)).toBeGreaterThan(0.01);
      expect(finite([wet])).toBe(true);
    });
  });

  describe("surround field", () => {
    const L = 0, R = 1, C = 2, LFE = 3;

    it("5.1: a centred voice goes to the centre speaker only, at unity", () => {
      const out = run({ width: 0 }, input, 6);
      expect(rms(out[C], settle)).toBeCloseTo(rms(input, settle), 4);
      for (const c of [L, R, LFE, 4, 5]) expect(rms(out[c], settle)).toBeLessThan(1e-6);
    });

    it("5.1: a wide rear stack reaches the surround speakers", () => {
      const out = run({ width: 1, rear: 1, unison: 8, detune: 20 }, input, 6);
      expect(rms(out[4], settle)).toBeGreaterThan(0.02);
      expect(rms(out[5], settle)).toBeGreaterThan(0.02);
      expect(finite(out)).toBe(true);
    });

    it("7.1: the same stack lands on side and back speakers, none on LFE", () => {
      const out = run({ width: 1, rear: 1, unison: 8, detune: 20 }, input, 8);
      const rear = rms(out[4], settle) + rms(out[5], settle) + rms(out[6], settle) + rms(out[7], settle);
      expect(rear).toBeGreaterThan(0.05);
      expect(rms(out[LFE], settle)).toBeLessThan(1e-6);
    });

    it("LFE gets a low-passed send only when asked", () => {
      const off = run({ width: 0 }, input, 6);
      const on = run({ width: 0, lfe: 1 }, input, 6);
      expect(rms(off[LFE], settle)).toBeLessThan(1e-6);
      const lfe = on[LFE];
      expect(rms(lfe, settle)).toBeGreaterThan(1e-3);
      // Low-passed: sample-to-sample differences are tiny relative to level.
      let d = 0;
      for (let i = settle + 1; i < lfe.length; i++) d += (lfe[i] - lfe[i - 1]) ** 2;
      d = Math.sqrt(d / (lfe.length - settle));
      expect(d / rms(lfe, settle)).toBeLessThan(0.05);
    });

    it("centre send puts the dry voice on C, scaled by mix", () => {
      const out = run({ shift: 0, vocoder: 0, center: 1, width: 0 }, input, 6);
      for (let i = settle; i < input.length; i += 101) expect(out[C][i]).toBeCloseTo(input[i], 5);
    });

    it("orbit rotates a voice through the 5.1 ring", () => {
      const out = run({ width: 1, orbitRate: 1, orbitDepth: 1, pitch: 3 }, input, 6);
      // Over 0.6 s of a 1 Hz orbit the voice visits front and surround speakers.
      expect(rms(out[C])).toBeGreaterThan(0.01);
      expect(rms(out[4]) + rms(out[5])).toBeGreaterThan(0.01);
      expect(rms(out[L]) + rms(out[R])).toBeGreaterThan(0.01);
    });
  });
});

describe("voice-synth model", () => {
  it("every preset stays inside the parameter ranges", () => {
    for (const preset of SYNTH_PRESETS) {
      const p = presetParams(preset);
      for (const key of Object.keys(p) as SynthKey[]) {
        expect(clampSynthValue(key, p[key]), `${preset.name}.${key}`).toBe(p[key]);
      }
    }
  });

  it("matchingPreset finds an untouched preset and null once edited", () => {
    const choir = presetParams(SYNTH_PRESETS.find((p) => p.name === "Choir")!);
    expect(matchingPreset(choir)).toBe("Choir");
    expect(matchingPreset({ ...choir, detune: choir.detune + 1 })).toBeNull();
    expect(matchingPreset(DEFAULT_SYNTH)).toBe("Off");
  });

  it("synthIsActive needs wet mix and at least one engine", () => {
    expect(synthIsActive(DEFAULT_SYNTH)).toBe(false);
    expect(synthIsActive({ ...DEFAULT_SYNTH, mix: 1, shift: 0 })).toBe(false);
    expect(synthIsActive({ ...DEFAULT_SYNTH, mix: 1, shift: 0, polyvox: 0.2 })).toBe(true);
  });

  it("clamps out-of-range and non-finite values to the spec", () => {
    expect(clampSynthValue("pitch", 99)).toBe(SYNTH_SPECS.pitch.max);
    expect(clampSynthValue("unison", 3.6)).toBe(4);
    expect(clampSynthValue("width", Number.NaN)).toBe(DEFAULT_SYNTH.width);
  });

  it("migrates v1 voice presets onto the synth", () => {
    expect(migrateVoiceParams({ preset: "chipmunk", mix: 0.7 })).toMatchObject({ mix: 0.7, shift: 1, pitch: 7 });
    expect(migrateVoiceParams({ preset: "robot", mix: 1 })).toMatchObject({ ring: 45 });
    expect(migrateVoiceParams({ preset: "off", mix: 1 }).mix).toBe(0);
    expect(migrateVoiceParams(undefined).mix).toBe(0);
  });

  it("normalizeSynth fills defaults, clamps, and falls back to legacy voice", () => {
    expect(normalizeSynth({ mix: 0.5, unison: 40, junk: 3 })).toMatchObject({ mix: 0.5, unison: 8, shift: 1 });
    expect(normalizeSynth(undefined, { preset: "deep", mix: 1 })).toMatchObject({ pitch: -7 });
  });

  it("surround layouts carry channel counts and SMPTE names", () => {
    expect(SURROUND["5.1"].channels).toBe(6);
    expect(SURROUND["7.1"].names).toEqual(["L", "R", "C", "LFE", "Lb", "Rb", "Ls", "Rs"]);
  });
});
