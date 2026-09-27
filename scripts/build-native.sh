#!/usr/bin/env bash
# Build the native audio engine (native/, Rust → Node-API addon) inside the
# Ubuntu 22.04 build image, and drop it at native/ggmm-engine.node where the
# Electron main process loads it. glibc 2.35 build → runs on SteamOS.
#   scripts/build-native.sh          build (release) + unit tests
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME=podman; command -v podman >/dev/null 2>&1 || RUNTIME=docker
"$RUNTIME" run --rm -v "$REPO_DIR":/work:Z -v ggmm-cargo-registry:/root/.cargo/registry -w /work/native \
  ggmusicmaker-build bash -lc 'cargo test --release --lib 2>&1 | tail -15 && cargo build --release 2>&1 | tail -3 && cp target/release/libggmm_engine.so ggmm-engine.node'
ls -la "$REPO_DIR/native/ggmm-engine.node"
