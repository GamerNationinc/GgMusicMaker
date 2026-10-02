// One place every way of moving round the timeline goes through: the Deck's
// left pad and stick (input/controller.ts), keys (App.svelte), the toolbar's
// zoom buttons and the timeline's own wheel / ruler-drag / touch gestures.
// Movement is batched to at most one DOM update per ~16 ms frame (the Deck
// reports at 250 Hz), and flings play out here with friction.

import { get, writable } from "svelte/store";
import { Glide } from "./navMath";

/** What Timeline.svelte gives us to drive. */
export interface NavTarget {
  /** Apply a batched move: scroll by (px), zoom by `zoom` around `anchorPx`
   *  (px from the view's left; null = the playhead if on screen, else the middle). */
  apply(dx: number, dy: number, zoom: number, anchorPx: number | null): void;
  /** Fit [t0, t1] seconds (or the whole song if omitted) into the view. */
  fit(range?: [number, number]): void;
}

let target: NavTarget | null = null;
export function registerTimeline(t: NavTarget | null): void {
  target = t;
}

/** Ableton's Follow: the view turns the page as the playhead runs off it. */
export const follow = writable(true);
/** Manual moves pause Follow for a moment, so it doesn't yank the view back. */
let holdUntil = 0;
export const followHeld = (now = Date.now()) => now < holdUntil;
function hold(): void {
  holdUntil = Date.now() + 2500;
}

let pending = { dx: 0, dy: 0, zoom: 1, anchor: null as number | null };
let timer: ReturnType<typeof setTimeout> | null = null;
const glide = new Glide();
let lastGlide = 0;

function schedule(): void {
  if (timer) return;
  timer = setTimeout(flush, 16);
}

function flush(): void {
  timer = null;
  if (glide.moving) {
    const now = performance.now();
    const d = glide.step(Math.min(0.05, (now - lastGlide) / 1000));
    lastGlide = now;
    pending.dx += d.dx;
    pending.dy += d.dy;
  }
  const p = pending;
  pending = { dx: 0, dy: 0, zoom: 1, anchor: null };
  if (target && (p.dx !== 0 || p.dy !== 0 || p.zoom !== 1)) target.apply(p.dx, p.dy, p.zoom, p.anchor);
  if (glide.moving) schedule();
}

export const nav = {
  /** Scroll by (px): +dx later in the song, +dy lower layers. */
  scrollBy(dx: number, dy = 0): void {
    hold();
    glide.stop();
    pending.dx += dx;
    pending.dy += dy;
    schedule();
  },
  /** Zoom by `factor` (>1 = in) around `anchorPx`, or the playhead / middle. */
  zoomBy(factor: number, anchorPx: number | null = null): void {
    if (factor === 1) return;
    hold();
    pending.zoom *= factor;
    if (anchorPx !== null) pending.anchor = anchorPx;
    schedule();
  },
  /** Throw the view (px/s); it glides to a stop. */
  fling(vx: number, vy: number): void {
    hold();
    glide.launch(vx, vy);
    lastGlide = performance.now();
    schedule();
  },
  stopGlide(): void {
    glide.stop();
  },
  fit(range?: [number, number]): void {
    hold();
    glide.stop();
    target?.fit(range);
  },
  toggleFollow(): boolean {
    follow.update((f) => !f);
    holdUntil = 0;
    return get(follow);
  },
};
