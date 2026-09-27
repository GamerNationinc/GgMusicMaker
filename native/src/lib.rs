//! GgMusicMaker native audio engine, loaded by the Electron main process as
//! a Node-API addon (see electron/engine.cjs).
//!
//! The mixer (src/mixer.rs — the whole web FX graph, ported) runs on cpal's
//! real-time callback thread (ALSA → PipeWire on the Deck). The JS side talks
//! to it through a lock-free command channel; everything the callback
//! replaces (old projects, buffers, layer DSP, reverbs) is sent back and freed
//! off the audio thread. Status (playhead, meters, device clock) is published
//! through atomics; the spectrum scope through a try-locked buffer.

pub mod binaural;
pub mod dsp;
pub mod mixer;
pub mod morph;
pub mod placer;
pub mod reverb;
pub mod synth;
pub mod util;

use crossbeam_channel::{bounded, Receiver, Sender};
use mixer::{Buffer, Mixer, ProjectSpec, TrackDsp, SCOPE};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use reverb::{Reverb, Space};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

enum Cmd {
    AddBuffer(String, Arc<Buffer>),
    RemoveBuffer(String),
    SetProject(Box<ProjectSpec>, Vec<(String, TrackDsp)>, Option<Box<Reverb>>),
    Play(f64),
    Stop,
}

#[allow(dead_code)]
enum Garbage {
    Buffer(Arc<Buffer>),
    Project(Box<ProjectSpec>),
    Dsp(Vec<TrackDsp>),
    Reverb(Box<Reverb>),
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
    bus: AtomicU64,
}

fn st(a: &AtomicU64, v: f64) {
    a.store(v.to_bits(), Ordering::Relaxed);
}
fn ld(a: &AtomicU64) -> f64 {
    f64::from_bits(a.load(Ordering::Relaxed))
}

struct Audio {
    mixer: Mixer,
    rx: Receiver<Cmd>,
    trash: Sender<Garbage>,
    status: Arc<Status>,
    scope: Arc<Mutex<Vec<f32>>>,
    chans: Vec<Vec<f32>>,
}

impl Audio {
    fn tick(&mut self, data: &mut [f32], channels: usize) {
        let m = &mut self.mixer;
        while let Ok(cmd) = self.rx.try_recv() {
            match cmd {
                Cmd::AddBuffer(id, b) => {
                    if let Some(old) = m.add_buffer(id, b) {
                        let _ = self.trash.try_send(Garbage::Buffer(old));
                    }
                }
                Cmd::RemoveBuffer(id) => {
                    if let Some(old) = m.remove_buffer(&id) {
                        let _ = self.trash.try_send(Garbage::Buffer(old));
                    }
                }
                Cmd::SetProject(p, fresh, rv) => {
                    let (old, dropped, old_rv) = m.set_project(*p, fresh, rv.map(|b| *b));
                    let _ = self.trash.try_send(Garbage::Project(Box::new(old)));
                    let _ = self.trash.try_send(Garbage::Dsp(dropped));
                    if let Some(r) = old_rv {
                        let _ = self.trash.try_send(Garbage::Reverb(Box::new(r)));
                    }
                }
                Cmd::Play(t) => m.play(t),
                Cmd::Stop => m.stop(),
            }
        }
        let frames = data.len() / channels;
        for c in &mut self.chans {
            if c.len() < frames {
                c.resize(frames, 0.0); // only if the device breaks its promise
            }
        }
        {
            let mut outs: Vec<&mut [f32]> = self.chans.iter_mut().map(|c| &mut c[..frames]).collect();
            m.render(&mut outs);
        }
        for i in 0..frames {
            for c in 0..channels {
                data[i * channels + c] = self.chans[c][i];
            }
        }
        let s = &self.status;
        st(&s.time, m.time());
        s.clock.store(m.clock, Ordering::Relaxed);
        s.playing.store(m.playing, Ordering::Relaxed);
        st(&s.peak, m.peak);
        st(&s.rms, m.rms);
        st(&s.out_peak, m.out_peak);
        st(&s.reduction, m.reduction);
        st(&s.bus, m.bus_channels() as f64);
        if let Ok(mut sc) = self.scope.try_lock() {
            // Oldest → newest.
            let p = m.scope_pos;
            sc[..SCOPE - p].copy_from_slice(&m.scope[p..]);
            sc[SCOPE - p..].copy_from_slice(&m.scope[..p]);
        }
    }
}

