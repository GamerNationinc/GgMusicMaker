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
//!   time its *last* frame was captured and asks the mark which song time
//!   was being heard at that instant ([`song_at`]). That pair (captured
//!   frame index, song time) is the take's [`Anchor`] ([`anchor_at`]).
//!   The last frame, not the first: an input often starts with a burst of
//!   buffered audio (seconds of it, on PipeWire through ALSA) while
//!   reporting no latency, and only the newest frame was captured "now".
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
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
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

/// The anchor an input callback gives: `before` frames came earlier, this
/// block holds `frames` more, and its first frame was captured `lat_ns`
/// before `now_ns` (cpal's callback − capture; 0 when the backend doesn't
/// say). Anchored at the block's end, captured `lat_ns − block length` ago
/// (never in the future).
pub fn anchor_at(mark: &OutMark, now_ns: i64, lat_ns: i64, before: u64, frames: u64, rate: f64) -> Option<Anchor> {
    let block_ns = (frames as f64 / rate * 1e9) as i64;
    let end_lat = (lat_ns - block_ns).max(0);
    let song = song_at(mark, now_ns - end_lat)?;
    Some(Anchor { frame: before + frames, song, in_latency_ns: lat_ns, out_latency_ns: mark.latency_ns })
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
/// leading frames. `pick`: keep only that one input (a mono take of, say,
/// the guitar on input 1 of an interface).
pub fn deinterleave(data: &[f32], channels: usize, skip: usize, pick: Option<usize>) -> Vec<Vec<f32>> {
    let channels = channels.max(1);
    let frames = data.len() / channels;
    let skip = skip.min(frames);
    let sel: Vec<usize> = match pick {
        Some(k) => vec![k.min(channels - 1)],
        None => (0..channels.min(2)).collect(),
    };
    let mut out = vec![Vec::with_capacity(frames - skip); sel.len()];
    for f in skip..frames {
        for (ch, &c) in out.iter_mut().zip(&sel) {
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
    /// The input stream; None when recording the Deck instrument (the mixer
    /// feeds the take through a [`Capture`]).
    stream: Option<cpal::Stream>,
    shared: Arc<Shared>,
    drain: Option<JoinHandle<Vec<f32>>>,
    pub rate: f64,
    pub channels: usize,
    /// One input of a multi-input interface, or None for the first two.
    pub pick: Option<usize>,
    pub device: String,
}

/// The name a Deck-instrument take reports as its device.
pub const DECK_SOURCE: &str = "Deck instrument";

/// The audio-thread end of a Deck-instrument take: the mixer pushes what
/// the instrument plays, every block, whether or not a note sounds (so the
/// take's frames stay locked to song time).
pub struct Capture {
    prod: rtrb::Producer<f32>,
    shared: Arc<Shared>,
}

impl Capture {
    /// One block of the instrument (L, R). `song`: song time of its first
    /// frame; `heard_after`: how long until that frame reaches the speaker
    /// (output latency + the master look-ahead). The player reacted to what
    /// they heard then, so the take is placed that much earlier — the same
    /// rule as a mic take (see the module docs). Never blocks or allocates.
    pub fn push(&mut self, l: &[f64], r: &[f64], song: f64, playing: bool, heard_after: f64) {
        let before = self.shared.frames.load(Ordering::Relaxed);
        if playing {
            if let Ok(mut a) = self.shared.anchor.try_lock() {
                if a.is_none() {
                    *a = Some(Anchor { frame: before, song: song - heard_after, in_latency_ns: 0, out_latency_ns: (heard_after * 1e9) as i64 });
                }
            }
        }
        let n = l.len().min(r.len());
        let fit = (self.prod.slots() / 2).min(n);
        if let Ok(mut chunk) = self.prod.write_chunk_uninit(fit * 2) {
            let (a, b) = chunk.as_mut_slices();
            for (i, dst) in a.iter_mut().chain(b.iter_mut()).enumerate() {
                let f = i / 2;
                dst.write(if i % 2 == 0 { l[f] } else { r[f] } as f32);
            }
            unsafe { chunk.commit_all() };
        }
        if fit < n {
            self.shared.dropped.fetch_add(((n - fit) * 2) as u64, Ordering::Relaxed);
        }
        self.shared.frames.store(before + n as u64, Ordering::Relaxed);
    }
}

/// The input config to open: f32 at `want_rate` (the output's rate, so
/// nothing resamples), stereo preferred; else the device default.
fn choose_config(dev: &cpal::Device, want_rate: f64) -> Result<cpal::SupportedStreamConfig, String> {
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
    Ok(cfg)
}

/// How many inputs a device offers (as it would be opened), for the
/// "Input 1 / Input 2 …" picker.
pub fn input_channels(device: Option<&str>, want_rate: f64) -> Result<usize, String> {
    let dev = pick_input(device)?;
    Ok(choose_config(&dev, want_rate)?.channels() as usize)
}

fn check_pick(pick: Option<usize>, channels: usize) -> Result<(), String> {
    match pick {
        Some(k) if k >= channels => Err(format!("input {} doesn't exist (the device has {channels})", k + 1)),
        _ => Ok(()),
    }
}

fn spawn_drain(mut cons: rtrb::Consumer<f32>, channels: usize, rate: f64, sh: Arc<Shared>) -> Result<JoinHandle<Vec<f32>>, String> {
    std::thread::Builder::new()
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
        .map_err(|e| format!("drain thread: {e}"))
}

fn new_shared() -> Arc<Shared> {
    Arc::new(Shared { frames: AtomicU64::new(0), dropped: AtomicU64::new(0), stop: AtomicBool::new(false), anchor: Mutex::new(None), peaks: Mutex::new(Vec::new()) })
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
    /// `pick`: record only that input (0-based) as a mono take.
    pub fn start(device: Option<&str>, pick: Option<usize>, want_rate: f64, clock: Arc<Clock>) -> Result<Recording, String> {
        let dev = pick_input(device)?;
        let name = dev.name().unwrap_or_else(|_| "default".into());
        let cfg = choose_config(&dev, want_rate)?;
        let channels = cfg.channels() as usize;
        check_pick(pick, channels)?;
        let rate = cfg.sample_rate().0 as f64;
        let shared = new_shared();
        // Four seconds of headroom; the drain thread empties it every 10 ms.
        let (prod, cons) = rtrb::RingBuffer::<f32>::new((rate as usize * channels * 4).max(1 << 16));

        let stream = match cfg.sample_format() {
            cpal::SampleFormat::F32 => build::<f32>(&dev, &cfg.config(), channels, rate, prod, shared.clone(), clock),
            cpal::SampleFormat::I16 => build::<i16>(&dev, &cfg.config(), channels, rate, prod, shared.clone(), clock),
            cpal::SampleFormat::I32 => build::<i32>(&dev, &cfg.config(), channels, rate, prod, shared.clone(), clock),
            f => return Err(format!("unsupported input format {f:?}")),
        }?;
        stream.play().map_err(|e| format!("start input: {e}"))?;
        let drain = spawn_drain(cons, channels, rate, shared.clone())?;
        Ok(Recording { stream: Some(stream), shared, drain: Some(drain), rate, channels, pick, device: name })
    }

    /// Record the Deck instrument: no input stream — the mixer pushes the
    /// instrument's output into the returned [`Capture`] (stereo, at the
    /// engine's rate).
    pub fn start_deck(rate: f64) -> Result<(Recording, Capture), String> {
        let shared = new_shared();
        let (prod, cons) = rtrb::RingBuffer::<f32>::new((rate as usize * 2 * 4).max(1 << 16));
        let drain = spawn_drain(cons, 2, rate, shared.clone())?;
        let rec = Recording { stream: None, shared: shared.clone(), drain: Some(drain), rate, channels: 2, pick: None, device: DECK_SOURCE.into() };
        Ok((rec, Capture { prod, shared }))
    }

    /// Live waveform pairs from pair index `from` on; also the frames captured.
    pub fn peaks_since(&self, from: usize) -> (Vec<f32>, u64) {
        let p = self.shared.peaks.lock().unwrap();
        let start = (from * 2).min(p.len());
        (p[start..].to_vec(), self.shared.frames.load(Ordering::Relaxed))
    }

    /// Stop capturing and hand back the take.
    pub fn finish(mut self) -> Take {
        if let Some(st) = &self.stream {
            let _ = st.pause();
        }
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
            channels: deinterleave(&data, self.channels, skip, self.pick),
            start,
            in_latency_ms: anchor.map(|a| a.in_latency_ns as f64 / 1e6).unwrap_or(0.0),
            out_latency_ms: anchor.map(|a| a.out_latency_ns as f64 / 1e6).unwrap_or(0.0),
            dropped: self.shared.dropped.load(Ordering::Relaxed),
            device: self.device.clone(),
        }
    }
}

// ---- input monitoring --------------------------------------------------------

/// Hear the input while it's armed: an input stream of its own (beside any
/// recording; PipeWire shares the device) whose samples the mixer plays
/// through the master. Also measures the input level for the meter.
pub struct Monitor {
    _stream: cpal::Stream,
    peak: Arc<AtomicU32>,
    pub device: String,
    pub channels: usize,
}

/// The audio-thread end of a [`Monitor`].
pub struct MonitorFeed {
    cons: rtrb::Consumer<f32>,
    channels: usize,
    pick: Option<usize>,
    primed: bool,
}

/// Frames kept queued before the monitor starts playing (absorbs callback
/// jitter between the input and output streams) …
pub const MONITOR_PRIME: usize = 256;
/// … and the most it may fall behind before old frames are skipped, so the
/// delay you hear stays small when the two clocks drift.
pub const MONITOR_BACKLOG: usize = 1024;

impl MonitorFeed {
    /// Add one block of the input into L and R (a picked input or a mono
    /// device in both; otherwise inputs 1 and 2). Never blocks or allocates.
    pub fn render(&mut self, l: &mut [f64], r: &mut [f64], gain: f64) {
        let n = l.len();
        let ch = self.channels.max(1);
        let mut avail = self.cons.slots() / ch;
        if !self.primed {
            if avail < n + MONITOR_PRIME {
                return;
            }
            self.primed = true;
        }
        if avail < n {
            // Ran dry: wait to build the cushion up again.
            self.primed = false;
            return;
        }
        if avail > n + MONITOR_BACKLOG {
            let skip = avail - n - MONITOR_PRIME;
            if let Ok(c) = self.cons.read_chunk(skip * ch) {
                c.commit_all();
            }
            avail -= skip;
        }
        let _ = avail;
        let Ok(chunk) = self.cons.read_chunk(n * ch) else { return };
        let (a, b) = chunk.as_slices();
        let at = |i: usize| if i < a.len() { a[i] } else { b[i - a.len()] } as f64;
        for f in 0..n {
            let (x, y) = match self.pick {
                Some(k) => {
                    let v = at(f * ch + k.min(ch - 1));
                    (v, v)
                }
                None if ch == 1 => (at(f), at(f)),
                None => (at(f * ch), at(f * ch + 1)),
            };
            l[f] += x * gain;
            r[f] += y * gain;
        }
        chunk.commit_all();
    }
}

impl Monitor {
    /// Open `device`'s input for monitoring. It must run at the output's
    /// rate (`rate`): the mixer plays its samples as they come.
    pub fn start(device: Option<&str>, pick: Option<usize>, rate: f64) -> Result<(Monitor, MonitorFeed), String> {
        let dev = pick_input(device)?;
        let name = dev.name().unwrap_or_else(|_| "default".into());
        let cfg = choose_config(&dev, rate)?;
        if cfg.sample_format() != cpal::SampleFormat::F32 {
            return Err("the input has no f32 format to monitor".into());
        }
        if cfg.sample_rate().0 as f64 != rate {
            return Err(format!("the input runs at {} Hz, the output at {rate} Hz", cfg.sample_rate().0));
        }
        let channels = cfg.channels() as usize;
        check_pick(pick, channels)?;
        let peak = Arc::new(AtomicU32::new(0));
        let mut last_err = String::new();
        // A small fixed buffer when the device allows it (less delay to hear).
        for fixed in [true, false] {
            let mut sc = cfg.config();
            if fixed {
                sc.buffer_size = cpal::BufferSize::Fixed(256);
            }
            let (prod, cons) = rtrb::RingBuffer::<f32>::new(rate as usize * channels / 2);
            match build_monitor(&dev, &sc, channels, pick, prod, peak.clone()) {
                Ok(stream) => {
                    stream.play().map_err(|e| format!("start monitor: {e}"))?;
                    let feed = MonitorFeed { cons, channels, pick, primed: false };
                    return Ok((Monitor { _stream: stream, peak, device: name, channels }, feed));
                }
                Err(e) => last_err = e,
            }
        }
        Err(format!("open monitor: {last_err}"))
    }

    /// The loudest input sample since the last call (0..1+), then reset.
    pub fn take_peak(&self) -> f32 {
        f32::from_bits(self.peak.swap(0, Ordering::Relaxed))
    }
}

fn build_monitor(dev: &cpal::Device, cfg: &cpal::StreamConfig, channels: usize, pick: Option<usize>, mut prod: rtrb::Producer<f32>, peak: Arc<AtomicU32>) -> Result<cpal::Stream, String> {
    dev.build_input_stream(
        cfg,
        move |data: &[f32], _: &cpal::InputCallbackInfo| {
            let mut p = 0f32;
            for (i, v) in data.iter().enumerate() {
                if pick.map_or(true, |k| i % channels == k) {
                    p = p.max(v.abs());
                }
            }
            let _ = peak.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |old| (p > f32::from_bits(old)).then_some(p.to_bits()));
            let n = data.len().min(prod.slots());
            if let Ok(mut chunk) = prod.write_chunk_uninit(n) {
                let (a, b) = chunk.as_mut_slices();
                for (dst, src) in a.iter_mut().chain(b.iter_mut()).zip(data.iter()) {
                    dst.write(*src);
                }
                unsafe { chunk.commit_all() };
            }
        },
        |e| eprintln!("ggmm-engine: monitor stream error: {e}"),
        None,
    )
    .map_err(|e| e.to_string())
}

fn build<T>(dev: &cpal::Device, cfg: &cpal::StreamConfig, channels: usize, rate: f64, mut prod: rtrb::Producer<f32>, shared: Arc<Shared>, clock: Arc<Clock>) -> Result<cpal::Stream, String>
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
            let frames = (data.len() / channels) as u64;
            if let Ok(mut a) = shared.anchor.try_lock() {
                if a.is_none() {
                    if let Ok(m) = clock.mark.try_lock() {
                        *a = anchor_at(&m, now, lat, before, frames, rate);
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
            shared.frames.store(before + frames, Ordering::Relaxed);
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
    fn a_startup_burst_is_anchored_at_its_newest_frame() {
        // Playing from song −2 s since wall 0 (no output latency). The input
        // opened at wall −1.5 s but its first callback comes at +0.5 s with
        // all 2 s buffered and no latency reported.
        let m = OutMark { playing: true, song: -2.0, heard_ns: 0, latency_ns: 0 };
        let a = anchor_at(&m, 500_000_000, 0, 0, 96_000, 48_000.0).unwrap();
        assert_eq!(a.frame, 96_000);
        assert!((a.song - -1.5).abs() < 1e-9);
        // So the take's first frame was captured at song −3.5 s (before the
        // song started); cut at 0, it keeps exactly what came after.
        let (start, trim) = place(&a, 48_000.0);
        assert_eq!((start, trim), (0.0, 168_000));
        // A backend that reports the first frame's latency honestly gives
        // the same anchor.
        let b = anchor_at(&m, 500_000_000, 2_000_000_000, 0, 96_000, 48_000.0).unwrap();
        assert_eq!((b.frame, b.song), (a.frame, a.song));
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
        let out = deinterleave(&data, 3, 1, None);
        assert_eq!(out, vec![vec![2.0, 3.0], vec![20.0, 30.0]]);
        let mono = deinterleave(&[1.0, 2.0, 3.0], 1, 0, None);
        assert_eq!(mono, vec![vec![1.0, 2.0, 3.0]]);
        assert_eq!(deinterleave(&[1.0, 2.0], 2, 5, None), vec![Vec::<f32>::new(), vec![]]);
        // One input of an interface: input 3 alone, as a mono take.
        assert_eq!(deinterleave(&data, 3, 0, Some(2)), vec![vec![100.0, 200.0, 300.0]]);
    }

    #[test]
    fn the_monitor_primes_then_plays_the_picked_input_and_skips_a_backlog() {
        let (mut prod, cons) = rtrb::RingBuffer::<f32>::new(1 << 16);
        let mut feed = MonitorFeed { cons, channels: 2, pick: Some(1), primed: false };
        let mut push = |frames: usize, v: f32| {
            for _ in 0..frames {
                prod.push(9.0).unwrap(); // input 1: not picked
                prod.push(v).unwrap();
            }
        };
        let (mut l, mut r) = ([0.0; 128], [0.0; 128]);
        push(200, 0.5);
        feed.render(&mut l, &mut r, 1.0);
        assert_eq!(l[0], 0.0); // not enough cushion yet: silent
        push(200, 0.5);
        feed.render(&mut l, &mut r, 0.5);
        assert_eq!((l[0], r[127]), (0.25, 0.25)); // input 2 in both sides, at the gain
        // Far behind (the clocks drifted): old frames are skipped, so what
        // plays is the newest audio less the priming cushion.
        push(4000, 0.1);
        let (mut l, mut r) = ([0.0; 128], [0.0; 128]);
        feed.render(&mut l, &mut r, 1.0);
        assert!((l[0] - 0.1).abs() < 1e-6);
        assert_eq!(feed.cons.slots() / 2, MONITOR_PRIME);
    }

    #[test]
    fn a_missing_input_is_refused() {
        assert!(check_pick(Some(1), 2).is_ok());
        assert!(check_pick(None, 1).is_ok());
        assert_eq!(check_pick(Some(2), 2).unwrap_err(), "input 3 doesn't exist (the device has 2)");
    }

    #[test]
    fn a_deck_take_is_placed_where_it_was_heard() {
        let (rec, mut cap) = Recording::start_deck(48_000.0).unwrap();
        let block = |v: f64| (vec![v; 128], vec![-v; 128]);
        // Two blocks with the transport stopped, then playing from song 10 s.
        let (l, r) = block(0.0);
        cap.push(&l, &r, 0.0, false, 0.02);
        cap.push(&l, &r, 0.0, false, 0.02);
        let (l, r) = block(0.5);
        cap.push(&l, &r, 10.0, true, 0.02);
        cap.push(&l, &r, 10.0 + 128.0 / 48_000.0, true, 0.02);
        std::thread::sleep(Duration::from_millis(30));
        let t = rec.finish();
        // 256 frames of pre-roll before the anchor at 10 s − 20 ms.
        assert!((t.start.unwrap() - (10.0 - 0.02 - 256.0 / 48_000.0)).abs() < 1e-9);
        assert_eq!(t.channels.len(), 2);
        assert_eq!(t.channels[0].len(), 512);
        assert_eq!((t.channels[0][300], t.channels[1][300]), (0.5, -0.5));
        assert_eq!(t.device, DECK_SOURCE);
        assert_eq!(t.dropped, 0);
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
