//! The pad sampler — SP-404-style pads in Instrument mode (src/pads/pads.ts,
//! docs/sampler-research.md §2). The web engine's twin is
//! src/audio/sampler.ts (Web Audio buffer sources); both follow the rules
//! below, so a pad sounds the same on either engine.
//!
//! A pad plays a region [start, end) of a loaded buffer:
//!   oneshot  plays the region through; letting go does nothing
//!   gate     plays while held; letting go releases it
//!   loop     latches: press starts looping the region, press again releases
//! reverse plays the region backwards; pitch repitches (semitones, speed
//! and pitch together). Envelope: linear attack (≥ 1 ms) and linear release
//! (≥ 5 ms); the end of a non-looping region fades over 3 ms so a chop
//! never clicks. Velocity × gain, then Web Audio's StereoPannerNode law for
//! stereo input (a mono buffer plays as L = R). Mono pads cut their own
//! previous voice; pads in the same choke group (> 0) cut each other.
//!
//! Triggers arrive as live events (`pad` / `padoff`); the pad settings come
//! with the project. Voices hold their own Arc of the buffer.

use crate::mixer::Buffer;
use serde::Deserialize;
use std::sync::Arc;

pub const VOICES: usize = 32;
/// Fade at the end of a non-looping region, seconds.
pub const DECLICK: f64 = 0.003;
/// Minimum attack / release, seconds.
pub const MIN_ATTACK: f64 = 0.001;
pub const MIN_RELEASE: f64 = 0.005;
/// How fast a choked / mono-cut voice goes, seconds.
pub const CUT: f64 = 0.005;

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PadMode {
    Oneshot,
    Gate,
    Loop,
}

fn one() -> f64 {
    1.0
}
fn yes() -> bool {
    true
}

/// One pad as the page sends it (only pads with a sample).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PadSpec {
    pub slot: u32,
    pub buffer: String,
    /// Region in the buffer, seconds.
    pub start: f64,
    pub end: f64,
    pub mode: PadMode,
    #[serde(default)]
    pub reverse: bool,
    #[serde(default = "one")]
    pub gain: f64,
    #[serde(default)]
    pub pan: f64,
    /// Semitones.
    #[serde(default)]
    pub pitch: f64,
    #[serde(default)]
    pub attack: f64,
    #[serde(default)]
    pub release: f64,
    /// 0 = none.
    #[serde(default)]
    pub choke: u32,
    #[serde(default = "yes")]
    pub mono: bool,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Stage {
    Off,
    Attack,
    Hold,
    Release,
}

#[derive(Clone)]
struct Voice {
    stage: Stage,
    slot: u32,
    mode: PadMode,
    choke: u32,
    age: u64,
    buf: Option<Arc<Buffer>>,
    /// Region in source frames.
    lo: f64,
    len: f64,
    reverse: bool,
    /// Source frames travelled into the region.
    t: f64,
    step: f64,
    gl: f64,
    gr: f64,
    pan: f64,
    env: f64,
    att: f64,
    rel: f64,
}

impl Voice {
    const IDLE: Voice = Voice {
        stage: Stage::Off,
        slot: 0,
        mode: PadMode::Oneshot,
        choke: 0,
        age: 0,
        buf: None,
        lo: 0.0,
        len: 0.0,
        reverse: false,
        t: 0.0,
        step: 1.0,
        gl: 0.0,
        gr: 0.0,
        pan: 0.0,
        env: 0.0,
        att: 0.0,
        rel: 0.0,
    };

    fn release(&mut self, seconds: f64, sr: f64) {
        if self.stage == Stage::Off {
            return;
        }
        let r = self.env / (seconds.max(MIN_RELEASE) * sr);
        // A cut never lengthens a release already under way.
        if self.stage != Stage::Release || r > self.rel {
            self.rel = r;
        }
        self.stage = Stage::Release;
    }
}

