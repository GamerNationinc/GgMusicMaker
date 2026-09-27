<script lang="ts">
  import Transport from "./Transport.svelte";
  import Toolbar from "./Toolbar.svelte";
  import Timeline from "./Timeline.svelte";
  import FxRack from "./FxRack.svelte";
  import AnalogMeter from "./AnalogMeter.svelte";
  import ExportDialog from "./ExportDialog.svelte";
  import MatrixRain from "./MatrixRain.svelte";
  import LoadMeter from "./LoadMeter.svelte";
  import EngineSwitch from "./EngineSwitch.svelte";
  import {
    togglePlay,
    splitAtPlayhead,
    deleteSelectedClip,
    startRecording,
    stopRecording,
    undo,
    redo,
    duplicateSelectedTrack,
    status,
    transport,
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
    // Crash recovery first, so the timer never overwrites what it offers.
    void recoverAutosave().then(startAutosave);
  });

  function onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
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
  <LoadMeter />
  <EngineSwitch />
  <button class="btn theme-btn" onclick={onTheme} title="Cycle colour mode (T)" data-role="theme">
    <span class="theme-icon">◐</span> {$theme.label}
  </button>
  <Transport />
</header>

<Toolbar />

<main class="workspace box" data-title="layers">
  {#if !$lowPower}
    <MatrixRain />
  {/if}
  <Timeline />
</main>

<FxRack />

<footer class="bottom">
  <div class="box meter-box" data-title="vu · pre-limit">
    <AnalogMeter />
  </div>
  <div class="box status-box" data-title="status">
    <div class="keys" aria-label="Keyboard shortcuts">
      {#each [["space", "play"], ["s", "split"], ["r", "rec"], ["del", "delete"], ["t", "theme"], ["^z", "undo"], ["^d", "dup layer"], ["^s", "save"]] as [k, what]}
        <span class="key"><b>{k}</b> {what}</span>
      {/each}
    </div>
    <div class="statusbar screen">{$status}</div>
  </div>
</footer>

<ExportDialog />

<style>
  .app-header {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 10px 6px;
    margin: 8px 6px 0;
    flex: 0 0 auto;
  }
  .theme-btn {
    font-size: 11px;
    padding: 0 10px;
    min-width: 128px;
    color: var(--box-title);
  }
  .theme-icon {
    color: var(--magenta);
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
    letter-spacing: 2px;
    font-size: 20px;
    color: var(--ink);
  }
  .accent {
    color: var(--cyan);
  }
  .session {
    font-size: 12px;
    padding: 2px 8px;
    max-width: 220px;
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
