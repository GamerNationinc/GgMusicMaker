// The native engine (native/, Rust) against the JS reference DSP. Skipped
// when the addon hasn't been built (scripts/build-native.sh).
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import coreSource from "../../public/punch-core.js?raw";
import { PUNCH_PRESETS, punchPresetParams, type PunchCoreCtor, type PunchParams } from "../fx/punch";
import bassSource from "../../public/bass-core.js?raw";
import { BASS_PRESETS, bassPresetParams, type BassCoreCtor, type BassParams } from "../fx/bass";

const ADDON = new URL("../../native/ggmm-engine.node", import.meta.url).pathname;
const has = existsSync(ADDON);
const native = has ? (createRequire(import.meta.url)(ADDON) as {
  renderOffline(project: string, ids: string[], rates: number[], data: Float32Array[][], sr: number, tail: number): Promise<Float32Array[]>;
}) : null;
/** The master is a DynamicsCompressorNode twin, which applies automatic
 *  makeup gain (1 / gain at 0 dBFS)^0.6 — about +1.7 dB — like Chromium's. */
const MAKEUP = Math.pow(1 / Math.pow(10, (-3 + 3 / 20) / 20), 0.6);
/** …and delays the mix 6 ms (its look-ahead), like Chromium's. */
const AHEAD = Math.round(48000 * 0.006);
const SR = 48000;
const Core = new Function("sampleRate", `${coreSource.replace(/^export /m, "")}\nreturn PunchCore;`)(SR) as PunchCoreCtor;
const BassCore = new Function("sampleRate", `${bassSource.replace(/^export /gm, "")}\nreturn BassCore;`)(SR) as BassCoreCtor;

function beat(seconds: number): [Float32Array, Float32Array] {
  const n = Math.floor(SR * seconds);
  const l = new Float32Array(n), r = new Float32Array(n);
  let seed = 3;
  for (let i = 0; i < n; i++) {
    const t = i / SR, tk = t % 0.5;
    const kick = Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-tk * 40)) * tk) * Math.exp(-tk * 9) * 0.35;
    const hat = (((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5) * Math.exp(-(t % 0.25) * 60) * 0.25;
    l[i] = kick + 0.1 * Math.sin(2 * Math.PI * 82 * t) + hat;
    r[i] = kick + 0.1 * Math.sin(2 * Math.PI * 82 * t) - hat * 0.5;
  }
  return [l, r];
}

const track = (over: object) => ({
  id: "t1", gain: 1, pan: 0, width: 1, eq: null, punch: null, bass: null, morph: null, synth: null, send: 0, sendPan: 0, sendWidth: 1,
  clips: [{ buffer: "b", start: 0, offset: 0, duration: 2 }], ...over,
});
const render = (tracks: object[], master: number, input: [Float32Array, Float32Array]) =>
  native!.renderOffline(JSON.stringify({ tracks, masterGain: master }), ["b"], [SR], [[input[0], input[1]]], SR, 0);