pub struct Sampler {
    sr: f64,
    voices: Vec<Voice>,
    clock: u64,
}

impl Sampler {
    pub fn new(sr: f64) -> Self {
        Sampler { sr, voices: vec![Voice::IDLE; VOICES], clock: 0 }
    }

    pub fn active(&self) -> bool {
        self.voices.iter().any(|v| v.stage != Stage::Off)
    }

    /// Voices sounding for `slot` (tests, UI).
    pub fn voices_of(&self, slot: u32) -> usize {
        self.voices.iter().filter(|v| v.stage != Stage::Off && v.stage != Stage::Release && v.slot == slot).count()
    }

    /// Press a pad. `buf` is the pad's sample (None: nothing happens).
    pub fn trigger(&mut self, p: &PadSpec, buf: Option<Arc<Buffer>>, vel: f64) {
        let sr = self.sr;
        let Some(buf) = buf else { return };
        // A latched loop: a second press lets it go.
        if p.mode == PadMode::Loop {
            let mut was = false;
            for v in &mut self.voices {
                if v.slot == p.slot && v.mode == PadMode::Loop && matches!(v.stage, Stage::Attack | Stage::Hold) {
                    v.release(p.release, sr);
                    was = true;
                }
            }
            if was {
                return;
            }
        }
        for v in &mut self.voices {
            let own = v.slot == p.slot && p.mono;
            let choked = p.choke > 0 && v.choke == p.choke && v.slot != p.slot;
            if own || choked {
                v.release(CUT, sr);
            }
        }
        let n = buf.channels[0].len() as f64;
        let lo = (p.start * buf.rate).floor().clamp(0.0, n);
        let hi = (p.end * buf.rate).ceil().clamp(lo, n);
        if hi - lo < 1.0 {
            return;
        }
        self.clock += 1;
        let slot = match self.voices.iter().position(|v| v.stage == Stage::Off) {
            Some(i) => i,
            None => (0..VOICES).min_by_key(|&i| self.voices[i].age).unwrap_or(0),
        };
        let g = vel.clamp(0.0, 1.0) * p.gain.max(0.0);
        self.voices[slot] = Voice {
            stage: Stage::Attack,
            slot: p.slot,
            mode: p.mode,
            choke: p.choke,
            age: self.clock,
            buf: Some(buf.clone()),
            lo,
            len: hi - lo,
            reverse: p.reverse,
            t: 0.0,
            step: buf.rate / sr * (p.pitch / 12.0).exp2(),
            gl: g,
            gr: g,
            pan: p.pan.clamp(-1.0, 1.0),
            env: 0.0,
            att: 1.0 / (p.attack.max(MIN_ATTACK) * sr),
            rel: 0.0,
        };
    }

    /// Let go of a pad: gate pads release; one-shots and latched loops don't.
    pub fn release(&mut self, slot: u32, release: f64) {
        let sr = self.sr;
        for v in &mut self.voices {
            if v.slot == slot && v.mode == PadMode::Gate && v.stage != Stage::Release {
                v.release(release, sr);
            }
        }
    }

    pub fn panic(&mut self) {
        for v in &mut self.voices {
            *v = Voice::IDLE;
        }
    }

