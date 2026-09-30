//! Raw Steam Deck controller input (Valve 28DE:1205, the vendor interface).
//!
//! Chromium's Gamepad API only sees what Steam Input emits — sticks, ABXY,
//! bumpers, triggers — and never the trackpads, their pressure, the four back
//! buttons or the IMU. Those are all in the controller's own 64-byte state
//! report (type 0x09, 250 Hz), which any process of the seat user can read
//! from hidraw alongside Steam (udev gives the user an ACL on the node).
//!
//! A reader thread keeps the latest report; the Electron main process polls
//! it (electron/deckpad.cjs) and the renderer parses it (src/input/deckpad.ts
//! — parsing stays in TypeScript so it is unit-tested with the mapping).
//! Feature reports (haptics) go out through HIDIOCSFEATURE.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

const HID_ID: &str = "HID_ID=0003:000028DE:00001205";
/// Report type of the Deck's full state packet.
const DECK_STATE: u8 = 0x09;

struct Shared {
    latest: Mutex<[u8; 64]>,
    seq: AtomicU64,
    alive: AtomicBool,
    stop: AtomicBool,
}

/// The hidraw node of the Deck controller's vendor interface (USB interface
/// 2 — interfaces 0 and 1 are Steam's emulated mouse and keyboard).
fn find_device() -> Option<String> {
    let mut found = vec![];
    for e in fs::read_dir("/sys/class/hidraw").ok()?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let dev = e.path().join("device");
        let uevent = fs::read_to_string(dev.join("uevent")).unwrap_or_default();
        if !uevent.contains(HID_ID) {
            continue;
        }
        let real = fs::canonicalize(&dev).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        found.push((real.contains(":1.2/"), format!("/dev/{name}")));
    }
    found.sort();
    found.pop().map(|(_, p)| p)
}

#[cfg(target_os = "linux")]
fn set_feature(f: &File, report: &[u8]) -> std::io::Result<()> {
    extern "C" {
        fn ioctl(fd: i32, req: std::ffi::c_ulong, ...) -> i32;
    }
    // Report id 0 first (the controller doesn't number its reports), padded
    // to the 64-byte feature report.
    let mut buf = [0u8; 65];
    let n = report.len().min(64);
    buf[1..1 + n].copy_from_slice(&report[..n]);
    // _IOC(_IOC_READ | _IOC_WRITE, 'H', 0x06, len)
    let req = (3 << 30) | ((buf.len() as std::ffi::c_ulong) << 16) | ((b'H' as std::ffi::c_ulong) << 8) | 0x06;
    let r = unsafe { ioctl(f.as_raw_fd(), req, buf.as_mut_ptr()) };
    if r < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "linux"))]
fn set_feature(_f: &File, _report: &[u8]) -> std::io::Result<()> {
    Err(std::io::Error::other("no hidraw on this OS"))
}

#[napi(object)]
pub struct DeckReport {
    pub seq: f64,
    pub report: Buffer,
}

#[napi]
pub struct DeckPad {
    shared: Arc<Shared>,
    writer: Mutex<File>,
    path: String,
}

#[napi]
impl DeckPad {
    /// Open the Deck controller. Errors when there is none (not a Deck, or
    /// the node isn't readable).
    #[napi(factory)]
    pub fn open() -> Result<DeckPad> {
        let path = find_device().ok_or_else(|| Error::from_reason("no Steam Deck controller"))?;
        let mut reader = File::open(&path).map_err(|e| Error::from_reason(format!("{path}: {e}")))?;
        let writer = OpenOptions::new().read(true).write(true).open(&path).map_err(|e| Error::from_reason(format!("{path}: {e}")))?;
        let shared = Arc::new(Shared { latest: Mutex::new([0; 64]), seq: AtomicU64::new(0), alive: AtomicBool::new(true), stop: AtomicBool::new(false) });
        let sh = shared.clone();
        std::thread::Builder::new()
            .name("ggmm-deckpad".into())
            .spawn(move || {
                let mut buf = [0u8; 64];
                while !sh.stop.load(Ordering::Relaxed) {
                    match reader.read(&mut buf) {
                        Ok(n) if n >= 60 && buf[2] == DECK_STATE => {
                            if let Ok(mut l) = sh.latest.lock() {
                                *l = buf;
                            }
                            sh.seq.fetch_add(1, Ordering::Release);
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
                sh.alive.store(false, Ordering::Release);
            })
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(DeckPad { shared, writer: Mutex::new(writer), path })
    }

    #[napi(getter)]
    pub fn path(&self) -> String {
        self.path.clone()
    }

    /// False once the reader stopped (device gone or closed).
    #[napi]
    pub fn alive(&self) -> bool {
        self.shared.alive.load(Ordering::Acquire)
    }

    /// The newest state report if it's newer than `since` (a previous `seq`).
    #[napi]
    pub fn latest(&self, since: f64) -> Option<DeckReport> {
        let seq = self.shared.seq.load(Ordering::Acquire);
        if seq == 0 || seq as f64 <= since {
            return None;
        }
        let r = *self.shared.latest.lock().ok()?;
        Some(DeckReport { seq: seq as f64, report: r.to_vec().into() })
    }

    /// Send a feature report (first byte = message type, then its length
    /// and payload — see src/input/deckpad.ts for the ones we use).
    #[napi]
    pub fn feature(&self, report: Buffer) -> Result<()> {
        let f = self.writer.lock().map_err(|_| Error::from_reason("deckpad lock"))?;
        set_feature(&f, &report).map_err(|e| Error::from_reason(format!("feature: {e}")))
    }

    /// Stop the reader (it notices within one report, ≤ 4 ms).
    #[napi]
    pub fn close(&self) {
        self.shared.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for DeckPad {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
    }
}
