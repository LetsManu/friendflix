// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! Data model of the server's player answers; keys and parsing mirror `PlayerApi.kt` on Android.
use serde_json::Value;

pub const ALL_SEGMENTS: [&str; 4] = ["intro", "outro", "recap", "preview"];
const AUDIO_FX: [&str; 4] = ["off", "voices", "night", "both"];

#[derive(Debug, Clone, PartialEq)]
pub struct AudioTrack {
    pub index: i32,
    pub title: String,
    pub language: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleTrack {
    pub index: i32,
    pub title: String,
    pub language: Option<String>,
    pub url: String,
    pub is_default: bool,
}

/// Timeline preview sheets: `url` has `{n}` = sheet index, thumbnails are `interval_ms` apart.
#[derive(Debug, Clone, PartialEq)]
pub struct TrickplayInfo {
    pub width: i32,
    pub height: i32,
    pub tile_width: i32,
    pub tile_height: i32,
    pub count: i32,
    pub interval_ms: i64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlaybackInfo {
    pub play_session_id: String,
    pub media_source_id: String,
    pub direct_url: Option<String>,
    pub hls_url: String,
    pub resume_ticks: i64,
    pub max_bitrate: i64,
    pub role_max_bitrate: Option<i64>,
    pub audio_index: Option<i32>,
    pub transcode_reason: Option<String>,
    pub audio_tracks: Vec<AudioTrack>,
    pub subtitles: Vec<SubtitleTrack>,
    pub trickplay: Option<TrickplayInfo>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ItemInfo {
    pub id: String,
    pub kind: Option<String>,
    pub name: String,
    pub series_name: Option<String>,
    pub series_id: Option<String>,
    pub season: Option<i32>,
    pub episode: Option<i32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub kind: String,
    pub start_sec: f64,
    pub end_sec: f64,
}

/// A chapter as the server sends it: `start_sec` in seconds, `image` a same-origin path.
#[derive(Debug, Clone, PartialEq)]
pub struct Chapter {
    pub start_sec: f64,
    pub name: String,
    pub image: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ServerCaps {
    pub chapters: bool,
    pub trickplay: bool,
    pub subtitle_search: bool,
    pub postplay: bool,
    pub segments: Vec<String>,
    pub role: Option<String>,
}

impl Default for ServerCaps {
    fn default() -> Self {
        ServerCaps {
            chapters: true,
            trickplay: true,
            subtitle_search: true,
            postplay: true,
            segments: ALL_SEGMENTS.iter().map(|s| s.to_string()).collect(),
            role: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubtitleStyle {
    pub size: String,
    pub color: String,
    pub background: String,
    pub font: String,
}

impl Default for SubtitleStyle {
    fn default() -> Self {
        SubtitleStyle {
            size: "m".into(),
            color: "white".into(),
            background: "semi".into(),
            font: "sans".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FlowPrefs {
    pub autoplay_next: bool,
    pub auto_skip_intro: bool,
    pub still_watching: bool,
    pub still_watching_episodes: i32,
}

impl Default for FlowPrefs {
    fn default() -> Self {
        FlowPrefs {
            autoplay_next: true,
            auto_skip_intro: false,
            still_watching: true,
            still_watching_episodes: 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlayerPrefs {
    pub flow: FlowPrefs,
    pub audio_lang: String,
    pub subtitle_lang: String,
    /// saved quality cap in bit/s, 0 = automatic
    pub quality: i64,
    pub subtitle_style: SubtitleStyle,
    /// off | voices | night | both
    pub audio_fx: String,
    pub anime_original: bool,
    pub postplay: bool,
    pub spoiler_protection: bool,
}

impl Default for PlayerPrefs {
    fn default() -> Self {
        PlayerPrefs {
            flow: FlowPrefs::default(),
            audio_lang: String::new(),
            subtitle_lang: String::new(),
            quality: 0,
            subtitle_style: SubtitleStyle::default(),
            audio_fx: "off".into(),
            anime_original: false,
            postplay: true,
            spoiler_protection: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LangPref {
    pub audio: Option<String>,
    pub subtitle: Option<String>,
    pub anime: bool,
}

// ---- lenient JSON readers (like org.json's opt*) ----

fn non_empty(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn string(o: &Value, k: &str) -> String {
    o.get(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn int(o: &Value, k: &str) -> Option<i64> {
    let v = o.get(k)?;
    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
}

fn i32_of(o: &Value, k: &str) -> Option<i32> {
    int(o, k).and_then(|n| i32::try_from(n).ok())
}

fn flag(o: Option<&Value>, k: &str, default: bool) -> bool {
    o.and_then(|o| o.get(k))
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

fn objects(v: &Value) -> impl Iterator<Item = &Value> {
    v.as_array().into_iter().flatten().filter(|e| e.is_object())
}

fn language(o: &Value) -> Option<String> {
    non_empty(o.get("language"))
}

pub fn parse_info(j: &Value) -> Option<PlaybackInfo> {
    let play_session_id = non_empty(j.get("playSessionId"))?;
    j.get("resumeTicks")?;
    let audio = j.get("audioTracks").filter(|v| v.is_array())?;
    let subs = j.get("subtitles").filter(|v| v.is_array())?;
    let direct_url = non_empty(j.get("directUrl"));
    let hls = non_empty(j.get("hlsUrl"));
    if direct_url.is_none() && hls.is_none() {
        return None;
    }
    Some(PlaybackInfo {
        play_session_id,
        media_source_id: string(j, "mediaSourceId"),
        direct_url,
        hls_url: hls.unwrap_or_default(),
        resume_ticks: int(j, "resumeTicks").unwrap_or(0),
        max_bitrate: int(j, "maxBitrate").unwrap_or(0),
        role_max_bitrate: int(j, "roleMaxBitrate"),
        audio_index: i32_of(j, "audioIndex"),
        transcode_reason: non_empty(j.get("transcodeReason")),
        audio_tracks: objects(audio)
            .map(|o| AudioTrack {
                index: i32_of(o, "index").unwrap_or(0),
                title: string(o, "title"),
                language: language(o),
                is_default: flag(Some(o), "isDefault", false),
            })
            .collect(),
        subtitles: objects(subs)
            .filter_map(|o| {
                Some(SubtitleTrack {
                    index: i32_of(o, "index").unwrap_or(0),
                    title: string(o, "title"),
                    language: language(o),
                    url: non_empty(o.get("url"))?,
                    is_default: flag(Some(o), "isDefault", false),
                })
            })
            .collect(),
        trickplay: j.get("trickplay").and_then(parse_trickplay),
    })
}

fn parse_trickplay(o: &Value) -> Option<TrickplayInfo> {
    if !o.is_object() {
        return None;
    }
    let url = non_empty(o.get("url"))?;
    let g = |k: &str| i32_of(o, k).unwrap_or(0);
    let interval_ms = int(o, "interval").unwrap_or(0);
    let t = TrickplayInfo {
        width: g("width"),
        height: g("height"),
        tile_width: g("tileWidth"),
        tile_height: g("tileHeight"),
        count: g("count"),
        interval_ms,
        url,
    };
    let ok = t.width > 0
        && t.height > 0
        && t.tile_width > 0
        && t.tile_height > 0
        && t.count > 0
        && t.interval_ms > 0;
    ok.then_some(t)
}

pub fn parse_item(o: &Value) -> Option<ItemInfo> {
    Some(ItemInfo {
        id: non_empty(o.get("id"))?,
        kind: non_empty(o.get("type")),
        name: string(o, "name"),
        series_name: non_empty(o.get("seriesName")),
        series_id: non_empty(o.get("seriesId")),
        season: i32_of(o, "parentIndexNumber"),
        episode: i32_of(o, "indexNumber"),
    })
}

pub fn parse_segments(j: &Value) -> Vec<Segment> {
    objects(j.get("segments").unwrap_or(&Value::Null))
        .filter_map(|o| {
            let s = o.get("start")?.as_f64()?;
            let e = o.get("end")?.as_f64()?;
            (s.is_finite() && e.is_finite() && e > s).then(|| Segment {
                kind: string(o, "type").to_lowercase(),
                start_sec: s,
                end_sec: e,
            })
        })
        .collect()
}

pub fn parse_chapters(j: &Value) -> Vec<Chapter> {
    objects(j.get("chapters").unwrap_or(&Value::Null))
        .filter_map(|o| {
            let s = o.get("start")?.as_f64()?;
            s.is_finite().then(|| Chapter {
                start_sec: s,
                name: string(o, "name"),
                image: non_empty(o.get("image")),
            })
        })
        .collect()
}

/// `/api/me`: a flag that is not sent counts as true.
pub fn parse_caps(me: &Value) -> ServerCaps {
    let c = me.get("server").and_then(|s| s.get("capabilities"));
    let c = c.filter(|v| v.is_object());
    let segments = match c.and_then(|c| c.get("segments")).and_then(Value::as_array) {
        None => ServerCaps::default().segments,
        Some(a) => a
            .iter()
            .filter_map(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase)
            .collect(),
    };
    let role =
        non_empty(me.get("role")).or_else(|| non_empty(me.get("user").and_then(|u| u.get("role"))));
    ServerCaps {
        chapters: flag(c, "chapters", true),
        trickplay: flag(c, "trickplay", true),
        subtitle_search: flag(c, "subtitleSearch", true),
        postplay: flag(me.get("features"), "postplay", true),
        segments,
        role,
    }
}

fn style_str(o: &Value, k: &str, default: &str) -> String {
    non_empty(o.get(k))
        .filter(|s| s.chars().count() <= 20)
        .unwrap_or_else(|| default.to_string())
}

pub fn parse_prefs(j: &Value) -> Option<PlayerPrefs> {
    let p = j.get("prefs").filter(|v| v.is_object())?;
    let d = PlayerPrefs::default();
    let fd = FlowPrefs::default();
    let sd = SubtitleStyle::default();
    let style = match p.get("subtitleStyle").filter(|v| v.is_object()) {
        None => sd,
        Some(s) => SubtitleStyle {
            size: style_str(s, "size", &sd.size),
            color: style_str(s, "color", &sd.color),
            background: style_str(s, "background", &sd.background),
            font: style_str(s, "font", &sd.font),
        },
    };
    let b = |k: &str, def: bool| flag(Some(p), k, def);
    Some(PlayerPrefs {
        flow: FlowPrefs {
            autoplay_next: b("autoplayNext", fd.autoplay_next),
            auto_skip_intro: b("autoSkipIntro", fd.auto_skip_intro),
            still_watching: b("stillWatching", fd.still_watching),
            still_watching_episodes: i32_of(p, "stillWatchingEpisodes")
                .unwrap_or(fd.still_watching_episodes),
        },
        audio_lang: string(p, "audioLang"),
        subtitle_lang: string(p, "subtitleLang"),
        quality: int(p, "quality").unwrap_or(0),
        subtitle_style: style,
        audio_fx: non_empty(p.get("audioFx"))
            .filter(|s| AUDIO_FX.contains(&s.as_str()))
            .unwrap_or(d.audio_fx),
        anime_original: b("animeOriginal", false),
        postplay: b("postplay", true),
        spoiler_protection: b("spoilerProtection", false),
    })
}

pub fn parse_lang_pref(j: &Value) -> LangPref {
    LangPref {
        audio: non_empty(j.get("audio")),
        subtitle: non_empty(j.get("subtitle")),
        anime: flag(Some(j), "anime", false),
    }
}
