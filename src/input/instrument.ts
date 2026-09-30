// Instrument mode — the Deck as a playable instrument (docs/deck-dual-mode.md).
//
//   right pad   scale-locked note grid: columns = scale steps, 3 rows =
//               3 octaves. Touch plays, slide moves between steps (a haptic
//               tick on each), lift releases.
//   left pad    X/Y macro: X = filter cutoff, Y = reverb send (stays put).
//   left stick  pitch bend (±2 semitones, springs back).
//   right stick up = mod wheel (vibrato depth).
//   R2          expression (swell), L2 = velocity of the ABXY pads.
//   ABXY        bank A: kick / snare / hat / clap. Hold L1 or R1 for bank B:
//               the I, IV, V, vi chords of the key.
//   L4 / R4     octave down / up.     L5  sustain (hold).
//   R5          hold to arm tilt: rolling the Deck bends pitch.
//   D-pad       ←/→ key down/up a semitone, ↑/↓ next/previous scale.
//   L3          next sound (keys, pluck, pad, bass).
//
// Pure: `update(state)` → the engine events and haptic pulses that state
// change causes. No timers, no audio, no DOM.

import type { ControllerState, HapticSide } from "./deckpad";
import { LIVE_PATCHES, type LiveControls, type LiveEvent } from "../audio/live";

export const SCALES = [
  { name: "major", steps: [0, 2, 4, 5, 7, 9, 11] },
  { name: "minor", steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: "dorian", steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: "major pent.", steps: [0, 2, 4, 7, 9] },
  { name: "minor pent.", steps: [0, 3, 5, 7, 10] },
  { name: "blues", steps: [0, 3, 5, 6, 7, 10] },
] as const;

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const GRID_ROWS = 3;
export const DRUM_NAMES = ["Kick", "Snare", "Hat", "Clap"];
/** Face buttons in pad order (A B X Y). */
export const PAD_BUTTONS = ["a", "b", "x", "y"] as const;
/** Chord degrees on bank B: I IV V vi. */
const CHORD_DEGREES = [0, 3, 4, 5];
const BEND_RANGE = 2;
const STICK_DEAD = 0.12;
/** Tilt (radians) for a full bend. */
const TILT_FULL = Math.PI / 6;

export interface InstrumentSettings {
  key: number;
  scale: number;
  /** Octave of the grid's bottom row (C3 = 3). */
  octave: number;
  patch: number;
}

export const DEFAULT_SETTINGS: InstrumentSettings = { key: 0, scale: 0, octave: 3, patch: 0 };

/** What the UI shows. */
export interface InstrumentView extends InstrumentSettings {
  /** Grid cell under the right thumb, or null. */
  cell: { col: number; row: number } | null;
  rpad: { x: number; y: number; touch: boolean };
  lpad: { x: number; y: number; touch: boolean };
  bank: "drums" | "chords";
  /** Which of the 4 pads are held. */
  pads: boolean[];
  controls: LiveControls;
  tiltArmed: boolean;
}

export interface Haptic {
  side: HapticSide;
  strength: "tick" | "bump";
}

export interface Output {
  events: LiveEvent[];
  haptics: Haptic[];
}

const deadzone = (v: number) => (Math.abs(v) < STICK_DEAD ? 0 : (v - Math.sign(v) * STICK_DEAD) / (1 - STICK_DEAD));
const edge = (prev: ControllerState, s: ControllerState, b: keyof ControllerState["buttons"]) => s.buttons[b] && !prev.buttons[b];

export function scaleOf(settings: InstrumentSettings): readonly number[] {
  return SCALES[settings.scale % SCALES.length].steps;
}

/** MIDI note of a grid cell. */
export function cellNote(settings: InstrumentSettings, col: number, row: number): number {
  const steps = scaleOf(settings);
  return 12 * (settings.octave + 1 + row) + settings.key + steps[col % steps.length];
}

