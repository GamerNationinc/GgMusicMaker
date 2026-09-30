// Application state + actions.
//
// Svelte stores hold the serializable project + live transport state; a single
// AudioEngine instance does the sound. Every action that changes mix params or
// structure updates the store immutably and syncs the engine. This is the one
// place the UI and the audio runtime meet.

import { prepareSummary } from "../render/peaks";
import { writable, get } from "svelte/store";
import type { Project, Track, Clip, TransportState } from "../audio/types";
import { nextId, reserveIds, TRACK_COLORS, EQ_CUT_OFF } from "../audio/types";
import { syncStacks, makeStackLayer, mirrorClips, ensureLinkIds, stackMembers } from "../audio/stacks";
import { STACK_RECIPES, findRack, rackTrack } from "../fx/racks";
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
  soloTracks,
} from "../audio/edits";
import { AudioEngine } from "../audio/engine";
import { NativeBackend, type NativeEngineBridge } from "../audio/native";
import type { AudioBackend, MasterMeter } from "../audio/backend";
import * as history from "./history";
import { encodeWav, wavParts } from "../audio/wav";
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
import { FX_ALL_ON, type FxSlot } from "../fx/chain";
import {
  DEFAULT_MORPH,
  MORPH_ALGOS,
  MORPH_PRESETS,
  clampMorphValue,
  morphPresetParams,
  type MorphKey,
} from "../fx/morph";
import {
  DEFAULT_PUNCH,
  PUNCH_PRESETS,
  clampPunchValue,
  punchPresetParams,
  type PunchKey,
} from "../fx/punch";
import {
  packSessionParts,
  planSession,
  readSession,
  unpackSession,
  type SessionHeaderBase,
  sessionDisplayName,
  SESSION_EXTENSION,
} from "./session";
import { saveBytes, confirmDialog, isNative, autosaveBridge, autosaveInterval, separationBridge, fileStreams } from "./platform";
import { STEM_RATE, audibleStems, rms, stemLayerName, stemSummary } from "../audio/stems";
import { Autosaver, recoverAutosave as readAutosave, AUTOSAVE_MS } from "./autosave";
import type { DecodedPcm } from "../audio/wav";
import { INITIAL_LOAD, type LoadState, frameUtilisation, ema, audioDropout } from "./load";

/** The audio runtime. Typed as the interface, not the class, so a future
 *  native backend can be swapped in without touching the store or the UI. */
export const engine: AudioBackend = createBackend();

/** Which audio engine this run uses (chosen at startup; switching reloads). */
export type EngineKind = "web" | "native";
const ENGINE_KEY = "ggmm.engine";
function wantedEngine(): EngineKind {
  try {
    // (literal, not ENGINE_KEY: this runs while `engine` initialises, above it)
    // Native is the default in the desktop app; "web" only if chosen.
    return localStorage.getItem("ggmm.engine") === "web" ? "web" : "native";
  } catch {
    return "web";
  }
}
function createBackend(): AudioBackend {
  const web = new AudioEngine();
  const bridge = (globalThis as { ggmmNative?: { engine?: NativeEngineBridge } }).ggmmNative?.engine;
  if (wantedEngine() !== "native" || !bridge) return web;
  return new NativeBackend(web, bridge);
}
export const engineKind: EngineKind = engine instanceof NativeBackend ? "native" : "web";
/** Whether this build can run the native engine at all (desktop app only). */
export const nativeEngineAvailable = !!(globalThis as { ggmmNative?: { engine?: unknown } }).ggmmNative?.engine;
/** Shown next to the ENGINE switch (e.g. when native fell back to web). */
export const engineNote = writable<string>("");
if (engine instanceof NativeBackend) {
  engine.onFallback = (why) => {
    engineNote.set(`native engine off (${why}) — using web`);
    status.set(`Native engine unavailable (${why}); playing through the web engine.`);
  };
}

/** Calibrated recording latency (ms) for the current devices; null = not
 *  calibrated (or the engine can't record natively). */
