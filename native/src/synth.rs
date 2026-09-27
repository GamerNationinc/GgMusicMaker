//! VOICE SYNTH — port of public/voice-synth-processor.js (see its header for
//! the signal flow). Processes one render quantum (≤ 128 frames) per call
//! with k-rate params, exactly like the worklet.

use crate::util::*;
use serde::Deserialize;

const BANDS: usize = 20;
const F_LO: f64 = 100.0;
const F_HI: f64 = 8000.0;
const NOISE_FROM_BAND: usize = 15;
const CARRIER_C3: f64 = 130.81;
const EPS: f64 = 1e-4;
const MAX_UNISON: usize = 8;
const MAX_POLY: usize = 4;
const L_MAIN: usize = 0;
const L_UNISON: usize = 1;
const L_SUB: usize = L_UNISON + MAX_UNISON - 1;
const L_SHIMMER: usize = L_SUB + 1;
const L_POLY: usize = L_SHIMMER + 1;
const L_VOCODER: usize = L_POLY + MAX_POLY;
const L_TALKBOX: usize = L_VOCODER + 1;
const L_COMPUVOX: usize = L_TALKBOX + 1;
const N_LAYERS: usize = L_COMPUVOX + 1;
const CHORDS: [&[f64]; 7] = [&[0.0], &[0.0, 12.0], &[0.0, 7.0], &[0.0, 4.0, 7.0], &[0.0, 3.0, 7.0], &[0.0, 5.0, 7.0], &[-12.0, 0.0, 7.0, 12.0]];

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SynthParams {
    pub mix: f64,
    pub pitch: f64,
    pub formant: f64,
    pub chord: f64,
    pub glide: f64,
    pub shift: f64,
    pub vocoder: f64,
    pub talkbox: f64,
    pub compuvox: f64,
    pub polyvox: f64,
    pub character: f64,
    pub unison: f64,
    pub detune: f64,
    pub sub: f64,
    pub shimmer: f64,
    pub vibrato_rate: f64,
    pub vibrato_depth: f64,
    pub drift: f64,
    pub formant_rate: f64,
    pub formant_depth: f64,
    pub env_pitch: f64,
    pub env_formant: f64,
    pub env_width: f64,
    pub width: f64,
    pub orbit_rate: f64,
    pub orbit_depth: f64,
    pub ensemble: f64,
    pub rear: f64,
    pub lfe: f64,
    pub center: f64,
    pub ring: f64,
    pub pan: f64,
    pub path: f64,
    pub diffuse: f64,
}

impl SynthParams {
    /// Round to f32 like an AudioParam, so the port sees exactly what the
    /// worklet sees.
    pub fn quantize(&mut self) {
        self.mix = self.mix as f32 as f64;
        self.pitch = self.pitch as f32 as f64;
        self.formant = self.formant as f32 as f64;
        self.chord = self.chord as f32 as f64;
        self.glide = self.glide as f32 as f64;
        self.shift = self.shift as f32 as f64;
        self.vocoder = self.vocoder as f32 as f64;
        self.talkbox = self.talkbox as f32 as f64;
        self.compuvox = self.compuvox as f32 as f64;
        self.polyvox = self.polyvox as f32 as f64;
        self.character = self.character as f32 as f64;
        self.unison = self.unison as f32 as f64;
        self.detune = self.detune as f32 as f64;
        self.sub = self.sub as f32 as f64;
        self.shimmer = self.shimmer as f32 as f64;
        self.vibrato_rate = self.vibrato_rate as f32 as f64;
        self.vibrato_depth = self.vibrato_depth as f32 as f64;
        self.drift = self.drift as f32 as f64;
        self.formant_rate = self.formant_rate as f32 as f64;
        self.formant_depth = self.formant_depth as f32 as f64;
        self.env_pitch = self.env_pitch as f32 as f64;
        self.env_formant = self.env_formant as f32 as f64;
        self.env_width = self.env_width as f32 as f64;
        self.width = self.width as f32 as f64;
        self.orbit_rate = self.orbit_rate as f32 as f64;
        self.orbit_depth = self.orbit_depth as f32 as f64;
        self.ensemble = self.ensemble as f32 as f64;
        self.rear = self.rear as f32 as f64;
        self.lfe = self.lfe as f32 as f64;
        self.center = self.center as f32 as f64;
        self.ring = self.ring as f32 as f64;
        self.pan = self.pan as f32 as f64;
        self.path = self.path as f32 as f64;
        self.diffuse = self.diffuse as f32 as f64;
    }
}

