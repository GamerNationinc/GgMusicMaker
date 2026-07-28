// TrackChannel — the per-track audio graph, from fader through the FX rack.
//
// Signal path:
//   input(gain: vol/mute/solo)
//     -> EQ low-shelf -> mid peak -> high-shelf
//     -> [pitch worklet]            (voice: chipmunk/deep/alien)
//     -> ring stage                 (voice: robot/alien ring mod)
//     -> output ----------------------------------> master (dry)
//              \-> send(gain) ------------------->  reverb convolver (wet)
//
// One class builds this for BOTH the realtime AudioContext and the offline
// export context, so the mix you hear is exactly the mix you render. It never
// touches project state directly — the engine pushes params in via applyTrack.

import type { Track } from "./types";
import { isTrackAudible } from "./edits";
import { VOICE_PRESETS, pitchMixFor, ringDepthFor } from "../fx/voice";

const EQ_LOW_HZ = 220;
const EQ_MID_HZ = 1200;
const EQ_HIGH_HZ = 4500;

export class TrackChannel {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly send: GainNode;

  private eqLow: BiquadFilterNode;
  private eqMid: BiquadFilterNode;
  private eqHigh: BiquadFilterNode;

  private pitch: AudioWorkletNode | null = null;
  private ringGain: GainNode;
  private ringDepth: GainNode;
  private ringOsc: OscillatorNode;

  constructor(private ctx: BaseAudioContext, hasPitchWorklet: boolean) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.send = ctx.createGain();
    this.send.gain.value = 0;

    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = "lowshelf";
    this.eqLow.frequency.value = EQ_LOW_HZ;
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = "peaking";
    this.eqMid.frequency.value = EQ_MID_HZ;
    this.eqMid.Q.value = 1;
    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = "highshelf";
    this.eqHigh.frequency.value = EQ_HIGH_HZ;

    // Ring-mod stage: effective gain = (1 - depth) + depth * osc, so depth 0 is
    // a clean passthrough and depth 1 is full ring modulation.
    this.ringGain = ctx.createGain();
    this.ringGain.gain.value = 1;
    this.ringDepth = ctx.createGain();
    this.ringDepth.gain.value = 0;
    this.ringOsc = ctx.createOscillator();
    this.ringOsc.frequency.value = 0;
    this.ringOsc.connect(this.ringDepth);
    this.ringDepth.connect(this.ringGain.gain);
    this.ringOsc.start();

    if (hasPitchWorklet) {
      try {
        this.pitch = new AudioWorkletNode(ctx as AudioContext, "pitch-shift-processor");
      } catch {
        this.pitch = null;
      }
    }

    // Wire the chain.
    this.input.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    if (this.pitch) {
      this.eqHigh.connect(this.pitch);
      this.pitch.connect(this.ringGain);
    } else {
      this.eqHigh.connect(this.ringGain);
    }
    this.ringGain.connect(this.output);
    this.output.connect(this.send);
  }

  /** True if this channel could construct the pitch-shift node. */
  get hasPitch(): boolean {
    return this.pitch !== null;
  }

  /** Connect the dry output to the master bus and the send to the reverb bus. */
  connect(master: AudioNode, reverbBus: AudioNode): void {
    this.output.connect(master);
    this.send.connect(reverbBus);
  }

  /** Push a track's mix + FX params onto the live nodes. */
  applyTrack(track: Track, projectHasSolo: boolean, smooth = true): void {
    const t = smooth ? this.ctx.currentTime : 0;
    const ramp = (p: AudioParam, v: number) =>
      smooth ? p.setTargetAtTime(v, t, 0.01) : (p.value = v);

    const audible = isTrackAudible(track, projectHasSolo);
    ramp(this.input.gain, audible ? track.gain : 0);
    ramp(this.send.gain, audible ? track.reverbSend : 0);

    ramp(this.eqLow.gain, track.eq.low);
    ramp(this.eqMid.gain, track.eq.mid);
    ramp(this.eqHigh.gain, track.eq.high);

    const preset = VOICE_PRESETS[track.voice.preset];
    if (this.pitch) {
      const pitchParam = this.pitch.parameters.get("pitch");
      const mixParam = this.pitch.parameters.get("mix");
      if (pitchParam) ramp(pitchParam, preset.pitch);
      if (mixParam) ramp(mixParam, pitchMixFor(track.voice.preset, track.voice.mix));
    }
    const depth = ringDepthFor(track.voice.preset) * track.voice.mix;
    ramp(this.ringOsc.frequency, preset.ringHz);
    ramp(this.ringGain.gain, 1 - depth);
    ramp(this.ringDepth.gain, depth);
  }

  dispose(): void {
    try {
      this.ringOsc.stop();
    } catch {
      /* already stopped */
    }
    for (const n of [
      this.input,
      this.output,
      this.send,
      this.eqLow,
      this.eqMid,
      this.eqHigh,
      this.ringGain,
      this.ringDepth,
      this.ringOsc,
      this.pitch,
    ]) {
      try {
        n?.disconnect();
      } catch {
        /* noop */
      }
    }
  }
}
