// Session files — save and restore a whole project in one self-contained file.
//
// A `.ggmm` file is a tiny binary container: a JSON header (the project model
// plus the few bits of UI state worth keeping) followed by one embedded WAV per
// audio buffer the project still references. Embedding the audio, rather than
// pointing at the original files, means a session survives the source files
// being moved or deleted and can be copied to another machine as one file.
//
// Layout (all integers little-endian):
//
//   "GGMM"           4 bytes   magic
//   u32 version      4 bytes   container version (FORMAT_VERSION)
//   u32 headerLen    4 bytes   byte length of the UTF-8 JSON header
//   header           …         SessionHeader as JSON
//   blobs            …         WAV files, back to back, at header.audio[i].offset
//                              relative to the end of the header
//
// Pure: no Svelte, no Web Audio, so it is unit-tested with fake buffers. The
// store handles dialogs and turning decoded PCM back into engine buffers.

import type { Project, Track } from "../audio/types";
import type { ReverbSpace } from "../audio/reverb";
import { encodeWav, decodeWav, wavByteLength, type PcmSource, type DecodedPcm } from "../audio/wav";
import { normalizeSynth, SURROUND_ORDER, type SurroundLayout } from "../fx/voice-synth";
import { normalizeFx } from "../fx/chain";
import { normalizeMorph } from "../fx/morph";
import { normalizePunch } from "../fx/punch";
import { normalizeBass } from "../fx/bass";
import { normalizePads } from "../pads/pads";
import { normalizeFxBuses } from "../fx/fxbus";

export const SESSION_EXTENSION = "ggmm";
// v1: tracks had `voice: { preset, mix }`; v2: `synth` (Voice Synth) + project.surround;
// v3: per-track pan/width + reverbPan/reverbWidth; v4: per-module power switches (`fx`).
// Older files are migrated on open.
export const FORMAT_VERSION = 4;
const MAGIC = "GGMM";
const PREAMBLE = 12;

/** UI state saved alongside the project so reopening feels like resuming. */
export interface SessionExtras {
  reverbSpace: ReverbSpace;
  pixelsPerSecond: number;
  playhead: number;
}

export interface AudioEntry {
  /** The `bufferId` clips in `project` refer to. Remapped on load. */
  id: string;
  /** Byte offset of the WAV, relative to the end of the JSON header. */
  offset: number;
  length: number;
}

export interface SessionHeader extends SessionExtras {
  format: typeof MAGIC;
  version: number;
  app: string;
  savedAt: string;
  project: Project;
  audio: AudioEntry[];
}

export interface UnpackedSession {
  header: SessionHeader;
  /** Decoded PCM keyed by the `bufferId` used inside `header.project`. */
  audio: Map<string, DecodedPcm>;
}

/** Buffer ids the project actually uses — orphaned buffers are not saved. */
export function referencedBufferIds(project: Project): string[] {
  const ids = new Set<string>();
  for (const t of project.tracks) for (const c of t.clips) ids.add(c.bufferId);
  for (const p of project.pads ?? []) ids.add(p.bufferId);
  return [...ids];
}

/** The JSON header minus the audio table: everything about a session except
 *  where its WAVs sit in the file. */
export type SessionHeaderBase = Omit<SessionHeader, "audio">;

/** Build the header for `project` at `now` (the audio table is added when
 *  the container is packed). */
export function sessionHeader(project: Project, extras: SessionExtras, now: Date = new Date()): SessionHeaderBase {
  // Arming is transport state; a reopened session should not surprise the
  // user by recording onto a layer they armed last week.
  return {
    format: MAGIC,
    version: FORMAT_VERSION,
    app: "GgMusicMaker",
    savedAt: now.toISOString(),
    ...extras,
    project: {
      ...project,
      tracks: project.tracks.map((t) => ({ ...t, armed: false })),
    },
  };
}

/** A `.ggmm` file as its parts, in file order: preamble + JSON header, then
 *  each WAV. Written back to back they are the file; a big session (over
 *  a GB) is never assembled into one buffer. Only referenced buffers go in. */
export function packContainerParts(base: SessionHeaderBase, wavs: Map<string, ArrayBuffer>): ArrayBuffer[] {
  const audio: AudioEntry[] = [];
  const blobs: ArrayBuffer[] = [];
  let offset = 0;
  for (const id of referencedBufferIds(base.project)) {
    const wav = wavs.get(id);
    if (!wav) throw new Error(`audio buffer ${id} is missing`);
    audio.push({ id, offset, length: wav.byteLength });
    blobs.push(wav);
    offset += wav.byteLength;
  }
  const header: SessionHeader = { ...base, audio };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const head = new ArrayBuffer(PREAMBLE + headerBytes.byteLength);
  const view = new DataView(head);
  for (let i = 0; i < 4; i++) view.setUint8(i, MAGIC.charCodeAt(i));
  view.setUint32(4, FORMAT_VERSION, true);
  view.setUint32(8, headerBytes.byteLength, true);
  new Uint8Array(head).set(headerBytes, PREAMBLE);
  return [head, ...blobs];
}

