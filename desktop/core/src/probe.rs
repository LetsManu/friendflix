// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! Setup check of a server address (parity with the Android `ServerProbe`): `GET /api/version`, public, without cookies and
//! without following redirects. FriendFlix answers `{sha, version, codename, ...}` and optionally `authOrigin`.
use std::error::Error as StdError;
use std::io::Read;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::ACCEPT;
use reqwest::redirect::Policy;
use serde_json::Value;
use url::Url;

use crate::origin::{parse_auth, Origin};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeOk {
    pub version: String,
    /// the sign-in origin (`authOrigin`, https, nothing after the host), or None when absent or unusable
    pub auth_origin: Option<Origin>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeError {
    NotFriendFlix,
    ServerTooOld,
    TlsProblem,
    Unreachable,
}

/// The oldest server (release version) this app works with (as on Android).
pub const MIN_SERVER: (u32, u32, u32) = (2, 0, 0);
const MAX_BODY: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);

/// `GET <server>/api/version` without cookies or redirects; Ok when it is a FriendFlix server this app can talk to.
pub fn probe(server: &Origin) -> Result<ProbeOk, ProbeError> {
    let http = Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .redirect(Policy::none())
        .build()
        .map_err(|_| ProbeError::Unreachable)?;
    let resp = http
        .get(server.join("/api/version"))
        .header(ACCEPT, "application/json")
        .send()
        .map_err(|e| {
            if is_tls(&e) {
                ProbeError::TlsProblem
            } else {
                ProbeError::Unreachable
            }
        })?;
    if resp.status().as_u16() != 200 || resp.content_length().is_some_and(|n| n > MAX_BODY as u64) {
        return Err(ProbeError::NotFriendFlix);
    }
    let mut body = Vec::new();
    resp.take(MAX_BODY as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|_| ProbeError::Unreachable)?;
    evaluate(&body)
}

/// A certificate or handshake failure (reqwest does not type these; the error chain names them).
fn is_tls(e: &reqwest::Error) -> bool {
    let mut src: Option<&dyn StdError> = Some(e);
    while let Some(s) = src {
        let t = s.to_string().to_ascii_lowercase();
        if ["certificate", "tls", "handshake", "ssl"]
            .iter()
            .any(|w| t.contains(w))
        {
            return true;
        }
        src = s.source();
    }
    false
}

/// Strict `major.minor.patch` (each 1..=6 digits); pre-release suffixes are not a release version.
fn semver(text: &str) -> Option<(u32, u32, u32)> {
    let p: Vec<&str> = text.split('.').collect();
    if p.len() != 3 {
        return None;
    }
    let n = |s: &str| {
        (!s.is_empty() && s.len() <= 6 && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<u32>().ok())
            .flatten()
    };
    Some((n(p[0])?, n(p[1])?, n(p[2])?))
}

/// Checks a `/api/version` body (at most 64 KiB).
pub fn evaluate(body: &[u8]) -> Result<ProbeOk, ProbeError> {
    if body.len() > MAX_BODY {
        return Err(ProbeError::NotFriendFlix);
    }
    let json: Value = serde_json::from_slice(body).map_err(|_| ProbeError::NotFriendFlix)?;
    let text = |k: &str| json.get(k).and_then(Value::as_str).unwrap_or("");
    let version = text("version");
    let server = semver(version).ok_or(ProbeError::NotFriendFlix)?;
    if text("sha").is_empty() || text("codename").is_empty() {
        return Err(ProbeError::NotFriendFlix);
    }
    if server < MIN_SERVER {
        return Err(ProbeError::ServerTooOld);
    }
    Ok(ProbeOk {
        version: version.to_string(),
        auth_origin: auth_origin_of(text("authOrigin")),
    })
}

