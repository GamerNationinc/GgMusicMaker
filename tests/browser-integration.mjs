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
