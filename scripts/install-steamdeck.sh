#!/usr/bin/env bash
# Install ProfitPals DAW so it launches with one click from the desktop menu.
#
# Copies the AppImage into ~/Applications, installs the icons, and writes a
# .desktop entry into ~/.local/share/applications. Everything lands under $HOME,
# so it works on SteamOS's immutable root without sudo and survives OS updates.
#
# Usage:  ./scripts/install-steamdeck.sh [path/to/ProfitPals-DAW.AppImage]
# With no argument it looks for a freshly built AppImage in src-tauri/target.

set -euo pipefail

APP_NAME="ProfitPals DAW"
APP_ID="profitpals-daw"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
INSTALL_DIR="$HOME/Applications"

# --- locate the AppImage --------------------------------------------------
if [ $# -ge 1 ]; then
  SRC_APPIMAGE="$1"
else
  SRC_APPIMAGE="$(find "$REPO_DIR/src-tauri/target" -name '*.AppImage' -type f 2>/dev/null | head -1 || true)"
fi

if [ -z "${SRC_APPIMAGE:-}" ] || [ ! -f "$SRC_APPIMAGE" ]; then
  echo "error: no AppImage found." >&2
  echo "  Pass one explicitly:  $0 ~/Downloads/ProfitPals-DAW_0.1.0_amd64.AppImage" >&2
  echo "  Or build one first:   npm run tauri build" >&2
  exit 1
fi

echo "==> Installing $APP_NAME"
echo "    from: $SRC_APPIMAGE"

# --- install the binary ---------------------------------------------------
mkdir -p "$INSTALL_DIR"
DEST_APPIMAGE="$INSTALL_DIR/${APP_ID}.AppImage"
# Copy to a temp name first so a failed copy can't leave a half-written binary
# in place of a working one.
cp -f "$SRC_APPIMAGE" "$DEST_APPIMAGE.tmp"
chmod +x "$DEST_APPIMAGE.tmp"
mv -f "$DEST_APPIMAGE.tmp" "$DEST_APPIMAGE"
echo "    -> $DEST_APPIMAGE"

# --- install icons --------------------------------------------------------
installed_icons=0
for size in 32 128 256 512; do
  case "$size" in
    32)  src="$REPO_DIR/src-tauri/icons/32x32.png" ;;
    128) src="$REPO_DIR/src-tauri/icons/128x128.png" ;;
    256) src="$REPO_DIR/src-tauri/icons/128x128@2x.png" ;;
    512) src="$REPO_DIR/src-tauri/icons/icon.png" ;;
  esac
  if [ -f "$src" ]; then
    mkdir -p "$ICON_ROOT/${size}x${size}/apps"
    cp -f "$src" "$ICON_ROOT/${size}x${size}/apps/${APP_ID}.png"
    installed_icons=$((installed_icons + 1))
  fi
done
echo "    -> installed $installed_icons icon size(s)"

# --- install the .desktop entry ------------------------------------------
mkdir -p "$APPS_DIR"
DESKTOP_SRC="$REPO_DIR/packaging/${APP_ID}.desktop"
DESKTOP_DEST="$APPS_DIR/${APP_ID}.desktop"
if [ ! -f "$DESKTOP_SRC" ]; then
  echo "error: missing $DESKTOP_SRC" >&2
  exit 1
fi
# Substitute the real binary path; escape | since paths may contain it.
sed "s|APPIMAGE_PATH|${DEST_APPIMAGE}|g" "$DESKTOP_SRC" > "$DESKTOP_DEST"
chmod 644 "$DESKTOP_DEST"
echo "    -> $DESKTOP_DEST"

# --- refresh the menu caches (best-effort) --------------------------------
command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
  gtk-update-icon-cache -f -t "$ICON_ROOT" >/dev/null 2>&1 || true

cat <<EOF

Done. "$APP_NAME" is installed.

  Launch it:  from the application menu (Multimedia -> $APP_NAME),
              or run $DEST_APPIMAGE

  Add to Steam (for Gaming Mode):
    Steam -> Games -> Add a Non-Steam Game to My Library -> Browse
    -> $DEST_APPIMAGE
EOF
