// Pure helpers for the analogue master meter.
//
// The engine hands over raw analyser data; everything here is plain math so it
// can be unit-tested and so a native backend could reuse it unchanged.

/** Linear amplitude -> dBFS. Silence clamps to `floor` instead of -Infinity. */
export function toDb(amplitude: number, floor = -60): number {
  if (amplitude <= 0) return floor;
  return Math.max(floor, 20 * Math.log10(amplitude));
}

/** Peak and RMS of a block of float samples. Peak may exceed 1.0 for a hot
 *  (pre-limiter) signal, which is exactly what the meter wants to show. */
export function blockLevels(samples: ArrayLike<number>): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
    sum += v * v;
  }
  return { peak, rms: samples.length ? Math.sqrt(sum / samples.length) : 0 };
}

/**
 * Fold linear FFT bins (0..255 magnitudes from getByteFrequencyData) into
 * `out.length` log-spaced bands between loHz and hiHz, each normalised 0..1
 * (the loudest bin in the band). Log spacing gives bass and treble equal
 * visual room, like a hardware spectrum analyser.
 */
export function logBands(
  bins: ArrayLike<number>,
  sampleRate: number,
  out: Float32Array,
  loHz = 40,
  hiHz = 16000,
): Float32Array {
  const bands = out.length;
  const hzPerBin = sampleRate / 2 / bins.length;
  const ratio = Math.log(hiHz / loHz);
  for (let b = 0; b < bands; b++) {
    const f0 = loHz * Math.exp((ratio * b) / bands);
    const f1 = loHz * Math.exp((ratio * (b + 1)) / bands);
    let i0 = Math.floor(f0 / hzPerBin);
    let i1 = Math.max(i0 + 1, Math.ceil(f1 / hzPerBin));
    i0 = Math.min(i0, bins.length - 1);
    i1 = Math.min(i1, bins.length);
    let max = 0;
    for (let i = i0; i < i1; i++) if (bins[i] > max) max = bins[i];
    out[b] = max / 255;
  }
  return out;
}

/**
 * Needle ballistics: quick to rise, slow to fall, so transients register but
 * the needle reads like a mechanical VU rather than jittering every frame.
 * Returns the new displayed value.
 */
export function ballistics(shown: number, target: number, rise = 0.5, fall = 0.08): number {
  const k = target > shown ? rise : fall;
  return shown + (target - shown) * k;
}

/**
 * An AnalyserNode's getByteFrequencyData, for audio that isn't in a Web
 * Audio graph (the native engine's scope): Blackman window, FFT, |X|/N,
 * smoothing over calls, dB mapped from [minDb, maxDb] onto 0..255.
 * `state` carries the smoothed magnitudes between calls.
 */
export function analyserBytes(
  samples: Float32Array,
  fftSize: number,
  state: Float32Array,
  out: Uint8Array,
  smoothing = 0.6,
  minDb = -100,
  maxDb = -30,
): Uint8Array {
  const n = fftSize;
  const re = new Float64Array(n), im = new Float64Array(n);
  const off = Math.max(0, samples.length - n);
  for (let i = 0; i < n; i++) {
    const a = 0.16, a0 = 0.5 * (1 - a), a1 = 0.5, a2 = 0.5 * a;
    const w = a0 - a1 * Math.cos((2 * Math.PI * i) / n) + a2 * Math.cos((4 * Math.PI * i) / n);
    re[i] = (samples[off + i] ?? 0) * w;
  }
  // Iterative radix-2 FFT.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  for (let k = 0; k < n / 2; k++) {
    const mag = Math.hypot(re[k], im[k]) / n;
    state[k] = smoothing * state[k] + (1 - smoothing) * mag;
    const db = 20 * Math.log10(state[k] + 1e-12);
    out[k] = Math.max(0, Math.min(255, Math.round((255 * (db - minDb)) / (maxDb - minDb))));
  }
  return out;
}
