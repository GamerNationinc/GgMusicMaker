// Tempo and downbeat detection: what BPM an imported song is at, and where
// its bars start, so the grid can be laid over it (Ableton's auto-warp guess,
// without the warping).
//
// 1. Onset envelope: the audio, mixed to mono, split into a low band (kick),
//    the full band and a high band (hats), as log energy per 5 ms hop; the
//    rises in each band, summed, peak wherever a note or a hit starts.
// 2. Tempo: autocorrelation of that envelope over 60–200 BPM, scored on how
//    well a beat length also repeats at 2, 3 and 4 beats and splits into
//    8ths, with a gentle preference for ~100 so a song isn't read at half or
//    double time; four-on-the-floor read at half time gets doubled.
// 3. Refine: fold the envelope by each candidate beat length around that
//    guess (0.005 BPM steps) — the right tempo stacks every hit on the same
//    phase, a slightly wrong one smears them. A whole-number BPM wins if it
//    folds (almost) as sharply, since most produced music is on one.
// 4. Phase: the fold's peak is where the beats fall; of the beats in a bar,
//    the one with the most low-band (kick) onsets is called the downbeat.
//
// Runs on the UI thread in slices, yielding between them, so a long song
// doesn't freeze the app. Only the first `maxSeconds` are analysed.

import { BPM_MIN, BPM_MAX } from "./tempo";

export interface BeatSource {
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface DetectOptions {
  /** First sample to analyse (a clip's offset into its buffer). */
  startSample?: number;
  /** Samples to analyse from there (default: to the end, capped by maxSeconds). */
  lengthSamples?: number;
  /** Cap on the analysed length, seconds. */
  maxSeconds?: number;
  beatsPerBar?: number;
  /** Called between slices; resolve to carry on (default: a macrotask). */
  yieldFn?: () => Promise<void>;
}

export interface TempoGuess {
  /** Beats per minute, to 0.01. */
  bpm: number;
  /** First beat at or after the analysed start, seconds from that start. */
  firstBeat: number;
  /** First downbeat (bar line) at or after the analysed start, seconds from it. */
  downbeat: number;
  /** 0–1: how much more sharply the beats line up at this tempo than a few
   *  percent off it. Below MIN_CONFIDENCE there is no clear beat. */
  confidence: number;
}

/** Below this the guess is not worth acting on. Beatless audio (noise, a
 *  pad) scores ~0.1–0.2; records ~0.3–1. */
export const MIN_CONFIDENCE = 0.25;

const ENV_RATE = 200; // envelope frames per second (5 ms hops)
const SEARCH_MIN = 60;
const SEARCH_MAX = 200;
const PHASE_BINS = 64;

const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));

interface Envelope {
  /** Onset strength per frame (all bands). */
  onset: Float32Array;
  /** Low-band onset strength per frame. */
  low: Float32Array;
  /** Frames per second (sampleRate / hop). */
  rate: number;
}

function onePoleCoef(cutoff: number, sr: number): number {
  return 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
}

async function onsetEnvelope(src: BeatSource, start: number, length: number, yieldFn: () => Promise<void>): Promise<Envelope> {
  const sr = src.sampleRate;
  const hop = Math.max(1, Math.round(sr / ENV_RATE));
  const frames = Math.floor(length / hop);
  const chans = Array.from({ length: src.numberOfChannels }, (_, c) => src.getChannelData(c));
  const nc = chans.length;
  const aLow = onePoleCoef(150, sr);
  const aHigh = onePoleCoef(4000, sr);
  const aDc = onePoleCoef(30, sr);
  let lp = 0;
  let hpLp = 0;
  let dc = 0;
  const eLow = new Float32Array(frames);
  const eFull = new Float32Array(frames);
  const eHigh = new Float32Array(frames);
  const SLICE = 1 << 18;
  for (let f = 0; f < frames; f++) {
    let sl = 0;
    let sf = 0;
    let sh = 0;
    const base = start + f * hop;
    for (let i = 0; i < hop; i++) {
      let x = 0;
      for (let c = 0; c < nc; c++) x += chans[c][base + i];
      x /= nc;
      dc += aDc * (x - dc);
      const y = x - dc;
      lp += aLow * (y - lp);
      hpLp += aHigh * (y - hpLp);
      const hp = y - hpLp;
      sl += lp * lp;
      sf += y * y;
      sh += hp * hp;
    }
    eLow[f] = sl / hop;
    eFull[f] = sf / hop;
    eHigh[f] = sh / hop;
    if ((f * hop) % SLICE < hop && f > 0) await yieldFn();
  }
  const onset = new Float32Array(frames);
  const low = new Float32Array(frames);
  const flux = (e: Float32Array, out: Float32Array, w: number, also?: Float32Array) => {
    // Log compression relative to the band's loudest frame, so quiet and loud
    // songs (and quiet bands) count alike.
    let max = 0;
    for (let i = 0; i < e.length; i++) if (e[i] > max) max = e[i];
    if (max <= 0) return;
    const k = 1e4 / max;
    let prev = Math.log1p(e[0] * k);
    for (let i = 1; i < e.length; i++) {
      const cur = Math.log1p(e[i] * k);
      const d = cur - prev;
      prev = cur;
      if (d > 0) {
        out[i] += w * d;
        if (also) also[i] += d;
      }
    }
  };
  flux(eLow, onset, 1, low);
  flux(eFull, onset, 1);
  flux(eHigh, onset, 0.7);
  // Take away the local average (~0.4 s) and keep what sticks out: sustained
  // swells stop counting, hits stay.
  return { onset: highlight(onset, Math.round(0.4 * ENV_RATE)), low: highlight(low, Math.round(0.4 * ENV_RATE)), rate: sr / hop };
}

