// Keeps a PUNCH preview per (layer, audio buffer) so the timeline can draw
// what PUNCH does to the audio inside the clip. Jobs run in ~5 ms slices on
// the main thread (the DSP is the real public/punch-core.js, loaded as a
// same-origin module), newest request first; `previewTick` bumps whenever a
// preview finishes so the lanes redraw.

import { writable } from "svelte/store";
import type { Track } from "../audio/types";
import { punchIsActive, type PunchCoreCtor } from "../fx/punch";
import { PunchPreviewJob, type PunchPreview } from "../render/punchPreview";
import { engine } from "../state/store";

export const previewTick = writable(0);

let Core: PunchCoreCtor | null = null;
let loading: Promise<void> | null = null;
function loadCore(): void {
  if (Core || loading) return;
  loading = import(/* @vite-ignore */ `${import.meta.env.BASE_URL}punch-core.js`)
    .then((m: { PunchCore: PunchCoreCtor }) => {
      Core = m.PunchCore;
      previewTick.update((n) => n + 1);
    })
    .catch(() => {
      /* no preview; the audio path is unaffected */
    });
}

interface Entry {
  key: string;
  job: PunchPreviewJob | null;
  /** Last finished preview (possibly for an older key while a new one runs). */
  done: PunchPreview | null;
  doneKey: string;
}
const entries = new Map<string, Entry>();
const queue: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const SLICE = 120_000; // samples per slice (~4-6 ms)

function pump(): void {
  timer = null;
  const id = queue[0];
  const e = id ? entries.get(id) : undefined;
  if (!id || !e?.job) {
    queue.shift();
    if (queue.length) timer = setTimeout(pump, 0);
    return;
  }
  if (e.job.step(SLICE)) {
    e.done = e.job.result;
    e.doneKey = e.key;
    e.job = null;
    queue.shift();
    previewTick.update((n) => n + 1);
  }
  if (queue.length) timer = setTimeout(pump, 0);
}

/** The finished preview for this layer's buffer, scheduling one if the
 *  settings changed. Returns the last finished one meanwhile (or null). */
export function punchPreviewFor(track: Track, bufferId: string): { preview: PunchPreview; fresh: boolean } | null {
  if (!track.fx.punch || !punchIsActive(track.punch)) return null;
  loadCore();
  if (!Core) return null;
  const buffer = engine.getBuffer(bufferId);
  if (!buffer) return null;
  const id = `${track.id}|${bufferId}`;
  const key = `${JSON.stringify(track.punch)}|${track.gain}`;
  let e = entries.get(id);
  if (!e) {
    e = { key: "", job: null, done: null, doneKey: "" };
    entries.set(id, e);
  }
  if (e.key !== key) {
    e.key = key;
    const channels = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));
    e.job = new PunchPreviewJob(Core, buffer.sampleRate, channels, track.punch, track.gain);
    // Newest first: the layer being tweaked updates before stale others.
    const at = queue.indexOf(id);
    if (at >= 0) queue.splice(at, 1);
    queue.unshift(id);
    if (!timer) timer = setTimeout(pump, 30);
  }
  return e.done ? { preview: e.done, fresh: e.doneKey === key } : null;
}
