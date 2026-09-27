// Native recording in the real desktop app, measured end to end.
//
// A private null sink is the "room": the app plays into it and records its
// monitor, so what the take hears is exactly what the app played. Then:
// calibrate (header ⏱ button) → overdub while a click track plays → save →
// parse the .ggmm and check the take sits on the timeline where the clicks
// it captured were played. Also: an input that can't open falls back to web
// recording and says so.
//
// Routing: on PipeWire (the Deck) PIPEWIRE_NODE points the default ALSA
// device at the sink and stream.capture.sink makes capture read its
// monitor; on PulseAudio (CI) PULSE_SINK / PULSE_SOURCE do the same.
// Nothing touches the system's default devices.
//
//   npm run build && npm run test:record
import { rm, writeFile, readFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { _electron: electron } = require("playwright-core");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0, passed = 0;
function check(name, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the room ---------------------------------------------------------------
const SINK = `ggmm_rec_${process.pid}`;
const moduleId = execFileSync("pactl", ["load-module", "module-null-sink", `sink_name=${SINK}`, `sink_properties=device.description=${SINK}`]).toString().trim();
const unload = () => {
  try {
    execFileSync("pactl", ["unload-module", moduleId]);
  } catch {}
};
process.on("exit", unload);

// ---- a click track: uneven clicks so alignment is unambiguous ---------------
const SR = 48000, SECS = 8, N = SR * SECS;
const click = new Float32Array(N);
{
  const gaps = [0.29, 0.47, 0.35, 0.53, 0.41];
  let t = 0.2;
  for (let k = 0; t < SECS - 0.1; k++) {
    const at = Math.round(t * SR);
    for (let i = 0; i < 240; i++) click[at + i] = 0.7 * Math.sin(i * 0.5) * (1 - i / 240);
    t += gaps[k % gaps.length];
  }
}
const dir = await mkdtemp(join(tmpdir(), "ggmm-rec-in-"));
const wavPath = join(dir, "clicks.wav");
{
  const wav = Buffer.alloc(44 + N * 4);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + N * 4, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(1, 22); // float, mono
  wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(32, 34);
  wav.write("data", 36); wav.writeUInt32LE(N * 4, 40);
  for (let i = 0; i < N; i++) wav.writeFloatLE(click[i], 44 + i * 4);
  await writeFile(wavPath, wav);
}

// ---- .ggmm parsing (see src/state/session.ts) --------------------------------
function readWavFloat(buf) {
  let p = 12, fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4), len = buf.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = { format: buf.readUInt16LE(p + 8), channels: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === "data") {
      const frames = len / (fmt.channels * fmt.bits / 8);
      const ch = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) for (let c = 0; c < fmt.channels; c++) {
        const o = p + 8 + (f * fmt.channels + c) * (fmt.bits / 8);
        ch[c][f] = fmt.format === 3 ? buf.readFloatLE(o) : buf.readInt16LE(o) / 32768;
      }
      return { rate: fmt.rate, channels: ch };
    }
    p += 8 + len + (len & 1);
  }
  throw new Error("no data chunk");
}
function readSession(buf) {
  const headerLen = buf.readUInt32LE(8);
  const header = JSON.parse(buf.toString("utf8", 12, 12 + headerLen));
  const blobs = 12 + headerLen;
  const audio = new Map(header.audio.map((a) => [a.id, readWavFloat(buf.subarray(blobs + a.offset, blobs + a.offset + a.length))]));
  return { header, audio };
}

// ---- the app ------------------------------------------------------------------
const packaged = process.env.GGMM_APP;
const tempDirs = [dir];
async function launch(extraEnv = {}, extraArgs = []) {
  const userData = await mkdtemp(join(tmpdir(), "ggmm-rec-data-"));
  const saveDir = await mkdtemp(join(tmpdir(), "ggmm-rec-out-"));
  tempDirs.push(userData, saveDir);
  const app = await electron.launch({
    ...(packaged
      ? { executablePath: resolve(packaged), args: ["--ozone-platform=x11", ...extraArgs] }
      : { args: [ROOT, "--ozone-platform=x11", ...extraArgs] }),
    env: {
      ...process.env,
      GGMM_USER_DATA: userData,
      GGMM_TEST_SAVE_DIR: saveDir,
      GGMM_HIDDEN: "1",
      GGMM_NO_CLOSE_GUARD: "1",
      GGMM_TEST_DIALOG: "0",
      PIPEWIRE_NODE: SINK,
      PIPEWIRE_PROPS: "{ stream.capture.sink=true }",
      PULSE_SINK: SINK,
      PULSE_SOURCE: `${SINK}.monitor`,
      ...extraEnv,
    },
  });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => check("no page errors", false, e.message));
  await page.waitForSelector(".title");
  return { app, page, saveDir };
}
const statusText = (page) => page.textContent(".statusbar").then((s) => s.trim());
async function waitStatus(page, re, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await statusText(page);
    if (re.test(s)) return s;
    await sleep(150);
  }
  return statusText(page);
}