export const recordLatency = writable<number | null>(null);
/** Whether this engine can measure recording latency (native only). */
export const canCalibrate = !!engine.calibrateLatency;
if (canCalibrate) {
  // The output device's name arrives with the engine's first status.
  setTimeout(() => recordLatency.set(engine.recordLatency ?? null), 1500);
}

/** Input devices for the mic picker (native: cpal names; web: browser
 *  devices, labelled once permission is granted). */
export const inputDevices = writable<{ id: string; label: string }[]>([]);
const INPUT_DEVICE_KEY = "ggmm.inputDevice";
/** The chosen device's id, or "" for the default mic. */
export const selectedInputDevice = writable<string>("");
try {
  const saved = localStorage.getItem(INPUT_DEVICE_KEY) ?? "";
  selectedInputDevice.set(saved);
  engine.setInputDevice(saved || undefined);
} catch {
  // Storage unavailable (private browsing): default mic only.
}

/** Refresh the device list. Call on startup (unlabelled is fine — the
 *  picker still offers "Default mic") and pass `unlock: true` from a user
 *  gesture (opening the picker) to prompt for the mic permission and get
 *  the web engine's real device labels. */
export async function refreshInputDevices(unlock = false): Promise<void> {
  const devices = await engine.listInputDevices(unlock).catch(() => []);
  inputDevices.set(devices);
  // A device that's since disappeared (unplugged) quietly falls back to
  // the default rather than erroring on the next recording.
  const wanted = get(selectedInputDevice);
  if (wanted && !devices.some((d) => d.id === wanted)) setInputDevice("");
}
void refreshInputDevices();

export function setInputDevice(id: string): void {
  selectedInputDevice.set(id);
  engine.setInputDevice(id || undefined);
  try {
    localStorage.setItem(INPUT_DEVICE_KEY, id);
  } catch {
    // Storage unavailable: the choice just won't persist across launches.
  }
}

/** Measure the speaker → mic round trip so native takes land in time. */
export async function calibrateRecording(): Promise<void> {
  if (!engine.calibrateLatency) return;
  if (get(transport).isRecording) return;
  const ok = await confirmDialog(
    "Calibrate recording latency?\n\nGgMusicMaker will play a few clicks through the speakers and listen with the mic for about 4 seconds. Use the setup you record with (same speakers or headphones-to-mic loop), with the volume up.",
    "Calibrate recording",
  );
  if (!ok) return;
  stop();
  status.set("Calibrating — playing clicks and listening…");
  try {
    const { ms } = await engine.calibrateLatency();
    recordLatency.set(ms);
    status.set(`Recording latency: ${ms.toFixed(1)} ms (calibrated). New takes are shifted by this much.`);
  } catch (err) {
    status.set(`Calibration failed: ${(err as Error).message}`);
  }
}

/** Switch engines. It's picked at startup, so this restarts the app window. */
export async function setEngineKind(kind: EngineKind): Promise<void> {
  if (kind === engineKind) return;
  if (get(dirty) && !(await confirmDialog("Switching the audio engine restarts GgMusicMaker — unsaved changes will be lost. Continue?"))) return;
  try {
    localStorage.setItem(ENGINE_KEY, kind);
  } catch {
    return;
  }
  dirty.set(false);
  await autosaver?.clear();
  location.reload();
}

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
const HEADPHONES_KEY = "ggmm.headphones3d";
function readHeadphones(): boolean {
  try {
    return localStorage.getItem(HEADPHONES_KEY) !== "0";
  } catch {
    return true;
  }
}
/** Headphone 3D monitor wanted (applies when the device has fewer channels than the layout). */
export const headphones3d = writable<boolean>(readHeadphones());
/** True while the live bus is actually being rendered binaurally. */
export const binauralLive = writable<boolean>(false);
engine.setHeadphones3d(get(headphones3d));
/** Where the session was last saved/opened (null = never saved). */
export const sessionPath = writable<string | null>(null);
/** True when the project has changed since it was last saved or opened. */
export const dirty = writable<boolean>(false);

