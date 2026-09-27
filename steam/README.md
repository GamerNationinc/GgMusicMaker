# Shipping GgMusicMaker on Steam

The desktop app is an Electron build (`npm run dist:deck`), which produces:

- `release/linux-unpacked/` — the **Steam depot**: a self-contained folder
  with the `ggmusicmaker` executable, its own Chromium, and the app in
  `resources/app.asar`. Nothing is needed from the host except glibc, X11 or
  Wayland, and PulseAudio/PipeWire — all present on SteamOS and every desktop
  distro.
- `release/GgMusicMaker-<version>-x86_64.AppImage` — the same thing as one
  file, for desktop mode outside Steam (what `scripts/install-desktop.sh`
  installs).

## What only the owner can do

1. Pay the Steam Direct fee and create the app in Steamworks
   (https://partner.steamgames.com). You get an **App ID** and a **Depot ID**.
2. Put them in `app_build.vdf` / `depot_build_linux.vdf` (replace
   `APP_ID` / `DEPOT_ID`).
3. Download the Steamworks SDK, then from `sdk/tools/ContentBuilder`:
   `steamcmd +login <builder account> +run_app_build /path/to/steam/app_build.vdf +quit`
4. In Steamworks → Installation → General: launch option
   **Executable** `ggmusicmaker`, **OS** Linux + SteamOS,
   **Launch type** Launch (Default). Set the Steam Deck compatibility
   category (Steam Deck → Verified checks) and submit for review.

## Notes

- The app does not need the Steamworks SDK at runtime (no achievements,
  no overlay hooks) — Steam launches it like any Linux title. Adding Steam
  Cloud for `.ggmm` sessions later is a Steamworks setting (Auto-Cloud on
  `~/.config/GgMusicMaker`) plus a save-location change.
- Multi-user: Steam gives each Deck/PC user their own install + config;
  sessions are per-user files.
- A Windows depot is the same `electron-builder --win dir` output; it has
  not been built or tested yet.
