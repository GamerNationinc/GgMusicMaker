// BASS MOD core DSP — modulates and thickens a bass line or an 808. Shared by
// the `bass-processor` AudioWorklet (live + export) and ported line by line
// to native/src/bass.rs, so both engines sound the same.
//
// Loaded as a module; it also parks the class on globalThis so the worklet
// (a separate module in the same AudioWorkletGlobalScope) can find it.
//
//   in L/R ─ VIBRATO (LFO-swept delay: pitch wobble)
//          ─ FILTER  resonant low-pass; WOBBLE sweeps it with the tempo-locked
//                    LFO, TALK (env) opens/closes it with each hit
//          ─ + GRIT  saturated bass band, high-passed: harmonics small speakers play
//          ─ + DEEPEN clean sine that tracks the bass's pitch (or an octave below)
//          ─ WIDEN   above 150 Hz: chorus into the sides; below stays mono
//          ─ PUMP    sidechain-style duck on every LFO cycle
//          ─ OUTPUT gain ─ soft ceiling
//
// The LFO is locked to song time: `block(t)` is called at the start of every
// 128-frame block with the song position in seconds, so a 1/8 wobble lands
// on the 1/8 notes of the song (at the module's own BPM) on both engines.

const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const TAU = 2 * Math.PI;

/** LFO length per rate setting, in beats: 1/1 1/2 1/4 1/8 1/16 1/4T 1/8T 1/16T. */
export const BASS_RATE_BEATS = [4, 2, 1, 0.5, 0.25, 2 / 3, 1 / 3, 1 / 6];
const WIDE_HZ = 150;
const DEEP_HZ = 180;
const GRIT_LP = 250;
const GRIT_HP = 300;

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, freq, q, sr) {
    const w0 = (TAU * clampN(freq, 10, sr * 0.45)) / sr;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    if (type === "lp") { this.b0 = (1 - cw) / 2 / a0; this.b1 = (1 - cw) / a0; }
    else { this.b0 = (1 + cw) / 2 / a0; this.b1 = -(1 + cw) / a0; }
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0; this.a2 = (1 - alpha) / a0;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z1 = 0; this.z2 = 0; }
}

class Env {
  constructor(att, rel, sr) { this.a = Math.exp(-1 / (sr * att)); this.r = Math.exp(-1 / (sr * rel)); this.v = 0; }
  step(x) {
    const ax = x < 0 ? -x : x;
    this.v = ax > this.v ? ax + (this.v - ax) * this.a : this.v * this.r;
    return this.v;
  }
}

/** Fractional delay line (linear interpolation). */
class Delay {
  constructor(n) { this.buf = new Float64Array(n); this.mask = n - 1; this.w = 0; }
  push(x) { this.buf[this.w] = x; this.w = (this.w + 1) & this.mask; }
  /** Read `d` samples behind the newest sample (d >= 0). */
  read(d) {
    const p = this.w - 1 - d;
    const i = Math.floor(p);
    const f = p - i;
    const a = this.buf[i & this.mask], b = this.buf[(i + 1) & this.mask];
    return a + (b - a) * f;
  }
  reset() { this.buf.fill(0); this.w = 0; }
}

/** Deterministic noise per LFO cycle (integer hash, same on both engines). */
function cycleNoise(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return (h / 4294967295) * 2 - 1;
}

/** Phase lag of the 2-biquad pitch-tracking low-pass at `f` Hz, in cycles. */
function cascadeLag(bq, f, sr) {
  const w = (TAU * f) / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  // H = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2), z^-1 = e^{-jw}
  const nr = bq.b0 + bq.b1 * c1 + bq.b2 * c2, ni = -bq.b1 * s1 - bq.b2 * s2;
  const dr = 1 + bq.a1 * c1 + bq.a2 * c2, di = -bq.a1 * s1 - bq.a2 * s2;
  const ph = Math.atan2(ni, nr) - Math.atan2(di, dr);
  return (-2 * ph) / TAU;
}

// floor(x + 0.5), not Math.round: the Rust port rounds the same way.
const wrapHalf = (x) => x - Math.floor(x + 0.5);

