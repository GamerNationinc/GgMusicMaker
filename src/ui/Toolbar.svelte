<script lang="ts">
  import {
    importFiles,
    addEmptyTrack,
    splitAtPlayhead,
    deleteSelectedClip,
    startRecording,
    stopRecording,
    inputDevices,
    selectedInputDevice,
    setInputDevice,
    refreshInputDevices,
    exportMix,
    separateStems,
    stemsUnavailable,
    undo,
    redo,
    canUndo,
    canRedo,
    transport,
    newSession,
    openSession,
    saveSession,
    loadSessionFile,
    confirmDiscardForOpen,
    project,
  } from "../state/store";
  import { SESSION_EXTENSION } from "../state/session";
  import { projectDuration } from "../audio/edits";
  import { nav } from "./timelineNav";

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

  function onInputDeviceChange(e: Event) {
    setInputDevice((e.target as HTMLSelectElement).value);
  }

  // Multiplicative zoom over a wide range: from a whole song on one screen
  // down to a few samples per pixel for trimming dead space.
  // Zooms round the playhead (if it's on screen), like the keys and the Deck.
  function zoom(factor: number) {
    nav.zoomBy(factor);
  }

  /** Fit the whole project into the visible lanes. */
  function zoomFit() {
    if (projectDuration($project) <= 0) return;
    nav.fit();
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

  <select
    class="btn input-device"
    data-role="input-device"
    disabled={$transport.isRecording}
    value={$selectedInputDevice}
    onchange={onInputDeviceChange}
    onmousedown={() => void refreshInputDevices(true)}
    title={`Microphone: ${$inputDevices.find((d) => d.id === $selectedInputDevice)?.label || "default"} — pick which one to record from`}
  >
    <option value="">🎤 Default mic</option>
    {#each $inputDevices as d (d.id)}
      <option value={d.id}>🎤 {d.label}</option>
    {/each}
  </select>

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
  .input-device {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

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
  /* Narrow windows (a default-size window, the Deck's own screen): the mic
     picker shows just the start of its name (the whole name is in the
     tooltip) and zoom tightens, so Export stays on the one row. */
  @media (max-width: 1400px) {
    .toolbar {
      gap: 4px;
    }
    .input-device {
      max-width: 72px;
    }
    .zoom :global(button.btn) {
      padding: 0 6px;
      min-width: 32px;
    }
  }
</style>
