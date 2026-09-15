// Voice Synth AudioWorklet — a VocalSynth-style vocal engine with a stacked,
// modulated, surround-placed voice field.
//
// Signal flow (everything wet is mono-analysed, then placed into the field):
//
//   in L/R ─┬─────────────────────────────────────────── dry ──┐
//           └ mono ─ 20-band analysis ─ formant re-weight ─┐    │
//                       │ (band envelopes)                 │    │
//                       │                          SHIFT ──┤    │
//                       │                          ×unison │    │
//                       │                          sub/shim│    │
//                       │                          POLYVOX ├─ pan each layer
//                       └── carrier (saw/pulse/…) VOCODER ─┤   into N channels ─ ring ─ ensemble ─┐
//                                                 TALKBOX ─┤                                       │
//                                                 COMPUVOX ┘                                       │
//   out[N] = softclip( dry·(1-mix) + (field + center·dry→C + lfe→LFE)·mix ) ◄────────────────────┘
//
// Engines (each has its own level, all can run at once — that is the "stack"):
//   SHIFT     dual-delay-line ("Doppler") pitch shifter + formant shift.
//   VOCODER   channel vocoder: the voice's band envelopes gate a polyBLEP saw
//             chord carrier; noise is blended into the top bands so
//             consonants survive.
//   TALKBOX   the vocoder on a buzzy pulse+saw carrier, sharper bands, drive.
//   COMPUVOX  "Speak & Spell": pulse-train vocoder + sample-hold decimation
//             and bit reduction. `character` = crush amount.
//   POLYVOX   harmoniser: shifted copies at the chord intervals, detuned by
//             `character`.
//
// Modulation (all block-rate, 128 samples):
//   vibrato LFO · random drift (one walker per stacked voice) · glide ·
//   formant LFO · the voice's own loudness → pitch / formant / width.
//
// Placement: every layer has a home azimuth. `width` scales it, `rear` lets
// the ring extend behind the listener, `pan` rotates the whole field and
// `orbit` keeps it turning.
// Output channel count selects the speaker ring: 2 = stereo (constant-power
// pan, rear folds forward), 6 = 5.1 (L R C LFE Ls Rs), 8 = 7.1 (L R C LFE
// Lb Rb Ls Rs, SMPTE order). Layers are VBAP-panned between the two nearest
// speakers. `center` feeds the dry voice to C and `lfe` a low-passed sub to
// LFE (both only exist in 6/8-channel output).
//
// Formant trick: the formant re-weight is applied to the mono input *before*
// pitch shifting. A pre-shift of F semitones followed by a pitch shift of P
// lands the envelope exactly where a post-shift re-weight of F would, so one
// filterbank serves every stacked voice and the vocoder engines alike.
//
// Everything is time-domain (no FFT) so it runs under WebKitGTK and
// identically in the OfflineAudioContext used for export. All randomness is
// from a seeded PRNG, so a render is reproducible.

const BANDS = 20;
const F_LO = 100;
const F_HI = 8000;
const NOISE_FROM_BAND = 15; // bands at/above this get noise in the carrier (sibilance)
const CARRIER_C3 = 130.81; // `pitch` 0 = C3 for the synth engines
const EPS = 1e-4;
const MAX_UNISON = 8;
const MAX_POLY = 4;
const MAX_CH = 8;
const DEG = Math.PI / 180;
// Blocks of silent input before the processor resets and idles (~0.6 s: the
// longest tail is the 45 ms chorus line + 100 ms shifter buffer + envelopes).
const QUIET_BLOCKS = Math.ceil((0.6 * sampleRate) / 128);

// Chord intervals in semitones, indexed by the `chord` param.
const CHORDS = [
  [0],            // 0 unison
  [0, 12],        // 1 octave
  [0, 7],         // 2 fifth
  [0, 4, 7],      // 3 major
  [0, 3, 7],      // 4 minor
  [0, 5, 7],      // 5 sus4
  [-12, 0, 7, 12] // 6 wide
];

