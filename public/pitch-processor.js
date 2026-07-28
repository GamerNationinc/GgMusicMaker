// Voice pitch-shifter AudioWorklet processor.
//
// A time-domain dual-delay-line ("Doppler") pitch shifter: two read pointers
// sweep a short delay buffer at a rate set by the pitch ratio, crossfaded with
// a sine window to hide the wrap discontinuities. It's compact, stable, has no
// FFT, and runs fine under WebKitGTK — good enough for chipmunk/deep/alien
// voice FX. Formant correction is intentionally omitted (v2 scope).
//
// Params (k-rate):
//   pitch — playback ratio (2 = one octave up, 0.5 = one octave down)
//   mix   — 0 dry .. 1 fully shifted (lets pitch=1 presets stay artefact-free)

class PitchShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "pitch", defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: "k-rate" },
      { name: "mix", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    // ~50 ms grain; buffer a bit longer than the grain to allow wrap.
    this.grain = Math.floor(sampleRate * 0.05);
    this.bufSize = this.grain * 2;
    this.buffers = [new Float32Array(this.bufSize), new Float32Array(this.bufSize)];
    this.writePos = 0;
    this.phase = 0; // 0..1 sweep position
  }

  read(buf, pos) {
    // Fractional read with linear interpolation and circular wrap.
    let p = pos % this.bufSize;
    if (p < 0) p += this.bufSize;
    const i = Math.floor(p);
    const frac = p - i;
    const a = buf[i];
    const b = buf[(i + 1) % this.bufSize];
    return a + (b - a) * frac;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const pitch = params.pitch[0];
    const mix = params.mix[0];
    // Per-sample phase advance: >0 delay grows (pitch down), <0 shrinks (up).
    const dPhase = (1 - pitch) / this.grain;

    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input[ch] || input[0];
      const outCh = output[ch];
      const buf = this.buffers[ch] || this.buffers[0];
      let phase = this.phase;
      let writePos = this.writePos;

      for (let n = 0; n < outCh.length; n++) {
        buf[writePos] = inCh[n];

        // Two taps, half a grain out of phase, sine-windowed.
        const p1 = phase;
        let p2 = phase + 0.5;
        if (p2 >= 1) p2 -= 1;
        const d1 = p1 * this.grain;
        const d2 = p2 * this.grain;
        const w1 = Math.sin(Math.PI * p1);
        const w2 = Math.sin(Math.PI * p2);
        const wet = w1 * this.read(buf, writePos - d1) + w2 * this.read(buf, writePos - d2);

        outCh[n] = inCh[n] * (1 - mix) + wet * mix;

        phase += dPhase;
        if (phase >= 1) phase -= 1;
        else if (phase < 0) phase += 1;
        writePos = (writePos + 1) % this.bufSize;
      }

      // Persist per-block state from the last channel processed.
      if (ch === output.length - 1) {
        this.phase = phase;
        this.writePos = writePos;
      }
    }
    return true;
  }
}

registerProcessor("pitch-shift-processor", PitchShiftProcessor);
