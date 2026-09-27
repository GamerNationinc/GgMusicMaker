//! Stem separation: split a finished mix into vocals / drums / bass / guitar /
//! piano / other with HTDemucs (Demucs v4, Meta, MIT licence) — a neural
//! network trained on real multitrack recordings. It hears instruments, not
//! frequency bands, so a bass line and a kick drum in the same range still
//! come apart.
//!
//! Runs as its own program (src/main.rs, `ggmm-separate`), not inside the
//! app: ONNX Runtime's allocations crash Electron's allocator, and a crash
//! or out-of-memory here must never take the user's session down with it.
//!
//! The network core runs in ONNX Runtime (`models/htdemucs_6s.onnx`, exported
//! by scripts/export-demucs.sh). ONNX can't carry complex numbers, so the
//! STFT going in and the inverse STFT coming out are done here, along with
//! the 7.8 s segment overlap-add — each step mirrors demucs/htdemucs.py and
//! demucs/apply.py line for line (checked against PyTorch sample by sample,
//! the ignored parity tests below).
//!
//! Everything here is 44.1 kHz stereo, the rate the model was trained at; the
//! page resamples in and out.

use realfft::num_complex::Complex32;
use realfft::RealFftPlanner;
use std::path::Path;

pub const SAMPLE_RATE: u32 = 44_100;
pub const NFFT: usize = 4096;
pub const HOP: usize = 1024;
/// Frequency bins the model sees (the Nyquist bin is dropped).
pub const BINS: usize = NFFT / 2;

/// What the exported model was built for (models/<name>.json).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ModelMeta {
    pub name: String,
    pub sources: Vec<String>,
    pub samplerate: u32,
    pub channels: usize,
    /// Samples per segment (7.8 s at 44.1 kHz = 343 980).
    pub segment_samples: usize,
    pub nfft: usize,
    pub hop: usize,
    pub spec_frames: usize,
    pub spec_bins: usize,
}

// ---- STFT / iSTFT, exactly as HTDemucs._spec / _ispec ---------------------

/// Periodic Hann window (torch.hann_window default).
fn hann(n: usize) -> Vec<f32> {
    (0..n).map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos()) as f32).collect()
}

/// torch.nn.functional.pad(mode="reflect") on one channel (edge not repeated).
fn reflect_pad(x: &[f32], left: usize, right: usize) -> Vec<f32> {
    let n = x.len();
    assert!(left < n && right < n, "reflect pad larger than the signal");
    let mut out = Vec::with_capacity(n + left + right);
    out.extend((0..left).map(|i| x[left - i]));
    out.extend_from_slice(x);
    out.extend((0..right).map(|j| x[n - 2 - j]));
    out
}

/// Frames the model sees for `len` samples.
pub fn frames_for(len: usize) -> usize {
    len.div_ceil(HOP)
}

/// HTDemucs._spec + _magnitude(cac): the "complex as channels" spectrogram
/// of a stereo segment, laid out [channel*2 + re/im][bin][frame].
pub fn spec(mix: &[Vec<f32>; 2]) -> Vec<f32> {
    let len = mix[0].len();
    let le = frames_for(len);
    let pad = HOP / 2 * 3;
    let window = hann(NFFT);
    let scale = 1.0 / (NFFT as f32).sqrt(); // normalized=True
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(NFFT);
    let mut frame = fft.make_input_vec();
    let mut bins = fft.make_output_vec();
    let mut out = vec![0.0f32; 4 * BINS * le];
    for (c, x) in mix.iter().enumerate() {
        // _spec's own padding, then torch.stft(center=True)'s reflect padding.
        let x = reflect_pad(x, pad, pad + le * HOP - len);
        let x = reflect_pad(&x, NFFT / 2, NFFT / 2);
        // stft gives le + 4 frames; _spec keeps [2, 2 + le).
        for t in 0..le {
            let start = (t + 2) * HOP;
            for i in 0..NFFT {
                frame[i] = x[start + i] * window[i];
            }
            fft.process(&mut frame, &mut bins).expect("fft");
            for f in 0..BINS {
                out[((c * 2) * BINS + f) * le + t] = bins[f].re * scale;
                out[((c * 2 + 1) * BINS + f) * le + t] = bins[f].im * scale;
            }
        }
    }
    out
}