/// `authOrigin` as an origin the window may show: https, a host, and nothing after it (no path, query, fragment or user info).
pub fn auth_origin_of(text: &str) -> Option<Origin> {
    if !text
        .get(..8)
        .is_some_and(|p| p.eq_ignore_ascii_case("https://"))
    {
        return None;
    }
    let url = Url::parse(text).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    parse_auth(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use serde_json::json;

    fn origin(server: &MockServer) -> Origin {
        Origin::parse(&server.base_url()).unwrap()
    }

    #[test]
    fn probe_accepts_friendflix_answer() {
        let server = MockServer::start();
        let m = server.mock(|when, then| {
            when.method(GET).path("/api/version").matches(|req| {
                !req.headers
                    .as_ref()
                    .is_some_and(|h| h.iter().any(|(k, _)| k.eq_ignore_ascii_case("cookie")))
            });
            then.status(200).json_body(json!({
                "sha": "abc", "version": "2.2.1", "codename": "Brezel", "build": "x", "channel": "stable", "label": "",
                "authOrigin": "https://auth.example.com"
            }));
        });
        let ok = probe(&origin(&server)).unwrap();
        m.assert();
        assert_eq!(ok.version, "2.2.1");
        assert_eq!(ok.auth_origin, Origin::parse("https://auth.example.com"));
    }

    #[test]
    fn probe_rejects_other_answers() {
        for (status, body) in [
            (200, json!({"version": "2.2.1", "codename": "x"})),
            (200, json!({"sha": "a", "version": "2.2.1"})),
            (200, json!({"sha": "a", "version": "2.2", "codename": "x"})),
            (
                200,
                json!({"sha": "a", "version": "2.2.1-rc1", "codename": "x"}),
            ),
            (200, json!([1])),
            (
                404,
                json!({"sha": "a", "version": "2.2.1", "codename": "x"}),
            ),
            (302, json!({})),
        ] {
            let server = MockServer::start();
            server.mock(|when, then| {
                when.method(GET).path("/api/version");
                then.status(status).json_body(body.clone());
            });
            assert_eq!(
                probe(&origin(&server)),
                Err(ProbeError::NotFriendFlix),
                "{status} {body}"
            );
        }
    }

    #[test]
    fn probe_server_too_old_and_unreachable() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/api/version");
            then.status(200)
                .json_body(json!({"sha": "a", "version": "1.9.9", "codename": "x"}));
        });
        assert_eq!(probe(&origin(&server)), Err(ProbeError::ServerTooOld));
        let closed = Origin::parse("http://127.0.0.1:9").unwrap();
        assert_eq!(probe(&closed), Err(ProbeError::Unreachable));
    }

    #[test]
    fn probe_body_size_limit() {
        let big = format!(
            r#"{{"sha":"a","version":"2.2.1","codename":"x","pad":"{}"}}"#,
            "x".repeat(70 * 1024)
        );
        assert_eq!(evaluate(big.as_bytes()), Err(ProbeError::NotFriendFlix));
    }

    #[test]
    fn auth_origin_rules() {
        assert_eq!(
            auth_origin_of("https://auth.example.com"),
            Origin::parse("https://auth.example.com")
        );
        assert_eq!(
            auth_origin_of("https://auth.example.com/"),
            Origin::parse("https://auth.example.com")
        );
        assert_eq!(
            auth_origin_of("HTTPS://auth.example.com:8443"),
            Origin::parse("https://auth.example.com:8443")
        );
        for bad in [
            "",
            "auth.example.com",
            "http://auth.example.com",
            "https://auth.example.com/login",
            "https://auth.example.com/?x=1",
            "https://auth.example.com/#f",
            "https://u@auth.example.com",
            "https://u:p@auth.example.com",
            "javascript:alert(1)",
        ] {
            assert_eq!(auth_origin_of(bad), None, "{bad}");
        }
        let ok = evaluate(br#"{"sha":"a","version":"2.0.0","codename":"x","authOrigin":"http://auth.example.com"}"#).unwrap();
        assert_eq!(ok.auth_origin, None);
        let ok =
            evaluate(br#"{"sha":"a","version":"2.0.0","codename":"x","authOrigin":5}"#).unwrap();
        assert_eq!(ok.auth_origin, None);
    }
}
