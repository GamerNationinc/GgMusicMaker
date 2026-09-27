import numpy as np, torch
from demucs.pretrained import get_model
m = get_model("htdemucs_6s").models[0]
rng = np.random.default_rng(0)
x = torch.tensor(rng.uniform(-1, 1, (1, 2, 343980)).astype(np.float32))
z = m._spec(x); mag = m._magnitude(z)
back = m._ispec(z, 343980)
print("torch roundtrip max err", (back - x).abs().max().item(), "interior", (back - x)[..., 5000:-5000].abs().max().item())
x.numpy().tofile("/out/stft_x.f32"); mag.numpy().tofile("/out/stft_spec.f32"); back.numpy().tofile("/out/stft_back.f32")
