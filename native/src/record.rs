//! Native recording: capture from the default (or chosen) input device with
//! cpal, on the same process clock as playback, so a take lands on the
//! timeline exactly where the music was when it was played.
//!
//! How a take is placed
//! --------------------
//! cpal's `StreamInstant`s are relative to each stream's own start, so an
//! input instant can't be compared with an output one directly. Each stream
//! does report its own latency, though:
//!
//!   output: `playback - callback` = how long until this buffer's first
//!           frame reaches the speaker
//!   input:  `callback - capture`  = how long ago this buffer's first frame
//!           hit the microphone
//!
//! Both callbacks also read one shared monotonic clock (`Instant`, as
//! nanoseconds since the engine started). So:
//!
//! * every output callback publishes an [`OutMark`]: the song time of the
//!   first frame it renders, and the wall time that frame will be *heard*
//!   (now + output latency + the master compressor's 6 ms look-ahead, which
//!   delays everything the mixer plays);
//! * the first input callback that finds playback running computes the wall
//!   time its first frame was *captured* (now − input latency) and asks the
//!   mark which song time was being heard at that instant ([`song_at`]).
//!   That pair (captured frame index, song time) is the take's [`Anchor`].
//!
//! The take then starts at `anchor.song − anchor.frame / rate` ([`place`]):
//! audio captured before the transport started is kept (pre-roll) unless it
//! would fall before 0 s, in which case it is trimmed. A take recorded with
//! the transport stopped has no anchor; the caller puts it at the playhead.
//!
//! What this can't see: converter latency inside the sound card (not
//! reported by ALSA/PipeWire) and any latency outside the machine (a USB
//! interface's own buffers, Bluetooth). Those would show up as a constant
//! offset of a few ms.
//!
//! Samples travel from the input callback through a lock-free SPSC ring to
//! a drain thread, so the capture callback never allocates or blocks.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// What the output callback last rendered, on the shared clock.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OutMark {
    pub playing: bool,
    /// Song time (s) of the first frame of the last rendered buffer.
    pub song: f64,
    /// Wall time (ns since the engine epoch) that frame is heard.
    pub heard_ns: i64,
    /// Output latency reported by the device (ns), for diagnostics.
    pub latency_ns: i64,
}

/// A mark older than this is not trusted (the output stream stalled).
const MAX_MARK_AGE_NS: i64 = 1_000_000_000;

/// Song time being heard at wall time `wall_ns`, or None if playback is
/// stopped or the mark is too far away to extrapolate from.
pub fn song_at(mark: &OutMark, wall_ns: i64) -> Option<f64> {
    if !mark.playing {
        return None;
    }
    let d = wall_ns - mark.heard_ns;
    if d.abs() > MAX_MARK_AGE_NS {
        return None;
    }
    Some(mark.song + d as f64 * 1e-9)
}

/// The moment capture and playback were first seen running together.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Anchor {
    /// Index (in frames) of the captured frame the song time refers to.
    pub frame: u64,
    /// Song time heard when that frame was captured.
    pub song: f64,
    pub in_latency_ns: i64,
    pub out_latency_ns: i64,
}

/// Where a take goes: its start time on the timeline and how many leading
/// frames to drop (they would land before 0 s).
pub fn place(anchor: &Anchor, rate: f64) -> (f64, usize) {
    let start = anchor.song - anchor.frame as f64 / rate;
    if start >= 0.0 {
        (start, 0)
    } else {
        let trim = (-start * rate).round() as usize;
        (0.0f64.max(start + trim as f64 / rate), trim)
    }
}

/// Split interleaved samples into at most 2 channels, dropping `skip`
/// leading frames.
pub fn deinterleave(data: &[f32], channels: usize, skip: usize) -> Vec<Vec<f32>> {
    let channels = channels.max(1);
    let frames = data.len() / channels;
    let keep = channels.min(2);
    let skip = skip.min(frames);
    let mut out = vec![Vec::with_capacity(frames - skip); keep];
    for f in skip..frames {
        for (c, ch) in out.iter_mut().enumerate() {
            ch.push(data[f * channels + c]);
        }
    }
    out
}

/// Shared between the engine (output callback) and a recording.
pub struct Clock {
    epoch: Instant,
    pub mark: Mutex<OutMark>,
}

impl Default for Clock {
    fn default() -> Self {
        Clock { epoch: Instant::now(), mark: Mutex::new(OutMark::default()) }
    }
}

impl Clock {
    pub fn now_ns(&self) -> i64 {
        self.epoch.elapsed().as_nanos() as i64
    }

    /// Called by the output callback before it renders: never blocks.
    pub fn publish(&self, playing: bool, song: f64, latency: Duration, extra_delay_s: f64) {
        let now = self.now_ns();
        let latency_ns = latency.as_nanos() as i64;
        if let Ok(mut m) = self.mark.try_lock() {
            *m = OutMark { playing, song, heard_ns: now + latency_ns + (extra_delay_s * 1e9) as i64, latency_ns };
        }
    }
}

