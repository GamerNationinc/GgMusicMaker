<script lang="ts">
  // The toolbar's mic button and its drop-down: what to record from (the
  // device, and which of its inputs), hearing it, the metronome and count-in.
  import {
    inputDevices,
    selectedInputDevice,
    setInputDevice,
    refreshInputDevices,
    refreshInputChannels,
    inputChannel,
    inputChannelCount,
    setInputChannel,
    monitorInput,
    toggleMonitor,
    inputLevel,
    canMonitor,
    metronome,
    toggleMetronome,
    countInBars,
    setCountIn,
    canClick,
    transport,
  } from "../state/store";

  let open = $state(false);
  let root: HTMLDivElement;

  const deviceLabel = $derived($inputDevices.find((d) => d.id === $selectedInputDevice)?.label || "Mic");
  const inputLabel = $derived($inputChannel == null ? "" : ` · in ${$inputChannel + 1}`);

  function toggle() {
    open = !open;
    if (open) {
      void refreshInputDevices(true);
      void refreshInputChannels();
    }
  }

  function onWindowDown(e: PointerEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }

  /** Level → meter width; dB-ish so quiet signals still show. */
  const levelPct = $derived(Math.max(0, Math.min(100, ((20 * Math.log10(Math.max($inputLevel, 1e-4)) + 60) / 60) * 100)));
</script>

<svelte:window onpointerdown={onWindowDown} />

<div class="rec-setup" bind:this={root}>
  <button
    class="btn input-btn"
    class:on={open}
    onclick={toggle}
    title={`Record from: ${deviceLabel}${inputLabel} — click for inputs, hearing yourself, metronome and count-in`}
    data-role="record-setup"
  >🎤 {deviceLabel}{inputLabel} ▾</button>

  {#if open}
    <div class="panel box" data-title="record setup" data-role="record-panel">
      <label class="row">
        <span class="tiny">DEVICE</span>
        <select
          class="btn"
          data-role="input-device"
          disabled={$transport.isRecording}
          value={$selectedInputDevice}
          onchange={(e) => setInputDevice((e.target as HTMLSelectElement).value)}
        >
          <option value="">Default mic</option>
          {#each $inputDevices as d (d.id)}
            <option value={d.id}>{d.label}</option>
          {/each}
        </select>
      </label>

      <label class="row" title="An audio interface's inputs: record just the one your instrument is plugged into (a mono take), or inputs 1 and 2 as stereo.">
        <span class="tiny">INPUT</span>
        <select
          class="btn"
          data-role="input-channel"
          disabled={$transport.isRecording}
          value={$inputChannel == null ? "" : String($inputChannel)}
          onchange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            setInputChannel(v === "" ? null : Number(v));
          }}
        >
          <option value="">{$inputChannelCount > 1 ? "Inputs 1+2 (stereo)" : "Input 1"}</option>
          {#if $inputChannelCount > 1}
            {#each Array.from({ length: $inputChannelCount }, (_, i) => i) as i (i)}
              <option value={String(i)}>Input {i + 1} (mono)</option>
            {/each}
          {/if}
        </select>
      </label>

      <div class="row">
        <span class="tiny">HEAR IT</span>
        <button
          class="btn small"
          class:accent={$monitorInput}
          onclick={toggleMonitor}
          disabled={!canMonitor}
          aria-pressed={$monitorInput}
          title={canMonitor
            ? "Monitor: hear the input through your headphones while a layer is armed (●). With speakers it will feed back."
            : "Hearing the input needs the native engine"}
          data-role="monitor"
        >{$monitorInput ? "MONITOR ON" : "MONITOR OFF"}</button>
        <span class="level" title="Input level" data-role="input-level" data-level={$inputLevel.toFixed(3)}>
          <span class="fill" class:hot={$inputLevel > 0.9} style:width="{levelPct}%"></span>
        </span>
      </div>

      <div class="row">
        <span class="tiny">METRONOME</span>
        <button
          class="btn small"
          class:accent={$metronome}
          onclick={toggleMetronome}
          disabled={!canClick}
          aria-pressed={$metronome}
          title={canClick ? "Clicks on the song's beat while it plays (never in the export)" : "The metronome needs the native engine"}
          data-role="metronome-panel"
        >{$metronome ? "CLICK ON" : "CLICK OFF"}</button>
        <span class="tiny count">COUNT-IN</span>
        <div class="choices" role="radiogroup" aria-label="Count-in">
          {#each [0, 1, 2] as n (n)}
            <button
              class="btn small"
              class:accent={$countInBars === n}
              role="radio"
              aria-checked={$countInBars === n}
              onclick={() => setCountIn(n)}
              data-role="count-in-{n}"
            >{n === 0 ? "OFF" : `${n} BAR${n > 1 ? "S" : ""}`}</button>
          {/each}
        </div>
      </div>
      <span class="tiny hint">Count-in plays with the metronome on, when Record starts from stopped. Latency: calibrate with ⏱ in the header.</span>
    </div>
  {/if}
</div>

<style>
  .rec-setup {
    position: relative;
  }
  .input-btn {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .input-btn.on {
    color: var(--green);
  }
  /* Opens leftwards: the button sits near the toolbar's right end. */
  .panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 50;
    width: 430px;
    max-width: calc(100vw - 24px);
    padding: 14px 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--panel);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .row .tiny {
    min-width: 74px;
    font-size: 10px;
    white-space: nowrap;
    flex: 0 0 auto;
  }
  .row .btn.small {
    font-size: 10px;
    padding: 0 7px;
    min-height: 26px;
  }
  .row .tiny + .choices,
  .row .btn.small {
    white-space: nowrap;
  }
  .row select {
    height: 28px;
    font-size: 11px;
  }
  .row select {
    flex: 1 1 auto;
    min-width: 0;
  }
  .row .tiny.count {
    min-width: 0;
    margin-left: 8px;
  }
  .choices {
    display: flex;
    gap: 2px;
  }
  .level {
    flex: 1 1 auto;
    height: 10px;
    background: var(--panel-lo);
    border: 1px solid var(--box);
    position: relative;
  }
  .level .fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: var(--meter-lo);
  }
  .level .fill.hot {
    background: var(--meter-hi);
  }
  .hint {
    font-size: 10px;
    line-height: 1.4;
    color: var(--ink-dim);
  }
  @media (max-width: 1400px) {
    .input-btn {
      max-width: 96px;
    }
  }
</style>
