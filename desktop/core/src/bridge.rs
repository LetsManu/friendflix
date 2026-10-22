// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! The narrow native bridge protocol (JSON strings), mirroring web/src/lib/native/bridge.ts and play.ts.
//! Anything the app does not support, or any invalid field, is answered with the protocol's "no" (`reply(.., false, None)`).
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;

pub const MAX_MESSAGE_BYTES: usize = 16384;
pub const MAX_START_MS: u64 = 604_800_000;

static REQUEST_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").unwrap());
static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9-]{1,64}$").unwrap());
static TRACK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,32}$").unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayRequest {
    pub item_id: String,
    pub profile_id: String,
    pub start_ms: Option<u64>,
    pub media_source_id: Option<String>,
    pub audio: Option<String>,
    pub subtitle: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Capabilities,
    Play(PlayRequest),
    OpenSettings,
    Unsupported,
}

/// `None` for an oversized message, bad JSON or a missing/invalid id (nothing to answer to).
pub fn parse(msg: &str) -> Option<(String, Request)> {
    if msg.len() > MAX_MESSAGE_BYTES {
        return None;
    }
    let root: Value = serde_json::from_str(msg).ok()?;
    let root = root.as_object()?;
    let id = root
        .get("id")?
        .as_str()
        .filter(|s| REQUEST_ID.is_match(s))?
        .to_string();
    let request = match root.get("method").and_then(Value::as_str) {
        Some("capabilities") => Request::Capabilities,
        Some("openSettings") => Request::OpenSettings,
        Some("play") => play(root.get("args")).map_or(Request::Unsupported, Request::Play),
        _ => Request::Unsupported,
    };
    Some((id, request))
}

fn field<'a>(args: &'a Map<String, Value>, key: &str, re: &Regex) -> Result<Option<&'a str>, ()> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if re.is_match(s) => Ok(Some(s)),
        _ => Err(()),
    }
}

fn play(args: Option<&Value>) -> Option<PlayRequest> {
    const KEYS: [&str; 6] = [
        "itemId",
        "profileId",
        "startMs",
        "mediaSourceId",
        "audio",
        "subtitle",
    ];
    let args = args?.as_object()?;
    if args.keys().any(|k| !KEYS.contains(&k.as_str())) {
        return None;
    }
    let start_ms = match args.get("startMs") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_u64().filter(|ms| *ms <= MAX_START_MS)?),
    };
    let own = |s: &str| s.to_string();
    Some(PlayRequest {
        item_id: field(args, "itemId", &ID).ok()??.to_string(),
        profile_id: field(args, "profileId", &ID).ok()??.to_string(),
        start_ms,
        media_source_id: field(args, "mediaSourceId", &ID).ok()?.map(own),
        audio: field(args, "audio", &TRACK).ok()?.map(own),
        subtitle: field(args, "subtitle", &TRACK).ok()?.map(own),
    })
}

/// `{id, ok:true, result}` or the "no" answer `{id, ok:false, error:"unsupported"}`.
pub fn reply(id: &str, ok: bool, result: Option<Value>) -> String {
    if ok {
        json!({"id": id, "ok": true, "result": result.unwrap_or(Value::Null)}).to_string()
    } else {
        json!({"id": id, "ok": false, "error": "unsupported"}).to_string()
    }
}

