import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { loading, withLoading, withBoot, __resetLoading, SHOW_AFTER_MS, MIN_SHOWN_MS, BOOT_MIN_MS } from "./loading";

describe("loading state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetLoading();
  });
  afterEach(() => vi.useRealTimers());

  it("a quick load never shows the loader", async () => {
    const job = withLoading("OPENING", async () => {
      await vi.advanceTimersByTimeAsync(SHOW_AFTER_MS - 20);
    });
    await job;
    expect(get(loading)).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(get(loading)).toBeNull();
  });

  it("a slow load shows it, with progress, and keeps it up a moment after", async () => {
    let finish!: () => void;
    const job = withLoading("IMPORTING AUDIO", (report) => {
      report(0.5, "kick.wav");
      return new Promise<void>((r) => (finish = r));
    });
    await vi.advanceTimersByTimeAsync(SHOW_AFTER_MS + 5);
    expect(get(loading)).toMatchObject({ label: "IMPORTING AUDIO", detail: "kick.wav", progress: 0.5, boot: false });
    finish();
    await job;
    expect(get(loading)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(MIN_SHOWN_MS);
    expect(get(loading)).toBeNull();
  });

  it("errors still take the loader down", async () => {
    const job = withLoading("OPENING", async () => {
      await vi.advanceTimersByTimeAsync(SHOW_AFTER_MS + 5);
      throw new Error("bad file");
    });
    await expect(job).rejects.toThrow("bad file");
    await vi.advanceTimersByTimeAsync(MIN_SHOWN_MS);
    expect(get(loading)).toBeNull();
  });

  it("boot shows at once, full window, for at least BOOT_MIN_MS; a load inside keeps that look", async () => {
    let inner!: Promise<void>;
    const boot = withBoot(async () => {
      expect(get(loading)).toMatchObject({ label: "BOOTING", boot: true });
      inner = withLoading("RECOVERING SESSION", async () => {});
      await inner;
    });
    await boot;
    expect(get(loading)?.boot).toBe(true);
    await vi.advanceTimersByTimeAsync(BOOT_MIN_MS);
    expect(get(loading)).toBeNull();
  });
});