/** Grid cell under a pad position. */
export function cellAt(settings: InstrumentSettings, x: number, y: number): { col: number; row: number } {
  const cols = scaleOf(settings).length;
  const col = Math.min(cols - 1, Math.max(0, Math.floor(((x + 1) / 2) * cols)));
  const row = Math.min(GRID_ROWS - 1, Math.max(0, Math.floor(((y + 1) / 2) * GRID_ROWS)));
  return { col, row };
}

/** Triad on scale degree `deg` of the key (7-note parent scale for the
 *  pentatonic/blues ones: major for major pent., natural minor otherwise). */
export function chordNotes(settings: InstrumentSettings, deg: number): number[] {
  let steps = scaleOf(settings);
  if (steps.length !== 7) steps = settings.scale === 3 ? SCALES[0].steps : SCALES[1].steps;
  const root = 12 * (settings.octave + 1) + settings.key;
  return [0, 2, 4].map((k) => {
    const i = deg + k;
    return root + steps[i % 7] + 12 * Math.floor(i / 7);
  });
}

export function chordName(settings: InstrumentSettings, deg: number): string {
  const [a, b] = chordNotes(settings, deg);
  const name = NOTE_NAMES[((a % 12) + 12) % 12];
  return b - a === 3 ? `${name}m` : name;
}

/** Glide between cells for sustained sounds; retrigger for struck ones. */
const LEGATO = new Set([2, 3]);

export class Instrument {
  settings: InstrumentSettings;
  private prev: ControllerState | null = null;
  private nextId = 1;
  /** Voice id of the note under the right thumb. */
  private gridVoice: number | null = null;
  private cell: { col: number; row: number } | null = null;
  /** Chord pad → voice ids it started. */
  private chordVoices = new Map<number, number[]>();
  private controls: LiveControls = { bend: 0, mod: 0, cutoff: 0.7, send: 0.2, expr: 0.7, sustain: false };
  private sentControls: LiveControls | null = null;
  private tiltZero: number | null = null;
  private lpadXY = { x: 0.4, y: -0.6 };

  constructor(settings: InstrumentSettings = DEFAULT_SETTINGS) {
    this.settings = { ...settings };
  }