// Speaker rings by output channel count: [channel index, azimuth°] sorted by
// azimuth. LFE (index 3) is not in the ring; it gets its own low-passed send.
const RINGS = {
  6: [[2, 0], [1, 30], [5, 110], [4, 250], [0, 330]],
  8: [[2, 0], [1, 30], [7, 90], [5, 150], [4, 210], [6, 270], [0, 330]],
};

// Layer slots in the field. Home azimuth is a fraction of the ring's reach
// (-1 .. 1); the stack alternates sides so it wraps around the listener.
const L_MAIN = 0;
const L_UNISON = 1;                    // .. L_UNISON + MAX_UNISON - 2
const L_SUB = L_UNISON + MAX_UNISON - 1;
const L_SHIMMER = L_SUB + 1;
const L_POLY = L_SHIMMER + 1;          // .. L_POLY + MAX_POLY - 1
const L_VOCODER = L_POLY + MAX_POLY;
const L_TALKBOX = L_VOCODER + 1;
const L_COMPUVOX = L_TALKBOX + 1;
const N_LAYERS = L_COMPUVOX + 1;

const semis = (n) => Math.pow(2, n / 12);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Transparent below 0.8, then a tanh knee that never exceeds ±1. */
function softClip(y) {
  const a = Math.abs(y);
  if (a <= 0.8) return y;
  const k = 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2);
  return y < 0 ? -k : k;
}

/** xorshift32 — deterministic noise so exports render identically. */
class Rng {
  constructor(seed) { this.s = seed >>> 0 || 0x9e3779b9; }
  next() {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296; // 0..1
  }
  bipolar() { return this.next() * 2 - 1; }
}