pub fn capabilities() -> Value {
    json!({"api": 1, "play": true, "download": false, "cast": false})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(v: serde_json::Value) -> String {
        v.to_string()
    }

    #[test]
    fn bridge_parse_methods() {
        let (id, r) = parse(&msg(json!({"id":"a-1_x","method":"capabilities"}))).unwrap();
        assert_eq!((id.as_str(), r), ("a-1_x", Request::Capabilities));
        assert_eq!(
            parse(&msg(json!({"id":"1","method":"openSettings","args":{}})))
                .unwrap()
                .1,
            Request::OpenSettings
        );
        for m in ["download", "downloads", "deleteDownload", "nope", ""] {
            assert_eq!(
                parse(&msg(json!({"id":"1","method":m}))).unwrap().1,
                Request::Unsupported,
                "{m}"
            );
        }
        assert_eq!(
            parse(&msg(json!({"id":"1"}))).unwrap().1,
            Request::Unsupported
        );
        let p = parse(&msg(json!({"id":"1","method":"play","args":{
            "itemId":"abc-123","profileId":"p1","startMs":5000,"mediaSourceId":"ms-1","audio":"a_1","subtitle":"s-2"}}))).unwrap().1;
        assert_eq!(
            p,
            Request::Play(PlayRequest {
                item_id: "abc-123".into(),
                profile_id: "p1".into(),
                start_ms: Some(5000),
                media_source_id: Some("ms-1".into()),
                audio: Some("a_1".into()),
                subtitle: Some("s-2".into()),
            })
        );
        let min = parse(&msg(
            json!({"id":"1","method":"play","args":{"itemId":"i","profileId":"p"}}),
        ))
        .unwrap()
        .1;
        assert!(matches!(
            min,
            Request::Play(PlayRequest {
                start_ms: None,
                media_source_id: None,
                audio: None,
                subtitle: None,
                ..
            })
        ));
        let max = parse(&msg(json!({"id":"1","method":"play","args":{"itemId":"i","profileId":"p","startMs":604_800_000u64}}))).unwrap().1;
        assert!(matches!(
            max,
            Request::Play(PlayRequest {
                start_ms: Some(604_800_000),
                ..
            })
        ));
    }

    #[test]
    fn bridge_rejects_bad_ids_and_sizes() {
        for id in [
            json!(""),
            json!("a b"),
            json!("x".repeat(65)),
            json!(5),
            json!(null),
            json!("ä"),
        ] {
            assert!(parse(&msg(json!({"id":id,"method":"capabilities"}))).is_none());
        }
        assert!(parse(&msg(json!({"method":"capabilities"}))).is_none());
        assert!(parse("not json").is_none());
        assert!(parse("[1]").is_none());
        let ok = format!(
            r#"{{"id":"1","method":"capabilities","pad":"{}"}}"#,
            "x".repeat(16384 - 50)
        );
        assert!(ok.len() <= 16384 && parse(&ok).is_some());
        let big = format!(
            r#"{{"id":"1","method":"capabilities","pad":"{}"}}"#,
            "x".repeat(16384)
        );
        assert!(parse(&big).is_none());
    }

    #[test]
    fn bridge_play_validation() {
        let play = |args: serde_json::Value| {
            parse(&msg(json!({"id":"1","method":"play","args":args})))
                .unwrap()
                .1
        };
        let bad = [
            json!({"itemId":"a_b","profileId":"p"}),
            json!({"itemId":"i","profileId":"p q"}),
            json!({"itemId":"","profileId":"p"}),
            json!({"itemId":"i"}),
            json!({"itemId":"i","profileId":"p","audio":"a b"}),
            json!({"itemId":"i","profileId":"p","audio":"a".repeat(33)}),
            json!({"itemId":"i","profileId":"p","subtitle":"../x"}),
            json!({"itemId":"i","profileId":"p","mediaSourceId":"a_b"}),
            json!({"itemId":"i","profileId":"p","startMs":604_800_001u64}),
            json!({"itemId":"i","profileId":"p","startMs":-1}),
            json!({"itemId":"i","profileId":"p","startMs":1.5}),
            json!({"itemId":"i","profileId":"p","startMs":"5"}),
            json!({"itemId":"i","profileId":"p","extra":1}),
            json!({"itemId":7,"profileId":"p"}),
            json!("str"),
        ];
        for a in bad {
            assert_eq!(play(a.clone()), Request::Unsupported, "{a}");
        }
    }

    #[test]
    fn reply_shapes() {
        let ok: serde_json::Value =
            serde_json::from_str(&reply("1", true, Some(json!(true)))).unwrap();
        assert_eq!(ok, json!({"id":"1","ok":true,"result":true}));
        let no: serde_json::Value = serde_json::from_str(&reply("1", false, None)).unwrap();
        assert_eq!(no, json!({"id":"1","ok":false,"error":"unsupported"}));
    }

    #[test]
    fn capabilities_shape() {
        assert_eq!(
            capabilities(),
            json!({"api":1,"play":true,"download":false,"cast":false})
        );
    }
}