  /** Feed the latest controller state. */
  update(s: ControllerState): Output {
    const prev = this.prev ?? s;
    this.prev = s;
    const events: LiveEvent[] = [];
    const haptics: Haptic[] = [];
    const st = this.settings;

    // --- settings: octave, key, scale, sound ---
    let moved = false;
    if (edge(prev, s, "l4") && st.octave > 1) (st.octave--, (moved = true));
    if (edge(prev, s, "r4") && st.octave < 6) (st.octave++, (moved = true));
    if (edge(prev, s, "left")) (st.key = (st.key + 11) % 12, (moved = true));
    if (edge(prev, s, "right")) (st.key = (st.key + 1) % 12, (moved = true));
    if (edge(prev, s, "up")) (st.scale = (st.scale + 1) % SCALES.length, (moved = true));
    if (edge(prev, s, "down")) (st.scale = (st.scale + SCALES.length - 1) % SCALES.length, (moved = true));
    if (edge(prev, s, "l3")) (st.patch = (st.patch + 1) % LIVE_PATCHES.length, (moved = true));
    if (moved) {
      haptics.push({ side: "both", strength: "bump" });
      // The note under the thumb follows the new layout.
      this.cell = null;
    }

    // --- continuous controls ---
    const c = this.controls;
    if (s.lpad.touch) this.lpadXY = { x: s.lpad.x, y: s.lpad.y };
    c.cutoff = (this.lpadXY.x + 1) / 2;
    c.send = (this.lpadXY.y + 1) / 2;
    c.mod = Math.max(0, deadzone(s.rstick.y));
    c.expr = 0.7 + 0.3 * s.r2;
    c.sustain = s.buttons.l5;
    let bend = deadzone(s.lstick.y) * BEND_RANGE;
    if (s.buttons.r5 && s.source === "deck") {
      const angle = Math.atan2(s.accel[0], s.accel[1]);
      if (this.tiltZero === null) this.tiltZero = angle;
      bend += Math.max(-1, Math.min(1, (angle - this.tiltZero) / TILT_FULL)) * BEND_RANGE;
    } else {
      this.tiltZero = null;
    }
    c.bend = Math.max(-BEND_RANGE * 2, Math.min(BEND_RANGE * 2, bend));
    const sent = this.sentControls;
    if (
      !sent ||
      sent.sustain !== c.sustain ||
      (["bend", "mod", "cutoff", "send", "expr"] as const).some((k) => Math.abs(sent[k] - c[k]) > 0.002)
    ) {
      events.push({ t: "ctl", ...c });
      this.sentControls = { ...c };
    }

    // --- right pad: the note grid ---
    if (s.rpad.touch) {
      const cell = cellAt(st, s.rpad.x, s.rpad.y);
      if (!this.cell || cell.col !== this.cell.col || cell.row !== this.cell.row) {
        const note = cellNote(st, cell.col, cell.row);
        if (this.gridVoice !== null && LEGATO.has(st.patch)) {
          events.push({ t: "glide", id: this.gridVoice, note });
        } else {
          if (this.gridVoice !== null) events.push({ t: "off", id: this.gridVoice });
          this.gridVoice = this.nextId++;
          events.push({ t: "on", id: this.gridVoice, note, vel: 0.8, patch: st.patch });
        }
        if (this.cell) haptics.push({ side: "right", strength: "tick" });
        this.cell = cell;
      }
    } else if (this.gridVoice !== null || this.cell) {
      if (this.gridVoice !== null) events.push({ t: "off", id: this.gridVoice });
      this.gridVoice = null;
      this.cell = null;
    }

    // --- ABXY pads ---
    const chords = s.buttons.l1 || s.buttons.r1;
    const vel = 0.6 + 0.4 * s.l2;
    PAD_BUTTONS.forEach((b, i) => {
      if (edge(prev, s, b)) {
        if (chords) {
          const ids = chordNotes(st, CHORD_DEGREES[i]).map((note) => {
            const id = this.nextId++;
            events.push({ t: "on", id, note, vel: vel * 0.8, patch: st.patch });
            return id;
          });
          this.chordVoices.set(i, ids);
        } else {
          events.push({ t: "drum", kind: i, vel });
        }
      } else if (!s.buttons[b] && prev.buttons[b]) {
        for (const id of this.chordVoices.get(i) ?? []) events.push({ t: "off", id });
        this.chordVoices.delete(i);
      }
    });

    return { events, haptics };
  }

  /** Release everything (leaving the mode, controller lost). */
  release(): Output {
    const events: LiveEvent[] = [];
    if (this.gridVoice !== null) events.push({ t: "off", id: this.gridVoice });
    for (const ids of this.chordVoices.values()) for (const id of ids) events.push({ t: "off", id });
    this.gridVoice = null;
    this.cell = null;
    this.chordVoices.clear();
    if (this.controls.sustain || this.controls.bend) {
      this.controls = { ...this.controls, sustain: false, bend: 0 };
      events.push({ t: "ctl", ...this.controls });
      this.sentControls = { ...this.controls };
    }
    this.prev = null;
    return { events, haptics: [] };
  }

  view(): InstrumentView {
    const s = this.prev;
    return {
      ...this.settings,
      cell: this.cell,
      rpad: s ? { x: s.rpad.x, y: s.rpad.y, touch: s.rpad.touch } : { x: 0, y: 0, touch: false },
      lpad: { ...this.lpadXY, touch: !!s?.lpad.touch },
      bank: s && (s.buttons.l1 || s.buttons.r1) ? "chords" : "drums",
      pads: PAD_BUTTONS.map((b) => !!s?.buttons[b]),
      controls: { ...this.controls },
      tiltArmed: this.tiltZero !== null,
    };
  }
}