// ---- autosave + crash recovery (desktop app) ------------------------------

const autosaveStore = autosaveBridge();
const autosaver = autosaveStore ? new Autosaver(autosaveStore, (id) => engine.getBuffer(id)) : null;

/** Write unsaved work to the autosave now (no-op if nothing changed). */
export async function autosaveNow(): Promise<boolean> {
  if (!autosaver || !get(dirty) || get(transport).isRecording) return false;
  try {
    return await autosaver.save(
      get(project),
      { reverbSpace: get(reverbSpace), pixelsPerSecond: get(pixelsPerSecond), playhead: get(transport).playhead },
      get(sessionPath),
    );
  } catch (err) {
    console.error("autosave:", err);
    return false;
  }
}

/** Throw the autosave away: the user saved, or chose to discard. */
export async function clearAutosave(): Promise<void> {
  try {
    await autosaver?.clear();
  } catch (err) {
    console.error("autosave clear:", err);
  }
}

/** Start the autosave timer. Call once, after `recoverAutosave`. */
export async function startAutosave(): Promise<void> {
  if (!autosaver) return;
  const ms = await autosaveInterval(AUTOSAVE_MS);
  setInterval(() => void autosaveNow(), ms);
}

/** On launch: if the last run left unsaved work behind (it crashed, or was
 *  killed), offer to bring it back. */
