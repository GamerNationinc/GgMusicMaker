//! Helpers shared by the worklet ports. The JS worklets keep much of their
//! state in Float32Arrays; the ports store the same values as f32 (rounding
//! on every store) and compute in f64 like JS numbers, so they track the web
//! engine sample for sample (see src/audio/native-engine.test.ts).

pub const TAU: f64 = std::f64::consts::PI * 2.0;
pub const DEG: f64 = std::f64::consts::PI / 180.0;
pub const MAX_CH: usize = 8;

/// JS Math.round: halves round towards +∞.
#[inline]
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

#[inline]
pub fn semis(n: f64) -> f64 {
    2f64.powf(n / 12.0)
}

#[inline]
pub fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// Transparent below 0.8, tanh knee, never beyond ±1 (all worklets use it).
#[inline]
pub fn soft_clip(y: f64) -> f64 {
    let a = y.abs();
    if a <= 0.8 {
        return y;
    }
    let k = 0.8 + 0.2 * ((a - 0.8) / 0.2).tanh();
    if y < 0.0 {
        -k
    } else {
        k
    }
}

/// xorshift32, bit-identical to the worklets' `Rng`.
#[derive(Clone)]
pub struct Rng(u32);
impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(if seed == 0 { 0x9e37_79b9 } else { seed })
    }
    #[inline]
    pub fn next(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x as f64 / 4_294_967_296.0
    }
    #[inline]
    pub fn bipolar(&mut self) -> f64 {
        self.next() * 2.0 - 1.0
    }
}

/// RBJ constant-0 dB-peak bandpass, TDF-II (the worklets' `Bandpass`).
#[derive(Clone, Copy, Default)]
pub struct Bandpass {
    b0: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}
impl Bandpass {
    /// `freq` is used as given (callers clamp the way their worklet does).
    pub fn set(&mut self, freq: f64, q: f64, sr: f64) {
        let w0 = TAU * freq / sr;
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        self.b0 = alpha / a0;
        self.b2 = -alpha / a0;
        self.a1 = -2.0 * w0.cos() / a0;
        self.a2 = (1.0 - alpha) / a0;
    }
    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = -self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

/// 2nd-order Butterworth low-pass (the synth's LFE send).
#[derive(Clone, Copy)]
pub struct Lowpass {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    pub z1: f64,
    pub z2: f64,
}
impl Lowpass {
    pub fn new(freq: f64, sr: f64) -> Self {
        let w0 = TAU * freq / sr;
        let alpha = w0.sin() / std::f64::consts::SQRT_2;
        let cw = w0.cos();
        let a0 = 1.0 + alpha;
        let b0 = (1.0 - cw) / 2.0 / a0;
        Lowpass { b0, b1: (1.0 - cw) / a0, b2: b0, a1: -2.0 * cw / a0, a2: (1.0 - alpha) / a0, z1: 0.0, z2: 0.0 }
    }
    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// Schroeder all-pass with an f32 line (the worklets' `AllPass`).
#[derive(Clone)]
pub struct AllPass {
    pub buf: Vec<f32>,
    i: usize,
    g: f64,
}
impl AllPass {
    pub fn new(len: usize, g: f64) -> Self {
        AllPass { buf: vec![0.0; len], i: 0, g }
    }
    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let d = self.buf[self.i] as f64;
        let y = -self.g * x + d;
        self.buf[self.i] = (x + self.g * y) as f32;
        self.i = (self.i + 1) % self.buf.len();
        y
    }
}

/// Speaker rings (channel, azimuth°) sorted by azimuth; LFE isn't on a ring.
pub fn ring(n_ch: usize) -> Option<&'static [(usize, f64)]> {
    const R6: [(usize, f64); 5] = [(2, 0.0), (1, 30.0), (5, 110.0), (4, 250.0), (0, 330.0)];
    const R8: [(usize, f64); 7] = [(2, 0.0), (1, 30.0), (7, 90.0), (5, 150.0), (4, 210.0), (6, 270.0), (0, 330.0)];
    match n_ch {
        6 => Some(&R6),
        8 => Some(&R8),
        _ => None,
    }
}

/// VBAP gains of a source at `az`° into `n_ch` (stereo: constant-power on
/// sin(az), rear folds forward) — the synth's and morph's `setPan`, writing
/// f32 like their Float32Array.
pub fn set_pan(pan: &mut [f32], az: f64, n_ch: usize) {
    for p in pan.iter_mut().take(MAX_CH) {
        *p = 0.0;
    }
    let Some(ring) = ring(n_ch) else {
        if n_ch == 1 {
            pan[0] = 1.0;
            return;
        }
        let a = ((az * DEG).sin() + 1.0) * std::f64::consts::PI / 4.0;
        pan[0] = a.cos() as f32;
        pan[1] = a.sin() as f32;
        return;
    };
    let mut a = az % 360.0;
    if a < 0.0 {
        a += 360.0;
    }
    let mut i = 0;
    while i < ring.len() - 1 && ring[i + 1].1 <= a {
        i += 1;
    }
    let s1 = ring[i];
    let s2 = ring[(i + 1) % ring.len()];
    let a2 = if i == ring.len() - 1 { s2.1 + 360.0 } else { s2.1 };
    let t = (a - s1.1) / (a2 - s1.1);
    pan[s1.0] = (t * std::f64::consts::PI / 2.0).cos() as f32;
    pan[s2.0] = (t * std::f64::consts::PI / 2.0).sin() as f32;
}
