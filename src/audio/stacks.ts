// Layer stacks — one piece of audio, many layers, each with its own FX.
//
// A stack is the tracks that share a `stackId`. Linked members (`linked`)
// share their clips: cut, split, move, trim or delete on any one of them and
// every other linked member follows, so the layers stay sample-aligned while
// each runs a different FX chain (parallel processing, the way you'd stack
// a vocal or a drum bus in a big DAW). Unlinking a member frees its clips.
//
// Clips are matched across members by `linkId`. syncStacks runs after every
// project edit (store.updateProject): it finds the linked member whose clips
// changed and mirrors them onto the others, keeping each member's own clip
// ids where the linkIds match (so selection and dragging keep working).

import type { Clip, Project, Track } from "./types";
import { nextId } from "./types";

/** Give every clip a linkId, and a fresh one to any clip that shares its
 *  linkId with an earlier clip on the same track (both halves of a split
 *  start out with the same one). */
export function ensureLinkIds(clips: Clip[]): Clip[] {
  const seen = new Set<string>();
  let changed = false;
  const out = clips.map((c) => {
    let linkId = c.linkId ?? c.id;
    if (seen.has(linkId)) linkId = nextId("link");
    seen.add(linkId);
    if (linkId === c.linkId) return c;
    changed = true;
    return { ...c, linkId };
  });
  return changed ? out : clips;
}

/** `member`'s copy of `src` clips: same timing, the member's own ids. */
export function mirrorClips(src: Clip[], member: Clip[]): Clip[] {
  const byLink = new Map(member.map((c) => [c.linkId ?? c.id, c]));
  return src.map((c) => {
    const mine = byLink.get(c.linkId!);
    return { ...c, id: mine?.id ?? nextId("clip") };
  });
}

function sameClips(a: Clip[], b: Clip[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (x.id !== y.id || x.startTime !== y.startTime || x.offset !== y.offset || x.duration !== y.duration || x.bufferId !== y.bufferId) return false;
  }
  return true;
}

export function isLinked(t: Track): boolean {
  return !!t.stackId && t.linked;
}

/** Members of `stackId`, in track order. */
export function stackMembers(p: Project, stackId: string | null | undefined): Track[] {
  return stackId ? p.tracks.filter((t) => t.stackId === stackId) : [];
}

/** Propagate clip edits across linked stack members (see file comment). */
export function syncStacks(prev: Project, next: Project): Project {
  const before = new Map(prev.tracks.map((t) => [t.id, t]));
  const stacks = new Map<string, Track[]>();
  for (const t of next.tracks) if (isLinked(t)) stacks.set(t.stackId!, [...(stacks.get(t.stackId!) ?? []), t]);

  const replace = new Map<string, Track>();
  for (const members of stacks.values()) {
    if (members.length < 2) continue;
    // A member that existed before and whose clips really changed drove the
    // edit. Compare contents, not the array: edits like delete rebuild every
    // track's list, and an untouched layer must not win and undo the edit.
    const src = members.find((m) => {
      const old = before.get(m.id);
      return old && !sameClips(old.clips, m.clips);
    });
    if (!src) continue;
    const clips = ensureLinkIds(src.clips);
    if (clips !== src.clips) replace.set(src.id, { ...src, clips });
    for (const m of members) {
      if (m.id === src.id) continue;
      replace.set(m.id, { ...m, clips: mirrorClips(clips, ensureLinkIds(m.clips)) });
    }
  }
  if (!replace.size) return next;
  return { ...next, tracks: next.tracks.map((t) => replace.get(t.id) ?? t) };
}

/** A new linked member of `src`'s stack (creating the stack if needed):
 *  same clips (shared audio), fresh ids, neutral mix — the caller applies a rack. */
export function makeStackLayer(src: Track, stackId: string, base: Track, name: string): Track {
  const clips = ensureLinkIds(src.clips);
  return {
    ...base,
    name,
    stackId,
    linked: true,
    color: src.color,
    clips: mirrorClips(clips, []),
  };
}
