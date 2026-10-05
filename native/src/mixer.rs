//! The mixer — the whole web graph (audio/channel.ts + audio/master.ts) in
//! one place, rendered in 128-frame quanta like Web Audio:
//!
//!   clips → level → cuts → EQ → [PUNCH] → [BASS MOD] → [MORPH] → [VOICE SYNTH] → [placer]
//!         → bus (dry)  +  [send placer] → send → REVERB (stereo) → bus L/R
//!   bus ×master → meters → compressor(s) → [binaural] → device
//!
//! Bracketed stages are only in the path when engaged (same rule as the web
//! engine's `route`). The bus is 2, 6 or 8 channels. One Mixer serves both the
//! live stream and offline export. Nothing allocates while rendering.

use crate::bass::{Bass, BassParams};
use crate::binaural::Binaural;
use crate::dsp::{Biquad, Compressor, Kind, Punch, PunchParams};
use crate::morph::{Morph, MorphParams};
use crate::placer::Placer;
use crate::live::{Live, LiveEvent};
use crate::reverb::{Reverb, Space};
use crate::synth::{SynthParams, VoiceSynth};
use crate::util::MAX_CH;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;

pub const Q: usize = 128;
pub const SCOPE: usize = 2048;

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

impl EqSpec {
    /// Round to f32 like an AudioParam, so the port sees exactly what the
    /// worklet sees.
    pub fn quantize(&mut self) {
        self.low = self.low as f32 as f64;
        self.mid = self.mid as f32 as f64;
        self.high = self.high as f32 as f64;
        self.low_cut = self.low_cut as f32 as f64;
        self.high_cut = self.high_cut as f32 as f64;
    }
}

/// One layer as the page sends it (mute/solo/bypass already resolved:
/// a bypassed or idle module is `None`, a neutral placement is 0 / 1).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackSpec {
    pub id: String,
    pub gain: f64,
    pub eq: Option<EqSpec>,
    pub punch: Option<PunchParams>,
    #[serde(default)]
    pub bass: Option<BassParams>,
    pub morph: Option<MorphParams>,
    pub synth: Option<SynthParams>,
    pub pan: f64,
    pub width: f64,
    pub send: f64,
    pub send_pan: f64,
    pub send_width: f64,
    pub clips: Vec<ClipSpec>,
}