export class BassCore {
  constructor(sr) {
    this.sr = sr;
    // Pitch wobble: up to 6 ms of swing (plus 2 samples) at any rate.
    let n = 1; while (n < Math.ceil(sr * 0.012) + 8) n *= 2;
    this.vibL = new Delay(n); this.vibR = new Delay(n);
    this.ic1L = 0; this.ic2L = 0; this.ic1R = 0; this.ic2R = 0;
    this.envF = new Env(0.002, 0.15, sr);
    this.gritLp = new Biquad(); this.gritHp = new Biquad();
    this.gritLp.set("lp", GRIT_LP, Math.SQRT1_2, sr);
    this.gritHp.set("hp", GRIT_HP, Math.SQRT1_2, sr);
    this.deep = [new Biquad(), new Biquad()];
    for (const f of this.deep) f.set("lp", DEEP_HZ, Math.SQRT1_2, sr);
    this.deepEnv = new Env(0.004, 0.1, sr);
    this.lpL = [new Biquad(), new Biquad()]; this.lpR = [new Biquad(), new Biquad()];
    this.hpL = [new Biquad(), new Biquad()]; this.hpR = [new Biquad(), new Biquad()];
    for (const f of [...this.lpL, ...this.lpR]) f.set("lp", WIDE_HZ, Math.SQRT1_2, sr);
    for (const f of [...this.hpL, ...this.hpR]) f.set("hp", WIDE_HZ, Math.SQRT1_2, sr);
    n = 1; while (n < Math.ceil(sr * 0.012) + 8) n *= 2;
    this.wide = new Delay(n);
    this.smK = 1 - Math.exp(-1 / (sr * 0.004));
    this.pumpK = 1 - Math.exp(-1 / (sr * 0.0015));
    this.p = null;
    this.reset();
    this.ph = 0; this.cyc = 0; this.wph = 0; this.hz = 1;
  }

  /** p: { bpm, rate, shape, wobble, cutoff, reso, env, vibrato, deepen, octave, grit, widen, pump, output } */
  set(p) {
    this.p = p;
    const beats = BASS_RATE_BEATS[clampN(Math.round(p.rate), 0, BASS_RATE_BEATS.length - 1)];
    this.hz = p.bpm / 60 / beats;
    this.shape = Math.round(p.shape);
    this.filterOn = p.wobble > 0 || p.env !== 0 || p.cutoff < 20000;
    this.k = 1 / (0.7 + p.reso * 7.3);
    // Vibrato swing (samples) for up to ±50 cents at this rate, capped at 6 ms.
    const swing = (p.vibrato * 50 * Math.LN2 / 1200) / (TAU * this.hz);
    this.vibA = Math.min(swing, 0.006) * this.sr;
    this.outGain = Math.pow(10, p.output / 20);
  }

  reset() {
    this.vibL.reset(); this.vibR.reset(); this.wide.reset();
    this.ic1L = 0; this.ic2L = 0; this.ic1R = 0; this.ic2R = 0;
    this.envF.v = 0; this.deepEnv.v = 0;
    for (const f of [this.gritLp, this.gritHp, ...this.deep, ...this.lpL, ...this.lpR, ...this.hpL, ...this.hpR]) f.reset();
    this.mod = 0; this.pumpG = 1;
    this.n = 0; this.prevB = 0; this.armed = false; this.lastCross = -1;
    this.f = 55; this.oph = 0; this.flip = 0;
  }

  /** Start of a block: lock the LFOs to the song position `t` (seconds). */
  block(t) {
    const x = t * this.hz;
    const c = Math.floor(x);
    this.cyc = c;
    this.ph = x - c;
    const w = t * 0.37;
    this.wph = w - Math.floor(w);
  }

  lfo() {
    const ph = this.ph;
    switch (this.shape) {
      case 1: return 4 * Math.abs(ph - 0.5) - 1;
      case 2: return 1 - 2 * ph;
      case 3: return ph < 0.5 ? 1 : -1;
      case 4: return cycleNoise(this.cyc);
      default: return Math.cos(TAU * ph);
    }
  }

