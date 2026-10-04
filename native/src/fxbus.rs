//! FX BUS — the SP-style performance effects (docs/sampler-research.md
//! §3.2). Line-by-line port of public/fxbus-core.js (the effects, their
//! macros and depth are described there); kept in step by
//! src/fx/fxbus.test.ts. Buffers the JS keeps in Float32Arrays are f32 here.

use crate::util::Rng;
use serde::Deserialize;
use std::f64::consts::{PI, TAU};

const SMOOTH: f64 = 0.02;
const MAX_DELAY: f64 = 2.0;
const HISTORY: f64 = 0.6;
const LOOP_MAX: f64 = 0.5;
const LOOP_FADE: f64 = 64.0;
const SEED: u32 = 0x5eed_1234;

/// One bus's settings as the page sends them (with the project; `depth`
/// comes from live `fx` events).
#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FxBusSpec {
    /// 0 off, 1 vinyl, 2 cassette, 3 lo-fi, 4 filter, 5 echo, 6 looper.
    #[serde(default)]
    pub effect: u32,
    #[serde(default = "half")]
    pub a: f64,
    #[serde(default = "half")]
    pub b: f64,
}
fn half() -> f64 {
    0.5
}

pub struct FxBus {
    sr: f64,
    k: f64,
    g_echo: f64,
    dlen: usize,
    dl: Vec<f32>,
    dr: Vec<f32>,
    dpos: usize,
    hlen: usize,
    hl: Vec<f32>,
    hr: Vec<f32>,
    hpos: usize,
    max_loop: usize,
    ll: Vec<f32>,
    lr: Vec<f32>,
    pub effect: u32,
    pub a: f64,
    pub b: f64,
    pub depth: f64,
    s_a: f64,
    s_b: f64,
    s_d: f64,
    fresh: bool,
    ox: f64,
    oy: f64,
    rng: Rng,
    lfo: f64,
    lfo2: f64,
    lp1: f64,
    lp2: f64,
    hp1: f64,
    hp2: f64,
    crk: f64,
    dip: f64,
    dip_t: i64,
    dip_to: f64,
    ph: f64,
    hol: f64,
    hor: f64,
    i1l: f64,
    i2l: f64,
    i1r: f64,
    i2r: f64,
    engaged: bool,
    s_g: f64,
    loop_start: usize,
    loop_len: usize,
    lpos: f64,
}

impl FxBus {
    pub fn new(sr: f64) -> Self {
        let dlen = (sr * MAX_DELAY).ceil() as usize + 4;
        let hlen = (sr * HISTORY).ceil() as usize;
        let max_loop = (sr * LOOP_MAX).round() as usize;
        let mut f = FxBus {
            sr,
            k: (-1.0 / (sr * SMOOTH)).exp(),
            g_echo: 1.0 - (-TAU * 3500.0 / sr).exp(),
            dlen,
            dl: vec![0.0; dlen],
            dr: vec![0.0; dlen],
            dpos: 0,
            hlen,
            hl: vec![0.0; hlen],
            hr: vec![0.0; hlen],
            hpos: 0,
            max_loop,
            ll: vec![0.0; max_loop],
            lr: vec![0.0; max_loop],
            effect: 0,
            a: 0.5,
            b: 0.5,
            depth: 0.0,
            s_a: 0.5,
            s_b: 0.5,
            s_d: 0.0,
            fresh: true,
            ox: 0.0,
            oy: 0.0,
            rng: Rng::new(SEED),
            lfo: 0.0,
            lfo2: 0.0,
            lp1: 0.0,
            lp2: 0.0,
            hp1: 0.0,
            hp2: 0.0,
            crk: 0.0,
            dip: 1.0,
            dip_t: 0,
            dip_to: 1.0,
            ph: 1.0,
            hol: 0.0,
            hor: 0.0,
            i1l: 0.0,
            i2l: 0.0,
            i1r: 0.0,
            i2r: 0.0,
            engaged: false,
            s_g: 0.0,
            loop_start: 0,
            loop_len: 32,
            lpos: 0.0,
        };
        f.reset();
        f
    }

