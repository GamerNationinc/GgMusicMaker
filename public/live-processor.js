// Live instrument AudioWorklet — the notes and drum hits played from the
// Deck's controls in Instrument mode (src/input/instrument.ts). The web
// engine's twin of native/src/live.rs, kept in step with it by
// src/audio/native-parity.test.ts; change both together.
//
// Voices: two PolyBLEP oscillators (saw/square blend, detuned) → TPT state-
// variable lowpass (cutoff from the left-pad macro, opened by the envelope)
// → ADSR. Drums: kick, snare, hat, clap, synthesised.
//
// No inputs. Two stereo outputs: [0] dry → master bus, [1] reverb send.
// Events arrive on the port (see LiveEvent in src/input/instrument.ts) and
// apply at the start of the next quantum.

const VOICES = 16;
const DRUMS = 8;

// attack, decay, sustain, release (s), saw/square mix, detune (cents),
// filter envelope depth (octaves) — keys, pluck, pad, bass.
const PATCHES = [
  { a: 0.005, d: 0.3, s: 0.6, r: 0.25, saw: 0.7, detune: 6, fenv: 2 },
  { a: 0.002, d: 0.25, s: 0, r: 0.15, saw: 1, detune: 0, fenv: 3.5 },
  { a: 0.35, d: 0.8, s: 0.8, r: 0.9, saw: 1, detune: 12, fenv: 1 },
  { a: 0.003, d: 0.2, s: 0.7, r: 0.1, saw: 0.4, detune: 0, fenv: 1.5 },
];

const OFF = 0, ATTACK = 1, DECAY = 2, RELEASE = 3;
const DRUM_PAN = [0, 0.05, 0.3, -0.2];
const DRUM_LEN = [1.2, 0.6, 0.3, 0.6];

/** xorshift32 — deterministic noise, bit-identical to native/src/util.rs. */
class Rng {
  constructor(seed) { this.s = seed >>> 0 || 0x9e3779b9; }
  next() {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  bipolar() { return this.next() * 2 - 1; }
}

function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

function idleVoice() {
  return { id: 0, stage: OFF, held: false, age: 0, patch: 0, note: 60, target: 60, vel: 0, env: 0, att: 0, kd: 0, kr: 0, ph1: 0, ph2: 0.37, ic1: 0, ic2: 0 };
}
function idleDrum() {
  return { kind: 0, on: false, n: 0, vel: 0, gl: 0, gr: 0, ph: 0, x1: 0, y1: 0 };
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));

class LiveProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    this.voices = Array.from({ length: VOICES }, idleVoice);
    this.drums = Array.from({ length: DRUMS }, idleDrum);
    this.nextDrum = 0;
    this.clock = 0;
    this.rng = new Rng(0x11fe5eed);
    this.lfo = 0;
    this.bend = 0; this.mod = 0; this.cutoff = 0.7; this.send = 0.2; this.expr = 1; this.sustain = false;
    this.sBend = 0; this.sMod = 0; this.sCutoff = 0.7; this.sSend = 0.2; this.sExpr = 1;
    this.sm = Math.exp(-1 / (sr * 0.01));
    this.kg = Math.exp(-1 / (sr * 0.03));
    this.queue = [];
    if (this.port) this.port.onmessage = (e) => this.queue.push(e.data);
  }

  active() {
    return this.voices.some((v) => v.stage !== OFF) || this.drums.some((d) => d.on);
  }

  event(e) {
    const sr = sampleRate;
    switch (e.t) {
      case "on": {
        this.clock++;
        let slot = this.voices.findIndex((v) => v.stage !== OFF && v.id === e.id);
        if (slot < 0) slot = this.voices.findIndex((v) => v.stage === OFF);
        if (slot < 0) {
          slot = 0;
          for (let i = 0; i < VOICES; i++) if (this.voices[i].age < this.voices[slot].age) slot = i;
        }
        const pi = Math.min(e.patch | 0, PATCHES.length - 1);
        const p = PATCHES[pi];
        const v = this.voices[slot];
        const fresh = v.stage === OFF;
        this.voices[slot] = {
          id: e.id, stage: ATTACK, held: false, age: this.clock, patch: pi,
          note: e.note, target: e.note, vel: clamp01(e.vel),
          env: fresh ? 0 : v.env,
          att: 1 / (p.a * sr), kd: Math.exp(-3 / (p.d * sr)), kr: Math.exp(-3 / (p.r * sr)),
          ph1: fresh ? 0 : v.ph1, ph2: fresh ? 0.37 : v.ph2,
          ic1: fresh ? 0 : v.ic1, ic2: fresh ? 0 : v.ic2,
        };
        break;
      }
      case "off":
        for (const v of this.voices) {
          if (v.stage === OFF || v.stage === RELEASE || v.id !== e.id) continue;
          if (this.sustain) v.held = true;
          else v.stage = RELEASE;
        }
        break;
      case "glide":
        for (const v of this.voices) if (v.stage !== OFF && v.id === e.id) v.target = e.note;
        break;
      case "drum": {
        const k = Math.min(e.kind | 0, 3);
        const a = ((DRUM_PAN[k] + 1) * Math.PI) / 4;
        this.drums[this.nextDrum] = { kind: k, on: true, n: 0, vel: clamp01(e.vel), gl: Math.cos(a), gr: Math.sin(a), ph: 0, x1: 0, y1: 0 };
        this.nextDrum = (this.nextDrum + 1) % DRUMS;
        break;
      }
      case "ctl":
        this.bend = e.bend;
        this.mod = clamp01(e.mod);
        this.cutoff = clamp01(e.cutoff);
        this.send = clamp01(e.send);
        this.expr = clamp01(e.expr);
        if (this.sustain && !e.sustain) {
          for (const v of this.voices) {
            if (!v.held) continue;
            v.held = false;
            if (v.stage !== OFF) v.stage = RELEASE;
          }
        }
        this.sustain = !!e.sustain;
        break;
      case "panic":
        this.voices = Array.from({ length: VOICES }, idleVoice);
        this.drums = Array.from({ length: DRUMS }, idleDrum);
        break;
    }
  }

  process(_inputs, outputs) {
    for (const e of this.queue) this.event(e);
    this.queue.length = 0;
    const [dl, dr] = outputs[0];
    const send = outputs[1] || [];
    const sl = send[0], sr_ = send[1];
    if (!this.active()) {
      // Nothing sounding: controls jump to where they are now, so the next
      // note doesn't glide in from a stale value.
      this.sBend = this.bend; this.sMod = this.mod; this.sCutoff = this.cutoff; this.sSend = this.send; this.sExpr = this.expr;
      return true;
    }
    const sr = sampleRate;
    const n = dl.length;
    const resK = 1.3;
    for (let i = 0; i < n; i++) {
      this.sBend = this.bend + (this.sBend - this.bend) * this.sm;
      this.sMod = this.mod + (this.sMod - this.mod) * this.sm;
      this.sCutoff = this.cutoff + (this.sCutoff - this.cutoff) * this.sm;
      this.sSend = this.send + (this.sSend - this.send) * this.sm;
      this.sExpr = this.expr + (this.sExpr - this.expr) * this.sm;
      this.lfo += 5.5 / sr;
      if (this.lfo >= 1) this.lfo -= 1;
      const vib = this.sMod * 0.5 * Math.sin(2 * Math.PI * this.lfo);
      const baseCut = 80 * Math.pow(2, this.sCutoff * 8);
      let mono = 0;
      for (let vi = 0; vi < VOICES; vi++) {
        const v = this.voices[vi];
        if (v.stage === OFF) continue;
        const p = PATCHES[v.patch];
        if (v.stage === ATTACK) {
          v.env += v.att;
          if (v.env >= 1) { v.env = 1; v.stage = DECAY; }
        } else if (v.stage === DECAY) {
          v.env = p.s + (v.env - p.s) * v.kd;
        } else {
          v.env *= v.kr;
          if (v.env < 1e-4) { this.voices[vi] = idleVoice(); continue; }
        }
        v.note = v.target + (v.note - v.target) * this.kg;
        const pitch = v.note + this.sBend + vib;
        const f = 440 * Math.pow(2, (pitch - 69) / 12);
        const det = Math.pow(2, p.detune / 2400);
        const dt1 = Math.min(f / det / sr, 0.45);
        const dt2 = Math.min((f * det) / sr, 0.45);
        let o = 0;
        for (let k = 0; k < 2; k++) {
          const dt = k === 0 ? dt1 : dt2;
          const t = k === 0 ? v.ph1 : v.ph2;
          const saw = 2 * t - 1 - blep(t, dt);
          let t2 = t + 0.5;
          if (t2 >= 1) t2 -= 1;
          const sq = (t < 0.5 ? 1 : -1) + blep(t, dt) - blep(t2, dt);
          o += p.saw * saw + (1 - p.saw) * sq;
          let ph = t + dt;
          if (ph >= 1) ph -= 1;
          if (k === 0) v.ph1 = ph; else v.ph2 = ph;
        }
        const fc = Math.min(baseCut * Math.pow(2, p.fenv * v.env * (0.5 + 0.5 * v.vel)), sr * 0.45);
        const g = Math.tan((Math.PI * fc) / sr);
        const a1 = 1 / (1 + g * (g + resK));
        const a2 = g * a1;
        const a3 = g * a2;
        const v3 = 0.5 * o - v.ic2;
        const v1 = a1 * v.ic1 + a2 * v3;
        const v2 = v.ic2 + a2 * v.ic1 + a3 * v3;
        v.ic1 = 2 * v1 - v.ic1;
        v.ic2 = 2 * v2 - v.ic2;
        mono += v2 * v.env * v.vel * 0.8;
      }
      mono *= this.sExpr;
      let l = mono, r = mono;
      for (const d of this.drums) {
        if (!d.on) continue;
        const t = d.n / sr;
        let y;
        if (d.kind === 0) {
          d.ph += (45 + 105 * Math.exp(-t / 0.03)) / sr;
          y = Math.sin(2 * Math.PI * d.ph) * Math.exp(-t / 0.18);
        } else if (d.kind === 1) {
          const x = this.rng.bipolar();
          d.y1 = x - d.x1 + 0.9 * d.y1;
          d.x1 = x;
          y = 0.5 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t / 0.05) + 0.5 * d.y1 * Math.exp(-t / 0.07);
        } else if (d.kind === 2) {
          const x = this.rng.bipolar();
          const hp = x - d.x1;
          d.x1 = x;
          y = 0.4 * hp * Math.exp(-t / 0.018);
        } else {
          const x = this.rng.bipolar();
          d.y1 = x - d.x1 + 0.8 * d.y1;
          d.x1 = x;
          const env = t < 0.03 ? Math.exp(-(t % 0.01) / 0.004) : Math.exp(-(t - 0.03) / 0.08);
          y = 0.5 * d.y1 * env;
        }
        y = y * d.vel * 0.9;
        l += y * d.gl;
        r += y * d.gr;
        d.n++;
        if (t > DRUM_LEN[d.kind]) d.on = false;
      }
      dl[i] += l;
      dr[i] += r;
      if (sl) { sl[i] += l * this.sSend; sr_[i] += r * this.sSend; }
    }
    return true;
  }
}

registerProcessor("live-processor", LiveProcessor);
