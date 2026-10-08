//! DJ decks — two turntable-style players on the shared engine (DJ mode,
//! docs/deck-dual-mode.md). Port of public/dj-processor.js, kept in step
//! with it by native-parity.test.ts; change both together.
//!
//! Each deck plays a loaded buffer at a variable speed (tempo fader × sync,
//! plus a jog nudge; a scratch sets the speed directly, backwards too) with
//! 4-point Hermite interpolation — pitch follows speed, like vinyl. Then a
//! 3-band EQ (low shelf 250 Hz, peak 1 kHz, high shelf 3 kHz; −60 dB = kill),
//! the channel fader and the crossfader (full on both sides in the middle,
//! constant power towards the ends). Out: stereo, into the master bus.
//! Allocation-free after `new`; a buffer arrives as an `Arc` built off the
//! audio thread and the replaced one is handed back to be freed there.

use crate::dsp::{Biquad, Kind};
use crate::mixer::Buffer;
use serde::Deserialize;
use std::f64::consts::PI;
use std::sync::Arc;

pub const DECKS: usize = 2;
/// The EQ's floor: a band turned all the way down is gone.
pub const EQ_MIN_DB: f64 = -60.0;
pub const EQ_MAX_DB: f64 = 6.0;
/// Speed changes glide over ~10 ms (no clicks on play / stop / sync).
const SPEED_TAU: f64 = 0.01;
/// Faders glide over ~5 ms.
const GAIN_TAU: f64 = 0.005;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum DjEvent {
    Play { deck: usize, on: bool },
    /// Jump to `time` seconds into the track.
    Seek { deck: usize, time: f64 },
    /// SYNC's phase step, done here where both positions are exact: move
    /// `deck` (beats every `beat` s from `first`, track time) the shorter
    /// way onto the beat phase of deck `to` (beats every `to_beat` s from
    /// `to_first`).
    #[serde(rename_all = "camelCase")]
    Phase { deck: usize, beat: f64, first: f64, to: usize, to_beat: f64, to_first: f64 },
    /// Tempo: 1 = as recorded.
    Rate { deck: usize, rate: f64 },
    /// Added to the rate while the jog is pushed (0 when let go).
    Nudge { deck: usize, amount: f64 },
    /// Hand on the platter: the deck runs at `speed` (−… backwards, 0 held
    /// still) whatever its play state, until `on` is false.
    Scratch { deck: usize, on: bool, speed: f64 },
    /// Band gains in dB (EQ_MIN_DB .. EQ_MAX_DB).
    Eq { deck: usize, low: f64, mid: f64, high: f64 },
    /// Channel fader 0..1.
    Vol { deck: usize, v: f64 },
    /// Crossfader −1 (deck A only) .. 1 (deck B only).
    Xfade { x: f64 },
    /// Loop between two times (s); `to <= from` ends the loop.
    Loop { deck: usize, from: f64, to: f64 },
}

/// Crossfader gains (A, B): both full in the middle, constant power
/// towards the ends.
pub fn xfade_gains(x: f64) -> (f64, f64) {
    let a = (x.clamp(-1.0, 1.0) + 1.0) * PI / 4.0;
    ((std::f64::consts::SQRT_2 * a.cos()).min(1.0), (std::f64::consts::SQRT_2 * a.sin()).min(1.0))
}

struct Deck {
    buf: Option<Arc<Buffer>>,
    /// Read position, in buffer frames.
    pos: f64,
    playing: bool,
    rate: f64,
    nudge: f64,
    scratch: bool,
    scratch_speed: f64,
    /// Current (smoothed) speed.
    speed: f64,
    loop_from: f64,
    loop_to: f64,
    eq_target: [f64; 3],
    eq_now: [f64; 3],
    eq: [[Biquad; 3]; 2],
    vol: f64,
    vol_now: f64,
}

impl Deck {
    fn new() -> Self {
        let mut d = Deck {
            buf: None,
            pos: 0.0,
            playing: false,
            rate: 1.0,
            nudge: 0.0,
            scratch: false,
            scratch_speed: 0.0,
            speed: 0.0,
            loop_from: 0.0,
            loop_to: 0.0,
            eq_target: [0.0; 3],
            eq_now: [0.0; 3],
            eq: [[Biquad::identity(); 3]; 2],
            vol: 1.0,
            vol_now: 1.0,
        };
        d.eq_now = [f64::NAN; 3]; // coefficients set on the first render
        d
    }

    fn target_speed(&self) -> f64 {
        if self.scratch {
            self.scratch_speed
        } else if self.playing {
            self.rate + self.nudge
        } else {
            0.0
        }
    }

