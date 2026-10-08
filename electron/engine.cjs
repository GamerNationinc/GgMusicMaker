// Native audio engine host: loads native/ggmm-engine.node (Rust, see
// native/src/lib.rs) in the main process and exposes it to the page over IPC.
// The engine runs its own real-time thread straight to ALSA/PipeWire, so
// playback no longer depends on the page's audio stack or timers.
const { app, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const transfer = require("./transfer.cjs");

/** Channels → one planar buffer offered for the page to read in chunks. */
function offerChannels(chans) {
  const frames = chans[0]?.length ?? 0;
  const planar = new Float32Array(frames * chans.length);
  chans.forEach((c, i) => planar.set(c, i * frames));
  return { channelCount: chans.length, frames, ...transfer.offerBuffer(planar) };
}

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
  // Big buffers (long recordings, imports) arrive as an upload: planar f32.
  ipcMain.handle("engine-load-upload", (_e, { id, sampleRate, channelCount, uploadId }) => {
    const buf = transfer.readUpload(uploadId);
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const frames = all.length / channelCount;
    const chans = Array.from({ length: channelCount }, (_, c) => all.subarray(c * frames, (c + 1) * frames));
    return getEngine()?.loadBuffer(id, sampleRate, chans);
  });
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
  // Instrument mode: one live-instrument event (JSON), fire and forget.
  ipcMain.on("engine-live", (_e, json) => {
    try {
      getEngine()?.live(json);
    } catch (err) {
      console.error("engine-live:", err);
    }
  });
  // DJ mode: deck events (JSON, fire and forget) and loading a deck.
  ipcMain.on("engine-dj", (_e, json) => {
    try {
      getEngine()?.dj(json);
    } catch (err) {
      console.error("engine-dj:", err);
    }
  });
  ipcMain.handle("engine-dj-load", (_e, deck, id) => getEngine()?.djLoad(deck >>> 0, id ?? undefined));
  ipcMain.handle("engine-status", () => getEngine()?.status() ?? null);
  ipcMain.handle("engine-scope", () => getEngine()?.scope() ?? null);
  // Native recording (native/src/record.rs). Errors reject the invoke, and
  // the page falls back to recording through Chromium.
  // `input`: one input of the device (0-based), or null for inputs 1+2.
  ipcMain.handle("engine-rec-start", (_e, device, input) => {
    const e = getEngine();
    if (!e) throw new Error(loadError || "native engine unavailable");
    return e.recStart(device || undefined, input ?? undefined);
  });
  // Record the Deck instrument (Instrument mode): fed by the mixer itself.
  ipcMain.handle("engine-rec-start-deck", () => {
    const e = getEngine();
    if (!e) throw new Error(loadError || "native engine unavailable");
    return e.recStartDeck();
  });
  // Hear the armed input through the output; its level for the meter.
  ipcMain.handle("engine-monitor-start", (_e, device, input) => {
    const e = getEngine();
    if (!e) throw new Error(loadError || "native engine unavailable");
    return e.monitorStart(device || undefined, input ?? undefined);
  });
  ipcMain.handle("engine-monitor-stop", () => getEngine()?.monitorStop());
  ipcMain.handle("engine-input-level", () => getEngine()?.inputLevel() ?? 0);
  ipcMain.handle("engine-input-channels", (_e, device) => {
    if (!getEngine()) throw new Error(loadError || "native engine unavailable");
    return getModule().inputChannels(device || undefined);
  });
  // Live waveform of the take while it records (small: a few KB per poll).
  ipcMain.handle("engine-rec-peaks", (_e, from) => getEngine()?.recPeaks(from >>> 0) ?? null);
  ipcMain.handle("engine-list-input-devices", () => {
    if (!getEngine()) throw new Error(loadError || "native engine unavailable");
    return getModule().listInputDevices();
  });
  ipcMain.handle("engine-rec-stop", () => {
    const e = getEngine();
    if (!e) throw new Error(loadError || "native engine unavailable");
    const take = e.recStop();
    // A long take is hundreds of MB: the audio goes back in chunks.
    const { channels, ...rest } = take;
    return { ...rest, ...offerChannels(channels) };
  });
  // Export renders from the buffers the engine already holds (no audio
  // shipped over IPC); the mix comes back in chunks.
  ipcMain.handle("engine-render-loaded", async (_e, { project, sampleRate, tail }) => {
    const e = getEngine();
    if (!e) throw new Error(loadError || "native engine unavailable");
    return offerChannels(await e.renderLoaded(project, sampleRate, tail));
  });
  ipcMain.handle("engine-render", (_e, { project, ids, rates, data, sampleRate, tail }) =>
    getModule()?.renderOffline(project, ids, rates, data, sampleRate, tail),
  );
}

module.exports = { register, getModule };
void app;
