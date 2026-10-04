//! Skip-back: an always-on ring of what the device just played (the master
//! output, after the limiter, folded to its first two channels), so a jam
//! you didn't record can still be rescued, and so RESAMPLE can bounce the
//! mix with every effect baked in (docs/sampler-research.md §3.1, §3.3).
//!
//! The audio thread writes; the page reads whenever it asks. No locks: the
//! samples are atomics (f32 bits, relaxed) and `written` publishes them
//! (release/acquire). A reader copies, then re-reads `written` and drops
//! whatever the writer may have overwritten meanwhile — only ever the oldest
//! frames of a grab.
//!
//! Every SLOT frames the ring also notes where that frame sat in the song
//! (NaN while the transport was stopped), so a grab knows where it belongs
//! on the timeline.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

/// How much the ring holds.
pub const SECONDS: f64 = 120.0;
/// Frames per song-time note.
pub const SLOT: usize = 128;
/// Frames a writer can have in flight past `written` (one device callback).
const IN_FLIGHT: u64 = 16384;

pub struct SkipBack {
    pub rate: f64,
    cap: usize,
    /// Interleaved L/R, `cap` frames.
    data: Vec<AtomicU32>,
    /// Song time (f64 bits) of frame `k * SLOT`, at `k % slots`.
    times: Vec<AtomicU64>,
    written: AtomicU64,
}

/// A copy out of the ring.
pub struct Grab {
    /// Absolute frame index of `left[0]`.
    pub start: u64,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    /// Song time of the first frame; None when the transport was stopped there.
    pub song_time: Option<f64>,
}

impl SkipBack {
    pub fn new(rate: f64) -> Self {
        Self::with_capacity(rate, (rate * SECONDS) as usize)
    }

    pub fn with_capacity(rate: f64, frames: usize) -> Self {
        let cap = frames.max(SLOT).div_ceil(SLOT) * SLOT;
        SkipBack {
            rate,
            cap,
            data: (0..cap * 2).map(|_| AtomicU32::new(0)).collect(),
            times: (0..cap / SLOT).map(|_| AtomicU64::new(f64::NAN.to_bits())).collect(),
            written: AtomicU64::new(0),
        }
    }

    pub fn capacity(&self) -> usize {
        self.cap
    }

    /// Frames written since the engine started.
    pub fn written(&self) -> u64 {
        self.written.load(Ordering::Acquire)
    }

    /// Audio thread: append one block. `song` = song time of `left[0]`, or
    /// None while stopped. Never allocates.
    pub fn push(&self, left: &[f32], right: &[f32], song: Option<f64>) {
        let w = self.written.load(Ordering::Relaxed);
        let n = left.len().min(right.len());
        let slots = self.times.len();
        for i in 0..n {
            let f = w + i as u64;
            let at = (f % self.cap as u64) as usize * 2;
            self.data[at].store(left[i].to_bits(), Ordering::Relaxed);
            self.data[at + 1].store(right[i].to_bits(), Ordering::Relaxed);
            if f % SLOT as u64 == 0 {
                let t = song.map(|t| t + i as f64 / self.rate).unwrap_or(f64::NAN);
                self.times[(f / SLOT as u64) as usize % slots].store(t.to_bits(), Ordering::Relaxed);
            }
        }
        self.written.store(w + n as u64, Ordering::Release);
    }

    /// Copy frames `[from, written)` (from = None: the last `max_frames`),
    /// at most `max_frames`, clipped to what the ring still holds.
    pub fn grab(&self, from: Option<u64>, max_frames: usize) -> Grab {
        let w0 = self.written();
        let oldest = w0.saturating_sub(self.cap as u64);
        let mut start = from.unwrap_or_else(|| w0.saturating_sub(max_frames as u64)).max(oldest).min(w0);
        let end = w0.min(start.saturating_add(max_frames as u64));
        let n = (end - start) as usize;
        let mut left = Vec::with_capacity(n);
        let mut right = Vec::with_capacity(n);
        for f in start..end {
            let at = (f % self.cap as u64) as usize * 2;
            left.push(f32::from_bits(self.data[at].load(Ordering::Relaxed)));
            right.push(f32::from_bits(self.data[at + 1].load(Ordering::Relaxed)));
        }
        // Whatever the writer reached while we copied may hold newer audio.
        let safe = (self.written() + IN_FLIGHT).saturating_sub(self.cap as u64);
        if safe > start {
            let cut = ((safe - start) as usize).min(left.len());
            left.drain(..cut);
            right.drain(..cut);
            start += cut as u64;
        }
        let song_time = self.song_time(start);
        Grab { start, left, right, song_time }
    }

