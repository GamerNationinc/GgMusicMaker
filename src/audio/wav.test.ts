import { describe, it, expect } from "vitest";
import { encodeWav, type PcmSource } from "./wav";
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