// 1. Calibrate, then overdub while the clicks play.
{
  const { app, page, saveDir } = await launch();
  const avail = await page.evaluate(() => window.ggmmNative.engine.available());
  check("native engine opened the test sink", avail.ok === true, avail.ok ? `${avail.device} @ ${avail.sampleRate} Hz` : avail.error);
  await page.setInputFiles("input[type=file][accept='audio/*']", [wavPath]);
  await page.waitForFunction(() => document.querySelectorAll(".head").length === 1);

  check("uncalibrated at first", (await page.textContent("[data-role=calibrate]")).includes("CAL"));
  await page.click("[data-role=calibrate]");
  const cal = await waitStatus(page, /Recording latency: |Calibration failed/);
  const ms = Number(/Recording latency: (-?[\d.]+) ms/.exec(cal)?.[1]);
  check("calibration measures the round trip", Number.isFinite(ms) && ms > 1 && ms < 300, cal);
  check("the header shows it", (await page.textContent("[data-role=calibrate]")).includes(`${Math.round(ms)}ms`));

  // Overdub: play from 1.0 s, record ~3 s on a new layer, stop.
  await page.evaluate(() => { const el = document.querySelector(".lanes"); el && el.focus(); });
  await page.click("button[aria-label='Play or pause']");
  await sleep(700);
  await page.keyboard.press("r");
  const recStatus = await waitStatus(page, /Recording onto/);
  check("recording starts", /Recording onto/.test(recStatus), recStatus);
  await sleep(3000);
  await page.keyboard.press("r");
  const done = await waitStatus(page, /^Recorded /);
  await page.click("button[aria-label='Stop']");
  check("the take was captured natively and compensated", /native capture, [\d.]+ ms latency compensated/.test(done), done);
  check("no samples dropped", !/dropped/.test(done), done);

  await page.keyboard.press("Control+s");
  let file = null;
  for (let i = 0; i < 50 && !file; i++) {
    file = (await readdir(saveDir)).find((f) => f.endsWith(".ggmm"));
    if (!file) await sleep(200);
  }
  const { header, audio } = readSession(await readFile(join(saveDir, file)));
  const take = header.project.tracks.flatMap((t) => t.clips).find((c) => c.name === "Take");
  check("the take is on the timeline", !!take, take ? `starts at ${take.startTime.toFixed(3)} s, ${take.duration.toFixed(2)} s long` : "none");
  if (take) {
    const pcm = audio.get(take.bufferId);
    const rec = pcm.channels[0];
    const rate = pcm.rate;
    // The playhead was near 0.7 s when recording started: the take must
    // start there (not at the playhead when it stopped, ~3.7 s).
    check("the take starts where recording began, not where it stopped", take.startTime > 0.3 && take.startTime < 1.5, take.startTime.toFixed(3));
    // Residual misalignment: where does the captured audio best match the
    // click track, relative to where the take was placed?
    const start = Math.round(take.startTime * rate);
    let best = -Infinity, lag = 0;
    const hot = [];
    for (let j = 0; j < N; j++) if (click[j] !== 0) hot.push(j);
    for (let l = -Math.round(0.1 * rate); l <= Math.round(0.1 * rate); l++) {
      let s = 0;
      for (const j of hot) {
        const i = j - start + l;
        if (i >= 0 && i < rec.length) s += rec[i] * click[j];
      }
      if (s > best) { best = s; lag = l; }
    }
    const errMs = (lag / rate) * 1000;
    let peak = 0;
    for (const v of rec) peak = Math.max(peak, Math.abs(v));
    check("the take heard the clicks", peak > 0.05, `peak ${peak.toFixed(3)}`);
    check("overdub lands in time (within 1 ms)", Math.abs(errMs) <= 1, `${errMs.toFixed(2)} ms off (${lag} samples)`);
  }
  await app.evaluate(({ app }) => app.exit(0));
}

// 2. An input that won't open: recording still works, through the web engine.
{
  // The web path needs a mic Chromium can see; CI runners have none, so it
  // gets Chromium's fake one (this check is about the fallback, not the mic).
  const { app, page } = await launch({ GGMM_INPUT_DEVICE: "no-such-input" }, ["--use-fake-device-for-media-stream"]);
  await page.keyboard.press("r");
  const s = await waitStatus(page, /Recording onto|Mic unavailable/);
  check("falls back to web recording and says why", /native capture unavailable: no input device named no-such-input — recorded through the web engine/.test(s), s);
  await sleep(800);
  await page.keyboard.press("r");
  const done = await waitStatus(page, /^Recorded /);
  check("… and the fallback take is recorded", /^Recorded /.test(done), done);
  await app.evaluate(({ app }) => app.exit(0));
}

unload();
// /tmp is RAM on the Deck: never leave test audio behind.
for (const d of tempDirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(`\n${passed}/${passed + failed} native recording checks passed`);
process.exit(failed ? 1 : 0);
