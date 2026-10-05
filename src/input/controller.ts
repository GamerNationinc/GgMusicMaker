// The controller loop and the app mode (docs/deck-dual-mode.md).
//
// Input comes from the raw Deck controller when the desktop shell can open
// it (electron/deckpad.cjs), otherwise from the Gamepad API. Every state goes
// through `handle`: View + Menu together cycles the mode from anywhere; in
// Instrument mode the state drives the live instrument.
//
// Studio mode drives the timeline (studioNav.ts): the left pad is a
// trackpad for it and the left stick scrolls / zooms, so every mode takes
// all 250 reports a second.

import { get, writable } from "svelte/store";
import { engine, status, transport, startRecording, stopRecording, togglePlay } from "../state/store";
import { emptyState, fromGamepad, hapticPulse, parseDeckReport, type ControllerState } from "./deckpad";
import { Instrument, type Haptic, type InstrumentView, type Output } from "./instrument";
import { StudioNav } from "./studioNav";

export type AppMode = "studio" | "instrument" | "dj";

export const MODES: { id: AppMode; label: string; ready: boolean }[] = [
  { id: "studio", label: "Studio", ready: true },
  { id: "instrument", label: "Instrument", ready: true },
  { id: "dj", label: "DJ", ready: false },
];

export const mode = writable<AppMode>("studio");

/** Where controller input comes from right now. */
export const controllerSource = writable<ControllerState["source"]>("none");

/** True while the raw Deck controller drives a performance mode. Steam's
 *  desktop layout also turns the same buttons into mouse clicks and keys
 *  (R2 = left click, right pad = cursor), so the UI ignores mouse input and
 *  keys while this is set; the touchscreen keeps working. */
export const deckPerforming = writable(false);

/** Wrap a click handler so it ignores mouse clicks while the Deck is
 *  performing (they're Steam's R2 → left-click emulation, not the user
 *  aiming at the button); touch and pen always go through. */
export function screenOnly<E extends Event>(fn: (e: E) => void): (e: E) => void {
  return (e) => {
    if (get(deckPerforming) && (e as unknown as PointerEvent).pointerType === "mouse") return;
    fn(e);
  };
}

const instrument = new Instrument();
const studio = new StudioNav();

/** True while the Deck's left pad is driving the timeline (and a moment
 *  after): Steam's desktop layout turns that pad into a scroll wheel too,
 *  and its wheel events must not scroll the timeline a second time. */
export const wheelGuard = (): boolean => studio.padBusy(performance.now());

/** True while the raw left stick is moving the timeline: Steam also types
 *  arrow keys for it, which the key handler must then ignore. */
export const arrowGuard = (): boolean => studio.stickBusy(performance.now());
export const instrumentView = writable<InstrumentView>(instrument.view());

interface DeckBridge {
  start(): Promise<{ ok: boolean; error?: string; fake?: boolean }>;
  stop(): void;
  detail(d: "full" | "buttons"): void;
  feature(bytes: Uint8Array): void;
  onReport(cb: (report: Uint8Array) => void): () => void;
  onPresence(cb: (present: boolean) => void): () => void;
}

const deckBridge = (): DeckBridge | undefined =>
  (globalThis as { ggmmNative?: { deckpad?: DeckBridge } }).ggmmNative?.deckpad;

let deck: DeckBridge | undefined;
let deckOk = false;
let prev = emptyState();
let started = false;

