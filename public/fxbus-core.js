// FX BUS core DSP — the SP-style performance effects (docs/sampler-research.md
// §3.2). Shared by the `fxbus-processor` AudioWorklet and ported line by line
// to native/src/fxbus.rs, so both engines sound the same.
//
// Loaded as a module; it also parks the class on globalThis so the worklet
// (a separate module in the same AudioWorkletGlobalScope) can find it.
//
// One bus holds one effect with two macros, A and B (0..1), and a DEPTH
// (0..1: how far it's engaged — latched on = 1, or how hard R2 is pulled).
// Every setting glides over 20 ms. Effects, by id:
//   0 OFF       passes through
//   1 VINYL     A age: wow, duller, thinner · B noise: crackle + hiss
//   2 CASSETTE  A wear: wow + flutter, saturation, duller · B hiss + dropouts
//   3 LO-FI     A bits 16 → 4 · B sample rate 48 k → 1.5 k (no anti-aliasing)
//   4 FILTER    A cutoff: below ½ low-pass sweeping down, above ½ high-pass
//               sweeping up · B resonance + drive
//   5 ECHO      A time 60 ms → 0.96 s · B feedback (darker each repeat);
//               depth feeds the echo, so the tail rings on after release
//   6 LOOPER    engaging (depth > ½) loops the last moment (A: 500 → 16 ms,
//               shrinking while held) · B speed ½× → 2×
// Insert effects crossfade dry → wet by depth; noise is deterministic
// (xorshift32), so a render is repeatable.

const TAU = 2 * Math.PI;
const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const SMOOTH = 0.02;
const MAX_DELAY = 2;
const HISTORY = 0.6;
const LOOP_MAX = 0.5;
const LOOP_FADE = 64;
const SEED = 0x5eed1234;

class FxRng {
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

export class FxBusCore {
  constructor(sr) {
    this.sr = sr;
    this.k = Math.exp(-1 / (sr * SMOOTH));
    this.gEcho = 1 - Math.exp((-TAU * 3500) / sr);
    this.dlen = Math.ceil(sr * MAX_DELAY) + 4;
    this.dl = new Float32Array(this.dlen);
    this.dr = new Float32Array(this.dlen);
    this.hlen = Math.ceil(sr * HISTORY);
    this.hl = new Float32Array(this.hlen);
    this.hr = new Float32Array(this.hlen);
    this.maxLoop = Math.round(sr * LOOP_MAX);
    this.ll = new Float32Array(this.maxLoop);
    this.lr = new Float32Array(this.maxLoop);
    this.effect = 0; this.a = 0.5; this.b = 0.5; this.depth = 0;
    this.sA = 0.5; this.sB = 0.5; this.sD = 0;
    this.fresh = true;
    this.ox = 0; this.oy = 0;
    this.reset();
  }

  reset() {
    this.dl.fill(0); this.dr.fill(0); this.dpos = 0;
    this.hl.fill(0); this.hr.fill(0); this.hpos = 0;
    this.ll.fill(0); this.lr.fill(0);
    this.rng = new FxRng(SEED);
    this.lfo = 0; this.lfo2 = 0;
    this.lp1 = 0; this.lp2 = 0; this.hp1 = 0; this.hp2 = 0;
    this.crk = 0; this.dip = 1; this.dipT = 0; this.dipTo = 1;
    this.ph = 1; this.hol = 0; this.hor = 0;
    this.i1l = 0; this.i2l = 0; this.i1r = 0; this.i2r = 0;
    this.engaged = false; this.sG = 0; this.loopStart = 0; this.loopLen = 32; this.lpos = 0;
  }

  /** { effect, a, b, depth } — any subset. A new effect starts from silence. */
  set(p) {
    if (p.effect !== undefined) {
      const e = clampN(p.effect | 0, 0, 6);
      if (e !== this.effect) { this.effect = e; this.reset(); }
    }
    if (p.a !== undefined) this.a = clampN(+p.a || 0, 0, 1);
    if (p.b !== undefined) this.b = clampN(+p.b || 0, 0, 1);
    if (p.depth !== undefined) this.depth = clampN(+p.depth || 0, 0, 1);
    if (this.fresh) { this.fresh = false; this.sA = this.a; this.sB = this.b; this.sD = this.depth; }
  }

  /** Newest-relative read, `d` (≥ 1) samples back, linear. */
  read(buf, d) {
    const p = this.dpos - d + this.dlen;
    const i0 = Math.floor(p);
    const f = p - i0;
    const a = buf[i0 % this.dlen];
    const b = buf[(i0 + 1) % this.dlen];
    return a + (b - a) * f;
  }

