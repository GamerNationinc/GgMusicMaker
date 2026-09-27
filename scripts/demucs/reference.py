# Reference separation with the real PyTorch Demucs (shifts=0 so it is
# deterministic), for checking the Rust engine sample by sample.
#   writes /out/ref_in.f32 (2 x N, planar) and /out/ref_out.f32 (S x 2 x N)
import sys, numpy as np, torch
from demucs.pretrained import get_model
from demucs.apply import apply_model
from demucs.audio import AudioFile
bag = get_model("htdemucs_6s")
wav = AudioFile(sys.argv[1]).read(streams=0, samplerate=44100, channels=2)
secs = float(sys.argv[2]) if len(sys.argv) > 2 else 0
if secs: wav = wav[:, : int(secs * 44100)]
wav.numpy().astype(np.float32).tofile("/out/ref_in.f32")
ref = wav.mean(0)
x = (wav - ref.mean()) / ref.std()
torch.set_num_threads(6)
with torch.no_grad():
    s = apply_model(bag, x[None], shifts=0, split=True, overlap=0.25)[0]
s = s * ref.std() + ref.mean()
s.numpy().astype(np.float32).tofile("/out/ref_out.f32")
print("N", wav.shape[-1], "sources", bag.sources, "rms", [round(float(v), 4) for v in s.pow(2).mean(dim=(1, 2)).sqrt()])
