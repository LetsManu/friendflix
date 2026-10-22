// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! The remembered settings (spec §5) in `%APPDATA%\FriendFlix\settings.json`. A missing or unreadable file means the
//! defaults; unknown fields are ignored; an address that is not a valid origin is dropped.
use std::path::{Path, PathBuf};

use friendflix_core::origin::{parse_auth, Origin};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateMode {
    #[default]
    Auto,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub server: Option<String>,
    pub auth_origin: Option<String>,
    pub updates: UpdateMode,
    pub hwdec: bool,
    pub start_fullscreen: bool,
    pub autostart: bool,
    pub window: Option<WindowState>,
    pub last_profile: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            server: None,
            auth_origin: None,
            updates: UpdateMode::Auto,
            hwdec: true,
            start_fullscreen: true,
            autostart: false,
            window: None,
            last_profile: None,
        }
    }
}

/// The settings page's view: the server address (read-only there) and the four choices of spec §5.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSettings {
    #[serde(default)]
    pub server: Option<String>,
    pub updates: UpdateMode,
    pub hwdec: bool,
    pub start_fullscreen: bool,
    pub autostart: bool,
}

fn valid_profile(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

impl Settings {
    /// `%APPDATA%\FriendFlix\settings.json` (defaults when there is none or it cannot be read).
    pub fn load() -> Settings {
        path().map_or_else(Settings::default, |p| Settings::load_from(&p))
    }

    pub fn save(&self) {
        match path() {
            Some(p) => {
                if let Err(e) = self.save_to(&p) {
                    log::warn!("settings not saved: {e}");
                }
            }
            None => log::warn!("settings not saved: no settings folder"),
        }
    }

    pub fn load_from(path: &Path) -> Settings {
        let parsed = std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Settings>(&b).ok());
        parsed.map_or_else(Settings::default, Settings::sanitized)
    }

    /// Writes a temporary file next to the target and renames it over, so a crash never leaves half a file.
    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)
    }

    /// Addresses in their normalised web form; anything unusable is dropped.
    fn sanitized(mut self) -> Settings {
        self.server = self
            .server
            .as_deref()
            .and_then(Origin::parse)
            .map(|o| o.web());
        self.auth_origin = self
            .auth_origin
            .as_deref()
            .and_then(parse_auth)
            .map(|o| o.web());
        self.last_profile = self.last_profile.filter(|p| valid_profile(p));
        self
    }

    pub fn server_origin(&self) -> Option<Origin> {
        self.server.as_deref().and_then(Origin::parse)
    }

    pub fn auth(&self) -> Option<Origin> {
        self.auth_origin.as_deref().and_then(parse_auth)
    }

    pub fn ui(&self) -> UiSettings {
        UiSettings {
            server: self.server.clone(),
            updates: self.updates,
            hwdec: self.hwdec,
            start_fullscreen: self.start_fullscreen,
            autostart: self.autostart,
        }
    }

    /// Takes the four choices from the settings page; the address changes only through `probe_server`.
    pub fn apply(&mut self, ui: &UiSettings) {
        self.updates = ui.updates;
        self.hwdec = ui.hwdec;
        self.start_fullscreen = ui.start_fullscreen;
        self.autostart = ui.autostart;
    }

    pub fn set_last_profile(&mut self, id: &str) {
        if valid_profile(id) {
            self.last_profile = Some(id.to_string());
        }
    }
}

/// `%APPDATA%\FriendFlix\settings.json` on Windows; the XDG config folder elsewhere (development builds).
pub fn path() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    };
    base.filter(|b| b.is_absolute())
        .map(|b| b.join("FriendFlix").join("settings.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults() {
        let s = Settings::default();
        assert_eq!(s.server, None);
        assert_eq!(s.auth_origin, None);
        assert_eq!(s.updates, UpdateMode::Auto);
        assert!(s.hwdec);
        assert!(s.start_fullscreen);
        assert!(!s.autostart);
        assert_eq!(s.window, None);
        assert_eq!(s.last_profile, None);
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            Settings::load_from(&dir.path().join("missing.json")),
            Settings::default()
        );
        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, "{not json").unwrap();
        assert_eq!(Settings::load_from(&bad), Settings::default());
    }

    #[test]
    fn roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("FriendFlix").join("settings.json");
        let s = Settings {
            server: Some("https://friend.example.com".into()),
            auth_origin: Some("https://auth.example.com".into()),
            updates: UpdateMode::Ask,
            hwdec: false,
            start_fullscreen: false,
            autostart: true,
            window: Some(WindowState {
                x: -8,
                y: 20,
                width: 1280,
                height: 720,
                maximized: true,
            }),
            last_profile: Some("p-1".into()),
        };
        s.save_to(&p).unwrap();
        assert_eq!(Settings::load_from(&p), s);
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(
            text.contains("\"startFullscreen\": false") && text.contains("\"updates\": \"ask\""),
            "{text}"
        );
    }

    #[test]
    fn unknown_fields_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        std::fs::write(
            &p,
            r#"{"server":"http://192.0.2.5:8096","future":{"x":1},"hwdec":false}"#,
        )
        .unwrap();
        let s = Settings::load_from(&p);
        assert_eq!(s.server.as_deref(), Some("http://192.0.2.5:8096"));
        assert!(!s.hwdec);
        assert!(s.start_fullscreen, "missing fields keep their defaults");
    }

    #[test]
    fn invalid_addresses_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        std::fs::write(
            &p,
            r#"{"server":"ftp://friend.example.com","authOrigin":"http://auth.example.com","lastProfile":"a b"}"#,
        )
        .unwrap();
        let s = Settings::load_from(&p);
        assert_eq!(
            (s.server, s.auth_origin, s.last_profile),
            (None, None, None)
        );
        std::fs::write(&p, r#"{"server":"https://FRIEND.example.com:443/x","authOrigin":"https://auth.example.com"}"#).unwrap();
        let s = Settings::load_from(&p);
        assert_eq!(s.server.as_deref(), Some("https://friend.example.com"));
        assert_eq!(s.auth_origin.as_deref(), Some("https://auth.example.com"));
    }

    #[test]
    fn ui_view_and_apply() {
        let mut s = Settings {
            server: Some("https://friend.example.com".into()),
            ..Settings::default()
        };
        let mut ui = s.ui();
        assert_eq!(ui.server.as_deref(), Some("https://friend.example.com"));
        ui.server = Some("https://other.example.com".into());
        ui.updates = UpdateMode::Ask;
        ui.hwdec = false;
        ui.autostart = true;
        s.apply(&ui);
        assert_eq!(
            s.server.as_deref(),
            Some("https://friend.example.com"),
            "the address is not set here"
        );
        assert_eq!(
            (s.updates, s.hwdec, s.autostart, s.start_fullscreen),
            (UpdateMode::Ask, false, true, true)
        );
        s.set_last_profile("bad id");
        assert_eq!(s.last_profile, None);
        s.set_last_profile("p-1");
        assert_eq!(s.last_profile.as_deref(), Some("p-1"));
    }
}
