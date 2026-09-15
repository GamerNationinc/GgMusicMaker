<script lang="ts">
  // Falling-glyph backdrop for the timeline void. Deliberately cheap: ~20 fps,
  // one fillText per column per tick, trails via a translucent clear. Sits
  // behind the lanes; track stripes and clips are opaque, so the rain only
  // shows where there is nothing else — the space "beyond" the project.
  import { onMount } from "svelte";

  // Pure ASCII: guaranteed to exist in every monospace font WebKitGTK can
  // find on the Deck (CJK glyphs rendered as blanks there).
  const GLYPHS = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ<>/\\|=+*#@%$&?!;:~^";
  const COL_W = 14;
  const ROW_H = 16;
  const TICK_MS = 50;

  let canvas: HTMLCanvasElement;

  onMount(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const ctx = canvas.getContext("2d")!;
    let cols = 0;
    let heads: number[] = [];
    let speeds: number[] = [];
    let w = 0;
    let h = 0;

    function resize() {
      const parent = canvas.parentElement!;
      w = parent.clientWidth;
      h = parent.clientHeight;
      canvas.width = w;
      canvas.height = h;
      cols = Math.ceil(w / COL_W);
      heads = Array.from({ length: cols }, () => Math.random() * -40);
      speeds = Array.from({ length: cols }, () => 0.4 + Math.random() * 0.9);
      ctx.fillStyle = "#030805";
      ctx.fillRect(0, 0, w, h);
      ctx.font = `bold 13px "Courier New", "DejaVu Sans Mono", monospace`;
    }

    function tick() {
      // Trail: fade what's there instead of clearing.
      ctx.fillStyle = "rgba(3, 8, 5, 0.18)";
      ctx.fillRect(0, 0, w, h);
      for (let c = 0; c < cols; c++) {
        const y = heads[c] * ROW_H;
        const ch = GLYPHS[(Math.random() * GLYPHS.length) | 0];
        const x = c * COL_W;
        // Bright head, dimmer body is left behind by the fade.
        ctx.fillStyle = "#b8ffd0";
        ctx.fillText(ch, x, y);
        ctx.fillStyle = "#1f9a52";
        ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], x, y - ROW_H);
        heads[c] += speeds[c];
        if (y > h + ROW_H * 4 && Math.random() < 0.05) {
          heads[c] = -Math.random() * 20;
          speeds[c] = 0.4 + Math.random() * 0.9;
        }
      }
    }

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);
    let timer = 0;
    // A hidden window still runs timers (throttled); painting into it is
    // pure waste, so the rain sleeps while the document is hidden.
    const start = () => {
      if (!timer && !document.hidden) timer = window.setInterval(tick, TICK_MS);
    };
    const pause = () => {
      clearInterval(timer);
      timer = 0;
    };
    const onVisibility = () => (document.hidden ? pause() : start());
    if (!reduce) {
      // Prime a few rows so it doesn't start blank.
      for (let i = 0; i < 30; i++) tick();
      start();
      document.addEventListener("visibilitychange", onVisibility);
    } else {
      for (let i = 0; i < 60; i++) tick();
    }
    return () => {
      pause();
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
    };
  });
</script>

<canvas bind:this={canvas} class="rain" aria-hidden="true"></canvas>

<style>
  .rain {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0.32;
    pointer-events: none;
  }
</style>