/** The parts joined into one `.ggmm` buffer (small sessions, tests). */
export function joinParts(parts: ArrayBuffer[]): ArrayBuffer {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), pos);
    pos += p.byteLength;
  }
  return out.buffer;
}

/** Lay a header and already-encoded WAVs out as one `.ggmm` buffer. */
export function packContainer(base: SessionHeaderBase, wavs: Map<string, ArrayBuffer>): ArrayBuffer {
  return joinParts(packContainerParts(base, wavs));
}

/** One audio buffer as it is stored in a session: 32-bit float WAV, lossless,
 *  so a reopened session is bit-identical. */
export function sessionWav(buf: PcmSource): ArrayBuffer {
  return encodeWav(buf, { float: true });
}

/** A `.ggmm` laid out before any audio is encoded: the head (preamble +
 *  JSON header, whose offsets come from `wavByteLength`), then the buffers
 *  whose WAVs follow it, in file order. A writer encodes and sends one WAV
 *  at a time, so a 1 GB+ session never sits in memory twice. */
export interface SessionPlan {
  head: ArrayBuffer;
  ids: string[];
  /** Expected length of each WAV, same order as `ids`. */
  lengths: number[];
  size: number;
}

export function planSession(
  project: Project,
  extras: SessionExtras,
  getBuffer: (id: string) => PcmSource | undefined,
  now: Date = new Date(),
): SessionPlan {
  const ids = referencedBufferIds(project);
  const lengths = ids.map((id) => {
    const buf = getBuffer(id);
    if (!buf) throw new Error(`audio buffer ${id} is missing`);
    return wavByteLength(buf, { float: true });
  });
  // Placeholder WAVs of the right size give the exact same header.
  const sized = new Map(ids.map((id, i) => [id, { byteLength: lengths[i] } as ArrayBuffer]));
  const [head] = packContainerParts(sessionHeader(project, extras, now), sized);
  return { head, ids, lengths, size: head.byteLength + lengths.reduce((a, b) => a + b, 0) };
}

/** Serialise a project and its audio as `.ggmm` parts (see packContainerParts). */
export function packSessionParts(
  project: Project,
  extras: SessionExtras,
  getBuffer: (id: string) => PcmSource | undefined,
  now: Date = new Date(),
): ArrayBuffer[] {
  const wavs = new Map<string, ArrayBuffer>();
  for (const id of referencedBufferIds(project)) {
    const buf = getBuffer(id);
    if (!buf) throw new Error(`audio buffer ${id} is missing`);
    wavs.set(id, sessionWav(buf));
  }
  return packContainerParts(sessionHeader(project, extras, now), wavs);
}

/** Serialise a project and its audio into a `.ggmm` file. */
export function packSession(
  project: Project,
  extras: SessionExtras,
  getBuffer: (id: string) => PcmSource | undefined,
  now: Date = new Date(),
): ArrayBuffer {
  return joinParts(packSessionParts(project, extras, getBuffer, now));
}

/** Parse the head of a `.ggmm` (`bytes` = its first bytes, at least 12 and
 *  ideally the whole preamble + header). Returns what's needed to read the
 *  WAVs one by one, or `need` = how many leading bytes the head takes. */
export function parseSessionHead(bytes: ArrayBuffer, fileSize: number): { header: SessionHeader; blobStart: number } | { need: number } {
  const view = new DataView(bytes);
  let magic = "";
  for (let i = 0; i < 4 && i < bytes.byteLength; i++) magic += String.fromCharCode(view.getUint8(i));
  if (bytes.byteLength < PREAMBLE || magic !== MAGIC) throw new Error("not a GgMusicMaker session file");
  const version = view.getUint32(4, true);
  if (version > FORMAT_VERSION) throw new Error(`session was saved by a newer GgMusicMaker (format v${version})`);
  const blobStart = PREAMBLE + view.getUint32(8, true);
  if (blobStart > fileSize) throw new Error("session file is truncated");
  if (bytes.byteLength < blobStart) return { need: blobStart };
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, PREAMBLE, blobStart - PREAMBLE))) as SessionHeader;
  if (!header.project || !Array.isArray(header.project.tracks) || !Array.isArray(header.audio)) {
    throw new Error("session header is malformed");
  }
  header.project = migrateProject(header.project);
  for (const e of header.audio) if (blobStart + e.offset + e.length > fileSize) throw new Error("session file is truncated");
  return { header, blobStart };
}

/** Read a `.ggmm` through `read(offset, length)` — the head, then one WAV at
 *  a time — so opening a 1 GB+ session never holds the whole file. */
