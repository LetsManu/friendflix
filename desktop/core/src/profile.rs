// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! The device profile (`caps` block of `POST /api/playback/info`): what mpv direct-plays on Windows.
//! Same JSON shape as `ClientCaps.toJson()` on Android.
use serde_json::{json, Value};

pub const CONTAINERS: [&str; 8] = ["mkv", "mp4", "m4v", "mov", "webm", "avi", "ts", "m2ts"];
pub const VIDEO: [&str; 6] = ["h264", "hevc", "av1", "vp9", "mpeg2video", "vc1"];
pub const AUDIO: [&str; 10] = [
    "aac", "ac3", "eac3", "dts", "truehd", "flac", "opus", "mp3", "vorbis", "pcm",
];
pub const SUBTITLES: [&str; 6] = ["srt", "ass", "ssa", "vtt", "pgs", "dvdsub"];

pub fn device_profile() -> Value {
    json!({
        "client": "windows",
        "appVersion": env!("CARGO_PKG_VERSION"),
        "containers": CONTAINERS,
        "video": VIDEO.iter().map(|c| json!({ "codec": c })).collect::<Vec<_>>(),
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
        assert_eq!(
            p["video"],
            json!([
                {"codec":"h264"},{"codec":"hevc"},{"codec":"av1"},
                {"codec":"vp9"},{"codec":"mpeg2video"},{"codec":"vc1"}
            ])
        );
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
    }
}
