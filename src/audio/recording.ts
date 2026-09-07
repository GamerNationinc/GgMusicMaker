// Pure helpers for assembling a recorded take.
//
// The capture path (AudioWorklet, or ScriptProcessorNode as a fallback) hands
// us a list of render quanta, each an array of per-channel Float32Arrays.
// Turning that into one contiguous buffer per channel is pure array work, so it
// lives here where it can be unit-tested without an AudioContext — the engine
// only has to copy the result into an AudioBuffer.

/** One captured block: index by channel, then by sample. */
export type Chunk = Float32Array[];

export interface AssembledTake {
  /** One contiguous Float32Array per channel. */
  channels: Float32Array[];
  /** Frames per channel. */
  frames: number;
}

/**
 * Concatenate captured chunks into per-channel buffers.
 *
 * Channel count is taken from the widest chunk, so a device that starts mono
 * and reports stereo later (or vice versa) still produces a valid take; short
 * channels are filled from channel 0 rather than left as silence.
 */
export function assembleTake(chunks: Chunk[]): AssembledTake {
  const usable = chunks.filter((c) => c.length > 0 && c[0].length > 0);
  if (usable.length === 0) return { channels: [new Float32Array(0)], frames: 0 };

  let channelCount = 1;
  let frames = 0;
  for (const chunk of usable) {
    channelCount = Math.max(channelCount, chunk.length);
    frames += chunk[0].length;
  }

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch++) channels.push(new Float32Array(frames));

  let pos = 0;
  for (const chunk of usable) {
    const len = chunk[0].length;
    for (let ch = 0; ch < channelCount; ch++) {
      // Fall back to channel 0 when this chunk has fewer channels.
      channels[ch].set(chunk[ch] ?? chunk[0], pos);
    }
    pos += len;
  }
  return { channels, frames };
}
