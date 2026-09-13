<script lang="ts">
  import {
    importFiles,
    addEmptyTrack,
    splitAtPlayhead,
    deleteSelectedClip,
    startRecording,
    stopRecording,
    exportMix,
    undo,
    redo,
    canUndo,
    canRedo,
    transport,
    pixelsPerSecond,
  } from "../state/store";

  let fileInput: HTMLInputElement;

  function onFiles(e: Event) {
    const files = (e.target as HTMLInputElement).files;
    if (files && files.length) void importFiles(files);
    (e.target as HTMLInputElement).value = "";
  }

  function toggleRecord() {
    if ($transport.isRecording) void stopRecording();
    else void startRecording();
  }

  function zoom(delta: number) {
    pixelsPerSecond.update((p) => Math.min(400, Math.max(20, p + delta)));
  }
</script>

<div class="toolbar panel">
  <input
    bind:this={fileInput}
    type="file"
    accept="audio/*"
    multiple
    onchange={onFiles}
    hidden
  />
  <button class="btn magenta" onclick={() => fileInput.click()}>＋ Import</button>
  <button class="btn" onclick={addEmptyTrack}>＋ Layer</button>

  <span class="divider"></span>

  <button class="btn undo" onclick={undo} disabled={!$canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">↶ Undo</button>
  <button class="btn redo" onclick={redo} disabled={!$canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷ Redo</button>

  <span class="divider"></span>

  <button class="btn" onclick={splitAtPlayhead} title="Split at playhead (S)">✂ Split</button>
  <button class="btn danger" onclick={deleteSelectedClip} title="Delete clip (Del)">🗑 Delete</button>

  <span class="divider"></span>

  <button
    class="btn danger"
    class:on={$transport.isRecording}
    onclick={toggleRecord}
    title="Record (R)"
  >
    {$transport.isRecording ? "● REC…" : "● Record"}
  </button>

  <span class="divider"></span>

  <button class="btn" onclick={() => zoom(-20)} aria-label="Zoom out">🔍−</button>
  <button class="btn" onclick={() => zoom(20)} aria-label="Zoom in">🔍＋</button>

  <span class="spacer"></span>

  <button class="btn accent" onclick={() => void exportMix()}>⭳ Export WAV</button>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    flex: 0 0 auto;
    flex-wrap: wrap;
  }
  .divider {
    width: 2px;
    align-self: stretch;
    background: var(--bevel-dark);
    margin: 0 4px;
  }
  .spacer {
    flex: 1 1 auto;
  }
</style>
