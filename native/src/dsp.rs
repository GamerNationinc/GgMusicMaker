//! DSP building blocks, written to match the web engine sample-for-sample
//! where it matters: the biquads use the Web Audio spec's formulas (so an EQ
//! setting sounds the same on either engine) and `Punch` is a line-by-line
//! port of public/punch-core.js.

use std::f64::consts::{PI, SQRT_2};

#[derive(Clone, Copy, Default)]
pub struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

pub enum Kind {
    Lowpass,
    Highpass,
    Lowshelf,
    Highshelf,
    Peaking,
}

impl Biquad {
    pub fn identity() -> Self {
        Biquad { b0: 1.0, ..Default::default() }
    }

    /// Web Audio BiquadFilterNode coefficients (Audio EQ Cookbook as the spec
    /// adapts it: shelves use slope S = 1, low/high-pass take Q in dB).
    pub fn set(&mut self, kind: Kind, freq: f64, q: f64, gain_db: f64, sr: f64) {
        let nyq = sr / 2.0;
        let f = (freq / nyq).clamp(0.0, 1.0);
        if f >= 1.0 && matches!(kind, Kind::Lowpass) {
            *self = Biquad { z1: self.z1, z2: self.z2, ..Biquad::identity() };
            return;
        }
        let w0 = PI * f;
        let (s, c) = w0.sin_cos();
        let a = 10f64.powf(gain_db / 40.0);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            Kind::Lowpass | Kind::Highpass => {
                let alpha = s / (2.0 * 10f64.powf(q / 20.0));
                if matches!(kind, Kind::Lowpass) {
                    ((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
                } else {
                    ((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
                }
            }
            Kind::Lowshelf => {
                let alpha = s / 2.0 * SQRT_2;
                let k = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * c + k),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * c),
                    a * ((a + 1.0) - (a - 1.0) * c - k),
                    (a + 1.0) + (a - 1.0) * c + k,
                    -2.0 * ((a - 1.0) + (a + 1.0) * c),
                    (a + 1.0) + (a - 1.0) * c - k,
                )
            }
            Kind::Highshelf => {
                let alpha = s / 2.0 * SQRT_2;
                let k = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * c + k),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
                    a * ((a + 1.0) + (a - 1.0) * c - k),
                    (a + 1.0) - (a - 1.0) * c + k,
                    2.0 * ((a - 1.0) - (a + 1.0) * c),
                    (a + 1.0) - (a - 1.0) * c - k,
                )
            }
            Kind::Peaking => {
                let alpha = s / (2.0 * q);
                (1.0 + alpha * a, -2.0 * c, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * c, 1.0 - alpha / a)
            }
        };
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

// ---- PUNCH (port of public/punch-core.js) ------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
pub struct PunchParams {
    pub boom: f64,
    pub sub: f64,
    pub punch: f64,
    pub snap: f64,
    pub drive: f64,
    pub blowout: f64,
    pub freq: f64,
    pub output: f64,
    pub safe: f64,
}

impl PunchParams {
    /// Round to f32 like an AudioParam, so the port sees exactly what the
    /// worklet sees.
    pub fn quantize(&mut self) {
        self.boom = self.boom as f32 as f64;
        self.sub = self.sub as f32 as f64;
        self.punch = self.punch as f32 as f64;
        self.snap = self.snap as f32 as f64;
        self.drive = self.drive as f32 as f64;
        self.blowout = self.blowout as f32 as f64;
        self.freq = self.freq as f32 as f64;
        self.output = self.output as f32 as f64;
        self.safe = self.safe as f32 as f64;
    }
}

/// The JS core's cookbook biquad (0 dB-peak RBJ LP/HP with a linear Q).
#[derive(Clone, Copy, Default)]
pub(crate) struct CoreBiquad(Biquad);
impl CoreBiquad {
    /// (b0, b1, b2, a1, a2)
    pub(crate) fn coeffs(&self) -> (f64, f64, f64, f64, f64) {
        let b = &self.0;
        (b.b0, b.b1, b.b2, b.a1, b.a2)
    }
    #[inline]
    pub(crate) fn process(&mut self, x: f64) -> f64 {
        self.0.process(x)
    }
    pub(crate) fn reset(&mut self) {
        self.0.reset();
    }
    pub(crate) fn set(&mut self, lp: bool, freq: f64, q: f64, sr: f64) {
        let w0 = 2.0 * PI * freq.clamp(10.0, sr * 0.45) / sr;
        let cw = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        let b = &mut self.0;
        if lp {
            b.b0 = (1.0 - cw) / 2.0 / a0;
            b.b1 = (1.0 - cw) / a0;
        } else {
            b.b0 = (1.0 + cw) / 2.0 / a0;
            b.b1 = -(1.0 + cw) / a0;
        }
        b.b2 = b.b0;
        b.a1 = -2.0 * cw / a0;
        b.a2 = (1.0 - alpha) / a0;
    }
}

