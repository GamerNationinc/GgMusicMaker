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

export const REVERB_SPACES: ReverbSpace[] = ["room", "hall", "plate"];

/** The IR's samples, per channel. Deterministic (seeded xorshift32, one seed
 *  per space and channel) so every render is identical and the native engine
 *  (native/src/reverb.rs) builds exactly the same response. */
export function impulseChannels(space: ReverbSpace, rate: number): Float32Array[] {
  const { seconds, decay } = SPACES[space];
  const length = Math.max(1, Math.floor(rate * seconds));
  const out: Float32Array[] = [];
  for (let ch = 0; ch < 2; ch++) {
    const data = new Float32Array(length);
    let s = (0x7e5e_0000 + REVERB_SPACES.indexOf(space) * 16 + ch) >>> 0;
    let last = 0;
    for (let i = 0; i < length; i++) {
      const envelope = Math.pow(1 - i / length, decay);
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      const white = (s / 4294967296) * 2 - 1;
      // Gentle low-pass so the tail is smooth rather than fizzy.
      last = last * 0.2 + white * 0.8;
      data[i] = last * envelope;
    }
    out.push(data);
  }
  return out;
}

/**
 * Build a stereo impulse response as decaying filtered noise.
 * `ctx` can be a realtime or offline AudioContext (both expose createBuffer).
 */
export function makeImpulseResponse(
  ctx: BaseAudioContext,
  space: ReverbSpace = "hall",
): AudioBuffer {
  const chans = impulseChannels(space, ctx.sampleRate);
  const impulse = ctx.createBuffer(2, chans[0].length, ctx.sampleRate);
  chans.forEach((d, ch) => impulse.copyToChannel(d as Float32Array<ArrayBuffer>, ch));
  return impulse;
}
