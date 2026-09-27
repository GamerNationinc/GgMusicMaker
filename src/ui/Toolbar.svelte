<script lang="ts">
  import {
    importFiles,
    addEmptyTrack,
    splitAtPlayhead,
    deleteSelectedClip,
    startRecording,
    stopRecording,
    exportMix,
    separateStems,
    stemsUnavailable,
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
    project,
  } from "../state/store";
  import { SESSION_EXTENSION } from "../state/session";
  import { projectDuration } from "../audio/edits";
  import { ZOOM_MIN, ZOOM_MAX } from "./constants";

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

  // Multiplicative zoom over a wide range: from a whole song on one screen
  // down to a few samples per pixel for trimming dead space.
  function zoom(factor: number) {
    pixelsPerSecond.update((p) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, p * factor)));
  }

  /** Fit the whole project into the visible lanes. */
  function zoomFit() {
    const lanes = document.querySelector<HTMLElement>(".lanes-scroll");
    const dur = projectDuration($project);
    if (!lanes || dur <= 0) return;
    // The timeline always shows 4 s past the end (min 30 s) — fit that.
    pixelsPerSecond.set(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (lanes.clientWidth - 2) / Math.max(dur + 4, 30))));
    lanes.scrollLeft = 0;
  }
</script>

<div class="toolbar box" data-title="tools">
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
  <button
    class="btn stems"
    onclick={() => void separateStems()}
    disabled={!!$stemsUnavailable}
    title={$stemsUnavailable || "Split the selected clip into stems: vocals, drums, bass, guitar, piano, other (AI, HTDemucs)"}
  >⋔ Stems</button>

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

  <div class="zoom">
    <button class="btn" onclick={() => zoom(1 / 1.5)} aria-label="Zoom out" title="Zoom out">−</button>
    <button class="btn" onclick={zoomFit} aria-label="Zoom to fit" title="Show the whole song">FIT</button>
    <button class="btn" onclick={() => zoom(1.5)} aria-label="Zoom in" title="Zoom in (down to single samples)">＋</button>
  </div>

  <span class="spacer"></span>

  <button class="btn accent" onclick={() => void exportMix()}>⭳ Export</button>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 8px 8px 6px;
    margin: 8px 6px 0;
    flex: 0 0 auto;
    flex-wrap: wrap;
  }
  /* Slightly tighter than the global button so the whole strip fits one
     row at the Deck's 1280 px without wrapping Export onto a second line. */
  .toolbar > :global(button.btn) {
    padding: 0 7px;
  }
  /* Zoom − FIT + as one compact group. */
  .zoom {
    display: flex;
    gap: 2px;
  }
  .zoom :global(button.btn) {
    padding: 0 8px;
    min-width: 40px;
  }
  .divider {
    width: 1px;
    align-self: stretch;
    background: var(--box);
    margin: 0 2px;
  }
  .spacer {
    flex: 1 1 auto;
  }
</style>
