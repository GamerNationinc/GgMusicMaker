// NativeBackend — playback and mixing on the native (Rust) engine.
//
// The Rust engine (native/, hosted by electron/engine.cjs) runs its own
// real-time thread straight to ALSA/PipeWire. This backend sends it the
// project and the decoded audio, drives its transport, and reads its
// playhead/meters. Everything the native engine doesn't do yet — decoding
// (for waveforms), recording, export, spectrum — stays with the web engine
// it wraps; the web engine itself never plays in this mode.
//
// Native today: clips, level/mute/solo, pan/width, EQ (+ cuts), PUNCH,
// master level + limiter + meters. Not yet: VOICE SYNTH, MORPH, reverb,
// surround — `unsupported()` names them so the UI can say so.

import type { AudioBackend, DecodedAudio, MasterMeter } from "./backend";
import type { AudioEngine } from "./engine";
import type { Project, Track } from "./types";
import type { ReverbSpace } from "./reverb";
import type { SurroundLayout } from "../fx/voice-synth";
import { anySoloed, isTrackAudible } from "./edits";
import { punchIsActive } from "../fx/punch";
import { synthIsActive } from "../fx/voice-synth";
import { morphIsActive } from "../fx/morph";

export interface NativeEngineBridge {
  available(): Promise<{ ok: boolean; error?: string; sampleRate?: number; device?: string }>;
  load(id: string, sampleRate: number, channels: Float32Array[]): Promise<void>;
  remove(id: string): Promise<void>;
  setProject(json: string): void;
  play(from: number): void;
  stop(): void;
  status(): Promise<NativeStatus | null>;
}

export interface NativeStatus {
  time: number;
  clock: number;
  playing: boolean;
  peak: number;
  rms: number;
  outPeak: number;
  reduction: number;
  sampleRate: number;
  device: string;
}

/** The mixer-facing view of a project (mirrors native/src/mixer.rs ProjectSpec). */
export function nativeProjectSpec(project: Project, masterGain: number) {
  const solo = anySoloed(project);
  return {
    masterGain,
    tracks: project.tracks.map((t) => ({
      id: t.id,
      gain: isTrackAudible(t, solo) ? t.gain : 0,
      pan: t.fx.place ? t.pan : 0,
      width: t.fx.place ? t.width : 1,
      eq: t.fx.eq ? { ...t.eq } : null,
      punch: t.fx.punch && punchIsActive(t.punch) ? { ...t.punch } : null,
      clips: t.clips.map((c) => ({ buffer: c.bufferId, start: c.startTime, offset: c.offset, duration: c.duration })),
    })),
  };
}

/** Modules a project uses that the native engine doesn't render yet. */
export function nativeUnsupported(project: Project): string[] {
  const out = new Set<string>();
  for (const t of project.tracks) {
    if (t.fx.synth && synthIsActive(t.synth)) out.add("VOICE SYNTH");
    if (t.fx.morph && morphIsActive(t.morph)) out.add("MORPH");
    if (t.fx.reverb && t.reverbSend > 0) out.add("REVERB");
  }
  if (project.surround !== "stereo") out.add("SURROUND");
  return [...out];
}

export class NativeBackend implements AudioBackend {
  private status: NativeStatus | null = null;
  private statusAt = 0;
  private polling = false;
  private masterGain = 0.9;
  private lastProject: Project | null = null;
  private loaded = new Set<string>();
  private pendingLoads: Promise<void>[] = [];
  private wantPlaying = false;
  /** The native engine couldn't start: behave exactly like the web engine. */
  private fallback = false;
  /** Called with the modules the current project uses that aren't native yet. */
  onUnsupported: (modules: string[]) => void = () => {};
  private lastUnsupported = "";

