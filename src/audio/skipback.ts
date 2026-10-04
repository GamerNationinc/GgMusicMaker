// Skip-back + resample, the pure parts (docs/sampler-research.md §3.1, §3.3).
//
// Both engines keep an always-on ring of what the device played — the master
// output after the limiter, as stereo: native/src/skipback.rs and
// public/skipback-processor.js, two minutes long. SKIP BACK lifts the last
// minute out of it (trimmed to where there was sound); RESAMPLE marks the ring
// and later lifts everything since the mark. Either lands on a new layer.

/** What a ring holds. */
export const RING_SECONDS = 120;
/** How far SKIP BACK reaches. */
export const SKIPBACK_SECONDS = 60;
/** Longest resample (the ring has to still hold its start). */
export const RESAMPLE_MAX_SECONDS = RING_SECONDS - 5;
/** Below this (linear peak, ≈ -60 dB) counts as silence. */
export const SILENCE = 0.001;
/** Kept either side of the sound when trimming, seconds. */
export const TRIM_PAD = 0.05;

/** Audio copied out of the ring. */
export interface SkipGrab {
  sampleRate: number;
  /** [left, right]. */
  channels: Float32Array[];
  /** Song time of the first sample; null = the transport was stopped there. */
  songTime: number | null;
}

/** Frames [start, end) that hold sound, padded by `pad` seconds; null when
 *  it's all silence. */
export function soundSpan(channels: Float32Array[], sampleRate: number, threshold = SILENCE, pad = TRIM_PAD): { start: number; end: number } | null {
  const n = channels[0]?.length ?? 0;
  const loud = (i: number) => channels.some((c) => Math.abs(c[i]) > threshold);
  let first = 0;
  while (first < n && !loud(first)) first++;
  if (first === n) return null;
  let last = n - 1;
  while (last > first && !loud(last)) last--;
  const p = Math.round(pad * sampleRate);
  return { start: Math.max(0, first - p), end: Math.min(n, last + 1 + p) };
}

/** A grab cut down to its sound (SKIP BACK), song time moved along with it.
 *  null when nothing was audible. */
export function trimGrab(g: SkipGrab, threshold = SILENCE): SkipGrab | null {
  const span = soundSpan(g.channels, g.sampleRate, threshold);
  if (!span) return null;
  return {
    sampleRate: g.sampleRate,
    channels: g.channels.map((c) => c.slice(span.start, span.end)),
    songTime: g.songTime == null ? null : g.songTime + span.start / g.sampleRate,
  };
}

/** When the transport ran, in context time: [start, end) → song time at start. */
export interface PlaySpan {
  ctxStart: number;
  ctxEnd: number;
  song: number;
}

/** Song time at a context time, or null when the transport was stopped. */
export function songTimeAt(log: readonly PlaySpan[], ctxTime: number): number | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const s = log[i];
    if (ctxTime >= s.ctxStart && ctxTime < s.ctxEnd) return s.song + (ctxTime - s.ctxStart);
  }
  return null;
}

/** Next free "<base> N" name. */
export function nextLayerName(base: string, names: readonly string[]): string {
  let n = 1;
  while (names.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