    pub fn reset(&mut self) {
        self.dl.fill(0.0);
        self.dr.fill(0.0);
        self.dpos = 0;
        self.hl.fill(0.0);
        self.hr.fill(0.0);
        self.hpos = 0;
        self.ll.fill(0.0);
        self.lr.fill(0.0);
        self.rng = Rng::new(SEED);
        self.lfo = 0.0;
        self.lfo2 = 0.0;
        self.lp1 = 0.0;
        self.lp2 = 0.0;
        self.hp1 = 0.0;
        self.hp2 = 0.0;
        self.crk = 0.0;
        self.dip = 1.0;
        self.dip_t = 0;
        self.dip_to = 1.0;
        self.ph = 1.0;
        self.hol = 0.0;
        self.hor = 0.0;
        self.i1l = 0.0;
        self.i2l = 0.0;
        self.i1r = 0.0;
        self.i2r = 0.0;
        self.engaged = false;
        self.s_g = 0.0;
        self.loop_start = 0;
        self.loop_len = 32;
        self.lpos = 0.0;
    }

    /// Any of effect / a / b / depth (None = unchanged). A new effect starts
    /// from silence.
    pub fn set(&mut self, effect: Option<u32>, a: Option<f64>, b: Option<f64>, depth: Option<f64>) {
        if let Some(e) = effect {
            let e = e.min(6);
            if e != self.effect {
                self.effect = e;
                self.reset();
            }
        }
        if let Some(v) = a {
            self.a = v.clamp(0.0, 1.0);
        }
        if let Some(v) = b {
            self.b = v.clamp(0.0, 1.0);
        }
        if let Some(v) = depth {
            self.depth = v.clamp(0.0, 1.0);
        }
        if self.fresh {
            self.fresh = false;
            self.s_a = self.a;
            self.s_b = self.b;
            self.s_d = self.depth;
        }
    }

    /// Something to do: an effect, and it's engaged or still ringing.
    pub fn busy(&self) -> bool {
        self.effect != 0
    }

    fn read(buf: &[f32], dpos: usize, dlen: usize, d: f64) -> f64 {
        let p = dpos as f64 - d + dlen as f64;
        let i0 = p.floor();
        let f = p - i0;
        let i0 = i0 as usize;
        let a = buf[i0 % dlen] as f64;
        let b = buf[(i0 + 1) % dlen] as f64;
        a + (b - a) * f
    }

    fn push(&mut self, x: f64, y: f64) {
        self.dl[self.dpos] = x as f32;
        self.dr[self.dpos] = y as f32;
        self.dpos = (self.dpos + 1) % self.dlen;
    }

    fn capture(&mut self) {
        let m = self.max_loop;
        for j in 0..m {
            let idx = (self.hpos + self.hlen + j - m) % self.hlen;
            self.ll[j] = self.hl[idx];
            self.lr[j] = self.hr[idx];
        }
        let len0 = ((self.sr * LOOP_MAX * (2f64).powf(-5.0 * self.a)).round() as usize).clamp(32, m);
        self.loop_start = m - len0;
        self.lpos = 0.0;
    }

    /// Process L/R in place.
    pub fn process(&mut self, l: &mut [f64], r: &mut [f64]) {
        let e = self.effect;
        if e == 0 {
            self.s_a = self.a;
            self.s_b = self.b;
            self.s_d = self.depth;
            return;
        }
        if e == 6 {
            let on = self.depth > 0.5;
            if on && !self.engaged {
                self.capture();
            }
            self.engaged = on;
            if on {
                self.loop_len = ((self.sr * LOOP_MAX * (2f64).powf(-5.0 * self.a)).round() as usize).clamp(32, (self.max_loop - self.loop_start).max(32));
            }
            if self.lpos >= self.loop_len as f64 {
                self.lpos %= self.loop_len as f64;
            }
        }
        let k = self.k;
        for i in 0..l.len().min(r.len()) {
            self.s_a = self.a + (self.s_a - self.a) * k;
            self.s_b = self.b + (self.s_b - self.b) * k;
            self.s_d = self.depth + (self.s_d - self.depth) * k;
            let (x, y) = (l[i], r[i]);
            match e {
                1 => self.vinyl(x, y),
                2 => self.cassette(x, y),
                3 => self.lofi(x, y),
                4 => self.filter(x, y),
                5 => self.echo(x, y),
                _ => self.looper(x, y),
            }
            l[i] = self.ox;
            r[i] = self.oy;
        }
    }

