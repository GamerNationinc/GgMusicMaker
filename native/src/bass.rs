//! BASS MOD — line-by-line port of public/bass-core.js (see that file for
//! the signal flow). Modulates and thickens a bass line or an 808: tempo-
//! locked filter wobble, TALK envelope, vibrato, DEEPEN (pitch-tracked
//! sine), GRIT, WIDEN (mono sub) and PUMP.
//!
//! `block(t)` locks the LFOs to the song position at the start of every
//! quantum, exactly as the worklet does with `currentTime − songT0`.

use crate::dsp::{ceiling, clamp_n, CoreBiquad, Env};
use std::f64::consts::{FRAC_1_SQRT_2, LN_2, PI};

const TAU: f64 = 2.0 * PI;
pub const RATE_BEATS: [f64; 8] = [4.0, 2.0, 1.0, 0.5, 0.25, 2.0 / 3.0, 1.0 / 3.0, 1.0 / 6.0];
const WIDE_HZ: f64 = 150.0;
const DEEP_HZ: f64 = 180.0;
const GRIT_LP: f64 = 250.0;
const GRIT_HP: f64 = 300.0;

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
pub struct BassParams {
    pub bpm: f64,
    pub rate: f64,
    pub shape: f64,
    pub wobble: f64,
    pub cutoff: f64,
    pub reso: f64,
    pub env: f64,
    pub vibrato: f64,
    pub deepen: f64,
    pub octave: f64,
    pub grit: f64,
    pub widen: f64,
    pub pump: f64,
    pub output: f64,
}

impl BassParams {
    /// Round to f32 like an AudioParam, so the port sees what the worklet sees.
    pub fn quantize(&mut self) {
        for v in [
            &mut self.bpm, &mut self.rate, &mut self.shape, &mut self.wobble, &mut self.cutoff, &mut self.reso,
            &mut self.env, &mut self.vibrato, &mut self.deepen, &mut self.octave, &mut self.grit, &mut self.widen,
            &mut self.pump, &mut self.output,
        ] {
            *v = *v as f32 as f64;
        }
    }
}

/// JS Math.round (half up), which `floor(x + 0.5)` is.
#[inline]
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

struct Delay {
    buf: Vec<f64>,
    mask: usize,
    w: usize,
}
impl Delay {
    fn new(n: usize) -> Self {
        Delay { buf: vec![0.0; n], mask: n - 1, w: 0 }
    }
    #[inline]
    fn push(&mut self, x: f64) {
        self.buf[self.w] = x;
        self.w = (self.w + 1) & self.mask;
    }
    #[inline]
    fn read(&self, d: f64) -> f64 {
        let p = self.w as f64 - 1.0 - d;
        let i = p.floor();
        let f = p - i;
        let i = i as i64;
        let m = self.mask as i64;
        let a = self.buf[(i & m) as usize];
        let b = self.buf[((i + 1) & m) as usize];
        a + (b - a) * f
    }
    fn reset(&mut self) {
        self.buf.fill(0.0);
        self.w = 0;
    }
}

fn cycle_noise(n: f64) -> f64 {
    let mut h: u32 = ((n as i64) as i32 as u32) ^ 0x9e37_79b9;
    h = (h ^ (h >> 16)).wrapping_mul(0x85eb_ca6b);
    h = (h ^ (h >> 13)).wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    (h as f64 / 4_294_967_295.0) * 2.0 - 1.0
}

fn cascade_lag(bq: &CoreBiquad, f: f64, sr: f64) -> f64 {
    let (b0, b1, b2, a1, a2) = bq.coeffs();
    let w = TAU * f / sr;
    let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
    let nr = b0 + b1 * c1 + b2 * c2;
    let ni = -b1 * s1 - b2 * s2;
    let dr = 1.0 + a1 * c1 + a2 * c2;
    let di = -a1 * s1 - a2 * s2;
    let ph = ni.atan2(nr) - di.atan2(dr);
    (-2.0 * ph) / TAU
}

#[inline]
fn wrap_half(x: f64) -> f64 {
    x - (x + 0.5).floor()
}

