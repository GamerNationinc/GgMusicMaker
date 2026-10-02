// BASS MOD AudioWorklet — modulates and thickens a bass line or 808. The DSP
// lives in bass-core.js (added to the worklet first; it parks BassCore on
// globalThis); native/src/bass.rs is its line-by-line port.
//
// The LFO follows the song: the engine posts { songT0 } — the context time
// at which song time 0 plays — whenever playback (or an export) starts.

const kParam = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "k-rate" });
const PARAMS = [
  kParam("bpm", 140, 40, 240), kParam("rate", 3, 0, 7), kParam("shape", 0, 0, 4),
  kParam("wobble", 0, 0, 1), kParam("cutoff", 20000, 40, 20000), kParam("reso", 0.2, 0, 1), kParam("env", 0, -1, 1),
  kParam("vibrato", 0, 0, 1), kParam("deepen", 0, 0, 1), kParam("octave", 0, 0, 1), kParam("grit", 0, 0, 1),
  kParam("widen", 0, 0, 1), kParam("pump", 0, 0, 1), kParam("output", 0, -18, 12),
];
const NAMES = PARAMS.map((d) => d.name);
// Silent blocks before idling (~0.5 s: the slowest envelope + filters).
const QUIET_BLOCKS = Math.ceil((0.5 * sampleRate) / 128);

class BassProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return PARAMS;
  }

  constructor() {
    super();
    this.core = new globalThis.BassCore(sampleRate);
    this.p = {};
    this.key = "";
    this.quiet = 0;
    this.idle = false;
    this.zero = new Float32Array(128);
    this.songT0 = 0;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.songT0 === "number") this.songT0 = e.data.songT0;
    };
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
    core.block(currentTime - this.songT0);
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

registerProcessor("bass-processor", BassProcessor);
