//! Pan + width — port of public/placer-processor.js. Stereo: M/S width then
//! constant-power balance (unity at centre). Surround: every input channel
//! is re-panned onto the ring from its speaker's azimuth × width + pan·180°.

use crate::util::{ring, MAX_CH};

fn azimuth(n: usize) -> &'static [Option<f64>] {
    match n {
        6 => &[Some(-30.0), Some(30.0), Some(0.0), None, Some(-110.0), Some(110.0)],
        8 => &[Some(-30.0), Some(30.0), Some(0.0), None, Some(-150.0), Some(150.0), Some(-90.0), Some(90.0)],
        _ => &[],
    }
}

fn ring_gains(n: usize, az: f64, out: &mut [f32; MAX_CH]) {
    *out = [0.0; MAX_CH];
    let r = ring(n).unwrap();
    let mut a = az % 360.0;
    if a < 0.0 {
        a += 360.0;
    }
    let mut i = 0;
    while i < r.len() - 1 && r[i + 1].1 <= a {
        i += 1;
    }
    let s1 = r[i];
    let s2 = r[(i + 1) % r.len()];
    let a2 = if i == r.len() - 1 { s2.1 + 360.0 } else { s2.1 };
    let t = (a - s1.1) / (a2 - s1.1);
    out[s1.0] = (out[s1.0] as f64 + (t * std::f64::consts::PI / 2.0).cos()) as f32;
    out[s2.0] = (out[s2.0] as f64 + (t * std::f64::consts::PI / 2.0).sin()) as f32;
}

pub struct Placer {
    matrix: [[f32; MAX_CH]; MAX_CH],
    key: Option<(usize, f64, f64)>,
}

impl Default for Placer {
    fn default() -> Self {
        Placer { matrix: [[0.0; MAX_CH]; MAX_CH], key: None }
    }
}

impl Placer {
    pub fn process(&mut self, pan: f64, width: f64, input: &[&[f32]], output: &mut [&mut [f32]]) {
        let n_ch = output.len();
        let frames = output[0].len();
        if (pan == 0.0 && width == 1.0) || n_ch == 1 || (n_ch != 2 && ring(n_ch).is_none()) {
            for c in 0..n_ch {
                let src = if c < input.len() { input[c] } else { input[0] };
                output[c].copy_from_slice(&src[..frames]);
            }
            return;
        }
        if n_ch == 2 {
            let in_l = input[0];
            let in_r = if input.len() > 1 { input[1] } else { input[0] };
            let a = (pan + 1.0) * std::f64::consts::PI / 4.0;
            let gl = a.cos() * std::f64::consts::SQRT_2;
            let gr = a.sin() * std::f64::consts::SQRT_2;
            let (ol, rest) = output.split_at_mut(1);
            for n in 0..frames {
                let mid = 0.5 * (in_l[n] as f64 + in_r[n] as f64);
                let side = 0.5 * (in_l[n] as f64 - in_r[n] as f64) * width;
                ol[0][n] = ((mid + side) * gl) as f32;
                rest[0][n] = ((mid - side) * gr) as f32;
            }
            return;
        }
        if self.key != Some((n_ch, pan, width)) {
            self.key = Some((n_ch, pan, width));
            let az = azimuth(n_ch);
            self.matrix = [[0.0; MAX_CH]; MAX_CH];
            let mut tmp = [0f32; MAX_CH];
            for c in 0..n_ch {
                match az[c] {
                    None => self.matrix[c][c] = 1.0,
                    Some(a) => {
                        ring_gains(n_ch, a * width + pan * 180.0, &mut tmp);
                        self.matrix[c][..n_ch].copy_from_slice(&tmp[..n_ch]);
                    }
                }
            }
        }
        for o in output.iter_mut() {
            o.fill(0.0);
        }
        for c in 0..n_ch.min(input.len()) {
            let src = input[c];
            for o in 0..n_ch {
                let g = self.matrix[c][o] as f64;
                if g == 0.0 {
                    continue;
                }
                let dst = &mut output[o];
                for n in 0..frames {
                    dst[n] = (dst[n] as f64 + src[n] as f64 * g) as f32;
                }
            }
        }
    }
}
