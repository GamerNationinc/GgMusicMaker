// Voice-manipulation presets — the iZotope-style "digital voice" unit.
//
// Each preset maps to a pitch ratio (fed to the pitch-shift worklet) and a
// ring-modulation frequency (done natively with an oscillator -> gain.gain).
// Pure data + mapping so it can be unit-tested without any AudioContext.

export type VoicePreset = "off" | "chipmunk" | "deep" | "robot" | "alien";

export interface VoiceSettings {
  /** Pitch ratio: 1 = unchanged, 2 = octave up, 0.5 = octave down. */
  pitch: number;
  /** Ring-mod carrier frequency in Hz; 0 disables ring modulation. */
  ringHz: number;
  label: string;
}

export const VOICE_PRESETS: Record<VoicePreset, VoiceSettings> = {
  off: { pitch: 1.0, ringHz: 0, label: "Off" },
  chipmunk: { pitch: 1.5, ringHz: 0, label: "Chipmunk" },
  deep: { pitch: 0.65, ringHz: 0, label: "Deep" },
  robot: { pitch: 1.0, ringHz: 45, label: "Robot" },
  alien: { pitch: 1.35, ringHz: 90, label: "Alien" },
};

export const VOICE_PRESET_ORDER: VoicePreset[] = ["off", "chipmunk", "deep", "robot", "alien"];

/** How much the pitch worklet should mix in for a preset, given the user mix. */
export function pitchMixFor(preset: VoicePreset, userMix: number): number {
  const s = VOICE_PRESETS[preset];
  // A pitch ratio of 1 means "no shift", so keep it fully dry (no artefacts).
  return s.pitch === 1 ? 0 : userMix;
}

/** Ring-mod depth for a preset (0..1); driven by the preset, not the mix. */
export function ringDepthFor(preset: VoicePreset): number {
  return VOICE_PRESETS[preset].ringHz > 0 ? 1 : 0;
}
