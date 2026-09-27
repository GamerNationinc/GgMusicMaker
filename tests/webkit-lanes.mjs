// WebKit check for the timeline — the Deck runs WebKitGTK, and layout bugs
// there don't show in Chromium (the blank-layers-past-~10 bug was one: the
// lanes box was clipped to the visible height in WebKit only).
//
// Imports 14 realistic 200 s stereo songs into the production build in
// Playwright's WebKit, then checks every layer draws its waveform at the top,
// bottom and far end of the timeline. Needs WebKit's Ubuntu libraries, so run
// it with scripts/test-webkit-in-container.sh.
import http from "node:http";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { webkit } = require("playwright-core");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const PORT = 4620;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const N = 14, SECS = 200, RATE = 44100;

let failed = 0, passed = 0;
function check(name, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const server = http
  .createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    try {
      const d = await readFile(join(DIST, p));
      res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
      res.end(d);
    } catch {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(PORT);

const dir = await mkdtemp(join(tmpdir(), "ggmm-wk-"));
const files = [];
for (let f = 0; f < N; f++) {
  const n = RATE * SECS, wav = Buffer.alloc(44 + n * 4);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + n * 4, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(9000 * Math.sin(i * (0.01 + f * 0.001)) * ((i / RATE) % 0.5 < 0.2 ? 1 : 0.2));
    wav.writeInt16LE(v, 44 + i * 4);
    wav.writeInt16LE(v, 46 + i * 4);
  }
  const p = join(dir, `song-${f + 1}.wav`);
  await writeFile(p, wav);
  files.push(p);
}

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => check("no page errors", false, e.message));
await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.setInputFiles("input[type=file][accept='audio/*']", files);
await page.waitForFunction((n) => document.querySelectorAll(".head").length === n, N, { timeout: 120000 });
await page.waitForTimeout(800);
check(`imports ${N} × ${SECS} s songs`, true);

/** Share of pixels along lane `lane`'s waveform row that differ from its background. */
const inked = (lane) =>
  page.evaluate((lane) => {
    const c = document.querySelector(".lanes canvas");
    const top = parseFloat(c.style.top) || 0;
    const dpr = devicePixelRatio || 1;
    const y = Math.round((lane * 96 + 48 - top) * dpr);
    if (y < 0 || y >= c.height) return -1;
    // The canvas must also be visible there: not clipped by the lanes box.
    const box = document.querySelector(".lanes-scroll").getBoundingClientRect();
    const lanes = document.querySelector(".lanes").getBoundingClientRect();
    if (lanes.top + lane * 96 + 48 > box.bottom) return -2;
    const ctx = c.getContext("2d");
    const d = ctx.getImageData(0, y, c.width, 1).data;
    const bg = ctx.getImageData(Math.round(2 * dpr), Math.round((lane * 96 + 1 - top) * dpr), 1, 1).data;
    let hit = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40) hit++;
    return hit / (d.length / 4);
  }, lane);

check("first layer draws", (await inked(0)) > 0.5);
await page.$eval(".body", (el) => (el.scrollTop = el.scrollHeight));
await page.waitForTimeout(500);
for (const lane of [10, 12, N - 1]) {
  const v = await inked(lane);
  check(`layer ${lane + 1} draws after scrolling down`, v > 0.5, v === -2 ? "clipped by the lanes box" : `${Math.round(v * 100)}% inked`);
}
await page.$eval(".lanes-scroll", (el) => (el.scrollLeft = el.scrollWidth - el.clientWidth - 400));
await page.waitForTimeout(500);
const end = await inked(N - 1);
check(`layer ${N} draws at the end of the song`, end > 0.3, `${Math.round(end * 100)}% inked`);
await page.screenshot({ path: join(dir, "webkit-lanes.png") });

await browser.close();
server.close();
console.log(`\n${passed}/${passed + failed} WebKit checks passed (screenshot: ${join(dir, "webkit-lanes.png")})`);
process.exit(failed ? 1 : 0);
