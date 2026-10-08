// DJ mode — the Deck as a two-deck mix table (docs/deck-dual-mode.md).
//
//   trackpads   jog wheels, left = deck A, right = deck B. Circle the pad
//               like a platter: while the deck plays, a touch nudges it
//               (pitch-bend to line beats up); press the pad in to scratch
//               (the deck follows your thumb, backwards too); a stopped deck
//               scrubs under the thumb.
//   sticks      EQ, left = A, right = B: up / down turns the LOW knob, left /
//               right the HIGH one (the knob stays where you leave it).
//               Click = LOW kill on / off (bass swap).
//   L2 / R2     crossfader: hold to slide it towards A / B, harder = faster.
//   L1 / R1     play / pause A / B.
//   D-pad ← / → CUE A / B (playing: back to the cue and stop; stopped: set
//               the cue here).
//   X / Y       SYNC A / LOOP A (4 beats on, again = off).
//   B / A       SYNC B / LOOP B.
//   L4 L5 / R4 R5  hot cues 1 and 2 of A / B (set, then jump).
//
// Pure: `update(state, now)` and the screen actions return the engine
// events, deck loads and haptic pulses they cause. `status(...)` takes the
// engine's deck positions. No timers, no audio, no DOM.

import type { ControllerState } from "./deckpad";
import type { Haptic } from "./instrument";
import { EQ_MIN_DB, EQ_MAX_DB, type DjEvent, type DjStatus } from "../audio/dj";

export const HOT_CUES = 4;
export const EQ_BANDS = ["low", "mid", "high"] as const;
export type EqBand = (typeof EQ_BANDS)[number];
/** Tempo fader range, ± (8 % like a turntable). */
export const TEMPO_RANGE = 0.08;
/** Seconds of audio per platter turn (a 33⅓ rpm record). */
export const SECONDS_PER_TURN = 1.8;
const STICK_DEAD = 0.15;
/** Knob travel per second at full stick. */
const KNOB_SPEED = 1.2;
/** Crossfader travel per second at a full trigger. */
const XFADE_SPEED = 1.5;
/** Haptic ticks per platter turn while scratching / scrubbing. */
const TICKS_PER_TURN = 12;
/** Thumb closer to the pad's centre than this: angle too jumpy to read. */
const MIN_RADIUS = 0.25;

export interface DjTrack {
  name: string;
  bufferId: string;
  duration: number;
  /** Detected tempo, or null when no clear beat. */
  bpm: number | null;
  /** First beat, seconds into the track. */
  firstBeat: number;
}

export interface DeckState {
  track: DjTrack | null;
  pos: number;
  playing: boolean;
  /** Tempo fader, 1 = as recorded. */
  rate: number;
  cue: number;
  hotCues: (number | null)[];
  loop: { from: number; to: number } | null;
  /** EQ knobs, −1 (kill) .. 0 (flat) .. 1 (+6 dB). */
  eq: Record<EqBand, number>;
  kill: Record<EqBand, boolean>;
  vol: number;
}

export interface DjView {
  decks: (DeckState & { bpm: number | null; jog: { touch: boolean; scratch: boolean } })[];
  xfade: number;
}

export interface DjOutput {
  events: DjEvent[];
  loads: { deck: number; bufferId: string | null }[];
  haptics: Haptic[];
}

const deadzone = (v: number) => (Math.abs(v) < STICK_DEAD ? 0 : (v - Math.sign(v) * STICK_DEAD) / (1 - STICK_DEAD));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const edge = (prev: ControllerState, s: ControllerState, b: keyof ControllerState["buttons"]) => s.buttons[b] && !prev.buttons[b];

/** EQ knob position → dB: 0 = flat, 1 = +6 dB, down to −∞ (kill) at −1. */
export function knobDb(k: number): number {
  if (k >= 0) return EQ_MAX_DB * Math.min(1, k);
  if (k <= -0.98) return EQ_MIN_DB;
  return Math.max(EQ_MIN_DB, 26 * Math.log10(1 + k));
}

function newDeck(): DeckState {
  return {
    track: null,
    pos: 0,
    playing: false,
    rate: 1,
    cue: 0,
    hotCues: Array(HOT_CUES).fill(null),
    loop: null,
    eq: { low: 0, mid: 0, high: 0 },
    kill: { low: false, mid: false, high: false },
    vol: 1,
  };
}

/** The deck's tempo as heard (its BPM × the tempo fader). */
export function deckBpm(d: DeckState): number | null {
  return d.track?.bpm ? d.track.bpm * d.rate : null;
}

/** The beat nearest `t` (s into the track), or `t` without a tempo. */
export function nearestBeat(track: DjTrack | null, t: number): number {
  if (!track?.bpm) return t;
  const beat = 60 / track.bpm;
  return Math.max(0, track.firstBeat + Math.round((t - track.firstBeat) / beat) * beat);
}

