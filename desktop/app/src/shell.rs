// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! The main window around the server's web app, the bundled setup and settings pages, the origin lock (navigation,
//! new windows, the bridge's init script and runtime capability) and `friendflix://watch/<id>` links.
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use friendflix_core::bridge::PlayRequest;
use friendflix_core::logs::scrub;
use friendflix_core::origin::{classify, Nav, Origin};
use friendflix_core::probe::{self, ProbeError};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::utils::acl::capability::CapabilityFile;
use tauri::utils::acl::RemoteUrlPattern;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window,
};
use tauri_plugin_autostart::ManagerExt as _;

use crate::bridge_cmd;
use crate::settings::{self, Settings, UiSettings, WindowState};
use crate::tray;

/// The global the init script defines for unsolicited events (`bridge_cmd::send_event`).
pub const DELIVER: &str = "__FRIENDFLIX_DELIVER__";
const SETTINGS: &str = "settings";
const REMOTE_TEMPLATE: &str = include_str!("../capabilities/remote.json");

/// Shared app state: the settings (saved on every change) and the label of the current main window. The main window is
/// re-created when the server changes (its init script names the server origin), so each one gets a new label.
pub struct AppState {
    settings: Mutex<Settings>,
    /// where the settings are saved (None: nowhere, e.g. no %APPDATA%)
    path: Option<PathBuf>,
    main_label: Mutex<String>,
    created: AtomicU32,
}

impl AppState {
    pub fn new(settings: Settings) -> AppState {
        AppState::with_path(settings, settings::path())
    }

    pub fn with_path(settings: Settings, path: Option<PathBuf>) -> AppState {
        AppState {
            settings: Mutex::new(settings),
            path,
            main_label: Mutex::new(String::new()),
            created: AtomicU32::new(0),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|p| p.into_inner().clone())
    }

    /// The only way to change the settings: `change` runs and the result is saved while the lock is held, so concurrent
    /// changes (commands on the async pool, window events on the main thread) never lose each other or interleave writes.
    /// Returns the settings after the change.
    pub fn update(&self, change: impl FnOnce(&mut Settings)) -> Settings {
        let mut guard = self.settings.lock().unwrap_or_else(|p| p.into_inner());
        change(&mut guard);
        match &self.path {
            Some(p) => {
                if let Err(e) = guard.save_to(p) {
                    log::warn!("settings not saved: {e}");
                }
            }
            None => log::warn!("settings not saved: no settings folder"),
        }
        guard.clone()
    }

