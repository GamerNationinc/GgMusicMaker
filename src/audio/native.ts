// NativeBackend — the whole mix on the native (Rust) engine.
//
// The Rust engine (native/, hosted by electron/engine.cjs) runs its own
// real-time thread straight to ALSA/PipeWire and renders the complete graph:
// EQ + cuts, PUNCH, MORPH, VOICE SYNTH, pan/width, reverb sends, 5.1/7.1
// and the headphone 3D monitor, into a Chromium-style master compressor.
// Export runs through the same mixer, so the WAV is what you heard.
//
// This backend sends it the project and the decoded audio, drives its
// transport and reads its playhead/meters/scope. It also records: the take
// is captured by the engine on the same clock as playback and placed where
// the music was (native/src/record.rs), minus the calibrated round-trip
// latency (record-align.ts). Decoding (the page needs AudioBuffers for
// waveforms) stays with the web engine it wraps; that engine never plays in
// this mode — unless the native engine can't open a device, in which case
// everything falls back to it (recording too, if only the input fails).

import type { AudioBackend, DecodedAudio, MasterMeter } from "./backend";
import type { AudioEngine } from "./engine";
import type { Project, Track } from "./types";
import type { ReverbSpace } from "./reverb";
import type { SurroundLayout } from "../fx/voice-synth";
import { anySoloed, isTrackAudible } from "./edits";
import { punchIsActive } from "../fx/punch";
import { synthIsActive, surroundChannels } from "../fx/voice-synth";
import { morphIsActive } from "../fx/morph";
import { analyserBytes, logBands } from "./spectrum";
import { applyOffset, calibrationClicks, findLag, readLatency, writeLatency } from "./record-align";

/** What the engine hands back when a native recording stops. */
export interface NativeTake {
  sampleRate: number;
  channels: Float32Array[];
  /** Timeline position of the first sample; null = transport was stopped. */
  startTime: number | null | undefined;
  inputLatencyMs: number;
  outputLatencyMs: number;
  dropped: number;
  device: string;
}

export interface NativeEngineBridge {
  available(): Promise<{ ok: boolean; error?: string; sampleRate?: number; device?: string }>;
  load(id: string, sampleRate: number, channels: Float32Array[]): Promise<void>;
  remove(id: string): Promise<void>;
  setProject(json: string): void;
  play(from: number): void;
  stop(): void;
  status(): Promise<NativeStatus | null>;
  scope(): Promise<Float32Array | null>;
  render(project: string, ids: string[], rates: number[], data: Float32Array[][], sampleRate: number, tail: number): Promise<Float32Array[]>;
  /** Native capture (older shells don't have it: recording stays web). */
  recStart?(): Promise<{ sampleRate: number; channels: number; device: string }>;
  recStop?(): Promise<NativeTake>;
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
  deviceChannels: number;
  busChannels: number;
}

/** The mixer-facing view of a project (mirrors native/src/mixer.rs
 *  ProjectSpec): mute/solo and every power switch resolved the way
 *  audio/channel.ts resolves them, so both engines render the same graph. */
export function nativeProjectSpec(project: Project, opts: { masterGain: number; reverb: ReverbSpace; binaural: boolean }) {
  const solo = anySoloed(project);
  return {
    masterGain: opts.masterGain,
    surround: surroundChannels(project.surround),
    reverb: opts.reverb,
    binaural: opts.binaural,
    tracks: project.tracks.map((t) => {
      const audible = isTrackAudible(t, solo);
      return {
        id: t.id,
        gain: audible ? t.gain : 0,
        eq: t.fx.eq ? { ...t.eq } : null,
        punch: t.fx.punch && punchIsActive(t.punch) ? { ...t.punch } : null,
        morph: t.fx.morph && morphIsActive(t.morph) ? { ...t.morph } : null,
        synth: t.fx.synth && synthIsActive(t.synth) ? { ...t.synth } : null,
        pan: t.fx.place ? t.pan : 0,
        width: t.fx.place ? t.width : 1,
        send: audible && t.fx.reverb ? t.reverbSend : 0,
        sendPan: t.fx.reverb ? t.reverbPan : 0,
        sendWidth: t.fx.reverb ? t.reverbWidth : 1,
        clips: t.clips.map((c) => ({ buffer: c.bufferId, start: c.startTime, offset: c.offset, duration: c.duration })),
      };
    }),
  };
}

export class NativeBackend implements AudioBackend {
  private status: NativeStatus | null = null;
  private statusAt = 0;
  private polling = false;
  private masterGain = 0.9;
  private reverb: ReverbSpace = "hall";
  private surround: SurroundLayout = "stereo";
  private headphones = true;
  private lastProject: Project | null = null;
  private loaded = new Set<string>();
  private pendingLoads: Promise<unknown>[] = [];
  private wantPlaying = false;
  private scope: Float32Array | null = null;
  private scopeState = new Float32Array(512);
  private scopeBytes = new Uint8Array(512);
  /** The native engine couldn't start: behave exactly like the web engine. */
  private fallback = false;
  /** Error text when the native engine failed and the web engine took over. */
  failure: string | null = null;
  /** A native take is being captured. */
  private nativeRec = false;
  private inputDevice = "default";
  takeStart: number | null = null;
  takeNote = "";
  onFallback: (why: string) => void = () => {};

