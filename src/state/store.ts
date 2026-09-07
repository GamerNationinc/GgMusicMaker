// Application state + actions.
//
// Svelte stores hold the serializable project + live transport state; a single
// AudioEngine instance does the sound. Every action that changes mix params or
// structure updates the store immutably and syncs the engine. This is the one
// place the UI and the audio runtime meet.

import { writable, get } from "svelte/store";
import type { Project, Track, Clip, TransportState } from "../audio/types";
import { nextId, TRACK_COLORS } from "../audio/types";
import {
  splitClip,
  trimClip,
  moveClip,
  timeInsideClip,
  projectDuration,
  replaceClip,
} from "../audio/edits";
import { AudioEngine } from "../audio/engine";
import type { AudioBackend } from "../audio/backend";
import { encodeWav } from "../audio/wav";
import type { VoicePreset } from "../fx/voice";
import type { ReverbSpace } from "../audio/reverb";

/** The audio runtime. Typed as the interface, not the class, so a future
 *  native backend can be swapped in without touching the store or the UI. */
export const engine: AudioBackend = new AudioEngine();

export const project = writable<Project>({
  tracks: [],
  sampleRate: engine.sampleRate,
});

export const transport = writable<TransportState>({
  isPlaying: false,
  isRecording: false,
  playhead: 0,
  looping: false,
});

export const selectedClipId = writable<string | null>(null);
/** Track whose FX rack is open, or null when the rack is closed. */
export const selectedTrackId = writable<string | null>(null);
export const status = writable<string>("Ready. Import an audio file to begin.");
export const masterLevel = writable<number>(0);
/** Timeline zoom, in pixels per second. */
export const pixelsPerSecond = writable<number>(80);
export const reverbSpace = writable<ReverbSpace>(engine.currentReverbSpace);

// ---- internal helpers -----------------------------------------------------

function updateProject(fn: (p: Project) => Project): void {
  project.update((p) => {
    const next = fn(p);
    engine.syncAll(next);
    return next;
  });
}

function updateTrack(trackId: string, fn: (t: Track) => Track): void {
  updateProject((p) => ({
    ...p,
    tracks: p.tracks.map((t) => (t.id === trackId ? fn(t) : t)),
  }));
}

let colorIdx = 0;
function makeTrack(name: string): Track {
  const color = TRACK_COLORS[colorIdx % TRACK_COLORS.length];
  colorIdx += 1;
  return {
    id: nextId("track"),
    name,
    gain: 1,
    muted: false,
    soloed: false,
    armed: false,
    reverbSend: 0,
    eq: { low: 0, mid: 0, high: 0 },
    voice: { preset: "off", mix: 1 },
    color,
    clips: [],
  };
}

// ---- track actions --------------------------------------------------------

export function addEmptyTrack(): string {
  const track = makeTrack(`Layer ${get(project).tracks.length + 1}`);
  updateProject((p) => ({ ...p, tracks: [...p.tracks, track] }));
  status.set(`Added ${track.name}.`);
  return track.id;
}

export function removeTrack(trackId: string): void {
  engine.removeTrack(trackId);
  updateProject((p) => ({ ...p, tracks: p.tracks.filter((t) => t.id !== trackId) }));
  selectedTrackId.update((cur) => (cur === trackId ? null : cur));
}

export function setTrackGain(trackId: string, gain: number): void {
  updateTrack(trackId, (t) => ({ ...t, gain }));
}

export function setReverbSend(trackId: string, amount: number): void {
  updateTrack(trackId, (t) => ({ ...t, reverbSend: amount }));
}

// ---- FX rack (v2) ---------------------------------------------------------

export function setEq(trackId: string, band: "low" | "mid" | "high", db: number): void {
  updateTrack(trackId, (t) => ({ ...t, eq: { ...t.eq, [band]: db } }));
}

export function setVoiceMix(trackId: string, mix: number): void {
  updateTrack(trackId, (t) => ({ ...t, voice: { ...t.voice, mix } }));
}

