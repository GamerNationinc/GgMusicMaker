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
import { encodeWav, decodeWav, type PcmSource, type DecodedPcm } from "../audio/wav";
import { normalizeSynth, SURROUND_ORDER, type SurroundLayout } from "../fx/voice-synth";

export const SESSION_EXTENSION = "ggmm";
// v1: tracks had `voice: { preset, mix }`; v2: `synth` (Voice Synth) + project.surround;
// v3: per-track pan/width + reverbPan/reverbWidth. Older files are migrated on open.
export const FORMAT_VERSION = 3;
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
  return [...ids];
}

/** Serialise a project and its audio into a `.ggmm` file. */
export function packSession(
  project: Project,
  extras: SessionExtras,
  getBuffer: (id: string) => PcmSource | undefined,
  now: Date = new Date(),
): ArrayBuffer {
  const wavs: ArrayBuffer[] = [];
  const audio: AudioEntry[] = [];
  let offset = 0;
  for (const id of referencedBufferIds(project)) {
    const buf = getBuffer(id);
    if (!buf) throw new Error(`audio buffer ${id} is missing`);
    const wav = encodeWav(buf);
    audio.push({ id, offset, length: wav.byteLength });
    wavs.push(wav);
    offset += wav.byteLength;
  }

  // Arming is transport state; a reopened session should not surprise the
  // user by recording onto a layer they armed last week.
  const header: SessionHeader = {
    format: MAGIC,
    version: FORMAT_VERSION,
    app: "GgMusicMaker",
    savedAt: now.toISOString(),
    ...extras,
    project: {
      ...project,
      tracks: project.tracks.map((t) => ({ ...t, armed: false })),
    },
    audio,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));

  const out = new ArrayBuffer(PREAMBLE + headerBytes.byteLength + offset);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  for (let i = 0; i < 4; i++) view.setUint8(i, MAGIC.charCodeAt(i));
  view.setUint32(4, FORMAT_VERSION, true);
  view.setUint32(8, headerBytes.byteLength, true);
  bytes.set(headerBytes, PREAMBLE);
  let pos = PREAMBLE + headerBytes.byteLength;
  for (const wav of wavs) {
    bytes.set(new Uint8Array(wav), pos);
    pos += wav.byteLength;
  }
  return out;
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
    } as Track;
  });
  const surround: SurroundLayout = SURROUND_ORDER.includes(project.surround) ? project.surround : "stereo";
  return { ...project, tracks, surround };
}

/** Strip the path and extension from a session path for display. */
export function sessionDisplayName(path: string | null): string {
  if (!path) return "untitled";
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(new RegExp(`\\.${SESSION_EXTENSION}$`, "i"), "");
}