/** RBJ constant-0 dB-peak bandpass, transposed direct form II. */
class Bandpass {
  constructor() { this.b0 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(freq, q) {
    const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
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
}

/** 2nd-order Butterworth low-pass (for the LFE send). */
class Lowpass {
  constructor(freq) {
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const alpha = Math.sin(w0) / Math.SQRT2;
    const cw = Math.cos(w0);
    const a0 = 1 + alpha;
    this.b0 = (1 - cw) / 2 / a0; this.b1 = (1 - cw) / a0; this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0; this.a2 = (1 - alpha) / a0;
    this.z1 = 0; this.z2 = 0;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Dual-tap delay-line pitch shifter; ~50 ms grain, sine crossfade. */
class Shifter {
  constructor(phase) {
    this.grain = Math.floor(sampleRate * 0.05);
    this.size = this.grain * 2;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.phase = phase;
  }
  read(pos) {
    let p = pos % this.size;
    if (p < 0) p += this.size;
    const i = p | 0;
    const f = p - i;
    const a = this.buf[i];
    const b = this.buf[(i + 1) % this.size];
    return a + (b - a) * f;
  }
  process(x, ratio) {
    this.buf[this.w] = x;
    const p1 = this.phase;
    let p2 = p1 + 0.5;
    if (p2 >= 1) p2 -= 1;
    const y = Math.sin(Math.PI * p1) * this.read(this.w - p1 * this.grain)
            + Math.sin(Math.PI * p2) * this.read(this.w - p2 * this.grain);
    this.phase += (1 - ratio) / this.grain;
    if (this.phase >= 1) this.phase -= 1; else if (this.phase < 0) this.phase += 1;
    this.w = (this.w + 1) % this.size;
    return y;
  }
}

/** PolyBLEP correction for a step discontinuity at phase t with increment dt. */
function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

/** Band-limited saw + variable-width pulse from one phase accumulator. */
class Osc {
  constructor(phase) { this.phase = phase; this.dt = 0; this.saw = 0; this.pulse = 0; }
  setFreq(hz) { this.dt = hz / sampleRate; }
  /** Computes this.saw / this.pulse for the sample and advances. */
  step(width) {
    const t = this.phase;
    const dt = this.dt;
    if (dt <= 0) { this.saw = 0; this.pulse = 0; return; }
    const saw = 2 * t - 1 - polyBlep(t, dt);
    let t2 = t + width; if (t2 >= 1) t2 -= 1;
    // pulse = difference of two saws `width` apart (band-limited square-ish)
    this.saw = saw;
    this.pulse = saw - (2 * t2 - 1 - polyBlep(t2, dt));
    this.phase = t + dt;
    if (this.phase >= 1) this.phase -= 1;
  }
}

/** Slow random walk: a new target every 0.4–1.6 s, low-passed at ~1 Hz. */
class Drift {
  constructor(rng) { this.rng = rng; this.value = 0; this.target = 0; this.left = 0; this.coef = Math.exp(-128 / (sampleRate * 0.16)); }
  /** Advance one block (128 samples). Returns -1..1. */
  step() {
    if (this.left <= 0) {
      this.target = this.rng.bipolar();
      this.left = Math.floor(sampleRate * (0.4 + 1.2 * this.rng.next()));
    }
    this.left -= 128;
    this.value = this.target + (this.value - this.target) * this.coef;
    return this.value;
  }
}

/** One vocoder engine: its own synthesis bank + level matcher + crush state. */
class VocoderEngine {
  constructor() {
    this.syn = [];
    for (let i = 0; i < BANDS; i++) this.syn.push(new Bandpass());
    this.q = 0;
    this.wetEnv = 0;
    this.holdVal = 0; this.holdN = 0;
  }
  setQ(centers, q) {
    if (q === this.q) return;
    this.q = q;
    for (let i = 0; i < BANDS; i++) this.syn[i].set(centers[i], q);
  }
}

/** Modulated delay for the ensemble stage, one per output channel. */
class Chorus {
  constructor(phase, rate) {
    this.size = Math.ceil(sampleRate * 0.045);
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.phase = phase;
    this.dphase = rate / sampleRate;
    this.base = sampleRate * 0.014;
    this.depth = sampleRate * 0.006;
  }
  process(x) {
    this.buf[this.w] = x;
    const d = this.base + this.depth * Math.sin(2 * Math.PI * this.phase);
    this.phase += this.dphase; if (this.phase >= 1) this.phase -= 1;
    let p = this.w - d; if (p < 0) p += this.size;
    const i = p | 0; const f = p - i;
    const a = this.buf[i]; const b = this.buf[(i + 1) % this.size];
    this.w = (this.w + 1) % this.size;
    return a + (b - a) * f;
  }
}

const kParam = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "k-rate" });
const PARAMS = [
      kParam("mix", 0, 0, 1),
      // pitch
      kParam("pitch", 0, -24, 24), kParam("formant", 0, -12, 12), kParam("chord", 0, 0, 6), kParam("glide", 0, 0, 1),
      // engine levels
      kParam("shift", 1, 0, 1), kParam("vocoder", 0, 0, 1), kParam("talkbox", 0, 0, 1), kParam("compuvox", 0, 0, 1), kParam("polyvox", 0, 0, 1),
      kParam("character", 0.5, 0, 1),
      // stack
      kParam("unison", 1, 1, MAX_UNISON), kParam("detune", 12, 0, 100), kParam("sub", 0, 0, 1), kParam("shimmer", 0, 0, 1),
      // modulation
      kParam("vibratoRate", 5, 0, 12), kParam("vibratoDepth", 0, 0, 100), kParam("drift", 0, 0, 100),
      kParam("formantRate", 0.5, 0, 12), kParam("formantDepth", 0, 0, 6),
      kParam("envPitch", 0, -1, 1), kParam("envFormant", 0, -1, 1), kParam("envWidth", 0, 0, 1),
      // space
      kParam("width", 0.6, 0, 1), kParam("orbitRate", 0.2, 0, 4), kParam("orbitDepth", 0, 0, 1), kParam("ensemble", 0, 0, 1),
      kParam("rear", 0.3, 0, 1), kParam("lfe", 0, 0, 1), kParam("center", 0, 0, 1), kParam("ring", 0, 0, 400),
      kParam("pan", 0, -1, 1),
];
const PARAM_NAMES = PARAMS.map((d) => d.name);

class VoiceSynthProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return PARAMS;
  }


