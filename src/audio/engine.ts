// AudioEngine — the Web Audio runtime for GgMusicMaker.
//
// Owns the single AudioContext, the master bus (gain -> limiter -> meter ->
// output, 2/6/8 channels — see master.ts), a shared convolution-reverb bus,
// and one TrackChannel per track (fader + 3-band EQ + voice synth + reverb
// send). Playback schedules an AudioBufferSourceNode per clip on the shared
// timeline, so layering is inherent. Recording captures mic/line input;
// export re-renders the whole project offline through the *same*
// TrackChannel + master graph, at the project's surround layout.

import type { Project, Track } from "./types";
import { nextId } from "./types";
import { anySoloed, isTrackAudible } from "./edits";
import { makeImpulseResponse, type ReverbSpace } from "./reverb";
import { TrackChannel } from "./channel";
import type { AudioBackend, DecodedAudio, MasterMeter } from "./backend";
import { blockLevels, logBands } from "./spectrum";
import { assembleTake, type Chunk } from "./recording";
import { buildMasterBus, deviceChannelsFor, type MasterBus } from "./master";
import { surroundChannels, type SurroundLayout } from "../fx/voice-synth";

const SYNTH_WORKLET_URL = `${import.meta.env.BASE_URL}voice-synth-processor.js`;
const PLACER_WORKLET_URL = `${import.meta.env.BASE_URL}placer-processor.js`;
const RECORDER_WORKLET_URL = `${import.meta.env.BASE_URL}recorder-processor.js`;

export class AudioEngine implements AudioBackend {
  readonly ctx: AudioContext;

  /** gain -> limiter(s) -> meters -> destination. Rebuilt when the surround
   *  layout changes; `master.input` is what channels and the reverb feed. */
  private master: MasterBus;
  private surround: SurroundLayout = "stereo";
  private masterGainValue = 0.9;
  private convolver: ConvolverNode;
  private reverbReturn: GainNode;
  private reverbSpace: ReverbSpace = "hall";

  private channels = new Map<string, TrackChannel>();
  private buffers = new Map<string, AudioBuffer>();
  private activeSources: AudioBufferSourceNode[] = [];

  private playStartCtxTime = 0;
  private playStartOffset = 0;
  private _isPlaying = false;

  /** Resolves once the synth worklet has (or hasn't) loaded. */
  private synthReady: Promise<boolean>;
  synthAvailable = false;

  // Recording state
  private recStream: MediaStream | null = null;
  /** Worklet capture node (preferred), or the ScriptProcessor fallback. */
  private recNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private recMonitor: GainNode | null = null;
  private recChunks: Chunk[] = [];
  private recSampleRate = 48000;
  /** True when the current take is being captured on the audio thread. */
  private recUsedWorklet = false;

  private meterBuf: Uint8Array<ArrayBuffer>;
  private preTimeBuf: Float32Array<ArrayBuffer>;
  private preFreqBuf: Uint8Array<ArrayBuffer>;

  constructor() {
    this.ctx = new AudioContext();

    this.master = buildMasterBus(this.ctx, 2, this.masterGainValue);
    this.meterBuf = new Uint8Array(new ArrayBuffer(this.master.post.fftSize));
    this.preTimeBuf = new Float32Array(new ArrayBuffer(4 * this.master.preTap.fftSize));
    this.preFreqBuf = new Uint8Array(new ArrayBuffer(this.master.preTap.frequencyBinCount));

    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = makeImpulseResponse(this.ctx, this.reverbSpace);
    this.reverbReturn = this.ctx.createGain();
    this.reverbReturn.gain.value = 1;
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master.input);

    this.synthReady = this.loadFxWorklets(this.ctx);
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  get isAudioReady(): boolean {
    return this.ctx.state === "running";
  }

  private async loadWorklet(ctx: BaseAudioContext, url: string): Promise<boolean> {
    try {
      if (!("audioWorklet" in ctx) || !ctx.audioWorklet) return false;
      await ctx.audioWorklet.addModule(url);
      return true;
    } catch {
      // WebKitGTK without AudioWorklet: the voice synth + placement are
      // unavailable (dry passthrough) and recording falls back to the
      // ScriptProcessor path.
      return false;
    }
  }

  /** Register the FX worklets (synth + placer) on a context. */
  private async loadFxWorklets(ctx: BaseAudioContext): Promise<boolean> {
    const ok =
      (await this.loadWorklet(ctx, SYNTH_WORKLET_URL)) && (await this.loadWorklet(ctx, PLACER_WORKLET_URL));
    if (ctx === this.ctx && ok) this.synthAvailable = true;
    return ok;
  }

  /** Resume the context and make sure the synth worklet had a chance to load. */
  async ensureRunning(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    await this.synthReady;
  }

  setMasterGain(value: number): void {
    this.masterGainValue = value;
    this.master.input.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
  }

  // ---- Surround -----------------------------------------------------------

  get currentSurround(): SurroundLayout {
    return this.surround;
  }