/** Where in its beat `t` falls, 0..1. */
function beatPhase(track: DjTrack, t: number): number {
  const beat = 60 / track.bpm!;
  const p = (t - track.firstBeat) / beat;
  return p - Math.floor(p);
}

interface Jog {
  touch: boolean;
  scratch: boolean;
  /** A nudge is out (must be zeroed on let go). */
  nudging: boolean;
  angle: number;
  at: number;
  /** Platter speed (× normal), smoothed. */
  speed: number;
  /** Rotation since the last haptic tick (turns). */
  turns: number;
}

const idleJog = (): Jog => ({ touch: false, scratch: false, nudging: false, angle: 0, at: 0, speed: 0, turns: 0 });

export class DjDesk {
  decks: DeckState[] = [newDeck(), newDeck()];
  xfade = 0;
  /** Cue / hot cues / loops land on the nearest beat. */
  quantize = true;
  private prev: ControllerState | null = null;
  private lastAt = 0;
  private jogs: Jog[] = [idleJog(), idleJog()];
  private out: DjOutput = { events: [], loads: [], haptics: [] };

  private flush(): DjOutput {
    const o = this.out;
    this.out = { events: [], loads: [], haptics: [] };
    return o;
  }
  private ev(e: DjEvent): void {
    this.out.events.push(e);
  }

  view(): DjView {
    return {
      decks: this.decks.map((d, k) => ({ ...d, bpm: deckBpm(d), jog: { touch: this.jogs[k].touch, scratch: this.jogs[k].scratch } })),
      xfade: this.xfade,
    };
  }

  /** Engine positions in (the engine is the clock). */
  status(s: DjStatus): void {
    this.decks.forEach((d, k) => {
      d.pos = s.pos[k] ?? d.pos;
      d.playing = s.playing[k] ?? d.playing;
    });
  }

  // ---- screen actions (and the controller's buttons) -----------------------

  load(deck: number, track: DjTrack | null): DjOutput {
    const d = this.decks[deck];
    if (!d) return this.flush();
    Object.assign(d, { ...newDeck(), eq: d.eq, kill: d.kill, vol: d.vol, rate: 1, track });
    d.cue = track ? (track.bpm ? nearestBeat(track, track.firstBeat) : 0) : 0;
    this.out.loads.push({ deck, bufferId: track?.bufferId ?? null });
    this.ev({ t: "rate", deck, rate: 1 });
    this.ev({ t: "loop", deck, from: 0, to: 0 });
    if (d.cue > 0) this.ev({ t: "seek", deck, time: d.cue });
    d.pos = d.cue;
    return this.flush();
  }

  playPause(deck: number): DjOutput {
    const d = this.decks[deck];
    if (d?.track) {
      d.playing = !d.playing;
      this.ev({ t: "play", deck, on: d.playing });
    }
    return this.flush();
  }

  /** CUE: playing → back to the cue point and stop; stopped → the cue
   *  point is here (on the beat). */
  cue(deck: number): DjOutput {
    const d = this.decks[deck];
    if (!d?.track) return this.flush();
    if (d.playing) {
      d.playing = false;
      d.pos = d.cue;
      this.ev({ t: "play", deck, on: false });
      this.ev({ t: "seek", deck, time: d.cue });
    } else {
      d.cue = this.quantize ? nearestBeat(d.track, d.pos) : d.pos;
      d.pos = d.cue;
      this.ev({ t: "seek", deck, time: d.cue });
    }
    return this.flush();
  }

  /** Hot cue: empty → set here (bump); set → jump there, playing or not. */
  hotCue(deck: number, i: number): DjOutput {
    const d = this.decks[deck];
    if (!d?.track || i < 0 || i >= HOT_CUES) return this.flush();
    const at = d.hotCues[i];
    if (at == null) {
      d.hotCues[i] = this.quantize ? nearestBeat(d.track, d.pos) : d.pos;
      this.out.haptics.push({ side: deck === 0 ? "left" : "right", strength: "bump" });
    } else {
      d.pos = at;
      this.ev({ t: "seek", deck, time: at });
    }
    return this.flush();
  }

  clearHotCue(deck: number, i: number): DjOutput {
    const d = this.decks[deck];
    if (d && i >= 0 && i < HOT_CUES) d.hotCues[i] = null;
    return this.flush();
  }

