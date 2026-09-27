import { describe, it, expect } from "vitest";
import { summarize, columnStats, SUMMARY_BUCKET, type ColumnStats } from "./peaks";

function src(chs: Float32Array[]) {
  return { length: chs[0].length, numberOfChannels: chs.length, getChannelData: (c: number) => chs[c] };
}

describe("waveform summary", () => {
  // 10 minutes at 48 kHz: the lanes must cope with long songs.
  const n = 48000 * 600;
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const on = i > n / 2; // first half silent (dead space), second half a tone
    l[i] = on ? 0.5 * Math.sin(i * 0.01) : 0;
    r[i] = on ? -0.25 * Math.sin(i * 0.01) : 0;
  }
  const buf = src([l, r]);
  const sum = summarize(buf);
  const st: ColumnStats = { min: 0, max: 0, rms: 0 };

  it("is a small fraction of the audio", () => {
    expect(sum.buckets).toBe(Math.ceil(n / SUMMARY_BUCKET));
    expect(sum.channels).toBe(2);
  });

  it("covers the whole buffer — the end of a long track has a waveform", () => {
    columnStats(sum, buf, 0, n - 48000, n, st);
    expect(st.max).toBeCloseTo(0.5, 2);
    expect(st.rms).toBeCloseTo(0.5 / Math.SQRT2, 2);
    columnStats(sum, buf, 1, n - 48000, n, st);
    expect(st.min).toBeCloseTo(-0.25, 2);
  });

  it("shows dead space as silence", () => {
    columnStats(sum, buf, 0, 1000, 480000, st);
    expect(st.max - st.min).toBe(0);
  });

  it("reads raw samples when zoomed past a bucket per pixel, same answer", () => {
    const a = { ...columnStats(sum, buf, 0, n - 100, n - 40, st) };
    let mx = -1;
    for (let i = n - 100; i < n - 40; i++) mx = Math.max(mx, l[i]);
    expect(a.max).toBe(mx);
  });
});
