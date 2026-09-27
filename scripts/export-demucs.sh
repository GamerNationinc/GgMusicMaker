#!/usr/bin/env bash
# Rebuild models/htdemucs_6s.onnx from Meta's published Demucs v4 weights
# (MIT), in a throwaway Python + PyTorch container. Also writes the PyTorch
# reference files the Rust parity tests compare against (into $OUT).
#
#   scripts/export-demucs.sh                 export the model
#   scripts/export-demucs.sh --reference     + reference separation of the
#                                            Demucs test clip, and STFT refs
# then:  GGMM_MODEL_DIR=models GGMM_REF_DIR=$OUT cargo test --release -- --ignored parity
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME=podman; command -v podman >/dev/null 2>&1 || RUNTIME=docker
OUT="${OUT:-$REPO_DIR/native/target/demucs-ref}"
mkdir -p "$OUT"
"$RUNTIME" build -t ggmm-demucs -f "$REPO_DIR/scripts/demucs/Containerfile" "$REPO_DIR/scripts/demucs"
run() { "$RUNTIME" run --rm -v "$REPO_DIR/scripts/demucs":/w:Z -v "$OUT":/out:Z -v ggmm-torch-cache:/root/.cache/torch -w /w ggmm-demucs "$@"; }
run python3 export.py htdemucs_6s /out/htdemucs_6s.onnx
cp "$OUT/htdemucs_6s.onnx" "$OUT/htdemucs_6s.json" "$REPO_DIR/models/"
sha256sum "$REPO_DIR/models/htdemucs_6s.onnx" | sed "s#$REPO_DIR/##" > "$REPO_DIR/models/htdemucs_6s.onnx.sha256"
if [ "${1:-}" = "--reference" ]; then
  [ -f "$OUT/test.mp3" ] || curl -fsL -o "$OUT/test.mp3" https://github.com/facebookresearch/demucs/raw/main/test.mp3
  run python3 reference.py /out/test.mp3
  run python3 stftref.py
fi
echo "model: models/htdemucs_6s.onnx   references: $OUT"
