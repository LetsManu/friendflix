// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! Blocking client for the FriendFlix server calls of the player (parity with `PlayerApi.kt` / `ServerApi.kt`).
//! It sends the session cookie to the server origin only, never follows redirects and never logs URLs, bodies or the cookie.
use std::fmt;
use std::io::Read;
use std::sync::Mutex;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE, COOKIE};
use reqwest::redirect::Policy;
use serde_json::Value;

use crate::model::{
    self, Chapter, ItemInfo, LangPref, PlaybackInfo, PlayerPrefs, Segment, ServerCaps,
};
use crate::origin::Origin;

const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_JSON: usize = 1 << 20;
const MAX_BYTES: usize = 8 << 20;
const PROFILE_ERRORS: [&str; 2] = ["profile_changed", "profile_required"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiError {
    /// 401: the session is gone
    Unauthorized,
    Status(u16),
    Network,
    Malformed,
}

#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum InfoAnswer {
    Ok(PlaybackInfo),
    /// 429 max_streams: the account's stream limit
    MaxStreams(u32),
    /// 401: the session is gone
    Unauthorized,
    /// another 4xx
    Refused,
    /// 409 profile_changed / profile_required
    ProfileMismatch,
    /// 5xx, network or malformed answer
    Retry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportKind {
    Start,
    Progress,
    Stop,
}

impl ReportKind {
    pub fn path(self) -> &'static str {
        match self {
            ReportKind::Start => "start",
            ReportKind::Progress => "progress",
            ReportKind::Stop => "stop",
        }
    }
}

/// `cookie` and `profile_id` are kept for later use; both are already in the client's (sensitive) default headers.
#[allow(dead_code)]
pub struct ServerApi {
    origin: Origin,
    cookie: String,
    profile_id: String,
    http: Client,
    csrf: Mutex<Option<String>>,
}

impl fmt::Debug for ServerApi {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerApi")
            .field("origin", &self.origin)
            .finish()
    }
}

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn sensitive(v: &str) -> Option<HeaderValue> {
    let mut h = HeaderValue::from_str(v).ok()?;
    h.set_sensitive(true);
    Some(h)
}

fn read_limited(resp: reqwest::blocking::Response, max: usize) -> Result<Vec<u8>, ApiError> {
    if resp.content_length().is_some_and(|n| n > max as u64) {
        return Err(ApiError::Malformed);
    }
    let mut buf = Vec::new();
    resp.take(max as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|_| ApiError::Network)?;
    if buf.len() > max {
        return Err(ApiError::Malformed);
    }
    Ok(buf)
}

impl ServerApi {
    pub fn new(origin: Origin, cookie: String, profile_id: String) -> ServerApi {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Some(c) = sensitive(&cookie) {
            headers.insert(COOKIE, c);
        }
        if let Some(p) = sensitive(&profile_id) {
            headers.insert(HeaderName::from_static("x-ff-profile"), p);
        }
        let http = Client::builder()
            .timeout(TIMEOUT)
            .redirect(Policy::none())
            .default_headers(headers)
            .build()
            .expect("http client");
        ServerApi {
            origin,
            cookie,
            profile_id,
            http,
            csrf: Mutex::new(None),
        }
    }

    fn url(&self, path: &str) -> String {
        self.origin.join(path)
    }

    fn csrf_get(&self) -> Option<String> {
        self.csrf.lock().ok().and_then(|g| g.clone())
    }

    fn csrf_set(&self, v: Option<String>) {
        if let Ok(mut g) = self.csrf.lock() {
            *g = v;
        }
    }

