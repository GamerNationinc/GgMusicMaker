# Mix real multitrack stems into a song excerpt, and group the true stems the
# way HTDemucs names them, to score a separation (SDR, higher = cleaner).
import sys, glob, os, numpy as np, soundfile as sf
src, start, secs = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
groups = {"vocals": ["Lead Vocals", "Backing Vocals"], "drums": ["Drums", "Percussion"], "bass": ["Bass"],
          "guitar": ["Guitar"], "piano": ["Keyboard"]}
tracks = {}
for f in sorted(glob.glob(os.path.join(src, "*.wav"))):
    name = os.path.basename(f)[:-4].split(" ", 1)[1]
    a, sr = sf.read(f, dtype="float32", always_2d=True)
    a = a[int(start * sr): int((start + secs) * sr)].T
    if sr != 44100:
        import torch, julius
        a = julius.resample_frac(torch.from_numpy(np.ascontiguousarray(a)), sr, 44100).numpy()
    tracks[name] = a if a.shape[0] == 2 else np.repeat(a, 2, 0)
mix = sum(tracks.values())
peak = np.abs(mix).max(); g = 0.9 / peak if peak > 0.9 else 1.0
mix *= g
truth = {k: sum(tracks[n] for n in v if n in tracks) * g for k, v in groups.items()}
used = {n for v in groups.values() for n in v}
truth["other"] = sum(t for n, t in tracks.items() if n not in used) * g
mix.astype(np.float32).tofile("/eval/mix.f32")
np.save("/eval/truth.npy", {k: v.astype(np.float32) for k, v in truth.items()})
print("mixed", list(tracks), "->", {k: round(float(np.sqrt((v**2).mean())), 4) for k, v in truth.items()})
