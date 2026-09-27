// MORPH AudioWorklet — eight completely different sound engines, one at a
// time, each spread around the listener as several independently placed
// voices. See src/fx/morph.ts for the parameter model and knob meanings.
//
//   in L/R ─┬──────────────────────────────────────────────── dry ──┐
//           └ mono ─ ENGINE[algo] ─ voices v0..v15 ─ VBAP each onto  │
//                                     the speaker ring (home × spread │
//                                     + PATH motion) ─ diffusion ────┤
//   out[N] = softclip( dry·(1-mix) + field·mix ) ◄───────────────────┘
//
// Engines:
//   0 FM VOX     2-op phase modulation; the (auto-gained) voice is the
//                modulator, a tuned sine the carrier; carrier feedback.
//   1 GRAIN      2 s ring buffer, up to 16 Hann grains, re-pitched from an
//                interval set, each grain born at its own azimuth.
//   2 STRINGS    four Karplus-Strong waveguides tuned to a chord, excited
//                ("bowed") by the input plus optional noise.
//   3 VOWEL      3-formant vocal tract morphing A-E-I-O-U; the input is
//                flattened to a buzz first so the vowel reads clearly.
//   4 FOLD       sine wavefolder (Buchla 259 style) + Chebyshev T_n harmonic
//                generator, dynamics restored afterwards.
//   5 CHAOS      Lorenz attractor → TPT state-variable filter cutoff,
//                amplitude, and the two voices' positions.
//   6 SPECTRAL   phase-vocoder STFT (1024 / hop 256): freeze, smear,
//                bin-shift, natural / robot / whisper phase; resynthesised
//                as four frequency bands, each placed apart.
//   7 HARMONIC   resonator bank on the harmonic series of a chosen reference
//                (A440, A432, 528, Schumann ×16, golden-ratio partials),
//                optional binaural beat (second bank, detuned, other ear) and
//                an ear-soft dip of partials in the 2–5 kHz ear-canal band.
//
// Everything is deterministic (seeded PRNG) so export renders match playback.

const MAX_CH = 8;
const MAX_VOICES = 16;
const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;
// Silent blocks before reset + idle: strings / resonators / grain memory tail.
const QUIET_BLOCKS = Math.ceil((3 * sampleRate) / 128);

const RINGS = {
  6: [[2, 0], [1, 30], [5, 110], [4, 250], [0, 330]],
  8: [[2, 0], [1, 30], [7, 90], [5, 150], [4, 210], [6, 270], [0, 330]],
};

// Keep in sync with src/fx/morph.ts (a unit test checks).
const FM_RATIOS = [0.5, 1, 1.5, 2, 3, 3.5, 5, 7];
const STRING_CHORDS = [[0, 0.07, -0.07, 12], [0, 7, 12, 19], [0, 4, 7, 12], [0, 3, 7, 12], [0, 5, 7, 14], [0, 1, 2, 3]];
const TUNING_ROOTS = [130.81, 128.43, 132, 125.28, 130.81];
const PHI = (1 + Math.sqrt(5)) / 2;
// Formants (Hz) for A E I O U, and their relative levels.
const VOWELS = [[730, 1090, 2440], [530, 1840, 2480], [270, 2290, 3010], [570, 840, 2410], [300, 870, 2240]];
const FORMANT_GAIN = [1, 0.7, 0.4];

const semis = (n) => Math.pow(2, n / 12);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function softClip(y) {
  const a = Math.abs(y);
  if (a <= 0.8) return y;
  const k = 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2);
  return y < 0 ? -k : k;
}

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

