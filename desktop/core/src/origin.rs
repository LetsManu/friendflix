// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! Origin policy: which URLs are the app (server origin), the sign-in provider (auth origin) or foreign.
//! Origins are compared as exact (scheme, host, port) tuples; user info never matches.
//! Plain `http` is accepted only for a server in the home network (see [`http_allowed`]); every other host needs `https`.
use std::net::{Ipv4Addr, Ipv6Addr};
use url::{Host, Url};

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
        match url.scheme() {
            "https" => {}
            "http" if url.host().is_some_and(|h| http_allowed(&h)) => {}
            _ => return None,
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

    /// A server URL (the server sends paths like `/media/...`) made absolute against this origin, kept only when the
    /// result is on exactly this origin (a `//host` or absolute foreign URL gives `None`).
    pub fn resolve(&self, url: &str) -> Option<String> {
        if url.trim().is_empty() {
            return None;
        }
        let base = Url::parse(&format!("{}/", self.web())).ok()?;
        let u = base.join(url).ok()?;
        self.matches(u.as_str()).then(|| u.to_string())
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

/// Whether plain `http` may be used for this host: only for a server in the home network (docs/windows.md), never across
/// the internet, where the session cookie and the media would travel in clear text. That is loopback, private (RFC 1918),
/// link-local and shared/CGNAT (100.64.0.0/10, e.g. Tailscale) IPv4; loopback, unique-local (fc00::/7) and link-local
/// (fe80::/10) IPv6 (also IPv4-mapped); and names that only resolve locally: a single label (`nas`), `localhost` and the
/// suffixes `.localhost`, `.local` (mDNS), `.lan`, `.home.arpa` (RFC 8375), `.internal` and `.ts.net` (Tailscale MagicDNS:
/// the traffic is WireGuard-encrypted end to end). 100.64.0.0/10 is also ISP carrier-grade-NAT space; that is accepted.
/// At most one trailing dot (the absolute form) is ignored and an empty label (`nas..`) is refused. A public name is
/// refused even when it resolves to a private address: the name is what is checked, never the DNS answer. Everything else
/// needs `https`.
pub fn http_allowed(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(a) => local_v4(a),
        Host::Ipv6(a) => local_v6(a),
        Host::Domain(d) => {
            let d = d.strip_suffix('.').unwrap_or(d).to_ascii_lowercase();
            !d.is_empty()
                && d.split('.').all(|l| !l.is_empty())
                && (!d.contains('.')
                    || d == "localhost"
                    || [
                        ".localhost",
                        ".local",
                        ".lan",
                        ".home.arpa",
                        ".internal",
                        ".ts.net",
                    ]
                    .iter()
                    .any(|s| d.ends_with(s)))
        }
    }
}

fn local_v4(a: &Ipv4Addr) -> bool {
    let [o0, o1, ..] = a.octets();
    a.is_loopback() || a.is_private() || a.is_link_local() || (o0 == 100 && (o1 & 0xc0) == 64)
}

fn local_v6(a: &Ipv6Addr) -> bool {
    if let Some(v4) = a.to_ipv4_mapped() {
        return local_v4(&v4);
    }
    let s0 = a.segments()[0];
    a.is_loopback() || (s0 & 0xfe00) == 0xfc00 || (s0 & 0xffc0) == 0xfe80
}

/// Why an address that `Origin::parse` refuses was refused, when that is worth telling the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalReason {
    /// `http://` for a host outside the home network: the same address would be fine over https
    PlainHttpPublicHost,
}

