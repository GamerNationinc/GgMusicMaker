<script lang="ts">
  import Transport from "./Transport.svelte";
  import Toolbar from "./Toolbar.svelte";
  import Timeline from "./Timeline.svelte";
  import FxRack from "./FxRack.svelte";
  import AnalogMeter from "./AnalogMeter.svelte";
  import ExportDialog from "./ExportDialog.svelte";
  import StemsDialog from "./StemsDialog.svelte";
  import ChopLab from "./ChopLab.svelte";
  import MatrixRain from "./MatrixRain.svelte";
  import LoadMeter from "./LoadMeter.svelte";
  import EngineSwitch from "./EngineSwitch.svelte";
  import ModeSwitch from "./ModeSwitch.svelte";
  import InstrumentView from "./InstrumentView.svelte";
  import AsciiLoader from "./AsciiLoader.svelte";
  import { withBoot } from "../state/loading";
  import { mode, startController, deckPerforming, arrowGuard, instrumentView } from "../input/controller";
  import { nav } from "./timelineNav";
  import { clipEnd } from "../audio/edits";
  import {
    togglePlay,
    splitAtPlayhead,
    deleteSelectedClip,
    startRecording,
    skipBack,
    toggleResample,
    chopLab,
    stopRecording,
    undo,
    redo,
    duplicateSelectedTrack,
    status,
    transport,
    project,
    selectedClipId,
    saveSession,
    openSession,
    confirmDiscardForOpen,
    newSession,
    sessionPath,
    dirty,
    lowPower,
    clearAutosave,
    recoverAutosave,
    startAutosave,
  } from "../state/store";
  import { sessionDisplayName } from "../state/session";
  import { isNative, onCloseRequested, confirmDialog } from "../state/platform";
  import { onMount } from "svelte";
  import { theme, cycleTheme } from "./themeStore";

  function onTheme() {
    const t = cycleTheme();
    status.set(`Theme: ${t.label} (T to cycle).`);
  }

  const STUDIO_KEYS = [["space", "play"], ["s", "split"], ["r", "rec"], ["del", "delete"], ["^z", "undo"], ["^s", "save"], ["←→↑↓", "scroll/zoom"], ["L-pad", "swipe · click+drag zoom"], ["z", "fit"], ["f", "follow"], ["t", "theme"]];
  const PADS_KEYS = [["R-pad", "4×4 pads"], ["D-pad+XYAB", "pads 1–8"], ["L1+", "9–16"], ["L4/R4", "bank"], ["L3", "fx bus"], ["L5", "fx on"], ["R2", "grab"], ["L-pad", "fx xy"], ["R3", "skip back"], ["Menu", "kit"]];
  const INSTRUMENT_KEYS = [["R-pad", "notes"], ["L-pad", "cutoff/reverb"], ["ABXY", "drums"], ["L1/R1+ABXY", "chords"], ["R2", "swell"], ["L5", "sustain"], ["R5", "tilt bend"], ["Menu", "pads"], ["View+Menu", "studio"]];

  const sessionName = $derived(sessionDisplayName($sessionPath));

  // Losing an hour of takes to a stray close click is the worst thing a DAW
  // can do. Browser: the standard beforeunload prompt. Desktop app: the
  // window close is intercepted, we ask, and only then let it through.
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (!$dirty || isNative()) return;
    e.preventDefault();
    e.returnValue = "";
  }

  onMount(() => {
    onCloseRequested(async () => {
      if (!$dirty) return true;
      const quit = await confirmDialog(`${sessionName} has unsaved changes. Quit anyway?`, "Unsaved changes");
      if (quit) {
        dirty.set(false);
        await clearAutosave();
      }
      return quit;
    });
    // The boot screen while the shell and controller come up; then crash
    // recovery (before the timer, so it never overwrites what it offers).
    void withBoot(async (report) => {
      report(null, "connecting the controller");
      startController();
      // The first layout and paint happen under the boot screen. (A timer,
      // not animation frames: a hidden window never runs those.)
      await new Promise((r) => setTimeout(r, 80));
    })
      .then(recoverAutosave)
      .then(startAutosave);
  });

  function onKey(e: KeyboardEvent) {
    // The chop lab handles its own keys (Escape); nothing may edit behind it.
    if ($chopLab) return;
    // Performing on the Deck: Steam's desktop layout also types keys for the
    // face buttons (A = Enter, B = Escape…) — none of them may edit.
    if ($mode !== "studio") {
      if ($deckPerforming) e.preventDefault();
      return;
    }
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        void saveSession(e.shiftKey);
      } else if (k === "o") {
        e.preventDefault();
        void openSession().then(async (handled) => {
          if (handled || !(await confirmDiscardForOpen())) return;
          document.querySelector<HTMLInputElement>("input[data-role=session-file]")?.click();
        });
      } else if (k === "n") {
        e.preventDefault();
        void newSession();
      } else if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (k === "y") {
        e.preventDefault();
        redo();
      } else if (k === "d") {
        e.preventDefault();
        duplicateSelectedTrack();
      }
      return;
    }
    switch (e.key) {
      case " ":
        e.preventDefault();
        togglePlay();
        break;
      // Timeline navigation. The Deck's left stick also arrives here as
      // arrow keys (Steam's desktop layout); while the raw stick is driving
      // the timeline smoothly those are dropped.
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        e.preventDefault();
        if (arrowGuard()) break;
        const w = document.querySelector(".lanes-scroll")?.clientWidth ?? 800;
        if (e.key === "ArrowLeft") nav.scrollBy(-w * 0.2);
        else if (e.key === "ArrowRight") nav.scrollBy(w * 0.2);
        else nav.zoomBy(e.key === "ArrowUp" ? 1.25 : 1 / 1.25);
        break;
      }
      case "+":
      case "=":
        nav.zoomBy(1.5);
        break;
      case "-":
      case "_":
        nav.zoomBy(1 / 1.5);
        break;
      case "z":
      case "Z": {
        // Ableton's Z: zoom to the selection — here the selected clip, or the whole song.
        const clip = $project.tracks.flatMap((t) => t.clips).find((c) => c.id === $selectedClipId);
        nav.fit(clip ? [clip.startTime, clipEnd(clip)] : undefined);
        break;
      }
      case "f":
      case "F":
        status.set(nav.toggleFollow() ? "Follow on: the view turns the page with the playhead." : "Follow off.");
        break;
      case "s":
      case "S":
        splitAtPlayhead();
        break;
      case "Delete":
      case "Backspace":
        deleteSelectedClip();
        break;
      case "t":
      case "T":
        onTheme();
        break;
      case "r":
      case "R":
        if ($transport.isRecording) void stopRecording();
        else void startRecording();
        break;
      case "b":
      case "B":
        if (e.shiftKey) void toggleResample();
        else void skipBack();
        break;
    }
  }
