// Placer AudioWorklet — pan + width for a whole signal, on a stereo or a
// surround bus. Used after each layer's FX chain (the layer's place in the
// mix) and on the reverb send (where the wet image sits).
//
// Stereo (2 channels): classic mid/side width, then a constant-power
// balance. width 0 = mono, 1 = as is, 2 = exaggerated sides. pan -1..1.
//
// Surround (6 / 8 channels): every speaker feed is treated as a virtual
// source sitting at its speaker's azimuth. `width` scales that azimuth
// towards the front centre (0 = everything collapses onto C, 2 = pushed
// further round the ring), `pan` rotates the whole field (±1 = ±180°), and
// each source is re-panned onto the ring with VBAP — so pan 0 / width 1 is
// an exact identity (each source lands back on its own speaker). LFE is
// passed through untouched.
//
// Memoryless (no delay lines, no filters), so it is bit-exact at rest and
// has no tail to ring out. Params are k-rate.

const MAX_CH = 8;

// Speaker rings by channel count: [channel index, azimuth°] sorted by azimuth.
const RINGS = {
  6: [[2, 0], [1, 30], [5, 110], [4, 250], [0, 330]],
  8: [[2, 0], [1, 30], [7, 90], [5, 150], [4, 210], [6, 270], [0, 330]],
};
// Signed azimuth of each channel index (front = 0, right positive).
const AZIMUTH = {
  6: [-30, 30, 0, null, -110, 110],
  8: [-30, 30, 0, null, -150, 150, -90, 90],
};

/** VBAP gains for a source at `az` degrees into the `ring`, written to `out`. */
function ringGains(ring, az, out) {
  out.fill(0);
  let a = az % 360; if (a < 0) a += 360;
  let i = 0;
  while (i < ring.length - 1 && ring[i + 1][1] <= a) i++;
  const s1 = ring[i];
  const s2 = ring[(i + 1) % ring.length];
  const a1 = s1[1];
  const a2 = i === ring.length - 1 ? s2[1] + 360 : s2[1];
  const t = (a - a1) / (a2 - a1);
  out[s1[0]] += Math.cos((t * Math.PI) / 2);
  out[s2[0]] += Math.sin((t * Math.PI) / 2);
}

class PlacerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "pan", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "k-rate" },
      { name: "width", defaultValue: 1, minValue: 0, maxValue: 2, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    // matrix[in * MAX_CH + out] for the surround case, rebuilt on param change.
    this.matrix = new Float32Array(MAX_CH * MAX_CH);
    this.tmp = new Float32Array(MAX_CH);
    this.key = "";
  }

  buildMatrix(nCh, pan, width) {
    const ring = RINGS[nCh];
    const az = AZIMUTH[nCh];
    const m = this.matrix;
    m.fill(0);
    for (let c = 0; c < nCh; c++) {
      if (az[c] === null) { m[c * MAX_CH + c] = 1; continue; } // LFE
      ringGains(ring, az[c] * width + pan * 180, this.tmp);
      for (let o = 0; o < nCh; o++) m[c * MAX_CH + o] = this.tmp[o];
    }
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    const nCh = output.length;
    const frames = output[0].length;
    if (!input || input.length === 0) {
      for (let c = 0; c < nCh; c++) output[c].fill(0);
      return true;
    }
    const pan = params.pan[0];
    const width = params.width[0];

    if ((pan === 0 && width === 1) || nCh === 1 || (nCh !== 2 && !RINGS[nCh])) {
      for (let c = 0; c < nCh; c++) output[c].set(input[c] || input[0]);
      return true;
    }

    if (nCh === 2) {
      const inL = input[0], inR = input[1] || input[0];
      const outL = output[0], outR = output[1];
      // Constant-power balance, unity at centre.
      const a = ((pan + 1) * Math.PI) / 4;
      const gL = Math.cos(a) * Math.SQRT2, gR = Math.sin(a) * Math.SQRT2;
      for (let n = 0; n < frames; n++) {
        const mid = 0.5 * (inL[n] + inR[n]);
        const side = 0.5 * (inL[n] - inR[n]) * width;
        outL[n] = (mid + side) * gL;
        outR[n] = (mid - side) * gR;
      }
      return true;
    }

    const key = `${nCh}|${pan}|${width}`;
    if (key !== this.key) { this.key = key; this.buildMatrix(nCh, pan, width); }
    const m = this.matrix;
    for (let o = 0; o < nCh; o++) output[o].fill(0);
    for (let c = 0; c < nCh; c++) {
      const src = input[c];
      if (!src) continue;
      for (let o = 0; o < nCh; o++) {
        const g = m[c * MAX_CH + o];
        if (g === 0) continue;
        const dst = output[o];
        for (let n = 0; n < frames; n++) dst[n] += src[n] * g;
      }
    }
    return true;
  }
}

registerProcessor("placer-processor", PlacerProcessor);
