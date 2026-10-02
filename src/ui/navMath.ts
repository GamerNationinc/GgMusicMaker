// Timeline navigation maths — pure, so the feel is unit-tested:
//   zoomAround   zoom keeping one point of the song under the same pixel
//   Glide        fling momentum (touch swipes and the Deck's left pad)
//   stickCurve   dead zone + response curve for an analog stick
//   PadNav       the Deck's left trackpad as a timeline trackpad:
//                slide = scroll (content follows the thumb), lift = glide,
//                press + slide = Ableton's ruler drag (down zooms in)

/** Zoom by `factor` keeping the time under `anchorPx` (px from the view's
 *  left edge) where it is. */
export function zoomAround(
  pps: number,
  scrollLeft: number,
  anchorPx: number,
  factor: number,
  min: number,
  max: number,
): { pps: number; scrollLeft: number } {
  const t = (scrollLeft + anchorPx) / pps;
  const next = Math.min(max, Math.max(min, pps * factor));
  return { pps: next, scrollLeft: Math.max(0, t * next - anchorPx) };
}

/** Pixels per second that fit [t0, t1] into `width` px, with a small margin. */
export function fitRange(t0: number, t1: number, width: number, min: number, max: number): { pps: number; scrollLeft: number } {
  const span = Math.max(0.01, t1 - t0);
  const pps = Math.min(max, Math.max(min, (width * 0.9) / span));
  return { pps, scrollLeft: Math.max(0, t0 * pps - width * 0.05) };
}

/** Where a following view jumps when the playhead runs off it (Ableton's
 *  page turn): null while it is still on screen. */
export function followScroll(playheadPx: number, scrollLeft: number, width: number): number | null {
  if (playheadPx >= scrollLeft && playheadPx <= scrollLeft + width - 24) return null;
  return Math.max(0, playheadPx - width * 0.1);
}

/** Analog stick: dead zone, then a squared curve (fine near the centre). */
export function stickCurve(v: number, dead = 0.15): number {
  const a = Math.abs(v);
  if (a <= dead) return 0;
  const n = Math.min(1, (a - dead) / (1 - dead));
  return Math.sign(v) * n * n;
}

/** Fling momentum: feed movement while the finger is down, `release` turns
 *  the last ~80 ms into a velocity, `step` plays it out with friction. */
export class Glide {
  vx = 0;
  vy = 0;
  private samples: { t: number; dx: number; dy: number }[] = [];
  /** Velocity half-life feel: v decays as e^(−t/τ). */
  constructor(private tau = 0.33) {}

  track(tMs: number, dx: number, dy: number): void {
    this.vx = this.vy = 0;
    this.samples.push({ t: tMs, dx, dy });
    while (this.samples.length && tMs - this.samples[0].t > 100) this.samples.shift();
  }

  /** Finger up at `tMs`: start gliding (or not, if it was a slow drag). */
  release(tMs: number): boolean {
    const recent = this.samples.filter((s) => tMs - s.t <= 80);
    this.samples = [];
    if (recent.length < 2) return false;
    const span = Math.max(16, tMs - recent[0].t) / 1000;
    let dx = 0, dy = 0;
    for (const s of recent) {
      dx += s.dx;
      dy += s.dy;
    }
    this.vx = dx / span;
    this.vy = dy / span;
    if (Math.hypot(this.vx, this.vy) < 120) {
      this.vx = this.vy = 0;
      return false;
    }
    return true;
  }

  /** Advance `dt` seconds; the distance to move now. */
  step(dt: number): { dx: number; dy: number } {
    const k = Math.exp(-dt / this.tau);
    // Exact integral of v·e^(−t/τ) over dt.
    const f = this.tau * (1 - k);
    const out = { dx: this.vx * f, dy: this.vy * f };
    this.vx *= k;
    this.vy *= k;
    if (Math.hypot(this.vx, this.vy) < 15) this.vx = this.vy = 0;
    return out;
  }

