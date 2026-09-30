// Live-instrument events: what Instrument mode (src/input/instrument.ts)
// sends to the engine. Played by public/live-processor.js (web) and
// native/src/live.rs (native); both apply an event at the next quantum.

/** Voice patches, in the engines' PATCHES order. */
export const LIVE_PATCHES = ["keys", "pluck", "pad", "bass"] as const;
export type LivePatch = (typeof LIVE_PATCHES)[number];

/** Drum pieces, in the engines' order. */
export const DRUM_KINDS = ["kick", "snare", "hat", "clap"] as const;
export type DrumKind = (typeof DRUM_KINDS)[number];

export interface LiveControls {
  /** Pitch bend, semitones. */
  bend: number;
  /** Vibrato depth 0..1 (the mod wheel). */
  mod: number;
  /** Filter cutoff 0..1 (80 Hz .. 20 kHz, log). */
  cutoff: number;
  /** Reverb send 0..1. */
  send: number;
  /** Expression (overall voice level) 0..1. */
  expr: number;
  sustain: boolean;
}

export type LiveEvent =
  | { t: "on"; id: number; note: number; vel: number; patch: number }
  | { t: "off"; id: number }
  | { t: "glide"; id: number; note: number }
  | { t: "drum"; kind: number; vel: number }
  | ({ t: "ctl" } & LiveControls)
  | { t: "panic" };
