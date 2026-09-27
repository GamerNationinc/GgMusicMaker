// Instrument racks and stack recipes.
//
// A RACK is a whole-layer setting for one job ("Double L", "Sub Boom"): it
// resets every module (EQ, PUNCH, MORPH, VOICE SYNTH, reverb send, pan,
// width, level) and dials in that job, so applying one is predictable.
// Racks are grouped by instrument category.
//
// A STACK RECIPE is a list of racks: the first goes on the layer you start
// from, each other one on a new linked layer of the same audio — parallel
// processing the easy way ("Wall of Vox" = lead + doubles + octave + air).
//
// Pure data + one pure function (rackTrack); unit-tested.

import type { EqParams, Track } from "../audio/types";
import { EQ_CUT_OFF } from "../audio/types";
import { DEFAULT_SYNTH, SYNTH_PRESETS, presetParams, type VoiceSynthParams } from "./voice-synth";
import { DEFAULT_MORPH, MORPH_PRESETS, morphPresetParams, type MorphParams } from "./morph";
import { DEFAULT_PUNCH, PUNCH_PRESETS, punchPresetParams, type PunchParams } from "./punch";
import { FX_ALL_ON } from "./chain";

export const CATEGORIES = ["VOCALS", "DRUMS", "PERCUSSION", "BASS", "SYNTH", "KEYS & GUITAR", "AMBIENT"] as const;
export type Category = (typeof CATEGORIES)[number];

/** A module setting: a factory preset by name, plus optional overrides. */
interface ModuleSpec<P> {
  preset?: string;
  set?: Partial<P>;
}

export interface Rack {
  name: string;
  category: Category;
  blurb: string;
  gain?: number;
  pan?: number;
  width?: number;
  reverbSend?: number;
  eq?: Partial<EqParams>;
  punch?: ModuleSpec<PunchParams>;
  morph?: ModuleSpec<MorphParams>;
  synth?: ModuleSpec<VoiceSynthParams>;
}

export interface StackRecipe {
  name: string;
  category: Category;
  blurb: string;
  /** Rack names; [0] goes on the starting layer. */
  layers: string[];
}

const DOUBLE: Partial<VoiceSynthParams> = { mix: 1, shift: 1, unison: 2, detune: 14, drift: 12, vibratoDepth: 4, width: 0.2 };

