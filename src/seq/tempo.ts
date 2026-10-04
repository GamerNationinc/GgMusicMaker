// The project tempo — one BPM the whole project shares: the sequencer, the
// bar grid on the ruler, the metronome. 4/4 sixteenths for now. Pure.

export interface Tempo {
  bpm: number;
  beatsPerBar: number;
}

export const DEFAULT_TEMPO: Tempo = { bpm: 120, beatsPerBar: 4 };
export const BPM_MIN = 40;
export const BPM_MAX = 240;

export const tempoOf = (p: { tempo?: Tempo }): Tempo => p.tempo ?? DEFAULT_TEMPO;
export const clampBpm = (bpm: number) => Math.round(Math.min(BPM_MAX, Math.max(BPM_MIN, Number.isFinite(bpm) ? bpm : DEFAULT_TEMPO.bpm)) * 10) / 10;

/** Seconds per beat / per sixteenth / per bar. */
export const beatSeconds = (t: Tempo) => 60 / t.bpm;
export const stepSeconds = (t: Tempo) => 15 / t.bpm;
export const barSeconds = (t: Tempo) => beatSeconds(t) * t.beatsPerBar;

/** Bar, beat and sixteenth (all from 1) at a song time. */
export function barBeat(t: Tempo, seconds: number): { bar: number; beat: number; sixteenth: number } {
  const steps = Math.floor(Math.max(0, seconds) / stepSeconds(t) + 1e-9);
  const perBar = t.beatsPerBar * 4;
  return { bar: Math.floor(steps / perBar) + 1, beat: Math.floor((steps % perBar) / 4) + 1, sixteenth: (steps % 4) + 1 };
}

export function normalizeTempo(raw: unknown): Tempo | undefined {
  const r = raw as Partial<Tempo> | null;
  if (!r || typeof r !== "object") return undefined;
  const beats = Math.round(Number(r.beatsPerBar));
  return { bpm: clampBpm(Number(r.bpm)), beatsPerBar: beats >= 1 && beats <= 16 ? beats : 4 };
}

/** Tap tempo: the average of the last few taps; a pause over 2 s starts again. */
export class TapTempo {
  private taps: number[] = [];

  /** A tap at `ms`; the tempo once there are two taps, else null. */
  tap(ms: number): number | null {
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && ms - last > 2000) this.taps = [];
    this.taps.push(ms);
    if (this.taps.length > 5) this.taps.shift();
    if (this.taps.length < 2) return null;
    const span = this.taps[this.taps.length - 1] - this.taps[0];
    return clampBpm((60000 * (this.taps.length - 1)) / span);
  }
}
