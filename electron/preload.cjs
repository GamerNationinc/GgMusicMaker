// The only bridge between the page and the OS (see main.cjs). Everything the
// page can do natively is listed here; src/state/platform.ts is its client.
//
// Anything that can be big (a session is easily over 1 GB) crosses in
// chunks — one IPC message past a few hundred MB makes Chromium kill the
// app. See electron/transfer.cjs; the page never sees the chunking.
const { contextBridge, ipcRenderer } = require("electron");

const CHUNK = 32 * 1024 * 1024;
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const bytesOf = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v.buffer ?? v, v.byteOffset ?? 0, v.byteLength));

/** Append one typed array / ArrayBuffer to an upload, in chunks. */
async function sendPart(id, part) {
  const b = bytesOf(part);
  for (let off = 0; off < b.byteLength; off += CHUNK) {
    // slice, not subarray: IPC would serialise a view's whole backing buffer.
    await invoke("upload-chunk", { id, bytes: b.slice(off, Math.min(off + CHUNK, b.byteLength)) });
  }
}

/** Send typed arrays / ArrayBuffers, back to back, as one upload. */
async function upload(parts) {
  const id = await invoke("upload-begin");
  try {
    for (const part of parts) await sendPart(id, part);
  } catch (e) {
    await invoke("upload-abort", { id }).catch(() => {});
    throw e;
  }
  return id;
}

/** Read `length` bytes at `offset` of an offered download, in chunks. */
async function readRange(token, offset, length) {
  const out = new Uint8Array(length);
  for (let off = 0; off < length; off += CHUNK) {
    const chunk = await invoke("download-chunk", { token, offset: offset + off, length: Math.min(CHUNK, length - off) });
    out.set(chunk, off);
  }
  return out.buffer;
}

/** Read an offered download ({ token, size }) into one ArrayBuffer. */
async function download({ token, size }) {
  let out;
  try {
    out = new Uint8Array(await readRange(token, 0, size));
  } finally {
    await invoke("download-done", { token }).catch(() => {});
  }
  return out.buffer;
}

/** A planar f32 download → one Float32Array per channel. */
async function downloadChannels(offer) {
  const all = new Float32Array(await download(offer));
  const n = offer.frames ?? all.length / offer.channelCount;
  return Array.from({ length: offer.channelCount }, (_, c) => all.subarray(c * n, (c + 1) * n));
}

const channelBytes = (channels) => channels.reduce((s, c) => s + c.byteLength, 0);

