#!/usr/bin/env bash
# Download the stem-separation model (HTDemucs 6-stem, ONNX) into models/,
# checked against models/htdemucs_6s.onnx.sha256. It lives in a GitHub
# release because it's over GitHub's 100 MB per-file limit for git.
# To rebuild it from Meta's published weights instead: scripts/export-demucs.sh
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"
URL="https://github.com/GamerNationinc/GgMusicMaker/releases/download/models-v1/htdemucs_6s.onnx"
if [ -f models/htdemucs_6s.onnx ] && sha256sum -c --status models/htdemucs_6s.onnx.sha256; then
  echo "models/htdemucs_6s.onnx already present"; exit 0
fi
curl -fL --retry 3 -o models/htdemucs_6s.onnx.part "$URL"
mv models/htdemucs_6s.onnx.part models/htdemucs_6s.onnx
sha256sum -c models/htdemucs_6s.onnx.sha256
