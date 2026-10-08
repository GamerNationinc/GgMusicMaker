# GgMusicMaker — Master Reference

The single place that says **what this repo is, what is proven to work, where
everything lives, and where it is going.** Keep it current when features land.

_Last updated: 2026-09-26 (branch `morph-surround-themes`)._

---

## 1. Identity

| | |
|---|---|
| Product name | **GgMusicMaker** — a simple, playful DAW for the Steam Deck (desktop mode) |
| Package / crate / AppImage / desktop id | `ggmusicmaker` |
| Rust lib crate | `ggmusicmaker_lib` |
| Tauri bundle identifier | `com.gamernation.ggmusicmaker` |
| Exported mix filename | `ggmusicmaker-mix.wav` |
| Version | `0.1.0` (`package.json`, `Cargo.toml`, `tauri.conf.json` — keep in sync) |
| Stack | TypeScript + Svelte 5 + Vite 6 frontend · Web Audio API + Canvas · Tauri v2 (Rust) shell · WebKitGTK on Linux |
| Remote | `https://github.com/GamerNationinc/GgMusicMaker` (public) |

### Where it is on this machine (Steam Deck)

| Path | What |
|---|---|
| `~/GgMusicMaker/` | The repo (full git history) |
| `~/GgMusicMaker/src-tauri/target/release/bundle/appimage/GgMusicMaker_0.1.0_amd64.AppImage` | Last native build output (~88 MB) |
| `~/GgMusicMaker/src-tauri/target/release/bundle/deb/GgMusicMaker_0.1.0_amd64.deb` | .deb (not useful on SteamOS; for Debian/Ubuntu hosts) |
| `~/Applications/ggmusicmaker.AppImage` | **Installed** app (what the menu launches) |
| `~/.local/share/applications/ggmusicmaker.desktop` | Menu entry (Multimedia → GgMusicMaker) |
| `~/.local/share/icons/hicolor/{32,128,256,512}x…/apps/ggmusicmaker.png` | Installed icons |
| podman image `localhost/ggmusicmaker-build` (1.84 GB) | Ubuntu 22.04 build toolchain (glibc 2.35 + WebKitGTK dev + Node 20 + Rust) |
| podman volume `ggmm-cargo-registry` | Cached crates so rebuilds take ~1 min instead of ~4 |

---

## 2. What works (verified)

Everything below has been run, not just read. "Browser" = headless Chromium
against the production build (`npm run test:browser`); "Native" = the AppImage
launched on this Steam Deck under KDE/Wayland.

### Core DAW

| Feature | Verified how |
|---|---|
| Import any audio the WebView decodes (WAV/MP3/OGG/FLAC) onto its own layer | Browser test `imports and layers a file` |
| Non-destructive **split / trim / move / delete** on the timeline | 16 unit tests in `src/audio/edits.test.ts` (pure math) |
| **Record** from mic onto an armed layer, via AudioWorklet (falls back to ScriptProcessor on old WebKit and says so in the status bar) | Browser test records 1.8 s and confirms the worklet path was used |
| Per-layer **volume, mute, solo, reverb send** | Unit-tested param mapping; exercised in browser |
| **FX rack** per layer: 3-band EQ, Voice Synth (see 2026-09-14 below), Room / Hall / Plate reverb | Browser test: Chipmunk preset changes the exported render (~200 KB of samples differ) |
| Shared convolution **reverb** bus with synthesised IRs | Part of the graph exercised above |
| **Master limiter** + 12-segment LED level meter | Native: LED meter lights during playback |
| **Export** mix to WAV, rendered offline through the same FX graph (Tauri save dialog, or browser download) | Browser test `exports a WAV` (valid RIFF, >44 bytes); WAV encoder unit-tested |
| Keyboard: `Space` play/pause · `S` split · `R` record · `Delete` delete clip · `Ctrl+D` duplicate layer | In `App.svelte`; used by browser test for undo shortcuts |

### Added 2026-09-13

| Feature | Verified how |
|---|---|
| **Undo / Redo** — toolbar buttons + `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`. Covers import, layers, split/delete/move/trim, takes, mixer + FX changes. Fader drags coalesce into one step. Arming is deliberately not undoable. Restoring while playing reschedules audio; restoring a deleted layer recreates its audio channel. | 7 unit tests (`history.test.ts`: order, branch discard, coalescing, window, cap); 6 browser checks (button + keyboard) |
| **Analogue master meter** (bottom-left): VU-style needle with ballistics, peak-hold tick, **PEAK** lamp (amber = limiter working, red = over full scale), 20-band spectrum strip. Reads the mix **before** the limiter — the post-limiter meter can never show a peak. | 9 unit tests (`spectrum.test.ts`); browser check that the lamp lights on a hot signal (3 consecutive runs); visible in native app |

### Added 2026-09-14

| Feature | Verified how |
|---|---|
| **Load meter + low-power mode** — header readout like Ableton's: `CPU nn%` (UI-thread utilisation: per-frame busy time from the top of the rAF tick until a zero-delay timer runs, EMA-smoothed, published at 4 Hz), a **D** lamp when the audio clock advanced <97 % of wall time during playback/recording (= the audio thread starved), and an **ECO** toggle (persisted in `localStorage`) that unmounts the Matrix rain and caps meters at 20 fps. Independently, the meter loop now idles: after 2.5 s with nothing playing/recording/sounding it drops to 8 Hz and, once the VU has decayed to silence, stops pushing values (each push repaints the ASCII VU + LED strip). The rain also pauses while the document is hidden. | 7 unit tests (`load.test.ts`); 6 browser checks (readout, no false dropout, ECO on/off/remembered). Measured in headless Chromium, idle after a 4 s playback: main-thread busy **10.7 % → 3.4 %** (→ 1.3 % with ECO) |
| **Sessions** — New / Open / Save / Save As (toolbar + `Ctrl+N/O/S/Shift+S`). One self-contained `.ggmm` file: `GGMM` magic, JSON header (project, reverb space, zoom, playhead), then one embedded 16-bit WAV per *referenced* buffer (orphans are dropped, armed flags are cleared). Loading decodes the WAVs itself (`decodeWav`) and registers PCM straight into the engine — no dependency on the WebView's media decoders. Ids from a loaded file are reserved so new ids never collide. Header shows `name*` while dirty; New/Open ask before discarding; the browser gets a `beforeunload` prompt and Tauri intercepts the window close (`core:window:allow-close/destroy`, `dialog:allow-ask`). | 9 unit tests (`session.test.ts`: round-trip, orphan GC, arm clearing, bad/truncated/newer files, id reservation) + 3 `decodeWav` tests; 7 browser checks including *save → New → reopen → export renders the same mix* (max sample delta 0.0002) |

| **Voice Synth** (replaces the v2 voice presets) — one AudioWorklet (`public/voice-synth-processor.js`), all time-domain. Five engines run *in parallel*, each with a level: Shift (dual-delay pitch shifter + 20-band formant re-weight), Vocoder (saw chord carrier), Talkbox (buzz carrier + drive), Compuvox (pulse carrier + sample-hold/bit crush), Polyvox (chord harmoniser). Stack: up to 8 detuned unison voices with staggered grain phases, sub and shimmer octave layers. Modulation (block-rate): vibrato LFO, seeded random drift per voice, glide, formant LFO, and a dynamics follower routed to pitch / formant / width. Space: each layer has a home azimuth; `width` scales it, `rear` extends the ring behind the listener, `orbit` rotates the field; ensemble chorus per output channel; ring mod. The formant re-weight runs on the mono input *before* shifting (a pre-shift of F then a pitch shift of P lands where a post-shift F would), so one filterbank serves every layer. 31 k-rate AudioParams; seeded PRNG so renders are reproducible. When the host hands over an empty input (upstream nodes went quiet) the worklet keeps rendering on zeros so tails ring out, and after 0.6 s of silence it resets and idles at zero cost — this made export bit-for-bit repeatable (before, Chromium's tail-time cut landed at a different block on some runs). Presets: Off, Chipmunk, Deep, Robot, Alien, Choir, Daft, Speak & Spell, Cathedral, Orbit, Swarm. Old sessions' `voice` presets migrate to equivalent synth settings. | 41 unit tests run the worklet source in Node (`voice-synth.test.ts`): bit-exact bypass, every engine bounded/non-silent, stack thickens, each modulator changes the sound, glide slews a pitch jump, determinism, empty-input tail == zero-input tail then idle, width/orbit/fold-down, 5.1/7.1 placement, LFE is low-passed, centre send. Browser: Chipmunk changes the render; Choir + 5.1/7.1 export. CPU (Node, this Deck): Chipmunk 2 %, Choir 6–8 %, everything maxed at 7.1 17 % of one core per layer |
| **Surround output** — `Project.surround` = stereo / 5.1 / 7.1 (Voice Synth → SPACE → OUTPUT; undoable; saved in the session). `MasterBus` (`src/audio/master.ts`) is `gain → limiter → meters → destination` at 2/6/8 channels, pinned explicit+discrete so nothing re-mixes the synth's field; a wide bus gets one limiter per channel (DynamicsCompressor is stereo at most). Live: the bus follows the layout when `destination.maxChannelCount` allows, else stays stereo and the synth folds its field down (status bar says so). Export: always renders the full layout; `encodeWav` writes `WAVE_FORMAT_EXTENSIBLE` with the SMPTE speaker mask for >2 channels (`decodeWav` reads it back). Filename gets a `-5.1`/`-7.1` suffix. | Unit: extensible header + mask + round trip for 6/8 ch. Browser: 5.1 and 7.1 exports are 6/8-channel extensible WAVs; Choir lands on C and the surrounds while LFE sits ≥10 dB under C (this check caught a real bug: the worklet's bypass path copied L into every surround channel). A Chromium probe confirmed the split/limit/merge bus keeps channels discrete |

### Added 2026-09-15

| Feature | Verified how |
|---|---|
| **Duplicate layer** — ⧉ on the track head, or `Ctrl+D` for the layer whose FX rack is open (else the selected clip's layer). The copy lands directly under the original with its clips (sharing the audio buffers — nothing re-decoded), gain/mute/solo/send, EQ, Voice Synth settings and colour; never armed; named "X copy" / "X copy 2"…; one undo step; audible immediately if playing. Pure pieces in `edits.ts`: `cloneTrack`, `copyName`, `insertTrackAfter`. | 3 unit tests (deep copy + fresh ids + shared buffers + not armed; collision-free names; insertion position); 5 browser checks (position + name, status, the copy renders — louder and ~210 KB different, the copy's rack shows the same preset, Ctrl+Z removes it) |