#[inline]
pub(crate) fn cascade(f: &mut [CoreBiquad; 2], x: f64) -> f64 {
    let y = f[0].0.process(x);
    f[1].0.process(y)
}

#[derive(Clone, Copy)]
pub(crate) struct Env {
    a: f64,
    r: f64,
    pub(crate) v: f64,
}
impl Env {
    pub(crate) fn new(att: f64, rel: f64, sr: f64) -> Self {
        Env { a: (-1.0 / (sr * att)).exp(), r: (-1.0 / (sr * rel)).exp(), v: 0.0 }
    }
    #[inline]
    pub(crate) fn step(&mut self, x: f64) -> f64 {
        let ax = x.abs();
        self.v = if ax > self.v { ax + (self.v - ax) * self.a } else { self.v * self.r };
        self.v
    }
}

pub struct Punch {
    sr: f64,
    lp_l: [CoreBiquad; 2],
    lp_r: [CoreBiquad; 2],
    hp_l: [CoreBiquad; 2],
    hp_r: [CoreBiquad; 2],
    sub_in: [CoreBiquad; 2],
    sub_out: [CoreBiquad; 2],
    low_fast: Env,
    low_slow: Env,
    hi_fast: Env,
    hi_slow: Env,
    sub_env: Env,
    sub_prev: f64,
    sub_sq: f64,
    freq: f64,
    p: Option<PunchParams>,
    boom_gain: f64,
    punch_k: f64,
    snap_k: f64,
    drive_k: f64,
    drive_norm: f64,
    blow_k: f64,
    out_gain: f64,
    safe: bool,
}