    /// Add one block into `l` / `r`.
    pub fn render(&mut self, l: &mut [f64], r: &mut [f64]) {
        let half = std::f64::consts::FRAC_PI_2;
        for v in &mut self.voices {
            if v.stage == Stage::Off {
                continue;
            }
            let Some(buf) = v.buf.clone() else {
                v.stage = Stage::Off;
                continue;
            };
            let a = &buf.channels[0];
            let b = buf.channels.get(1).unwrap_or(a);
            let fade = DECLICK * buf.rate;
            let looping = v.mode == PadMode::Loop;
            // StereoPannerNode, stereo input.
            let x = if v.pan <= 0.0 { v.pan + 1.0 } else { v.pan };
            let (pl, pr) = ((x * half).cos().max(0.0), (x * half).sin());
            for i in 0..l.len() {
                match v.stage {
                    Stage::Attack => {
                        v.env += v.att;
                        if v.env >= 1.0 {
                            v.env = 1.0;
                            v.stage = Stage::Hold;
                        }
                    }
                    Stage::Release => {
                        v.env -= v.rel;
                        if v.env <= 0.0 {
                            v.stage = Stage::Off;
                            break;
                        }
                    }
                    _ => {}
                }
                if v.t >= v.len {
                    if !looping {
                        v.stage = Stage::Off;
                        break;
                    }
                    v.t %= v.len;
                }
                let p = if v.reverse { v.lo + v.len - 1.0 - v.t } else { v.lo + v.t };
                let p = p.max(v.lo);
                let k = p as usize;
                let f = p - k as f64;
                let k1 = (k + 1).min(a.len() - 1);
                let x = a[k] as f64 + (a[k1] as f64 - a[k] as f64) * f;
                let y = b[k] as f64 + (b[k1] as f64 - b[k] as f64) * f;
                let mut g = v.env;
                if !looping {
                    g *= ((v.len - v.t) / fade).min(1.0);
                }
                let (x, y) = (x * v.gl * g, y * v.gr * g);
                if v.pan <= 0.0 {
                    l[i] += x + y * pl;
                    r[i] += y * pr;
                } else {
                    l[i] += x * pl;
                    r[i] += y + x * pr;
                }
                v.t += v.step;
            }
            if v.stage == Stage::Off {
                v.buf = None; // freed here only if the pad's buffer was dropped meanwhile
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 1000.0;

    fn buf(samples: Vec<f32>) -> Arc<Buffer> {
        Arc::new(Buffer { rate: SR, channels: vec![samples.clone(), samples] })
    }
    fn ramp(n: usize) -> Vec<f32> {
        (0..n).map(|i| (i + 1) as f32 / n as f32).collect()
    }
    fn pad(mode: PadMode) -> PadSpec {
        PadSpec { slot: 0, buffer: "b".into(), start: 0.0, end: 1.0, mode, reverse: false, gain: 1.0, pan: 0.0, pitch: 0.0, attack: 0.0, release: 0.0, choke: 0, mono: true }
    }
    fn run(s: &mut Sampler, n: usize) -> (Vec<f64>, Vec<f64>) {
        let (mut l, mut r) = (vec![0.0; n], vec![0.0; n]);
        s.render(&mut l, &mut r);
        (l, r)
    }

    #[test]
    fn oneshot_plays_the_region_through_and_stops() {
        let mut s = Sampler::new(SR);
        let b = buf(vec![0.5; 1000]);
        let p = PadSpec { start: 0.1, end: 0.3, ..pad(PadMode::Oneshot) };
        s.trigger(&p, Some(b), 1.0);
        s.release(0, 0.0); // a one-shot ignores letting go
        let (l, r) = run(&mut s, 400);
        assert!((l[100] - 0.5).abs() < 1e-9 && (r[100] - 0.5).abs() < 1e-9, "{}", l[100]);
        assert!(l[198] < 0.5 && l[198] > 0.0, "declick at the end");
        assert_eq!(l[200], 0.0);
        assert!(!s.active());
    }

    #[test]
    fn reverse_reads_backwards() {
        let mut s = Sampler::new(SR);
        let p = PadSpec { reverse: true, attack: 0.0, ..pad(PadMode::Oneshot) };
        s.trigger(&p, Some(buf(ramp(1000))), 1.0);
        let (l, _) = run(&mut s, 600);
        assert!((l[10] - (990.0 / 1000.0)).abs() < 1e-6, "{}", l[10]);
        assert!((l[500] - (500.0 / 1000.0)).abs() < 1e-6, "{}", l[500]);
    }

    #[test]
    fn gate_releases_when_let_go() {
        let mut s = Sampler::new(SR);
        let p = PadSpec { release: 0.05, ..pad(PadMode::Gate) };
        s.trigger(&p, Some(buf(vec![1.0; 1000])), 1.0);
        let (l, _) = run(&mut s, 100);
        assert!((l[99] - 1.0).abs() < 1e-9);
        s.release(0, 0.05);
        let (l, _) = run(&mut s, 100);
        assert!(l[25] < 0.6 && l[25] > 0.4, "{}", l[25]);
        assert_eq!(l[60], 0.0);
        assert!(!s.active());
    }

    #[test]
    fn loop_latches_and_a_second_press_lets_go() {
        let mut s = Sampler::new(SR);
        let p = PadSpec { end: 0.1, ..pad(PadMode::Loop) };
        let b = buf(vec![1.0; 1000]);
        s.trigger(&p, Some(b.clone()), 1.0);
        s.release(0, 0.0); // letting go keeps it going
        let (l, _) = run(&mut s, 450);
        assert!((l[449] - 1.0).abs() < 1e-9, "still looping past the region");
        s.trigger(&p, Some(b), 1.0);
        let (l, _) = run(&mut s, 50);
        assert_eq!(l[20], 0.0);
        assert!(!s.active());
    }

    #[test]
    fn choke_groups_and_mono_cut() {
        let mut s = Sampler::new(SR);
        let b = buf(vec![1.0; 1000]);
        let open = PadSpec { slot: 1, choke: 1, ..pad(PadMode::Oneshot) };
        let closed = PadSpec { slot: 2, choke: 1, ..pad(PadMode::Oneshot) };
        s.trigger(&open, Some(b.clone()), 1.0);
        run(&mut s, 10);
        s.trigger(&closed, Some(b.clone()), 1.0);
        assert_eq!((s.voices_of(1), s.voices_of(2)), (0, 1));
        // Mono: a retrigger cuts the previous voice; poly stacks.
        s.trigger(&closed, Some(b.clone()), 1.0);
        assert_eq!(s.voices_of(2), 1);
        let poly = PadSpec { slot: 3, mono: false, ..pad(PadMode::Oneshot) };
        s.trigger(&poly, Some(b.clone()), 1.0);
        s.trigger(&poly, Some(b), 1.0);
        assert_eq!(s.voices_of(3), 2);
    }

    #[test]
    fn pitch_up_an_octave_plays_twice_as_fast() {
        let mut s = Sampler::new(SR);
        let p = PadSpec { end: 0.4, pitch: 12.0, ..pad(PadMode::Oneshot) };
        s.trigger(&p, Some(buf(vec![1.0; 1000])), 1.0);
        let (l, _) = run(&mut s, 400);
        assert!(l[150] > 0.9 && l[201] == 0.0, "{} {}", l[150], l[201]);
    }

    #[test]
    fn pan_follows_the_stereo_panner_law() {
        let mut s = Sampler::new(SR);
        let p = PadSpec { pan: -1.0, ..pad(PadMode::Oneshot) };
        s.trigger(&p, Some(buf(vec![0.5; 1000])), 1.0);
        let (l, r) = run(&mut s, 100);
        assert!((l[50] - 1.0).abs() < 1e-9 && r[50].abs() < 1e-9, "hard left sums both sides: {} {}", l[50], r[50]);
    }

    #[test]
    fn velocity_and_gain_scale_and_missing_buffer_is_silent() {
        let mut s = Sampler::new(SR);
        let p = PadSpec { gain: 0.5, ..pad(PadMode::Oneshot) };
        s.trigger(&p, None, 1.0);
        assert!(!s.active());
        s.trigger(&p, Some(buf(vec![1.0; 1000])), 0.5);
        let (l, _) = run(&mut s, 100);
        assert!((l[50] - 0.25).abs() < 1e-9);
    }
}