/** RBJ constant-0 dB-peak bandpass (TDF-II). */
class Bandpass {
  constructor() { this.b0 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(freq, q) {
    const w0 = (TAU * clamp(freq, 20, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0; this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0; this.a2 = (1 - alpha) / a0;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = -this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z1 = 0; this.z2 = 0; }
}

/** Schroeder all-pass, used for per-speaker decorrelation. */
class AllPass {
  constructor(len, g) { this.buf = new Float32Array(len); this.i = 0; this.g = g; }
  process(x) {
    const d = this.buf[this.i];
    const y = -this.g * x + d;
    this.buf[this.i] = x + this.g * y;
    this.i = (this.i + 1) % this.buf.length;
    return y;
  }
}

/** Lorenz attractor, Euler-integrated a few steps per block. */
class Lorenz {
  constructor() { this.x = 0.1; this.y = 0; this.z = 20; }
  step(dt, rho, n) {
    for (let i = 0; i < n; i++) {
      const dx = 10 * (this.y - this.x);
      const dy = this.x * (rho - this.z) - this.y;
      const dz = this.x * this.y - (8 / 3) * this.z;
      this.x += dx * dt; this.y += dy * dt; this.z += dz * dt;
    }
  }
}

/** Slow random walk, -1..1, for SWARM motion. */
class Walker {
  constructor(rng) { this.rng = rng; this.v = rng.bipolar(); this.t = this.v; this.left = 0; }
  step(rate) {
    if (this.left <= 0) { this.t = this.rng.bipolar(); this.left = (0.3 + this.rng.next()) / Math.max(0.05, rate); }
    this.left -= 128 / sampleRate;
    this.v += (this.t - this.v) * Math.min(1, 3 * rate * 128 / sampleRate);
    return this.v;
  }
}

// ---- FFT (radix-2, in place) ----------------------------------------------

const N_FFT = 1024;
const HOP = 256;
const HALF = N_FFT / 2;
const BITREV = new Uint16Array(N_FFT);
const COS = new Float32Array(HALF);
const SIN = new Float32Array(HALF);
const HANN = new Float32Array(N_FFT);
{
  const bits = Math.log2(N_FFT);
  for (let i = 0; i < N_FFT; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    BITREV[i] = r;
  }
  for (let i = 0; i < HALF; i++) { COS[i] = Math.cos((TAU * i) / N_FFT); SIN[i] = Math.sin((TAU * i) / N_FFT); }
  for (let i = 0; i < N_FFT; i++) HANN[i] = 0.5 - 0.5 * Math.cos((TAU * i) / N_FFT);
}
/** In-place complex FFT; `inverse` flips the twiddle sign (no 1/N scaling). */
function fft(re, im, inverse) {
  for (let i = 0; i < N_FFT; i++) {
    const j = BITREV[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= N_FFT; size <<= 1) {
    const half = size >> 1;
    const step = N_FFT / size;
    for (let start = 0; start < N_FFT; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * step], wi = sgn * SIN[k * step];
        const a = start + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}
const princarg = (p) => p - TAU * Math.round(p / TAU);
// Spectral band edges (bins) for the four placed bands: ~0-375, -1.5k, -4.5k, rest.
const BAND_EDGES = [1, 8, 32, 96, HALF + 1];

const kParam = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "k-rate" });
const PARAMS = [
  kParam("mix", 0, 0, 1), kParam("algo", 0, 0, 7),
  kParam("a", 0.5, 0, 1), kParam("b", 0.5, 0, 1), kParam("c", 0.5, 0, 1), kParam("d", 0.5, 0, 1),
  kParam("note", 0, -24, 24), kParam("tuning", 0, 0, 4),
  kParam("spread", 0.7, 0, 1), kParam("path", 0, 0, 6), kParam("motion", 0.2, 0, 1), kParam("diffuse", 0, 0, 1),
];
const PARAM_NAMES = PARAMS.map((d) => d.name);

class MorphProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return PARAMS;
  }

  constructor() {
    super();
    this.rng = new Rng(0x6d6f7270);
    this.p = {};
    this.zero = new Float32Array(128);
    this.quiet = 0;
    this.idle = false;
    this.algo = -1;

    // Followers: fast amplitude, slow (for auto-gain).
    this.envF = 0; this.envS = 0;
    this.aF = Math.exp(-1 / (sampleRate * 0.003)); this.rF = Math.exp(-1 / (sampleRate * 0.06));
    this.aS = Math.exp(-1 / (sampleRate * 0.01)); this.rS = Math.exp(-1 / (sampleRate * 0.25));

    // Field.
    this.vs = new Float32Array(MAX_VOICES);
    this.home = new Float32Array(MAX_VOICES);   // -1..1, × spread × 180°
    this.fixedAz = new Float32Array(MAX_VOICES).fill(NaN); // absolute az overrides (binaural)
    this.pan = new Float32Array(MAX_VOICES * MAX_CH);
    this.field = new Float32Array(MAX_CH);
    this.nv = 0;
    this.pathPhase = 0;
    this.walkers = [];
    for (let v = 0; v < MAX_VOICES; v++) this.walkers.push(new Walker(this.rng));
    this.pathLorenz = new Lorenz();
    this.diff = [];
    const lens = [[142, 379], [163, 421], [191, 467], [211, 509], [233, 557], [257, 601], [277, 643], [307, 701]];
    for (let c = 0; c < MAX_CH; c++) this.diff.push([new AllPass(lens[c][0], 0.6), new AllPass(lens[c][1], 0.55)]);

    // FM.
    this.fmPhC = [0, 0.25]; this.fmPhM = [0, 0.5]; this.fmPrev = [0, 0];

    // Grain.
    this.gSize = Math.ceil(sampleRate * 2.2);
    this.gBuf = new Float32Array(this.gSize);
    this.gW = 0;
    this.gCount = 0;
    this.grains = [];
    for (let v = 0; v < MAX_VOICES; v++) this.grains.push({ on: false, pos: 0, inc: 1, t: 0, len: 1 });

    // Strings.
    this.sLen = 4096;
    this.sBuf = [0, 1, 2, 3].map(() => new Float32Array(this.sLen));
    this.sW = 0;
    this.sLp = new Float32Array(4);
    this.sDelay = new Float32Array(4);

    // Vowel.
    this.formants = [new Bandpass(), new Bandpass(), new Bandpass()];
    this.vowelPhase = 0;
    this.vLvlIn = 0; this.vLvlOut = 0;

    // Fold.
    this.dcX = [0, 0]; this.dcY = [0, 0]; this.lp = [0, 0];

    // Chaos.
    this.lorenz = new Lorenz();
    this.svfIc1 = 0; this.svfIc2 = 0;

    // Spectral.
    this.inRing = new Float32Array(N_FFT);
    this.inW = 0;
    this.hopCount = 0;
    this.re = new Float32Array(N_FFT); this.im = new Float32Array(N_FFT);
    this.re2 = new Float32Array(N_FFT); this.im2 = new Float32Array(N_FFT);
    this.mag = new Float32Array(HALF + 1); this.omega = new Float32Array(HALF + 1);
    this.holdMag = new Float32Array(HALF + 1); this.holdW = new Float32Array(HALF + 1);
    this.lastPh = new Float32Array(HALF + 1); this.synPh = new Float32Array(HALF + 1);
    this.outMag = new Float32Array(HALF + 1); this.outW = new Float32Array(HALF + 1);
    this.prefix = new Float32Array(HALF + 2);
    this.ola = [0, 1, 2, 3].map(() => new Float32Array(N_FFT));
    this.olaR = 0;

    // Harmonic.
    this.hBank = [];
    for (let v = 0; v < MAX_VOICES; v++) this.hBank.push(new Bandpass());
    this.hGain = new Float32Array(MAX_VOICES);
    this.hKey = "";
  }

  // ---- placement -----------------------------------------------------------

  setPan(v, az, nCh) {
    const pan = this.pan;
    const o = v * MAX_CH;
    for (let c = 0; c < MAX_CH; c++) pan[o + c] = 0;
    const ring = RINGS[nCh];
    if (!ring) {
      if (nCh === 1) { pan[o] = 1; return; }
      const a = ((Math.sin(az * DEG) + 1) * Math.PI) / 4;
      pan[o] = Math.cos(a);
      pan[o + 1] = Math.sin(a);
      return;
    }
    let a = az % 360; if (a < 0) a += 360;
    let i = 0;
    while (i < ring.length - 1 && ring[i + 1][1] <= a) i++;
    const s1 = ring[i];
    const s2 = ring[(i + 1) % ring.length];
    const a2 = i === ring.length - 1 ? s2[1] + 360 : s2[1];
    const t = (a - s1[1]) / (a2 - s1[1]);
    pan[o + s1[0]] = Math.cos((t * Math.PI) / 2);
    pan[o + s2[0]] = Math.sin((t * Math.PI) / 2);
  }

  /** Default homes: `n` voices evenly over -1..1 (one voice sits in front). */
  evenHomes(n) {
    for (let v = 0; v < MAX_VOICES; v++) { this.home[v] = n <= 1 ? 0 : -1 + (2 * v) / (n - 1); this.fixedAz[v] = NaN; }
  }

  placeVoices(p, nCh) {
    const rate = p.motion * p.motion * 2; // Hz, fine control at the slow end
    const t = 128 / sampleRate;
    this.pathPhase += rate * t; if (this.pathPhase >= 1) this.pathPhase -= 1;
    const ph = TAU * this.pathPhase;
    const path = Math.round(p.path);
    let lorenzAz = 0;
    if (path === 6) {
      this.pathLorenz.step(0.0005 + rate * 0.004, 28, 4);
      lorenzAz = Math.atan2(this.pathLorenz.x, this.pathLorenz.y) / DEG;
    }
    const reach = 180 * p.spread;
    for (let v = 0; v < this.nv; v++) {
      if (!Number.isNaN(this.fixedAz[v])) { this.setPan(v, this.fixedAz[v], nCh); continue; }
      const h = this.home[v];
      let az = h * reach;
      switch (path) {
        case 1: az += 360 * this.pathPhase; break;                                   // circle
        case 2: az += 90 * Math.sin(ph); break;                                       // pendulum
        case 3: az += (h < 0 ? -1 : 1) * 180 * (0.5 - 0.5 * Math.cos(ph)); break;    // front ↔ back fly-over
        case 4: az += (v % 2 ? 1 : -1) * 120 * Math.sin(ph); break;                  // figure-8: pairs cross
        case 5: az += 150 * this.walkers[v].step(Math.max(0.1, rate * 2)); break;     // swarm
        case 6: az += lorenzAz; break;                                                // strange attractor
      }
      this.setPan(v, az, nCh);
    }
  }

  // ---- per-block engine setup ----------------------------------------------

  prepare(p, algo) {
    const root = TUNING_ROOTS[clamp(Math.round(p.tuning), 0, 4)] * semis(Math.round(p.note));
    switch (algo) {
      case 0: {
        this.nv = 2; this.evenHomes(2); this.home[0] = -0.35; this.home[1] = 0.35;
        this.fmFc = root * 2;
        this.fmRatio = FM_RATIOS[Math.min(FM_RATIOS.length - 1, Math.floor(p.a * FM_RATIOS.length))];
        this.fmIndex = p.b * 6;
        this.fmFb = p.c * 1.2;
        this.fmVoice = p.d;
        break;
      }
      case 1: {
        if (this.nv !== MAX_VOICES) { this.nv = MAX_VOICES; this.evenHomes(MAX_VOICES); }
        this.gRate = 3 + p.a * 57;
        this.gLen = Math.floor(sampleRate * (0.02 + p.b * 0.23));
        this.gPitch = p.c;
        this.gBack = p.d * 1.5;
        const overlap = Math.max(1, this.gRate * this.gLen / sampleRate);
        this.gNorm = 1.6 / Math.sqrt(overlap);
        break;
      }
      case 2: {
        this.nv = 4; this.evenHomes(4);
        const chord = STRING_CHORDS[Math.min(STRING_CHORDS.length - 1, Math.floor(p.c * STRING_CHORDS.length))];
        for (let k = 0; k < 4; k++) {
          let f = root * semis(chord[k]);
          while (f < sampleRate / (this.sLen - 4)) f *= 2;
          this.sDelay[k] = sampleRate / f;
        }
        this.sFb = 0.9 + 0.0995 * Math.sqrt(p.a);
        this.sDamp = 0.08 + 0.88 * p.b;
        this.sNoise = p.d;
        this.sExc = 0.35 * (1 - this.sFb) * 40 + 0.02;
        break;
      }
      case 3: {
        this.nv = 3; this.evenHomes(3); this.home[0] = 0; this.home[1] = -0.8; this.home[2] = 0.8;
        this.vowelPhase += p.b * 6 * (128 / sampleRate); if (this.vowelPhase >= 1) this.vowelPhase -= 1;
        let pos = p.a * 4 + p.c * 2 * Math.sin(TAU * this.vowelPhase);
        // Reflect into 0..4 so the morph bounces off A and U.
        pos = Math.abs(pos); pos = pos % 8; if (pos > 4) pos = 8 - pos;
        const i = Math.min(3, Math.floor(pos)); const f = pos - i;
        const scale = 1.35 - 0.7 * p.d;
        for (let k = 0; k < 3; k++) {
          const hz = (VOWELS[i][k] + (VOWELS[i + 1][k] - VOWELS[i][k]) * f) * scale;
          this.formants[k].set(hz, 6 + 3 * k);
        }
        break;
      }
      case 4: {
        this.nv = 2; this.evenHomes(2); this.home[0] = -0.5; this.home[1] = 0.5;
        this.fDrive = 0.5 + p.a * 4;
        this.fFolds = 1 + p.b * 6;
        this.fSym = p.c * 0.9;
        this.fOrder = 2 + p.d * 6;
        this.fChebLvl = 0.3 + 0.7 * p.d;
        break;
      }
      case 5: {
        this.nv = 2; this.evenHomes(2);
        const rho = 14 + p.c * 36;
        this.lorenz.step(0.0004 + p.a * 0.006, rho, 4);
        const L = this.lorenz;
        const xn = clamp(L.x / 20, -1, 1);
        const cutoff = clamp(1200 * Math.pow(2, xn * p.b * 4), 60, 12000);
        const g = Math.tan((Math.PI * cutoff) / sampleRate);
        const k = 2 - 1.7 * (0.3 + 0.6 * p.b);
        this.svfA1 = 1 / (1 + g * (g + k)); this.svfA2 = g * this.svfA1; this.svfA3 = g * this.svfA2; this.svfK = k;
        this.cAmp = 1 - p.d * clamp(L.z / 50, 0, 1);
        const az = Math.atan2(L.x, L.y) / DEG;
        // The attractor *is* the path here: both voices fly on it, opposite.
        this.fixedAz[0] = az * p.spread; this.fixedAz[1] = (az + 180) * p.spread;
        break;
      }
      case 6: {
        this.nv = 4; this.evenHomes(4);
        this.home[0] = 0; this.home[1] = -0.7; this.home[2] = 0.7; this.home[3] = 1;
        this.spFreeze = p.a;
        this.spSmear = Math.round(p.b * 12);
        this.spPhase = p.c < 1 / 3 ? 0 : p.c < 2 / 3 ? 1 : 2;
        this.spShift = Math.round((p.d - 0.5) * 48);
        break;
      }
      case 7: {
        const beat = p.c > 0.01 ? p.c * 12 : 0;
        const K = 1 + Math.round(p.a * 7);
        const phi = Math.round(p.tuning) === 4;
        const key = `${root}|${K}|${p.b}|${beat}|${p.d}|${phi}`;
        this.nv = beat > 0 ? 2 * K : K;
        this.evenHomes(K);
        if (key !== this.hKey) {
          this.hKey = key;
          const q = 20 + p.b * 280;
          for (let k = 0; k < K; k++) {
            let f = phi ? root * Math.pow(PHI, k) : root * (k + 1);
            while (f > 9000) f /= 2;
            const oct = Math.log2(f / 3500);
            const earDip = 1 - p.d * 0.85 * Math.exp(-(oct * oct) / (2 * 0.45 * 0.45));
            const g = Math.pow(k + 1, -0.6) * earDip * Math.sqrt(q) * 3.3;
            this.hBank[k].set(f, q); this.hGain[k] = g;
            if (beat > 0) { this.hBank[K + k].set(f + beat, q); this.hGain[K + k] = g; }
          }
        }
        if (beat > 0) {
          // A binaural beat needs each ear to get its own bank: pin them left/right.
          for (let k = 0; k < K; k++) { this.fixedAz[k] = -90; this.fixedAz[K + k] = 90; }
        }
        this.hK = K;
        break;
      }
    }
  }

  reset() {
    this.envF = 0; this.envS = 0;
    this.gBuf.fill(0); for (const g of this.grains) g.on = false;
    for (const b of this.sBuf) b.fill(0); this.sLp.fill(0);
    for (const f of this.formants) f.reset();
    this.vLvlIn = 0; this.vLvlOut = 0;
    this.dcX = [0, 0]; this.dcY = [0, 0]; this.lp = [0, 0];
    this.svfIc1 = 0; this.svfIc2 = 0;
    this.inRing.fill(0); for (const o of this.ola) o.fill(0);
    this.holdMag.fill(0); this.holdW.fill(0); this.lastPh.fill(0); this.synPh.fill(0);
    for (const b of this.hBank) b.reset();
    for (const d of this.diff) for (const ap of d) ap.buf.fill(0);
    this.fmPrev = [0, 0];
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    const nCh = output.length;
    const frames = output[0].length;
    if (this.zero.length < frames) this.zero = new Float32Array(frames);
    const hasInput = input && input.length > 0;
    const nIn = hasInput ? input.length : 0;
    const inL = hasInput ? input[0] : this.zero;
    const inR = hasInput ? input[1] || input[0] : this.zero;

    let silent = true;
    for (let n = 0; n < frames; n++) if (inL[n] !== 0 || inR[n] !== 0) { silent = false; break; }
    if (silent) {
      if (this.quiet < QUIET_BLOCKS) this.quiet++;
      else {
        if (!this.idle) { this.reset(); this.idle = true; }
        for (let ch = 0; ch < nCh; ch++) output[ch].fill(0);
        return true;
      }
    } else { this.quiet = 0; this.idle = false; }

    const mix = params.mix[0];
    const dryOf = (c) => (c < nIn ? input[c] : c === 1 ? inR : null);
    if (mix <= 0) {
      for (let c = 0; c < nCh; c++) { const d = dryOf(c); if (d) output[c].set(d); else output[c].fill(0); }
      return true;
    }

    const p = this.p;
    for (let i = 0; i < PARAM_NAMES.length; i++) p[PARAM_NAMES[i]] = params[PARAM_NAMES[i]][0];
    const algo = clamp(Math.round(p.algo), 0, 7);
    if (algo !== this.algo) { this.algo = algo; this.reset(); this.hKey = ""; this.nv = 0; this.evenHomes(0); }
    this.prepare(p, algo);
    this.placeVoices(p, nCh);

    const vs = this.vs, pan = this.pan, field = this.field, nv = this.nv;
    const diffuse = p.diffuse;
    const dA = Math.cos((diffuse * Math.PI) / 2), dB = Math.sin((diffuse * Math.PI) / 2);
    const dryMix = 1 - mix;

    for (let n = 0; n < frames; n++) {
      const x = 0.5 * (inL[n] + inR[n]);
      const ax = Math.abs(x);
      this.envF = ax > this.envF ? this.envF + (ax - this.envF) * (1 - this.aF) : this.envF * this.rF;
      this.envS = ax > this.envS ? this.envS + (ax - this.envS) * (1 - this.aS) : this.envS * this.rS;

      for (let v = 0; v < nv; v++) vs[v] = 0;
      switch (algo) {
        case 0: this.runFm(x); break;
        case 1: this.runGrain(x); break;
        case 2: this.runStrings(x); break;
        case 3: this.runVowel(x); break;
        case 4: this.runFold(x); break;
        case 5: this.runChaos(x); break;
        case 6: this.runSpectral(x); break;
        case 7: this.runHarmonic(x); break;
      }

      for (let c = 0; c < nCh; c++) field[c] = 0;
      for (let v = 0; v < nv; v++) {
        const s = vs[v];
        if (s === 0) continue;
        const o = v * MAX_CH;
        for (let c = 0; c < nCh; c++) field[c] += s * pan[o + c];
      }
      for (let c = 0; c < nCh; c++) {
        let w = field[c];
        if (diffuse > 0) { const d = this.diff[c]; w = dA * w + dB * d[1].process(d[0].process(w)); }
        const dry = dryOf(c);
        output[c][n] = softClip((dry ? dry[n] : 0) * dryMix + w * mix);
      }
    }
    return true;
  }

  /** The voice normalised to roughly ±1 regardless of how loud it is. */
  agc(x) {
    return Math.tanh(x / (this.envS + 0.003));
  }

  runFm(x) {
    const xn = this.agc(x) * this.fmVoice;
    const amp = this.envF * 0.5;
    const vs = this.vs;
    for (let k = 0; k < 2; k++) {
      const det = k ? 1.004 : 1;
      const fc = this.fmFc * det;
      const mod = xn + (1 - this.fmVoice) * Math.sin(TAU * this.fmPhM[k]);
      const y = Math.sin(TAU * this.fmPhC[k] + this.fmIndex * (k ? 0.8 : 1) * mod + this.fmFb * this.fmPrev[k]);
      this.fmPrev[k] = y;
      this.fmPhC[k] += fc / sampleRate; if (this.fmPhC[k] >= 1) this.fmPhC[k] -= 1;
      this.fmPhM[k] += (fc * this.fmRatio) / sampleRate; if (this.fmPhM[k] >= 1) this.fmPhM[k] -= 1;
      vs[k] = y * amp;
    }
  }

  runGrain(x) {
    const buf = this.gBuf, size = this.gSize;
    buf[this.gW] = x;
    if (--this.gCount <= 0) {
      this.gCount = Math.max(1, Math.floor((sampleRate / this.gRate) * (0.6 + 0.8 * this.rng.next())));
      this.spawnGrain();
    }
    const vs = this.vs;
    for (let v = 0; v < MAX_VOICES; v++) {
      const g = this.grains[v];
      if (!g.on) continue;
      let pos = g.pos % size; if (pos < 0) pos += size;
      const i = pos | 0, f = pos - i;
      const a = buf[i], b = buf[(i + 1) % size];
      const w = 0.5 - 0.5 * Math.cos((TAU * g.t) / g.len);
      vs[v] = (a + (b - a) * f) * w * this.gNorm;
      g.pos += g.inc;
      if (++g.t >= g.len) g.on = false;
    }
    this.gW = (this.gW + 1) % size;
  }

  spawnGrain() {
    let slot = -1;
    for (let v = 0; v < MAX_VOICES; v++) if (!this.grains[v].on) { slot = v; break; }
    if (slot < 0) return;
    const r = this.rng;
    let semi = 0;
    if (r.next() < this.gPitch) semi = [12, -12, 7, 5, -5, 19, 24][Math.floor(r.next() * 7)];
    semi += r.bipolar() * this.gPitch * 0.3;
    const inc = semis(semi);
    const len = this.gLen;
    // Start far enough back that a faster-than-real grain never overtakes the write head.
    const back = len * Math.max(1, inc) + 64 + r.next() * this.gBack * sampleRate;
    const g = this.grains[slot];
    g.on = true; g.inc = inc; g.t = 0; g.len = len; g.pos = this.gW - Math.min(back, this.gSize - 2);
    this.home[slot] = r.bipolar();
  }

  runStrings(x) {
    const exc = x * this.sExc + this.sNoise * this.rng.bipolar() * this.envF * 0.25;
    const L = this.sLen, w = this.sW;
    for (let k = 0; k < 4; k++) {
      const buf = this.sBuf[k];
      let r = w - this.sDelay[k]; if (r < 0) r += L;
      const i = r | 0, f = r - i;
      const a = buf[i], b = buf[(i + 1) % L];
      const y = a + (b - a) * f;
      this.sLp[k] += this.sDamp * (y - this.sLp[k]);
      buf[w] = exc + this.sFb * this.sLp[k];
      this.vs[k] = this.sLp[k] * 0.45;
    }
    this.sW = (w + 1) % L;
  }

  runVowel(x) {
    // Flatten the voice into a bright buzz so the tract's formants dominate.
    const buzz = Math.tanh(3 * this.agc(x)) * this.envF;
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      const y = this.formants[k].process(buzz) * FORMANT_GAIN[k];
      this.vs[k] = y; sum += Math.abs(y);
    }
    // Level-match the tract output to the input (~50 ms).
    const c = 0.9996;
    this.vLvlIn = this.vLvlIn * c + Math.abs(x) * (1 - c);
    this.vLvlOut = this.vLvlOut * c + sum * (1 - c);
    const g = Math.min(12, this.vLvlIn / (this.vLvlOut + 1e-5));
    for (let k = 0; k < 3; k++) this.vs[k] *= g * 1.9;
  }