describe.skipIf(!has)("native engine (Rust)", () => {
  const input = beat(2);

  it("a plain layer renders the clip unchanged (below the threshold: just the makeup gain)", async () => {
    const [l, r] = await render([track({})], 0.25, input);
    const m = Math.fround(0.25) * MAKEUP;
    for (let i = 0; i + AHEAD < input[0].length; i += 97) {
      expect(l[i + AHEAD]).toBeCloseTo(input[0][i] * m, 4);
      expect(r[i + AHEAD]).toBeCloseTo(input[1][i] * m, 4);
    }
  });

  for (const name of ["Tight Kick", "808 Boom", "Snap Drums", "Lo-Fi Crush", "Blown Out"]) {
    it(`PUNCH "${name}" matches the JS core sample for sample`, async () => {
      const p0 = punchPresetParams(PUNCH_PRESETS.find((x) => x.name === name)!) as PunchParams;
      // What the worklet sees: AudioParams are f32.
      const p = Object.fromEntries(Object.entries(p0).map(([k, v]) => [k, Math.fround(v)])) as unknown as PunchParams;
      const m = Math.fround(0.05) * MAKEUP; // keep the compressor below threshold
      const [l, r] = await render([track({ punch: p })], 0.05, input);
      const core = new Core(SR);
      core.set(p);
      let maxErr = 0;
      for (let i = 0; i + AHEAD < input[0].length; i++) {
        core.step(input[0][i], input[1][i]);
        maxErr = Math.max(maxErr, Math.abs(l[i + AHEAD] / m - core.l), Math.abs(r[i + AHEAD] / m - core.r));
      }
      expect(maxErr).toBeLessThan(2e-4);
    });
  }

  it("BASS MOD in the mixer matches the JS core, its LFO locked to song time", async () => {
    const p0 = bassPresetParams(BASS_PRESETS.find((x) => x.name === "Festival")!);
    const p = Object.fromEntries(Object.entries(p0).map(([k, v]) => [k, Math.fround(v)])) as unknown as BassParams;
    const m = Math.fround(0.05) * MAKEUP;
    const [l, r] = await render([track({ bass: p })], 0.05, input);
    const core = new BassCore(SR);
    core.set(p);
    let maxErr = 0;
    for (let i = 0; i + AHEAD < input[0].length; i++) {
      if (i % 128 === 0) core.block(i / SR);
      core.step(input[0][i], input[1][i]);
      maxErr = Math.max(maxErr, Math.abs(l[i + AHEAD] / m - core.l), Math.abs(r[i + AHEAD] / m - core.r));
    }
    expect(maxErr).toBeLessThan(2e-4);
  });

  it("BASS MOD's LFO counts from bar 1 (barOrigin), like the worklet's songT0", async () => {
    const p0 = bassPresetParams(BASS_PRESETS.find((x) => x.name === "Festival")!);
    const p = Object.fromEntries(Object.entries(p0).map(([k, v]) => [k, Math.fround(v)])) as unknown as BassParams;
    const m = Math.fround(0.05) * MAKEUP;
    const origin = 0.3125; // bar 1 a little into the song
    const [l, r] = await native!.renderOffline(
      JSON.stringify({ tracks: [track({ bass: p })], masterGain: 0.05, barOrigin: origin }),
      ["b"], [SR], [[input[0], input[1]]], SR, 0,
    );
    const core = new BassCore(SR);
    core.set(p);
    let maxErr = 0;
    for (let i = 0; i + AHEAD < input[0].length; i++) {
      if (i % 128 === 0) core.block(i / SR - origin);
      core.step(input[0][i], input[1][i]);
      maxErr = Math.max(maxErr, Math.abs(l[i + AHEAD] / m - core.l), Math.abs(r[i + AHEAD] / m - core.r));
    }
    expect(maxErr).toBeLessThan(2e-4);
  });

  it("mute (gain 0) is silent; pan hard left empties the right channel", async () => {
    const [, r0] = await render([track({ gain: 0 })], 0.5, input);
    expect(r0.every((v) => v === 0)).toBe(true);
    const [l, r] = await render([track({ pan: -1 })], 0.25, input);
    expect(Math.max(...r.map(Math.abs))).toBeLessThan(1e-6);
    expect(Math.max(...l.map(Math.abs))).toBeGreaterThan(0.05);
  });

  it("EQ low cut removes the bass", async () => {
    const low = (a: Float32Array) => {
      let y = 0, s = 0;
      const k = 1 - Math.exp((-2 * Math.PI * 100) / SR);
      for (const v of a) { y += k * (v - y); s += y * y; }
      return Math.sqrt(s / a.length);
    };
    const [dry] = await render([track({})], 0.25, input);
    const [cut] = await render([track({ eq: { low: 0, mid: 0, high: 0, lowCut: 1000, highCut: 20000 } })], 0.25, input);
    expect(low(cut)).toBeLessThan(low(dry) * 0.15);
  });

  it("the master compressor holds a hot mix under full scale", async () => {
    const [l] = await render([track({ punch: punchPresetParams(PUNCH_PRESETS.find((x) => x.name === "Speaker Killer")!) })], 1.5, input);
    expect(Math.max(...l.map(Math.abs))).toBeLessThan(1);
  });

  it("resamples a 44.1 kHz buffer onto a 48 kHz mix at the right length", async () => {
    const n = 44100;
    const tone = new Float32Array(n).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 441 * i) / 44100));
    const [l] = await native!.renderOffline(JSON.stringify({ tracks: [track({ clips: [{ buffer: "b", start: 0, offset: 0, duration: 1 }] })], masterGain: 1 }), ["b"], [44100], [[tone]], SR, 0);
    expect(l.length).toBe(SR);
    // 441 Hz tone → 441 zero-crossings up per second at either rate.
    let ups = 0;
    for (let i = 1; i < SR; i++) if (l[i - 1] < 0 && l[i] >= 0) ups++;
    // The first 6 ms are the compressor's look-ahead (silence), so ~438 of the 441.
    expect(Math.abs(ups - 441 * (1 - AHEAD / SR))).toBeLessThanOrEqual(1);
  });
});