| **Pan + width on every effect** — a `placer-processor` worklet (`public/placer-processor.js`) sits after each layer's chain (LAYER module: PAN / WIDTH) and on the reverb send (REVERB: PAN / WIDTH), and the Voice Synth gained PAN (rotates its field; stacks with orbit). Stereo: mid/side width (0 mono · 1 as is · 2 exaggerated) then constant-power balance (unity at centre, +3 dB at the extremes). 5.1/7.1: every speaker feed is a virtual source at its speaker's azimuth, scaled by width and rotated by pan (±1 = ±180°), VBAP-re-panned — so pan 0 / width 1 is an exact identity on any bus; LFE passes through. Memoryless: no tail, bit-exact bypass. Fields `pan`/`width`/`reverbPan`/`reverbWidth` on `Track`, coalesced undo, session format v3 (v1/v2 files migrate to centred/natural). EQ deliberately has no knobs: it is inline tone-shaping, so a pan there would just be the layer pan under another name. | 9 unit tests run the placer DSP in Node (identity, mono fold, side doubling, hard pan, 5.1/7.1 identity, width-0 fold onto C, 180° rotation lands on the surrounds with constant power) + a synth pan test; browser: hard-left layer exports with R = 0, undo restores L = R |

| **FX chain rack** (replaces the row of modules) — the rack is a chain strip `LAYER ▸ EQ ▸ VOICE SYNTH ▸ REVERB` plus one full-width editor for the picked slot. Each slot has a **power switch** (real per-module bypass: `Track.fx.{place,eq,synth,reverb}`; settings are kept, the graph never changes shape — the module is pushed to its neutral values), a **lamp** that lights only when the module is on *and* doing something, and a one-line **summary** (`Choir · 70%`, `+4 / 0 / -3.5 dB`, `hall · 30%`, `L 40 · 120%`). The track head's FX chip lights when any module is engaged. Voice Synth presets moved from a wall of 11 buttons to a hardware-style screen (`◀ CHOIR / Stacks ▶`, shows `custom · edited` once touched) with a **BROWSE** popover grouped by category (Classic / Stacks / Synth / Space; Esc closes). Pure summary/lamp logic in `src/fx/chain.ts`. Session format v4 (v1–v3 files open with every module on). | 5 unit tests (`chain.test.ts`: neutral layer, summaries, lamp needs on+engaged, readouts, normalize); browser: rack opens on the synth slot, browser pick closes and updates the screen, strip summary, head chip lit, bypassing the synth renders **bit-identical to dry** and keeps the summary, the duplicate's rack shows the same preset; 49/49 ×2. One CSS class collision found by measuring (`.eq` editor height leaking onto the `.slot.eq` strip cell) |

