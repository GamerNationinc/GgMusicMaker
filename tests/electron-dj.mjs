// DJ mode in the real desktop app, driven by Deck controller reports (see
// electron-instrument.mjs for how: GGMM_DECKPAD=fake, the exact 64-byte
// reports, a private null sink). Two generated house loops — 124 and 128
// BPM, first downbeats at 0.3 s and 0.5 s — go on the decks; positions are
// read from the native engine's own deck clocks.
//
//   npm run build && npm run test:dj
import { rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { _electron: electron } = require("playwright-core");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

/** A house loop: kick every beat, clap on 2 and 4, off-beat hats; bar 1 at `start`. */
function houseWav(bpm, start, secs = 40, rate = 44100) {
  const n = rate * secs, beat = 60 / bpm;
  const pcm = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  const hit = (t, len, fn) => {
    const s0 = Math.round(t * rate), m = Math.round(len * rate);
    for (let i = 0; i < m && s0 + i < n; i++) pcm[s0 + i] += fn(i, Math.exp(-i / (m / 5)));
  };
  for (let k = 0; start + k * beat * 0.5 < secs; k++) {
    const t = start + k * beat * 0.5;
    if (k % 2) hit(t, 0.03, (_, e) => 0.12 * e * rnd());
    else {
      hit(t, 0.25, (i, e) => 0.8 * e * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-i / 800)) * (i / rate)));
      if ((k / 2) % 2 === 1) hit(t, 0.15, (_, e) => 0.3 * e * rnd());
    }
  }
  const wav = Buffer.alloc(44 + n * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32000), 44 + i * 2);
  return wav;
}

const SINK = `ggmm_dj_${process.pid}`;
const moduleId = execFileSync("pactl", ["load-module", "module-null-sink", `sink_name=${SINK}`, `sink_properties=device.description=${SINK}`]).toString().trim();
process.on("exit", () => {
  try {
    execFileSync("pactl", ["unload-module", moduleId]);
  } catch {}
});

const userData = await mkdtemp(join(tmpdir(), "ggmm-dj-"));
const songs = await mkdtemp(join(tmpdir(), "ggmm-dj-songs-"));
const loopA = join(songs, "house-124.wav");
const loopB = join(songs, "house-128.wav");
await writeFile(loopA, houseWav(124, 0.3));
await writeFile(loopB, houseWav(128, 0.5));

