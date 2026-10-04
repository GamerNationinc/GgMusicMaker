// Skip-back AudioWorklet — the web engine's twin of native/src/skipback.rs.
//
// An always-on ring of the master output (what goes to the device, after the
// limiter, as stereo), so a jam that wasn't recorded can still be rescued and
// RESAMPLE can bounce the mix with its effects baked in. The ring lives here,
// on the audio thread; the page only asks for copies.
//
// Protocol (port):
//   in  {type:"mark", id}                    → {id, frame}
//   in  {type:"grab", id, from, frames}      → {id, start, ctxTime, channels:[L, R]}
//       from = a mark's frame, or null for the last `frames`; at most `frames`.
//       ctxTime = the context time the first sample was played at (null if
//       the ring no longer knows).
//
// processorOptions.seconds sets the length (default 120 s).

class SkipBackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const seconds = (options && options.processorOptions && options.processorOptions.seconds) || 120;
    this.cap = Math.max(128, Math.ceil((seconds * sampleRate) / 128) * 128);
    this.left = new Float32Array(this.cap);
    this.right = new Float32Array(this.cap);
    // Context time of every 128-frame slot's first frame.
    this.times = new Float64Array(this.cap / 128).fill(NaN);
    this.written = 0;
    this.port.onmessage = (e) => this.message(e.data || {});
  }

  message(m) {
    if (m.type === "mark") {
      this.port.postMessage({ id: m.id, frame: this.written });
    } else if (m.type === "grab") {
      const w = this.written;
      const oldest = Math.max(0, w - this.cap);
      const max = Math.max(0, Math.floor(m.frames || 0));
      let start = m.from == null ? w - max : m.from;
      start = Math.min(w, Math.max(oldest, start));
      const end = Math.min(w, start + max);
      const n = end - start;
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      const at = start % this.cap;
      const first = Math.min(n, this.cap - at);
      l.set(this.left.subarray(at, at + first));
      r.set(this.right.subarray(at, at + first));
      if (first < n) {
        l.set(this.left.subarray(0, n - first), first);
        r.set(this.right.subarray(0, n - first), first);
      }
      const slot = Math.floor(start / 128);
      const t = this.times[slot % this.times.length];
      const ctxTime = n > 0 && Number.isFinite(t) ? t + (start - slot * 128) / sampleRate : null;
      this.port.postMessage({ id: m.id, start, ctxTime, channels: [l, r] }, [l.buffer, r.buffer]);
    }
  }

  process(inputs) {
    const input = inputs[0];
    const n = input && input[0] ? input[0].length : 128;
    const l = input && input[0];
    const r = (input && input[1]) || l;
    for (let i = 0; i < n; i++) {
      const f = this.written + i;
      const at = f % this.cap;
      // Nothing connected (or silence the graph optimised away): zeros.
      this.left[at] = l ? l[i] : 0;
      this.right[at] = r ? r[i] : 0;
      if (f % 128 === 0) this.times[(f / 128) % this.times.length] = currentTime + i / sampleRate;
    }
    this.written += n;
    return true;
  }
}

registerProcessor("skipback-processor", SkipBackProcessor);