/// A finished take.
pub struct Take {
    pub rate: f64,
    pub channels: Vec<Vec<f32>>,
    /// Timeline position of the first frame (None: transport was stopped).
    pub start: Option<f64>,
    pub in_latency_ms: f64,
    pub out_latency_ms: f64,
    /// Samples lost because the drain thread fell behind (should be 0).
    pub dropped: u64,
    pub device: String,
}

struct Shared {
    frames: AtomicU64,
    dropped: AtomicU64,
    stop: AtomicBool,
    anchor: Mutex<Option<Anchor>>,
    /// Live waveform of the take so far: (min, max) over all channels per
    /// PEAK_BUCKET frames, appended by the drain thread for the UI to draw.
    peaks: Mutex<Vec<f32>>,
}

/// Frames per live-waveform bucket (2.7 ms at 48 kHz).
pub const PEAK_BUCKET: usize = 128;

/// Running (min, max) over interleaved frames, emitting one pair per
/// PEAK_BUCKET frames. Kept apart from the drain thread so it is unit-tested.
#[derive(Default)]
pub struct PeakAcc {
    lo: f32,
    hi: f32,
    /// Frames in the bucket so far.
    n: usize,
}

impl PeakAcc {
    /// Feed interleaved samples (whole frames); append finished pairs to `out`.
    pub fn feed(&mut self, data: &[f32], channels: usize, out: &mut Vec<f32>) {
        for frame in data.chunks_exact(channels.max(1)) {
            let (mut lo, mut hi) = (frame[0], frame[0]);
            for &v in &frame[1..] {
                lo = lo.min(v);
                hi = hi.max(v);
            }
            if self.n == 0 {
                self.lo = lo;
                self.hi = hi;
            } else {
                self.lo = self.lo.min(lo);
                self.hi = self.hi.max(hi);
            }
            self.n += 1;
            if self.n == PEAK_BUCKET {
                out.push(self.lo);
                out.push(self.hi);
                self.n = 0;
            }
        }
    }
}

/// An open capture stream. Dropping it without `finish` discards the take.
pub struct Recording {
    stream: cpal::Stream,
    shared: Arc<Shared>,
    drain: Option<JoinHandle<Vec<f32>>>,
    pub rate: f64,
    pub channels: usize,
    pub device: String,
}

fn pick_input(name: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(want) = name {
        let devs = host.input_devices().map_err(|e| format!("input devices: {e}"))?;
        for d in devs {
            if d.name().map(|n| n == want).unwrap_or(false) {
                return Ok(d);
            }
        }
        return Err(format!("no input device named {want}"));
    }
    host.default_input_device().ok_or_else(|| "no audio input device".to_string())
}

/// Every input device's name, for a picker. The default device (if it can
/// still be named) is listed first.
pub fn list_input_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let mut names: Vec<String> = host.input_devices().map_err(|e| format!("input devices: {e}"))?.filter_map(|d| d.name().ok()).collect();
    if let Some(default) = host.default_input_device().and_then(|d| d.name().ok()) {
        if let Some(pos) = names.iter().position(|n| n == &default) {
            names.swap(0, pos);
        }
    }
    Ok(names)
}

