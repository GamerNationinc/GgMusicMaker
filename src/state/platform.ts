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
  saveFile(bytes: Uint8Array, defaultName: string, filters: FileFilter[], path?: string | null): Promise<string | null>;
  openFile(filters: FileFilter[]): Promise<{ path: string; bytes: Uint8Array } | null>;
  confirm(message: string, title?: string): Promise<boolean>;
  appInfo(): Promise<{ version: string; electron: string; chrome: string; autosaveMs?: number }>;
  onCloseRequested(handler: () => Promise<boolean>): void;
  autosave?: AutosaveBridge;
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
  bytes: Uint8Array,
  opts: { defaultName: string; filters: FileFilter[]; path?: string | null; mime?: string },
): Promise<string | null> {
  const native = bridge();
  if (native) return native.saveFile(bytes, opts.defaultName, opts.filters, opts.path ?? null);
  const blob = new Blob([bytes as BlobPart], { type: opts.mime ?? "application/octet-stream" });
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

/** Desktop app: the on-disk autosave store (null in a browser). */
export function autosaveBridge(): AutosaveBridge | null {
  return bridge()?.autosave ?? null;
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
