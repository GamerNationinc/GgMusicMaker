//! MORPH — port of public/morph-processor.js: eight engines, each voice
//! placed on the speaker ring. One render quantum (≤ 128 frames) per call.

use crate::util::*;
use serde::Deserialize;

const MAX_VOICES: usize = 16;
const FM_RATIOS: [f64; 8] = [0.5, 1.0, 1.5, 2.0, 3.0, 3.5, 5.0, 7.0];
const STRING_CHORDS: [[f64; 4]; 6] =
    [[0.0, 0.07, -0.07, 12.0], [0.0, 7.0, 12.0, 19.0], [0.0, 4.0, 7.0, 12.0], [0.0, 3.0, 7.0, 12.0], [0.0, 5.0, 7.0, 14.0], [0.0, 1.0, 2.0, 3.0]];
const TUNING_ROOTS: [f64; 5] = [130.81, 128.43, 132.0, 125.28, 130.81];
const VOWELS: [[f64; 3]; 5] = [[730.0, 1090.0, 2440.0], [530.0, 1840.0, 2480.0], [270.0, 2290.0, 3010.0], [570.0, 840.0, 2410.0], [300.0, 870.0, 2240.0]];
const FORMANT_GAIN: [f64; 3] = [1.0, 0.7, 0.4];
const N_FFT: usize = 1024;
const HOP: usize = 256;
const HALF: usize = N_FFT / 2;
const BAND_EDGES: [usize; 5] = [1, 8, 32, 96, HALF + 1];

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct MorphParams {
    pub mix: f64,
    pub algo: f64,
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub note: f64,
    pub tuning: f64,
    pub spread: f64,
    pub path: f64,
    pub motion: f64,
    pub diffuse: f64,
}

impl MorphParams {
    /// Round to f32 like an AudioParam, so the port sees exactly what the
    /// worklet sees.
    pub fn quantize(&mut self) {
        self.mix = self.mix as f32 as f64;
        self.algo = self.algo as f32 as f64;
        self.a = self.a as f32 as f64;
        self.b = self.b as f32 as f64;
        self.c = self.c as f32 as f64;
        self.d = self.d as f32 as f64;
        self.note = self.note as f32 as f64;
        self.tuning = self.tuning as f32 as f64;
        self.spread = self.spread as f32 as f64;
        self.path = self.path as f32 as f64;
        self.motion = self.motion as f32 as f64;
        self.diffuse = self.diffuse as f32 as f64;
    }
}

struct Walker {
    v: f64,
    t: f64,
    left: f64,
}
impl Walker {
    fn step(&mut self, rng: &mut Rng, rate: f64, sr: f64) -> f64 {
        if self.left <= 0.0 {
            self.t = rng.bipolar();
            self.left = (0.3 + rng.next()) / rate.max(0.05);
        }
        self.left -= 128.0 / sr;
        self.v += (self.t - self.v) * (1f64).min(3.0 * rate * 128.0 / sr);
        self.v
    }
}

