// GgMusicMaker desktop shell (Electron).
//
// The app ships its own Chromium instead of borrowing the system's WebKit
// (the old Tauri shell used WebKitGTK, and the Deck-only bugs came from
// there). The UI + audio are the same build as `npm run build` (dist/),
// served from a private, secure `app://` origin so AudioWorklets and ES
// modules load exactly as they do in the tests.
//
// Native services the page needs (file dialogs, disk, quit guard) cross the
// process boundary through preload.cjs → `window.ggmmNative`, nothing else:
// contextIsolation on, no Node in the page.

const { app, BrowserWindow, dialog, ipcMain, protocol, net, session, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const nativeEngine = require("./engine.cjs");
const crashlog = require("./crashlog.cjs");
const autosave = require("./autosave.cjs");
const stems = require("./stems.cjs");

const DIST = path.join(__dirname, "..", "dist");
const SCHEME = "app";
const ORIGIN = `${SCHEME}://ggmm`;

// Audio must start without a click-to-play gesture; the Deck's GPU is fine
// for Chromium's compositor. Prefer Wayland when the session has it.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
// Short audio buffers: PipeWire (via its Pulse server) handles these well.
app.commandLine.appendSwitch("audio-buffer-size", "512");

// GGMM_USER_DATA: automated tests keep their autosaves and logs out of the
// real ~/.config/ggmusicmaker.
if (process.env.GGMM_USER_DATA) app.setPath("userData", process.env.GGMM_USER_DATA);
crashlog.start();

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// One window, one audio engine: a second launch focuses the first.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let allowClose = false;
// Set when the page has said it heard a close request. A page that has died
// or hung never does, and without this the window could never be closed.
let closeAcked = false;
const CLOSE_ACK_MS = 3000;

// Tests can't click dialogs: GGMM_TEST_DIALOG=<button index> answers them.
async function ask(opts) {
  if (process.env.GGMM_TEST_DIALOG != null) return Number(process.env.GGMM_TEST_DIALOG);
  return (await dialog.showMessageBox(win, opts)).response;
}

function forceClose() {
  allowClose = true;
  win?.destroy();
}

const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null);

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#030805",
    title: "GgMusicMaker",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep meters + audio scheduling live when unfocused
    },
  });
  win.setMenuBarVisibility(false);
  // GGMM_HIDDEN: automated tests run the real app without a window popping up.
  if (!process.env.GGMM_HIDDEN) win.once("ready-to-show", () => win.show());
  win.loadURL(`${ORIGIN}/index.html`);

  // Unsaved-work guard: ask the page; it acks at once ("close-ack"), then
  // answers with "close-ok" once the user has decided.
  win.on("close", (e) => {
    // GGMM_NO_CLOSE_GUARD: automated tests quit without answering the dialog.
    if (allowClose || !win || process.env.GGMM_NO_CLOSE_GUARD) return;
    // A dead page can't answer. Its last autosave is still on disk and is
    // offered on the next launch, so just close.
    if (win.webContents.isCrashed()) return;
    e.preventDefault();
    closeAcked = false;
    win.webContents.send("close-requested");
    setTimeout(async () => {
      if (closeAcked || allowClose || !win) return;
      crashlog.logCrash("close-unanswered", { waitedMs: CLOSE_ACK_MS });
      const r = await ask({
        type: "warning",
        title: "GgMusicMaker",
        message: "GgMusicMaker isn't responding.",
        detail: "Quit anyway? Your last autosave will be offered the next time you open GgMusicMaker.",
        buttons: ["Quit", "Wait"],
        defaultId: 0,
        cancelId: 1,
      });
      if (r === 0) forceClose();
    }, CLOSE_ACK_MS);
  });

  // The page died (crash, out of memory, killed). Log why, then offer to
  // bring it back; the fresh page finds the autosave and offers to restore.
  win.webContents.on("render-process-gone", async (_e, d) => {
    if (d.reason === "clean-exit" || allowClose) return;
    crashlog.logCrash("page-gone", { reason: d.reason, exitCode: d.exitCode });
    const at = clock(await autosave.lastSavedAt());
    const r = await ask({
      type: "error",
      title: "GgMusicMaker",
      message: "GgMusicMaker's window crashed.",
      detail:
        (at ? `Your work up to the autosave at ${at} can be recovered.` : "There was no unsaved work to recover.") +
        `\n\nDetails were written to ${crashlog.logFile()}`,
      buttons: ["Reopen", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (r === 0) win?.webContents.reload();
    else forceClose();
  });
  win.webContents.on("unresponsive", () => crashlog.logCrash("page-unresponsive"));
  win.webContents.on("responsive", () => crashlog.logCrash("page-responsive-again"));
  // Links (if any ever appear) open in the real browser, never in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  nativeEngine.register();
  autosave.register();
  stems.register();
  // Serve dist/ on app://ggmm/, refusing anything outside it.
  protocol.handle(SCHEME, (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    if (!file.startsWith(DIST)) return new Response("forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // The mic (recording) is the only permission the app asks for.
  const allowed = new Set(["media", "audioCapture"]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  createWindow();
});

app.on("window-all-closed", () => app.quit());

// ---- native services for the page ------------------------------------------

const toDialogFilters = (filters) => (filters ?? []).map((f) => ({ name: f.name, extensions: f.extensions }));

// Automated tests (tests/electron-app.mjs) can't click a dialog: with this
// set, saves go straight into the directory given.
const TEST_SAVE_DIR = process.env.GGMM_TEST_SAVE_DIR || null;

ipcMain.handle("save-file", async (_e, { bytes, defaultName, filters, path: known }) => {
  let target = known ?? (TEST_SAVE_DIR ? path.join(TEST_SAVE_DIR, defaultName) : null);
  if (!target) {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath("music"), defaultName),
      filters: toDialogFilters(filters),
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  // Atomic: a crash mid-save must not wreck the file being saved over.
  await autosave.writeAtomic(target, Buffer.from(bytes));
  return target;
});

ipcMain.handle("open-file", async (_e, { filters }) => {
  const r = await dialog.showOpenDialog(win, {
    defaultPath: app.getPath("music"),
    properties: ["openFile"],
    filters: toDialogFilters(filters),
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const data = await fs.readFile(r.filePaths[0]);
  return { path: r.filePaths[0], bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
});

ipcMain.handle("confirm", async (_e, { message, title }) => {
  const r = await ask({
    type: "warning",
    title: title ?? "GgMusicMaker",
    message,
    buttons: ["Yes", "No"],
    defaultId: 1,
    cancelId: 1,
  });
  return r === 0;
});

ipcMain.on("close-ack", () => {
  closeAcked = true;
});

ipcMain.on("close-ok", () => {
  allowClose = true;
  win?.close();
});

ipcMain.handle("app-info", () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  // GGMM_AUTOSAVE_MS: tests autosave every second or two instead of every minute.
  autosaveMs: Number(process.env.GGMM_AUTOSAVE_MS) || undefined,
}));
