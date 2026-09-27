import { describe, it, expect } from "vitest";
import { THEMES, THEME_ORDER, DEFAULT_THEME, contrast, laneColor, nextTheme, isThemeName, parseHex } from "./themes";
import { TRACK_COLORS } from "../audio/types";

describe("themes", () => {
  it("every theme in the cycle exists and the cycle wraps", () => {
    for (const n of THEME_ORDER) expect(THEMES[n].name).toBe(n);
    expect(THEME_ORDER[0]).toBe(DEFAULT_THEME);
    let t = DEFAULT_THEME;
    for (let i = 0; i < THEME_ORDER.length; i++) t = nextTheme(t);
    expect(t).toBe(DEFAULT_THEME);
    expect(isThemeName("cyber")).toBe(true);
    expect(isThemeName("nope")).toBe(false);
  });

  it("every theme has the same token set", () => {
    const keys = Object.keys(THEMES[DEFAULT_THEME].tokens).sort();
    for (const n of THEME_ORDER) expect(Object.keys(THEMES[n].tokens).sort()).toEqual(keys);
  });

  it("contrast maths matches WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
    expect(parseHex("#abc")).toEqual([0xaa, 0xbb, 0xcc]);
  });

  describe.each(THEME_ORDER)("%s is legible", (name) => {
    const t = THEMES[name].tokens;
    const surfaces = [t.panel, t["panel-hi"], t["panel-lo"], t.bg];
    it("ink ≥ 7:1 on every surface", () => {
      for (const s of surfaces) expect(contrast(t.ink, s)).toBeGreaterThanOrEqual(7);
    });
    it("dim ink ≥ 4.5:1 on every surface", () => {
      for (const s of surfaces) expect(contrast(t["ink-dim"], s)).toBeGreaterThanOrEqual(4.5);
    });
    it("accents readable as text on panels (≥ 4.5:1)", () => {
      for (const k of ["green", "cyan", "magenta", "amber", "danger", "box-title"] as const)
        for (const s of surfaces) expect(contrast(t[k], s), `${k} on ${s}`).toBeGreaterThanOrEqual(4.5);
    });
    it("text on filled accent buttons ≥ 4.5:1", () => {
      for (const k of ["green", "magenta", "danger", "amber", "cyan"] as const)
        expect(contrast(t["on-accent"], t[k]), k).toBeGreaterThanOrEqual(4.5);
    });
    it("clip colours stand out from the lanes (≥ 3:1) and clip names are readable on them", () => {
      expect(THEMES[name].lanes.length).toBe(TRACK_COLORS.length);
      for (const c of THEMES[name].lanes) {
        expect(contrast(c, t["lane-a"])).toBeGreaterThanOrEqual(3);
        expect(contrast(t["on-accent"], c)).toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  it("laneColor maps stored track colours through the theme", () => {
    const red = THEMES.red;
    expect(laneColor(red, TRACK_COLORS[0])).toBe(red.lanes[0]);
    expect(laneColor(red, "#123456")).toBe("#123456");
  });
});
