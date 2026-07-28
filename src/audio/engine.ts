// AudioEngine — the Web Audio runtime for ProfitPals DAW.
//
// Owns the single AudioContext, the master bus (gain -> limiter -> meter ->
// output), a shared convolution-reverb bus, and one gain+send node pair per
// track. Playback schedules an AudioBufferSourceNode per clip on the shared
// timeline, so layering is inherent. Recording captures mic/line input into an
// AudioBuffer, and export re-renders the whole project offline.
//
// Kept deliberately UI-agnostic: the Svelte store drives it, it never reaches
// back into the UI.

import type { Project, Track } from "./types";
import { nextId } from "./types";
import { anySoloed, isTrackAudible } from "./edits";
import { makeImpulseResponse, type ReverbSpace } from "./reverb";

interface TrackNodes {
  gain: GainNode;
  send: GainNode;
}

export class AudioEngine {
  readonly ctx: AudioContext;

  private masterGain: GainNode;
  private limiter: DynamicsCompressorNode;
  private analyser: AnalyserNode;
  private convolver: ConvolverNode;
  private reverbReturn: GainNode;

  private trackNodes = new Map<string, TrackNodes>();
  private buffers = new Map<string, AudioBuffer>();
  private activeSources: AudioBufferSourceNode[] = [];

  private playStartCtxTime = 0;
  private playStartOffset = 0;
  private _isPlaying = false;

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

    // A compressor with a high ratio + fast attack acts as a simple limiter,
    // catching peaks when many layers stack up ("mastering level" in v1).
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.1;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.meterBuf = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));

    // Shared reverb bus.
    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = makeImpulseResponse(this.ctx, "hall");
    this.reverbReturn = this.ctx.createGain();
    this.reverbReturn.gain.value = 1;

    // Wire the master bus: masterGain -> limiter -> analyser -> output.
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    // Reverb return folds back into the master bus (pre-limiter).
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.masterGain);
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /** Resume the context (browsers/WebKitGTK start it suspended until a gesture). */
  async ensureRunning(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  setMasterGain(value: number): void {
    this.masterGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
  }

  setReverbSpace(space: ReverbSpace): void {
    this.convolver.buffer = makeImpulseResponse(this.ctx, space);
  }

  // ---- Buffer store -------------------------------------------------------

  /** Decode raw file bytes into an AudioBuffer and register it. */
  async decodeBytes(bytes: ArrayBuffer): Promise<{ bufferId: string; buffer: AudioBuffer }> {
    // decodeAudioData detaches its input, so hand it a copy.
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

  // ---- Track nodes --------------------------------------------------------

  private ensureTrackNodes(trackId: string): TrackNodes {
    let nodes = this.trackNodes.get(trackId);
    if (!nodes) {
      const gain = this.ctx.createGain();
      const send = this.ctx.createGain();
      send.gain.value = 0;
      gain.connect(this.masterGain); // dry path
      gain.connect(send); // pre-fader-ish tap
      send.connect(this.convolver); // wet path
      nodes = { gain, send };
      this.trackNodes.set(trackId, nodes);
    }
    return nodes;
  }

  /** Push a track's mixer params (gain/mute/solo/send) to its live nodes. */
  applyTrackParams(track: Track, projectHasSolo: boolean): void {
    const nodes = this.ensureTrackNodes(track.id);
    const audible = isTrackAudible(track, projectHasSolo);
    const target = audible ? track.gain : 0;
    nodes.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01);
    nodes.send.gain.setTargetAtTime(audible ? track.reverbSend : 0, this.ctx.currentTime, 0.01);
  }

  removeTrack(trackId: string): void {
    const nodes = this.trackNodes.get(trackId);
    if (!nodes) return;
    nodes.gain.disconnect();
    nodes.send.disconnect();
    this.trackNodes.delete(trackId);
  }

  syncAll(project: Project): void {
    const hasSolo = anySoloed(project);
    for (const track of project.tracks) this.applyTrackParams(track, hasSolo);
  }

  // ---- Transport ----------------------------------------------------------

  /** Schedule and start playback of the whole project from `fromTime` seconds. */
  play(project: Project, fromTime: number): void {
    this.stopSources();
    const hasSolo = anySoloed(project);
    const startAt = this.ctx.currentTime + 0.05;
    this.playStartCtxTime = startAt;
    this.playStartOffset = fromTime;

    for (const track of project.tracks) {
      this.applyTrackParams(track, hasSolo);
      if (!isTrackAudible(track, hasSolo)) continue;
      const nodes = this.ensureTrackNodes(track.id);

      for (const clip of track.clips) {
        const clipEndT = clip.startTime + clip.duration;
        if (clipEndT <= fromTime) continue; // already behind the playhead
        const buffer = this.buffers.get(clip.bufferId);
        if (!buffer) continue;

        const when = startAt + Math.max(0, clip.startTime - fromTime);
        const into = clip.offset + Math.max(0, fromTime - clip.startTime);
        const dur = clipEndT - Math.max(fromTime, clip.startTime);

        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(nodes.gain);
        try {
          src.start(when, into, dur);
        } catch {
          // Ignore invalid ranges (e.g. offset past buffer end).
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

  /** Current playhead position in seconds while playing. */
  currentTime(): number {
    if (!this._isPlaying) return this.playStartOffset;
    const elapsed = this.ctx.currentTime - this.playStartCtxTime;
    return this.playStartOffset + Math.max(0, elapsed);
  }

  /** Peak master level 0..1 for the VU meter. */
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

  /**
   * Start capturing from a mic/line input. Uses a ScriptProcessorNode rather
   * than MediaRecorder because it works reliably under WebKitGTK (the Steam
   * Deck / Tauri webview) and gives us raw Float32 samples with no codec step.
   */
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

    // Route through a silent monitor gain so the processor runs without
    // feeding the input back to the speakers (avoids feedback howl).
    const monitor = this.ctx.createGain();
    monitor.gain.value = 0;
    src.connect(processor);
    processor.connect(monitor);
    monitor.connect(this.ctx.destination);
    this.recProcessor = processor;
    this.recMonitor = monitor;
  }

  /** Stop recording and assemble the captured audio into an AudioBuffer. */
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

  /**
   * Re-render the whole project (dry + reverb, master gain + limiter) to a
   * single AudioBuffer via an OfflineAudioContext. `tailSeconds` leaves room
   * for the reverb tail to ring out past the last clip.
   */
  async renderMix(project: Project, tailSeconds = 3): Promise<AudioBuffer> {
    const hasSolo = anySoloed(project);
    let duration = 0;
    for (const t of project.tracks)
      for (const c of t.clips) duration = Math.max(duration, c.startTime + c.duration);
    duration += tailSeconds;

    const rate = project.sampleRate || this.ctx.sampleRate;
    const frames = Math.max(1, Math.ceil(duration * rate));
    const offline = new OfflineAudioContext(2, frames, rate);

    // Master bus (mirror of the realtime graph).
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
    convolver.buffer = makeImpulseResponse(offline, "hall");
    convolver.connect(masterGain);

    for (const track of project.tracks) {
      if (!isTrackAudible(track, hasSolo)) continue;
      const gain = offline.createGain();
      gain.gain.value = track.gain;
      const send = offline.createGain();
      send.gain.value = track.reverbSend;
      gain.connect(masterGain);
      gain.connect(send);
      send.connect(convolver);

      for (const clip of track.clips) {
        const buffer = this.buffers.get(clip.bufferId);
        if (!buffer) continue;
        const src = offline.createBufferSource();
        src.buffer = buffer;
        src.connect(gain);
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