fn pow2_at_least(n: usize) -> usize {
    let mut k = 1;
    while k < n {
        k *= 2;
    }
    k
}

pub struct Bass {
    sr: f64,
    vib_l: Delay,
    vib_r: Delay,
    ic1l: f64,
    ic2l: f64,
    ic1r: f64,
    ic2r: f64,
    env_f: Env,
    grit_lp: CoreBiquad,
    grit_hp: CoreBiquad,
    deep: [CoreBiquad; 2],
    deep_env: Env,
    lp_l: [CoreBiquad; 2],
    lp_r: [CoreBiquad; 2],
    hp_l: [CoreBiquad; 2],
    hp_r: [CoreBiquad; 2],
    wide: Delay,
    sm_k: f64,
    pump_k: f64,
    p: Option<BassParams>,
    hz: f64,
    shape: i32,
    filter_on: bool,
    k: f64,
    vib_a: f64,
    out_gain: f64,
    // running state
    ph: f64,
    cyc: f64,
    wph: f64,
    modv: f64,
    pump_g: f64,
    n: f64,
    prev_b: f64,
    armed: bool,
    last_cross: f64,
    f: f64,
    oph: f64,
    flip: f64,
    /// Silent frames in a row (the worklet idles + resets after ~0.5 s).
    quiet: usize,
    idle: bool,
}

impl Bass {
    pub fn new(sr: f64) -> Self {
        let n = pow2_at_least((sr * 0.012).ceil() as usize + 8);
        let q = FRAC_1_SQRT_2;
        let mut b = Bass {
            sr,
            vib_l: Delay::new(n),
            vib_r: Delay::new(n),
            ic1l: 0.0,
            ic2l: 0.0,
            ic1r: 0.0,
            ic2r: 0.0,
            env_f: Env::new(0.002, 0.15, sr),
            grit_lp: CoreBiquad::default(),
            grit_hp: CoreBiquad::default(),
            deep: Default::default(),
            deep_env: Env::new(0.004, 0.1, sr),
            lp_l: Default::default(),
            lp_r: Default::default(),
            hp_l: Default::default(),
            hp_r: Default::default(),
            wide: Delay::new(n),
            sm_k: 1.0 - (-1.0 / (sr * 0.004)).exp(),
            pump_k: 1.0 - (-1.0 / (sr * 0.0015)).exp(),
            p: None,
            hz: 1.0,
            shape: 0,
            filter_on: false,
            k: 1.0,
            vib_a: 0.0,
            out_gain: 1.0,
            ph: 0.0,
            cyc: 0.0,
            wph: 0.0,
            modv: 0.0,
            pump_g: 1.0,
            n: 0.0,
            prev_b: 0.0,
            armed: false,
            last_cross: -1.0,
            f: 55.0,
            oph: 0.0,
            flip: 0.0,
            quiet: 0,
            idle: false,
        };
        b.grit_lp.set(true, GRIT_LP, q, sr);
        b.grit_hp.set(false, GRIT_HP, q, sr);
        for f in b.deep.iter_mut() {
            f.set(true, DEEP_HZ, q, sr);
        }
        for f in b.lp_l.iter_mut().chain(b.lp_r.iter_mut()) {
            f.set(true, WIDE_HZ, q, sr);
        }
        for f in b.hp_l.iter_mut().chain(b.hp_r.iter_mut()) {
            f.set(false, WIDE_HZ, q, sr);
        }
        b
    }

    pub fn set(&mut self, p: BassParams) {
        if self.p == Some(p) {
            return;
        }
        let idx = clamp_n(js_round(p.rate), 0.0, (RATE_BEATS.len() - 1) as f64) as usize;
        self.hz = p.bpm / 60.0 / RATE_BEATS[idx];
        self.shape = js_round(p.shape) as i32;
        self.filter_on = p.wobble > 0.0 || p.env != 0.0 || p.cutoff < 20000.0;
        self.k = 1.0 / (0.7 + p.reso * 7.3);
        let swing = (p.vibrato * 50.0 * LN_2 / 1200.0) / (TAU * self.hz);
        self.vib_a = swing.min(0.006) * self.sr;
        self.out_gain = 10f64.powf(p.output / 20.0);
        self.p = Some(p);
    }

