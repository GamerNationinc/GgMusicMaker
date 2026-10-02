// Studio mode on the Deck: the timeline under your left thumb.
//
//   Left trackpad   slide = scroll the song / the layers (content follows
//                   the thumb, flick to glide), press + slide = Ableton's
//                   zoom drag (down zooms in, sideways scrolls). A haptic
//                   tick every detent.
//   Left stick      ← → scroll smoothly (further = faster), ↑ ↓ zoom in/out
//                   round the playhead.
//   D-pad           Steam types arrow keys for it: App.svelte steps the view.
//
// Steam's desktop layout keeps running alongside: it makes the left pad a
// scroll wheel (+ middle click) and the left stick arrow keys. While the raw
// pad / stick is in use those are swallowed (controller.ts wheelGuard /
// arrowGuard), so nothing moves twice. If the mouse pointer is over the FX
// rack or a dialog when the thumb lands, the pad is left to Steam (its wheel
// scrolls what's under the pointer, as everywhere else on the desktop).

import type { ControllerState, HapticSide } from "./deckpad";
import { PadNav, stickCurve } from "../ui/navMath";
import { nav } from "../ui/timelineNav";

/** Stick full right: px per second of scrolling. */
export const STICK_SCROLL = 1600;
/** Stick full up: zoom e^(2.4) ≈ ×11 per second. */
export const STICK_ZOOM = 2.4;

export class StudioNav {
  private pad = new PadNav();
  private lastT = -1;
  private padUntil = 0;
  private stickUntil = 0;
  private lastTick = -Infinity;
  private captured = false;
  private wasTouch = false;
  private pointer: { x: number; y: number } | null = null;

  pointerAt(x: number, y: number): void {
    this.pointer = { x, y };
  }

  padBusy(now: number): boolean {
    return now < this.padUntil;
  }

  stickBusy(now: number): boolean {
    return now < this.stickUntil;
  }

  reset(): void {
    this.pad = new PadNav();
    this.captured = false;
    this.wasTouch = false;
    this.lastT = -1;
  }

  /** Should a thumb landing now drive the timeline? Not when the pointer is
   *  over something else that scrolls. */
  private wantsPad(): boolean {
    if (!this.pointer || typeof document === "undefined") return true;
    const el = document.elementFromPoint(this.pointer.x, this.pointer.y);
    return !el?.closest(".rack, [role=dialog]");
  }

  /** One controller state; returns the pads to tick. */
  update(s: ControllerState, now: number): HapticSide[] {
    const dt = this.lastT >= 0 ? Math.min(0.05, (now - this.lastT) / 1000) : 0;
    this.lastT = now;
    const ticks: HapticSide[] = [];

    if (s.source === "deck") {
      const lp = s.lpad;
      if (lp.touch && !this.wasTouch) this.captured = this.wantsPad();
      this.wasTouch = lp.touch;
      if (this.captured) {
        this.padUntil = now + 300;
        const m = this.pad.update({ touch: lp.touch, x: lp.x, y: lp.y, click: s.buttons.lpadClick }, now);
        if (m.dx !== 0 || m.dy !== 0) nav.scrollBy(m.dx, m.dy);
        if (m.zoom !== 1) nav.zoomBy(m.zoom);
        if (m.fling) nav.fling(m.fling.vx, m.fling.vy);
        if (m.ticks > 0 && now - this.lastTick > 35) {
          this.lastTick = now;
          ticks.push("left");
        }
        if (!lp.touch) this.captured = false;
      }
    }

    if (Math.abs(s.lstick.x) > 0.1 || Math.abs(s.lstick.y) > 0.1) this.stickUntil = now + 250;
    const sx = stickCurve(s.lstick.x);
    const sy = stickCurve(s.lstick.y);
    if (dt > 0 && sx !== 0) nav.scrollBy(sx * STICK_SCROLL * dt, 0);
    if (dt > 0 && sy !== 0) nav.zoomBy(Math.exp(sy * STICK_ZOOM * dt));
    return ticks;
  }
}
