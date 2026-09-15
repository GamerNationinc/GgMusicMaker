// Application state + actions.
//
// Svelte stores hold the serializable project + live transport state; a single
// AudioEngine instance does the sound. Every action that changes mix params or
// structure updates the store immutably and syncs the engine. This is the one
// place the UI and the audio runtime meet.

import { writable, get } from "svelte/store";
import type { Project, Track, Clip, TransportState } from "../audio/types";
import { nextId, reserveIds, TRACK_COLORS } from "../audio/types";
import {
  splitClip,
  trimClip,
  moveClip,
  timeInsideClip,
  projectDuration,
  replaceClip,
  cloneTrack,
  copyName,
  insertTrackAfter,
} from "../audio/edits";
import { AudioEngine } from "../audio/engine";
import type { AudioBackend, MasterMeter } from "../audio/backend";
import * as history from "./history";
import { encodeWav } from "../audio/wav";
import {
  DEFAULT_SYNTH,
  SYNTH_PRESETS,
  clampSynthValue,
  presetParams,
  surroundChannels,
  SURROUND,
  type SynthKey,
  type SurroundLayout,
} from "../fx/voice-synth";
import type { ReverbSpace } from "../audio/reverb";
import {
  packSession,
  unpackSession,
  sessionDisplayName,
  SESSION_EXTENSION,
} from "./session";
import { saveBytes, openBytes, confirmDialog, isTauri } from "./platform";
import { INITIAL_LOAD, type LoadState, frameUtilisation, ema, audioDropout } from "./load";

/** The audio runtime. Typed as the interface, not the class, so a future
 *  native backend can be swapped in without touching the store or the UI. */
export const engine: AudioBackend = new AudioEngine();