  /** Start gliding at a known velocity (px/s). */
  launch(vx: number, vy: number): void {
    this.samples = [];
    this.vx = vx;
    this.vy = vy;
  }

  get moving(): boolean {
    return this.vx !== 0 || this.vy !== 0;
  }

  stop(): void {
    this.vx = this.vy = 0;
    this.samples = [];
  }
}

export interface PadInput {
  touch: boolean;
  /** −1..1, left → right. */
  x: number;
  /** −1..1, bottom → top. */
  y: number;
  /** The pad is pressed in (clicked). */
  click: boolean;
}

export interface PadMove {
  /** Scroll by (px): +dx shows later in the song, +dy shows lower layers. */
  dx: number;
  dy: number;
  /** Zoom factor this step (1 = none). */
  zoom: number;
  /** The thumb lifted after a swipe: fling with this velocity (px/s). */
  fling: { vx: number; vy: number } | null;
  /** Detents passed (for a haptic tick each). */
  ticks: number;
}

/** Pixels the timeline moves per pad unit (the pad is 2 units wide). */
export const PAD_GAIN = 520;
/** Zoom per pad unit of press-drag: e^(2.2·Δy). */
export const PAD_ZOOM = 2.2;
const TICK_PX = 90;
const TICK_ZOOM = Math.log(1.25);
/** Thumb wobble under this (pad units) is ignored. */
const JITTER = 0.004;

export class PadNav {
  private last: { x: number; y: number } | null = null;
  private glide = new Glide();
  private travel = 0;
  private zoomTravel = 0;
  /** Axis this swipe is locked to, once it clearly goes one way. */
  private axis: "x" | "y" | "free" | null = null;
  private start = { x: 0, y: 0 };

  update(p: PadInput, tMs: number): PadMove {
    const out: PadMove = { dx: 0, dy: 0, zoom: 1, fling: null, ticks: 0 };
    if (!p.touch) {
      if (this.last) {
        this.last = null;
        if (this.glide.release(tMs)) out.fling = { vx: this.glide.vx, vy: this.glide.vy };
        this.glide.stop();
      }
      return out;
    }
    if (!this.last) {
      this.last = { x: p.x, y: p.y };
      this.start = { x: p.x, y: p.y };
      this.axis = null;
      this.glide.stop();
      return out;
    }
    let mx = p.x - this.last.x;
    let my = p.y - this.last.y;
    if (Math.abs(mx) < JITTER && Math.abs(my) < JITTER) return out;
    this.last = { x: p.x, y: p.y };

    if (p.click) {
      // Ableton's ruler drag: down zooms in, sideways scrolls.
      out.zoom = Math.exp(-my * PAD_ZOOM);
      out.dx = -mx * PAD_GAIN;
      this.zoomTravel += Math.abs(my * PAD_ZOOM);
      while (this.zoomTravel >= TICK_ZOOM) {
        this.zoomTravel -= TICK_ZOOM;
        out.ticks++;
      }
      this.glide.stop();
      return out;
    }

    // Lock to an axis once the swipe clearly goes one way (2:1), so a
    // sideways swipe doesn't drift through the layers.
    if (!this.axis) {
      const tx = Math.abs(p.x - this.start.x), ty = Math.abs(p.y - this.start.y);
      if (tx + ty > 0.05) this.axis = tx > 2 * ty ? "x" : ty > 2 * tx ? "y" : "free";
    }
    if (this.axis === "x") my = 0;
    if (this.axis === "y") mx = 0;
    // Content follows the thumb: thumb right → earlier in the song; thumb up → lower layers.
    out.dx = -mx * PAD_GAIN;
    out.dy = my * PAD_GAIN * 0.6;
    this.glide.track(tMs, out.dx, out.dy);
    this.travel += Math.hypot(out.dx, out.dy);
    while (this.travel >= TICK_PX) {
      this.travel -= TICK_PX;
      out.ticks++;
    }
    return out;
  }
}
