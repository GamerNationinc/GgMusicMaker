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
  // The output device has to be pulling audio before a note can be heard. On
  // a CI VM's virtual sound device that can take a moment after launch (the
  // first note there once measured silent while every later one played).
  const clock = () => page.evaluate(() => window.ggmmNative.engine.status().then((s) => s?.clock ?? 0));
  const c0 = await clock();
  let c1 = c0;
  for (let i = 0; i < 100 && c1 - c0 < 0.1; i++) {
    await sleep(50);
    c1 = await clock();
  }
  check("the audio device is running", c1 - c0 >= 0.1, `${(c1 - c0).toFixed(2)} s rendered while waiting`);
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

  // --- R3: skip-back; L1/R1 + R3: resample (native ring, skipback.rs) ---
  const statusText = () => page.textContent(".statusbar").then((t) => t.trim());
  await send({ buttons: { r3: true } });
  await send();
  await page.waitForFunction(() => /Skip-back/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
  const sb = await statusText();
  const rescued = Number(/rescued (\d+\.\d+) s/.exec(sb)?.[1]);
  // Everything played above, first note to last touch: several seconds.
  check("R3 rescues the jam from the native ring", rescued > 3 && rescued < 60, sb);
  await send({ buttons: { l1: true } });
  await send({ buttons: { l1: true, r3: true } });
  await send();
  await sleep(100);
  check("L1 + R3 starts a resample", await page.$eval("[data-role=inst-resample]", (b) => b.classList.contains("on")).catch(() => false));
  await send({ buttons: { a: true } });
  await sleep(150);
  await send();
  await sleep(900);
  await send({ buttons: { r1: true } });
  await send({ buttons: { r1: true, r3: true } });
  await send();
  await page.waitForFunction(() => /Resampled/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
  const rs = await statusText();
  const bounced = Number(/Resampled (\d+\.\d+) s/.exec(rs)?.[1]);
  check("R1 + R3 lands the resample", bounced > 0.8 && bounced < 3, rs);

  // --- Menu tap: the PADS kit, played on the native sampler (pads.rs) ---
  await send({ buttons: { menu: true } });
  await send();
  await page.waitForSelector("[data-role=pad-grid]", { timeout: 3000 }).catch(() => {});
  check("a Menu tap switches to the PADS kit", !!(await page.$("[data-role=pad-grid]")));
  await page.setInputFiles("[data-role=pad-file]", [join(ROOT, "tests", "fixtures", "tone-4s.wav")]);
  await page.waitForFunction(() => /onto pad A1/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
  check("a file loads onto pad A1", /onto pad A1/.test(await statusText()), await statusText());
  await sleep(1500);
  check("quiet before hitting a pad", (await peakOver(200)) < 1e-3);
  await send({ buttons: { left: true } });
  const padPeak = await peakOver(300);
  check("D-pad ← hits pad 1 on the native engine", padPeak > 0.05, `peak ${padPeak.toFixed(3)}`);
  check("the pad lights while held", await page.$eval("[data-role=pad-A1]", (el) => el.classList.contains("hit")));
  await send();
  await page.click("[data-role=pad-mode-gate]");
  await sleep(300);
  await send({ rpad: { x: -0.9, y: 0.9, touch: true } });
  const gatePeak = await peakOver(300);
  await send();
  await sleep(400);
  const gateTail = await peakOver(200);
  check("right-pad top-left = pad 1; a GATE pad stops on lift", gatePeak > 0.05 && gateTail < gatePeak * 0.05, `${gatePeak.toFixed(3)} → ${gateTail.toFixed(4)}`);
  // --- FX buses on the native engine (fxbus.rs): L5 latches master bus 3
  // (FILTER), the left pad closes it, R2 grabs it ---
  const holdPeak = async (extra = {}) => {
    await send({ rpad: { x: -0.9, y: 0.9, touch: true }, ...extra });
    const p = await peakOver(300);
    await send(extra);
    await sleep(300);
    return p;
  };
  const openPeak = await holdPeak();
  await send({ buttons: { l5: true } });
  await send();
  await send({ lpad: { x: -1, y: -1, touch: true } });
  await send();
  await sleep(150);
  check("the left pad's move lands in the project on lift", (await page.$eval("[data-role=fx-a-3]", (el) => el.value).catch(() => "")) === "0");
  const latched = await holdPeak();
  check("L5 latches master bus 3 (FILTER, closed by the left pad)", latched < openPeak * 0.2, `${openPeak.toFixed(3)} → ${latched.toFixed(3)}`);
  await send({ buttons: { l5: true } });
  await send();
  await sleep(200);
  await send({ r2: 1 });
  await sleep(150); // the bus glides in over 20 ms
  const grabbed = await holdPeak({ r2: 1 });
  await send();
  const after = await holdPeak();
  check("R2 grabs the bus only while pulled", grabbed < openPeak * 0.2 && after > openPeak * 0.8, `${grabbed.toFixed(3)} pulled → ${after.toFixed(3)} let go`);

  await send({ buttons: { r3: true } });
  await send();
  await page.waitForFunction(() => /onto pad A2/.test(document.querySelector(".statusbar")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
  check("R3 in the PADS kit skips back onto the next empty pad", /Skip-back: rescued .* onto pad A2/.test(await statusText()), await statusText());
  check("…and selects it", (await page.$eval("[data-role=pad-editor] .pad-name", (el) => el.value).catch(() => "")) === "Skip-back 1");
  await send({ buttons: { r4: true } });
  await send();
  await sleep(100);
  check("R4 moves to bank B", (await page.textContent("[data-role=inst-bank]")).trim() === "B");
  await send({ buttons: { l4: true } });
  await send();
  await send({ buttons: { menu: true } });
  await send();
  await sleep(100);
  check("another Menu tap goes back to SYNTH", !(await page.$("[data-role=pad-grid]")) && !!(await page.$("[data-role=inst-grid]")));

  await page.screenshot({ path: join(userData, "..", `ggmm-instrument-${process.pid}.png`) }).catch(() => {});

  // --- back out ---
  await send({ buttons: { view: true, menu: true } });
  await send();
  await page.waitForSelector(".workspace", { timeout: 3000 }).catch(() => {});
  check("View + Menu goes back to Studio", !!(await page.$(".workspace")) && !(await page.$("[data-role=instrument]")));
  await send({ buttons: { a: true } });
  check("in Studio the controller plays nothing", (await peakOver(250)) < 1e-3);
  await send();

  const names = await page.$$eval(".head input", (i) => i.map((x) => x.value));
  check("the captures are layers in Studio", names.includes("Skip-back 1") && names.includes("Resample 1"), names.join(", "));
  // Six undos: the pad edits (load, GATE, skip-back onto A2), the FX macro
  // move, then both layers.
  for (let i = 0; i < 6; i++) await page.keyboard.press("Control+z");
  await sleep(200);
  check("undo removes them", (await page.$$(".head")).length === 0);

  // --- Studio: the left pad and stick drive the timeline ---
  await page.setInputFiles("input[type=file][accept='audio/*']", [join(ROOT, "tests", "fixtures", "tone-4s.wav")]);
  await page.waitForSelector(".head", { timeout: 10000 });
  const lanesBox = await page.$eval(".lanes-scroll", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 40 };
  });
  await page.mouse.move(lanesBox.x, lanesBox.y); // Steam's cursor rests on the timeline
  const scrollX = () => page.$eval(".lanes-scroll", (el) => el.scrollLeft);
  const laneWidth = () => page.$eval(".lanes", (el) => el.getBoundingClientRect().width);
  await page.evaluate(() => (document.querySelector(".lanes-scroll").scrollLeft = 0));
  for (let i = 0; i <= 12; i++) {
    await send({ lpad: { x: 0.7 - i * 0.1, y: 0, touch: true } });
    await sleep(8);
  }
  await send();
  await sleep(150);
  const swiped = await scrollX();
  check("left pad swipe scrolls the song (content follows the thumb)", swiped > 300, `scrollLeft ${swiped}`);
  await sleep(1200); // let the glide settle
  const w0 = await laneWidth();
  for (let i = 0; i <= 8; i++) {
    await send({ lpad: { x: 0, y: 0.4 - i * 0.08, touch: true }, buttons: { lpadClick: true } });
    await sleep(8);
  }
  await send();
  await sleep(150);
  const w1 = await laneWidth();
  check("left pad press + drag down zooms in", w1 > w0 * 1.5, `${Math.round(w0)} → ${Math.round(w1)} px`);
  const s0 = await scrollX();
  for (let i = 0; i < 40; i++) {
    await send({ lstick: { x: 1, y: 0 } });
    await sleep(10);
  }
  await send();
  await sleep(100);
  const s1 = await scrollX();
  check("left stick scrolls smoothly", s1 - s0 > 200, `${s0} → ${s1}`);
  for (let i = 0; i < 30; i++) {
    await send({ lstick: { x: 0, y: -1 } });
    await sleep(10);
  }
  await send();
  await sleep(100);
  check("left stick down zooms out", (await laneWidth()) < w1, `${Math.round(w1)} → ${Math.round(await laneWidth())} px`);
  check("Follow is on by default", (await page.getAttribute(".follow", "aria-pressed")) === "true");
} finally {
  await app.close().catch(() => {});
  await rm(userData, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
