import { describe, it, expect } from "vitest";
import { emptyState, type ControllerState } from "./deckpad";
import { Instrument, cellAt, cellNote, chordNotes, chordName, SCALES } from "./instrument";
import type { LiveEvent } from "../audio/live";

type Patch = Partial<Omit<ControllerState, "buttons">> & { buttons?: Partial<ControllerState["buttons"]> };
function st(p: Patch = {}): ControllerState {
  const s = emptyState("deck");
  return { ...s, ...p, buttons: { ...s.buttons, ...p.buttons }, accel: p.accel ?? [0, 1, 0] };
}
const touch = (x: number, y: number) => ({ rpad: { x, y, touch: true, pressure: 0 } });
const kinds = (ev: LiveEvent[]) => ev.map((e) => e.t);
const notes = (ev: LiveEvent[]) => ev.flatMap((e) => (e.t === "on" || e.t === "glide" ? [e.note] : []));

describe("note grid", () => {
  const s = { key: 0, scale: 0, octave: 3, patch: 0 };
  it("maps the pad to scale steps and 3 octaves", () => {
    expect(cellAt(s, -1, -1)).toEqual({ col: 0, row: 0 });
    expect(cellAt(s, 1, 1)).toEqual({ col: 6, row: 2 });
    expect(cellNote(s, 0, 0)).toBe(48); // C3
    expect(cellNote(s, 6, 2)).toBe(83); // B5
    expect(cellNote({ ...s, key: 9, scale: 1 }, 2, 0)).toBe(48 + 9 + 3); // A minor, 3rd step = C
  });
  it("chords are the diatonic triads", () => {
    expect(chordNotes(s, 0)).toEqual([48, 52, 55]);
    expect(chordName(s, 3)).toBe("F");
    expect(chordName(s, 5)).toBe("Am");
    expect(chordNotes({ ...s, scale: 4 }, 0)).toEqual([48, 51, 55]); // minor pent. → natural minor
  });
  it("every scale fills the pad", () => {
    for (let i = 0; i < SCALES.length; i++) expect(cellAt({ ...s, scale: i }, 0.999, 0).col).toBe(SCALES[i].steps.length - 1);
  });
});

