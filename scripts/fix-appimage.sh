#!/usr/bin/env bash
# Post-process the Tauri AppImage so it runs on SteamOS.
#
# linuxdeploy copies the build host's libwayland-* into the AppImage. Those
# must come from the *runtime* host instead: Mesa's EGL driver is linked against
# the host's libwayland-client, and SteamOS's Mesa needs symbols that the older
# bundled copy (Ubuntu 22.04, libwayland 1.20) lacks. The bundled copy shadows
# the system one, EGL finds no usable driver, and WebKitWebProcess aborts with
#   "Could not create default EGL display: EGL_BAD_PARAMETER"
# leaving a blank window. Every GTK3 host ships libwayland, so dropping the
# bundled copies is safe; the loader then falls back to the host's.
#
# Usage: scripts/fix-appimage.sh   (after `npm run tauri build`)
# Rewrites src-tauri/target/release/bundle/appimage/*.AppImage in place.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="$REPO_DIR/src-tauri/target/release/bundle/appimage"

APPDIR="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.AppDir' -type d | head -1 || true)"
APPIMAGE="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.AppImage' -type f | head -1 || true)"
if [ -z "$APPDIR" ] || [ -z "$APPIMAGE" ]; then
  echo "error: no AppDir/AppImage under $BUNDLE_DIR — run 'npm run tauri build' first" >&2
  exit 1
fi

echo "==> Stripping host-tied libraries from $(basename "$APPDIR")"
find "$APPDIR/usr/lib" -name 'libwayland-*.so*' -print -delete

# appimagetool repacks the AppDir. Cached under target/ but *outside* the
# bundle dir, so nothing that globs bundle/appimage/*.AppImage (the release
# smoke test, artifact collection) can mistake it for the app.
TOOL="${APPIMAGETOOL:-$REPO_DIR/src-tauri/target/appimagetool-x86_64.AppImage}"
if [ ! -x "$TOOL" ]; then
  echo "==> Downloading appimagetool"
  curl -fsSL -o "$TOOL" \
    https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x "$TOOL"
fi

echo "==> Repacking $(basename "$APPIMAGE")"
ARCH=x86_64 "$TOOL" --appimage-extract-and-run "$APPDIR" "$APPIMAGE.tmp" >/dev/null
mv -f "$APPIMAGE.tmp" "$APPIMAGE"
chmod +x "$APPIMAGE"
ls -lh "$APPIMAGE"
