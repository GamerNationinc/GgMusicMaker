// Crash log: one line per thing that went wrong, in
// ~/.config/ggmusicmaker/logs/crash.log (rotated to crash.log.1 past 1 MB).
//
// Covers the window's page dying or hanging, any other Chromium process
// (GPU, audio service) dying, uncaught errors in this main process, and
// uncaught errors the page reports over IPC. Chromium's own minidumps go to
// ~/.config/ggmusicmaker/Crashpad (kept locally, never uploaded).
const { app, crashReporter, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const MAX_BYTES = 1024 * 1024;

function logDir() {
  return path.join(app.getPath("userData"), "logs");
}

function logFile() {
  return path.join(logDir(), "crash.log");
}

/** Append one entry. Never throws: logging must not become the crash. */
function logCrash(kind, details = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), kind, version: app.getVersion(), ...details });
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    const file = logFile();
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      // no log yet
    }
    fs.appendFileSync(file, line + "\n");
  } catch (e) {
    console.error("crash log:", e);
  }
  console.error(`[crash] ${line}`);
}

// Page errors can repeat every frame; keep the log readable.
const PAGE_ERROR_LIMIT = 20;
let pageErrors = 0;

/** Call before app ready. */
function start() {
  crashReporter.start({ uploadToServer: false });
  process.on("uncaughtException", (e) => logCrash("main-exception", { message: String(e?.stack ?? e) }));
  process.on("unhandledRejection", (e) => logCrash("main-rejection", { message: String(e?.stack ?? e) }));
  app.on("child-process-gone", (_e, d) => {
    if (d.reason === "clean-exit") return;
    logCrash("child-process-gone", { type: d.type, reason: d.reason, exitCode: d.exitCode, name: d.name, serviceName: d.serviceName });
  });
  ipcMain.on("log-error", (_e, { message, source }) => {
    if (++pageErrors > PAGE_ERROR_LIMIT) return;
    logCrash("page-error", { message: String(message).slice(0, 4000), source: String(source ?? "") });
  });
}

module.exports = { start, logCrash, logFile };