impl Recording {
    /// Open the input (`device`, or the default) and start capturing,
    /// preferring f32 at `want_rate` (the output's rate, so nothing resamples).
    pub fn start(device: Option<&str>, want_rate: f64, clock: Arc<Clock>) -> Result<Recording, String> {
        let dev = pick_input(device)?;
        let name = dev.name().unwrap_or_else(|_| "default".into());
        let mut cfg = dev.default_input_config().map_err(|e| format!("input config: {e}"))?;
        if let Ok(configs) = dev.supported_input_configs() {
            let want = want_rate as u32;
            let mut best: Option<cpal::SupportedStreamConfig> = None;
            for c in configs {
                if c.sample_format() == cpal::SampleFormat::F32 && c.min_sample_rate().0 <= want && c.max_sample_rate().0 >= want {
                    let s = c.with_sample_rate(cpal::SampleRate(want));
                    // Prefer stereo, then whatever the default has.
                    let better = match &best {
                        None => true,
                        Some(b) => (s.channels() == 2) && b.channels() != 2,
                    };
                    if better {
                        best = Some(s);
                    }
                }
            }
            if let Some(b) = best {
                cfg = b;
            }
        }
        let channels = cfg.channels() as usize;
        let rate = cfg.sample_rate().0 as f64;
        let shared = Arc::new(Shared { frames: AtomicU64::new(0), dropped: AtomicU64::new(0), stop: AtomicBool::new(false), anchor: Mutex::new(None), peaks: Mutex::new(Vec::new()) });
        // Four seconds of headroom; the drain thread empties it every 10 ms.
        let (prod, mut cons) = rtrb::RingBuffer::<f32>::new((rate as usize * channels * 4).max(1 << 16));

        let stream = match cfg.sample_format() {
            cpal::SampleFormat::F32 => build::<f32>(&dev, &cfg.config(), channels, prod, shared.clone(), clock),
            cpal::SampleFormat::I16 => build::<i16>(&dev, &cfg.config(), channels, prod, shared.clone(), clock),
            cpal::SampleFormat::I32 => build::<i32>(&dev, &cfg.config(), channels, prod, shared.clone(), clock),
            f => return Err(format!("unsupported input format {f:?}")),
        }?;
        stream.play().map_err(|e| format!("start input: {e}"))?;

        let sh = shared.clone();
        let drain = std::thread::Builder::new()
            .name("ggmm-rec-drain".into())
            .spawn(move || {
                let mut out: Vec<f32> = Vec::with_capacity(rate as usize * channels * 60);
                let mut acc = PeakAcc::default();
                let mut fresh: Vec<f32> = Vec::new();
                let mut seen = 0usize;
                loop {
                    let done = sh.stop.load(Ordering::Acquire);
                    let n = cons.slots();
                    if n > 0 {
                        if let Ok(chunk) = cons.read_chunk(n) {
                            let (a, b) = chunk.as_slices();
                            out.extend_from_slice(a);
                            out.extend_from_slice(b);
                            chunk.commit_all();
                        }
                    }
                    // Whole frames only; a partial frame waits for the next pass.
                    let whole = (out.len() / channels.max(1)) * channels.max(1);
                    if whole > seen {
                        acc.feed(&out[seen..whole], channels, &mut fresh);
                        seen = whole;
                        if !fresh.is_empty() {
                            sh.peaks.lock().unwrap().extend_from_slice(&fresh);
                            fresh.clear();
                        }
                    }
                    if done {
                        break out;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            })
            .map_err(|e| format!("drain thread: {e}"))?;

        Ok(Recording { stream, shared, drain: Some(drain), rate, channels, device: name })
    }

    /// Live waveform pairs from pair index `from` on; also the frames captured.
    pub fn peaks_since(&self, from: usize) -> (Vec<f32>, u64) {
        let p = self.shared.peaks.lock().unwrap();
        let start = (from * 2).min(p.len());
        (p[start..].to_vec(), self.shared.frames.load(Ordering::Relaxed))
    }

    /// Stop capturing and hand back the take.
    pub fn finish(mut self) -> Take {
        let _ = self.stream.pause();
        self.shared.stop.store(true, Ordering::Release);
        let data = self.drain.take().and_then(|h| h.join().ok()).unwrap_or_default();
        let anchor = *self.shared.anchor.lock().unwrap();
        let (start, skip) = match &anchor {
            Some(a) => {
                let (s, k) = place(a, self.rate);
                (Some(s), k)
            }
            None => (None, 0),
        };
        Take {
            rate: self.rate,
            channels: deinterleave(&data, self.channels, skip),
            start,
            in_latency_ms: anchor.map(|a| a.in_latency_ns as f64 / 1e6).unwrap_or(0.0),
            out_latency_ms: anchor.map(|a| a.out_latency_ns as f64 / 1e6).unwrap_or(0.0),
            dropped: self.shared.dropped.load(Ordering::Relaxed),
            device: self.device.clone(),
        }
    }
}

fn build<T>(dev: &cpal::Device, cfg: &cpal::StreamConfig, channels: usize, mut prod: rtrb::Producer<f32>, shared: Arc<Shared>, clock: Arc<Clock>) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    use cpal::Sample;
    dev.build_input_stream(
        cfg,
        move |data: &[T], info: &cpal::InputCallbackInfo| {
            let now = clock.now_ns();
            let ts = info.timestamp();
            let lat = ts.callback.duration_since(&ts.capture).map(|d| d.as_nanos() as i64).unwrap_or(0);
            let before = shared.frames.load(Ordering::Relaxed);
            if let Ok(mut a) = shared.anchor.try_lock() {
                if a.is_none() {
                    if let Ok(m) = clock.mark.try_lock() {
                        if let Some(song) = song_at(&m, now - lat) {
                            *a = Some(Anchor { frame: before, song, in_latency_ns: lat, out_latency_ns: m.latency_ns });
                        }
                    }
                }
            }
            let n = data.len().min(prod.slots());
            if let Ok(mut chunk) = prod.write_chunk_uninit(n) {
                let (a, b) = chunk.as_mut_slices();
                for (dst, src) in a.iter_mut().chain(b.iter_mut()).zip(data.iter()) {
                    dst.write(f32::from_sample(*src));
                }
                unsafe { chunk.commit_all() };
            }
            if n < data.len() {
                shared.dropped.fetch_add((data.len() - n) as u64, Ordering::Relaxed);
            }
            shared.frames.store(before + (data.len() / channels) as u64, Ordering::Relaxed);
        },
        |e| eprintln!("ggmm-engine: input stream error: {e}"),
        None,
    )
    .map_err(|e| format!("open input: {e}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn live_peaks_are_min_max_per_bucket_over_channels() {
        let mut acc = super::PeakAcc::default();
        let mut out = Vec::new();
        // Stereo: L ramps up, R is its negative; bucket 1 then half of bucket 2.
        let frames = super::PEAK_BUCKET + super::PEAK_BUCKET / 2;
        let data: Vec<f32> = (0..frames).flat_map(|i| [i as f32 / 1000.0, -(i as f32) / 1000.0]).collect();
        // Fed in uneven pieces (whole frames), as the drain thread does.
        acc.feed(&data[..100], 2, &mut out);
        acc.feed(&data[100..], 2, &mut out);
        assert_eq!(out.len(), 2);
        let last = (super::PEAK_BUCKET - 1) as f32 / 1000.0;
        assert_eq!(out, vec![-last, last]);
    }

    use super::*;

    fn mark(song: f64, heard_ns: i64) -> OutMark {
        OutMark { playing: true, song, heard_ns, latency_ns: 20_000_000 }
    }

    #[test]
    fn song_at_extrapolates_from_the_mark() {
        let m = mark(10.0, 1_000_000_000);
        assert!((song_at(&m, 1_500_000_000).unwrap() - 10.5).abs() < 1e-12);
        // Before the mark's frame is heard, the song is earlier.
        assert!((song_at(&m, 900_000_000).unwrap() - 9.9).abs() < 1e-12);
    }

    #[test]
    fn song_at_is_none_when_stopped_or_stale() {
        let mut m = mark(10.0, 0);
        assert!(song_at(&m, 2_000_000_000).is_none());
        m.playing = false;
        assert!(song_at(&m, 0).is_none());
    }

    #[test]
    fn latencies_cancel_out_end_to_end() {
        // Speaker plays song time S at wall T. The mic hears it at T and
        // delivers it 15 ms later. The take must place that sample at S.
        let clock_latency_out = 30_000_000; // 30 ms output latency
        let callback_at = 5_000_000_000i64;
        let lookahead = 0.006;
        let heard = callback_at + clock_latency_out + (lookahead * 1e9) as i64;
        let m = OutMark { playing: true, song: 42.0, heard_ns: heard, latency_ns: clock_latency_out };
        // The input callback runs 15 ms after the capture of its first frame,
        // which was captured exactly when song 42.0 was heard.
        let in_lat = 15_000_000;
        let input_cb_now = heard + in_lat;
        let song = song_at(&m, input_cb_now - in_lat).unwrap();
        assert!((song - 42.0).abs() < 1e-9);
        let a = Anchor { frame: 48_000, song, in_latency_ns: in_lat, out_latency_ns: clock_latency_out };
        let (start, trim) = place(&a, 48_000.0);
        assert!((start - 41.0).abs() < 1e-9); // 1 s of pre-roll before the anchor
        assert_eq!(trim, 0);
    }

    #[test]
    fn pre_roll_before_zero_is_trimmed() {
        let a = Anchor { frame: 96_000, song: 0.5, in_latency_ns: 0, out_latency_ns: 0 };
        let (start, trim) = place(&a, 48_000.0);
        assert_eq!(trim, 72_000); // 1.5 s before 0 s dropped
        assert!(start.abs() < 1e-9);
    }

    #[test]
    fn deinterleave_keeps_two_channels_and_skips() {
        let data = [1.0, 10.0, 100.0, 2.0, 20.0, 200.0, 3.0, 30.0, 300.0];
        let out = deinterleave(&data, 3, 1);
        assert_eq!(out, vec![vec![2.0, 3.0], vec![20.0, 30.0]]);
        let mono = deinterleave(&[1.0, 2.0, 3.0], 1, 0);
        assert_eq!(mono, vec![vec![1.0, 2.0, 3.0]]);
        assert_eq!(deinterleave(&[1.0, 2.0], 2, 5), vec![Vec::<f32>::new(), vec![]]);
    }

    #[test]
    fn publish_folds_latency_and_lookahead_into_heard_time() {
        let c = Clock::default();
        let before = c.now_ns();
        c.publish(true, 3.0, Duration::from_millis(20), 0.006);
        let m = *c.mark.lock().unwrap();
        assert!(m.playing && m.song == 3.0);
        let d = m.heard_ns - before;
        assert!(d >= 26_000_000 && d < 26_000_000 + 50_000_000, "{d}");
    }
}
