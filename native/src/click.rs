//! The metronome: a short sine blip on every beat of the song's grid, a
//! higher one on each bar's downbeat. Live only (the page leaves it out of
//! the export spec). It also plays before 0 s, so starting the transport a
//! bar early gives a count-in.

use serde::Deserialize;

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClickSpec {
    pub bpm: f64,
    pub beats_per_bar: u32,
    /// Song time of bar 1.
    #[serde(default)]
    pub offset: f64,
    /// Linear gain of the blip.
    #[serde(default = "level")]
    pub level: f64,
}
fn level() -> f64 {
    0.5
}

pub const DOWNBEAT_HZ: f64 = 1760.0;
pub const BEAT_HZ: f64 = 1320.0;
/// Decay time constant of a blip (s).
const TAU: f64 = 0.012;

pub struct Click {
    sr: f64,
    phase: f64,
    step: f64,
    env: f64,
    decay: f64,
}

impl Click {
    pub fn new(sr: f64) -> Self {
        Click { sr, phase: 0.0, step: 0.0, env: 0.0, decay: (-1.0 / (sr * TAU)).exp() }
    }

    /// Silence a ringing blip (transport stopped).
    pub fn reset(&mut self) {
        self.env = 0.0;
    }

    /// Where the next beat at or after `t0` lands: (sample index into a
    /// block starting at song time `t0`, is it a downbeat).
    pub fn next_beat(spec: &ClickSpec, t0: f64, sr: f64) -> (usize, bool) {
        let beat = 60.0 / spec.bpm.max(1.0);
        let k = ((t0 - spec.offset) / beat - 1e-9).ceil();
        let at = spec.offset + k * beat;
        let idx = ((at - t0) * sr).round().max(0.0) as usize;
        (idx, (k as i64).rem_euclid(spec.beats_per_bar.max(1) as i64) == 0)
    }

    /// Add one block (song time `t0` at its first frame) into L and R.
    pub fn render(&mut self, spec: &ClickSpec, t0: f64, l: &mut [f64], r: &mut [f64]) {
        let n = l.len();
        let (hit, down) = Self::next_beat(spec, t0, self.sr);
        if self.env < 1e-5 && hit >= n {
            return;
        }
        for i in 0..n {
            if i == hit {
                self.env = 1.0;
                self.phase = 0.0;
                self.step = std::f64::consts::TAU * if down { DOWNBEAT_HZ } else { BEAT_HZ } / self.sr;
            }
            if self.env < 1e-5 {
                continue;
            }
            let v = self.phase.sin() * self.env * spec.level;
            self.phase += self.step;
            self.env *= self.decay;
            l[i] += v;
            r[i] += v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;

    fn spec() -> ClickSpec {
        ClickSpec { bpm: 120.0, beats_per_bar: 4, offset: 0.0, level: 0.5 }
    }

    /// Render `secs` from song time `from` in 128-frame blocks; return L.
    fn run(s: &ClickSpec, from: f64, secs: f64) -> Vec<f64> {
        let mut c = Click::new(SR);
        let n = (secs * SR) as usize;
        let (mut l, mut r) = (vec![0.0; n], vec![0.0; n]);
        let mut i = 0;
        while i < n {
            let q = (n - i).min(128);
            c.render(s, from + i as f64 / SR, &mut l[i..i + q], &mut r[i..i + q]);
            i += q;
        }
        l
    }

    fn onsets(l: &[f64]) -> Vec<usize> {
        (0..l.len()).filter(|&i| l[i] == 0.0 && l.get(i + 1).map_or(false, |v| v.abs() > 0.01) && (i < 200 || l[i - 200..i].iter().all(|v| v.abs() < 1e-3))).collect()
    }

    #[test]
    fn a_blip_on_every_beat() {
        let l = run(&spec(), 0.0, 2.1);
        // sin(0) = 0 at the onset sample, so the onset is where the blip starts.
        assert_eq!(onsets(&l), vec![0, 24_000, 48_000, 72_000, 96_000]);
    }

    #[test]
    fn the_downbeat_is_higher() {
        let s = spec();
        assert_eq!(Click::next_beat(&s, 0.0, SR), (0, true));
        assert_eq!(Click::next_beat(&s, 0.4, SR), (4_800, false));
        assert_eq!(Click::next_beat(&s, 1.9, SR), (4_800, true)); // beat 4 → bar 2
        // Count-in: a bar before 0 still lands on the grid, downbeat at −2 s.
        assert_eq!(Click::next_beat(&s, -2.0, SR), (0, true));
        assert_eq!(Click::next_beat(&s, -1.6, SR), (4_800, false));
    }

    #[test]
    fn follows_the_grid_offset_and_decays_between_beats() {
        let s = ClickSpec { offset: 0.25, ..spec() };
        let l = run(&s, 0.0, 1.0);
        assert_eq!(onsets(&l), vec![12_000, 36_000]);
        let peak = l.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        assert!(peak > 0.45 && peak <= 0.5, "{peak}");
        assert!(l[12_000 + 12_000].abs() < 1e-4); // silent half a beat later
    }
}
