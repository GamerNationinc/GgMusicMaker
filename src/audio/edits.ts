// Pure, non-destructive timeline editing operations.
//
// These functions never mutate their inputs and never touch audio data — they
// only compute new Clip/Track geometry. That keeps them trivially unit-testable
// (see edits.test.ts) and keeps the "source audio is never altered" guarantee
// from the plan honest.

import type { Clip, Track, Project } from "./types";
import { nextId } from "./types";

/** Timeline position (seconds) where a clip ends. */
export function clipEnd(clip: Clip): number {
  return clip.startTime + clip.duration;
}

/** True if `time` falls strictly inside the clip (not on its edges). */
export function timeInsideClip(clip: Clip, time: number): boolean {
  return time > clip.startTime && time < clipEnd(clip);
}

/**
 * Split a clip at an absolute timeline position, returning two clips that
 * together cover the same audio. Returns the original (as a single-element
 * array) if the cut falls on or outside the clip's edges.
 */
export function splitClip(clip: Clip, time: number): Clip[] {
  if (!timeInsideClip(clip, time)) return [clip];

  const leftDuration = time - clip.startTime;
  const left: Clip = {
    ...clip,
    duration: leftDuration,
  };
  const right: Clip = {
    ...clip,
    id: nextId("clip"),
    startTime: time,
    offset: clip.offset + leftDuration,
    duration: clip.duration - leftDuration,
  };
  return [left, right];
}

/**
 * Trim a clip by moving its left and/or right edge on the timeline. Trimming
 * the left edge also advances the source offset so the audio under the cursor
 * stays put. Clamped so the clip keeps a minimum positive length and never
 * reads before the start of its source buffer.
 */
export function trimClip(
  clip: Clip,
  newStartTime: number,
  newEndTime: number,
  minLength = 0.01,
): Clip {
  let start = newStartTime;
  let end = newEndTime;
  if (end - start < minLength) end = start + minLength;

  const deltaStart = start - clip.startTime;
  // Don't let the left trim pull the offset negative.
  const clampedOffset = Math.max(0, clip.offset + deltaStart);
  const offsetShift = clampedOffset - clip.offset;
  // If the offset was clamped, the visible start shifts to match.
  start = clip.startTime + offsetShift;

  return {
    ...clip,
    startTime: start,
    offset: clampedOffset,
    duration: Math.max(minLength, end - start),
  };
}

/** Move a clip along the timeline, clamped to be non-negative. */
export function moveClip(clip: Clip, newStartTime: number): Clip {
  return { ...clip, startTime: Math.max(0, newStartTime) };
}

/** Total project length in seconds (end of the last clip, or 0). */
export function projectDuration(project: Project): number {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clipEnd(clip));
    }
  }
  return max;
}

/** True if any track in the project is soloed. */
export function anySoloed(project: Project): boolean {
  return project.tracks.some((t) => t.soloed);
}

/**
 * Whether a track should be audible given the project's solo state:
 * muted tracks are silent; if anything is soloed, only soloed tracks play.
 */
export function isTrackAudible(track: Track, projectHasSolo: boolean): boolean {
  if (track.muted) return false;
  if (projectHasSolo) return track.soloed;
  return true;
}

/** Immutably replace a clip within a track's clip list. */
export function replaceClip(clips: Clip[], id: string, replacement: Clip[]): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    if (c.id === id) out.push(...replacement);
    else out.push(c);
  }
  return out;
}

/** Name for a copy of `name` that doesn't collide with `taken`:
 *  "Vocal" → "Vocal copy", then "Vocal copy 2", … */
export function copyName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `${name.replace(/ copy( \d+)?$/, "")} copy`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** A copy of a track: fresh track/clip ids, the same audio buffers (nothing is
 *  re-decoded), every mix + FX setting copied, and never armed (arming is
 *  transport state — the copy shouldn't steal the next take). */
export function cloneTrack(track: Track, name: string): Track {
  return {
    ...track,
    id: nextId("track"),
    name,
    armed: false,
    eq: { ...track.eq },
    synth: { ...track.synth },
    clips: track.clips.map((c) => ({ ...c, id: nextId("clip") })),
  };
}

/** Insert `copy` directly after the track with id `afterId`. */
export function insertTrackAfter(tracks: Track[], afterId: string, copy: Track): Track[] {
  const i = tracks.findIndex((t) => t.id === afterId);
  if (i < 0) return [...tracks, copy];
  return [...tracks.slice(0, i + 1), copy, ...tracks.slice(i + 1)];
}