function highlight(x: Float32Array, win: number): Float32Array {
  const out = new Float32Array(x.length);
  const half = Math.floor(win / 2);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(x.length - 1, i + half);
    while (hi < b) sum += x[++hi];
    while (lo < a) sum -= x[lo++];
    const v = x[i] - sum / (hi - lo + 1);
    out[i] = v > 0 ? v : 0;
  }
  return out;
}

function autocorr(x: Float32Array, lag: number): number {
  let s = 0;
  for (let i = lag; i < x.length; i++) s += x[i] * x[i - lag];
  return s / (x.length - lag);
}

/** Fold the envelope by a beat length: a phase histogram (sum of onset
 *  strength per phase bin). */
function fold(env: Float32Array, rate: number, bpm: number, out: Float64Array): void {
  out.fill(0);
  const beatsPerFrame = bpm / 60 / rate;
  for (let i = 0; i < env.length; i++) {
    const v = env[i];
    if (v === 0) continue;
    const ph = i * beatsPerFrame;
    out[Math.floor((ph - Math.floor(ph)) * PHASE_BINS) % PHASE_BINS] += v;
  }
}

/** How sharp a fold is: its best 3-bin window against the average. */
function sharpness(hist: Float64Array): { score: number; peak: number } {
  let total = 0;
  for (const v of hist) total += v;
  if (total <= 0) return { score: 0, peak: 0 };
  let best = -1;
  let peak = 0;
  for (let b = 0; b < PHASE_BINS; b++) {
    const s = hist[(b + PHASE_BINS - 1) % PHASE_BINS] + hist[b] + hist[(b + 1) % PHASE_BINS];
    if (s > best) {
      best = s;
      peak = b;
    }
  }
  return { score: best / total, peak };
}

/** Sub-bin position of the fold's peak, as a phase in [0, 1). */
function peakPhase(hist: Float64Array, b: number): number {
  const l = hist[(b + PHASE_BINS - 1) % PHASE_BINS];
  const c = hist[b];
  const r = hist[(b + 1) % PHASE_BINS];
  const den = l - 2 * c + r;
  const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
  const ph = (b + 0.5 + d) / PHASE_BINS;
  return ph - Math.floor(ph);
}

/** Guess the tempo and the downbeat. Null when there is too little audio
 *  (under ~6 s) to tell. */
