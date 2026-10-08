import { describe, it, expect } from "vitest";
import { emptyState, type ControllerState } from "./deckpad";
import { DjDesk, knobDb, nearestBeat, deckBpm, SECONDS_PER_TURN, type DjTrack } from "./dj";
import { xfadeGains, type DjEvent } from "../audio/dj";

type Patch = Partial<Omit<ControllerState, "buttons">> & { buttons?: Partial<ControllerState["buttons"]> };
function st(p: Patch = {}): ControllerState {
  const s = emptyState("deck");
  return { ...s, ...p, buttons: { ...s.buttons, ...p.buttons } };
}
const track = (bpm: number | null, firstBeat = 0.1, name = "t"): DjTrack => ({ name, bufferId: `buf-${name}`, duration: 200, bpm, firstBeat });
const kinds = (ev: DjEvent[]) => ev.map((e) => e.t);
const find = <T extends DjEvent["t"]>(ev: DjEvent[], t: T) => ev.find((e) => e.t === t) as Extract<DjEvent, { t: T }> | undefined;

describe("DJ helpers", () => {
  it("EQ knob: flat in the middle, +6 dB up, kill at the bottom", () => {
    expect(knobDb(0)).toBe(0);
    expect(knobDb(1)).toBe(6);
    expect(knobDb(-1)).toBe(-60);
    expect(knobDb(-0.5)).toBeCloseTo(-7.83, 1);
    for (let k = -0.97; k < 1; k += 0.1) expect(knobDb(k + 0.05)).toBeGreaterThan(knobDb(k));
  });
  it("snaps to the nearest beat", () => {
    expect(nearestBeat(track(120, 0.1), 0.38)).toBeCloseTo(0.6);
    expect(nearestBeat(track(120, 0.1), 0.3)).toBeCloseTo(0.1);
    expect(nearestBeat(track(null), 1.234)).toBe(1.234);
  });
  it("crossfader: both full in the middle, one side at the ends", () => {
    expect(xfadeGains(0)).toEqual([1, 1]);
    const [a, b] = xfadeGains(1);
    expect(a).toBeLessThan(1e-12);
    expect(b).toBe(1);
  });
});