/// HTDemucs._mask(cac) + _ispec: one source's spectrogram back to `len`
/// samples of stereo audio. `z` is [channel*2 + re/im][bin][frame].
pub fn ispec(z: &[f32], len: usize) -> [Vec<f32>; 2] {
    let le = frames_for(len);
    assert_eq!(z.len(), 4 * BINS * le);
    let pad = HOP / 2 * 3;
    let frames = le + 4; // zero frames added either side
    let full = NFFT + HOP * (frames - 1);
    let window = hann(NFFT);
    // normalized=True undoes the forward 1/sqrt(n); irfft divides by n.
    let scale = (NFFT as f32).sqrt() / NFFT as f32;
    let mut planner = RealFftPlanner::<f32>::new();
    let ifft = planner.plan_fft_inverse(NFFT);
    let mut bins = ifft.make_input_vec();
    let mut frame = ifft.make_output_vec();
    // Window-squared envelope for the overlap-add (istft's NOLA division).
    let mut env = vec![0.0f32; full];
    for t in 0..frames {
        for i in 0..NFFT {
            env[t * HOP + i] += window[i] * window[i];
        }
    }
    let mut out: [Vec<f32>; 2] = [Vec::new(), Vec::new()];
    for (c, o) in out.iter_mut().enumerate() {
        let mut y = vec![0.0f32; full];
        for t in 2..2 + le {
            for f in 0..BINS {
                bins[f] = Complex32::new(z[((c * 2) * BINS + f) * le + t - 2], z[((c * 2 + 1) * BINS + f) * le + t - 2]);
            }
            bins[BINS] = Complex32::new(0.0, 0.0); // the dropped Nyquist bin
            bins[0].im = 0.0; // irfft ignores it too
            ifft.process(&mut bins, &mut frame).expect("ifft");
            for i in 0..NFFT {
                y[t * HOP + i] += frame[i] * scale * window[i];
            }
        }
        // center=True trims n_fft/2; _ispec then trims its own pad.
        let start = NFFT / 2 + pad;
        *o = (0..len)
            .map(|i| {
                let k = start + i;
                if env[k] > 1e-11 { y[k] / env[k] } else { y[k] }
            })
            .collect();
    }
    out
}

// ---- segmenting, as demucs.apply.apply_model(split=True, shifts=0) --------

/// The triangular cross-fade weight for one segment (transition_power = 1).
pub fn segment_weight(seg: usize) -> Vec<f32> {
    let half = seg / 2;
    let w: Vec<f64> = (1..=half).map(|v| v as f64).chain((1..=seg - half).rev().map(|v| v as f64)).collect();
    let max = w.iter().cloned().fold(0.0, f64::max);
    w.into_iter().map(|v| (v / max) as f32).collect()
}

/// Segment start offsets for a track of `len` samples (25 % overlap).
pub fn segment_offsets(len: usize, seg: usize) -> Vec<usize> {
    let stride = (0.75 * seg as f64) as usize;
    (0..len).step_by(stride).collect()
}

/// TensorChunk(mix, offset, seg).padded(seg): the chunk centred in a full
/// segment, borrowing real neighbouring audio where there is some and zeros
/// past either end. Returns the padded audio and the chunk's own length.
pub fn padded_chunk(mix: &[Vec<f32>; 2], offset: usize, seg: usize) -> ([Vec<f32>; 2], usize) {
    let total = mix[0].len();
    let length = seg.min(total - offset);
    let delta = seg - length;
    let start = offset as isize - (delta / 2) as isize;
    let take = |x: &Vec<f32>| -> Vec<f32> {
        (0..seg as isize)
            .map(|i| {
                let k = start + i;
                if k >= 0 && (k as usize) < total { x[k as usize] } else { 0.0 }
            })
            .collect()
    };
    ([take(&mix[0]), take(&mix[1])], length)
}

