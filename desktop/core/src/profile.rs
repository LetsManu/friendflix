// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! The device profile (`caps` block of `POST /api/playback/info`): what mpv direct-plays on Windows.
//! Same JSON shape as `ClientCaps.toJson()` on Android.
use serde_json::{json, Value};

pub const CONTAINERS: [&str; 8] = ["mkv", "mp4", "m4v", "mov", "webm", "avi", "ts", "m2ts"];
pub const VIDEO: [&str; 6] = ["h264", "hevc", "av1", "vp9", "mpeg2video", "vc1"];

/// Video profiles per codec, in Android's names (`DeviceProfile.kt` for a decoder with 10-bit support): mpv decodes
/// 10-bit H.264/HEVC/AV1 (in software where the GPU cannot). A "10" profile is what the server's `isTenBitProfile`
/// reads to let 10-bit sources play direct. Codecs without an entry send no profiles (no restriction).
fn profiles(codec: &str) -> &'static [&'static str] {
    match codec {
        "h264" => &[
            "baseline",
            "constrained baseline",
            "main",
            "high",
            "high 10",
        ],
        "hevc" | "av1" => &["main", "main 10"],
        _ => &[],
    }
}
pub const AUDIO: [&str; 10] = [
    "aac", "ac3", "eac3", "dts", "truehd", "flac", "opus", "mp3", "vorbis", "pcm",
];
pub const SUBTITLES: [&str; 6] = ["srt", "ass", "ssa", "vtt", "pgs", "dvdsub"];

pub fn device_profile() -> Value {
    json!({
        "client": "windows",
        "appVersion": env!("CARGO_PKG_VERSION"),
        "containers": CONTAINERS,
        "video": VIDEO
            .iter()
            .map(|c| match profiles(c) {
                [] => json!({ "codec": c }),
                p => json!({ "codec": c, "profiles": p }),
            })
            .collect::<Vec<_>>(),
        "audio": AUDIO,
        "subtitles": SUBTITLES,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_profile_lists() {
        let p = device_profile();
        assert_eq!(
            p["containers"],
            json!(["mkv", "mp4", "m4v", "mov", "webm", "avi", "ts", "m2ts"])
        );
        // mpv decodes 10-bit everywhere (software fallback): profiles as Android sends them for a 10-bit decoder, so the
        // server's isTenBitProfile lets 10-bit HEVC/AV1/H.264 play direct
        assert_eq!(
            p["video"],
            json!([
                {"codec":"h264","profiles":["baseline","constrained baseline","main","high","high 10"]},
                {"codec":"hevc","profiles":["main","main 10"]},
                {"codec":"av1","profiles":["main","main 10"]},
                {"codec":"vp9"},{"codec":"mpeg2video"},{"codec":"vc1"}
            ])
        );
        let profile = regex::Regex::new(r"^[a-z0-9][a-z0-9 ._-]{0,31}$").unwrap(); // the server's PROFILE
        for v in p["video"].as_array().unwrap() {
            if let Some(ps) = v.get("profiles") {
                let ps = ps.as_array().unwrap();
                assert!(ps.len() <= 16);
                assert!(
                    ps.iter().all(|x| profile.is_match(x.as_str().unwrap())),
                    "{v}"
                );
            }
        }
        assert_eq!(
            p["audio"],
            json!(["aac", "ac3", "eac3", "dts", "truehd", "flac", "opus", "mp3", "vorbis", "pcm"])
        );
        assert_eq!(
            p["subtitles"],
            json!(["srt", "ass", "ssa", "vtt", "pgs", "dvdsub"])
        );
        assert_eq!(p["client"], "windows");
        assert_eq!(p["appVersion"], env!("CARGO_PKG_VERSION"));
        // the server's shape: strict x.y.z (max 32 chars), every list at most 16 entries
        let v = p["appVersion"].as_str().unwrap();
        let parts: Vec<&str> = v.split('.').collect();
        assert!(v.len() <= 32 && parts.len() == 3);
        assert!(parts.iter().all(|n| !n.is_empty()
            && n.bytes().all(|b| b.is_ascii_digit())
            && (*n == "0" || !n.starts_with('0'))));
        for k in ["containers", "video", "audio", "subtitles"] {
            assert!(p[k].as_array().unwrap().len() <= 16, "{k}");
        }
    }
}
