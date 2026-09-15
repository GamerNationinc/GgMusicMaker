<script lang="ts">
  import Transport from "./Transport.svelte";
  import Toolbar from "./Toolbar.svelte";
  import Timeline from "./Timeline.svelte";
  import FxRack from "./FxRack.svelte";
  import AnalogMeter from "./AnalogMeter.svelte";
  import ExportDialog from "./ExportDialog.svelte";
  import MatrixRain from "./MatrixRain.svelte";
  import LoadMeter from "./LoadMeter.svelte";
  import {
    togglePlay,
    splitAtPlayhead,
    deleteSelectedClip,
    startRecording,
    stopRecording,
    undo,
    redo,
    status,
    transport,
    saveSession,
    openSession,
    confirmDiscardForOpen,
    newSession,
    sessionPath,
    dirty,
    lowPower,
  } from "../state/store";
  import { sessionDisplayName } from "../state/session";
  import { isTauri } from "../state/platform";
  import { onMount } from "svelte";

  const sessionName = $derived(sessionDisplayName($sessionPath));

  // Losing an hour of takes to a stray close click is the worst thing a DAW
  // can do. Browser: the standard beforeunload prompt. Tauri: intercept the
  // window close, ask, and only then let it through.
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (!$dirty || isTauri()) return;
    e.preventDefault();
    e.returnValue = "";
  }

  onMount(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { ask } = await import("@tauri-apps/plugin-dialog");
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested(async (event) => {
          if (!$dirty) return;
          event.preventDefault();
          const quit = await ask(`${sessionName} has unsaved changes. Quit anyway?`, {
            title: "Unsaved changes",
            kind: "warning",
          });
          if (quit) {
            dirty.set(false);
            await win.close();
          }
        });
      } catch {
        // Older shell without window permissions: closing just closes.
      }
    })();
    return () => unlisten?.();
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
      case "r":
      case "R":
        if ($transport.isRecording) void stopRecording();
        else void startRecording();
        break;
    }
  }
</script>

<svelte:window on:keydown={onKey} on:beforeunload={onBeforeUnload} />

<header class="app-header panel">
  <div class="brand">
    <span class="logo">▶</span>
    <span class="title">GgMusic<span class="accent">Maker</span></span>
    <span class="session screen" title={$sessionPath ?? "Not saved yet"}>
      {sessionName}{#if $dirty}<span class="dirty">*</span>{/if}
    </span>
  </div>
  <LoadMeter />
  <Transport />
</header>

<Toolbar />

<main class="workspace">
  {#if !$lowPower}
    <MatrixRain />
  {/if}
  <Timeline />
</main>

<FxRack />

<footer class="bottom">
  <AnalogMeter />
  <div class="statusbar screen">{$status}</div>
</footer>

<ExportDialog />

<style>
  .app-header {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 8px 12px;
    flex: 0 0 auto;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .logo {
    color: var(--green);
    font-size: 22px;
    text-shadow: 0 0 8px rgba(90, 240, 150, 0.6);
  }
  .title {
    font-weight: bold;
    letter-spacing: 2px;
    font-size: 20px;
    color: var(--magenta);
    text-shadow: 2px 2px 0 var(--panel-lo);
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
    display: flex;
    overflow: hidden;
    position: relative; /* rain canvas anchors here, behind the timeline */
    background: var(--bg);
  }
  .workspace > :global(.timeline) {
    position: relative;
    z-index: 1;
  }
  .title {
    text-shadow: 2px 2px 0 var(--panel-lo), var(--glow);
  }
  .bottom {
    flex: 0 0 auto;
    display: flex;
    align-items: flex-end;
    gap: 6px;
    margin: 6px;
  }
  .statusbar {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    min-height: 26px;
    display: flex;
    align-items: center;
  }
</style>