/// Mean and (unbiased) standard deviation of the mono mix — separate.py
/// normalises the whole track by these before separating.
pub fn track_stats(mix: &[Vec<f32>; 2]) -> (f32, f32) {
    let n = mix[0].len() as f64;
    let mono: Vec<f64> = (0..mix[0].len()).map(|i| (mix[0][i] as f64 + mix[1][i] as f64) / 2.0).collect();
    let mean = mono.iter().sum::<f64>() / n;
    let var = mono.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1.0).max(1.0);
    (mean as f32, var.sqrt() as f32)
}

// ---- the model ------------------------------------------------------------

pub struct Demucs {
    session: ort::session::Session,
    pub meta: ModelMeta,
}

/// One separated source: its name and stereo audio at 44.1 kHz.
pub struct Stem {
    pub name: String,
    pub audio: [Vec<f32>; 2],
}

impl Demucs {
    /// Load `<dir>/<name>.onnx` + `.json`. `threads` = 0 picks a default that
    /// leaves the audio thread and the UI room to breathe.
    pub fn load(dir: &Path, name: &str, threads: usize) -> Result<Self, String> {
        let meta_path = dir.join(format!("{name}.json"));
        let meta: ModelMeta = serde_json::from_slice(&std::fs::read(&meta_path).map_err(|e| format!("{}: {e}", meta_path.display()))?)
            .map_err(|e| format!("{}: {e}", meta_path.display()))?;
        if meta.samplerate != SAMPLE_RATE || meta.nfft != NFFT || meta.hop != HOP || meta.channels != 2 || meta.spec_bins != BINS {
            return Err(format!("unsupported model layout: {meta:?}"));
        }
        let threads = if threads > 0 {
            threads
        } else {
            std::thread::available_parallelism().map(|n| n.get().saturating_sub(2).max(1)).unwrap_or(2)
        };
        let model_path = dir.join(format!("{name}.onnx"));
        let session = ort::session::Session::builder()
            .and_then(|b| b.with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3))
            .and_then(|b| b.with_intra_threads(threads))
            .and_then(|b| b.commit_from_file(&model_path))
            .map_err(|e| format!("{}: {e}", model_path.display()))?;
        Ok(Demucs { session, meta })
    }

    /// Run the network on one full segment (already normalised).
    /// Returns [source][channel] audio of `segment_samples`.
    fn run_segment(&mut self, chunk: &[Vec<f32>; 2]) -> Result<Vec<[Vec<f32>; 2]>, String> {
        let seg = self.meta.segment_samples;
        let le = frames_for(seg);
        let z = spec(chunk);
        let mut mix = Vec::with_capacity(2 * seg);
        mix.extend_from_slice(&chunk[0]);
        mix.extend_from_slice(&chunk[1]);
        let err = |e: ort::Error| e.to_string();
        let mix = ort::value::Tensor::from_array(([1usize, 2, seg], mix)).map_err(err)?;
        let zin = ort::value::Tensor::from_array(([1usize, 4, BINS, le], z)).map_err(err)?;
        let outputs = self.session.run(ort::inputs!["mix" => mix, "spec" => zin]).map_err(err)?;
        let (_, spec_out) = outputs["spec_out"].try_extract_tensor::<f32>().map_err(err)?;
        let (_, time_out) = outputs["time_out"].try_extract_tensor::<f32>().map_err(err)?;
        let s_count = self.meta.sources.len();
        let per_source = 4 * BINS * le;
        let mut stems = Vec::with_capacity(s_count);
        for s in 0..s_count {
            let mut audio = ispec(&spec_out[s * per_source..(s + 1) * per_source], seg);
            for (c, ch) in audio.iter_mut().enumerate() {
                let t = &time_out[(s * 2 + c) * seg..(s * 2 + c + 1) * seg];
                for (a, b) in ch.iter_mut().zip(t) {
                    *a += b;
                }
            }
            stems.push(audio);
        }
        Ok(stems)
    }

    /// Separate a whole stereo track at 44.1 kHz. `progress(done_fraction)`
    /// returns false to cancel (the call then returns Err("cancelled")).
    pub fn separate(&mut self, input: &[Vec<f32>; 2], mut progress: impl FnMut(f32) -> bool) -> Result<Vec<Stem>, String> {
        let total = input[0].len();
        if total == 0 {
            return Err("nothing to separate".into());
        }
        let seg = self.meta.segment_samples;
        let (mean, std) = track_stats(input);
        let std = if std > 0.0 { std } else { 1.0 };
        let norm: [Vec<f32>; 2] = [
            input[0].iter().map(|v| (v - mean) / std).collect(),
            input[1].iter().map(|v| (v - mean) / std).collect(),
        ];
        let weight = segment_weight(seg);
        let offsets = segment_offsets(total, seg);
        let s_count = self.meta.sources.len();
        let mut out: Vec<[Vec<f32>; 2]> = (0..s_count).map(|_| [vec![0.0; total], vec![0.0; total]]).collect();
        let mut sum_weight = vec![0.0f32; total];
        for (n, &offset) in offsets.iter().enumerate() {
            if !progress(n as f32 / offsets.len() as f32) {
                return Err("cancelled".into());
            }
            let (chunk, length) = padded_chunk(&norm, offset, seg);
            let res = self.run_segment(&chunk)?;
            // center_trim back to the chunk's own length.
            let trim = (seg - length) / 2;
            for (s, stem) in res.iter().enumerate() {
                for c in 0..2 {
                    let dst = &mut out[s][c][offset..offset + length];
                    let src = &stem[c][trim..trim + length];
                    for i in 0..length {
                        dst[i] += weight[i] * src[i];
                    }
                }
            }
            for i in 0..length {
                sum_weight[offset + i] += weight[i];
            }
        }
        progress(1.0);
        Ok(out
            .into_iter()
            .zip(&self.meta.sources)
            .map(|(mut audio, name)| {
                for ch in audio.iter_mut() {
                    for (v, w) in ch.iter_mut().zip(&sum_weight) {
                        *v = *v / w * std + mean;
                    }
                }
                Stem { name: name.clone(), audio }
            })
            .collect())
    }
}

