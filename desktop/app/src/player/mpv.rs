// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! The bundled mpv process: where it lives, its exact command line (spec §6, global constraints) and the random pipe.
//! The command line never carries the cookie or a URL; both go over the pipe.
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use crate::settings::Settings;

/// The bundled files: `<app>\mpv\mpv.exe`, `<app>\mpv` as mpv's config dir and `<app>\friendflix.lua` (with
/// `layout.lua` next to it).
#[derive(Debug, Clone)]
pub struct Paths {
    pub mpv: PathBuf,
    pub config_dir: PathBuf,
    pub script: PathBuf,
}

impl Paths {
    pub fn under(app_dir: &Path) -> Paths {
        let config_dir = app_dir.join("mpv");
        Paths {
            mpv: config_dir.join(if cfg!(windows) { "mpv.exe" } else { "mpv" }),
            config_dir,
            script: app_dir.join("friendflix.lua"),
        }
    }

    /// The paths under the app's resource folder; an error when mpv or the skin is missing (development builds
    /// without the downloaded mpv).
    pub fn resolve(resource_dir: &Path) -> Result<Paths, String> {
        let p = Paths::under(resource_dir);
        if !p.mpv.is_file() {
            return Err(format!("mpv is missing ({})", p.mpv.display()));
        }
        if !p.script.is_file() {
            return Err(format!(
                "the player skin is missing ({})",
                p.script.display()
            ));
        }
        Ok(p)
    }
}

/// `\\.\pipe\friendflix-<32 hex>` from 128 random bits.
pub fn pipe_name() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(r"\\.\pipe\friendflix-{hex}"))
}

/// The exact mpv flags: the spec §6 list, `--osc=no`, hardware decoding and fullscreen from the settings,
/// `--force-window=immediate`, and `--idle=yes` so the window stays between episodes and before the first `loadfile`.
pub fn args(paths: &Paths, pipe: &str, s: &Settings) -> Vec<String> {
    let on = |b: bool, yes: &str, no: &str| if b { yes } else { no }.to_string();
    vec![
        "--no-config".into(),
        format!("--config-dir={}", paths.config_dir.display()),
        "--load-scripts=no".into(),
        format!("--script={}", paths.script.display()),
        "--ytdl=no".into(),
        format!("--input-ipc-server={pipe}"),
        "--demuxer-lavf-o=protocol_whitelist=[http,https,tls,tcp,crypto,file]".into(),
        "--media-controls=yes".into(),
        "--osc=no".into(),
        on(s.hwdec, "--hwdec=auto-safe", "--hwdec=no"),
        on(s.start_fullscreen, "--fullscreen=yes", "--fullscreen=no"),
        "--force-window=immediate".into(),
        "--idle=yes".into(),
    ]
}

pub fn spawn(paths: &Paths, pipe: &str, s: &Settings) -> io::Result<Child> {
    let mut cmd = Command::new(&paths.mpv);
    cmd.args(args(paths, pipe, s))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = paths.mpv.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn()
}

/// Brings the visible window of the process `pid` (the running mpv) to the front.
#[cfg(windows)]
pub fn focus(pid: u32) {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow,
        ShowWindow, SW_RESTORE,
    };

    struct Find {
        pid: u32,
        hwnd: HWND,
    }

    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: lparam is the `Find` passed to EnumWindows below, alive for the whole call.
        let find = unsafe { &mut *(lparam as *mut Find) };
        let mut owner = 0u32;
        // SAFETY: hwnd comes from EnumWindows; owner is a valid out pointer.
        unsafe { GetWindowThreadProcessId(hwnd, &mut owner) };
        // SAFETY: hwnd comes from EnumWindows.
        if owner == find.pid && unsafe { IsWindowVisible(hwnd) } != 0 {
            find.hwnd = hwnd;
            return 0;
        }
        1
    }

    let mut find = Find {
        pid,
        hwnd: std::ptr::null_mut(),
    };
    // SAFETY: the callback only touches `find`, which outlives the call.
    unsafe { EnumWindows(Some(each), &mut find as *mut Find as LPARAM) };
    if !find.hwnd.is_null() {
        // SAFETY: a window handle found above; failures are harmless.
        unsafe {
            if IsIconic(find.hwnd) != 0 {
                ShowWindow(find.hwnd, SW_RESTORE);
            }
            SetForegroundWindow(find.hwnd);
        }
    }
}

#[cfg(not(windows))]
pub fn focus(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_flags() {
        let app = if cfg!(windows) {
            PathBuf::from(r"C:\Program Files\FriendFlix")
        } else {
            PathBuf::from("/opt/friendflix")
        };
        let p = Paths::under(&app);
        let pipe = r"\\.\pipe\friendflix-0123456789abcdef0123456789abcdef";
        let s = Settings::default();
        let cfg = format!("--config-dir={}", app.join("mpv").display());
        let script = format!("--script={}", app.join("friendflix.lua").display());
        assert_eq!(
            args(&p, pipe, &s),
            vec![
                "--no-config",
                cfg.as_str(),
                "--load-scripts=no",
                script.as_str(),
                "--ytdl=no",
                r"--input-ipc-server=\\.\pipe\friendflix-0123456789abcdef0123456789abcdef",
                "--demuxer-lavf-o=protocol_whitelist=[http,https,tls,tcp,crypto,file]",
                "--media-controls=yes",
                "--osc=no",
                "--hwdec=auto-safe",
                "--fullscreen=yes",
                "--force-window=immediate",
                "--idle=yes",
            ]
        );
        let off = Settings {
            hwdec: false,
            start_fullscreen: false,
            ..Settings::default()
        };
        let a = args(&p, pipe, &off);
        assert!(a.contains(&"--hwdec=no".to_string()));
        assert!(a.contains(&"--fullscreen=no".to_string()));
        assert!(a
            .iter()
            .all(|x| !x.contains("http://") && !x.contains("https://")));
    }

    #[test]
    fn pipe_names_are_random_128_bit() {
        let a = pipe_name().unwrap();
        let b = pipe_name().unwrap();
        assert_ne!(a, b);
        let hex = a.strip_prefix(r"\\.\pipe\friendflix-").expect(&a);
        assert_eq!(hex.len(), 32);
        assert!(hex
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
    }

    #[test]
    fn missing_mpv_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Paths::resolve(dir.path())
            .unwrap_err()
            .contains("mpv is missing"));
        std::fs::create_dir_all(dir.path().join("mpv")).unwrap();
        let p = Paths::under(dir.path());
        std::fs::write(&p.mpv, b"").unwrap();
        assert!(Paths::resolve(dir.path()).unwrap_err().contains("skin"));
        std::fs::write(&p.script, b"").unwrap();
        assert!(Paths::resolve(dir.path()).is_ok());
    }
}