  /** A 4-beat loop from the beat at (or just before) here; again = off.
   *  Without a tempo: 2 s. */
  loop(deck: number, beats = 4): DjOutput {
    const d = this.decks[deck];
    if (!d?.track) return this.flush();
    if (d.loop) {
      d.loop = null;
      this.ev({ t: "loop", deck, from: 0, to: 0 });
      return this.flush();
    }
    let from = d.pos;
    let len = 2;
    if (d.track.bpm) {
      const beat = 60 / d.track.bpm;
      len = beats * beat;
      from = Math.max(0, d.track.firstBeat + Math.floor((d.pos - d.track.firstBeat) / beat + 1e-6) * beat);
    }
    const to = Math.min(d.track.duration, from + len);
    d.loop = { from, to };
    this.ev({ t: "loop", deck, from, to });
    return this.flush();
  }

  /** SYNC: match the other deck's tempo (at half / double time if that's
   *  closer) and line this deck's beats up with its beats. */
  sync(deck: number): DjOutput {
    const d = this.decks[deck];
    const o = this.decks[1 - deck];
    if (!d?.track?.bpm || !o?.track?.bpm) return this.flush();
    const target = o.track.bpm * o.rate;
    let ratio = target / d.track.bpm;
    while (ratio > 1.5) ratio /= 2;
    while (ratio < 0.75) ratio *= 2;
    d.rate = ratio;
    this.ev({ t: "rate", deck, rate: ratio });
    // Phase: the engine moves this deck the shorter way onto the other's
    // beat, using both positions as they are when the event lands (the
    // view here is a few ms old and both decks move on meanwhile).
    let diff = beatPhase(o.track, o.pos) - beatPhase(d.track, d.pos);
    diff -= Math.round(diff);
    d.pos = Math.max(0, d.pos + diff * (60 / d.track.bpm));
    this.ev({ t: "phase", deck, beat: 60 / d.track.bpm, first: d.track.firstBeat, to: 1 - deck, toBeat: 60 / o.track.bpm, toFirst: o.track.firstBeat });
    this.out.haptics.push({ side: deck === 0 ? "left" : "right", strength: "bump" });
    return this.flush();
  }

  setRate(deck: number, rate: number): DjOutput {
    const d = this.decks[deck];
    if (d) {
      d.rate = clamp(rate, 1 - TEMPO_RANGE * 2, 1 + TEMPO_RANGE * 2);
      this.ev({ t: "rate", deck, rate: d.rate });
    }
    return this.flush();
  }

  setEq(deck: number, band: EqBand, knob: number): DjOutput {
    const d = this.decks[deck];
    if (d) {
      d.eq[band] = clamp(knob, -1, 1);
      this.sendEq(deck);
    }
    return this.flush();
  }

  toggleKill(deck: number, band: EqBand): DjOutput {
    const d = this.decks[deck];
    if (d) {
      d.kill[band] = !d.kill[band];
      this.sendEq(deck);
    }
    return this.flush();
  }

  private sendEq(deck: number): void {
    const d = this.decks[deck];
    const db = (b: EqBand) => (d.kill[b] ? EQ_MIN_DB : knobDb(d.eq[b]));
    this.ev({ t: "eq", deck, low: db("low"), mid: db("mid"), high: db("high") });
  }

  setVol(deck: number, v: number): DjOutput {
    const d = this.decks[deck];
    if (d) {
      d.vol = clamp(v, 0, 1);
      this.ev({ t: "vol", deck, v: d.vol });
    }
    return this.flush();
  }

  setXfade(x: number): DjOutput {
    this.xfade = clamp(x, -1, 1);
    this.ev({ t: "xfade", x: this.xfade });
    return this.flush();
  }

  /** Jump to a time (a click on the waveform overview). */
  seek(deck: number, time: number): DjOutput {
    const d = this.decks[deck];
    if (d?.track) {
      d.pos = clamp(time, 0, d.track.duration);
      this.ev({ t: "seek", deck, time: d.pos });
    }
    return this.flush();
  }

  /** Hand on the platter from the screen: speed × normal, null = let go. */
  screenScratch(deck: number, speed: number | null): DjOutput {
    if (!this.decks[deck]?.track) return this.flush();
    this.ev(speed == null ? { t: "scratch", deck, on: false, speed: 0 } : { t: "scratch", deck, on: true, speed });
    return this.flush();
  }

  /** Everything let go (leaving DJ mode, controller lost). */
  release(): DjOutput {
    this.jogs.forEach((j, deck) => {
      if (j.scratch) this.ev({ t: "scratch", deck, on: false, speed: 0 });
      if (j.nudging) this.ev({ t: "nudge", deck, amount: 0 });
    });
    this.jogs = [idleJog(), idleJog()];
    this.prev = null;
    return this.flush();
  }

  // ---- the controller -------------------------------------------------------

