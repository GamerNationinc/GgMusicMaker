// Headless browser integration tests.
//
// Covers what unit tests can't: that the app actually boots, that the
// AudioWorklets load, that recording captures audio into a clip, and that voice
// FX measurably change the exported mix. Runs against the production `dist`
// build in Chromium.
//
// Chromium stands in for the Steam Deck's WebKitGTK here — it proves the app
// logic is correct, not that WebKit specifically will cooperate. That remains a
// device-level check.
//
// Usage: node tests/browser-integration.mjs   (after `npm run build`)
// Needs Chromium: `npx playwright-core install chromium`, or set CHROME_PATH.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const PORT = 4610;

// CHROME_PATH overrides; otherwise use the Chromium that playwright-core
// resolves from its cache (`npx playwright-core install chromium`).
const CHROME = process.env.CHROME_PATH || undefined;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
};

function serve() {
  const server = http.createServer(async (req, res) => {
    try {
      let p = req.url.split("?")[0];
      if (p === "/") p = "/index.html";
      const data = await readFile(join(DIST, p));
      res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((r) => server.listen(PORT, () => r(server)));
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const { chromium } = require("playwright-core");
  const server = await serve();
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      // Feed a synthetic mic so getUserMedia works headlessly.
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => check("no page errors", false, e.message));
  await page.context().grantPermissions(["microphone"]);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });

  // --- boot -------------------------------------------------------------
  check("app mounts", (await page.textContent(".title")) === "GgMusicMaker");

  // --- import -----------------------------------------------------------
  const tone = join(ROOT, "tests", "fixtures", "tone.wav");
  await page.setInputFiles("input[type=file]", [tone]);
  await page.waitForTimeout(600);
  check("imports and layers a file", (await page.$$(".head")).length === 1);

  // --- undo / redo ------------------------------------------------------
  check("undo enabled after an edit", await page.isEnabled("button.undo"));
  check("redo disabled with nothing undone", !(await page.isEnabled("button.redo")));
  await page.click("button.undo");
  await page.waitForTimeout(150);
  check("undo removes the imported layer", (await page.$$(".head")).length === 0);
  await page.click("button.redo");
  await page.waitForTimeout(150);
  check("redo restores the layer", (await page.$$(".head")).length === 1);
  await page.click("button:has-text('Layer')");
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  check("Ctrl+Z undoes adding a layer", (await page.$$(".head")).length === 1);
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(150);
  check("Ctrl+Shift+Z redoes it", (await page.$$(".head")).length === 2);
  await page.keyboard.press("Control+z"); // back to just the imported layer
  await page.waitForTimeout(150);

  // --- analogue meter ---------------------------------------------------
  // The fixture tone sits right at the limiter threshold, so crank the master
  // fader: the pre-limiter meter must then light its PEAK lamp while playing.
  await page.$eval(".master input[type=range]", (el) => {
    el.value = "1.2";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("button[aria-label='Play or pause']");
  await page.waitForTimeout(700);
  // The lamp is the "(o) PEAK" glyphs at the bottom-left of the dial face
  // (cells 1..8 of row 10, 5x7 px cells). Scan that strip for the brightest
  // pixel: amber/red when lit, dim green when not.
  const lamp = await page.evaluate(() => {
    const c = document.querySelector("canvas.meter");
    const dpr = window.devicePixelRatio || 1;
    const d = c.getContext("2d").getImageData(5 * dpr, 70 * dpr, 40 * dpr, 7 * dpr).data;
    let best = { r: 0, g: 0, b: 0 };
    for (let i = 0; i < d.length; i += 4) if (d[i] > best.r) best = { r: d[i], g: d[i + 1], b: d[i + 2] };
    return best;
  });
  check(
    "analogue meter PEAK lamp lights on a hot signal",
    lamp.r > 200 && lamp.b < 120,
    `rgb(${lamp.r},${lamp.g},${lamp.b})`,
  );
  await page.click("button[aria-label='Stop']");
  await page.$eval(".master input[type=range]", (el) => {
    el.value = "0.9";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(200);

  // --- recording (previously untested) ----------------------------------
  await page.click("button:has-text('Record')");
  await page.waitForTimeout(1800);
  await page.click("button:has-text('REC')");
  await page.waitForTimeout(900);
  const status = await page.textContent(".statusbar");
  check(
    "records audio onto a layer",
    /Recorded \d+\.\d+s/.test(status),
    status.trim(),
  );
  check(
    "recording used the AudioWorklet path (not the fallback)",
    !status.includes("fallback capture"),
  );

  // --- mute / solo during playback --------------------------------------
  // Regression: sources were only scheduled for audible tracks, so a mute
  // then un-mute (or solo then un-solo) mid-playback went silent for good.
  // Uses a 4 s tone on its own layer and measures after the 1 s tone and the
  // 1.8 s take have finished, so that layer is the only thing sounding.
  const litLeds = () =>
    page.$$eval(".seg", (els) => els.filter((e) => !e.style.background.includes("panel")).length);
  await page.click("button[aria-label='Stop']");
  await page.setInputFiles("input[type=file]", [join(ROOT, "tests", "fixtures", "tone-4s.wav")]);
  await page.waitForTimeout(600);
  const longLayer = ".head:nth-child(3)";
  // Mute BEFORE play, then un-mute during playback.
  await page.click(`${longLayer} .chip.mute`);
  await page.click("button[aria-label='Play or pause']");
  await page.waitForTimeout(2100);
  const whileMuted = await litLeds();
  await page.click(`${longLayer} .chip.mute`);
  await page.waitForTimeout(300);
  const afterUnmute = await litLeds();
  check(
    "muted-before-play layer sounds once un-muted",
    whileMuted === 0 && afterUnmute > 0,
    `${whileMuted} → ${afterUnmute} LEDs`,
  );
  await page.click("button[aria-label='Stop']");
  await page.waitForTimeout(200);
  // Solo another layer BEFORE play, then un-solo during playback.
  await page.click(".head:nth-child(1) .chip.solo");
  await page.click("button[aria-label='Play or pause']");
  await page.waitForTimeout(2100);
  const whileSoloed = await litLeds();
  await page.click(".head:nth-child(1) .chip.solo");
  await page.waitForTimeout(300);
  const afterUnsolo = await litLeds();
  check(
    "un-soloing brings back a layer that was silent at play",
    whileSoloed === 0 && afterUnsolo > 0,
    `${whileSoloed} → ${afterUnsolo} LEDs`,
  );
  await page.click("button[aria-label='Stop']");
  await page.waitForTimeout(200);

  // --- export + voice FX change the render ------------------------------
  async function exportBytes() {
    const dl = page.waitForEvent("download", { timeout: 15000 });
    await page.click("button:has-text('Export')");
    return readFile(await (await dl).path());
  }
  const dry = await exportBytes();
  check("exports a WAV", dry.length > 44 && dry.slice(0, 4).toString() === "RIFF");
  await page.waitForTimeout(300);
  const phase = await page.textContent(".dialog .phase").catch(() => "");
  check("export popup reports completion", phase.trim() === "EXPORT COMPLETE", phase.trim());
  await page.click(".dialog button");
  await page.waitForTimeout(200);
  check("export popup dismisses", (await page.$(".dialog")) === null);

  await page.click(".chip.fx");
  await page.waitForTimeout(200);
  await page.click("button:has-text('Chipmunk')");
  await page.waitForTimeout(400);
  const wet = await exportBytes();
  let diff = 0;
  const n = Math.min(dry.length, wet.length);
  for (let i = 44; i < n; i++) if (dry[i] !== wet[i]) diff++;
  check("voice FX changes the rendered mix", diff > 1000, `${diff} bytes differ`);

  // --- session save / open ------------------------------------------------
  // Three layers (tone, take, 4 s tone), Chipmunk on the first, one muted at
  // some point. Save, wipe with New, reopen from the file, and prove the
  // reopened project renders the same mix.
  page.on("dialog", (d) => d.accept());
  const sessionLabel = () => page.textContent(".app-header .session").then((t) => t.trim());
  check("unsaved session shows as untitled*", (await sessionLabel()) === "untitled*", await sessionLabel());
  const layersBefore = (await page.$$(".head")).length;
  const namesBefore = await page.$$eval(".head .name", (els) => els.map((e) => e.value));

  const dlSession = page.waitForEvent("download", { timeout: 15000 });
  await page.click("button.session-save");
  const sessionFile = await (await dlSession).path();
  const sessionBytes = await readFile(sessionFile);
  check(
    "saves a .ggmm session file",
    sessionBytes.slice(0, 4).toString() === "GGMM" && sessionBytes.length > 44 * 3,
    `${(sessionBytes.length / 1024).toFixed(0)} KB`,
  );
  await page.waitForTimeout(200);
  check("saving clears the dirty marker", (await sessionLabel()) === "untitled", await sessionLabel());

  await page.click("button.session-new");
  await page.waitForTimeout(200);
  check("New empties the workspace", (await page.$$(".head")).length === 0);

  await page.setInputFiles("input[data-role=session-file]", [sessionFile]);
  await page.waitForTimeout(800);
  const namesAfter = await page.$$eval(".head .name", (els) => els.map((e) => e.value));
  check(
    "Open restores every layer by name",
    layersBefore === 3 && namesAfter.length === 3 && namesAfter.join("|") === namesBefore.join("|"),
    namesAfter.join(", "),
  );
  const openedStatus = (await page.textContent(".statusbar")).trim();
  // (Playwright hands the download back under a random temp name, so only
  // the shape of the message is checked here, not the session's name.)
  check("status reports the opened session", /^Opened .* — 3 layers\.$/.test(openedStatus), openedStatus);

  const reopened = await exportBytes();
  const a16 = new Int16Array(wet.buffer, wet.byteOffset + 44, (wet.length - 44) >> 1);
  const b16 = new Int16Array(reopened.buffer, reopened.byteOffset + 44, (reopened.length - 44) >> 1);
  let maxDelta = 0;
  for (let i = 0; i < Math.min(a16.length, b16.length); i++) {
    const d = Math.abs(a16[i] - b16[i]);
    if (d > maxDelta) maxDelta = d;
  }
  check(
    "reopened session renders the same mix (FX, gains, clips intact)",
    a16.length === b16.length && maxDelta < 0.01 * 32768,
    `${a16.length} vs ${b16.length} samples, max delta ${(maxDelta / 32768).toFixed(4)}`,
  );

  // --- Voice Synth stack + surround export ----------------------------------
  // Choir = 6 unison voices + harmonies spread to the rear, LFE and centre
  // sends. Rendered at 5.1 and 7.1 the WAV must be WAVE_FORMAT_EXTENSIBLE
  // with the right channel count/mask, and the stack must actually reach
  // the centre, surround and LFE channels.
  await page.click(".chip.fx");
  await page.waitForTimeout(200);
  await page.click("button:has-text('Choir')");
  await page.click("button.tab:has-text('SPACE')");
  await page.waitForTimeout(100);
  async function exportSurround(label, channels, mask) {
    await page.click(`button.surround:has-text('${label}')`);
    await page.waitForTimeout(300);
    const bytes = await exportBytes();
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const fmtOk = v.getUint16(20, true) === 0xfffe && v.getUint16(22, true) === channels && v.getUint32(40, true) === mask;
    check(`${label} export is a ${channels}-channel extensible WAV`, fmtOk, `fmt ${v.getUint16(20, true).toString(16)}, ${v.getUint16(22, true)} ch, mask ${v.getUint32(40, true).toString(16)}`);
    const dataAt = 68; // 12 RIFF + (8 + 40) fmt + 8 data header
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset + dataAt, (bytes.length - dataAt) >> 1);
    const rms = new Array(channels).fill(0);
    for (let i = 0; i < pcm.length; i++) rms[i % channels] += pcm[i] * pcm[i];
    const frames = pcm.length / channels;
    const db = rms.map((s) => (s ? 20 * Math.log10(Math.sqrt(s / frames) / 32768) : -Infinity));
    // Centre and surrounds carry the stack; LFE is only the low-passed sub,
    // so it must sit well below the centre (a leak would make them equal).
    const placed = db[2] > -40 && db[channels - 2] > -50 && db[channels - 1] > -50;
    const lfeIsSub = db[3] > -80 && db[3] < db[2] - 10;
    check(`${label} render puts the stack on centre + surrounds, sub only on LFE`, placed && lfeIsSub, db.map((d) => d.toFixed(0)).join(" "));
    await page.waitForTimeout(300);
    await page.click(".dialog button");
    await page.waitForTimeout(200);
    return db;
  }
  await exportSurround("5.1", 6, 0x3f);
  await exportSurround("7.1", 8, 0x63f);
  await page.click("button.surround:has-text('Stereo')");
  await page.waitForTimeout(200);
  check("surround change is undoable", await page.isEnabled("button.undo"));

  // --- load meter + low-power mode ------------------------------------------
  await page.waitForTimeout(600);
  const cpu = (await page.textContent("[data-role=cpu]")).trim();
  check("load meter shows a CPU percentage", /^\d{1,3}%$/.test(cpu), cpu);
  check("no dropout lamp after an ordinary session", !(await page.$(".lamp.lit")));
  check("backdrop rain is on by default", (await page.$("canvas.rain")) !== null);
  await page.click("button.eco");
  await page.waitForTimeout(150);
  check("ECO removes the backdrop rain", (await page.$("canvas.rain")) === null);
  check(
    "ECO is remembered",
    (await page.evaluate(() => localStorage.getItem("ggmm.lowPower"))) === "1",
  );
  await page.click("button.eco");
  await page.waitForTimeout(150);
  check("ECO off brings the rain back", (await page.$("canvas.rain")) !== null);

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
