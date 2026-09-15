// MasterBus — gain -> limiter -> meter tap -> destination, for 2, 6 or 8 channels.
//
// Web Audio's DynamicsCompressorNode is stereo at most (it clamps wider
// inputs down to 2), so a surround bus splits into one compressor per
// channel and merges again. Every node in the bus is pinned to an explicit,
// discrete channel count: the synth worklet already places its field on the
// right speakers, so nothing here may re-mix it. A stereo bus is the plain
// gain -> compressor chain the app always had.
//
// Built the same way for the realtime AudioContext and the offline export
// context, so what the meters show is what the WAV gets.

export interface MasterBus {
  /** Where the track channels and the reverb return connect. */
  readonly input: GainNode;
  readonly channels: number;
  /** Parallel tap on the mix *before* the limiter (for the analogue meter). */
  readonly preTap: AnalyserNode;
  /** Post-limiter analyser (for the LED meter). */
  readonly post: AnalyserNode;
  /** Deepest limiter gain reduction across channels, in dB (<= 0). */
  reduction(): number;
  dispose(): void;
}

function makeLimiter(ctx: BaseAudioContext): DynamicsCompressorNode {
  // A high-ratio, fast-attack compressor acts as a simple mastering limiter.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.1;
  return limiter;
}

function pin(node: AudioNode, channels: number): void {
  node.channelCount = channels;
  node.channelCountMode = "explicit";
  node.channelInterpretation = "discrete";
}

export function buildMasterBus(ctx: BaseAudioContext, channels: number, gain = 0.9): MasterBus {
  const input = ctx.createGain();
  input.gain.value = gain;
  const preTap = ctx.createAnalyser();
  preTap.fftSize = 1024; // 512 bins ≈ 47 Hz each at 48 kHz
  preTap.smoothingTimeConstant = 0.6;
  const post = ctx.createAnalyser();
  post.fftSize = 256;

  const limiters: DynamicsCompressorNode[] = [];
  const nodes: AudioNode[] = [input, preTap, post];

  input.connect(preTap); // tap only; no output
  if (channels <= 2) {
    const limiter = makeLimiter(ctx);
    limiters.push(limiter);
    input.connect(limiter);
    limiter.connect(post);
    nodes.push(limiter);
  } else {
    pin(input, channels);
    pin(post, channels);
    const splitter = ctx.createChannelSplitter(channels);
    const merger = ctx.createChannelMerger(channels);
    pin(splitter, channels);
    input.connect(splitter);
    for (let c = 0; c < channels; c++) {
      const limiter = makeLimiter(ctx);
      limiter.channelCount = 1;
      limiter.channelCountMode = "explicit";
      splitter.connect(limiter, c);
      limiter.connect(merger, 0, c);
      limiters.push(limiter);
      nodes.push(limiter);
    }
    merger.connect(post);
    nodes.push(splitter, merger);
  }
  post.connect(ctx.destination);

  return {
    input,
    channels,
    preTap,
    post,
    reduction() {
      let r = 0;
      for (const l of limiters) if (l.reduction < r) r = l.reduction;
      return r;
    },
    dispose() {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* noop */
        }
      }
    },
  };
}

/** Channels the device can actually take for a wanted layout: the layout's
 *  count when the hardware has it, else the widest even count it supports.
 *  Web Audio only defines 1/2/4/6 speaker layouts natively; we also allow 8
 *  because the bus is discrete end to end. */
export function deviceChannelsFor(wanted: number, maxChannelCount: number): number {
  if (wanted <= 2) return 2;
  if (maxChannelCount >= wanted) return wanted;
  if (maxChannelCount >= 6) return 6;
  return 2;
}
