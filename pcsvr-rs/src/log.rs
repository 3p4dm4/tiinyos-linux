//! Size-capped file logger.
//!
//! The Python shim wrote to `pcsvr-shim.log` with no cap and reached 16 MB
//! in a few days (and its EMFILE death then made every log line fail noisily
//! on top of everything else). This one:
//!
//! * appends `[YYYY-MM-DD HH:MM:SS] msg` lines (UTC; the process has no
//!   `unsafe` allowance for libc `localtime_r`);
//! * when the file exceeds `max_bytes`, rotates: current -> `.old`, new file;
//!   so total footprint is bounded by 2 x max_bytes;
//! * throttles to at most one line per 100 ms globally, so a hostile or
//!   chatty client cannot inflate the file (or CPU) at request rate;
//! * if the file cannot be opened (permissions, read-only fs), falls back to
//!   stderr instead of panicking — the app launches us detached.

use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static GLOBAL: OnceLock<Logger> = OnceLock::new();

/// Install the process-wide logger (called once from main). Later calls are
/// ignored, like the std env logger's `init`.
pub fn init(path: &str, max_bytes: u64) -> &'static Logger {
    GLOBAL.get_or_init(|| Logger::new(path, max_bytes))
}

/// The process-wide logger. When `init` was never called (unit and
/// integration tests, library users) it discards: a test must never create
/// a log file in the source tree.
pub fn global() -> &'static Logger {
    GLOBAL.get_or_init(Logger::null)
}

const LINE_BUDGET: usize = 400; // truncate long lines (paths, bodies)
const MIN_INTERVAL_MS: i64 = 100;

pub struct Logger {
    path: Option<PathBuf>,
    max_bytes: u64,
    throttle_ms: i64,
    state: Mutex<LogState>,
    last_tick: AtomicI64,
    file_ok: AtomicBool,
}

struct LogState {
    file: Option<File>,
    written: u64,
}

impl Logger {
    /// A logger that discards everything.
    pub fn null() -> Self {
        Self {
            path: None,
            max_bytes: 0,
            throttle_ms: 0,
            state: Mutex::new(LogState {
                file: None,
                written: 0,
            }),
            last_tick: AtomicI64::new(0),
            file_ok: AtomicBool::new(true),
        }
    }

    pub fn new(path: &str, max_bytes: u64) -> Self {
        let existing = File::open(path)
            .ok()
            .and_then(|f| f.metadata().ok())
            .map(|m| m.len());
        Self {
            path: if path.is_empty() {
                None
            } else {
                Some(PathBuf::from(path))
            },
            max_bytes: max_bytes.max(64 * 1024),
            throttle_ms: MIN_INTERVAL_MS,
            state: Mutex::new(LogState {
                file: None,
                written: existing.unwrap_or(0),
            }),
            last_tick: AtomicI64::new(0),
            file_ok: AtomicBool::new(true),
        }
    }

    /// Throttle off (tests that must observe every line).
    pub fn unthrottled(path: &str, max_bytes: u64) -> Self {
        let mut l = Self::new(path, max_bytes);
        l.throttle_ms = 0;
        l
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn throttled(&self) -> bool {
        if self.throttle_ms <= 0 {
            return false;
        }
        let now = Self::now_ms();
        let last = self.last_tick.load(Ordering::Relaxed);
        if now - last >= self.throttle_ms {
            self.last_tick.store(now, Ordering::Relaxed);
            false
        } else {
            true
        }
    }

    pub fn log(&self, msg: &str) {
        let path = match &self.path {
            Some(p) => p.clone(),
            None => return, // discarding logger (tests, library users)
        };
        if self.throttled() {
            return;
        }
        let mut line = String::with_capacity(msg.len() + 32);
        line.push_str(&timestamp());
        line.push(' ');
        let msg: String = msg.chars().take(LINE_BUDGET).collect();
        line.push_str(&msg);
        line.push('\n');

        if !self.file_ok.load(Ordering::Relaxed) {
            eprintln!("[pcsvr] {line}");
            return;
        }
        let mut st = self.state.lock().unwrap();
        if st.file.is_none() {
            st.file = match fs::OpenOptions::new().create(true).append(true).open(&path) {
                Ok(f) => Some(f),
                Err(_) => {
                    self.file_ok.store(false, Ordering::Relaxed);
                    eprintln!("[pcsvr] {line}");
                    return;
                }
            };
        }
        let rotate = st.written > self.max_bytes;
        if rotate {
            let old = path.with_extension("old");
            let _ = fs::remove_file(&old);
            let _ = fs::rename(&path, &old);
            st.file = None;
            st.written = 0;
        }
        if st.file.is_none() {
            st.file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .ok();
        }
        let file = match st.file.as_mut() {
            Some(f) => f,
            None => {
                self.file_ok.store(false, Ordering::Relaxed);
                eprintln!("[pcsvr] {line}");
                return;
            }
        };
        if let Err(e) = file.write_all(line.as_bytes()) {
            self.file_ok.store(false, Ordering::Relaxed);
            eprintln!("[pcsvr] {line}");
            let _ = e;
            return;
        }
        st.written += line.len() as u64;
    }
}

fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // days since epoch -> calendar date (civil-from-days algorithm)
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{m:02}:{s:02}")
}

pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if mo <= 2 { y + 1 } else { y }, mo, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn tmp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("pcsvr-test-{name}-{}.log", std::process::id()));
        p
    }

    #[test]
    fn writes_and_caps() {
        let p = tmp_path("cap");
        let _ = fs::remove_file(&p);
        let _ = fs::remove_file(p.with_extension("old"));
        // the implementation clamps the cap to a floor; test against that
        let cap = 64 * 1024;
        let log = Logger::unthrottled(p.to_str().unwrap(), cap);
        for k in 0..6000 {
            log.log(&format!("line {k} padding-to-make-it-realistically-long"));
        }
        let main_len = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        let old_len = fs::metadata(p.with_extension("old"))
            .map(|m| m.len())
            .unwrap_or(0);
        assert!(main_len > 0, "nothing written");
        assert!(main_len <= cap + 128, "main log unbounded: {main_len}");
        assert!(old_len <= cap + 128, "old log unbounded: {old_len}");
        // content survives rotation
        let mut data = String::new();
        if let Ok(mut f) = fs::File::open(&p) {
            f.read_to_string(&mut data).ok();
        }
        assert!(data.contains("line "));
        assert!(data.contains("line 5999"), "newest line missing");
        let _ = fs::remove_file(&p);
        let _ = fs::remove_file(p.with_extension("old"));
    }

    #[test]
    fn throttles_but_first_line_gets_through() {
        let p = tmp_path("throttle");
        let _ = fs::remove_file(&p);
        let log = Logger::new(p.to_str().unwrap(), 1024 * 1024);
        for _ in 0..50 {
            log.log("spam");
        }
        let mut data = String::new();
        fs::File::open(&p)
            .ok()
            .as_mut()
            .and_then(|f| f.read_to_string(&mut data).ok());
        let lines = data.lines().count();
        assert!((1..=3).contains(&lines), "expected ~1 line, got {lines}");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_454), (2026, 1, 1)); // 2026-01-01
        assert_eq!(civil_from_days(19_782), (2024, 2, 29)); // leap day
    }
}