    /// `GET path` as JSON: the status and the body (None when it is not JSON or too large).
    fn get_json(&self, path: &str) -> Result<(u16, Option<Value>), ApiError> {
        let resp = self
            .http
            .get(self.url(path))
            .send()
            .map_err(|_| ApiError::Network)?;
        let code = resp.status().as_u16();
        if code == 401 {
            return Err(ApiError::Unauthorized);
        }
        let body = read_limited(resp, MAX_JSON)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());
        Ok((code, body))
    }

    fn csrf_token(&self) -> Result<String, ApiError> {
        if let Some(t) = self.csrf_get() {
            return Ok(t);
        }
        match self.get_json("/api/me")? {
            (200, Some(j)) => {
                let t = j
                    .get("csrfToken")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                    .ok_or(ApiError::Malformed)?
                    .to_string();
                self.csrf_set(Some(t.clone()));
                Ok(t)
            }
            (200, None) => Err(ApiError::Malformed),
            (code, _) => Err(ApiError::Status(code)),
        }
    }

    /// A CSRF-protected JSON write (the token is refetched once on a csrf 403): the status and the body.
    fn send_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: &Value,
    ) -> Result<(u16, Option<Value>), ApiError> {
        for attempt in 0..2 {
            let token = self.csrf_token()?;
            let resp = self
                .http
                .request(method.clone(), self.url(path))
                .header(
                    "x-csrf-token",
                    sensitive(&token).ok_or(ApiError::Malformed)?,
                )
                .header(CONTENT_TYPE, "application/json")
                .body(body.to_string())
                .send()
                .map_err(|_| ApiError::Network)?;
            let code = resp.status().as_u16();
            if code == 401 {
                return Err(ApiError::Unauthorized);
            }
            let json: Option<Value> = read_limited(resp, MAX_JSON)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok());
            let csrf_error = json.as_ref().and_then(|j| j.get("error")?.as_str()) == Some("csrf");
            if code == 403 && csrf_error && attempt == 0 {
                self.csrf_set(None);
                continue;
            }
            return Ok((code, json));
        }
        Err(ApiError::Network)
    }

    pub fn info(&self, body: &Value) -> InfoAnswer {
        let (code, json) = match self.send_json(reqwest::Method::POST, "/api/playback/info", body) {
            Ok(r) => r,
            Err(ApiError::Unauthorized) => return InfoAnswer::Unauthorized,
            Err(_) => return InfoAnswer::Retry,
        };
        let error = json
            .as_ref()
            .and_then(|j| j.get("error")?.as_str())
            .unwrap_or("");
        match code {
            200 => json
                .as_ref()
                .and_then(model::parse_info)
                .map_or(InfoAnswer::Retry, InfoAnswer::Ok),
            429 if error == "max_streams" => {
                let max = json
                    .as_ref()
                    .and_then(|j| j.get("max")?.as_u64())
                    .map_or(1, |n| n.min(u32::MAX as u64) as u32);
                InfoAnswer::MaxStreams(max)
            }
            409 if PROFILE_ERRORS.contains(&error) => InfoAnswer::ProfileMismatch,
            400..=499 => InfoAnswer::Refused,
            _ => InfoAnswer::Retry,
        }
    }

    /// `POST /api/playback/<kind>`; the caller drops a failed report.
    pub fn report(&self, kind: ReportKind, body: &Value) -> Result<(), ApiError> {
        let path = format!("/api/playback/{}", kind.path());
        match self.send_json(reqwest::Method::POST, &path, body)? {
            (200, _) => Ok(()),
            (code, _) => Err(ApiError::Status(code)),
        }
    }

    fn get_ok(&self, path: &str) -> Result<Value, ApiError> {
        match self.get_json(path)? {
            (200, Some(j)) => Ok(j),
            (200, None) => Err(ApiError::Malformed),
            (code, _) => Err(ApiError::Status(code)),
        }
    }

    fn get_item_path(&self, id: &str, suffix: &str) -> Result<Value, ApiError> {
        if !valid_id(id) {
            return Err(ApiError::Malformed);
        }
        self.get_ok(&format!("/api/items/{id}{suffix}"))
    }

    pub fn item(&self, id: &str) -> Result<ItemInfo, ApiError> {
        let j = self.get_item_path(id, "")?;
        j.get("item")
            .and_then(model::parse_item)
            .ok_or(ApiError::Malformed)
    }

    /// The episode (or film) that follows; `None` when the server says there is none.
    pub fn next(&self, id: &str) -> Result<Option<ItemInfo>, ApiError> {
        let j = self.get_item_path(id, "/next")?;
        match j.get("item") {
            None | Some(Value::Null) => Ok(None),
            Some(o) => model::parse_item(o).map(Some).ok_or(ApiError::Malformed),
        }
    }

    pub fn segments(&self, id: &str) -> Result<Vec<Segment>, ApiError> {
        Ok(model::parse_segments(&self.get_item_path(id, "/segments")?))
    }

    pub fn chapters(&self, id: &str) -> Result<Vec<Chapter>, ApiError> {
        Ok(model::parse_chapters(&self.get_item_path(id, "/chapters")?))
    }

    /// One `/api/me` read; a missing flag means "available".
    pub fn caps(&self) -> Result<ServerCaps, ApiError> {
        Ok(model::parse_caps(&self.get_ok("/api/me")?))
    }

    pub fn prefs(&self) -> Result<PlayerPrefs, ApiError> {
        model::parse_prefs(&self.get_ok("/api/prefs")?).ok_or(ApiError::Malformed)
    }

    pub fn lang_pref(&self, id: &str, anime: bool) -> Result<LangPref, ApiError> {
        if !valid_id(id) {
            return Err(ApiError::Malformed);
        }
        let q = if anime { "?anime=1" } else { "" };
        Ok(model::parse_lang_pref(
            &self.get_ok(&format!("/api/series/{id}/langpref{q}"))?,
        ))
    }

    pub fn save_lang_pref(
        &self,
        series_id: &str,
        audio: Option<&str>,
        subtitle: Option<&str>,
    ) -> Result<(), ApiError> {
        if !valid_id(series_id) {
            return Err(ApiError::Malformed);
        }
        let mut body = serde_json::Map::new();
        if let Some(a) = audio {
            body.insert("audio".into(), a.into());
        }
        if let Some(s) = subtitle {
            body.insert("subtitle".into(), s.into());
        }
        let path = format!("/api/series/{series_id}/langpref");
        match self.send_json(reqwest::Method::PUT, &path, &Value::Object(body))? {
            (200, _) => Ok(()),
            (code, _) => Err(ApiError::Status(code)),
        }
    }

    /// A small same-origin resource (subtitle, artwork, trickplay sheet) of at most 8 MiB.
    pub fn bytes(&self, url: &str) -> Result<Vec<u8>, ApiError> {
        if !self.origin.matches(url) {
            return Err(ApiError::Malformed);
        }
        let resp = self.http.get(url).send().map_err(|_| ApiError::Network)?;
        match resp.status().as_u16() {
            200 => read_limited(resp, MAX_BYTES),
            401 => Err(ApiError::Unauthorized),
            code => Err(ApiError::Status(code)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use serde_json::json;

    fn api(server: &MockServer) -> ServerApi {
        ServerApi::new(
            Origin::parse(&server.base_url()).unwrap(),
            "ff_sid=SECRETCOOKIE".into(),
            "prof1".into(),
        )
    }

    fn csrf_mock(server: &MockServer) {
        server.mock(|when, then| {
            when.method(GET).path("/api/me");
            then.status(200).json_body(json!({"csrfToken": "tok"}));
        });
    }

    fn info_json() -> Value {
        json!({
            "playSessionId": "ps", "mediaSourceId": "ms", "directUrl": "/media/d",
            "hlsUrl": "/media/h.m3u8", "resumeTicks": 5, "maxBitrate": 8000000,
            "audioTracks": [{"index": 1, "title": "DE", "language": "deu", "isDefault": true}],
            "subtitles": [{"index": 2, "title": "EN", "language": null, "url": "/s.vtt"}, {"index": 3}],
        })
    }

    fn info_with(status: u16, body: Value) -> InfoAnswer {
        let server = MockServer::start();
        csrf_mock(&server);
        server.mock(|when, then| {
            when.method(POST).path("/api/playback/info");
            then.status(status).json_body(body);
        });
        api(&server).info(&json!({"itemId": "x"}))
    }

    #[test]
    fn info_maps_each_status() {
        match info_with(200, info_json()) {
            InfoAnswer::Ok(i) => {
                assert_eq!(i.play_session_id, "ps");
                assert_eq!(i.audio_tracks.len(), 1);
                assert_eq!(i.subtitles.len(), 1, "a subtitle without url is dropped");
                assert_eq!(i.subtitles[0].language, None);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            info_with(429, json!({"error": "max_streams", "max": 3})),
            InfoAnswer::MaxStreams(3)
        );
        assert_eq!(info_with(403, json!({"error": "no"})), InfoAnswer::Refused);
        assert_eq!(
            info_with(409, json!({"error": "profile_changed"})),
            InfoAnswer::ProfileMismatch
        );
        assert_eq!(info_with(500, json!({})), InfoAnswer::Retry);
        assert_eq!(info_with(401, json!({})), InfoAnswer::Unauthorized);
        assert_eq!(info_with(404, json!({})), InfoAnswer::Refused);

        let server = MockServer::start();
        csrf_mock(&server);
        server.mock(|when, then| {
            when.method(POST).path("/api/playback/info");
            then.status(200).body("not json {");
        });
        assert_eq!(api(&server).info(&json!({})), InfoAnswer::Retry);
    }

    #[test]
    fn unauthorized_is_distinct() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/api/items/abc/segments");
            then.status(401);
        });
        assert_eq!(api(&server).segments("abc"), Err(ApiError::Unauthorized));
    }

    #[test]
    fn bytes_refuses_foreign_url() {
        let server = MockServer::start();
        let a = api(&server);
        assert_eq!(a.bytes("http://192.0.2.1/x.vtt"), Err(ApiError::Malformed));
        assert_eq!(
            a.bytes("https://friend.example.com/x"),
            Err(ApiError::Malformed)
        );
    }

    #[test]
    fn bytes_caps_body_and_reads_same_origin() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/ok");
            then.status(200).body("hello");
        });
        server.mock(|when, then| {
            when.method(GET).path("/big");
            then.status(200).body(vec![b'a'; MAX_BYTES + 1]);
        });
        let a = api(&server);
        assert_eq!(a.bytes(&server.url("/ok")).unwrap(), b"hello");
        assert_eq!(a.bytes(&server.url("/big")), Err(ApiError::Malformed));
    }

    #[test]
    fn headers_sent() {
        let server = MockServer::start();
        let me = server.mock(|when, then| {
            when.method(GET)
                .path("/api/me")
                .header("cookie", "ff_sid=SECRETCOOKIE")
                .header("x-ff-profile", "prof1");
            then.status(200).json_body(json!({"csrfToken": "tok"}));
        });
        let report = server.mock(|when, then| {
            when.method(POST)
                .path("/api/playback/progress")
                .header("cookie", "ff_sid=SECRETCOOKIE")
                .header("x-ff-profile", "prof1")
                .header("x-csrf-token", "tok")
                .json_body(json!({"a": 1}));
            then.status(200).json_body(json!({}));
        });
        let a = api(&server);
        assert_eq!(a.report(ReportKind::Progress, &json!({"a": 1})), Ok(()));
        me.assert();
        report.assert();
        let shown = format!("{a:?}");
        assert!(!shown.contains("SECRETCOOKIE"));
        assert!(shown.starts_with("ServerApi"));
    }

    #[test]
    fn csrf_403_refetches_once() {
        let server = MockServer::start();
        let mut me = server.mock(|when, then| {
            when.method(GET).path("/api/me");
            then.status(200).json_body(json!({"csrfToken": "old"}));
        });
        server.mock(|when, then| {
            when.method(PUT)
                .path("/api/series/s1/langpref")
                .header("x-csrf-token", "old");
            then.status(403).json_body(json!({"error": "csrf"}));
        });
        let a = api(&server);
        assert_eq!(
            a.save_lang_pref("s1", Some("deu"), None),
            Err(ApiError::Status(403))
        );
        me.assert_hits(2);
        me.delete();
    }

    #[test]
    fn parse_caps_missing_flags_true() {
        let c = model::parse_caps(&json!({}));
        assert_eq!(c, ServerCaps::default());
        assert!(c.chapters && c.trickplay && c.subtitle_search && c.postplay);
        assert_eq!(c.segments, vec!["intro", "outro", "recap", "preview"]);
        let c = model::parse_caps(&json!({
            "server": {"capabilities": {"chapters": false, "segments": ["Intro"]}},
            "features": {"postplay": false}, "role": "admin"
        }));
        assert!(!c.chapters && c.trickplay && c.subtitle_search && !c.postplay);
        assert_eq!(c.segments, vec!["intro"]);
        assert_eq!(c.role.as_deref(), Some("admin"));
    }

    #[test]
    fn reads_item_segments_prefs_langpref() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/api/items/e1/segments");
            then.status(200).json_body(json!({"segments": [
                {"type": "Intro", "start": 1.0, "end": 9.5}, {"type": "x", "start": 5, "end": 5}]}));
        });
        server.mock(|when, then| {
            when.method(GET).path("/api/items/e1/next");
            then.status(200).json_body(json!({"item": null}));
        });
        server.mock(|when, then| {
            when.method(GET).path("/api/prefs");
            then.status(200).json_body(json!({"prefs": {
                "audioFx": "bogus", "subtitleStyle": {"size": "l", "color": "x".repeat(21)}}}));
        });
        server.mock(|when, then| {
            when.method(GET)
                .path("/api/series/s1/langpref")
                .query_param("anime", "1");
            then.status(200)
                .json_body(json!({"audio": "jpn", "subtitle": null, "anime": true}));
        });
        let a = api(&server);
        let s = a.segments("e1").unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].kind, "intro");
        assert_eq!(a.next("e1"), Ok(None));
        let p = a.prefs().unwrap();
        assert_eq!(p.audio_fx, "off");
        assert_eq!(p.subtitle_style.size, "l");
        assert_eq!(p.subtitle_style.color, "white");
        let l = a.lang_pref("s1", true).unwrap();
        assert_eq!(
            (l.audio.as_deref(), l.subtitle, l.anime),
            (Some("jpn"), None, true)
        );
        assert_eq!(a.item("bad/id"), Err(ApiError::Malformed));
    }
}