    pub fn main_label(&self) -> String {
        self.main_label
            .lock()
            .map(|l| l.clone())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavAction {
    Allow,
    OpenExternal,
    Cancel,
}

/// The app's own bundled pages (`tauri://localhost` on Linux, `http(s)://tauri.localhost` on Windows).
fn is_local(u: &Url) -> bool {
    match u.scheme() {
        "tauri" => u.host_str() == Some("localhost"),
        "http" | "https" => u.host_str() == Some("tauri.localhost") && u.port().is_none(),
        _ => false,
    }
}

fn outside(u: &Url) -> NavAction {
    if matches!(u.scheme(), "http" | "https") {
        NavAction::OpenExternal
    } else {
        NavAction::Cancel
    }
}

/// The main window: the server origin and the sign-in origin stay; other http(s) URLs open in the default browser;
/// everything else (blob:, data:, javascript:, file:, …) is cancelled. Without a server only the bundled pages load.
pub fn decide(server: Option<&Origin>, auth: Option<&Origin>, url: &str) -> NavAction {
    let Ok(u) = Url::parse(url) else {
        return NavAction::Cancel;
    };
    if u.as_str() == "about:blank" {
        return NavAction::Allow;
    }
    match server {
        None if is_local(&u) => NavAction::Allow,
        None => outside(&u),
        Some(s) => match classify(s, auth, url) {
            Nav::App | Nav::Auth => NavAction::Allow,
            Nav::External if is_local(&u) => NavAction::Cancel,
            Nav::External => outside(&u),
        },
    }
}

/// The settings window: only the bundled pages.
pub fn decide_local(url: &str) -> NavAction {
    match Url::parse(url) {
        Ok(u) if is_local(&u) || u.as_str() == "about:blank" => NavAction::Allow,
        Ok(u) => outside(&u),
        Err(_) => NavAction::Cancel,
    }
}

/// WebView2's own user agent (Edge's reduced form for the runtime's major version) plus ` FriendFlixDesktop/<version>`.
pub fn user_agent(webview: Option<&str>, app: &str) -> String {
    let major = webview
        .and_then(|v| v.split('.').next())
        .filter(|m| (1..=4).contains(&m.len()) && m.bytes().all(|b| b.is_ascii_digit()));
    let base = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)";
    match major {
        Some(m) => {
            format!("{base} Chrome/{m}.0.0.0 Safari/537.36 Edg/{m}.0.0.0 FriendFlixDesktop/{app}")
        }
        None => format!("{base} Safari/537.36 FriendFlixDesktop/{app}"),
    }
}

/// Defines `window.FriendFlixNative` (`postMessage` + `message` events) only when the page is on the server origin.
pub fn init_script(server: &Origin) -> String {
    let origin = Value::String(server.web()).to_string();
    let deliver = Value::String(DELIVER.into()).to_string();
    format!(
        r#"(function () {{
  "use strict";
  if (window.location.origin !== {origin} || window.FriendFlixNative) return;
  var target = new EventTarget();
  function deliver(data) {{
    if (typeof data === "string") target.dispatchEvent(new MessageEvent("message", {{ data: data }}));
  }}
  var port = {{
    postMessage: function (s) {{
      var t = window.__TAURI_INTERNALS__;
      if (!t || typeof t.invoke !== "function") return;
      t.invoke("bridge_message", {{ msg: String(s) }}).then(deliver, function () {{}});
    }},
    addEventListener: function (type, listener, options) {{ target.addEventListener(type, listener, options); }},
    removeEventListener: function (type, listener, options) {{ target.removeEventListener(type, listener, options); }}
  }};
  Object.defineProperty(window, "FriendFlixNative", {{ value: Object.freeze(port) }});
  Object.defineProperty(window, {deliver}, {{ value: deliver }});
}})();
"#
    )
}

/// `capabilities/remote.json` for one main window, scoped to the server origin (None when that does not make a valid
/// URL pattern, e.g. an IPv6 host; the bridge then stays off).
pub fn remote_capability(label: &str, server: &Origin) -> Option<String> {
    let mut v: Value = serde_json::from_str(REMOTE_TEMPLATE).ok()?;
    let o = v.as_object_mut()?;
    o.remove("$schema");
    o.insert("identifier".into(), json!(format!("remote-{label}")));
    o.insert("remote".into(), json!({ "urls": [server.web()] }));
    o.insert("windows".into(), json!([label]));
    let text = v.to_string();
    let CapabilityFile::Capability(c) = text.parse::<CapabilityFile>().ok()? else {
        return None;
    };
    let urls = c.remote?.urls;
    let patterns: Vec<RemoteUrlPattern> = urls.iter().filter_map(|u| u.parse().ok()).collect();
    let probe = Url::parse(&server.web()).ok()?;
    (patterns.len() == 1 && patterns[0].test(&probe)).then_some(text)
}

