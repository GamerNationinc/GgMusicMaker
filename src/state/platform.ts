// File dialogs, disk access and the quit guard, with a browser fallback.
//
// Inside the desktop app (Electron, see electron/main.cjs) the preload script
// exposes `window.ggmmNative`: real open/save dialogs and a path to write to.
// In a plain browser (`npm run dev`, the headless tests) saving becomes a
// download and opening goes through an <input type="file">. Everything that
// touches the filesystem goes through here so the store stays platform-blind.

import type { AutosaveBridge } from "./autosave";

export interface FileFilter {
  name: string;
  extensions: string[];
}

interface NativeBridge {
  /** `bytes` may be parts written back to back (sent in chunks: big files). */
  saveFile(bytes: Uint8Array | ArrayBuffer[], defaultName: string, filters: FileFilter[], path?: string | null): Promise<string | null>;
  openFile(filters: FileFilter[]): Promise<{ path: string; bytes: Uint8Array } | null>;
  confirm(message: string, title?: string): Promise<boolean>;
  appInfo(): Promise<{ version: string; electron: string; chrome: string; autosaveMs?: number }>;
  onCloseRequested(handler: () => Promise<boolean>): void;
  autosave?: AutosaveBridge;
  files?: FileStreams;
  separation?: SeparationBridge;
  logError?(message: string, source?: string): void;
}

function bridge(): NativeBridge | null {
  return typeof window !== "undefined" ? ((window as unknown as { ggmmNative?: NativeBridge }).ggmmNative ?? null) : null;
}

/** True inside the desktop app (native dialogs + disk). */
export const isNative = (): boolean => bridge() !== null;

/** Write `bytes` to disk. Returns the path written, or null if cancelled.
 *  `path` skips the dialog (plain "Save" over an existing file). In the
 *  browser the file is downloaded and the suggested name is returned. */
export async function saveBytes(
  bytes: Uint8Array | ArrayBuffer[],
  opts: { defaultName: string; filters: FileFilter[]; path?: string | null; mime?: string },
): Promise<string | null> {
  const native = bridge();
  if (native) return native.saveFile(bytes, opts.defaultName, opts.filters, opts.path ?? null);
  const blob = new Blob(Array.isArray(bytes) ? bytes : [bytes as BlobPart], { type: opts.mime ?? "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = opts.defaultName;
  a.click();
  URL.revokeObjectURL(url);
  return opts.defaultName;
}

/** Pick a file with the native dialog and read it. Returns null if cancelled.
 *  Desktop app only — callers check `isNative()` and use an <input type="file">
 *  in a browser. */
export async function openBytes(filters: FileFilter[]): Promise<{ path: string; bytes: ArrayBuffer } | null> {
  const native = bridge();
  if (!native) throw new Error("no native file dialog in the browser");
  const picked = await native.openFile(filters);
  if (!picked) return null;
  const b = picked.bytes;
  return { path: picked.path, bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
}

/** Yes/no question. Native dialog in the app, window.confirm elsewhere. */
export async function confirmDialog(message: string, title = "GgMusicMaker"): Promise<boolean> {
  const native = bridge();
  return native ? native.confirm(message, title) : window.confirm(message);
}

/** Desktop app: run `shouldClose` when the window is asked to close. */
export function onCloseRequested(shouldClose: () => Promise<boolean>): void {
  bridge()?.onCloseRequested(shouldClose);
}

/** Streaming file access (desktop app): write or read a file one piece at a
 *  time, for sessions too big to hold in memory twice. */
export interface FileStreams {
  uploadBegin(): Promise<number>;
  uploadPart(id: number, bytes: ArrayBuffer | Uint8Array): Promise<void>;
  uploadAbort(id: number): Promise<void>;
  saveUpload(id: number, defaultName: string, filters: FileFilter[], path?: string | null): Promise<string | null>;
  pick(filters: FileFilter[]): Promise<{ path: string; token: number; size: number } | null>;
  read(token: number, offset: number, length: number): Promise<ArrayBuffer>;
  close(token: number): Promise<void>;
}

export function fileStreams(): FileStreams | null {
  return bridge()?.files ?? null;
}

/** Stem separation in the native engine (electron/engine.cjs). */
export interface SeparationBridge {
  available(): Promise<{ ok: boolean; error?: string }>;
  start(left: Float32Array, right: Float32Array): Promise<number>;
  status(id: number): Promise<{ progress: number; done: boolean; error?: string | null; stems: string[] } | null>;
  stem(id: number, index: number): Promise<{ name: string; left: Float32Array; right: Float32Array }>;
  free(id: number): Promise<void>;
}

/** Desktop app: stem separation (null in a browser). */
export function separationBridge(): SeparationBridge | null {
  return bridge()?.separation ?? null;
}

/** Desktop app: the on-disk autosave store (null in a browser). */
/** The shell's autosave bridge as preload exposes it (electron/preload.cjs). */
interface RawAutosaveBridge extends Omit<AutosaveBridge, "putAudio"> {
  putAudio(key: string, bytes: Uint8Array): Promise<void>;
  /** Store a finished upload (files.uploadBegin/uploadPart) as the WAV. */
  putUpload?(key: string, uploadId: number): Promise<void>;
}

export function autosaveBridge(): AutosaveBridge | null {
  const b = bridge();
  const raw = b?.autosave as RawAutosaveBridge | undefined;
  if (!raw) return null;
  const files = b?.files;
  return {
    audioKeys: () => raw.audioKeys(),
    commit: (header, keys, meta) => raw.commit(header, keys, meta),
    load: () => raw.load(),
    readAudio: (key) => raw.readAudio(key),
    clear: () => raw.clear(),
    async putAudio(key, parts) {
      if (files && raw.putUpload) {
        // One piece at a time: each crosses into the shell on its own and
        // the page gets to run between them.
        const id = await files.uploadBegin();
        try {
          for (const part of parts) await files.uploadPart(id, part);
        } catch (err) {
          await files.uploadAbort(id).catch(() => {});
          throw err;
        }
        return raw.putUpload(key, id);
      }
      const list = [...parts];
      const bytes = new Uint8Array(list.reduce((n, x) => n + x.byteLength, 0));
      let at = 0;
      for (const x of list) (bytes.set(new Uint8Array(x), at), (at += x.byteLength));
      return raw.putAudio(key, bytes);
    },
  };
}

/** Desktop app: how often to autosave (ms), when the shell overrides it. */
export async function autosaveInterval(fallbackMs: number): Promise<number> {
  const ms = (await bridge()?.appInfo())?.autosaveMs;
  return typeof ms === "number" && ms > 0 ? ms : fallbackMs;
}

/** Desktop app: record an uncaught page error in the crash log. */
export function logError(message: string, source?: string): void {
  bridge()?.logError?.(message, source);
}