#[napi(object)]
pub struct EngineStatus {
    pub time: f64,
    pub clock: f64,
    pub playing: bool,
    pub peak: f64,
    pub rms: f64,
    pub out_peak: f64,
    pub reduction: f64,
    pub sample_rate: f64,
    pub device: String,
    pub device_channels: u32,
    pub bus_channels: u32,
}

/// Build what a project needs off the audio thread: DSP for new layers, and
/// a reverb if the space changed.
fn prepare(p: &ProjectSpec, known: &mut std::collections::HashSet<String>, space: &mut Option<Space>, sr: f64) -> (Vec<(String, TrackDsp)>, Option<Box<Reverb>>) {
    let fresh = p.tracks.iter().filter(|t| !known.contains(&t.id)).map(|t| (t.id.clone(), TrackDsp::new(sr))).collect();
    *known = p.tracks.iter().map(|t| t.id.clone()).collect();
    let rv = if *space != Some(p.reverb) {
        *space = Some(p.reverb);
        Some(Box::new(Reverb::new(p.reverb, sr)))
    } else {
        None
    };
    (fresh, rv)
}

#[napi]
pub struct NativeEngine {
    tx: Sender<Cmd>,
    trash_rx: Receiver<Garbage>,
    status: Arc<Status>,
    scope: Arc<Mutex<Vec<f32>>>,
    sr: f64,
    channels: u32,
    device: String,
    known: Mutex<(std::collections::HashSet<String>, Option<Space>)>,
    _stream: Option<cpal::Stream>,
}

#[napi]
impl NativeEngine {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let host = cpal::default_host();
        let dev = host.default_output_device().ok_or_else(|| Error::from_reason("no audio output device"))?;
        let name = dev.name().unwrap_or_else(|_| "default".into());
        let mut def = dev.default_output_config().map_err(|e| Error::from_reason(format!("output config: {e}")))?;
        // Prefer 48 kHz f32 (what decoded audio is at, so nothing resamples),
        // keeping the default channel count, when the device offers it.
        if let Ok(configs) = dev.supported_output_configs() {
            for c in configs {
                if c.channels() == def.channels()
                    && c.sample_format() == cpal::SampleFormat::F32
                    && c.min_sample_rate().0 <= 48000
                    && c.max_sample_rate().0 >= 48000
                {
                    def = c.with_sample_rate(cpal::SampleRate(48000));
                    break;
                }
            }
        }
        if def.sample_format() != cpal::SampleFormat::F32 {
            return Err(Error::from_reason("device has no f32 output"));
        }
        let channels = def.channels() as usize;
        let sr = def.sample_rate().0 as f64;
        let status = Arc::new(Status::default());
        let scope = Arc::new(Mutex::new(vec![0f32; SCOPE]));
        let mut last_err = String::new();
        for fixed in [true, false] {
            let mut cfg: cpal::StreamConfig = def.config();
            if fixed {
                cfg.buffer_size = cpal::BufferSize::Fixed(512); // ~10 ms at 48 kHz
            }
            let (tx, rx) = bounded::<Cmd>(1024);
            let (trash_tx, trash_rx) = bounded::<Garbage>(4096);
            let mut audio = Audio {
                mixer: Mixer::new(sr, channels),
                rx,
                trash: trash_tx,
                status: status.clone(),
                scope: scope.clone(),
                chans: vec![vec![0f32; 8192]; channels],
            };
            match dev.build_output_stream(&cfg, move |data: &mut [f32], _| audio.tick(data, channels), |e| eprintln!("ggmm-engine: stream error: {e}"), None) {
                Ok(stream) => {
                    stream.play().map_err(|e| Error::from_reason(format!("start stream: {e}")))?;
                    return Ok(NativeEngine {
                        tx,
                        trash_rx,
                        status,
                        scope,
                        sr,
                        channels: channels as u32,
                        device: name,
                        known: Mutex::new((Default::default(), None)),
                        _stream: Some(stream),
                    });
                }
                Err(e) => last_err = e.to_string(),
            }
        }
        Err(Error::from_reason(format!("open stream: {last_err}")))
    }

    fn collect_garbage(&self) {
        while self.trash_rx.try_recv().is_ok() {}
    }

    fn send(&self, c: Cmd) -> Result<()> {
        self.collect_garbage();
        self.tx.try_send(c).map_err(|_| Error::from_reason("engine command queue full"))
    }

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

    #[napi]
    pub fn set_project(&self, json: String) -> Result<()> {
        let mut p: ProjectSpec = serde_json::from_str(&json).map_err(|e| Error::from_reason(format!("project: {e}")))?;
        p.quantize();
        let (fresh, rv) = {
            let mut k = self.known.lock().unwrap();
            let (known, space) = &mut *k;
            prepare(&p, known, space, self.sr)
        };
        self.send(Cmd::SetProject(Box::new(p), fresh, rv))
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
            device_channels: self.channels,
            bus_channels: ld(&s.bus) as u32,
        }
    }

    /// The last 2048 pre-limiter mono samples (for the spectrum meter).
    #[napi]
    pub fn scope(&self) -> Float32Array {
        Float32Array::new(self.scope.lock().map(|s| s.clone()).unwrap_or_else(|_| vec![0.0; SCOPE]))
    }
}