  push(x, y) {
    this.dl[this.dpos] = x;
    this.dr[this.dpos] = y;
    this.dpos = (this.dpos + 1) % this.dlen;
  }

  capture() {
    const m = this.maxLoop;
    for (let j = 0; j < m; j++) {
      const idx = (this.hpos - m + j + this.hlen) % this.hlen;
      this.ll[j] = this.hl[idx];
      this.lr[j] = this.hr[idx];
    }
    const len0 = clampN(Math.round(this.sr * LOOP_MAX * Math.pow(2, -5 * this.a)), 32, m);
    this.loopStart = m - len0;
    this.lpos = 0;
  }

  /** Process `n` frames of L/R in place. */
  process(L, R, n) {
    const e = this.effect;
    if (e === 0) {
      this.sA = this.a; this.sB = this.b; this.sD = this.depth;
      return;
    }
    if (e === 6) {
      const on = this.depth > 0.5;
      if (on && !this.engaged) this.capture();
      this.engaged = on;
      if (on) this.loopLen = clampN(Math.round(this.sr * LOOP_MAX * Math.pow(2, -5 * this.a)), 32, this.maxLoop - this.loopStart);
      if (this.lpos >= this.loopLen) this.lpos %= this.loopLen;
    }
    const k = this.k;
    for (let i = 0; i < n; i++) {
      this.sA = this.a + (this.sA - this.a) * k;
      this.sB = this.b + (this.sB - this.b) * k;
      this.sD = this.depth + (this.sD - this.depth) * k;
      const x = L[i], y = R[i];
      switch (e) {
        case 1: this.vinyl(x, y); break;
        case 2: this.cassette(x, y); break;
        case 3: this.lofi(x, y); break;
        case 4: this.filter(x, y); break;
        case 5: this.echo(x, y); break;
        default: this.looper(x, y); break;
      }
      L[i] = this.ox;
      R[i] = this.oy;
    }
  }

  vinyl(x, y) {
    const sr = this.sr, sA = this.sA, sB = this.sB, sD = this.sD;
    this.lfo += 0.55 / sr;
    if (this.lfo >= 1) this.lfo -= 1;
    this.push(x, y);
    const d = ((5 + (0.2 + 2.8 * sA) * Math.sin(TAU * this.lfo)) * sr) / 1000;
    const wl = this.read(this.dl, d), wr = this.read(this.dr, d);
    const g = 1 - Math.exp((-TAU * 18000 * Math.pow(2, -3.5 * sA)) / sr);
    this.lp1 += (wl - this.lp1) * g;
    this.lp2 += (wr - this.lp2) * g;
    const gh = 1 - Math.exp((-TAU * (40 + 160 * sA)) / sr);
    this.hp1 += (this.lp1 - this.hp1) * gh;
    this.hp2 += (this.lp2 - this.hp2) * gh;
    const r1 = this.rng.next(), r2 = this.rng.bipolar(), r3 = this.rng.bipolar();
    if (r1 < (2 + 60 * sB) / sr) this.crk += r2 * (0.15 + 0.35 * sB);
    this.crk *= 0.55;
    const noise = this.crk + r3 * 0.003 * sB;
    this.ox = x + (this.lp1 - this.hp1 + noise - x) * sD;
    this.oy = y + (this.lp2 - this.hp2 + noise - y) * sD;
  }

  cassette(x, y) {
    const sr = this.sr, sA = this.sA, sB = this.sB, sD = this.sD;
    this.lfo += 0.8 / sr;
    if (this.lfo >= 1) this.lfo -= 1;
    this.lfo2 += 7.3 / sr;
    if (this.lfo2 >= 1) this.lfo2 -= 1;
    this.push(x, y);
    const d = ((6 + (0.05 + 0.6 * sA) * (Math.sin(TAU * this.lfo) + 0.35 * Math.sin(TAU * this.lfo2))) * sr) / 1000;
    const gs = 1 + 3 * sA;
    const nrm = Math.tanh(gs);
    const wl = Math.tanh(this.read(this.dl, d) * gs) / nrm;
    const wr = Math.tanh(this.read(this.dr, d) * gs) / nrm;
    const g = 1 - Math.exp((-TAU * 12000 * Math.pow(2, -2.5 * sA)) / sr);
    this.lp1 += (wl - this.lp1) * g;
    this.lp2 += (wr - this.lp2) * g;
    const r1 = this.rng.next(), r2 = this.rng.bipolar();
    if (this.dipT > 0) this.dipT--;
    else if (r1 < (0.3 + 2 * sB) / sr) {
      this.dipT = Math.floor((0.03 + 0.09 * this.rng.next()) * sr);
      this.dipTo = 1 - (0.3 + 0.6 * this.rng.next()) * sB;
    }
    this.dip += ((this.dipT > 0 ? this.dipTo : 1) - this.dip) * 0.002;
    const hiss = r2 * 0.006 * sB;
    this.ox = x + (this.lp1 * this.dip + hiss - x) * sD;
    this.oy = y + (this.lp2 * this.dip + hiss - y) * sD;
  }

