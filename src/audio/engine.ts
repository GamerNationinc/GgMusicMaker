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
import type { LiveEvent } from "./live";
import { TrackChannel } from "./channel";
import type { AudioBackend, DecodedAudio, MasterMeter } from "./backend";
import { blockLevels, logBands } from "./spectrum";
import { assembleTake, type Chunk } from "./recording";
import { LivePeaks } from "./liveTake";
import { WebSampler } from "./sampler";
import { RING_SECONDS, songTimeAt, type PlaySpan, type SkipGrab } from "./skipback";
import { buildMasterBus, deviceChannelsFor, type MasterBus } from "./master";
import { surroundChannels, type SurroundLayout } from "../fx/voice-synth";
import { punchIsActive } from "../fx/punch";
import { bassIsActive } from "../fx/bass";

const SYNTH_WORKLET_URL = `${import.meta.env.BASE_URL}voice-synth-processor.js`;
const PLACER_WORKLET_URL = `${import.meta.env.BASE_URL}placer-processor.js`;
const PUNCH_CORE_URL = `${import.meta.env.BASE_URL}punch-core.js`;
const PUNCH_WORKLET_URL = `${import.meta.env.BASE_URL}punch-processor.js`;
const BASS_CORE_URL = `${import.meta.env.BASE_URL}bass-core.js`;
const BASS_WORKLET_URL = `${import.meta.env.BASE_URL}bass-processor.js`;
const MORPH_WORKLET_URL = `${import.meta.env.BASE_URL}morph-processor.js`;
const BINAURAL_WORKLET_URL = `${import.meta.env.BASE_URL}binaural-processor.js`;
const LIVE_WORKLET_URL = `${import.meta.env.BASE_URL}live-processor.js`;
const RECORDER_WORKLET_URL = `${import.meta.env.BASE_URL}recorder-processor.js`;
const SKIPBACK_WORKLET_URL = `${import.meta.env.BASE_URL}skipback-processor.js`;

export class AudioEngine implements AudioBackend {
  readonly ctx: AudioContext;

  /** gain -> limiter(s) -> meters -> destination. Rebuilt when the surround
   *  layout changes; `master.input` is what channels and the reverb feed. */
  private master: MasterBus;
  private surround: SurroundLayout = "stereo";
  /** Render a wider-than-device bus binaurally (see master.ts). */
  private headphones3d = true;
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
  private recLive: LivePeaks | null = null;
  private recSampleRate = 48000;
  /** True when the current take is being captured on the audio thread. */
  private recUsedWorklet = false;
  /** deviceId (from `listInputDevices`) to record from; "" = default mic. */
  private inputDeviceId = "";

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

  /** Register the FX worklets (synth + morph + placer, and the binaural
   *  monitor on the live context) on a context. */
  private async loadFxWorklets(ctx: BaseAudioContext): Promise<boolean> {
    const ok =
      (await this.loadWorklet(ctx, SYNTH_WORKLET_URL)) &&
      (await this.loadWorklet(ctx, MORPH_WORKLET_URL)) &&
      // The core first: punch-processor finds PunchCore on the shared global.
      (await this.loadWorklet(ctx, PUNCH_CORE_URL)) &&
      (await this.loadWorklet(ctx, PUNCH_WORKLET_URL)) &&
      (await this.loadWorklet(ctx, BASS_CORE_URL)) &&
      (await this.loadWorklet(ctx, BASS_WORKLET_URL)) &&
      (await this.loadWorklet(ctx, PLACER_WORKLET_URL));
    if (ctx === this.ctx) {
      if (ok) this.synthAvailable = true;
      this.binauralAvailable = await this.loadWorklet(ctx, BINAURAL_WORKLET_URL);
      this.liveAvailable = await this.loadWorklet(ctx, LIVE_WORKLET_URL);
      this.skipLoaded = await this.loadWorklet(ctx, SKIPBACK_WORKLET_URL);
      if (this.skipWanted) this.startSkipBack();
    }
    return ok;
  }

  /** Context time at which song time 0 plays (BASS MOD's LFO lock). */
  private songOrigin = 0;
  private binauralAvailable = false;
  private liveAvailable = false;
  /** The live instrument (public/live-processor.js): output 0 dry → master,
   *  output 1 → the reverb. Built on the first event. */
  private liveNode: AudioWorkletNode | null = null;

  /** The sampler pads (sampler.ts): plain Web Audio nodes, no worklet. */
  private sampler: WebSampler | null = null;

