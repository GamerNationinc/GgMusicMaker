// Raw Steam Deck controller → page. The native addon's DeckPad (native/src/
// deckpad.rs) reads the controller's state reports on its own thread; this
// polls the newest one every 4 ms (the controller sends at 250 Hz) and
// forwards it to the page that asked, which parses and maps it
// (src/input/deckpad.ts). Studio mode asks for "buttons" detail — a report
// only when a button changes — so the View + Menu mode combo works without
// 250 messages a second; Instrument mode takes every report.
//
// GGMM_DECKPAD=off never opens the device; GGMM_DECKPAD=fake reports it as
// present without opening it, so tests can inject reports of their own
// (webContents.send("deckpad-report", bytes)).
const { ipcMain } = require("electron");
const { getModule } = require("./engine.cjs");

const POLL_MS = 4;
const RETRY_MS = 2000;

let pad = null;
let timer = null;
let target = null;
let seq = 0;
let lastError = null;
/** "full": every report. "buttons": only when a button changes (bytes
 *  8..15) — enough to catch the mode-switch combo without streaming. */
let detail = "full";
let lastButtons = Buffer.alloc(8);

function openPad() {
  const m = getModule();
  if (!m || !m.DeckPad) {
    lastError = "native engine not built";
    return null;
  }
  try {
    const p = m.DeckPad.open();
    lastError = null;
    return p;
  } catch (e) {
    lastError = String(e && e.message ? e.message : e);
    return null;
  }
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  target = null;
  if (pad) pad.close();
  pad = null;
  seq = 0;
}

function start(sender) {
  const mode = process.env.GGMM_DECKPAD;
  if (mode === "off") return { ok: false, error: "disabled" };
  if (mode === "fake") return { ok: true, fake: true };
  stop();
  target = sender;
  pad = openPad();
  if (!pad) return { ok: false, error: lastError };
  let retryAt = 0;
  timer = setInterval(() => {
    if (!target || target.isDestroyed()) return stop();
    if (!pad || !pad.alive()) {
      // Unplugged / suspended: tell the page once, then keep trying.
      if (pad) {
        pad.close();
        pad = null;
        target.send("deckpad-lost");
      }
      const now = Date.now();
      if (now < retryAt) return;
      retryAt = now + RETRY_MS;
      pad = openPad();
      seq = 0;
      if (pad) target.send("deckpad-found");
      return;
    }
    const r = pad.latest(seq);
    if (r) {
      seq = r.seq;
      const buttons = r.report.subarray(8, 16);
      if (detail === "buttons" && buttons.equals(lastButtons)) return;
      buttons.copy(lastButtons);
      target.send("deckpad-report", r.report);
    }
  }, POLL_MS);
  return { ok: true, path: pad.path };
}

function register() {
  ipcMain.handle("deckpad-start", (e) => start(e.sender));
  ipcMain.on("deckpad-stop", () => stop());
  ipcMain.on("deckpad-detail", (_e, d) => (detail = d === "buttons" ? "buttons" : "full"));
  ipcMain.on("deckpad-feature", (_e, bytes) => {
    try {
      pad?.feature(Buffer.from(bytes));
    } catch (err) {
      // Haptics are a nicety: a failed pulse must never disturb playing.
      console.error("deckpad-feature:", err.message || err);
    }
  });
}

module.exports = { register, stop };
