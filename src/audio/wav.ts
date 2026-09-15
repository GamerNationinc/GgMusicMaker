// Minimal 16-bit PCM WAV encoder.
//
// Web Audio can decode almost anything but can't *encode*, so for export we
// render the mix to an AudioBuffer (offline) and hand it here. Works on a plain
// { numberOfChannels, sampleRate, length, getChannelData } shape so it can be
// unit-tested without a real AudioContext.

export interface PcmSource {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

function clampSample(x: number): number {
  if (x > 1) return 1;
  if (x < -1) return -1;
  return x;
}

/** Encode an audio buffer to a 16-bit PCM WAV as an ArrayBuffer. */
export function encodeWav(buffer: PcmSource): ArrayBuffer {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  // RIFF header
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  // fmt chunk
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  // data chunk
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  // Interleave channels, converting float [-1,1] to signed 16-bit.
  const chanData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chanData.push(buffer.getChannelData(c));

  let pos = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = clampSample(chanData[c][i]);
      view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      pos += 2;
    }
  }
  return out;
}

/** Decoded PCM: one Float32Array per channel, all the same length. */
export interface DecodedPcm {
  sampleRate: number;
  channels: Float32Array[];
}

/**
 * Decode a 16-bit PCM WAV (the only kind `encodeWav` writes). Walks the RIFF
 * chunks so a WAV with extra chunks (LIST, fact) still decodes. Session files
 * embed these, so loading must not depend on the WebView's media stack.
 */
export function decodeWav(bytes: ArrayBuffer): DecodedPcm {
  const view = new DataView(bytes);
  const readStr = (offset: number, len: number) => {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  };
  if (bytes.byteLength < 12 || readStr(0, 4) !== "RIFF" || readStr(8, 4) !== "WAVE") {
    throw new Error("not a WAV file");
  }

  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let format = 0;
  let dataOffset = -1;
  let dataSize = 0;
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = readStr(pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataOffset = body;
      dataSize = Math.min(size, bytes.byteLength - body);
      break;
    }
    pos = body + size + (size & 1); // chunks are word-aligned
  }
  if (dataOffset < 0 || !channels || !sampleRate) throw new Error("WAV is missing fmt/data");
  if (format !== 1 || bits !== 16) throw new Error(`unsupported WAV (format ${format}, ${bits}-bit)`);

  const frames = Math.floor(dataSize / (channels * 2));
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
  let p = dataOffset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = view.getInt16(p, true);
      out[c][i] = s < 0 ? s / 0x8000 : s / 0x7fff;
      p += 2;
    }
  }
  return { sampleRate, channels: out };
}
