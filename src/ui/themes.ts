// Colour modes for the whole app.
//
// Every theme is one flat map of CSS custom properties. The component styles
// only ever say `var(--green)` / `var(--panel)` etc., so switching a theme
// is setting these on <html> — nothing else re-renders. The canvases (rain,
// lanes, meters) read the same tokens straight from this map via the theme
// store, so they recolour in step.
//
// The old variable names are kept on purpose: `--green` is "the primary
// phosphor", `--magenta` "the hot accent", `--cyan` "the cool accent",
// `--amber` "the warning", whatever hue a theme actually gives them. In the
// monochrome themes those four are one hue at different lightness, which is
// what makes a terminal readable: one colour, many brightnesses.
//
// Pure data + a tiny DOM helper; the contrast maths is unit-tested so a
// palette that fails legibility can't ship.

import { TRACK_COLORS } from "../audio/types";

export type ThemeName = "matrix" | "red" | "redblack" | "cyber" | "amber" | "btop";

/** Cycle order for the THEME button. */
export const THEME_ORDER: ThemeName[] = ["matrix", "red", "redblack", "cyber", "amber", "btop"];
export const DEFAULT_THEME: ThemeName = "matrix";

export interface ThemeTokens {
  bg: string;
  panel: string;
  "panel-hi": string;
  "panel-lo": string;
  ink: string;
  "ink-dim": string;
  /** Primary phosphor (readouts, playhead, "on"). */
  green: string;
  /** Cool accent. */
  cyan: string;
  /** Hot accent (title, lit FX, peak hold). */
  magenta: string;
  /** Warning / hint. */
  amber: string;
  danger: string;
  /** Text on a filled accent/danger button. */
  "on-accent": string;
  "bevel-light": string;
  "bevel-dark": string;
  /** btop-style box border + the title set into it. */
  box: string;
  "box-title": string;
  glow: string;
  /** Hard drop shadow under panels (DOOM extrusion); "none" to switch off. */
  extrude: string;
  /** Meter gradient, low → mid → high (btop's cpu gradient). */
  "meter-lo": string;
  "meter-mid": string;
  "meter-hi": string;
  /** Cyberpunk haze overlay opacity (0 = off) and its two bloom colours. */
  haze: string;
  "haze-a": string;
  "haze-b": string;
  /** Scanline darkness, 0..1. */
  scan: string;
  "rain-head": string;
  "rain-tail": string;
  "rain-bg": string;
  "lane-a": string;
  "lane-b": string;
  grid: string;
  "clip-bg": string;
}

export interface Theme {
  name: ThemeName;
  label: string;
  tokens: ThemeTokens;
  /** Clip / track-stripe colours, one per entry of TRACK_COLORS. */
  lanes: string[];
}

const T = (name: ThemeName, label: string, tokens: ThemeTokens, lanes: string[]): Theme => ({
  name,
  label,
  tokens,
  lanes,
});

