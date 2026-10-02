// What the app is busy loading, for the ASCII loader (ui/AsciiLoader.svelte).
//
// `withLoading` wraps a job: the loader only appears if the job is still
// running after SHOW_AFTER_MS (quick loads never flash it), and once it has
// appeared it stays at least MIN_SHOWN_MS so it reads as an animation, not a
// glitch. Nested / overlapping jobs share one loader (the newest label wins).

import { writable } from "svelte/store";

export interface LoadingState {
  /** Big label: "OPENING SESSION". */
  label: string;
  /** What exactly: a file name, "audio 3 of 12". */
  detail: string;
  /** 0..1 when known, else null (the bar bounces). */
  progress: number | null;
  /** The boot screen: full window, the app isn't up yet. */
  boot: boolean;
}

export const SHOW_AFTER_MS = 120;
export const MIN_SHOWN_MS = 450;
export const BOOT_MIN_MS = 900;

/** The loader on screen right now (null = hidden). */
export const loading = writable<LoadingState | null>(null);

let jobs = 0;
let current: LoadingState | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let shownAt = 0;
let minShown = MIN_SHOWN_MS;
let visible = false;

function show(): void {
  showTimer = null;
  if (!current) return;
  visible = true;
  shownAt = Date.now();
  loading.set({ ...current });
}

function begin(state: LoadingState, delay: number, min: number): void {
  jobs++;
  // A job that starts under the boot screen keeps the full-window look.
  current = { ...state, boot: state.boot || (visible && !!current?.boot) };
  minShown = Math.max(min, jobs > 1 ? minShown : 0);
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (visible) loading.set({ ...current });
  else if (delay <= 0) show();
  else if (!showTimer) showTimer = setTimeout(show, delay);
}

function finish(): void {
  jobs = Math.max(0, jobs - 1);
  if (jobs > 0) return;
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (!visible) {
    current = null;
    return;
  }
  const left = shownAt + minShown - Date.now();
  const hide = () => {
    hideTimer = null;
    if (jobs > 0) return;
    visible = false;
    current = null;
    loading.set(null);
  };
  if (left > 0) hideTimer = setTimeout(hide, left);
  else hide();
}

/** Progress reporter handed to a job. */
export type Report = (progress: number | null, detail?: string) => void;

const report: Report = (progress, detail) => {
  if (!current) return;
  current = { ...current, progress: progress === null ? null : Math.max(0, Math.min(1, progress)), detail: detail ?? current.detail };
  if (visible) loading.set({ ...current });
};

/** Run `job` with the loader up (if it takes long enough to be worth it). */
export async function withLoading<T>(label: string, job: (report: Report) => Promise<T>, detail = ""): Promise<T> {
  begin({ label, detail, progress: null, boot: false }, SHOW_AFTER_MS, MIN_SHOWN_MS);
  try {
    return await job(report);
  } finally {
    finish();
  }
}

/** The boot screen: up at once, for at least BOOT_MIN_MS. */
export async function withBoot<T>(job: (report: Report) => Promise<T>): Promise<T> {
  begin({ label: "BOOTING", detail: "", progress: null, boot: true }, 0, BOOT_MIN_MS);
  try {
    return await job(report);
  } finally {
    finish();
  }
}

/** Test helper. */
export function __resetLoading(): void {
  for (const t of [showTimer, hideTimer]) if (t) clearTimeout(t);
  showTimer = hideTimer = null;
  jobs = 0;
  current = null;
  visible = false;
  loading.set(null);
}
