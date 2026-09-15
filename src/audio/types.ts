// Core data model for GgMusicMaker.
//
// Everything here is plain, serializable state (no Web Audio objects). Decoded
// AudioBuffers live separately in the AudioEngine's buffer store, keyed by
// `bufferId`, so the project model stays lightweight and easy to reason about.

import type { VoicePreset } from "../fx/voice";

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

/** 3-band EQ, gains in dB (-18..+18). */
export interface EqParams {
  low: number;
  mid: number;
  high: number;
}

/** Voice-manipulation FX settings for a track. */
export interface VoiceParams {
  preset: VoicePreset;
  /** How much of the shifted signal to blend in, 0..1. */
  mix: number;
}

/** One layer/track: a stack of clips plus mix + FX params. */
export interface Track {
  id: string;
  name: string;
  /** Linear gain, 0..1.5 (1 = unity). */
  gain: number;
  muted: boolean;
  soloed: boolean;
  /** Armed for recording. */
  armed: boolean;
  /** Reverb send amount, 0..1. */
  reverbSend: number;
  /** 3-band EQ (v2 FX rack). */
  eq: EqParams;
  /** Voice manipulation (v2 FX rack). */
  voice: VoiceParams;
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

/** Move the counter past any ids in `ids` (e.g. from a loaded session) so
 *  freshly generated ids can never collide with them. */
export function reserveIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const n = Number(id.slice(id.lastIndexOf("_") + 1));
    if (Number.isFinite(n) && n > idCounter) idCounter = n;
  }
}

/** Reset the id counter — test helper only. */
export function __resetIds(): void {
  idCounter = 0;
}
