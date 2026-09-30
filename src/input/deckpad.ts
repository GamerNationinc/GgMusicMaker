// Controller state — one shape for every source:
//   "deck"    the Steam Deck's own 64-byte state report, read raw from hidraw
//             by the native addon (native/src/deckpad.rs): everything,
//             including trackpads, pad pressure, back buttons and the IMU.
//   "gamepad" the browser Gamepad API (any controller, or the Deck through
//             Steam Input): sticks, buttons and triggers only.
// Instrument / DJ modes map this state; they never see a source directly.

export const BUTTONS = [
  "a", "b", "x", "y",
  "l1", "r1", "l2", "r2",
  "up", "down", "left", "right",
  "view", "menu", "steam", "qam",
  "l3", "r3", "l4", "r4", "l5", "r5",
  "lpadClick", "rpadClick",
] as const;
export type Button = (typeof BUTTONS)[number];

export interface Pad {
  /** -1..1, left → right. */
  x: number;
  /** -1..1, bottom → top. */
  y: number;
  touch: boolean;
  /** Force on the pad, 0..1 (Deck only). */
  pressure: number;
}

export interface Stick {
  /** -1..1, left → right. */
  x: number;
  /** -1..1, down → up. */
  y: number;
}

export interface ControllerState {
  source: "deck" | "gamepad" | "none";
  buttons: Record<Button, boolean>;
  lpad: Pad;
  rpad: Pad;
  lstick: Stick;
  rstick: Stick;
  /** Analog triggers, 0..1. */
  l2: number;
  r2: number;
  /** Accelerometer in g (Deck: x right, y up the screen, z out of it). */
  accel: [number, number, number];
}

export function emptyState(source: ControllerState["source"] = "none"): ControllerState {
  return {
    source,
    buttons: Object.fromEntries(BUTTONS.map((b) => [b, false])) as Record<Button, boolean>,
    lpad: { x: 0, y: 0, touch: false, pressure: 0 },
    rpad: { x: 0, y: 0, touch: false, pressure: 0 },
    lstick: { x: 0, y: 0 },
    rstick: { x: 0, y: 0 },
    l2: 0,
    r2: 0,
    accel: [0, 0, 0],
  };
}

/** Report type of the Deck's full state packet (byte 2). */
export const DECK_STATE = 0x09;

// Bit positions in the 64-bit button word at byte 8 (same layout as the
// kernel's hid-steam and SDL's Deck driver).
const DECK_BITS: [Button, number][] = [
  ["r2", 0], ["l2", 1], ["r1", 2], ["l1", 3],
  ["y", 4], ["b", 5], ["x", 6], ["a", 7],
  ["up", 8], ["right", 9], ["left", 10], ["down", 11],
  ["view", 12], ["steam", 13], ["menu", 14],
  ["l5", 15], ["r5", 16],
  ["lpadClick", 17], ["rpadClick", 18],
  ["l3", 22], ["r3", 26],
  ["l4", 41], ["r4", 42], ["qam", 50],
];
const LPAD_TOUCH = 19;
const RPAD_TOUCH = 20;

const axis = (v: number) => Math.max(-1, Math.min(1, v / 32767));
const unit = (v: number) => Math.max(0, Math.min(1, v / 32767));

/** Parse one raw Deck state report; null if it isn't one. */
export function parseDeckReport(r: Uint8Array): ControllerState | null {
  if (r.length < 60 || r[2] !== DECK_STATE) return null;
  const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
  const lo = dv.getUint32(8, true);
  const hi = dv.getUint32(12, true);
  const bit = (n: number) => (n < 32 ? (lo >>> n) & 1 : (hi >>> (n - 32)) & 1) === 1;
  const s = emptyState("deck");
  for (const [b, n] of DECK_BITS) s.buttons[b] = bit(n);
  const i16 = (o: number) => dv.getInt16(o, true);
  s.lpad = { x: axis(i16(16)), y: axis(i16(18)), touch: bit(LPAD_TOUCH), pressure: unit(dv.getUint16(56, true)) };
  s.rpad = { x: axis(i16(20)), y: axis(i16(22)), touch: bit(RPAD_TOUCH), pressure: unit(dv.getUint16(58, true)) };
  s.accel = [i16(24) / 16384, i16(26) / 16384, i16(28) / 16384];
  s.l2 = unit(dv.getUint16(44, true));
  s.r2 = unit(dv.getUint16(46, true));
  s.lstick = { x: axis(i16(48)), y: axis(i16(50)) };
  s.rstick = { x: axis(i16(52)), y: axis(i16(54)) };
  return s;
}

