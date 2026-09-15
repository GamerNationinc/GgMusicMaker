import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_SYNTH } from "../fx/voice-synth";
import { packSession, unpackSession, referencedBufferIds, sessionDisplayName } from "./session";
import type { Project, Track } from "../audio/types";
import { nextId, reserveIds, __resetIds } from "../audio/types";
import type { PcmSource } from "../audio/wav";

function pcm(samples: number[][], sampleRate = 48000): PcmSource {
  const chans = samples.map((s) => new Float32Array(s));
  return {
    numberOfChannels: chans.length,
    sampleRate,
    length: chans[0].length,
    getChannelData: (c) => chans[c],
  };
}

const buffers = new Map<string, PcmSource>([
  ["buf_1", pcm([[0, 0.5, -0.5, 1], [0, -1, 1, 0]])],
  ["buf_2", pcm([[0.25, -0.25]], 44100)],
  ["buf_orphan", pcm([[1, 1, 1]])],
]);

const project: Project = {
  sampleRate: 48000,
  surround: "stereo",
  tracks: [
    {
      id: "track_1",
      name: "Vocal",
      gain: 0.8,
      muted: false,
      soloed: true,
      armed: true,
      reverbSend: 0.3,
      eq: { low: 2, mid: -1, high: 4 },
      synth: { ...DEFAULT_SYNTH, mix: 0.7, shift: 1, pitch: 7 },
      color: "#ff3ca0",
      clips: [
        { id: "clip_1", bufferId: "buf_1", startTime: 0, offset: 0, duration: 2, name: "a" },
        { id: "clip_2", bufferId: "buf_1", startTime: 3, offset: 1, duration: 1, name: "b" },
      ],
    },
    {
      id: "track_2",
      name: "Beat",
      gain: 1,
      muted: true,
      soloed: false,
      armed: false,
      reverbSend: 0,
      eq: { low: 0, mid: 0, high: 0 },
      synth: { ...DEFAULT_SYNTH },
      color: "#5af096",
      clips: [{ id: "clip_3", bufferId: "buf_2", startTime: 1, offset: 0, duration: 0.5, name: "c" }],
    },
  ],
};

const extras = { reverbSpace: "plate" as const, pixelsPerSecond: 120, playhead: 1.25 };

describe("session container", () => {
  it("only saves buffers that clips reference", () => {
    expect(referencedBufferIds(project).sort()).toEqual(["buf_1", "buf_2"]);
    const file = packSession(project, extras, (id) => buffers.get(id));
    const { header } = unpackSession(file);
    expect(header.audio.map((a) => a.id).sort()).toEqual(["buf_1", "buf_2"]);
  });

  it("round-trips the project, UI extras and audio", () => {
    const file = packSession(project, extras, (id) => buffers.get(id), new Date("2026-09-14T10:00:00Z"));
    const { header, audio } = unpackSession(file);

    expect(header.format).toBe("GGMM");
    expect(header.savedAt).toBe("2026-09-14T10:00:00.000Z");
    expect(header.reverbSpace).toBe("plate");
    expect(header.pixelsPerSecond).toBe(120);
    expect(header.playhead).toBe(1.25);
    expect(header.project.sampleRate).toBe(48000);
    expect(header.project.tracks.map((t) => t.name)).toEqual(["Vocal", "Beat"]);
    expect(header.project.tracks[0].clips).toEqual(project.tracks[0].clips);
    expect(header.project.tracks[0].synth).toEqual({ ...DEFAULT_SYNTH, mix: 0.7, shift: 1, pitch: 7 });
    expect(header.project.tracks[0].eq).toEqual({ low: 2, mid: -1, high: 4 });

    const a = audio.get("buf_1")!;
    expect(a.sampleRate).toBe(48000);
    expect(a.channels.length).toBe(2);
    expect(Array.from(a.channels[0])).toEqual([0, 0.5, -0.5, 1].map((x) => expect.closeTo(x, 4)));
    expect(Array.from(a.channels[1])).toEqual([0, -1, 1, 0].map((x) => expect.closeTo(x, 4)));
    const b = audio.get("buf_2")!;
    expect(b.sampleRate).toBe(44100);
    expect(b.channels.length).toBe(1);
    expect(Array.from(b.channels[0])).toEqual([0.25, -0.25].map((x) => expect.closeTo(x, 4)));
  });

  it("never restores an armed layer", () => {
    const { header } = unpackSession(packSession(project, extras, (id) => buffers.get(id)));
    expect(header.project.tracks.every((t) => !t.armed)).toBe(true);
    // …and does not mutate the caller's project to achieve that.
    expect(project.tracks[0].armed).toBe(true);
  });

  it("rejects files that are not sessions", () => {
    expect(() => unpackSession(new TextEncoder().encode("RIFF....WAVE").buffer)).toThrow(
      /not a GgMusicMaker session/,
    );
    expect(() => unpackSession(new ArrayBuffer(3))).toThrow(/not a GgMusicMaker session/);
  });

  it("rejects truncated files and newer formats", () => {
    const file = packSession(project, extras, (id) => buffers.get(id));
    expect(() => unpackSession(file.slice(0, file.byteLength - 10))).toThrow(/truncated/);
    const newer = file.slice(0);
    new DataView(newer).setUint32(4, 99, true);
    expect(() => unpackSession(newer)).toThrow(/newer GgMusicMaker/);
  });

  it("fails loudly when a referenced buffer is missing at save time", () => {
    expect(() => packSession(project, extras, () => undefined)).toThrow(/buf_1 is missing/);
  });

  it("derives a display name from the path", () => {
    expect(sessionDisplayName(null)).toBe("untitled");
    expect(sessionDisplayName("/home/deck/Music/my song.ggmm")).toBe("my song");
    expect(sessionDisplayName("C:\\Users\\deck\\jam.GGMM")).toBe("jam");
    expect(sessionDisplayName("plain")).toBe("plain");
  });
});

describe("reserveIds", () => {
  beforeEach(() => __resetIds());

  it("moves the id counter past loaded ids so new ones cannot collide", () => {
    reserveIds(["track_7", "clip_12", "buf_3", "weird"]);
    expect(nextId("track")).toBe("track_13");
  });

  it("never moves the counter backwards", () => {
    nextId("x");
    nextId("x");
    reserveIds(["x_1"]);
    expect(nextId("x")).toBe("x_3");
  });
});

describe("session migration", () => {
  it("opens a v1 file: voice presets become synth settings, surround defaults to stereo", () => {
    const v1 = {
      format: "GGMM",
      version: 1,
      app: "GgMusicMaker",
      savedAt: "2026-09-13T00:00:00.000Z",
      reverbSpace: "hall",
      pixelsPerSecond: 80,
      playhead: 0,
      project: {
        sampleRate: 48000,
        tracks: [{ ...project.tracks[1], synth: undefined, voice: { preset: "chipmunk", mix: 0.5 }, clips: [] }],
      },
      audio: [],
    };
    const json = new TextEncoder().encode(JSON.stringify(v1));
    const bytes = new Uint8Array(12 + json.length);
    const view = new DataView(bytes.buffer);
    bytes.set([0x47, 0x47, 0x4d, 0x4d], 0); // "GGMM"
    view.setUint32(4, 1, true);
    view.setUint32(8, json.length, true);
    bytes.set(json, 12);

    const { header } = unpackSession(bytes.buffer);
    const t = header.project.tracks[0] as Track & { voice?: unknown };
    expect(t.voice).toBeUndefined();
    expect(t.synth).toMatchObject({ mix: 0.5, shift: 1, pitch: 7 });
    expect(header.project.surround).toBe("stereo");
  });
});