/// Put whatever the network didn't assign anywhere into "other", so the
/// stems add back up to the original exactly: with every stem playing, the
/// user hears the song they imported, bit for bit (up to float rounding).
pub fn fold_residual(input: &[Vec<f32>; 2], stems: &mut [Stem]) {
    let Some(other) = stems.iter().position(|s| s.name == "other") else { return };
    for c in 0..2 {
        for i in 0..input[c].len() {
            let sum: f32 = stems.iter().map(|s| s.audio[c][i]).sum();
            stems[other].audio[c][i] += input[c][i] - sum;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(n: usize, seed: u32) -> Vec<f32> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (s >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
            })
            .collect()
    }

    #[test]
    fn ispec_inverts_spec_away_from_the_edges() {
        // Like HTDemucs itself, the round trip drops the Nyquist bin and the
        // edge frames, so it's exact only for band-limited audio away from
        // the ends (PyTorch: 0.5 at the edges, 0.02 inside for white noise).
        for len in [343_980, 44_100, 12_000] {
            let tone = |f: f32, ph: f32| (0..len).map(|i| (i as f32 * f * 2.0 * std::f32::consts::PI / 44_100.0 + ph).sin() * 0.5).collect::<Vec<f32>>();
            let x = [tone(440.0, 0.0), tone(3_000.0, 1.0)];
            let back = ispec(&spec(&x), len);
            for c in 0..2 {
                let err = x[c][4_000..len - 4_000].iter().zip(&back[c][4_000..len - 4_000]).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
                assert!(err < 1e-4, "len {len} ch {c}: max err {err}");
            }
        }
    }

    /// spec and ispec against torch's own _spec/_magnitude/_ispec output
    /// (scripts/export-demucs.sh writes stft_*.f32).
    #[test]
    #[ignore]
    fn parity_stft_with_pytorch() {
        let refs = std::path::PathBuf::from(std::env::var("GGMM_REF_DIR").expect("GGMM_REF_DIR"));
        let read = |f: &str| -> Vec<f32> {
            std::fs::read(refs.join(f)).unwrap().chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
        };
        let (x, zr, backr) = (read("stft_x.f32"), read("stft_spec.f32"), read("stft_back.f32"));
        let n = x.len() / 2;
        let z = spec(&[x[..n].to_vec(), x[n..].to_vec()]);
        let zerr = z.iter().zip(&zr).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
        let zmax = zr.iter().map(|v| v.abs()).fold(0.0, f32::max);
        println!("spec: max err {zerr:e} (peak {zmax})");
        assert!(zerr < 1e-4 * zmax.max(1.0));
        let back = ispec(&zr, n);
        let berr = back[0].iter().chain(&back[1]).zip(&backr).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
        println!("ispec: max err {berr:e}");
        assert!(berr < 1e-4);
    }

    #[test]
    fn spec_has_the_models_shape() {
        let x = [noise(343_980, 3), noise(343_980, 4)];
        assert_eq!(frames_for(343_980), 336);
        assert_eq!(spec(&x).len(), 4 * 2048 * 336);
    }

    #[test]
    fn spec_matches_a_direct_dft() {
        // One frame, one bin, computed the slow way (torch.stft semantics).
        let len = 20_000;
        let x = [noise(len, 5), noise(len, 6)];
        let z = spec(&x);
        let le = frames_for(len);
        let pad = HOP / 2 * 3;
        let p1 = reflect_pad(&x[1], pad, pad + le * HOP - len);
        let p2 = reflect_pad(&p1, NFFT / 2, NFFT / 2);
        let w = hann(NFFT);
        let (t, f) = (7usize, 100usize);
        let (mut re, mut im) = (0.0f64, 0.0f64);
        for i in 0..NFFT {
            let v = (p2[(t + 2) * HOP + i] * w[i]) as f64;
            let a = -2.0 * std::f64::consts::PI * (f * i) as f64 / NFFT as f64;
            re += v * a.cos();
            im += v * a.sin();
        }
        let s = 1.0 / (NFFT as f64).sqrt();
        assert!((z[(2 * BINS + f) * le + t] as f64 - re * s).abs() < 1e-3);
        assert!((z[(3 * BINS + f) * le + t] as f64 - im * s).abs() < 1e-3);
    }

    /// Against the real PyTorch Demucs (scripts/export-demucs.sh writes the
    /// model and the reference files). Needs the model, so opt-in:
    ///   GGMM_MODEL_DIR=… GGMM_REF_DIR=… cargo test --release -- --ignored parity
    #[test]
    #[ignore]
    fn parity_with_pytorch() {
        let dir = std::env::var("GGMM_MODEL_DIR").expect("GGMM_MODEL_DIR");
        let refs = std::path::PathBuf::from(std::env::var("GGMM_REF_DIR").expect("GGMM_REF_DIR"));
        let read = |f: &str| -> Vec<f32> {
            std::fs::read(refs.join(f)).unwrap().chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
        };
        let inp = read("ref_in.f32");
        let n = inp.len() / 2;
        let input = [inp[..n].to_vec(), inp[n..].to_vec()];
        let reference = read("ref_out.f32");
        let mut m = Demucs::load(std::path::Path::new(&dir), "htdemucs_6s", 0).unwrap();
        let t0 = std::time::Instant::now();
        let stems = m.separate(&input, |_| true).unwrap();
        let secs = t0.elapsed().as_secs_f64();
        println!("separated {:.1} s of audio in {:.1} s", n as f64 / 44_100.0, secs);
        for (s, stem) in stems.iter().enumerate() {
            let (mut sig, mut err) = (0.0f64, 0.0f64);
            for c in 0..2 {
                let r = &reference[(s * 2 + c) * n..(s * 2 + c + 1) * n];
                for (a, b) in stem.audio[c].iter().zip(r) {
                    sig += (*b as f64).powi(2);
                    err += (*a as f64 - *b as f64).powi(2);
                }
            }
            let snr = 10.0 * (sig / err.max(1e-20)).log10();
            println!("{:>7}: rms {:.4}, match vs PyTorch {:.1} dB", stem.name, (sig / (2 * n) as f64).sqrt(), snr);
            assert!(snr > 40.0, "{} differs from PyTorch: {snr:.1} dB", stem.name);
        }
    }

    /// Separate any planar f32 stereo file: GGMM_SEP_IN → GGMM_SEP_OUT
    /// (S × 2 × N planar), for listening tests and quality scoring.
    #[test]
    #[ignore]
    fn separate_raw_file() {
        let dir = std::env::var("GGMM_MODEL_DIR").expect("GGMM_MODEL_DIR");
        let raw: Vec<f32> = std::fs::read(std::env::var("GGMM_SEP_IN").expect("GGMM_SEP_IN"))
            .unwrap()
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        let n = raw.len() / 2;
        let mut m = Demucs::load(std::path::Path::new(&dir), "htdemucs_6s", 0).unwrap();
        let t0 = std::time::Instant::now();
        let stems = m.separate(&[raw[..n].to_vec(), raw[n..].to_vec()], |_| true).unwrap();
        println!("separated {:.1} s in {:.1} s", n as f64 / 44_100.0, t0.elapsed().as_secs_f64());
        let mut out = Vec::with_capacity(stems.len() * 2 * n * 4);
        for s in &stems {
            for c in &s.audio {
                for v in c {
                    out.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
        std::fs::write(std::env::var("GGMM_SEP_OUT").expect("GGMM_SEP_OUT"), out).unwrap();
    }

    #[test]
    fn stems_sum_back_to_the_mix_after_folding() {
        let input = [vec![0.5, -0.25, 0.1], vec![0.0, 0.3, -0.7]];
        let stem = |name: &str, v: f32| Stem { name: name.into(), audio: [vec![v; 3], vec![v; 3]] };
        let mut stems = vec![stem("drums", 0.1), stem("other", 0.05), stem("vocals", -0.2)];
        fold_residual(&input, &mut stems);
        for c in 0..2 {
            for i in 0..3 {
                let sum: f32 = stems.iter().map(|s| s.audio[c][i]).sum();
                assert!((sum - input[c][i]).abs() < 1e-6);
            }
        }
        assert_eq!(stems[0].audio[0], vec![0.1; 3], "only other changes");
    }

    #[test]
    fn reflect_pad_matches_torch() {
        assert_eq!(reflect_pad(&[1.0, 2.0, 3.0, 4.0], 2, 3), vec![3.0, 2.0, 1.0, 2.0, 3.0, 4.0, 3.0, 2.0, 1.0]);
    }

    #[test]
    fn segment_weights_are_a_triangle_peaking_at_one() {
        let w = segment_weight(10);
        assert_eq!(w.len(), 10);
        assert_eq!(w[0], 0.2);
        assert_eq!(w[4], 1.0);
        assert_eq!(w[5], 1.0);
        assert_eq!(w[9], 0.2);
    }

    #[test]
    fn segments_cover_the_track_with_overlap() {
        assert_eq!(segment_offsets(1_000_000, 343_980), vec![0, 257_985, 515_970, 773_955]);
        assert_eq!(segment_offsets(100, 343_980), vec![0]);
    }

    #[test]
    fn padded_chunk_centres_and_borrows_neighbours() {
        let x: Vec<f32> = (0..10).map(|v| v as f32).collect();
        let mix = [x.clone(), x];
        // Last chunk of 4 samples at offset 6, padded to 8: 2 samples of real
        // audio borrowed on the left, zeros past the end.
        let (p, len) = padded_chunk(&mix, 6, 8);
        assert_eq!(len, 4);
        assert_eq!(p[0], vec![4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 0.0, 0.0]);
        // A short track: zeros both sides.
        let (p, len) = padded_chunk(&[vec![1.0, 2.0], vec![1.0, 2.0]], 0, 6);
        assert_eq!(len, 2);
        assert_eq!(p[0], vec![0.0, 0.0, 1.0, 2.0, 0.0, 0.0]);
    }
}