    fn len(&self) -> f64 {
        self.buf.as_ref().map(|b| b.channels[0].len() as f64).unwrap_or(0.0)
    }

    /// Glide the EQ towards its target, a quarter of the way per quantum.
    fn update_eq(&mut self, sr: f64) {
        for band in 0..3 {
            let t = self.eq_target[band];
            let now = self.eq_now[band];
            let next = if now.is_nan() || (t - now).abs() < 0.01 { t } else { now + (t - now) * 0.25 };
            if next == now {
                continue;
            }
            self.eq_now[band] = next;
            for ch in 0..2 {
                let f = &mut self.eq[ch][band];
                match band {
                    0 => f.set(Kind::Lowshelf, 250.0, 0.0, next, sr),
                    1 => f.set(Kind::Peaking, 1000.0, 0.7, next, sr),
                    _ => f.set(Kind::Highshelf, 3000.0, 0.0, next, sr),
                }
            }
        }
    }
}

#[inline]
fn hermite(c: &[f32], pos: f64) -> f64 {
    let i = pos.floor();
    let f = pos - i;
    let i = i as isize;
    let n = c.len() as isize;
    let at = |k: isize| if k < 0 || k >= n { 0.0 } else { c[k as usize] as f64 };
    let (xm1, x0, x1, x2) = (at(i - 1), at(i), at(i + 1), at(i + 2));
    let c1 = 0.5 * (x1 - xm1);
    let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
    let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    ((c3 * f + c2) * f + c1) * f + x0
}

pub struct Dj {
    sr: f64,
    decks: [Deck; DECKS],
    xfade: f64,
    xf_now: [f64; DECKS],
    k_speed: f64,
    k_gain: f64,
}

impl Dj {
    pub fn new(sr: f64) -> Self {
        let (a, b) = xfade_gains(0.0);
        Dj {
            sr,
            decks: [Deck::new(), Deck::new()],
            xfade: 0.0,
            xf_now: [a, b],
            k_speed: (-1.0 / (sr * SPEED_TAU)).exp(),
            k_gain: (-1.0 / (sr * GAIN_TAU)).exp(),
        }
    }

    /// Put a buffer on a deck (None = eject); stops it and goes to the start.
    /// Returns the buffer that was there, to be freed off the audio thread.
    pub fn load(&mut self, deck: usize, buf: Option<Arc<Buffer>>) -> Option<Arc<Buffer>> {
        let d = self.decks.get_mut(deck)?;
        d.playing = false;
        d.scratch = false;
        d.speed = 0.0;
        d.pos = 0.0;
        d.loop_to = 0.0;
        d.loop_from = 0.0;
        std::mem::replace(&mut d.buf, buf)
    }

    pub fn event(&mut self, e: DjEvent) {
        let rate_of = |d: &Deck| d.buf.as_ref().map(|b| b.rate).unwrap_or(1.0);
        match e {
            DjEvent::Xfade { x } => self.xfade = x.clamp(-1.0, 1.0),
            DjEvent::Play { deck, on } => {
                if let Some(d) = self.decks.get_mut(deck) {
                    d.playing = on && d.buf.is_some();
                }
            }
            DjEvent::Seek { deck, time } => {
                if let Some(d) = self.decks.get_mut(deck) {
                    d.pos = (time * rate_of(d)).clamp(0.0, d.len());
                }
            }
            DjEvent::Phase { deck, beat, first, to, to_beat, to_first } => {
                if deck >= DECKS || to >= DECKS || deck == to || beat <= 0.0 || to_beat <= 0.0 {
                    return;
                }
                let [(p0, _), (p1, _)] = self.status();
                let (mine, theirs) = if deck == 0 { (p0, p1) } else { (p1, p0) };
                let frac = |x: f64| x - x.floor();
                let mut diff = frac((theirs - to_first) / to_beat) - frac((mine - first) / beat);
                diff -= diff.round();
                let d = &mut self.decks[deck];
                let r = rate_of(d);
                d.pos = (d.pos + diff * beat * r).clamp(0.0, d.len());
            }
            DjEvent::Rate { deck, rate } => {
                if let Some(d) = self.decks.get_mut(deck) {
                    d.rate = rate.clamp(0.0, 4.0);
                }
            }
            DjEvent::Nudge { deck, amount } => {
                if let Some(d) = self.decks.get_mut(deck) {
                    d.nudge = amount.clamp(-1.0, 1.0);
                }
            }
            DjEvent::Scratch { deck, on, speed } => {
                if let Some(d) = self.decks.get_mut(deck) {
                    d.scratch = on;
                    d.scratch_speed = speed.clamp(-8.0, 8.0);
                }
            }
            DjEvent::Eq { deck, low, mid, high } => {
                if let Some(d) = self.decks.get_mut(deck) {
                    d.eq_target = [low, mid, high].map(|g| g.clamp(EQ_MIN_DB, EQ_MAX_DB));
                }
            }
            DjEvent::Vol { deck, v } => {
                if let Some(d) = self.decks.get_mut(deck) {
                    d.vol = v.clamp(0.0, 1.0);
                }
            }
            DjEvent::Loop { deck, from, to } => {
                if let Some(d) = self.decks.get_mut(deck) {
                    let r = rate_of(d);
                    d.loop_from = (from * r).max(0.0);
                    d.loop_to = (to * r).min(d.len());
                }
            }
        }
    }

