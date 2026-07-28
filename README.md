# ProfitPals DAW

A **very simple, playful DAW for the Steam Deck** (desktop mode). Think "the core
ideas of Ableton, but as approachable as the Hasbro *Play It Now*" — chunky
toy-like controls wrapped in retro pixel / DOOM-status-bar art.

Load any audio file, stack it into layers, cut and split clips on a timeline,
record from the mic, and mix it down — with an iZotope-style convolution reverb
send on every layer and a master limiter for the final level.

![screenshot placeholder](docs/screenshot.png)

## Status

**v1 (working now):**

- 🎚️ Import any audio file (WAV/MP3/OGG/FLAC — anything the WebView can decode) and
  layer it onto its own track.
- ✂️ Non-destructive **cut / split / trim / move / delete** on a timeline.
- 🎙️ **Record** from the mic / line-in straight onto an armed layer.
- 🎛️ Per-layer **volume, mute, solo** and a **reverb send** (the FX seam).
- 🌫️ Convolution **reverb** bus (synthesised hall/room/plate impulse response).
- 📈 **Master limiter** + level meter ("mastering level").
- 💾 **Export** the whole mix to a WAV file (native save dialog under Tauri).

**v2 (next milestone — the FX seam is already in place):**

- Full per-layer FX rack: EQ, and an **iZotope-style voice manipulation** unit
  (pitch + formant shifting — robot / chipmunk / deep / alien) via an
  `AudioWorklet` / SoundTouchJS.
- Selectable reverb spaces per send and real IR files.
- Steam Deck gamepad navigation.

## Architecture

Web tech (TypeScript + **Web Audio API** for sound, HTML5 **Canvas** for the
pixel art) shipped as a small native Linux binary via **Tauri v2**.

```
src/
  audio/     AudioEngine (AudioContext + master bus + reverb), Track/Clip model,
             pure edit ops (split/trim/move), WAV encoder, reverb IR generator
  render/    waveform peak extraction + caching
  state/     Svelte stores + all app actions (the UI <-> engine seam)
  ui/        Svelte components: App, Transport, Toolbar, Timeline, TrackHead
src-tauri/   Rust/Tauri shell: window config, mic/fs permissions, WebKitGTK setup
```

Key design choices (see `docs/` and inline comments):

- **Non-destructive editing** — clips only reference a decoded `AudioBuffer` and
  adjust `offset`/`duration`/`startTime`; source audio is never mutated. The math
  lives in `src/audio/edits.ts` and is fully unit-tested.
- **Real-time, non-destructive FX** — each track routes `gain → master` (dry) and
  `gain → send → convolver → master` (wet); the master bus is
  `gain → limiter → meter → output`. Export mirrors this graph in an
  `OfflineAudioContext`.
- **Recording** uses a `ScriptProcessorNode` rather than `MediaRecorder` because it
  works reliably under WebKitGTK (the Steam Deck / Tauri webview) with no codec step.

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
npm test               # vitest (pure edit + WAV + peak logic)

# Build a Steam Deck AppImage + .deb:
npm run tauri build
```

The frontend also runs fully in a plain browser — export falls back to a normal
download when the Tauri APIs aren't present, so you can develop most features
without building the native shell.

## Keyboard shortcuts

| Key       | Action              |
|-----------|---------------------|
| `Space`   | Play / pause        |
| `S`       | Split at playhead   |
| `R`       | Record / stop       |
| `Delete`  | Delete selected clip|

## Notes for the Steam Deck

- Targeted at desktop mode (SteamOS / KDE), 1280×800, touch + trackpad friendly
  (large hit targets, no hover-only controls).
- `src-tauri/src/lib.rs` disables the WebKitGTK DMABUF renderer, the common fix for
  a black WebView on Mesa/Steam Deck drivers, and the app requests microphone access
  for recording.
