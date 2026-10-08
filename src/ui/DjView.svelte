<script lang="ts">
  // DJ mode: deck A | mixer | deck B. The mixer has each deck's 3-band EQ
  // (knob + kill), channel fader and the crossfader. The Deck's controls are
  // mapped in src/input/dj.ts; this draws the desk and forwards the screen.
  import DjDeck from "./DjDeck.svelte";
  import { djView, djAct, screenOnly, controllerSource } from "../input/controller";
  import { EQ_BANDS, knobDb, type EqBand } from "../input/dj";

  const v = $derived($djView);
  const sourceLabel = $derived($controllerSource === "deck" ? "deck controls · raw" : $controllerSource === "gamepad" ? "gamepad" : "touch only");
  const BAND_LABEL: Record<EqBand, string> = { high: "HI", mid: "MID", low: "LOW" };
  const BANDS = [...EQ_BANDS].reverse(); // HI on top
  const db = (deck: number, b: EqBand) => {
    const d = v.decks[deck];
    if (d.kill[b]) return "KILL";
    const x = knobDb(d.eq[b]);
    return x <= -59.9 ? "−∞" : `${x >= 0 ? "+" : ""}${x.toFixed(0)}`;
  };
</script>

<section class="dj" data-role="dj">
  <DjDeck deck={0} />

  <div class="box mixer" data-title="mixer" data-title-right={sourceLabel}>
    <div class="strips">
      {#each [0, 1] as deck (deck)}
        <div class="strip" data-role="dj-strip-{deck}">
          <span class="side">{deck === 0 ? "A" : "B"}</span>
          {#each BANDS as b (b)}
            <div class="eq">
              <span class="lbl">{BAND_LABEL[b]}</span>
              <input
                type="range"
                min="-1"
                max="1"
                step="0.01"
                value={v.decks[deck].eq[b]}
                oninput={(e) => djAct((d) => d.setEq(deck, b, Number((e.target as HTMLInputElement).value)))}
                ondblclick={() => djAct((d) => d.setEq(deck, b, 0))}
                title="{BAND_LABEL[b]} EQ (double-click: flat){b === 'low' ? ` · ${deck === 0 ? 'left' : 'right'} stick ↑↓` : b === 'high' ? ` · ${deck === 0 ? 'left' : 'right'} stick ←→` : ''}"
                data-role="dj-eq-{deck}-{b}"
              />
              <button
                class="kill"
                class:on={v.decks[deck].kill[b]}
                onclick={screenOnly(() => djAct((d) => d.toggleKill(deck, b)))}
                title="Kill {BAND_LABEL[b]}{b === 'low' ? ` (${deck === 0 ? 'L3' : 'R3'})` : ''}"
                data-role="dj-kill-{deck}-{b}">{db(deck, b)}</button
              >
            </div>
          {/each}
          <div class="vol">
            <span class="lbl">VOL</span>
            <input
              class="vertical"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={v.decks[deck].vol}
              oninput={(e) => djAct((d) => d.setVol(deck, Number((e.target as HTMLInputElement).value)))}
              aria-label="Deck {deck === 0 ? 'A' : 'B'} volume"
              data-role="dj-vol-{deck}"
            />
          </div>
        </div>
      {/each}
    </div>
    <div class="xfade">
      <span class="lbl">A <small>L2</small></span>
      <input
        type="range"
        min="-1"
        max="1"
        step="0.01"
        value={v.xfade}
        oninput={(e) => djAct((d) => d.setXfade(Number((e.target as HTMLInputElement).value)))}
        ondblclick={() => djAct((d) => d.setXfade(0))}
        aria-label="Crossfader"
        title="Crossfader (double-click: middle). On the Deck: hold L2 / R2 to slide it."
        data-role="dj-xfade"
      />
      <span class="lbl"><small>R2</small> B</span>
    </div>
  </div>

  <DjDeck deck={1} />
</section>

<style>
  .dj {
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 236px minmax(0, 1fr);
    gap: 6px;
    min-height: 0;
    padding: 6px;
  }
  .mixer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }
  .strips {
    margin-top: 8px;
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    min-height: 0;
  }
  .strip {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: stretch;
    min-height: 0;
  }
  .side {
    text-align: center;
    font-weight: bold;
    color: var(--magenta);
  }
  .eq {
    display: grid;
    grid-template-columns: 28px 1fr;
    grid-template-rows: auto auto;
    align-items: center;
    gap: 2px 4px;
  }
  .eq .lbl {
    grid-row: span 2;
  }
  .eq input {
    width: 100%;
    accent-color: var(--green);
  }
  .kill {
    font-family: var(--font);
    font-size: 10px;
    min-height: 24px;
    border: 1px solid var(--box);
    background: var(--panel-lo);
    color: var(--ink-dim);
    cursor: pointer;
  }
  .kill.on {
    background: var(--danger);
    border-color: var(--danger);
    color: var(--on-accent);
  }
  .vol {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    min-height: 80px;
  }
  input.vertical {
    flex: 1 1 auto;
    writing-mode: vertical-lr;
    direction: rtl;
    width: 28px;
    min-height: 60px;
    accent-color: var(--green);
  }
  .xfade {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .xfade input {
    flex: 1 1 auto;
    accent-color: var(--amber);
    height: 28px;
  }
  .lbl {
    font-size: 10px;
    color: var(--ink-dim);
    letter-spacing: 1px;
  }
  .lbl small {
    font-size: 8px;
    opacity: 0.8;
  }
</style>
