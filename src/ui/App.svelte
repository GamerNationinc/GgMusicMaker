<script lang="ts">
  import Transport from "./Transport.svelte";
  import Toolbar from "./Toolbar.svelte";
  import Timeline from "./Timeline.svelte";
  import FxRack from "./FxRack.svelte";
  import AnalogMeter from "./AnalogMeter.svelte";
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
  } from "../state/store";

  function onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "z") {
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

<svelte:window on:keydown={onKey} />

<header class="app-header panel">
  <div class="brand">
    <span class="logo">▶</span>
    <span class="title">GgMusic<span class="accent">Maker</span></span>
  </div>
  <Transport />
</header>

<Toolbar />

<main class="workspace">
  <Timeline />
</main>

<FxRack />

<footer class="bottom">
  <AnalogMeter />
  <div class="statusbar screen">{$status}</div>
</footer>

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
  .workspace {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    overflow: hidden;
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