/// The item id of `friendflix://watch/<id>` (the web app's id form), else None.
pub fn watch_id(url: &str) -> Option<String> {
    const PREFIX: &str = "friendflix://watch/";
    if !url.get(..PREFIX.len())?.eq_ignore_ascii_case(PREFIX) {
        return None;
    }
    let rest = &url[PREFIX.len()..];
    let id = rest.strip_suffix('/').unwrap_or(rest);
    ((1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        .then(|| id.to_string())
}

/// A remembered window is put back only when at least 100 px of its title bar is on a monitor.
pub fn on_screen(w: &WindowState, monitors: &[(i32, i32, u32, u32)]) -> bool {
    if w.width == 0 || w.height == 0 {
        return false;
    }
    let (x, y, width) = (i64::from(w.x), i64::from(w.y), i64::from(w.width));
    monitors.iter().any(|&(mx, my, mw, mh)| {
        let (mx, my, mw, mh) = (i64::from(mx), i64::from(my), i64::from(mw), i64::from(mh));
        let overlap = (x + width).min(mx + mw) - x.max(mx);
        overlap >= 100 && y >= my - 16 && y <= my + mh - 40
    })
}

fn open_external(url: &str) {
    if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
        log::warn!("could not open {} in the browser: {e}", scrub(url));
    }
}

fn on_main_navigation(app: &AppHandle, url: &Url) -> bool {
    let s = app.state::<AppState>().settings();
    match decide(s.server_origin().as_ref(), s.auth().as_ref(), url.as_str()) {
        NavAction::Allow => true,
        NavAction::OpenExternal => {
            open_external(url.as_str());
            false
        }
        NavAction::Cancel => {
            log::info!("navigation cancelled: {}", url.scheme());
            false
        }
    }
}

/// `window.open` / `target=_blank`: the app's own pages load in the main window, the rest opens in the browser.
fn on_main_new_window(app: &AppHandle, url: &Url) {
    let s = app.state::<AppState>().settings();
    match decide(s.server_origin().as_ref(), s.auth().as_ref(), url.as_str()) {
        NavAction::Allow if url.as_str() != "about:blank" => {
            if let Some(w) = main_window(app) {
                let _ = w.navigate(url.clone());
            }
        }
        NavAction::OpenExternal => open_external(url.as_str()),
        _ => {}
    }
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(&app.state::<AppState>().main_label())
}

pub fn is_main(window: &Window) -> bool {
    window.label() == window.app_handle().state::<AppState>().main_label()
}

/// Remembers the main window's size, position and maximised state (a maximised window keeps its last normal bounds).
pub fn remember_window(app: &AppHandle) {
    let Some(w) = main_window(app) else { return };
    let maximized = w.is_maximized().unwrap_or(false);
    let minimized = w.is_minimized().unwrap_or(false);
    let (pos, size) = (w.outer_position(), w.inner_size());
    app.state::<AppState>().update(|s| {
        let ws = match (maximized, s.window, pos, size) {
            (true, Some(old), _, _) => WindowState {
                maximized: true,
                ..old
            },
            (_, _, Ok(p), Ok(sz)) if !minimized => WindowState {
                x: p.x,
                y: p.y,
                width: sz.width,
                height: sz.height,
                maximized,
            },
            _ => return,
        };
        s.window = Some(ws);
    });
}

fn restore(w: &WebviewWindow, ws: Option<WindowState>) {
    let Some(ws) = ws else {
        let _ = w.center();
        return;
    };
    let monitors: Vec<(i32, i32, u32, u32)> = w
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            (
                m.position().x,
                m.position().y,
                m.size().width,
                m.size().height,
            )
        })
        .collect();
    if on_screen(&ws, &monitors) {
        let _ = w.set_size(PhysicalSize::new(ws.width.max(640), ws.height.max(400)));
        let _ = w.set_position(PhysicalPosition::new(ws.x, ws.y));
    } else {
        let _ = w.center();
    }
    if ws.maximized {
        let _ = w.maximize();
    }
}

/// Opens the main window on the server origin, or on the bundled setup page without one. An existing main window is
/// replaced (its geometry is kept).
pub fn open_main(app: &AppHandle, s: &Settings) {
    open_main_at(app, s, None);
}

/// First start: a `friendflix://watch/<id>` argument plays the title or opens the window right on `/watch/<id>` (a
/// navigation just after creating the window would race its first load).
pub fn start(app: &AppHandle, s: &Settings, args: &[String]) {
    let target = args
        .iter()
        .rev()
        .find_map(|a| watch_id(a))
        .and_then(|id| watch_target(app, &id));
    open_main_at(app, s, target);
}