    fn vinyl(&mut self, x: f64, y: f64) {
        let (sr, s_a, s_b, s_d) = (self.sr, self.s_a, self.s_b, self.s_d);
        self.lfo += 0.55 / sr;
        if self.lfo >= 1.0 {
            self.lfo -= 1.0;
        }
        self.push(x, y);
        let d = ((5.0 + (0.2 + 2.8 * s_a) * (TAU * self.lfo).sin()) * sr) / 1000.0;
        let wl = Self::read(&self.dl, self.dpos, self.dlen, d);
        let wr = Self::read(&self.dr, self.dpos, self.dlen, d);
        let g = 1.0 - ((-TAU * 18000.0 * (2f64).powf(-3.5 * s_a)) / sr).exp();
        self.lp1 += (wl - self.lp1) * g;
        self.lp2 += (wr - self.lp2) * g;
        let gh = 1.0 - ((-TAU * (40.0 + 160.0 * s_a)) / sr).exp();
        self.hp1 += (self.lp1 - self.hp1) * gh;
        self.hp2 += (self.lp2 - self.hp2) * gh;
        let r1 = self.rng.next();
        let r2 = self.rng.bipolar();
        let r3 = self.rng.bipolar();
        if r1 < (2.0 + 60.0 * s_b) / sr {
            self.crk += r2 * (0.15 + 0.35 * s_b);
        }
        self.crk *= 0.55;
        let noise = self.crk + r3 * 0.003 * s_b;
        self.ox = x + (self.lp1 - self.hp1 + noise - x) * s_d;
        self.oy = y + (self.lp2 - self.hp2 + noise - y) * s_d;
    }

    fn cassette(&mut self, x: f64, y: f64) {
        let (sr, s_a, s_b, s_d) = (self.sr, self.s_a, self.s_b, self.s_d);
        self.lfo += 0.8 / sr;
        if self.lfo >= 1.0 {
            self.lfo -= 1.0;
        }
        self.lfo2 += 7.3 / sr;
        if self.lfo2 >= 1.0 {
            self.lfo2 -= 1.0;
        }
        self.push(x, y);
        let d = ((6.0 + (0.05 + 0.6 * s_a) * ((TAU * self.lfo).sin() + 0.35 * (TAU * self.lfo2).sin())) * sr) / 1000.0;
        let gs = 1.0 + 3.0 * s_a;
        let nrm = gs.tanh();
        let wl = (Self::read(&self.dl, self.dpos, self.dlen, d) * gs).tanh() / nrm;
        let wr = (Self::read(&self.dr, self.dpos, self.dlen, d) * gs).tanh() / nrm;
        let g = 1.0 - ((-TAU * 12000.0 * (2f64).powf(-2.5 * s_a)) / sr).exp();
        self.lp1 += (wl - self.lp1) * g;
        self.lp2 += (wr - self.lp2) * g;
        let r1 = self.rng.next();
        let r2 = self.rng.bipolar();
        if self.dip_t > 0 {
            self.dip_t -= 1;
        } else if r1 < (0.3 + 2.0 * s_b) / sr {
            self.dip_t = ((0.03 + 0.09 * self.rng.next()) * sr).floor() as i64;
            self.dip_to = 1.0 - (0.3 + 0.6 * self.rng.next()) * s_b;
        }
        let target = if self.dip_t > 0 { self.dip_to } else { 1.0 };
        self.dip += (target - self.dip) * 0.002;
        let hiss = r2 * 0.006 * s_b;
        self.ox = x + (self.lp1 * self.dip + hiss - x) * s_d;
        self.oy = y + (self.lp2 * self.dip + hiss - y) * s_d;
    }

    fn lofi(&mut self, x: f64, y: f64) {
        let s_d = self.s_d;
        let q = (2f64).powf(1.0 - (16.0 - 12.0 * self.s_a));
        self.ph += (2f64).powf(-5.0 * self.s_b);
        if self.ph >= 1.0 {
            self.ph -= self.ph.floor();
            self.hol = (x / q + 0.5).floor() * q;
            self.hor = (y / q + 0.5).floor() * q;
        }
        self.ox = x + (self.hol - x) * s_d;
        self.oy = y + (self.hor - y) * s_d;
    }