struct Shifter {
    grain: f64,
    size: usize,
    buf: Vec<f32>,
    w: usize,
    phase: f64,
}
impl Shifter {
    fn new(phase: f64, sr: f64) -> Self {
        let grain = (sr * 0.05).floor();
        let size = (grain * 2.0) as usize;
        Shifter { grain, size, buf: vec![0.0; size], w: 0, phase }
    }
    #[inline]
    fn read(&self, pos: f64) -> f64 {
        let mut p = pos % self.size as f64;
        if p < 0.0 {
            p += self.size as f64;
        }
        let i = p as usize;
        let f = p - i as f64;
        let a = self.buf[i] as f64;
        let b = self.buf[(i + 1) % self.size] as f64;
        a + (b - a) * f
    }
    #[inline]
    fn process(&mut self, x: f64, ratio: f64) -> f64 {
        self.buf[self.w] = x as f32;
        let p1 = self.phase;
        let mut p2 = p1 + 0.5;
        if p2 >= 1.0 {
            p2 -= 1.0;
        }
        let w = self.w as f64;
        let y = (std::f64::consts::PI * p1).sin() * self.read(w - p1 * self.grain)
            + (std::f64::consts::PI * p2).sin() * self.read(w - p2 * self.grain);
        self.phase += (1.0 - ratio) / self.grain;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        } else if self.phase < 0.0 {
            self.phase += 1.0;
        }
        self.w = (self.w + 1) % self.size;
        y
    }
}

#[inline]
fn poly_blep(mut t: f64, dt: f64) -> f64 {
    if t < dt {
        t /= dt;
        return t + t - t * t - 1.0;
    }
    if t > 1.0 - dt {
        t = (t - 1.0) / dt;
        return t * t + t + t + 1.0;
    }
    0.0
}

#[derive(Clone, Copy)]
struct Osc {
    phase: f64,
    dt: f64,
    saw: f64,
    pulse: f64,
}
impl Osc {
    fn set_freq(&mut self, hz: f64, sr: f64) {
        self.dt = hz / sr;
    }
    #[inline]
    fn step(&mut self, width: f64) {
        let t = self.phase;
        let dt = self.dt;
        if dt <= 0.0 {
            self.saw = 0.0;
            self.pulse = 0.0;
            return;
        }
        let saw = 2.0 * t - 1.0 - poly_blep(t, dt);
        let mut t2 = t + width;
        if t2 >= 1.0 {
            t2 -= 1.0;
        }
        self.saw = saw;
        self.pulse = saw - (2.0 * t2 - 1.0 - poly_blep(t2, dt));
        self.phase = t + dt;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
    }
}

struct Drift {
    value: f64,
    target: f64,
    left: f64,
    coef: f64,
}
impl Drift {
    fn step(&mut self, rng: &mut Rng, sr: f64) -> f64 {
        if self.left <= 0.0 {
            self.target = rng.bipolar();
            self.left = (sr * (0.4 + 1.2 * rng.next())).floor();
        }
        self.left -= 128.0;
        self.value = self.target + (self.value - self.target) * self.coef;
        self.value
    }
}