/** Change a track's voice preset. Rebuilds the FX chain and, if playing,
 *  reschedules so the change is heard immediately. */
export async function setVoicePreset(trackId: string, preset: VoicePreset): Promise<void> {
  await engine.ensureRunning();
  updateTrack(trackId, (t) => ({ ...t, voice: { ...t.voice, preset } }));
  if (get(transport).isPlaying) engine.play(get(project), get(transport).playhead);
  status.set(`Voice: ${preset} on the selected layer.`);
}

export function setReverbSpace(space: ReverbSpace): void {
  engine.setReverbSpace(space);
  reverbSpace.set(space);
  status.set(`Reverb space: ${space}.`);
}

export function toggleMute(trackId: string): void {
  updateTrack(trackId, (t) => ({ ...t, muted: !t.muted }));
}

export function toggleSolo(trackId: string): void {
  updateTrack(trackId, (t) => ({ ...t, soloed: !t.soloed }));
}

export function renameTrack(trackId: string, name: string): void {
  updateTrack(trackId, (t) => ({ ...t, name }));
}

/** Arm exactly one track for recording (single-arm keeps v1 simple). */
export function armTrack(trackId: string): void {
  updateProject((p) => ({
    ...p,
    tracks: p.tracks.map((t) => ({ ...t, armed: t.id === trackId ? !t.armed : false })),
  }));
}

// ---- import ---------------------------------------------------------------

/** Decode files and drop each onto its own new layer at the playhead. */
export async function importFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  const at = get(transport).playhead;
  for (const file of list) {
    try {
      status.set(`Decoding ${file.name}…`);
      const bytes = await file.arrayBuffer();
      const { bufferId, buffer } = await engine.decodeBytes(bytes);
      const track = makeTrack(file.name.replace(/\.[^.]+$/, ""));
      const clip: Clip = {
        id: nextId("clip"),
        bufferId,
        startTime: at,
        offset: 0,
        duration: buffer.duration,
        name: track.name,
      };
      track.clips = [clip];
      updateProject((p) => ({ ...p, tracks: [...p.tracks, track] }));
      status.set(`Imported ${file.name} (${buffer.duration.toFixed(1)}s).`);
    } catch (err) {
      status.set(`Couldn't decode ${file.name}: ${(err as Error).message}`);
    }
  }
}

// ---- editing --------------------------------------------------------------

/** Split every clip that the playhead currently sits inside. */
export function splitAtPlayhead(): void {
  const time = get(transport).playhead;
  let count = 0;
  updateProject((p) => ({
    ...p,
    tracks: p.tracks.map((t) => {
      let clips = t.clips;
      for (const clip of t.clips) {
        if (timeInsideClip(clip, time)) {
          clips = replaceClip(clips, clip.id, splitClip(clip, time));
          count += 1;
        }
      }
      return { ...t, clips };
    }),
  }));
  status.set(count ? `Split ${count} clip(s) at ${time.toFixed(2)}s.` : "Nothing under the playhead to split.");
}

export function deleteSelectedClip(): void {
  const id = get(selectedClipId);
  if (!id) {
    status.set("Select a clip first.");
    return;
  }
  updateProject((p) => ({
    ...p,
    tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== id) })),
  }));
  selectedClipId.set(null);
  status.set("Deleted clip.");
}

export function moveClipTo(trackId: string, clipId: string, newStart: number): void {
  updateTrack(trackId, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? moveClip(c, newStart) : c)),
  }));
}

export function trimClipTo(
  trackId: string,
  clipId: string,
  newStart: number,
  newEnd: number,
): void {
  updateTrack(trackId, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? trimClip(c, newStart, newEnd) : c)),
  }));
}

export function selectClip(clipId: string | null): void {
  selectedClipId.set(clipId);
}

/** Toggle the FX rack for a track (open it, or close it if already open). */
export function toggleFxRack(trackId: string): void {
  selectedTrackId.update((cur) => (cur === trackId ? null : trackId));
}

// ---- transport ------------------------------------------------------------

let rafId = 0;