export const project = writable<Project>({
  tracks: [],
  sampleRate: engine.sampleRate,
  surround: "stereo",
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
/** Channels the live output really has for the chosen layout (2 on a stereo
 *  device even when the project is 5.1 — the synth folds its field down). */
export const liveChannels = writable<number>(engine.liveChannels);
/** Ableton-style load readout: UI-thread utilisation + audio dropout lamp. */
export const systemLoad = writable<LoadState>(INITIAL_LOAD);
const LOW_POWER_KEY = "ggmm.lowPower";
function readLowPower(): boolean {
  try {
    return localStorage.getItem(LOW_POWER_KEY) === "1";
  } catch {
    return false;
  }
}
/** Eco mode for battery: no backdrop animation, meters at a lower rate. */
export const lowPower = writable<boolean>(readLowPower());
export function toggleLowPower(): void {
  lowPower.update((on) => {
    const next = !on;
    try {
      localStorage.setItem(LOW_POWER_KEY, next ? "1" : "0");
    } catch {
      /* private mode etc. — the toggle still works for this run */
    }
    status.set(next ? "Low-power mode on: backdrop off, meters slowed." : "Low-power mode off.");
    return next;
  });
}
/** Where the session was last saved/opened (null = never saved). */
export const sessionPath = writable<string | null>(null);
/** True when the project has changed since it was last saved or opened. */
export const dirty = writable<boolean>(false);

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
      dirty.set(true);
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
  engine.setSurround(target.surround);
  liveChannels.set(engine.liveChannels);
  engine.syncAll(target);
  // Clip edits must be audible immediately, like a synth change is.
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
    synth: { ...DEFAULT_SYNTH },
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

/** Copy a layer — clips (sharing the audio), mix, FX, colour — and drop it
 *  right under the original. Undoable; audible at once if playing. */
export function duplicateTrack(trackId: string): string | null {
  const src = get(project).tracks.find((t) => t.id === trackId);
  if (!src) return null;
  const copy = cloneTrack(src, copyName(src.name, get(project).tracks.map((t) => t.name)));
  updateProject((p) => ({ ...p, tracks: insertTrackAfter(p.tracks, trackId, copy) }));
  if (get(transport).isPlaying) engine.play(get(project), get(transport).playhead);
  status.set(`Duplicated ${src.name} → ${copy.name}.`);
  return copy.id;
}

/** Ctrl+D: duplicate the layer whose FX rack is open, else the selected clip's layer. */
export function duplicateSelectedTrack(): void {
  const p = get(project);
  const clipId = get(selectedClipId);
  const id = get(selectedTrackId) ?? p.tracks.find((t) => t.clips.some((c) => c.id === clipId))?.id;
  if (!id) {
    status.set("Select a layer (open its FX) or a clip to duplicate.");
    return;
  }
  duplicateTrack(id);
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

/** Turn one Voice Synth knob. Drags coalesce into a single undo step. */
export function setSynthParam(trackId: string, key: SynthKey, value: number): void {
  const v = clampSynthValue(key, value);
  updateTrack(trackId, (t) => (t.synth[key] === v ? t : { ...t, synth: { ...t.synth, [key]: v } }), {
    history: `synth:${key}:${trackId}`,
  });
}

/** Load a factory preset onto a track's synth. Makes sure the audio device
 *  (and the worklet) are up first, since this is usually the first FX click. */
export async function applySynthPreset(trackId: string, name: string): Promise<void> {
  const preset = SYNTH_PRESETS.find((p) => p.name === name);
  if (!preset) return;
  await engine.ensureRunning();
  updateTrack(trackId, (t) => ({ ...t, synth: presetParams(preset) }));
  status.set(`Voice Synth: ${preset.name} on the selected layer.`);
}

/** Change the project's output layout (stereo / 5.1 / 7.1). Rebuilds the
 *  live graph when the device can follow; export always renders the layout. */
export async function setSurround(layout: SurroundLayout): Promise<void> {
  await engine.ensureRunning();
  const rebuilt = engine.setSurround(layout);
  updateProject((p) => (p.surround === layout ? p : { ...p, surround: layout }), { history: "surround" });
  liveChannels.set(engine.liveChannels);
  if (rebuilt && get(transport).isPlaying) engine.play(get(project), get(transport).playhead);
  const want = surroundChannels(layout);
  const note =
    engine.liveChannels >= want
      ? ""
      : ` — this device outputs ${engine.liveChannels} channels, so you hear a fold-down; the WAV export gets all ${want}.`;
  status.set(`Output: ${SURROUND[layout].label}${note}`);
}

export function setReverbSpace(space: ReverbSpace): void {
  engine.setReverbSpace(space);
  reverbSpace.set(space);
  dirty.set(true);
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

// ---- frame pacing ----------------------------------------------------------
// The loop runs every animation frame, but the *work* is gated: idle (nothing
// playing, recording, or sounding for a while) drops the meters to a few Hz
// and, once they have decayed to silence, stops pushing identical values —
// every push repaints the ASCII VU and the LED strip, which is the single
// heaviest thing this app does at rest. Low-power mode caps the rate too.
const IDLE_AFTER_MS = 2500;
const IDLE_FPS = 8;
const LOW_POWER_FPS = 20;
const SILENCE = 1e-4;
let lastActivityAt = 0;
let lastMeterAt = 0;
let meterSilent = false;

// Load probe state (see state/load.ts).
let prevFrameAt = 0;
let cpuEma = 0;
let loadPublishedAt = 0;
let dropoutUntil = 0;
let dropouts = 0;
let clockCheckAt = 0;
let clockCheckAudio = 0;
const LOAD_PUBLISH_MS = 250;
const CLOCK_CHECK_MS = 1000;
const DROPOUT_LAMP_MS = 1500;

function probeLoad(now: number): void {
  const interval = now - prevFrameAt;
  prevFrameAt = now;
  // Busy time: from the top of this frame until a zero-delay timer can run,
  // i.e. after our tick, the Svelte effects it queued, and this frame's
  // layout + paint. That is the main thread's real cost per frame.
  const start = performance.now();
  setTimeout(() => {
    const busy = performance.now() - start;
    if (interval > 0 && interval < 1000) cpuEma = ema(cpuEma, frameUtilisation(busy, interval), 0.08);
  }, 0);

  // Audio clock vs wall clock, once a second, only while the device runs.
  if (engine.isAudioReady) {
    if (clockCheckAt === 0) {
      clockCheckAt = now;
      clockCheckAudio = engine.audioClock();
    } else if (now - clockCheckAt >= CLOCK_CHECK_MS) {
      const wall = (now - clockCheckAt) / 1000;
      const audio = engine.audioClock() - clockCheckAudio;
      // Only judge while something is actually being rendered; an idle
      // context in some WebViews parks its clock without any "dropout".
      if ((get(transport).isPlaying || get(transport).isRecording) && audioDropout(audio, wall)) {
        dropouts += 1;
        dropoutUntil = now + DROPOUT_LAMP_MS;
      }
      clockCheckAt = now;
      clockCheckAudio = engine.audioClock();
    }
  } else {
    clockCheckAt = 0;
  }

  if (now - loadPublishedAt >= LOAD_PUBLISH_MS) {
    loadPublishedAt = now;
    systemLoad.set({ cpu: cpuEma, dropout: now < dropoutUntil, dropouts });
  }
}

function tick(now: number): void {
  rafId = requestAnimationFrame(tick);
  probeLoad(now);

  const t = get(transport);
  const active = t.isPlaying || t.isRecording;
  if (active) lastActivityAt = now;
  const idle = now - lastActivityAt > IDLE_AFTER_MS;
  const fps = idle ? IDLE_FPS : get(lowPower) ? LOW_POWER_FPS : Infinity;
  if (now - lastMeterAt < 1000 / fps) return;
  lastMeterAt = now;

  const level = engine.masterLevel();
  const meter = engine.masterMeter();
  const sounding = level > SILENCE || meter.peak > SILENCE;
  if (sounding) lastActivityAt = now;
  // Nothing has changed and nothing is moving: leave the meters as drawn.
  if (idle && !sounding && meterSilent) return;
  meterSilent = idle && !sounding;

  masterLevel.set(level);
  masterMeter.set(meter);
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

    setExport("saving", 1);
    const suffix = p.surround === "stereo" ? "" : `-${p.surround}`;
    const where = await saveBytes(bytes, {
      defaultName: `ggmusicmaker-mix${suffix}.wav`,
      filters: [{ name: "WAV audio", extensions: ["wav"] }],
      mime: "audio/wav",
    });
    if (!where) {
      dismissExport();
      status.set("Export cancelled.");
      return;
    }
    const secs = rendered.duration.toFixed(1);
    const ch = rendered.numberOfChannels > 2 ? ` (${rendered.numberOfChannels} ch)` : "";
    setExport("done", 1, `${secs}s${ch} → ${where}`);
    status.set(`Exported ${where}`);
    exportCloseTimer = window.setTimeout(dismissExport, 2500);
  } catch (err) {
    const msg = (err as Error).message;
    setExport("error", 0, msg);
    status.set(`Export failed: ${msg}`);
  }
}

// ---- sessions -------------------------------------------------------------

const SESSION_FILTERS = [{ name: "GgMusicMaker session", extensions: [SESSION_EXTENSION] }];

/** Tear down the current project: stop, drop every channel, clear history. */
function resetWorkspace(next: Project): void {
  if (get(transport).isRecording) void engine.stopRecording().catch(() => undefined);
  stop();
  for (const t of get(project).tracks) engine.removeTrack(t.id);
  project.set(next);
  engine.setSurround(next.surround);
  liveChannels.set(engine.liveChannels);
  engine.syncAll(next);
  setHistory(history.createHistory<Project>());
  selectedClipId.set(null);
  selectedTrackId.set(null);
  transport.update((s) => ({ ...s, isRecording: false, playhead: 0 }));
}

/** Ask before throwing away unsaved work. Resolves true when it's safe to go on. */
async function confirmDiscard(): Promise<boolean> {
  if (!get(dirty)) return true;
  return confirmDialog(
    `${sessionDisplayName(get(sessionPath))} has unsaved changes. Discard them?`,
    "Unsaved changes",
  );
}

/** Start over with an empty project. */
export async function newSession(): Promise<void> {
  if (!(await confirmDiscard())) return;
  resetWorkspace({ tracks: [], sampleRate: engine.sampleRate, surround: "stereo" });
  sessionPath.set(null);
  dirty.set(false);
  status.set("New session.");
}

/** Save the session to its file, or ask where if it has none / `as` is set. */
export async function saveSession(as = false): Promise<void> {
  const p = get(project);
  try {
    status.set("Saving session…");
    const t = get(transport);
    const file = packSession(
      p,
      { reverbSpace: get(reverbSpace), pixelsPerSecond: get(pixelsPerSecond), playhead: t.playhead },
      (id) => engine.getBuffer(id),
    );
    const current = get(sessionPath);
    // Save As starts from the current file so the dialog opens in its folder.
    const where = await saveBytes(new Uint8Array(file), {
      defaultName: current ?? `untitled.${SESSION_EXTENSION}`,
      filters: SESSION_FILTERS,
      path: as ? null : current,
    });
    if (!where) {
      status.set("Save cancelled.");
      return;
    }
    sessionPath.set(where);
    dirty.set(false);
    const mb = (file.byteLength / 1048576).toFixed(1);
    status.set(`Saved ${sessionDisplayName(where)} (${mb} MB).`);
  } catch (err) {
    status.set(`Save failed: ${(err as Error).message}`);
  }
}

/** Replace the workspace with the session in `bytes`. */
export async function loadSessionBytes(bytes: ArrayBuffer, path: string | null): Promise<void> {
  const { header, audio } = unpackSession(bytes);
  // Audio goes into the engine under fresh ids; clips are pointed at those.
  const idMap = new Map<string, string>();
  for (const [id, pcm] of audio) idMap.set(id, engine.registerPcm(pcm.sampleRate, pcm.channels));
  const loaded: Project = {
    ...header.project,
    sampleRate: engine.sampleRate,
    tracks: header.project.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => ({ ...c, bufferId: idMap.get(c.bufferId) ?? c.bufferId })),
    })),
  };
  reserveIds(loaded.tracks.flatMap((t) => [t.id, ...t.clips.map((c) => c.id)]));
  colorIdx = loaded.tracks.length;

  resetWorkspace(loaded);
  if (header.reverbSpace) setReverbSpace(header.reverbSpace);
  if (header.pixelsPerSecond) pixelsPerSecond.set(header.pixelsPerSecond);
  seek(header.playhead ?? 0);
  sessionPath.set(path);
  dirty.set(false);
  const n = loaded.tracks.length;
  status.set(`Opened ${sessionDisplayName(path)} — ${n} layer${n === 1 ? "" : "s"}.`);
}

/** Open a session from a File (browser file input; the caller has already
 *  confirmed discarding unsaved work via `confirmDiscardForOpen`). */
export async function loadSessionFile(file: File): Promise<void> {
  try {
    await loadSessionBytes(await file.arrayBuffer(), file.name);
  } catch (err) {
    status.set(`Couldn't open ${file.name}: ${(err as Error).message}`);
  }
}

/** Browser flow: ask about unsaved work *before* the file picker appears. */
export async function confirmDiscardForOpen(): Promise<boolean> {
  return confirmDiscard();
}

/** Open a session via the native dialog. Returns false when the platform has
 *  no dialog (browser), so the caller can fall back to a file input. */
export async function openSession(): Promise<boolean> {
  if (!isTauri()) return false;
  if (!(await confirmDiscard())) return true;
  try {
    const picked = await openBytes(SESSION_FILTERS);
    if (!picked) {
      status.set("Open cancelled.");
      return true;
    }
    await loadSessionBytes(picked.bytes, picked.path);
  } catch (err) {
    status.set(`Couldn't open session: ${(err as Error).message}`);
  }
  return true;
}
