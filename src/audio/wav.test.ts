import { describe, it, expect } from "vitest";
import { encodeWav, decodeWav, speakerMask, type PcmSource } from "./wav";
import { computePeaks } from "../render/peaks";

function fakeBuffer(channels: Float32Array[], sampleRate = 48000): PcmSource {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0].length,
    getChannelData: (c) => channels[c],
  };
}

function readStr(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe("encodeWav", () => {
  it("writes 5.1 and 7.1 as WAVE_FORMAT_EXTENSIBLE with a speaker mask", () => {
    for (const [channels, mask] of [
      [6, 0x3f],
      [8, 0x63f],
    ] as const) {
      const chans: Float32Array[] = [];
      for (let c = 0; c < channels; c++) chans.push(new Float32Array([0.1 * c, -0.1 * c, 0.5]));
      const wav = encodeWav(fakeBuffer(chans));
      const view = new DataView(wav);
      expect(readStr(view, 0, 4)).toBe("RIFF");
      expect(view.getUint32(16, true)).toBe(40); // extensible fmt size
      expect(view.getUint16(20, true)).toBe(0xfffe);
      expect(view.getUint16(22, true)).toBe(channels);
      expect(view.getUint16(36, true)).toBe(22); // cbSize
      expect(view.getUint32(40, true)).toBe(mask);
      expect(speakerMask(channels)).toBe(mask);
      expect(view.getUint8(44)).toBe(1); // PCM sub-format GUID starts 00000001
      expect(readStr(view, 60, 4)).toBe("data");
      expect(view.getUint32(64, true)).toBe(3 * channels * 2);
      expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);

      // And it decodes back, channel order intact.
      const back = decodeWav(wav);
      expect(back.channels.length).toBe(channels);
      for (let c = 0; c < channels; c++) {
        expect(back.channels[c][0]).toBeCloseTo(0.1 * c, 3);
        expect(back.channels[c][2]).toBeCloseTo(0.5, 3);
      }
    }
  });

  it("writes a valid RIFF/WAVE header for stereo", () => {
    const left = new Float32Array([0, 0.5, -0.5, 1]);
    const right = new Float32Array([0, -1, 1, 0]);
    const wav = encodeWav(fakeBuffer([left, right]));
    const view = new DataView(wav);

    expect(readStr(view, 0, 4)).toBe("RIFF");
    expect(readStr(view, 8, 4)).toBe("WAVE");
    expect(readStr(view, 12, 4)).toBe("fmt ");
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(48000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bit depth
    expect(readStr(view, 36, 4)).toBe("data");

    // 4 frames * 2 channels * 2 bytes = 16 bytes of data
    expect(view.getUint32(40, true)).toBe(16);
    expect(wav.byteLength).toBe(44 + 16);
  });

  it("converts full-scale samples correctly and clamps overshoot", () => {
    const mono = new Float32Array([1, -1, 2, -2]); // 2/-2 must clamp
    const wav = encodeWav(fakeBuffer([mono]));
    const view = new DataView(wav);
    expect(view.getInt16(44, true)).toBe(0x7fff); // +1 => max
    expect(view.getInt16(46, true)).toBe(-0x8000); // -1 => min
    expect(view.getInt16(48, true)).toBe(0x7fff); // +2 clamps to +1
    expect(view.getInt16(50, true)).toBe(-0x8000); // -2 clamps to -1
  });
});

describe("computePeaks", () => {
  it("finds min/max per bucket", () => {
    const data = new Float32Array([0, 1, -1, 0.5, -0.5, 0]);
    const peaks = computePeaks(
      { length: data.length, numberOfChannels: 1, getChannelData: () => data },
      2,
    );
    // bucket 0 = samples [0..3): min -1, max 1
    expect(peaks[0]).toBe(-1);
    expect(peaks[1]).toBe(1);
    // bucket 1 = samples [3..6): min -0.5, max 0.5
    expect(peaks[2]).toBe(-0.5);
    expect(peaks[3]).toBe(0.5);
  });

  it("returns zeros for an empty buffer", () => {
    const peaks = computePeaks(
      { length: 0, numberOfChannels: 1, getChannelData: () => new Float32Array() },
      4,
    );
    expect(Array.from(peaks)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("decodeWav", () => {
  it("round-trips what encodeWav writes", () => {
    const left = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const right = new Float32Array([0.1, -0.1, 0.9, -0.9, 0]);
    const wav = encodeWav(fakeBuffer([left, right], 44100));
    const { sampleRate, channels } = decodeWav(wav);
    expect(sampleRate).toBe(44100);
    expect(channels.length).toBe(2);
    for (let i = 0; i < left.length; i++) {
      expect(channels[0][i]).toBeCloseTo(left[i], 3);
      expect(channels[1][i]).toBeCloseTo(right[i], 3);
    }
  });

  it("skips unknown chunks before the data chunk", () => {
    const wav = encodeWav(fakeBuffer([new Float32Array([0.5, -0.5])]));
    // Splice a 6-byte (odd → padded to 8) LIST chunk between fmt and data.
    const src = new Uint8Array(wav);
    const junk = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 5, 0, 0, 0, 1, 2, 3, 4, 5, 0]);
    const out = new Uint8Array(src.length + junk.length);
    out.set(src.subarray(0, 36), 0);
    out.set(junk, 36);
    out.set(src.subarray(36), 36 + junk.length);
    const { channels } = decodeWav(out.buffer);
    expect(channels[0][0]).toBeCloseTo(0.5, 3);
    expect(channels[0][1]).toBeCloseTo(-0.5, 3);
  });

  it("rejects non-WAV and non-16-bit input", () => {
    expect(() => decodeWav(new TextEncoder().encode("hello world!").buffer)).toThrow(/not a WAV/);
    const wav = encodeWav(fakeBuffer([new Float32Array([0])]));
    new DataView(wav).setUint16(34, 24, true);
    expect(() => decodeWav(wav)).toThrow(/unsupported/);
  });
});