    fn filter(&mut self, x: f64, y: f64) {
        let (sr, s_a, s_b, s_d) = (self.sr, self.s_a, self.s_b, self.s_d);
        let low = s_a < 0.5;
        let fc = (sr * 0.45).min(if low { 20000.0 * (2f64).powf(-(0.5 - s_a) * 18.0) } else { 20.0 * (2f64).powf((s_a - 0.5) * 19.0) });
        let gg = (PI * fc / sr).tan();
        let kk = 2.0 - 1.85 * s_b;
        let a1 = 1.0 / (1.0 + gg * (gg + kk));
        let a2 = gg * a1;
        let a3 = gg * a2;
        let gd = 1.0 + 2.0 * s_b;
        let nd = gd.tanh();
        let xin = (x * gd).tanh() / nd;
        let v3 = xin - self.i2l;
        let v1 = a1 * self.i1l + a2 * v3;
        let v2 = self.i2l + a2 * self.i1l + a3 * v3;
        self.i1l = 2.0 * v1 - self.i1l;
        self.i2l = 2.0 * v2 - self.i2l;
        let fl = if low { v2 } else { xin - kk * v1 - v2 };
        let xin = (y * gd).tanh() / nd;
        let v3 = xin - self.i2r;
        let v1 = a1 * self.i1r + a2 * v3;
        let v2 = self.i2r + a2 * self.i1r + a3 * v3;
        self.i1r = 2.0 * v1 - self.i1r;
        self.i2r = 2.0 * v2 - self.i2r;
        let fr = if low { v2 } else { xin - kk * v1 - v2 };
        self.ox = x + (fl - x) * s_d;
        self.oy = y + (fr - y) * s_d;
    }

    fn echo(&mut self, x: f64, y: f64) {
        let sr = self.sr;
        let t = 0.06 * (2f64).powf(4.0 * self.s_a);
        let fb = 0.92 * self.s_b;
        let el = Self::read(&self.dl, self.dpos, self.dlen, t * sr);
        let er = Self::read(&self.dr, self.dpos, self.dlen, t * 1.03 * sr);
        self.lp1 += (el - self.lp1) * self.g_echo;
        self.lp2 += (er - self.lp2) * self.g_echo;
        let (wl, wr) = (x * self.s_d + (self.lp1 * fb).tanh(), y * self.s_d + (self.lp2 * fb).tanh());
        self.push(wl, wr);
        self.ox = x + el * 0.7;
        self.oy = y + er * 0.7;
    }

