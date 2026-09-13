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
