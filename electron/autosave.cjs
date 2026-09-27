// Autosave store: the page's unsaved work, kept on disk so a crash (of the
// page, the audio engine, this process or the whole Deck) costs a minute at
// most. Lives in ~/.config/ggmusicmaker/autosave/:
//
//   session.json      { meta: { path, savedAt }, header }  — the project
//   audio/<key>.wav   one float WAV per audio buffer        — written once
//
// Audio never changes once recorded or imported, so each buffer is sent
// once; after that an autosave is only the (small) project JSON. Keys carry
// a per-run prefix from the page, because buffer ids restart every launch.
// The folder exists only while there is unsaved work: the page clears it
// after a real save, a new/opened session, or an explicit "discard".
const { app, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");

const KEY = /^[A-Za-z0-9_.-]{1,128}$/;

function dir() {
  return path.join(app.getPath("userData"), "autosave");
}
const audioDir = () => path.join(dir(), "audio");
const sessionFile = () => path.join(dir(), "session.json");

/** Write via a temp file + rename, so a crash mid-write never leaves a
 *  half-written file where a good one was. */
async function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function audioKeys() {
  try {
    return (await fs.readdir(audioDir())).filter((f) => f.endsWith(".wav")).map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
}

function checkKey(key) {
  if (!KEY.test(key)) throw new Error(`bad autosave key ${key}`);
  return key;
}

/** The saved autosave, or null. Audio comes back keyed as the header names it. */
async function load() {
  let saved;
  try {
    saved = JSON.parse(await fs.readFile(sessionFile(), "utf8"));
  } catch {
    return null;
  }
  const audio = {};
  for (const [bufferId, key] of Object.entries(saved.audioKeys ?? {})) {
    try {
      const data = await fs.readFile(path.join(audioDir(), `${checkKey(key)}.wav`));
      audio[bufferId] = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch {
      return { meta: saved.meta, header: saved.header, audio: null, error: `audio ${bufferId} is missing` };
    }
  }
  return { meta: saved.meta, header: saved.header, audio };
}

async function clear() {
  await fs.rm(dir(), { recursive: true, force: true });
}

/** When the last autosave was written, or null (for the crash dialog). */
async function lastSavedAt() {
  try {
    return JSON.parse(await fs.readFile(sessionFile(), "utf8")).meta?.savedAt ?? null;
  } catch {
    return null;
  }
}

function register() {
  ipcMain.handle("autosave-audio-keys", () => audioKeys());
  ipcMain.handle("autosave-put-audio", async (_e, { key, bytes }) => {
    await fs.mkdir(audioDir(), { recursive: true });
    await writeAtomic(path.join(audioDir(), `${checkKey(key)}.wav`), Buffer.from(bytes));
  });
  // `audioKeys` maps each buffer id in `header` to its stored WAV; WAVs no
  // longer referenced are deleted.
  ipcMain.handle("autosave-commit", async (_e, { header, audioKeys: keys, meta }) => {
    const wanted = new Set(Object.values(keys).map(checkKey));
    await fs.mkdir(audioDir(), { recursive: true });
    await writeAtomic(sessionFile(), JSON.stringify({ meta, header, audioKeys: keys }));
    for (const k of await audioKeys()) {
      if (!wanted.has(k)) await fs.rm(path.join(audioDir(), `${k}.wav`), { force: true });
    }
  });
  ipcMain.handle("autosave-load", () => load());
  ipcMain.handle("autosave-clear", () => clear());
}

module.exports = { register, lastSavedAt, writeAtomic };
