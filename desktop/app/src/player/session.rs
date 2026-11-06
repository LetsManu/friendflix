// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! Wiring only: the real mpv (`Ipc`), `ServerApi`, the monotonic clock and the shell as `Host` around
//! `friendflix_core::session::Session`, run on the player thread. What the shell does after a session (crash dialog with
//! "Play in the web player", error message, the web player for a 409) is decided by `After`.
use friendflix_core::origin::Origin;
use serde_json::Value;
use tauri::Url;

/// The shell's step once the player is gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum After {
    /// back to the main window
    Nothing,
    /// mpv went away: offer "Play in the web player" for this item
    Crashed(String),
    /// the start failed with this message
    Error(String),
    /// the web player takes over at this path (`/watch/<id>…`)
    OpenWeb(String),
}

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

impl After {
    /// The step for a session event (`ff-reload` needs none: the window reloads at once).
    pub fn of(event: &str, payload: &Value) -> Option<After> {
        let text = |k: &str| payload.get(k).and_then(Value::as_str);
        match event {
            "ff-player-crashed" => text("itemId")
                .filter(|id| valid_id(id))
                .map(|id| After::Crashed(id.to_string())),
            "ff-player-error" => text("message").map(|m| After::Error(m.to_string())),
            "ff-open-web" => text("path").map(|p| After::OpenWeb(p.to_string())),
            _ => None,
        }
    }

    /// The main window's URL for a `/watch/<id>…` path, only on the server origin.
    pub fn web_url(server: &Origin, path: &str) -> Option<Url> {
        let rest = path.strip_prefix("/watch/")?;
        let id = rest.split('?').next().unwrap_or_default();
        if !valid_id(id) {
            return None;
        }
        Url::parse(&server.resolve(path)?).ok()
    }
}