fn open_main_at(app: &AppHandle, s: &Settings, start: Option<Url>) {
    let state = app.state::<AppState>();
    let old = main_window(app);
    if old.is_some() {
        remember_window(app);
    }
    let geometry = state.settings().window.or(s.window);
    let n = state.created.fetch_add(1, Ordering::SeqCst);
    let label = if n == 0 {
        "main".to_string()
    } else {
        format!("main-{n}")
    };
    let server = s.server_origin();
    let first = server.as_ref().and_then(|o| match start {
        Some(u) if o.matches(u.as_str()) => Some(u),
        _ => Url::parse(&o.web()).ok(),
    });
    let url = match first {
        Some(u) => WebviewUrl::External(u),
        None => WebviewUrl::App("setup.html".into()),
    };
    if let Some(o) = &server {
        match remote_capability(&label, o) {
            Some(cap) => {
                if let Err(e) = app.add_capability(cap) {
                    log::error!("bridge capability not added: {e}");
                }
            }
            None => {
                log::error!("the server address gives no capability pattern; the bridge stays off")
            }
        }
    }
    let version = app.package_info().version.to_string();
    // the runtime version is WebView2's on Windows (other platforms are development builds only)
    let runtime = if cfg!(windows) {
        tauri::webview_version().ok()
    } else {
        None
    };
    let ua = user_agent(runtime.as_deref(), &version);
    let (nav, popup) = (app.clone(), app.clone());
    let mut builder = WebviewWindowBuilder::new(app, &label, url)
        .title("FriendFlix")
        .inner_size(1280.0, 800.0)
        .min_inner_size(640.0, 400.0)
        .visible(false)
        .user_agent(&ua)
        .on_navigation(move |u| on_main_navigation(&nav, u))
        .on_new_window(move |u, _| {
            on_main_new_window(&popup, &u);
            NewWindowResponse::Deny
        });
    if let Some(o) = &server {
        builder = builder.initialization_script(init_script(o));
    }
    match builder.build() {
        Ok(w) => {
            if let Ok(mut l) = state.main_label.lock() {
                *l = label;
            }
            restore(&w, geometry);
            let _ = w.show();
            let _ = w.set_focus();
            if let Some(old) = old {
                let _ = old.destroy();
            }
        }
        // the old window (and its label) stays the main window
        Err(e) => log::error!("main window not created: {e}"),
    }
}

