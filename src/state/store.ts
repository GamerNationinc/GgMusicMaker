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
import type { AudioBackend, MasterMeter } from "../audio/backend";
import * as history from "./history";
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
/** Pre-limiter peak/RMS/gain-reduction, refreshed every frame for the analogue meter. */
export const masterMeter = writable<MasterMeter>({ peak: 0, rms: 0, reduction: 0 });
/** Log-spaced spectrum bands (0..1) of the mix. The same array is re-set each frame. */
export const SPECTRUM_BANDS = 20;
export const masterSpectrum = writable<Float32Array>(new Float32Array(SPECTRUM_BANDS));
/** Export dialog state. `phase` drives the retro progress popup. */
export interface ExportState {
  phase: "idle" | "rendering" | "encoding" | "saving" | "done" | "error";
  fraction: number;
  message: string;
}
export const exportState = writable<ExportState>({ phase: "idle", fraction: 0, message: "" });
export const canUndo = writable<boolean>(false);
export const canRedo = writable<boolean>(false);
/** Timeline zoom, in pixels per second. */
export const pixelsPerSecond = writable<number>(80);
export const reverbSpace = writable<ReverbSpace>(engine.currentReverbSpace);

// ---- internal helpers -----------------------------------------------------

let hist = history.createHistory<Project>();

function setHistory(h: history.History<Project>): void {
  hist = h;
  canUndo.set(history.canUndo(h));
  canRedo.set(history.canRedo(h));
}

interface EditOptions {
  /** Coalesce key for continuous controls (see history.ts); `false` = not undoable. */
  history?: string | false;
}

/** Apply an edit to the project, record it for undo, and sync the engine. */
function updateProject(fn: (p: Project) => Project, opts: EditOptions = {}): void {
  project.update((p) => {
    const next = fn(p);
    if (next === p) return p;
    if (opts.history !== false) {
      setHistory(history.push(hist, p, opts.history ?? null, performance.now()));
    }
    engine.syncAll(next);
    return next;
  });
}

function updateTrack(trackId: string, fn: (t: Track) => Track, opts?: EditOptions): void {
  updateProject(
    (p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? fn(t) : t)),
    }),
    opts,
  );
}

/** Swap in a historical project state (undo/redo) and bring the engine along. */
function restoreProject(target: Project): void {
  const current = get(project);
  // Channels for tracks that no longer exist would linger in the graph.
  for (const t of current.tracks) {
    if (!target.tracks.some((x) => x.id === t.id)) engine.removeTrack(t.id);
  }
  project.set(target);
  engine.syncAll(target);
  // Clip edits must be audible immediately, like a voice-preset change is.
  if (get(transport).isPlaying) engine.play(target, get(transport).playhead);
  const clipIds = new Set(target.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  selectedClipId.update((id) => (id && clipIds.has(id) ? id : null));
  selectedTrackId.update((id) => (id && target.tracks.some((t) => t.id === id) ? id : null));
}

export function undo(): void {
  const r = history.undo(hist, get(project));
  if (!r) {
    status.set("Nothing to undo.");
    return;
  }
  setHistory(r.history);
  restoreProject(r.state);
  status.set("Undo.");
}

export function redo(): void {
  const r = history.redo(hist, get(project));
  if (!r) {
    status.set("Nothing to redo.");
    return;
  }
  setHistory(r.history);
  restoreProject(r.state);
  status.set("Redo.");
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
  updateTrack(trackId, (t) => ({ ...t, gain }), { history: `gain:${trackId}` });
}

export function setReverbSend(trackId: string, amount: number): void {
  updateTrack(trackId, (t) => ({ ...t, reverbSend: amount }), { history: `send:${trackId}` });
}

// ---- FX rack (v2) ---------------------------------------------------------

export function setEq(trackId: string, band: "low" | "mid" | "high", db: number): void {
  updateTrack(trackId, (t) => ({ ...t, eq: { ...t.eq, [band]: db } }), {
    history: `eq:${band}:${trackId}`,
  });
}

export function setVoiceMix(trackId: string, mix: number): void {
  updateTrack(trackId, (t) => ({ ...t, voice: { ...t.voice, mix } }), {
    history: `voicemix:${trackId}`,
  });
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

/** Arm exactly one track for recording (single-arm keeps v1 simple).
 *  Arming is transport state, not an edit, so it stays out of undo. */
export function armTrack(trackId: string): void {
  updateProject(
    (p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({ ...t, armed: t.id === trackId ? !t.armed : false })),
    }),
    { history: false },
  );
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
  updateTrack(
    trackId,
    (t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === clipId ? moveClip(c, newStart) : c)),
    }),
    { history: `move:${clipId}` },
  );
}

export function trimClipTo(
  trackId: string,
  clipId: string,
  newStart: number,
  newEnd: number,
): void {
  updateTrack(
    trackId,
    (t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === clipId ? trimClip(c, newStart, newEnd) : c)),
    }),
    { history: `trim:${clipId}` },
  );
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

const spectrumBuf = new Float32Array(SPECTRUM_BANDS);

function tick(): void {
  const t = get(transport);
  masterLevel.set(engine.masterLevel());
  masterMeter.set(engine.masterMeter());
  masterSpectrum.set(engine.masterSpectrum(spectrumBuf));
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

let exportCloseTimer = 0;
function setExport(phase: ExportState["phase"], fraction: number, message = ""): void {
  exportState.set({ phase, fraction, message });
}

export function dismissExport(): void {
  clearTimeout(exportCloseTimer);
  setExport("idle", 0);
}

/** Render the mix to WAV and save it (Tauri dialog if available, else download).
 *  Drives `exportState` so the UI can show progress and the outcome. */
export async function exportMix(): Promise<void> {
  const p = get(project);
  if (projectDuration(p) === 0) {
    status.set("Nothing to export yet.");
    return;
  }
  if (get(exportState).phase !== "idle" && get(exportState).phase !== "done") return;
  clearTimeout(exportCloseTimer);

  try {
    setExport("rendering", 0);
    status.set("Rendering mix…");
    const rendered = await engine.renderMix(p, 3, (f) => setExport("rendering", f));
    setExport("encoding", 1);
    // Let the bar paint the encoding phase before the synchronous encode.
    await new Promise((r) => setTimeout(r, 30));
    const bytes = new Uint8Array(encodeWav(rendered));

    const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    let where: string;
    if (isTauri) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      setExport("saving", 1);
      const path = await save({
        defaultPath: "ggmusicmaker-mix.wav",
        filters: [{ name: "WAV audio", extensions: ["wav"] }],
      });
      if (!path) {
        dismissExport();
        status.set("Export cancelled.");
        return;
      }
      await writeFile(path, bytes);
      where = path;
    } else {
      // Browser fallback: trigger a download.
      setExport("saving", 1);
      const blob = new Blob([bytes], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ggmusicmaker-mix.wav";
      a.click();
      URL.revokeObjectURL(url);
      where = "ggmusicmaker-mix.wav";
    }
    const secs = rendered.duration.toFixed(1);
    setExport("done", 1, `${secs}s → ${where}`);
    status.set(`Exported ${where}`);
    exportCloseTimer = window.setTimeout(dismissExport, 2500);
  } catch (err) {
    const msg = (err as Error).message;
    setExport("error", 0, msg);
    status.set(`Export failed: ${msg}`);
  }
}
