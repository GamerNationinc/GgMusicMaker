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

const DIST = path.join(__dirname, "..", "dist");
const SCHEME = "app";
const ORIGIN = `${SCHEME}://ggmm`;

// Audio must start without a click-to-play gesture; the Deck's GPU is fine
// for Chromium's compositor. Prefer Wayland when the session has it.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
// Short audio buffers: PipeWire (via its Pulse server) handles these well.
app.commandLine.appendSwitch("audio-buffer-size", "512");

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// One window, one audio engine: a second launch focuses the first.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let allowClose = false;

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

  // Unsaved-work guard: ask the page; it answers with "close-ok".
  win.on("close", (e) => {
    // GGMM_NO_CLOSE_GUARD: automated tests quit without answering the dialog.
    if (allowClose || !win || process.env.GGMM_NO_CLOSE_GUARD) return;
    e.preventDefault();
    win.webContents.send("close-requested");
  });
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
  await fs.writeFile(target, Buffer.from(bytes));
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
  const r = await dialog.showMessageBox(win, {
    type: "warning",
    title: title ?? "GgMusicMaker",
    message,
    buttons: ["Yes", "No"],
    defaultId: 1,
    cancelId: 1,
  });
  return r.response === 0;
});

ipcMain.on("close-ok", () => {
  allowClose = true;
  win?.close();
});

ipcMain.handle("app-info", () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome }));