/// `de` from `de-AT` (the app language for the anime default); `en` when unknown.
pub fn lang_of(locale: &str) -> String {
    let lang = locale
        .split(['-', '_', '.'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if (2..=3).contains(&lang.len()) && lang.bytes().all(|b| b.is_ascii_lowercase()) {
        lang
    } else {
        "en".into()
    }
}

#[cfg(windows)]
pub use imp::{run, tell_async};

#[cfg(windows)]
mod imp {
    use std::process::Child;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use friendflix_core::api::ServerApi;
    use friendflix_core::bridge::PlayRequest;
    use friendflix_core::origin::Origin;
    use friendflix_core::session::{
        Host, MonotonicClock, MpvEvent, Outcome, Player, PlayerError, Session, SessionConfig,
    };
    use serde_json::Value;
    use tauri::{AppHandle, Manager};
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_YESNO,
    };

    use super::{lang_of, After};
    use crate::bridge_cmd;
    use crate::player::cookies;
    use crate::player::ipc::Ipc;
    use crate::player::mpv::{self, Paths};
    use crate::settings::Settings;
    use crate::shell;

    const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
    const EXIT_WAIT: Duration = Duration::from_secs(3);
    /// After the pipe closed, how long to wait for mpv's exit status.
    const EXIT_STATUS_WAIT: Duration = Duration::from_secs(2);
    const TITLE: &str = "FriendFlix";

    /// The pipe plus the mpv child, whose exit status tells a quit from a crash once the pipe closed.
    struct IpcPlayer {
        ipc: Arc<Ipc>,
        child: Arc<Mutex<Child>>,
    }

    impl Player for IpcPlayer {
        fn command(&self, v: Value) -> Result<Value, PlayerError> {
            self.ipc.command(v)
        }
        fn events(&self) -> std::sync::mpsc::Receiver<MpvEvent> {
            self.ipc.events()
        }
        fn exited_cleanly(&self) -> bool {
            let mut status = None;
            crate::player::wait_for(EXIT_STATUS_WAIT, || {
                status = self
                    .child
                    .lock()
                    .ok()
                    .and_then(|mut c| c.try_wait().ok().flatten());
                status.is_some()
            });
            status.is_some_and(|s| s.success())
        }
    }

    /// Events go to the page (`send_event`, origin-checked twice); the shell's own step is kept for after the session.
    struct AppHost {
        app: AppHandle,
        after: Mutex<After>,
    }

    impl Host for AppHost {
        fn emit(&self, event: &str, payload: Value) {
            bridge_cmd::send_event(&self.app, event, payload.clone());
            if event == "ff-reload" {
                if let Some(w) = shell::main_window(&self.app) {
                    let _ = w.reload();
                }
            }
            if let Some(a) = After::of(event, &payload) {
                if let Ok(mut g) = self.after.lock() {
                    *g = a;
                }
            }
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn ask(text: &str) -> bool {
        let (t, c) = (wide(text), wide(TITLE));
        // SAFETY: both strings are NUL-terminated UTF-16 buffers alive for the call.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                t.as_ptr(),
                c.as_ptr(),
                MB_YESNO | MB_ICONWARNING | MB_SETFOREGROUND,
            ) == IDYES
        }
    }

    fn tell(text: &str) {
        let (t, c) = (wide(text), wide(TITLE));
        // SAFETY: as above.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                t.as_ptr(),
                c.as_ptr(),
                MB_OK | MB_ICONWARNING | MB_SETFOREGROUND,
            )
        };
    }

    /// A message box on its own thread (callers may be on the main thread).
    pub fn tell_async(text: &'static str) {
        let _ = std::thread::Builder::new()
            .name("ff-message".into())
            .spawn(move || tell(text));
    }

    fn app_lang() -> String {
        let mut buf = [0u16; 85];
        // SAFETY: the buffer holds LOCALE_NAME_MAX_LENGTH (85) characters.
        let n = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
        let name = String::from_utf16_lossy(&buf[..(n.max(1) as usize - 1).min(buf.len())]);
        lang_of(&name)
    }

    /// The player thread: one session, then the shell's step. The running slot is cleared by the caller.
    pub fn run(app: &AppHandle, req: PlayRequest, server: Origin, s: Settings, paths: Paths) {
        let item = req.item_id.clone();
        let after = match play(app, req, &server, &s, &paths) {
            Ok(a) => a,
            Err(e) => {
                log::error!("player failed: {e}");
                After::Crashed(item)
            }
        };
        super::super::clear_running();
        apply(app, &server, after);
    }

    fn play(
        app: &AppHandle,
        req: PlayRequest,
        server: &Origin,
        s: &Settings,
        paths: &Paths,
    ) -> Result<After, String> {
        let window = shell::main_window(app).ok_or("no main window")?;
        let cookie = cookies::session_cookie(window.as_ref(), server).unwrap_or_default();
        let pipe = mpv::pipe_name().map_err(|e| format!("no pipe name: {e}"))?;
        let mut child =
            mpv::spawn(paths, &pipe, s).map_err(|e| format!("mpv did not start: {e}"))?;
        super::super::set_running(child.id(), None);
        let connected =
            tauri::async_runtime::block_on(Ipc::connect(&pipe, child.id(), CONNECT_TIMEOUT));
        let ipc = match connected {
            Ok(i) => Arc::new(i),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("no connection to mpv: {e}"));
            }
        };
        super::super::set_running(child.id(), Some(ipc.clone()));
        let temp = app
            .path()
            .temp_dir()
            .ok()
            .map(|t| {
                t.join(format!(
                    "friendflix-player-{}",
                    pipe.rsplit('-').next().unwrap_or("x")
                ))
            })
            .filter(|d| std::fs::create_dir_all(d).is_ok());
        let cfg = SessionConfig {
            origin: server.clone(),
            cookie: cookie.clone(),
            profile_id: req.profile_id.clone(),
            app_lang: app_lang(),
            temp_dir: temp.clone(),
        };
        let api = ServerApi::new(server.clone(), cookie, req.profile_id.clone());
        let host = AppHost {
            app: app.clone(),
            after: Mutex::new(After::Nothing),
        };
        let child = Arc::new(Mutex::new(child));
        let player = IpcPlayer {
            ipc,
            child: child.clone(),
        };
        let outcome = Session::new(cfg, req, player, api, &host, MonotonicClock::new()).run();
        log::info!("player ended: {}", outcome_name(&outcome));
        wait_or_kill(&child);
        if let Some(t) = temp {
            let _ = std::fs::remove_dir_all(t);
        }
        let after = host
            .after
            .lock()
            .map(|a| a.clone())
            .unwrap_or(After::Nothing);
        Ok(after)
    }

    fn outcome_name(o: &Outcome) -> &'static str {
        match o {
            Outcome::Closed => "closed",
            Outcome::Unauthorized => "signed out",
            Outcome::Crashed => "crashed",
            Outcome::Failed(_) => "start failed",
            Outcome::OpenInWeb(_) => "web player",
        }
    }

    fn wait_or_kill(child: &Mutex<Child>) {
        let Ok(mut child) = child.lock() else {
            return;
        };
        if !crate::player::wait_for(EXIT_WAIT, || matches!(child.try_wait(), Ok(Some(_)))) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn navigate(app: &AppHandle, server: &Origin, path: &str) {
        if let (Some(url), Some(w)) = (After::web_url(server, path), shell::main_window(app)) {
            let _ = w.navigate(url);
        }
    }

    fn apply(app: &AppHandle, server: &Origin, after: After) {
        match after {
            After::Nothing => {}
            After::Crashed(id) => {
                if ask("The player stopped unexpectedly.\n\nPlay this title in the web player instead?") {
                    navigate(app, server, &format!("/watch/{id}"));
                }
            }
            After::Error(message) => tell(&message),
            After::OpenWeb(path) => navigate(app, server, &path),
        }
        shell::focus_main(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn events_map_to_shell_steps() {
        assert_eq!(After::of("ff-reload", &json!({})), None);
        assert_eq!(After::of("ff-state", &json!({})), None);
        assert_eq!(
            After::of("ff-player-crashed", &json!({"itemId": "abc-1"})),
            Some(After::Crashed("abc-1".into()))
        );
        assert_eq!(
            After::of("ff-player-crashed", &json!({"itemId": "../x"})),
            None
        );
        assert_eq!(
            After::of(
                "ff-player-error",
                &json!({"itemId": "a", "message": "Can’t play this."})
            ),
            Some(After::Error("Can’t play this.".into()))
        );
        assert_eq!(
            After::of(
                "ff-open-web",
                &json!({"itemId": "a", "path": "/watch/a?t=61"})
            ),
            Some(After::OpenWeb("/watch/a?t=61".into()))
        );
    }

    #[test]
    fn web_url_stays_on_the_server_watch_page() {
        let s = Origin::parse("https://friend.example.com").unwrap();
        assert_eq!(
            After::web_url(&s, "/watch/abc-1?t=61").map(|u| u.to_string()),
            Some("https://friend.example.com/watch/abc-1?t=61".into())
        );
        for bad in [
            "//evil.example.net/watch/a",
            "https://evil.example.net/watch/a",
            "/settings",
            "/watch/",
            "/watch/a/../../admin",
            "/watch/a b",
        ] {
            assert_eq!(After::web_url(&s, bad), None, "{bad}");
        }
    }

    #[test]
    fn app_language_from_locale() {
        assert_eq!(lang_of("de-AT"), "de");
        assert_eq!(lang_of("en_US.UTF-8"), "en");
        assert_eq!(lang_of("FR"), "fr");
        assert_eq!(lang_of(""), "en");
        assert_eq!(lang_of("C"), "en");
        assert_eq!(lang_of("1234"), "en");
    }
}
