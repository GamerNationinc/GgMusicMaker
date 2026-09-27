import numpy as np
S = ["drums", "bass", "other", "vocals", "guitar", "piano"]
truth = np.load("/eval/truth.npy", allow_pickle=True).item()
mix = np.fromfile("/eval/mix.f32", dtype=np.float32).reshape(2, -1)
est = np.fromfile("/eval/stems.f32", dtype=np.float32).reshape(len(S), 2, -1)
def sdr(ref, e): return 10 * np.log10((ref**2).sum() / max(((ref - e) ** 2).sum(), 1e-12))
print(f"{'stem':>7}  {'SDR':>6}  {'EQ-only baseline*':>18}")
for i, s in enumerate(S):
    t = truth[s]
    if (t**2).mean() < 1e-7: print(f"{s:>7}  (silent in this song)"); continue
    # *baseline: the mix itself, best-scaled: what "just turn the rest down" gets.
    a = (t * mix).sum() / (mix * mix).sum()
    print(f"{s:>7}  {sdr(t, est[i]):6.1f}  {sdr(t, a * mix):18.1f}")
print("sum of stems vs mix:", round(sdr(mix, est.sum(0)), 1), "dB")
res = mix - est.sum(0)
print("other with the residual folded in:", round(sdr(truth["other"], est[2] + res), 1), "dB (vs", round(sdr(truth["other"], est[2]), 1), ")")
print("residual level", round(float(np.sqrt((res**2).mean())), 5), "mix", round(float(np.sqrt((mix**2).mean())), 4))