  constructor(
    private web: AudioEngine,
    private native: NativeEngineBridge,
    readonly deviceName: string,
  ) {
    const poll = async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        const s = await this.native.status();
        if (s) {
          this.status = s;
          this.statusAt = performance.now();
        }
      } finally {
        this.polling = false;
      }
    };
    setInterval(() => void (this.fallback ? undefined : poll()), 16);
    void this.native.available().then((a) => {
      if (!a.ok) this.useFallback(a.error ?? "unavailable");
    });
  }

  /** Error text when the native engine failed and the web engine took over. */
  failure: string | null = null;

  private useFallback(why: string): void {
    this.fallback = true;
    this.failure = why;
    this.onFallback(why);
    if (this.lastProject) this.web.syncAll(this.lastProject);
  }
  onFallback: (why: string) => void = () => {};

  get kind(): "native" {
    return "native";
  }

  get sampleRate(): number {
    return this.web.sampleRate;
  }
  async ensureRunning(): Promise<void> {
    await this.web.ensureRunning(); // decoding, recording, export still use it
  }
  get isAudioReady(): boolean {
    return true;
  }

  // ---- buffers: decode on the web side (waveforms), mirror PCM natively ----

  private mirror(id: string, buffer: AudioBuffer): void {
    if (this.loaded.has(id)) return;
    this.loaded.add(id);
    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice());
    const p = this.native.load(id, buffer.sampleRate, channels).catch(() => this.loaded.delete(id));
    this.pendingLoads.push(p as Promise<void>);
  }

  async decodeBytes(bytes: ArrayBuffer): Promise<DecodedAudio> {
    const d = await this.web.decodeBytes(bytes);
    this.mirror(d.bufferId, d.buffer);
    return d;
  }
  registerBuffer(buffer: AudioBuffer): string {
    const id = this.web.registerBuffer(buffer);
    this.mirror(id, buffer);
    return id;
  }
  registerPcm(sampleRate: number, channels: Float32Array[]): string {
    const id = this.web.registerPcm(sampleRate, channels);
    const b = this.web.getBuffer(id);
    if (b) this.mirror(id, b);
    return id;
  }
  getBuffer(id: string): AudioBuffer | undefined {
    return this.web.getBuffer(id);
  }

  // ---- mixer ---------------------------------------------------------------

  private push(project: Project): void {
    this.lastProject = project;
    const missing = nativeUnsupported(project).join(", ");
    if (missing !== this.lastUnsupported) {
      this.lastUnsupported = missing;
      this.onUnsupported(missing ? missing.split(", ") : []);
    }
    if (this.fallback) {
      this.web.syncAll(project);
      return;
    }
    for (const t of project.tracks) for (const c of t.clips) {
      const b = this.web.getBuffer(c.bufferId);
      if (b) this.mirror(c.bufferId, b);
    }
    this.native.setProject(JSON.stringify(nativeProjectSpec(project, this.masterGain)));
  }
  applyTrackParams(track: Track, _solo: boolean): void {
    if (!this.lastProject) return;
    this.push({ ...this.lastProject, tracks: this.lastProject.tracks.map((t) => (t.id === track.id ? track : t)) });
  }
  syncAll(project: Project): void {
    this.push(project);
  }
  removeTrack(trackId: string): void {
    this.web.removeTrack(trackId); // the native side drops it on the next sync
  }
  setMasterGain(value: number): void {
    this.masterGain = value;
    if (this.lastProject) this.push(this.lastProject);
  }
  setReverbSpace(space: ReverbSpace): void {
    this.web.setReverbSpace(space);
  }
  get currentReverbSpace(): ReverbSpace {
    return this.web.currentReverbSpace;
  }
  setSurround(layout: SurroundLayout): boolean {
    return this.web.setSurround(layout);
  }
  get currentSurround(): SurroundLayout {
    return this.web.currentSurround;
  }
  get liveChannels(): number {
    return 2;
  }
  get deviceMaxChannels(): number {
    return 2;
  }
  setHeadphones3d(on: boolean): boolean {
    return this.web.setHeadphones3d(on);
  }
  get binauralMonitor(): boolean {
    return false;
  }

  // ---- transport -------------------------------------------------------------

  play(project: Project, fromTime: number): void {
    if (this.fallback) {
      this.web.play(project, fromTime);
      return;
    }
    this.push(project);
    this.wantPlaying = true;
    // Audio handed over just now must reach the engine before it plays.
    const pending = this.pendingLoads;
    this.pendingLoads = [];
    void Promise.all(pending).then(() => {
      if (this.wantPlaying) this.native.play(fromTime);
    });
    this.status = this.status ? { ...this.status, time: fromTime, playing: true } : null;
    this.statusAt = performance.now();
  }
  stop(): void {
    if (this.fallback) return this.web.stop();
    this.wantPlaying = false;
    this.native.stop();
  }
  get isPlaying(): boolean {
    return this.fallback ? this.web.isPlaying : this.wantPlaying;
  }
  currentTime(): number {
    if (this.fallback) return this.web.currentTime();
    const s = this.status;
    if (!s) return 0;
    // Extrapolate between polls so the playhead moves every frame.
    return s.playing && this.wantPlaying ? s.time + (performance.now() - this.statusAt) / 1000 : s.time;
  }
  audioClock(): number {
    if (this.fallback) return this.web.audioClock();
    const s = this.status;
    return s ? s.clock + (performance.now() - this.statusAt) / 1000 : 0;
  }
  masterLevel(): number {
    if (this.fallback) return this.web.masterLevel();
    return Math.min(1, this.status?.outPeak ?? 0);
  }
  masterMeter(): MasterMeter {
    if (this.fallback) return this.web.masterMeter();
    const s = this.status;
    return { peak: s?.peak ?? 0, rms: s?.rms ?? 0, reduction: s?.reduction ?? 0 };
  }
  masterSpectrum(out: Float32Array): Float32Array {
    if (this.fallback) return this.web.masterSpectrum(out);
    out.fill(0); // not computed natively yet
    return out;
  }

  // ---- recording + export stay on the web engine ----------------------------

  startRecording(deviceId?: string): Promise<void> {
    return this.web.startRecording(deviceId);
  }
  stopRecording(): Promise<AudioBuffer> {
    return this.web.stopRecording();
  }
  get isRecording(): boolean {
    return this.web.isRecording;
  }
  get recordingUsesWorklet(): boolean {
    return this.web.recordingUsesWorklet;
  }
  renderMix(project: Project, tailSeconds?: number, onProgress?: (f: number) => void): Promise<AudioBuffer> {
    return this.web.renderMix(project, tailSeconds, onProgress);
  }
}
