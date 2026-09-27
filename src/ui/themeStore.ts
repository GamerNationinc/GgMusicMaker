// The active colour mode: a Svelte store, persisted per machine, applied to
// <html> as CSS custom properties. Canvases subscribe to `theme` and read
// the token map directly (no getComputedStyle round-trip per frame).

import { writable, get } from "svelte/store";
import { THEMES, DEFAULT_THEME, applyTheme, isThemeName, nextTheme, type Theme } from "./themes";

const KEY = "ggmm.theme";

function readSaved(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (isThemeName(v)) return THEMES[v];
  } catch {
    /* storage blocked: default theme */
  }
  return THEMES[DEFAULT_THEME];
}

export const theme = writable<Theme>(readSaved());

/** Apply the saved theme before the app mounts (no flash of the default). */
export function initTheme(): void {
  applyTheme(document.documentElement, get(theme));
}

export function setTheme(t: Theme): void {
  theme.set(t);
  applyTheme(document.documentElement, t);
  try {
    localStorage.setItem(KEY, t.name);
  } catch {
    /* still switches for this run */
  }
}

/** Step to the next theme; returns it (for the status line). */
export function cycleTheme(): Theme {
  const t = THEMES[nextTheme(get(theme).name)];
  setTheme(t);
  return t;
}
