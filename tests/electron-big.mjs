// A big session (1.2 GB of audio) through every path that moves a whole
// project between the page and the main process. One IPC message past a few
// hundred MB makes Chromium kill the app (SIGTRAP) — that crashed a real
// 27-layer, 1.1 GB session on recovery at startup. Everything big now moves
// in chunks (electron/transfer.cjs); this proves it end to end:
//
//   autosave → app killed → relaunch recovers it → save → open → native export
//
//   npm run build && npm run test:big
//   GGMM_APP=release/linux-unpacked/ggmusicmaker npm run test:big   (packaged app)
import { rm, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { _electron: electron } = require("playwright-core");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0, passed = 0;
function check(name, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const exists = (p) => stat(p).then(() => true, () => false);
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// On disk, not /tmp: that's RAM on the Deck, and this is ~1 GB of files.
const base = join(ROOT, "node_modules", ".cache", "ggmm-big");
await rm(base, { recursive: true, force: true });
const [inDir, userData, saveDir] = ["in", "data", "out"].map((d) => join(base, d));
for (const d of [inDir, userData, saveDir]) await mkdir(d, { recursive: true });

// 9 × 6 min stereo 48 kHz: 69 MB each as 16-bit WAV, 138 MB each as the
// session's float WAV → a 1.24 GB session. The old code survived 550 MB
// and crashed at 1.1 GB (the user's), so the test has to be this big.
const LAYERS = 9, RATE = 48000, SECS = 360;
const files = [];
for (let f = 0; f < LAYERS; f++) {
  const n = RATE * SECS;
  const wav = Buffer.alloc(44 + n * 4);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + n * 4, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(n * 4, 40);
  const w = 2 * Math.PI * (110 * (f + 1)) / RATE;
  for (let i = 0; i < n; i++) {
    const v = Math.round(6000 * Math.sin(i * w));
    wav.writeInt16LE(v, 44 + i * 4);
    wav.writeInt16LE(v, 46 + i * 4);
  }
  const p = join(inDir, `long-${f + 1}.wav`);
  await writeFile(p, wav);
  files.push(p);
}

const sessionFile = join(saveDir, "untitled.ggmm");
const packaged = process.env.GGMM_APP;
async function launch() {
  const app = await electron.launch({
    ...(packaged ? { executablePath: resolve(packaged), args: ["--ozone-platform=x11"] } : { args: [ROOT, "--ozone-platform=x11"] }),
    env: {
      ...process.env,
      GGMM_USER_DATA: userData,
      GGMM_TEST_SAVE_DIR: saveDir,
      GGMM_TEST_OPEN_FILE: sessionFile,
      GGMM_HIDDEN: "1",
      GGMM_NO_CLOSE_GUARD: "1",
      GGMM_AUTOSAVE_MS: "1000",
      GGMM_TEST_DIALOG: "0", // every dialog: Yes / Reopen
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".title");
  return { app, page, proc: app.process() };
}
const layers = (page) => page.evaluate(() => document.querySelectorAll(".head").length);
const statusText = (page) => page.evaluate(() => document.querySelector(".statusbar")?.textContent?.trim() ?? "");

// 1. Import and autosave, then the app dies without warning.
let { app, page, proc } = await launch();
await page.setInputFiles("input[type=file][accept='audio/*']", files);
await page.waitForFunction((n) => document.querySelectorAll(".head").length === n, LAYERS, { timeout: 180000 });
const audioDir = join(userData, "autosave", "audio");
const autosaved = await waitFor(async () => (await exists(join(userData, "autosave", "session.json"))) && (await readdir(audioDir)).filter((f) => f.endsWith(".wav")).length === LAYERS, 180000);
const autosaveMB = autosaved ? (await Promise.all((await readdir(audioDir)).map((f) => stat(join(audioDir, f))))).reduce((n, s) => n + s.size, 0) / 1e6 : 0;
check("autosaves a 1.2 GB session", autosaved && autosaveMB > 1200, `${autosaveMB.toFixed(0)} MB`);
proc.kill("SIGKILL");
await new Promise((r) => proc.once("exit", r));

// 2. Relaunch: the recovery must not crash the app (it did, at 1.1 GB).
({ app, page, proc } = await launch());
let died = false;
proc.once("exit", () => (died = true));
const recovered = await waitFor(async () => (await layers(page)) === LAYERS, 180000);
check("relaunch recovers every layer without crashing", recovered && !died, `${await layers(page).catch(() => "?")} layers · ${await statusText(page).catch(() => "")}`);

// 3. Save it (one 1.2 GB file).
await page.keyboard.press("Control+s");
await waitFor(async () => /Saved|failed/.test(await statusText(page)), 300000);
const saved = await statusText(page);
const size = (await exists(sessionFile)) ? (await stat(sessionFile)).size : 0;
check("saves the whole session", /^Saved/.test(saved) && size > 1200e6, `${saved} · ${(size / 1e6).toFixed(0)} MB on disk`);

// 4. Open it again.
await page.keyboard.press("Control+n");
await waitFor(async () => (await layers(page)) === 0, 10000);
await page.keyboard.press("Control+o");
await waitFor(async () => /Opened|Couldn't/.test(await statusText(page)), 300000);
check("reopens it", (await layers(page)) === LAYERS && /^Opened/.test(await statusText(page)), await statusText(page));

// 5. Native export of the whole 6-minute mix.
await page.click("button:has-text('Export')");
await page.waitForFunction(() => /EXPORT COMPLETE|FAIL/i.test(document.querySelector(".dialog")?.textContent ?? ""), null, { timeout: 300000 });
const mix = join(saveDir, "ggmusicmaker-mix.wav");
const mixSize = (await exists(mix)) ? (await stat(mix)).size : 0;
check("exports the mix", mixSize > RATE * SECS * 4 * 0.99, `${(mixSize / 1e6).toFixed(0)} MB`);
check("the app is still alive", !died);

await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
await new Promise((r) => (died ? r() : proc.once("exit", r)));
await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(`\n${passed}/${passed + failed} big-session checks passed`);
process.exit(failed ? 1 : 0);
