// AudioEngine — the Web Audio runtime for ProfitPals DAW.
//
// Owns the single AudioContext, the master bus (gain -> limiter -> meter ->
// output), a shared convolution-reverb bus, and one TrackChannel per track
// (fader + 3-band EQ + voice FX + reverb send). Playback schedules an
// AudioBufferSourceNode per clip on the shared timeline, so layering is
// inherent. Recording captures mic/line input; export re-renders the whole
// project offline through the *same* TrackChannel graph.

import type { Project, Track } from "./types";
import { nextId } from "./types";
import { anySoloed, isTrackAudible } from "./edits";
import { makeImpulseResponse, type ReverbSpace } from "./reverb";
import { TrackChannel } from "./channel";

const PITCH_WORKLET_URL = `${import.meta.env.BASE_URL}pitch-processor.js`;

export class AudioEngine {
  readonly ctx: AudioContext;

  private masterGain: GainNode;
  private limiter: DynamicsCompressorNode;
  private analyser: AnalyserNode;
  private convolver: ConvolverNode;
  private reverbReturn: GainNode;
  private reverbSpace: ReverbSpace = "hall";

  private channels = new Map<string, TrackChannel>();
  private buffers = new Map<string, AudioBuffer>();
  private activeSources: AudioBufferSourceNode[] = [];

  private playStartCtxTime = 0;
  private playStartOffset = 0;
  private _isPlaying = false;

  /** Resolves once the pitch worklet has (or hasn't) loaded. */
  private pitchReady: Promise<boolean>;
  pitchAvailable = false;

  // Recording state
  private recStream: MediaStream | null = null;
  private recProcessor: ScriptProcessorNode | null = null;
  private recMonitor: GainNode | null = null;
  private recChunks: Float32Array[][] = [];
  private recSampleRate = 48000;

  private meterBuf: Uint8Array<ArrayBuffer>;

  constructor() {
    this.ctx = new AudioContext();

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;

    // A high-ratio, fast-attack compressor acts as a simple mastering limiter.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.1;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.meterBuf = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));

    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = makeImpulseResponse(this.ctx, this.reverbSpace);
    this.reverbReturn = this.ctx.createGain();
    this.reverbReturn.gain.value = 1;

    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.masterGain);

    this.pitchReady = this.loadWorklet(this.ctx);
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  private async loadWorklet(ctx: BaseAudioContext): Promise<boolean> {
    try {
      if (!("audioWorklet" in ctx) || !ctx.audioWorklet) return false;
      await ctx.audioWorklet.addModule(PITCH_WORKLET_URL);
      if (ctx === this.ctx) this.pitchAvailable = true;
      return true;
    } catch {
      return false; // WebKitGTK without AudioWorklet: voice pitch degrades gracefully
    }
  }

  /** Resume the context and make sure the pitch worklet had a chance to load. */
  async ensureRunning(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    await this.pitchReady;
  }

  setMasterGain(value: number): void {
    this.masterGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
  }

  setReverbSpace(space: ReverbSpace): void {
    this.reverbSpace = space;
    this.convolver.buffer = makeImpulseResponse(this.ctx, space);
  }

  get currentReverbSpace(): ReverbSpace {
    return this.reverbSpace;
  }

  // ---- Buffer store -------------------------------------------------------

  async decodeBytes(bytes: ArrayBuffer): Promise<{ bufferId: string; buffer: AudioBuffer }> {
    const buffer = await this.ctx.decodeAudioData(bytes.slice(0));
    return { bufferId: this.registerBuffer(buffer), buffer };
  }

  registerBuffer(buffer: AudioBuffer): string {
    const id = nextId("buf");
    this.buffers.set(id, buffer);
    return id;
  }

  getBuffer(id: string): AudioBuffer | undefined {
    return this.buffers.get(id);
  }

  // ---- Track channels -----------------------------------------------------

  private createChannel(trackId: string): TrackChannel {
    const ch = new TrackChannel(this.ctx, this.pitchAvailable);
    ch.connect(this.masterGain, this.convolver);
    this.channels.set(trackId, ch);
    return ch;
  }

  private ensureChannel(track: Track): TrackChannel {
    let ch = this.channels.get(track.id);
    if (!ch) ch = this.createChannel(track.id);
    // Self-heal: if the worklet finished loading after this channel was built
    // and the track now wants a pitched voice, rebuild it with the pitch node.
    if (track.voice.preset !== "off" && !ch.hasPitch && this.pitchAvailable) {
      ch.dispose();
      this.channels.delete(track.id);
      ch = this.createChannel(track.id);
    }
    return ch;
  }

  applyTrackParams(track: Track, projectHasSolo: boolean): void {
    this.ensureChannel(track).applyTrack(track, projectHasSolo);
  }

  removeTrack(trackId: string): void {
    const ch = this.channels.get(trackId);
    if (!ch) return;
    ch.dispose();
    this.channels.delete(trackId);
  }

  syncAll(project: Project): void {
    const hasSolo = anySoloed(project);
    for (const track of project.tracks) this.applyTrackParams(track, hasSolo);
  }

  // ---- Transport ----------------------------------------------------------