#[derive(Default)]
struct Lorenz {
    x: f64,
    y: f64,
    z: f64,
}
impl Lorenz {
    fn new() -> Self {
        Lorenz { x: 0.1, y: 0.0, z: 20.0 }
    }
    fn step(&mut self, dt: f64, rho: f64, n: usize) {
        for _ in 0..n {
            let dx = 10.0 * (self.y - self.x);
            let dy = self.x * (rho - self.z) - self.y;
            let dz = self.x * self.y - (8.0 / 3.0) * self.z;
            self.x += dx * dt;
            self.y += dy * dt;
            self.z += dz * dt;
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Grain {
    on: bool,
    pos: f64,
    inc: f64,
    t: f64,
    len: f64,
}

struct Fft {
    bitrev: Vec<u16>,
    cos: Vec<f32>,
    sin: Vec<f32>,
    hann: Vec<f32>,
}
impl Fft {
    fn new() -> Self {
        let bits = N_FFT.trailing_zeros();
        let bitrev = (0..N_FFT)
            .map(|i| {
                let mut r = 0;
                for b in 0..bits {
                    r |= ((i >> b) & 1) << (bits - 1 - b);
                }
                r as u16
            })
            .collect();
        let cos = (0..HALF).map(|i| (TAU * i as f64 / N_FFT as f64).cos() as f32).collect();
        let sin = (0..HALF).map(|i| (TAU * i as f64 / N_FFT as f64).sin() as f32).collect();
        let hann = (0..N_FFT).map(|i| (0.5 - 0.5 * (TAU * i as f64 / N_FFT as f64).cos()) as f32).collect();
        Fft { bitrev, cos, sin, hann }
    }
    /// In place over f32 arrays, like the worklet (every store rounds).
    fn run(&self, re: &mut [f32], im: &mut [f32], inverse: bool) {
        for i in 0..N_FFT {
            let j = self.bitrev[i] as usize;
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let sgn = if inverse { 1.0 } else { -1.0 };
        let mut size = 2;
        while size <= N_FFT {
            let half = size >> 1;
            let step = N_FFT / size;
            let mut start = 0;
            while start < N_FFT {
                for k in 0..half {
                    let wr = self.cos[k * step] as f64;
                    let wi = sgn * self.sin[k * step] as f64;
                    let a = start + k;
                    let b = a + half;
                    let tr = re[b] as f64 * wr - im[b] as f64 * wi;
                    let ti = re[b] as f64 * wi + im[b] as f64 * wr;
                    re[b] = (re[a] as f64 - tr) as f32;
                    im[b] = (im[a] as f64 - ti) as f32;
                    re[a] = (re[a] as f64 + tr) as f32;
                    im[a] = (im[a] as f64 + ti) as f32;
                }
                start += size;
            }
            size <<= 1;
        }
    }
}

#[inline]
fn princarg(p: f64) -> f64 {
    p - TAU * js_round(p / TAU)
}

pub struct Morph {
    sr: f64,
    rng: Rng,
    quiet: usize,
    quiet_blocks: usize,
    idle: bool,
    algo: i64,
    env_f: f64,
    env_s: f64,
    a_f: f64,
    r_f: f64,
    a_s: f64,
    r_s: f64,
    vs: [f32; MAX_VOICES],
    home: [f32; MAX_VOICES],
    fixed_az: [f32; MAX_VOICES],
    pan: [f32; MAX_VOICES * MAX_CH],
    field: [f32; MAX_CH],
    nv: usize,
    path_phase: f64,
    walkers: Vec<Walker>,
    path_lorenz: Lorenz,
    diff: Vec<[AllPass; 2]>,
    // FM
    fm_ph_c: [f64; 2],
    fm_ph_m: [f64; 2],
    fm_prev: [f64; 2],
    fm_fc: f64,
    fm_ratio: f64,
    fm_index: f64,
    fm_fb: f64,
    fm_voice: f64,
    // grain
    g_size: usize,
    g_buf: Vec<f32>,
    g_w: usize,
    g_count: f64,
    grains: [Grain; MAX_VOICES],
    g_rate: f64,
    g_len: f64,
    g_pitch: f64,
    g_back: f64,
    g_norm: f64,
    // strings
    s_len: usize,
    s_buf: Vec<Vec<f32>>,
    s_w: usize,
    s_lp: [f32; 4],
    s_delay: [f32; 4],
    s_fb: f64,
    s_damp: f64,
    s_noise: f64,
    s_exc: f64,
    // vowel
    formants: [Bandpass; 3],
    vowel_phase: f64,
    v_lvl_in: f64,
    v_lvl_out: f64,
    // fold
    dc_x: [f64; 2],
    dc_y: [f64; 2],
    lp: [f64; 2],
    f_drive: f64,
    f_folds: f64,
    f_sym: f64,
    f_order: f64,
    f_cheb_lvl: f64,
    // chaos
    lorenz: Lorenz,
    svf_ic1: f64,
    svf_ic2: f64,
    svf_a1: f64,
    svf_a2: f64,
    svf_a3: f64,
    c_amp: f64,
    // spectral
    fft: Fft,
    in_ring: Vec<f32>,
    in_w: usize,
    hop_count: usize,
    re: Vec<f32>,
    im: Vec<f32>,
    re2: Vec<f32>,
    im2: Vec<f32>,
    mag: Vec<f32>,
    hold_mag: Vec<f32>,
    hold_w: Vec<f32>,
    last_ph: Vec<f32>,
    syn_ph: Vec<f32>,
    out_mag: Vec<f32>,
    out_w: Vec<f32>,
    prefix: Vec<f32>,
    ola: Vec<Vec<f32>>,
    ola_r: usize,
    sp_freeze: f64,
    sp_smear: usize,
    sp_phase: u8,
    sp_shift: i64,
    // harmonic
    h_bank: [Bandpass; MAX_VOICES],
    h_gain: [f32; MAX_VOICES],
    h_key: Option<[f64; 6]>,
}

impl Morph {
    pub fn new(sr: f64) -> Self {
        let mut rng = Rng::new(0x6d6f_7270);
        let walkers = (0..MAX_VOICES)
            .map(|_| {
                let v = rng.bipolar();
                Walker { v, t: v, left: 0.0 }
            })
            .collect();
        let lens = [[142, 379], [163, 421], [191, 467], [211, 509], [233, 557], [257, 601], [277, 643], [307, 701]];
        let g_size = (sr * 2.2).ceil() as usize;
        Morph {
            sr,
            rng,
            quiet: 0,
            quiet_blocks: (3.0 * sr / 128.0).ceil() as usize,
            idle: false,
            algo: -1,
            env_f: 0.0,
            env_s: 0.0,
            a_f: (-1.0 / (sr * 0.003)).exp(),
            r_f: (-1.0 / (sr * 0.06)).exp(),
            a_s: (-1.0 / (sr * 0.01)).exp(),
            r_s: (-1.0 / (sr * 0.25)).exp(),
            vs: [0.0; MAX_VOICES],
            home: [0.0; MAX_VOICES],
            fixed_az: [f32::NAN; MAX_VOICES],
            pan: [0.0; MAX_VOICES * MAX_CH],
            field: [0.0; MAX_CH],
            nv: 0,
            path_phase: 0.0,
            walkers,
            path_lorenz: Lorenz::new(),
            diff: lens.iter().map(|[a, b]| [AllPass::new(*a, 0.6), AllPass::new(*b, 0.55)]).collect(),
            fm_ph_c: [0.0, 0.25],
            fm_ph_m: [0.0, 0.5],
            fm_prev: [0.0; 2],
            fm_fc: 0.0,
            fm_ratio: 1.0,
            fm_index: 0.0,
            fm_fb: 0.0,
            fm_voice: 0.0,
            g_size,
            g_buf: vec![0.0; g_size],
            g_w: 0,
            g_count: 0.0,
            grains: [Grain { on: false, pos: 0.0, inc: 1.0, t: 0.0, len: 1.0 }; MAX_VOICES],
            g_rate: 1.0,
            g_len: 1.0,
            g_pitch: 0.0,
            g_back: 0.0,
            g_norm: 1.0,
            s_len: 4096,
            s_buf: (0..4).map(|_| vec![0.0; 4096]).collect(),
            s_w: 0,
            s_lp: [0.0; 4],
            s_delay: [0.0; 4],
            s_fb: 0.0,
            s_damp: 0.0,
            s_noise: 0.0,
            s_exc: 0.0,
            formants: [Bandpass::default(); 3],
            vowel_phase: 0.0,
            v_lvl_in: 0.0,
            v_lvl_out: 0.0,
            dc_x: [0.0; 2],
            dc_y: [0.0; 2],
            lp: [0.0; 2],
            f_drive: 0.0,
            f_folds: 0.0,
            f_sym: 0.0,
            f_order: 2.0,
            f_cheb_lvl: 0.0,
            lorenz: Lorenz::new(),
            svf_ic1: 0.0,
            svf_ic2: 0.0,
            svf_a1: 0.0,
            svf_a2: 0.0,
            svf_a3: 0.0,
            c_amp: 1.0,
            fft: Fft::new(),
            in_ring: vec![0.0; N_FFT],
            in_w: 0,
            hop_count: 0,
            re: vec![0.0; N_FFT],
            im: vec![0.0; N_FFT],
            re2: vec![0.0; N_FFT],
            im2: vec![0.0; N_FFT],
            mag: vec![0.0; HALF + 1],
            hold_mag: vec![0.0; HALF + 1],
            hold_w: vec![0.0; HALF + 1],
            last_ph: vec![0.0; HALF + 1],
            syn_ph: vec![0.0; HALF + 1],
            out_mag: vec![0.0; HALF + 1],
            out_w: vec![0.0; HALF + 1],
            prefix: vec![0.0; HALF + 2],
            ola: (0..4).map(|_| vec![0.0; N_FFT]).collect(),
            ola_r: 0,
            sp_freeze: 0.0,
            sp_smear: 0,
            sp_phase: 0,
            sp_shift: 0,
            h_bank: [Bandpass::default(); MAX_VOICES],
            h_gain: [0.0; MAX_VOICES],
            h_key: None,
        }
    }

    fn even_homes(&mut self, n: usize) {
        for v in 0..MAX_VOICES {
            self.home[v] = if n <= 1 { 0.0 } else { (-1.0 + (2.0 * v as f64) / (n - 1) as f64) as f32 };
            self.fixed_az[v] = f32::NAN;
        }
    }

    fn place_voices(&mut self, p: &MorphParams, n_ch: usize) {
        let sr = self.sr;
        let rate = p.motion * p.motion * 2.0;
        let t = 128.0 / sr;
        self.path_phase += rate * t;
        if self.path_phase >= 1.0 {
            self.path_phase -= 1.0;
        }
        let ph = TAU * self.path_phase;
        let path = js_round(p.path) as i64;
        let mut lorenz_az = 0.0;
        if path == 6 {
            self.path_lorenz.step(0.0005 + rate * 0.004, 28.0, 4);
            lorenz_az = self.path_lorenz.x.atan2(self.path_lorenz.y) / DEG;
        }
        let reach = 180.0 * p.spread;
        for v in 0..self.nv {
            let fixed = self.fixed_az[v];
            if !fixed.is_nan() {
                set_pan(&mut self.pan[v * MAX_CH..(v + 1) * MAX_CH], fixed as f64, n_ch);
                continue;
            }
            let h = self.home[v] as f64;
            let mut az = h * reach;
            match path {
                1 => az += 360.0 * self.path_phase,
                2 => az += 90.0 * ph.sin(),
                3 => az += (if h < 0.0 { -1.0 } else { 1.0 }) * 180.0 * (0.5 - 0.5 * ph.cos()),
                4 => az += (if v % 2 == 1 { 1.0 } else { -1.0 }) * 120.0 * ph.sin(),
                5 => {
                    let (w, rng) = (&mut self.walkers[v], &mut self.rng);
                    az += 150.0 * w.step(rng, (rate * 2.0).max(0.1), sr);
                }
                6 => az += lorenz_az,
                _ => {}
            }
            set_pan(&mut self.pan[v * MAX_CH..(v + 1) * MAX_CH], az, n_ch);
        }
    }

    fn prepare(&mut self, p: &MorphParams, algo: i64) {
        let sr = self.sr;
        let root = TUNING_ROOTS[(js_round(p.tuning) as i64).clamp(0, 4) as usize] * semis(js_round(p.note));
        match algo {
            0 => {
                self.nv = 2;
                self.even_homes(2);
                self.home[0] = -0.35;
                self.home[1] = 0.35;
                self.fm_fc = root * 2.0;
                self.fm_ratio = FM_RATIOS[((p.a * FM_RATIOS.len() as f64).floor() as usize).min(FM_RATIOS.len() - 1)];
                self.fm_index = p.b * 6.0;
                self.fm_fb = p.c * 1.2;
                self.fm_voice = p.d;
            }
            1 => {
                if self.nv != MAX_VOICES {
                    self.nv = MAX_VOICES;
                    self.even_homes(MAX_VOICES);
                }
                self.g_rate = 3.0 + p.a * 57.0;
                self.g_len = (sr * (0.02 + p.b * 0.23)).floor();
                self.g_pitch = p.c;
                self.g_back = p.d * 1.5;
                let overlap = (1f64).max(self.g_rate * self.g_len / sr);
                self.g_norm = 1.6 / overlap.sqrt();
            }
            2 => {
                self.nv = 4;
                self.even_homes(4);
                let chord = STRING_CHORDS[((p.c * STRING_CHORDS.len() as f64).floor() as usize).min(STRING_CHORDS.len() - 1)];
                for k in 0..4 {
                    let mut f = root * semis(chord[k]);
                    while f < sr / (self.s_len - 4) as f64 {
                        f *= 2.0;
                    }
                    self.s_delay[k] = (sr / f) as f32;
                }
                self.s_fb = 0.9 + 0.0995 * p.a.sqrt();
                self.s_damp = 0.08 + 0.88 * p.b;
                self.s_noise = p.d;
                self.s_exc = 0.35 * (1.0 - self.s_fb) * 40.0 + 0.02;
            }
            3 => {
                self.nv = 3;
                self.even_homes(3);
                self.home[0] = 0.0;
                self.home[1] = -0.8;
                self.home[2] = 0.8;
                self.vowel_phase += p.b * 6.0 * (128.0 / sr);
                if self.vowel_phase >= 1.0 {
                    self.vowel_phase -= 1.0;
                }
                let mut pos = p.a * 4.0 + p.c * 2.0 * (TAU * self.vowel_phase).sin();
                pos = pos.abs() % 8.0;
                if pos > 4.0 {
                    pos = 8.0 - pos;
                }
                let i = (pos.floor() as usize).min(3);
                let f = pos - i as f64;
                let scale = 1.35 - 0.7 * p.d;
                for k in 0..3 {
                    let hz = (VOWELS[i][k] + (VOWELS[i + 1][k] - VOWELS[i][k]) * f) * scale;
                    self.formants[k].set(hz.clamp(20.0, sr * 0.45), 6.0 + 3.0 * k as f64, sr);
                }
            }
            4 => {
                self.nv = 2;
                self.even_homes(2);
                self.home[0] = -0.5;
                self.home[1] = 0.5;
                self.f_drive = 0.5 + p.a * 4.0;
                self.f_folds = 1.0 + p.b * 6.0;
                self.f_sym = p.c * 0.9;
                self.f_order = 2.0 + p.d * 6.0;
                self.f_cheb_lvl = 0.3 + 0.7 * p.d;
            }
            5 => {
                self.nv = 2;
                self.even_homes(2);
                let rho = 14.0 + p.c * 36.0;
                self.lorenz.step(0.0004 + p.a * 0.006, rho, 4);
                let l = &self.lorenz;
                let xn = (l.x / 20.0).clamp(-1.0, 1.0);
                let cutoff = (1200.0 * 2f64.powf(xn * p.b * 4.0)).clamp(60.0, 12000.0);
                let g = (std::f64::consts::PI * cutoff / sr).tan();
                let k = 2.0 - 1.7 * (0.3 + 0.6 * p.b);
                self.svf_a1 = 1.0 / (1.0 + g * (g + k));
                self.svf_a2 = g * self.svf_a1;
                self.svf_a3 = g * self.svf_a2;
                self.c_amp = 1.0 - p.d * (l.z / 50.0).clamp(0.0, 1.0);
                let az = l.x.atan2(l.y) / DEG;
                self.fixed_az[0] = (az * p.spread) as f32;
                self.fixed_az[1] = ((az + 180.0) * p.spread) as f32;
            }
            6 => {
                self.nv = 4;
                self.even_homes(4);
                self.home[0] = 0.0;
                self.home[1] = -0.7;
                self.home[2] = 0.7;
                self.home[3] = 1.0;
                self.sp_freeze = p.a;
                self.sp_smear = js_round(p.b * 12.0) as usize;
                self.sp_phase = if p.c < 1.0 / 3.0 { 0 } else if p.c < 2.0 / 3.0 { 1 } else { 2 };
                self.sp_shift = js_round((p.d - 0.5) * 48.0) as i64;
            }
            _ => {
                let beat = if p.c > 0.01 { p.c * 12.0 } else { 0.0 };
                let kk = 1 + js_round(p.a * 7.0) as usize;
                let phi = js_round(p.tuning) as i64 == 4;
                let key = [root, kk as f64, p.b, beat, p.d, phi as u8 as f64];
                self.nv = if beat > 0.0 { 2 * kk } else { kk };
                self.even_homes(kk);
                if self.h_key != Some(key) {
                    self.h_key = Some(key);
                    let q = 20.0 + p.b * 280.0;
                    let golden = (1.0 + 5f64.sqrt()) / 2.0;
                    for k in 0..kk {
                        let mut f = if phi { root * golden.powi(k as i32) } else { root * (k + 1) as f64 };
                        while f > 9000.0 {
                            f /= 2.0;
                        }
                        let oct = (f / 3500.0).log2();
                        let ear_dip = 1.0 - p.d * 0.85 * (-(oct * oct) / (2.0 * 0.45 * 0.45)).exp();
                        let g = ((k + 1) as f64).powf(-0.6) * ear_dip * q.sqrt() * 3.3;
                        self.h_bank[k].set(f.clamp(20.0, sr * 0.45), q, sr);
                        self.h_gain[k] = g as f32;
                        if beat > 0.0 {
                            self.h_bank[kk + k].set((f + beat).clamp(20.0, sr * 0.45), q, sr);
                            self.h_gain[kk + k] = g as f32;
                        }
                    }
                }
                if beat > 0.0 {
                    for k in 0..kk {
                        self.fixed_az[k] = -90.0;
                        self.fixed_az[kk + k] = 90.0;
                    }
                }
            }
        }
    }

    fn reset(&mut self) {
        self.env_f = 0.0;
        self.env_s = 0.0;
        self.g_buf.fill(0.0);
        for g in &mut self.grains {
            g.on = false;
        }
        for b in &mut self.s_buf {
            b.fill(0.0);
        }
        self.s_lp = [0.0; 4];
        for f in &mut self.formants {
            f.reset();
        }
        self.v_lvl_in = 0.0;
        self.v_lvl_out = 0.0;
        self.dc_x = [0.0; 2];
        self.dc_y = [0.0; 2];
        self.lp = [0.0; 2];
        self.svf_ic1 = 0.0;
        self.svf_ic2 = 0.0;
        self.in_ring.fill(0.0);
        for o in &mut self.ola {
            o.fill(0.0);
        }
        self.hold_mag.fill(0.0);
        self.hold_w.fill(0.0);
        self.last_ph.fill(0.0);
        self.syn_ph.fill(0.0);
        for b in &mut self.h_bank {
            b.reset();
        }
        for d in &mut self.diff {
            for ap in d.iter_mut() {
                ap.buf.fill(0.0);
            }
        }
        self.fm_prev = [0.0; 2];
    }

    pub fn process(&mut self, p: &MorphParams, input: &[&[f32]], output: &mut [&mut [f32]]) {
        let n_ch = output.len();
        let frames = output[0].len();
        let n_in = input.len();
        let in_l = input[0];
        let in_r = if n_in > 1 { input[1] } else { input[0] };

        let silent = (0..frames).all(|n| in_l[n] == 0.0 && in_r[n] == 0.0);
        if silent {
            if self.quiet < self.quiet_blocks {
                self.quiet += 1;
            } else {
                if !self.idle {
                    self.reset();
                    self.idle = true;
                }
                for o in output.iter_mut() {
                    o.fill(0.0);
                }
                return;
            }
        } else {
            self.quiet = 0;
            self.idle = false;
        }

        let dry_of = |c: usize| -> Option<&[f32]> {
            if c < n_in {
                Some(input[c])
            } else if c == 1 {
                Some(in_r)
            } else {
                None
            }
        };
        let mix = p.mix;
        if mix <= 0.0 {
            for c in 0..n_ch {
                match dry_of(c) {
                    Some(d) => output[c].copy_from_slice(&d[..frames]),
                    None => output[c].fill(0.0),
                }
            }
            return;
        }

        let algo = (js_round(p.algo) as i64).clamp(0, 7);
        if algo != self.algo {
            self.algo = algo;
            self.reset();
            self.h_key = None;
            self.nv = 0;
            self.even_homes(0);
        }
        self.prepare(p, algo);
        self.place_voices(p, n_ch);

        let nv = self.nv;
        let diffuse = p.diffuse;
        let da = (diffuse * std::f64::consts::PI / 2.0).cos();
        let db = (diffuse * std::f64::consts::PI / 2.0).sin();
        let dry_mix = 1.0 - mix;

        for n in 0..frames {
            let x = 0.5 * (in_l[n] as f64 + in_r[n] as f64);
            let ax = x.abs();
            self.env_f = if ax > self.env_f { self.env_f + (ax - self.env_f) * (1.0 - self.a_f) } else { self.env_f * self.r_f };
            self.env_s = if ax > self.env_s { self.env_s + (ax - self.env_s) * (1.0 - self.a_s) } else { self.env_s * self.r_s };
            for v in 0..nv {
                self.vs[v] = 0.0;
            }
            match algo {
                0 => self.run_fm(x),
                1 => self.run_grain(x),
                2 => self.run_strings(x),
                3 => self.run_vowel(x),
                4 => self.run_fold(x),
                5 => self.run_chaos(x),
                6 => self.run_spectral(x),
                _ => self.run_harmonic(x),
            }
            for c in 0..n_ch {
                self.field[c] = 0.0;
            }
            for v in 0..nv {
                let s = self.vs[v] as f64;
                if s == 0.0 {
                    continue;
                }
                let o = v * MAX_CH;
                for c in 0..n_ch {
                    self.field[c] = (self.field[c] as f64 + s * self.pan[o + c] as f64) as f32;
                }
            }
            for c in 0..n_ch {
                let mut w = self.field[c] as f64;
                if diffuse > 0.0 {
                    let d = &mut self.diff[c];
                    let y = d[0].process(w);
                    w = da * w + db * d[1].process(y);
                }
                let dry = dry_of(c).map(|d| d[n] as f64).unwrap_or(0.0);
                output[c][n] = soft_clip(dry * dry_mix + w * mix) as f32;
            }
        }
    }

    #[inline]
    fn agc(&self, x: f64) -> f64 {
        (x / (self.env_s + 0.003)).tanh()
    }

    fn run_fm(&mut self, x: f64) {
        let xn = self.agc(x) * self.fm_voice;
        let amp = self.env_f * 0.5;
        for k in 0..2 {
            let det = if k == 1 { 1.004 } else { 1.0 };
            let fc = self.fm_fc * det;
            let m = xn + (1.0 - self.fm_voice) * (TAU * self.fm_ph_m[k]).sin();
            let y = (TAU * self.fm_ph_c[k] + self.fm_index * (if k == 1 { 0.8 } else { 1.0 }) * m + self.fm_fb * self.fm_prev[k]).sin();
            self.fm_prev[k] = y;
            self.fm_ph_c[k] += fc / self.sr;
            if self.fm_ph_c[k] >= 1.0 {
                self.fm_ph_c[k] -= 1.0;
            }
            self.fm_ph_m[k] += fc * self.fm_ratio / self.sr;
            if self.fm_ph_m[k] >= 1.0 {
                self.fm_ph_m[k] -= 1.0;
            }
            self.vs[k] = (y * amp) as f32;
        }
    }

    fn run_grain(&mut self, x: f64) {
        let size = self.g_size;
        self.g_buf[self.g_w] = x as f32;
        self.g_count -= 1.0;
        if self.g_count <= 0.0 {
            self.g_count = (1f64).max(((self.sr / self.g_rate) * (0.6 + 0.8 * self.rng.next())).floor());
            self.spawn_grain();
        }
        for v in 0..MAX_VOICES {
            let g = &mut self.grains[v];
            if !g.on {
                continue;
            }
            let mut pos = g.pos % size as f64;
            if pos < 0.0 {
                pos += size as f64;
            }
            let i = pos as usize;
            let f = pos - i as f64;
            let a = self.g_buf[i] as f64;
            let b = self.g_buf[(i + 1) % size] as f64;
            let w = 0.5 - 0.5 * (TAU * g.t / g.len).cos();
            self.vs[v] = ((a + (b - a) * f) * w * self.g_norm) as f32;
            g.pos += g.inc;
            g.t += 1.0;
            if g.t >= g.len {
                g.on = false;
            }
        }
        self.g_w = (self.g_w + 1) % size;
    }

    fn spawn_grain(&mut self) {
        let Some(slot) = (0..MAX_VOICES).find(|&v| !self.grains[v].on) else { return };
        let r = &mut self.rng;
        let mut semi = 0.0;
        if r.next() < self.g_pitch {
            semi = [12.0, -12.0, 7.0, 5.0, -5.0, 19.0, 24.0][(r.next() * 7.0).floor() as usize];
        }
        semi += r.bipolar() * self.g_pitch * 0.3;
        let inc = semis(semi);
        let len = self.g_len;
        let back = len * inc.max(1.0) + 64.0 + r.next() * self.g_back * self.sr;
        let pos = self.g_w as f64 - back.min(self.g_size as f64 - 2.0);
        let home = r.bipolar();
        self.grains[slot] = Grain { on: true, inc, t: 0.0, len, pos };
        self.home[slot] = home as f32;
    }

    fn run_strings(&mut self, x: f64) {
        let exc = x * self.s_exc + self.s_noise * self.rng.bipolar() * self.env_f * 0.25;
        let l = self.s_len;
        let w = self.s_w;
        for k in 0..4 {
            let mut r = w as f64 - self.s_delay[k] as f64;
            if r < 0.0 {
                r += l as f64;
            }
            let i = r as usize;
            let f = r - i as f64;
            let buf = &mut self.s_buf[k];
            let a = buf[i] as f64;
            let b = buf[(i + 1) % l] as f64;
            let y = a + (b - a) * f;
            let lp = self.s_lp[k] as f64;
            self.s_lp[k] = (lp + self.s_damp * (y - lp)) as f32;
            buf[w] = (exc + self.s_fb * self.s_lp[k] as f64) as f32;
            self.vs[k] = (self.s_lp[k] as f64 * 0.45) as f32;
        }
        self.s_w = (w + 1) % l;
    }

    fn run_vowel(&mut self, x: f64) {
        let buzz = (3.0 * self.agc(x)).tanh() * self.env_f;
        let mut sum = 0.0;
        for k in 0..3 {
            let y = self.formants[k].process(buzz) * FORMANT_GAIN[k];
            self.vs[k] = y as f32;
            sum += y.abs();
        }
        let c = 0.9996;
        self.v_lvl_in = self.v_lvl_in * c + x.abs() * (1.0 - c);
        self.v_lvl_out = self.v_lvl_out * c + sum * (1.0 - c);
        let g = (12f64).min(self.v_lvl_in / (self.v_lvl_out + 1e-5));
        for k in 0..3 {
            self.vs[k] = (self.vs[k] as f64 * (g * 1.9)) as f32;
        }
    }

    fn run_fold(&mut self, x: f64) {
        let xn = (x / (self.env_s + 0.02)) * self.f_drive;
        let fold = (std::f64::consts::PI / 2.0 * (xn * self.f_folds + self.f_sym)).sin();
        let t = xn.tanh();
        let n0 = self.f_order.floor() as i64;
        let fr = self.f_order - n0 as f64;
        let (mut t_prev, mut t_cur, mut tn0, mut tn1) = (1.0, t, 0.0, 0.0);
        for k in 1..=n0 + 1 {
            if k == n0 {
                tn0 = t_cur;
            }
            if k == n0 + 1 {
                tn1 = t_cur;
            }
            let next = 2.0 * t * t_cur - t_prev;
            t_prev = t_cur;
            t_cur = next;
        }
        let cheb = tn0 + (tn1 - tn0) * fr;
        let env = self.env_f;
        let outs = [fold * env, cheb * env * self.f_cheb_lvl];
        for k in 0..2 {
            let y = outs[k] - self.dc_x[k] + 0.995 * self.dc_y[k];
            self.dc_x[k] = outs[k];
            self.dc_y[k] = y;
            self.lp[k] += 0.55 * (y - self.lp[k]);
            self.vs[k] = self.lp[k] as f32;
        }
    }

    fn run_chaos(&mut self, x: f64) {
        let v3 = x - self.svf_ic2;
        let v1 = self.svf_a1 * self.svf_ic1 + self.svf_a2 * v3;
        let v2 = self.svf_ic2 + self.svf_a2 * self.svf_ic1 + self.svf_a3 * v3;
        self.svf_ic1 = 2.0 * v1 - self.svf_ic1;
        self.svf_ic2 = 2.0 * v2 - self.svf_ic2;
        self.vs[0] = (v2 * self.c_amp * 1.9) as f32;
        self.vs[1] = (v1 * self.c_amp * 2.8) as f32;
    }

    fn run_spectral(&mut self, x: f64) {
        self.in_ring[self.in_w] = x as f32;
        self.in_w = (self.in_w + 1) % N_FFT;
        for b in 0..4 {
            self.vs[b] = self.ola[b][self.ola_r];
            self.ola[b][self.ola_r] = 0.0;
        }
        self.ola_r = (self.ola_r + 1) % N_FFT;
        self.hop_count += 1;
        if self.hop_count >= HOP {
            self.hop_count = 0;
            self.spectral_frame();
        }
    }

    fn spectral_frame(&mut self) {
        let hann = &self.fft.hann;
        for i in 0..N_FFT {
            self.re[i] = (self.in_ring[(self.in_w + i) % N_FFT] as f64 * hann[i] as f64) as f32;
            self.im[i] = 0.0;
        }
        self.fft.run(&mut self.re, &mut self.im, false);
        let expect = TAU * HOP as f64 / N_FFT as f64;
        let fz = self.sp_freeze;
        for k in 0..=HALF {
            let (r, i) = (self.re[k] as f64, self.im[k] as f64);
            let m = r.hypot(i);
            let ph = i.atan2(r);
            let w = expect * k as f64 + princarg(ph - self.last_ph[k] as f64 - expect * k as f64);
            self.last_ph[k] = ph as f32;
            self.hold_mag[k] = (self.hold_mag[k] as f64 * fz + m * (1.0 - fz)) as f32;
            self.hold_w[k] = (self.hold_w[k] as f64 * fz + w * (1.0 - fz)) as f32;
        }
        let s = self.sp_smear;
        if s > 0 {
            self.prefix[0] = 0.0;
            for k in 0..=HALF {
                self.prefix[k + 1] = (self.prefix[k] as f64 + self.hold_mag[k] as f64) as f32;
            }
            for k in 0..=HALF {
                let lo = k.saturating_sub(s);
                let hi = (k + s).min(HALF);
                self.mag[k] = ((self.prefix[hi + 1] as f64 - self.prefix[lo] as f64) / (hi - lo + 1) as f64) as f32;
            }
        } else {
            self.mag.copy_from_slice(&self.hold_mag);
        }
        let sh = self.sp_shift;
        for k in 0..=HALF {
            let src = k as i64 - sh;
            if src < 1 || src > HALF as i64 {
                self.out_mag[k] = 0.0;
                self.out_w[k] = (expect * k as f64) as f32;
                continue;
            }
            self.out_mag[k] = self.mag[src as usize];
            self.out_w[k] = (self.hold_w[src as usize] as f64 + expect * sh as f64) as f32;
        }
        for k in 0..=HALF {
            self.syn_ph[k] = match self.sp_phase {
                0 => princarg(self.syn_ph[k] as f64 + self.out_w[k] as f64) as f32,
                1 => ((k & 1) as f64 * std::f64::consts::PI) as f32,
                _ => (TAU * self.rng.next()) as f32,
            };
        }
        let scale = 1.0 / (N_FFT as f64 * 1.5);
        for pair in 0..2 {
            self.re2.fill(0.0);
            self.im2.fill(0.0);
            for side in 0..2 {
                let band = pair * 2 + side;
                for k in BAND_EDGES[band]..BAND_EDGES[band + 1] {
                    let om = self.out_mag[k] as f64;
                    let sp = self.syn_ph[k] as f64;
                    let ar = om * sp.cos();
                    let ai = om * sp.sin();
                    let add = |v: &mut f32, d: f64| *v = (*v as f64 + d) as f32;
                    if side == 0 {
                        add(&mut self.re2[k], ar);
                        add(&mut self.im2[k], ai);
                        if k != HALF {
                            add(&mut self.re2[N_FFT - k], ar);
                            add(&mut self.im2[N_FFT - k], -ai);
                        }
                    } else {
                        add(&mut self.re2[k], -ai);
                        add(&mut self.im2[k], ar);
                        if k != HALF {
                            add(&mut self.re2[N_FFT - k], ai);
                            add(&mut self.im2[N_FFT - k], ar);
                        }
                    }
                }
            }
            self.fft.run(&mut self.re2, &mut self.im2, true);
            let hann = &self.fft.hann;
            for i in 0..N_FFT {
                let j = (self.ola_r + i) % N_FFT;
                let (oa, ob) = (pair * 2, pair * 2 + 1);
                self.ola[oa][j] = (self.ola[oa][j] as f64 + self.re2[i] as f64 * hann[i] as f64 * scale) as f32;
                self.ola[ob][j] = (self.ola[ob][j] as f64 + self.im2[i] as f64 * hann[i] as f64 * scale) as f32;
            }
        }
    }

    fn run_harmonic(&mut self, x: f64) {
        for v in 0..self.nv {
            self.vs[v] = (self.h_bank[v].process(x) * self.h_gain[v] as f64) as f32;
        }
    }
}