| **Native playback measured and fixed** — first time the app was played on the Deck itself (session opened through the Tauri dialog, 3 layers, Choir + Chipmunk on two of them). It was "super laggy": `perf` on the WebKitWebProcess main thread showed 98 % in one pixel loop inside libwebkit2gtk (Skia software raster). Cause: `lib.rs` had forced `WEBKIT_DISABLE_DMABUF_RENDERER=1` since v1 as a precaution; on WebKitGTK 2.50 that path re-rasterises and copies the whole window every animation frame. Removed. Also: a layer with nothing engaged now bypasses its three worklet nodes entirely (`TrackChannel.route`), and an explicit stereo stage keeps mono layers L = R on the bus without the worklets. | Native, rebuilt AppImage, `top -H` on the WebKit process while playing: main thread **98 % → 12–15 %** (app's own CPU readout 14 %), audio thread 30 % with the FX session, 20 % dry (was 25–29 %); window renders with the GPU renderer. The synth DSP itself was cleared first: `jsc` from the same WebKitGTK 2.50.4 runs it as fast as V8 (Chipmunk 3 %, Choir 5 % per layer). Browser suite 49/49 ×2 |

### Added 2026-09-26

| Feature | Verified how |
|---|---|
| **MORPH** — a new FX slot between EQ and the Voice Synth (`LAYER ▸ EQ ▸ MORPH ▸ VOICE SYNTH ▸ REVERB`), one worklet (`public/morph-processor.js`) hosting eight unrelated engines, each with its own four macro knobs: FM VOX (voice-as-modulator phase modulation), GRAIN CLOUD (2 s granular, grains sprayed round the ring), STRINGS (Karplus-Strong chord), VOWEL (3-formant A-E-I-O-U tract), FOLD (sine wavefolder + Chebyshev T_n), CHAOS (Lorenz attractor → SVF + flight path), SPECTRAL (phase-vocoder STFT: freeze / smear / bin-shift / robot / whisper, 4 bands placed apart), HARMONIC (resonators on the harmonic series of A440 / A432 / 528 / Schumann×16 / φ partials, binaural beat, ear-soft 2–5 kHz dip). 19 presets. Every engine's voices are VBAP-placed with SPREAD, PATH (static, circle, pendulum, fly-over, figure-8, swarm, Lorenz), MOTION and DIFFUSE. Picking an engine loads its first preset. Sessions: v4 files open with MORPH off. | 32 unit tests run the worklet in Node (`src/fx/morph.test.ts`): every preset finite, ≤ 0 dBFS, within −10..+6 dB of the input; all 8 engines differ pairwise; 7.1 reaches Ls/Rs/Lb/Rb and never LFE; deterministic. Browser: Grain Halo alone in a 7.1 export puts −25..−29 dB on every back/side channel, LFE silent |
| **Voice Synth surround** — ORBIT PATH (pendulum = old behaviour, circle, fly-over, figure-8, swarm), DIFFUSE (per-speaker all-pass decorrelation, LFE excluded), five **Immersive** presets (Halo 360, Fly-Over, Vortex, Crossfire, Hive). The synth now analyses and passes through surround channels arriving from MORPH. | Unit: each path renders differently; diffuse drops L/R correlation from > 0.99 to < 0.7 at similar level; upstream channel 5 passes at (1 − mix) |
| **3D headphone monitor** — on a device with fewer channels than the layout (the Deck), the live bus stays 6/8 channels and ends in `public/binaural-processor.js` (Woodworth ITD, head-shadow ILD, rear pinna darkening, LFE to both ears) instead of the flat fold-down. On by default, `🎧 3D` toggle in Voice Synth → SPACE → OUTPUT, remembered in `localStorage` (`ggmm.headphones3d`). Export is unaffected. | Unit (`src/audio/binaural.test.ts`): side speakers land in their ear, centre stays centred, rear is darker than front. **Not yet heard on the Deck.** |
| **Colour themes + btop HUD** — MATRIX, RED, RED/BLACK, CYBERPUNK (neon haze overlay), AMBER, BTOP; header `◐` button or `T` cycles, remembered (`ggmm.theme`). Themes remap the existing CSS variables, so every component follows; canvases (rain, lanes, VU, LED meter) read the tokens; track colours map through a per-theme lane palette. Panels are btop-style boxes with the title in the border. | `src/ui/themes.test.ts` (34 tests): every theme ink ≥ 7:1 and dim ink ≥ 4.5:1 on every panel shade, accents ≥ 4.5:1, clip colours ≥ 3:1. Browser: theme cycles + persists. Screenshots of all six reviewed |

### Added 2026-09-26 (second pass)

| Feature | Verified how |
|---|---|
| **Waveforms for any number of layers / any song length** — bug: the lanes were one canvas as big as song × layers; past WebKit's canvas-size limit (~10 layers of a few minutes) it silently drew nothing. The lane and ruler canvases now cover only the visible viewport (redrawn on scroll/resize); `.lanes` keeps the full size for the scrollbars. Waveform comes from a 128-sample min/max/Σx² summary per buffer (`render/peaks.ts: summarize/columnStats`), raw samples when zoomed past a bucket per pixel. Ableton-style drawing: peak envelope at half strength, RMS body solid, display gain so the file's loudest peak fills the lane, silence as a flat line (dead space stands out). Zoom is multiplicative 2–4000 px/s (single samples) with **FIT**; ruler labels adapt (ms → m:ss). | Browser: 12 × 150 s layers — 12th lane inked 100 % mid-song and at the very end, canvas stays ≤ screen width, silent intro draws empty, FIT shows the whole song. Unit (`peaks.test.ts`): 10-minute buffer summarised end to end |
| **PUNCH** — drums + bass enhancer (Neutron-style) slot after EQ: LR4 crossover (40–250 Hz), mono low band with KICK PUNCH (transient shaper), BOOM (+12 dB), SUB (octave-down flip-flop), DRIVE (tanh), SNAP (transients above the crossover), BLOWOUT (tanh wall), OUTPUT dB, CEILING safe / let it clip. 10 presets (Tight Kick … Speaker Killer). DSP in `public/punch-core.js`, shared by `punch-processor.js` and the **lane preview**: with PUNCH on, the clip shows the processed waveform against dashed 0 dBFS guides, bass after (solid) vs before (ticks), and red where samples go over; the editor shows peak dBFS, clipped-sample count and bass gain. Preview runs in 5 ms slices on the main thread (gain + PUNCH only; EQ is not included). | Unit (`punch.test.ts`): worklet output == preview core output; BOOM/SUB raise bass; PUNCH raises attack more than tail; SAFE never exceeds 0 dBFS, Speaker Killer unsafe does; sliced preview == one pass. Browser: Blown Out readout shows +dBFS and bass +dB, red marks drawn in the lane, export changes |

### Fixed 2026-09-26 (third pass) — blank layers on the Deck

| Fix | Verified how |
|---|---|
| Layers below the first screenful stayed blank **in WebKit only** (the Deck's engine): `.lanes-scroll` is a flex item *and* a scroll container with `overflow-y: hidden`; WebKit stretched it to the body's visible height, clipping every lane below. Chromium sizes it to the content, so the Chromium suite never saw it. Fix: `align-self: flex-start`. | New `npm run test:webkit` (`tests/webkit-lanes.mjs` in Playwright WebKit inside the Ubuntu build image): 14 × 200 s songs, layers 11/13/14 draw after scrolling and at the song's end. Fails 4/6 ("clipped by the lanes box") with the fix removed, passes 6/6 with it |

### Added 2026-09-26 — layer stacks + instrument racks

| Feature | Verified how |
|---|---|
| **Layer stacks** (`audio/stacks.ts`): ⊞ on a head (or ＋ STACK LAYER) adds a *linked* layer of the same audio under it. Linked members share clip edits — split / move / trim / delete on any layer mirrors to all (clips matched by `linkId`, run in `updateProject` via `syncStacks`), while each keeps its own FX chain. 🔗 unlinks / relinks. ⧉ still makes an independent copy. | Unit (`stacks.test.ts`, 7): move/split/delete mirror, ids kept, unlinked members untouched, delete that rebuilds every list still wins. Browser: deleting the clip on layer 3 of a 5-layer stack removes it on all five; undo restores all |
| **Instrument racks** (`fx/racks.ts`): 41 racks in VOCALS / DRUMS / PERCUSSION / BASS / SYNTH / KEYS & GUITAR / AMBIENT, each a whole-layer setting (EQ incl. new LOW/HIGH CUT, PUNCH, MORPH, VOICE SYNTH, send, pan, width, level). 14 **stack recipes** build a full stack in one undo step (Wall of Vox, Big Room Kit, Stack Bass, Huge Lead…). FX panel opens on RACKS & STACK; ⛓ FX CHAIN is the per-module editor (view remembered). | Unit (`racks.test.ts`, 6): every category covered, every preset reference resolves, racks reset then dial in, values in range. Browser: Wall of Vox → 5 named layers, render differs from the single layer |
| **EQ low/high cut** (12 dB/oct HP/LP before the shelves) — the tool for splitting bands across stacked layers (Sub Boom = LP 150, Crack = HP 1.5k). Sessions v7: cuts off, layers standalone. | Session migration test |

### Changed 2026-09-26 — desktop shell is now Electron (own Chromium), not WebKitGTK

| Change | Verified how |
|---|---|
| `electron/main.cjs` + `preload.cjs`: the app ships its own Chromium (Electron 44 / Chromium 152) instead of the system WebKitGTK the Tauri shell used (the source of the Deck-only bugs). dist/ is served from a private secure `app://ggmm` origin; the page gets native dialogs / disk / quit guard only through `window.ggmmNative` (contextIsolation, sandbox, no Node). `src/state/platform.ts` is its client. Audio goes Chromium → PulseAudio API → PipeWire. | `npm run test:app` (`tests/electron-app.mjs`) drives the real app via Playwright's Electron driver: own Chromium, app:// origin, 12 × 120 s imports with the 12th lane drawn, Wall of Vox stack, all 5 FX worklets construct, WAV export through the native save path (23.6 MB). 7/7 on the dev tree, on `release/linux-unpacked/ggmusicmaker` **and** on the installed `~/Applications/ggmusicmaker.AppImage`. Launched visibly on the Deck: window up, `application.name = "ggmusicmaker"` in PipeWire |
| Packaging: `npm run dist:deck` (electron-builder) → `release/linux-unpacked/` (the **Steam depot** folder) + `release/GgMusicMaker-<v>-x86_64.AppImage`; `scripts/install-steamdeck.sh` now installs the latter. `steam/` holds SteamPipe `app_build.vdf` / `depot_build_linux.vdf` templates and the owner-only steps (Steam Direct, App ID, steamcmd upload). | Built on the Deck directly (no container needed) |
| Test-only env: `GGMM_HIDDEN` (no window), `GGMM_TEST_SAVE_DIR` (saves skip the dialog), `GGMM_NO_CLOSE_GUARD`. Electron's `--ozone-platform=headless` segfaults on SteamOS, so tests use a hidden X11 window. | — |

`src-tauri/` and the Tauri container build are now **legacy** (kept until the Electron path has had real use; CI workflows still build Tauri). Next phase: a native Rust audio engine (napi addon in the Electron main process) behind `AudioBackend`.

### Added 2026-09-26 — native audio engine (Rust), beta

| Feature | Verified how |
|---|---|
| `native/` — Rust crate (`ggmm-engine`, Node-API addon via napi-rs, cpal → ALSA → PipeWire). Mixer runs on the device's real-time callback thread: clips (linear-interp resampling), layer level/mute/solo, EQ (Web Audio-spec biquads incl. cuts), PUNCH (line-by-line port of `punch-core.js`), pan/width (placer math), master level + peak limiter + meters. Commands arrive over a lock-free channel; replaced projects/buffers/DSP state are freed off the audio thread. Built by `scripts/build-native.sh` in the Ubuntu 22.04 image (now with `libasound2-dev`) → `native/ggmm-engine.node` (asar-unpacked in the package). | `src/audio/native-engine.test.ts` (10, skipped if unbuilt): plain layer bit-accurate below the limiter; PUNCH Tight Kick / 808 Boom / Snap Drums / Lo-Fi Crush / Blown Out match the JS core to < 2e-4; mute, hard-left pan, low cut, limiter, 44.1→48 kHz resampling. Host: device opened, clock advanced 0.96 s in 1 s |
| `electron/engine.cjs` hosts it in the main process (IPC); `src/audio/native.ts` `NativeBackend` sends the project + PCM, drives transport, reads playhead/meters (polled at 60 Hz, extrapolated per frame); decoding, recording (native since 2026-09-27, see below), export and spectrum stay on the wrapped web engine, which falls back to playing if the device won't open. Header **ENGINE: WEB / NATIVE β** (restarts the window; default WEB). Header names modules the native engine skips (VOICE SYNTH, MORPH, REVERB, SURROUND). | `npm run test:app` now 14/14 on dev tree, packaged folder and installed AppImage: engine opens the device, native playhead reaches 1.5 s, native meters see signal, UI playhead follows, header names MORPH as not-native |

**Not yet native** (next): VOICE SYNTH, MORPH, reverb, surround/binaural, spectrum meter, recording, export (export still renders on the web engine — and its limiter is Chromium's compressor, so a hot native mix and its export can differ slightly at the top). Default stays WEB until those land and it has been listened to on the Deck.

### 2026-09-27 — every effect ported to Rust; NATIVE is the default engine

| Change | Verified how |
|---|---|
| Rust ports of every worklet: `native/src/synth.rs` (VOICE SYNTH), `morph.rs` (all 8 engines incl. the phase-vocoder FFT), `placer.rs`, `binaural.rs`, `reverb.rs` (the same IRs — `reverb.ts` now seeds its noise, so every render is identical — normalised like ConvolverNode, 3-stage partitioned real-FFT convolver 128/1024/8192, silence costs nothing, 128-sample wet latency). State that JS keeps in Float32Arrays is stored as f32 in Rust, and AudioParam values are rounded to f32 (`quantize()`), so the ports track the worklets sample for sample. | `src/audio/native-parity.test.ts` (76): every VOICE SYNTH and MORPH preset in stereo and 7.1 within 0.1 % RMS of the worklet (chaotic Lorenz/FM-feedback presets: first 50 ms tight + level), placer + binaural < 1e-5, reverb impulse response = web IR × spec normalisation < 1e-5 |
| `mixer.rs` now renders the whole graph in 128-frame quanta (clips → level → cuts → EQ → PUNCH → MORPH → SYNTH → placer; sends → reverb; 2/6/8-ch bus; binaural when wider than the device) into a DynamicsCompressor twin (−3 dB, ratio 20, 2/100 ms, **6 ms look-ahead**, spec makeup gain ≈ +1.7 dB). Device opened at 48 kHz f32 when offered. Export renders natively (async task). Spectrum meter from the engine's scope (AnalyserNode emulation). | Desktop app: the same 5-layer Wall of Vox exported natively vs on the web engine → **0.33 dB, r = 0.993**. Bench (5 layers, 10 s): plain 0.08 s, reverb 0.14 s, VOICE SYNTH 0.24 s, spectral MORPH 0.83 s |
| NATIVE is the default in the desktop app (WEB still selectable; automatic fallback to WEB if the device won't open). | `npm run test:app` 18/18 |
| CI (`ci.yml`) builds + tests the engine, runs parity, Chromium, WebKit and the Electron app under xvfb with ALSA's null device; `release.yml` packages with electron-builder and publishes AppImage + Steam depot tarball. | First runs: all green except the session-reopen render check — sessions stored audio as 16-bit PCM, which rounds and clips the recorded take (the runner's 44.1 kHz fake mic crossed the threshold). Sessions now embed **32-bit float** WAV (lossless; old 16-bit sessions still open): reopen is bit-identical (max delta 0.0000) in the CI container and on the Deck |

### 2026-09-27 — autosave, crash recovery, crash log

Trigger: the page (renderer) died mid-session; the window then froze on close because the quit guard waited forever for an answer from a page that no longer existed, and nothing had been saved.

| Change | Verified how |
|---|---|
| **Autosave** (`src/state/autosave.ts` + `electron/autosave.cjs`): while there are unsaved changes, every 60 s (skipped while recording, and when only the playhead moved) the project goes to `~/.config/ggmusicmaker/autosave/`. Each buffer's WAV is sent once (audio never changes), later autosaves are just the project JSON. Keys carry a per-launch prefix (buffer ids restart every launch). All writes are temp-file + rename. Cleared after a real save, New, Open, or "Quit anyway". | `src/state/autosave.test.ts` (7): round-trip opens bit-identical, audio sent once, playhead-only skip, unused audio pruned + re-sent after undo, clear beats an in-flight save, two launches never share keys |
| **Crash recovery**: on launch, a leftover autosave → "didn't close properly — recover?" → loads it as unsaved (`*`), then autosaves it again at once so a second crash can't lose it. If the page dies while running, main logs it and offers **Reopen / Quit**; Reopen reloads the page, which then offers the autosave. | `npm run test:recovery` (`tests/electron-recovery.mjs`) 14/14 on the dev tree and the packaged app: renderer SIGKILLed → logged → reopened → layer back and dirty; app relaunch → recovered; Ctrl+S → autosave gone |
| **Close can't hang any more**: the page acks `close-requested` at once; no ack in 3 s → "isn't responding — Quit / Wait". A crashed page closes straight away (autosave kept for next launch). | Same test: page stuck in an infinite loop, window close → app exits, `close-unanswered` logged |
| **Crash log** (`electron/crashlog.cjs`): `~/.config/ggmusicmaker/logs/crash.log` (JSON lines, rotates at 1 MB): page gone (reason + exit code), page unresponsive, other Chromium processes gone (GPU/audio service), main-process exceptions, uncaught page errors (first 20 per run). Chromium minidumps kept locally in `Crashpad/` (never uploaded). | Same test: `page-gone`, `close-unanswered`, `page-error` entries |
| Sessions saved over an existing file are now written atomically (temp + rename) — a crash mid-save can't wreck the old file. | — |
| Test hooks: `GGMM_USER_DATA` (isolated config dir), `GGMM_AUTOSAVE_MS`, `GGMM_TEST_DIALOG=<button>` (answers every dialog). `test:app` now uses an isolated config dir too. | `npm run test:app` 18/18, `npm run test:browser` 72/72 |

Browser build (`npm run dev`) has no autosave — desktop app only.

### 2026-09-27 — native recording, latency calibration

| Change | Verified how |
|---|---|
| **Recording goes through the native engine** when it is active (`native/src/record.rs`): a cpal input stream (default input, or `GGMM_INPUT_DEVICE`) beside the output, f32 at the output's rate, samples → lock-free SPSC ring (`rtrb`) → drain thread, so the capture callback never allocates or blocks. IPC `engine-rec-start` / `engine-rec-stop` → `NativeBackend`. If the input won't open, recording falls back to the web path and the status line says why. | Rust unit tests (6); `npm run test:record` fallback check |
| **Takes are placed from the device clocks, not the playhead.** Output callbacks publish the song time of each buffer and the wall time it will be *heard* (callback + reported output latency + the compressor's 6 ms look-ahead) on one process clock; the first input callback that sees playback running maps its capture time (callback − reported input latency) to the song time heard then. Take start = that song time − frames already captured (pre-roll kept, trimmed at 0 s). Transport stopped for the whole take → placed at the playhead as before. (The web path still uses the playhead at *stop*, which is wrong if you play while recording — unchanged here.) | `record.rs` tests: extrapolation, stale/stopped marks, end-to-end latency cancellation, pre-roll trim |
| **Latency calibration** (header **⏱ CAL** → **⏱ 37ms**): cpal reads latency from `snd_pcm_status` delay, which the PipeWire and PulseAudio ALSA plugins leave at **0**, yet the real round trip on the Deck is **37.3 ms — identical to the sample on every run**. So it is measured: the engine plays an uneven click pattern, records it, finds the offset (`src/audio/record-align.ts`, sparse cross-correlation), stores it per output→input device pair (localStorage `ggmm.recordLatency`) and shifts every native take earlier by it. Status line says `native capture, 37.4 ms latency compensated` (or `latency not calibrated`). | `npm run test:record` (`tests/electron-record.mjs`) 13/13: a private null sink loops the app's output into its input (PipeWire: `PIPEWIRE_NODE` + `stream.capture.sink`; PulseAudio/CI: `PULSE_SINK`/`PULSE_SOURCE`; system defaults untouched) → calibrate 37.4 ms → overdub while a click track plays → save → the take, parsed from the `.ggmm`, lines up with the clicks **0.00 ms off** |
| `GGMM_AUDIO_DEVICE` / `GGMM_INPUT_DEVICE`: open a cpal device by name (tests; device picking later). | Used by the test |
| Header no longer overlaps: the theme button used to sit on top of the ENGINE switch at 1280 px (the NATIVE button was unclickable under it); the ENGINE label is gone, gaps tightened, everything fits at 1280×800. | Screenshot at 1280×800; `test:record` clicks the ⏱ button |

**Not verified:** calibration through the Deck's real speaker → internal mic (it would make noise; the code path is the same as the loopback, but acoustic confidence/threshold 0.25 is untested). Hardware converter latency and USB/Bluetooth interfaces are only covered by calibrating with that setup. Packaged AppImage not built on this branch (release.yml runs `test:record` on it).

### 2026-09-27 — exclusive solo, effects you can see at a glance

| Change | Verified how |
|---|---|
| **Solo is exclusive**: soloing a layer un-solos the others. Ctrl/Shift-click adds to the solos; a plain click on one of several makes it the only one; clicking the only solo turns solo off. (`soloTracks` in `audio/edits.ts`.) | 5 unit tests; browser test drives all four cases on real track heads |
| **Track heads show the effects**: the FX chip carries a count ("FX 3"); a badge row PAN · EQ · PUNCH · MORPH · SYNTH · VERB shows each module **filled** when active, **struck through** when bypassed, faint when neutral; clicking a badge opens the rack on that module. The layer whose rack is open is highlighted. | browser test: count = number of lit badges, SYNTH badge lit after Chipmunk, head highlighted |
| **FX rack**: the chain strip is pinned above both tabs (racks and chain), active modules filled with an ON tag, bypassed dashed; the title says "N of 6 active". | browser test + screenshots at 1280×800 |

### 2026-09-27 — stem separation (HTDemucs, on-device)

Split a finished song into **vocals, drums, bass, guitar, piano, other** with a real source-separation network — HTDemucs (Demucs v4, Meta AI, MIT) 6-stem — not EQ.

| Change | Verified how |
|---|---|
| `native/stems` (Rust crate, binary `ggmm-separate`): the network core in **ONNX Runtime** (static, via the `ort` crate); the STFT, iSTFT and the 7.8 s segment overlap-add are done in Rust, mirroring `demucs/htdemucs.py` + `demucs/apply.py`. Residual folded into "other" so the stems sum back to the original. | `cargo test` (8): STFT vs direct DFT, reflect padding, segment weights/offsets/padding, residual folding. Opt-in parity vs PyTorch (`scripts/export-demucs.sh --reference`): STFT/iSTFT within 3e-7, **stems within ~90 dB of PyTorch Demucs** (identical) |
| Runs as **its own process**: ONNX Runtime inside Electron crashed Electron's allocator (SIGTRAP in PartitionAlloc — plain Node was fine), and a separator crash/OOM must never take the session down. `electron/stems.cjs` spawns it at lower CPU priority, work files in `~/.config/ggmusicmaker/stems-work` (not the RAM-backed /tmp), cancel = close its stdin. | `npm run test:stems` 13/13 on the dev tree: real song → Drums + Other layers, silent stems skipped, original muted, one undo restores; **stems mix = original mix, r = 0.9995, −0.03 dB**; Cancel stops the process and deletes its files |
| **⋔ STEMS** (toolbar): the selected clip (or the selected/only layer's first clip) is resampled to 44.1 kHz, separated, and each audible stem (> −40 dB vs the mix) lands on a new layer "Song · Vocals" etc. under the original, which is muted. Progress dialog with ETA and Cancel. Desktop app only. | screenshots; status line names found / skipped stems |
| Quality on a real multitrack song (60 s, true stems known, `scripts/demucs/eval_*.py`), SDR: **drums 17.0, vocals 13.4, bass 10.7**, guitar 2.0, other 0.6 dB (the mix itself scores 0.1–2.8). Guitar/other are the model's known weak spots. | Rust engine on the Deck |
| Speed on the Deck: ~0.6× real time (20 s in 12 s; a 4-minute song ≈ 2.5 min). | same |
| Model: not in git (114 MB > GitHub's 100 MB). `scripts/fetch-model.sh` downloads the `models-v1` release asset (sha256-checked); `scripts/export-demucs.sh` rebuilds it from Meta's weights in a PyTorch container. Packaged via asarUnpack with the binary. | fetch verified byte-identical |

### 2026-09-27 — big sessions: nothing large goes over IPC in one piece

Trigger: the app crashed at every startup. The user had imported a 24-stem song (27 layers, 1.1 GB of audio, unsaved); recovering its autosave sent all of it to the page in **one IPC message**, and Chromium kills the process (a CHECK → SIGTRAP, no crash-log line) when one message is past a few hundred MB. Save, open, native export, stems and long native takes had the same flaw.

| Change | Verified how |
|---|---|
| `electron/transfer.cjs` + the preload: everything big moves in **32 MB chunks** — page→main uploads are staged on disk (so a save is a move into place, atomic), main→page downloads are read chunk by chunk. `/tmp` is avoided (RAM on the Deck). | the user's real 1.1 GB session (copy of their config): recovered 27 layers in 12 s, saved (1.1 GB) in 30 s, reopened in 13 s, native export OK — no crash |
| Sessions are saved as parts (`packSessionParts`) — never assembled into one buffer; autosave recovery reads one WAV at a time (`recoverAutosave`) and shows progress. | unit tests (autosave reads per WAV, progress) |
| Native export renders from the buffers the engine already holds (`NativeEngine.renderLoaded`) instead of re-sending every layer's audio. | `test:app` export parity unchanged |
| Long native takes and stems come back in chunks; stem input goes up in chunks. | `test:record`, `test:stems` |
| `tests/electron-big.mjs` (`npm run test:big`): 1.24 GB session (the old code survived 550 MB, died at 1.1 GB) — autosave, app SIGKILLed, relaunch recovers, save, reopen, export, app alive. In CI and release. | 6/6 on the fix |

### 2026-09-28 — input device picker

Recording always used "default" (or the `GGMM_INPUT_DEVICE` test env var); there was no way to pick a mic from the app, e.g. after plugging in a USB or Bluetooth headset.

| Change | Verified how |
|---|---|
| A 🎤 dropdown in the toolbar, next to Record. Native: lists cpal input device names (`native/src/record.rs: list_input_devices`, default listed first), `rec_start(device)` opens the chosen one (falls back to `GGMM_INPUT_DEVICE`, then default, if none is passed — test hook unchanged). Web: lists `navigator.mediaDevices` audio inputs; labels are blank until the mic permission is granted, so opening the picker (a user gesture) unlocks them via a throwaway `getUserMedia` probe — the automatic startup listing never prompts. The choice is remembered (`localStorage`, per browser/engine id-space) and also picked up by latency calibration, since it opens the same device. | Rust: `cargo test` unaffected (6/6). `test:app`: 18/18 (one pre-existing timing flake on a rerun, unrelated). `test:record`: 13/13, including the existing "no such device" fallback path now going through the new `device` parameter instead of only the env var. Manual: launched the packaged dev build headless, `listInputDevices()` returned this Deck's real devices (`default`, `pipewire`, `pulse`, `jack`), `recStart("default")` opened successfully and reported back `device: "default"`, `recStart("definitely-not-a-real-device")` rejected with "no input device named …". Screenshot of the toolbar at 1280×800 confirms the picker matches the existing button styling. |

### 2026-09-30 — Deck dual mode, milestone 1: raw controller + Instrument mode

Spec, decisions, full mapping and what's still open: **`docs/deck-dual-mode.md`**.

| Change | Verified how |
|---|---|
| **Raw Deck controller** (`native/src/deckpad.rs` → `electron/deckpad.cjs` → `src/input/deckpad.ts`): the controller's own 250 Hz state report read from hidraw alongside Steam — trackpads (+ pressure), all buttons incl. L4/R4/L5/R5, sticks, analog triggers, accelerometer; haptic pulses out. Gamepad API fallback into the same state. Studio mode only forwards reports when a button changes. | Unit (6); on this Deck: 251 reports/s from Node with Steam running, app idle in Studio 0 msg/s, Instrument ≈ 232/s, haptic report accepted |
| **Modes**: STUDIO / INSTRUMENT / DJ switch in the header (DJ = next milestone), **View + Menu** on the Deck. While the Deck performs, keys and mouse clicks (Steam's desktop-layout emulation of the same buttons) are ignored; touch works. | `test:instrument` |
| **Instrument mode** (`src/input/instrument.ts`, `src/ui/InstrumentView.svelte`): right pad = scale-locked 3-octave note grid with haptic ticks, left pad = cutoff/reverb macro, sticks = bend/mod, R2 swell, ABXY drums, L1/R1 + ABXY chords, L4/R4 octave, L5 sustain, R5 tilt bend, d-pad key/scale, L3 sound; all playable on the touchscreen too. | Unit (10); `npm run test:instrument` 18/18 (real app, injected Deck reports, sound measured on the native engine's meters) |
| **Live instrument in the engine** (`native/src/live.rs` + `public/live-processor.js`): 16-voice synth (keys/pluck/pad/bass) + 4 synthesised drums, into the bus before the reverb return with its own send. `AudioBackend.live(event)`. | Rust (6); parity test: scripted performance JS vs Rust < 0.1 % |
| **Header fits 1282 px** again (the mode switch pushed the master fader off): under 1400 CSS px the wordmark, the theme's name and the header LED meter (the footer VU shows the level) give way. Tests wait for `.app-header` instead of `.title`. | measured `scrollWidth` 1456 → 1269 = `clientWidth` |

### 2026-09-30 — long tracks no longer freeze the app; toolbar on one row

Reported: importing a really long track freezes the app. Reproduced with a 60-minute MP3 in the real app (a 50 ms heartbeat timer logs every stall > 150 ms; CDP CPU profile for the causes).

| Change | Verified how |
|---|---|
| **Autosave never saved a long track and froze the app every minute trying.** It encoded the whole buffer as one float WAV (1.4 GB for an hour) and handed it to preload in one call; a typed array that big doesn't survive the page → preload bridge (arrives as `null`), so the save threw, and the next tick encoded it again: a 3.4 s freeze per autosave, forever. Now `wavParts` (`src/audio/wav.ts`) encodes 8 MB pieces on demand and `autosaveBridge().putAudio` streams them through `files.uploadBegin/uploadPart` → `autosave.putUpload`. | Before: stalls of 3.2–3.8 s at every autosave (5 s interval in the test), `autosave: Cannot read properties of null` each time. After: none; the 1.38 GB WAV lands in `autosave/audio`. `wav.test.ts`: pieces join into exactly `encodeWav`'s bytes (1/2/6 ch, float/16-bit, odd sizes, empty) |
| **Save had the same flaw** (one WAV per layer in one call) — a session with an hour-long layer couldn't be saved. Now streamed with `wavParts`. | Saved the 60-min session: 1382 MB `.ggmm` |
| **Import → native engine** copied every channel whole (`slice()`, 1.4 GB) on the UI thread, then passed it through the bridge in one call. Now `NativeBackend.loadChannels` sends 8 MB planar pieces itself (`engine.loadUpload`). | Stall at import end 5.7 s → 1.2 s; plays from the engine (heard at 7:52, past the first piece) |
| **Waveform summary** of the whole song was built in one go on first draw (345 M samples). `prepareSummary` (`render/peaks.ts`) builds it in 4 M-sample slices during import. | Unit test: sliced == one-pass summary. Last stall 1.2 s → **0.45 s** (Chromium finishing the decode — the only one left) |
| `encodeWav` interleaves through `Float32Array` / `Int16Array` instead of a `DataView` per sample (little-endian hosts; DataView fallback kept). | Same byte-exact tests |
| **Toolbar back on one row** at a default-size window (the 🎤 picker of 2026-09-28 pushed EXPORT to a second row, which shortened the timeline and hid the 5th lane): under 1400 px the picker is 72 px (full name in its tooltip), zoom and gaps tighten. | New and Export on the same row, measured; `test:browser` **79/79** (its "every linked layer has audio" check failed on `main` since 425dc62 — bisected) |

`test:app`'s "UI playhead follows the native engine" reads the on-screen clock, which a hidden test window updates about once a second (Chromium throttles its timers), so it sits on the 00:00.9x / 00:01.0x edge; it passed 5 of 6 runs today, unrelated to these changes.

### 2026-10-02 — BASS MOD, Ableton-style timeline navigation, the GG loader

Asked for: an Ableton-like, Deck-friendly way to move round the timeline; an FX that modulates and controls a bass line / 808 and stacks effects on it to widen / deepen it; a fun, cheap, ASCII-inspired loading animation for app start, opening a file and other loads.

| Change | Verified how |
|---|---|
| **BASS MOD** — new FX slot after PUNCH (`LAYER ▸ EQ ▸ PUNCH ▸ BASS MOD ▸ MORPH ▸ VOICE SYNTH ▸ REVERB`). MODULATE: **WOBBLE** (TPT state-variable low-pass swept down from CUTOFF by up to 6 octaves, RESO), **TALK** (each hit opens / closes the filter, up to 5 oct), **VIBRATO** (±50 cents via a swept delay, ≤ 6 ms), **PUMP** (sidechain-style duck per cycle). One LFO for all of it: 8 rates 1/1 … 1/16T at the module's own **BPM** (−/+, type, TAP), 5 shapes (sine, tri, saw, square, seeded random). The LFO is **locked to song time** (worklet: `currentTime − songT0`, posted by the engine on play; native: the mixer's song time), so a 1/8 wobble lands on the song's 1/8s on both engines and in export. THICKEN: **DEEPEN** (a sine phase-locked to the bass's own fundamental — zero-crossing pitch tracking, filter-lag compensated, so it reinforces instead of cancelling; or an octave below), **GRIT** (saturated bass band, high-passed: harmonics small speakers play), **WIDEN** (above 150 Hz chorused into the sides; the sub stays mono), OUTPUT, soft ceiling. 12 presets (Wobble 1/8, Yoi Growl, Glitch Steps, Talking 808, Deep 808, Sub Drop, Wide Bass, Pump 1/4, Vibrato 808, Phone Killer, Festival); presets keep the layer's BPM. Racks 808 Wobble / 808 Talk / 808 Wide and stack **808 Monster**. Editor: presets, tempo row, rate + shape, an LFO scope whose dot follows the playhead, MODULATE / THICKEN tabs. DSP in `public/bass-core.js` (worklet `bass-processor.js`), line-by-line Rust port `native/src/bass.rs`. Old sessions open with it off. | `src/fx/bass.test.ts` (25): wobble open on the beat / shut between (> 5×), LFO lock (one cycle later = identical to 1e-9, half a cycle = opposite), TALK lifts the 20th harmonic > 5×, DEEPEN > 1.6× the fundamental in phase and follows a glide, octave mode adds 25 Hz, GRIT harmonics, WIDEN side > 10 % on 1 kHz and < 2 % on 45 Hz, PUMP duck < 25 %, VIBRATO period swing 1–10 %, cranked = never over 0.98; **Rust = JS for all 11 presets** (rel. error < 1e-3) + through the native mixer (< 2e-4). Browser: summary `custom · 1/4T @ 100`, LFO drawn, THICKEN tab, export changes. `test:app`: bass-processor constructs in the shell |
| **Timeline navigation, Ableton-style and built for the Deck.** Deck (raw controller, Studio mode): **left trackpad** = timeline trackpad — slide scrolls the song / layers (content follows the thumb, axis-locked), flick glides with friction, **press + slide** = Ableton's ruler drag (down zooms in, sideways scrolls), haptic tick per detent; **left stick** ←→ scrolls smoothly (speed by deflection), ↑↓ zooms round the playhead. Steam's desktop layout still emits a scroll wheel + middle click for that pad and arrow keys for that stick: swallowed while the raw pad / stick is driving (`wheelGuard` / `arrowGuard`). With the mouse pointer over the FX rack or a dialog the pad is left to Steam. Studio now takes all 250 reports/s (it used to take only button changes). Everywhere: **ruler drag** (down/up = zoom in/out round the grabbed moment, sideways = scroll; click still seeks; double-click = whole song), **ctrl+wheel / touchpad pinch** zooms at the pointer, wheel over the ruler (or with Shift, or when every layer is visible) scrolls sideways, **touchscreen** two-finger pinch-zoom + pan and one-finger pan on empty lane with fling (tap still seeks, a clip still drags), **keys** ←→ scroll, ↑↓ / + − zoom, **Z** fits the selected clip or the song, **F** toggles **FOLLOW** (corner button, on by default: the view turns the page with the playhead; manual moves pause it 2.5 s). Toolbar − FIT + now zoom round the playhead too. All moves go through `src/ui/timelineNav.ts` (batched to one DOM update per 16 ms); maths in `src/ui/navMath.ts`, Deck mapping in `src/input/studioNav.ts`. | Unit: `navMath.test.ts` (11: anchored zoom, fit, follow page turn, stick curve, glide comes to rest, pad scroll / axis lock / press-zoom / fling / detents / jitter), `studioNav.test.ts` (3). `test:instrument` (real app, injected Deck reports): pad swipe scrolls 1205 px, press-drag zooms 2400 → 9811 px, stick scrolls and zooms out, Follow on. Browser: ctrl+wheel zooms ×3.3 with the anchor moving 0.001, ruler wheel scrolls, ruler drag zooms ×2, ruler click seeks, → / ↓, pinch ×4, one-finger pan, Z fits again |
| **The GG loader** (`src/ui/AsciiLoader.svelte`, frames in `src/ui/asciiLoader.ts`, state in `src/state/loading.ts`): a little ASCII tape deck — block-letter GG, a waveform scrolling through the tape window, spinning cassette reels, bouncing EQ bars, the label typed out with a blinking cursor, the file / count underneath, a rotating quip ("tuning the 808s…"), and a progress bar (a bouncing block when the length is unknown). One `<pre>` rebuilt at ~11 fps, paused while the window is hidden, static under reduced motion; clicks pass through. Full-window **boot screen** at launch (≥ 0.9 s); a panel for **opening a session** (native + browser), **importing audio** (per-file progress) and **recovering an autosave** — only if the job is still running after 120 ms, then up ≥ 450 ms so it never flickers. | Unit: `asciiLoader.test.ts` (5: every line exactly 52 columns for any frame / progress / detail, label typed in, frames move, bar bounces, quips rotate), `loading.test.ts` (4: quick loads never show, slow ones show with progress and linger, errors still hide it, boot shows at once and a load inside keeps the boot look). Screenshot at 1280×800 reviewed |
| Small: FX chain strip fits seven slots on one row at 1280 px; track-head badges are ≤ 4 letters (PNCH, MRPH, SYN) so seven fit; key hints in the status bar stay on one line. | screenshots at 1280×800 |

### 2026-10-02 — the take draws live while it records

| Change | Verified how |
|---|---|
| **Live recording view (Ableton-style)**: while recording, the armed layer shows the take as a red clip growing from where recording began, header `● REC 12.3s`, waveform filled in as audio arrives (~15 redraws/s); when you stop, the real clip replaces it. Both engines feed a compact summary — (min, max) over all channels per 128 frames: the web engine from the captured blocks (`src/audio/liveTake.ts` `LivePeaks`), the native engine in its drain thread (`record.rs` `PeakAcc`, polled every 50 ms through `recPeaks(from)` / IPC `engine-rec-peaks`, a few KB per poll). The timeline widens if the take runs past the song. Also fixed: a **web-path** take recorded during playback was placed at the playhead at *stop*; it now starts where recording began (native already placed takes from the device clocks). | Rust `live_peaks_are_min_max_per_bucket_over_channels`; `liveTake.test.ts` (2). `test:record` (native, loopback sink): red take on the lane 988 → 3022 px between 1 s and 2.5 s, 0 red px after stop — 15/15. `test:browser` (web capture, fake mic): 831 → 2395 px — 93/93. Screenshot mid-take reviewed |

### 2026-10-02 — Record works like Ableton's

| Change | Verified how |
|---|---|
| **Record starts the transport** when it's stopped (you hear what you play along to); **R** again ends the take and keeps playing; **Stop / Space** ends the take and stops. While recording the song **keeps rolling past its end** (it used to auto-stop and rewind at the last clip). Starting a New / Open while recording drops the take as before. | `test:record`: R from stopped → ❚❚; Stop ends the take and stops (17/17; overdub still 0.04 ms off). `test:browser`: a 1.9 s take on a ~1 s song (94/94). `test:recovery` 14/14 |

### 2026-10-05 — song tempo, bar/beat grid, snap

| Change | Verified how |
|---|---|
| **One tempo for the song** (`project.tempo`: BPM 40–240 to 0.01, beats per bar 2–7, `offset` = where bar 1 starts, folded into one bar). Controls in the timeline corner (where LAYERS was): BPM box (type, wheel ±1, Shift+wheel ±0.1), **TAP**, **4/4** select, **SNAP**, FOLLOW. Tempo edits are undoable; the clock shows **bar.beat.16th** under mm:ss. **Ruler counts bars** (numbers every 1/2/4… bars so they stay ≥ 44 px apart, `bar.beat` labels once a beat is that wide); lanes draw bar / beat / 16th lines. **Adaptive grid** (Ableton's): the finest of 16th, 8th, beat, 1/2/4… bars whose lines are ≥ 14 px apart. **Snap** (on by default, Ctrl+4 / SNAP, remembered in localStorage): clip moves snap the start, trims snap the dragged edge, clicks in the lanes and on the ruler snap the playhead; hold **Shift** (or Alt) to place freely. **B** = a bar starts at the playhead, **Shift+click on the ruler** = a bar starts there (line the grid up with an imported song). Audio isn't warped: changing the tempo moves the grid, not the clips. **BASS MOD follows the song BPM** (its BPM box, −/+ and TAP now set the song tempo; every layer's `bass.bpm` is kept equal to it by `followSongTempo` in `updateProject`), and its LFO counts from **bar 1** on both engines and in export (web: `songT0 + offset`; native: `ProjectSpec.barOrigin`). Old sessions: 120 BPM 4/4, or the BPM of the first active BASS MOD layer. Code: `src/audio/tempo.ts`, `src/ui/TempoControls.svelte`. | `src/audio/tempo.test.ts` (8): clamp/fold/normalize, adaptive grid at 4 zooms + 3/4, snap from bar 1 (never < 0), grid lines with bar/beat/sub and the pickup bar, bar.beat.16th, `followSongTempo`. Session migration test (BASS MOD 87 BPM → song 87). Native: BASS MOD through the mixer with `barOrigin` 0.3125 s = JS core counted from 0.3125 (< 2e-4). Browser (106/106): BASS MOD BPM = song BPM both ways, B puts a bar at the playhead (`1.1.1`), a click lands on a 16th from that bar, Ctrl+4 / SNAP toggle, an unsnapped click doesn't, 3/4 + undo, the ruler draws numbers, the corner fits on one line at 1280 px |

### 2026-10-05 — recording instruments: metronome, count-in, inputs, monitoring, Deck takes

| Change | Verified how |
|---|---|
| **Metronome** (header ♩, also in Instrument mode): a sine blip on every beat of the song grid, higher on the downbeat, rendered in the native mixer (`native/src/click.rs`, `ProjectSpec.click`) — live only, never in an export. Web engine: not available (button disabled). **Count-in** (0 / 1 / 2 bars, default 1, with the metronome on, when Record starts from stopped): the transport starts a bar early — **the mixer now plays from negative song time** (clips start at 0). **Record setup panel** (toolbar 🎤 ▾, replaces the mic select): device, **which input** of an interface (Inputs 1+2 stereo, or Input k as a **mono take**; `rec_start(device, input)`), **MONITOR** (hear the input through the master while a layer is armed — a second cpal input stream → SPSC ring → mixer, 256-frame cushion, skips a backlog over 1024 frames; `record::Monitor`), an **input level meter**, metronome + count-in. **From stopped, capture now starts before playback** (opening an input can take ~1.5 s; nothing after Record is lost) and the take is cut to start where Record was pressed. **Anchoring fix**: a take is anchored on each input block's *newest* frame (`anchor_at`) — PipeWire-via-ALSA delivers a startup burst of seconds of audio while reporting 0 latency; anchoring the first frame put such takes ~1.5 s late. Calibration storage key bumped to `ggmm.recordLatency.v2` (old values don't apply; the test sink now measures 10.7 ms = one output buffer, was 37 ms). **Recording the Deck instrument**: Instrument mode **Menu** = record / stop the take, **View** = play / stop (taps count on release, so View+Menu still only switches mode); on-screen ● REC / ▶ PLAY / ♩ and a bar.beat readout. The mixer pushes the instrument's dry L/R into a `record::Capture` every block (silence too), placed `out latency + look-ahead` earlier (where the player heard the song); onto the armed layer, or a new "Deck instrument" layer. | Rust (20 lib tests): click onsets every beat / downbeat flag / count-in before 0 / grid offset / decay; Deck take placed at song − heard delay with its pre-roll; monitor primes, plays the picked input at the gain, skips a backlog; a missing input refused; deinterleave picks one input; a startup burst anchors at its newest frame. `record-align.test.ts`: `trimBefore`. `test:record` (31): input picker lists 3 options on the stereo test sink, toolbar shows "in 2", count-in from −2 s (engine clock), the take runs from 0 s to where the song stopped (count-in cut), Input 2 = a mono take that heard the song, monitor on → input meter moves (1.7 peak), off again; overdub still within 0.04 ms after recalibration. `test:instrument` (31): View plays / stops, the metronome is heard (peak 0.36), Menu records a kick onto "Deck instrument", it plays back in Studio (peak 0.34) |

### 2026-10-08 — tempo detection: the song sets the tempo

| Change | Verified how |
|---|---|
| **BPM + downbeat detection** (`src/audio/beatDetect.ts`, plain TS on the UI thread in slices, first 150 s of a clip). Onset envelope (low / full / high band log-energy rises, 5 ms hops) → autocorrelation scored on the beat repeating at 1–4 beats and splitting into 8ths, ~100 BPM preference, four-on-the-floor read at half time doubled (≤ 150) → fine search ±2.5 % by how sharply the hits fold onto one phase (whole BPM preferred when as sharp) → beat phase from the fold, downbeat = the beat in the bar with the most kick. Confidence = fold sharpness vs a few % off tempo; < 0.25 = no clear beat, nothing changes. **Import**: the first song into an empty project sets the song tempo and puts a bar on its downbeat (its own undo step: Ctrl+Z keeps the import, drops the tempo); later imports only say what they hear if it differs ("Select it and press AUTO"). **AUTO** (timeline corner, after TAP): tempo + bar 1 from the selected clip, else the longest. Not warping: clips still don't stretch. | `beatDetect.test.ts` (12): house loops 120/124/128/140, boom-bap 84/90/96 and 92.5, beat and bar position within 12 ms (silence before bar 1), stereo + 48 kHz + a clip starting 10 s into its buffer, 3/4 downbeat, noise below the threshold, < 6 s / silence = null. Real records (dev check, not in CI): 9/10 Kanye songs with published tempos within 3 % (Runaway read as 101.5, not 87); MF DOOM tracks agree with themselves across three windows. 0.57 s for a 3-min stereo 48 kHz song, longest UI block 70 ms. Browser (+5, 111/111): a generated 124 BPM loop into a new project → 124 + status; set 100, AUTO → 124, undo → 100; corner still fits (219/219 px — it is now full). |

### 2026-10-08 — DJ mode, milestone 1: two decks on the Deck

| Change | Verified how |
|---|---|
| **DJ mode** (header **DJ**, or View + Menu, which now cycles Studio → Instrument → DJ). Two decks on the shared engine (`native/src/dj.rs`, web twin `public/dj-processor.js`, parity-tested): variable speed with Hermite interpolation (pitch follows, like vinyl), tempo fader ±8 %, jog nudge, scratch (backwards too), 3-band EQ (low shelf 250 Hz / peak 1 kHz / high shelf 3 kHz, −60 dB = kill), channel faders, crossfader (both full in the middle, constant power to the ends), loops; decks play in every mode and through the master/limiter/meters. **SYNC** matches the other deck's tempo (half/double time if closer) and lines up the beat phase *in the engine* (`phase` event — the page's view of positions is a few ms old). Tracks: the project's songs, or **FILE…** straight onto a deck; each is listened to once (`detectTempo`) and cues at its first *audible* beat. Screen (`DjView.svelte`, `DjDeck.svelte`): scrolling waveform ±4 s with beat grid / cue / hot cues / loop (drag it = scratch), whole-track overview (click = jump), PLAY, CUE (CDJ: playing → back to cue and stop; stopped → set cue on the beat), SYNC, LOOP 4, 4 hot cues (tap set/jump, hold clear), tempo, LOAD; mixer with EQ knobs + kills, VOL, crossfader. **Controller** (`src/input/dj.ts`): trackpads = jog (circle it; touch nudges a playing deck, press in = scratch, a stopped deck scrubs; haptic tick every 1/12 turn), sticks = EQ LOW (↑↓) / HIGH (←→) knobs at a rate (they stay), L3/R3 = LOW kill, L2/R2 slide the crossfader (it stays), L1/R1 play, D-pad ←/→ CUE, X/B SYNC, Y/A LOOP 4, L4 L5 / R4 R5 hot cues 1–2. Native status carries `djPos` / `djPlaying`; deck events wait behind a pending track upload. | Rust (5 in `dj.rs`): silent until played, rate incl. 44.1 kHz on 48 kHz, end stops, loop wraps, scratch backwards, crossfader cut + curve, low kill < 5 %, phase moves the shorter way. Parity: a scripted 1.2 s mix (play, tempo, nudge, EQ kill/boost, faders, crossfade, loop, scratch both ways, seek, phase, stop) < 0.1 %. `dj.test.ts` (15): EQ curve, beat snap, crossfader, load/cue/hot cues/loops/sync incl. half-double time and phase, every button, stick + trigger rates, jog nudge/scratch/scrub/release. **`npm run test:dj`** (22, real app, native engine, injected Deck reports, two generated house loops 124/128 BPM): loads + reads tempos, cues at the first beats (0.296 / 0.496 s), L1 heard (peak 0.5), deck clock 1×, SYNC → 124 BPM, B runs at 0.969×, beats within 1.4 % of a beat, R2 / L2 crossfader, stick ↓ LOW, L3 kill, L4 hot cue, Y loop holds, scratching the right pad backwards runs B back 1.1 s, CUE stops at the cue, View + Menu out. Browser (+4): DJ on the web engine plays and reports. `test:instrument`: View + Menu now goes Instrument → DJ → Studio. |

### Native Steam Deck build

| Step | Verified how |
|---|---|
| `npm run build:deck` in the Ubuntu 22.04 container produces AppImage + .deb | Built 3× on this Deck; Rust compile clean |
| AppImage runs on SteamOS: window, WebView, UI, status "Ready" | Native launch; screenshot |
| **Audio reaches PipeWire** (bundled GStreamer → pulsesink → pipewire-pulse) | `pw-cli ls Node` shows `ggmusicmaker` `Stream/Output/Audio`, `media.role=webaudio` |
| `scripts/install-steamdeck.sh` installs AppImage + icons + menu entry under `$HOME`, no sudo | Ran it; `desktop-file-validate` passes |
| Window reports `WM_CLASS = ggmusicmaker` and groups with its icon in the KDE taskbar | Measured with `xwininfo`; `StartupWMClass` set to match |

### Quality gates (all green, 2026-09-14)

```
npm run check         svelte-check: 236 files, 0 errors, 0 warnings
npm test              vitest: 10 files, 120 tests
npm run build         vite: ~99 KB main chunk (+15 KB lazy Tauri window chunk)
npm run test:browser  49/49 checks
```

---

## 3. Not yet verified / known limitations

- **Native recording end-to-end** through WebKitGTK's mic permission path has still not been done by hand. (Native playback *has* now been exercised on the Deck — see 2026-09-15 below.)
- **CI has never run** on the new commits — they are unpushed (see §6). `ci.yml` and `release.yml` are believed correct but unproven on GitHub's runners.
- No GitHub release exists yet; the README's "download the AppImage" link is dead until a `v*` tag is pushed.
- Whole files live in RAM as `AudioBuffer`s — fine for songs, not for hour-long sessions. Session files embed audio as 32-bit float (~23 MB per stereo minute at 48 kHz) so reopening is lossless, which makes a long project a big `.ggmm`.
- The Tauri close-guard (`onCloseRequested` → ask) is exercised in a browser only via `beforeunload`; the native path compiles against the granted permissions but has not been clicked through on the Deck yet.
- Live FX monitoring while recording is not a goal (WebKitGTK → GStreamer latency). Record dry, add FX after.
- **Surround has only been heard as a fold-down.** Headless Chromium and (very likely) the Deck's WebKitGTK report a 2-channel destination, so the live 5.1/7.1 bus path (`setSurround` → rebuilt master + channels) compiles and is exercised only in its stereo branch; the multichannel WAVs are verified structurally and by per-channel levels, not on a surround rig. The reverb send is stereo (5.1 folds down into it; 7.1's side/back channels are dropped from the send).
- The Voice Synth is JavaScript on the audio thread: measured natively at ~30 % of the audio thread for two FX layers (Choir + Chipmunk) plus a dry one. Many layers on the heaviest presets could still provoke the D lamp; WebKit's per-worklet-node call overhead is noticeable (a dry 3-layer project sat at 25 % before idle layers were routed around their nodes, 20 % after), so folding the two placer nodes into the synth node (one worklet per layer, two outputs) is the next lever if it is ever needed.
- No LICENSE file in the repo.
- The `.deb` is untested anywhere.
- Gamepad *navigation* of the editor (Gaming Mode) does not exist yet. The controller plays Instrument mode (raw Deck input, 2026-09-30) and switches modes, but Studio is touch/trackpad/keyboard only. Instrument mode has not been played by a person yet, and haptics are unconfirmed by feel — see `docs/deck-dual-mode.md` → Open.
- **DJ decks on the web engine, late in a heavy session:** in the browser test, after 12 long layers had been loaded, headless Chromium stopped delivering page → worklet messages to the DJ node (the worklet kept running and its messages still came out; no processor error). Not reproduced in a fresh page with the same steps; cause not found. The web engine is the fallback (MASTER §6), so the browser test checks DJ early in its run; the native decks are covered by `test:dj`.
- DJ mode, not yet played by a person: jog feel (speed of a turn, nudge strength, scratch smoothing), stick/trigger rates and the haptic ticks are guesses until a thumb tries them. Bar lines in the deck waveform count from the first beat, not the detected downbeat.
- The CPU readout is **UI-thread** load, not audio-thread load — a WebView cannot see the audio thread. The D lamp is the only audio-side signal, and it has not yet been provoked on the Deck (it is verified only to stay off during a normal session).

---

## 4. Repository map

Every tracked file and why it exists.

```
GgMusicMaker/
├── MASTER.md                      ← this file
├── README.md                      User-facing docs: features, architecture, develop, install, Deck notes
├── index.html                     Vite entry; mounts src/main.ts
├── package.json                   Scripts (see §5), deps. name=ggmusicmaker
├── package-lock.json
├── vite.config.ts                 Dev server on :1420 (Tauri expects it), build settings
├── svelte.config.js               Svelte 5 preprocess
├── tsconfig.json / tsconfig.node.json
├── .gitignore                     node_modules, dist, src-tauri/target, src-tauri/gen, squashfs-root
│
├── src/                           FRONTEND (the whole DAW lives here)
│   ├── main.ts                    Mounts App.svelte, starts the meter/transport rAF loop
│   ├── audio/                     Audio runtime — no Svelte in here
│   │   ├── backend.ts             AudioBackend interface: the UI↔runtime seam (swap-in point for a native engine)
│   │   ├── engine.ts              AudioEngine: AudioContext, master bus (gain→limiter→analyser→out),
│   │   │                          pre-limiter analyser tap, reverb bus, scheduling, recording, offline render
│   │   ├── channel.ts             TrackChannel: gain→EQ→voice synth→placer (layer pan/width)→out,
│   │   │                          out→placer (reverb pan/width)→send
│   │   ├── master.ts              MasterBus: gain→limiter(s)→meters→destination at 2/6/8 channels
│   │   ├── edits.ts (+test)       Pure clip math: split/trim/move/replace, audibility, project duration,
│   │   │                          track duplication (cloneTrack / copyName / insertTrackAfter)
│   │   ├── recording.ts (+test)   Assemble captured chunks into a take
│   │   ├── reverb.ts              Synthesised impulse responses: room / hall / plate
│   │   ├── spectrum.ts (+test)    Pure meter math: dB, block peak/RMS, log-band folding, needle ballistics
│   │   ├── types.ts               Project / Track / Clip / TransportState model, id + colour helpers
│   │   └── wav.ts (+test)         WAV encoder (plain / extensible multichannel) + 16-bit PCM decoder
│   ├── fx/
│   │   ├── morph.ts (+test)       MORPH model: 8 engines + knob labels, tunings, paths, presets. The test runs the worklet in Node
│   │   ├── voice-synth.ts (+test) Voice Synth model: params + UI specs, presets, surround layouts,
│   │   │                          v1 voice → synth migration. The test also runs the worklet DSP in Node
│   │   ├── placer.test.ts         Runs public/placer-processor.js in Node (pan/width stage)
│   │   └── chain.ts (+test)       FX chain strip model: slots, power switches, lamp + summary logic
│   ├── render/
│   │   └── peaks.ts               Waveform peak extraction + cache for the timeline canvas
│   ├── state/
│   │   ├── store.ts               ALL app actions + Svelte stores. Only file that talks to the engine.
│   │   ├── history.ts (+test)     Pure undo/redo snapshot stack with coalescing
│   │   ├── session.ts (+test)     Pure .ggmm container: pack/unpack project + embedded WAVs
│   │   ├── load.ts (+test)        Pure load maths: frame utilisation, EMA, audio-clock dropout test
│   │   └── platform.ts            Tauri dialogs/fs with browser fallbacks (download, confirm)
│   └── ui/                        Svelte 5 components (runes)
│       ├── App.svelte             Layout: header (+ session name/dirty) / toolbar / timeline / fx rack /
│       │                          bottom row; global hotkeys; unsaved-changes close guard
│       ├── LoadMeter.svelte       Header CPU % bar, dropout "D" lamp, ECO toggle
│       ├── Transport.svelte       Play/stop, time readout, LED meter, master fader
│       ├── Toolbar.svelte         New/Open/Save, Import, Layer, Undo, Redo, Split, Delete, Record, zoom, Export
│       ├── Timeline.svelte        Ruler + lanes canvas, playhead, clip drag/trim, scroll sync
│       ├── TrackHead.svelte       Per-layer name, FX button, M/S/arm chips, VOL + RVB faders
│       ├── FxRack.svelte          Chain strip (power/lamp/summary per slot) + one editor: LAYER, EQ, Voice Synth
│       │                          (preset screen + browser, MIX, tabs, chord, OUTPUT), REVERB (space, send, pan, width)
│       ├── AnalogMeter.svelte     Bottom-left VU dial + PEAK lamp + spectrum (canvas)
│       ├── MatrixRain.svelte      Falling-glyph backdrop behind the lanes (20 fps; off in ECO / when hidden)
│       ├── ExportDialog.svelte    Retro export progress popup
│       ├── constants.ts           LANE_HEIGHT, HEAD_WIDTH, RULER_HEIGHT (keep heads and lanes aligned)
│       ├── themes.ts (+test)      Colour themes: token maps, lane palettes, contrast maths; themeStore.ts = persisted store
│       └── theme.css              Retro pixel / DOOM-status-bar theme, touch-sized controls
│
├── public/                        Served as-is; AudioWorklets must be plain files
│   ├── voice-synth-processor.js   The Voice Synth DSP (engines, stack, modulation, surround field)
│   ├── punch-core.js              PUNCH DSP core (drums + bass), shared by the worklet and the lane preview
│   ├── punch-processor.js         PUNCH AudioWorklet wrapper around punch-core.js
│   ├── morph-processor.js         MORPH DSP: the eight engines, per-voice ring placement, paths, diffusion
│   ├── binaural-processor.js      Headphone 3D monitor: 5.1/7.1 bus → 2 ears (ITD, ILD, rear cue)
│   ├── placer-processor.js        Pan + width for a whole signal, stereo (M/S + balance) or surround (VBAP rotate)
│   └── recorder-processor.js      Audio-thread capture for recording
│
├── src-tauri/                     NATIVE SHELL (Rust / Tauri v2)
│   ├── Cargo.toml                 package ggmusicmaker, lib ggmusicmaker_lib; webkit2gtk pinned =2.0.2
│   ├── Cargo.lock
│   ├── build.rs                   tauri_build::build()
│   ├── tauri.conf.json            productName, identifier, 1280×800 window, CSP, bundle targets
│   │                              (appimage+deb), bundleMediaFramework=true, icons
│   ├── capabilities/default.json  Permissions: dialog open/save/ask, fs read+write ($HOME etc.), window close
│   ├── icons/                     32, 128, 128@2x, icon.png — generated by scripts/gen_icons.py
│   ├── src/main.rs                → ggmusicmaker_lib::run()
│   └── src/lib.rs                 Registers dialog+fs plugins (DMABUF renderer deliberately left ON);
│                                  on Linux auto-grants WebKitGTK mic permission requests
│
├── packaging/
│   ├── ggmusicmaker.desktop       Menu entry template (APPIMAGE_PATH substituted by installer);
│   │                              Icon=ggmusicmaker, StartupWMClass=ggmusicmaker
│   └── Containerfile              Ubuntu 22.04 build image = same as the release runner
│
├── scripts/
│   ├── build-in-container.sh      podman/docker: build the toolchain image, then npm ci + build:deck
│   ├── fix-appimage.sh            Post-build: strip bundled libwayland-* from the AppDir, repack with
│   │                              appimagetool. WITHOUT THIS THE WEBVIEW IS BLANK ON STEAMOS.
│   ├── install-steamdeck.sh       Copy AppImage to ~/Applications, install icons + .desktop, refresh caches
│   └── gen_icons.py               Pure-Python PNG icon generator (mixer-fader motif)
│
├── tests/
│   ├── browser-integration.mjs    Headless Chromium: boot, import, undo/redo, meter, record, export, FX, sessions
│   └── fixtures/tone.wav          Test tone (peaks right at the limiter threshold — see test comments)
│
├── docs/
│   └── screenshot.png             README screenshot
│
└── .github/workflows/
    ├── ci.yml                     Push/PR: check → test → build → browser test (ubuntu-22.04)
    └── release.yml                Tag v* or manual: full native build on ubuntu-22.04 (glibc 2.35),
                                   desktop-entry validation, xvfb launch smoke test, attach AppImage+deb
```

Generated / ignored: `node_modules/`, `dist/`, `src-tauri/target/`, `src-tauri/gen/`.

---

## 5. How to do things

```bash
# ---- develop (any machine with Node 20+) ----
npm install
npm run dev              # http://localhost:1420 — full DAW in a normal browser
npm run check            # svelte-check
npm test                 # vitest
npm run build            # production frontend → dist/
npm run test:browser     # needs Chromium: `npx playwright-core install chromium`, or set CHROME_PATH
npm run test:instrument  # Instrument mode in the Electron app, injected Deck reports (after npm run build)

# ---- native (needs Rust + WebKitGTK dev libs; i.e. Ubuntu 22.04 or the container) ----
npm run tauri dev        # dev server + native window
npm run build:deck       # tauri build + scripts/fix-appimage.sh → AppImage + .deb

# ---- on a Steam Deck (no toolchain on the immutable root needed) ----
scripts/build-in-container.sh    # rootless podman; ~4 min cold, ~1 min warm
scripts/install-steamdeck.sh     # install what was just built
~/Applications/ggmusicmaker.AppImage   # or launch from the app menu

# ---- release ----
git tag v0.1.0 && git push origin v0.1.0     # release.yml builds + attaches artifacts
```

### Runtime facts worth knowing

- The AppImage bundles GTK, WebKitGTK and **all of GStreamer** (core + plugins) from Ubuntu 22.04, and deliberately does **not** bundle `libwayland-*` (must match the host's Mesa) nor Mesa/EGL itself.
- glibc: built on 2.35 so it runs on SteamOS. Do not build the release on a newer distro.
- Useful env vars if the WebView misbehaves: `WEBKIT_DISABLE_DMABUF_RENDERER=1` (black window on a broken driver — but it makes playback lag, see §7), `GDK_BACKEND=x11` (forces XWayland).
- Diagnosing a blank window: run the AppImage from a terminal; a `WebKitWebProcess` crash prints there. `LD_DEBUG=libs` on the AppImage finds library mismatches fast.

---

## 6. Direction

### Immediate (blocked only on a push)

1. **Push** `rename-ggmusicmaker` (3 commits ahead of `origin/main`; no credentials on this Deck):
   `git config --global credential.helper store && git push -u origin rename-ggmusicmaker`
2. Merge to `main` → CI runs for the first time.
3. Tag `v0.1.0` → first real release; fix the README download link's target.
4. On-device manual pass: import via Tauri dialog → play → hear it → record → export via save dialog.

### Next up (asked for 2026-09-14, after testing the Voice Synth)

1. ~~**Better FX-selection UI.**~~ Done 2026-09-15 (see §2): chain strip with power/lamp/summary per slot, single editor, categorised preset browser. Not done: re-ordering slots or adding a second instance of a module — the chain order is the audio graph's order. If that is wanted, `TrackChannel` needs a generic slot list instead of fixed nodes.
2. ~~**Duplicate track.**~~ Done 2026-09-15 (see §2).
3. ~~**Width + pan knobs on every effect.**~~ Done 2026-09-15 (see §2). Possible follow-up: a *spatial EQ* — per-band pan/width on the 3-band EQ (lows mono, highs wide), which is the version of "EQ pan" that would actually mean something.

### Near term

- **Deck dual mode, next milestones** (`docs/deck-dual-mode.md`): DJ mode milestone 1 done 2026-10-08 (see §2); next for DJ: sampler, beat-jump / loop sizes, keylock (tempo without pitch), deck FX, recording the mix. Then library + bulk import with analysis, album view.
- **Engine policy (2026-10-08):** new sound features go in the native engine only and are greyed out on the web engine (as the metronome already is). The web engine stays for decoding, the browser test suite and as the fallback for what it already does.
- ~~**A project tempo.**~~ Done 2026-10-05 (see §2), and the metronome / count-in. **BPM detection** done 2026-10-08 (see §2). Follow-ups: warping (clips that stretch with the tempo); detection for the library's analysis queue (DJ mode) can reuse `detectTempo`.
- **Recording instruments, next:** feel-test on the Deck (monitor delay with headphones, count-in, Deck takes in time by ear); record the Deck as **notes** (a piano roll you can edit, not just audio); a USB **MIDI keyboard** playing the live instrument; loop recording / take lanes.
- **Feel-test on the Deck** (2026-10-02 work): left-pad gain / glide friction / haptic detents, stick speeds, and BASS MOD's presets by ear.
- **Gamepad navigation** so the app is usable in Gaming Mode (Steam Input → keyboard is the cheap first step; a focus ring + D-pad model is the real one).
- LICENSE file.
- A real screenshot for the README (the current one predates the meter/undo).
- ~~Persist/restore a session~~ — done 2026-09-14 (`.ggmm` files). Possible follow-ups: autosave/crash recovery to IndexedDB, a "recent sessions" list, and a Deck manual pass of the native close-guard.
- Track re-ordering and multi-select.

### Later (asked for 2026-10-08, not now)

- **Auto-treatment mode ("slowed + reverb" and friends):** drop in a song and pick a one-click treatment — slowed + reverb (≈ 0.8× speed with the pitch going down with it, big hall, a little low-pass), nightcore, lo-fi, 8D (auto-pan through the binaural monitor) — that sets up the layer's FX for you and stays editable afterwards. Mostly existing pieces: varispeed playback (the DJ decks' resampler), the reverb, MORPH/EQ presets, BPM detection to keep the grid on the slowed tempo.

### v3 ideas (from the original roadmap)

- Formant-corrected pitch shifting; real impulse-response files for reverb.
- Movable FX order / more inserts per layer.
- A native Rust/`cpal` `AudioBackend` if WebKitGTK ever proves too slow on the Deck — the interface in `src/audio/backend.ts` exists precisely so this is a second implementation, not a rewrite.

### Non-goals

- Live FX monitoring while recording (latency through GStreamer).
- Windows/macOS builds (nothing prevents them, but nothing tests them).

---

## 7. History of decisions (why things are the way they are)

| Decision | Why |
|---|---|
| Strip `libwayland-*` from the AppImage | Ubuntu 22.04's libwayland 1.20 shadowed the host's 1.23; SteamOS Mesa EGL needs `wl_display_create_queue_with_name` → `EGL_BAD_PARAMETER` → WebProcess abort → blank window. Found with `LD_DEBUG=libs`. |
| Bundle **all** GStreamer instead of none | Bundled 1.20 core couldn't load the host's 1.26 plugins (`appsrc not found`); using the host's core needs GLib ≥ 2.80 which clashes with the bundled GTK. Bundling the whole stack is the only self-consistent option. |
| Meter taps **pre**-limiter | A limiter's purpose is to never pass a peak, so a post-limiter meter can't show peaking. Red zone = limiter threshold (-3 dBFS). |
| Undo history coalesces by key | Faders emit an edit per pointer move; without coalescing one drag = hundreds of undo steps. |
| Arming excluded from undo | It's transport state (which track records next), not a change to the project. |
| Build in an Ubuntu 22.04 container even on the Deck | SteamOS root is immutable and has no compiler; glibc 2.41 builds wouldn't be shareable anyway. Same image as CI = same bugs as CI. |
| WebKitGTK's DMABUF (GPU) renderer stays **on** | v1 disabled it preemptively ("black window fix"). Measured on the Deck: with it off, WebKitGTK 2.50 software-paints the whole window per frame → main thread 98 % during playback; on → 12–15 %. The real black-window bug was libwayland (above). Anyone with a broken driver can still set `WEBKIT_DISABLE_DMABUF_RENDERER=1` in the environment. |
| Tauri identifier `com.gamernation.ggmusicmaker` | Chosen during the rename; change before first release if a different domain is wanted (it's the app's stable OS-level id). |