function tick(): void {
  const t = get(transport);
  masterLevel.set(engine.masterLevel());
  if (t.isPlaying) {
    const now = engine.currentTime();
    const end = projectDuration(get(project));
    if (end > 0 && now >= end) {
      stop();
      seek(0);
    } else {
      transport.update((s) => ({ ...s, playhead: now }));
    }
  }
  rafId = requestAnimationFrame(tick);
}

export function startMeterLoop(): void {
  if (!rafId) rafId = requestAnimationFrame(tick);
}

export async function play(): Promise<void> {
  await engine.ensureRunning();
  if (!engine.isAudioReady) {
    // Most likely cause on Linux: WebKitGTK couldn't build its GStreamer audio
    // pipeline. Say so rather than appearing to play in silence.
    status.set("No audio output available — check the system audio (GStreamer) setup.");
    return;
  }
  const from = get(transport).playhead;
  engine.play(get(project), from);
  transport.update((s) => ({ ...s, isPlaying: true }));
  status.set("Playing.");
}

export function stop(): void {
  engine.stop();
  transport.update((s) => ({ ...s, isPlaying: false }));
}

export function togglePlay(): void {
  if (get(transport).isPlaying) stop();
  else void play();
}

export function seek(time: number): void {
  const clamped = Math.max(0, time);
  transport.update((s) => ({ ...s, playhead: clamped }));
  if (get(transport).isPlaying) {
    engine.play(get(project), clamped);
  }
}

// ---- recording ------------------------------------------------------------

export async function startRecording(): Promise<void> {
  let armed = get(project).tracks.find((t) => t.armed);
  if (!armed) {
    const id = addEmptyTrack();
    armTrack(id);
    armed = get(project).tracks.find((t) => t.id === id)!;
  }
  try {
    await engine.startRecording();
    transport.update((s) => ({ ...s, isRecording: true }));
    status.set(`Recording onto ${armed.name}…`);
  } catch (err) {
    status.set(`Mic unavailable: ${(err as Error).message}`);
  }
}

export async function stopRecording(): Promise<void> {
  if (!engine.isRecording) return;
  const startedAt = get(transport).playhead;
  const usedWorklet = engine.recordingUsesWorklet;
  const buffer = await engine.stopRecording();
  const bufferId = engine.registerBuffer(buffer);
  const armed = get(project).tracks.find((t) => t.armed);
  transport.update((s) => ({ ...s, isRecording: false }));
  if (!armed) return;

  const clip: Clip = {
    id: nextId("clip"),
    bufferId,
    startTime: startedAt,
    offset: 0,
    duration: buffer.duration,
    name: "Take",
  };
  updateTrack(armed.id, (t) => ({ ...t, clips: [...t.clips, clip] }));
  // Flag the degraded capture path so a glitchy take has a visible cause.
  const note = usedWorklet ? "" : " (fallback capture — may drop samples)";
  status.set(`Recorded ${buffer.duration.toFixed(1)}s onto ${armed.name}.${note}`);
}

// ---- export ---------------------------------------------------------------

/** Render the mix to WAV and save it (Tauri dialog if available, else download). */
export async function exportMix(): Promise<void> {
  const p = get(project);
  if (projectDuration(p) === 0) {
    status.set("Nothing to export yet.");
    return;
  }
  status.set("Rendering mix…");
  const rendered = await engine.renderMix(p);
  const wav = encodeWav(rendered);
  const bytes = new Uint8Array(wav);

  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (isTauri) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: "profitpals-mix.wav",
        filters: [{ name: "WAV audio", extensions: ["wav"] }],
      });
      if (!path) {
        status.set("Export cancelled.");
        return;
      }
      await writeFile(path, bytes);
      status.set(`Exported to ${path}`);
      return;
    } catch (err) {
      status.set(`Export failed: ${(err as Error).message}`);
      return;
    }
  }

  // Browser fallback: trigger a download.
  const blob = new Blob([bytes], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "profitpals-mix.wav";
  a.click();
  URL.revokeObjectURL(url);
  status.set("Exported profitpals-mix.wav");
}
