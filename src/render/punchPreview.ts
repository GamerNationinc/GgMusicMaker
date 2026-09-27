// PUNCH preview — runs the real PUNCH DSP (public/punch-core.js) over a
// layer's audio off the audio thread, in slices, and keeps per-bucket
// statistics the timeline draws inside the clip: the processed waveform, the
// bass before/after, and every sample that would go over 0 dBFS.
//
// Pure (takes the core class and raw channel data), so it unit-tests in Node.

import type { PunchCoreCtor, PunchParams } from "../fx/punch";
import { SUMMARY_BUCKET } from "./peaks";

export interface PunchPreview {
  bucket: number;
  buckets: number;
  /** Processed min / max per bucket (both channels folded). */
  min: Float32Array;
  max: Float32Array;
  /** Low band sum-of-squares per bucket, before and after PUNCH. */
  lowIn: Float32Array;
  lowOut: Float32Array;
  /** Samples over full scale per bucket. */
  over: Uint16Array;
  /** Whole-buffer figures for the editor readout. */
  peak: number;
  overTotal: number;
  lowInSq: number;
  lowOutSq: number;
}

export class PunchPreviewJob {
  readonly result: PunchPreview;
  private pos = 0;
  private core;
  private l: Float32Array;
  private r: Float32Array;

  constructor(Core: PunchCoreCtor, sampleRate: number, channels: Float32Array[], params: PunchParams, private gain: number) {
    this.l = channels[0];
    this.r = channels[1] ?? channels[0];
    const buckets = Math.max(1, Math.ceil(this.l.length / SUMMARY_BUCKET));
    this.result = {
      bucket: SUMMARY_BUCKET,
      buckets,
      min: new Float32Array(buckets),
      max: new Float32Array(buckets),
      lowIn: new Float32Array(buckets),
      lowOut: new Float32Array(buckets),
      over: new Uint16Array(buckets),
      peak: 0,
      overTotal: 0,
      lowInSq: 0,
      lowOutSq: 0,
    };
    this.core = new Core(sampleRate);
    this.core.set({ ...params });
  }

  get done(): boolean {
    return this.pos >= this.l.length;
  }

  /** Process up to `samples` more; returns true when finished. */
  step(samples: number): boolean {
    const res = this.result, core = this.core, l = this.l, r = this.r, g = this.gain;
    const end = Math.min(l.length, this.pos + samples);
    for (let i = this.pos; i < end; i++) {
      core.step(l[i] * g, r[i] * g);
      const b = (i / SUMMARY_BUCKET) | 0;
      const lo = core.l < core.r ? core.l : core.r;
      const hi = core.l > core.r ? core.l : core.r;
      if (lo < res.min[b]) res.min[b] = lo;
      if (hi > res.max[b]) res.max[b] = hi;
      const li = core.lowIn * core.lowIn, lo2 = core.lowOut * core.lowOut;
      res.lowIn[b] += li;
      res.lowOut[b] += lo2;
      res.lowInSq += li;
      res.lowOutSq += lo2;
      const a = Math.max(hi, -lo);
      if (a > res.peak) res.peak = a;
      if (a > 1) {
        res.over[b]++;
        res.overTotal++;
      }
    }
    this.pos = end;
    return this.done;
  }
}

/** Bass change in dB (after vs before), for the readout. */
export function lowGainDb(p: PunchPreview): number {
  if (p.lowInSq <= 0) return 0;
  return 10 * Math.log10((p.lowOutSq + 1e-12) / p.lowInSq);
}
