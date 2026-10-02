// The waveform of a take *while it records*, so the timeline can draw it
// growing on the armed layer (as Ableton does). A compact summary: one
// (min, max) pair over all channels per LIVE_BUCKET frames — an hour at
// 48 kHz is ~10 MB. The web engine feeds it the captured blocks; the native
// engine builds the same pairs in its drain thread (native/src/record.rs,
// PEAK_BUCKET) and the backend appends what it polls.

export const LIVE_BUCKET = 128;

export class LivePeaks {
  /** (min, max) pairs, interleaved; `pairs` of them are valid. */
  data = new Float32Array(8192);
  pairs = 0;
  /** Frames captured so far (may run ahead of pairs × bucket by < 1 bucket). */
  frames = 0;
  private lo = 0;
  private hi = 0;
  private n = 0;

  constructor(
    readonly sampleRate: number,
    readonly bucket = LIVE_BUCKET,
  ) {}

  get seconds(): number {
    return this.frames / this.sampleRate;
  }

  private push(lo: number, hi: number): void {
    if (this.pairs * 2 + 2 > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.pairs * 2] = lo;
    this.data[this.pairs * 2 + 1] = hi;
    this.pairs++;
  }

  /** Feed one captured block (planar channels). */
  feedPlanar(channels: Float32Array[]): void {
    if (channels.length === 0) return;
    const len = channels[0].length;
    for (let i = 0; i < len; i++) {
      let lo = channels[0][i], hi = lo;
      for (let c = 1; c < channels.length; c++) {
        const v = channels[c][i] ?? lo;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (this.n === 0) {
        this.lo = lo;
        this.hi = hi;
      } else {
        if (lo < this.lo) this.lo = lo;
        if (hi > this.hi) this.hi = hi;
      }
      if (++this.n === this.bucket) {
        this.push(this.lo, this.hi);
        this.n = 0;
      }
    }
    this.frames += len;
  }

  /** Append pairs built elsewhere (the native engine) and its frame count. */
  appendPairs(pairs: Float32Array, frames: number): void {
    for (let i = 0; i + 1 < pairs.length; i += 2) this.push(pairs[i], pairs[i + 1]);
    this.frames = Math.max(this.frames, frames);
  }

  /** (min, max) over the take between `t0` and `t1` seconds; null past the end. */
  range(t0: number, t1: number): [number, number] | null {
    const a = Math.max(0, Math.floor((t0 * this.sampleRate) / this.bucket));
    const b = Math.min(this.pairs, Math.max(a + 1, Math.ceil((t1 * this.sampleRate) / this.bucket)));
    if (a >= this.pairs) return null;
    let lo = this.data[a * 2], hi = this.data[a * 2 + 1];
    for (let i = a + 1; i < b; i++) {
      const l = this.data[i * 2], h = this.data[i * 2 + 1];
      if (l < lo) lo = l;
      if (h > hi) hi = h;
    }
    return [lo, hi];
  }
}
