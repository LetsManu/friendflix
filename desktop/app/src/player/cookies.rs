// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! The session cookie for mpv and the player's server calls, read from WebView2's cookie store for the server origin.
//! It is only held in memory: never logged, written to disk or put on a command line.
use friendflix_core::origin::Origin;
use tauri::{Url, Webview};

/// The `Cookie` header value (`name=value; …`) for the server origin, or `None` when there is none. On Windows this must
/// not run on the main thread (WebView2 deadlocks there); the player calls it from its own thread.
pub fn session_cookie(webview: &Webview, origin: &Origin) -> Option<String> {
    let url = Url::parse(&origin.web()).ok()?;
    let cookies = webview.cookies_for_url(url).ok()?;
    let header = cookie_header(cookies.iter().map(|c| (c.name(), c.value())));
    (!header.is_empty()).then_some(header)
}

/// `name=value; …`; pairs that would break the header (separators, control characters) are left out.
pub fn cookie_header<'a>(pairs: impl Iterator<Item = (&'a str, &'a str)>) -> String {
    let token = |s: &str, name: bool| {
        s.chars().all(|c| {
            !c.is_control() && c != ';' && c != ',' && !(name && (c == '=' || c.is_whitespace()))
        })
    };
    pairs
        .filter(|(n, v)| !n.is_empty() && token(n, true) && token(v, false))
        .map(|(n, v)| format!("{n}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_from_pairs() {
        let pairs = [
            ("ff_sid", "abc"),
            ("theme", "dark"),
            ("bad;name", "x"),
            ("ok", "evil\r\nX-Injected: 1"),
            ("", "empty"),
            ("semi", "a;b"),
        ];
        assert_eq!(
            cookie_header(pairs.iter().map(|(n, v)| (*n, *v))),
            "ff_sid=abc; theme=dark"
        );
        assert_eq!(cookie_header(std::iter::empty()), "");
    }
}
