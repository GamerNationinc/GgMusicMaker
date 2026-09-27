// PUNCH core DSP — drums + bass enhancer (Neutron-style), shared by the
// `punch-processor` AudioWorklet (live + export) and the timeline preview on
// the main thread, so what the lane shows is exactly what you hear.
//
// Loaded as a module in both places; it also parks the class on globalThis
// so the worklet (a separate module in the same AudioWorkletGlobalScope) can
// find it without an import.
//
//   in L/R ─ LR4 crossover @ FREQ ─┬─ LOW (summed to mono)
//                                  │   PUNCH  transient shaper: (fast env / slow env)^k
//                                  │   BOOM   up to +12 dB on the low band
//                                  │   SUB    octave-down (zero-crossing flip-flop, dbx-120 style)
//                                  │   DRIVE  tanh saturation → harmonics a phone speaker can play
//                                  └─ HIGH  SNAP transient shaper (±: crack / soften)
//   sum ─ BLOWOUT (hard tanh wall) ─ OUTPUT gain ─ SAFE? soft ceiling : may exceed 0 dBFS

const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, freq, q, sr) {
    const w0 = (2 * Math.PI * clampN(freq, 10, sr * 0.45)) / sr;
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

/** Follower with separate attack/release times (seconds). */
class Env {
  constructor(att, rel, sr) { this.a = Math.exp(-1 / (sr * att)); this.r = Math.exp(-1 / (sr * rel)); this.v = 0; }
  step(x) {
    const ax = x < 0 ? -x : x;
    this.v = ax > this.v ? ax + (this.v - ax) * this.a : this.v * this.r;
    return this.v;
  }
}

export class PunchCore {
  constructor(sr) {
    this.sr = sr;
    this.lpL = [new Biquad(), new Biquad()]; this.lpR = [new Biquad(), new Biquad()];
    this.hpL = [new Biquad(), new Biquad()]; this.hpR = [new Biquad(), new Biquad()];
    this.subIn = [new Biquad(), new Biquad()];
    this.subOut = [new Biquad(), new Biquad()];
    for (const f of this.subIn) f.set("lp", 110, Math.SQRT1_2, sr);
    for (const f of this.subOut) f.set("lp", 90, Math.SQRT1_2, sr);
    this.lowFast = new Env(0.0005, 0.04, sr); this.lowSlow = new Env(0.02, 0.2, sr);
    this.hiFast = new Env(0.0005, 0.03, sr); this.hiSlow = new Env(0.015, 0.15, sr);
    this.subEnv = new Env(0.005, 0.12, sr);
    this.subPrev = 0; this.subSq = 1;
    this.freq = -1;
    this.p = null;
    // Per-sample taps for the preview's statistics.
    this.lowIn = 0; this.lowOut = 0;
  }

  /** p: { boom, sub, punch, snap, drive, blowout, freq, output, safe } */
  set(p) {
    this.p = p;
    if (p.freq !== this.freq) {
      this.freq = p.freq;
      const q = Math.SQRT1_2;
      for (const f of [...this.lpL, ...this.lpR]) f.set("lp", p.freq, q, this.sr);
      for (const f of [...this.hpL, ...this.hpR]) f.set("hp", p.freq, q, this.sr);
    }
    this.boomGain = 1 + p.boom * 3;                 // up to +12 dB
    this.punchK = p.punch * 1.4;
    this.snapK = p.snap * 1.2;
    this.driveK = 1 + p.drive * 11;
    this.driveNorm = Math.pow(this.driveK, -0.45);
    this.blowK = 1 + p.blowout * 9;
    this.outGain = Math.pow(10, p.output / 20);
    this.safe = p.safe >= 0.5;
  }

  reset() {
    for (const f of [...this.lpL, ...this.lpR, ...this.hpL, ...this.hpR, ...this.subIn, ...this.subOut]) f.reset();
    this.lowFast.v = 0; this.lowSlow.v = 0; this.hiFast.v = 0; this.hiSlow.v = 0; this.subEnv.v = 0;
    this.subPrev = 0; this.subSq = 1;
  }

  /** Process one stereo sample; results in this.l / this.r. */
  step(xl, xr) {
    const p = this.p;
    const lowL = this.lpL[1].process(this.lpL[0].process(xl));
    const lowR = this.lpR[1].process(this.lpR[0].process(xr));
    const hiL = this.hpL[1].process(this.hpL[0].process(xl));
    const hiR = this.hpR[1].process(this.hpR[0].process(xr));
    // LR4 halves are in phase at the crossover and sum flat (an all-pass).
    // The low band is summed to mono: tight, centred bass, as on a club mix.
    let low = 0.5 * (lowL + lowR);
    this.lowIn = low;

    // PUNCH: exaggerate the kick's attack against its body.
    const f = this.lowFast.step(low), s = this.lowSlow.step(low);
    if (this.punchK > 0) low *= Math.pow(clampN((f + 1e-5) / (s + 1e-5), 0.25, 6), this.punchK);
    low *= this.boomGain;

    // SUB: a square at half the bass's frequency, shaped by its envelope.
    if (p.sub > 0) {
      const b = this.subIn[1].process(this.subIn[0].process(this.lowIn));
      if (this.subPrev < 0 && b >= 0) this.subSq = -this.subSq;
      this.subPrev = b;
      const e = this.subEnv.step(b);
      low += p.sub * 2.2 * this.subOut[1].process(this.subOut[0].process(this.subSq * e));
    }

    if (p.drive > 0) low = Math.tanh(this.driveK * low) * this.driveNorm * 1.6;
    this.lowOut = low;

    // SNAP on everything above the crossover.
    let g = 1;
    if (this.snapK !== 0) {
      const hm = 0.5 * (hiL + hiR);
      const hf = this.hiFast.step(hm), hs = this.hiSlow.step(hm);
      g = Math.pow(clampN((hf + 1e-5) / (hs + 1e-5), 0.25, 6), this.snapK);
    }
    let l = low + hiL * g;
    let r = low + hiR * g;

    if (p.blowout > 0) {
      l = Math.tanh(this.blowK * l) * 0.97;
      r = Math.tanh(this.blowK * r) * 0.97;
    }
    l *= this.outGain; r *= this.outGain;
    if (this.safe) { l = ceiling(l); r = ceiling(r); }
    this.l = l; this.r = r;
  }
}

/** Soft ceiling: transparent below 0.8, never above ±0.98 (≈ −0.2 dBFS). */
function ceiling(y) {
  const a = y < 0 ? -y : y;
  if (a <= 0.8) return y;
  const k = 0.8 + 0.18 * Math.tanh((a - 0.8) / 0.18);
  return y < 0 ? -k : k;
}

globalThis.PunchCore = PunchCore;
