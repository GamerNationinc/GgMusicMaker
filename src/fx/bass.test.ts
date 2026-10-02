// BASS MOD: the model (ranges, presets) and what the DSP (public/bass-core.js)
// actually does to a bass — measured, not assumed. The Rust port is held to
// the JS core here too (skipped when the addon isn't built).
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import coreSource from "../../public/bass-core.js?raw";
import {
  BASS_PRESETS,
  BASS_RATES,
  BASS_RATE_BEATS,
  BASS_SPECS,
  DEFAULT_BASS,
  bassFromSlider,
  bassIsActive,
  bassPresetParams,
  bassToSlider,
  clampBassValue,
  matchingBassPreset,
  normalizeBass,
  type BassCoreCtor,
  type BassParams,
} from "./bass";

const SR = 48000;
const Core = new Function("sampleRate", `${coreSource.replace(/^export /gm, "")}\nreturn BassCore;`)(SR) as BassCoreCtor;
const p = (over: Partial<BassParams>): BassParams => ({ ...DEFAULT_BASS, ...over });

/** Run the core over stereo input in 128-frame blocks, song time from `t0`. */
function run(params: BassParams, l: Float32Array, r: Float32Array = l, t0 = 0): [Float64Array, Float64Array] {
  const core = new Core(SR);
  core.set(params);
  const ol = new Float64Array(l.length), or = new Float64Array(l.length);
  for (let i = 0; i < l.length; i++) {
    if (i % 128 === 0) core.block(t0 + i / SR);
    core.step(l[i], r[i]);
    ol[i] = core.l;
    or[i] = core.r;
  }
  return [ol, or];
}

const sine = (hz: number, seconds: number, amp = 0.3) =>
  Float32Array.from({ length: Math.floor(SR * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
/** Bright saw — lots of harmonics for a filter to take away. */
const saw = (hz: number, seconds: number, amp = 0.3) =>
  Float32Array.from({ length: Math.floor(SR * seconds) }, (_, i) => amp * (2 * ((hz * i) / SR - Math.floor((hz * i) / SR + 0.5))));

/** Amplitude of the `hz` component over a slice (Goertzel). */
function tone(x: ArrayLike<number>, hz: number, from = 0, to = x.length): number {
  const w = (2 * Math.PI * hz) / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) {
    const s = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const n = to - from;
  return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))) / n;
}