struct VocoderEngine {
    syn: [Bandpass; BANDS],
    q: f64,
    wet_env: f64,
    hold_val: f64,
    hold_n: f64,
}
impl VocoderEngine {
    fn new() -> Self {
        VocoderEngine { syn: [Bandpass::default(); BANDS], q: 0.0, wet_env: 0.0, hold_val: 0.0, hold_n: 0.0 }
    }
    fn set_q(&mut self, centers: &[f32; BANDS], q: f64, sr: f64) {
        if q == self.q {
            return;
        }
        self.q = q;
        for i in 0..BANDS {
            self.syn[i].set((centers[i] as f64).min(sr * 0.45), q, sr);
        }
    }
}

struct Chorus {
    size: usize,
    buf: Vec<f32>,
    w: usize,
    phase: f64,
    dphase: f64,
    base: f64,
    depth: f64,
}
impl Chorus {
    fn new(phase: f64, rate: f64, sr: f64) -> Self {
        let size = (sr * 0.045).ceil() as usize;
        Chorus { size, buf: vec![0.0; size], w: 0, phase, dphase: rate / sr, base: sr * 0.014, depth: sr * 0.006 }
    }
    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        self.buf[self.w] = x as f32;
        let d = self.base + self.depth * (TAU * self.phase).sin();
        self.phase += self.dphase;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        let mut p = self.w as f64 - d;
        if p < 0.0 {
            p += self.size as f64;
        }
        let i = p as usize;
        let f = p - i as f64;
        let a = self.buf[i] as f64;
        let b = self.buf[(i + 1) % self.size] as f64;
        self.w = (self.w + 1) % self.size;
        a + (b - a) * f
    }
}

pub struct VoiceSynth {
    sr: f64,
    rng: Rng,
    quiet: usize,
    quiet_blocks: usize,
    idle: bool,
    centers: [f32; BANDS],
    bands_per_semi: f64,
    ana: [Bandpass; BANDS],
    band: [f32; BANDS],
    env: [f32; BANDS],
    env_a: f64,
    env_r: f64,
    shifters: Vec<Shifter>,
    drifts: Vec<Drift>,
    osc: [Osc; 4],
    n_osc: usize,
    vocoder: VocoderEngine,
    talkbox: VocoderEngine,
    compuvox: VocoderEngine,
    lvl: f64,
    in_env: f64,
    dyn_a: f64,
    dyn_r: f64,
    dynv: f64,
    vib_phase: f64,
    fmt_phase: f64,
    orbit_phase: f64,
    ring_phase: f64,
    pitch_sm: f64,
    pitch_init: bool,
    layer_sig: [f32; N_LAYERS],
    layer_lvl: [f32; N_LAYERS],
    layer_ratio: [f32; N_LAYERS],
    pan: [f32; N_LAYERS * MAX_CH],
    field: [f32; MAX_CH],
    active: [usize; N_LAYERS],
    n_active: usize,
    chorus: Vec<Chorus>,
    lfe_lp: Lowpass,
    diff: Vec<[AllPass; 2]>,
    // per-block
    f_shift: f64,
    use_bank: bool,
    any_vocoder: bool,
    voc_noise: f64,
    tb_drive: f64,
    cv_hold: f64,
    cv_quant: f64,
}

