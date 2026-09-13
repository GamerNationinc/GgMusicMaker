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

  // --- export + voice FX change the render ------------------------------
  async function exportBytes() {
    const dl = page.waitForEvent("download", { timeout: 15000 });
    await page.click("button:has-text('Export')");
    return readFile(await (await dl).path());
  }
  const dry = await exportBytes();
  check("exports a WAV", dry.length > 44 && dry.slice(0, 4).toString() === "RIFF");

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
