# GgMusicMaker — Master Reference

The single place that says **what this repo is, what is proven to work, where
everything lives, and where it is going.** Keep it current when features land.

_Last updated: 2026-09-15 (branch `main`)._

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
npm test              vitest: 8 files, 106 tests
npm run build         vite: ~99 KB main chunk (+15 KB lazy Tauri window chunk)
npm run test:browser  40/40 checks
```

---

## 3. Not yet verified / known limitations

- **Native playback and recording end-to-end.** The audio node exists and the UI works natively, but nobody has yet imported a file through the Tauri file dialog on the Deck, pressed play, and *heard* it, or recorded through WebKitGTK's mic permission path. This is the first thing to do by hand.
- **CI has never run** on the new commits — they are unpushed (see §6). `ci.yml` and `release.yml` are believed correct but unproven on GitHub's runners.
- No GitHub release exists yet; the README's "download the AppImage" link is dead until a `v*` tag is pushed.
- Whole files live in RAM as `AudioBuffer`s — fine for songs, not for hour-long sessions. Session files embed audio as 16-bit PCM (~10 MB per stereo minute at 48 kHz), so a long project makes a big `.ggmm`.
- The Tauri close-guard (`onCloseRequested` → ask) is exercised in a browser only via `beforeunload`; the native path compiles against the granted permissions but has not been clicked through on the Deck yet.
- Live FX monitoring while recording is not a goal (WebKitGTK → GStreamer latency). Record dry, add FX after.
- **Surround has only been heard as a fold-down.** Headless Chromium and (very likely) the Deck's WebKitGTK report a 2-channel destination, so the live 5.1/7.1 bus path (`setSurround` → rebuilt master + channels) compiles and is exercised only in its stereo branch; the multichannel WAVs are verified structurally and by per-channel levels, not on a surround rig. The reverb send is stereo (5.1 folds down into it; 7.1's side/back channels are dropped from the send).
- The Voice Synth is JavaScript on the audio thread; a project with many layers all on the heaviest presets could provoke the D lamp on the Deck. Not yet measured natively.
- No LICENSE file in the repo.
- The `.deb` is untested anywhere.
- Gamepad navigation (Gaming Mode) does not exist yet; the app is touch/trackpad/keyboard only.
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
│   │   ├── channel.ts             TrackChannel: gain→EQ→voice synth worklet (N-ch out)→out, + reverb send
│   │   ├── master.ts              MasterBus: gain→limiter(s)→meters→destination at 2/6/8 channels
│   │   ├── edits.ts (+test)       Pure clip math: split/trim/move/replace, audibility, project duration,
│   │   │                          track duplication (cloneTrack / copyName / insertTrackAfter)
│   │   ├── recording.ts (+test)   Assemble captured chunks into a take
│   │   ├── reverb.ts              Synthesised impulse responses: room / hall / plate
│   │   ├── spectrum.ts (+test)    Pure meter math: dB, block peak/RMS, log-band folding, needle ballistics
│   │   ├── types.ts               Project / Track / Clip / TransportState model, id + colour helpers
│   │   └── wav.ts (+test)         WAV encoder (plain / extensible multichannel) + 16-bit PCM decoder
│   ├── fx/
│   │   └── voice-synth.ts (+test) Voice Synth model: params + UI specs, presets, surround layouts,
│   │                              v1 voice → synth migration. The test also runs the worklet DSP in Node
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
│       ├── FxRack.svelte          EQ, Voice Synth (presets, MIX, tabbed sections, chord, OUTPUT layout), reverb
│       ├── AnalogMeter.svelte     Bottom-left VU dial + PEAK lamp + spectrum (canvas)
│       ├── MatrixRain.svelte      Falling-glyph backdrop behind the lanes (20 fps; off in ECO / when hidden)
│       ├── ExportDialog.svelte    Retro export progress popup
│       ├── constants.ts           LANE_HEIGHT, HEAD_WIDTH, RULER_HEIGHT (keep heads and lanes aligned)
│       └── theme.css              Retro pixel / DOOM-status-bar theme, touch-sized controls
│
├── public/                        Served as-is; AudioWorklets must be plain files
│   ├── voice-synth-processor.js   The Voice Synth DSP (engines, stack, modulation, surround field)
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
│   └── src/lib.rs                 Sets WEBKIT_DISABLE_DMABUF_RENDERER=1; registers dialog+fs plugins;
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
- Useful env vars if the WebView misbehaves: `WEBKIT_DISABLE_DMABUF_RENDERER=1` (set by `lib.rs`), `GDK_BACKEND=x11` (forces XWayland).
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

1. **Better FX-selection UI.** The rack is a row of modules with a tabbed synth in the middle; it should read as an FX *chain* you pick from — a module strip per layer (EQ ▸ Voice Synth ▸ Reverb …) with add/remove/enable per slot, a clearer "what's active" style than the magenta border, and preset browsing that isn't a wall of buttons.
2. ~~**Duplicate track.**~~ Done 2026-09-15 (see §2).
3. **Width + pan knobs on every effect.** Each module (EQ, Voice Synth, Reverb send, and the dry layer itself) gets its own stereo width and pan, so a layer can sit somewhere in the field and any effect can be placed independently of it. In surround, "pan" means azimuth on the ring — the synth's `setPan` (VBAP on the speaker ring) is the shared primitive; a small pan/width worklet stage (or a StereoPanner for the stereo bus) per module.

### Near term

- **Gamepad navigation** so the app is usable in Gaming Mode (Steam Input → keyboard is the cheap first step; a focus ring + D-pad model is the real one).
- LICENSE file.
- A real screenshot for the README (the current one predates the meter/undo).
- ~~Persist/restore a session~~ — done 2026-09-14 (`.ggmm` files). Possible follow-ups: autosave/crash recovery to IndexedDB, a "recent sessions" list, and a Deck manual pass of the native close-guard.
- Track re-ordering and multi-select.

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
| Tauri identifier `com.gamernation.ggmusicmaker` | Chosen during the rename; change before first release if a different domain is wanted (it's the app's stable OS-level id). |
