// Chop lab, the pure parts (docs/sampler-research.md §2.4): slice markers
// over a region of a sample, cut by hand, into equal parts, or at the
// transients. Times are seconds into the buffer.

export interface Slice {
  start: number;
  end: number;
}

/** Shortest slice a marker may leave, seconds. */
export const MIN_SLICE = 0.01;

/** Markers (sorted, deduplicated, inside the region and ≥ MIN_SLICE apart). */
export function cleanMarkers(markers: readonly number[], start: number, end: number): number[] {
  const out: number[] = [];
  for (const m of [...markers].sort((a, b) => a - b)) {
    if (m - start < MIN_SLICE || end - m < MIN_SLICE) continue;
    if (out.length && m - out[out.length - 1] < MIN_SLICE) continue;
    out.push(m);
  }
  return out;
}

/** The slices the markers cut [start, end) into. */
export function markersToSlices(markers: readonly number[], start: number, end: number): Slice[] {
  const cuts = [start, ...cleanMarkers(markers, start, end), end];
  return cuts.slice(1).map((e, i) => ({ start: cuts[i], end: e }));
}

/** Markers that cut [start, end) into `n` equal parts. */
export function equalMarkers(start: number, end: number, n: number): number[] {
  const k = Math.max(1, Math.floor(n));
  return Array.from({ length: k - 1 }, (_, i) => start + ((end - start) * (i + 1)) / k);
}

/** Index of the slice holding time `t` (clamped to the first / last). */
export function sliceAt(slices: readonly Slice[], t: number): number {
  for (let i = 0; i < slices.length; i++) if (t < slices[i].end) return i;
  return Math.max(0, slices.length - 1);
}

/** Add a marker at `t` (no-op when too close to another or to an edge). */
export function addMarker(markers: readonly number[], t: number, start: number, end: number): number[] {
  return cleanMarkers([...markers, t], start, end).length > cleanMarkers(markers, start, end).length
    ? cleanMarkers([...markers, t], start, end)
    : cleanMarkers(markers, start, end);
}

/** The marker nearest `t`, if within `tolerance` seconds. */
export function nearestMarker(markers: readonly number[], t: number, tolerance: number): number | null {
  let best: number | null = null;
  markers.forEach((m, i) => {
    if (Math.abs(m - t) <= tolerance && (best === null || Math.abs(m - t) < Math.abs(markers[best] - t))) best = i;
  });
  return best;
}

/** Analysis hop for onset detection, seconds. */
const HOP = 0.005;
/** Onsets closer than this are one hit. */
const MIN_GAP = 0.06;

/**
 * Transient markers in [start, end): a high-frequency-weighted energy
 * envelope (first difference of the mono mix, so the click of a hit counts
 * more than a held bass note) in 5 ms hops; an onset is a hop whose log
 * energy jumps well above the recent average and is the strongest within
 * ±30 ms, and is loud enough. `sensitivity` 0..1: higher finds smaller
 * jumps and softer hits. Each marker sits a
 * few ms before the hop, so the attack is kept whole.
 */
export function detectOnsets(channels: readonly Float32Array[], sampleRate: number, start: number, end: number, sensitivity = 0.5): number[] {
  const hop = Math.max(1, Math.round(HOP * sampleRate));
  const a = Math.max(1, Math.floor(start * sampleRate));
  const b = Math.min(channels[0]?.length ?? 0, Math.floor(end * sampleRate));
  const n = Math.floor((b - a) / hop);
  if (n < 3) return [];
  const e = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = a + k * hop; i < a + (k + 1) * hop; i++) {
      let x = 0;
      let px = 0;
      for (const c of channels) {
        x += c[i];
        px += c[i - 1];
      }
      const d = (x - px) / channels.length;
      sum += d * d;
    }
    e[k] = sum / hop;
  }
  let peak = 0;
  for (const v of e) peak = Math.max(peak, v);
  if (peak <= 0) return [];
  const floor = peak * 1e-4; // -40 dB under the loudest hop
  const log = (v: number) => Math.log(v + floor);
  // Jump needed above the recent average, in log units (≈ 4.3 dB each).
  const sens = Math.min(1, Math.max(0, sensitivity));
  const need = 3.5 - 2.5 * sens;
  // …and be loud enough: -10 dB under the loudest hop at 0, -40 dB at 1.
  const loud = peak * 10 ** -(1 + 3 * sens);
  const strength = new Float64Array(n);
  for (let k = 1; k < n; k++) {
    let avg = 0;
    const from = Math.max(0, k - 8);
    for (let j = from; j < k; j++) avg += e[j];
    avg /= k - from;
    strength[k] = log(e[k]) - log(avg);
  }
  const radius = Math.round(0.03 / HOP);
  const out: number[] = [];
  for (let k = 1; k < n; k++) {
    if (strength[k] < need || e[k] < loud) continue;
    let best = true;
    for (let j = Math.max(1, k - radius); j <= Math.min(n - 1, k + radius); j++) {
      if (strength[j] > strength[k] || (strength[j] === strength[k] && j < k)) best = false;
    }
    if (!best) continue;
    const t = (a + k * hop) / sampleRate - 0.003;
    if (out.length && t - out[out.length - 1] < MIN_GAP) continue;
    out.push(Math.max(start, t));
  }
  return cleanMarkers(out, start, end);
}