    /// Song time of an absolute frame still in the ring.
    fn song_time(&self, frame: u64) -> Option<f64> {
        let slot = frame / SLOT as u64;
        // The note for this slot may have been overwritten already: then the
        // next one stands in for it.
        for k in [slot, slot + 1] {
            let first = k * SLOT as u64;
            if first + (self.cap as u64) < self.written() + IN_FLIGHT || first >= self.written() {
                continue;
            }
            let t = f64::from_bits(self.times[k as usize % self.times.len()].load(Ordering::Relaxed));
            return t.is_finite().then(|| t - (first as f64 - frame as f64) / self.rate);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(from: usize, n: usize) -> Vec<f32> {
        (from..from + n).map(|i| i as f32).collect()
    }

    #[test]
    fn last_seconds_come_back_in_order() {
        let sb = SkipBack::with_capacity(1000.0, 100_000);
        let mut f = 0;
        while f < 3000 {
            let l = ramp(f, 500);
            let r: Vec<f32> = l.iter().map(|v| -v).collect();
            sb.push(&l, &r, None);
            f += 500;
        }
        let g = sb.grab(None, 1000);
        assert_eq!(g.start, 2000);
        assert_eq!(g.left, ramp(2000, 1000));
        assert_eq!(g.right[0], -2000.0);
        assert_eq!(g.song_time, None);
    }

    #[test]
    fn wraps_and_keeps_only_what_is_safe() {
        let cap = 20_000;
        let sb = SkipBack::with_capacity(1000.0, cap);
        let cap = sb.capacity();
        for b in 0..100 {
            let l = ramp(b * 512, 512);
            sb.push(&l, &l, None);
        }
        let w = 100 * 512;
        let g = sb.grab(None, usize::MAX);
        // Everything returned is the right sample, and the in-flight margin is dropped.
        assert_eq!(g.start as usize, w - cap + IN_FLIGHT as usize);
        assert_eq!(g.left.len(), w - g.start as usize);
        for (i, v) in g.left.iter().enumerate() {
            assert_eq!(*v, (g.start as usize + i) as f32);
        }
    }

    #[test]
    fn from_a_marker() {
        let sb = SkipBack::with_capacity(1000.0, 100_000);
        sb.push(&ramp(0, 700), &ramp(0, 700), None);
        let mark = sb.written();
        sb.push(&ramp(700, 300), &ramp(700, 300), None);
        let g = sb.grab(Some(mark), usize::MAX);
        assert_eq!(g.start, 700);
        assert_eq!(g.left, ramp(700, 300));
        let g = sb.grab(Some(mark), 100);
        assert_eq!(g.left, ramp(700, 100));
    }

    #[test]
    fn knows_where_the_song_was() {
        let sb = SkipBack::with_capacity(1000.0, 100_000);
        sb.push(&[0.0; 1000], &[0.0; 1000], None); // stopped
        sb.push(&[0.0; 1000], &[0.0; 1000], Some(5.0)); // playing from 5 s
        assert_eq!(sb.grab(Some(500), usize::MAX).song_time, None);
        let t = sb.grab(Some(1300), usize::MAX).song_time.unwrap();
        assert!((t - 5.3).abs() < 1e-9, "{t}");
        // Mid-slot start is interpolated from the slot's note.
        let t = sb.grab(Some(1301), usize::MAX).song_time.unwrap();
        assert!((t - 5.301).abs() < 1e-9, "{t}");
    }
}

