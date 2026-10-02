<script lang="ts">
  // The GG loader: a little ASCII tape deck that plays while something
  // loads (app start, opening a session, importing audio, recovering an
  // autosave). One <pre> whose text is rebuilt ~11 times a second — no
  // canvas, no layout work beyond one text node, nothing at all while
  // hidden. Clicks pass straight through: it never blocks the app.
  import { loading } from "../state/loading";
  import { loaderFrame } from "./asciiLoader";
  import { onDestroy } from "svelte";

  const FPS_MS = 90;
  let pre = $state<HTMLPreElement>();
  let t = 0;
  let labelAt = 0;
  let lastLabel = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  const still = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function draw() {
    const s = $loading;
    if (!s || !pre) return;
    if (s.label !== lastLabel) {
      lastLabel = s.label;
      labelAt = t;
    }
    pre.textContent = loaderFrame({
      t,
      label: s.label,
      detail: s.detail,
      progress: s.progress,
      sinceLabel: still ? 99 : t - labelAt,
    }).join("\n");
  }

  $effect(() => {
    const on = !!$loading;
    if (on && !timer && !still) {
      timer = setInterval(() => {
        if (document.hidden) return;
        t++;
        draw();
      }, FPS_MS);
    } else if (!on && timer) {
      clearInterval(timer);
      timer = null;
      t = 0;
      lastLabel = "";
    }
  });
  // Progress / label changes draw straight away, between ticks too.
  $effect(() => {
    void $loading;
    void pre;
    draw();
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
  });
</script>

{#if $loading}
  <div class="loader" class:boot={$loading.boot} role="status" aria-live="polite" aria-label="{$loading.label} {$loading.detail}" data-role="loader">
    <pre bind:this={pre} aria-hidden="true"></pre>
  </div>
{/if}

<style>
  .loader {
    position: fixed;
    inset: 0;
    z-index: 900;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    background: color-mix(in srgb, var(--bg) 55%, transparent);
    animation: fade-in 120ms ease-out;
  }
  .loader.boot {
    background: var(--bg);
  }
  pre {
    margin: 0;
    padding: 6px 4px;
    font-family: "DejaVu Sans Mono", monospace;
    font-size: clamp(9px, 1.55vw, 15px);
    line-height: 1.18;
    color: var(--green);
    text-shadow: var(--glow);
    background: var(--panel-lo);
    box-shadow: 4px 4px 0 #000;
    white-space: pre;
  }
  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }
</style>
