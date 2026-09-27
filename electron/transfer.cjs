// Big data between the page and this process, in chunks.
//
// Chromium kills the app outright (a CHECK, SIGTRAP) when one IPC message
// is too big — a few hundred MB. A 27-layer session is over 1 GB, so every
// path that can carry a whole project (save, open, export, autosave,
// recovery, stems, long takes) goes through here instead:
//
//   page → main   "uploads":   begin → chunk × n (≤ CHUNK each) → the
//                 consumer takes the finished file (staged on disk, so a
//                 save becomes a rename and memory isn't doubled here).
//   main → page   "downloads": offer a file or in-memory buffer → the page
//                 reads it chunk by chunk → done.
//
// Staging lives in ~/.config/ggmusicmaker/transfer (not /tmp: that's RAM on
// the Deck) and is wiped at startup.
const { app, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

let nextId = 1;
/** upload id → { file, fd, bytes } */
const uploads = new Map();
/** download token → { file?, buffer?, size, deleteAfter } */
const downloads = new Map();

const root = () => path.join(app.getPath("userData"), "transfer");

/** Hand a finished upload to its consumer: returns { file, bytes }. The
 *  caller now owns the file (move it, read it, or delete it). */
function takeUpload(id) {
  const u = uploads.get(id);
  if (!u) throw new Error(`no such upload ${id}`);
  uploads.delete(id);
  fs.closeSync(u.fd);
  return { file: u.file, bytes: u.bytes };
}

/** Read a finished upload fully into memory and delete its file. */
function readUpload(id) {
  const { file } = takeUpload(id);
  try {
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Offer a file for the page to read in chunks. */
function offerFile(file, { deleteAfter = false } = {}) {
  const token = nextId++;
  downloads.set(token, { file, size: fs.statSync(file).size, deleteAfter });
  return { token, size: downloads.get(token).size };
}

/** Offer in-memory bytes (Buffer or typed array) for the page to read in chunks. */
function offerBuffer(data) {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const token = nextId++;
  downloads.set(token, { buffer, size: buffer.byteLength });
  return { token, size: buffer.byteLength };
}

function register() {
  fs.rmSync(root(), { recursive: true, force: true });
  fs.mkdirSync(root(), { recursive: true });

  ipcMain.handle("upload-begin", () => {
    const id = nextId++;
    const file = path.join(root(), `up-${id}.bin`);
    uploads.set(id, { file, fd: fs.openSync(file, "w"), bytes: 0 });
    return id;
  });
  ipcMain.handle("upload-chunk", (_e, { id, bytes }) => {
    const u = uploads.get(id);
    if (!u) throw new Error(`no such upload ${id}`);
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 0;
    while (off < b.length) off += fs.writeSync(u.fd, b, off);
    u.bytes += b.length;
  });
  ipcMain.handle("upload-abort", (_e, { id }) => {
    try {
      const { file } = takeUpload(id);
      fs.rmSync(file, { force: true });
    } catch {
      // already taken
    }
  });
  ipcMain.handle("download-chunk", (_e, { token, offset, length }) => {
    const d = downloads.get(token);
    if (!d) throw new Error(`no such download ${token}`);
    const len = Math.max(0, Math.min(length, d.size - offset));
    if (d.buffer) return new Uint8Array(d.buffer.buffer, d.buffer.byteOffset + offset, len).slice();
    const out = Buffer.alloc(len);
    const fd = fs.openSync(d.file, "r");
    try {
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, out, got, len - got, offset + got);
        if (n === 0) break;
        got += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  });
  ipcMain.handle("download-done", (_e, { token }) => {
    const d = downloads.get(token);
    downloads.delete(token);
    if (d?.file && d.deleteAfter) fs.rmSync(d.file, { force: true });
  });
}

module.exports = { register, takeUpload, readUpload, offerFile, offerBuffer };