export async function readSession(
  read: (offset: number, length: number) => Promise<ArrayBuffer>,
  fileSize: number,
  onProgress?: (done: number, total: number) => void,
): Promise<UnpackedSession> {
  let head = parseSessionHead(await read(0, Math.min(fileSize, 1 << 20)), fileSize);
  if ("need" in head) head = parseSessionHead(await read(0, head.need), fileSize);
  if ("need" in head) throw new Error("session header is malformed");
  const { header, blobStart } = head;
  const audio = new Map<string, DecodedPcm>();
  for (const [n, entry] of header.audio.entries()) {
    onProgress?.(n, header.audio.length);
    audio.set(entry.id, decodeWav(await read(blobStart + entry.offset, entry.length)));
  }
  onProgress?.(header.audio.length, header.audio.length);
  for (const id of referencedBufferIds(header.project)) {
    if (!audio.has(id)) throw new Error(`session is missing audio for ${id}`);
  }
  return { header, audio };
}

/** Parse a `.ggmm` file. Throws a readable error for anything that isn't one. */
export function unpackSession(bytes: ArrayBuffer): UnpackedSession {
  const view = new DataView(bytes);
  let magic = "";
  for (let i = 0; i < 4 && i < bytes.byteLength; i++) magic += String.fromCharCode(view.getUint8(i));
  if (bytes.byteLength < PREAMBLE || magic !== MAGIC) {
    throw new Error("not a GgMusicMaker session file");
  }
  const version = view.getUint32(4, true);
  if (version > FORMAT_VERSION) {
    throw new Error(`session was saved by a newer GgMusicMaker (format v${version})`);
  }
  const headerLen = view.getUint32(8, true);
  const blobStart = PREAMBLE + headerLen;
  if (blobStart > bytes.byteLength) throw new Error("session file is truncated");

  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(bytes, PREAMBLE, headerLen)),
  ) as SessionHeader;
  if (!header.project || !Array.isArray(header.project.tracks) || !Array.isArray(header.audio)) {
    throw new Error("session header is malformed");
  }
  header.project = migrateProject(header.project);

  const audio = new Map<string, DecodedPcm>();
  for (const entry of header.audio) {
    const start = blobStart + entry.offset;
    if (start + entry.length > bytes.byteLength) throw new Error("session file is truncated");
    audio.set(entry.id, decodeWav(bytes.slice(start, start + entry.length)));
  }
  for (const id of referencedBufferIds(header.project)) {
    if (!audio.has(id)) throw new Error(`session is missing audio for ${id}`);
  }
  return { header, audio };
}

/** Bring a project from any older format up to date: v1 voice presets become
 *  Voice Synth settings, missing blocks get defaults, values are clamped. */
export function migrateProject(project: Project): Project {
  const num = (v: unknown, lo: number, hi: number, dflt: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  const tracks = (project.tracks as (Track & { voice?: unknown })[]).map((t) => {
    const { voice, ...rest } = t;
    return {
      ...rest,
      // v2 → v3: layer + reverb-send placement.
      pan: num(t.pan, -1, 1, 0),
      width: num(t.width, 0, 2, 1),
      reverbPan: num(t.reverbPan, -1, 1, 0),
      reverbWidth: num(t.reverbWidth, 0, 2, 1),
      synth: normalizeSynth(t.synth, voice),
      // v4 → v5: the MORPH module (off for old sessions).
      morph: normalizeMorph(t.morph),
      // v6 → v7: EQ cut filters (off) and layer stacks (standalone).
      eq: {
        low: num(t.eq?.low, -18, 18, 0),
        mid: num(t.eq?.mid, -18, 18, 0),
        high: num(t.eq?.high, -18, 18, 0),
        lowCut: num(t.eq?.lowCut, 20, 2000, 20),
        highCut: num(t.eq?.highCut, 500, 20000, 20000),
      },
      stackId: typeof t.stackId === "string" ? t.stackId : null,
      linked: typeof t.stackId === "string" && t.linked !== false,
      role: typeof t.role === "string" ? t.role : "",
      // v5 → v6: PUNCH (off for old sessions).
      punch: normalizePunch(t.punch),
      // BASS MOD (off for older sessions).
      bass: normalizeBass(t.bass),
      // v3 → v4: power switches, all on.
      fx: normalizeFx(t.fx),
    } as Track;
  });
  const surround: SurroundLayout = SURROUND_ORDER.includes(project.surround) ? project.surround : "stereo";
  const out: Project = { ...project, tracks, surround };
  const pads = normalizePads(project.pads);
  if (pads.length) out.pads = pads;
  else delete out.pads;
  const fx = normalizeFxBuses(project.fxBuses);
  if (fx) out.fxBuses = fx;
  else delete out.fxBuses;
  return out;
}

/** Strip the path and extension from a session path for display. */
export function sessionDisplayName(path: string | null): string {
  if (!path) return "untitled";
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(new RegExp(`\\.${SESSION_EXTENSION}$`, "i"), "");
}
