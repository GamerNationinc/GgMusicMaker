import { describe, it, expect } from "vitest";
import { LOADER_COLS, QUIPS, eqLevels, loaderFrame, waveAt } from "./asciiLoader";

const frame = (over: Partial<Parameters<typeof loaderFrame>[0]> = {}) =>
  loaderFrame({ t: 5, label: "OPENING SESSION", detail: "song.ggmm", progress: null, sinceLabel: 99, ...over });

describe("the GG ASCII loader", () => {
  it("every line of every frame is exactly the box width", () => {
    for (let t = 0; t < 200; t += 7)
      for (const progress of [null, 0, 0.42, 1])
        for (const l of frame({ t, progress, detail: "x".repeat(t % 80) })) expect([...l].length, l).toBe(LOADER_COLS);
  });

  it("shows the label (typed in), the detail and a progress figure", () => {
    const text = frame({ progress: 0.42 }).join("\n");
    expect(text).toContain("OPENING SESSION");
    expect(text).toContain("song.ggmm");
    expect(text).toContain(" 42%");
    expect(frame({ sinceLabel: 2 }).join("\n")).toContain("OPEN");
    expect(frame({ sinceLabel: 2 }).join("\n")).not.toContain("OPENING SESSION");
  });

  it("moves: the tape scrolls and the frames differ", () => {
    expect(frame({ t: 1 }).join()).not.toBe(frame({ t: 2 }).join());
    expect(waveAt(0)).toBeGreaterThan(waveAt(8));
  });

  it("an unknown-length load bounces a block along the bar", () => {
    const pos = (t: number) => frame({ t }).find((l) => l.includes("▓"))!.indexOf("▓");
    expect(pos(3)).not.toBe(pos(10));
  });

  it("EQ bars stay in range; quips rotate", () => {
    for (let t = 0; t < 100; t++) for (const h of eqLevels(t)) expect(h >= 0 && h <= 6).toBe(true);
    const quip = (t: number) => QUIPS.find((q) => frame({ t }).join("\n").includes(q));
    expect(quip(0)).not.toBe(quip(28));
  });
});