  /** Channels the live bus is actually running at (the device may have fewer
   *  than the layout wants — then the synth folds its field down to what
   *  there is). Export always renders the full layout. */
  get liveChannels(): number {
    return this.master.channels;
  }

  get deviceMaxChannels(): number {
    return this.ctx.destination.maxChannelCount || 2;
  }

  /** Switch the output layout. Rebuilds the master bus and every track
   *  channel when the live channel count changes, so the worklets get the
   *  new output width. The store reschedules playback afterwards. */
  setSurround(layout: SurroundLayout): boolean {
    this.surround = layout;
    const wanted = surroundChannels(layout);
    const live = deviceChannelsFor(wanted, this.deviceMaxChannels);
    if (live === this.master.channels) return false;

    const dest = this.ctx.destination;
    try {
      if (live > 2) {
        dest.channelCount = live;
        dest.channelCountMode = "explicit";
        dest.channelInterpretation = "discrete";
      } else {
        dest.channelCountMode = "explicit";
        dest.channelInterpretation = "speakers";
        dest.channelCount = 2;
      }
    } catch {
      // The device refused the width; stay where we are.
      return false;
    }

    this.stopSources();
    this.reverbReturn.disconnect();
    this.master.dispose();
    this.master = buildMasterBus(this.ctx, live, this.masterGainValue);
    this.meterBuf = new Uint8Array(new ArrayBuffer(this.master.post.fftSize));
    this.preTimeBuf = new Float32Array(new ArrayBuffer(4 * this.master.preTap.fftSize));
    this.preFreqBuf = new Uint8Array(new ArrayBuffer(this.master.preTap.frequencyBinCount));
    this.reverbReturn.connect(this.master.input);
    for (const [id, ch] of this.channels) {
      ch.dispose();
      this.channels.delete(id);
    }
    return true;
  }

  setReverbSpace(space: ReverbSpace): void {
    this.reverbSpace = space;
    this.convolver.buffer = makeImpulseResponse(this.ctx, space);
  }

  get currentReverbSpace(): ReverbSpace {
    return this.reverbSpace;
  }

  // ---- Buffer store -------------------------------------------------------

  async decodeBytes(bytes: ArrayBuffer): Promise<DecodedAudio> {
    const buffer = await this.ctx.decodeAudioData(bytes.slice(0));
    return { bufferId: this.registerBuffer(buffer), buffer };
  }

  registerBuffer(buffer: AudioBuffer): string {
    const id = nextId("buf");
    this.buffers.set(id, buffer);
    return id;
  }

