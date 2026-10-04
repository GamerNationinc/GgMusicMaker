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
import type { LivePeaks } from "./liveTake";

import type { Project, Track } from "./types";
import type { ReverbSpace } from "./reverb";
import type { SurroundLayout } from "../fx/voice-synth";
import type { LiveEvent } from "./live";
import type { SkipGrab } from "./skipback";
import type { Pad } from "../pads/pads";

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
  /** Build a buffer from raw PCM (one Float32Array per channel) and register
   *  it. Used when reopening a session, so loading never depends on the
   *  WebView's media decoders. */
  registerPcm(sampleRate: number, channels: Float32Array[]): string;
  getBuffer(id: string): AudioBuffer | undefined;

  // Mixer / FX
  applyTrackParams(track: Track, projectHasSolo: boolean): void;
  syncAll(project: Project): void;
  removeTrack(trackId: string): void;
  setMasterGain(value: number): void;
  setReverbSpace(space: ReverbSpace): void;
  readonly currentReverbSpace: ReverbSpace;
  /** Change the output layout. Returns true when the live graph was rebuilt
   *  (the caller should reschedule playback). */
  setSurround(layout: SurroundLayout): boolean;
  readonly currentSurround: SurroundLayout;
  /** Channels the live output is really running at; export always renders
   *  the full layout. */
  readonly liveChannels: number;
  readonly deviceMaxChannels: number;
  /** Headphone 3D monitor: on a device with fewer channels than the layout,
   *  run the bus at full width and render it binaurally instead of folding
   *  it down. Returns true when the live graph was rebuilt. */
  setHeadphones3d(on: boolean): boolean;
  /** True while the live bus ends in the binaural monitor. */
  readonly binauralMonitor: boolean;

  // Live instrument (Instrument mode): plays whether or not the transport runs.
  live(e: LiveEvent): void;
  /** Pads the app plays itself (the metronome), kept beside the project's
   *  pads on every sync; slots outside the banks. */
  setSystemPads(pads: Pad[]): void;

  // Skip-back: the always-on ring of what the device played (skipback.ts).
  /** A marker for `skipGrab`: frames the ring has taken so far. */
  skipMark(): Promise<number>;
  /** Copy from a `skipMark` marker to now (`from` null: the last `seconds`),
   *  at most `seconds`. null when the ring isn't running. */
  skipGrab(from: number | null, seconds: number): Promise<SkipGrab | null>;

  // Transport
  play(project: Project, fromTime: number): void;
  stop(): void;
  readonly isPlaying: boolean;
  /** Playhead position in seconds. */
  currentTime(): number;
  /** The audio device's own clock, in seconds. Advances only while the
   *  device is running; used to detect dropouts (see state/load.ts). */
  audioClock(): number;
  /** Peak master level, 0..1, for the meter. */
  masterLevel(): number;
  /** Pre-limiter peak/RMS and limiter gain reduction, for the analogue meter. */
  masterMeter(): MasterMeter;
  /** Fill `out` with log-spaced spectrum bands (0..1) of the pre-limiter mix. */
  masterSpectrum(out: Float32Array): Float32Array;

  // Recording
  /** Input devices for a picker: `id` is whatever `setInputDevice` expects
   *  (a browser deviceId on the web engine, a cpal device name natively).
   *  On the web engine, labels are blank until the mic permission has been
   *  granted; pass `unlock` (from a user gesture, e.g. opening the picker)
   *  to prompt for it and get real labels back. */
  listInputDevices(unlock?: boolean): Promise<{ id: string; label: string }[]>;
  /** Which input `startRecording`/`calibrateLatency` should use next.
   *  undefined/"" = the default device. */
  setInputDevice(id: string | undefined): void;
  startRecording(): Promise<void>;
  stopRecording(): Promise<AudioBuffer>;
  readonly isRecording: boolean;
  /** The waveform of the take while it records (null when not recording). */
  liveTake(): LivePeaks | null;
  /** False when capture fell back to the deprecated main-thread path, which
   *  can drop samples under load — worth surfacing to the user. */
  readonly recordingUsesWorklet: boolean;
  /** After `stopRecording`: where the take belongs on the timeline (s), when
   *  the engine knows better than the playhead (native: from the device
   *  clocks). null/undefined = use the playhead. */
  readonly takeStart?: number | null;
  /** How the last take was captured, appended to the status line. */
  readonly takeNote?: string;
  /** Measure the recording round-trip latency (native engine). Returns ms. */
  calibrateLatency?(): Promise<{ ms: number; confidence: number }>;
  /** The calibrated latency for the current devices (ms), or null. */
  readonly recordLatency?: number | null;

  // Export
  /** Render the whole project offline. `onProgress` gets 0..1 as rendering
   *  advances, so the UI can show a real bar rather than a spinner. */
  renderMix(
    project: Project,
    tailSeconds?: number,
    onProgress?: (fraction: number) => void,
  ): Promise<AudioBuffer>;
}