impl VoiceSynth {
    pub fn new(sr: f64) -> Self {
        let mut rng = Rng::new(0x5eed_1234);
        let octaves = (F_HI / F_LO).log2();
        let mut centers = [0f32; BANDS];
        for (i, c) in centers.iter_mut().enumerate() {
            *c = (F_LO * 2f64.powf(octaves * i as f64 / (BANDS - 1) as f64)) as f32;
        }
        let mut ana = [Bandpass::default(); BANDS];
        for i in 0..BANDS {
            ana[i].set((centers[i] as f64).min(sr * 0.45), 4.5, sr);
        }
        let shifters = (0..N_LAYERS).map(|i| Shifter::new((i as f64 * 0.37) % 1.0, sr)).collect();
        let coef = (-128.0 / (sr * 0.16)).exp();
        let drifts = (0..N_LAYERS).map(|_| Drift { value: 0.0, target: 0.0, left: 0.0, coef }).collect();
        let _ = &mut rng;
        let lens = [[149, 383], [167, 431], [193, 461], [211, 503], [229, 563], [251, 599], [281, 641], [311, 709]];
        VoiceSynth {
            sr,
            rng,
            quiet: 0,
            quiet_blocks: (0.6 * sr / 128.0).ceil() as usize,
            idle: false,
            centers,
            bands_per_semi: (BANDS - 1) as f64 / (octaves * 12.0),
            ana,
            band: [0.0; BANDS],
            env: [0.0; BANDS],
            env_a: (-1.0 / (sr * 0.004)).exp(),
            env_r: (-1.0 / (sr * 0.025)).exp(),
            shifters,
            drifts,
            osc: [0.0, 0.25, 0.5, 0.75].map(|phase| Osc { phase, dt: 0.0, saw: 0.0, pulse: 0.0 }),
            n_osc: 0,
            vocoder: VocoderEngine::new(),
            talkbox: VocoderEngine::new(),
            compuvox: VocoderEngine::new(),
            lvl: (-1.0 / (sr * 0.04)).exp(),
            in_env: 0.0,
            dyn_a: (-1.0 / (sr * 0.005)).exp(),
            dyn_r: (-1.0 / (sr * 0.12)).exp(),
            dynv: 0.0,
            vib_phase: 0.0,
            fmt_phase: 0.0,
            orbit_phase: 0.0,
            ring_phase: 0.0,
            pitch_sm: 0.0,
            pitch_init: false,
            layer_sig: [0.0; N_LAYERS],
            layer_lvl: [0.0; N_LAYERS],
            layer_ratio: [0.0; N_LAYERS],
            pan: [0.0; N_LAYERS * MAX_CH],
            field: [0.0; MAX_CH],
            active: [0; N_LAYERS],
            n_active: 0,
            chorus: (0..MAX_CH).map(|c| Chorus::new(c as f64 / MAX_CH as f64, 0.45 + 0.11 * c as f64, sr)).collect(),
            lfe_lp: Lowpass::new(80.0, sr),
            diff: lens.iter().map(|[a, b]| [AllPass::new(*a, 0.6), AllPass::new(*b, 0.55)]).collect(),
            f_shift: 0.0,
            use_bank: false,
            any_vocoder: false,
            voc_noise: 0.0,
            tb_drive: 0.0,
            cv_hold: 0.0,
            cv_quant: 0.0,
        }
    }

    #[inline]
    fn env_at(&self, pos: f64) -> f64 {
        let env = &self.env;
        if pos <= 0.0 {
            return env[0] as f64;
        }
        if pos >= (BANDS - 1) as f64 {
            return env[BANDS - 1] as f64;
        }
        let i = pos as usize;
        let f = pos - i as f64;
        env[i] as f64 + (env[i + 1] as f64 - env[i] as f64) * f
    }

    fn place(&mut self, layer: usize, frac: f64, reach: f64, rot: f64, depth: f64, path: i64, n_ch: usize) {
        let oph = TAU * self.orbit_phase;
        let o = match path {
            1 => depth * 360.0 * self.orbit_phase,
            2 => (if frac < 0.0 { -1.0 } else { 1.0 }) * depth * 180.0 * (0.5 - 0.5 * oph.cos()),
            3 => (if frac < 0.0 { -1.0 } else { 1.0 }) * depth * 150.0 * oph.sin(),
            4 => depth * 170.0 * self.drifts[layer].value,
            _ => depth * 180.0 * oph.sin(),
        };
        set_pan(&mut self.pan[layer * MAX_CH..(layer + 1) * MAX_CH], frac * reach + rot + o, n_ch);
    }

