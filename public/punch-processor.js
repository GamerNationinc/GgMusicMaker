// PUNCH AudioWorklet — drums + bass enhancer. The DSP lives in
// punch-core.js (added to the worklet first; it parks PunchCore on
// globalThis) so the timeline preview runs the very same code.

const kParam = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "k-rate" });
const PARAMS = [
  kParam("boom", 0, 0, 1), kParam("sub", 0, 0, 1), kParam("punch", 0, 0, 1), kParam("snap", 0, -1, 1),
  kParam("drive", 0, 0, 1), kParam("blowout", 0, 0, 1), kParam("freq", 110, 40, 250),
  kParam("output", 0, -18, 12), kParam("safe", 1, 0, 1),
];
const NAMES = PARAMS.map((d) => d.name);
// Silent blocks before idling (~0.5 s: the slowest envelope + sub filters).
const QUIET_BLOCKS = Math.ceil((0.5 * sampleRate) / 128);

class PunchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return PARAMS;
  }

  constructor() {
    super();
    this.core = new globalThis.PunchCore(sampleRate);
    this.p = {};
    this.key = "";
    this.quiet = 0;
    this.idle = false;
    this.zero = new Float32Array(128);
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const out = outputs[0];
    const frames = out[0].length;
    if (this.zero.length < frames) this.zero = new Float32Array(frames);
    const has = input && input.length > 0;
    const inL = has ? input[0] : this.zero;
    const inR = has ? input[1] || input[0] : this.zero;

    let silent = true;
    for (let n = 0; n < frames; n++) if (inL[n] !== 0 || inR[n] !== 0) { silent = false; break; }
    if (silent) {
      if (this.quiet < QUIET_BLOCKS) this.quiet++;
      else {
        if (!this.idle) { this.core.reset(); this.idle = true; }
        for (const ch of out) ch.fill(0);
        return true;
      }
    } else { this.quiet = 0; this.idle = false; }

    let key = "";
    for (const n of NAMES) { const v = params[n][0]; this.p[n] = v; key += v + ","; }
    if (key !== this.key) { this.key = key; this.core.set({ ...this.p }); }

    const core = this.core;
    const oL = out[0], oR = out[1] || out[0];
    for (let n = 0; n < frames; n++) {
      core.step(inL[n], inR[n]);
      oL[n] = core.l;
      oR[n] = core.r;
    }
    for (let c = 2; c < out.length; c++) out[c].fill(0);
    return true;
  }
}

registerProcessor("punch-processor", PunchProcessor);