  constructor() {
    super();
    this.rng = new Rng(0x5eed1234);
    this.p = {};
    this.zero = new Float32Array(128);
    this.quiet = 0;
    this.idle = false;
    this.centers = new Float32Array(BANDS);
    const octaves = Math.log2(F_HI / F_LO);
    for (let i = 0; i < BANDS; i++) this.centers[i] = F_LO * Math.pow(2, (octaves * i) / (BANDS - 1));
    this.bandsPerSemi = (BANDS - 1) / (octaves * 12);

    // Shared analysis of the mono voice.
    this.ana = [];
    for (let i = 0; i < BANDS; i++) this.ana.push(new Bandpass());
    for (let i = 0; i < BANDS; i++) this.ana[i].set(this.centers[i], 4.5);
    this.band = new Float32Array(BANDS);   // band outputs this sample
    this.env = new Float32Array(BANDS);    // band envelopes
    this.envA = Math.exp(-1 / (sampleRate * 0.004));   // ~4 ms attack
    this.envR = Math.exp(-1 / (sampleRate * 0.025));   // ~25 ms release

    // Shift family: one shifter per stacked voice, staggered phases so the
    // grain crossfades don't line up (that is what makes unison thick).
    this.shifters = [];
    for (let i = 0; i < N_LAYERS; i++) this.shifters.push(new Shifter((i * 0.37) % 1));
    this.drifts = [];
    for (let i = 0; i < N_LAYERS; i++) this.drifts.push(new Drift(this.rng));

    // Vocoder family.
    this.osc = [new Osc(0), new Osc(0.25), new Osc(0.5), new Osc(0.75)];
    this.engines = { vocoder: new VocoderEngine(), talkbox: new VocoderEngine(), compuvox: new VocoderEngine() };
    this.lvl = Math.exp(-1 / (sampleRate * 0.04)); // level matcher (~40 ms)
    this.inEnv = 0;

    // Dynamics follower for the env → modulation routes (~5 ms / 120 ms).
    this.dynA = Math.exp(-1 / (sampleRate * 0.005));
    this.dynR = Math.exp(-1 / (sampleRate * 0.12));
    this.dyn = 0;

    // Modulators.
    this.vibPhase = 0;
    this.fmtPhase = 0;
    this.orbitPhase = 0;
    this.ringPhase = 0;
    this.pitchSm = 0;
    this.pitchInit = false;

    // Field.
    this.layerSig = new Float32Array(N_LAYERS);
    this.layerLvl = new Float32Array(N_LAYERS);
    this.layerRatio = new Float32Array(N_LAYERS);
    this.pan = new Float32Array(N_LAYERS * MAX_CH);
    this.field = new Float32Array(MAX_CH);
    this.active = new Int32Array(N_LAYERS);
    this.nActive = 0;
    this.chorus = [];
    for (let c = 0; c < MAX_CH; c++) this.chorus.push(new Chorus(c / MAX_CH, 0.45 + 0.11 * c));
    this.lfeLp = new Lowpass(80);
  }

  /** Spectral-envelope level at a fractional band index (linear interp). */
  envAt(pos) {
    const env = this.env;
    if (pos <= 0) return env[0];
    if (pos >= BANDS - 1) return env[BANDS - 1];
    const i = pos | 0;
    const f = pos - i;
    return env[i] + (env[i + 1] - env[i]) * f;
  }

