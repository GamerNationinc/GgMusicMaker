//! `ggmm-separate`: the stem separator as its own process (see lib.rs for why).
//!
//!   ggmm-separate --model-dir DIR [--model htdemucs_6s] --in IN.f32 --out OUTDIR [--threads N]
//!
//! IN.f32 is 44.1 kHz stereo, planar little-endian f32 (all of the left
//! channel, then all of the right). Each stem is written the same way to
//! OUTDIR/<name>.f32. Stdout, one line each: `progress <0..1>`, then
//! `stem <name>` per stem written, then `done`. Errors go to stderr, exit 1.
//! Closing stdin (the app quitting or cancelling) stops the separation.

use ggmm_stems::{fold_residual, Demucs};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn read_planar(path: &PathBuf) -> Result<[Vec<f32>; 2], String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if bytes.len() % 8 != 0 {
        return Err("input is not stereo f32".into());
    }
    let all: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let n = all.len() / 2;
    Ok([all[..n].to_vec(), all[n..].to_vec()])
}

fn write_planar(path: &PathBuf, audio: &[Vec<f32>; 2]) -> Result<(), String> {
    let mut out = Vec::with_capacity((audio[0].len() + audio[1].len()) * 4);
    for ch in audio {
        for v in ch {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    // Write-then-rename: the app never reads a half-written stem.
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, out).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| format!("{}: {e}", path.display()))
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let (mut model_dir, mut model, mut input, mut out, mut threads) = (None, "htdemucs_6s".to_string(), None, None, 0usize);
    while let Some(a) = args.next() {
        let mut val = || args.next().ok_or_else(|| format!("{a} needs a value"));
        match a.as_str() {
            "--model-dir" => model_dir = Some(PathBuf::from(val()?)),
            "--model" => model = val()?,
            "--in" => input = Some(PathBuf::from(val()?)),
            "--out" => out = Some(PathBuf::from(val()?)),
            "--threads" => threads = val()?.parse().map_err(|_| "--threads wants a number")?,
            _ => return Err(format!("unknown argument {a}")),
        }
    }
    let (model_dir, input, out) = (
        model_dir.ok_or("--model-dir is required")?,
        input.ok_or("--in is required")?,
        out.ok_or("--out is required")?,
    );
    // The parent closing our stdin means "stop".
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 64];
            while matches!(std::io::stdin().read(&mut buf), Ok(n) if n > 0) {}
            cancel.store(true, Ordering::Relaxed);
        });
    }
    let audio = read_planar(&input)?;
    let mut demucs = Demucs::load(&model_dir, &model, threads)?;
    let mut stdout = std::io::stdout().lock();
    let mut stems = demucs.separate(&audio, |p| {
        let _ = writeln!(stdout, "progress {p:.4}");
        let _ = stdout.flush();
        !cancel.load(Ordering::Relaxed)
    })?;
    fold_residual(&audio, &mut stems);
    std::fs::create_dir_all(&out).map_err(|e| format!("{}: {e}", out.display()))?;
    for s in &stems {
        write_planar(&out.join(format!("{}.f32", s.name)), &s.audio)?;
        let _ = writeln!(stdout, "stem {}", s.name);
    }
    let _ = writeln!(stdout, "done");
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