export const RACKS: Rack[] = [
  // ---- VOCALS ----------------------------------------------------------------
  { name: "Lead Clean", category: "VOCALS", blurb: "de-mud, presence, a touch of air", eq: { lowCut: 90, low: -2, mid: 1.5, high: 3 }, reverbSend: 0.15 },
  { name: "Double L", category: "VOCALS", blurb: "detuned double, hard left", gain: 0.7, pan: -0.75, eq: { lowCut: 150, high: 2 }, synth: { set: DOUBLE } },
  { name: "Double R", category: "VOCALS", blurb: "detuned double, hard right", gain: 0.7, pan: 0.75, eq: { lowCut: 150, high: 2 }, synth: { set: { ...DOUBLE, detune: 19, drift: 18 } } },
  { name: "Octave Down", category: "VOCALS", blurb: "an octave under, dark", gain: 0.5, eq: { highCut: 3000 }, synth: { preset: "Deep", set: { pitch: -12, formant: -2 } } },
  { name: "Whisper Air", category: "VOCALS", blurb: "breathy spectral top layer", gain: 0.45, eq: { lowCut: 2500 }, reverbSend: 0.3, morph: { preset: "Whisper Swarm" } },
  { name: "Harmony Choir", category: "VOCALS", blurb: "stacked chord voices", gain: 0.55, eq: { lowCut: 200 }, synth: { preset: "Choir" } },
  { name: "Robot Vox", category: "VOCALS", blurb: "vocoder robot", gain: 0.6, synth: { preset: "Robot" } },
  { name: "Talkbox", category: "VOCALS", blurb: "Daft-style talkbox", gain: 0.6, synth: { preset: "Daft" } },
  { name: "Telephone", category: "VOCALS", blurb: "band-limited, gritty", gain: 0.6, eq: { lowCut: 450, highCut: 3200, mid: 6 }, punch: { set: { drive: 0.45 } } },
  { name: "Halo Verb", category: "VOCALS", blurb: "wet surround halo", gain: 0.4, eq: { lowCut: 300 }, reverbSend: 1, synth: { preset: "Halo 360" } },
  // ---- DRUMS -----------------------------------------------------------------
  { name: "Kit Main", category: "DRUMS", blurb: "tight, punchy full kit", eq: { lowCut: 30 }, punch: { preset: "Tight Kick" } },
  { name: "Sub Boom", category: "DRUMS", blurb: "only the lows, boomed + sub", gain: 0.8, eq: { highCut: 150 }, punch: { preset: "808 Boom" } },
  { name: "Crack", category: "DRUMS", blurb: "only the highs, snapped", gain: 0.6, eq: { lowCut: 1500 }, punch: { preset: "Snap Drums" } },
  { name: "Room Smash", category: "DRUMS", blurb: "crushed parallel room", gain: 0.35, eq: { lowCut: 100, highCut: 8000 }, reverbSend: 0.5, punch: { preset: "Blown Out", set: { safe: 1 } } },
  { name: "Lo-Fi Kit", category: "DRUMS", blurb: "dusty, rolled-off", eq: { lowCut: 60, highCut: 5000 }, punch: { preset: "Lo-Fi Crush" } },
  { name: "Blown Kit", category: "DRUMS", blurb: "speaker-killer parallel", gain: 0.5, punch: { preset: "Speaker Killer" } },
  { name: "Wide Kit", category: "DRUMS", blurb: "extra-wide highs", eq: { lowCut: 250 }, width: 1.8, gain: 0.6 },
  // ---- PERCUSSION -------------------------------------------------------------
  { name: "Perc Clean", category: "PERCUSSION", blurb: "clear, snappy", eq: { lowCut: 200 }, punch: { set: { snap: 0.5 } } },
  { name: "Shaker Air", category: "PERCUSSION", blurb: "only the sizzle", gain: 0.6, eq: { lowCut: 3000, high: 4 }, reverbSend: 0.3, width: 1.6 },
  { name: "Grain Perc", category: "PERCUSSION", blurb: "granular scatter round the room", gain: 0.6, morph: { preset: "Grain Storm" } },
  { name: "Tuned Perc", category: "PERCUSSION", blurb: "hits ring on tuned strings", gain: 0.6, morph: { preset: "Harp Strings" } },
  { name: "Perc Orbit", category: "PERCUSSION", blurb: "circles the listener", gain: 0.6, eq: { lowCut: 300 }, morph: { preset: "Grain Halo", set: { mix: 0.9, path: 1, motion: 0.4 } } },
  // ---- BASS --------------------------------------------------------------------
  { name: "Bass DI", category: "BASS", blurb: "solid, controlled", eq: { lowCut: 30 }, punch: { set: { boom: 0.3, drive: 0.2, freq: 120 } } },
  { name: "Sub Only", category: "BASS", blurb: "lows + synthesised sub", gain: 0.8, eq: { highCut: 120 }, punch: { preset: "Club Sub" } },
  { name: "Grit Top", category: "BASS", blurb: "folded mids so it cuts through", gain: 0.45, eq: { lowCut: 400 }, morph: { preset: "Buchla Fold" } },
  { name: "808 Glide", category: "BASS", blurb: "big 808 boom", punch: { preset: "808 Boom" } },
  { name: "Wobble", category: "BASS", blurb: "talking vowel filter", gain: 0.6, eq: { lowCut: 150 }, morph: { preset: "Talking Tract", set: { b: 0.5 } } },
  // ---- SYNTH -------------------------------------------------------------------
  { name: "Synth Wide", category: "SYNTH", blurb: "wide, cleaned-up lows", eq: { lowCut: 120 }, width: 1.8 },
  { name: "Supersaw", category: "SYNTH", blurb: "8-voice detuned unison", gain: 0.7, synth: { set: { mix: 1, shift: 1, unison: 8, detune: 30, drift: 10, width: 1, ensemble: 0.4 } } },
  { name: "Octave Sparkle", category: "SYNTH", blurb: "an octave up, top only", gain: 0.45, eq: { lowCut: 800 }, synth: { set: { mix: 1, shift: 1, pitch: 12, width: 0.8 } } },
  { name: "FM Bell", category: "SYNTH", blurb: "FM bell layer", gain: 0.6, morph: { preset: "FM Bell Voice" } },
  { name: "Chaos Pad", category: "SYNTH", blurb: "Lorenz-modulated movement", gain: 0.6, morph: { preset: "Lorenz Flight" } },
  { name: "Frozen Pad", category: "SYNTH", blurb: "spectral freeze wash", gain: 0.6, reverbSend: 0.4, morph: { preset: "Spectral Freeze" } },
  // ---- KEYS & GUITAR -----------------------------------------------------------
  { name: "Keys Warm", category: "KEYS & GUITAR", blurb: "round and soft", eq: { lowCut: 60, low: 2, high: -3 } },
  { name: "Guitar L", category: "KEYS & GUITAR", blurb: "double-tracked, left", gain: 0.75, pan: -0.8, eq: { lowCut: 100 }, synth: { set: DOUBLE } },
  { name: "Guitar R", category: "KEYS & GUITAR", blurb: "double-tracked, right", gain: 0.75, pan: 0.8, eq: { lowCut: 100 }, synth: { set: { ...DOUBLE, detune: 20, drift: 16 } } },
  { name: "Amp Crunch", category: "KEYS & GUITAR", blurb: "driven mids", eq: { lowCut: 90, mid: 4 }, punch: { set: { drive: 0.7, freq: 200 } } },
  { name: "Harmonic Shimmer", category: "KEYS & GUITAR", blurb: "just-intonation resonance", gain: 0.5, morph: { preset: "Just Choir 432" } },
  // ---- AMBIENT -------------------------------------------------------------------
  { name: "Space Wash", category: "AMBIENT", blurb: "cathedral + full verb", gain: 0.6, reverbSend: 1, synth: { preset: "Cathedral" } },
  { name: "Drone", category: "AMBIENT", blurb: "sitar-like drone strings", gain: 0.5, morph: { preset: "Drone Sitar" } },
  { name: "Solfeggio Bed", category: "AMBIENT", blurb: "528-rooted resonance", gain: 0.5, morph: { preset: "Solfeggio 528" } },
  { name: "Freeze Cloud", category: "AMBIENT", blurb: "frozen spectral cloud", gain: 0.5, morph: { preset: "Spectral Freeze", set: { a: 1 } } },
];