  constructor(
    private web: AudioEngine,
    private native: NativeEngineBridge,
  ) {
    this.reverb = web.currentReverbSpace;
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
    setInterval(() => {
      if (!this.fallback && this.wantPlaying) void this.native.scope().then((s) => (this.scope = s));
    }, 50);
    void this.native.available().then((a) => {
      if (!a.ok) this.useFallback(a.error ?? "unavailable");
    });
  }

  private useFallback(why: string): void {
    this.fallback = true;
    this.failure = why;
    this.onFallback(why);
    if (this.lastProject) this.web.syncAll(this.lastProject);
  }

  get sampleRate(): number {
    return this.web.sampleRate;
  }
  async ensureRunning(): Promise<void> {
    await this.web.ensureRunning(); // decoding + recording
  }
  get isAudioReady(): boolean {
    return true;
  }

  // ---- buffers: decode on the web side (waveforms), mirror PCM natively ----

  private mirror(id: string, buffer: AudioBuffer): void {
    if (this.loaded.has(id)) return;
    this.loaded.add(id);
    this.pendingLoads.push(this.native.load(id, buffer.sampleRate, channelsOf(buffer)).catch(() => this.loaded.delete(id)));
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

  private spec(project: Project): string {
    return JSON.stringify(nativeProjectSpec(project, { masterGain: this.masterGain, reverb: this.reverb, binaural: this.headphones }));
  }

  private push(project: Project): void {
    this.lastProject = project;
    this.surround = project.surround;
    if (this.fallback) {
      this.web.syncAll(project);
      return;
    }
    for (const t of project.tracks)
      for (const c of t.clips) {
        const b = this.web.getBuffer(c.bufferId);
        if (b) this.mirror(c.bufferId, b);
      }
    this.native.setProject(this.spec(project));
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
    this.web.setMasterGain(value);
    if (this.lastProject) this.push(this.lastProject);
  }
  setReverbSpace(space: ReverbSpace): void {
    this.reverb = space;
    this.web.setReverbSpace(space);
    if (this.lastProject) this.push(this.lastProject);
  }
  get currentReverbSpace(): ReverbSpace {
    return this.reverb;
  }
  setSurround(layout: SurroundLayout): boolean {
    if (this.fallback) return this.web.setSurround(layout);
    this.surround = layout;
    if (this.lastProject) this.push({ ...this.lastProject, surround: layout });
    return false; // the native bus changes width in place; nothing to reschedule
  }
  get currentSurround(): SurroundLayout {
    return this.fallback ? this.web.currentSurround : this.surround;
  }
  /** Width of the native bus (the full layout when the 3D monitor folds it). */
  get liveChannels(): number {
    if (this.fallback) return this.web.liveChannels;
    const want = surroundChannels(this.surround);
    const dev = this.status?.deviceChannels ?? 2;
    return want <= dev || this.headphones ? want : Math.min(dev, 2);
  }
  get deviceMaxChannels(): number {
    return this.fallback ? this.web.deviceMaxChannels : this.status?.deviceChannels ?? 2;
  }
  setHeadphones3d(on: boolean): boolean {
    if (this.fallback) return this.web.setHeadphones3d(on);
    this.headphones = on;
    if (this.lastProject) this.push(this.lastProject);
    return false;
  }
  get binauralMonitor(): boolean {
    if (this.fallback) return this.web.binauralMonitor;
    const want = surroundChannels(this.surround);
    return this.headphones && want > (this.status?.deviceChannels ?? 2);
  }

  // ---- transport -------------------------------------------------------------

  play(project: Project, fromTime: number): void {
    if (this.fallback) return this.web.play(project, fromTime);
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
    if (!this.scope) return out.fill(0);
    // Same analysis as the web engine's pre-limiter AnalyserNode (1024 pt).
    analyserBytes(this.scope, 1024, this.scopeState, this.scopeBytes);
    return logBands(this.scopeBytes, this.status?.sampleRate ?? this.sampleRate, out);
  }

  // ---- recording (native, web fallback) + export (native) --------------------

  /** Calibration is per output + input device pair. */
  private deviceKey(): string {
    return `${this.status?.device ?? "default"} → ${this.inputDevice}`;
  }
  get recordLatency(): number | null {
    return readLatency(this.deviceKey());
  }

  async startRecording(deviceId?: string): Promise<void> {
    this.takeStart = null;
    this.takeNote = "";
    // A specific browser device id means the web path was asked for.
    if (!this.fallback && this.native.recStart && !deviceId) {
      try {
        const info = await this.native.recStart();
        this.inputDevice = info.device;
        this.nativeRec = true;
        return;
      } catch (err) {
        // Electron wraps IPC errors: "Error invoking remote method '…': Error: why".
        const why = (err as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
        this.takeNote = ` (native capture unavailable: ${why} — recorded through the web engine)`;
      }
    }
    return this.web.startRecording(deviceId);
  }

  async stopRecording(): Promise<AudioBuffer> {
    if (!this.nativeRec) return this.web.stopRecording();
    this.nativeRec = false;
    const take = await this.native.recStop!();
    let channels = take.channels.length ? take.channels : [new Float32Array(1)];
    const notes = ["native capture"];
    if (take.startTime == null) {
      notes.push("transport stopped: placed at the playhead");
    } else {
      const ms = this.recordLatency;
      let start = take.startTime;
      if (ms != null) {
        ({ channels, start } = applyOffset(channels, start, ms / 1000, take.sampleRate));
        notes.push(`${ms.toFixed(1)} ms latency compensated`);
      } else {
        notes.push("latency not calibrated");
      }
      this.takeStart = start;
    }
    if (take.dropped > 0) notes.push(`${take.dropped} samples dropped`);
    this.takeNote = ` (${notes.join(", ")})`;
    const length = Math.max(1, channels[0].length);
    const out = new AudioBuffer({ numberOfChannels: channels.length, length, sampleRate: take.sampleRate });
    channels.forEach((c, i) => out.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    return out;
  }
  get isRecording(): boolean {
    return this.nativeRec || this.web.isRecording;
  }
  get recordingUsesWorklet(): boolean {
    return this.nativeRec || this.web.recordingUsesWorklet;
  }

  /**
   * Measure the round trip speaker → mic (or any loopback) and remember it:
   * play a click pattern, record it, and find how late the clicks landed
   * against where the engine placed the take. Needs the transport stopped;
   * the project is put back afterwards.
   */
  async calibrateLatency(): Promise<{ ms: number; confidence: number }> {
    if (this.fallback || !this.native.recStart || !this.native.recStop) throw new Error("needs the native engine");
    if (this.nativeRec || this.web.isRecording || this.wantPlaying) throw new Error("stop playback and recording first");
    const sr = this.status?.sampleRate ?? 48000;
    const seconds = 3;
    const clicks = calibrationClicks(sr, seconds);
    const id = "__calibrate";
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await this.native.load(id, sr, [clicks, clicks]);
    this.native.setProject(
      JSON.stringify({
        masterGain: 1,
        surround: 2,
        reverb: this.reverb,
        binaural: false,
        tracks: [
          { id, gain: 1, eq: null, punch: null, morph: null, synth: null, pan: 0, width: 1, send: 0, sendPan: 0, sendWidth: 1, clips: [{ buffer: id, start: 0, offset: 0, duration: seconds }] },
        ],
      }),
    );
    let started = false;
    try {
      const info = await this.native.recStart();
      started = true;
      this.inputDevice = info.device;
      await sleep(250);
      this.native.play(0);
      await sleep(seconds * 1000 + 400);
      const take = await this.native.recStop();
      started = false;
      this.native.stop();
      if (take.startTime == null) throw new Error("the engine never saw playback start");
      if (take.sampleRate !== sr) throw new Error(`input runs at ${take.sampleRate} Hz, output at ${sr} Hz`);
      const { lag, confidence } = findLag(take.channels[0] ?? new Float32Array(0), clicks, Math.round(take.startTime * sr), -Math.round(0.01 * sr), Math.round(0.5 * sr));
      if (confidence < 0.25) throw new Error("couldn't hear the clicks — turn the volume up and check the mic");
      const ms = (lag / sr) * 1000;
      writeLatency(this.deviceKey(), ms);
      return { ms, confidence };
    } finally {
      if (started) await this.native.recStop().catch(() => undefined);
      this.native.stop();
      await this.native.remove(id).catch(() => undefined);
      if (this.lastProject) this.push(this.lastProject);
    }
  }

  async renderMix(project: Project, tailSeconds = 3, onProgress?: (f: number) => void): Promise<AudioBuffer> {
    if (this.fallback) return this.web.renderMix(project, tailSeconds, onProgress);
    onProgress?.(0);
    const ids = [...new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.bufferId)))].filter((id) => this.web.getBuffer(id));
    const bufs = ids.map((id) => this.web.getBuffer(id)!);
    const rate = project.sampleRate || this.web.sampleRate;
    const spec = nativeProjectSpec(project, { masterGain: this.masterGain, reverb: this.reverb, binaural: false });
    const chans = await this.native.render(JSON.stringify(spec), ids, bufs.map((b) => b.sampleRate), bufs.map(channelsOf), rate, tailSeconds);
    const out = new AudioBuffer({ numberOfChannels: chans.length, length: chans[0].length, sampleRate: rate });
    chans.forEach((c, i) => out.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    onProgress?.(1);
    return out;
  }
}

function channelsOf(b: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, b.numberOfChannels); c++) out.push(b.getChannelData(c).slice());
  return out;
}
