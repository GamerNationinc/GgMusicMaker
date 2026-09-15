// File dialogs and disk access, with a browser fallback.
//
// Inside the Tauri shell we get real save/open dialogs and a path to write to;
// in a plain browser (`npm run dev`, the headless tests) saving becomes a
// download and opening goes through an <input type="file">. Everything that
// touches the filesystem goes through here so the store stays platform-blind.

export interface FileFilter {
  name: string;
  extensions: string[];
}

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Write `bytes` to disk. Returns the path written, or null if cancelled.
 *  `path` skips the dialog (plain "Save" over an existing file). In the
 *  browser the file is downloaded and the suggested name is returned. */
export async function saveBytes(
  bytes: Uint8Array,
  opts: { defaultName: string; filters: FileFilter[]; path?: string | null; mime?: string },
): Promise<string | null> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path =
      opts.path ?? (await save({ defaultPath: opts.defaultName, filters: opts.filters }));
    if (!path) return null;
    await writeFile(path, bytes);
    return path;
  }
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
 *  Tauri only — a browser can't open a picker programmatically, so callers
 *  check `isTauri()` and use an <input type="file"> there. */
export async function openBytes(
  filters: FileFilter[],
): Promise<{ path: string; bytes: ArrayBuffer } | null> {
  if (!isTauri()) throw new Error("no native file dialog in the browser");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const picked = await open({ multiple: false, directory: false, filters });
  if (!picked) return null;
  const path = typeof picked === "string" ? picked : (picked as { path: string }).path;
  const data = await readFile(path);
  return { path, bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
}

/** Yes/no question. Native dialog under Tauri, window.confirm elsewhere. */
export async function confirmDialog(message: string, title = "GgMusicMaker"): Promise<boolean> {
  if (isTauri()) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(message, { title, kind: "warning" });
  }
  return window.confirm(message);
}
