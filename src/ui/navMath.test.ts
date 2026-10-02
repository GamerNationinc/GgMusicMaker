import { describe, it, expect } from "vitest";
import { Glide, PadNav, PAD_GAIN, fitRange, followScroll, stickCurve, zoomAround } from "./navMath";

describe("timeline navigation maths", () => {
  it("zooming keeps the anchored moment under the same pixel", () => {
    const r = zoomAround(100, 500, 300, 2, 2, 4000);
    expect(r.pps).toBe(200);
    // t = (500 + 300) / 100 = 8 s → 8 × 200 − 300
    expect(r.scrollLeft).toBe(1300);
    expect((r.scrollLeft + 300) / r.pps).toBe(8);
  });

  it("zoom stops at the limits and never scrolls before 0", () => {
    expect(zoomAround(3000, 0, 100, 10, 2, 4000).pps).toBe(4000);
    expect(zoomAround(100, 10, 400, 0.01, 2, 4000)).toEqual({ pps: 2, scrollLeft: 0 });
  });

  it("fits a range into the view with a margin", () => {
    const r = fitRange(10, 20, 1000, 2, 4000);
    expect(r.pps).toBe(90);
    expect(r.scrollLeft).toBe(850);
  });

  it("follow turns the page only when the playhead leaves the view", () => {
    expect(followScroll(500, 0, 1000)).toBeNull();
    expect(followScroll(990, 0, 1000)).toBe(890);
    expect(followScroll(100, 400, 1000)).toBe(0);
  });

  it("the stick has a dead zone and a gentle centre", () => {
    expect(stickCurve(0.1)).toBe(0);
    expect(stickCurve(1)).toBe(1);
    expect(stickCurve(-1)).toBe(-1);
    expect(Math.abs(stickCurve(0.5))).toBeLessThan(0.5);
  });

  it("a flick glides on and comes to rest; a slow drag doesn't glide", () => {
    const g = new Glide();
    for (let t = 0; t <= 80; t += 16) g.track(t, 20, 0); // 20 px / 16 ms ≈ 1250 px/s
    expect(g.release(80)).toBe(true);
    expect(g.vx).toBeGreaterThan(900);
    let total = 0;
    for (let i = 0; i < 300 && g.moving; i++) total += g.step(1 / 60).dx;
    expect(g.moving).toBe(false);
    expect(total).toBeGreaterThan(250);
    expect(total).toBeLessThan(600);
    const slow = new Glide();
    for (let t = 0; t <= 80; t += 16) slow.track(t, 1, 0);
    expect(slow.release(80)).toBe(false);
  });
});

describe("the Deck's left pad as a timeline trackpad", () => {
  const at = (x: number, y: number, click = false) => ({ touch: true, x, y, click });

  it("landing doesn't move; sliding moves the content with the thumb", () => {
    const p = new PadNav();
    expect(p.update(at(0, 0), 0)).toMatchObject({ dx: 0, dy: 0 });
    const m = p.update(at(0.1, 0), 4);
    expect(m.dx).toBeCloseTo(-0.1 * PAD_GAIN); // thumb right → earlier in the song
    expect(m.dy).toBe(0);
  });

  it("a sideways swipe locks out vertical drift", () => {
    const p = new PadNav();
    p.update(at(0, 0), 0);
    p.update(at(0.1, 0.01), 4);
    const m = p.update(at(0.2, 0.04), 8);
    expect(m.dy).toBe(0);
    expect(m.dx).toBeLessThan(0);
  });

  it("press + slide down zooms in, up zooms out (Ableton's ruler drag)", () => {
    const p = new PadNav();
    p.update(at(0, 0, true), 0);
    expect(p.update(at(0, -0.2, true), 4).zoom).toBeGreaterThan(1);
    expect(p.update(at(0, 0.2, true), 8).zoom).toBeLessThan(1);
  });

  it("a flick off the pad flings; ticks come every detent", () => {
    const p = new PadNav();
    p.update(at(-0.8, 0), 0);
    let ticks = 0;
    for (let i = 1; i <= 10; i++) ticks += p.update(at(-0.8 + i * 0.12, 0), i * 4).ticks;
    expect(ticks).toBeGreaterThanOrEqual(5);
    const up = p.update({ touch: false, x: 0, y: 0, click: false }, 44);
    expect(up.fling?.vx).toBeLessThan(-1000);
  });

  it("thumb jitter at rest moves nothing", () => {
    const p = new PadNav();
    p.update(at(0.3, 0.3), 0);
    expect(p.update(at(0.302, 0.299), 4)).toMatchObject({ dx: 0, dy: 0, zoom: 1, ticks: 0 });
  });
});
