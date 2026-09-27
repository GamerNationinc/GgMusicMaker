// Stem separation, the pure parts: which stems to keep, what to call them
// and how loud they are. The separating itself is HTDemucs in the native
// engine (native/src/separate.rs); the store drives it (separateStems).

/** The order stems appear in as layers, top to bottom. */
export const STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"] as const;
export type StemName = (typeof STEM_ORDER)[number];

export const STEM_LABEL: Record<string, string> = {
  vocals: "Vocals",
  drums: "Drums",
  bass: "Bass",
  guitar: "Guitar",
  piano: "Piano",
  other: "Other",
};

/** The rate the separation model runs at; audio is resampled to it and back. */
export const STEM_RATE = 44_100;

/** RMS over every channel. */
export function rms(channels: Float32Array[]): number {
  let sum = 0;
  let n = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    n += ch.length;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** A stem quieter than this, relative to the mix, is just bleed: the song
 *  has no such instrument, so it doesn't get a layer. */
export const SILENT_STEM_DB = -40;

export interface StemLevel {
  name: string;
  rms: number;
}

/** Split stems into ones worth a layer and near-silent ones, in STEM_ORDER. */
export function audibleStems(levels: StemLevel[], mixRms: number, floorDb = SILENT_STEM_DB): { keep: string[]; dropped: string[] } {
  const floor = mixRms * 10 ** (floorDb / 20);
  const rank = (n: string) => {
    const i = (STEM_ORDER as readonly string[]).indexOf(n);
    return i < 0 ? STEM_ORDER.length : i;
  };
  const sorted = [...levels].sort((a, b) => rank(a.name) - rank(b.name));
  return {
    keep: sorted.filter((l) => l.rms > floor).map((l) => l.name),
    dropped: sorted.filter((l) => l.rms <= floor).map((l) => l.name),
  };
}

/** "Song · Vocals". */
export function stemLayerName(source: string, stem: string): string {
  return `${source} · ${STEM_LABEL[stem] ?? stem}`;
}

/** One-line result for the status bar / dialog. */
export function stemSummary(source: string, keep: string[], dropped: string[]): string {
  const names = (l: string[]) => l.map((s) => (STEM_LABEL[s] ?? s).toLowerCase()).join(", ");
  let msg = `${source} → ${keep.length} stem${keep.length === 1 ? "" : "s"}: ${names(keep)}.`;
  if (dropped.length) msg += ` No ${names(dropped)} found (silent, skipped).`;
  return msg + " The original layer is muted.";
}