pub struct RenderTask {
    project: ProjectSpec,
    buffers: Vec<(String, Arc<Buffer>)>,
    sr: f64,
    tail: f64,
}

impl Task for RenderTask {
    type Output = Vec<Vec<f32>>;
    type JsValue = Vec<Float32Array>;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(render(std::mem::replace(&mut self.project, ProjectSpec { tracks: vec![], master_gain: 0.0, surround: 2, reverb: Space::Hall, binaural: false }), &self.buffers, self.sr, self.tail))
    }
    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(out.into_iter().map(Float32Array::new).collect())
    }
}

/// Offline render: the same Mixer, no device, as many channels as the
/// project's layout (never binaural).
pub fn render(mut p: ProjectSpec, buffers: &[(String, Arc<Buffer>)], sr: f64, tail: f64) -> Vec<Vec<f32>> {
    p.binaural = false;
    let n = p.surround.clamp(2, 8);
    let mut m = Mixer::new(sr, 0);
    for (id, b) in buffers {
        m.add_buffer(id.clone(), b.clone());
    }
    let mut known = Default::default();
    let mut space = None;
    let (fresh, rv) = prepare(&p, &mut known, &mut space, sr);
    m.set_project(p, fresh, rv.map(|b| *b));
    let frames = ((m.duration() + tail) * sr).ceil().max(1.0) as usize;
    let mut out = vec![vec![0f32; frames]; n];
    m.play(0.0);
    let mut views: Vec<&mut [f32]> = out.iter_mut().map(|c| c.as_mut_slice()).collect();
    m.render(&mut views);
    out
}

/// Offline render (export, tests) on a worker thread. Returns one
/// Float32Array per channel of the project's layout.
#[napi]
pub fn render_offline(project_json: String, buffer_ids: Vec<String>, buffer_rates: Vec<f64>, buffer_data: Vec<Vec<Float32Array>>, sample_rate: f64, tail_seconds: f64) -> Result<AsyncTask<RenderTask>> {
    let mut project: ProjectSpec = serde_json::from_str(&project_json).map_err(|e| Error::from_reason(format!("project: {e}")))?;
    project.quantize();
    let buffers = buffer_ids
        .into_iter()
        .zip(buffer_rates)
        .zip(buffer_data)
        .map(|((id, rate), chans)| (id, Arc::new(Buffer { rate, channels: chans.iter().take(2).map(|c| c.to_vec()).collect() })))
        .collect();
    Ok(AsyncTask::new(RenderTask { project, buffers, sr: sample_rate, tail: tail_seconds }))
}

