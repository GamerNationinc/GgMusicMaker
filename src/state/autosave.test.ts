import { describe, it, expect } from "vitest";
import { Autosaver, recoverAutosave, type AutosaveBridge, type AutosaveMeta, type LoadedAutosave } from "./autosave";
import { type SessionExtras, type SessionHeaderBase } from "./session";
import type { Project, Track } from "../audio/types";
import type { PcmSource } from "../audio/wav";
import { DEFAULT_TEMPO } from "../audio/tempo";

function pcm(samples: number[]): PcmSource {
  const data = new Float32Array(samples);
  return { numberOfChannels: 1, sampleRate: 48000, length: data.length, getChannelData: () => data };
}

const buffers = new Map<string, PcmSource>([
  ["buf_1", pcm([0, 0.5, -0.5, 1])],
  ["buf_2", pcm([0.25, -0.25])],
]);

function track(id: string, bufferIds: string[]): Track {
  return {
    id,
    name: id,
    gain: 1,
    muted: false,
    soloed: false,
    armed: false,
    reverbSend: 0,
    clips: bufferIds.map((b, i) => ({ id: `${id}_c${i}`, bufferId: b, start: i, offset: 0, duration: 1 })),
  } as unknown as Track;
}

const project = (bufs: string[]): Project => ({ sampleRate: 48000, surround: "stereo", tempo: { ...DEFAULT_TEMPO }, tracks: [track("track_1", bufs)] });
const extras: SessionExtras = { reverbSpace: "room", pixelsPerSecond: 80, playhead: 0 };

/** In-memory stand-in for electron/autosave.cjs. */
class FakeStore implements AutosaveBridge {
  wavs = new Map<string, Uint8Array>();
  saved: { header: SessionHeaderBase; keys: Record<string, string>; meta: AutosaveMeta } | null = null;
  puts = 0;
  commits = 0;
  async audioKeys() {
    return [...this.wavs.keys()];
  }
  async putAudio(key: string, parts: Iterable<ArrayBuffer>) {
    this.puts++;
    const list = [...parts];
    const bytes = new Uint8Array(list.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of list) (bytes.set(new Uint8Array(p), at), (at += p.byteLength));
    this.wavs.set(key, bytes);
  }
  async commit(header: SessionHeaderBase, keys: Record<string, string>, meta: AutosaveMeta) {
    this.commits++;
    const wanted = new Set(Object.values(keys));
    for (const k of this.wavs.keys()) if (!wanted.has(k)) this.wavs.delete(k);
    this.saved = { header, keys, meta };
  }
  async load(): Promise<LoadedAutosave | null> {
    if (!this.saved) return null;
    return { meta: this.saved.meta, header: this.saved.header, audioKeys: this.saved.keys };
  }
  reads = 0;
  async readAudio(key: string) {
    this.reads++;
    const b = this.wavs.get(key);
    if (!b) throw new Error(`no ${key}`);
    return b;
  }
  async clear() {
    this.wavs.clear();
    this.saved = null;
  }
}

describe("Autosaver", () => {
  it("round-trips into a session that opens with the same project and audio", async () => {
    const store = new FakeStore();
    const a = new Autosaver(store, (id) => buffers.get(id));
    expect(await a.save(project(["buf_1", "buf_2"]), extras, "/music/song.ggmm")).toBe(true);
    const loaded = (await store.load())!;
    expect(loaded.meta.path).toBe("/music/song.ggmm");
    const { header, audio } = await recoverAutosave(loaded, store);
    expect(header.project.tracks[0].clips.map((c) => c.bufferId)).toEqual(["buf_1", "buf_2"]);
    expect([...audio.get("buf_1")!.channels[0]]).toEqual([0, 0.5, -0.5, 1]);
    expect([...audio.get("buf_2")!.channels[0]]).toEqual([0.25, -0.25]);
  });

  it("sends each buffer's audio once, then only the project", async () => {
    const store = new FakeStore();
    const a = new Autosaver(store, (id) => buffers.get(id));
    await a.save(project(["buf_1"]), extras, null);
    await a.save(project(["buf_1", "buf_2"]), extras, null);
    const p = project(["buf_1", "buf_2"]);
    p.tracks[0].gain = 0.5;
    await a.save(p, extras, null);
    expect(store.puts).toBe(2);
    expect(store.commits).toBe(3);
  });

  it("skips an autosave when only the playhead moved", async () => {
    const store = new FakeStore();
    const a = new Autosaver(store, (id) => buffers.get(id));
    const p = project(["buf_1"]);
    expect(await a.save(p, extras, null)).toBe(true);
    expect(await a.save(p, { ...extras, playhead: 12 }, null)).toBe(false);
    expect(store.commits).toBe(1);
  });

  it("drops audio the project no longer uses", async () => {
    const store = new FakeStore();
    const a = new Autosaver(store, (id) => buffers.get(id));
    await a.save(project(["buf_1", "buf_2"]), extras, null);
    await a.save(project(["buf_2"]), extras, null);
    expect(store.wavs.size).toBe(1);
    // …and re-sends it if it comes back (undo).
    await a.save(project(["buf_1", "buf_2"]), extras, null);
    expect(store.wavs.size).toBe(2);
    expect((await recoverAutosave((await store.load())!, store)).audio.size).toBe(2);
  });

  it("a clear wins over a save that was already in flight", async () => {
    const store = new FakeStore();
    const a = new Autosaver(store, (id) => buffers.get(id));
    const saving = a.save(project(["buf_1"]), extras, null);
    const clearing = a.clear();
    await Promise.all([saving, clearing]);
    expect(await store.load()).toBeNull();
    // After a clear, the next save writes everything again.
    await a.save(project(["buf_1"]), extras, null);
    expect(store.wavs.size).toBe(1);
  });

  it("two autosavers (two launches) never share audio keys", async () => {
    const store = new FakeStore();
    await new Autosaver(store, (id) => buffers.get(id)).save(project(["buf_1"]), extras, null);
    const first = [...store.wavs.keys()][0];
    // The next launch's buf_1 is different audio under the same id.
    const other = new Map([["buf_1", pcm([1, 1])]]);
    await new Autosaver(store, (id) => other.get(id)).save(project(["buf_1"]), extras, null);
    expect([...store.wavs.keys()][0]).not.toBe(first);
    const { audio } = await recoverAutosave((await store.load())!, store);
    expect([...audio.get("buf_1")!.channels[0]]).toEqual([1, 1]);
  });

  it("a recovered autosave with missing audio fails loudly", async () => {
    const broken: LoadedAutosave = {
      meta: { path: null, savedAt: "" },
      header: {} as SessionHeaderBase,
      audioKeys: {},
      error: "audio buf_1 is missing",
    };
    await expect(recoverAutosave(broken, new FakeStore())).rejects.toThrow(/buf_1 is missing/);
  });

  it("recovery reads the audio one WAV at a time and reports progress", async () => {
    const store = new FakeStore();
    await new Autosaver(store, (id) => buffers.get(id)).save(project(["buf_1", "buf_2"]), extras, null);
    const seen: string[] = [];
    await recoverAutosave((await store.load())!, store, (d, t) => seen.push(`${d}/${t}`));
    expect(store.reads).toBe(2);
    expect(seen).toEqual(["0/2", "1/2", "2/2"]);
  });
});
