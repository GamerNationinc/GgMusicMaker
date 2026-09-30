import { describe, it, expect } from "vitest";
import { BUTTONS, buildDeckReport, parseDeckReport, fromGamepad, hapticPulse } from "./deckpad";

// Built from values read off this Deck at rest: header, sticks' idle noise
// and the tail from one capture, the accelerometer (lying tilted: gravity on
// y and z) from another.
const REAL = "01000940" + "57530900" + "00".repeat(16) + "6eff6235692200000000000000000000" + "0000000000000000" + "f7027401e4fdc4ff" + "00000000" + "e9ff1500";

describe("Deck state report", () => {
  it("parses a captured report: nothing pressed, gravity ~1 g", () => {
    const bytes = Uint8Array.from(REAL.match(/../g)!.map((h) => parseInt(h, 16)));
    const s = parseDeckReport(bytes)!;
    expect(s.source).toBe("deck");
    expect(BUTTONS.filter((b) => s.buttons[b])).toEqual([]);
    expect(Math.hypot(...s.accel)).toBeGreaterThan(0.9);
    expect(Math.hypot(...s.accel)).toBeLessThan(1.1);
    expect(Math.abs(s.lstick.x)).toBeLessThan(0.05);
  });

  it("rejects other report types", () => {
    const r = buildDeckReport({});
    r[2] = 0x04;
    expect(parseDeckReport(r)).toBeNull();
    expect(parseDeckReport(new Uint8Array(10))).toBeNull();
  });

  it("round-trips every button on its own (both 32-bit words)", () => {
    for (const b of BUTTONS) {
      const s = parseDeckReport(buildDeckReport({ buttons: { [b]: true } }))!;
      expect(BUTTONS.filter((k) => s.buttons[k]), b).toEqual([b]);
    }
  });

  it("round-trips pads, sticks, triggers and pressure", () => {
    const s = parseDeckReport(
      buildDeckReport({
        rpad: { x: 0.5, y: -0.25, touch: true, pressure: 0.3 },
        lpad: { x: -1, y: 1, touch: false, pressure: 0 },
        lstick: { x: 0, y: 0.75 },
        rstick: { x: -0.5, y: 0 },
        l2: 0.2,
        r2: 1,
      }),
    )!;
    expect(s.rpad.touch).toBe(true);
    expect(s.lpad.touch).toBe(false);
    expect(s.rpad.x).toBeCloseTo(0.5, 3);
    expect(s.rpad.y).toBeCloseTo(-0.25, 3);
    expect(s.rpad.pressure).toBeCloseTo(0.3, 3);
    expect(s.lpad.y).toBeCloseTo(1, 3);
    expect(s.lstick.y).toBeCloseTo(0.75, 3);
    expect(s.rstick.x).toBeCloseTo(-0.5, 3);
    expect(s.l2).toBeCloseTo(0.2, 3);
    expect(s.r2).toBeCloseTo(1, 3);
  });
});

describe("Gamepad API fallback", () => {
  it("maps the standard layout, y up", () => {
    const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: i === 0 || i === 5, value: i === 7 ? 0.5 : 0, touched: false }));
    const s = fromGamepad({ buttons, axes: [0, -1, 0, 0.5] } as unknown as Gamepad);
    expect(s.source).toBe("gamepad");
    expect(s.buttons.a && s.buttons.r1 && !s.buttons.b).toBe(true);
    expect(s.r2).toBe(0.5);
    expect(s.lstick.y).toBe(1);
    expect(s.rstick.y).toBe(-0.5);
  });
});

describe("haptic pulse report", () => {
  it("encodes side, duration and count little-endian", () => {
    expect([...hapticPulse("right", 0x190, 2)]).toEqual([0x8f, 8, 1, 0x90, 0x01, 0, 0, 2, 0, 0]);
  });
});
