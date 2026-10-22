// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! Self-update (spec §5): the Tauri updater checks `latest.json` on GitHub Releases at start and every 24 h, and every
//! download is checked against the public key built into the app (a bad signature is refused and logged).
//! - "Automatic" installs a found update at the next app start (the check at start installs it at once).
//! - "Ask first" sends `ff-update-available {version}` to the main window; the init script's banner (local text, see
//!   `update_banner.js`) offers *Install and restart*. The click comes back through `bridge_message` with a token that only
//!   the init script knows, so the server page gains nothing it can call on its own.
//! - Nothing is installed while the player runs.
//!
//! A build whose `plugins.updater` still holds the placeholder key (or has no endpoint) has updates turned off: the
//! release workflow leaves the key out when the owner has not generated one yet (desktop-release.yml).
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::settings::UpdateMode;
use crate::shell::AppState;

/// `desktop/app/updater.pub` until the owner generates the update key (`tauri signer generate`).
pub const PLACEHOLDER: &str = "REPLACE_WITH_PUBLIC_KEY";
/// The event the banner listens for.
pub const EVENT: &str = "ff-update-available";
const BANNER: &str = include_str!("update_banner.js");
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// How often the 24 h rule is looked at (wall clock, so a sleeping PC checks soon after it wakes up).
const POLL: Duration = Duration::from_secs(15 * 60);

/// A check is due 24 h after the last one, or at once when the clock went back.
pub fn due(last_check_ms: u64, now_ms: u64) -> bool {
    now_ms < last_check_ms || now_ms - last_check_ms >= DAY_MS
}

/// Whether an update may be installed now: never while the player runs; with "Ask first" only after the viewer's click.
pub fn may_install(running: bool, mode: UpdateMode, user_ok: bool) -> bool {
    !running && (user_ok || mode == UpdateMode::Auto)
}

/// Updates are on when the build carries a real public key and at least one endpoint (`plugins.updater`).
pub fn enabled(config: Option<&Value>) -> bool {
    let Some(c) = config else {
        return false;
    };
    let key = c.get("pubkey").and_then(Value::as_str).map(str::trim);
    let endpoints = c.get("endpoints").and_then(Value::as_array);
    key.is_some_and(|k| !k.is_empty() && k != PLACEHOLDER)
        && endpoints.is_some_and(|e| !e.is_empty())
}

/// A version as `version.json` writes it (`X.Y.Z`); anything else is never announced.
pub fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| (1..=4).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

/// The banner's *Install and restart* click: `{"ffUpdate":"install","token":…,"version":…}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Click {
    pub token: String,
    pub version: String,
}

impl Click {
    pub fn parse(msg: &str) -> Option<Click> {
        let v: Value = serde_json::from_str(msg).ok()?;
        if v.get("ffUpdate")?.as_str()? != "install" {
            return None;
        }
        Some(Click {
            token: v.get("token")?.as_str()?.to_string(),
            version: v.get("version")?.as_str()?.to_string(),
        })
    }
}

/// What a click led to; the banner shows its own text for each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// the installer runs (on Windows the app has exited before this is ever seen)
    Installing,
    /// the player runs: close it first
    PlayerRuns,
    /// no such update is pending (or the token is wrong)
    NotPending,
    /// download, signature or installer start failed (logged)
    Failed,
}

impl Outcome {
    /// The reply the banner reads.
    pub fn reply(self) -> String {
        let what = match self {
            Outcome::Installing => "installing",
            Outcome::PlayerRuns => "player",
            Outcome::NotPending => "none",
            Outcome::Failed => "failed",
        };
        json!({ "ffUpdate": what }).to_string()
    }
}

/// The per-run secret the init script sends with a click (128 bit, hex).
pub fn token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        let mut b = [0u8; 16];
        getrandom::fill(&mut b).expect("system random source");
        b.iter().map(|x| format!("{x:02x}")).collect()
    })
}

/// The banner part of the init script, with this run's token.
pub fn banner_script() -> String {
    BANNER.replace("\"@TOKEN@\"", &Value::String(token().into()).to_string())
}

fn pending() -> MutexGuard<'static, Option<Update>> {
    static PENDING: Mutex<Option<Update>> = Mutex::new(None);
    PENDING.lock().unwrap_or_else(|p| p.into_inner())
}

