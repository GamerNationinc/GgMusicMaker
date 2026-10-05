import { describe, it, expect } from "vitest";
import { syncStacks, ensureLinkIds, makeStackLayer } from "./stacks";
import type { Clip, Project, Track } from "./types";
import { splitClip, moveClip } from "./edits";
import { DEFAULT_TEMPO } from "./tempo";

const clip = (id: string, start = 0): Clip => ({ id, bufferId: "b", startTime: start, offset: 0, duration: 4, name: "x" });
const tr = (id: string, clips: Clip[], stackId: string | null = "s", linked = true): Track =>
  ({ id, name: id, clips, stackId, linked } as unknown as Track);
const proj = (tracks: Track[]): Project => ({ tracks, sampleRate: 48000, surround: "stereo", tempo: { ...DEFAULT_TEMPO } });

describe("layer stacks", () => {
  const src = tr("a", ensureLinkIds([clip("c1"), clip("c2", 5)]));
  const layer = makeStackLayer(src, "s", tr("b", []), "b");
  const other = tr("c", [clip("z", 1)], null, false);
  const p0 = proj([src, layer, other]);

  it("a new layer carries the same clips with its own ids", () => {
    expect(layer.clips.map((c) => c.startTime)).toEqual([0, 5]);
    expect(layer.clips.map((c) => c.linkId)).toEqual(src.clips.map((c) => c.linkId));
    expect(layer.clips.some((c) => src.clips.some((s) => s.id === c.id))).toBe(false);
  });

  it("moving a clip on one layer moves it on the other, keeping ids", () => {
    const moved = { ...p0, tracks: p0.tracks.map((t) => (t.id === "b" ? { ...t, clips: [moveClip(t.clips[0], 2), t.clips[1]] } : t)) };
    const out = syncStacks(p0, moved);
    expect(out.tracks[0].clips[0].startTime).toBe(2);
    expect(out.tracks[0].clips[0].id).toBe("c1");
    expect(out.tracks[2]).toBe(other); // outside the stack: untouched
  });

  it("a split mirrors with fresh link ids for the new half", () => {
    const split = { ...p0, tracks: p0.tracks.map((t) => (t.id === "a" ? { ...t, clips: [...splitClip(t.clips[0], 1), t.clips[1]] } : t)) };
    const out = syncStacks(p0, split);
    const [a, b] = out.tracks;
    expect(a.clips).toHaveLength(3);
    expect(b.clips).toHaveLength(3);
    expect(new Set(a.clips.map((c) => c.linkId)).size).toBe(3);
    expect(b.clips.map((c) => [c.startTime, c.duration, c.linkId])).toEqual(a.clips.map((c) => [c.startTime, c.duration, c.linkId]));
    expect(b.clips[0].id).toBe(layer.clips[0].id);
  });

  it("deleting on one layer deletes on all", () => {
    const del = { ...p0, tracks: p0.tracks.map((t) => (t.id === "a" ? { ...t, clips: t.clips.slice(1) } : t)) };
    expect(syncStacks(p0, del).tracks[1].clips).toHaveLength(1);
  });

  it("a delete that rebuilds every track's list still wins over untouched layers", () => {
    // store.deleteSelectedClip filters every track, so every list is a new array.
    const gone = layer.clips[1].id;
    const del = { ...p0, tracks: p0.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== gone) })) };
    const out = syncStacks(p0, del);
    expect(out.tracks[0].clips).toHaveLength(1);
    expect(out.tracks[1].clips).toHaveLength(1);
  });

  it("an unlinked member keeps its own clips", () => {
    const p1 = proj([src, { ...layer, linked: false }]);
    const del = { ...p1, tracks: p1.tracks.map((t) => (t.id === "a" ? { ...t, clips: [] } : t)) };
    expect(syncStacks(p1, del).tracks[1].clips).toHaveLength(2);
  });

  it("is a no-op when no clips changed", () => {
    const same = { ...p0, tracks: p0.tracks.map((t) => ({ ...t, gain: 0.5 })) };
    expect(syncStacks(p0, same)).toBe(same);
  });
});
