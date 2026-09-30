// Waveform peak extraction for Canvas rendering.
//
// Computing min/max per pixel column from raw samples on every frame would be
// far too slow, so we downsample once per buffer into a compact peak array and
// cache it. Operates on a minimal { length, getChannelData } shape for testing.

export interface PeakSource {
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Interleaved [min0, max0, min1, max1, ...] peaks, one pair per bucket. */
export type Peaks = Float32Array;

/**
 * Reduce a buffer to `buckets` min/max pairs by scanning channel 0 (mono peaks
 * are plenty for a small clip lane). Returns a Float32Array of length
 * buckets*2.
 */
export function computePeaks(buffer: PeakSource, buckets: number): Peaks {
  const out = new Float32Array(Math.max(1, buckets) * 2);
  if (buffer.length === 0 || buckets <= 0) return out;

  const data = buffer.getChannelData(0);
  const samplesPerBucket = buffer.length / buckets;

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * samplesPerBucket);
    const end = Math.min(buffer.length, Math.floor((b + 1) * samplesPerBucket));
    let min = 1.0;
    let max = -1.0;
    for (let i = start; i < end; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (end <= start) {
      min = 0;
      max = 0;
    }
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}

const cache = new WeakMap<PeakSource, Map<number, Peaks>>();

/** Cached variant keyed by buffer identity + bucket count. */
export function getPeaks(buffer: PeakSource, buckets: number): Peaks {
  let byBucket = cache.get(buffer);
  if (!byBucket) {
    byBucket = new Map();
    cache.set(buffer, byBucket);
  }
  let peaks = byBucket.get(buckets);
  if (!peaks) {
    peaks = computePeaks(buffer, buckets);
    byBucket.set(buckets, peaks);
  }
  return peaks;
}

// ---- multi-resolution summary (the timeline's waveform) --------------------
//
// The lanes draw only what is on screen, at any zoom, for songs of any
// length. One pass per buffer reduces it to fixed 128-sample buckets of
// min / max / sum-of-squares per channel (≈ 1/40th of the audio's size);
// a pixel column then folds together however many buckets it covers. When
// zoomed in past one bucket per pixel the lane reads the raw samples.

export const SUMMARY_BUCKET = 128;

export interface WaveSummary {
  bucket: number;
  buckets: number;
  channels: number;
  length: number;
  min: Float32Array[];
  max: Float32Array[];
  /** Sum of squares per bucket (so columns can compute an exact RMS). */
  sq: Float32Array[];
  /** Largest absolute sample in the whole buffer. */
  peak: number;
}

function emptySummary(buffer: PeakSource, bucket: number): WaveSummary {
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const buckets = Math.max(1, Math.ceil(buffer.length / bucket));
  const s: WaveSummary = { bucket, buckets, channels, length: buffer.length, min: [], max: [], sq: [], peak: 0 };
  for (let c = 0; c < channels; c++) {
    s.min.push(new Float32Array(buckets));
    s.max.push(new Float32Array(buckets));
    s.sq.push(new Float32Array(buckets));
  }
  return s;
}

/** Fill buckets [b0, b1) of every channel. */
function fillBuckets(buffer: PeakSource, s: WaveSummary, b0: number, b1: number): void {
  const bucket = s.bucket;
  for (let c = 0; c < s.channels; c++) {
    const data = buffer.getChannelData(c);
    const mn = s.min[c], mx = s.max[c], sq = s.sq[c];
    for (let b = b0; b < b1; b++) {
      const end = Math.min(buffer.length, (b + 1) * bucket);
      let lo = 0, hi = 0, acc = 0;
      for (let i = b * bucket; i < end; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        acc += v * v;
      }
      mn[b] = lo; mx[b] = hi; sq[b] = acc;
      if (hi > s.peak) s.peak = hi;
      if (-lo > s.peak) s.peak = -lo;
    }
  }
}

export function summarize(buffer: PeakSource, bucket = SUMMARY_BUCKET): WaveSummary {
  const s = emptySummary(buffer, bucket);
  fillBuckets(buffer, s, 0, s.buckets);
  return s;
}

const summaries = new WeakMap<PeakSource, WaveSummary>();
export function getSummary(buffer: PeakSource): WaveSummary {
  let s = summaries.get(buffer);
  if (!s) {
    s = summarize(buffer);
    summaries.set(buffer, s);
  }
  return s;
}

/** Buckets per slice of `prepareSummary`: 4 M samples per channel, a few ms. */
const PREPARE_BUCKETS = 32768;

/**
 * Build a buffer's summary ahead of drawing, a slice at a time with the page
 * free to run in between, and cache it for `getSummary`. An hour of audio is
 * ~345 M samples — summarised in one go (what the first draw would do) that
 * freezes the page for most of a second, longer on the Deck.
 */
export async function prepareSummary(
  buffer: PeakSource,
  pause: () => Promise<void> = () => new Promise((r) => setTimeout(r, 0)),
): Promise<void> {
  if (summaries.has(buffer)) return;
  const s = emptySummary(buffer, SUMMARY_BUCKET);
  for (let b = 0; b < s.buckets; b += PREPARE_BUCKETS) {
    fillBuckets(buffer, s, b, Math.min(s.buckets, b + PREPARE_BUCKETS));
    if (b + PREPARE_BUCKETS < s.buckets) await pause();
    // Drawn meanwhile (computed in one go): nothing left to do.
    if (summaries.has(buffer)) return;
  }
  summaries.set(buffer, s);
}

export interface ColumnStats {
  min: number;
  max: number;
  rms: number;
}

/** min / max / RMS of channel `ch` over samples [s0, s1). Reads the raw
 *  samples when the span is shorter than a couple of buckets. */
export function columnStats(
  sum: WaveSummary,
  buffer: PeakSource,
  ch: number,
  s0: number,
  s1: number,
  out: ColumnStats,
): ColumnStats {
  const a = Math.max(0, Math.floor(s0));
  const b = Math.min(sum.length, Math.ceil(s1));
  out.min = 0; out.max = 0; out.rms = 0;
  if (b <= a) return out;
  const c = Math.min(ch, sum.channels - 1);
  if (b - a < sum.bucket * 2) {
    const data = buffer.getChannelData(c);
    let acc = 0;
    for (let i = a; i < b; i++) {
      const v = data[i];
      if (v < out.min) out.min = v;
      if (v > out.max) out.max = v;
      acc += v * v;
    }
    out.rms = Math.sqrt(acc / (b - a));
    return out;
  }
  const b0 = Math.floor(a / sum.bucket), b1 = Math.min(sum.buckets, Math.ceil(b / sum.bucket));
  const mn = sum.min[c], mx = sum.max[c], sq = sum.sq[c];
  let acc = 0;
  for (let k = b0; k < b1; k++) {
    if (mn[k] < out.min) out.min = mn[k];
    if (mx[k] > out.max) out.max = mx[k];
    acc += sq[k];
  }
  out.rms = Math.sqrt(acc / Math.max(1, (b1 - b0) * sum.bucket));
  return out;
}
