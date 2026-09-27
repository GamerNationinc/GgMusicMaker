// Autosave: keep unsaved work on disk so a crash costs a minute at most.
//
// The store calls `save` on a timer while there are unsaved changes; the
// desktop shell (electron/autosave.cjs) keeps the result in
// ~/.config/ggmusicmaker/autosave. Audio never changes once it is in a
// buffer, so each buffer's WAV is sent once and later autosaves are just the
// project JSON — cheap even with an hour of takes loaded. On the next launch
// `recoverBytes` turns a found autosave back into a `.ggmm` for the normal
// open path.
//
// No Svelte, no Web Audio: unit-tested with a fake bridge.

import type { Project } from "../audio/types";
import type { PcmSource } from "../audio/wav";
import {
  packContainer,
  referencedBufferIds,
  sessionHeader,
  sessionWav,
  type SessionExtras,
  type SessionHeaderBase,
} from "./session";

export interface AutosaveMeta {
  /** The session file the work belongs to (null = never saved). */
  path: string | null;
  savedAt: string;
}

export interface LoadedAutosave {
  meta: AutosaveMeta;
  header: SessionHeaderBase;
  /** WAV bytes keyed by the buffer ids in `header`; null if some are missing. */
  audio: Record<string, Uint8Array> | null;
  error?: string;
}

/** What the shell provides (see electron/preload.cjs). */
export interface AutosaveBridge {
  audioKeys(): Promise<string[]>;
  putAudio(key: string, bytes: Uint8Array): Promise<void>;
  commit(header: SessionHeaderBase, audioKeys: Record<string, string>, meta: AutosaveMeta): Promise<void>;
  load(): Promise<LoadedAutosave | null>;
  clear(): Promise<void>;
}

export const AUTOSAVE_MS = 60_000;

/** Buffer ids restart at buf_1 every launch, so stored WAVs are keyed by a
 *  per-run prefix too: a new run can never mistake an old WAV for its own. */
function newRunId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export class Autosaver {
  private readonly run = newRunId();
  /** Keys of WAVs already on disk. */
  private stored = new Set<string>();
  /** What the last autosave contained, to skip identical ones. */
  private lastSig: string | null = null;
  /** Saves and clears run one at a time, in order: a clear can't be undone
   *  by a save that was already in flight. */
  private queue: Promise<unknown> = Promise.resolve();
  private pending = false;

  constructor(
    private readonly bridge: AutosaveBridge,
    private readonly getBuffer: (id: string) => PcmSource | undefined,
  ) {}

  /** Autosave `project` unless nothing changed since last time. Resolves
   *  true when something was written. A call made while one is still
   *  queued is dropped (the timer will come round again). */
  save(project: Project, extras: SessionExtras, path: string | null, now: Date = new Date()): Promise<boolean> {
    if (this.pending) return Promise.resolve(false);
    this.pending = true;
    return this.enqueue(async () => {
      this.pending = false;
      // The playhead moving on its own is not new work.
      const sig = JSON.stringify([project, extras.reverbSpace, path]);
      if (sig === this.lastSig) return false;
      const keys: Record<string, string> = {};
      for (const id of referencedBufferIds(project)) {
        const key = `${this.run}.${id}`;
        if (!this.stored.has(key)) {
          const buf = this.getBuffer(id);
          if (!buf) throw new Error(`audio buffer ${id} is missing`);
          await this.bridge.putAudio(key, new Uint8Array(sessionWav(buf)));
          this.stored.add(key);
        }
        keys[id] = key;
      }
      await this.bridge.commit(sessionHeader(project, extras, now), keys, { path, savedAt: now.toISOString() });
      // The shell deleted WAVs the project no longer uses.
      this.stored = new Set(Object.values(keys));
      this.lastSig = sig;
      return true;
    });
  }

  /** Throw the autosave away (after a real save, or a discard). */
  clear(): Promise<void> {
    return this.enqueue(async () => {
      this.stored.clear();
      this.lastSig = null;
      await this.bridge.clear();
    });
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** Rebuild a found autosave as `.ggmm` bytes for the normal open path. */
export function recoverBytes(saved: LoadedAutosave): ArrayBuffer {
  if (!saved.audio) throw new Error(saved.error ?? "autosave audio is missing");
  const wavs = new Map<string, ArrayBuffer>();
  for (const [id, b] of Object.entries(saved.audio)) {
    wavs.set(id, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  }
  return packContainer(saved.header, wavs);
}
