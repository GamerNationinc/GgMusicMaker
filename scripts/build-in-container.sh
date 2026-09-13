#!/usr/bin/env bash
# Build the Steam Deck AppImage locally, in the same Ubuntu 22.04 environment
# the release workflow uses. Works on a Steam Deck itself (rootless podman is
# preinstalled on SteamOS; no toolchain on the immutable root is needed).
#
# Usage: scripts/build-in-container.sh
# Output: src-tauri/target/release/bundle/appimage/GgMusicMaker_*.AppImage
#         (install it with scripts/install-steamdeck.sh)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="ggmusicmaker-build"

if command -v podman >/dev/null 2>&1; then RUNTIME=podman
elif command -v docker >/dev/null 2>&1; then RUNTIME=docker
else echo "error: need podman or docker" >&2; exit 1; fi

echo "==> Building toolchain image ($IMAGE)"
"$RUNTIME" build -t "$IMAGE" -f "$REPO_DIR/packaging/Containerfile" "$REPO_DIR/packaging"

echo "==> Building AppImage"
# The cargo registry lives in a named volume so rebuilds don't re-download crates.
"$RUNTIME" run --rm \
  -v "$REPO_DIR:/work:Z" \
  -v ggmusicmaker-cargo-registry:/root/.cargo/registry:Z \
  -e CI=true -e APPIMAGE_EXTRACT_AND_RUN=1 \
  "$IMAGE" bash -lc 'npm ci && npm run build:deck'

echo
echo "Done. Install with:  scripts/install-steamdeck.sh"
