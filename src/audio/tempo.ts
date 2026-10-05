// The song's tempo and the bar/beat grid built on it.
//
// One BPM for the whole project: the ruler counts bars, clips snap to the
// grid, and every tempo-locked effect (BASS MOD's LFO) follows it. Audio
// clips are not warped — changing the tempo moves the grid, not the audio,
// like an un-warped clip in Ableton. `offset` is where bar 1 starts, so the
// grid can be laid over an imported song whose first downbeat isn't at 0.

export interface Tempo {
  /** Beats per minute. */
  bpm: number;
  /** Beats in a bar (the top of the time signature; beats are quarter notes). */
  beatsPerBar: number;
  /** Song time of bar 1's downbeat, in seconds. Kept within one bar of 0. */
  offset: number;
}

export const BPM_MIN = 40;
export const BPM_MAX = 240;
export const BEATS_PER_BAR = [2, 3, 4, 5, 6, 7] as const;
export const DEFAULT_TEMPO: Tempo = { bpm: 120, beatsPerBar: 4, offset: 0 };

/** BPM to two decimals (120.00), clamped to the range the LFOs accept. */
export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return DEFAULT_TEMPO.bpm;
  return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm * 100) / 100));
}

export function beatSeconds(t: Tempo): number {
  return 60 / t.bpm;
}

export function barSeconds(t: Tempo): number {
  return beatSeconds(t) * t.beatsPerBar;
}

/** Fold an offset into [0, one bar): any downbeat names the same grid. */
export function foldOffset(offset: number, t: Pick<Tempo, "bpm" | "beatsPerBar">): number {
  const bar = (60 / t.bpm) * t.beatsPerBar;
  if (!Number.isFinite(offset)) return 0;
  const o = ((offset % bar) + bar) % bar;
  // Rounding can land exactly on the bar length.
  return o >= bar - 1e-9 ? 0 : o;
}

/** A valid tempo from anything (a saved file, a rack). */
export function normalizeTempo(raw: unknown, fallbackBpm = DEFAULT_TEMPO.bpm): Tempo {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bpm = clampBpm(typeof src.bpm === "number" ? src.bpm : fallbackBpm);
  const beatsPerBar = (BEATS_PER_BAR as readonly number[]).includes(src.beatsPerBar as number)
    ? (src.beatsPerBar as number)
    : DEFAULT_TEMPO.beatsPerBar;
  const offset = foldOffset(typeof src.offset === "number" ? src.offset : 0, { bpm, beatsPerBar });
  return { bpm, beatsPerBar, offset };
}

/** Grid steps, in beats: a 16th, an 8th, a beat, then whole bars (filled in per tempo). */
const SUB_BEATS = [0.25, 0.5, 1];
const BAR_MULTIPLES = [1, 2, 4, 8, 16, 32, 64, 128];

/** Every grid step for this tempo, finest first, in beats. */
function steps(t: Tempo): number[] {
  return [...SUB_BEATS.filter((b) => b < t.beatsPerBar), ...BAR_MULTIPLES.map((m) => m * t.beatsPerBar)];
}

/** The finest step, in beats, whose lines are at least `minPx` apart at this
 *  zoom. The grid and snapping both use it, so snapping always lands on a
 *  line you can see (Ableton's adaptive grid). */
export function gridBeats(t: Tempo, pps: number, minPx = 14): number {
  const beatPx = beatSeconds(t) * pps;
  const all = steps(t);
  for (const s of all) if (s * beatPx >= minPx) return s;
  return all[all.length - 1];
}

/** Snap a song time to the nearest grid line (never before 0). */
export function snapTime(time: number, t: Tempo, stepBeats: number): number {
  const step = stepBeats * beatSeconds(t);
  const snapped = t.offset + Math.round((time - t.offset) / step) * step;
  return Math.max(0, snapped < 0 ? snapped + step : snapped);
}

/** Grid lines in [from, to): time plus how strong each line is. */
export interface GridLine {
  time: number;
  /** 0-based bar index from bar 1 (−1 = the bar before bar 1). */
  bar: number;
  /** 0-based beat within the bar, fractional for sub-beats. */
  beat: number;
  kind: "bar" | "beat" | "sub";
}

export function gridLines(t: Tempo, stepBeats: number, from: number, to: number): GridLine[] {
  const beat = beatSeconds(t);
  const step = stepBeats * beat;
  const out: GridLine[] = [];
  const first = Math.ceil((from - t.offset) / step - 1e-9);
  for (let i = first; ; i++) {
    const time = t.offset + i * step;
    if (time >= to) break;
    if (time < 0) continue;
    const beats = i * stepBeats;
    const bar = Math.floor(beats / t.beatsPerBar + 1e-9);
    const inBar = beats - bar * t.beatsPerBar;
    const kind = Math.abs(inBar) < 1e-6 ? "bar" : Math.abs(inBar - Math.round(inBar)) < 1e-6 ? "beat" : "sub";
    out.push({ time, bar, beat: Math.abs(inBar) < 1e-6 ? 0 : inBar, kind });
    if (out.length > 20000) break;
  }
  return out;
}

/** Where a song time falls: bar (1-based; 0 = the pickup before bar 1),
 *  beat (1-based) and 16th (1-based). */
export function barsBeats(time: number, t: Tempo): { bar: number; beat: number; sixteenth: number } {
  const beats = (time - t.offset) / beatSeconds(t) + 1e-6;
  const barIdx = Math.floor(beats / t.beatsPerBar);
  const inBar = beats - barIdx * t.beatsPerBar;
  const beat = Math.floor(inBar);
  const sixteenth = Math.floor((inBar - beat) * 4);
  return { bar: barIdx + 1, beat: beat + 1, sixteenth: sixteenth + 1 };
}

/** "12.3.2" — Ableton's bar.beat.sixteenth readout. */
export function formatBarsBeats(time: number, t: Tempo): string {
  const { bar, beat, sixteenth } = barsBeats(time, t);
  return `${bar}.${beat}.${sixteenth}`;
}

/** "120" or "92.5" — no trailing zeros. */
export function formatBpm(bpm: number): string {
  return String(Math.round(bpm * 100) / 100);
}

/** Tap tempo: keep taps from the last 2.5 s (max 6); the BPM once there are
 *  at least two, from the average gap. */
export function tapTempo(taps: number[], now: number): { taps: number[]; bpm: number | null } {
  const kept = [...taps.filter((t) => now - t < 2500), now].slice(-6);
  if (kept.length < 2) return { taps: kept, bpm: null };
  const gap = (kept[kept.length - 1] - kept[0]) / (kept.length - 1);
  return { taps: kept, bpm: Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(60000 / gap))) };
}

/** Every layer's BASS MOD runs at the song's BPM. The engines read each
 *  layer's own `bass.bpm`, so this keeps those copies in step; returns `p`
 *  itself when nothing changes. */
export function followSongTempo<P extends { tempo: Tempo; tracks: readonly { bass: { bpm: number } }[] }>(p: P): P {
  const bpm = p.tempo.bpm;
  if (p.tracks.every((t) => t.bass.bpm === bpm)) return p;
  return { ...p, tracks: p.tracks.map((t) => (t.bass.bpm === bpm ? t : { ...t, bass: { ...t.bass, bpm } })) };
}