/// Shows and focuses the main window (tray, second start, deep link).
pub fn focus_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Opens (or focuses) the bundled settings page.
pub fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SETTINGS) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App("settings.html".into()))
        .title("FriendFlix settings")
        .inner_size(520.0, 620.0)
        .min_inner_size(420.0, 480.0)
        .on_navigation(|u| match decide_local(u.as_str()) {
            NavAction::Allow => true,
            NavAction::OpenExternal => {
                open_external(u.as_str());
                false
            }
            NavAction::Cancel => false,
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build();
    if let Err(e) = built {
        log::error!("settings window not created: {e}");
    }
}

/// `friendflix://watch/<id>` arguments forwarded by a second start.
pub fn handle_args(app: &AppHandle, args: &[String]) {
    for id in args.iter().filter_map(|a| watch_id(a)) {
        if let (Some(url), Some(w)) = (watch_target(app, &id), main_window(app)) {
            let _ = w.navigate(url);
        }
    }
}

/// Plays the title for the last active profile; without one (or when the player declines) the URL of `/watch/<id>`
/// for the window. None when there is no server or the player took it.
fn watch_target(app: &AppHandle, id: &str) -> Option<Url> {
    let s = app.state::<AppState>().settings();
    let server = s.server_origin()?;
    if let Some(profile) = s.last_profile.clone() {
        let req = PlayRequest {
            item_id: id.to_string(),
            profile_id: profile,
            start_ms: None,
            media_source_id: None,
            audio: None,
            subtitle: None,
        };
        if bridge_cmd::play(app, req) {
            return None;
        }
    }
    Url::parse(&format!("{}/watch/{id}", server.web())).ok()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOk {
    pub server: String,
    pub version: String,
}

fn probe_message(e: ProbeError) -> &'static str {
    match e {
        ProbeError::NotFriendFlix => "No FriendFlix server answered at this address.",
        ProbeError::ServerTooOld => {
            "This FriendFlix server is too old for the app. Ask its owner to update it."
        }
        ProbeError::TlsProblem => "The server's certificate could not be verified.",
        ProbeError::Unreachable => {
            "The server could not be reached. Check the address and your connection."
        }
    }
}

/// Setup and settings: checks the address with `GET /api/version` (no cookies) and, when it is a FriendFlix server,
/// stores it with its sign-in origin and opens it in the main window.
#[tauri::command]
pub async fn probe_server(app: AppHandle, address: String) -> Result<ProbeOk, String> {
    let invalid = || "That is not a valid server address.".to_string();
    if address.len() > 2048 {
        return Err(invalid());
    }
    let origin = Origin::parse(&address).ok_or_else(invalid)?;
    let target = origin.clone();
    let answer = tauri::async_runtime::spawn_blocking(move || probe::probe(&target))
        .await
        .map_err(|_| probe_message(ProbeError::Unreachable).to_string())?;
    let ok = answer.map_err(|e| probe_message(e).to_string())?;
    let (server, auth) = (Some(origin.web()), ok.auth_origin.map(|a| a.web()));
    let mut changed = false;
    let s = app.state::<AppState>().update(|s| {
        changed = s.server != server || s.auth_origin != auth;
        if s.server != server {
            s.last_profile = None;
        }
        s.server = server;
        s.auth_origin = auth;
    });
    log::info!("server set to {} (version {})", origin.web(), ok.version);
    tray::set_server(&app, s.server.as_deref());
    if changed || main_window(&app).is_none_or(|w| w.url().is_ok_and(|u| is_local(&u))) {
        open_main(&app, &s);
    }
    Ok(ProbeOk {
        server: origin.web(),
        version: ok.version,
    })
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> UiSettings {
    state.settings().ui()
}

/// Saves the settings page's choices; "start with Windows" is applied right away.
#[tauri::command]
pub async fn set_settings(app: AppHandle, settings: UiSettings) -> Result<UiSettings, String> {
    let state = app.state::<AppState>();
    if settings.autostart != state.settings().autostart {
        let launcher = app.autolaunch();
        let done = if settings.autostart {
            launcher.enable()
        } else {
            launcher.disable()
        };
        if let Err(e) = done {
            log::warn!("autostart not changed: {e}");
            return Err("Start with Windows could not be changed.".into());
        }
    }
    Ok(state.update(|s| s.apply(&settings)).ui())
}

#[cfg(test)]
mod tests {
    use super::*;
    use friendflix_core::origin::parse_auth;
    use tauri::utils::acl::capability::CapabilityFile;
    use tauri::utils::acl::RemoteUrlPattern;

    fn server() -> Origin {
        Origin::parse("https://friend.example.com").unwrap()
    }

    #[test]
    fn concurrent_updates_all_land() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("FriendFlix").join("settings.json");
        let state = Arc::new(AppState::with_path(Settings::default(), Some(p.clone())));
        let stop = Arc::new(AtomicBool::new(false));
        let reader = {
            let (p, stop) = (p.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut reads = 0;
                while !stop.load(Ordering::SeqCst) {
                    if let Ok(b) = std::fs::read(&p) {
                        serde_json::from_slice::<Settings>(&b)
                            .expect("settings.json always parses");
                        reads += 1;
                    }
                }
                reads
            })
        };
        let writers: Vec<_> = (0..8)
            .map(|_| {
                let state = state.clone();
                std::thread::spawn(move || {
                    for _ in 0..50 {
                        state.update(|s| {
                            let w = s.window.get_or_insert(WindowState {
                                x: 0,
                                y: 0,
                                width: 800,
                                height: 600,
                                maximized: false,
                            });
                            w.x += 1;
                        });
                    }
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        stop.store(true, Ordering::SeqCst);
        assert!(reader.join().unwrap() > 0);
        assert_eq!(state.settings().window.unwrap().x, 400);
        assert_eq!(Settings::load_from(&p).window.unwrap().x, 400);
    }

    #[test]
    fn navigation_decisions() {
        let s = server();
        let a = parse_auth("https://auth.example.com").unwrap();
        let d = |url: &str| decide(Some(&s), Some(&a), url);
        assert_eq!(d("https://friend.example.com/home"), NavAction::Allow);
        assert_eq!(
            d("https://auth.example.com/authorize?x=1"),
            NavAction::Allow
        );
        assert_eq!(d("https://other.example.com/"), NavAction::OpenExternal);
        assert_eq!(d("http://friend.example.com/"), NavAction::OpenExternal);
        assert_eq!(
            d("https://friend.example.com:8443/"),
            NavAction::OpenExternal
        );
        assert_eq!(d("about:blank"), NavAction::Allow);
        for never in [
            "blob:https://friend.example.com/1",
            "data:text/html,x",
            "javascript:alert(1)",
            "file:///C:/x",
            "mailto:a@example.com",
            "garbage",
        ] {
            assert_eq!(d(never), NavAction::Cancel, "{never}");
        }
        // with a server the bundled pages are not shown in the main window
        assert_eq!(d("http://tauri.localhost/setup.html"), NavAction::Cancel);
        assert_eq!(
            decide(Some(&s), None, "https://auth.example.com/"),
            NavAction::OpenExternal
        );
        // without a server only the bundled pages load
        assert_eq!(
            decide(None, None, "http://tauri.localhost/setup.html"),
            NavAction::Allow
        );
        assert_eq!(
            decide(None, None, "tauri://localhost/setup.html"),
            NavAction::Allow
        );
        assert_eq!(
            decide(None, None, "https://friend.example.com/"),
            NavAction::OpenExternal
        );
        assert_eq!(decide(None, None, "data:text/html,x"), NavAction::Cancel);
        assert_eq!(
            decide(None, None, "http://tauri.localhost.evil.example/"),
            NavAction::OpenExternal
        );
        assert_eq!(
            decide_local("http://tauri.localhost/settings.html"),
            NavAction::Allow
        );
        assert_eq!(
            decide_local("https://friend.example.com/"),
            NavAction::OpenExternal
        );
        assert_eq!(decide_local("blob:x"), NavAction::Cancel);
    }

    #[test]
    fn user_agent_marker() {
        let ua = user_agent(Some("130.0.2849.68"), "2.2.1");
        assert_eq!(
            ua,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0 FriendFlixDesktop/2.2.1"
        );
        assert!(user_agent(None, "2.2.1").ends_with(" FriendFlixDesktop/2.2.1"));
        assert!(!user_agent(Some("x.y"), "2.2.1").contains("Chrome/x"));
    }

    #[test]
    fn init_script_is_origin_locked() {
        let js = init_script(&server());
        assert!(
            js.contains(r#"location.origin !== "https://friend.example.com""#),
            "{js}"
        );
        assert!(js.contains("bridge_message") && js.contains("FriendFlixNative"));
        assert!(!js.contains(":443"));
        let lan = init_script(&Origin::parse("http://192.0.2.5:8096").unwrap());
        assert!(lan.contains(r#""http://192.0.2.5:8096""#));
    }

    #[test]
    fn remote_capability_scoped_to_server() {
        let json =
            remote_capability("main-2", &Origin::parse("http://192.0.2.5:8096").unwrap()).unwrap();
        let CapabilityFile::Capability(c) = json.parse::<CapabilityFile>().unwrap() else {
            panic!()
        };
        assert_eq!(c.identifier, "remote-main-2");
        assert_eq!(c.windows, vec!["main-2".to_string()]);
        assert!(!c.local);
        let perms: Vec<String> = c
            .permissions
            .iter()
            .map(|p| p.identifier().get().to_string())
            .collect();
        assert_eq!(perms, vec!["allow-bridge-message"]);
        let urls: Vec<RemoteUrlPattern> = c
            .remote
            .unwrap()
            .urls
            .iter()
            .map(|u| u.parse().unwrap())
            .collect();
        assert_eq!(urls.len(), 1);
        let ok = |u: &str| urls[0].test(&u.parse().unwrap());
        assert!(ok("http://192.0.2.5:8096/"));
        assert!(ok("http://192.0.2.5:8096/title/x?y=1"));
        assert!(!ok("http://192.0.2.5:8097/"));
        assert!(!ok("http://192.0.2.5/"));
        assert!(!ok("https://192.0.2.5:8096/"));
        let json = remote_capability("main", &server()).unwrap();
        let CapabilityFile::Capability(c) = json.parse::<CapabilityFile>().unwrap() else {
            panic!()
        };
        let urls: Vec<RemoteUrlPattern> = c
            .remote
            .unwrap()
            .urls
            .iter()
            .map(|u| u.parse().unwrap())
            .collect();
        assert!(urls[0].test(&"https://friend.example.com/x".parse().unwrap()));
        assert!(!urls[0].test(&"https://friend.example.com.evil.example/".parse().unwrap()));
        assert!(!urls[0].test(&"https://friend.example.com:8443/".parse().unwrap()));
        // an IPv6 host either makes a pattern for exactly that origin or none (never a panic, never a wider one)
        if let Some(json) = remote_capability("main", &Origin::parse("http://[::1]:8096").unwrap())
        {
            let CapabilityFile::Capability(c) = json.parse::<CapabilityFile>().unwrap() else {
                panic!()
            };
            let p: RemoteUrlPattern = c.remote.unwrap().urls[0].parse().unwrap();
            assert!(p.test(&"http://[::1]:8096/x".parse().unwrap()));
            assert!(!p.test(&"http://[::2]:8096/x".parse().unwrap()));
            assert!(!p.test(&"http://friend.example.com:8096/x".parse().unwrap()));
        }
    }

    #[test]
    fn deep_link_watch() {
        assert_eq!(
            watch_id("friendflix://watch/abc-123").as_deref(),
            Some("abc-123")
        );
        assert_eq!(
            watch_id("friendflix://watch/abc-123/").as_deref(),
            Some("abc-123")
        );
        assert_eq!(watch_id("FRIENDFLIX://watch/abc").as_deref(), Some("abc"));
        for bad in [
            "friendflix://watch/",
            "friendflix://watch/a_b",
            "friendflix://watch/a/b",
            "friendflix://watch/a?x=1",
            "friendflix://title/abc",
            "https://friend.example.com/watch/abc",
            "friendflix://watch/../x",
            "C:\\Program Files\\FriendFlix\\friendflix.exe",
        ] {
            assert_eq!(watch_id(bad), None, "{bad}");
        }
        assert_eq!(
            watch_id(&format!("friendflix://watch/{}", "a".repeat(65))),
            None
        );
    }

    #[test]
    fn window_on_screen() {
        let mons = [(0, 0, 1920, 1080), (1920, 0, 2560, 1440)];
        let w = |x, y| WindowState {
            x,
            y,
            width: 1280,
            height: 720,
            maximized: false,
        };
        assert!(on_screen(&w(100, 100), &mons));
        assert!(on_screen(&w(2000, 50), &mons));
        assert!(on_screen(&w(-8, -8), &mons));
        assert!(!on_screen(&w(5000, 100), &mons));
        assert!(!on_screen(&w(100, 1075), &mons));
        assert!(!on_screen(&w(-1270, 100), &mons));
        assert!(!on_screen(
            &WindowState {
                width: 0,
                ..w(0, 0)
            },
            &mons
        ));
        assert!(!on_screen(&w(100, 100), &[]));
    }
}