/// `Some` when `input` is refused only because of plain `http` to a public host (and `https://` would be accepted);
/// `None` when it is accepted or simply not a valid address.
pub fn refusal_reason(input: &str) -> Option<RefusalReason> {
    if Origin::parse(input).is_some() {
        return None;
    }
    let t = input.trim();
    let http = t
        .get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("http://"));
    (http && Origin::parse(&format!("https://{}", &t[7..])).is_some())
        .then_some(RefusalReason::PlainHttpPublicHost)
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
            Origin::parse("http://192.168.1.5:8096/x?y")
                .unwrap()
                .as_str(),
            "http://192.168.1.5:8096"
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
        assert_eq!(o("http://192.168.1.5:80"), "http://192.168.1.5");
        assert_eq!(o("http://192.168.1.5:8096"), "http://192.168.1.5:8096");
        assert_eq!(
            o("https://friend.example.com:80"),
            "https://friend.example.com:80"
        );
        assert_eq!(
            o("https://FRIEND.example.com"),
            "https://friend.example.com"
        );
        let w = Origin::parse("http://192.168.1.5:8096").unwrap();
        assert!(w.matches(&w.web()));
    }

    #[test]
    fn resolve_keeps_only_this_origin() {
        let o = Origin::parse("https://friend.example.com").unwrap();
        assert_eq!(
            o.resolve("/media/Videos/a/stream?x=1").as_deref(),
            Some("https://friend.example.com/media/Videos/a/stream?x=1")
        );
        assert_eq!(
            o.resolve("https://friend.example.com:443/s.vtt").as_deref(),
            Some("https://friend.example.com/s.vtt")
        );
        for bad in [
            "\\\\evil.test/x",
            "/\\evil.test/x",
            "https:\\\\evil.test",
            "//evil.test/x",
            "\t//evil.test",
            "//evil.example.net/x",
            "https://evil.example.net/x",
            "http://friend.example.com/x",
            "https://u:p@friend.example.com/x",
            "javascript:alert(1)",
            "",
        ] {
            assert_eq!(o.resolve(bad), None, "{bad}");
        }
        let lan = Origin::parse("http://192.168.1.5:8096").unwrap();
        assert_eq!(
            lan.resolve("media/h.m3u8").as_deref(),
            Some("http://192.168.1.5:8096/media/h.m3u8")
        );
    }

    #[test]
    fn http_only_for_the_home_network() {
        for ok in [
            "http://127.0.0.1:8096",
            "http://localhost:8096",
            "http://app.localhost",
            "http://10.1.2.3",
            "http://172.16.0.9",
            "http://172.31.255.1",
            "http://192.168.178.20:8096",
            "http://169.254.1.1",
            "http://100.64.0.1",
            "http://100.127.255.254",
            "http://[::1]:8096",
            "http://[fd12:3456::1]:8096",
            "http://[fe80::1]",
            "http://[::ffff:192.168.1.2]",
            "http://nas:8096",
            "http://NAS.local",
            "http://friendflix.lan:8096",
            "http://media.home.arpa",
            "http://box.internal.",
            "http://3232235777", // normalised to 192.168.1.1
            "http://pi.tail1234.ts.net",
        ] {
            assert!(Origin::parse(ok).is_some(), "{ok}");
        }
        for bad in [
            "http://friend.example.com",
            "http://friend.example.com.local.evil.test",
            "http://192.0.2.5:8096",
            "http://8.8.8.8",
            "http://172.32.0.1",
            "http://100.128.0.1",
            "http://11.0.0.1",
            "http://[2001:db8::1]",
            "http://[::ffff:8.8.8.8]",
            "http://friendlocal.com",
            "http://example.localhost.com",
            "http://192.168.1.5@friend.example.com",
            "http://134744072", // 8.8.8.8
            "http://[::ffff:808:808]",
            "http://localhost.evil.example.com",
            "http://0.0.0.0",
            "http://nas..",
            "http://nas..local",
        ] {
            assert!(Origin::parse(bad).is_none(), "{bad}");
        }
        // https is never restricted; a public http URL never matches a LAN origin either
        assert!(Origin::parse("https://192.0.2.5:8096").is_some());
        let lan = Origin::parse("http://192.168.1.5:8096").unwrap();
        assert!(!lan.matches("http://friend.example.com:8096/"));
    }

    #[test]
    fn refusal_reason_names_plain_http_only() {
        for r in [
            "http://friend.example.com",
            "HTTP://friend.example.com:8096/x",
            "  http://8.8.8.8 ",
            "http://nas..", // https would parse, so the advice is right
        ] {
            assert_eq!(
                refusal_reason(r),
                Some(RefusalReason::PlainHttpPublicHost),
                "{r}"
            );
        }
        for none in [
            "https://friend.example.com",
            "friend.example.com",
            "http://192.168.1.5",
            "ftp://friend.example.com",
            "http://",
            "",
            "http://exa mple.com",
        ] {
            assert_eq!(refusal_reason(none), None, "{none}");
        }
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
