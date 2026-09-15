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
    newSession,
    openSession,
    saveSession,
    loadSessionFile,
    confirmDiscardForOpen,
  } from "../state/store";
  import { SESSION_EXTENSION } from "../state/session";

  let fileInput: HTMLInputElement;
  let sessionInput: HTMLInputElement;

  function onFiles(e: Event) {
    const files = (e.target as HTMLInputElement).files;
    if (files && files.length) void importFiles(files);
    (e.target as HTMLInputElement).value = "";
  }

  async function onOpen() {
    // No native dialog (plain browser): fall back to the file input.
    if (await openSession()) return;
    if (await confirmDiscardForOpen()) sessionInput.click();
  }

  function onSessionFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void loadSessionFile(file);
    input.value = "";
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
  <input
    bind:this={sessionInput}
    type="file"
    accept=".{SESSION_EXTENSION}"
    onchange={onSessionFile}
    hidden
    data-role="session-file"
  />
  <button class="btn session-new" onclick={() => void newSession()} title="New session (Ctrl+N)">▢ New</button>
  <button class="btn session-open" onclick={() => void onOpen()} title="Open session (Ctrl+O)">▤ Open</button>
  <button class="btn session-save" onclick={() => void saveSession()} title="Save session (Ctrl+S; Ctrl+Shift+S = Save As)">▣ Save</button>

  <span class="divider"></span>

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
    gap: 6px;
    padding: 8px 10px;
    flex: 0 0 auto;
    flex-wrap: wrap;
  }
  /* Slightly tighter than the global button so the whole strip fits one
     row at the Deck's 1280 px without wrapping Export onto a second line. */
  .toolbar > :global(button.btn) {
    padding: 0 10px;
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