</script>

<svelte:window on:keydown={onKey} on:beforeunload={onBeforeUnload} />

<header class="app-header box" data-title="ggmusicmaker" data-title-right={$theme.label.toLowerCase()}>
  <div class="brand">
    <span class="logo">▶</span>
    <span class="title">GgMusic<span class="accent">Maker</span></span>
    <span class="session screen" title={$sessionPath ?? "Not saved yet"}>
      {sessionName}{#if $dirty}<span class="dirty">*</span>{/if}
    </span>
  </div>
  <ModeSwitch />
  <LoadMeter />
  <EngineSwitch />
  <button class="btn theme-btn" onclick={onTheme} title="Colour mode: {$theme.label} — click or T to cycle" data-role="theme">
    <span class="theme-icon">◐</span> <span class="theme-label">{$theme.label}</span>
  </button>
  <Transport />
</header>

{#if $mode === "instrument"}
  <InstrumentView />
{:else}
  <Toolbar />

  <main class="workspace box" data-title="layers">
    {#if !$lowPower}
      <MatrixRain />
    {/if}
    <Timeline />
  </main>

  <FxRack />
{/if}

<footer class="bottom">
  <div class="box meter-box" data-title="vu · pre-limit">
    <AnalogMeter />
  </div>
  <div class="box status-box" data-title="status">
    <div class="keys" aria-label={$mode === "instrument" ? "Controller" : "Keyboard shortcuts"}>
      {#each $mode === "instrument" ? ($instrumentView.kit === "pads" ? PADS_KEYS : INSTRUMENT_KEYS) : STUDIO_KEYS as [k, what] (k)}
        <span class="key"><b>{k}</b> {what}</span>
      {/each}
    </div>
    <div class="statusbar screen">{$status}</div>
  </div>
</footer>

<ExportDialog />
<StemsDialog />
{#if $chopLab}<ChopLab src={$chopLab} />{/if}
<AsciiLoader />

<style>
  .app-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px 6px;
    margin: 8px 6px 0;
    flex: 0 0 auto;
  }
  .theme-btn {
    font-size: 11px;
    padding: 0 8px;
    flex: 0 0 auto;
    white-space: nowrap;
    color: var(--box-title);
  }
  .theme-icon {
    color: var(--magenta);
  }
  /* Narrow windows (the Deck's own screen, a default-size window): the
     wordmark and the theme's name make way for the controls — the name is
     in the window title, the theme's in the button's tooltip. */
  @media (max-width: 1400px) {
    .app-header {
      gap: 6px;
    }
    .theme-label,
    .title {
      display: none;
    }
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .logo {
    color: var(--green);
    font-size: 22px;
    text-shadow: var(--glow);
  }
  .title {
    font-weight: bold;
    letter-spacing: 1px;
    font-size: 20px;
    color: var(--ink);
  }
  .accent {
    color: var(--cyan);
  }
  .session {
    font-size: 12px;
    padding: 2px 8px;
    max-width: 180px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dirty {
    color: var(--amber);
  }
  .workspace {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
    position: relative; /* rain canvas anchors here, behind the timeline */
    background: var(--bg);
    margin: 8px 6px 0;
  }
  /* No overflow:hidden here — it would clip the box title; the rain is
     inset:0 and the timeline scrolls inside itself. */
  .workspace > :global(.timeline) {
    position: relative;
    z-index: 1;
  }
  .title {
    text-shadow: var(--glow);
  }
  .bottom {
    flex: 0 0 auto;
    display: flex;
    align-items: stretch;
    gap: 6px;
    margin: 8px 6px 6px;
  }
  .meter-box {
    padding: 11px 2px 2px;
    display: flex;
  }
  .status-box {
    flex: 1 1 auto;
    min-width: 0;
    padding: 12px 6px 6px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 6px;
  }
  .keys {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    font-size: 11px;
    color: var(--ink-dim);
    padding: 0 4px;
  }
  .key b {
    color: var(--box-title);
  }
  .statusbar {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    min-height: 26px;
    display: flex;
    align-items: center;
    flex: 0 0 auto;
  }
</style>
