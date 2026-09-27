//! Headphone 3D monitor — port of public/binaural-processor.js: each
//! speaker of a 5.1/7.1 bus becomes a virtual source (Woodworth ITD, head
//! shadow ILD, rear pinna darkening); LFE to both ears at −3 dB.

const MAX_DELAY: usize = 64;

struct Source {
    lfe: bool,
    far_is_left: bool,
    delay: f64,
    far_gain: f64,
    far_lp: f64,
    rear: f64,
    rear_lp: f64,
    buf: [f32; MAX_DELAY],
    w: usize,
    far_z: f64,
    rear_z: f64,
}

fn one_pole(hz: f64, sr: f64) -> f64 {
    1.0 - (-2.0 * std::f64::consts::PI * hz.min(sr * 0.45) / sr).exp()
}

pub struct Binaural {
    sources: Vec<Source>,
    norm: f64,
}

impl Binaural {
    pub fn new(n: usize, sr: f64) -> Self {
        let az: &[Option<f64>] = match n {
            6 => &[Some(-30.0), Some(30.0), Some(0.0), None, Some(-110.0), Some(110.0)],
            8 => &[Some(-30.0), Some(30.0), Some(0.0), None, Some(-150.0), Some(150.0), Some(-90.0), Some(90.0)],
            _ => &[],
        };
        let sources = az
            .iter()
            .map(|a| {
                let th = a.unwrap_or(0.0).to_radians();
                let lateral = th.sin().abs().asin();
                let s = th.sin().abs();
                Source {
                    lfe: a.is_none(),
                    far_is_left: a.unwrap_or(0.0) > 0.0,
                    delay: (0.0875 / 343.0) * (lateral + lateral.sin()) * sr,
                    far_gain: 1.0 - 0.45 * s,
                    far_lp: if s < 0.05 { 1.0 } else { one_pole(20000.0 * (1200.0f64 / 20000.0).powf(s), sr) },
                    rear: (-th.cos()).max(0.0),
                    rear_lp: one_pole(4500.0, sr),
                    buf: [0.0; MAX_DELAY],
                    w: 0,
                    far_z: 0.0,
                    rear_z: 0.0,
                }
            })
            .collect::<Vec<_>>();
        let speakers = az.iter().filter(|a| a.is_some()).count().max(1);
        Binaural { sources, norm: 1.0 / (speakers as f64 / 2.0).sqrt() }
    }

    /// `input`: n bus channels for one sample; returns (L, R).
    #[inline]
    pub fn step(&mut self, input: &[f64]) -> (f64, f64) {
        let (mut l, mut r) = (0.0, 0.0);
        for (c, s) in self.sources.iter_mut().enumerate() {
            let x = input[c];
            if s.lfe {
                l += x * 0.7071;
                r += x * 0.7071;
                continue;
            }
            let mut v = x * self.norm;
            s.rear_z += s.rear_lp * (v - s.rear_z);
            v += s.rear * 0.6 * (s.rear_z - v);
            s.buf[s.w] = v as f32;
            let mut rd = s.w as f64 - s.delay;
            if rd < 0.0 {
                rd += MAX_DELAY as f64;
            }
            let k = rd as usize;
            let f = rd - k as f64;
            let dv = s.buf[k] as f64 + (s.buf[(k + 1) % MAX_DELAY] as f64 - s.buf[k] as f64) * f;
            s.far_z += s.far_lp * (dv - s.far_z);
            let (near, far) = (v, s.far_z * s.far_gain);
            if s.far_is_left {
                r += near;
                l += far;
            } else {
                l += near;
                r += far;
            }
            s.w = (s.w + 1) % MAX_DELAY;
        }
        (l, r)
    }
}