  update(s: ControllerState, now: number): DjOutput {
    const prev = this.prev;
    this.prev = s;
    const dt = prev ? Math.min(0.05, Math.max(0, (now - this.lastAt) / 1000)) : 0;
    this.lastAt = now;
    if (!prev) return this.flush();

    if (edge(prev, s, "l1")) this.merge(this.playPause(0));
    if (edge(prev, s, "r1")) this.merge(this.playPause(1));
    if (edge(prev, s, "left")) this.merge(this.cue(0));
    if (edge(prev, s, "right")) this.merge(this.cue(1));
    if (edge(prev, s, "x")) this.merge(this.sync(0));
    if (edge(prev, s, "y")) this.merge(this.loop(0));
    if (edge(prev, s, "b")) this.merge(this.sync(1));
    if (edge(prev, s, "a")) this.merge(this.loop(1));
    if (edge(prev, s, "l4")) this.merge(this.hotCue(0, 0));
    if (edge(prev, s, "l5")) this.merge(this.hotCue(0, 1));
    if (edge(prev, s, "r4")) this.merge(this.hotCue(1, 0));
    if (edge(prev, s, "r5")) this.merge(this.hotCue(1, 1));
    if (edge(prev, s, "l3")) this.merge(this.toggleKill(0, "low"));
    if (edge(prev, s, "r3")) this.merge(this.toggleKill(1, "low"));

    // EQ: the sticks turn the LOW (y) and HIGH (x) knobs at a rate.
    ([s.lstick, s.rstick] as const).forEach((st, deck) => {
      const y = deadzone(st.y);
      const x = deadzone(st.x);
      if (!y && !x) return;
      const d = this.decks[deck];
      d.eq.low = clamp(d.eq.low + y * KNOB_SPEED * dt, -1, 1);
      d.eq.high = clamp(d.eq.high + x * KNOB_SPEED * dt, -1, 1);
      this.sendEq(deck);
    });

    // Crossfader: R2 pushes towards B, L2 towards A.
    const push = s.r2 - s.l2;
    if (Math.abs(push) > 0.05 && dt > 0) {
      const x = clamp(this.xfade + push * XFADE_SPEED * dt, -1, 1);
      if (x !== this.xfade) {
        this.xfade = x;
        this.ev({ t: "xfade", x });
      }
    }

    this.jog(0, s.lpad, s.buttons.lpadClick, now);
    this.jog(1, s.rpad, s.buttons.rpadClick, now);
    return this.flush();
  }

  private merge(o: DjOutput): void {
    this.out.events.push(...o.events);
    this.out.loads.push(...o.loads);
    this.out.haptics.push(...o.haptics);
  }

  private jog(deck: number, pad: ControllerState["lpad"], pressed: boolean, now: number): void {
    const j = this.jogs[deck];
    const d = this.decks[deck];
    const radius = Math.hypot(pad.x, pad.y);
    const on = pad.touch && radius >= MIN_RADIUS && !!d.track;
    if (!on) {
      if (j.scratch) this.ev({ t: "scratch", deck, on: false, speed: 0 });
      if (j.nudging) this.ev({ t: "nudge", deck, amount: 0 });
      this.jogs[deck] = idleJog();
      return;
    }
    // Clockwise = forwards: the pad's y is up, so clockwise = angle falling.
    const angle = Math.atan2(pad.y, pad.x);
    if (!j.touch) {
      Object.assign(j, { touch: true, angle, at: now, speed: 0, turns: 0 });
      return;
    }
    const dtJ = (now - j.at) / 1000;
    if (dtJ <= 0) return;
    let da = j.angle - angle;
    da -= 2 * Math.PI * Math.round(da / (2 * Math.PI));
    j.angle = angle;
    j.at = now;
    const turns = da / (2 * Math.PI);
    const inst = (turns * SECONDS_PER_TURN) / dtJ;
    // ~20 ms smoothing: the pad reads at 250 Hz, a thumb's circle is jittery.
    const a = Math.min(1, dtJ / 0.02);
    j.speed += (inst - j.speed) * a;
    const scratch = pressed || !d.playing;
    if (scratch) {
      if (j.nudging) this.ev({ t: "nudge", deck, amount: 0 });
      j.nudging = false;
      j.scratch = true;
      this.ev({ t: "scratch", deck, on: true, speed: clamp(j.speed, -8, 8) });
      j.turns += Math.abs(turns);
      if (j.turns >= 1 / TICKS_PER_TURN) {
        j.turns = 0;
        this.out.haptics.push({ side: deck === 0 ? "left" : "right", strength: "tick" });
      }
    } else {
      if (j.scratch) {
        j.scratch = false;
        this.ev({ t: "scratch", deck, on: false, speed: 0 });
      }
      // Nudge: a push of the platter bends the tempo a little.
      j.nudging = true;
      this.ev({ t: "nudge", deck, amount: clamp(j.speed * 0.1, -0.2, 0.2) });
    }
  }
}
