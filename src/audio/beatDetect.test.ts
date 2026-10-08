import { describe, it, expect } from "vitest";
import { detectTempo, MIN_CONFIDENCE, type BeatSource } from "./beatDetect";

const SR = 44100;
const now = () => Promise.resolve();

function source(chans: Float32Array[], sampleRate = SR): BeatSource {
  return { length: chans[0].length, numberOfChannels: chans.length, sampleRate, getChannelData: (c) => chans[c] };
}

/** A drum loop with a little life in it (velocities wobble like a played
 *  or swung-sampled loop). "four": kick on every beat, clap on 2 and 4, hats
 *  on the off-beats (house/techno). "boombap": kick on 1 and the "and" of 2,
 *  snare on 2 and 4, soft closed hats on the 8ths (hip-hop). Bar 1 starts at
 *  `start` seconds; beat 1 of each bar is the strongest kick. */
function drums(bpm: number, seconds: number, start = 0, beatsPerBar = 4, sampleRate = SR, style: "four" | "boombap" = "four"): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  const beat = 60 / bpm;
  let seed = 1;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const vel = () => 0.8 + 0.2 * rnd();
  const hit = (t: number, len: number, fn: (i: number, env: number) => number) => {
    const s0 = Math.round(t * sampleRate);
    const n = Math.round(len * sampleRate);
    const v = vel();
    for (let i = 0; i < n && s0 + i < out.length; i++) {
      if (s0 + i < 0) continue;
      out[s0 + i] += v * fn(i, Math.exp(-i / (n / 5)));
    }
  };
  const kick = (t: number, a: number) => hit(t, 0.25, (i, e) => a * e * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-i / 800)) * (i / sampleRate)));
  const snare = (t: number, a: number) => hit(t, 0.15, (i, e) => a * e * (0.6 * rnd() + 0.4 * Math.sin((2 * Math.PI * 190 * i) / sampleRate)));
  const hat = (t: number, a: number) => hit(t, 0.03, (_, e) => a * e * rnd());
  for (let k = 0; start + k * beat * 0.5 < seconds; k++) {
    const t = start + k * beat * 0.5;
    const inBar = (k / 2) % beatsPerBar; // 0, 0.5, 1, …
    const onBeat = k % 2 === 0;
    if (style === "four") {
      if (onBeat) kick(t, inBar === 0 ? 1 : 0.8);
      if (onBeat && inBar % 2 === 1) snare(t, 0.35);
      if (!onBeat) hat(t, 0.12);
    } else {
      hat(t, 0.04);
      if (inBar === 0) kick(t, 1);
      if (inBar === 1.5 && beatsPerBar === 4) kick(t, 0.6);
      if (onBeat && inBar % 2 === 1) snare(t, 0.5);
      if (beatsPerBar === 3 && inBar === 2) snare(t, 0.5);
    }
  }
  return out;
}

describe("detectTempo", () => {
  for (const [bpm, style] of [
    [120, "four"],
    [124, "four"],
    [128, "four"],
    [140, "four"],
    [84, "boombap"],
    [90, "boombap"],
    [96, "boombap"],
  ] as const) {
    it(`finds ${bpm} BPM (${style})`, async () => {
      const g = await detectTempo(source([drums(bpm, 30, 0, 4, SR, style)]), { yieldFn: now });
      expect(g).not.toBeNull();
      expect(g!.bpm).toBeCloseTo(bpm, 1);
      expect(g!.confidence).toBeGreaterThan(MIN_CONFIDENCE);
    });
  }

  it("keeps a fractional tempo", async () => {
    const g = await detectTempo(source([drums(92.5, 40, 0, 4, SR, "boombap")]), { yieldFn: now });
    expect(g!.bpm).toBeCloseTo(92.5, 1);
  });

  it("finds where the beats and the bar start", async () => {
    const bpm = 120;
    const start = 0.73; // song starts with silence; bar 1 at 0.73 s
    const g = await detectTempo(source([drums(bpm, 30, start)]), { yieldFn: now });
    const beat = 60 / bpm;
    // firstBeat is the first beat at/after 0: 0.73 − 0.5 = 0.23.
    expect(Math.abs(g!.firstBeat - (start % beat))).toBeLessThan(0.012);
    const bar = 4 * beat;
    const d = Math.abs(((g!.downbeat - start) % bar + bar) % bar);
    expect(Math.min(d, bar - d)).toBeLessThan(0.012);
  });

  it("reads stereo, other sample rates and a clip's slice of its buffer", async () => {
    const sr = 48000;
    const l = drums(128, 40, 0.1, 4, sr);
    const r = l.map((v) => v * 0.5);
    const startSample = 10 * sr; // the clip starts 10 s into its buffer
    const g = await detectTempo(source([l, r], sr), { startSample, yieldFn: now });
    expect(g!.bpm).toBeCloseTo(128, 1);
    const beat = 60 / 128;
    // Beats in buffer time are 0.1 + k·beat; relative to the clip start, 10 s.
    const expected = (((0.1 - 10) % beat) + beat) % beat;
    expect(Math.abs(g!.firstBeat - expected)).toBeLessThan(0.012);
  });

  it("3/4: the kick picks the downbeat", async () => {
    const g = await detectTempo(source([drums(120, 30, 0.4, 3, SR, "boombap")]), { beatsPerBar: 3, yieldFn: now });
    expect(g!.bpm).toBeCloseTo(120, 1);
    const bar = 1.5;
    const d = Math.abs(((g!.downbeat - 0.4) % bar + bar) % bar);
    expect(Math.min(d, bar - d)).toBeLessThan(0.012);
  });

  it("has low confidence on noise and gives up on too-short audio", async () => {
    let seed = 7;
    const noise = new Float32Array(SR * 20).map(() => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 0.4);
    const g = await detectTempo(source([noise]), { yieldFn: now });
    expect(g === null || g.confidence < MIN_CONFIDENCE).toBe(true);
    expect(await detectTempo(source([drums(120, 4)]), { yieldFn: now })).toBeNull();
    expect(await detectTempo(source([new Float32Array(SR * 10)]), { yieldFn: now })).toBeNull();
  });
});