    /// Where each deck is (seconds into its track) and whether it plays.
    pub fn status(&self) -> [(f64, bool); DECKS] {
        let s = |d: &Deck| (d.buf.as_ref().map(|b| d.pos / b.rate).unwrap_or(0.0), d.playing);
        [s(&self.decks[0]), s(&self.decks[1])]
    }

    /// True while a deck could make sound.
    pub fn active(&self) -> bool {
        self.decks.iter().any(|d| d.buf.is_some() && (d.speed.abs() > 1e-9 || d.target_speed() != 0.0))
    }

    /// Add both decks into `out` (L, R).
    pub fn render(&mut self, out: [&mut [f64]; 2]) {
        let [ol, or] = out;
        let n = ol.len();
        let sr = self.sr;
        let (ga, gb) = xfade_gains(self.xfade);
        let xf_target = [ga, gb];
        for (k, d) in self.decks.iter_mut().enumerate() {
            let Some(buf) = d.buf.clone() else { continue };
            let target = d.target_speed();
            if d.speed.abs() <= 1e-9 && target == 0.0 {
                d.speed = 0.0;
                self.xf_now[k] = xf_target[k];
                d.vol_now = d.vol;
                continue;
            }
            d.update_eq(sr);
            let ratio = buf.rate / sr;
            let len = buf.channels[0].len() as f64;
            let ch_l = &buf.channels[0][..];
            let ch_r = &buf.channels[buf.channels.len().min(2) - 1][..];
            let looping = d.loop_to > d.loop_from;
            for i in 0..n {
                d.speed = target + (d.speed - target) * self.k_speed;
                d.vol_now = d.vol + (d.vol_now - d.vol) * self.k_gain;
                self.xf_now[k] = xf_target[k] + (self.xf_now[k] - xf_target[k]) * self.k_gain;
                let (mut l, mut r) = (hermite(ch_l, d.pos), hermite(ch_r, d.pos));
                for b in 0..3 {
                    l = d.eq[0][b].process(l);
                    r = d.eq[1][b].process(r);
                }
                let g = d.vol_now * self.xf_now[k];
                ol[i] += l * g;
                or[i] += r * g;
                d.pos += d.speed * ratio;
                if looping && d.speed > 0.0 && d.pos >= d.loop_to {
                    d.pos -= d.loop_to - d.loop_from;
                }
                if d.pos >= len {
                    d.pos = len;
                    d.playing = false;
                } else if d.pos < 0.0 {
                    d.pos = 0.0;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48000.0;

    fn sine(freq: f64, secs: f64, rate: f64) -> Arc<Buffer> {
        let n = (secs * rate) as usize;
        let c: Vec<f32> = (0..n).map(|i| (0.5 * (2.0 * PI * freq * i as f64 / rate).sin()) as f32).collect();
        Arc::new(Buffer { rate, channels: vec![c.clone(), c] })
    }

    fn run(dj: &mut Dj, frames: usize) -> (Vec<f64>, Vec<f64>) {
        let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
        for i in (0..frames).step_by(128) {
            let q = (frames - i).min(128);
            let (a, b) = (&mut l[i..i + q], &mut r[i..i + q]);
            dj.render([a, b]);
        }
        (l, r)
    }

    fn rms(x: &[f64]) -> f64 {
        (x.iter().map(|v| v * v).sum::<f64>() / x.len().max(1) as f64).sqrt()
    }

    #[test]
    fn silent_until_played_then_plays_at_rate() {
        let mut dj = Dj::new(SR);
        dj.load(0, Some(sine(440.0, 4.0, 44100.0)));
        assert!(!dj.active());
        assert_eq!(rms(&run(&mut dj, 4800).0), 0.0);
        dj.event(DjEvent::Play { deck: 0, on: true });
        run(&mut dj, 48000);
        // One second at rate 1 (a 44.1 kHz file on a 48 kHz engine), less
        // the 10 ms glide up to speed.
        assert!((dj.status()[0].0 - 0.99).abs() < 0.001, "{:?}", dj.status());
        dj.event(DjEvent::Rate { deck: 0, rate: 1.08 });
        run(&mut dj, 48000);
        assert!((dj.status()[0].0 - (0.99 + 1.08 - 0.08 * 0.01)).abs() < 0.001, "{:?}", dj.status());
        let (l, _) = run(&mut dj, 4800);
        assert!((rms(&l) - 0.5 / 2f64.sqrt()).abs() < 0.01, "{}", rms(&l));
    }

    #[test]
    fn stops_at_the_end_and_loops() {
        let mut dj = Dj::new(SR);
        dj.load(1, Some(sine(220.0, 1.0, SR)));
        dj.event(DjEvent::Play { deck: 1, on: true });
        run(&mut dj, 60000);
        assert_eq!(dj.status()[1], (1.0, false));
        dj.event(DjEvent::Seek { deck: 1, time: 0.0 });
        dj.event(DjEvent::Loop { deck: 1, from: 0.25, to: 0.5 });
        dj.event(DjEvent::Play { deck: 1, on: true });
        run(&mut dj, 96000);
        let t = dj.status()[1].0;
        assert!((0.25..0.5).contains(&t) && dj.status()[1].1, "{t}");
    }

    #[test]
    fn scratch_runs_backwards_and_the_crossfader_cuts() {
        let mut dj = Dj::new(SR);
        dj.load(0, Some(sine(440.0, 4.0, SR)));
        dj.event(DjEvent::Seek { deck: 0, time: 2.0 });
        dj.event(DjEvent::Scratch { deck: 0, on: true, speed: -1.0 });
        run(&mut dj, 24000);
        assert!((dj.status()[0].0 - 1.5).abs() < 0.01, "{:?}", dj.status());
        dj.event(DjEvent::Scratch { deck: 0, on: false, speed: 0.0 });
        dj.event(DjEvent::Play { deck: 0, on: true });
        dj.event(DjEvent::Xfade { x: 1.0 });
        run(&mut dj, 4800);
        assert!(rms(&run(&mut dj, 4800).0) < 1e-6);
        assert_eq!(xfade_gains(0.0), (1.0, 1.0));
        let (a, b) = xfade_gains(0.5);
        assert!((a - (2f64.sqrt() * (3.0 * PI / 8.0).cos())).abs() < 1e-12 && b == 1.0);
    }

    #[test]
    fn phase_lines_the_beats_up_the_shorter_way() {
        let mut dj = Dj::new(SR);
        dj.load(0, Some(sine(440.0, 8.0, SR)));
        dj.load(1, Some(sine(440.0, 8.0, SR)));
        // A: beats every 0.5 s from 0.1, at 2.2 s = 0.2 into a beat.
        // B: beats every 0.4 s from 0, at 3.0 s = 0.5 into a beat → back 0.3.
        dj.event(DjEvent::Seek { deck: 0, time: 2.2 });
        dj.event(DjEvent::Seek { deck: 1, time: 3.0 });
        dj.event(DjEvent::Phase { deck: 1, beat: 0.4, first: 0.0, to: 0, to_beat: 0.5, to_first: 0.1 });
        assert!((dj.status()[1].0 - (3.0 - 0.3 * 0.4)).abs() < 1e-9, "{:?}", dj.status());
        // Nonsense is ignored.
        dj.event(DjEvent::Phase { deck: 1, beat: 0.0, first: 0.0, to: 1, to_beat: 0.5, to_first: 0.0 });
        assert!((dj.status()[1].0 - 2.88).abs() < 1e-9);
    }

    #[test]
    fn eq_kill_removes_the_band() {
        let mut dj = Dj::new(SR);
        dj.load(0, Some(sine(60.0, 3.0, SR)));
        dj.event(DjEvent::Play { deck: 0, on: true });
        let before = rms(&run(&mut dj, 24000).0[12000..]);
        dj.event(DjEvent::Eq { deck: 0, low: EQ_MIN_DB, mid: 0.0, high: 0.0 });
        let after = rms(&run(&mut dj, 48000).0[24000..]);
        assert!(after < before * 0.05, "{before} → {after}");
    }
}
