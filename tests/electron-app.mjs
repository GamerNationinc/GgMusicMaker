// End-to-end test of the real desktop app: launches Electron on the built
// dist/ (the same code the packaged app runs), offscreen, and drives it —
// no browser stand-in. Proves the shell itself: the app:// origin, the
// AudioWorklets (synth / morph / punch / placer / binaural) loading, many
// long layers drawing, a stack building, and a native-path WAV export.
//
//   npm run build && npm run test:app            (dev tree)
//   GGMM_APP=release/linux-unpacked/ggmusicmaker npm run test:app   (packaged app)
import { writeFile, readFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
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

const dir = await mkdtemp(join(tmpdir(), "ggmm-app-"));
const saveDir = await mkdtemp(join(tmpdir(), "ggmm-app-out-"));
const files = [];
for (let f = 0; f < 12; f++) {
  const rate = 44100, secs = 120, n = rate * secs;
  const wav = Buffer.alloc(44 + n * 4);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + n * 4, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(9000 * Math.sin(i * (0.01 + f * 0.001)) * ((i / rate) % 0.5 < 0.2 ? 1 : 0.2));
    wav.writeInt16LE(v, 44 + i * 4);
    wav.writeInt16LE(v, 46 + i * 4);
  }
  const p = join(dir, `song-${f + 1}.wav`);
  await writeFile(p, wav);
  files.push(p);
}

const packaged = process.env.GGMM_APP;
const app = await electron.launch({
  ...(packaged ? { executablePath: resolve(packaged), args: ["--ozone-platform=x11"] } : { args: [ROOT, "--ozone-platform=x11"] }),
  // Electron's headless ozone backend segfaults on SteamOS; a hidden X11 window works.
  env: { ...process.env, GGMM_TEST_SAVE_DIR: saveDir, GGMM_HIDDEN: "1", GGMM_NO_CLOSE_GUARD: "1" },
});
const page = await app.firstWindow();
page.on("pageerror", (e) => check("no page errors", false, e.message));
await page.waitForSelector(".title");

const info = await page.evaluate(() => window.ggmmNative?.appInfo());
check("runs in the desktop shell with its own Chromium", !!info?.chrome, info ? `Electron ${info.electron}, Chromium ${info.chrome}` : "no native bridge");
check("served from the private app:// origin", page.url().startsWith("app://ggmm/"), page.url());

await page.setInputFiles("input[type=file][accept='audio/*']", files);
await page.waitForFunction(() => document.querySelectorAll(".head").length === 12, null, { timeout: 120000 });
check("imports 12 × 120 s songs", true);
// A hidden window doesn't run frames, so the browser never delivers the
// scroll event on its own; send it the way a visible window would.
await page.$eval(".body", (el) => {
  el.scrollTop = el.scrollHeight;
  el.dispatchEvent(new Event("scroll"));
});
await page.waitForTimeout(500);
const ink = await page.evaluate(() => {
  const c = document.querySelector(".lanes canvas");
  const top = parseFloat(c.style.top) || 0;
  const dpr = devicePixelRatio;
  const ctx = c.getContext("2d");
  const y = Math.round((11 * 96 + 48 - top) * dpr);
  const d = ctx.getImageData(0, y, c.width, 1).data;
  const bg = ctx.getImageData(Math.round(2 * dpr), Math.round((11 * 96 + 1 - top) * dpr), 1, 1).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40) n++;
  return n / (d.length / 4);
});
const dbg = await page.evaluate(() => {
  const c = document.querySelector(".lanes canvas"), b = document.querySelector(".body"), l = document.querySelector(".lanes-scroll");
  return `canvas ${c.width}x${c.height} top ${c.style.top} · body ${b.scrollTop}/${b.scrollHeight} ch ${b.clientHeight} · lanes ${l.clientWidth}x${l.clientHeight} · vis ${document.visibilityState}`;
});
check("the 12th layer's waveform draws", ink > 0.5, `${Math.round(ink * 100)}% inked · ${dbg}`);