  runFold(x) {
    const xn = (x / (this.envS + 0.02)) * this.fDrive;
    const fold = Math.sin((Math.PI / 2) * (xn * this.fFolds + this.fSym));
    const t = Math.tanh(xn);
    // Chebyshev T_n(t) by recurrence, crossfading fractional orders.
    const n0 = Math.floor(this.fOrder), fr = this.fOrder - n0;
    let tPrev = 1, tCur = t, tn0 = 0, tn1 = 0;
    for (let k = 1; k <= n0 + 1; k++) {
      if (k === n0) tn0 = tCur;
      if (k === n0 + 1) tn1 = tCur;
      const next = 2 * t * tCur - tPrev; tPrev = tCur; tCur = next;
    }
    const cheb = tn0 + (tn1 - tn0) * fr;
    const env = this.envF;
    const outs = [fold * env, cheb * env * this.fChebLvl];
    for (let k = 0; k < 2; k++) {
      // DC blocker (fold symmetry makes DC) then a gentle top-end tame.
      const y = outs[k] - this.dcX[k] + 0.995 * this.dcY[k];
      this.dcX[k] = outs[k]; this.dcY[k] = y;
      this.lp[k] += 0.55 * (y - this.lp[k]);
      this.vs[k] = this.lp[k];
    }
  }

