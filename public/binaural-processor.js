// Binaural monitor AudioWorklet — hear a 5.1 / 7.1 bus on headphones.
//
// A stereo device can't play a surround bus, and a plain fold-down throws
// away front/back: a voice behind you lands in the same place as one in
// front. This renders each speaker feed as a virtual source at its speaker's
// azimuth with the three cues the ears actually use:
//
//   ITD   interaural time difference, Woodworth's spherical head:
//         τ = (a / c)(θ + sin θ) on the lateral angle, up to ~0.66 ms,
//         applied to the far ear (fractional delay).
//   ILD   head shadow: the far ear hears the source through a one-pole
//         low-pass whose corner falls from ~20 kHz (front) to ~1.2 kHz
//         (fully lateral), plus a broadband level drop.
//   Pinna rear cue: sources behind the head lose some top end at *both*
//         ears (a shelf blend), which is what separates back from front.
//
// LFE goes to both ears at -3 dB. Monitoring only: exports still write the
// real multichannel WAV. Memory: a short delay line per speaker per ear.

const HEAD_RADIUS = 0.0875; // m
const SOUND_SPEED = 343;    // m/s
const DEG = Math.PI / 180;
const MAX_DELAY = 64;       // samples; > 0.66 ms at 96 kHz

// Signed azimuth of each channel (front = 0, right positive); null = LFE.
const AZIMUTH = {
  6: [-30, 30, 0, null, -110, 110],
  8: [-30, 30, 0, null, -150, 150, -90, 90],
};

const onePoleCoef = (hz) => 1 - Math.exp((-2 * Math.PI * Math.min(hz, sampleRate * 0.45)) / sampleRate);

class Source {
  constructor(az) {
    this.lfe = az === null;
    const th = (az ?? 0) * DEG;
    const lateral = Math.asin(Math.abs(Math.sin(th))); // 0 front/back … π/2 side
    const itd = (HEAD_RADIUS / SOUND_SPEED) * (lateral + Math.sin(lateral)) * sampleRate;
    const s = Math.abs(Math.sin(th));
    this.farIsLeft = (az ?? 0) > 0;
    this.delay = itd;
    this.nearGain = 1;
    this.farGain = 1 - 0.45 * s;
    this.farLp = s < 0.05 ? 1 : onePoleCoef(20000 * Math.pow(1200 / 20000, s)); // front/back: both ears alike
    this.rear = Math.max(0, -Math.cos(th));        // 0 in front, 1 straight behind
    this.rearLp = onePoleCoef(4500);
    this.buf = new Float32Array(MAX_DELAY);
    this.w = 0;
    this.farZ = 0;
    this.rearZ = 0;
  }
}

class BinauralProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.n = 0;
    this.sources = [];
  }

  setup(n) {
    this.n = n;
    const az = AZIMUTH[n];
    this.sources = az ? az.map((a) => new Source(a)) : [];
    // Normalise so a signal on every speaker at once doesn't overload.
    this.norm = az ? 1 / Math.sqrt(az.filter((a) => a !== null).length / 2) : 1;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const frames = L.length;
    if (!input || input.length === 0) { L.fill(0); R.fill(0); return true; }
    if (input.length !== this.n) this.setup(input.length);
    if (!this.sources.length) {
      // Not a known surround width: plain pass of the first two channels.
      L.set(input[0]); R.set(input[1] || input[0]);
      return true;
    }
    L.fill(0); R.fill(0);
    const norm = this.norm;
    for (let c = 0; c < this.sources.length; c++) {
      const src = this.sources[c];
      const x = input[c];
      if (!x) continue;
      if (src.lfe) {
        for (let i = 0; i < frames; i++) { const v = x[i] * 0.7071; L[i] += v; R[i] += v; }
        continue;
      }
      const near = src.farIsLeft ? R : L;
      const far = src.farIsLeft ? L : R;
      const buf = src.buf;
      const d = src.delay;
      for (let i = 0; i < frames; i++) {
        let v = x[i] * norm;
        // Rear: blend towards a darker copy (pinna shadow).
        src.rearZ += src.rearLp * (v - src.rearZ);
        v = v + src.rear * 0.6 * (src.rearZ - v);
        buf[src.w] = v;
        let r = src.w - d; if (r < 0) r += MAX_DELAY;
        const k = r | 0, f = r - k;
        const dv = buf[k] + (buf[(k + 1) % MAX_DELAY] - buf[k]) * f;
        src.farZ += src.farLp * (dv - src.farZ);
        near[i] += v * src.nearGain;
        far[i] += src.farZ * src.farGain;
        src.w = (src.w + 1) % MAX_DELAY;
      }
    }
    return true;
  }
}

registerProcessor("binaural-processor", BinauralProcessor);