/// Test hook: run one ported module over `inputs` in 128-frame quanta, the
/// way the worklet host runs the JS original. kind: "synth" | "morph" |
/// "placer" (params {pan, width}) | "binaural" | "reverb" (params {space}).
#[napi]
pub fn process_module(kind: String, params_json: String, inputs: Vec<Float32Array>, out_channels: u32, sample_rate: f64) -> Result<Vec<Float32Array>> {
    let bad = |e: serde_json::Error| Error::from_reason(format!("params: {e}"));
    let ins: Vec<Vec<f32>> = inputs.iter().map(|c| c.to_vec()).collect();
    let len = ins.first().map(|c| c.len()).unwrap_or(0);
    let n_out = out_channels as usize;
    let mut out = vec![vec![0f32; len]; n_out];
    enum M {
        S(Box<synth::VoiceSynth>, synth::SynthParams),
        Mo(Box<morph::Morph>, morph::MorphParams),
        P(placer::Placer, f64, f64),
        B(binaural::Binaural),
        R(Box<Reverb>),
    }
    #[derive(serde::Deserialize)]
    struct Pw {
        pan: f64,
        width: f64,
    }
    #[derive(serde::Deserialize)]
    struct Rs {
        space: Space,
    }
    let mut m = match kind.as_str() {
        "synth" => {
            let mut p: synth::SynthParams = serde_json::from_str(&params_json).map_err(bad)?;
            p.quantize();
            M::S(Box::new(synth::VoiceSynth::new(sample_rate)), p)
        }
        "morph" => {
            let mut p: morph::MorphParams = serde_json::from_str(&params_json).map_err(bad)?;
            p.quantize();
            M::Mo(Box::new(morph::Morph::new(sample_rate)), p)
        }
        "placer" => {
            let p: Pw = serde_json::from_str(&params_json).map_err(bad)?;
            M::P(placer::Placer::default(), p.pan as f32 as f64, p.width as f32 as f64)
        }
        "binaural" => M::B(binaural::Binaural::new(ins.len(), sample_rate)),
        "reverb" => {
            let p: Rs = serde_json::from_str(&params_json).map_err(bad)?;
            M::R(Box::new(Reverb::new(p.space, sample_rate)))
        }
        _ => return Err(Error::from_reason("unknown module")),
    };
    let mut i = 0;
    while i < len {
        let q = (len - i).min(128);
        let inp: Vec<&[f32]> = ins.iter().map(|c| &c[i..i + q]).collect();
        let mut o: Vec<&mut [f32]> = out.iter_mut().map(|c| &mut c[i..i + q]).collect();
        match &mut m {
            M::S(s, p) => s.process(p, &inp, &mut o),
            M::Mo(s, p) => s.process(p, &inp, &mut o),
            M::P(s, pan, width) => s.process(*pan, *width, &inp, &mut o),
            M::B(b) => {
                let mut frame = [0f64; util::MAX_CH];
                for n in 0..q {
                    for (c, ch) in inp.iter().enumerate() {
                        frame[c] = ch[n] as f64;
                    }
                    let (l, r) = b.step(&frame[..inp.len()]);
                    o[0][n] = l as f32;
                    o[1][n] = r as f32;
                }
            }
            M::R(r) => {
                for n in 0..q {
                    let (l, rr) = r.step(inp[0][n] as f64, inp[1][n] as f64);
                    o[0][n] = l as f32;
                    o[1][n] = rr as f32;
                }
            }
        }
        i += q;
    }
    Ok(out.into_iter().map(Float32Array::new).collect())
}