// A stack on the first layer: exercises every FX worklet the racks use.
await page.$eval(".body", (el) => (el.scrollTop = 0));
await page.click(".head:nth-child(1) .chip.fx");
await page.click(".cats button:has-text('VOCALS')");
await page.click(".recipe:has-text('Wall of Vox')");
await page.waitForFunction(() => document.querySelectorAll(".head").length === 16, null, { timeout: 20000 });
check("builds a Wall of Vox stack", true);
const worklets = await page.evaluate(async () => {
  // Every module the app registers must construct in this shell.
  const ctx = new AudioContext();
  const names = ["voice-synth-processor", "morph-processor", "punch-processor", "placer-processor", "binaural-processor"];
  for (const f of ["voice-synth-processor.js", "morph-processor.js", "punch-core.js", "punch-processor.js", "placer-processor.js", "binaural-processor.js"])
    await ctx.audioWorklet.addModule(`/${f}`);
  const ok = names.filter((n) => {
    try {
      new AudioWorkletNode(ctx, n);
      return true;
    } catch {
      return false;
    }
  });
  await ctx.close();
  return ok;
});
check("all five FX worklets run in the shell", worklets.length === 5, worklets.join(", "));

// Export through the native save path (dialog bypassed by GGMM_TEST_SAVE_DIR).
// Keep it short: drop all but the stack first.
for (let i = 0; i < 11; i++) {
  await page.click(".head:last-child .chip:has-text('✕')");
}
await page.waitForFunction(() => document.querySelectorAll(".head").length === 5);
await page.click("button:has-text('Export')");
await page.waitForFunction(() => /EXPORT COMPLETE|SAVED/i.test(document.querySelector(".dialog .phase")?.textContent ?? ""), null, { timeout: 180000 });
const out = await readdir(saveDir);
const wav = out.find((f) => f.endsWith(".wav"));
const bytes = wav ? await readFile(join(saveDir, wav)) : Buffer.alloc(0);
check("exports a WAV to disk through the native save path", bytes.length > 1_000_000 && bytes.slice(0, 4).toString() === "RIFF", `${wav ?? "nothing"} ${(bytes.length / 1e6).toFixed(1)} MB`);

// --- native (Rust) engine ----------------------------------------------------
// Switch engines (reloads the window), import one layer, play very quietly,
// and prove the native engine is the one moving the playhead + meters.
await page.evaluate(() => localStorage.setItem("ggmm.engine", "native"));
await page.reload();
await page.waitForSelector(".title");
check("ENGINE switch shows NATIVE", (await page.$("[data-role=engine-native].on")) !== null);
const avail = await page.evaluate(() => window.ggmmNative.engine.available());
check("the native engine opened the audio device", avail.ok === true, avail.ok ? `${avail.device} @ ${avail.sampleRate} Hz` : avail.error);
await page.setInputFiles("input[type=file][accept='audio/*']", [join(ROOT, "tests", "fixtures", "tone-4s.wav")]);
await page.waitForFunction(() => document.querySelectorAll(".head").length === 1);
await page.$eval(".master input[type=range]", (el) => {
  el.value = "0.03"; // ~-30 dB: audible proof isn't the point, the meters are
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const before = await page.evaluate(() => window.ggmmNative.engine.status());
await page.click("button[aria-label='Play or pause']");
await page.waitForTimeout(1500);
const during = await page.evaluate(() => window.ggmmNative.engine.status());
const shown = (await page.textContent(".transport .time")) ?? "";
await page.click("button[aria-label='Stop']");
check("native transport plays: engine playhead advances", during.playing && during.time > 1.0, `t=${during.time.toFixed(2)} s`);
check("native meters see the signal", during.peak > 0.001, `peak ${during.peak.toFixed(4)}`);
check("native device clock runs", during.clock - before.clock > 1.2, `${(during.clock - before.clock).toFixed(2)} s`);
check("UI playhead follows the native engine", /00:0[1-2]/.test(shown), shown.trim());
// A module the native engine doesn't render yet is named in the header.
await page.click(".chip.fx");
await page.click("button.tab:has-text('FX CHAIN')");
await page.click(".slot.morph .pick");
await page.click(".engine:has-text('GRAIN CLOUD')");
await page.waitForTimeout(300);
check("header names modules not native yet", /MORPH/.test((await page.textContent("[data-role=engine-note]").catch(() => "")) ?? ""));
await page.evaluate(() => localStorage.setItem("ggmm.engine", "web"));

await app.close();
console.log(`\n${passed}/${passed + failed} desktop-app checks passed`);
process.exit(failed ? 1 : 0);