export const STACK_RECIPES: StackRecipe[] = [
  { name: "Wall of Vox", category: "VOCALS", blurb: "lead + L/R doubles + octave + air", layers: ["Lead Clean", "Double L", "Double R", "Octave Down", "Whisper Air"] },
  { name: "Choir Stack", category: "VOCALS", blurb: "lead + harmonies + halo", layers: ["Lead Clean", "Harmony Choir", "Halo Verb"] },
  { name: "Robot Duet", category: "VOCALS", blurb: "lead + robot + octave", layers: ["Lead Clean", "Robot Vox", "Octave Down"] },
  { name: "Big Room Kit", category: "DRUMS", blurb: "main + sub + crack + smash", layers: ["Kit Main", "Sub Boom", "Crack", "Room Smash"] },
  { name: "Boom Bap", category: "DRUMS", blurb: "lo-fi + sub + crack", layers: ["Lo-Fi Kit", "Sub Boom", "Crack"] },
  { name: "Speaker Killer", category: "DRUMS", blurb: "main + blown parallel + sub", layers: ["Kit Main", "Blown Kit", "Sub Boom"] },
  { name: "Perc Cloud", category: "PERCUSSION", blurb: "clean + grains + air", layers: ["Perc Clean", "Grain Perc", "Shaker Air"] },
  { name: "Tuned Hits", category: "PERCUSSION", blurb: "clean + strings + orbit", layers: ["Perc Clean", "Tuned Perc", "Perc Orbit"] },
  { name: "Stack Bass", category: "BASS", blurb: "DI + sub + grit", layers: ["Bass DI", "Sub Only", "Grit Top"] },
  { name: "Wobble Bass", category: "BASS", blurb: "sub + wobble", layers: ["Sub Only", "Wobble"] },
  { name: "Huge Lead", category: "SYNTH", blurb: "wide + supersaw + sparkle", layers: ["Synth Wide", "Supersaw", "Octave Sparkle"] },
  { name: "Evolving Pad", category: "SYNTH", blurb: "wide + freeze + chaos", layers: ["Synth Wide", "Frozen Pad", "Chaos Pad"] },
  { name: "Double Tracked", category: "KEYS & GUITAR", blurb: "L/R doubles + crunch", layers: ["Guitar L", "Guitar R", "Amp Crunch"] },
  { name: "Ambient Bed", category: "AMBIENT", blurb: "wash + drone + 528", layers: ["Space Wash", "Drone", "Solfeggio Bed"] },
];

export function findRack(name: string): Rack | undefined {
  return RACKS.find((r) => r.name === name);
}

function module<P extends object>(defaults: P, presets: { name: string }[], toParams: (p: never) => P, spec?: ModuleSpec<P>): P {
  if (!spec) return { ...defaults };
  const preset = spec.preset ? presets.find((p) => p.name === spec.preset) : undefined;
  const base = preset ? toParams(preset as never) : { ...defaults };
  return { ...base, ...spec.set };
}

/** `track` with `rack` applied: every module reset, then the rack dialled in.
 *  Clips, name, stack membership and mute/solo are left alone. */
export function rackTrack(track: Track, rack: Rack): Track {
  return {
    ...track,
    role: rack.name,
    gain: rack.gain ?? 1,
    pan: rack.pan ?? 0,
    width: rack.width ?? 1,
    reverbSend: rack.reverbSend ?? 0,
    reverbPan: 0,
    reverbWidth: 1,
    eq: { low: 0, mid: 0, high: 0, ...EQ_CUT_OFF, ...rack.eq },
    punch: module(DEFAULT_PUNCH, PUNCH_PRESETS, punchPresetParams as (p: never) => PunchParams, rack.punch),
    morph: module(DEFAULT_MORPH, MORPH_PRESETS, morphPresetParams as (p: never) => MorphParams, rack.morph),
    synth: module(DEFAULT_SYNTH, SYNTH_PRESETS, presetParams as (p: never) => VoiceSynthParams, rack.synth),
    fx: { ...FX_ALL_ON },
  };
}

/** Every preset name a rack refers to, for the consistency test. */
export function rackReferences(r: Rack): { kind: "punch" | "morph" | "synth"; name: string }[] {
  const out: { kind: "punch" | "morph" | "synth"; name: string }[] = [];
  if (r.punch?.preset) out.push({ kind: "punch", name: r.punch.preset });
  if (r.morph?.preset) out.push({ kind: "morph", name: r.morph.preset });
  if (r.synth?.preset) out.push({ kind: "synth", name: r.synth.preset });
  return out;
}
