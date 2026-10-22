// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! Local log files in `%LOCALAPPDATA%\FriendFlix\logs` (one per UTC day, `friendflix-YYYY-MM-DD.log`). Every line goes
//! through `logs::scrub` (no query strings, cookies or session ids); files older than 14 days are deleted at start.
//! Nothing is sent anywhere.
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use friendflix_core::logs::scrub;
use log::{Level, LevelFilter, Log, Metadata, Record};

const KEEP: Duration = Duration::from_secs(14 * 86_400);
const PREFIX: &str = "friendflix-";

/// (year, month, day, hour, minute, second) in UTC for seconds since 1970 (H. Hinnant's days-to-civil).
pub fn civil(unix_secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (unix_secs / 86_400) as i64;
    let rem = unix_secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (
        y,
        m,
        d,
        (rem / 3_600) as u32,
        (rem % 3_600 / 60) as u32,
        (rem % 60) as u32,
    )
}

fn secs(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn day(t: SystemTime) -> String {
    let (y, m, d, ..) = civil(secs(t));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Only `friendflix-*.log` files are ours; they are deleted once they were last written more than 14 days ago.
pub fn expired(name: &str, modified: SystemTime, now: SystemTime) -> bool {
    name.starts_with(PREFIX)
        && name.ends_with(".log")
        && now.duration_since(modified).is_ok_and(|age| age > KEEP)
}

/// One scrubbed log line (line breaks in the message become spaces, so a message cannot forge lines).
pub fn line(now: SystemTime, level: Level, target: &str, msg: &str) -> String {
    let (y, mo, d, h, mi, s) = civil(secs(now));
    let msg = scrub(msg).replace(['\r', '\n'], " ");
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02} {level} {target}: {msg}\n")
}

/// `%LOCALAPPDATA%\FriendFlix\logs` on Windows; the XDG state folder elsewhere (development builds).
pub fn dir() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("state"))
            })
    };
    base.filter(|b| b.is_absolute())
        .map(|b| b.join("FriendFlix").join("logs"))
}

struct FileLog {
    dir: PathBuf,
    /// the open file and its day
    file: Mutex<Option<(String, File)>>,
}

impl Log for FileLog {
    fn enabled(&self, m: &Metadata) -> bool {
        m.level() <= max_level()
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let now = SystemTime::now();
        let text = line(
            now,
            record.level(),
            record.target(),
            &record.args().to_string(),
        );
        if cfg!(debug_assertions) {
            eprint!("{text}");
        }
        let today = day(now);
        let Ok(mut slot) = self.file.lock() else {
            return;
        };
        if slot.as_ref().is_none_or(|(d, _)| *d != today) {
            let path = self.dir.join(format!("{PREFIX}{today}.log"));
            *slot = OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .ok()
                .map(|f| (today, f));
        }
        if let Some((_, f)) = slot.as_mut() {
            let _ = f.write_all(text.as_bytes());
        }
    }

    fn flush(&self) {
        if let Ok(mut slot) = self.file.lock() {
            if let Some((_, f)) = slot.as_mut() {
                let _ = f.flush();
            }
        }
    }
}

fn max_level() -> LevelFilter {
    if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    }
}

fn prune(dir: &PathBuf, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let modified = e.metadata().and_then(|m| m.modified());
        if let Ok(modified) = modified {
            if expired(&name, modified, now) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

/// Starts file logging (and logs panics through it). Without a log folder, logging stays off.
pub fn init() {
    let Some(dir) = dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    prune(&dir, SystemTime::now());
    let logger = FileLog {
        dir,
        file: Mutex::new(None),
    };
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(max_level());
        std::panic::set_hook(Box::new(|info| {
            log::error!(target: "panic", "{info}");
            log::logger().flush();
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 86_400;

    #[test]
    fn civil_dates() {
        assert_eq!(civil(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(civil(951_782_400), (2000, 2, 29, 0, 0, 0));
        assert_eq!(civil(1_792_627_199), (2026, 10, 21, 23, 59, 59));
        assert_eq!(civil(1_792_627_200 + 3_723), (2026, 10, 22, 1, 2, 3));
    }

    #[test]
    fn keeps_14_days() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_627_200);
        let ago = |d: u64| now - Duration::from_secs(d);
        assert!(!expired("friendflix-2026-10-08.log", ago(13 * DAY), now));
        assert!(!expired(
            "friendflix-2026-10-08.log",
            ago(14 * DAY - 1),
            now
        ));
        assert!(expired("friendflix-2026-10-07.log", ago(14 * DAY + 1), now));
        assert!(expired("friendflix-2020-01-01.log", ago(400 * DAY), now));
        // only our own log files are ever deleted
        assert!(!expired("notes.txt", ago(400 * DAY), now));
        assert!(!expired("friendflix-2020-01-01.txt", ago(400 * DAY), now));
        assert!(!expired("mpv.log", ago(400 * DAY), now));
    }

    #[test]
    fn lines_are_scrubbed() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_627_200 + 3_723);
        let l = line(
            now,
            log::Level::Warn,
            "friendflix",
            "GET https://friend.example.com/a?api_key=x ff_sid=abc",
        );
        assert_eq!(
            l,
            "2026-10-22 01:02:03 WARN friendflix: GET https://friend.example.com/a ff_sid=***\n"
        );
        assert_eq!(
            line(now, log::Level::Info, "t", "a\nb\r\nc"),
            "2026-10-22 01:02:03 INFO t: a b  c\n"
        );
    }
}
