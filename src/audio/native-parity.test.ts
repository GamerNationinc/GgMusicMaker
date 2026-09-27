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
});