/** Build a Deck state report (the inverse of parseDeckReport) — for tests
 *  and for driving the app without the hardware. */
export function buildDeckReport(s: Partial<Omit<ControllerState, "buttons">> & { buttons?: Partial<Record<Button, boolean>> }): Uint8Array {
  const r = new Uint8Array(64);
  const dv = new DataView(r.buffer);
  r[0] = 0x01;
  r[2] = DECK_STATE;
  r[3] = 0x40;
  let lo = 0, hi = 0;
  const set = (n: number) => {
    if (n < 32) lo |= 1 << n;
    else hi |= 1 << (n - 32);
  };
  for (const [b, n] of DECK_BITS) if (s.buttons?.[b]) set(n);
  if (s.lpad?.touch) set(LPAD_TOUCH);
  if (s.rpad?.touch) set(RPAD_TOUCH);
  dv.setUint32(8, lo >>> 0, true);
  dv.setUint32(12, hi >>> 0, true);
  const i16 = (o: number, v: number) => dv.setInt16(o, Math.round(Math.max(-1, Math.min(1, v)) * 32767), true);
  const u16 = (o: number, v: number) => dv.setUint16(o, Math.round(Math.max(0, Math.min(1, v)) * 32767), true);
  i16(16, s.lpad?.x ?? 0); i16(18, s.lpad?.y ?? 0);
  i16(20, s.rpad?.x ?? 0); i16(22, s.rpad?.y ?? 0);
  const a = s.accel ?? [0, 1, 0];
  a.forEach((g, k) => dv.setInt16(24 + 2 * k, Math.round(Math.max(-2, Math.min(2, g)) * 16384), true));
  u16(44, s.l2 ?? 0); u16(46, s.r2 ?? 0);
  i16(48, s.lstick?.x ?? 0); i16(50, s.lstick?.y ?? 0);
  i16(52, s.rstick?.x ?? 0); i16(54, s.rstick?.y ?? 0);
  u16(56, s.lpad?.pressure ?? 0); u16(58, s.rpad?.pressure ?? 0);
  return r;
}

/** Standard-mapping Gamepad API → controller state (no pads, no IMU). */
export function fromGamepad(g: Gamepad): ControllerState {
  const s = emptyState("gamepad");
  const b = (i: number) => !!g.buttons[i]?.pressed;
  const order: Button[] = ["a", "b", "x", "y", "l1", "r1", "l2", "r2", "view", "menu", "l3", "r3", "up", "down", "left", "right", "steam"];
  order.forEach((name, i) => (s.buttons[name] = b(i)));
  s.l2 = g.buttons[6]?.value ?? 0;
  s.r2 = g.buttons[7]?.value ?? 0;
  // The Gamepad API's y axes point down.
  s.lstick = { x: g.axes[0] ?? 0, y: -(g.axes[1] ?? 0) };
  s.rstick = { x: g.axes[2] ?? 0, y: -(g.axes[3] ?? 0) };
  return s;
}

/** Pad haptics: which trackpad's actuator to fire. */
export type HapticSide = "left" | "right" | "both";

/** Feature report for one haptic pulse on the Deck trackpads (the kernel's
 *  hid-steam `steam_haptic_pulse`: type 0x8f, pad 0 left / 1 right / 2 both,
 *  on-time and interval in µs, repeat count, gain in dB). */
export function hapticPulse(side: HapticSide, onUs = 400, count = 1, gainDb = 0): Uint8Array {
  const r = new Uint8Array(10);
  r[0] = 0x8f;
  r[1] = 8;
  r[2] = side === "left" ? 0 : side === "right" ? 1 : 2;
  r[3] = onUs & 0xff; r[4] = (onUs >> 8) & 0xff;
  r[5] = 0; r[6] = 0;
  r[7] = count & 0xff; r[8] = (count >> 8) & 0xff;
  r[9] = gainDb & 0xff;
  return r;
}
