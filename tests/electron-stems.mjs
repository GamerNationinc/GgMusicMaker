// Stem separation in the real desktop app: import a real song (the Demucs
// project's own 20 s test clip), press STEMS, and check the layers that come
// back — then that the stems add up to the song: the mix exported with the
// stems (original muted) must match the mix of the original alone.
//
//   scripts/fetch-model.sh && npm run build && npm run test:stems
//   GGMM_APP=release/linux-unpacked/ggmusicmaker npm run test:stems   (packaged app)
import { rm, readFile, writeFile, mkdtemp, mkdir, stat } from "node:fs/promises";
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

// The clip is MIT-licensed test material from facebookresearch/demucs; cached, not committed.
const cacheDir = join(ROOT, "node_modules", ".cache", "ggmm");
const song = join(cacheDir, "demucs-test.mp3");
if (!(await stat(song).catch(() => null))) {
  await mkdir(cacheDir, { recursive: true });
  const res = await fetch("https://github.com/facebookresearch/demucs/raw/main/test.mp3");
  if (!res.ok) throw new Error(`couldn't fetch the test song: ${res.status}`);
  await writeFile(song, Buffer.from(await res.arrayBuffer()));
}

const userData = await mkdtemp(join(tmpdir(), "ggmm-stems-data-"));
const saveDir = await mkdtemp(join(tmpdir(), "ggmm-stems-out-"));
const packaged = process.env.GGMM_APP;
const app = await electron.launch({
  ...(packaged ? { executablePath: resolve(packaged), args: ["--ozone-platform=x11"] } : { args: [ROOT, "--ozone-platform=x11"] }),
  env: { ...process.env, GGMM_USER_DATA: userData, GGMM_TEST_SAVE_DIR: saveDir, GGMM_HIDDEN: "1", GGMM_NO_CLOSE_GUARD: "1" },
});
const page = await app.firstWindow();
page.on("pageerror", (e) => check("no page errors", false, e.message));
await page.waitForSelector(".app-header");

const avail = await page.evaluate(() => window.ggmmNative.separation.available());
check("stem separation is available (engine + model)", avail.ok, avail.error ?? "");
await page.waitForFunction(() => !document.querySelector("button.stems")?.disabled, null, { timeout: 5000 }).catch(() => {});

await page.setInputFiles("input[type=file][accept='audio/*']", [song]);
await page.waitForFunction(() => document.querySelectorAll(".head").length === 1);

const exportWav = async () => {
  await page.click("button:has-text('Export')");
  await page.waitForFunction(() => /EXPORT COMPLETE|FAIL/i.test(document.querySelector(".dialog")?.textContent ?? ""), null, { timeout: 180000 });
  const bytes = await readFile(join(saveDir, "ggmusicmaker-mix.wav"));
  await page.click(".dialog button", { timeout: 3000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector(".dialog"), null, { timeout: 5000 }).catch(() => {});
  const n = (bytes.length - 44) >> 2;
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = bytes.readInt16LE(44 + i * 4) / 32768;
    r[i] = bytes.readInt16LE(46 + i * 4) / 32768;
  }
  return [l, r];
};

const t0 = Date.now();
await page.click("button.stems");
await page.waitForFunction(() => /STEMS READY|FAILED|CANCELLED/.test(document.querySelector(".dialog")?.textContent ?? ""), null, { timeout: 300000 });
const secs = (Date.now() - t0) / 1000;
const dialog = (await page.textContent(".dialog")).replace(/\s+/g, " ").trim();
check("separates the song", /STEMS READY/.test(dialog), `${secs.toFixed(1)} s · ${dialog.slice(0, 160)}`);
await page.click(".dialog button");

const heads = await page.$$eval(".head", (hs) => hs.map((h) => ({ name: h.querySelector(".name").value, muted: !!h.querySelector(".chip.mute.on") })));
const names = heads.map((h) => h.name);
check("the original layer is kept, muted", heads[0]?.muted === true && heads[0].name === "demucs-test", names.join(" | "));
check("stems land on new layers under it, named after the song", heads.length > 2 && heads.slice(1).every((h) => h.name.startsWith("demucs-test · ") && !h.muted), names.slice(1).join(" | "));
// This clip is drums + other (no singer, no bass): those must be found, silent stems skipped.
check("finds the drums and the rest", names.includes("demucs-test · Drums") && names.includes("demucs-test · Other"));
check("skips stems the song doesn't have", !names.includes("demucs-test · Vocals") && !names.includes("demucs-test · Piano"), names.join(" | "));

const stems = await exportWav();
await page.keyboard.press("Control+z");
await page.waitForFunction(() => document.querySelectorAll(".head").length === 1);
check("one undo puts it back the way it was", (await page.$(".head .chip.mute.on")) === null);
const original = await exportWav();
const n = Math.min(stems[0].length, original[0].length);
let dot = 0, ss = 0, oo = 0;
for (const ch of [0, 1]) for (let i = 0; i < n; i++) {
  dot += stems[ch][i] * original[ch][i];
  ss += stems[ch][i] ** 2;
  oo += original[ch][i] ** 2;
}
const corr = dot / Math.sqrt(ss * oo);
const dB = 10 * Math.log10(ss / oo);
check("the stems add back up to the song (correlation > 0.999)", corr > 0.999, `r = ${corr.toFixed(5)}`);
check("… at the same level (within 0.2 dB)", Math.abs(dB) < 0.2, `${dB.toFixed(3)} dB`);

// Cancel mid-way: the separator process must actually stop, and clean up.
const { execSync } = await import("node:child_process");
const separators = () => execSync("pgrep -x ggmm-separate || true").toString().trim();
await page.click("button.stems");
await page.waitForFunction(() => /SEPARATING/.test(document.querySelector(".dialog")?.textContent ?? ""), null, { timeout: 60000 });
check("the separator runs as its own process", separators() !== "");
await page.click(".dialog button:has-text('Cancel')");
await page.waitForFunction(() => /CANCELLED/.test(document.querySelector(".dialog")?.textContent ?? ""), null, { timeout: 15000 });
let gone = false;
for (let i = 0; i < 40 && !gone; i++) {
  await new Promise((r) => setTimeout(r, 250));
  gone = separators() === "";
}
check("Cancel stops the separator process", gone);
const leftovers = await stat(join(userData, "stems-work", "2")).then(() => true, () => false);
check("… and deletes its work files", !leftovers);
await page.click(".dialog button");
check("cancelling leaves the song alone", (await page.$$(".head")).length === 1);

await app.evaluate(({ app }) => app.exit(0));
for (const d of [userData, saveDir]) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(`\n${passed}/${passed + failed} stem checks passed`);
process.exit(failed ? 1 : 0);
