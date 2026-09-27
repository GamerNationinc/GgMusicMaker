// Native audio engine host: loads native/ggmm-engine.node (Rust, see
// native/src/lib.rs) in the main process and exposes it to the page over IPC.
// The engine runs its own real-time thread straight to ALSA/PipeWire, so
// playback no longer depends on the page's audio stack or timers.
const { app, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

function addonPath() {
  const candidates = [
    // Packaged: asarUnpack keeps the .node file on disk next to app.asar.
    path.join(process.resourcesPath || "", "app.asar.unpacked", "native", "ggmm-engine.node"),
    path.join(__dirname, "..", "native", "ggmm-engine.node"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

let mod = null;
let engine = null;
let loadError = null;

function getModule() {
  if (mod || loadError) return mod;
  const p = addonPath();
  if (!p) {
    loadError = "native engine not built (scripts/build-native.sh)";
    return null;
  }
  try {
    mod = require(p);
  } catch (e) {
    loadError = String(e && e.message ? e.message : e);
  }
  return mod;
}

function getEngine() {
  if (engine) return engine;
  const m = getModule();
  if (!m) return null;
  try {
    engine = new m.NativeEngine();
  } catch (e) {
    loadError = `audio device: ${e && e.message ? e.message : e}`;
  }
  return engine;
}

function register() {
  ipcMain.handle("engine-available", () => {
    const e = getEngine();
    return e ? { ok: true, ...e.status() } : { ok: false, error: loadError };
  });
  ipcMain.handle("engine-load", (_e, { id, sampleRate, channels }) => getEngine()?.loadBuffer(id, sampleRate, channels));
  ipcMain.handle("engine-remove", (_e, { id }) => getEngine()?.removeBuffer(id));
  ipcMain.on("engine-project", (_e, json) => {
    try {
      getEngine()?.setProject(json);
    } catch (err) {
      console.error("engine-project:", err);
    }
  });
  ipcMain.on("engine-play", (_e, from) => getEngine()?.play(from));
  ipcMain.on("engine-stop", () => getEngine()?.stop());
  ipcMain.handle("engine-status", () => getEngine()?.status() ?? null);
  ipcMain.handle("engine-render", (_e, { project, ids, rates, data, sampleRate, tail }) =>
    getModule()?.renderOffline(project, ids, rates, data, sampleRate, tail),
  );
}

module.exports = { register };
void app;