describe("DjDesk buttons", () => {
  it("loads a track at its first beat, rate 1, loop off", () => {
    const dj = new DjDesk();
    const o = dj.load(0, track(120, 0.35));
    expect(o.loads).toEqual([{ deck: 0, bufferId: "buf-t" }]);
    expect(kinds(o.events)).toEqual(["rate", "loop", "seek"]);
    expect(find(o.events, "seek")!.time).toBeCloseTo(0.35);
    expect(dj.decks[0].cue).toBeCloseTo(0.35);
  });

  it("play / pause and CUE like a CDJ", () => {
    const dj = new DjDesk();
    dj.load(1, track(120));
    expect(dj.playPause(1).events).toEqual([{ t: "play", deck: 1, on: true }]);
    dj.status({ pos: [0, 12.3], playing: [false, true] });
    // Playing: CUE = back to the cue point and stop.
    expect(dj.cue(1).events).toEqual([{ t: "play", deck: 1, on: false }, { t: "seek", deck: 1, time: 0.1 }]);
    // Stopped somewhere else: CUE sets the cue there, on the beat.
    dj.status({ pos: [0, 30.33], playing: [false, false] });
    dj.cue(1);
    expect(dj.decks[1].cue).toBeCloseTo(30.1);
    // An empty deck does nothing.
    expect(dj.playPause(0).events).toEqual([]);
  });

  it("hot cues: first press sets (with a bump), then jumps", () => {
    const dj = new DjDesk();
    dj.load(0, track(100, 0));
    dj.status({ pos: [10.02, 0], playing: [true, false] });
    const set = dj.hotCue(0, 2);
    expect(set.events).toEqual([]);
    expect(set.haptics).toEqual([{ side: "left", strength: "bump" }]);
    expect(dj.decks[0].hotCues[2]).toBeCloseTo(10.2); // nearest beat at 100 BPM
    dj.status({ pos: [50, 0], playing: [true, false] });
    expect(dj.hotCue(0, 2).events).toEqual([{ t: "seek", deck: 0, time: dj.decks[0].hotCues[2]! }]);
    dj.clearHotCue(0, 2);
    expect(dj.decks[0].hotCues[2]).toBeNull();
  });

  it("LOOP: 4 beats from the beat before, again = off", () => {
    const dj = new DjDesk();
    dj.load(0, track(120, 0.1));
    dj.status({ pos: [5.4, 0], playing: [true, false] });
    const on = find(dj.loop(0).events, "loop")!;
    expect(on.from).toBeCloseTo(5.1);
    expect(on.to).toBeCloseTo(7.1);
    expect(dj.loop(0).events).toEqual([{ t: "loop", deck: 0, from: 0, to: 0 }]);
    dj.load(1, track(null));
    dj.status({ pos: [0, 3], playing: [false, true] });
    const free = find(dj.loop(1).events, "loop")!;
    expect([free.from, free.to]).toEqual([3, 5]);
  });

  it("SYNC matches tempo (halving / doubling when closer) and beat phase", () => {
    const dj = new DjDesk();
    dj.load(0, track(128, 0));
    dj.load(1, track(124, 0.2));
    dj.setRate(0, 1.02);
    // Deck A is 0.3 beat into a beat; deck B is 0.75 into one.
    const beatA = 60 / 128, beatB = 60 / 124;
    dj.status({ pos: [10 * beatA + 0.3 * beatA, 0.2 + 20 * beatB + 0.75 * beatB], playing: [true, true] });
    const o = dj.sync(1);
    const rate = find(o.events, "rate")!.rate;
    expect(124 * rate).toBeCloseTo(128 * 1.02, 6);
    expect(find(o.events, "phase")).toEqual({ t: "phase", deck: 1, beat: beatB, first: 0.2, to: 0, toBeat: beatA, toFirst: 0 });
    // The view's guess: the shorter way, back 0.45 of a beat (0.75 → 0.3).
    expect(dj.decks[1].pos).toBeCloseTo(0.2 + 20.3 * beatB, 6);
    expect(deckBpm(dj.decks[1])).toBeCloseTo(130.56, 2);
    // 87 BPM against 174: double time is the closer match.
    const dj2 = new DjDesk();
    dj2.load(0, track(174));
    dj2.load(1, track(87));
    expect(find(dj2.sync(1).events, "rate")!.rate).toBeCloseTo(1, 6);
    // No tempo on either side: nothing to sync to.
    const dj3 = new DjDesk();
    dj3.load(0, track(null));
    dj3.load(1, track(120));
    expect(dj3.sync(1).events).toEqual([]);
  });

  it("EQ knobs and kill go out as dB", () => {
    const dj = new DjDesk();
    expect(dj.setEq(0, "high", 1).events).toEqual([{ t: "eq", deck: 0, low: 0, mid: 0, high: 6 }]);
    expect(dj.toggleKill(0, "low").events).toEqual([{ t: "eq", deck: 0, low: -60, mid: 0, high: 6 }]);
    expect(dj.toggleKill(0, "low").events).toEqual([{ t: "eq", deck: 0, low: 0, mid: 0, high: 6 }]);
  });
});