  /** Pan gains for a layer at azimuth `az` (degrees, 0 = front) into `nCh`. */
  setPan(layer, az, nCh) {
    const pan = this.pan;
    const o = layer * MAX_CH;
    for (let c = 0; c < MAX_CH; c++) pan[o + c] = 0;
    const ring = RINGS[nCh];
    if (!ring) {
      // Stereo (or anything else): constant-power pan; rear folds forward.
      const p = Math.sin(az * DEG);
      const a = ((p + 1) * Math.PI) / 4;
      if (nCh === 1) { pan[o] = 1; return; }
      pan[o] = Math.cos(a);
      pan[o + 1] = Math.sin(a);
      return;
    }
    let a = az % 360; if (a < 0) a += 360;
    // Find the ring pair bracketing `a` (the last pair wraps through 360).
    let i = 0;
    while (i < ring.length - 1 && ring[i + 1][1] <= a) i++;
    const s1 = ring[i];
    const s2 = ring[(i + 1) % ring.length];
    const a1 = s1[1];
    const a2 = i === ring.length - 1 ? s2[1] + 360 : s2[1];
    const t = (a - a1) / (a2 - a1);
    pan[o + s1[0]] = Math.cos((t * Math.PI) / 2);
    pan[o + s2[0]] = Math.sin((t * Math.PI) / 2);
  }

