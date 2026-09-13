# GgMusicMaker

A **very simple, playful DAW for the Steam Deck** (desktop mode). Think "the core
ideas of Ableton, but as approachable as the Hasbro *Play It Now*" — chunky
toy-like controls wrapped in retro pixel / DOOM-status-bar art.

Load any audio file, stack it into layers, cut and split clips on a timeline,
record from the mic, and mix it down — with an iZotope-style convolution reverb
send on every layer and a master limiter for the final level.

![GgMusicMaker screenshot](docs/screenshot.png)

> **See [MASTER.md](MASTER.md)** for the verified status of every feature, a map of every
> file, install locations, and the roadmap.

## Status

**Working now (v1 + v2):**

- 🎚️ Import any audio file (WAV/MP3/OGG/FLAC — anything the WebView can decode) and
  layer it onto its own track.
- ✂️ Non-destructive **cut / split / trim / move / delete** on a timeline.
- 🎙️ **Record** from the mic / line-in straight onto an armed layer.
- 🎛️ Per-layer **volume, mute, solo** and a **reverb send**.
- 🎚️ **Per-layer FX rack** (the "FX" button on each layer):
  - **3-band EQ** (low shelf / mid peak / high shelf).
  - **Voice manipulation** — an iZotope-style digital-voice unit with
    **Chipmunk / Deep / Robot / Alien** presets (pitch shifting via a custom
    `AudioWorklet`, ring modulation via a native oscillator) plus an amount knob.
  - **Reverb** send with selectable **Room / Hall / Plate** spaces.
- 🌫️ Shared convolution **reverb** bus (synthesised impulse responses).
- 📈 **Master limiter** + level meter ("mastering level").
- 🎚️ **Analogue master meter** (bottom-left): VU-style needle with peak hold, a
  **PEAK** lamp, and a spectrum strip — all reading the mix *before* the limiter, so the
  red zone means "the limiter is working" and the lamp means "over full scale".
- ↶ **Undo / redo** for every edit (import, layers, cut/split/move/trim, takes, mixer
  and FX changes); fader drags collapse into one step.
- 💾 **Export** the whole mix to a WAV file — rendered offline through the *same*
  FX graph you hear (native save dialog under Tauri).

**Next (v3 ideas):**

- Formant-corrected pitch shifting and real IR reverb files.
- Movable FX order / more inserts per layer.
- Steam Deck gamepad navigation.

## Architecture

Web tech (TypeScript + **Web Audio API** for sound, HTML5 **Canvas** for the
pixel art) shipped as a small native Linux binary via **Tauri v2**.

```
public/
  pitch-processor.js  AudioWorklet: dual-delay-line pitch shifter (voice FX)
src/
  audio/     AudioEngine (AudioContext + master bus + reverb), TrackChannel
             (per-layer fader + EQ + voice FX + send), Track/Clip model,
             pure edit ops (split/trim/move), WAV encoder, reverb IR generator
  fx/        Voice presets + param mapping (pure, unit-tested)
  render/    waveform peak extraction + caching
  state/     Svelte stores + all app actions (the UI <-> engine seam)
  ui/        Svelte components: App, Transport, Toolbar, Timeline, TrackHead, FxRack
src-tauri/   Rust/Tauri shell: window config, mic/fs permissions, WebKitGTK setup
```

Key design choices (see also "Architecture decisions" below and inline comments):

- **Non-destructive editing** — clips only reference a decoded `AudioBuffer` and
  adjust `offset`/`duration`/`startTime`; source audio is never mutated. The math
  lives in `src/audio/edits.ts` and is fully unit-tested.
- **Real-time, non-destructive FX** — each track is a `TrackChannel`:
  `gain → EQ → pitch → ring-mod → out`, with `out → master` (dry) and
  `out → send → convolver → master` (wet); the master bus is
  `gain → limiter → meter → output`. Export builds the **same** `TrackChannel`
  graph in an `OfflineAudioContext`, so the render matches playback exactly.
- **Recording** captures through an `AudioWorklet` (`public/recorder-processor.js`) so it
  runs on the audio thread and stays clean while the UI is busy. If the worklet can't
  load (older WebKitGTK), it falls back automatically to a `ScriptProcessorNode` and the
  status bar says so, rather than failing outright.
- **Swappable audio backend** — the UI talks to the runtime only through the
  `AudioBackend` interface (`src/audio/backend.ts`). Web Audio is today's sole
  implementation; a native Rust/`cpal` backend could be added behind the same interface
  without touching the store or UI. See "Architecture decisions" below.

## Develop