const packaged = process.env.GGMM_APP;
const app = await electron.launch({
  ...(packaged ? { executablePath: resolve(packaged), args: ["--ozone-platform=x11"] } : { args: [ROOT, "--ozone-platform=x11"] }),
  env: { ...process.env, GGMM_USER_DATA: userData, GGMM_HIDDEN: "1", GGMM_NO_CLOSE_GUARD: "1", GGMM_DECKPAD: "fake", PIPEWIRE_NODE: SINK, PULSE_SINK: SINK },
});
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => check("no page errors", false, e.message));
  await page.waitForSelector(".app-header");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));

  const send = (state = {}) =>
    app.evaluate(({ BrowserWindow }, bytes) => BrowserWindow.getAllWindows()[0].webContents.send("deckpad-report", Uint8Array.from(bytes)), [...buildDeckReport(state)]);
  /** Press and release a button. */
  const tap = async (b) => {
    await send({ buttons: { [b]: true } });
    await send();
  };
  const status = () => page.evaluate(() => window.ggmmNative.engine.status());
  async function peakOver(ms) {
    let peak = 0;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      peak = Math.max(peak, (await status())?.peak ?? 0);
      await sleep(20);
    }
    return peak;
  }
  /** Hold a controller state, re-sent every ~10 ms, for `ms`. */
  async function hold(state, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await send(state);
      await sleep(10);
    }
    await send();
  }

  const avail = await page.evaluate(() => window.ggmmNative.engine.available());
  check("native engine running", avail.ok === true, avail.ok ? `${avail.device} @ ${avail.sampleRate} Hz` : avail.error);
  const c0 = (await status())?.clock ?? 0;
  for (let i = 0; i < 100 && ((await status())?.clock ?? 0) - c0 < 0.1; i++) await sleep(50);

  // --- two songs into the project, then DJ mode ---
  await page.setInputFiles("input[type=file][accept='audio/*']", [loopA, loopB]);
  await page.waitForFunction(() => document.querySelectorAll(".head").length === 2, null, { timeout: 20000 });
  await page.click("[data-role=mode-dj]");
  await page.waitForSelector("[data-role=dj]", { timeout: 3000 }).catch(() => {});
  check("DJ mode opens from the header", !!(await page.$("[data-role=dj]")) && !(await page.$(".workspace")));
  const options = await page.$$eval("[data-role=dj-load-0] option:not([disabled])", (o) => o.map((x) => x.textContent));
  check("the project's songs are on the load list", options.length === 2 && /house-124/.test(options[0]), options.join(" | "));

  await page.selectOption("[data-role=dj-load-0]", { index: 1 });
  await page.waitForFunction(() => /124\.00/.test(document.querySelector("[data-role=dj-bpm-0]")?.textContent ?? ""), null, { timeout: 10000 }).catch(() => {});
  check("deck A loads the 124 BPM loop and reads its tempo", /124\.00/.test(await page.textContent("[data-role=dj-bpm-0]")), (await page.textContent("[data-role=dj-bpm-0]")).trim());
  await page.selectOption("[data-role=dj-load-1]", { index: 2 });
  await page.waitForFunction(() => /128\.00/.test(document.querySelector("[data-role=dj-bpm-1]")?.textContent ?? ""), null, { timeout: 10000 }).catch(() => {});
  check("deck B loads the 128 BPM loop", /128\.00/.test(await page.textContent("[data-role=dj-bpm-1]")), (await page.textContent("[data-role=dj-bpm-1]")).trim());
  await sleep(300);
  const s0 = await status();
  check("loading cues each deck at its first beat", Math.abs(s0.djPos[0] - 0.3) < 0.02 && Math.abs(s0.djPos[1] - 0.5) < 0.02, `${s0.djPos.map((p) => p.toFixed(3))}`);
  check("quiet before playing", (await peakOver(300)) < 1e-3);

  // --- L1 plays deck A ---
  await send();
  await tap("l1");
  const pA = await peakOver(600);
  const s1 = await status();
  check("L1 plays deck A (heard on the master)", pA > 0.05 && s1.djPlaying[0] && !s1.djPlaying[1], `peak ${pA.toFixed(3)}`);
  await sleep(500);
  const s1b = await status();
  check("deck A's clock runs at 1×", Math.abs(s1b.djPos[0] - s1.djPos[0] - (s1b.clock - s1.clock)) < 0.05, `${(s1b.djPos[0] - s1.djPos[0]).toFixed(3)} s in ${(s1b.clock - s1.clock).toFixed(3)} s`);
  check("the screen follows", (await page.textContent("[data-role=dj-time-0]")).startsWith("0:0"), (await page.textContent("[data-role=dj-time-0]")).trim());

  // --- B = SYNC deck B to A, R1 plays it: same tempo, beats lined up ---
  await tap("b");
  await sleep(100);
  check("SYNC brings deck B to 124 BPM", /124\.00/.test(await page.textContent("[data-role=dj-bpm-1]")), (await page.textContent("[data-role=dj-bpm-1]")).trim());
  await tap("r1");
  await tap("b"); // re-sync phase now that both run
  await sleep(1500);
  const s2 = await status();
  const phase = (pos, first, bpm) => (((pos - first) / (60 / bpm)) % 1 + 1) % 1;
  let dph = phase(s2.djPos[0], 0.3, 124) - phase(s2.djPos[1], 0.5, 128);
  dph -= Math.round(dph);
  check("both decks play, beats within 4 % of a beat", s2.djPlaying[0] && s2.djPlaying[1] && Math.abs(dph) < 0.04, `phase diff ${dph.toFixed(3)} beat`);
  const adv0 = s2.djPos[1];
  await sleep(1000);
  const s3 = await status();
  const speedB = (s3.djPos[1] - adv0) / (s3.clock - s2.clock);
  check("deck B runs at 124/128", Math.abs(speedB - 124 / 128) < 0.02, `${speedB.toFixed(3)}×`);

  // --- R2 slides the crossfader to B, and it stays ---
  await hold({ r2: 1 }, 1600);
  await sleep(100);
  const xf = Number(await page.inputValue("[data-role=dj-xfade]"));
  check("holding R2 slides the crossfader all the way to B", xf === 1, `${xf}`);
  await hold({ l2: 1 }, 700);
  const xf2 = Number(await page.inputValue("[data-role=dj-xfade]"));
  check("L2 slides it back towards A, and it stays put", xf2 < 0.2 && xf2 > -0.6, `${xf2}`);
  await hold({ r2: 1 }, 200); // ≈ the middle again
  await page.evaluate(() => {
    const el = document.querySelector("[data-role=dj-xfade]");
    el.value = "0";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // --- left stick down: deck A's LOW knob turns down; L3 kills it ---
  await hold({ lstick: { x: 0, y: -1 } }, 600);
  const low = Number(await page.inputValue("[data-role=dj-eq-0-low]"));
  check("left stick ↓ turns deck A's LOW down", low < -0.5, `${low}`);
  await tap("l3");
  await sleep(100);
  check("L3 kills deck A's LOW", (await page.textContent("[data-role=dj-kill-0-low]")).trim() === "KILL");
  await tap("l3");

  // --- L4 sets hot cue 1 on A; Y loops 4 beats ---
  await tap("l4");
  await sleep(100);
  check("L4 sets hot cue 1 on deck A", (await page.getAttribute("[data-role=dj-hot-0-1]", "class")).includes("set"));
  await tap("y");
  await sleep(100);
  const loopStart = (await status()).djPos[0];
  await sleep(2500); // a 4-beat loop at 124 BPM is 1.94 s
  const s4 = await status();
  check("Y loops 4 beats on deck A", s4.djPos[0] < loopStart + 1.94 && s4.djPlaying[0], `${loopStart.toFixed(2)} → ${s4.djPos[0].toFixed(2)}`);
  await tap("y");

  // --- stop B; press the right pad in and circle backwards: it scratches back ---
  await tap("r1");
  await sleep(200);
  const before = (await status()).djPos[1];
  const t0 = Date.now();
  while (Date.now() - t0 < 800) {
    const a = 2 * Math.PI * 0.8 * ((Date.now() - t0) / 1000); // counter-clockwise = backwards
    await send({ rpad: { x: 0.8 * Math.cos(a), y: 0.8 * Math.sin(a), touch: true }, buttons: { rpadClick: true } });
    await sleep(8);
  }
  await send();
  await sleep(150);
  const after = (await status()).djPos[1];
  check("scratching the right pad backwards runs deck B back", after < before - 0.5, `${before.toFixed(2)} → ${after.toFixed(2)} s`);

  // --- d-pad ← = CUE: deck A back to its cue point and stopped ---
  await tap("left");
  await sleep(150);
  const s5 = await status();
  check("CUE stops deck A at its cue point", !s5.djPlaying[0] && Math.abs(s5.djPos[0] - 0.3) < 0.02, `${s5.djPos[0].toFixed(3)}`);

  await page.screenshot({ path: join(songs, "dj.png") }).catch(() => {});

  // --- View + Menu: back to Studio ---
  await send({ buttons: { view: true, menu: true } });
  await send();
  await page.waitForSelector(".workspace", { timeout: 3000 }).catch(() => {});
  check("View + Menu leaves DJ mode for Studio", !!(await page.$(".workspace")) && !(await page.$("[data-role=dj]")));
  if (process.env.GGMM_KEEP_SHOT) execFileSync("cp", [join(songs, "dj.png"), process.env.GGMM_KEEP_SHOT]);
} catch (e) {
  check("no exceptions", false, e.stack);
} finally {
  await app.close().catch(() => {});
  await rm(userData, { recursive: true, force: true });
  await rm(songs, { recursive: true, force: true });
}
console.log(`\n${passed}/${passed + failed} DJ-mode checks passed`);
process.exit(failed ? 1 : 0);
