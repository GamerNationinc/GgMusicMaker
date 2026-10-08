// What DJ mode can put on a deck (until the real library milestone): every
// song already in the project, plus files loaded straight onto a deck.
// Each is listened to once for its tempo and first beat (beatDetect.ts);
// the decks' waveforms come from the same buffers.

import { derived, get, writable } from "svelte/store";
import { engine, project, status } from "./store";
import { withLoading } from "./loading";
import { detectTempo, MIN_CONFIDENCE } from "../audio/beatDetect";
import { computePeaks, type Peaks } from "../render/peaks";
import { djLoadTrack } from "../input/controller";
import type { DjTrack } from "../input/dj";

export interface LibraryEntry {
  bufferId: string;
  name: string;
  duration: number;
}

/** Files loaded straight onto a deck (not in the project). */
const loose = writable<LibraryEntry[]>([]);

/** Everything a deck can load: the project's songs, then loose files. */
export const djLibrary = derived([project, loose], ([$p, $loose]) => {
  const seen = new Set<string>();
  const out: LibraryEntry[] = [];
  for (const t of $p.tracks)
    for (const c of t.clips) {
      if (seen.has(c.bufferId)) continue;
      const b = engine.getBuffer(c.bufferId);
      if (!b || b.duration < 1) continue;
      seen.add(c.bufferId);
      out.push({ bufferId: c.bufferId, name: c.name || t.name, duration: b.duration });
    }
  for (const e of $loose) if (!seen.has(e.bufferId)) out.push(e);
  return out;
});

const tempos = new Map<string, Promise<{ bpm: number | null; firstBeat: number }>>();

/** The track's tempo and first beat, listened for once per buffer. */
function tempoOf(bufferId: string): Promise<{ bpm: number | null; firstBeat: number }> {
  let p = tempos.get(bufferId);
  if (!p) {
    const b = engine.getBuffer(bufferId);
    p = b
      ? detectTempo(b).then((g) => {
          const start = audioStart(b);
          if (!g || g.confidence < MIN_CONFIDENCE) return { bpm: null, firstBeat: start };
          // The grid's first beat may sit in the silence before the music:
          // the first beat you can hear is where a deck cues up.
          const beat = 60 / g.bpm;
          const skip = Math.max(0, Math.ceil((start - 0.05 - g.firstBeat) / beat));
          return { bpm: g.bpm, firstBeat: g.firstBeat + skip * beat };
        })
      : Promise.resolve({ bpm: null, firstBeat: 0 });
    tempos.set(bufferId, p);
  }
  return p;
}

/** Where the music starts: the first sample above −40 dBFS (s). */
function audioStart(b: AudioBuffer): number {
  const chans = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
  for (let i = 0; i < b.length; i++) for (const c of chans) if (Math.abs(c[i]) > 0.01) return i / b.sampleRate;
  return 0;
}

/** Put a library entry on a deck (after finding its beat). */
export async function loadDeck(deck: number, entry: LibraryEntry): Promise<void> {
  const t = await withLoading("FINDING THE BEAT", () => tempoOf(entry.bufferId), entry.name);
  const track: DjTrack = { ...entry, ...t };
  djLoadTrack(deck, track);
  const side = deck === 0 ? "A" : "B";
  status.set(t.bpm ? `Deck ${side}: ${entry.name} — ${t.bpm} BPM.` : `Deck ${side}: ${entry.name} — no clear beat (SYNC and quantize off for it).`);
}

/** Decode a file and put it on a deck; it joins the list for later. */
export async function loadFileToDeck(deck: number, file: File): Promise<void> {
  try {
    const { bufferId, buffer } = await withLoading("LOADING TRACK", async () => engine.decodeBytes(await file.arrayBuffer()), file.name);
    const entry = { bufferId, name: file.name.replace(/\.[^.]+$/, ""), duration: buffer.duration };
    loose.update((l) => [...l, entry]);
    await loadDeck(deck, entry);
  } catch (err) {
    status.set(`Couldn't load ${file.name}: ${(err as Error).message}`);
  }
}

/** Waveform peaks for a deck: 100 min/max pairs a second. */
export const PEAKS_PER_SEC = 100;
const peakCache = new Map<string, Peaks>();
export function deckPeaks(bufferId: string): Peaks | null {
  let p = peakCache.get(bufferId);
  if (!p) {
    const b = engine.getBuffer(bufferId);
    if (!b) return null;
    p = computePeaks(b, Math.max(1, Math.ceil(b.duration * PEAKS_PER_SEC)));
    peakCache.set(bufferId, p);
  }
  return p;
}

/** Test hook: what's on the list. */
export const libraryNow = () => get(djLibrary);