export async function detectTempo(src: BeatSource, opts: DetectOptions = {}): Promise<TempoGuess | null> {
  const yieldFn = opts.yieldFn ?? macrotask;
  const sr = src.sampleRate;
  const start = Math.max(0, Math.min(src.length, Math.floor(opts.startSample ?? 0)));
  const avail = src.length - start;
  const length = Math.min(avail, Math.floor(opts.lengthSamples ?? avail), Math.floor((opts.maxSeconds ?? 150) * sr));
  if (length < 6 * sr || src.numberOfChannels === 0) return null;
  const { onset, low, rate } = await onsetEnvelope(src, start, length, yieldFn);

  // ---- coarse tempo: autocorrelation with a soft ~120 BPM preference ----
  const lagMin = Math.floor((60 * rate) / SEARCH_MAX);
  const lagMax = Math.ceil((60 * rate) / SEARCH_MIN);
  const acf = new Float64Array(4 * lagMax + 2);
  for (let lag = 1; lag < acf.length && lag < onset.length; lag++) acf[lag] = autocorr(onset, lag);
  await yieldFn();
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = (60 * rate) / lag;
    // A real beat repeats every beat, every two, three and four (a bar),
    // and is split in half by 8ths. A period that is off the beat (¾ of one,
    // 1½) only lines up with some of these. Weights tuned on real records
    // (hip-hop, pop) and on house / boom-bap loops; see beatDetect.test.ts.
    let s = acf[lag] + 0.5 * (acf[2 * lag] + acf[3 * lag] + acf[4 * lag]);
    s += 1.5 * (acf[Math.floor(lag / 2)] + acf[Math.ceil(lag / 2)]) / 2;
    const prior = Math.exp(-0.5 * Math.log2(bpm / 100) ** 2);
    const score = s * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || bestScore <= 0) return null;
  // Parabolic interpolation of the lag.
  const a = acf[bestLag - 1];
  const b = acf[bestLag];
  const c = acf[bestLag + 1];
  const den = a - 2 * b + c;
  const lag = bestLag + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0);
  let coarse = (60 * rate) / lag;
  // Half time? Four-on-the-floor reads as one slow beat with an equally
  // strong hit halfway through it: then the beat is twice as fast. Only up
  // to 150 BPM — above that, hip-hop's snare would get doubled.
  if (coarse * 2 <= 150) {
    const h = new Float64Array(PHASE_BINS);
    fold(onset, rate, coarse, h);
    const { peak } = sharpness(h);
    const at = (b: number) => h[(b + PHASE_BINS - 1) % PHASE_BINS] + h[b % PHASE_BINS] + h[(b + 1) % PHASE_BINS];
    if (at(peak + PHASE_BINS / 2) > 0.6 * at(peak)) coarse *= 2;
  }

  // ---- refine: the sharpest fold within ±2.5 % ----
  const hist = new Float64Array(PHASE_BINS);
  let bpm = coarse;
  let best = -1;
  const lo = coarse * 0.975;
  const hi = coarse * 1.025;
  let n = 0;
  for (let cand = lo; cand <= hi; cand += 0.005) {
    fold(onset, rate, cand, hist);
    const s = sharpness(hist).score;
    if (s > best) {
      best = s;
      bpm = cand;
    }
    if (++n % 100 === 0) await yieldFn();
  }
  const whole = Math.round(bpm);
  if (Math.abs(whole - bpm) < 0.25) {
    fold(onset, rate, whole, hist);
    if (sharpness(hist).score >= best * 0.97) bpm = whole;
  }
  bpm = Math.round(bpm * 100) / 100;
  if (bpm < BPM_MIN || bpm > BPM_MAX) return null;

  // ---- phase + downbeat ----
  fold(onset, rate, bpm, hist);
  const { score, peak } = sharpness(hist);
  const beat = 60 / bpm;
  // Frame i's flux is the rise from frame i−1 to i: the hit landed about the
  // middle of hop i−1 … i, i.e. at (i − 0.5) hops, not at the frame start.
  const firstBeat = (((peakPhase(hist, peak) - 0.5 / ((rate * 60) / bpm)) % 1) + 1) % 1 * beat;
  const bpb = Math.max(1, Math.round(opts.beatsPerBar ?? 4));
  const perBeat = new Float64Array(bpb);
  const win = Math.max(1, Math.round(0.03 * rate));
  for (let k = 0; ; k++) {
    const t = firstBeat + k * beat;
    const f = Math.round(t * rate);
    if (f >= low.length) break;
    let s = 0;
    for (let j = Math.max(0, f - win); j <= Math.min(low.length - 1, f + win); j++) s += low[j] + 0.25 * onset[j];
    perBeat[k % bpb] += s;
  }
  let down = 0;
  for (let k = 1; k < bpb; k++) if (perBeat[k] > perBeat[down]) down = k;
  // Confidence: how much sharper the beats fold at this tempo than a few
  // percent off it (where they smear). Noise folds about the same anywhere.
  let off = 0;
  for (const m of [0.93, 0.955, 1.045, 1.07]) {
    fold(onset, rate, bpm * m, hist);
    off += sharpness(hist).score / 4;
  }
  const ratio = off > 0 ? score / off : 1;
  const confidence = Math.max(0, Math.min(1, (ratio - 1) / 1.5));
  return { bpm, firstBeat, downbeat: firstBeat + down * beat, confidence };
}
