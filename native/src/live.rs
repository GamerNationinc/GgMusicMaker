//! Live instrument — the notes and drum hits you play from the Deck's
//! controls in Instrument mode (src/input/instrument.ts turns controller
//! state into `LiveEvent`s). Port of public/live-processor.js, kept in step
//! with it the same way as the FX worklets (native-parity.test.ts).
//!
//! Voices: two PolyBLEP oscillators (saw/square blend, detuned) → TPT state-
//! variable lowpass (cutoff from the left-pad macro, opened by the envelope)
//! → ADSR. Drums: four synthesised kits pieces (kick, snare, hat, clap).
//! Everything is allocation-free after `new`, so it runs on the audio thread.
//! Events apply at the start of the next render call (one 128-frame quantum
//! at most, ≈ 2.7 ms at 48 kHz).

use crate::util::Rng;
use serde::Deserialize;
use std::f64::consts::PI;

pub const VOICES: usize = 16;
pub const DRUMS: usize = 8;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum LiveEvent {
    /// Start (or retrigger) voice `id` at MIDI `note` (fractional allowed).
    On { id: u32, note: f64, vel: f64, patch: u8 },
    /// Release voice `id` (held on while sustain is down).
    Off { id: u32 },
    /// Slide voice `id` to a new note (legato, no retrigger).
    Glide { id: u32, note: f64 },
    /// One drum hit: 0 kick, 1 snare, 2 hat, 3 clap.
    Drum { kind: u8, vel: f64 },
    /// Continuous controls. bend in semitones, the rest 0..1.
    Ctl {
        bend: f64,
        #[serde(rename = "mod")]
        modw: f64,
        cutoff: f64,
        send: f64,
        expr: f64,
        sustain: bool,
    },
    /// Everything silent at once.
    Panic,
}

/// attack, decay, sustain, release (s), saw/square mix, detune (cents),
/// filter envelope depth (octaves).
struct Patch {
    a: f64,
    d: f64,
    s: f64,
    r: f64,
    saw: f64,
    detune: f64,
    fenv: f64,
}

const PATCHES: [Patch; 4] = [
    // keys
    Patch { a: 0.005, d: 0.3, s: 0.6, r: 0.25, saw: 0.7, detune: 6.0, fenv: 2.0 },
    // pluck
    Patch { a: 0.002, d: 0.25, s: 0.0, r: 0.15, saw: 1.0, detune: 0.0, fenv: 3.5 },
    // pad
    Patch { a: 0.35, d: 0.8, s: 0.8, r: 0.9, saw: 1.0, detune: 12.0, fenv: 1.0 },
    // bass
    Patch { a: 0.003, d: 0.2, s: 0.7, r: 0.1, saw: 0.4, detune: 0.0, fenv: 1.5 },
];

