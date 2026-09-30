// Instrument mode in the real desktop app, driven by Deck controller reports.
//
// The app runs with GGMM_DECKPAD=fake: the shell says a Deck controller is
// there without opening it, and this test sends the reports itself — the
// exact 64-byte packets the hardware sends (built by src/input/deckpad.ts),
// through the same IPC path as the real reader. Sound is measured on the
// native engine's own meters, and goes to a private null sink so nothing
// plays out loud.
//
//   npm run build && npm run test:instrument
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { _electron: electron } = require("playwright-core");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The report builder is TypeScript (src/input/deckpad.ts, no imports): strip
// the types with esbuild (Vite's) so this runs on Node 20 like the others.
const { transformSync } = require("esbuild");
const { buildDeckReport } = await import(
  "data:text/javascript;base64," +
    Buffer.from(transformSync(readFileSync(join(ROOT, "src/input/deckpad.ts"), "utf8"), { loader: "ts", format: "esm" }).code).toString("base64")
);

let failed = 0, passed = 0;
function check(name, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SINK = `ggmm_inst_${process.pid}`;
const moduleId = execFileSync("pactl", ["load-module", "module-null-sink", `sink_name=${SINK}`, `sink_properties=device.description=${SINK}`]).toString().trim();
process.on("exit", () => {
  try {
    execFileSync("pactl", ["unload-module", moduleId]);
  } catch {}
});

const userData = await mkdtemp(join(tmpdir(), "ggmm-inst-"));
const packaged = process.env.GGMM_APP;
const app = await electron.launch({
  ...(packaged ? { executablePath: resolve(packaged), args: ["--ozone-platform=x11"] } : { args: [ROOT, "--ozone-platform=x11"] }),
  env: {
    ...process.env,
    GGMM_USER_DATA: userData,
    GGMM_HIDDEN: "1",
    GGMM_NO_CLOSE_GUARD: "1",
    GGMM_DECKPAD: "fake",
    PIPEWIRE_NODE: SINK,
    PULSE_SINK: SINK,
  },
});
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => check("no page errors", false, e.message));
  await page.waitForSelector(".app-header");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));

  /** Send one controller state as a raw Deck report. */
  const send = (state = {}) =>
    app.evaluate(({ BrowserWindow }, bytes) => BrowserWindow.getAllWindows()[0].webContents.send("deckpad-report", Uint8Array.from(bytes)), [...buildDeckReport(state)]);
  /** Loudest native-engine peak over `ms`. */
  async function peakOver(ms) {
    let peak = 0;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = await page.evaluate(() => window.ggmmNative.engine.status());
      peak = Math.max(peak, s?.peak ?? 0);
      await sleep(20);
    }
    return peak;
  }

  const avail = await page.evaluate(() => window.ggmmNative.engine.available());
  check("native engine running", avail.ok === true, avail.ok ? `${avail.device} @ ${avail.sampleRate} Hz` : avail.error);
  check("header has the mode switch", (await page.$$("[data-role^=mode-]")).length === 3);

  // --- View + Menu: into Instrument mode ---
  await send();
  await send({ buttons: { view: true, menu: true } });
  await page.waitForSelector("[data-role=instrument]", { timeout: 3000 }).catch(() => {});
  check("View + Menu switches to Instrument mode", !!(await page.$("[data-role=instrument]")));
  check("the editor is out of the way", !(await page.$(".workspace")));
  await send();
  check("quiet before playing", (await peakOver(300)) < 1e-3);

  // --- right pad plays the grid ---
  await send({ rpad: { x: -0.95, y: -0.9, touch: true } });
  const notePeak = await peakOver(400);
  check("touching the right pad plays a note", notePeak > 0.01, `peak ${notePeak.toFixed(3)}`);
  check("the grid lights the cell under the thumb (C3)", (await page.getAttribute(".cell.on", "data-note").catch(() => null)) === "48");
  await send({ rpad: { x: -0.6, y: -0.9, touch: true } });
  await sleep(100);
  check("sliding moves to the next scale step (D3)", (await page.getAttribute(".cell.on", "data-note").catch(() => null)) === "50");
  await send();
  await sleep(1500);
  const tail = await peakOver(200);
  // Only the reverb tail may be left (the default send is 20 %).
  check("lifting the thumb releases it", tail < notePeak * 0.05, `${(20 * Math.log10(tail / notePeak)).toFixed(0)} dB after 1.5 s`);

  // --- ABXY drums, bumper chords ---
  await send({ buttons: { a: true } });
  const kick = await peakOver(250);
  check("A hits the kick", kick > 0.05, `peak ${kick.toFixed(3)}`);
  await send();
  await sleep(1500);
  await send({ buttons: { l1: true } });
  await send({ buttons: { l1: true, y: true } });
  await sleep(100);
  const padLabel = await page.textContent("[data-role=inst-pad-y]");
  check("holding L1 turns the pads into chords (Y = Am)", /Am/.test(padLabel), padLabel.trim());
  const chord = await peakOver(300);
  check("L1 + Y plays the chord", chord > 0.01, `peak ${chord.toFixed(3)}`);
  await send();
  await sleep(1500);
  const chordTail = await peakOver(200);
  check("releasing the pad releases the chord", chordTail < chord * 0.05, `${(20 * Math.log10(chordTail / chord)).toFixed(0)} dB after 1.5 s`);

  // --- settings from the controller ---
  await send({ buttons: { r4: true } });
  await send();
  await send({ buttons: { right: true } });
  await send();
  await send({ buttons: { up: true } });
  await send();
  await sleep(100);
  const key = await page.textContent("[data-role=inst-key]");
  const scale = await page.textContent("[data-role=inst-scale]");
  const oct = await page.textContent("[data-role=inst-octave]");
  check("R4 / d-pad change octave, key and scale", oct.trim() === "4" && key.trim() === "C#" && scale.trim() === "minor", `${key.trim()} ${scale.trim()} oct ${oct.trim()}`);

  // --- Steam's emulated mouse is ignored, the touchscreen isn't ---
  const cell = await page.$(".cell");
  await cell.click();
  check("a mouse click (Steam's R2 emulation) plays nothing", (await peakOver(250)) < 1e-3);
  await cell.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const o = { pointerId: 7, pointerType: "touch", bubbles: true, clientX: r.x + 5, clientY: r.y + 5 };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    setTimeout(() => el.dispatchEvent(new PointerEvent("pointerup", o)), 300);
  });
  const touchPeak = await peakOver(250);
  check("a touch on the grid plays", touchPeak > 0.01, `peak ${touchPeak.toFixed(3)}`);
  await sleep(1200);

  await page.screenshot({ path: join(userData, "..", `ggmm-instrument-${process.pid}.png`) }).catch(() => {});

  // --- back out ---
  await send({ buttons: { view: true, menu: true } });
  await send();
  await page.waitForSelector(".workspace", { timeout: 3000 }).catch(() => {});
  check("View + Menu goes back to Studio", !!(await page.$(".workspace")) && !(await page.$("[data-role=instrument]")));
  await send({ buttons: { a: true } });
  check("in Studio the controller plays nothing", (await peakOver(250)) < 1e-3);
} finally {
  await app.close().catch(() => {});
  await rm(userData, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
