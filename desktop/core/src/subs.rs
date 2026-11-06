// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! Subtitle style to mpv options, and the anime default track pick (port of web `anime.ts`).
use crate::model::{AudioTrack, SubtitleStyle, SubtitleTrack};

pub fn mpv_style(style: &SubtitleStyle) -> Vec<(&'static str, String)> {
    let size = match style.size.as_str() {
        "s" => "38",
        "l" => "60",
        "xl" => "76",
        _ => "48",
    };
    let color = match style.color.as_str() {
        "yellow" => "#ffe14d",
        "cyan" => "#4de8ff",
        "green" => "#6dff7a",
        _ => "#ffffff",
    };
    let font = match style.font.as_str() {
        "serif" => "Georgia",
        "mono" => "Consolas",
        _ => "Segoe UI",
    };
    let mut o = vec![
        ("sub-font-size", size.to_string()),
        ("sub-color", color.to_string()),
        ("sub-font", font.to_string()),
    ];
    match style.background.as_str() {
        "none" => o.push(("sub-border-size", "0".into())),
        "semi" | "solid" => {
            let back = if style.background == "semi" {
                "#A6000000"
            } else {
                "#FF000000"
            };
            o.push(("sub-back-color", back.into()));
            o.push(("sub-border-style", "background-box".into()));
        }
        _ => o.push(("sub-shadow-offset", "2".into())),
    }
    // ASS subtitles keep the file's own style
    o.push(("sub-ass-override", "no".into()));
    o
}

/// ISO 639-2 codes (bibliographic and terminology forms) the server reports for the UI languages.
fn track_codes(lang: &str) -> &'static [&'static str] {
    match lang {
        "de" => &["ger", "deu"],
        "en" => &["eng"],
        "fr" => &["fre", "fra"],
        "es" => &["spa"],
        "it" => &["ita"],
        "tr" => &["tur"],
        "pl" => &["pol"],
        _ => &[],
    }
}

fn is_japanese(lang: Option<&str>) -> bool {
    lang.is_some_and(|l| matches!(l.to_lowercase().as_str(), "jpn" | "ja"))
}

pub fn anime_pick(
    audio: &[AudioTrack],
    subs: &[SubtitleTrack],
    app_lang: &str,
) -> (Option<i32>, Option<i32>) {
    let Some(jp) = audio.iter().find(|t| is_japanese(t.language.as_deref())) else {
        return (None, None);
    };
    let want = track_codes(&app_lang.to_lowercase());
    let sub = subs.iter().find(|t| {
        t.language
            .as_deref()
            .is_some_and(|l| want.contains(&l.to_lowercase().as_str()))
    });
    (Some(jp.index), sub.map(|t| t.index))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(size: &str, color: &str, background: &str, font: &str) -> Vec<(&'static str, String)> {
        mpv_style(&SubtitleStyle {
            size: size.into(),
            color: color.into(),
            background: background.into(),
            font: font.into(),
        })
    }

    fn get(o: &[(&'static str, String)], k: &str) -> Option<String> {
        o.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone())
    }

    #[test]
    fn style_each_value() {
        for (s, n) in [("s", "38"), ("m", "48"), ("l", "60"), ("xl", "76")] {
            assert_eq!(
                get(&opts(s, "white", "none", "sans"), "sub-font-size").as_deref(),
                Some(n)
            );
        }
        for (c, v) in [
            ("white", "#ffffff"),
            ("yellow", "#ffe14d"),
            ("cyan", "#4de8ff"),
            ("green", "#6dff7a"),
        ] {
            assert_eq!(
                get(&opts("m", c, "none", "sans"), "sub-color").as_deref(),
                Some(v)
            );
        }
        for (f, v) in [
            ("sans", "Segoe UI"),
            ("serif", "Georgia"),
            ("mono", "Consolas"),
        ] {
            assert_eq!(
                get(&opts("m", "white", "none", f), "sub-font").as_deref(),
                Some(v)
            );
        }
        let none = opts("m", "white", "none", "sans");
        assert_eq!(get(&none, "sub-shadow-offset"), None);
        assert_eq!(get(&none, "sub-back-color"), None);
        assert_eq!(get(&none, "sub-border-style"), None);
        assert_eq!(get(&none, "sub-border-size").as_deref(), Some("0"));
        let shadow = opts("m", "white", "shadow", "sans");
        assert_eq!(get(&shadow, "sub-shadow-offset").as_deref(), Some("2"));
        assert_eq!(get(&shadow, "sub-back-color"), None);
        let semi = opts("m", "white", "semi", "sans");
        assert_eq!(get(&semi, "sub-back-color").as_deref(), Some("#A6000000"));
        assert_eq!(
            get(&semi, "sub-border-style").as_deref(),
            Some("background-box")
        );
        let solid = opts("m", "white", "solid", "sans");
        assert_eq!(get(&solid, "sub-back-color").as_deref(), Some("#FF000000"));
        assert_eq!(
            get(&solid, "sub-border-style").as_deref(),
            Some("background-box")
        );
        for b in ["none", "shadow", "semi", "solid"] {
            assert_eq!(
                get(&opts("m", "white", b, "sans"), "sub-ass-override").as_deref(),
                Some("no")
            );
        }
    }

    #[test]
    fn style_unknown_falls_back() {
        let o = opts("huge", "pink", "glow", "comic");
        assert_eq!(get(&o, "sub-font-size").as_deref(), Some("48"));
        assert_eq!(get(&o, "sub-color").as_deref(), Some("#ffffff"));
        assert_eq!(get(&o, "sub-font").as_deref(), Some("Segoe UI"));
        assert_eq!(get(&o, "sub-shadow-offset").as_deref(), Some("2"));
        assert_eq!(get(&o, "sub-ass-override").as_deref(), Some("no"));
    }

    fn a(index: i32, lang: Option<&str>) -> AudioTrack {
        AudioTrack {
            index,
            title: String::new(),
            language: lang.map(Into::into),
            is_default: false,
        }
    }

    fn s(index: i32, lang: Option<&str>) -> SubtitleTrack {
        SubtitleTrack {
            index,
            title: String::new(),
            language: lang.map(Into::into),
            url: format!("/sub/{index}"),
            is_default: false,
        }
    }

    #[test]
    fn anime_prefers_japanese_with_app_lang_subs() {
        let audio = [a(1, Some("ger")), a(2, Some("JPN"))];
        let subs = [s(5, Some("eng")), s(6, Some("deu")), s(7, Some("fre"))];
        assert_eq!(anime_pick(&audio, &subs, "de"), (Some(2), Some(6)));
        assert_eq!(anime_pick(&audio, &subs, "en"), (Some(2), Some(5)));
        assert_eq!(anime_pick(&audio, &subs, "fr"), (Some(2), Some(7)));
        // no Polish subtitles: Japanese audio, subtitle stays on the global default
        assert_eq!(anime_pick(&audio, &subs, "pl"), (Some(2), None));
        // a subtitle without a language never matches
        assert_eq!(anime_pick(&audio, &[s(9, None)], "de"), (Some(2), None));
        assert_eq!(
            anime_pick(&[a(3, Some("ja"))], &subs, "de"),
            (Some(3), Some(6))
        );
    }

    #[test]
    fn anime_no_japanese_keeps_none() {
        let audio = [a(1, Some("ger")), a(2, None)];
        let subs = [s(6, Some("deu"))];
        assert_eq!(anime_pick(&audio, &subs, "de"), (None, None));
        assert_eq!(anime_pick(&[], &subs, "de"), (None, None));
    }
}