  lofi(x, y) {
    const sD = this.sD;
    const q = Math.pow(2, 1 - (16 - 12 * this.sA));
    this.ph += Math.pow(2, -5 * this.sB);
    if (this.ph >= 1) {
      this.ph -= Math.floor(this.ph);
      this.hol = Math.floor(x / q + 0.5) * q;
      this.hor = Math.floor(y / q + 0.5) * q;
    }
    this.ox = x + (this.hol - x) * sD;
    this.oy = y + (this.hor - y) * sD;
  }

  filter(x, y) {
    const sr = this.sr, sA = this.sA, sB = this.sB, sD = this.sD;
    const low = sA < 0.5;
    const fc = Math.min(sr * 0.45, low ? 20000 * Math.pow(2, -(0.5 - sA) * 18) : 20 * Math.pow(2, (sA - 0.5) * 19));
    const gg = Math.tan((Math.PI * fc) / sr);
    const kk = 2 - 1.85 * sB;
    const a1 = 1 / (1 + gg * (gg + kk)), a2 = gg * a1, a3 = gg * a2;
    const gd = 1 + 2 * sB;
    const nd = Math.tanh(gd);
    let xin = Math.tanh(x * gd) / nd;
    let v3 = xin - this.i2l;
    let v1 = a1 * this.i1l + a2 * v3;
    let v2 = this.i2l + a2 * this.i1l + a3 * v3;
    this.i1l = 2 * v1 - this.i1l;
    this.i2l = 2 * v2 - this.i2l;
    const fl = low ? v2 : xin - kk * v1 - v2;
    xin = Math.tanh(y * gd) / nd;
    v3 = xin - this.i2r;
    v1 = a1 * this.i1r + a2 * v3;
    v2 = this.i2r + a2 * this.i1r + a3 * v3;
    this.i1r = 2 * v1 - this.i1r;
    this.i2r = 2 * v2 - this.i2r;
    const fr = low ? v2 : xin - kk * v1 - v2;
    this.ox = x + (fl - x) * sD;
    this.oy = y + (fr - y) * sD;
  }

  echo(x, y) {
    const sr = this.sr;
    const t = 0.06 * Math.pow(2, 4 * this.sA);
    const fb = 0.92 * this.sB;
    const el = this.read(this.dl, t * sr), er = this.read(this.dr, t * 1.03 * sr);
    this.lp1 += (el - this.lp1) * this.gEcho;
    this.lp2 += (er - this.lp2) * this.gEcho;
    this.push(x * this.sD + Math.tanh(this.lp1 * fb), y * this.sD + Math.tanh(this.lp2 * fb));
    this.ox = x + el * 0.7;
    this.oy = y + er * 0.7;
  }

  looper(x, y) {
    this.hl[this.hpos] = x;
    this.hr[this.hpos] = y;
    this.hpos = (this.hpos + 1) % this.hlen;
    const want = this.engaged ? 1 : 0;
    this.sG = want + (this.sG - want) * this.k;
    if (!this.engaged && this.sG < 1e-4) {
      this.ox = x;
      this.oy = y;
      return;
    }
    const p = this.loopStart + this.lpos;
    const i0 = Math.floor(p);
    const f = p - i0;
    const i1 = Math.min(i0 + 1, this.loopStart + this.loopLen - 1);
    const vl = this.ll[i0] + (this.ll[i1] - this.ll[i0]) * f;
    const vr = this.lr[i0] + (this.lr[i1] - this.lr[i0]) * f;
    const fl = Math.min(LOOP_FADE, this.loopLen / 4);
    const fade = Math.min(1, this.lpos / fl, (this.loopLen - this.lpos) / fl);
    this.lpos += Math.pow(2, (this.sB - 0.5) * 2);
    if (this.lpos >= this.loopLen) this.lpos -= this.loopLen;
    this.ox = x + (vl * fade - x) * this.sG;
    this.oy = y + (vr * fade - y) * this.sG;
  }
}

globalThis.FxBusCore = FxBusCore;
