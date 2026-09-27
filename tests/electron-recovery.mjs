// Crash recovery in the real desktop app: autosave, crash log, recovery after
// the page crashes, a hung page no longer blocks closing the window, and the
// autosave survives the whole app being killed.
//
//   npm run build && npm run test:recovery
//   GGMM_APP=release/linux-unpacked/ggmusicmaker npm run test:recovery   (packaged app)
import { rm, writeFile, readFile, mkdtemp, readdir, stat } from "node:fs/promises";
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
const exists = (p) => stat(p).then(() => true, () => false);
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const userData = await mkdtemp(join(tmpdir(), "ggmm-rec-data-"));
const saveDir = await mkdtemp(join(tmpdir(), "ggmm-rec-out-"));
const wavPath = join(await mkdtemp(join(tmpdir(), "ggmm-rec-in-")), "take.wav");
{
  const rate = 44100, n = rate * 3;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(i * 0.03)), 44 + i * 2);
  await writeFile(wavPath, wav);
}

const sessionJson = join(userData, "autosave", "session.json");
const crashLog = join(userData, "logs", "crash.log");
const logKinds = async () => ((await exists(crashLog)) ? (await readFile(crashLog, "utf8")).trim().split("\n").map((l) => JSON.parse(l).kind) : []);

const packaged = process.env.GGMM_APP;
let proc;
async function launch() {
  const a = await electron.launch({
    ...(packaged ? { executablePath: resolve(packaged), args: ["--ozone-platform=x11"] } : { args: [ROOT, "--ozone-platform=x11"] }),
    env: {
      ...process.env,
      GGMM_USER_DATA: userData,
      GGMM_TEST_SAVE_DIR: saveDir,
      GGMM_HIDDEN: "1",
      GGMM_AUTOSAVE_MS: "1000",
      // Every dialog takes its first button: Yes / Reopen / Quit.
      GGMM_TEST_DIALOG: "0",
    },
  });
  proc = a.process();
  return a;
}
// Through the main process: Playwright's page handle doesn't survive a crash.
const inPage = (js) => app.evaluate(({ BrowserWindow }, js) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(js), js);
const layers = () => inPage(`document.querySelectorAll(".head").length`);
const isDirty = () => inPage(`!!document.querySelector(".session .dirty")`);

// 1. Unsaved work is autosaved.
let app = await launch();
let page = await app.firstWindow();
await page.waitForSelector(".title");
await page.setInputFiles("input[type=file][accept='audio/*']", [wavPath]);
await page.waitForFunction(() => document.querySelectorAll(".head").length === 1);
check("autosaves unsaved work within a couple of seconds", await waitFor(() => exists(sessionJson), 10000));
const wavs = await readdir(join(userData, "autosave", "audio")).catch(() => []);
check("… with its audio", wavs.length === 1, wavs.join(", "));

// 2. The page crashes: logged, reopened, and the work comes back.
await app.evaluate(({ BrowserWindow }) => process.kill(BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(), "SIGKILL"));
check("the crash is written to the crash log", await waitFor(async () => (await logKinds()).includes("page-gone")), (await logKinds()).join(", "));
const recovered = `document.querySelectorAll(".head").length === 1 && !!document.querySelector(".session .dirty")`;
const back = await waitFor(() => inPage(recovered).catch(() => false));
check("the window reopens and recovers the layer", back);
check("recovered work is marked unsaved", back && (await isDirty()));
const rewritten = JSON.parse(await readFile(sessionJson, "utf8"));
check("recovered work is autosaved again straight away", Object.keys(rewritten.audioKeys).length === 1);

// 3. A hung page: closing the window still works (this used to freeze forever).
void inPage(`setTimeout(() => { for (;;); }), 1`).catch(() => {});
await new Promise((r) => setTimeout(r, 300));
const closed = new Promise((r) => proc.once("exit", () => r(true)));
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
check("a hung window can still be closed", await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 15000))]));
check("… and the hang is logged", (await logKinds()).includes("close-unanswered"));
check("the autosave outlives the app", await exists(sessionJson));

// 4. Next launch offers it back; a real save clears it.
app = await launch();
page = await app.firstWindow();
await page.waitForSelector(".title");
check("next launch recovers the work", await waitFor(() => inPage(recovered), 20000));
await page.keyboard.press("Control+s");
check("saving writes the session", await waitFor(async () => (await readdir(saveDir)).some((f) => f.endsWith(".ggmm"))));
check("… and clears the autosave", await waitFor(async () => !(await exists(sessionJson))));
check("… and the title is clean", !(await isDirty()));

// 5. Page errors land in the crash log too.
await page.evaluate(() => setTimeout(() => { throw new Error("boom from the recovery test"); }));
check("uncaught page errors are logged", await waitFor(async () => (await logKinds()).includes("page-error")));

await app.evaluate(({ app }) => app.exit(0));
// /tmp is RAM on the Deck: never leave hundreds of MB of test audio behind.
for (const d of [userData, saveDir, dirname(wavPath)]) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
console.log(`\n${passed}/${passed + failed} recovery checks passed`);
process.exit(failed ? 1 : 0);