Prereqs: Node 20+, Rust (stable), and the Tauri Linux system deps
(`webkit2gtk-4.1`, etc. — see https://tauri.app/start/prerequisites/).

```bash
npm install

# Run just the web frontend in a normal browser (fast iteration):
npm run dev            # http://localhost:1420

# Run the full native app (spawns the Vite dev server + Tauri window):
npm run tauri dev

# Quality gates:
npm run check          # svelte-check / TypeScript
npm test               # vitest (edit math, WAV encoder, take assembly, undo history, meter math)
npm run build          # production frontend build
npm run test:browser   # headless Chromium: boot, import, RECORD, export, voice FX

# Build the Steam Deck AppImage (+ .deb) — tauri build plus scripts/fix-appimage.sh:
npm run build:deck

# Same thing from a machine without the Tauri toolchain (including a Steam Deck):
# builds inside an Ubuntu 22.04 container via podman/docker, matching CI.
scripts/build-in-container.sh
```

`test:browser` needs a Chromium binary. It looks in Playwright's browser cache first, so
`npx playwright-core install chromium` is enough; or point `CHROME_PATH` at any Chrome/Chromium.

The frontend also runs fully in a plain browser — export falls back to a normal
download when the Tauri APIs aren't present, so you can develop most features
without building the native shell.

## Install on a Steam Deck

Grab the AppImage from the [latest release](../../releases/latest) — **use the release
build, not one you compiled yourself on a newer distro** (see the glibc note below).

```bash
chmod +x install-steamdeck.sh
./install-steamdeck.sh ~/Downloads/GgMusicMaker_0.1.0_amd64.AppImage
```

That copies the AppImage to `~/Applications`, installs the icons, and adds a menu entry —
everything under `$HOME`, so it needs no `sudo` and survives SteamOS updates. Launch
**GgMusicMaker** from the application menu (Multimedia). To play it in Gaming Mode, add
`~/Applications/ggmusicmaker.AppImage` via *Steam → Add a Non-Steam Game*.

> **Why the release build?** Releases are built on Ubuntu 22.04 (glibc 2.35) because glibc
> is forward- but not backward-compatible: a binary compiled against a newer glibc than
> SteamOS ships will refuse to start with a `GLIBC_2.3x not found` error.

## Architecture decisions

**Why a WebView (Tauri + Web Audio) rather than a native audio stack?** For this app the
performance-critical DSP — reverb (`ConvolverNode`), EQ (`BiquadFilterNode`), the limiter
(`DynamicsCompressorNode`) — is native C++ inside the browser engine, and export runs
through `OfflineAudioContext`, so it isn't real-time bound at all. The known trade-offs are
monitoring latency (WebKitGTK routes through GStreamer, so live FX monitoring is not a goal
— record dry, add FX after) and whole files living in RAM as `AudioBuffer`s, which doesn't
scale to very long sessions.

The residual risk is the WebView itself on SteamOS. That's why the audio runtime sits behind
`AudioBackend`: if WebKitGTK proves a poor host on the Deck, a Rust/`cpal` engine can be
swapped in behind the same interface while the entire UI stays as-is.

## Keyboard shortcuts

| Key       | Action              |
|-----------|---------------------|
| `Space`   | Play / pause        |
| `S`       | Split at playhead   |
| `R`       | Record / stop       |
| `Delete`  | Delete selected clip|
| `Ctrl+Z`  | Undo                |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |

## Known runtime dependency: GStreamer

WebKitGTK builds its audio pipeline on **GStreamer**, so the host needs
`gstreamer1.0-plugins-base` and `-plugins-good` (providing `appsink`, `appsrc` and
`autoaudiosink`). SteamOS ships these as part of its KDE desktop, so a Deck should be fine
out of the box — but **this is the first thing to check if the app opens and plays silently.**

If the audio device fails to initialise the status bar now says
*"No audio output available — check the system audio (GStreamer) setup"* rather than
appearing to play in silence.

> Verified in CI only as far as the environment allows: the build container has no sound
> hardware at all (`/dev/snd` absent), so **audio output is confirmed on-device, not in CI.**
> The automated launch test proves the app starts and the WebView initialises.

## Notes for the Steam Deck

- Targeted at desktop mode (SteamOS / KDE), 1280×800, touch + trackpad friendly
  (large hit targets, no hover-only controls).
- `src-tauri/src/lib.rs` disables the WebKitGTK DMABUF renderer, the common fix for
  a black WebView on Mesa/Steam Deck drivers, and the app requests microphone access
  for recording.
- `scripts/fix-appimage.sh` (run by `npm run build:deck`) strips the bundled
  `libwayland-*` from the AppImage. SteamOS's Mesa EGL driver needs a newer libwayland
  than the Ubuntu 22.04 build host ships; with the bundled copy shadowing the system one,
  `WebKitWebProcess` aborts with `Could not create default EGL display` and the window
  stays blank. GStreamer, by contrast, *is* bundled in full (`bundleMediaFramework`) so
  the audio pipeline is self-contained rather than mixing the bundled 1.20 core with the
  host's 1.26 plugins.
