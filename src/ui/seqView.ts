// UI state of the PADS kit's sequencer screens (not saved).
import { writable } from "svelte/store";

/** The left panel: the pad grid, or the step sequencer. */
export const padsView = writable<"pads" | "steps">("pads");
/** The note being edited in STEPS (its id), or null. */
export const selectedNote = writable<string | null>(null);
/** Which 16 steps of a longer pattern are on screen. */
export const stepPage = writable(0);