  runChaos(x) {
    const v0 = x;
    const v3 = v0 - this.svfIc2;
    const v1 = this.svfA1 * this.svfIc1 + this.svfA2 * v3;
    const v2 = this.svfIc2 + this.svfA2 * this.svfIc1 + this.svfA3 * v3;
    this.svfIc1 = 2 * v1 - this.svfIc1;
    this.svfIc2 = 2 * v2 - this.svfIc2;
    this.vs[0] = v2 * this.cAmp * 1.9;          // low-pass
    this.vs[1] = v1 * this.cAmp * 2.8;          // band-pass
  }

  runSpectral(x) {
    this.inRing[this.inW] = x;
    this.inW = (this.inW + 1) % N_FFT;
    for (let b = 0; b < 4; b++) {
      const o = this.ola[b];
      this.vs[b] = o[this.olaR];
      o[this.olaR] = 0;
    }
    this.olaR = (this.olaR + 1) % N_FFT;
    if (++this.hopCount >= HOP) { this.hopCount = 0; this.spectralFrame(); }
  }

  spectralFrame() {
    const re = this.re, im = this.im;
    for (let i = 0; i < N_FFT; i++) { re[i] = this.inRing[(this.inW + i) % N_FFT] * HANN[i]; im[i] = 0; }
    fft(re, im, false);
    const mag = this.mag, om = this.omega, hold = this.holdMag, holdW = this.holdW;
    const expect = (TAU * HOP) / N_FFT;
    const fz = this.spFreeze;
    for (let k = 0; k <= HALF; k++) {
      const m = Math.hypot(re[k], im[k]);
      const ph = Math.atan2(im[k], re[k]);
      const w = expect * k + princarg(ph - this.lastPh[k] - expect * k);
      this.lastPh[k] = ph;
      hold[k] = hold[k] * fz + m * (1 - fz);
      holdW[k] = holdW[k] * fz + w * (1 - fz);
    }
    // Smear: box-blur the magnitudes across ±smear bins (prefix sums).
    const S = this.spSmear;
    if (S > 0) {
      const pre = this.prefix; pre[0] = 0;
      for (let k = 0; k <= HALF; k++) pre[k + 1] = pre[k] + hold[k];
      for (let k = 0; k <= HALF; k++) {
        const lo = Math.max(0, k - S), hi = Math.min(HALF, k + S);
        mag[k] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
      }
    } else mag.set(hold);
    // Shift bins.
    const sh = this.spShift, outM = this.outMag, outW = this.outW;
    for (let k = 0; k <= HALF; k++) {
      const s = k - sh;
      if (s < 1 || s > HALF) { outM[k] = 0; outW[k] = expect * k; continue; }
      outM[k] = mag[s]; outW[k] = holdW[s] + expect * sh;
    }
    // Phase.
    const syn = this.synPh;
    for (let k = 0; k <= HALF; k++) {
      if (this.spPhase === 0) syn[k] = princarg(syn[k] + outW[k]);
      else if (this.spPhase === 1) syn[k] = (k & 1) * Math.PI; // zero phase, centred in the frame
      else syn[k] = TAU * this.rng.next();
    }
    // Resynthesise bands in pairs: one complex IFFT carries two real signals.
    const scale = 1 / (N_FFT * 1.5); // 1/N for the IFFT, 1.5 = Hann² overlap sum at hop N/4
    for (let pair = 0; pair < 2; pair++) {
      const r2 = this.re2, i2 = this.im2;
      r2.fill(0); i2.fill(0);
      for (let side = 0; side < 2; side++) {
        const band = pair * 2 + side;
        for (let k = BAND_EDGES[band]; k < BAND_EDGES[band + 1]; k++) {
          const ar = outM[k] * Math.cos(syn[k]), ai = outM[k] * Math.sin(syn[k]);
          // X = A + iB, with A, B Hermitian: bin k gets A_k + iB_k, bin N-k gets conj(A_k) + i·conj(B_k).
          if (side === 0) {
            r2[k] += ar; i2[k] += ai;
            if (k !== HALF) { r2[N_FFT - k] += ar; i2[N_FFT - k] -= ai; }
          } else {
            r2[k] -= ai; i2[k] += ar;
            if (k !== HALF) { r2[N_FFT - k] += ai; i2[N_FFT - k] += ar; }
          }
        }
      }
      fft(r2, i2, true);
      const oa = this.ola[pair * 2], ob = this.ola[pair * 2 + 1];
      for (let i = 0; i < N_FFT; i++) {
        const j = (this.olaR + i) % N_FFT;
        oa[j] += r2[i] * HANN[i] * scale;
        ob[j] += i2[i] * HANN[i] * scale;
      }
    }
  }

  runHarmonic(x) {
    const n = this.nv;
    for (let v = 0; v < n; v++) this.vs[v] = this.hBank[v].process(x) * this.hGain[v];
  }
}

registerProcessor("morph-processor", MorphProcessor);