#[inline]
fn blep(t: f64, dt: f64) -> f64 {
    if t < dt {
        let t = t / dt;
        t + t - t * t - 1.0
    } else if t > 1.0 - dt {
        let t = (t - 1.0) / dt;
        t * t + t + t + 1.0
    } else {
        0.0
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Off,
    Attack,
    Decay,
    Release,
}

#[derive(Clone, Copy)]
struct Voice {
    id: u32,
    stage: Stage,
    /// Released while sustain was down: release when sustain lifts.
    held: bool,
    age: u64,
    patch: usize,
    note: f64,
    target: f64,
    vel: f64,
    env: f64,
    att: f64,
    kd: f64,
    kr: f64,
    ph1: f64,
    ph2: f64,
    ic1: f64,
    ic2: f64,
}

impl Voice {
    const IDLE: Voice = Voice {
        id: 0,
        stage: Stage::Off,
        held: false,
        age: 0,
        patch: 0,
        note: 60.0,
        target: 60.0,
        vel: 0.0,
        env: 0.0,
        att: 0.0,
        kd: 0.0,
        kr: 0.0,
        ph1: 0.0,
        ph2: 0.37,
        ic1: 0.0,
        ic2: 0.0,
    };
}

#[derive(Clone, Copy)]
struct Drum {
    kind: u8,
    on: bool,
    n: u64,
    vel: f64,
    gl: f64,
    gr: f64,
    ph: f64,
    x1: f64,
    y1: f64,
}

impl Drum {
    const IDLE: Drum = Drum { kind: 0, on: false, n: 0, vel: 0.0, gl: 0.0, gr: 0.0, ph: 0.0, x1: 0.0, y1: 0.0 };
}

const DRUM_PAN: [f64; 4] = [0.0, 0.05, 0.3, -0.2];
const DRUM_LEN: [f64; 4] = [1.2, 0.6, 0.3, 0.6];

pub struct Live {
    sr: f64,
    voices: [Voice; VOICES],
    drums: [Drum; DRUMS],
    next_drum: usize,
    clock: u64,
    rng: Rng,
    lfo: f64,
    // targets and their smoothed values
    bend: f64,
    modw: f64,
    cutoff: f64,
    send: f64,
    expr: f64,
    sustain: bool,
    s_bend: f64,
    s_mod: f64,
    s_cutoff: f64,
    s_send: f64,
    s_expr: f64,
    sm: f64,
    kg: f64,
}

impl Live {
    pub fn new(sr: f64) -> Self {
        Live {
            sr,
            voices: [Voice::IDLE; VOICES],
            drums: [Drum::IDLE; DRUMS],
            next_drum: 0,
            clock: 0,
            rng: Rng::new(0x11fe_5eed),
            lfo: 0.0,
            bend: 0.0,
            modw: 0.0,
            cutoff: 0.7,
            send: 0.2,
            expr: 1.0,
            sustain: false,
            s_bend: 0.0,
            s_mod: 0.0,
            s_cutoff: 0.7,
            s_send: 0.2,
            s_expr: 1.0,
            sm: (-1.0 / (sr * 0.01)).exp(),
            kg: (-1.0 / (sr * 0.03)).exp(),
        }
    }

    /// True while anything is sounding (the mixer skips a silent instrument).
    pub fn active(&self) -> bool {
        self.voices.iter().any(|v| v.stage != Stage::Off) || self.drums.iter().any(|d| d.on)
    }

    pub fn event(&mut self, e: LiveEvent) {
        let sr = self.sr;
        match e {
            LiveEvent::On { id, note, vel, patch } => {
                self.clock += 1;
                let slot = self
                    .voices
                    .iter()
                    .position(|v| v.stage != Stage::Off && v.id == id)
                    .or_else(|| self.voices.iter().position(|v| v.stage == Stage::Off))
                    .unwrap_or_else(|| {
                        let mut oldest = 0;
                        for (i, v) in self.voices.iter().enumerate() {
                            if v.age < self.voices[oldest].age {
                                oldest = i;
                            }
                        }
                        oldest
                    });
                let p = &PATCHES[(patch as usize).min(PATCHES.len() - 1)];
                let v = &mut self.voices[slot];
                let fresh = v.stage == Stage::Off;
                *v = Voice {
                    id,
                    stage: Stage::Attack,
                    held: false,
                    age: self.clock,
                    patch: (patch as usize).min(PATCHES.len() - 1),
                    note,
                    target: note,
                    vel: vel.clamp(0.0, 1.0),
                    env: if fresh { 0.0 } else { v.env },
                    att: 1.0 / (p.a * sr),
                    kd: (-3.0 / (p.d * sr)).exp(),
                    kr: (-3.0 / (p.r * sr)).exp(),
                    ph1: if fresh { 0.0 } else { v.ph1 },
                    ph2: if fresh { 0.37 } else { v.ph2 },
                    ic1: if fresh { 0.0 } else { v.ic1 },
                    ic2: if fresh { 0.0 } else { v.ic2 },
                };
            }
            LiveEvent::Off { id } => {
                let sustain = self.sustain;
                for v in self.voices.iter_mut().filter(|v| v.stage != Stage::Off && v.stage != Stage::Release && v.id == id) {
                    if sustain {
                        v.held = true;
                    } else {
                        v.stage = Stage::Release;
                    }
                }
            }
            LiveEvent::Glide { id, note } => {
                for v in self.voices.iter_mut().filter(|v| v.stage != Stage::Off && v.id == id) {
                    v.target = note;
                }
            }
            LiveEvent::Drum { kind, vel } => {
                let k = kind.min(3);
                let pan = DRUM_PAN[k as usize];
                let a = (pan + 1.0) * PI / 4.0;
                self.drums[self.next_drum] = Drum {
                    kind: k,
                    on: true,
                    n: 0,
                    vel: vel.clamp(0.0, 1.0),
                    gl: a.cos(),
                    gr: a.sin(),
                    ph: 0.0,
                    x1: 0.0,
                    y1: 0.0,
                };
                self.next_drum = (self.next_drum + 1) % DRUMS;
            }
            LiveEvent::Ctl { bend, modw, cutoff, send, expr, sustain } => {
                self.bend = bend;
                self.modw = modw.clamp(0.0, 1.0);
                self.cutoff = cutoff.clamp(0.0, 1.0);
                self.send = send.clamp(0.0, 1.0);
                self.expr = expr.clamp(0.0, 1.0);
                if self.sustain && !sustain {
                    for v in self.voices.iter_mut().filter(|v| v.held) {
                        v.held = false;
                        if v.stage != Stage::Off {
                            v.stage = Stage::Release;
                        }
                    }
                }
                self.sustain = sustain;
            }
            LiveEvent::Panic => {
                self.voices = [Voice::IDLE; VOICES];
                self.drums = [Drum::IDLE; DRUMS];
            }
        }
    }

    /// Add one block of the instrument into `dry` (L, R) and `send` (L, R —
    /// what goes to the reverb).
    pub fn render(&mut self, dry: [&mut [f64]; 2], send: [&mut [f64]; 2]) {
        let [dl, dr] = dry;
        let [sl, sr_] = send;
        if !self.active() {
            // Nothing sounding: controls jump to where they are now, so the
            // next note doesn't glide in from a stale value.
            self.s_bend = self.bend;
            self.s_mod = self.modw;
            self.s_cutoff = self.cutoff;
            self.s_send = self.send;
            self.s_expr = self.expr;
            return;
        }
        let sr = self.sr;
        let n = dl.len();
        let res_k = 1.3;
        for i in 0..n {
            self.s_bend = self.bend + (self.s_bend - self.bend) * self.sm;
            self.s_mod = self.modw + (self.s_mod - self.modw) * self.sm;
            self.s_cutoff = self.cutoff + (self.s_cutoff - self.cutoff) * self.sm;
            self.s_send = self.send + (self.s_send - self.send) * self.sm;
            self.s_expr = self.expr + (self.s_expr - self.expr) * self.sm;
            self.lfo += 5.5 / sr;
            if self.lfo >= 1.0 {
                self.lfo -= 1.0;
            }
            let vib = self.s_mod * 0.5 * (2.0 * PI * self.lfo).sin();
            let base_cut = 80.0 * (self.s_cutoff * 8.0).exp2();
            let mut mono = 0.0;
            for v in self.voices.iter_mut() {
                if v.stage == Stage::Off {
                    continue;
                }
                let p = &PATCHES[v.patch];
                match v.stage {
                    Stage::Attack => {
                        v.env += v.att;
                        if v.env >= 1.0 {
                            v.env = 1.0;
                            v.stage = Stage::Decay;
                        }
                    }
                    Stage::Decay => v.env = p.s + (v.env - p.s) * v.kd,
                    Stage::Release => {
                        v.env *= v.kr;
                        if v.env < 1e-4 {
                            *v = Voice::IDLE;
                            continue;
                        }
                    }
                    Stage::Off => {}
                }
                v.note = v.target + (v.note - v.target) * self.kg;
                let pitch = v.note + self.s_bend + vib;
                let f = 440.0 * ((pitch - 69.0) / 12.0).exp2();
                let det = (p.detune / 2400.0).exp2();
                let dt1 = (f / det / sr).min(0.45);
                let dt2 = (f * det / sr).min(0.45);
                let mut o = 0.0;
                for (ph, dt) in [(&mut v.ph1, dt1), (&mut v.ph2, dt2)] {
                    let t = *ph;
                    let saw = 2.0 * t - 1.0 - blep(t, dt);
                    let mut t2 = t + 0.5;
                    if t2 >= 1.0 {
                        t2 -= 1.0;
                    }
                    let sq = (if t < 0.5 { 1.0 } else { -1.0 }) + blep(t, dt) - blep(t2, dt);
                    o += p.saw * saw + (1.0 - p.saw) * sq;
                    *ph += dt;
                    if *ph >= 1.0 {
                        *ph -= 1.0;
                    }
                }
                let fc = (base_cut * (p.fenv * v.env * (0.5 + 0.5 * v.vel)).exp2()).min(sr * 0.45);
                let g = (PI * fc / sr).tan();
                let a1 = 1.0 / (1.0 + g * (g + res_k));
                let a2 = g * a1;
                let a3 = g * a2;
                let v3 = 0.5 * o - v.ic2;
                let v1 = a1 * v.ic1 + a2 * v3;
                let v2 = v.ic2 + a2 * v.ic1 + a3 * v3;
                v.ic1 = 2.0 * v1 - v.ic1;
                v.ic2 = 2.0 * v2 - v.ic2;
                mono += v2 * v.env * v.vel * 0.8;
            }
            mono *= self.s_expr;
            let (mut l, mut r) = (mono, mono);
            for d in self.drums.iter_mut() {
                if !d.on {
                    continue;
                }
                let t = d.n as f64 / sr;
                let y = match d.kind {
                    0 => {
                        d.ph += (45.0 + 105.0 * (-t / 0.03).exp()) / sr;
                        (2.0 * PI * d.ph).sin() * (-t / 0.18).exp()
                    }
                    1 => {
                        let x = self.rng.bipolar();
                        d.y1 = x - d.x1 + 0.9 * d.y1;
                        d.x1 = x;
                        0.5 * (2.0 * PI * 185.0 * t).sin() * (-t / 0.05).exp() + 0.5 * d.y1 * (-t / 0.07).exp()
                    }
                    2 => {
                        let x = self.rng.bipolar();
                        let hp = x - d.x1;
                        d.x1 = x;
                        0.4 * hp * (-t / 0.018).exp()
                    }
                    _ => {
                        let x = self.rng.bipolar();
                        d.y1 = x - d.x1 + 0.8 * d.y1;
                        d.x1 = x;
                        let env = if t < 0.03 {
                            (-(t % 0.01) / 0.004).exp()
                        } else {
                            (-(t - 0.03) / 0.08).exp()
                        };
                        0.5 * d.y1 * env
                    }
                } * d.vel
                    * 0.9;
                l += y * d.gl;
                r += y * d.gr;
                d.n += 1;
                if t > DRUM_LEN[d.kind as usize] {
                    d.on = false;
                }
            }
            dl[i] += l;
            dr[i] += r;
            sl[i] += l * self.s_send;
            sr_[i] += r * self.s_send;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(live: &mut Live, n: usize) -> (Vec<f64>, Vec<f64>) {
        let (mut l, mut r, mut a, mut b) = (vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        live.render([&mut l, &mut r], [&mut a, &mut b]);
        (l, a)
    }

    fn rms(x: &[f64]) -> f64 {
        (x.iter().map(|v| v * v).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn events_parse_from_json() {
        let e: LiveEvent = serde_json::from_str(r#"{"t":"on","id":3,"note":60,"vel":0.8,"patch":1}"#).unwrap();
        assert_eq!(e, LiveEvent::On { id: 3, note: 60.0, vel: 0.8, patch: 1 });
        let c: LiveEvent = serde_json::from_str(r#"{"t":"ctl","bend":0,"mod":0.5,"cutoff":1,"send":0,"expr":1,"sustain":true}"#).unwrap();
        assert!(matches!(c, LiveEvent::Ctl { sustain: true, .. }));
    }

    #[test]
    fn silent_until_played_and_releases_to_silence() {
        let mut live = Live::new(48000.0);
        assert!(!live.active());
        assert_eq!(rms(&run(&mut live, 480).0), 0.0);
        live.event(LiveEvent::On { id: 1, note: 60.0, vel: 1.0, patch: 0 });
        assert!(rms(&run(&mut live, 4800).0) > 0.01);
        live.event(LiveEvent::Off { id: 1 });
        run(&mut live, 48000);
        assert!(!live.active());
    }

    #[test]
    fn sustain_holds_until_lifted() {
        let mut live = Live::new(48000.0);
        let ctl = |s| LiveEvent::Ctl { bend: 0.0, modw: 0.0, cutoff: 0.7, send: 0.0, expr: 1.0, sustain: s };
        live.event(ctl(true));
        live.event(LiveEvent::On { id: 1, note: 60.0, vel: 1.0, patch: 2 });
        run(&mut live, 24000);
        live.event(LiveEvent::Off { id: 1 });
        run(&mut live, 96000);
        assert!(live.active(), "sustained note still sounding");
        live.event(ctl(false));
        run(&mut live, 192000);
        assert!(!live.active());
    }

    #[test]
    fn voices_are_stolen_not_dropped() {
        let mut live = Live::new(48000.0);
        for id in 0..(VOICES as u32 + 4) {
            live.event(LiveEvent::On { id, note: 48.0 + id as f64, vel: 1.0, patch: 2 });
        }
        let ids: Vec<u32> = live.voices.iter().map(|v| v.id).collect();
        assert!(ids.contains(&(VOICES as u32 + 3)), "newest note got a voice");
        assert!(!ids.contains(&0), "oldest note was stolen");
    }

    #[test]
    fn drums_ring_out_and_stop() {
        let mut live = Live::new(48000.0);
        for kind in 0..4 {
            live.event(LiveEvent::Drum { kind, vel: 1.0 });
        }
        assert!(rms(&run(&mut live, 4800).0) > 0.01);
        run(&mut live, 96000);
        assert!(!live.active());
    }

    #[test]
    fn send_follows_the_macro() {
        let mut live = Live::new(48000.0);
        live.event(LiveEvent::Ctl { bend: 0.0, modw: 0.0, cutoff: 0.7, send: 0.0, expr: 1.0, sustain: false });
        run(&mut live, 4800);
        live.event(LiveEvent::On { id: 1, note: 60.0, vel: 1.0, patch: 0 });
        let (_, s) = run(&mut live, 4800);
        assert!(rms(&s) < 1e-6);
    }
}
