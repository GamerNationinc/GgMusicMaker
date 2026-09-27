//! GgMusicMaker native audio engine, loaded by the Electron main process as
//! a Node-API addon (see electron/engine.cjs).
//!
//! The mixer runs on cpal's real-time callback thread (ALSA → PipeWire on
//! the Deck), not in the page. The JS side talks to it through a lock-free
//! command channel; everything the callback replaces (old projects, buffers,
//! layer DSP state) is sent back and freed off the audio thread. Status
//! (playhead, meters, the device clock) is published through atomics.

pub mod dsp;
pub mod mixer;

use crossbeam_channel::{bounded, Receiver, Sender};
use mixer::{Buffer, Mixer, ProjectSpec, TrackDsp};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

enum Cmd {
    AddBuffer(String, Arc<Buffer>),
    RemoveBuffer(String),
    SetProject(ProjectSpec, Vec<(String, TrackDsp)>),
    Play(f64),
    Stop,
}

/// Things the audio thread hands back to be dropped elsewhere.
enum Garbage {
    Buffer(#[allow(dead_code)] Arc<Buffer>),
    Project(#[allow(dead_code)] ProjectSpec),
    Dsp(#[allow(dead_code)] Vec<TrackDsp>),
}

#[derive(Default)]
struct Status {
    time: AtomicU64,
    clock: AtomicU64,
    playing: AtomicBool,
    peak: AtomicU64,
    rms: AtomicU64,
    out_peak: AtomicU64,
    reduction: AtomicU64,
}

fn st(a: &AtomicU64, v: f64) {
    a.store(v.to_bits(), Ordering::Relaxed);
}
fn ld(a: &AtomicU64) -> f64 {
    f64::from_bits(a.load(Ordering::Relaxed))
}

/// Apply queued commands then render one callback's worth into `data`
/// (interleaved, `channels` wide; the mix goes to the first two).
fn audio_tick(m: &mut Mixer, rx: &Receiver<Cmd>, trash: &Sender<Garbage>, status: &Status, data: &mut [f32], channels: usize, scratch: &mut (Vec<f32>, Vec<f32>)) {
    while let Ok(cmd) = rx.try_recv() {
        match cmd {
            Cmd::AddBuffer(id, b) => {
                if let Some(old) = m.add_buffer(id, b) {
                    let _ = trash.try_send(Garbage::Buffer(old));
                }
            }
            Cmd::RemoveBuffer(id) => {
                if let Some(old) = m.remove_buffer(&id) {
                    let _ = trash.try_send(Garbage::Buffer(old));
                }
            }
            Cmd::SetProject(p, fresh) => {
                let (old, dropped) = m.set_project(p, fresh);
                let _ = trash.try_send(Garbage::Project(old));
                let _ = trash.try_send(Garbage::Dsp(dropped));
            }
            Cmd::Play(t) => m.play(t),
            Cmd::Stop => m.stop(),
        }
    }
    let frames = data.len() / channels;
    let (l, r) = scratch;
    if l.len() < frames {
        // Only if the device suddenly asks for more than it said it would.
        l.resize(frames, 0.0);
        r.resize(frames, 0.0);
    }
    m.render(&mut l[..frames], &mut r[..frames]);
    for i in 0..frames {
        let o = i * channels;
        data[o] = l[i];
        if channels > 1 {
            data[o + 1] = r[i];
        }
        for c in 2..channels {
            data[o + c] = 0.0;
        }
    }
    st(&status.time, m.time());
    status.clock.store(m.clock, Ordering::Relaxed);
    status.playing.store(m.playing, Ordering::Relaxed);
    st(&status.peak, m.peak);
    st(&status.rms, m.rms);
    st(&status.out_peak, m.out_peak);
    st(&status.reduction, m.reduction_db());
}

#[napi(object)]
pub struct EngineStatus {
    pub time: f64,
    /// Device clock in seconds (frames pulled / rate).
    pub clock: f64,
    pub playing: bool,
    pub peak: f64,
    pub rms: f64,
    pub out_peak: f64,
    pub reduction: f64,
    pub sample_rate: f64,
    pub device: String,
}

#[napi]
pub struct NativeEngine {
    tx: Sender<Cmd>,
    trash_rx: Receiver<Garbage>,
    status: Arc<Status>,
    sr: f64,
    device: String,
    /// Layer ids the audio thread already has DSP state for.
    known: Mutex<std::collections::HashSet<String>>,
    // cpal::Stream isn't Send; it only ever lives on the JS main thread.
    _stream: Option<cpal::Stream>,
}

#[napi]
impl NativeEngine {
    /// Open the default output device and start the real-time stream.
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let host = cpal::default_host();
        let dev = host.default_output_device().ok_or_else(|| Error::from_reason("no audio output device"))?;
        let name = dev.name().unwrap_or_else(|_| "default".into());
        let def = dev.default_output_config().map_err(|e| Error::from_reason(format!("output config: {e}")))?;
        let channels = def.channels() as usize;
        let sr = def.sample_rate().0 as f64;
        let mut cfg: cpal::StreamConfig = def.config();
        // ~10 ms at 48 kHz: low enough to feel immediate, safe on the Deck.
        cfg.buffer_size = cpal::BufferSize::Fixed(512);

        let (tx, rx) = bounded::<Cmd>(1024);
        let (trash_tx, trash_rx) = bounded::<Garbage>(1024);
        let status = Arc::new(Status::default());
        let st2 = status.clone();
        let mut mixer = Mixer::new(sr);
        let mut scratch = (vec![0f32; 8192], vec![0f32; 8192]);
        let build = |cfg: &cpal::StreamConfig, mut mixer: Mixer, rx: Receiver<Cmd>, trash_tx: Sender<Garbage>, st2: Arc<Status>, mut scratch: (Vec<f32>, Vec<f32>)| {
            dev.build_output_stream(
                cfg,
                move |data: &mut [f32], _| audio_tick(&mut mixer, &rx, &trash_tx, &st2, data, channels, &mut scratch),
                |e| eprintln!("ggmm-engine: stream error: {e}"),
                None,
            )
        };
        let stream = match build(&cfg, mixer, rx.clone(), trash_tx.clone(), st2.clone(), scratch) {
            Ok(s) => s,
            Err(_) => {
                // Some devices refuse a fixed buffer; take the default.
                cfg.buffer_size = cpal::BufferSize::Default;
                mixer = Mixer::new(sr);
                scratch = (vec![0f32; 8192], vec![0f32; 8192]);
                build(&cfg, mixer, rx, trash_tx, st2, scratch).map_err(|e| Error::from_reason(format!("open stream: {e}")))?
            }
        };
        stream.play().map_err(|e| Error::from_reason(format!("start stream: {e}")))?;
        Ok(NativeEngine { tx, trash_rx, status, sr, device: name, known: Mutex::new(Default::default()), _stream: Some(stream) })
    }

    fn collect_garbage(&self) {
        while self.trash_rx.try_recv().is_ok() {}
    }

    fn send(&self, c: Cmd) -> Result<()> {
        self.collect_garbage();
        self.tx.try_send(c).map_err(|_| Error::from_reason("engine command queue full"))
    }

    /// Hand over decoded audio (one Float32Array per channel).
    #[napi]
    pub fn load_buffer(&self, id: String, sample_rate: f64, channels: Vec<Float32Array>) -> Result<()> {
        let b = Buffer { rate: sample_rate, channels: channels.iter().take(2).map(|c| c.to_vec()).collect() };
        if b.channels.is_empty() {
            return Err(Error::from_reason("buffer has no channels"));
        }
        self.send(Cmd::AddBuffer(id, Arc::new(b)))
    }

    #[napi]
    pub fn remove_buffer(&self, id: String) -> Result<()> {
        self.send(Cmd::RemoveBuffer(id))
    }

    /// Replace the project (JSON of mixer::ProjectSpec).
    #[napi]
    pub fn set_project(&self, json: String) -> Result<()> {
        let p: ProjectSpec = serde_json::from_str(&json).map_err(|e| Error::from_reason(format!("project: {e}")))?;
        let mut known = self.known.lock().unwrap();
        let fresh: Vec<(String, TrackDsp)> =
            p.tracks.iter().filter(|t| !known.contains(&t.id)).map(|t| (t.id.clone(), TrackDsp::new(self.sr))).collect();
        *known = p.tracks.iter().map(|t| t.id.clone()).collect();
        self.send(Cmd::SetProject(p, fresh))
    }

    #[napi]
    pub fn play(&self, from: f64) -> Result<()> {
        self.send(Cmd::Play(from))
    }

    #[napi]
    pub fn stop(&self) -> Result<()> {
        self.send(Cmd::Stop)
    }

    #[napi]
    pub fn status(&self) -> EngineStatus {
        self.collect_garbage();
        let s = &self.status;
        EngineStatus {
            time: ld(&s.time),
            clock: s.clock.load(Ordering::Relaxed) as f64 / self.sr,
            playing: s.playing.load(Ordering::Relaxed),
            peak: ld(&s.peak),
            rms: ld(&s.rms),
            out_peak: ld(&s.out_peak),
            reduction: ld(&s.reduction),
            sample_rate: self.sr,
            device: self.device.clone(),
        }
    }
}

/// Offline render (export, tests): no device needed. `buffers` maps ids to
/// [sampleRate, ...channels]; returns [left, right].
#[napi]
pub fn render_offline(project_json: String, buffer_ids: Vec<String>, buffer_rates: Vec<f64>, buffer_data: Vec<Vec<Float32Array>>, sample_rate: f64, tail_seconds: f64) -> Result<Vec<Float32Array>> {
    let p: ProjectSpec = serde_json::from_str(&project_json).map_err(|e| Error::from_reason(format!("project: {e}")))?;
    let mut m = Mixer::new(sample_rate);
    for ((id, rate), chans) in buffer_ids.into_iter().zip(buffer_rates).zip(buffer_data) {
        m.add_buffer(id, Arc::new(Buffer { rate, channels: chans.iter().take(2).map(|c| c.to_vec()).collect() }));
    }
    let fresh = p.tracks.iter().map(|t| (t.id.clone(), TrackDsp::new(sample_rate))).collect();
    m.set_project(p, fresh);
    let frames = ((m.duration() + tail_seconds) * sample_rate).ceil().max(1.0) as usize;
    let mut l = vec![0f32; frames];
    let mut r = vec![0f32; frames];
    m.play(0.0);
    m.render(&mut l, &mut r);
    Ok(vec![Float32Array::new(l), Float32Array::new(r)])
}
