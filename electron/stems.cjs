// Stem separation host: runs native/ggmm-separate (HTDemucs, see
// native/stems) as its own process and hands the page its stems.
//
// Its own process on purpose: ONNX Runtime's allocations crash Electron's
// allocator, and a separator crash or out-of-memory must never take the
// user's session with it. It also runs at lower CPU priority so playback
// and the UI stay smooth while it works, and all its memory goes back to
// the system when it exits.
//
// Audio travels as planar f32 files in ~/.config/ggmusicmaker/stems-work
// (not /tmp: that's RAM on the Deck), deleted as soon as the page has them.
const { app, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const { spawn } = require("node:child_process");

const MODEL = "htdemucs_6s";

function firstExisting(candidates) {
  return candidates.find((p) => fs.existsSync(p)) || null;
}
// Packaged: asarUnpack keeps both on disk (a binary can't run from inside
// app.asar, and ONNX Runtime opens the model by path).
const unpacked = () => path.join(process.resourcesPath || "", "app.asar.unpacked");
const binary = () =>
  firstExisting([path.join(unpacked(), "native", "ggmm-separate"), path.join(__dirname, "..", "native", "ggmm-separate")]);
const modelDir = () =>
  path.dirname(
    firstExisting([path.join(unpacked(), "models", `${MODEL}.onnx`), path.join(__dirname, "..", "models", `${MODEL}.onnx`)]) || "/nonexistent/x",
  );
const workRoot = () => path.join(app.getPath("userData"), "stems-work");

let nextId = 1;
/** id → { child, dir, progress, done, error, stems: string[] } */
const jobs = new Map();

function readPlanar(file) {
  const buf = fs.readFileSync(file);
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = all.length / 2;
  // Copies: the page gets its own buffers, the file can go.
  return { left: all.slice(0, n), right: all.slice(n) };
}

async function start(left, right) {
  const bin = binary();
  if (!bin) throw new Error("stem separator not built (scripts/build-native.sh)");
  const id = nextId++;
  const dir = path.join(workRoot(), String(id));
  await fsp.mkdir(dir, { recursive: true });
  const input = Buffer.alloc((left.length + right.length) * 4);
  Buffer.from(left.buffer, left.byteOffset, left.byteLength).copy(input, 0);
  Buffer.from(right.buffer, right.byteOffset, right.byteLength).copy(input, left.byteLength);
  await fsp.writeFile(path.join(dir, "in.f32"), input);

  const child = spawn(bin, ["--model-dir", modelDir(), "--model", MODEL, "--in", path.join(dir, "in.f32"), "--out", path.join(dir, "out")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    os.setPriority(child.pid, 10);
  } catch {
    // not fatal
  }
  const job = { child, dir, progress: 0, done: false, error: null, stems: [] };
  jobs.set(id, job);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => {
    out += d;
    let nl;
    while ((nl = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, nl);
      out = out.slice(nl + 1);
      if (line.startsWith("progress ")) job.progress = Number(line.slice(9)) || job.progress;
      else if (line.startsWith("stem ")) job.stems.push(line.slice(5));
    }
  });
  child.stderr.on("data", (d) => (err += d));
  child.on("error", (e) => {
    job.error = String(e.message || e);
    job.done = true;
  });
  child.on("exit", (code, signal) => {
    job.done = true;
    if (code !== 0 && !job.error) {
      job.error = err.trim() || (signal ? `separator stopped (${signal})` : `separator failed (exit ${code})`);
    }
    if (!job.error) job.progress = 1;
  });
  child.stdin.on("error", () => {}); // it may exit before we close it
  return id;
}

async function free(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  if (!job.done) job.child.stdin.end(); // closing stdin = cancel
  setTimeout(() => {
    if (!job.done) job.child.kill("SIGKILL");
  }, 5000).unref();
  await fsp.rm(job.dir, { recursive: true, force: true });
}

function register() {
  // Leftovers from a run that crashed or was killed mid-separation.
  fs.rmSync(workRoot(), { recursive: true, force: true });
  app.on("will-quit", () => {
    for (const id of jobs.keys()) void free(id);
  });

  ipcMain.handle("separation-available", () => {
    if (!binary()) return { ok: false, error: "stem separator not built (scripts/build-native.sh)" };
    if (!fs.existsSync(path.join(modelDir(), `${MODEL}.onnx`))) return { ok: false, error: "stem separation model missing (scripts/fetch-model.sh)" };
    return { ok: true };
  });
  ipcMain.handle("separation-start", (_e, { left, right }) => start(left, right));
  ipcMain.handle("separation-status", (_e, { id }) => {
    const job = jobs.get(id);
    return job ? { progress: job.progress, done: job.done, error: job.error, stems: job.done && !job.error ? job.stems : [] } : null;
  });
  ipcMain.handle("separation-stem", (_e, { id, index }) => {
    const job = jobs.get(id);
    if (!job || !job.done || job.error) throw new Error("no finished separation");
    const name = job.stems[index];
    if (!name) throw new Error("no such stem");
    const file = path.join(job.dir, "out", `${name}.f32`);
    const { left, right } = readPlanar(file);
    fs.rmSync(file, { force: true });
    return { name, left, right };
  });
  ipcMain.handle("separation-free", (_e, { id }) => free(id));
}

module.exports = { register };
