// Recording latency: measuring it (calibration) and taking it out of a take.
//
// The native engine places a take using the latencies the audio devices
// report (native/src/record.rs). On Linux, PipeWire and PulseAudio report
// none through ALSA, yet a round trip (speaker → mic → take) is tens of ms —
// on the Deck 37 ms, the same to the sample every time. So it is measured
// once: the engine plays a click pattern, records it back, and the offset
// between where the clicks landed and where they were played is stored and
// subtracted from every take. Pure functions; unit-tested.

/** A click pattern for calibration: short decaying bursts at uneven gaps
 *  (so no shift by one gap can line up again), `seconds` long. */
export function calibrationClicks(sampleRate: number, seconds = 3): Float32Array {
  const out = new Float32Array(Math.round(sampleRate * seconds));
  const gaps = [0.37, 0.52, 0.31, 0.61, 0.44, 0.33, 0.58, 0.41];
  const len = Math.round(sampleRate * 0.004);
  let t = 0.25;
  for (let k = 0; t < seconds - 0.1; k++) {
    const at = Math.round(t * sampleRate);
    for (let i = 0; i < len && at + i < out.length; i++) {
      out[at + i] = 0.8 * Math.sin(i * 0.9) * (1 - i / len);
    }
    t += gaps[k % gaps.length];
  }
  return out;
}

/**
 * How late (in samples) `rec` is against `ref`, when `rec`'s first sample was
 * placed at `ref` index `start`. Searches lags `minLag..maxLag`; positive =
 * the recording arrived late. Only `ref`'s non-silent samples are visited,
 * so a sparse click pattern is cheap to search over a wide range.
 * Returns the lag and a 0..1 confidence (normalised correlation).
 */
export function findLag(
  rec: Float32Array,
  ref: Float32Array,
  start: number,
  minLag: number,
  maxLag: number,
): { lag: number; confidence: number } {
  const hot: number[] = [];
  for (let j = 0; j < ref.length; j++) if (ref[j] !== 0) hot.push(j);
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (const j of hot) {
      const i = j - start + lag;
      if (i >= 0 && i < rec.length) s += rec[i] * ref[j];
    }
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  let er = 0;
  let ek = 0;
  for (const j of hot) {
    const i = j - start + bestLag;
    ek += ref[j] * ref[j];
    if (i >= 0 && i < rec.length) er += rec[i] * rec[i];
  }
  const confidence = er > 0 && ek > 0 ? Math.max(0, best) / Math.sqrt(er * ek) : 0;
  return { lag: bestLag, confidence };
}

/**
 * Move a take `offsetSeconds` earlier (the measured latency). If that would
 * put its start before 0 s, the leading samples that fall before 0 are cut.
 */
export function applyOffset(
  channels: Float32Array[],
  start: number,
  offsetSeconds: number,
  sampleRate: number,
): { channels: Float32Array[]; start: number } {
  const moved = start - offsetSeconds;
  if (moved >= 0) return { channels, start: moved };
  const cut = Math.min(channels[0]?.length ?? 0, Math.round(-moved * sampleRate));
  return { channels: channels.map((c) => c.subarray(cut)), start: 0 };
}

/**
 * Cut whatever a take holds from before `at` (s): a count-in's bar is
 * heard, not kept — the take starts where Record was pressed.
 */
export function trimBefore(
  channels: Float32Array[],
  start: number,
  at: number,
  sampleRate: number,
): { channels: Float32Array[]; start: number } {
  if (start >= at) return { channels, start };
  const cut = Math.min(channels[0]?.length ?? 0, Math.round((at - start) * sampleRate));
  return { channels: channels.map((c) => c.subarray(cut)), start: at };
}

/** Where the calibrated latency is kept (per output+input device pair). */
// v2 (2026-10-05): takes are anchored on each block's newest frame, which
// moves the measured round trip — older calibrations don't apply.
export const LATENCY_KEY = "ggmm.recordLatency.v2";

export interface StoredLatency {
  devices: string;
  ms: number;
  at: string;
}

export function readLatency(devices: string): number | null {
  try {
    const v = JSON.parse(localStorage.getItem(LATENCY_KEY) ?? "null") as StoredLatency | null;
    return v && v.devices === devices && Number.isFinite(v.ms) ? v.ms : null;
  } catch {
    return null;
  }
}

export function writeLatency(devices: string, ms: number): void {
  try {
    localStorage.setItem(LATENCY_KEY, JSON.stringify({ devices, ms, at: new Date().toISOString() } satisfies StoredLatency));
  } catch {
    // private mode etc.: calibration just won't be remembered
  }
}
