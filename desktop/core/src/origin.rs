// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! Origin policy: which URLs are the app (server origin), the sign-in provider (auth origin) or foreign.
//! Origins are compared as exact (scheme, host, port) tuples; user info never matches.
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nav {
    App,
    Auth,
    External,
}

impl Origin {
    /// `http`/`https` with a host; a bare `host` means `https://host`. Path, query, fragment and user info are dropped.
    pub fn parse(input: &str) -> Option<Origin> {
        let input = input.trim();
        let full = if input.contains("://") {
            input.to_string()
        } else {
            format!("https://{input}")
        };
        let url = Url::parse(&full).ok()?;
        Self::of(&url)
    }

    fn of(url: &Url) -> Option<Origin> {
        if !matches!(url.scheme(), "http" | "https") {
            return None;
        }
        let host = url.host_str().filter(|h| !h.is_empty())?.to_string();
        Some(Origin {
            scheme: url.scheme().to_string(),
            host,
            port: url.port_or_known_default()?,
        })
    }

    /// true only for a URL on exactly this origin and without user info
    pub fn matches(&self, url: &str) -> bool {
        match Url::parse(url) {
            Ok(u) => {
                u.username().is_empty()
                    && u.password().is_none()
                    && Self::of(&u).as_ref() == Some(self)
            }
            Err(_) => false,
        }
    }

    pub fn join(&self, path: &str) -> String {
        let sep = if path.starts_with('/') { "" } else { "/" };
        format!("{}{sep}{path}", self.as_str())
    }

    /// The web (`location.origin`) form: the port only when it is not the scheme's default. Use it where a browser's
    /// origin string is compared or a cookie URL is built; compare URLs with `matches`.
    pub fn web(&self) -> String {
        let default = matches!(
            (self.scheme.as_str(), self.port),
            ("https", 443) | ("http", 80)
        );
        if default {
            format!("{}://{}", self.scheme, self.host)
        } else {
            self.as_str()
        }
    }

    pub fn as_str(&self) -> String {
        format!("{}://{}:{}", self.scheme, self.host, self.port)
    }
}

/// An auth origin must be https.
pub fn parse_auth(input: &str) -> Option<Origin> {
    Origin::parse(input).filter(|o| o.scheme == "https")
}

pub fn classify(server: &Origin, auth: Option<&Origin>, url: &str) -> Nav {
    if server.matches(url) {
        Nav::App
    } else if auth.is_some_and(|a| a.matches(url)) {
        Nav::Auth
    } else {
        Nav::External
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_parse_normalises() {
        assert_eq!(
            Origin::parse("friend.example.com/").unwrap().as_str(),
            "https://friend.example.com:443"
        );
        assert_eq!(
            Origin::parse("http://192.0.2.5:8096/x?y").unwrap().as_str(),
            "http://192.0.2.5:8096"
        );
        assert_eq!(
            Origin::parse("https://u:p@friend.example.com/a#b")
                .unwrap()
                .as_str(),
            "https://friend.example.com:443"
        );
        assert!(Origin::parse("ftp://friend.example.com").is_none());
        assert!(Origin::parse("").is_none());
        assert!(Origin::parse("https://").is_none());
    }

    #[test]
    fn origin_lookalikes_and_ports() {
        let o = Origin::parse("https://friend.example.com").unwrap();
        assert!(o.matches("https://friend.example.com/x?y=1"));
        assert!(o.matches("https://FRIEND.example.com:443/"));
        for bad in [
            "https://friend.example.com.evil.test/",
            "https://friend.example.com:8443/",
            "http://friend.example.com/",
            "https://user@friend.example.com/",
            "https://u:p@friend.example.com/",
            "not a url",
        ] {
            assert!(!o.matches(bad), "{bad}");
        }
        assert_eq!(o.join("/api/x"), "https://friend.example.com:443/api/x");
        assert_eq!(o.join("api/x"), "https://friend.example.com:443/api/x");
    }

    #[test]
    fn web_form_omits_default_port() {
        let o = |s: &str| Origin::parse(s).unwrap().web();
        assert_eq!(o("friend.example.com"), "https://friend.example.com");
        assert_eq!(
            o("https://friend.example.com:443/x"),
            "https://friend.example.com"
        );
        assert_eq!(o("http://192.0.2.5:80"), "http://192.0.2.5");
        assert_eq!(o("http://192.0.2.5:8096"), "http://192.0.2.5:8096");
        assert_eq!(
            o("https://friend.example.com:80"),
            "https://friend.example.com:80"
        );
        assert_eq!(
            o("https://FRIEND.example.com"),
            "https://friend.example.com"
        );
        let w = Origin::parse("http://192.0.2.5:8096").unwrap();
        assert!(w.matches(&w.web()));
    }

    #[test]
    fn auth_origin_needs_https() {
        assert!(parse_auth("auth.example.com").is_some());
        assert!(parse_auth("http://auth.example.com").is_none());
    }

    #[test]
    fn classify_auth_and_external() {
        let s = Origin::parse("https://friend.example.com").unwrap();
        let a = parse_auth("auth.example.com").unwrap();
        assert_eq!(
            classify(&s, Some(&a), "https://friend.example.com/x"),
            Nav::App
        );
        assert_eq!(
            classify(&s, Some(&a), "https://auth.example.com/login"),
            Nav::Auth
        );
        assert_eq!(
            classify(&s, None, "https://auth.example.com/login"),
            Nav::External
        );
        assert_eq!(
            classify(&s, Some(&a), "https://other.example.com/"),
            Nav::External
        );
        assert_eq!(classify(&s, Some(&a), "garbage"), Nav::External);
    }
}