  play(project: Project, fromTime: number): void {
    this.stopSources();
    const hasSolo = anySoloed(project);
    const startAt = this.ctx.currentTime + 0.05;
    this.playStartCtxTime = startAt;
    this.playStartOffset = fromTime;

    for (const track of project.tracks) {
      const channel = this.ensureChannel(track);
      channel.applyTrack(track, hasSolo);
      if (!isTrackAudible(track, hasSolo)) continue;

      for (const clip of track.clips) {
        const clipEndT = clip.startTime + clip.duration;
        if (clipEndT <= fromTime) continue;
        const buffer = this.buffers.get(clip.bufferId);
        if (!buffer) continue;

        const when = startAt + Math.max(0, clip.startTime - fromTime);
        const into = clip.offset + Math.max(0, fromTime - clip.startTime);
        const dur = clipEndT - Math.max(fromTime, clip.startTime);

        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(channel.input);
        try {
          src.start(when, into, dur);
        } catch {
          continue;
        }
        this.activeSources.push(src);
      }
    }
    this._isPlaying = true;
  }

  stop(): void {
    this.stopSources();
    this._isPlaying = false;
  }

  private stopSources(): void {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
    }
    this.activeSources = [];
  }

  currentTime(): number {
    if (!this._isPlaying) return this.playStartOffset;
    const elapsed = this.ctx.currentTime - this.playStartCtxTime;
    return this.playStartOffset + Math.max(0, elapsed);
  }

  masterLevel(): number {
    this.analyser.getByteTimeDomainData(this.meterBuf);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = Math.abs(this.meterBuf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  // ---- Recording ----------------------------------------------------------

  async startRecording(deviceId?: string): Promise<void> {
    await this.ensureRunning();
    this.recStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    });
    const src = this.ctx.createMediaStreamSource(this.recStream);
    const processor = this.ctx.createScriptProcessor(4096, 2, 2);
    this.recChunks = [];
    this.recSampleRate = this.ctx.sampleRate;

    processor.onaudioprocess = (e) => {
      const inBuf = e.inputBuffer;
      const frame: Float32Array[] = [];
      for (let ch = 0; ch < inBuf.numberOfChannels; ch++) {
        frame.push(new Float32Array(inBuf.getChannelData(ch)));
      }
      this.recChunks.push(frame);
    };

    const monitor = this.ctx.createGain();
    monitor.gain.value = 0;
    src.connect(processor);
    processor.connect(monitor);
    monitor.connect(this.ctx.destination);
    this.recProcessor = processor;
    this.recMonitor = monitor;
  }

  async stopRecording(): Promise<AudioBuffer> {
    const chunks = this.recChunks;
    const rate = this.recSampleRate;

    if (this.recProcessor) {
      this.recProcessor.onaudioprocess = null;
      this.recProcessor.disconnect();
    }
    if (this.recMonitor) this.recMonitor.disconnect();
    if (this.recStream) this.recStream.getTracks().forEach((t) => t.stop());
    this.recProcessor = null;
    this.recMonitor = null;
    this.recStream = null;
    this.recChunks = [];

    const channelCount = chunks[0]?.length ?? 1;
    let totalFrames = 0;
    for (const f of chunks) totalFrames += f[0].length;
    totalFrames = Math.max(1, totalFrames);

    const out = this.ctx.createBuffer(channelCount, totalFrames, rate);
    for (let ch = 0; ch < channelCount; ch++) {
      const dest = out.getChannelData(ch);
      let pos = 0;
      for (const f of chunks) {
        dest.set(f[ch] ?? f[0], pos);
        pos += f[ch]?.length ?? f[0].length;
      }
    }
    return out;
  }

  get isRecording(): boolean {
    return this.recProcessor !== null;
  }

  // ---- Offline export -----------------------------------------------------

  /** Re-render the whole project (FX + reverb + master) to one AudioBuffer. */
  async renderMix(project: Project, tailSeconds = 3): Promise<AudioBuffer> {
    const hasSolo = anySoloed(project);
    let duration = 0;
    for (const t of project.tracks)
      for (const c of t.clips) duration = Math.max(duration, c.startTime + c.duration);
    duration += tailSeconds;

    const rate = project.sampleRate || this.ctx.sampleRate;
    const frames = Math.max(1, Math.ceil(duration * rate));
    const offline = new OfflineAudioContext(2, frames, rate);
    const hasPitch = await this.loadWorklet(offline);

    const masterGain = offline.createGain();
    masterGain.gain.value = 0.9;
    const limiter = offline.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    masterGain.connect(limiter);
    limiter.connect(offline.destination);

    const convolver = offline.createConvolver();
    convolver.buffer = makeImpulseResponse(offline, this.reverbSpace);
    const reverbReturn = offline.createGain();
    convolver.connect(reverbReturn);
    reverbReturn.connect(masterGain);

    for (const track of project.tracks) {
      if (!isTrackAudible(track, hasSolo)) continue;
      const channel = new TrackChannel(offline, hasPitch);
      channel.connect(masterGain, convolver);
      channel.applyTrack(track, hasSolo, /* smooth */ false);

      for (const clip of track.clips) {
        const buffer = this.buffers.get(clip.bufferId);
        if (!buffer) continue;
        const src = offline.createBufferSource();
        src.buffer = buffer;
        src.connect(channel.input);
        try {
          src.start(clip.startTime, clip.offset, clip.duration);
        } catch {
          continue;
        }
      }
    }

    return offline.startRendering();
  }
}
