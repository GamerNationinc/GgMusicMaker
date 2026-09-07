// Recording capture AudioWorklet.
//
// Replaces the deprecated ScriptProcessorNode capture path, which ran on the
// MAIN thread and could drop samples whenever the UI was busy (redrawing the
// timeline, decoding a file). This runs on the audio thread instead, so takes
// stay clean under load.
//
// It copies each render quantum and posts it to the main thread, which
// accumulates the chunks; assembling them into an AudioBuffer stays on the
// main side so this processor holds no unbounded state.
//
// Protocol: post {type:"start"} / {type:"stop"} in; receive
// {type:"chunk", channels: Float32Array[]} out.

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = true;
    this.port.onmessage = (e) => {
      const t = e.data && e.data.type;
      if (t === "start") this.recording = true;
      else if (t === "stop") this.recording = false;
    };
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    // No input connected yet (or the device dropped) — keep the node alive.
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true;

    // Copy: the underlying buffers are reused by the engine after we return.
    const channels = [];
    for (let ch = 0; ch < input.length; ch++) {
      channels.push(new Float32Array(input[ch]));
    }
    this.port.postMessage({ type: "chunk", channels }, channels.map((c) => c.buffer));
    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