  /** Per-block: modulators, layer ratios/levels/positions, carrier tuning. */
  prepareBlock(p, nCh) {
    const c = this.centers;
    const t = 128 / sampleRate;

    // --- dynamics → 0..1 (-42 dBFS .. 0 dBFS) ---
    const d = clamp01((20 * Math.log10(this.dyn + 1e-6) + 42) / 42);

    // --- pitch: glide, vibrato, env ---
    const pitch = p.pitch;
    if (!this.pitchInit) { this.pitchSm = pitch; this.pitchInit = true; }
    const glideCoef = p.glide > 0 ? Math.exp(-t / (0.02 + 0.6 * p.glide)) : 0;
    this.pitchSm = pitch + (this.pitchSm - pitch) * glideCoef;
    this.vibPhase += p.vibratoRate * t; if (this.vibPhase >= 1) this.vibPhase -= 1;
    const vib = (p.vibratoDepth / 100) * Math.sin(2 * Math.PI * this.vibPhase);
    const basePitch = this.pitchSm + vib + p.envPitch * d * 2;
    const driftSemi = p.drift / 100;

    // --- formant: LFO + env; converted to a band offset ---
    this.fmtPhase += p.formantRate * t; if (this.fmtPhase >= 1) this.fmtPhase -= 1;
    const fmt = p.formant + p.formantDepth * Math.sin(2 * Math.PI * this.fmtPhase) + p.envFormant * d * 6;
    this.fShift = fmt * this.bandsPerSemi;
    this.useBank = Math.abs(fmt) > 0.005;

    // --- space ---
    this.orbitPhase += p.orbitRate * t; if (this.orbitPhase >= 1) this.orbitPhase -= 1;
    // Static rotation (`pan`, ±1 = ±180°) plus the orbit LFO on top.
    const orbit = p.pan * 180 + p.orbitDepth * 180 * Math.sin(2 * Math.PI * this.orbitPhase);
    const reach = (60 + 120 * p.rear) * clamp01(p.width + p.envWidth * d);
    const place = (layer, frac) => this.setPan(layer, frac * reach + orbit, nCh);

    // --- layers ---
    const lvl = this.layerLvl, ratio = this.layerRatio, active = this.active;
    let n = 0;
    for (let i = 0; i < N_LAYERS; i++) this.drifts[i].step();
    const ratioOf = (semi, layer) => semis(semi + driftSemi * this.drifts[layer].value);

    const unison = Math.max(1, Math.min(MAX_UNISON, Math.round(p.unison)));
    if (p.shift > 0) {
      const norm = p.shift / Math.sqrt(unison);
      lvl[L_MAIN] = norm; ratio[L_MAIN] = ratioOf(basePitch, L_MAIN); place(L_MAIN, 0); active[n++] = L_MAIN;
      for (let k = 1; k < unison; k++) {
        // Spread the extra voices evenly over ±detune cents and ± the field.
        const f = unison === 2 ? 1 : -1 + (2 * (k - 1)) / (unison - 2);
        const L = L_UNISON + k - 1;
        lvl[L] = norm; ratio[L] = ratioOf(basePitch + (p.detune / 100) * f, L);
        // Alternate sides, each pair a step further out.
        const side = k % 2 ? 1 : -1;
        const radius = ((k + 1) >> 1) / Math.max(1, unison >> 1);
        place(L, side * radius);
        active[n++] = L;
      }
    }
    if (p.sub > 0) { lvl[L_SUB] = p.sub; ratio[L_SUB] = ratioOf(basePitch - 12, L_SUB); place(L_SUB, 0); active[n++] = L_SUB; }
    if (p.shimmer > 0) { lvl[L_SHIMMER] = p.shimmer; ratio[L_SHIMMER] = ratioOf(basePitch + 12, L_SHIMMER); place(L_SHIMMER, 0.5); active[n++] = L_SHIMMER; }

    const intervals = CHORDS[Math.max(0, Math.min(CHORDS.length - 1, Math.round(p.chord)))];
    if (p.polyvox > 0) {
      const norm = p.polyvox / Math.sqrt(intervals.length);
      for (let v = 0; v < intervals.length; v++) {
        const L = L_POLY + v;
        const det = (v % 2 ? -1 : 1) * p.character * 0.25 * (v + 1) * 0.5; // up to ±25 cents-ish
        lvl[L] = norm; ratio[L] = ratioOf(basePitch + intervals[v] + det, L);
        place(L, v === 0 ? 0 : (v % 2 ? 0.6 : -0.6) * (1 + (v >> 1) * 0.5));
        active[n++] = L;
      }
    }

    // Vocoder family: carriers share the four oscillators.
    this.anyVocoder = p.vocoder > 0 || p.talkbox > 0 || p.compuvox > 0;
    if (this.anyVocoder) {
      const base = CARRIER_C3 * semis(basePitch + driftSemi * this.drifts[L_VOCODER].value);
      for (let v = 0; v < this.osc.length; v++) {
        const iv = intervals[v];
        this.osc[v].setFreq(iv === undefined ? 0 : base * semis(iv));
      }
      this.nOsc = intervals.length;
      const ch = p.character;
      const E = this.engines;
      E.vocoder.setQ(c, 3 + 7 * ch);
      E.talkbox.setQ(c, 6 + 8 * ch);
      E.compuvox.setQ(c, 5);
      this.vocNoise = 0.35 + 0.4 * ch;
      this.tbDrive = 1.5 + 6 * ch;
      this.cvHold = 1 + Math.round(ch * 11);                 // 48 kHz → down to ~4 kHz
      this.cvQuant = Math.pow(2, 12 - Math.round(ch * 8));   // 12 → 4 bits
      if (p.vocoder > 0) { lvl[L_VOCODER] = p.vocoder; place(L_VOCODER, -0.35); active[n++] = L_VOCODER; }
      if (p.talkbox > 0) { lvl[L_TALKBOX] = p.talkbox; place(L_TALKBOX, 0.35); active[n++] = L_TALKBOX; }
      if (p.compuvox > 0) { lvl[L_COMPUVOX] = p.compuvox; place(L_COMPUVOX, 0.8); active[n++] = L_COMPUVOX; }
    }
    this.nActive = n;

    // Ring mod / ensemble / surround sends.
    this.ringHz = p.ring;
    this.ensemble = p.ensemble;
    this.centerSend = nCh >= 6 ? p.center : 0;
    this.lfeSend = nCh >= 6 ? p.lfe : 0;
  }