    fn prepare_block(&mut self, p: &SynthParams, n_ch: usize) {
        let sr = self.sr;
        let t = 128.0 / sr;
        let d = clamp01((20.0 * (self.dynv + 1e-6).log10() + 42.0) / 42.0);

        let pitch = p.pitch;
        if !self.pitch_init {
            self.pitch_sm = pitch;
            self.pitch_init = true;
        }
        let glide = if p.glide > 0.0 { (-t / (0.02 + 0.6 * p.glide)).exp() } else { 0.0 };
        self.pitch_sm = pitch + (self.pitch_sm - pitch) * glide;
        self.vib_phase += p.vibrato_rate * t;
        if self.vib_phase >= 1.0 {
            self.vib_phase -= 1.0;
        }
        let vib = (p.vibrato_depth / 100.0) * (TAU * self.vib_phase).sin();
        let base_pitch = self.pitch_sm + vib + p.env_pitch * d * 2.0;
        let drift_semi = p.drift / 100.0;

        self.fmt_phase += p.formant_rate * t;
        if self.fmt_phase >= 1.0 {
            self.fmt_phase -= 1.0;
        }
        let fmt = p.formant + p.formant_depth * (TAU * self.fmt_phase).sin() + p.env_formant * d * 6.0;
        self.f_shift = fmt * self.bands_per_semi;
        self.use_bank = fmt.abs() > 0.005;

        self.orbit_phase += p.orbit_rate * t;
        if self.orbit_phase >= 1.0 {
            self.orbit_phase -= 1.0;
        }
        let depth = p.orbit_depth;
        let path = js_round(p.path) as i64;
        let rot = p.pan * 180.0;
        let reach = (60.0 + 120.0 * p.rear) * clamp01(p.width + p.env_width * d);

        let mut n = 0;
        for i in 0..N_LAYERS {
            let (drifts, rng) = (&mut self.drifts, &mut self.rng);
            drifts[i].step(rng, sr);
        }
        let ratio_of = |s: &Self, semi: f64, layer: usize| semis(semi + drift_semi * s.drifts[layer].value);

        let unison = (js_round(p.unison) as i64).clamp(1, MAX_UNISON as i64) as usize;
        if p.shift > 0.0 {
            let norm = p.shift / (unison as f64).sqrt();
            self.layer_lvl[L_MAIN] = norm as f32;
            self.layer_ratio[L_MAIN] = ratio_of(self, base_pitch, L_MAIN) as f32;
            self.place(L_MAIN, 0.0, reach, rot, depth, path, n_ch);
            self.active[n] = L_MAIN;
            n += 1;
            for k in 1..unison {
                let f = if unison == 2 { 1.0 } else { -1.0 + (2.0 * (k - 1) as f64) / (unison - 2) as f64 };
                let l = L_UNISON + k - 1;
                self.layer_lvl[l] = norm as f32;
                self.layer_ratio[l] = ratio_of(self, base_pitch + (p.detune / 100.0) * f, l) as f32;
                let side = if k % 2 == 1 { 1.0 } else { -1.0 };
                let radius = ((k + 1) >> 1) as f64 / 1.max(unison >> 1) as f64;
                self.place(l, side * radius, reach, rot, depth, path, n_ch);
                self.active[n] = l;
                n += 1;
            }
        }
        if p.sub > 0.0 {
            self.layer_lvl[L_SUB] = p.sub as f32;
            self.layer_ratio[L_SUB] = ratio_of(self, base_pitch - 12.0, L_SUB) as f32;
            self.place(L_SUB, 0.0, reach, rot, depth, path, n_ch);
            self.active[n] = L_SUB;
            n += 1;
        }
        if p.shimmer > 0.0 {
            self.layer_lvl[L_SHIMMER] = p.shimmer as f32;
            self.layer_ratio[L_SHIMMER] = ratio_of(self, base_pitch + 12.0, L_SHIMMER) as f32;
            self.place(L_SHIMMER, 0.5, reach, rot, depth, path, n_ch);
            self.active[n] = L_SHIMMER;
            n += 1;
        }
        let intervals = CHORDS[(js_round(p.chord) as i64).clamp(0, CHORDS.len() as i64 - 1) as usize];
        if p.polyvox > 0.0 {
            let norm = p.polyvox / (intervals.len() as f64).sqrt();
            for v in 0..intervals.len() {
                let l = L_POLY + v;
                let det = (if v % 2 == 1 { -1.0 } else { 1.0 }) * p.character * 0.25 * (v + 1) as f64 * 0.5;
                self.layer_lvl[l] = norm as f32;
                self.layer_ratio[l] = ratio_of(self, base_pitch + intervals[v] + det, l) as f32;
                let frac = if v == 0 { 0.0 } else { (if v % 2 == 1 { 0.6 } else { -0.6 }) * (1.0 + (v >> 1) as f64 * 0.5) };
                self.place(l, frac, reach, rot, depth, path, n_ch);
                self.active[n] = l;
                n += 1;
            }
        }

        self.any_vocoder = p.vocoder > 0.0 || p.talkbox > 0.0 || p.compuvox > 0.0;
        if self.any_vocoder {
            let base = CARRIER_C3 * semis(base_pitch + drift_semi * self.drifts[L_VOCODER].value);
            for v in 0..4 {
                let hz = intervals.get(v).map(|iv| base * semis(*iv)).unwrap_or(0.0);
                self.osc[v].set_freq(hz, sr);
            }
            self.n_osc = intervals.len();
            let ch = p.character;
            let centers = self.centers;
            self.vocoder.set_q(&centers, 3.0 + 7.0 * ch, sr);
            self.talkbox.set_q(&centers, 6.0 + 8.0 * ch, sr);
            self.compuvox.set_q(&centers, 5.0, sr);
            self.voc_noise = 0.35 + 0.4 * ch;
            self.tb_drive = 1.5 + 6.0 * ch;
            self.cv_hold = 1.0 + js_round(ch * 11.0);
            self.cv_quant = 2f64.powf(12.0 - js_round(ch * 8.0));
            if p.vocoder > 0.0 {
                self.layer_lvl[L_VOCODER] = p.vocoder as f32;
                self.place(L_VOCODER, -0.35, reach, rot, depth, path, n_ch);
                self.active[n] = L_VOCODER;
                n += 1;
            }
            if p.talkbox > 0.0 {
                self.layer_lvl[L_TALKBOX] = p.talkbox as f32;
                self.place(L_TALKBOX, 0.35, reach, rot, depth, path, n_ch);
                self.active[n] = L_TALKBOX;
                n += 1;
            }
            if p.compuvox > 0.0 {
                self.layer_lvl[L_COMPUVOX] = p.compuvox as f32;
                self.place(L_COMPUVOX, 0.8, reach, rot, depth, path, n_ch);
                self.active[n] = L_COMPUVOX;
                n += 1;
            }
        }
        self.n_active = n;
    }