    fn looper(&mut self, x: f64, y: f64) {
        self.hl[self.hpos] = x as f32;
        self.hr[self.hpos] = y as f32;
        self.hpos = (self.hpos + 1) % self.hlen;
        let want = if self.engaged { 1.0 } else { 0.0 };
        self.s_g = want + (self.s_g - want) * self.k;
        if !self.engaged && self.s_g < 1e-4 {
            self.ox = x;
            self.oy = y;
            return;
        }
        let p = self.loop_start as f64 + self.lpos;
        let i0 = p.floor();
        let f = p - i0;
        let i0 = i0 as usize;
        let i1 = (i0 + 1).min(self.loop_start + self.loop_len - 1);
        let vl = self.ll[i0] as f64 + (self.ll[i1] as f64 - self.ll[i0] as f64) * f;
        let vr = self.lr[i0] as f64 + (self.lr[i1] as f64 - self.lr[i0] as f64) * f;
        let len = self.loop_len as f64;
        let fl = LOOP_FADE.min(len / 4.0);
        let fade = (self.lpos / fl).min((len - self.lpos) / fl).min(1.0);
        self.lpos += (2f64).powf((self.s_b - 0.5) * 2.0);
        if self.lpos >= len {
            self.lpos -= len;
        }
        self.ox = x + (vl * fade - x) * self.s_g;
        self.oy = y + (vr * fade - y) * self.s_g;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(n: usize, hz: f64, sr: f64) -> Vec<f64> {
        (0..n).map(|i| 0.5 * (TAU * hz * i as f64 / sr).sin()).collect()
    }

    #[test]
    fn off_and_zero_depth_pass_through() {
        let mut f = FxBus::new(48000.0);
        let s = sine(4800, 440.0, 48000.0);
        let (mut l, mut r) = (s.clone(), s.clone());
        f.set(Some(0), Some(0.3), Some(0.7), Some(1.0));
        f.process(&mut l, &mut r);
        assert_eq!(l, s);
        // An insert at depth 0 is dry.
        let mut f = FxBus::new(48000.0);
        f.set(Some(3), Some(1.0), Some(1.0), Some(0.0));
        let (mut l, mut r) = (s.clone(), s.clone());
        f.process(&mut l, &mut r);
        assert!(l.iter().zip(&s).all(|(a, b)| (a - b).abs() < 1e-12));
    }

    #[test]
    fn lofi_quantises_and_holds() {
        let mut f = FxBus::new(48000.0);
        f.set(Some(3), Some(1.0), Some(1.0), Some(1.0)); // 4 bits, 1.5 kHz
        let s = sine(4800, 440.0, 48000.0);
        let (mut l, mut r) = (s.clone(), s.clone());
        f.process(&mut l, &mut r);
        let q = (2f64).powf(-3.0);
        assert!(l[1000..].iter().all(|v| ((v / q) - (v / q).round()).abs() < 1e-9), "on the 4-bit grid");
        // 32 frames per held value (the first new value lands on frame 31).
        assert!(l[1023..1055].iter().all(|v| (v - l[1023]).abs() < 1e-12));
        assert!((l[1055] - l[1023]).abs() > 1e-3);
    }

    #[test]
    fn echo_repeats_after_the_time_and_rings_on() {
        let mut f = FxBus::new(1000.0);
        f.set(Some(5), Some(0.0), Some(0.5), Some(1.0)); // 60 ms = 60 frames at 1 kHz
        let mut l = vec![0.0; 400];
        l[0] = 1.0;
        let mut r = l.clone();
        f.process(&mut l, &mut r);
        assert!((l[60] - 0.7).abs() < 1e-9, "{}", l[60]);
        assert!(l[120].abs() > 0.01, "second repeat");
        // Released: the input no longer feeds it, the tail still plays.
        f.set(None, None, None, Some(0.0));
        let mut l2 = vec![0.0; 400];
        l2[0] = 1.0;
        let mut r2 = l2.clone();
        f.process(&mut l2, &mut r2);
        assert!(l2[1..].iter().any(|v| v.abs() > 1e-3));
    }

    #[test]
    fn filter_low_pass_kills_highs_high_pass_kills_lows() {
        let rms = |v: &[f64]| (v.iter().map(|x| x * x).sum::<f64>() / v.len() as f64).sqrt();
        let sr = 48000.0;
        for (a, hz, keep) in [(0.1, 8000.0, false), (0.1, 60.0, true), (0.9, 60.0, false), (0.9, 8000.0, true)] {
            let mut f = FxBus::new(sr);
            f.set(Some(4), Some(a), Some(0.0), Some(1.0));
            let s = sine(9600, hz, sr);
            let (mut l, mut r) = (s.clone(), s.clone());
            f.process(&mut l, &mut r);
            let ratio = rms(&l[4800..]) / rms(&s[4800..]);
            assert_eq!(ratio > 0.5, keep, "a {a} {hz} Hz: {ratio}");
        }
    }

    #[test]
    fn looper_repeats_what_just_played() {
        let sr = 1000.0;
        let mut f = FxBus::new(sr);
        f.set(Some(6), Some(1.0), Some(0.5), Some(0.0)); // 16 ms → 32 frames (the floor)
        let mut l: Vec<f64> = (0..600).map(|i| i as f64).collect();
        let mut r = l.clone();
        f.process(&mut l, &mut r);
        f.set(None, None, None, Some(1.0));
        let mut l: Vec<f64> = vec![0.0; 300];
        let mut r = l.clone();
        f.process(&mut l, &mut r);
        // After the fade-in, the output is the last 32 frames (568..599), looping.
        let v = l[200];
        assert!(v > 400.0, "{v}");
        assert!((l[232] - l[200]).abs() < 1.0, "one loop later: {} vs {}", l[232], l[200]);
    }
}