export async function recoverAutosave(): Promise<void> {
  if (!autosaveStore) return;
  let saved;
  try {
    saved = await autosaveStore.load();
  } catch (err) {
    console.error("autosave load:", err);
    return;
  }
  if (!saved) return;
  const name = sessionDisplayName(saved.meta?.path ?? null);
  const at = saved.meta?.savedAt
    ? new Date(saved.meta.savedAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
    : "an earlier session";
  const yes = await confirmDialog(
    `GgMusicMaker didn't close properly last time. Recover the unsaved work in ${name} from ${at}?\n\n(No throws it away.)`,
    "Recover unsaved work",
  );
  if (!yes) {
    await clearAutosave();
    status.set("Discarded the recovered work.");
    return;
  }
  try {
    const { header, audio } = await readAutosave(saved, autosaveStore, (done, total) =>
      status.set(`Recovering ${name}: audio ${done} of ${total}…`),
    );
    await loadSession(header, audio, saved.meta?.path ?? null);
    // Recovered work is still unsaved until the user saves it. Autosave it
    // again at once (this replaces the old autosave), so a second crash
    // before the next timer tick can't lose it.
    dirty.set(true);
    await autosaveNow();
    status.set(`Recovered ${name} from ${at} — save it to keep it.`);
  } catch (err) {
    status.set(`Couldn't recover the autosave: ${(err as Error).message}`);
  }
}

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
    let next = fn(p);
    if (next === p) return p;
    // Linked stack layers follow every clip edit made on any one of them.
    next = syncStacks(p, next);
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
  binauralLive.set(engine.binauralMonitor);
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
    pan: 0,
    width: 1,
    reverbPan: 0,
    reverbWidth: 1,
    eq: { low: 0, mid: 0, high: 0, ...EQ_CUT_OFF },
    synth: { ...DEFAULT_SYNTH },
    morph: { ...DEFAULT_MORPH },
    punch: { ...DEFAULT_PUNCH },
    fx: { ...FX_ALL_ON },
    stackId: null,
    linked: false,
    role: "",
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

// ---- stacks + instrument racks --------------------------------------------

/** Apply an instrument rack to one layer (resets its modules, then dials in). */
export async function applyRack(trackId: string, rackName: string): Promise<void> {
  const rack = findRack(rackName);
  if (!rack) return;
  await engine.ensureRunning();
  updateTrack(trackId, (t) => rackTrack(t, rack));
  status.set(`Rack: ${rack.name} — ${rack.blurb}.`);
}

/** Stack layers are named "<rack> ◂ <source>" so the rack reads first on
 *  the narrow head; this recovers the source name. */
function baseName(name: string): string {
  const parts = name.split(" ◂ ");
  return parts[parts.length - 1];
}

/** Add a linked layer of `trackId`'s audio to its stack (starting a stack if
 *  it has none), optionally with a rack; lands under the stack's last layer. */
function stackLayerEdit(p: Project, trackId: string, rackName?: string): { next: Project; id: string } | null {
  const src = p.tracks.find((t) => t.id === trackId);
  if (!src) return null;
  const stackId = src.stackId ?? nextId("stack");
  const rack = rackName ? findRack(rackName) : undefined;
  const members = stackMembers(p, src.stackId);
  const n = members.length || 1;
  let layer = makeStackLayer(src, stackId, makeTrack(""), `${rack?.name ?? `Layer ${n + 1}`} ◂ ${baseName(src.name)}`);
  if (rack) layer = rackTrack(layer, rack);
  const tracks = p.tracks.map((t) =>
    t.id === src.id && !t.stackId ? { ...t, stackId, linked: true, clips: ensureLinkIds(t.clips) } : t,
  );
  const lastId = members.length ? members[members.length - 1].id : src.id;
  return { next: { ...p, tracks: insertTrackAfter(tracks, lastId, layer) }, id: layer.id };
}

export async function addStackLayer(trackId: string, rackName?: string): Promise<string | null> {
  await engine.ensureRunning();
  let id: string | null = null;
  updateProject((p) => {
    const r = stackLayerEdit(p, trackId, rackName);
    if (!r) return p;
    id = r.id;
    return r.next;
  });
  if (!id) return null;
  if (get(transport).isPlaying) engine.play(get(project), get(transport).playhead);
  status.set(`Stacked a linked layer${rackName ? ` (${rackName})` : ""} — edits to its clips follow the whole stack.`);
  return id;
}

/** Build a whole stack from a recipe in one undo step: the first rack goes on
 *  this layer, each other rack on a new linked layer. */
export async function buildStack(trackId: string, recipeName: string): Promise<void> {
  const recipe = STACK_RECIPES.find((r) => r.name === recipeName);
  if (!recipe) return;
  await engine.ensureRunning();
  updateProject((p) => {
    const first = findRack(recipe.layers[0])!;
    let next: Project = { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? rackTrack(t, first) : t)) };
    for (const name of recipe.layers.slice(1)) {
      const r = stackLayerEdit(next, trackId, name);
      if (r) next = r.next;
    }
    return next;
  });
  if (get(transport).isPlaying) engine.play(get(project), get(transport).playhead);
  status.set(`Stack: ${recipe.name} — ${recipe.layers.length} layers (${recipe.blurb}).`);
}

/** Link / unlink a stack layer's clips from the rest of the stack. Relinking
 *  snaps its clips back to the stack's. */
export function toggleLinked(trackId: string): void {
  updateProject((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t?.stackId) return p;
    if (t.linked) return { ...p, tracks: p.tracks.map((x) => (x.id === trackId ? { ...x, linked: false } : x)) };
    const ref = p.tracks.find((x) => x.stackId === t.stackId && x.linked && x.id !== t.id);
    return {
      ...p,
      tracks: p.tracks.map((x) =>
        x.id === trackId ? { ...x, linked: true, clips: ref ? mirrorClips(ensureLinkIds(ref.clips), ensureLinkIds(x.clips)) : x.clips } : x,
      ),
    };
  });
  const t = get(project).tracks.find((x) => x.id === trackId);
  status.set(t?.linked ? `${t.name} relinked to its stack.` : `${t?.name} unlinked — its clips now edit on their own.`);
}

export function setTrackGain(trackId: string, gain: number): void {
  updateTrack(trackId, (t) => ({ ...t, gain }), { history: `gain:${trackId}` });
}

export function setReverbSend(trackId: string, amount: number): void {
  updateTrack(trackId, (t) => ({ ...t, reverbSend: amount }), { history: `send:${trackId}` });
}