const rms = (x: ArrayLike<number>, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

/** Energy above ~1.5 kHz (one-pole high-pass), over a slice. */
function bright(x: ArrayLike<number>, from: number, to: number): number {
  let y = 0, prev = 0, s = 0;
  const a = Math.exp((-2 * Math.PI * 1500) / SR);
  for (let i = Math.max(0, from - 2000); i < to; i++) {
    y = a * (y + x[i] - prev);
    prev = x[i];
    if (i >= from) s += y * y;
  }
  return Math.sqrt(s / (to - from));
}

describe("BASS MOD model", () => {
  it("is off by default and every preset but Off turns it on", () => {
    expect(bassIsActive(DEFAULT_BASS)).toBe(false);
    for (const pr of BASS_PRESETS) expect(bassIsActive(bassPresetParams(pr)), pr.name).toBe(pr.name !== "Off");
  });

  it("presets are in range and recognised whatever the tempo", () => {
    for (const pr of BASS_PRESETS) {
      const q = bassPresetParams(pr, { bpm: 87 });
      for (const [k, v] of Object.entries(q)) expect(clampBassValue(k as never, v), `${pr.name}.${k}`).toBe(v);
      expect(matchingBassPreset(q)).toBe(pr.name);
    }
    expect(matchingBassPreset(p({ wobble: 0.123 }))).toBeNull();
  });

  it("normalises old / broken sessions", () => {
    expect(normalizeBass(undefined)).toEqual(DEFAULT_BASS);
    expect(normalizeBass({ wobble: 5, rate: 2.6, bpm: "fast", cutoff: 1 })).toEqual({ ...DEFAULT_BASS, wobble: 1, rate: 3, cutoff: 40 });
  });

  it("the rate table is the core's", () => {
    const coreRates = new Function(`${coreSource.replace(/^export /gm, "")}\nreturn BASS_RATE_BEATS;`)() as number[];
    expect(coreRates).toEqual(BASS_RATE_BEATS);
    expect(BASS_RATE_BEATS.length).toBe(BASS_RATES.length);
  });

  it("the cutoff slider is logarithmic and round-trips", () => {
    const spec = BASS_SPECS.find((s) => s.key === "cutoff")!;
    expect(bassToSlider(spec, 40)).toBeCloseTo(0);
    expect(bassToSlider(spec, 20000)).toBeCloseTo(1000);
    expect(Math.abs(bassFromSlider(spec, bassToSlider(spec, 1000)) - 1000)).toBeLessThanOrEqual(1);
  });
});

describe("BASS MOD DSP (public/bass-core.js)", () => {
  it("WOBBLE sweeps the filter in time with the song: open on the beat, shut between", () => {
    // 120 BPM, 1/4 → 2 Hz: the filter is open at each beat (0, 0.5 s…) and shut half way.
    const [l] = run(p({ wobble: 1, cutoff: 4000, reso: 0.3, rate: 2, bpm: 120 }), saw(110, 2));
    const open = bright(l, SR * 1.0, SR * 1.03); // beat 3
    const shut = bright(l, SR * 1.23, SR * 1.26); // between beats
    expect(open / shut).toBeGreaterThan(5);
  });

  it("the LFO is locked to song time, not to when processing started", () => {
    const x = saw(110, 1);
    const q = p({ wobble: 0.8, cutoff: 2000, rate: 3, bpm: 120 }); // 1/8 = 4 Hz
    const [a] = run(q, x, x, 0);
    const [b] = run(q, x, x, 0.25); // one whole cycle later: same sweep
    const [c] = run(q, x, x, 0.125); // half a cycle: opposite sweep
    let dab = 0, dac = 0;
    for (let i = SR * 0.2; i < SR * 0.8; i++) {
      dab = Math.max(dab, Math.abs(a[i] - b[i]));
      dac = Math.max(dac, Math.abs(a[i] - c[i]));
    }
    expect(dab).toBeLessThan(1e-9);
    expect(dac).toBeGreaterThan(0.05);
  });

  it("TALK opens the filter with each hit", () => {
    // Decaying saw "808" hits every 0.5 s: brighter right after each hit than with TALK off.
    const x = Float32Array.from({ length: SR }, (_, i) => {
      const t = (i / SR) % 0.5;
      return 0.4 * Math.exp(-t * 6) * (2 * ((55 * t) % 1) - 1);
    });
    const [off] = run(p({ cutoff: 200 }), x);
    const [talk] = run(p({ cutoff: 200, env: 1 }), x);
    // The 20th harmonic (1.1 kHz), just after the hit at 0.5 s.
    const h20 = (y: ArrayLike<number>) => tone(y, 1100, SR * 0.5, SR * 0.6);
    expect(h20(talk)).toBeGreaterThan(5 * h20(off));
  });

  it("DEEPEN reinforces the bass's own fundamental (in phase), or adds the octave below", () => {
    const x = sine(50, 2);
    const [same] = run(p({ deepen: 1 }), x);
    expect(tone(same, 50, SR, 2 * SR) / tone(x, 50, SR, 2 * SR)).toBeGreaterThan(1.6);
    // A 808 that glides: the sine follows it.
    const glide = new Float32Array(SR * 2);
    let ph = 0;
    for (let i = 0; i < glide.length; i++) {
      ph += (60 - 20 * (i / glide.length)) / SR;
      glide[i] = 0.3 * Math.sin(2 * Math.PI * ph);
    }
    const [g] = run(p({ deepen: 1 }), glide);
    expect(rms(g, SR * 1.5, SR * 2)).toBeGreaterThan(1.5 * rms(glide, SR * 1.5, SR * 2));
    const [oct] = run(p({ deepen: 1, octave: 1 }), x);
    expect(tone(oct, 25, SR, 2 * SR)).toBeGreaterThan(0.1);
    expect(tone(x, 25, SR, 2 * SR)).toBeLessThan(0.01);
  });

  it("GRIT adds harmonics a phone speaker can play", () => {
    const x = sine(55, 1, 0.4);
    const [g] = run(p({ grit: 1 }), x);
    const harm = (y: ArrayLike<number>) => tone(y, 330, SR / 2, SR) + tone(y, 385, SR / 2, SR) + tone(y, 495, SR / 2, SR);
    expect(harm(g)).toBeGreaterThan(20 * harm(x) + 0.01);
  });

  it("WIDEN spreads the top into stereo and keeps the sub mono", () => {
    const hi = sine(1000, 1);
    const [l, r] = run(p({ widen: 1 }), hi);
    const side = (a: Float64Array, b: Float64Array) => rms(a.map((v, i) => v - b[i]), SR / 2, SR);
    expect(side(l, r)).toBeGreaterThan(0.1 * rms(l, SR / 2, SR));
    const sub = sine(45, 1);
    const [sl, sr] = run(p({ widen: 1 }), sub);
    expect(side(sl, sr)).toBeLessThan(0.02 * rms(sl, SR / 2, SR));
  });

  it("PUMP ducks at the start of every cycle and recovers", () => {
    const x = sine(80, 2);
    const [l] = run(p({ pump: 1, rate: 2, bpm: 120 }), x); // a duck every 0.5 s
    expect(rms(l, SR * 1.0, SR * 1.02)).toBeLessThan(0.25 * rms(l, SR * 1.4, SR * 1.48));
  });

  it("VIBRATO bends the pitch at the LFO rate", () => {
    const x = sine(100, 2);
    const [l] = run(p({ vibrato: 1, rate: 2, bpm: 120 }), x);
    const periods: number[] = [];
    let last = -1;
    for (let i = SR; i < 2 * SR; i++) {
      if (l[i - 1] < 0 && l[i] >= 0) {
        const at = i - 1 + l[i - 1] / (l[i - 1] - l[i]);
        if (last >= 0) periods.push(at - last);
        last = at;
      }
    }
    const spread = Math.max(...periods) / Math.min(...periods);
    expect(spread).toBeGreaterThan(1.01); // > ±~17 cents of swing
    expect(spread).toBeLessThan(1.1);
  });

  it("never goes over the ceiling, even fully cranked", () => {
    const x = saw(40, 1, 0.9);
    const [l, r] = run(p({ wobble: 1, cutoff: 300, reso: 1, deepen: 1, octave: 1, grit: 1, widen: 1, output: 12, env: 1 }), x);
    for (let i = 0; i < l.length; i++) {
      expect(Number.isFinite(l[i]) && Number.isFinite(r[i])).toBe(true);
      expect(Math.abs(l[i])).toBeLessThanOrEqual(0.98);
    }
  });
});

const ADDON = new URL("../../native/ggmm-engine.node", import.meta.url).pathname;
const native = existsSync(ADDON)
  ? (createRequire(import.meta.url)(ADDON) as {
      processModule(kind: string, params: string, inputs: Float32Array[], outCh: number, sr: number): Float32Array[];
    })
  : null;

describe.skipIf(!native)("BASS MOD Rust port (native/src/bass.rs)", () => {
  // An 808-ish line: gliding sine hits plus a saw layer, slightly stereo.
  const n = SR * 2;
  const L = new Float32Array(n), R = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = (i / SR) % 0.5;
    ph += (45 + 40 * Math.exp(-t * 20)) / SR;
    const v = 0.5 * Math.exp(-t * 3) * Math.sin(2 * Math.PI * ph) + 0.1 * (2 * (ph % 1) - 1);
    L[i] = v;
    R[i] = v * 0.9 + 0.02 * Math.sin((2 * Math.PI * 3000 * i) / SR);
  }

  for (const preset of BASS_PRESETS.filter((x) => x.name !== "Off")) {
    it(`"${preset.name}" matches the JS core`, () => {
      const q0 = bassPresetParams(preset, { bpm: 128 });
      const q = Object.fromEntries(Object.entries(q0).map(([k, v]) => [k, Math.fround(v)])) as unknown as BassParams;
      const t0 = 3.21;
      const [nl, nr] = native!.processModule("bass", JSON.stringify({ ...q, t0 }), [L, R], 2, SR);
      const [jl, jr] = run(q, L, R, t0);
      let err = 0, sig = 0;
      for (let i = 0; i < n; i++) {
        err = Math.max(err, Math.abs(nl[i] - jl[i]), Math.abs(nr[i] - jr[i]));
        sig = Math.max(sig, Math.abs(jl[i]));
      }
      expect(err / sig).toBeLessThan(1e-3);
    });
  }
});
