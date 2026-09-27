// The only bridge between the page and the OS (see main.cjs). Everything the
// page can do natively is listed here; src/state/platform.ts is its client.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ggmmNative", {
  saveFile: (bytes, defaultName, filters, path) => ipcRenderer.invoke("save-file", { bytes, defaultName, filters, path }),
  openFile: (filters) => ipcRenderer.invoke("open-file", { filters }),
  confirm: (message, title) => ipcRenderer.invoke("confirm", { message, title }),
  appInfo: () => ipcRenderer.invoke("app-info"),
  /** The native (Rust) audio engine in the main process. */
  engine: {
    available: () => ipcRenderer.invoke("engine-available"),
    load: (id, sampleRate, channels) => ipcRenderer.invoke("engine-load", { id, sampleRate, channels }),
    remove: (id) => ipcRenderer.invoke("engine-remove", { id }),
    setProject: (json) => ipcRenderer.send("engine-project", json),
    play: (from) => ipcRenderer.send("engine-play", from),
    stop: () => ipcRenderer.send("engine-stop"),
    status: () => ipcRenderer.invoke("engine-status"),
    scope: () => ipcRenderer.invoke("engine-scope"),
    render: (project, ids, rates, data, sampleRate, tail) =>
      ipcRenderer.invoke("engine-render", { project, ids, rates, data, sampleRate, tail }),
  },
  /** Unsaved work kept on disk for crash recovery (electron/autosave.cjs). */
  autosave: {
    audioKeys: () => ipcRenderer.invoke("autosave-audio-keys"),
    putAudio: (key, bytes) => ipcRenderer.invoke("autosave-put-audio", { key, bytes }),
    commit: (header, audioKeys, meta) => ipcRenderer.invoke("autosave-commit", { header, audioKeys, meta }),
    load: () => ipcRenderer.invoke("autosave-load"),
    clear: () => ipcRenderer.invoke("autosave-clear"),
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