  /** Process one stereo sample; results in this.l / this.r. */
  step(xl, xr) {
    const p = this.p, sr = this.sr;
    this.mod += (this.lfo() - this.mod) * this.smK;

    // VIBRATO: a delay swept by a sine at the LFO rate bends the pitch.
    if (this.vibA > 0) {
      this.vibL.push(xl); this.vibR.push(xr);
      const d = 2 + this.vibA * (1 - Math.cos(TAU * this.ph));
      xl = this.vibL.read(d); xr = this.vibR.read(d);
    }
    const mono = 0.5 * (xl + xr);
    const e = this.envF.step(mono);

    // FILTER: TPT state-variable low-pass, cutoff swept per sample.
    if (this.filterOn) {
      let oct = -p.wobble * 6 * (0.5 - 0.5 * this.mod);
      if (p.env !== 0) oct += p.env * 5 * Math.min(1, e * 6);
      const fc = clampN(p.cutoff * Math.pow(2, oct), 30, sr * 0.45);
      const g = Math.tan((Math.PI * fc) / sr);
      const a1 = 1 / (1 + g * (g + this.k)), a2 = g * a1, a3 = g * a2;
      let v3 = xl - this.ic2L;
      let v1 = a1 * this.ic1L + a2 * v3;
      let v2 = this.ic2L + a2 * this.ic1L + a3 * v3;
      this.ic1L = 2 * v1 - this.ic1L; this.ic2L = 2 * v2 - this.ic2L; xl = v2;
      v3 = xr - this.ic2R;
      v1 = a1 * this.ic1R + a2 * v3;
      v2 = this.ic2R + a2 * this.ic1R + a3 * v3;
      this.ic1R = 2 * v1 - this.ic1R; this.ic2R = 2 * v2 - this.ic2R; xr = v2;
    }

    // GRIT: saturate the bass band, keep only the harmonics it makes.
    if (p.grit > 0) {
      const b = this.gritLp.process(mono);
      const h = this.gritHp.process(Math.tanh(b * (1 + p.grit * 15)));
      xl += h * p.grit * 0.6; xr += h * p.grit * 0.6;
    }

    // DEEPEN: a sine phase-locked to the bass's own fundamental (or an octave below).
    if (p.deepen > 0) {
      const b = this.deep[1].process(this.deep[0].process(mono));
      const de = this.deepEnv.step(b);
      if (b < -0.1 * de) this.armed = true;
      if (this.armed && this.prevB < 0 && b >= 0 && de > 1e-4) {
        this.armed = false;
        const frac = this.prevB / (this.prevB - b);
        const at = this.n - 1 + frac;
        if (this.lastCross >= 0) {
          const period = at - this.lastCross;
          if (period > sr / 400 && period < sr / 25) this.f += (sr / period - this.f) * 0.5;
        }
        this.lastCross = at;
        this.flip = 1 - this.flip;
        let target = cascadeLag(this.deep[0], this.f, sr) + ((1 - frac) * this.f) / sr;
        if (p.octave >= 0.5) target = 0.5 * target + 0.5 * this.flip;
        this.oph += 0.3 * wrapHalf(target - this.oph);
      }
      this.prevB = b;
      const s = p.deepen * 1.2 * de * Math.sin(TAU * this.oph);
      xl += s; xr += s;
      this.oph += (p.octave >= 0.5 ? this.f * 0.5 : this.f) / sr;
      this.oph -= Math.floor(this.oph);
    }
    this.n++;

    // WIDEN: lows to mono, highs get a chorused side signal.
    if (p.widen > 0) {
      const lo = 0.5 * (this.lpL[1].process(this.lpL[0].process(xl)) + this.lpR[1].process(this.lpR[0].process(xr)));
      const hl = this.hpL[1].process(this.hpL[0].process(xl));
      const hr = this.hpR[1].process(this.hpR[0].process(xr));
      const mid = 0.5 * (hl + hr);
      this.wide.push(mid);
      const sw = 0.0025 * sr * Math.sin(TAU * this.wph);
      const dl = 0.007 * sr + sw, dr = 0.007 * sr - sw;
      const side = 0.5 * (hl - hr) * (1 + p.widen) + 0.5 * (this.wide.read(dl) - this.wide.read(dr)) * p.widen * 0.9;
      xl = lo + mid + side; xr = lo + mid - side;
      this.wph += 0.37 / sr;
      if (this.wph >= 1) this.wph -= 1;
    }

    // PUMP: duck at the start of each LFO cycle, recover over it.
    if (p.pump > 0) {
      const u = 1 - this.ph;
      const target = 1 - p.pump * u * u * u;
      this.pumpG += (target - this.pumpG) * this.pumpK;
      xl *= this.pumpG; xr *= this.pumpG;
    }

    this.ph += this.hz / sr;
    if (this.ph >= 1) { this.ph -= 1; this.cyc++; }

    this.l = ceiling(xl * this.outGain);
    this.r = ceiling(xr * this.outGain);
  }
}

/** Soft ceiling: transparent below 0.8, never above ±0.98 (≈ −0.2 dBFS). */
function ceiling(y) {
  const a = y < 0 ? -y : y;
  if (a <= 0.8) return y;
  const k = 0.8 + 0.18 * Math.tanh((a - 0.8) / 0.18);
  return y < 0 ? -k : k;
}

globalThis.BassCore = BassCore;
