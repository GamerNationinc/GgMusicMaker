// Impulse-response generation for the convolution reverb.
//
// v1 ships without IR .wav assets: we synthesise a decaying-noise impulse so the
// reverb send works out of the box. v2 can swap in real iZotope-style IR files
// (room/hall/plate) by loading them into ConvolverNode.buffer instead.

export type ReverbSpace = "room" | "hall" | "plate";

interface SpaceParams {
  seconds: number;
  decay: number;
}

const SPACES: Record<ReverbSpace, SpaceParams> = {
  room: { seconds: 0.8, decay: 3.0 },
  hall: { seconds: 2.6, decay: 2.2 },
  plate: { seconds: 1.4, decay: 4.5 },
};

/**
 * Build a stereo impulse response as decaying filtered noise.
 * `ctx` can be a realtime or offline AudioContext (both expose createBuffer).
 */
export function makeImpulseResponse(
  ctx: BaseAudioContext,
  space: ReverbSpace = "hall",
): AudioBuffer {
  const { seconds, decay } = SPACES[space];
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const impulse = ctx.createBuffer(2, length, rate);

  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const envelope = Math.pow(1 - i / length, decay);
      const white = Math.random() * 2 - 1;
      // Gentle low-pass so the tail is smooth rather than fizzy.
      last = last * 0.2 + white * 0.8;
      data[i] = last * envelope;
    }
  }
  return impulse;
}