impl ProjectSpec {
    /// Every parameter the web engine keeps in an AudioParam is an f32 there.
    pub fn quantize(&mut self) {
        let q = |v: &mut f64| *v = *v as f32 as f64;
        q(&mut self.master_gain);
        for t in &mut self.tracks {
            for v in [&mut t.gain, &mut t.pan, &mut t.width, &mut t.send, &mut t.send_pan, &mut t.send_width] {
                q(v);
            }
            if let Some(e) = &mut t.eq {
                e.quantize();
            }
            if let Some(p) = &mut t.punch {
                p.quantize();
            }
            if let Some(p) = &mut t.bass {
                p.quantize();
            }
            if let Some(p) = &mut t.morph {
                p.quantize();
            }
            if let Some(p) = &mut t.synth {
                p.quantize();
            }
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSpec {
    pub tracks: Vec<TrackSpec>,
    pub master_gain: f64,
    /// 2, 6 or 8.
    #[serde(default = "two")]
    pub surround: usize,
    #[serde(default = "hall")]
    pub reverb: Space,
    /// Render a wider-than-device bus for headphones.
    #[serde(default)]
    pub binaural: bool,
    /// Song time of bar 1 (the tempo grid's offset): BASS MOD's LFO counts from it.
    #[serde(default)]
    pub bar_origin: f64,
}
fn two() -> usize {
    2
}
fn hall() -> Space {
    Space::Hall
}

type Bufs = [[f32; Q]; MAX_CH];

#[derive(Clone, Copy, PartialEq)]
enum Cur {
    S,
    A,
    B,
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
    bass: Box<Bass>,
    morph: Box<Morph>,
    synth: Box<VoiceSynth>,
    place: Placer,
    send_place: Placer,
    gl: f64,
    send: f64,
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
            bass: Box::new(Bass::new(sr)),
            morph: Box::new(Morph::new(sr)),
            synth: Box::new(VoiceSynth::new(sr)),
            place: Placer::default(),
            send_place: Placer::default(),
            gl: f64::NAN,
            send: f64::NAN,
        }
    }

    fn configure(&mut self, t: &TrackSpec, sr: f64) {
        if t.eq != self.eq {
            self.eq = t.eq;
            if let Some(e) = t.eq {
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

fn views<'a>(b: &'a Bufs, n: usize, q: usize) -> [&'a [f32]; MAX_CH] {
    let mut out: [&[f32]; MAX_CH] = [&[]; MAX_CH];
    for c in 0..n {
        out[c] = &b[c][..q];
    }
    out
}

fn views_mut(b: &mut Bufs, n: usize, q: usize) -> Vec<&mut [f32]> {
    b.iter_mut().take(n).map(|c| &mut c[..q]).collect()
}

pub struct Mixer {
    pub sr: f64,
    /// Channels of the device (live) — the bus never renders wider unless
    /// the binaural monitor folds it back down. Offline: 0 = "as the project".
    device_ch: usize,
    buffers: HashMap<String, Arc<Buffer>>,
    project: ProjectSpec,
    dsp: HashMap<String, TrackDsp>,
    reverb: Reverb,
    /// The instrument played live from the controller (Instrument mode).
    live: Live,
    binaural: Option<(usize, Binaural)>,
    comps: Vec<Compressor>,
    /// The compressor's look-ahead line (Chromium's DynamicsCompressor
    /// delays the signal 6 ms so the detector sees transients coming).
    ahead: Vec<[f64; MAX_CH]>,
    ahead_pos: usize,
    master: f64,
    pub playing: bool,
    from: f64,
    pos: u64,
    pub clock: u64,
    // scratch
    tl: [f64; Q],
    tr: [f64; Q],
    s: Bufs,
    a: Bufs,
    b: Bufs,
    bus: [[f64; Q]; MAX_CH],
    send: [[f64; Q]; 2],
    // meters of the last render call
    pub peak: f64,
    pub rms: f64,
    pub out_peak: f64,
    pub reduction: f64,
    pub scope: [f32; SCOPE],
    pub scope_pos: usize,
}

impl Mixer {
    pub fn new(sr: f64, device_ch: usize) -> Self {
        Mixer {
            sr,
            device_ch,
            buffers: HashMap::new(),
            project: ProjectSpec { tracks: vec![], master_gain: 0.9, surround: 2, reverb: Space::Hall, binaural: false, bar_origin: 0.0 },
            dsp: HashMap::new(),
            reverb: Reverb::new(Space::Hall, sr),
            live: Live::new(sr),
            binaural: None,
            comps: vec![],
            ahead: vec![[0.0; MAX_CH]; ((sr * 0.006).round() as usize).max(1)],
            ahead_pos: 0,
            master: f64::NAN,
            playing: false,
            from: 0.0,
            pos: 0,
            clock: 0,
            tl: [0.0; Q],
            tr: [0.0; Q],
            s: [[0.0; Q]; MAX_CH],
            a: [[0.0; Q]; MAX_CH],
            b: [[0.0; Q]; MAX_CH],
            bus: [[0.0; Q]; MAX_CH],
            send: [[0.0; Q]; 2],
            peak: 0.0,
            rms: 0.0,
            out_peak: 0.0,
            reduction: 0.0,
            scope: [0.0; SCOPE],
            scope_pos: 0,
        }
    }

    /// How long after rendering a frame it leaves the mixer (the master
    /// compressor's look-ahead line), in seconds.
    pub fn output_delay(&self) -> f64 {
        self.ahead.len() as f64 / self.sr
    }

    /// Bus width for the current project and device.
    pub fn bus_channels(&self) -> usize {
        let want = self.project.surround.clamp(2, 8);
        if self.device_ch == 0 || want <= self.device_ch {
            return want;
        }
        if self.project.binaural && (want == 6 || want == 8) {
            want
        } else {
            self.device_ch.min(2).max(2)
        }
    }

    pub fn add_buffer(&mut self, id: String, b: Arc<Buffer>) -> Option<Arc<Buffer>> {
        self.buffers.insert(id, b)
    }
    pub fn remove_buffer(&mut self, id: &str) -> Option<Arc<Buffer>> {
        self.buffers.remove(id)
    }

    /// Swap in a project. New layers' DSP and a new reverb (if the space
    /// changed) are built by the caller off the audio thread; everything
    /// replaced is handed back to be freed there too.
    pub fn set_project(&mut self, p: ProjectSpec, fresh: Vec<(String, TrackDsp)>, reverb: Option<Reverb>) -> (ProjectSpec, Vec<TrackDsp>, Option<Reverb>) {
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
        let old_reverb = reverb.map(|r| std::mem::replace(&mut self.reverb, r));
        let old = std::mem::replace(&mut self.project, p);
        if self.master.is_nan() {
            self.master = self.project.master_gain;
        }
        (old, dropped, old_reverb)
    }

    pub fn live_event(&mut self, e: LiveEvent) {
        self.live.event(e);
    }

    pub fn reverb_space(&self) -> Space {
        self.reverb.space
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

    /// Render interleaved-free output: `out` has the device's channels.
    pub fn render(&mut self, out: &mut [&mut [f32]]) {
        let n = out[0].len();
        let (mut peak, mut sq, mut opeak) = (0f64, 0f64, 0f64);
        let mut done = 0;
        while done < n {
            let q = (n - done).min(Q);
            let (p, s, o) = self.render_quantum(out, done, q);
            peak = peak.max(p);
            sq += s;
            opeak = opeak.max(o);
            done += q;
        }
        self.peak = peak;
        self.rms = (sq / n.max(1) as f64).sqrt();
        self.out_peak = opeak;
        self.clock += n as u64;
    }

    fn render_quantum(&mut self, out: &mut [&mut [f32]], at: usize, q: usize) -> (f64, f64, f64) {
        let sr = self.sr;
        let nb = self.bus_channels();
        for c in 0..nb {
            self.bus[c][..q].fill(0.0);
        }
        self.send[0][..q].fill(0.0);
        self.send[1][..q].fill(0.0);

        if self.playing {
            let t0 = self.time();
            let bar_t = t0 - self.project.bar_origin;
            let sm = (-1.0 / (sr * 0.01)).exp();
            for t in &self.project.tracks {
                let Some(d) = self.dsp.get_mut(&t.id) else { continue };
                // --- clips → tl/tr ---
                self.tl[..q].fill(0.0);
                self.tr[..q].fill(0.0);
                let mut any = false;
                for c in &t.clips {
                    let Some(b) = self.buffers.get(&c.buffer) else { continue };
                    let end = c.start + c.duration;
                    let t1 = t0 + q as f64 / sr;
                    if end <= t0 || c.start >= t1 {
                        continue;
                    }
                    any = true;
                    let l = &b.channels[0];
                    let r = b.channels.get(1).unwrap_or(l);
                    let first = (((c.start - t0) * sr).ceil().max(0.0)) as usize;
                    let last = (((end - t0) * sr).ceil().min(q as f64)) as usize;
                    for i in first..last {
                        let src = (t0 + i as f64 / sr - c.start + c.offset) * b.rate;
                        if src < 0.0 {
                            continue;
                        }
                        let k = src as usize;
                        if k + 1 >= l.len() {
                            if k < l.len() {
                                self.tl[i] += l[k] as f64;
                                self.tr[i] += r[k] as f64;
                            }
                            continue;
                        }
                        let f = src - k as f64;
                        self.tl[i] += l[k] as f64 + (l[k + 1] as f64 - l[k] as f64) * f;
                        self.tr[i] += r[k] as f64 + (r[k + 1] as f64 - r[k] as f64) * f;
                    }
                }
                if d.gl.is_nan() {
                    d.gl = t.gain;
                }
                if d.send.is_nan() {
                    d.send = t.send;
                }
                let stages = t.morph.is_some() || t.synth.is_some() || t.pan != 0.0 || t.width != 1.0;
                // An idle layer with nothing ringing costs nothing (the
                // worklets' own idle logic handles tails once audio stops).
                if !any && d.gl.abs() < 1e-9 && t.gain == 0.0 && !stages {
                    continue;
                }
                // --- level + EQ → stereo pin (s[0..2]) ---
                let eq = d.eq.is_some();
                for i in 0..q {
                    d.gl = t.gain + (d.gl - t.gain) * sm;
                    let (mut x, mut y) = (self.tl[i] * d.gl, self.tr[i] * d.gl);
                    if eq {
                        x = d.hi[0].process(d.mid[0].process(d.lo[0].process(d.cut_hi[0].process(d.cut_lo[0].process(x)))));
                        y = d.hi[1].process(d.mid[1].process(d.lo[1].process(d.cut_hi[1].process(d.cut_lo[1].process(y)))));
                    }
                    self.s[0][i] = x as f32;
                    self.s[1][i] = y as f32;
                }
                // --- PUNCH (stereo) ---
                if t.punch.is_some() {
                    for i in 0..q {
                        let (a, b) = d.punch.step(self.s[0][i] as f64, self.s[1][i] as f64);
                        self.s[0][i] = a as f32;
                        self.s[1][i] = b as f32;
                    }
                }
                // --- BASS MOD (stereo), LFO locked to the song ---
                if let Some(bp) = t.bass {
                    let (sl, sr_) = self.s.split_at_mut(1);
                    d.bass.process(bp, bar_t, &mut sl[0][..q], &mut sr_[0][..q]);
                }
                // --- MORPH → SYNTH → placer: each stage reads the current
                // buffer and writes the other of a/b ---
                let mut cur = Cur::S;
                for stage in 0..3 {
                    let run = match stage {
                        0 => t.morph.is_some(),
                        1 => t.synth.is_some(),
                        _ => stages,
                    };
                    if !run {
                        continue;
                    }
                    let n_in = if cur == Cur::S { 2 } else { nb };
                    let (src, dst, next) = match cur {
                        Cur::S => (&self.s, &mut self.a, Cur::A),
                        Cur::A => (&self.a, &mut self.b, Cur::B),
                        Cur::B => (&self.b, &mut self.a, Cur::A),
                    };
                    let inp = views(src, n_in, q);
                    let mut o = views_mut(dst, nb, q);
                    match stage {
                        0 => d.morph.process(t.morph.as_ref().unwrap(), &inp[..n_in], &mut o),
                        1 => d.synth.process(t.synth.as_ref().unwrap(), &inp[..n_in], &mut o),
                        _ => d.place.process(t.pan, t.width, &inp[..n_in], &mut o),
                    }
                    cur = next;
                }
                let (outb, n_out): (&Bufs, usize) = match cur {
                    Cur::S => (&self.s, 2),
                    Cur::A => (&self.a, nb),
                    Cur::B => (&self.b, nb),
                };
                // --- dry to the bus ---
                for c in 0..n_out.min(nb) {
                    for i in 0..q {
                        self.bus[c][i] += outb[c][i] as f64;
                    }
                }
                // --- reverb send ---
                if t.send > 0.0 || d.send.abs() > 1e-9 {
                    let neutral = t.send_pan == 0.0 && t.send_width == 1.0;
                    let mut tmp: Bufs = [[0.0; Q]; MAX_CH];
                    let (sb, sn): (&Bufs, usize) = if neutral {
                        (outb, n_out)
                    } else {
                        let inp = views(outb, n_out, q);
                        let mut o = views_mut(&mut tmp, nb, q);
                        d.send_place.process(t.send_pan, t.send_width, &inp[..n_out], &mut o);
                        (&tmp, nb)
                    };
                    for i in 0..q {
                        d.send = t.send + (d.send - t.send) * sm;
                        let g = d.send;
                        // ConvolverNode input: 2 ch, "speakers" downmix (5.1 → L + √½(C+Ls));
                        // 7.1 has no speaker rule, so its first two channels.
                        let (l, r) = if sn == 6 {
                            let h = std::f64::consts::FRAC_1_SQRT_2;
                            (
                                sb[0][i] as f64 + h * (sb[2][i] as f64 + sb[4][i] as f64),
                                sb[1][i] as f64 + h * (sb[2][i] as f64 + sb[5][i] as f64),
                            )
                        } else {
                            (sb[0][i] as f64, sb[1][i] as f64)
                        };
                        self.send[0][i] += l * g;
                        self.send[1][i] += r * g;
                    }
                }
            }
            self.pos += q as u64;
        }

        // --- live instrument (plays whether or not the transport runs) ---
        if self.live.active() {
            let (b0, b1) = self.bus.split_at_mut(1);
            let (s0, s1) = self.send.split_at_mut(1);
            self.live.render([&mut b0[0][..q], &mut b1[0][..q]], [&mut s0[0][..q], &mut s1[0][..q]]);
        }

        // --- reverb return → bus L/R (runs always so tails ring out) ---
        for i in 0..q {
            let (l, r) = self.reverb.step(self.send[0][i], self.send[1][i]);
            self.bus[0][i] += l;
            self.bus[1][i] += r;
        }

        // --- master: level, meters, compressor(s), device ---
        let target = self.project.master_gain;
        if self.master.is_nan() {
            self.master = target;
        }
        let sm = (-1.0 / (sr * 0.01)).exp();
        let linked = nb == 2;
        let want_comps = if linked { 1 } else { nb };
        if self.comps.len() != want_comps {
            // Only on a bus-width change (rare); a fresh compressor is cheap.
            self.comps = (0..want_comps).map(|_| Compressor::new(sr)).collect();
        }
        let binaural = self.device_ch != 0 && nb > self.device_ch;
        if binaural && self.binaural.as_ref().map(|b| b.0) != Some(nb) {
            self.binaural = Some((nb, Binaural::new(nb, sr)));
        }
        let (mut peak, mut sq, mut opeak) = (0f64, 0f64, 0f64);
        let mut red = 0f64;
        let mut frame = [0f64; MAX_CH];
        for i in 0..q {
            self.master = target + (self.master - target) * sm;
            for c in 0..nb {
                frame[c] = self.bus[c][i] * self.master;
                peak = peak.max(frame[c].abs());
            }
            sq += 0.5 * (frame[0] * frame[0] + frame[1] * frame[1]);
            self.scope[self.scope_pos] = (0.5 * (frame[0] + frame[1])) as f32;
            self.scope_pos = (self.scope_pos + 1) % SCOPE;
            // Detect on the incoming sample, apply to the one 6 ms older.
            let slot = &mut self.ahead[self.ahead_pos];
            let delayed = *slot;
            *slot = frame;
            self.ahead_pos = (self.ahead_pos + 1) % self.ahead.len();
            if linked {
                let g = self.comps[0].gain(frame[0].abs().max(frame[1].abs()));
                frame[0] = delayed[0] * g;
                frame[1] = delayed[1] * g;
                red = red.min(self.comps[0].reduction_db);
            } else {
                for c in 0..nb {
                    let g = self.comps[c].gain(frame[c].abs());
                    frame[c] = delayed[c] * g;
                    red = red.min(self.comps[c].reduction_db);
                }
            }
            if binaural {
                let (l, r) = self.binaural.as_mut().unwrap().1.step(&frame[..nb]);
                frame[0] = l;
                frame[1] = r;
                for c in 2..nb {
                    frame[c] = 0.0;
                }
            }
            for (c, o) in out.iter_mut().enumerate() {
                let v = if c < nb && (!binaural || c < 2) { frame[c] } else { 0.0 };
                opeak = opeak.max(v.abs());
                o[at + i] = v as f32;
            }
        }
        self.reduction = red;
        (peak, sq, opeak)
    }

    pub fn duration(&self) -> f64 {
        self.project.tracks.iter().flat_map(|t| t.clips.iter()).map(|c| c.start + c.duration).fold(0.0, f64::max)
    }
}