describe("Instrument", () => {
  it("touch plays, slide retriggers with a tick, lift releases", () => {
    const inst = new Instrument();
    inst.update(st());
    const a = inst.update(st(touch(-0.95, -0.9)));
    expect(kinds(a.events)).toEqual(["on"]);
    expect(notes(a.events)).toEqual([48]);
    expect(a.haptics).toEqual([]);
    expect(kinds(inst.update(st(touch(-0.93, -0.9))).events)).toEqual([]); // same cell
    const b = inst.update(st(touch(-0.6, -0.9)));
    expect(kinds(b.events)).toEqual(["off", "on"]);
    expect(notes(b.events)).toEqual([50]);
    expect(b.haptics).toEqual([{ side: "right", strength: "tick" }]);
    expect(kinds(inst.update(st()).events)).toEqual(["off"]);
  });

  it("sustained sounds glide between steps instead", () => {
    const inst = new Instrument({ key: 0, scale: 0, octave: 3, patch: 2 });
    inst.update(st(touch(-0.95, -0.9)));
    expect(kinds(inst.update(st(touch(-0.6, -0.9))).events)).toEqual(["glide"]);
  });

  it("ABXY drums, bumper + ABXY chords held until release", () => {
    const inst = new Instrument();
    inst.update(st());
    const d = inst.update(st({ buttons: { b: true }, l2: 1 }));
    expect(d.events.filter((e) => e.t === "drum")).toEqual([{ t: "drum", kind: 1, vel: 1 }]);
    inst.update(st());
    const c = inst.update(st({ buttons: { r1: true, y: true } }));
    expect(notes(c.events)).toEqual([57, 60, 64]); // Am
    const off = inst.update(st({ buttons: { r1: true } }));
    expect(kinds(off.events)).toEqual(["off", "off", "off"]);
  });

  it("back buttons and d-pad change octave, key, scale; L3 the sound", () => {
    const inst = new Instrument();
    inst.update(st());
    const up = inst.update(st({ buttons: { r4: true } }));
    expect(inst.settings.octave).toBe(4);
    expect(up.haptics).toEqual([{ side: "both", strength: "bump" }]);
    inst.update(st());
    inst.update(st({ buttons: { right: true } }));
    inst.update(st());
    inst.update(st({ buttons: { up: true } }));
    inst.update(st());
    inst.update(st({ buttons: { l3: true } }));
    expect(inst.settings).toMatchObject({ key: 1, scale: 1, octave: 4, patch: 1 });
  });

  it("controls: macro stays where the thumb left it; ctl only on change", () => {
    const inst = new Instrument();
    const first = inst.update(st());
    expect(kinds(first.events)).toEqual(["ctl"]);
    expect(inst.update(st()).events).toEqual([]);
    inst.update(st({ lpad: { x: 1, y: 1, touch: true, pressure: 0 } }));
    const after = inst.update(st());
    expect(after.events).toEqual([]);
    expect(inst.view().controls.cutoff).toBe(1);
    expect(inst.view().controls.send).toBe(1);
    const sus = inst.update(st({ buttons: { l5: true }, r2: 1, lstick: { x: 0, y: 1 } }));
    expect(sus.events).toEqual([{ t: "ctl", bend: 2, mod: 0, cutoff: 1, send: 1, expr: 1, sustain: true }]);
  });

  it("tilt bends only while R5 is held, relative to where it started", () => {
    const inst = new Instrument();
    inst.update(st());
    inst.update(st({ buttons: { r5: true }, accel: [0, 1, 0] }));
    const tilt = Math.PI / 12; // half of full
    inst.update(st({ buttons: { r5: true }, accel: [Math.sin(tilt), Math.cos(tilt), 0] }));
    expect(inst.view().controls.bend).toBeCloseTo(1, 5);
    expect(inst.view().tiltArmed).toBe(true);
    inst.update(st({ accel: [Math.sin(tilt), Math.cos(tilt), 0] }));
    expect(inst.view().controls.bend).toBe(0);
  });

  it("release() lets go of every held note", () => {
    const inst = new Instrument();
    inst.update(st());
    inst.update(st({ ...touch(0, 0), buttons: { l1: true, a: true, l5: true } }));
    const r = inst.release();
    expect(kinds(r.events)).toEqual(["off", "off", "off", "off", "ctl"]);
  });
});

describe("capture buttons", () => {
  it("R3 is skip-back; with a bumper held it toggles resample", () => {
    const inst = new Instrument();
    inst.update(st());
    expect(inst.update(st({ buttons: { r3: true } })).actions).toEqual(["skipback"]);
    expect(inst.update(st({ buttons: { r3: true } })).actions).toEqual([]); // held: once
    inst.update(st());
    const r = inst.update(st({ buttons: { r3: true, l1: true } }));
    expect(r.actions).toEqual(["resample"]);
    expect(r.events.some((e) => e.t === "on" || e.t === "drum")).toBe(false);
  });
});

