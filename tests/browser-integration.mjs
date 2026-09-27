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
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    // Lit = the theme's warning/over colours (--meter-mid / --meter-hi);
    // unlit = the dim box line. Themes change the hues, so read them.
    const css = getComputedStyle(document.documentElement);
    const hex = (v) => {
      const h = css.getPropertyValue(v).trim().replace("#", "");
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    };
    const lit = [hex("--meter-mid"), hex("--meter-hi")];
    let best = { r: 0, g: 0, b: 0, dist: 1e9 };
    for (let i = 0; i < d.length; i += 4) {
      for (const [r, g, b] of lit) {
        const dist = Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b);
        if (dist < best.dist) best = { r: d[i], g: d[i + 1], b: d[i + 2], dist };
      }
    }
    return best;
  });
  check(
    "analogue meter PEAK lamp lights on a hot signal",
    lamp.dist < 40,
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
  check("FX panel opens on RACKS & STACK", (await page.$(".racks .rack-grid")) !== null);
  await page.click("button.tab:has-text('FX CHAIN')"); // remembered from here on
  await page.waitForTimeout(100);
  check("rack opens on the Voice Synth slot", (await page.$(".slot.synth.selected")) !== null);
  await page.click("button.preset-browse");
  await page.waitForTimeout(100);
  await page.click(".browser button:has-text('Chipmunk')");
  await page.waitForTimeout(400);
  check("preset browser closes on pick and the screen shows it", (await page.$(".browser")) === null && (await page.textContent(".preset-name")).trim() === "Chipmunk");
  const synthSummary = (await page.textContent(".slot.synth .summary")).trim();
  check("chain strip summarises the synth", synthSummary === "Chipmunk · 100%", synthSummary);
  check("FX chip on the head lights up", (await page.$(".head:nth-child(1) .chip.fx.lit")) !== null);
  const wet = await exportBytes();
  let diff = 0;
  const n = Math.min(dry.length, wet.length);
  for (let i = 44; i < n; i++) if (dry[i] !== wet[i]) diff++;
  check("voice FX changes the rendered mix", diff > 1000, `${diff} bytes differ`);
  await page.click(".slot.synth .power");
  await page.waitForTimeout(300);
  check("bypassed slot dims and keeps its summary", (await page.$(".slot.synth.off")) !== null && (await page.textContent(".slot.synth .summary")).trim() === "Chipmunk · 100%");
  const bypassed = await exportBytes();
  // Chromium sums a node's inputs in hash-set order, so two loud layers can
  // land a sample 1 LSB apart between renders; anything beyond that is real.
  const dry16 = new Int16Array(dry.buffer, dry.byteOffset + 44, (dry.length - 44) >> 1);
  const byp16 = new Int16Array(bypassed.buffer, bypassed.byteOffset + 44, (bypassed.length - 44) >> 1);
  let bypassMax = 0, bypassDiff = 0;
  for (let i = 0; i < Math.min(dry16.length, byp16.length); i++) { const d = Math.abs(dry16[i] - byp16[i]); if (d) bypassDiff++; if (d > bypassMax) bypassMax = d; }
  check("bypassing the synth renders the dry mix again", dry16.length === byp16.length && bypassMax <= 1 && bypassDiff < dry16.length * 0.001, `${bypassDiff} samples differ, max ${bypassMax} LSB`);
  await page.waitForTimeout(300);
  await page.click(".dialog button");
  await page.waitForTimeout(200);
  await page.click(".slot.synth .power"); // back on
  await page.waitForTimeout(200);

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

  // --- duplicate layer --------------------------------------------------------
  // Copy layer 1 (tone + Chipmunk): it lands right under the original with
  // the FX intact, so the render gets louder; Ctrl+Z takes it away again.
  await page.click(".head:nth-child(1) .chip.dup");
  await page.waitForTimeout(200);
  const namesDup = await page.$$eval(".head .name", (els) => els.map((e) => e.value));
  check("duplicate inserts a copy under the original", namesDup.length === 4 && namesDup[1] === "tone copy", namesDup.join(", "));
  const dupStatus = (await page.textContent(".statusbar")).trim();
  check("status reports the duplicate", dupStatus === "Duplicated tone → tone copy.", dupStatus);
  const withDup = await exportBytes();
  await page.waitForTimeout(300);
  await page.click(".dialog button");
  await page.waitForTimeout(200);
  const energy = (buf) => {
    const s16 = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) >> 1);
    let e = 0;
    for (let i = 0; i < s16.length; i++) e += s16[i] * s16[i];
    return e;
  };
  // The copy doubles the tone (+6 dB) but the master limiter eats most of
  // that, so expect "louder and different", not "twice the energy".
  let dupDiff = 0;
  for (let i = 44; i < Math.min(withDup.length, reopened.length); i++) if (withDup[i] !== reopened[i]) dupDiff++;
  check("the copy plays (render is louder and different)", energy(withDup) > energy(reopened) * 1.02 && dupDiff > 1000, `${(energy(withDup) / energy(reopened)).toFixed(2)}x, ${dupDiff} bytes differ`);
  await page.click(".chip.fx"); // open layer 1's rack…
  await page.waitForTimeout(150);
  await page.click(".head:nth-child(2) .chip.fx"); // …then the copy's: Chipmunk must be lit there too
  await page.waitForTimeout(150);
  check("the copy carries the Voice Synth preset", (await page.textContent(".preset-name")).trim() === "Chipmunk");
  await page.click(".rack-title .chip"); // close the rack so Ctrl+D below has no rack target
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  check("Ctrl+Z removes the duplicate", (await page.$$(".head")).length === 3);

  // --- layer pan / width -------------------------------------------------------
  // Solo layer 1, pan it hard left through the real placer worklet and export:
  // the right channel must be (near) silent. Then Ctrl+Z brings it back.
  const setRange = (sel, v) =>
    page.$eval(sel, (el, value) => {
      el.value = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, v);
  await page.click(".head:nth-child(1) .chip.solo");
  await page.click(".chip.fx");
  await page.waitForTimeout(200);
  await page.click(".slot.place .pick");
  await page.waitForTimeout(100);
  await setRange(".rack .editor.place input.pan", -1);
  await page.waitForTimeout(300);
  const panReadout = (await page.textContent(".rack .editor.place .readout")).trim();
  check("layer pan readout", panReadout === "L 100", panReadout);
  const panned = await exportBytes();
  await page.waitForTimeout(300);
  await page.click(".dialog button");
  await page.waitForTimeout(200);
  const lr = (buf) => {
    const s16 = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) >> 1);
    let l = 0, r = 0;
    for (let i = 0; i < s16.length; i += 2) { l += s16[i] * s16[i]; r += s16[i + 1] * s16[i + 1]; }
    return [Math.sqrt(l), Math.sqrt(r)];
  };
  const [pl, pr] = lr(panned);
  check("hard-left layer renders with a silent right channel", pl > 1000 && pr < pl * 0.01, `L ${pl.toFixed(0)} R ${pr.toFixed(0)}`);
  await page.click(".rack-title .chip");
  await page.keyboard.press("Control+z"); // pan back to centre
  await page.waitForTimeout(150);
  await page.click(".head:nth-child(1) .chip.solo");
  await page.waitForTimeout(150);
  const centred = await exportBytes();
  await page.waitForTimeout(300);
  await page.click(".dialog button");
  await page.waitForTimeout(200);
  const [cl, cr] = lr(centred);
  check("undo restores a centred layer", Math.abs(cl - cr) < cl * 0.05, `L ${cl.toFixed(0)} R ${cr.toFixed(0)}`);

  // --- Voice Synth stack + surround export ----------------------------------
  // Choir = 6 unison voices + harmonies spread to the rear, LFE and centre
  // sends. Rendered at 5.1 and 7.1 the WAV must be WAVE_FORMAT_EXTENSIBLE
  // with the right channel count/mask, and the stack must actually reach
  // the centre, surround and LFE channels.
  await page.click(".chip.fx");
  await page.waitForTimeout(200);
  await page.click(".slot.synth .pick");
  await page.click("button.preset-browse");
  await page.click(".browser button:has-text('Choir')");
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
  const db71 = await exportSurround("7.1", 8, 0x63f);

  // --- MORPH: a second, different engine rack, spread round the ring ------
  await page.click(".slot.morph .pick");
  await page.waitForTimeout(100);
  check("MORPH shows all eight engines", (await page.$$(".engine")).length === 8);
  await page.click(".engine:has-text('GRAIN CLOUD')");
  await page.waitForTimeout(300);
  const morphSummary = (await page.textContent(".slot.morph .summary")).trim();
  check("picking an engine loads its first preset", morphSummary === "Grain Halo · 60%", morphSummary);
  check("the knobs are relabelled for the engine", (await page.textContent(".morph-knobs")).includes("DENSITY"));
  // Measure MORPH on its own: bypass the synth so only the morph field plays.
  await page.click(".slot.synth .power");
  await page.waitForTimeout(200);
  const morphBytes = await exportBytes();
  {
    const pcm = new Int16Array(morphBytes.buffer, morphBytes.byteOffset + 68, (morphBytes.length - 68) >> 1);
    const rms = new Array(8).fill(0);
    for (let i = 0; i < pcm.length; i++) rms[i % 8] += pcm[i] * pcm[i];
    const db = rms.map((s) => (s ? 20 * Math.log10(Math.sqrt(s / (pcm.length / 8)) / 32768) : -Infinity));
    // Grain Halo sprays grains round the whole ring. With the synth bypassed
    // nothing else could reach the back / side speakers (dry is L/R only).
    check(
      "MORPH grains reach the 7.1 back + side speakers on their own",
      [4, 5, 6, 7].every((c) => db[c] > -50) && db[3] === -Infinity,
      db.map((d) => d.toFixed(0)).join(" ") + ` (Choir-only back pair was ${db71[4].toFixed(0)} ${db71[5].toFixed(0)})`,
    );
  }
  await page.waitForTimeout(300);
  await page.click(".dialog button");
  await page.waitForTimeout(200);
  await page.click(".slot.morph .power");
  await page.click(".slot.synth .power"); // synth back on
  await page.click(".slot.synth .pick");
  await page.waitForTimeout(100);
  check("3D headphone toggle is offered", (await page.$("button:has-text('3D')")) !== null);
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

  // --- colour themes --------------------------------------------------------
  const theme0 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click("[data-role=theme]");
  await page.waitForTimeout(150);
  const theme1 = await page.evaluate(() => document.documentElement.dataset.theme);
  check("THEME cycles the colour mode", theme0 === "matrix" && theme1 !== theme0, `${theme0} → ${theme1}`);
  check("theme is remembered", (await page.evaluate(() => localStorage.getItem("ggmm.theme"))) === theme1);

  // --- many long layers: every waveform must draw, to the very end --------
  // One canvas the size of the whole song × every layer went blank past
  // WebKit's canvas limit (~10 layers of a few minutes). Twelve 150 s layers,
  // each silent for its first 20 s (dead space) then a tone to the end.
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(400);
  const dir = await mkdtemp(join(tmpdir(), "ggmm-long-"));
  const files = [];
  for (let f = 0; f < 12; f++) {
    const rate = 16000, secs = 150, n = rate * secs;
    const wav = Buffer.alloc(44 + n * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(n * 2, 40);
    for (let i = rate * 20; i < n; i++) wav.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * (110 + f * 20) * i) / rate)), 44 + i * 2);
    const path = join(dir, `long-${f + 1}.wav`);
    await writeFile(path, wav);
    files.push(path);
  }
  await page.setInputFiles("input[type=file][accept='audio/*']", files);
  await page.waitForFunction(() => document.querySelectorAll(".head").length === 12, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  /** Share of columns in `lane`'s waveform row that differ from the lane background. */
  const inked = (lane, xFrac) =>
    page.evaluate(
      ([lane, xFrac]) => {
        const c = document.querySelector(".lanes canvas");
        const top = parseFloat(c.style.top) || 0;
        const dpr = window.devicePixelRatio || 1;
        const w = c.width;
        const y = Math.round((lane * 96 + 60 - top) * dpr);
        if (y < 0 || y >= c.height) return -1;
        const x0 = Math.round(w * xFrac), x1 = Math.min(w, x0 + Math.round(200 * dpr));
        const d = c.getContext("2d").getImageData(x0, y, x1 - x0, 1).data;
        const bg = [d[0], d[1], d[2]];
        const g = c.getContext("2d").getImageData(Math.round(4 * dpr), Math.round((lane * 96 + 2 - top) * dpr), 1, 1).data;
        let hit = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - g[0]) + Math.abs(d[i + 1] - g[1]) + Math.abs(d[i + 2] - g[2]) > 40) hit++;
        void bg;
        return hit / (d.length / 4);
      },
      [lane, xFrac],
    );
  await page.$eval(".body", (el) => (el.scrollTop = el.scrollHeight));
  await page.$eval(".lanes-scroll", (el) => (el.scrollLeft = el.scrollWidth * 0.5));
  await page.waitForTimeout(300);
  const lastMid = await inked(11, 0.3);
  check("the 12th long layer draws its waveform (middle of the song)", lastMid > 0.5, `${(lastMid * 100).toFixed(0)}% inked`);
  // Scroll to where the audio ends (150 s of a 154 s timeline).
  await page.$eval(".lanes-scroll", (el) => (el.scrollLeft = el.scrollWidth - el.clientWidth));
  await page.waitForTimeout(300);
  const lastEnd = await page.evaluate(() => {
    const c = document.querySelector(".lanes canvas");
    return { w: c.width, left: parseFloat(c.style.left) };
  });
  check("the lanes canvas stays screen-sized however long the song", lastEnd.w <= 1280 * (await page.evaluate(() => devicePixelRatio)), `${lastEnd.w}px @ scroll ${lastEnd.left}`);
  const endInk = await inked(11, 0.2);
  check("the waveform reaches the end of the track", endInk > 0.5, `${(endInk * 100).toFixed(0)}% inked`);
  await page.$eval(".lanes-scroll", (el) => (el.scrollLeft = 0));
  await page.waitForTimeout(300);
  const dead = await inked(11, 0.2);
  check("dead space (the silent intro) is drawn empty", dead >= 0 && dead < 0.2, `${(dead * 100).toFixed(0)}% inked`);
  await page.click("button[aria-label='Zoom to fit']");
  await page.waitForTimeout(300);
  const fit = await page.$eval(".lanes-scroll", (el) => el.scrollWidth <= el.clientWidth + 2);
  check("FIT shows the whole song", fit);

  // --- PUNCH: bass + drums, shown in the lane ------------------------------
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(400);
  await page.setInputFiles("input[type=file][accept='audio/*']", [tone]);
  await page.waitForTimeout(600);
  for (let i = 0; i < 7; i++) await page.click("button[aria-label='Zoom in']"); // undo FIT's wide view
  await page.waitForTimeout(200);
  const quiet = await exportBytes();
  await page.waitForTimeout(300);
  await page.click(".dialog button");
  await page.click(".chip.fx");
  await page.waitForTimeout(200);
  await page.click(".slot.punch .pick");
  await page.click(".punch-presets button:has-text('Blown Out')");
  await page.waitForFunction(() => document.querySelector(".punch-meter .big"), null, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector(".punch-meter .tiny")?.textContent?.includes("…"), null, { timeout: 30000 });
  const meter = (await page.textContent(".punch-meter")).replace(/\s+/g, " ").trim();
  check("PUNCH readout shows the layer going over 0 dBFS with more bass", (await page.$(".punch-meter .big.hot")) !== null && /BASS \+\d/.test(meter), meter);
  const red = await page.evaluate(() => {
    const c = document.querySelector(".lanes canvas");
    const hex = getComputedStyle(document.documentElement).getPropertyValue("--danger").trim().replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const d = c.getContext("2d").getImageData(0, 0, c.width, Math.round(96 * devicePixelRatio)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 30) n++;
    return n;
  });
  check("the lane marks where PUNCH clips, in red", red > 100, `${red} red px`);
  await page.click(".punch-presets button:has-text('Off')");
  await page.click(".punch-presets button:has-text('Club Sub')");
  await page.waitForTimeout(300);
  const punched = await exportBytes();
  let pd = 0;
  for (let i = 44; i < Math.min(quiet.length, punched.length); i++) if (quiet[i] !== punched[i]) pd++;
  check("PUNCH changes the exported render", pd > 10000, `${pd} bytes differ`);
  await page.waitForTimeout(300);
  await page.click(".dialog button");

  // --- layer stacks + instrument racks ---------------------------------------
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(400);
  await page.setInputFiles("input[type=file][accept='audio/*']", [tone]);
  await page.waitForTimeout(600);
  const single = await exportBytes();
  await page.waitForTimeout(300);
  await page.click(".dialog button");
  await page.click(".chip.fx");
  await page.click("button.tab:has-text('RACKS')");
  await page.click(".cats button:has-text('VOCALS')");
  await page.click(".recipe:has-text('Wall of Vox')");
  await page.waitForTimeout(500);
  check("Wall of Vox builds a 5-layer stack", (await page.$$(".head")).length === 5 && (await page.$$(".member")).length === 5);
  check("stack layers are named for their racks", (await page.$$eval(".head .name", (els) => els.map((e) => e.value))).join("|") === "tone|Double L ◂ tone|Double R ◂ tone|Octave Down ◂ tone|Whisper Air ◂ tone");
  check("the start layer carries the first rack", (await page.textContent(".rack-item.on .rack-name"))?.trim() === "Lead Clean");
  const stacked = await exportBytes();
  await page.waitForTimeout(300);
  await page.click(".dialog button");
  let sd = 0;
  for (let i = 44; i < Math.min(single.length, stacked.length); i++) if (single[i] !== stacked[i]) sd++;
  check("the stack renders differently from the single layer", sd > 10000, `${sd} bytes differ`);
  // Delete the clip on layer 3: every linked layer loses it.
  const laneInk = () =>
    page.evaluate(() => {
      const c = document.querySelector(".lanes canvas");
      const ctx = c.getContext("2d");
      const dpr = devicePixelRatio;
      return [0, 1, 2, 3, 4].map((lane) => {
        const top = parseFloat(c.style.top) || 0;
        const d = ctx.getImageData(Math.round(20 * dpr), Math.round((lane * 96 + 48 - top) * dpr), Math.round(60 * dpr), 1).data;
        const bg = ctx.getImageData(Math.round(2 * dpr), Math.round((lane * 96 + 1 - top) * dpr), 1, 1).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40) n++;
        return n;
      });
    });
  await page.click("[aria-label='Close FX']").catch(() => page.click(".rack-title .chip"));
  await page.waitForTimeout(200);
  const before = await laneInk();
  const box = await page.$eval(".lanes", (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  await page.mouse.click(box.x + 40, box.y + 2 * 96 + 50);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  const after = await laneInk();
  const delStatus = (await page.textContent(".statusbar")).trim();
  check("every linked layer has audio before the delete", before.every((n) => n > 10), before.join(","));
  check("deleting the clip on one stack layer removes it from all five", after.every((n) => n === 0), `${after.join(",")} · ${delStatus} · focus ${await page.evaluate(() => document.activeElement?.tagName + "." + document.activeElement?.className)}`);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  check("undo brings it back on every layer", (await laneInk()).every((n) => n > 10));

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