// ---- FX rack (v2) ---------------------------------------------------------

/** Power switch for one FX module (bypass; settings are kept). */
export function toggleFx(trackId: string, slot: FxSlot): void {
  updateTrack(trackId, (t) => ({ ...t, fx: { ...t.fx, [slot]: !t.fx[slot] } }));
}

export type PlaceKey = "pan" | "width" | "reverbPan" | "reverbWidth";

/** Pan (-1..1) / width (0..2) of the layer or of its reverb send. */
export function setPlacement(trackId: string, key: PlaceKey, value: number): void {
  const isPan = key === "pan" || key === "reverbPan";
  const v = Number.isFinite(value) ? Math.min(isPan ? 1 : 2, Math.max(isPan ? -1 : 0, value)) : isPan ? 0 : 1;
  updateTrack(trackId, (t) => (t[key] === v ? t : { ...t, [key]: v }), { history: `place:${key}:${trackId}` });
}

export function setEq(trackId: string, band: "low" | "mid" | "high" | "lowCut" | "highCut", db: number): void {
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

/** Turn one PUNCH knob. Drags coalesce into a single undo step. */
export function setPunchParam(trackId: string, key: PunchKey, value: number): void {
  const v = clampPunchValue(key, value);
  updateTrack(trackId, (t) => (t.punch[key] === v ? t : { ...t, punch: { ...t.punch, [key]: v } }), {
    history: `punch:${key}:${trackId}`,
  });
}

export async function applyPunchPreset(trackId: string, name: string): Promise<void> {
  const preset = PUNCH_PRESETS.find((p) => p.name === name);
  if (!preset) return;
  await engine.ensureRunning();
  updateTrack(trackId, (t) => ({ ...t, punch: punchPresetParams(preset) }));
  status.set(`PUNCH: ${preset.name} on the selected layer.`);
}

/** Turn one MORPH knob. Drags coalesce into a single undo step. */
export function setMorphParam(trackId: string, key: MorphKey, value: number): void {
  const v = clampMorphValue(key, value);
  updateTrack(trackId, (t) => (t.morph[key] === v ? t : { ...t, morph: { ...t.morph, [key]: v } }), {
    history: `morph:${key}:${trackId}`,
  });
}

/** Switch MORPH to another engine. Loads that engine's first preset, since
 *  the four macro knobs mean something different on every engine — but
 *  keeps the layer's space settings and wet level if it was already on. */
export async function selectMorphAlgo(trackId: string, algo: number): Promise<void> {
  const preset = MORPH_PRESETS.find((p) => p.params.algo === algo && (p.params.mix ?? 0) > 0);
  await engine.ensureRunning();
  updateTrack(trackId, (t) => {
    const base = preset ? morphPresetParams(preset) : { ...DEFAULT_MORPH, algo, mix: 0.7 };
    return { ...t, morph: { ...base, mix: t.morph.mix > 0 ? t.morph.mix : base.mix } };
  });
  status.set(`MORPH: ${MORPH_ALGOS[algo]?.name ?? "?"} — ${MORPH_ALGOS[algo]?.blurb ?? ""}.`);
}

export async function applyMorphPreset(trackId: string, name: string): Promise<void> {
  const preset = MORPH_PRESETS.find((p) => p.name === name);
  if (!preset) return;
  await engine.ensureRunning();
  updateTrack(trackId, (t) => ({ ...t, morph: morphPresetParams(preset) }));
  status.set(`MORPH: ${preset.name} on the selected layer.`);
}

/** Turn the headphone 3D monitor on/off (remembered across runs). */
export async function toggleHeadphones3d(): Promise<void> {
  const next = !get(headphones3d);
  headphones3d.set(next);
  try {
    localStorage.setItem(HEADPHONES_KEY, next ? "1" : "0");
  } catch {
    /* still applies for this run */
  }
  await engine.ensureRunning();
  const rebuilt = engine.setHeadphones3d(next);
  liveChannels.set(engine.liveChannels);
  binauralLive.set(engine.binauralMonitor);
  if (rebuilt) {
    engine.syncAll(get(project));
    if (get(transport).isPlaying) engine.play(get(project), get(transport).playhead);
  }
  status.set(
    next
      ? engine.binauralMonitor
        ? "3D headphones on: the surround field is rendered binaurally (front/back/sides) for headphones."
        : "3D headphones on — takes effect when the output is 5.1/7.1 on a stereo device."
      : "3D headphones off: plain stereo fold-down.",
  );
}

/** Change the project's output layout (stereo / 5.1 / 7.1). Rebuilds the
 *  live graph when the device can follow; export always renders the layout. */
export async function setSurround(layout: SurroundLayout): Promise<void> {
  await engine.ensureRunning();
  const rebuilt = engine.setSurround(layout);
  updateProject((p) => (p.surround === layout ? p : { ...p, surround: layout }), { history: "surround" });
  liveChannels.set(engine.liveChannels);
  binauralLive.set(engine.binauralMonitor);
  if (rebuilt && get(transport).isPlaying) engine.play(get(project), get(transport).playhead);
  const want = surroundChannels(layout);
  const note = engine.binauralMonitor
    ? ` — rendered in 3D for headphones on this ${Math.min(engine.deviceMaxChannels, 2)}-channel device; the WAV export gets all ${want} channels.`
    : engine.liveChannels >= want
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

/** Solo this layer only (see `soloTracks`); `additive` keeps other solos. */
export function toggleSolo(trackId: string, additive = false): void {
  updateProject((p) => ({ ...p, tracks: soloTracks(p.tracks, trackId, additive) }));
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
      // The waveform, a slice at a time, before the lane first draws it.
      await prepareSummary(buffer);
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
    status.set(`Recording onto ${armed.name}…${engine.takeNote ?? ""}`);
  } catch (err) {
    status.set(`Mic unavailable: ${(err as Error).message}`);
  }
}

export async function stopRecording(): Promise<void> {
  if (!engine.isRecording) return;
  const playheadAtStop = get(transport).playhead;
  const usedWorklet = engine.recordingUsesWorklet;
  const buffer = await engine.stopRecording();
  // The native engine knows where the take belongs from the device clocks.
  const startedAt = engine.takeStart ?? playheadAtStop;
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
  const note = (usedWorklet ? "" : " (fallback capture — may drop samples)") + (engine.takeNote ?? "");
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
  binauralLive.set(engine.binauralMonitor);
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
  await clearAutosave();
  status.set("New session.");
}

/** Save the session to its file, or ask where if it has none / `as` is set. */
export async function saveSession(as = false): Promise<void> {
  const p = get(project);
  try {
    status.set("Saving session…");
    const t = get(transport);
    const extras = { reverbSpace: get(reverbSpace), pixelsPerSecond: get(pixelsPerSecond), playhead: t.playhead };
    const current = get(sessionPath);
    // Save As starts from the current file so the dialog opens in its folder.
    const target = { defaultName: current ?? `untitled.${SESSION_EXTENSION}`, filters: SESSION_FILTERS, path: as ? null : current };
    const files = fileStreams();
    let where: string | null;
    let size: number;
    if (files) {
      // Desktop: one WAV encoded and sent at a time — a big session (over
      // a GB) must never sit in memory a second time as encoded WAVs.
      const plan = planSession(p, extras, (id) => engine.getBuffer(id));
      size = plan.size;
      const up = await files.uploadBegin();
      try {
        await files.uploadPart(up, plan.head);
        for (const [i, id] of plan.ids.entries()) {
          status.set(`Saving session… (${i + 1}/${plan.ids.length})`);
          // In pieces: an hour-long layer is 1.4 GB, too big to encode or
          // hand to the shell in one go.
          let sent = 0;
          for (const part of wavParts(engine.getBuffer(id)!, { float: true })) {
            await files.uploadPart(up, part);
            sent += part.byteLength;
          }
          if (sent !== plan.lengths[i]) throw new Error(`audio ${id} changed while saving`);
        }
      } catch (err) {
        await files.uploadAbort(up).catch(() => {});
        throw err;
      }
      where = await files.saveUpload(up, target.defaultName, target.filters, target.path);
    } else {
      const parts = packSessionParts(p, extras, (id) => engine.getBuffer(id));
      size = parts.reduce((n, x) => n + x.byteLength, 0);
      where = await saveBytes(parts, target);
    }
    if (!where) {
      status.set("Save cancelled.");
      return;
    }
    sessionPath.set(where);
    dirty.set(false);
    await clearAutosave();
    const mb = (size / 1048576).toFixed(1);
    status.set(`Saved ${sessionDisplayName(where)} (${mb} MB).`);
  } catch (err) {
    status.set(`Save failed: ${(err as Error).message}`);
  }
}

/** Replace the workspace with the session in `bytes`. */
export async function loadSessionBytes(bytes: ArrayBuffer, path: string | null): Promise<void> {
  const { header, audio } = unpackSession(bytes);
  await loadSession(header, audio, path);
}

/** Replace the workspace with a parsed session (header + decoded audio). */
async function loadSession(header: SessionHeaderBase, audio: Map<string, DecodedPcm>, path: string | null): Promise<void> {
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
    await clearAutosave();
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
  if (!isNative()) return false;
  if (!(await confirmDiscard())) return true;
  try {
    const files = fileStreams()!;
    const picked = await files.pick(SESSION_FILTERS);
    if (!picked) {
      status.set("Open cancelled.");
      return true;
    }
    // Header, then one WAV at a time: a 1 GB+ session is never read whole.
    const name = sessionDisplayName(picked.path);
    let session;
    try {
      session = await readSession((off, len) => files.read(picked.token, off, len), picked.size, (done, total) =>
        status.set(`Opening ${name}: audio ${done} of ${total}…`),
      );
    } finally {
      await files.close(picked.token).catch(() => {});
    }
    await loadSession(session.header, session.audio, picked.path);
    await clearAutosave();
  } catch (err) {
    status.set(`Couldn't open session: ${(err as Error).message}`);
  }
  return true;
}

// ---- stem separation (desktop app; HTDemucs in the native engine) ---------

export interface StemState {
  phase: "idle" | "preparing" | "separating" | "loading" | "done" | "error" | "cancelled";
  fraction: number;
  message: string;
}
export const stemState = writable<StemState>({ phase: "idle", fraction: 0, message: "" });
/** Why separation is unavailable ("" = available). Checked once at startup. */
export const stemsUnavailable = writable<string>("Stem separation needs the desktop app.");
void separationBridge()
  ?.available()
  .then((a) => stemsUnavailable.set(a.ok ? "" : (a.error ?? "unavailable")))
  .catch((e) => stemsUnavailable.set(String(e)));

let stemCancel = false;

/** The clip to separate: the selected clip, else the selected layer's first. */
function stemSource(): { track: Track; clip: Clip } | null {
  const p = get(project);
  const clipId = get(selectedClipId);
  for (const t of p.tracks) {
    const c = clipId ? t.clips.find((x) => x.id === clipId) : undefined;
    if (c) return { track: t, clip: c };
  }
  const t = p.tracks.find((x) => x.id === get(selectedTrackId)) ?? (p.tracks.length === 1 ? p.tracks[0] : undefined);
  return t && t.clips[0] ? { track: t, clip: t.clips[0] } : null;
}

/** The used part of a clip as 44.1 kHz stereo (the model's format). */
async function clipAt44k(buffer: AudioBuffer, offset: number, duration: number): Promise<[Float32Array, Float32Array]> {
  const frames = Math.max(1, Math.round(duration * STEM_RATE));
  const ctx = new OfflineAudioContext(2, frames, STEM_RATE);
  const src = ctx.createBufferSource();
  src.buffer = buffer; // mono is up-mixed to both channels
  src.connect(ctx.destination);
  src.start(0, offset, duration);
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}

/** Split a clip into stems (vocals, drums, bass, guitar, piano, other), each
 *  on a new layer under the original, which is muted. One undo step. */
export async function separateStems(): Promise<void> {
  const sep = separationBridge();
  const why = get(stemsUnavailable);
  if (!sep || why) {
    status.set(why || "Stem separation needs the desktop app.");
    return;
  }
  const phase = get(stemState).phase;
  if (phase === "preparing" || phase === "separating" || phase === "loading") return;
  const source = stemSource();
  if (!source) {
    status.set("Select a clip (or a layer) to split into stems.");
    return;
  }
  const buffer = engine.getBuffer(source.clip.bufferId);
  if (!buffer) {
    status.set("That clip's audio is missing.");
    return;
  }
  const name = source.clip.name || source.track.name;
  stemCancel = false;
  let id: number | null = null;
  try {
    stemState.set({ phase: "preparing", fraction: 0, message: `${name} — resampling to 44.1 kHz` });
    const [left, right] = await clipAt44k(buffer, source.clip.offset, source.clip.duration);
    const mixRms = rms([left, right]);
    id = await sep.start(left, right);
    const started = performance.now();
    let st = await sep.status(id);
    while (st && !st.done) {
      if (stemCancel) {
        await sep.free(id);
        id = null;
        stemState.set({ phase: "cancelled", fraction: 0, message: "Stem separation cancelled." });
        status.set("Stem separation cancelled.");
        return;
      }
      const secs = (performance.now() - started) / 1000;
      const eta = st.progress > 0.05 ? Math.max(0, Math.round((secs / st.progress) * (1 - st.progress))) : null;
      stemState.set({
        phase: "separating",
        fraction: st.progress,
        message: `${name} — ${Math.round(secs)} s${eta !== null ? `, about ${eta} s to go` : ""}`,
      });
      await new Promise((r) => setTimeout(r, 400));
      st = await sep.status(id);
    }
    if (!st) throw new Error("the separation job vanished");
    if (st.error) throw new Error(st.error);

    stemState.set({ phase: "loading", fraction: 1, message: `${name} — loading stems` });
    // Near-silent stems never get a buffer; that's decided once every level is known.
    const stems: { name: string; pcm: Float32Array[]; level: number }[] = [];
    for (let i = 0; i < st.stems.length; i++) {
      const s = await sep.stem(id, i);
      stems.push({ name: s.name, pcm: [s.left, s.right], level: rms([s.left, s.right]) });
    }
    await sep.free(id);
    id = null;
    const { keep, dropped } = audibleStems(stems.map((s) => ({ name: s.name, rms: s.level })), mixRms);
    const layers: Track[] = [];
    for (const stemName of keep) {
      const s = stems.find((x) => x.name === stemName)!;
      const bufferId = engine.registerPcm(STEM_RATE, s.pcm);
      const track = makeTrack(stemLayerName(name, stemName));
      track.clips = [
        { id: nextId("clip"), bufferId, startTime: source.clip.startTime, offset: 0, duration: s.pcm[0].length / STEM_RATE, name: track.name },
      ];
      layers.push(track);
    }
    updateProject((p) => {
      const at = p.tracks.findIndex((t) => t.id === source.track.id);
      const tracks = p.tracks.map((t) => (t.id === source.track.id ? { ...t, muted: true } : t));
      tracks.splice(at + 1, 0, ...layers);
      return { ...p, tracks };
    });
    const msg = stemSummary(name, keep, dropped);
    stemState.set({ phase: "done", fraction: 1, message: msg });
    status.set(msg);
  } catch (err) {
    if (id !== null) await sep.free(id).catch(() => {});
    const msg = `Stem separation failed: ${(err as Error).message}`;
    stemState.set({ phase: "error", fraction: 0, message: msg });
    status.set(msg);
  }
}

export function cancelStems(): void {
  stemCancel = true;
}

export function dismissStems(): void {
  stemState.set({ phase: "idle", fraction: 0, message: "" });
}
