// The FX chain as the rack shows it: four fixed slots in signal order, each
// with a power switch, a lamp and a one-line summary. Pure functions over
// the Track model so the strip's readouts are unit-tested.
//
//   LAYER (pan/width) ▸ EQ ▸ VOICE SYNTH ▸ REVERB (send + pan/width)
//
// The order is the audio graph's order (see audio/channel.ts) and cannot be
// changed here; "remove" is the power switch (a bypassed module is still in
// the chain, just neutral).

import type { Track } from "../audio/types";
import type { ReverbSpace } from "../audio/reverb";
import { matchingPreset, synthIsActive } from "./voice-synth";

export type FxSlot = "place" | "eq" | "synth" | "reverb";

/** Per-module power switches. All on by default. */
export interface FxEnabled {
  place: boolean;
  eq: boolean;
  synth: boolean;
  reverb: boolean;
}

export const FX_ALL_ON: FxEnabled = { place: true, eq: true, synth: true, reverb: true };

export const FX_SLOTS: { key: FxSlot; label: string }[] = [
  { key: "place", label: "LAYER" },
  { key: "eq", label: "EQ" },
  { key: "synth", label: "VOICE SYNTH" },
  { key: "reverb", label: "REVERB" },
];

/** Pan readout: "C", "L 40", "R 100". */
export function panText(v: number): string {
  return Math.abs(v) < 0.005 ? "C" : `${v < 0 ? "L" : "R"} ${Math.round(Math.abs(v) * 100)}`;
}

/** Width readout as a percentage of "as is". */
export function widthText(v: number): string {
  return `${Math.round(v * 100)}%`;
}

const db = (v: number) => (v > 0 ? `+${v}` : `${v}`);

/** True when the module would change the sound if powered on: the lamp. */
export function slotEngaged(track: Track, slot: FxSlot): boolean {
  switch (slot) {
    case "place":
      return track.pan !== 0 || track.width !== 1;
    case "eq":
      return track.eq.low !== 0 || track.eq.mid !== 0 || track.eq.high !== 0;
    case "synth":
      return synthIsActive(track.synth);
    case "reverb":
      return track.reverbSend > 0;
  }
}

/** True when the module is on *and* doing something — what the lamp shows. */
export function slotLit(track: Track, slot: FxSlot): boolean {
  return track.fx[slot] && slotEngaged(track, slot);
}

/** One line describing the module's current setting, for the chain strip. */
export function slotSummary(track: Track, slot: FxSlot, space: ReverbSpace): string {
  switch (slot) {
    case "place":
      return `${panText(track.pan)} · ${widthText(track.width)}`;
    case "eq":
      return `${db(track.eq.low)} / ${db(track.eq.mid)} / ${db(track.eq.high)} dB`;
    case "synth": {
      if (!synthIsActive(track.synth)) return "off";
      const name = matchingPreset(track.synth) ?? "custom";
      return `${name} · ${Math.round(track.synth.mix * 100)}%`;
    }
    case "reverb":
      return track.reverbSend > 0 ? `${space} · ${Math.round(track.reverbSend * 100)}%` : "no send";
  }
}

/** Any module on and engaged — lights the FX chip on the track head. */
export function anyFxLit(track: Track): boolean {
  return FX_SLOTS.some((s) => slotLit(track, s.key));
}

/** Fill in / clean a power-switch block from any (old or partial) track data. */
export function normalizeFx(fx: unknown): FxEnabled {
  const src = (fx ?? {}) as Partial<Record<FxSlot, unknown>>;
  const on = (k: FxSlot) => (typeof src[k] === "boolean" ? (src[k] as boolean) : true);
  return { place: on("place"), eq: on("eq"), synth: on("synth"), reverb: on("reverb") };
}
