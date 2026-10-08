// DJ-deck events: what DJ mode (src/dj/) sends to the engine. Played by
// public/dj-processor.js (web) and native/src/dj.rs (native); both apply an
// event at the next 128-frame quantum.

export const DJ_DECKS = 2;
/** A band turned all the way down is gone (kill). */
export const EQ_MIN_DB = -60;
export const EQ_MAX_DB = 6;

export type DjEvent =
  | { t: "play"; deck: number; on: boolean }
  /** Jump to `time` seconds into the track. */
  | { t: "seek"; deck: number; time: number }
  /** SYNC's phase step, done by the engine where both positions are exact:
   *  move `deck` the shorter way onto deck `to`'s beat phase. Beat lengths
   *  and first beats in track seconds. */
  | { t: "phase"; deck: number; beat: number; first: number; to: number; toBeat: number; toFirst: number }
  /** Tempo: 1 = as recorded (pitch follows, like vinyl). */
  | { t: "rate"; deck: number; rate: number }
  /** Added to the rate while the jog pushes (0 when let go). */
  | { t: "nudge"; deck: number; amount: number }
  /** Hand on the platter: runs at `speed` whatever the play state, until off. */
  | { t: "scratch"; deck: number; on: boolean; speed: number }
  /** Band gains, dB. */
  | { t: "eq"; deck: number; low: number; mid: number; high: number }
  /** Channel fader 0..1. */
  | { t: "vol"; deck: number; v: number }
  /** Crossfader −1 (A) .. 1 (B). */
  | { t: "xfade"; x: number }
  /** Loop between two times (s); to <= from ends it. */
  | { t: "loop"; deck: number; from: number; to: number };

export interface DjStatus {
  /** Seconds into each deck's track. */
  pos: number[];
  playing: boolean[];
}

/** Crossfader gains (A, B): both full in the middle, constant power
 *  towards the ends (as the engines). */
export function xfadeGains(x: number): [number, number] {
  const a = ((Math.min(1, Math.max(-1, x)) + 1) * Math.PI) / 4;
  return [Math.min(1, Math.SQRT2 * Math.cos(a)), Math.min(1, Math.SQRT2 * Math.sin(a))];
}
