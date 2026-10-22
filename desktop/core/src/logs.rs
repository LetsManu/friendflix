// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! Log scrubbing: no tokens, cookies or URL query strings in the logs.

use regex::{Captures, Regex};
use std::sync::OnceLock;

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid pattern"))
}

/// Removes `?…` and `#…` from every http(s) URL, and masks `ff_sid=` and `cookie:` values.
pub fn scrub(text: &str) -> String {
    static URL: OnceLock<Regex> = OnceLock::new();
    static COOKIE: OnceLock<Regex> = OnceLock::new();
    static SID: OnceLock<Regex> = OnceLock::new();
    let t = re(&URL, r#"(?i)https?://[^\s"'<>]+"#).replace_all(text, |c: &Captures| {
        let url = &c[0];
        url.find(['?', '#']).map_or(url, |i| &url[..i]).to_string()
    });
    let t = re(&COOKIE, r"(?i)(cookie:[ \t]*)[^\r\n]*").replace_all(&t, "${1}***");
    re(&SID, r#"(?i)(ff_sid=)[^\s;&"',]*"#)
        .replace_all(&t, "${1}***")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_urls_and_cookies() {
        let s = scrub("GET https://friend.example.com/Videos/1/master.m3u8?api_key=abc&x=1#frag ok http://192.0.2.1/a?b=c");
        assert_eq!(
            s,
            "GET https://friend.example.com/Videos/1/master.m3u8 ok http://192.0.2.1/a"
        );
        assert_eq!(
            scrub("sent ff_sid=s3cr3t; path=/"),
            "sent ff_sid=***; path=/"
        );
        assert_eq!(
            scrub("Cookie: ff_sid=abc; other=1\nnext line"),
            "Cookie: ***\nnext line"
        );
        assert_eq!(scrub("cookie: x"), "cookie: ***");
        assert_eq!(scrub("plain text, no url"), "plain text, no url");
        assert!(!scrub("https://a.example.com/p?ff_sid=zzz").contains("zzz"));
    }
}