  registerPcm(sampleRate: number, channels: Float32Array[]): string {
    const length = channels[0]?.length ?? 0;
    const buffer = this.ctx.createBuffer(Math.max(1, channels.length), Math.max(1, length), sampleRate);
    channels.forEach((data, c) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, c));
    return this.registerBuffer(buffer);
  }

  getBuffer(id: string): AudioBuffer | undefined {
    return this.buffers.get(id);
  }

  // ---- Track channels -----------------------------------------------------

  private createChannel(trackId: string): TrackChannel {
    const ch = new TrackChannel(this.ctx, this.synthAvailable, this.master.channels);
    ch.connect(this.master.input, this.convolver);
    this.channels.set(trackId, ch);
    return ch;
  }

  private ensureChannel(track: Track): TrackChannel {
    let ch = this.channels.get(track.id);
    if (!ch) ch = this.createChannel(track.id);
    // Self-heal: if the worklets finished loading after this channel was
    // built and the track now needs them, rebuild it with the worklet nodes.
    const needsWorklets =
      track.synth.mix > 0 || track.pan !== 0 || track.width !== 1 || track.reverbPan !== 0 || track.reverbWidth !== 1;
    if (needsWorklets && !ch.hasSynth && this.synthAvailable) {
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
      // Schedule every track, audible or not: mute/solo are just the channel
      // gain, so toggling them mid-playback must find sources already running.
      // Skipping inaudible tracks here left them silent until the next play.

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

  audioClock(): number {
    return this.ctx.currentTime;
  }

  masterLevel(): number {
    this.master.post.getByteTimeDomainData(this.meterBuf);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = Math.abs(this.meterBuf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  masterMeter(): MasterMeter {
    this.master.preTap.getFloatTimeDomainData(this.preTimeBuf);
    const { peak, rms } = blockLevels(this.preTimeBuf);
    return { peak, rms, reduction: this.master.reduction() };
  }

  masterSpectrum(out: Float32Array): Float32Array {
    this.master.preTap.getByteFrequencyData(this.preFreqBuf);
    return logBands(this.preFreqBuf, this.ctx.sampleRate, out);
  }

  // ---- Recording ----------------------------------------------------------

  /**
   * Start capturing from a mic/line input.
   *
   * Prefers an AudioWorklet, which runs on the audio thread so takes stay clean
   * while the UI is busy. Falls back to the deprecated main-thread
   * ScriptProcessorNode when the worklet can't load (older WebKitGTK), so
   * recording still works rather than failing outright.
   */
  async startRecording(deviceId?: string): Promise<void> {
    await this.ensureRunning();
    this.recStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    });
    const src = this.ctx.createMediaStreamSource(this.recStream);
    this.recChunks = [];
    this.recSampleRate = this.ctx.sampleRate;

    const useWorklet = await this.loadWorklet(this.ctx, RECORDER_WORKLET_URL);
    let node: AudioWorkletNode | ScriptProcessorNode;

    if (useWorklet) {
      const worklet = new AudioWorkletNode(this.ctx, "recorder-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      worklet.port.onmessage = (e: MessageEvent) => {
        const data = e.data as { type?: string; channels?: Float32Array[] };
        if (data?.type === "chunk" && data.channels) this.recChunks.push(data.channels);
      };
      node = worklet;
    } else {
      const processor = this.ctx.createScriptProcessor(4096, 2, 2);
      processor.onaudioprocess = (e) => {
        const inBuf = e.inputBuffer;
        const frame: Float32Array[] = [];
        for (let ch = 0; ch < inBuf.numberOfChannels; ch++) {
          frame.push(new Float32Array(inBuf.getChannelData(ch)));
        }
        this.recChunks.push(frame);
      };
      node = processor;
    }
    this.recUsedWorklet = useWorklet;

    // Route through a silent monitor gain so the node is pulled by the graph
    // without feeding the input back to the speakers (avoids feedback howl).
    const monitor = this.ctx.createGain();
    monitor.gain.value = 0;
    src.connect(node);
    node.connect(monitor);
    monitor.connect(this.ctx.destination);
    this.recNode = node;
    this.recMonitor = monitor;
  }

  /** Whether the in-flight take is using the audio-thread worklet path. */
  get recordingUsesWorklet(): boolean {
    return this.recUsedWorklet;
  }

  async stopRecording(): Promise<AudioBuffer> {
    const chunks = this.recChunks;
    const rate = this.recSampleRate;

    const node = this.recNode;
    if (node instanceof AudioWorkletNode) {
      node.port.postMessage({ type: "stop" });
      node.port.onmessage = null;
    } else if (node) {
      node.onaudioprocess = null;
    }
    node?.disconnect();
    if (this.recMonitor) this.recMonitor.disconnect();
    if (this.recStream) this.recStream.getTracks().forEach((t) => t.stop());
    this.recNode = null;
    this.recMonitor = null;
    this.recStream = null;
    this.recChunks = [];

    const { channels, frames } = assembleTake(chunks);
    const out = this.ctx.createBuffer(channels.length, Math.max(1, frames), rate);
    for (let ch = 0; ch < channels.length; ch++) {
      out.getChannelData(ch).set(channels[ch]);
    }
    return out;
  }

  get isRecording(): boolean {
    return this.recNode !== null;
  }

  // ---- Offline export -----------------------------------------------------

  /** Re-render the whole project (FX + reverb + master) to one AudioBuffer
   *  with as many channels as the project's surround layout (2, 6 or 8). */
  async renderMix(
    project: Project,
    tailSeconds = 3,
    onProgress?: (fraction: number) => void,
  ): Promise<AudioBuffer> {
    const hasSolo = anySoloed(project);
    let duration = 0;
    for (const t of project.tracks)
      for (const c of t.clips) duration = Math.max(duration, c.startTime + c.duration);
    duration += tailSeconds;

    const rate = project.sampleRate || this.ctx.sampleRate;
    const frames = Math.max(1, Math.ceil(duration * rate));
    const channels = surroundChannels(project.surround);
    const offline = new OfflineAudioContext(channels, frames, rate);
    const hasSynth = await this.loadFxWorklets(offline);

    const master = buildMasterBus(offline, channels, this.masterGainValue);
    const convolver = offline.createConvolver();
    convolver.buffer = makeImpulseResponse(offline, this.reverbSpace);
    const reverbReturn = offline.createGain();
    convolver.connect(reverbReturn);
    reverbReturn.connect(master.input);

    for (const track of project.tracks) {
      if (!isTrackAudible(track, hasSolo)) continue;
      const channel = new TrackChannel(offline, hasSynth, channels);
      channel.connect(master.input, convolver);
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

    // OfflineAudioContext has no progress event, but it can be suspended at
    // scheduled times. Pausing briefly at N checkpoints and resuming gives a
    // genuine progress figure at almost no cost.
    if (onProgress) {
      const steps = 24;
      for (let i = 1; i < steps; i++) {
        const at = (duration * i) / steps;
        offline
          .suspend(at)
          .then(() => {
            onProgress(i / steps);
            return offline.resume();
          })
          .catch(() => {
            /* suspend past the end or unsupported: progress just skips ahead */
          });
      }
    }
    const rendered = await offline.startRendering();
    onProgress?.(1);
    return rendered;
  }
}