contextBridge.exposeInMainWorld("ggmmNative", {
  /** `bytes`: one buffer, or an array of parts written back to back. */
  saveFile: async (bytes, defaultName, filters, path) =>
    invoke("save-file", { uploadId: await upload(Array.isArray(bytes) ? bytes : [bytes]), defaultName, filters, path }),
  openFile: async (filters) => {
    const picked = await invoke("open-file", { filters });
    return picked ? { path: picked.path, bytes: new Uint8Array(await download(picked)) } : null;
  },
  /** Streaming file access for files too big to hold twice (sessions):
   *  write one part at a time, or read one range at a time. */
  files: {
    uploadBegin: () => invoke("upload-begin"),
    uploadPart: (id, bytes) => sendPart(id, bytes),
    uploadAbort: (id) => invoke("upload-abort", { id }),
    /** Save a finished upload (dialog unless `path`); resolves the path or null. */
    saveUpload: (id, defaultName, filters, path) => invoke("save-file", { uploadId: id, defaultName, filters, path }),
    /** Pick a file to read: { path, token, size } or null. */
    pick: (filters) => invoke("open-file", { filters }),
    read: (token, offset, length) => readRange(token, offset, length),
    close: (token) => invoke("download-done", { token }),
  },
  confirm: (message, title) => invoke("confirm", { message, title }),
  /** The Steam Deck's own controller, raw (electron/deckpad.cjs). */
  deckpad: {
    start: () => invoke("deckpad-start"),
    stop: () => ipcRenderer.send("deckpad-stop"),
    /** "full" (every report) or "buttons" (only when a button changes). */
    detail: (d) => ipcRenderer.send("deckpad-detail", d),
    feature: (bytes) => ipcRenderer.send("deckpad-feature", bytes),
    /** cb(report: Uint8Array) per state report; returns an unsubscribe. */
    onReport: (cb) => {
      const h = (_e, bytes) => cb(new Uint8Array(bytes));
      ipcRenderer.on("deckpad-report", h);
      return () => ipcRenderer.off("deckpad-report", h);
    },
    /** cb(present: boolean) when the controller goes away / comes back. */
    onPresence: (cb) => {
      const lost = () => cb(false);
      const found = () => cb(true);
      ipcRenderer.on("deckpad-lost", lost);
      ipcRenderer.on("deckpad-found", found);
      return () => {
        ipcRenderer.off("deckpad-lost", lost);
        ipcRenderer.off("deckpad-found", found);
      };
    },
  },
  appInfo: () => invoke("app-info"),
  /** The native (Rust) audio engine in the main process. */
  engine: {
    available: () => invoke("engine-available"),
    load: async (id, sampleRate, channels) =>
      channelBytes(channels) <= CHUNK
        ? invoke("engine-load", { id, sampleRate, channels })
        : invoke("engine-load-upload", { id, sampleRate, channelCount: channels.length, uploadId: await upload(channels) }),
    /** Load audio the page streamed itself (files.uploadBegin/uploadPart), planar f32. */
    loadUpload: (id, sampleRate, channelCount, uploadId) => invoke("engine-load-upload", { id, sampleRate, channelCount, uploadId }),
    remove: (id) => invoke("engine-remove", { id }),
    setProject: (json) => ipcRenderer.send("engine-project", json),
    play: (from) => ipcRenderer.send("engine-play", from),
    stop: () => ipcRenderer.send("engine-stop"),
    live: (json) => ipcRenderer.send("engine-live", json),
    dj: (json) => ipcRenderer.send("engine-dj", json),
    djLoad: (deck, id) => invoke("engine-dj-load", deck, id ?? null),
    status: () => invoke("engine-status"),
    scope: () => invoke("engine-scope"),
    recStart: (device, input) => invoke("engine-rec-start", device, input ?? null),
    recStartDeck: () => invoke("engine-rec-start-deck"),
    monitorStart: (device, input) => invoke("engine-monitor-start", device, input ?? null),
    monitorStop: () => invoke("engine-monitor-stop"),
    inputLevel: () => invoke("engine-input-level"),
    inputChannels: (device) => invoke("engine-input-channels", device),
    listInputDevices: () => invoke("engine-list-input-devices"),
    recPeaks: (from) => invoke("engine-rec-peaks", from),
    recStop: async () => {
      const take = await invoke("engine-rec-stop");
      const { token, size, frames, channelCount, ...rest } = take;
      return { ...rest, channels: await downloadChannels({ token, size, frames, channelCount }) };
    },
    /** Export from the buffers the engine already holds. */
    renderLoaded: async (project, sampleRate, tail) => downloadChannels(await invoke("engine-render-loaded", { project, sampleRate, tail })),
    render: (project, ids, rates, data, sampleRate, tail) => invoke("engine-render", { project, ids, rates, data, sampleRate, tail }),
  },
  /** Stem separation (native/stems, run as its own process by electron/stems.cjs). */
  separation: {
    available: () => invoke("separation-available"),
    start: async (left, right) => invoke("separation-start", { uploadId: await upload([left, right]) }),
    status: (id) => invoke("separation-status", { id }),
    stem: async (id, index) => {
      const offer = await invoke("separation-stem", { id, index });
      const [left, right] = await downloadChannels({ ...offer, channelCount: 2 });
      return { name: offer.name, left, right };
    },
    free: (id) => invoke("separation-free", { id }),
  },
  /** Unsaved work kept on disk for crash recovery (electron/autosave.cjs). */
  autosave: {
    audioKeys: () => invoke("autosave-audio-keys"),
    putAudio: async (key, bytes) => invoke("autosave-put-audio", { key, uploadId: await upload([bytes]) }),
    /** Store an upload the page streamed itself (files.uploadBegin/uploadPart). */
    putUpload: (key, uploadId) => invoke("autosave-put-audio", { key, uploadId }),
    commit: (header, audioKeys, meta) => invoke("autosave-commit", { header, audioKeys, meta }),
    /** The project and its audio keys; audio comes one WAV at a time via readAudio. */
    load: () => invoke("autosave-load"),
    readAudio: async (key) => new Uint8Array(await download(await invoke("autosave-read-audio", { key }))),
    clear: () => invoke("autosave-clear"),
  },
  /** Record an uncaught page error in the crash log. */
  logError: (message, source) => ipcRenderer.send("log-error", { message, source }),
  /** `handler` resolves true to let the window close. */
  onCloseRequested: (handler) => {
    ipcRenderer.on("close-requested", async () => {
      // Ack first: main treats silence as a hung page.
      ipcRenderer.send("close-ack");
      if (await handler()) ipcRenderer.send("close-ok");
    });
  },
});