static BUSY: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn mode(app: &AppHandle) -> UpdateMode {
    app.state::<AppState>().settings().updates
}

/// Starts the update checks (at start, then every 24 h) on their own thread; does nothing when updates are off.
pub fn schedule(app: &AppHandle) {
    if !enabled(app.config().plugins.0.get("updater")) {
        log::info!("updates are off in this build (no update key)");
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("ff-updater".into())
        .spawn(move || {
            let mut last: Option<u64> = None;
            loop {
                let now = now_ms();
                if last.is_none_or(|l| due(l, now)) {
                    let at_start = last.is_none();
                    last = Some(now);
                    tauri::async_runtime::block_on(check(&app, at_start));
                }
                std::thread::sleep(POLL);
            }
        });
    if let Err(e) = spawned {
        log::error!("update checks not started: {e}");
    }
}

async fn check(app: &AppHandle, at_start: bool) {
    let remember = app.clone();
    let updater = match app
        .updater_builder()
        .on_before_exit(move || crate::shell::remember_window(&remember))
        .build()
    {
        Ok(u) => u,
        Err(e) => {
            log::error!("updater not available: {e}");
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            log::info!("update {} available", update.version);
            if !valid_version(&update.version) {
                log::warn!("update ignored: unexpected version format");
                return;
            }
            *pending() = Some(update.clone());
            match mode(app) {
                UpdateMode::Auto if at_start => {
                    let outcome = install(update, UpdateMode::Auto, false).await;
                    log::info!("automatic update: {outcome:?}");
                }
                UpdateMode::Auto => log::info!("the update installs at the next start"),
                UpdateMode::Ask => announce(app),
            }
        }
        Ok(None) => *pending() = None,
        Err(e) => log::warn!("update check failed: {e}"),
    }
}

/// Shows the banner for a pending update ("Ask first" only). Also called when the main window finished loading a page,
/// so a navigation or a reload does not lose it.
pub fn announce(app: &AppHandle) {
    if mode(app) != UpdateMode::Ask {
        return;
    }
    let version = pending().as_ref().map(|u| u.version.clone());
    if let Some(version) = version {
        crate::bridge_cmd::send_event(app, EVENT, json!({ "version": version }));
    }
}

/// The banner's click (the bridge command checked the origin already).
pub async fn on_click(app: &AppHandle, click: Click) -> Outcome {
    if click.token != token() {
        log::warn!("update click refused: wrong token");
        return Outcome::NotPending;
    }
    let update = pending().clone();
    let Some(update) = update.filter(|u| u.version == click.version) else {
        return Outcome::NotPending;
    };
    install(update, mode(app), true).await
}

async fn install(update: Update, mode: UpdateMode, user_ok: bool) -> Outcome {
    if !may_install(crate::player::running(), mode, user_ok) {
        return Outcome::PlayerRuns;
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return Outcome::Installing;
    }
    let outcome = download_and_install(&update).await;
    BUSY.store(false, Ordering::SeqCst);
    outcome
}

async fn download_and_install(update: &Update) -> Outcome {
    // the signature is checked against the built-in key inside `download`
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(b) => b,
        Err(e) => {
            log::error!("update {} refused or not downloaded: {e}", update.version);
            return Outcome::Failed;
        }
    };
    // the download took a while: the player may have started meanwhile
    if crate::player::running() {
        return Outcome::PlayerRuns;
    }
    log::info!("installing update {}", update.version);
    match update.install(bytes) {
        Ok(()) => Outcome::Installing,
        Err(e) => {
            log::error!("update {} not installed: {e}", update.version);
            Outcome::Failed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_every_24_hours() {
        assert!(due(0, DAY_MS));
        assert!(!due(1_000, 1_000));
        assert!(!due(1_000, 1_000 + DAY_MS - 1));
        assert!(due(1_000, 1_000 + DAY_MS));
        assert!(due(1_000, 1_000 + 3 * DAY_MS));
        // the clock went back: check rather than wait for the old time to come round again
        assert!(due(5 * DAY_MS, DAY_MS));
    }

    #[test]
    fn never_installs_while_the_player_runs() {
        for mode in [UpdateMode::Auto, UpdateMode::Ask] {
            for ok in [false, true] {
                assert!(!may_install(true, mode, ok), "{mode:?} {ok}");
            }
        }
        assert!(may_install(false, UpdateMode::Auto, false));
        assert!(may_install(false, UpdateMode::Auto, true));
        assert!(!may_install(false, UpdateMode::Ask, false));
        assert!(may_install(false, UpdateMode::Ask, true));
    }

    #[test]
    fn updates_need_a_real_key_and_an_endpoint() {
        let url = "https://github.com/LetsManu/friendflix/releases/latest/download/latest.json";
        let on = json!({"endpoints": [url], "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk="});
        assert!(enabled(Some(&on)));
        assert!(!enabled(None));
        assert!(!enabled(Some(
            &json!({"endpoints": [url], "pubkey": PLACEHOLDER})
        )));
        assert!(!enabled(Some(
            &json!({"endpoints": [url], "pubkey": format!(" {PLACEHOLDER}\n")})
        )));
        assert!(!enabled(Some(&json!({"endpoints": [url], "pubkey": ""}))));
        assert!(!enabled(Some(&json!({"endpoints": [url]}))));
        assert!(!enabled(Some(
            &json!({"endpoints": [], "pubkey": "dW50cnVzdGVk"})
        )));
        assert!(!enabled(Some(&json!({"pubkey": "dW50cnVzdGVk"}))));
    }

    #[test]
    fn committed_config_points_at_github_and_is_off_until_the_key_exists() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let up = &conf["plugins"]["updater"];
        assert_eq!(
            up["endpoints"],
            json!(["https://github.com/LetsManu/friendflix/releases/latest/download/latest.json"])
        );
        assert_eq!(up["pubkey"], json!(PLACEHOLDER));
        assert!(!enabled(Some(up)));
        // the release workflow turns the artifacts on only with a key (unsigned builds must still bundle)
        assert_eq!(conf["bundle"]["createUpdaterArtifacts"], json!(false));
        let key = include_str!("../updater.pub").trim();
        assert_eq!(key, PLACEHOLDER, "with a real key, drop this line");
    }

    #[test]
    fn versions() {
        for ok in ["2.2.1", "10.0.12", "0.0.0"] {
            assert!(valid_version(ok), "{ok}");
        }
        for bad in [
            "",
            "2.2",
            "2.2.1-beta",
            "v2.2.1",
            "2.2.1 ",
            "2..1",
            "<b>1</b>",
            "1.2.3.4",
            "99999.1.1",
        ] {
            assert!(!valid_version(bad), "{bad}");
        }
    }

    #[test]
    fn click_messages() {
        let ok = r#"{"ffUpdate":"install","token":"abc","version":"2.3.0"}"#;
        assert_eq!(
            Click::parse(ok),
            Some(Click {
                token: "abc".into(),
                version: "2.3.0".into()
            })
        );
        for bad in [
            "",
            "x",
            "[]",
            r#"{"ffUpdate":"other","token":"abc","version":"2.3.0"}"#,
            r#"{"ffUpdate":"install","token":1,"version":"2.3.0"}"#,
            r#"{"ffUpdate":"install","version":"2.3.0"}"#,
            r#"{"ffUpdate":"install","token":"abc"}"#,
            r#"{"id":"1","method":"play","args":{}}"#,
        ] {
            assert_eq!(Click::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn replies_name_the_outcome() {
        let read = |o: Outcome| -> Value { serde_json::from_str(&o.reply()).unwrap() };
        assert_eq!(read(Outcome::Installing), json!({"ffUpdate": "installing"}));
        assert_eq!(read(Outcome::PlayerRuns), json!({"ffUpdate": "player"}));
        assert_eq!(read(Outcome::NotPending), json!({"ffUpdate": "none"}));
        assert_eq!(read(Outcome::Failed), json!({"ffUpdate": "failed"}));
    }

    #[test]
    fn token_is_random_128_bit_hex() {
        let t = token();
        assert_eq!(t.len(), 32);
        assert!(t.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(token(), t);
    }

    #[test]
    fn banner_carries_the_token_and_local_text() {
        let js = banner_script();
        assert!(js.contains(&format!("\"{}\"", token())), "token");
        assert!(!js.contains("@TOKEN@"));
        assert!(js.contains("Install and restart"));
        assert!(js.contains(EVENT));
        assert!(js.contains(r#"mode: "closed""#));
        assert!(js.contains("isTrusted"));
    }
}
