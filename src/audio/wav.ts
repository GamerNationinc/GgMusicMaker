// Minimal 16-bit PCM WAV encoder.
//
// Web Audio can decode almost anything but can't *encode*, so for export we
// render the mix to an AudioBuffer (offline) and hand it here. Works on a plain
// { numberOfChannels, sampleRate, length, getChannelData } shape so it can be
// unit-tested without a real AudioContext.
//
// Mono and stereo are written as plain PCM (format 1). Anything wider is
// written as WAVE_FORMAT_EXTENSIBLE with a speaker mask, which is what
// players and DAWs need to put 5.1 / 7.1 channels on the right speakers.

/** Speaker masks in SMPTE order, by channel count. */
const SPEAKER_MASKS: Record<number, number> = {
  1: 0x4, // FC
  2: 0x3, // FL FR
  4: 0x33, // FL FR BL BR
  6: 0x3f, // FL FR FC LFE BL BR
  8: 0x63f, // FL FR FC LFE BL BR SL SR
};
const FORMAT_PCM = 1;
const FORMAT_EXTENSIBLE = 0xfffe;
// KSDATAFORMAT_SUBTYPE_PCM = 00000001-0000-0010-8000-00aa00389b71
const PCM_GUID = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

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
  const extensible = channels > 2;
  const fmtSize = extensible ? 40 : 16;
  const headerSize = 12 + 8 + fmtSize + 8;
  const out = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(out);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  // RIFF header
  writeStr(0, "RIFF");
  view.setUint32(4, headerSize - 8 + dataSize, true);
  writeStr(8, "WAVE");
  // fmt chunk
  writeStr(12, "fmt ");
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, extensible ? FORMAT_EXTENSIBLE : FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  if (extensible) {
    view.setUint16(36, 22, true); // cbSize
    view.setUint16(38, 16, true); // valid bits per sample
    view.setUint32(40, SPEAKER_MASKS[channels] ?? 0, true);
    for (let i = 0; i < 16; i++) view.setUint8(44 + i, PCM_GUID[i]);
  }
  // data chunk
  const dataChunk = 12 + 8 + fmtSize;
  writeStr(dataChunk, "data");
  view.setUint32(dataChunk + 4, dataSize, true);

  // Interleave channels, converting float [-1,1] to signed 16-bit.
  const chanData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chanData.push(buffer.getChannelData(c));

  let pos = headerSize;
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

/** Speaker mask for a channel count, or 0 when there is no standard layout. */
export function speakerMask(channels: number): number {
  return SPEAKER_MASKS[channels] ?? 0;
}

/**
 * Decode a 16-bit PCM WAV (the only kind `encodeWav` writes, plain or
 * extensible). Walks the RIFF chunks so a WAV with extra chunks (LIST, fact)
 * still decodes. Session files embed these, so loading must not depend on
 * the WebView's media stack.
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
      // Extensible: the real format is the first two bytes of the sub-format GUID.
      if (format === FORMAT_EXTENSIBLE && size >= 40) format = view.getUint16(body + 24, true);
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
