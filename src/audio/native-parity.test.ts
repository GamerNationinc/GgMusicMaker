// Parity: every ported worklet (public/*.js) against its Rust port
// (native/src/*.rs), on the same audio, preset by preset, stereo and 7.1.
// JS and Rust use different sin/pow/exp implementations, so bit-identity is
// impossible; the bar is the error relative to the signal (≤ 0.1 % for the
// deterministic engines; chaotic/feedback ones are held to their level and
// their first 50 ms). Skipped when the addon isn't built.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import synthSrc from "../../public/voice-synth-processor.js?raw";
import morphSrc from "../../public/morph-processor.js?raw";
import placerSrc from "../../public/placer-processor.js?raw";
import binauralSrc from "../../public/binaural-processor.js?raw";
import liveSrc from "../../public/live-processor.js?raw";
import type { LiveEvent } from "./live";
import djSrc from "../../public/dj-processor.js?raw";
import type { DjEvent } from "./dj";
import { DEFAULT_SYNTH, SYNTH_PRESETS, presetParams } from "../fx/voice-synth";
import { DEFAULT_MORPH, MORPH_PRESETS, morphPresetParams } from "../fx/morph";
import { impulseChannels, type ReverbSpace } from "./reverb";

const ADDON = new URL("../../native/ggmm-engine.node", import.meta.url).pathname;
const has = existsSync(ADDON);
type Native = { processModule(kind: string, params: string, inputs: Float32Array[], outCh: number, sr: number): Float32Array[] };
const native = has ? (createRequire(import.meta.url)(ADDON) as Native) : null;
const SR = 48000;

type Proc = { process(i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>): boolean };
function load(src: string, name: string): new () => Proc {
  const reg: Record<string, new () => Proc> = {};
  new Function("sampleRate", "AudioWorkletProcessor", "registerProcessor", src)(SR, class {}, (n: string, c: new () => Proc) => (reg[n] = c));
  return reg[name];
}

/** Run a JS worklet in 128-frame quanta. */
function runJs(Cls: new () => Proc, params: Record<string, number>, inputs: Float32Array[], outCh: number): Float32Array[] {
  const proc = new Cls();
  const len = inputs[0].length;
  const out = Array.from({ length: outCh }, () => new Float32Array(len));
  const p: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(params)) p[k] = new Float32Array([v]);
  for (let i = 0; i < len; i += 128) {
    const q = Math.min(128, len - i);
    const o = out.map(() => new Float32Array(q));
    proc.process([inputs.map((c) => c.subarray(i, i + q))], [o], p);
    o.forEach((c, k) => out[k].set(c, i));
  }
  return out;
}

/** A sung-ish voice: gliding pulse train through two resonances, stereo. */
function voice(seconds: number): Float32Array[] {
  const n = Math.floor(SR * seconds);
  const l = new Float32Array(n), r = new Float32Array(n);
  let y1 = 0, y2 = 0, z1 = 0, z2 = 0, ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (150 + 30 * Math.sin(2 * Math.PI * 0.7 * t)) / SR;
    const pulse = ph >= 1 ? ((ph -= 1), 1) : 0;
    const y = pulse + 1.6 * Math.cos((2 * Math.PI * 700) / SR) * 0.97 * y1 - 0.94 * y2;
    y2 = y1; y1 = y;
    const z = pulse + 1.9 * Math.cos((2 * Math.PI * 1800) / SR) * 0.98 * z1 - 0.96 * z2;
    z2 = z1; z1 = z;
    const v = (y + 0.5 * z) * Math.min(1, t / 0.05) * 0.1;
    l[i] = v;
    r[i] = v * 0.9 + 0.01 * Math.sin(i * 0.05);
  }
  return [l, r];
}

