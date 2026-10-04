import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import coreSource from "../../public/fxbus-core.js?raw";
import { FX_EFFECTS, DEFAULT_FX_BUSES, fxBusesOf, fxDepth, fxSpec, normalizeFxBuses } from "./fxbus";

const SR = 48000;
type Set = Partial<{ effect: number; a: number; b: number; depth: number }>;
interface Core {
  set(p: Set): void;
  process(l: Float32Array, r: Float32Array, n: number): void;
}
const Core = new Function("sampleRate", `${coreSource.replace(/^export /gm, "")}\nreturn FxBusCore;`)(SR) as new (sr: number) => Core;

/** Drums + bass + a held chord, stereo, 2 s: something every effect changes. */
function music(seconds = 2): Float32Array[] {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n), r = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const beat = t % 0.25;
    const kick = Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-beat / 0.03)) * beat) * Math.exp(-beat / 0.12);
    const hat = (i % 6000 < 1500 ? rnd() * Math.exp(-(i % 6000) / 300) : 0) * 0.3;
    const chord = 0.12 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t));
    l[i] = 0.5 * kick + hat + chord;
    r[i] = 0.5 * kick - hat * 0.5 + chord * 0.9;
  }
  return [l, r];
}

/** Run the JS core in 128-frame quanta, applying `script` changes first. */
function runJs(first: Set, script: [number, Set][], input: Float32Array[]): Float32Array[] {
  const core = new Core(SR);
  core.set(first);
  const [l, r] = input.map((c) => c.slice());
  for (let i = 0, q = 0; i < l.length; i += 128, q++) {
    for (const [k, s] of script) if (k === q) core.set(s);
    const n = Math.min(128, l.length - i);
    core.process(l.subarray(i, i + n), r.subarray(i, i + n), n);
  }
  return [l, r];
}

const rms = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const diff = (a: Float32Array, b: Float32Array) => {
  const d = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) d[i] = a[i] - b[i];
  return d;
};

describe("FX bus model", () => {
  it("defaults, normalising and specs", () => {
    expect(fxBusesOf({})).toEqual(DEFAULT_FX_BUSES);
    const n = normalizeFxBuses([{ effect: "echo", a: 9, b: -1 }, { effect: "nope" }]);
    expect(n).toHaveLength(4);
    expect(n![0]).toEqual({ effect: "echo", a: 1, b: 0 });
    expect(n![1].effect).toBe(DEFAULT_FX_BUSES[1].effect);
    expect(normalizeFxBuses(undefined)).toBeUndefined();
    expect(fxSpec({ effect: "looper", a: 0.1, b: 0.2 })).toEqual({ effect: 6, a: 0.1, b: 0.2 });
    expect(fxDepth({ on: true, grab: 0.2 })).toBe(1);
    expect(fxDepth({ on: false, grab: 0.2 })).toBe(0.2);
  });
});

describe("FX bus core (public/fxbus-core.js)", () => {
  const input = music();
  it("every effect is dry at depth 0 (echo: nothing fed in) and changes the sound engaged", () => {
    for (let e = 1; e < FX_EFFECTS.length; e++) {
      const [dl] = runJs({ effect: e, a: 0.7, b: 0.7, depth: 0 }, [], input);
      const [wl] = runJs({ effect: e, a: 0.7, b: 0.7, depth: 1 }, [], input);
      const dry = rms(diff(dl, input[0])) / rms(input[0]);
      const wet = rms(diff(wl, input[0])) / rms(input[0]);
      expect(dry, `${FX_EFFECTS[e]} dry`).toBeLessThan(1e-6);
      expect(wet, `${FX_EFFECTS[e]} wet`).toBeGreaterThan(0.05);
    }
  });

  it("engaging glides in (no click)", () => {
    const [l] = runJs({ effect: 3, a: 1, b: 1, depth: 0 }, [[40, { depth: 1 }]], input);
    const e = diff(l, input[0]);
    // 1 ms after engaging the change is still small; 100 ms after, full.
    expect(rms(e, 40 * 128, 40 * 128 + 48)).toBeLessThan(rms(e, 40 * 128 + 4800, 40 * 128 + 9600) * 0.3);
  });

  it("echo rings on after it's released", () => {
    const [l] = runJs({ effect: 5, a: 0.3, b: 0.6, depth: 1 }, [[200, { depth: 0 }]], input);
    const tail = rms(diff(l, input[0]), 220 * 128, 260 * 128);
    expect(tail).toBeGreaterThan(0.01);
  });

  it("the looper repeats a moment while engaged, and lets go", () => {
    // Loop length at A = 0.6: 0.5 s × 2^-3 = 62.5 ms = 3000 frames.
    const [l] = runJs({ effect: 6, a: 0.6, b: 0.5, depth: 0 }, [[300, { depth: 1 }], [600, { depth: 0 }]], input);
    const at = 300 * 128 + 14400; // 300 ms in: the 20 ms glide is done
    let same = 0;
    for (let i = 0; i < 2000; i++) if (Math.abs(l[at + i] - l[at + i + 3000]) < 1e-3) same++;
    // All but the 64-frame fades at the loop's ends.
    expect(same).toBeGreaterThan(1800);
    // Released: back to the dry input.
    const end = 600 * 128 + 4800;
    expect(rms(diff(l, input[0]), end, end + 4800)).toBeLessThan(1e-3);
  });

  it("lo-fi at full crush has few distinct levels", () => {
    const [l] = runJs({ effect: 3, a: 1, b: 0, depth: 1 }, [], input);
    expect(new Set(l.subarray(4800, 48000)).size).toBeLessThan(40);
  });
});

const ADDON = new URL("../../native/ggmm-engine.node", import.meta.url).pathname;
const native = existsSync(ADDON)
  ? (createRequire(import.meta.url)(ADDON) as { processModule(k: string, p: string, i: Float32Array[], o: number, sr: number): Float32Array[] })
  : null;

describe.skipIf(!native)("FX bus Rust port (native/src/fxbus.rs)", () => {
  const input = music();
  // Every effect, at two settings, engaged part-way and released again,
  // with a macro move in the middle.
  for (let e = 1; e < FX_EFFECTS.length; e++) {
    for (const [a, b] of [
      [0.2, 0.8],
      [0.8, 0.3],
    ]) {
      it(`${FX_EFFECTS[e]} a=${a} b=${b} matches the worklet`, () => {
        const first = { effect: e, a, b, depth: 0 };
        const script: [number, Set][] = [
          [50, { depth: 1 }],
          [300, { a: b, b: a }],
          [550, { depth: 0.4 }],
          [650, { depth: 0 }],
        ];
        const js = runJs(first, script, input);
        const [nl, nr] = native!.processModule("fxbus", JSON.stringify({ ...first, script }), input, 2, SR);
        for (const [x, y] of [
          [js[0], nl],
          [js[1], nr],
        ]) {
          const err = rms(diff(x, y)) / rms(x);
          expect(err, `${FX_EFFECTS[e]} error`).toBeLessThan(1e-3);
        }
      });
    }
  }
});
