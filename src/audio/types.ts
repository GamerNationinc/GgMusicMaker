// Core data model for ProfitPals DAW.
//
// Everything here is plain, serializable state (no Web Audio objects). Decoded
// AudioBuffers live separately in the AudioEngine's buffer store, keyed by
// `bufferId`, so the project model stays lightweight and easy to reason about.

/** A region of a source buffer placed on the timeline. Non-destructive:
 *  split/trim only adjust offset/duration/startTime — the buffer is untouched. */
export interface Clip {
  id: string;
  /** Key into the AudioEngine buffer store. */
  bufferId: string;
  /** Where the clip starts on the timeline, in seconds. */
  startTime: number;
  /** How far into the source buffer this clip begins, in seconds. */
  offset: number;
  /** Length of the clip, in seconds. */
  duration: number;
  name: string;
}

/** One layer/track: a stack of clips plus mix + FX-send params. */
export interface Track {
  id: string;
  name: string;
  /** Linear gain, 0..1.5 (1 = unity). */
  gain: number;
  muted: boolean;
  soloed: boolean;
  /** Armed for recording. */
  armed: boolean;
  /** Reverb send amount, 0..1 (the v1 FX seam; full rack lands in v2). */
  reverbSend: number;
  /** UI accent colour for the track's clips. */
  color: string;
  clips: Clip[];
}

export interface Project {
  tracks: Track[];
  /** Sample rate the project renders at. */
  sampleRate: number;
}

/** Live transport state, kept separate from the (undoable) project model. */
export interface TransportState {
  isPlaying: boolean;
  isRecording: boolean;
  /** Current playhead position, in seconds. */
  playhead: number;
  /** Whether playback loops over [loopStart, loopEnd). */
  looping: boolean;
}

export const TRACK_COLORS = [
  "#ff3ca0", // magenta
  "#5af096", // green
  "#3cc8ff", // cyan
  "#ffcf3c", // amber
  "#b47cff", // violet
  "#ff7a3c", // orange
] as const;

let idCounter = 0;
/** Small monotonic id generator (deterministic, easy to test). */
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

/** Reset the id counter — test helper only. */
export function __resetIds(): void {
  idCounter = 0;
}
