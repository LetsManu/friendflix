// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! The native bridge command. Only the server origin's page may call it: the runtime capability (`remote.json`, scoped to
//! the server origin) admits the call, and the command checks the calling webview's URL again (`allowed`).
//! Replies are the command's return value (the init script dispatches them as `message` events); unsolicited events go to
//! the page through `send_event`.
use friendflix_core::bridge::{self, capabilities, reply, PlayRequest, Request};
use friendflix_core::logs::scrub;
use friendflix_core::origin::Origin;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Webview};

use crate::shell::{self, AppState};

/// The bridge exists only on exactly the server origin (scheme, host, port; no user info).
pub fn allowed(webview_url: &str, server: &Origin) -> bool {
    server.matches(webview_url)
}

/// The protocol answer for one request; `play` and `settings` are the side effects.
pub fn answer(
    id: &str,
    req: Request,
    play: impl FnOnce(PlayRequest) -> bool,
    settings: impl FnOnce(),
) -> String {
    match req {
        Request::Capabilities => reply(id, true, Some(capabilities())),
        Request::Play(p) => reply(id, true, Some(json!(play(p)))),
        Request::OpenSettings => {
            settings();
            reply(id, true, None)
        }
        Request::Unsupported => reply(id, false, None),
    }
}

/// Hands a play request to the player. Task 8 replaces this with `player::start`; until then the web player plays.
pub fn play(_app: &AppHandle, _req: PlayRequest) -> bool {
    false
}

#[tauri::command]
pub async fn bridge_message(
    app: AppHandle,
    webview: Webview,
    msg: String,
) -> Result<String, String> {
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    let server = app.state::<AppState>().settings().server_origin();
    if !server.is_some_and(|s| allowed(&url, &s)) {
        log::warn!("bridge call refused from {}", scrub(&url));
        return Err("refused".into());
    }
    let Some((id, req)) = bridge::parse(&msg) else {
        return Err("invalid".into());
    };
    if let Request::Play(p) = &req {
        let state = app.state::<AppState>();
        let mut s = state.settings();
        s.set_last_profile(&p.profile_id);
        state.store(s);
    }
    Ok(answer(
        &id,
        req,
        |p| play(&app, p),
        || shell::open_settings(&app),
    ))
}

/// Sends an unsolicited `{event, detail}` message to the main window's page, only while it shows the server origin.
#[allow(dead_code)] // used by the player (Task 8)
pub fn send_event(app: &AppHandle, event: &str, detail: Value) {
    let Some(window) = shell::main_window(app) else {
        return;
    };
    let Some(server) = app.state::<AppState>().settings().server_origin() else {
        return;
    };
    let url = window.url().map(|u| u.to_string()).unwrap_or_default();
    if !allowed(&url, &server) {
        return;
    }
    let msg = json!({"event": event, "detail": detail}).to_string();
    let arg = serde_json::to_string(&msg).unwrap_or_default();
    let _ = window.eval(format!("window.{0} && window.{0}({arg})", shell::DELIVER));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn origin_gate() {
        let s = Origin::parse("https://friend.example.com").unwrap();
        assert!(allowed("https://friend.example.com/", &s));
        assert!(allowed("https://friend.example.com/title/abc?x=1#y", &s));
        assert!(allowed("https://friend.example.com:443/", &s));
        for bad in [
            "https://auth.example.com/login",
            "https://friend.example.com.evil.example/",
            "https://friend.example.com:8443/",
            "http://friend.example.com/",
            "https://u:p@friend.example.com/",
            "http://tauri.localhost/setup.html",
            "tauri://localhost/settings.html",
            "about:blank",
            "data:text/html,x",
            "",
        ] {
            assert!(!allowed(bad, &s), "{bad}");
        }
        let lan = Origin::parse("http://192.0.2.5:8096").unwrap();
        assert!(allowed("http://192.0.2.5:8096/x", &lan));
        assert!(!allowed("http://192.0.2.5/x", &lan));
    }

    fn json_of(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn answers_each_method() {
        let none = |_: PlayRequest| -> bool { panic!("no play") };
        assert_eq!(
            json_of(&answer("1", Request::Capabilities, none, || panic!())),
            json!({"id":"1","ok":true,"result":{"api":1,"play":true,"download":false,"cast":false}})
        );
        assert_eq!(
            json_of(&answer("2", Request::Unsupported, none, || panic!())),
            json!({"id":"2","ok":false,"error":"unsupported"})
        );
        let mut opened = false;
        let r = answer("3", Request::OpenSettings, none, || opened = true);
        assert!(opened);
        assert_eq!(json_of(&r), json!({"id":"3","ok":true,"result":null}));
        let req = PlayRequest {
            item_id: "i".into(),
            profile_id: "p".into(),
            start_ms: None,
            media_source_id: None,
            audio: None,
            subtitle: None,
        };
        let r = answer(
            "4",
            Request::Play(req.clone()),
            |p| {
                assert_eq!(p.item_id, "i");
                false
            },
            || panic!(),
        );
        assert_eq!(json_of(&r), json!({"id":"4","ok":true,"result":false}));
        let r = answer("5", Request::Play(req), |_| true, || panic!());
        assert_eq!(json_of(&r), json!({"id":"5","ok":true,"result":true}));
    }
}