pub(crate) fn clamp_n(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

pub(crate) fn ceiling(y: f64) -> f64 {
    let a = y.abs();
    if a <= 0.8 {
        return y;
    }
    let k = 0.8 + 0.18 * ((a - 0.8) / 0.18).tanh();
    if y < 0.0 {
        -k
    } else {
        k
    }
}

impl Punch {
    pub fn new(sr: f64) -> Self {
        let mut p = Punch {
            sr,
            lp_l: Default::default(),
            lp_r: Default::default(),
            hp_l: Default::default(),
            hp_r: Default::default(),
            sub_in: Default::default(),
            sub_out: Default::default(),
            low_fast: Env::new(0.0005, 0.04, sr),
            low_slow: Env::new(0.02, 0.2, sr),
            hi_fast: Env::new(0.0005, 0.03, sr),
            hi_slow: Env::new(0.015, 0.15, sr),
            sub_env: Env::new(0.005, 0.12, sr),
            sub_prev: 0.0,
            sub_sq: 1.0,
            freq: -1.0,
            p: None,
            boom_gain: 1.0,
            punch_k: 0.0,
            snap_k: 0.0,
            drive_k: 1.0,
            drive_norm: 1.0,
            blow_k: 1.0,
            out_gain: 1.0,
            safe: true,
        };
        let q = std::f64::consts::FRAC_1_SQRT_2;
        for f in p.sub_in.iter_mut() {
            f.set(true, 110.0, q, sr);
        }
        for f in p.sub_out.iter_mut() {
            f.set(true, 90.0, q, sr);
        }
        p
    }

    pub fn set(&mut self, p: PunchParams) {
        if self.p == Some(p) {
            return;
        }
        if p.freq != self.freq {
            self.freq = p.freq;
            let q = std::f64::consts::FRAC_1_SQRT_2;
            for f in self.lp_l.iter_mut().chain(self.lp_r.iter_mut()) {
                f.set(true, p.freq, q, self.sr);
            }
            for f in self.hp_l.iter_mut().chain(self.hp_r.iter_mut()) {
                f.set(false, p.freq, q, self.sr);
            }
        }
        self.boom_gain = 1.0 + p.boom * 3.0;
        self.punch_k = p.punch * 1.4;
        self.snap_k = p.snap * 1.2;
        self.drive_k = 1.0 + p.drive * 11.0;
        self.drive_norm = self.drive_k.powf(-0.45);
        self.blow_k = 1.0 + p.blowout * 9.0;
        self.out_gain = 10f64.powf(p.output / 20.0);
        self.safe = p.safe >= 0.5;
        self.p = Some(p);
    }

    #[inline]
    pub fn step(&mut self, xl: f64, xr: f64) -> (f64, f64) {
        let p = self.p.expect("Punch::set before step");
        let low_l = cascade(&mut self.lp_l, xl);
        let low_r = cascade(&mut self.lp_r, xr);
        let hi_l = cascade(&mut self.hp_l, xl);
        let hi_r = cascade(&mut self.hp_r, xr);
        let low_in = 0.5 * (low_l + low_r);
        let mut low = low_in;

        let f = self.low_fast.step(low);
        let s = self.low_slow.step(low);
        if self.punch_k > 0.0 {
            low *= clamp_n((f + 1e-5) / (s + 1e-5), 0.25, 6.0).powf(self.punch_k);
        }
        low *= self.boom_gain;

        if p.sub > 0.0 {
            let b = cascade(&mut self.sub_in, low_in);
            if self.sub_prev < 0.0 && b >= 0.0 {
                self.sub_sq = -self.sub_sq;
            }
            self.sub_prev = b;
            let e = self.sub_env.step(b);
            low += p.sub * 2.2 * cascade(&mut self.sub_out, self.sub_sq * e);
        }

        if p.drive > 0.0 {
            low = (self.drive_k * low).tanh() * self.drive_norm * 1.6;
        }

        let mut g = 1.0;
        if self.snap_k != 0.0 {
            let hm = 0.5 * (hi_l + hi_r);
            let hf = self.hi_fast.step(hm);
            let hs = self.hi_slow.step(hm);
            g = clamp_n((hf + 1e-5) / (hs + 1e-5), 0.25, 6.0).powf(self.snap_k);
        }
        let mut l = low + hi_l * g;
        let mut r = low + hi_r * g;
        if p.blowout > 0.0 {
            l = (self.blow_k * l).tanh() * 0.97;
            r = (self.blow_k * r).tanh() * 0.97;
        }
        l *= self.out_gain;
        r *= self.out_gain;
        if self.safe {
            l = ceiling(l);
            r = ceiling(r);
        }
        (l, r)
    }
}

// ---- master compressor (Web Audio DynamicsCompressorNode) --------------------

/// The web engine's master stage is a DynamicsCompressorNode (threshold
/// −3 dB, knee 0, ratio 20, attack 2 ms, release 100 ms). The spec also
/// applies automatic makeup gain, (1 / gain at 0 dBFS)^0.6 ≈ +1.7 dB here,
/// which the native bus must match or it would sound quieter. Linked over
/// the channels it's given (the web engine uses one per stereo pair / one
/// per surround channel).
pub struct Compressor {
    env_db: f64,
    att: f64,
    rel: f64,
    thr_db: f64,
    ratio: f64,
    makeup: f64,
    pub reduction_db: f64,
}

impl Compressor {
    pub fn new(sr: f64) -> Self {
        let thr_db = -3.0;
        let ratio = 20.0;
        let full = thr_db + (0.0 - thr_db) / ratio; // output level for a 0 dBFS input
        let makeup = (1.0 / 10f64.powf(full / 20.0)).powf(0.6);
        Compressor {
            env_db: 0.0,
            att: (-1.0 / (sr * 0.002)).exp(),
            rel: (-1.0 / (sr * 0.1)).exp(),
            thr_db,
            ratio,
            makeup,
            reduction_db: 0.0,
        }
    }
    /// Gain for this sample given the peak across the linked channels.
    #[inline]
    pub fn gain(&mut self, peak: f64) -> f64 {
        let in_db = 20.0 * peak.max(1e-9).log10();
        let target = if in_db > self.thr_db { (self.thr_db + (in_db - self.thr_db) / self.ratio) - in_db } else { 0.0 };
        let c = if target < self.env_db { self.att } else { self.rel };
        self.env_db = target + (self.env_db - target) * c;
        self.reduction_db = self.env_db;
        10f64.powf(self.env_db / 20.0) * self.makeup
    }
}

// ---- master limiter ---------------------------------------------------------

/// Peak limiter standing in for the web engine's DynamicsCompressor
/// (threshold −3 dBFS, fast attack, 100 ms release), plus a soft ceiling so
/// a transient that beats the attack still can't exceed full scale.
pub struct Limiter {
    gain: f64,
    att: f64,
    rel: f64,
    thr: f64,
}

impl Limiter {
    pub fn new(sr: f64) -> Self {
        Limiter { gain: 1.0, att: (-1.0 / (sr * 0.002)).exp(), rel: (-1.0 / (sr * 0.1)).exp(), thr: 10f64.powf(-3.0 / 20.0) }
    }
    #[inline]
    pub fn step(&mut self, l: f64, r: f64) -> (f64, f64) {
        let peak = l.abs().max(r.abs());
        let target = if peak > self.thr { self.thr / peak } else { 1.0 };
        let c = if target < self.gain { self.att } else { self.rel };
        self.gain = target + (self.gain - target) * c;
        (ceiling_hard(l * self.gain), ceiling_hard(r * self.gain))
    }
    pub fn reduction_db(&self) -> f64 {
        20.0 * self.gain.max(1e-6).log10()
    }
}

fn ceiling_hard(y: f64) -> f64 {
    let a = y.abs();
    if a <= 0.9 {
        return y;
    }
    let k = 0.9 + 0.099 * ((a - 0.9) / 0.099).tanh();
    if y < 0.0 {
        -k
    } else {
        k
    }
}
