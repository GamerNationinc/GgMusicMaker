// TrackChannel — the per-track audio graph, from fader through the FX rack.
//
// Signal path:
//   input(gain: vol/mute/solo)
//     -> EQ low-shelf -> mid peak -> high-shelf -> stereo (mono layers become L = R)
//     -> [voice synth worklet]     (stacked vocal engines; N-channel out)
//     -> [placer: layer pan/width]
//     -> output ----------------------------------> master (dry)
//              \-> [placer: reverb pan/width] -> send(gain) -> reverb convolver (wet)
//
// The bracketed worklet stages are only in the path while they have work
// to do (synth engaged, or non-neutral pan/width); otherwise the EQ feeds
// the output directly and the send comes straight off the output.
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
export const PLACER_PROCESSOR = "placer-processor";

export class TrackChannel {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly send: GainNode;

  private eqLow: BiquadFilterNode;
  private eqMid: BiquadFilterNode;
  private eqHigh: BiquadFilterNode;

  /** Pins the EQ output to 2 channels so a mono layer reaches the bus (and
   *  the synth) as L = R, whether or not the worklets are in the path. */
  private stereo: GainNode;

  private synth: AudioWorkletNode | null = null;
  private place: AudioWorkletNode | null = null;
  private sendPlace: AudioWorkletNode | null = null;

  constructor(
    private ctx: BaseAudioContext,
    /** Whether the synth + placer worklets are registered on `ctx`. */
    hasWorklets: boolean,
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
    this.stereo = ctx.createGain();
    this.stereo.channelCount = 2;
    this.stereo.channelCountMode = "explicit";
    this.stereo.channelInterpretation = "speakers";

    if (hasWorklets) {
      const opts = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [busChannels] };
      try {
        this.synth = new AudioWorkletNode(ctx as AudioContext, SYNTH_PROCESSOR, opts);
        this.place = new AudioWorkletNode(ctx as AudioContext, PLACER_PROCESSOR, opts);
        this.sendPlace = new AudioWorkletNode(ctx as AudioContext, PLACER_PROCESSOR, opts);
      } catch {
        this.synth = null;
        this.place = null;
        this.sendPlace = null;
      }
    }

    // Wire the chain. The worklet stages start routed around (see `route`):
    // a layer with nothing engaged costs no worklet calls at all.
    this.input.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.stereo);
    this.stereo.connect(this.output);
    this.output.connect(this.send);
    if (this.synth && this.place) this.synth.connect(this.place);
  }

  /** Whether the EQ feeds the synth+placer worklets (true) or the output directly. */
  private fxRouted = false;
  /** Whether the send goes through its placer worklet (true) or straight to `send`. */
  private sendRouted = false;

  /** Put the worklet stages in or out of the signal path. Every worklet
   *  node costs a JS call per render quantum even when it is a passthrough
   *  (~3 % of the audio thread each under WebKitGTK), so a layer with no
   *  synth and neutral placement bypasses them entirely. */
  private route(fx: boolean, sendFx: boolean): void {
    if (!this.synth || !this.place || !this.sendPlace) return;
    if (fx !== this.fxRouted) {
      this.fxRouted = fx;
      if (fx) {
        this.stereo.disconnect(this.output);
        this.stereo.connect(this.synth);
        this.place.connect(this.output);
      } else {
        this.stereo.disconnect(this.synth);
        this.place.disconnect(this.output);
        this.stereo.connect(this.output);
      }
    }
    if (sendFx !== this.sendRouted) {
      this.sendRouted = sendFx;
      if (sendFx) {
        this.output.disconnect(this.send);
        this.output.connect(this.sendPlace);
        this.sendPlace.connect(this.send);
      } else {
        this.output.disconnect(this.sendPlace);
        this.sendPlace.disconnect(this.send);
        this.output.connect(this.send);
      }
    }
  }

  /** True if this channel could construct the worklet nodes (synth + placers). */
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

    // A bypassed module keeps its settings but is pushed to its neutral
    // values, so the graph never changes shape — only the numbers do.
    const fx = track.fx;
    const audible = isTrackAudible(track, projectHasSolo);
    ramp(this.input.gain, audible ? track.gain : 0);
    ramp(this.send.gain, audible && fx.reverb ? track.reverbSend : 0);

    ramp(this.eqLow.gain, fx.eq ? track.eq.low : 0);
    ramp(this.eqMid.gain, fx.eq ? track.eq.mid : 0);
    ramp(this.eqHigh.gain, fx.eq ? track.eq.high : 0);

    const synthOn = fx.synth && synthIsActive(track.synth);
    const placeOn = fx.place && (track.pan !== 0 || track.width !== 1);
    const sendOn = fx.reverb && (track.reverbPan !== 0 || track.reverbWidth !== 1);
    this.route(synthOn || placeOn, sendOn);

    if (this.place && this.sendPlace) {
      const set = (node: AudioWorkletNode, name: string, v: number) => {
        const param = node.parameters.get(name);
        if (param) ramp(param, v);
      };
      set(this.place, "pan", fx.place ? track.pan : 0);
      set(this.place, "width", fx.place ? track.width : 1);
      set(this.sendPlace, "pan", fx.reverb ? track.reverbPan : 0);
      set(this.sendPlace, "width", fx.reverb ? track.reverbWidth : 1);
    }

    if (this.synth) {
      const synth = track.synth;
      // With no engine up (or the module switched off) there is nothing wet
      // to hear, so keep the dry path bit-exact instead of fading it by `mix`.
      const active = synthOn;
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
      this.stereo,
      this.synth,
      this.place,
      this.sendPlace,
    ]) {
      try {
        n?.disconnect();
      } catch {
        /* noop */
      }
    }
  }
}
