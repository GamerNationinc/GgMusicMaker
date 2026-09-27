# Export HTDemucs (6 stems) to ONNX without its STFT/iSTFT (ONNX can't carry
# complex tensors); GgMusicMaker's Rust engine does those, plus the segment
# overlap-add, exactly as demucs.apply / htdemucs.py do.
#
#   core(mix [1,2,L], spec [1,4,2048,T])  ->  (spec_out [1,S,4,2048,T], time_out [1,S,2,L])
#
# spec is the "complex as channels" STFT of mix (re/im interleaved per channel,
# as HTDemucs._magnitude builds it); both outputs are already de-normalised.
# The engine turns spec_out back to audio (HTDemucs._ispec) and adds time_out.
import sys, json, math
import torch
from demucs.pretrained import get_model

name = sys.argv[1] if len(sys.argv) > 1 else "htdemucs_6s"
out = sys.argv[2] if len(sys.argv) > 2 else f"/out/{name}.onnx"

bag = get_model(name)
model = bag.models[0].eval()
assert len(bag.models) == 1, "bags of several models not supported"
L = int(model.segment * model.samplerate)


class Core(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, mix, mag):
        m = self.m
        x = mag
        B, C, Fq, T = x.shape
        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) / (1e-5 + std)
        xt = mix
        meant = xt.mean(dim=(1, 2), keepdim=True)
        stdt = xt.std(dim=(1, 2), keepdim=True)
        xt = (xt - meant) / (1e-5 + stdt)
        saved, saved_t, lengths, lengths_t = [], [], [], []
        for idx, encode in enumerate(m.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(m.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = m.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and m.freq_emb is not None:
                frs = torch.arange(x.shape[-2], device=x.device)
                emb = m.freq_emb(frs).t()[None, :, :, None].expand_as(x)
                x = x + m.freq_emb_scale * emb
            saved.append(x)
        if m.crosstransformer:
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_upsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_upsampler_t(xt)
            x, xt = m.crosstransformer(x, xt)
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_downsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_downsampler_t(xt)
        for idx, decode in enumerate(m.decoder):
            skip = saved.pop(-1)
            x, pre = decode(x, skip, lengths.pop(-1))
            offset = m.depth - len(m.tdecoder)
            if idx >= offset:
                tdec = m.tdecoder[idx - offset]
                length_t = lengths_t.pop(-1)
                if tdec.empty:
                    pre = pre[:, :, 0]
                    xt, _ = tdec(pre, None, length_t)
                else:
                    skip = saved_t.pop(-1)
                    xt, _ = tdec(xt, skip, length_t)
        S = len(m.sources)
        x = x.view(B, S, -1, Fq, T)
        x = x * std[:, None] + mean[:, None]
        xt = xt.view(B, S, -1, mix.shape[-1])
        xt = xt * stdt[:, None] + meant[:, None]
        return x, xt


core = Core(model).eval()
mix = torch.randn(1, 2, L)
with torch.no_grad():
    z = model._spec(mix)
    mag = model._magnitude(z)
    # Sanity: the split model equals the original.
    ref = model(mix)
    x, xt = core(mix, mag)
    back = model._ispec(model._mask(z, x), L) + xt
    print("split vs original max abs diff:", (back - ref).abs().max().item())

torch.onnx.export(
    core, (mix, mag), out,
    input_names=["mix", "spec"], output_names=["spec_out", "time_out"],
    opset_version=17, do_constant_folding=True,
)
meta = {
    "name": name, "sources": list(model.sources), "samplerate": model.samplerate,
    "channels": model.audio_channels, "segment_samples": L, "nfft": model.nfft,
    "hop": model.hop_length, "spec_frames": int(mag.shape[-1]), "spec_bins": int(mag.shape[-2]),
}
json.dump(meta, open(out.replace(".onnx", ".json"), "w"), indent=1)
print(json.dumps(meta))

import onnxruntime as ort
sess = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
o = sess.run(None, {"mix": mix.numpy(), "spec": mag.numpy()})
print("onnx vs torch spec_out max diff:", abs(o[0] - x.numpy()).max(), " time_out:", abs(o[1] - xt.numpy()).max())
