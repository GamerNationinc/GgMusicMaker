// AudioBackend — the seam between the UI and whatever actually makes sound.
//
// `src/state/store.ts` talks to the audio runtime only through this interface,
// never to a concrete class. Today the sole implementation is `AudioEngine`
// (Web Audio, in the WebView). If WebKitGTK turns out to be a poor host on the
// Steam Deck, a Rust/cpal backend behind Tauri IPC becomes a second
// implementation of this interface rather than a rewrite of the store and UI.
//
// Keep this surface small and free of Web Audio types wherever practical: the
// AudioBuffer references below are the one concession, since decoded audio has
// to be represented somehow. A native backend would swap them for opaque
// buffer handles, which is why the store always refers to buffers by `bufferId`
// and only touches raw buffers for waveform drawing.

import type { Project, Track } from "./types";
import type { ReverbSpace } from "./reverb";

export interface DecodedAudio {
  bufferId: string;
  buffer: AudioBuffer;
}

/** One frame of master-bus metering, taken *before* the limiter so the
 *  meter shows how hard the mix is hitting it. */
export interface MasterMeter {
  /** Linear peak; can exceed 1.0 when the mix is over full scale. */
  peak: number;
  /** Linear RMS. */
  rms: number;
  /** Limiter gain reduction in dB (<= 0). Non-zero means it's working. */
  reduction: number;
}

export interface AudioBackend {
  /** Device sample rate the project renders at. */
  readonly sampleRate: number;

  /** Resume/prepare the audio device. Must be called from a user gesture. */
  ensureRunning(): Promise<void>;

  /** True once the audio device is actually running. False means the host's
   *  audio stack failed to initialise (e.g. missing GStreamer plugins under
   *  WebKitGTK) — playback would be silent, so the UI should say so. */
  readonly isAudioReady: boolean;

  // Buffer store
  decodeBytes(bytes: ArrayBuffer): Promise<DecodedAudio>;
  registerBuffer(buffer: AudioBuffer): string;
  getBuffer(id: string): AudioBuffer | undefined;

  // Mixer / FX
  applyTrackParams(track: Track, projectHasSolo: boolean): void;
  syncAll(project: Project): void;
  removeTrack(trackId: string): void;
  setMasterGain(value: number): void;
  setReverbSpace(space: ReverbSpace): void;
  readonly currentReverbSpace: ReverbSpace;

  // Transport
  play(project: Project, fromTime: number): void;
  stop(): void;
  readonly isPlaying: boolean;
  /** Playhead position in seconds. */
  currentTime(): number;
  /** Peak master level, 0..1, for the meter. */
  masterLevel(): number;
  /** Pre-limiter peak/RMS and limiter gain reduction, for the analogue meter. */
  masterMeter(): MasterMeter;
  /** Fill `out` with log-spaced spectrum bands (0..1) of the pre-limiter mix. */
  masterSpectrum(out: Float32Array): Float32Array;

  // Recording
  startRecording(deviceId?: string): Promise<void>;
  stopRecording(): Promise<AudioBuffer>;
  readonly isRecording: boolean;
  /** False when capture fell back to the deprecated main-thread path, which
   *  can drop samples under load — worth surfacing to the user. */
  readonly recordingUsesWorklet: boolean;

  // Export
  /** Render the whole project offline. `onProgress` gets 0..1 as rendering
   *  advances, so the UI can show a real bar rather than a spinner. */
  renderMix(
    project: Project,
    tailSeconds?: number,
    onProgress?: (fraction: number) => void,
  ): Promise<AudioBuffer>;
}
