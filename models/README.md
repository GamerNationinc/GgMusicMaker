# Models

`htdemucs_6s.onnx` — the stem-separation network (HTDemucs, Demucs v4, 6 sources:
drums, bass, other, vocals, guitar, piano), exported without its STFT/iSTFT by
`scripts/export-demucs.sh`; the native engine (`native/src/separate.rs`) does those
and the segment overlap-add. Not in git (114 MB): `scripts/fetch-model.sh` downloads
it and checks `htdemucs_6s.onnx.sha256`. `htdemucs_6s.json` describes its layout.

Weights: Demucs by Alexandre Défossez / Meta AI, MIT licence — see `LICENSE-demucs.txt`.
