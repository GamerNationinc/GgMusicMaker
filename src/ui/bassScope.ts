// Small pure helpers for the BASS MOD editor: the LFO drawing and tap tempo.

/** Value of LFO `shape` at phase `ph` (0..1), −1..1 — as bass-core.js's lfo(),
 *  with RANDOM drawn as a fixed step pattern (it changes every cycle). */
export function lfoAt(shape: number, ph: number, cycle = 0): number {
  switch (shape) {
    case 1:
      return 4 * Math.abs(ph - 0.5) - 1;
    case 2:
      return 1 - 2 * ph;
    case 3:
      return ph < 0.5 ? 1 : -1;
    case 4:
      return [0.6, -0.8, 0.1, -0.3][cycle % 4];
    default:
      return Math.cos(2 * Math.PI * ph);
  }
}

/** SVG polyline points for two LFO cycles across `w`×`h`. Up = filter open. */
export function lfoPath(shape: number, w: number, h: number, steps = 96): string {
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * 2;
    const cycle = Math.floor(Math.min(x, 1.999));
    const v = lfoAt(shape, x - cycle, cycle);
    pts.push(`${((i / steps) * w).toFixed(1)},${(h / 2 - v * (h / 2 - 3)).toFixed(1)}`);
  }
  return pts.join(" ");
}

/** Tap tempo: keep taps from the last 2.5 s (max 6); the BPM once there are
 *  at least two, from the average gap. */
export function tapTempo(taps: number[], now: number): { taps: number[]; bpm: number | null } {
  const kept = [...taps.filter((t) => now - t < 2500), now].slice(-6);
  if (kept.length < 2) return { taps: kept, bpm: null };
  const gap = (kept[kept.length - 1] - kept[0]) / (kept.length - 1);
  return { taps: kept, bpm: Math.max(40, Math.min(240, Math.round(60000 / gap))) };
}