/** Start listening. Called once when the app mounts. */
export function startController(): void {
  if (started) return;
  started = true;
  deck = deckBridge();
  if (deck) {
    deck.onReport((r) => {
      const s = parseDeckReport(r);
      if (s) handle(s);
    });
    deck.onPresence((present) => {
      deckOk = present;
      controllerSource.set(present ? "deck" : "none");
      updatePerforming();
      if (!present) send(instrument.release());
      status.set(present ? "Deck controller back." : "Deck controller lost — notes released.");
    });
    void deck.start().then((r) => {
      deckOk = r.ok;
      if (r.ok) {
        controllerSource.set("deck");
        deck!.detail("full");
      }
      updatePerforming();
    });
  }
  if (typeof window !== "undefined") {
    window.addEventListener("gamepadconnected", pollGamepads);
    // Where the mouse is (the Deck's right pad moves it): the left pad only
    // takes over the timeline when the pointer isn't over something else
    // that scrolls (the FX rack, a dialog) — there Steam's wheel keeps working.
    window.addEventListener("pointermove", (e) => studio.pointerAt(e.clientX, e.clientY), { passive: true });
    // Steam maps a left-pad click to the middle mouse button.
    const swallow = (e: MouseEvent) => {
      if (e.button === 1 && wheelGuard()) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    for (const t of ["mousedown", "mouseup", "auxclick"] as const) window.addEventListener(t, swallow, true);
  }
}

// ---- Gamepad API (no raw Deck access: browser, other controllers) ----------

let polling = false;
function pollGamepads(): void {
  if (polling) return;
  polling = true;
  const tick = () => {
    const pad = deckOk ? null : navigator.getGamepads().find((g) => g && g.mapping === "standard");
    if (pad) {
      controllerSource.set("gamepad");
      handle(fromGamepad(pad));
    } else if (!deckOk && get(controllerSource) === "gamepad") {
      controllerSource.set("none");
    }
    if (navigator.getGamepads().some(Boolean)) requestAnimationFrame(tick);
    else polling = false;
  };
  requestAnimationFrame(tick);
}

// ---- the loop --------------------------------------------------------------

/** View + Menu was used as the mode combo since both were last up: their
 *  releases then don't count as taps. */
let comboUsed = false;

/** Instrument mode: Menu tapped = record the Deck (again = stop the take),
 *  View tapped = play / stop. A tap counts on release, so pressing both
 *  for the mode switch never starts either. */
export function transportTaps(prev: ControllerState, s: ControllerState, comboHeld: boolean): { rec: boolean; play: boolean } {
  return {
    rec: !comboHeld && prev.buttons.menu && !s.buttons.menu && !s.buttons.view,
    play: !comboHeld && prev.buttons.view && !s.buttons.view && !s.buttons.menu,
  };
}

/** Record or stop recording what's played on the Deck. */
export function toggleDeckRecording(): void {
  if (get(transport).isRecording) void stopRecording();
  else void startRecording("deck");
}

function handle(s: ControllerState): void {
  const combo = s.buttons.view && s.buttons.menu;
  const was = prev.buttons.view && prev.buttons.menu;
  const last = prev;
  prev = s;
  if (combo && !was) {
    comboUsed = true;
    setMode(get(mode) === "studio" ? "instrument" : "studio");
    return;
  }
  const taps = transportTaps(last, s, comboUsed);
  if (!s.buttons.view && !s.buttons.menu) comboUsed = false;
  if (get(mode) === "instrument") {
    if (taps.rec) toggleDeckRecording();
    else if (taps.play) togglePlay();
    send(instrument.update(s));
    scheduleView();
  } else if (get(mode) === "studio") {
    for (const side of studio.update(s, performance.now())) haptic({ side, strength: "tick" });
  }
}

function send(out: Output): void {
  for (const e of out.events) engine.live(e);
  for (const h of out.haptics) haptic(h);
}

function haptic(h: Haptic): void {
  if (!deckOk || !deck) return;
  deck.feature(h.strength === "tick" ? hapticPulse(h.side, 300) : hapticPulse(h.side, 700, 2));
}

let viewQueued = false;
/** The UI follows at most ~60 times a second (a timer, not rAF: hidden and
 *  background windows don't run frames, and the sound must not depend on
 *  the screen anyway — only the picture is throttled). */
function scheduleView(): void {
  if (viewQueued) return;
  viewQueued = true;
  setTimeout(() => {
    viewQueued = false;
    instrumentView.set(instrument.view());
  }, 16);
}

function updatePerforming(): void {
  deckPerforming.set(deckOk && get(mode) !== "studio");
}

export function setMode(m: AppMode): void {
  const from = get(mode);
  if (m === from) return;
  if (!MODES.find((x) => x.id === m)?.ready) {
    status.set("DJ mode is the next milestone — not built yet.");
    return;
  }
  if (from === "instrument") send(instrument.release());
  mode.set(m);
  updatePerforming();
  studio.reset();
  if (m === "instrument") {
    void engine.ensureRunning();
    // Nothing keeps focus: Steam's desktop layout sends Enter/Space for
    // face buttons, which would "click" whatever button had it.
    (document.activeElement as HTMLElement | null)?.blur?.();
    instrumentView.set(instrument.view());
    status.set(
      get(controllerSource) === "none"
        ? "Instrument mode — no controller found: tap the grid and pads on screen."
        : "Instrument mode — right pad plays, ABXY drums (hold L1/R1 for chords). View + Menu to leave.",
    );
  } else {
    status.set("Studio mode.");
  }
}

// ---- touchscreen / mouse playing (no controller, or just by hand) ----------

let touchIds = 1_000_000;

/** Start a note from the screen; returns the id to release it with. */
export function screenNoteOn(note: number, vel = 0.8): number {
  const id = touchIds++;
  void engine.ensureRunning();
  engine.live({ t: "on", id, note, vel, patch: instrument.settings.patch });
  return id;
}

export function screenNoteOff(id: number): void {
  engine.live({ t: "off", id });
}

export function screenDrum(kind: number): void {
  void engine.ensureRunning();
  engine.live({ t: "drum", kind, vel: 0.85 });
}

/** Change an instrument setting from the screen. */
export function setInstrument(p: Partial<Instrument["settings"]>): void {
  Object.assign(instrument.settings, p);
  instrumentView.set(instrument.view());
}

/** Test hook: the instrument's current settings. */
export const instrumentSettings = () => ({ ...instrument.settings });
