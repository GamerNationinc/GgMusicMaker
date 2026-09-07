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
