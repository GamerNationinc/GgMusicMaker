// FX BUS AudioWorklet — one performance-effect bus (docs/sampler-research.md
// §3.2). The DSP lives in fxbus-core.js (added to the worklet first; it parks
// FxBusCore on globalThis); native/src/fxbus.rs is its line-by-line port.
//
// Settings arrive on the port: { effect, a, b, depth } (any subset), applied
// at the start of the next quantum. Channels 0/1 are processed; any others
// (a 5.1/7.1 master bus) pass through untouched.

class FxBusProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.core = new globalThis.FxBusCore(sampleRate);
    this.pending = [];
    this.port.onmessage = (e) => this.pending.push(e.data || {});
    this.zero = new Float32Array(128);
  }

  process(inputs, outputs) {
    for (const p of this.pending) this.core.set(p);
    this.pending.length = 0;
    const input = inputs[0] || [];
    const out = outputs[0];
    const n = out[0].length;
    if (this.zero.length < n) this.zero = new Float32Array(n);
    for (let c = 0; c < out.length; c++) out[c].set(input[c] || (c < 2 ? input[0] || this.zero : this.zero));
    const r = out[1] || out[0];
    if (out.length === 1) {
      // A mono bus: process a copy as R so L stays the left channel.
      const tmp = out[0].slice();
      this.core.process(out[0], tmp, n);
    } else {
      this.core.process(out[0], r, n);
    }
    return true;
  }
}

registerProcessor("fxbus-processor", FxBusProcessor);
