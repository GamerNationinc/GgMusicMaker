// The pad sampler on the web engine — the twin of native/src/pads.rs, built
// from Web Audio nodes: per voice, a buffer source (reversed copy for
// reverse; playbackRate = repitch) → an envelope gain (also up-mixes a mono
// buffer to L = R) → StereoPannerNode → the master bus, or the input of FX
// bus 1 / 2 (the pad's `bus`). The rules (modes,
// latch, choke, mono, attack/release floors, 3 ms end declick) are the ones
// pads.rs documents.

import type { Pad } from "../pads/pads";

const MIN_ATTACK = 0.001;
const MIN_RELEASE = 0.005;
const CUT = 0.005;
const DECLICK = 0.003;

interface Voice {
  slot: number;
  mode: Pad["mode"];
  choke: number;
  src: AudioBufferSourceNode;
  env: GainNode;
  pan: StereoPannerNode;
  releasing: boolean;
}

export class WebSampler {
  private pads = new Map<number, Pad>();
  private voices: Voice[] = [];
  private reversed = new WeakMap<AudioBuffer, AudioBuffer>();

  /** `outs`: dry, FX bus 1 in, FX bus 2 in. */
  constructor(
    private ctx: BaseAudioContext,
    private outs: AudioNode[],
    private getBuffer: (id: string) => AudioBuffer | undefined,
  ) {}

  setPads(pads: readonly Pad[] | undefined): void {
    this.pads = new Map((pads ?? []).map((p) => [p.slot, p]));
  }

  /** The bus was rebuilt: new voices go to `outs` (dry, bus 1, bus 2). */
  setOutputs(outs: AudioNode[]): void {
    this.outs = outs;
  }

  /** Voices of a pad still sounding (not releasing). */
  voicesOf(slot: number): number {
    return this.voices.filter((v) => v.slot === slot && !v.releasing).length;
  }

  trigger(slot: number, vel: number): void {
    const p = this.pads.get(slot);
    const buf = p && this.getBuffer(p.bufferId);
    if (!p || !buf) return;
    if (p.mode === "loop") {
      const latched = this.voices.filter((v) => v.slot === slot && v.mode === "loop" && !v.releasing);
      if (latched.length) {
        for (const v of latched) this.releaseVoice(v, p.release);
        return;
      }
    }
    for (const v of this.voices) {
      if ((v.slot === slot && p.mono) || (p.choke > 0 && v.choke === p.choke && v.slot !== slot)) this.releaseVoice(v, CUT);
    }
    const n = buf.length;
    const lo = Math.min(n, Math.max(0, Math.floor(p.start * buf.sampleRate)));
    const hi = Math.min(n, Math.max(lo, Math.ceil(p.end * buf.sampleRate)));
    if (hi - lo < 1) return;
    const data = p.reverse ? this.reverse(buf) : buf;
    const from = (p.reverse ? n - hi : lo) / buf.sampleRate;
    const len = (hi - lo) / buf.sampleRate;
    const rate = 2 ** (p.pitch / 12);

    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = data;
    src.playbackRate.value = rate;
    const env = ctx.createGain();
    env.channelCount = 2;
    env.channelCountMode = "explicit";
    env.channelInterpretation = "speakers";
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, p.pan));
    src.connect(env).connect(pan).connect(this.outs[Math.min(p.bus ?? 0, this.outs.length - 1)]);

    const t0 = ctx.currentTime;
    const g = Math.max(0, Math.min(1, vel)) * Math.max(0, p.gain);
    const att = Math.max(MIN_ATTACK, p.attack);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(g, t0 + att);
    if (p.mode === "loop") {
      src.loop = true;
      src.loopStart = from;
      src.loopEnd = from + len;
      src.start(t0, from);
    } else {
      const end = t0 + len / rate;
      const fadeAt = Math.max(t0 + att, end - DECLICK / rate);
      env.gain.setValueAtTime(g, fadeAt);
      env.gain.linearRampToValueAtTime(0, end);
      src.start(t0, from, len);
    }
    const v: Voice = { slot, mode: p.mode, choke: p.choke, src, env, pan, releasing: false };
    src.onended = () => {
      this.voices = this.voices.filter((x) => x !== v);
      pan.disconnect();
    };
    this.voices.push(v);
  }

  /** Let go: gate pads release; one-shots and latched loops don't. */
  release(slot: number): void {
    const rel = this.pads.get(slot)?.release ?? 0;
    for (const v of this.voices) if (v.slot === slot && v.mode === "gate") this.releaseVoice(v, rel);
  }

  panic(): void {
    for (const v of this.voices) {
      try {
        v.src.stop();
      } catch {
        /* not started */
      }
      v.pan.disconnect();
    }
    this.voices = [];
  }

  private releaseVoice(v: Voice, seconds: number): void {
    if (v.releasing) return;
    v.releasing = true;
    const now = this.ctx.currentTime;
    const g = v.env.gain;
    const hold = (g as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam }).cancelAndHoldAtTime;
    if (hold) hold.call(g, now);
    else {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
    }
    const end = now + Math.max(MIN_RELEASE, seconds);
    g.linearRampToValueAtTime(0, end);
    try {
      v.src.stop(end + 0.01);
    } catch {
      /* already stopped */
    }
  }

  private reverse(b: AudioBuffer): AudioBuffer {
    let r = this.reversed.get(b);
    if (!r) {
      r = this.ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
      for (let c = 0; c < b.numberOfChannels; c++) r.getChannelData(c).set(b.getChannelData(c).slice().reverse());
      this.reversed.set(b, r);
    }
    return r;
  }
}
