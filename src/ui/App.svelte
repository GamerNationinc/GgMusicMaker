<script lang="ts">
  import Transport from "./Transport.svelte";
  import Toolbar from "./Toolbar.svelte";
  import Timeline from "./Timeline.svelte";
  import {
    togglePlay,
    splitAtPlayhead,
    deleteSelectedClip,
    startRecording,
    stopRecording,
    status,
    transport,
  } from "../state/store";

  function onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
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
    <span class="title">ProfitPals<span class="daw">DAW</span></span>
  </div>
  <Transport />
</header>

<Toolbar />

<main class="workspace">
  <Timeline />
</main>

<footer class="statusbar screen">{$status}</footer>

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
  .daw {
    color: var(--cyan);
    margin-left: 4px;
  }
  .workspace {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }
  .statusbar {
    flex: 0 0 auto;
    margin: 6px;
    font-size: 13px;
    min-height: 26px;
    display: flex;
    align-items: center;
  }
</style>
