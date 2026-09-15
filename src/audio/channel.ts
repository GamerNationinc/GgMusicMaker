// TrackChannel — the per-track audio graph, from fader through the FX rack.
//
// Signal path:
//   input(gain: vol/mute/solo)
//     -> EQ low-shelf -> mid peak -> high-shelf
//     -> [voice synth worklet]     (stacked vocal engines; N-channel out)
//     -> output ----------------------------------> master (dry)
//              \-> send(gain) ------------------->  reverb convolver (wet)
//
// The synth worklet is built with as many output channels as the master bus
// has (2, 6 or 8), so a surround field lands on the bus discretely, with no
// implicit up/down-mixing in between. The reverb send is stereo: the
// convolver folds 5.1 down (L + 0.7C + 0.7Ls) and takes L/R of 7.1.
//
// One class builds this for BOTH the realtime AudioContext and the offline
// export context, so the mix you hear is exactly the mix you render. It never
// touches project state directly — the engine pushes params in via applyTrack.

import type { Track } from "./types";
import { isTrackAudible } from "./edits";
import { DEFAULT_SYNTH, synthIsActive, type SynthKey } from "../fx/voice-synth";

const EQ_LOW_HZ = 220;
const EQ_MID_HZ = 1200;
const EQ_HIGH_HZ = 4500;

export const SYNTH_PROCESSOR = "voice-synth-processor";

export class TrackChannel {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly send: GainNode;

  private eqLow: BiquadFilterNode;
  private eqMid: BiquadFilterNode;
  private eqHigh: BiquadFilterNode;

  private synth: AudioWorkletNode | null = null;

  constructor(
    private ctx: BaseAudioContext,
    hasSynthWorklet: boolean,
    /** Channels the master bus carries; the synth field is rendered into this many. */
    readonly busChannels: number,
  ) {
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

    if (hasSynthWorklet) {
      try {
        this.synth = new AudioWorkletNode(ctx as AudioContext, SYNTH_PROCESSOR, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [busChannels],
        });
      } catch {
        this.synth = null;
      }
    }

    // Wire the chain.
    this.input.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    if (this.synth) {
      this.eqHigh.connect(this.synth);
      this.synth.connect(this.output);
    } else {
      this.eqHigh.connect(this.output);
    }
    this.output.connect(this.send);
  }

  /** True if this channel could construct the voice synth node. */
  get hasSynth(): boolean {
    return this.synth !== null;
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

    if (this.synth) {
      const synth = track.synth;
      // With no engine up there is nothing wet to hear, so keep the dry
      // path bit-exact instead of fading it by `mix`.
      const active = synthIsActive(synth);
      for (const key of Object.keys(DEFAULT_SYNTH) as SynthKey[]) {
        const param = this.synth.parameters.get(key);
        if (!param) continue;
        const value = key === "mix" && !active ? 0 : synth[key];
        // Discrete params (mode-like) must not glide through in-between values.
        if (key === "chord" || key === "unison") param.value = value;
        else ramp(param, value);
      }
    }
  }

  dispose(): void {
    for (const n of [
      this.input,
      this.output,
      this.send,
      this.eqLow,
      this.eqMid,
      this.eqHigh,
      this.synth,
    ]) {
      try {
        n?.disconnect();
      } catch {
        /* noop */
      }
    }
  }
}