  private pads(): WebSampler {
    if (!this.sampler) this.sampler = new WebSampler(this.ctx, this.master.input, (id) => this.buffers.get(id));
    return this.sampler;
  }

  /** Sampler voices sounding for a pad (tests). */
  padVoices(slot: number): number {
    return this.sampler?.voicesOf(slot) ?? 0;
  }

  live(e: LiveEvent): void {
    if (e.t === "pad") return this.pads().trigger(e.slot, e.vel);
    if (e.t === "padoff") return this.pads().release(e.slot);
    if (e.t === "panic") this.sampler?.panic();
    if (!this.liveAvailable) return;
    if (!this.liveNode) {
      this.liveNode = new AudioWorkletNode(this.ctx, "live-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 2,
        outputChannelCount: [2, 2],
      });
      this.liveNode.connect(this.master.input, 0);
      this.liveNode.connect(this.convolver, 1);
    }
    this.liveNode.port.postMessage(e);
  }

  // ---- Skip-back ------------------------------------------------------------

  /** public/skipback-processor.js on the master output; pulled through a
   *  silent gain so it runs without being heard twice. */
  private skipNode: AudioWorkletNode | null = null;
  private skipLoaded = false;
  /** Off while the native engine plays (it keeps its own ring). */
  private skipWanted = true;
  private skipReplies = new Map<number, (data: unknown) => void>();
  private skipIds = 1;
  /** When the transport ran (context time), to place a grab in the song. */
  private playLog: PlaySpan[] = [];

  /** Run the ring or not (NativeBackend turns it off, and back on if it
   *  falls back to this engine). */
  setSkipBack(on: boolean): void {
    this.skipWanted = on;
    if (on) this.startSkipBack();
    else if (this.skipNode) {
      this.skipNode.disconnect();
      try {
        this.master.output.disconnect(this.skipNode);
      } catch {
        /* not connected */
      }
      this.skipNode = null;
    }
  }

  private startSkipBack(): void {
    if (this.skipNode || !this.skipLoaded) return;
    try {
      const node = new AudioWorkletNode(this.ctx, "skipback-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: "explicit",
        // A 5.1/7.1 bus folds down to stereo the standard way.
        channelInterpretation: "speakers",
        processorOptions: { seconds: RING_SECONDS },
      });
      node.port.onmessage = (e: MessageEvent) => {
        const d = e.data as { id: number };
        this.skipReplies.get(d.id)?.(d);
        this.skipReplies.delete(d.id);
      };
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink);
      sink.connect(this.ctx.destination);
      this.master.output.connect(node);
      this.skipNode = node;
    } catch {
      /* no worklet: skip-back is unavailable on this engine */
    }
  }

  private askSkip<T>(msg: Record<string, unknown>): Promise<T | null> {
    const node = this.skipNode;
    if (!node) return Promise.resolve(null);
    const id = this.skipIds++;
    return new Promise((resolve) => {
      this.skipReplies.set(id, (d) => resolve(d as T));
      node.port.postMessage({ ...msg, id });
    });
  }

  async skipMark(): Promise<number> {
    await this.synthReady;
    const r = await this.askSkip<{ frame: number }>({ type: "mark" });
    return r?.frame ?? 0;
  }

  async skipGrab(from: number | null, seconds: number): Promise<SkipGrab | null> {
    await this.synthReady;
    const r = await this.askSkip<{ ctxTime: number | null; channels: Float32Array[] }>({
      type: "grab",
      from,
      frames: Math.floor(seconds * this.ctx.sampleRate),
    });
    if (!r) return null;
    return {
      sampleRate: this.ctx.sampleRate,
      channels: r.channels,
      songTime: r.ctxTime == null ? null : songTimeAt(this.playLog, r.ctxTime),
    };
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

  get binauralMonitor(): boolean {
    return this.master.binaural;
  }

  setHeadphones3d(on: boolean): boolean {
    this.headphones3d = on;
    return this.setSurround(this.surround);
  }

  /** Switch the output layout. Rebuilds the master bus and every track
   *  channel when the live channel count (or the binaural monitor) changes,
   *  so the worklets get the new output width. The store reschedules
   *  playback afterwards. */
  setSurround(layout: SurroundLayout): boolean {
    this.surround = layout;
    const wanted = surroundChannels(layout);
    const device = deviceChannelsFor(wanted, this.deviceMaxChannels);
    // Device narrower than the layout: with the 3D monitor, keep the bus at
    // full width and render it for headphones rather than folding it down.
    const binaural = this.headphones3d && this.binauralAvailable && device < wanted;
    const live = binaural ? wanted : device;
    if (live === this.master.channels && binaural === this.master.binaural) return false;

    const dest = this.ctx.destination;
    try {
      if (device > 2) {
        dest.channelCount = device;
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
    this.master = buildMasterBus(this.ctx, live, this.masterGainValue, binaural);
    this.meterBuf = new Uint8Array(new ArrayBuffer(this.master.post.fftSize));
    this.preTimeBuf = new Float32Array(new ArrayBuffer(4 * this.master.preTap.fftSize));
    this.preFreqBuf = new Uint8Array(new ArrayBuffer(this.master.preTap.frequencyBinCount));
    this.reverbReturn.connect(this.master.input);
    this.sampler?.setOutput(this.master.input);
    if (this.skipNode) this.master.output.connect(this.skipNode);
    if (this.liveNode) {
      this.liveNode.disconnect();
      this.liveNode.connect(this.master.input, 0);
      this.liveNode.connect(this.convolver, 1);
    }
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
    ch.setSongOrigin(this.songOrigin);
    this.channels.set(trackId, ch);
    return ch;
  }

  private ensureChannel(track: Track): TrackChannel {
    let ch = this.channels.get(track.id);
    if (!ch) ch = this.createChannel(track.id);
    // Self-heal: if the worklets finished loading after this channel was
    // built and the track now needs them, rebuild it with the worklet nodes.
    const needsWorklets =
      track.synth.mix > 0 || track.morph.mix > 0 || punchIsActive(track.punch) || bassIsActive(track.bass) || track.pan !== 0 || track.width !== 1 || track.reverbPan !== 0 || track.reverbWidth !== 1;
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
    this.pads().setPads(project.pads);
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
    this.songOrigin = startAt - fromTime;
    this.endPlaySpan(startAt);
    this.playLog.push({ ctxStart: startAt, ctxEnd: Infinity, song: fromTime });
    if (this.playLog.length > 64) this.playLog.shift();

    for (const track of project.tracks) {
      const channel = this.ensureChannel(track);
      channel.applyTrack(track, hasSolo);
      channel.setSongOrigin(this.songOrigin);
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
    this.endPlaySpan(this.ctx.currentTime);
    this._isPlaying = false;
  }

  private endPlaySpan(at: number): void {
    const last = this.playLog[this.playLog.length - 1];
    if (last && last.ctxEnd === Infinity) last.ctxEnd = Math.max(last.ctxStart, at);
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

  setInputDevice(id: string | undefined): void {
    this.inputDeviceId = id ?? "";
  }

  /**
   * List audio input devices for a picker. Labels are blank until the mic
   * permission has been granted; pass `unlock` (only from a user gesture —
   * this prompts) to open and immediately close the default mic to get them.
   */
  async listInputDevices(unlock = false): Promise<{ id: string; label: string }[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (unlock && devices.some((d) => d.kind === "audioinput") && devices.every((d) => d.kind !== "audioinput" || !d.label)) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        probe.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch {
        // Permission denied: fall through with unlabelled devices.
      }
    }
    return devices.filter((d) => d.kind === "audioinput").map((d) => ({ id: d.deviceId, label: d.label || "Microphone" }));
  }

  /**
   * Start capturing from a mic/line input.
   *
   * Prefers an AudioWorklet, which runs on the audio thread so takes stay clean
   * while the UI is busy. Falls back to the deprecated main-thread
   * ScriptProcessorNode when the worklet can't load (older WebKitGTK), so
   * recording still works rather than failing outright.
   */
  async startRecording(): Promise<void> {
    await this.ensureRunning();
    this.recStream = await navigator.mediaDevices.getUserMedia({
      audio: this.inputDeviceId ? { deviceId: { exact: this.inputDeviceId } } : true,
      video: false,
    });
    const src = this.ctx.createMediaStreamSource(this.recStream);
    this.recChunks = [];
    this.recSampleRate = this.ctx.sampleRate;
    this.recLive = new LivePeaks(this.ctx.sampleRate);

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
        if (data?.type === "chunk" && data.channels) {
          this.recChunks.push(data.channels);
          this.recLive?.feedPlanar(data.channels);
        }
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
        this.recLive?.feedPlanar(frame);
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

  liveTake(): LivePeaks | null {
    return this.recLive;
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
    this.recLive = null;

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
