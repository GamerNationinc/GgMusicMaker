import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: { scroll: [number, number][]; zoom: number[]; fling: [number, number][] } = { scroll: [], zoom: [], fling: [] };
vi.mock("../ui/timelineNav", () => ({
  nav: {
    scrollBy: (dx: number, dy = 0) => calls.scroll.push([dx, dy]),
    zoomBy: (f: number) => calls.zoom.push(f),
    fling: (vx: number, vy: number) => calls.fling.push([vx, vy]),
  },
}));

import { StudioNav } from "./studioNav";
import { emptyState } from "./deckpad";

function state(over: { lpad?: Partial<ReturnType<typeof emptyState>["lpad"]>; lstick?: { x: number; y: number }; click?: boolean }) {
  const s = emptyState("deck");
  s.lpad = { ...s.lpad, ...over.lpad };
  if (over.lstick) s.lstick = over.lstick;
  s.buttons.lpadClick = !!over.click;
  return s;
}

describe("Studio mode Deck navigation", () => {
  beforeEach(() => {
    calls.scroll = [];
    calls.zoom = [];
    calls.fling = [];
  });

  it("left pad swipes scroll the timeline and guard Steam's wheel", () => {
    const n = new StudioNav();
    n.update(state({ lpad: { touch: true, x: 0, y: 0 } }), 0);
    const ticks = n.update(state({ lpad: { touch: true, x: 0.3, y: 0 } }), 4);
    expect(calls.scroll[0][0]).toBeLessThan(0);
    expect(ticks).toEqual(["left"]);
    expect(n.padBusy(100)).toBe(true);
    n.update(state({ lpad: { touch: false } }), 8);
    expect(n.padBusy(400)).toBe(false);
  });

  it("left pad press + drag zooms", () => {
    const n = new StudioNav();
    n.update(state({ lpad: { touch: true, x: 0, y: 0 }, click: true }), 0);
    n.update(state({ lpad: { touch: true, x: 0, y: -0.3 }, click: true }), 4);
    expect(calls.zoom[0]).toBeGreaterThan(1);
  });

  it("left stick scrolls and zooms smoothly, and swallows Steam's arrow keys meanwhile", () => {
    const n = new StudioNav();
    n.update(state({ lstick: { x: 1, y: 0 } }), 0);
    n.update(state({ lstick: { x: 1, y: 0 } }), 10);
    expect(calls.scroll.at(-1)![0]).toBeCloseTo(16, 0); // 1600 px/s × 10 ms
    expect(n.stickBusy(100)).toBe(true);
    n.update(state({ lstick: { x: 0, y: 1 } }), 20);
    expect(calls.zoom.at(-1)).toBeGreaterThan(1);
    n.update(state({ lstick: { x: 0, y: 0 } }), 30);
    expect(n.stickBusy(400)).toBe(false);
  });
});