    pub fn reset(&mut self) {
        self.vib_l.reset();
        self.vib_r.reset();
        self.wide.reset();
        self.ic1l = 0.0;
        self.ic2l = 0.0;
        self.ic1r = 0.0;
        self.ic2r = 0.0;
        self.env_f.v = 0.0;
        self.deep_env.v = 0.0;
        for f in [&mut self.grit_lp, &mut self.grit_hp]
            .into_iter()
            .chain(self.deep.iter_mut())
            .chain(self.lp_l.iter_mut())
            .chain(self.lp_r.iter_mut())
            .chain(self.hp_l.iter_mut())
            .chain(self.hp_r.iter_mut())
        {
            f.reset();
        }
        self.modv = 0.0;
        self.pump_g = 1.0;
        self.n = 0.0;
        self.prev_b = 0.0;
        self.armed = false;
        self.last_cross = -1.0;
        self.f = 55.0;
        self.oph = 0.0;
        self.flip = 0.0;
    }

    /// Start of a block: lock the LFOs to the song position `t` (seconds).
    pub fn block(&mut self, t: f64) {
        let x = t * self.hz;
        let c = x.floor();
        self.cyc = c;
        self.ph = x - c;
        let w = t * 0.37;
        self.wph = w - w.floor();
    }

    #[inline]
    fn lfo(&self) -> f64 {
        let ph = self.ph;
        match self.shape {
            1 => 4.0 * (ph - 0.5).abs() - 1.0,
            2 => 1.0 - 2.0 * ph,
            3 => {
                if ph < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
            4 => cycle_noise(self.cyc),
            _ => (TAU * ph).cos(),
        }
    }

    /// Process one block in place (stereo), as the worklet does: idle and
    /// reset after ~0.5 s of silence, LFOs locked at `t` (song seconds).
    pub fn process(&mut self, p: BassParams, t: f64, l: &mut [f32], r: &mut [f32]) {
        let frames = l.len();
        let silent = l.iter().zip(r.iter()).all(|(a, b)| *a == 0.0 && *b == 0.0);
        let quiet_blocks = (0.5 * self.sr / 128.0).ceil() as usize;
        if silent {
            if self.quiet < quiet_blocks {
                self.quiet += 1;
            } else {
                if !self.idle {
                    self.reset();
                    self.idle = true;
                }
                l.fill(0.0);
                r.fill(0.0);
                return;
            }
        } else {
            self.quiet = 0;
            self.idle = false;
        }
        self.set(p);
        self.block(t);
        for i in 0..frames {
            let (a, b) = self.step(l[i] as f64, r[i] as f64);
            l[i] = a as f32;
            r[i] = b as f32;
        }
    }

    #[inline]
    pub fn step(&mut self, mut xl: f64, mut xr: f64) -> (f64, f64) {
        let p = self.p.expect("Bass::set before step");
        let sr = self.sr;
        self.modv += (self.lfo() - self.modv) * self.sm_k;

        if self.vib_a > 0.0 {
            self.vib_l.push(xl);
            self.vib_r.push(xr);
            let d = 2.0 + self.vib_a * (1.0 - (TAU * self.ph).cos());
            xl = self.vib_l.read(d);
            xr = self.vib_r.read(d);
        }
        let mono = 0.5 * (xl + xr);
        let e = self.env_f.step(mono);

        if self.filter_on {
            let mut oct = -p.wobble * 6.0 * (0.5 - 0.5 * self.modv);
            if p.env != 0.0 {
                oct += p.env * 5.0 * (e * 6.0).min(1.0);
            }
            let fc = clamp_n(p.cutoff * 2f64.powf(oct), 30.0, sr * 0.45);
            let g = (PI * fc / sr).tan();
            let a1 = 1.0 / (1.0 + g * (g + self.k));
            let a2 = g * a1;
            let a3 = g * a2;
            let mut v3 = xl - self.ic2l;
            let mut v1 = a1 * self.ic1l + a2 * v3;
            let mut v2 = self.ic2l + a2 * self.ic1l + a3 * v3;
            self.ic1l = 2.0 * v1 - self.ic1l;
            self.ic2l = 2.0 * v2 - self.ic2l;
            xl = v2;
            v3 = xr - self.ic2r;
            v1 = a1 * self.ic1r + a2 * v3;
            v2 = self.ic2r + a2 * self.ic1r + a3 * v3;
            self.ic1r = 2.0 * v1 - self.ic1r;
            self.ic2r = 2.0 * v2 - self.ic2r;
            xr = v2;
        }

        if p.grit > 0.0 {
            let b = self.grit_lp.process(mono);
            let h = self.grit_hp.process((b * (1.0 + p.grit * 15.0)).tanh());
            xl += h * p.grit * 0.6;
            xr += h * p.grit * 0.6;
        }

        if p.deepen > 0.0 {
            let b = {
                let y = self.deep[0].process(mono);
                self.deep[1].process(y)
            };
            let de = self.deep_env.step(b);
            if b < -0.1 * de {
                self.armed = true;
            }
            if self.armed && self.prev_b < 0.0 && b >= 0.0 && de > 1e-4 {
                self.armed = false;
                let frac = self.prev_b / (self.prev_b - b);
                let at = self.n - 1.0 + frac;
                if self.last_cross >= 0.0 {
                    let period = at - self.last_cross;
                    if period > sr / 400.0 && period < sr / 25.0 {
                        self.f += (sr / period - self.f) * 0.5;
                    }
                }
                self.last_cross = at;
                self.flip = 1.0 - self.flip;
                let mut target = cascade_lag(&self.deep[0], self.f, sr) + ((1.0 - frac) * self.f) / sr;
                if p.octave >= 0.5 {
                    target = 0.5 * target + 0.5 * self.flip;
                }
                self.oph += 0.3 * wrap_half(target - self.oph);
            }
            self.prev_b = b;
            let s = p.deepen * 1.2 * de * (TAU * self.oph).sin();
            xl += s;
            xr += s;
            self.oph += (if p.octave >= 0.5 { self.f * 0.5 } else { self.f }) / sr;
            self.oph -= self.oph.floor();
        }
        self.n += 1.0;

        if p.widen > 0.0 {
            let lo_l = {
                let y = self.lp_l[0].process(xl);
                self.lp_l[1].process(y)
            };
            let lo_r = {
                let y = self.lp_r[0].process(xr);
                self.lp_r[1].process(y)
            };
            let lo = 0.5 * (lo_l + lo_r);
            let hl = {
                let y = self.hp_l[0].process(xl);
                self.hp_l[1].process(y)
            };
            let hr = {
                let y = self.hp_r[0].process(xr);
                self.hp_r[1].process(y)
            };
            let mid = 0.5 * (hl + hr);
            self.wide.push(mid);
            let sw = 0.0025 * sr * (TAU * self.wph).sin();
            let dl = 0.007 * sr + sw;
            let dr = 0.007 * sr - sw;
            let side = 0.5 * (hl - hr) * (1.0 + p.widen) + 0.5 * (self.wide.read(dl) - self.wide.read(dr)) * p.widen * 0.9;
            xl = lo + mid + side;
            xr = lo + mid - side;
            self.wph += 0.37 / sr;
            if self.wph >= 1.0 {
                self.wph -= 1.0;
            }
        }

        if p.pump > 0.0 {
            let u = 1.0 - self.ph;
            let target = 1.0 - p.pump * u * u * u;
            self.pump_g += (target - self.pump_g) * self.pump_k;
            xl *= self.pump_g;
            xr *= self.pump_g;
        }

        self.ph += self.hz / sr;
        if self.ph >= 1.0 {
            self.ph -= 1.0;
            self.cyc += 1.0;
        }

        (ceiling(xl * self.out_gain), ceiling(xr * self.out_gain))
    }
}