describe("PADS kit", () => {
  const padsOf = (o: { events: LiveEvent[] }) => o.events.flatMap((e) => (e.t === "pad" ? [`+${e.slot}`] : e.t === "padoff" ? [`-${e.slot}`] : []));

  it("a Menu tap switches kit; View + Menu (the mode combo) doesn't", () => {
    const inst = new Instrument();
    inst.update(st());
    inst.update(st({ buttons: { menu: true } }));
    inst.update(st());
    expect(inst.settings.kit).toBe("pads");
    inst.update(st({ buttons: { view: true } }));
    inst.update(st({ buttons: { view: true, menu: true } }));
    inst.update(st());
    expect(inst.settings.kit).toBe("pads");
  });

  it("buttons hit pads 1–8, a bumper 9–16, banks on L4/R4, and let go", () => {
    const inst = new Instrument({ kit: "pads" });
    inst.update(st());
    expect(padsOf(inst.update(st({ buttons: { left: true } })))).toEqual(["+0"]);
    expect(padsOf(inst.update(st()))).toEqual(["-0"]);
    expect(padsOf(inst.update(st({ buttons: { b: true, l1: true } })))).toEqual(["+15"]);
    inst.update(st({ buttons: { l1: true } }));
    inst.update(st({ buttons: { r4: true } }));
    inst.update(st());
    expect(inst.settings.padBank).toBe(1);
    const hit = inst.update(st({ buttons: { x: true }, l2: 1 }));
    expect(hit.events).toEqual([{ t: "pad", slot: 20, vel: 1 }]);
    expect(inst.settings.pad).toBe(20);
    // A bank change while held: the release still goes to the pad that was hit.
    inst.update(st({ buttons: { x: true, l4: true } }));
    expect(padsOf(inst.update(st()))).toEqual(["-20"]);
    // No synth sounds in the PADS kit.
    expect(inst.update(st({ buttons: { a: true } })).events.some((e) => e.t === "drum")).toBe(false);
  });

  it("the right pad is a 4×4 grid: touch, slide, lift", () => {
    const inst = new Instrument({ kit: "pads" });
    inst.update(st());
    expect(padsOf(inst.update(st(touch(-0.9, 0.9))))).toEqual(["+0"]);
    expect(padsOf(inst.update(st(touch(-0.85, 0.85))))).toEqual([]);
    const slid = inst.update(st(touch(0.9, -0.9)));
    expect(padsOf(slid)).toEqual(["-0", "+15"]);
    expect(slid.haptics).toEqual([{ side: "right", strength: "tick" }]);
    expect(inst.view().padsHeld).toEqual([15]);
    expect(padsOf(inst.update(st()))).toEqual(["-15"]);
  });

  it("switching kit or leaving lets go of held pads", () => {
    const inst = new Instrument({ kit: "pads" });
    inst.update(st());
    inst.update(st({ buttons: { up: true } }));
    expect(padsOf(inst.release())).toEqual(["-1"]);
  });
});

describe("PADS kit: FX buses", () => {
  it("L3 picks the bus, L5 latches it, R2 grabs it by how far it's pulled", () => {
    const inst = new Instrument({ kit: "pads" });
    inst.update(st());
    expect(inst.settings.fxBus).toBe(2); // starts on BUS 3 (master)
    expect(inst.update(st({ buttons: { l5: true } })).fx).toEqual([{ t: "toggle", bus: 2 }]);
    inst.update(st());
    const g = inst.update(st({ r2: 0.5 })).fx!;
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ t: "grab", bus: 2 });
    expect((g[0] as { depth: number }).depth).toBeCloseTo(0.5, 1);
    expect(inst.update(st({ r2: 0.5 })).fx).toEqual([]); // no change, nothing sent
    expect(inst.update(st({ r2: 0.01 })).fx).toEqual([{ t: "grab", bus: 2, depth: 0 }]);
    expect(inst.update(st({ r2: 0 })).fx).toEqual([]);
    // Changing bus mid-grab lets go of the old one first.
    inst.update(st({ r2: 1 }));
    const sw = inst.update(st({ r2: 1, buttons: { l3: true } })).fx!;
    expect(sw[0]).toEqual({ t: "grab", bus: 2, depth: 0 });
    expect(sw[1]).toEqual({ t: "grab", bus: 3, depth: 1 });
    expect(inst.settings.fxBus).toBe(3);
  });

  it("the left pad moves the macros and commits them on lift", () => {
    const inst = new Instrument({ kit: "pads" });
    inst.update(st());
    const m = inst.update(st({ lpad: { x: -1, y: 1, touch: true, pressure: 0 } })).fx;
    expect(m).toEqual([{ t: "macros", bus: 2, a: 0, b: 1 }]);
    expect(inst.update(st({ lpad: { x: 0, y: 0, touch: true, pressure: 0 } })).fx).toEqual([{ t: "macros", bus: 2, a: 0.5, b: 0.5 }]);
    expect(inst.update(st()).fx).toEqual([{ t: "commit", bus: 2 }]);
  });

  it("leaving lets go of a held grab", () => {
    const inst = new Instrument({ kit: "pads" });
    inst.update(st());
    inst.update(st({ r2: 1 }));
    expect(inst.release().fx).toEqual([{ t: "grab", bus: 2, depth: 1 - 1 }]);
  });
});