describe("DjDesk controller", () => {
  it("bumpers play, d-pad cues, ABXY sync / loop, back buttons hot cues", () => {
    const dj = new DjDesk();
    dj.load(0, track(120));
    dj.load(1, track(120));
    dj.update(st(), 0);
    expect(dj.update(st({ buttons: { l1: true } }), 4).events).toEqual([{ t: "play", deck: 0, on: true }]);
    expect(dj.update(st({ buttons: { l1: true } }), 8).events).toEqual([]); // held: once
    dj.update(st(), 12);
    expect(kinds(dj.update(st({ buttons: { r1: true, a: true } }), 16).events)).toEqual(["play", "loop"]);
    dj.update(st(), 20);
    expect(dj.update(st({ buttons: { r4: true } }), 24).haptics).toEqual([{ side: "right", strength: "bump" }]);
    dj.update(st(), 28);
    expect(kinds(dj.update(st({ buttons: { left: true } }), 32).events)).toEqual(["play", "seek"]); // A was playing
    dj.update(st(), 36);
    expect(kinds(dj.update(st({ buttons: { b: true } }), 40).events)).toEqual(["rate", "phase"]);
  });

  it("sticks turn the LOW / HIGH knobs at a rate; click kills the low", () => {
    const dj = new DjDesk();
    dj.update(st(), 0);
    for (let t = 4; t <= 500; t += 4) dj.update(st({ lstick: { x: 0, y: -1 } }), t);
    expect(dj.decks[0].eq.low).toBeCloseTo(-0.6, 1); // 0.5 s × 1.2/s
    for (let t = 504; t <= 800; t += 4) dj.update(st({ rstick: { x: 1, y: 0 } }), t);
    expect(dj.decks[1].eq.high).toBeCloseTo(0.36, 1);
    dj.update(st(), 804);
    const k = dj.update(st({ buttons: { l3: true } }), 808);
    expect(find(k.events, "eq")!.low).toBe(-60);
  });

  it("triggers slide the crossfader and it stays", () => {
    const dj = new DjDesk();
    dj.update(st(), 0);
    for (let t = 4; t <= 400; t += 4) dj.update(st({ r2: 1 }), t);
    expect(dj.xfade).toBeCloseTo(0.6, 1);
    dj.update(st(), 404);
    expect(dj.xfade).toBeCloseTo(0.6, 1);
    for (let t = 408; t <= 2000; t += 4) dj.update(st({ l2: 1 }), t);
    expect(dj.xfade).toBe(-1);
  });

  /** A thumb circling the pad at `turnsPerSec` (clockwise > 0). */
  function circle(dj: DjDesk, side: "lpad" | "rpad", turnsPerSec: number, ms: number, t0: number, press = false) {
    const out: DjEvent[] = [];
    const haptics: number[] = [];
    for (let t = t0; t <= t0 + ms; t += 4) {
      const a = -2 * Math.PI * turnsPerSec * ((t - t0) / 1000);
      const o = dj.update(st({ [side]: { x: 0.8 * Math.cos(a), y: 0.8 * Math.sin(a), touch: true, pressure: 0 }, buttons: { lpadClick: press && side === "lpad", rpadClick: press && side === "rpad" } }), t);
      out.push(...o.events);
      haptics.push(o.haptics.length);
    }
    return { out, ticks: haptics.reduce((a, b) => a + b, 0) };
  }

  it("jog: touching a playing deck nudges; pressing in scratches; letting go resumes", () => {
    const dj = new DjDesk();
    dj.load(0, track(120));
    dj.status({ pos: [10, 0], playing: [true, false] });
    dj.update(st(), 0);
    const { out } = circle(dj, "lpad", 0.5, 300, 4);
    const nudges = out.filter((e) => e.t === "nudge").map((e) => (e as { amount: number }).amount);
    expect(nudges.length).toBeGreaterThan(20);
    expect(nudges.at(-1)).toBeCloseTo(0.5 * SECONDS_PER_TURN * 0.1, 2);
    const sc = circle(dj, "lpad", -1, 300, 308, true);
    const speeds = sc.out.filter((e) => e.t === "scratch").map((e) => (e as { speed: number }).speed);
    expect(speeds.at(-1)).toBeCloseTo(-SECONDS_PER_TURN, 1); // backwards, one turn a second
    expect(sc.ticks).toBeGreaterThanOrEqual(3); // a tick every 1/12 turn: 0.3 turns ≈ 3.6
    const up = dj.update(st(), 700);
    expect(up.events).toEqual([{ t: "scratch", deck: 0, on: false, speed: 0 }]);
  });

  it("jog on a stopped deck scrubs; no track = nothing", () => {
    const dj = new DjDesk();
    dj.load(1, track(120));
    dj.update(st(), 0);
    const { out } = circle(dj, "rpad", 0.25, 200, 4);
    expect(out.some((e) => e.t === "scratch" && e.on)).toBe(true);
    expect(out.some((e) => e.t === "nudge")).toBe(false);
    dj.update(st(), 300);
    const none = circle(dj, "lpad", 1, 100, 304);
    expect(none.out).toEqual([]);
  });

  it("release lets go of everything", () => {
    const dj = new DjDesk();
    dj.load(0, track(120));
    dj.update(st(), 0);
    circle(dj, "lpad", 1, 100, 4, true);
    expect(dj.release().events).toEqual([{ t: "scratch", deck: 0, on: false, speed: 0 }]);
  });
});
