// System-load estimation — the maths behind the Ableton-style CPU meter.
//
// A WebView gives no direct view of the audio thread, so two honest proxies
// are used instead:
//
//  * UI-thread utilisation: how much of each animation frame the main thread
//    spent busy (our tick + Svelte effects + canvas draws + layout/paint),
//    smoothed so the readout is legible rather than jittery.
//  * Audio dropouts: while the context is running its clock must advance at
//    wall-clock speed. If it advances *slower*, the audio thread starved and
//    the output glitched — that is what Ableton's "D" (overload) lamp means.
//
// Pure functions here; the store feeds them timestamps.

export interface LoadState {
  /** Smoothed UI-thread utilisation, 0..1. */
  cpu: number;
  /** True for a moment after a dropout was detected. */
  dropout: boolean;
  /** Dropouts since the app started (or the counter was reset). */
  dropouts: number;
}

export const INITIAL_LOAD: LoadState = { cpu: 0, dropout: false, dropouts: 0 };

/** Fraction of a frame that was busy, clamped to 0..1. */
export function frameUtilisation(busyMs: number, intervalMs: number): number {
  if (!(intervalMs > 0) || !(busyMs >= 0)) return 0;
  return Math.min(1, busyMs / intervalMs);
}

/** Exponential moving average. `alpha` = weight of the new sample. */
export function ema(prev: number, sample: number, alpha: number): number {
  return prev + (sample - prev) * alpha;
}

/**
 * True when the audio clock fell behind the wall clock by more than
 * `tolerance` over the interval — i.e. the audio thread could not keep up.
 * Tiny intervals are ignored: at a few ms the clocks' granularity dominates.
 */
export function audioDropout(
  audioAdvanceSec: number,
  wallAdvanceSec: number,
  tolerance = 0.03,
  minIntervalSec = 0.25,
): boolean {
  if (wallAdvanceSec < minIntervalSec) return false;
  return audioAdvanceSec < wallAdvanceSec * (1 - tolerance);
}

/** Pick the bar cells for a 0..1 load, Ableton-style: green → amber → red. */
export function loadBand(cpu: number): "ok" | "warn" | "hot" {
  if (cpu >= 0.85) return "hot";
  if (cpu >= 0.6) return "warn";
  return "ok";
}