const rms = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
/** Worst channel's ‖native − js‖ / ‖js‖ over [from, to). */
function relErr(js: Float32Array[], nat: Float32Array[], from = 0, to = js[0].length): number {
  let worst = 0;
  js.forEach((j, c) => {
    const ref = rms(j, from, to);
    if (ref < 1e-6) {
      worst = Math.max(worst, rms(nat[c], from, to) > 1e-5 ? 1 : 0);
      return;
    }
    let s = 0;
    for (let i = from; i < to; i++) s += (j[i] - nat[c][i]) ** 2;
    worst = Math.max(worst, Math.sqrt(s / (to - from)) / ref);
  });
  return worst;
}
const levelRatio = (js: Float32Array[], nat: Float32Array[]) => {
  const a = Math.sqrt(js.reduce((s, c) => s + rms(c) ** 2, 0));
  const b = Math.sqrt(nat.reduce((s, c) => s + rms(c) ** 2, 0));
  return b / a;
};

describe.skipIf(!has)("Rust ports match the JS worklets", () => {
  const input = voice(1.2);

  describe("VOICE SYNTH", () => {
    const Synth = load(synthSrc, "voice-synth-processor");
    const cases = [
      ...SYNTH_PRESETS.filter((p) => p.name !== "Off").map((p) => ({ name: p.name, params: presetParams(p) })),
      { name: "everything stacked", params: { ...DEFAULT_SYNTH, mix: 1, pitch: 3, vocoder: 0.5, talkbox: 0.5, compuvox: 0.3, polyvox: 0.6, chord: 6, unison: 8, sub: 0.5, shimmer: 0.5, ring: 60, ensemble: 0.5, diffuse: 0.5 } },
    ];
    for (const nCh of [2, 8]) {
      for (const c of cases) {
        it(`${c.name} (${nCh} ch)`, () => {
          const js = runJs(Synth, c.params as unknown as Record<string, number>, input, nCh);
          const nat = native!.processModule("synth", JSON.stringify(c.params), input, nCh, SR);
          const e = relErr(js, nat);
          expect(e, `rel err ${e.toExponential(2)}`).toBeLessThan(1e-3);
        });
      }
    }
  });

  describe("MORPH", () => {
    const Morph = load(morphSrc, "morph-processor");
    // Chaotic or feedback engines drift apart from ulp-level libm differences.
    const loose = new Set(["Lorenz Flight", "Strange Weather", "FM Growl"]);
    for (const nCh of [2, 8]) {
      for (const p of MORPH_PRESETS.filter((x) => x.name !== "Off")) {
        it(`${p.name} (${nCh} ch)`, () => {
          const params = morphPresetParams(p);
          const js = runJs(Morph, params as unknown as Record<string, number>, input, nCh);
          const nat = native!.processModule("morph", JSON.stringify(params), input, nCh, SR);
          if (loose.has(p.name)) {
            expect(relErr(js, nat, 0, SR * 0.05)).toBeLessThan(1e-3);
            expect(Math.abs(Math.log10(levelRatio(js, nat)))).toBeLessThan(0.05);
          } else {
            const e = relErr(js, nat);
            expect(e, `rel err ${e.toExponential(2)}`).toBeLessThan(1e-3);
          }
        });
      }
    }
    it("every engine at its defaults (8 ch)", () => {
      for (let algo = 0; algo < 8; algo++) {
        const params = { ...DEFAULT_MORPH, mix: 1, algo, c: algo === 7 ? 0 : 0.5 };
        const js = runJs(Morph, params as unknown as Record<string, number>, input, 8);
        const nat = native!.processModule("morph", JSON.stringify(params), input, 8, SR);
        expect(relErr(js, nat, 0, algo === 5 ? SR * 0.05 : undefined), `algo ${algo}`).toBeLessThan(1e-3);
      }
    });
  });

  it("placer (pan/width), stereo and surround", () => {
    const Placer = load(placerSrc, "placer-processor");
    for (const [nCh, pan, width] of [[2, -0.6, 1.5], [2, 1, 0], [6, 0.3, 0.7], [8, -1, 2], [8, 0.25, 1]] as const) {
      const inp = nCh === 2 ? input : Array.from({ length: nCh }, (_, c) => input[c % 2].map((v) => v * (1 - c * 0.1)));
      const js = runJs(Placer, { pan, width }, inp, nCh);
      const nat = native!.processModule("placer", JSON.stringify({ pan, width }), inp, nCh, SR);
      expect(relErr(js, nat), `${nCh} ch pan ${pan} width ${width}`).toBeLessThan(1e-5);
    }
  });

  it("binaural monitor, 5.1 and 7.1", () => {
    const Bin = load(binauralSrc, "binaural-processor");
    for (const nCh of [6, 8]) {
      const inp = Array.from({ length: nCh }, (_, c) => input[c % 2].map((v, i) => v * Math.sin(i * 0.001 * (c + 1))));
      const js = runJs(Bin, {}, inp, 2);
      const nat = native!.processModule("binaural", "{}", inp, 2, SR);
      expect(relErr(js, nat), `${nCh} ch`).toBeLessThan(1e-5);
    }
  });

  for (const space of ["room", "hall", "plate"] as ReverbSpace[]) {
    it(`reverb ${space}: impulse response = the web IR, normalised like ConvolverNode, one quantum late`, () => {
      const ir = impulseChannels(space, SR);
      let power = 0;
      for (const c of ir) for (const v of c) power += v * v;
      power = Math.max(0.000125, Math.sqrt(power / (2 * ir[0].length)));
      const scale = (1 / power) * 0.00125 * (44100 / SR);
      const len = ir[0].length + 4096;
      const imp = [new Float32Array(len), new Float32Array(len)];
      imp[0][0] = 1;
      imp[1][0] = 1;
      const [l, r] = native!.processModule("reverb", JSON.stringify({ space }), imp, 2, SR);
      const shift = 128;
      const expL = new Float32Array(len), expR = new Float32Array(len);
      for (let i = 0; i < ir[0].length; i++) {
        expL[i + shift] = ir[0][i] * scale;
        expR[i + shift] = ir[1][i] * scale;
      }
      expect(relErr([expL, expR], [l, r])).toBeLessThan(1e-5);
    });
  }

  describe("live instrument", () => {
    type LiveProc = { event(e: LiveEvent): void; process(i: Float32Array[][], o: Float32Array[][]): boolean };
    const Live = load(liveSrc, "live-processor") as unknown as new () => LiveProc;
    const ctl = (o: Partial<Extract<LiveEvent, { t: "ctl" }>>): LiveEvent => ({ t: "ctl", bend: 0, mod: 0, cutoff: 0.7, send: 0.3, expr: 1, sustain: false, ...o });
    /** [quantum, event] — a little performance touching every path. */
    const script: [number, LiveEvent][] = [
      [0, ctl({ send: 0.4 })],
      [2, { t: "on", id: 1, note: 60, vel: 0.9, patch: 0 }],
      [2, { t: "on", id: 2, note: 64, vel: 0.7, patch: 1 }],
      [5, { t: "drum", kind: 0, vel: 1 }],
      [9, { t: "drum", kind: 1, vel: 0.8 }],
      [12, { t: "drum", kind: 2, vel: 0.6 }],
      [15, { t: "drum", kind: 3, vel: 0.7 }],
      [40, ctl({ bend: 1.5, mod: 0.6, cutoff: 0.4, send: 0.1, expr: 0.7, sustain: true })],
      [60, { t: "glide", id: 1, note: 67 }],
      [80, { t: "on", id: 3, note: 43, vel: 1, patch: 3 }],
      [90, { t: "on", id: 4, note: 72, vel: 0.5, patch: 2 }],
      [120, { t: "off", id: 1 }],
      [130, { t: "off", id: 2 }],
      [200, ctl({ sustain: false })],
      [260, { t: "off", id: 3 }],
      [300, { t: "off", id: 4 }],
    ];
    it("plays a scripted performance the same (dry + send)", () => {
      const len = SR * 1.2;
      const js = Array.from({ length: 4 }, () => new Float32Array(len));
      const proc = new Live();
      for (let i = 0, k = 0; i < len; i += 128, k++) {
        for (const [at, e] of script) if (at === k) proc.event(e);
        const q = Math.min(128, len - i);
        const o = [[new Float32Array(q), new Float32Array(q)], [new Float32Array(q), new Float32Array(q)]];
        proc.process([], o);
        o.flat().forEach((c, n) => js[n].set(c, i));
      }
      const nat = native!.processModule("live", JSON.stringify({ events: script }), [new Float32Array(len)], 4, SR);
      expect(rms(js[0])).toBeGreaterThan(0.01);
      expect(rms(js[2])).toBeGreaterThan(0.001);
      const e = relErr(js, nat);
      expect(e, `rel err ${e.toExponential(2)}`).toBeLessThan(1e-3);
    });
  });

  describe("DJ decks", () => {
    type DjProc = { core: { load(d: number, b: { rate: number; channels: Float32Array[] }): void; event(e: DjEvent): void }; process(i: Float32Array[][], o: Float32Array[][]): boolean; port: unknown };
    const Dj = load(djSrc, "dj-processor") as unknown as new () => DjProc;
    /** [quantum, event] — a little mix touching every path: play, tempo,
     *  nudge, EQ (kill and boost), faders, crossfade, a loop, a scratch
     *  backwards, a seek, stop. */
    const script: [number, DjEvent][] = [
      [0, { t: "play", deck: 0, on: true }],
      [0, { t: "xfade", x: -0.6 }],
      [30, { t: "play", deck: 1, on: true }],
      [30, { t: "rate", deck: 1, rate: 1.06 }],
      [60, { t: "eq", deck: 0, low: -60, mid: 2, high: -6 }],
      [90, { t: "nudge", deck: 1, amount: 0.04 }],
      [110, { t: "nudge", deck: 1, amount: 0 }],
      [120, { t: "xfade", x: 0.4 }],
      [130, { t: "vol", deck: 0, v: 0.5 }],
      [140, { t: "loop", deck: 1, from: 0.6, to: 0.85 }],
      [200, { t: "scratch", deck: 0, on: true, speed: -1.5 }],
      [230, { t: "scratch", deck: 0, on: true, speed: 2.2 }],
      [250, { t: "scratch", deck: 0, on: false, speed: 0 }],
      [260, { t: "seek", deck: 0, time: 0.2 }],
      [270, { t: "phase", deck: 1, beat: 0.48, first: 0.1, to: 0, toBeat: 0.5, toFirst: 0.05 }],
      [300, { t: "eq", deck: 0, low: 6, mid: 0, high: 0 }],
      [340, { t: "loop", deck: 1, from: 0, to: 0 }],
      [380, { t: "play", deck: 0, on: false }],
    ];
    it("plays a scripted mix the same", () => {
      const bufRate = 44100;
      const tracks = [...voice(3), ...voice(3).map((c) => c.map((v, i) => v * Math.sin(i * 0.001)))];
      const len = Math.floor(SR * 1.2);
      const js = [new Float32Array(len), new Float32Array(len)];
      const proc = new Dj();
      proc.core.load(0, { rate: bufRate, channels: tracks.slice(0, 2) });
      proc.core.load(1, { rate: bufRate, channels: tracks.slice(2, 4) });
      for (let i = 0, k = 0; i < len; i += 128, k++) {
        for (const [at, e] of script) if (at === k) proc.core.event(e);
        const q = Math.min(128, len - i);
        const o = [[new Float32Array(q), new Float32Array(q)]];
        proc.process([], o);
        o[0].forEach((c, n) => js[n].set(c, i));
      }
      // The native module renders exactly `len` frames: pad its inputs' length.
      const ins = tracks.map((c) => c);
      const nat = native!.processModule("dj", JSON.stringify({ events: script, bufRate }), ins, 2, SR).map((c) => c.subarray(0, len));
      expect(rms(js[0])).toBeGreaterThan(0.005);
      const e = relErr(js, nat);
      expect(e, `rel err ${e.toExponential(2)}`).toBeLessThan(1e-3);
    });
  });
});
