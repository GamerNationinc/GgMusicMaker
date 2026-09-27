//! The mixer: clips → per-layer chain → master → limiter → meters.
//!
//! One `Mixer` renders both the live stream (on the audio thread) and an
//! offline export, so they can't drift apart. It never allocates while
//! rendering: layer DSP state is created when a project arrives, and the
//! scratch buffers are sized up front.

use crate::dsp::{Biquad, Kind, Limiter, Punch, PunchParams};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;

pub const MAX_BLOCK: usize = 4096;

/// Decoded audio, one Vec per channel (1 or 2), at its own sample rate.
pub struct Buffer {
    pub rate: f64,
    pub channels: Vec<Vec<f32>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClipSpec {
    pub buffer: String,
    pub start: f64,
    pub offset: f64,
    pub duration: f64,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EqSpec {
    pub low: f64,
    pub mid: f64,
    pub high: f64,
    pub low_cut: f64,
    pub high_cut: f64,
}

/// What the page sends for each layer (mute/solo/bypass already resolved).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackSpec {
    pub id: String,
    pub gain: f64,
    pub pan: f64,
    pub width: f64,
    /// None = EQ bypassed.
    pub eq: Option<EqSpec>,
    /// None = PUNCH off/bypassed.
    pub punch: Option<PunchParams>,
    pub clips: Vec<ClipSpec>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSpec {
    pub tracks: Vec<TrackSpec>,
    pub master_gain: f64,
}

/// Per-layer DSP state (survives project updates for the same layer id).
pub struct TrackDsp {
    cut_lo: [Biquad; 2],
    cut_hi: [Biquad; 2],
    lo: [Biquad; 2],
    mid: [Biquad; 2],
    hi: [Biquad; 2],
    eq: Option<EqSpec>,
    punch: Punch,
    /// Smoothed layer level (10 ms), so fader moves don't click; NaN until
    /// the layer first renders, so it starts at its level instead of fading in.
    gl: f64,
}

impl TrackDsp {
    pub fn new(sr: f64) -> Self {
        TrackDsp {
            cut_lo: [Biquad::identity(); 2],
            cut_hi: [Biquad::identity(); 2],
            lo: [Biquad::identity(); 2],
            mid: [Biquad::identity(); 2],
            hi: [Biquad::identity(); 2],
            eq: None,
            punch: Punch::new(sr),
            gl: f64::NAN,
        }
    }

    fn configure(&mut self, t: &TrackSpec, sr: f64) {
        if t.eq != self.eq {
            self.eq = t.eq;
            if let Some(e) = t.eq {
                // Same nodes, frequencies and Q as audio/channel.ts.
                let q = std::f64::consts::FRAC_1_SQRT_2;
                let lc = if e.low_cut > 20.0 { e.low_cut } else { 10.0 };
                let hc = if e.high_cut < 20000.0 { e.high_cut } else { sr / 2.0 };
                for c in 0..2 {
                    self.cut_lo[c].set(Kind::Highpass, lc, q, 0.0, sr);
                    self.cut_hi[c].set(Kind::Lowpass, hc.min(sr / 2.0), q, 0.0, sr);
                    self.lo[c].set(Kind::Lowshelf, 220.0, 1.0, e.low, sr);
                    self.mid[c].set(Kind::Peaking, 1200.0, 1.0, e.mid, sr);
                    self.hi[c].set(Kind::Highshelf, 4500.0, 1.0, e.high, sr);
                }
            }
        }
        if let Some(p) = t.punch {
            self.punch.set(p);
        }
    }
}

pub struct Mixer {
    pub sr: f64,
    buffers: HashMap<String, Arc<Buffer>>,
    project: ProjectSpec,
    dsp: HashMap<String, TrackDsp>,
    limiter: Limiter,
    master: f64,
    pub playing: bool,
    /// Playhead in seconds at `pos` = 0, and frames rendered since.
    from: f64,
    pos: u64,
    /// Frames the device has pulled in total (the audio clock).
    pub clock: u64,
    tl: Vec<f64>,
    tr: Vec<f64>,
    // Meters for the last block (pre-limiter peak / RMS, post-limiter peak).
    pub peak: f64,
    pub rms: f64,
    pub out_peak: f64,
}

impl Mixer {
    pub fn new(sr: f64) -> Self {
        Mixer {
            sr,
            buffers: HashMap::new(),
            project: ProjectSpec { tracks: vec![], master_gain: 0.9 },
            dsp: HashMap::new(),
            limiter: Limiter::new(sr),
            master: 0.9,
            playing: false,
            from: 0.0,
            pos: 0,
            clock: 0,
            tl: vec![0.0; MAX_BLOCK],
            tr: vec![0.0; MAX_BLOCK],
            peak: 0.0,
            rms: 0.0,
            out_peak: 0.0,
        }
    }

    pub fn add_buffer(&mut self, id: String, b: Arc<Buffer>) -> Option<Arc<Buffer>> {
        self.buffers.insert(id, b)
    }

    pub fn remove_buffer(&mut self, id: &str) -> Option<Arc<Buffer>> {
        self.buffers.remove(id)
    }

    /// Swap in a new project; returns the old one (dropped off this thread)
    /// plus DSP states of layers that no longer exist.
    pub fn set_project(&mut self, p: ProjectSpec, fresh: Vec<(String, TrackDsp)>) -> (ProjectSpec, Vec<TrackDsp>) {
        for (id, d) in fresh {
            self.dsp.entry(id).or_insert(d);
        }
        for t in &p.tracks {
            if let Some(d) = self.dsp.get_mut(&t.id) {
                d.configure(t, self.sr);
            }
        }
        let keep: std::collections::HashSet<&str> = p.tracks.iter().map(|t| t.id.as_str()).collect();
        let gone: Vec<String> = self.dsp.keys().filter(|k| !keep.contains(k.as_str())).cloned().collect();
        let dropped = gone.into_iter().filter_map(|k| self.dsp.remove(&k)).collect();
        self.master = p.master_gain;
        (std::mem::replace(&mut self.project, p), dropped)
    }

    pub fn has_dsp(&self, id: &str) -> bool {
        self.dsp.contains_key(id)
    }

    pub fn play(&mut self, from: f64) {
        self.from = from.max(0.0);
        self.pos = 0;
        self.playing = true;
    }

    pub fn stop(&mut self) {
        if self.playing {
            self.from = self.time();
            self.pos = 0;
        }
        self.playing = false;
    }

    pub fn time(&self) -> f64 {
        self.from + self.pos as f64 / self.sr
    }

    /// Render `out_l.len()` frames (any length; done in MAX_BLOCK chunks).
    pub fn render(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len();
        let mut done = 0;
        let (mut peak, mut sq, mut opeak) = (0f64, 0f64, 0f64);
        while done < n {
            let len = (n - done).min(MAX_BLOCK);
            let (p, s, o) = self.render_block(&mut out_l[done..done + len], &mut out_r[done..done + len]);
            peak = peak.max(p);
            sq += s;
            opeak = opeak.max(o);
            done += len;
        }
        self.peak = peak;
        self.rms = (sq / n.max(1) as f64).sqrt();
        self.out_peak = opeak;
        self.clock += n as u64;
    }

    fn render_block(&mut self, out_l: &mut [f32], out_r: &mut [f32]) -> (f64, f64, f64) {
        let n = out_l.len();
        let mut ml = [0f64; MAX_BLOCK];
        let mut mr = [0f64; MAX_BLOCK];
        if self.playing {
            let t0 = self.time();
            let sr = self.sr;
            for t in &self.project.tracks {
                let Some(d) = self.dsp.get_mut(&t.id) else { continue };
                let (tl, tr) = (&mut self.tl[..n], &mut self.tr[..n]);
                tl.fill(0.0);
                tr.fill(0.0);
                let mut any = false;
                for c in &t.clips {
                    let Some(b) = self.buffers.get(&c.buffer) else { continue };
                    let end = c.start + c.duration;
                    let t1 = t0 + n as f64 / sr;
                    if end <= t0 || c.start >= t1 {
                        continue;
                    }
                    any = true;
                    let l = &b.channels[0];
                    let r = b.channels.get(1).unwrap_or(l);
                    let first = (((c.start - t0) * sr).ceil().max(0.0)) as usize;
                    let last = (((end - t0) * sr).ceil().min(n as f64)) as usize;
                    for i in first..last {
                        let src = (t0 + i as f64 / sr - c.start + c.offset) * b.rate;
                        if src < 0.0 {
                            continue;
                        }
                        let k = src as usize;
                        if k + 1 >= l.len() {
                            if k < l.len() {
                                tl[i] += l[k] as f64;
                                tr[i] += r[k] as f64;
                            }
                            continue;
                        }
                        let f = src - k as f64;
                        tl[i] += l[k] as f64 + (l[k + 1] as f64 - l[k] as f64) * f;
                        tr[i] += r[k] as f64 + (r[k + 1] as f64 - r[k] as f64) * f;
                    }
                }
                // Chain order and gain staging as audio/channel.ts: level at the
                // input (so PUNCH sees the fader), then EQ, PUNCH, and the
                // placer's constant-power balance (unity at centre) + M/S width.
                let a = (t.pan + 1.0) * std::f64::consts::PI / 4.0;
                let (bl, br) = (a.cos() * std::f64::consts::SQRT_2, a.sin() * std::f64::consts::SQRT_2);
                if d.gl.is_nan() {
                    d.gl = t.gain;
                }
                if !any && d.gl.abs() < 1e-6 && t.gain == 0.0 {
                    continue;
                }
                let sm = (-1.0 / (sr * 0.01)).exp();
                let width = t.width;
                let punch = t.punch.is_some();
                let eq = d.eq.is_some();
                let target = t.gain;
                for i in 0..n {
                    d.gl = target + (d.gl - target) * sm;
                    let (mut x, mut y) = (tl[i] * d.gl, tr[i] * d.gl);
                    if eq {
                        x = d.hi[0].process(d.mid[0].process(d.lo[0].process(d.cut_hi[0].process(d.cut_lo[0].process(x)))));
                        y = d.hi[1].process(d.mid[1].process(d.lo[1].process(d.cut_hi[1].process(d.cut_lo[1].process(y)))));
                    }
                    if punch {
                        let (a, b) = d.punch.step(x, y);
                        x = a;
                        y = b;
                    }
                    if width != 1.0 {
                        let mid = 0.5 * (x + y);
                        let side = 0.5 * (x - y) * width;
                        x = mid + side;
                        y = mid - side;
                    }
                    ml[i] += x * bl;
                    mr[i] += y * br;
                }
            }
            self.pos += n as u64;
        }
        let (mut peak, mut sq, mut opeak) = (0f64, 0f64, 0f64);
        for i in 0..n {
            let l = ml[i] * self.master;
            let r = mr[i] * self.master;
            peak = peak.max(l.abs()).max(r.abs());
            sq += 0.5 * (l * l + r * r);
            let (a, b) = self.limiter.step(l, r);
            opeak = opeak.max(a.abs()).max(b.abs());
            out_l[i] = a as f32;
            out_r[i] = b as f32;
        }
        (peak, sq, opeak)
    }

    pub fn reduction_db(&self) -> f64 {
        self.limiter.reduction_db()
    }

    /// Project length in seconds (end of the last clip).
    pub fn duration(&self) -> f64 {
        self.project.tracks.iter().flat_map(|t| t.clips.iter()).map(|c| c.start + c.duration).fold(0.0, f64::max)
    }
}