export const THEMES: Record<ThemeName, Theme> = {
  matrix: T(
    "matrix",
    "Matrix",
    {
      bg: "#020703",
      panel: "#06130b",
      "panel-hi": "#0c2415",
      "panel-lo": "#010502",
      ink: "#c4ffd8",
      "ink-dim": "#67c78c",
      green: "#3ff08a",
      cyan: "#a8ffc9",
      magenta: "#7dffb0",
      amber: "#d2ff5c",
      danger: "#ff5a4a",
      "on-accent": "#021006",
      "bevel-light": "rgba(140, 255, 180, 0.18)",
      "bevel-dark": "rgba(0, 0, 0, 0.8)",
      box: "#1f7a45",
      "box-title": "#8dffbd",
      glow: "0 0 6px rgba(63, 240, 138, 0.45)",
      extrude: "2px 2px 0 rgba(0, 0, 0, 0.7)",
      "meter-lo": "#2fd873",
      "meter-mid": "#c6ff4d",
      "meter-hi": "#ff5a4a",
      haze: "0",
      "haze-a": "rgba(63, 240, 138, 0.10)",
      "haze-b": "rgba(0, 0, 0, 0)",
      scan: "0.16",
      "rain-head": "#c4ffd8",
      "rain-tail": "#1f9a52",
      "rain-bg": "#020703",
      "lane-a": "#051009",
      "lane-b": "#07160c",
      grid: "rgba(63, 240, 138, 0.08)",
      "clip-bg": "rgba(1, 8, 4, 0.88)",
    },
    ["#7dffb0", "#3ff08a", "#b8ffd4", "#d2ff5c", "#5fd6a0", "#9cf07a"],
  ),
  red: T(
    "red",
    "Red",
    {
      bg: "#070102",
      panel: "#150405",
      "panel-hi": "#290a0c",
      "panel-lo": "#040001",
      ink: "#ffd0cc",
      "ink-dim": "#e0807a",
      green: "#ff4d45",
      cyan: "#ffaaa3",
      magenta: "#ff7a70",
      amber: "#ffb38a",
      danger: "#fff1ee",
      "on-accent": "#1a0203",
      "bevel-light": "rgba(255, 120, 110, 0.18)",
      "bevel-dark": "rgba(0, 0, 0, 0.8)",
      box: "#8a1d1d",
      "box-title": "#ff9a92",
      glow: "0 0 6px rgba(255, 77, 69, 0.5)",
      extrude: "2px 2px 0 rgba(0, 0, 0, 0.7)",
      "meter-lo": "#b3201c",
      "meter-mid": "#ff5a45",
      "meter-hi": "#fff1ee",
      haze: "0",
      "haze-a": "rgba(255, 60, 50, 0.10)",
      "haze-b": "rgba(0, 0, 0, 0)",
      scan: "0.18",
      "rain-head": "#ffd0cc",
      "rain-tail": "#a3201c",
      "rain-bg": "#070102",
      "lane-a": "#100304",
      "lane-b": "#170506",
      grid: "rgba(255, 77, 69, 0.09)",
      "clip-bg": "rgba(8, 1, 2, 0.88)",
    },
    ["#ff7a70", "#ff4d45", "#ffaaa3", "#ffb38a", "#e0605a", "#ffd0cc"],
  ),
  redblack: T(
    "redblack",
    "Red / Black",
    {
      bg: "#000000",
      panel: "#0b0b0b",
      "panel-hi": "#1a1a1a",
      "panel-lo": "#000000",
      ink: "#eee8dd",
      "ink-dim": "#a8a196",
      green: "#ff3b3b",
      cyan: "#eee8dd",
      magenta: "#ff3b3b",
      amber: "#ff8a70",
      danger: "#ff1f1f",
      "on-accent": "#000000",
      "bevel-light": "rgba(255, 255, 255, 0.10)",
      "bevel-dark": "rgba(0, 0, 0, 0.9)",
      box: "#5a1414",
      "box-title": "#ff4d4d",
      glow: "0 0 5px rgba(255, 59, 59, 0.45)",
      extrude: "none",
      "meter-lo": "#8c8579",
      "meter-mid": "#eee8dd",
      "meter-hi": "#ff2a2a",
      haze: "0",
      "haze-a": "rgba(255, 30, 30, 0.08)",
      "haze-b": "rgba(0, 0, 0, 0)",
      scan: "0.10",
      "rain-head": "#ff4d4d",
      "rain-tail": "#3a3a3a",
      "rain-bg": "#000000",
      "lane-a": "#070707",
      "lane-b": "#0d0d0d",
      grid: "rgba(238, 232, 221, 0.06)",
      "clip-bg": "rgba(0, 0, 0, 0.9)",
    },
    ["#ff3b3b", "#eee8dd", "#b0a99d", "#ff8a70", "#e84848", "#d8d0c4"],
  ),
  cyber: T(
    "cyber",
    "Cyberpunk",
    {
      bg: "#07051a",
      panel: "#110b2a",
      "panel-hi": "#1e1545",
      "panel-lo": "#050312",
      ink: "#e8f6ff",
      "ink-dim": "#a2acdc",
      green: "#1ff2ff",
      cyan: "#1ff2ff",
      magenta: "#ff2bd6",
      amber: "#fce94f",
      danger: "#ff3b6b",
      "on-accent": "#07051a",
      "bevel-light": "rgba(31, 242, 255, 0.18)",
      "bevel-dark": "rgba(0, 0, 0, 0.75)",
      box: "#6b2fb8",
      "box-title": "#ff5fe0",
      glow: "0 0 8px rgba(31, 242, 255, 0.6)",
      extrude: "0 0 10px rgba(255, 43, 214, 0.18)",
      "meter-lo": "#1ff2ff",
      "meter-mid": "#b36bff",
      "meter-hi": "#ff2bd6",
      haze: "1",
      "haze-a": "rgba(255, 43, 214, 0.13)",
      "haze-b": "rgba(31, 242, 255, 0.10)",
      scan: "0.12",
      "rain-head": "#ff5fe0",
      "rain-tail": "#1b8fb3",
      "rain-bg": "#07051a",
      "lane-a": "#0b0822",
      "lane-b": "#100c2c",
      grid: "rgba(31, 242, 255, 0.08)",
      "clip-bg": "rgba(6, 4, 20, 0.88)",
    },
    ["#ff2bd6", "#1ff2ff", "#b36bff", "#fce94f", "#ff7ab8", "#5cffc8"],
  ),
  amber: T(
    "amber",
    "Amber",
    {
      bg: "#070400",
      panel: "#150d02",
      "panel-hi": "#281a05",
      "panel-lo": "#040200",
      ink: "#ffdca3",
      "ink-dim": "#cc9b52",
      green: "#ffb020",
      cyan: "#ffd27a",
      magenta: "#ffc44d",
      amber: "#ff8a1a",
      danger: "#ff4a2a",
      "on-accent": "#140a00",
      "bevel-light": "rgba(255, 190, 90, 0.18)",
      "bevel-dark": "rgba(0, 0, 0, 0.8)",
      box: "#7a4f10",
      "box-title": "#ffc44d",
      glow: "0 0 6px rgba(255, 176, 32, 0.45)",
      extrude: "2px 2px 0 rgba(0, 0, 0, 0.7)",
      "meter-lo": "#c98410",
      "meter-mid": "#ffc44d",
      "meter-hi": "#ff4a2a",
      haze: "0",
      "haze-a": "rgba(255, 176, 32, 0.08)",
      "haze-b": "rgba(0, 0, 0, 0)",
      scan: "0.16",
      "rain-head": "#ffdca3",
      "rain-tail": "#9a6410",
      "rain-bg": "#070400",
      "lane-a": "#0f0902",
      "lane-b": "#140c02",
      grid: "rgba(255, 176, 32, 0.08)",
      "clip-bg": "rgba(7, 4, 0, 0.88)",
    },
    ["#ffc44d", "#ffb020", "#ffdca3", "#ff8a1a", "#e0a040", "#ffd27a"],
  ),
  btop: T(
    "btop",
    "btop",
    {
      bg: "#000000",
      panel: "#0c0c0f",
      "panel-hi": "#1a1a20",
      "panel-lo": "#000000",
      ink: "#e6e6e6",
      "ink-dim": "#9c9ca6",
      green: "#50f095",
      cyan: "#5cb8ff",
      magenta: "#ff6b8a",
      amber: "#f2e266",
      danger: "#fa3c3c",
      "on-accent": "#000000",
      "bevel-light": "rgba(255, 255, 255, 0.08)",
      "bevel-dark": "rgba(0, 0, 0, 0.9)",
      box: "#3d7b46",
      "box-title": "#eeeeee",
      glow: "none",
      extrude: "none",
      "meter-lo": "#50f095",
      "meter-mid": "#f2e266",
      "meter-hi": "#fa1e1e",
      haze: "0",
      "haze-a": "rgba(0, 0, 0, 0)",
      "haze-b": "rgba(0, 0, 0, 0)",
      scan: "0",
      "rain-head": "#50f095",
      "rain-tail": "#1f4a2f",
      "rain-bg": "#000000",
      "lane-a": "#070709",
      "lane-b": "#0c0c10",
      grid: "rgba(255, 255, 255, 0.05)",
      "clip-bg": "rgba(0, 0, 0, 0.9)",
    },
    ["#ff6b8a", "#50f095", "#5cb8ff", "#f2e266", "#b48cff", "#ff9f50"],
  ),
};

export function isThemeName(v: unknown): v is ThemeName {
  return typeof v === "string" && (THEME_ORDER as string[]).includes(v);
}

export function nextTheme(current: ThemeName): ThemeName {
  const i = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(i + 1) % THEME_ORDER.length];
}

/** A track's stored colour, as the given theme draws it. Tracks keep their
 *  original TRACK_COLORS entry in the project; the theme picks the shade. */
export function laneColor(theme: Theme, stored: string): string {
  const i = (TRACK_COLORS as readonly string[]).indexOf(stored);
  return i >= 0 ? theme.lanes[i % theme.lanes.length] : stored;
}

/** Write a theme onto an element (normally <html>): data-theme + every token. */
export function applyTheme(el: HTMLElement, theme: Theme): void {
  el.dataset.theme = theme.name;
  for (const [k, v] of Object.entries(theme.tokens)) el.style.setProperty(`--${k}`, v);
  el.style.colorScheme = "dark";
}

// ---- contrast (WCAG 2 relative luminance) -----------------------------------

/** Parse #rgb / #rrggbb to 0..255 channels. Non-hex colours return null. */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`not a hex colour: ${hex}`);
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