    fn reset(&mut self) {
        for s in &mut self.shifters {
            s.buf.fill(0.0);
        }
        for c in &mut self.chorus {
            c.buf.fill(0.0);
        }
        for d in &mut self.diff {
            for ap in d.iter_mut() {
                ap.buf.fill(0.0);
            }
        }
        for b in &mut self.ana {
            b.reset();
        }
        for e in [&mut self.vocoder, &mut self.talkbox, &mut self.compuvox] {
            for b in e.syn.iter_mut() {
                b.reset();
            }
            e.wet_env = 0.0;
            e.hold_val = 0.0;
            e.hold_n = 0.0;
        }
        self.env = [0.0; BANDS];
        self.layer_sig = [0.0; N_LAYERS];
        self.lfe_lp.z1 = 0.0;
        self.lfe_lp.z2 = 0.0;
        self.dynv = 0.0;
        self.in_env = 0.0;
    }

    /// `input`: 1..8 channels; `output`: the bus width (2, 6 or 8).
    pub fn process(&mut self, p: &SynthParams, input: &[&[f32]], output: &mut [&mut [f32]]) {
        let n_ch = output.len();
        let frames = output[0].len();
        let in_l = input[0];
        let in_r = if input.len() > 1 { input[1] } else { input[0] };
        let n_in = if input.len() > 1 { 2 } else { 1 };
        let n_in_ch = input.len();

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

        let mix = p.mix;
        if mix <= 0.0 {
            output[0].copy_from_slice(&in_l[..frames]);
            if n_ch > 1 {
                output[1].copy_from_slice(&in_r[..frames]);
            }
            for ch in 2..n_ch {
                if ch < n_in_ch {
                    output[ch].copy_from_slice(&input[ch][..frames]);
                } else {
                    output[ch].fill(0.0);
                }
            }
            return;
        }

        self.prepare_block(p, n_ch);
        let (env_a, env_r) = (self.env_a, self.env_r);
        let (use_bank, f_shift) = (self.use_bank, self.f_shift);
        let want_voc = p.vocoder > 0.0;
        let want_tb = p.talkbox > 0.0;
        let want_cv = p.compuvox > 0.0;
        let ring_hz = p.ring;
        let ensemble = p.ensemble;
        let center_send = if n_ch >= 6 { p.center } else { 0.0 };
        let lfe_send = if n_ch >= 6 { p.lfe } else { 0.0 };
        let ring_inc = ring_hz / self.sr;
        let diffuse = p.diffuse;
        let da = (diffuse * std::f64::consts::PI / 2.0).cos();
        let db = (diffuse * std::f64::consts::PI / 2.0).sin();
        let dry_mix = 1.0 - mix;

        for n in 0..frames {
            let mut mono = if n_in == 2 { 0.5 * (in_l[n] as f64 + in_r[n] as f64) } else { in_l[n] as f64 };
            if n_in_ch > 2 {
                for c in 2..n_in_ch {
                    if c != 3 || n_in_ch < 6 {
                        mono += 0.5 * input[c][n] as f64;
                    }
                }
            }
            let am = mono.abs();
            self.dynv = if am > self.dynv { self.dynv + (am - self.dynv) * (1.0 - self.dyn_a) } else { self.dynv * self.dyn_r };

            for i in 0..BANDS {
                let b = self.ana[i].process(mono);
                self.band[i] = b as f32;
                let a = b.abs();
                let e = self.env[i] as f64;
                self.env[i] = (if a > e { e + (a - e) * (1.0 - env_a) } else { e * env_r }) as f32;
            }

            let mut src = mono;
            if use_bank {
                src = 0.0;
                for i in 0..BANDS {
                    src += self.band[i] as f64 * (4f64).min((self.env_at(i as f64 - f_shift) + EPS) / (self.env[i] as f64 + EPS));
                }
            }

            for a in 0..self.n_active {
                let l = self.active[a];
                if l >= L_VOCODER {
                    continue;
                }
                let r = self.layer_ratio[l] as f64;
                self.layer_sig[l] = (if r == 1.0 { src } else { self.shifters[l].process(src, r) }) as f32;
            }

            if self.any_vocoder {
                let (mut saw, mut pulse, mut buzz) = (0.0, 0.0, 0.0);
                for v in 0..self.n_osc {
                    let o = &mut self.osc[v];
                    o.step(if want_cv { 0.08 } else { 0.18 });
                    saw += o.saw;
                    buzz += 0.5 * o.saw + 0.5 * o.pulse;
                    pulse += o.pulse;
                }
                let norm = 1.0 / (if self.n_osc == 0 { 1.0 } else { self.n_osc as f64 }).sqrt();
                saw *= norm;
                buzz *= norm;
                pulse *= norm;
                let noise = self.rng.bipolar();
                let ax = mono.abs();
                self.in_env = if ax > self.in_env { ax } else { self.in_env * self.lvl + ax * (1.0 - self.lvl) };
                if want_voc {
                    let amt = self.voc_noise;
                    let y = self.vocode(0, saw, noise, amt, use_bank, f_shift);
                    self.layer_sig[L_VOCODER] = y as f32;
                }
                if want_tb {
                    let y = self.vocode(1, buzz, noise, 0.25, use_bank, f_shift);
                    self.layer_sig[L_TALKBOX] = ((y * self.tb_drive).tanh() / self.tb_drive.tanh() * 0.9) as f32;
                }
                if want_cv {
                    let y = self.vocode(2, pulse, noise, 0.5, use_bank, f_shift);
                    let (q, hold) = (self.cv_quant, self.cv_hold);
                    let e = &mut self.compuvox;
                    if e.hold_n <= 0.0 {
                        e.hold_val = js_round(y * q) / q;
                        e.hold_n = hold;
                    }
                    e.hold_n -= 1.0;
                    self.layer_sig[L_COMPUVOX] = e.hold_val as f32;
                }
            }

            for c in 0..n_ch {
                self.field[c] = 0.0;
            }
            let mut wet_mono = 0.0;
            for a in 0..self.n_active {
                let l = self.active[a];
                let s = self.layer_sig[l] as f64 * self.layer_lvl[l] as f64;
                wet_mono += s;
                let o = l * MAX_CH;
                for c in 0..n_ch {
                    self.field[c] = (self.field[c] as f64 + s * self.pan[o + c] as f64) as f32;
                }
            }
            if ring_hz > 0.0 {
                let m = (TAU * self.ring_phase).sin();
                self.ring_phase += ring_inc;
                if self.ring_phase >= 1.0 {
                    self.ring_phase -= 1.0;
                }
                for c in 0..n_ch {
                    self.field[c] = (self.field[c] as f64 * m) as f32;
                }
            }
            if ensemble > 0.0 {
                for c in 0..n_ch {
                    let f = self.field[c] as f64;
                    self.field[c] = (f + ensemble * 0.7 * self.chorus[c].process(f)) as f32;
                }
            }
            if center_send > 0.0 {
                self.field[2] = (self.field[2] as f64 + mono * center_send) as f32;
            }
            if n_ch >= 6 {
                let low = self.lfe_lp.process(mono + wet_mono);
                if lfe_send > 0.0 {
                    self.field[3] = (self.field[3] as f64 + low * lfe_send) as f32;
                }
            }
            if diffuse > 0.0 {
                for c in 0..n_ch {
                    if c == 3 && n_ch >= 6 {
                        continue;
                    }
                    let f = self.field[c] as f64;
                    let ap = &mut self.diff[c];
                    let y = ap[0].process(f);
                    let y = ap[1].process(y);
                    self.field[c] = (da * f + db * y) as f32;
                }
            }
            for c in 0..n_ch {
                let dry = if c == 0 {
                    in_l[n] as f64
                } else if c == 1 {
                    in_r[n] as f64
                } else if c < n_in_ch {
                    input[c][n] as f64
                } else {
                    0.0
                };
                output[c][n] = soft_clip(dry * dry_mix + self.field[c] as f64 * mix) as f32;
            }
        }
    }

    fn vocode(&mut self, which: usize, carrier: f64, noise: f64, noise_amt: f64, use_bank: bool, f_shift: f64) -> f64 {
        let mut y = 0.0;
        for i in 0..BANDS {
            let src = if i >= NOISE_FROM_BAND { carrier * (1.0 - noise_amt) + noise * noise_amt } else { carrier };
            let g = if use_bank { self.env_at(i as f64 - f_shift) } else { self.env[i] as f64 };
            let e = match which {
                0 => &mut self.vocoder,
                1 => &mut self.talkbox,
                _ => &mut self.compuvox,
            };
            y += e.syn[i].process(src) * g;
        }
        let lvl = self.lvl;
        let in_env = self.in_env;
        let e = match which {
            0 => &mut self.vocoder,
            1 => &mut self.talkbox,
            _ => &mut self.compuvox,
        };
        let ay = y.abs();
        e.wet_env = if ay > e.wet_env { ay } else { e.wet_env * lvl + ay * (1.0 - lvl) };
        y * (60f64).min(in_env / (e.wet_env + EPS))
    }
}
