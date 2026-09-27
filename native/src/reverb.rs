//! Reverb: the same synthesised impulse responses as src/audio/reverb.ts
//! (seeded, so identical), normalised the way Web Audio's ConvolverNode
//! does, run through a two-stage partitioned FFT convolver:
//!   head  taps 0..2048 in 128-sample blocks (latency 128 = one quantum)
//!   tail  taps 2048..end in 2048-sample blocks (computed exactly in time)
//! Stereo in (the bus's send, downmixed as Web Audio would), stereo out.

use realfft::{num_complex::Complex, ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

pub const LATENCY: usize = 128;
// Stages (block, first tap): each needs first tap ≥ block − LATENCY.
const STAGES: [(usize, usize); 3] = [(128, 0), (1024, 1024), (8192, 8192)];
const RING: usize = 32768;

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Space {
    Room,
    Hall,
    Plate,
}

impl Space {
    fn params(self) -> (f64, f64, u32) {
        match self {
            Space::Room => (0.8, 3.0, 0),
            Space::Hall => (2.6, 2.2, 1),
            Space::Plate => (1.4, 4.5, 2),
        }
    }
}

/// The IR, exactly as reverb.ts `impulseChannels` builds it.
pub fn impulse(space: Space, rate: f64) -> [Vec<f32>; 2] {
    let (seconds, decay, idx) = space.params();
    let length = ((rate * seconds).floor() as usize).max(1);
    let mk = |ch: u32| {
        let mut s: u32 = 0x7e5e_0000u32.wrapping_add(idx * 16 + ch);
        let mut last = 0f64;
        (0..length)
            .map(|i| {
                let env = (1.0 - i as f64 / length as f64).powf(decay);
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;
                let white = (s as f64 / 4_294_967_296.0) * 2.0 - 1.0;
                last = last * 0.2 + white * 0.8;
                (last * env) as f32
            })
            .collect::<Vec<f32>>()
    };
    [mk(0), mk(1)]
}

/// Web Audio ConvolverNode normalisation (spec: calculateNormalizationScale).
pub fn normalization_scale(ir: &[Vec<f32>], rate: f64) -> f64 {
    let len = ir[0].len();
    let mut power: f64 = ir.iter().flat_map(|c| c.iter()).map(|&v| v as f64 * v as f64).sum();
    power = (power / (ir.len() * len) as f64).sqrt();
    if !power.is_finite() || power < 0.000125 {
        power = 0.000125;
    }
    (1.0 / power) * 0.00125 * (44100.0 / rate)
}

/// One uniformly-partitioned overlap-save stage over IR taps [off, end),
/// on real FFTs (half the bins of a complex one).
struct Stage {
    b: usize,
    off: usize,
    fft: Arc<dyn RealToComplex<f64>>,
    ifft: Arc<dyn ComplexToReal<f64>>,
    parts: Vec<Vec<Complex<f64>>>,
    fdl: Vec<Vec<Complex<f64>>>,
    fdl_pos: usize,
    input: Vec<f64>, // last 2B input samples (previous block, current block)
    fill: usize,
    block: u64,
    time_buf: Vec<f64>,
    acc: Vec<Complex<f64>>,
    out: Vec<f64>,
    scratch_f: Vec<Complex<f64>>,
    scratch_i: Vec<Complex<f64>>,
    /// Blocks until this stage's output is certainly silent again: an
    /// all-zero input block then costs nothing (no FFT, no multiply-adds).
    live: usize,
    block_nonzero: bool,
}

impl Stage {
    fn new(planner: &mut RealFftPlanner<f64>, ir: &[f32], scale: f64, b: usize, off: usize, end: usize) -> Option<Self> {
        if off >= ir.len() {
            return None;
        }
        let end = end.min(ir.len());
        let n = 2 * b;
        let fft = planner.plan_fft_forward(n);
        let ifft = planner.plan_fft_inverse(n);
        let mut parts = Vec::new();
        let mut start = off;
        let mut tb = vec![0.0; n];
        let mut sf = fft.make_scratch_vec();
        while start < end {
            tb.fill(0.0);
            for i in 0..b.min(end - start) {
                tb[i] = ir[start + i] as f64 * scale;
            }
            let mut spec = fft.make_output_vec();
            fft.process_with_scratch(&mut tb, &mut spec, &mut sf).expect("fft");
            parts.push(spec);
            start += b;
        }
        let p = parts.len();
        let bins = n / 2 + 1;
        Some(Stage {
            b,
            off,
            scratch_f: sf,
            scratch_i: ifft.make_scratch_vec(),
            fft,
            ifft,
            parts,
            fdl: vec![vec![Complex::new(0.0, 0.0); bins]; p],
            fdl_pos: 0,
            input: vec![0.0; n],
            fill: 0,
            block: 0,
            time_buf: vec![0.0; n],
            acc: vec![Complex::new(0.0, 0.0); bins],
            out: vec![0.0; n],
            live: 0,
            block_nonzero: false,
        })
    }

    /// Push one sample; when a block completes, add its output block to
    /// `ring` at absolute time block·B + off.
    #[inline]
    fn push(&mut self, x: f64, ring: &mut [f64]) {
        let b = self.b;
        self.input[b + self.fill] = x;
        if x != 0.0 {
            self.block_nonzero = true;
        }
        self.fill += 1;
        if self.fill < b {
            return;
        }
        self.fill = 0;
        let n = 2 * b;
        let p = self.parts.len();
        let prev_nonzero = self.input[..b].iter().any(|&v| v != 0.0);
        if self.block_nonzero || prev_nonzero {
            self.live = p + 1;
        }
        if self.live == 0 {
            // Silent in, silent FDL: nothing to do but keep time.
            self.input.copy_within(b..n, 0);
            self.block += 1;
            self.block_nonzero = false;
            return;
        }
        self.time_buf.copy_from_slice(&self.input);
        let slot = &mut self.fdl[self.fdl_pos];
        self.fft.process_with_scratch(&mut self.time_buf, slot, &mut self.scratch_f).expect("fft");
        for v in self.acc.iter_mut() {
            *v = Complex::new(0.0, 0.0);
        }
        for j in 0..p {
            let x = &self.fdl[(self.fdl_pos + p - j) % p];
            let h = &self.parts[j];
            for (a, (xv, hv)) in self.acc.iter_mut().zip(x.iter().zip(h.iter())) {
                *a += xv * hv;
            }
        }
        self.fdl_pos = (self.fdl_pos + 1) % p;
        let last = self.acc.len() - 1;
        self.acc[0].im = 0.0;
        self.acc[last].im = 0.0;
        self.ifft.process_with_scratch(&mut self.acc, &mut self.out, &mut self.scratch_i).expect("ifft");
        let at = self.block as usize * b + self.off;
        let norm = 1.0 / n as f64;
        for i in 0..b {
            ring[(at + i) % RING] += self.out[b + i] * norm;
        }
        self.input.copy_within(b..n, 0);
        self.block += 1;
        self.block_nonzero = false;
        self.live -= 1;
        if self.live == 0 {
            for f in self.fdl.iter_mut() {
                f.fill(Complex::new(0.0, 0.0));
            }
        }
    }
}

pub struct Reverb {
    stages: [Vec<Stage>; 2],
    rings: [Vec<f64>; 2],
    t: u64,
    pub space: Space,
}

impl Reverb {
    pub fn new(space: Space, rate: f64) -> Self {
        let ir = impulse(space, rate);
        let scale = normalization_scale(&ir, rate);
        let mut planner = RealFftPlanner::new();
        let mk = |ch: usize, planner: &mut RealFftPlanner<f64>| {
            let mut v = Vec::new();
            for (k, &(b, off)) in STAGES.iter().enumerate() {
                let end = STAGES.get(k + 1).map(|s| s.1).unwrap_or(usize::MAX);
                if let Some(s) = Stage::new(planner, &ir[ch], scale, b, off, end) {
                    v.push(s);
                }
            }
            v
        };
        let s0 = mk(0, &mut planner);
        let s1 = mk(1, &mut planner);
        Reverb { stages: [s0, s1], rings: [vec![0.0; RING], vec![0.0; RING]], t: 0, space }
    }

    /// One stereo sample in, one out (the wet signal, LATENCY samples late).
    #[inline]
    pub fn step(&mut self, l: f64, r: f64) -> (f64, f64) {
        let x = [l, r];
        let mut y = [0.0; 2];
        for ch in 0..2 {
            let ring = &mut self.rings[ch];
            for s in self.stages[ch].iter_mut() {
                s.push(x[ch], ring);
            }
            // Head block k lands at k·128; it is complete at (k+1)·128, so we
            // read one quantum behind.
            let rd = (self.t as usize + RING - LATENCY) % RING;
            y[ch] = ring[rd];
            ring[rd] = 0.0;
        }
        self.t += 1;
        (y[0], y[1])
    }
}
