#!/usr/bin/env bash
# Run the WebKit timeline checks (tests/webkit-lanes.mjs) against dist/ inside
# the Ubuntu 22.04 build image: Playwright's WebKit needs Ubuntu libraries
# SteamOS doesn't ship. Build first (npm run build). Don't run it while
# build-in-container.sh is rebuilding dist/.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME=podman; command -v podman >/dev/null 2>&1 || RUNTIME=docker
"$RUNTIME" run --rm -v "$REPO_DIR":/repo:Z -w /repo ggmusicmaker-build bash -lc \
  'npx playwright-core install --with-deps webkit >/tmp/webkit-install.log 2>&1 || { tail -20 /tmp/webkit-install.log; exit 1; }
   node tests/webkit-lanes.mjs'