  /** Clear every delay line, filter and follower: the tail is over. */
  reset() {
    for (const sh of this.shifters) { sh.buf.fill(0); }
    for (const c of this.chorus) c.buf.fill(0);
    for (const b of this.ana) { b.z1 = 0; b.z2 = 0; }
    for (const k in this.engines) {
      const e = this.engines[k];
      for (const b of e.syn) { b.z1 = 0; b.z2 = 0; }
      e.wetEnv = 0; e.holdVal = 0; e.holdN = 0;
    }
    this.env.fill(0);
    this.layerSig.fill(0);
    this.lfeLp.z1 = 0; this.lfeLp.z2 = 0;
    this.dyn = 0; this.inEnv = 0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    const nCh = output.length;
    const frames = output[0].length;

    // The host hands over an input with no channels once everything upstream
    // has gone quiet. That is silence, not "stop": the shifter grains, chorus
    // lines and envelopes still have a tail to ring out, so keep processing on
    // zeros — and keep the output deterministic whenever the host makes that
    // switch. Once the input has been silent long enough for every tail to
    // fade, reset the state and skip the DSP entirely (idle layers cost nothing).
    if (this.zero.length < frames) this.zero = new Float32Array(frames);
    const hasInput = input && input.length > 0;
    const inL = hasInput ? input[0] : this.zero;
    const inR = hasInput ? input[1] || input[0] : this.zero;
    const nIn = hasInput && input[1] ? 2 : 1;
    let silent = true;
    for (let n = 0; n < frames; n++) if (inL[n] !== 0 || inR[n] !== 0) { silent = false; break; }
    if (silent) {
      if (this.quiet < QUIET_BLOCKS) this.quiet++;
      else {
        if (!this.idle) { this.reset(); this.idle = true; }
        for (let ch = 0; ch < nCh; ch++) output[ch].fill(0);
        return true;
      }
    } else {
      this.quiet = 0;
      this.idle = false;
    }

    const mix = params.mix[0];
    if (mix <= 0) {
      // Bit-exact bypass: L/R pass straight through; on a surround bus the
      // other channels stay silent (a dry voice has nothing for C/LFE/rear).
      output[0].set(inL);
      if (nCh > 1) output[1].set(inR);
      for (let ch = 2; ch < nCh; ch++) output[ch].fill(0);
      return true;
    }

    const p = this.p;
    for (let i = 0; i < PARAM_NAMES.length; i++) p[PARAM_NAMES[i]] = params[PARAM_NAMES[i]][0];
    this.prepareBlock(p, nCh);

    const ana = this.ana, band = this.band, env = this.env;
    const envA = this.envA, envR = this.envR;
    const useBank = this.useBank, fShift = this.fShift;
    const layerSig = this.layerSig, layerLvl = this.layerLvl, layerRatio = this.layerRatio;
    const active = this.active, nActive = this.nActive;
    const pan = this.pan, field = this.field;
    const E = this.engines, osc = this.osc, nOsc = this.nOsc | 0;
    const anyVoc = this.anyVocoder;
    const wantVoc = p.vocoder > 0, wantTb = p.talkbox > 0, wantCv = p.compuvox > 0;
    const ringHz = this.ringHz, ensemble = this.ensemble;
    const centerSend = this.centerSend, lfeSend = this.lfeSend;
    const ringInc = ringHz / sampleRate;

    for (let n = 0; n < frames; n++) {
      const mono = nIn === 2 ? 0.5 * (inL[n] + inR[n]) : inL[n];

      // Dynamics follower (drives the env → modulation routes next block).
      const am = Math.abs(mono);
      this.dyn = am > this.dyn ? this.dyn + (am - this.dyn) * (1 - this.dynA) : this.dyn * this.dynR;

      // Shared analysis: band outputs + envelopes.
      for (let i = 0; i < BANDS; i++) {
        const b = ana[i].process(mono);
        band[i] = b;
        const a = Math.abs(b);
        env[i] = a > env[i] ? env[i] + (a - env[i]) * (1 - envA) : env[i] * envR;
      }

      // Formant re-weight: band i takes the level band (i - shift) has.
      let src = mono;
      if (useBank) {
        src = 0;
        for (let i = 0; i < BANDS; i++) {
          src += band[i] * Math.min(4, (this.envAt(i - fShift) + EPS) / (env[i] + EPS));
        }
      }

      // Shift family layers.
      for (let a = 0; a < nActive; a++) {
        const L = active[a];
        if (L >= L_VOCODER) continue;
        const r = layerRatio[L];
        layerSig[L] = r === 1 ? src : this.shifters[L].process(src, r);
      }

      // Vocoder family: one carrier set, three synthesis banks.
      if (anyVoc) {
        let saw = 0, pulse = 0, buzz = 0;
        for (let v = 0; v < nOsc; v++) {
          const o = osc[v];
          o.step(wantCv ? 0.08 : 0.18);
          saw += o.saw; buzz += 0.5 * o.saw + 0.5 * o.pulse; pulse += o.pulse;
        }
        const norm = 1 / Math.sqrt(nOsc || 1);
        saw *= norm; buzz *= norm; pulse *= norm;
        const noise = this.rng.bipolar();
        const ax = Math.abs(mono);
        this.inEnv = ax > this.inEnv ? ax : this.inEnv * this.lvl + ax * (1 - this.lvl);

        if (wantVoc) layerSig[L_VOCODER] = this.vocode(E.vocoder, saw, noise, this.vocNoise, useBank, fShift);
        if (wantTb) {
          const y = this.vocode(E.talkbox, buzz, noise, 0.25, useBank, fShift);
          layerSig[L_TALKBOX] = (Math.tanh(y * this.tbDrive) / Math.tanh(this.tbDrive)) * 0.9;
        }
        if (wantCv) {
          const e = E.compuvox;
          const y = this.vocode(e, pulse, noise, 0.5, useBank, fShift);
          if (e.holdN <= 0) { e.holdVal = Math.round(y * this.cvQuant) / this.cvQuant; e.holdN = this.cvHold; }
          e.holdN--;
          layerSig[L_COMPUVOX] = e.holdVal;
        }
      }

      // Place every active layer into the field.
      for (let c = 0; c < nCh; c++) field[c] = 0;
      let wetMono = 0;
      for (let a = 0; a < nActive; a++) {
        const L = active[a];
        const s = layerSig[L] * layerLvl[L];
        wetMono += s;
        const o = L * MAX_CH;
        for (let c = 0; c < nCh; c++) field[c] += s * pan[o + c];
      }

      // Ring modulation of the whole field (0 Hz = off).
      if (ringHz > 0) {
        const m = Math.sin(2 * Math.PI * this.ringPhase);
        this.ringPhase += ringInc; if (this.ringPhase >= 1) this.ringPhase -= 1;
        for (let c = 0; c < nCh; c++) field[c] *= m;
      }

      // Ensemble: a differently-modulated delay per channel, blended in.
      if (ensemble > 0) {
        for (let c = 0; c < nCh; c++) field[c] += ensemble * 0.7 * this.chorus[c].process(field[c]);
      }

      // Surround-only sends.
      if (centerSend > 0) field[2] += mono * centerSend;
      if (nCh >= 6) {
        const low = this.lfeLp.process(mono + wetMono);
        if (lfeSend > 0) field[3] += low * lfeSend;
      }

      // Dry stays in its own channels (L/R); everything else is field only.
      const dryMix = 1 - mix;
      for (let c = 0; c < nCh; c++) {
        const dry = c === 0 ? inL[n] : c === 1 ? inR[n] : 0;
        output[c][n] = softClip(dry * dryMix + field[c] * mix);
      }
    }
    return true;
  }

  /** Run one vocoder engine for a sample: carrier through the synthesis
   *  bank, each band scaled by the (formant-shifted) voice envelope, then
   *  level-matched to the dry voice so Q/carrier shape don't change loudness. */
  vocode(e, carrier, noise, noiseAmt, useBank, fShift) {
    const syn = e.syn, env = this.env;
    let y = 0;
    for (let i = 0; i < BANDS; i++) {
      const srcS = i >= NOISE_FROM_BAND ? carrier * (1 - noiseAmt) + noise * noiseAmt : carrier;
      const g = useBank ? this.envAt(i - fShift) : env[i];
      y += syn[i].process(srcS) * g;
    }
    const ay = Math.abs(y);
    e.wetEnv = ay > e.wetEnv ? ay : e.wetEnv * this.lvl + ay * (1 - this.lvl);
    return y * Math.min(60, this.inEnv / (e.wetEnv + EPS));
  }
}

registerProcessor("voice-synth-processor", VoiceSynthProcessor);
