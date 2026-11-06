// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! Pure playback rules for the desktop player. No I/O and no clock: every time is passed in.

use crate::api::ReportKind;
use crate::model::{PlaybackInfo, Segment};
use crate::origin::Origin;

/// A direct file plays only after it opened within this long.
const DIRECT_OPEN_TIMEOUT_MS: u64 = 10_000;
/// Gap between two progress reports while playing.
const PROGRESS_EVERY_MS: u64 = 10_000;
/// The next-episode card shows this long before the end when there is no Outro segment.
const NEXT_CARD_BEFORE_END_MS: u64 = 25_000;
/// Countdown on the next-episode card.
pub const COUNTDOWN_MS: u64 = 10_000;
/// Auto-advances in a row before "still watching?" asks, when the pref is 0.
const STILL_WATCHING_DEFAULT: u32 = 3;
/// "Still watching?" also asks after this long without an interaction.
const STILL_WATCHING_IDLE_MS: u64 = 90 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stream {
    pub url: String,
    pub direct: bool,
}

/// The direct URL if it is on the origin, else the HLS URL if it is, else nothing.
pub fn first_stream(info: &PlaybackInfo, origin: &Origin) -> Option<Stream> {
    if let Some(u) = info.direct_url.as_deref().filter(|u| origin.matches(u)) {
        return Some(Stream {
            url: u.to_string(),
            direct: true,
        });
    }
    origin.matches(&info.hls_url).then(|| Stream {
        url: info.hls_url.clone(),
        direct: false,
    })
}

/// The one-time switch from the direct file to HLS.
#[derive(Debug, Default)]
pub struct Fallback {
    used: bool,
}

impl Fallback {
    /// `playing_after_ms` is how long the stream took to start playing, `None` if it has not (yet) played.
    /// Call it when the open ended, failed or the timeout passed. Returns `true` exactly once: a direct
    /// stream that failed, never played or needed more than 10 s.
    pub fn on_open_result(
        &mut self,
        direct: bool,
        playing_after_ms: Option<u64>,
        failed: bool,
    ) -> bool {
        if self.used || !direct {
            return false;
        }
        let late = playing_after_ms.is_none_or(|ms| ms > DIRECT_OPEN_TIMEOUT_MS);
        if failed || late {
            self.used = true;
            return true;
        }
        false
    }
}

/// When to report to the server: start, every 10 s while playing, on pause/resume/seek, one stop.
#[derive(Debug, Default)]
pub struct ReportClock {
    started: bool,
    stopped: bool,
    last_ms: u64,
}

impl ReportClock {
    pub fn new() -> Self {
        Self::default()
    }

    /// Idempotent while running: a second call keeps the clock as it is.
    pub fn start(&mut self, now_ms: u64) -> ReportKind {
        if self.started && !self.stopped {
            return ReportKind::Start;
        }
        self.started = true;
        self.stopped = false;
        self.last_ms = now_ms;
        ReportKind::Start
    }

    pub fn tick(&mut self, now_ms: u64, paused: bool) -> Option<ReportKind> {
        if !self.started || self.stopped || paused {
            return None;
        }
        if now_ms.saturating_sub(self.last_ms) >= PROGRESS_EVERY_MS {
            self.last_ms = now_ms;
            return Some(ReportKind::Progress);
        }
        None
    }

    /// Pause, resume or seek: report now and restart the 10 s clock.
    /// `None` before `start` and after `stop`.
    pub fn event(&mut self, now_ms: u64) -> Option<ReportKind> {
        if !self.started || self.stopped {
            return None;
        }
        self.last_ms = now_ms;
        Some(ReportKind::Progress)
    }

    pub fn stop(&mut self) -> Option<ReportKind> {
        if self.started && !self.stopped {
            self.stopped = true;
            return Some(ReportKind::Stop);
        }
        None
    }
}

fn is_kind(seg: &Segment, kind: &str) -> bool {
    seg.kind.eq_ignore_ascii_case(kind)
}

/// Segment seconds to whole milliseconds (never negative).
fn ms(sec: f64) -> u64 {
    (sec * 1000.0).max(0.0) as u64
}

/// Where the next-episode card appears: the Outro start (within the duration), else 25 s before the end.
pub fn next_card_at_ms(duration_ms: u64, segments: &[Segment]) -> u64 {
    match segments.iter().find(|s| is_kind(s, "outro")) {
        Some(s) => ms(s.start_sec).min(duration_ms),
        None => duration_ms.saturating_sub(NEXT_CARD_BEFORE_END_MS),
    }
}

/// Mirror of the web's `shouldAsk`: ask when enabled and either the chain of unattended autoplays reached the
/// configured count (default 3) or the last real interaction is 90 minutes old. An interaction resets both.
#[derive(Debug)]
pub struct StillWatching {
    enabled: bool,
    episodes: u32,
    auto_in_a_row: u32,
    last_interaction_ms: u64,
}

impl StillWatching {
    /// `episodes` is the pref `stillWatchingEpisodes`; 0 or less means 3.
    pub fn new(enabled: bool, episodes: i32, now_ms: u64) -> Self {
        Self {
            enabled,
            episodes: u32::try_from(episodes)
                .ok()
                .filter(|n| *n > 0)
                .unwrap_or(STILL_WATCHING_DEFAULT),
            auto_in_a_row: 0,
            last_interaction_ms: now_ms,
        }
    }

    /// The next episode started by itself.
    pub fn on_auto_advance(&mut self) {
        self.auto_in_a_row = self.auto_in_a_row.saturating_add(1);
    }

    pub fn on_interaction(&mut self, now_ms: u64) {
        self.auto_in_a_row = 0;
        self.last_interaction_ms = now_ms;
    }

    /// Answering "yes" counts as an interaction.
    pub fn on_answer_yes(&mut self, now_ms: u64) {
        self.on_interaction(now_ms);
    }

    /// `true` means ask "still watching?".
    pub fn should_ask(&self, now_ms: u64) -> bool {
        self.enabled
            && (self.auto_in_a_row >= self.episodes
                || now_ms.saturating_sub(self.last_interaction_ms) >= STILL_WATCHING_IDLE_MS)
    }
}

/// The skip button for the position: the segment type (as the model stores it) and where to seek to.
/// Only `intro` and `recap`, only if enabled, only while `start <= pos < end` (end clamped to the duration).
pub fn skip_button(
    pos_ms: u64,
    segments: &[Segment],
    enabled: &[String],
    duration_ms: u64,
) -> Option<(String, u64)> {
    segments
        .iter()
        .filter(|s| is_kind(s, "intro") || is_kind(s, "recap"))
        .filter(|s| enabled.iter().any(|e| e.eq_ignore_ascii_case(&s.kind)))
        .find_map(|s| {
            let end = ms(s.end_sec).min(duration_ms);
            (ms(s.start_sec) <= pos_ms && pos_ms < end).then(|| (s.kind.clone(), end))
        })
}

/// Original (when allowed), then the quality menu of the Android app (`QUALITIES`, minus 360p).
pub fn quality_choices(direct_allowed: bool) -> Vec<(&'static str, Option<u64>)> {
    let mut v = Vec::with_capacity(4);
    if direct_allowed {
        v.push(("Original", None));
    }
    v.extend([
        ("1080p", Some(8_000_000)),
        ("720p", Some(4_000_000)),
        ("480p", Some(1_500_000)),
    ]);
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{PlaybackInfo, Segment};
    use crate::origin::Origin;

    fn origin() -> Origin {
        Origin::parse("https://friend.example.com").unwrap()
    }

    fn info(direct: Option<&str>, hls: &str) -> PlaybackInfo {
        PlaybackInfo {
            play_session_id: "p".into(),
            media_source_id: "m".into(),
            direct_url: direct.map(String::from),
            hls_url: hls.into(),
            resume_ticks: 0,
            max_bitrate: 0,
            role_max_bitrate: None,
            audio_index: None,
            transcode_reason: None,
            audio_tracks: vec![],
            subtitles: vec![],
            trickplay: None,
        }
    }

    fn seg(kind: &str, s: f64, e: f64) -> Segment {
        Segment {
            kind: kind.into(),
            start_sec: s,
            end_sec: e,
        }
    }

    #[test]
    fn direct_url_on_origin_wins() {
        let i = info(
            Some("https://friend.example.com/d"),
            "https://friend.example.com/h",
        );
        let s = first_stream(&i, &origin()).unwrap();
        assert!(s.direct);
        assert_eq!(s.url, "https://friend.example.com/d");
    }

    #[test]
    fn foreign_direct_url_falls_to_hls() {
        let i = info(
            Some("https://evil.example.net/d"),
            "https://friend.example.com/h",
        );
        let s = first_stream(&i, &origin()).unwrap();
        assert!(!s.direct);
        assert_eq!(s.url, "https://friend.example.com/h");
    }

    #[test]
    fn both_foreign_none() {
        let i = info(Some("https://evil.example.net/d"), "https://192.0.2.9/h");
        assert!(first_stream(&i, &origin()).is_none());
        assert!(first_stream(&info(None, "https://evil.example.net/h"), &origin()).is_none());
    }

    #[test]
    fn fallback_once_on_timeout_and_failure() {
        let mut f = Fallback::default();
        assert!(!f.on_open_result(true, Some(9_999), false));
        assert!(!f.on_open_result(true, Some(10_000), false));
        assert!(f.on_open_result(true, Some(10_001), false));
        assert!(!f.on_open_result(true, None, true)); // once only

        let mut f = Fallback::default();
        assert!(f.on_open_result(true, None, true));

        let mut f = Fallback::default();
        assert!(f.on_open_result(true, None, false)); // never played

        let mut f = Fallback::default();
        assert!(!f.on_open_result(false, None, true)); // HLS never falls back
        assert!(f.on_open_result(true, None, true)); // and did not use it up
    }

    #[test]
    fn report_clock_schedule() {
        let mut c = ReportClock::new();
        assert_eq!(c.stop(), None); // no stop without a start
        assert_eq!(c.start(1_000), ReportKind::Start);
        assert_eq!(c.tick(5_000, false), None);
        assert_eq!(c.tick(10_999, false), None);
        assert_eq!(c.tick(11_000, false), Some(ReportKind::Progress));
        assert_eq!(c.tick(12_000, false), None);
        assert_eq!(c.tick(21_000, true), None); // paused: nothing
        assert_eq!(c.event(21_500), Some(ReportKind::Progress)); // pause/resume/seek resets
        assert_eq!(c.tick(31_000, false), None);
        assert_eq!(c.tick(31_500, false), Some(ReportKind::Progress));
        assert_eq!(c.event(33_000), Some(ReportKind::Progress)); // seek
        assert_eq!(c.tick(42_999, false), None);
        assert_eq!(c.tick(43_000, false), Some(ReportKind::Progress));
        assert_eq!(c.stop(), Some(ReportKind::Stop));
        assert_eq!(c.stop(), None); // once
        assert_eq!(c.tick(99_000, false), None);
    }

    #[test]
    fn next_card_outro_else_25s() {
        let segs = [seg("intro", 0.0, 60.0), seg("outro", 3_000.5, 3_100.0)];
        assert_eq!(next_card_at_ms(3_200_000, &segs), 3_000_500);
        assert_eq!(next_card_at_ms(3_200_000, &segs[..1]), 3_175_000);
        // case-insensitive
        assert_eq!(
            next_card_at_ms(3_200_000, &[seg("Outro", 10.0, 20.0)]),
            10_000
        );
        // Outro past the duration is clamped
        assert_eq!(
            next_card_at_ms(100_000, &[seg("outro", 500.0, 600.0)]),
            100_000
        );
        // short media
        assert_eq!(next_card_at_ms(20_000, &[]), 0);
        assert_eq!(COUNTDOWN_MS, 10_000);
    }

    #[test]
    fn segments_clamped() {
        let segs = [seg("intro", 10.0, 90.0), seg("recap", 100.0, 500.0)];
        let on = vec!["intro".to_string(), "recap".to_string()];
        assert_eq!(skip_button(9_999, &segs, &on, 600_000), None);
        assert_eq!(
            skip_button(10_000, &segs, &on, 600_000),
            Some(("intro".into(), 90_000))
        );
        assert_eq!(
            skip_button(89_999, &segs, &on, 600_000),
            Some(("intro".into(), 90_000))
        );
        // recap end clamped to the duration
        assert_eq!(
            skip_button(150_000, &segs, &on, 200_000),
            Some(("recap".into(), 200_000))
        );
        assert_eq!(skip_button(200_000, &segs, &on, 200_000), None);
        // disabled types and other types do not show
        assert_eq!(
            skip_button(150_000, &segs, &["recap".to_string()], 600_000),
            Some(("recap".into(), 500_000))
        );
        assert_eq!(skip_button(20_000, &segs, &[], 600_000), None);
        assert_eq!(
            skip_button(
                5_000,
                &[seg("outro", 0.0, 60.0)],
                &["outro".to_string()],
                600_000
            ),
            None
        );
        // enabled list is compared case-insensitively
        assert!(skip_button(20_000, &segs[..1], &["Intro".to_string()], 600_000).is_some());
    }

    const MIN: u64 = 60_000;

    #[test]
    fn still_watching_after_three() {
        let mut s = StillWatching::new(true, 0, 0); // 0 means the default, 3
        s.on_auto_advance();
        s.on_auto_advance();
        assert!(!s.should_ask(MIN));
        s.on_auto_advance();
        assert!(s.should_ask(MIN));
        s.on_answer_yes(2 * MIN);
        assert!(!s.should_ask(2 * MIN));
    }

    #[test]
    fn still_watching_configured_count() {
        let mut s = StillWatching::new(true, 2, 0);
        s.on_auto_advance();
        assert!(!s.should_ask(MIN));
        s.on_auto_advance();
        assert!(s.should_ask(MIN));
    }

    #[test]
    fn still_watching_disabled_never_asks() {
        let mut s = StillWatching::new(false, 1, 0);
        s.on_auto_advance();
        assert!(!s.should_ask(1_000 * MIN));
    }

    #[test]
    fn still_watching_idle_90_minutes() {
        let s = StillWatching::new(true, 3, 0);
        assert!(!s.should_ask(90 * MIN - 1));
        assert!(s.should_ask(90 * MIN));
    }

    #[test]
    fn still_watching_interaction_resets_chain_and_idle() {
        let mut s = StillWatching::new(true, 2, 0);
        s.on_auto_advance();
        s.on_auto_advance();
        s.on_interaction(80 * MIN);
        assert!(!s.should_ask(80 * MIN)); // chain reset
        assert!(!s.should_ask(169 * MIN)); // idle clock restarted
        assert!(s.should_ask(170 * MIN));
    }

    #[test]
    fn report_clock_event_only_while_running() {
        let mut c = ReportClock::new();
        assert_eq!(c.event(500), None); // before start
        assert_eq!(c.start(1_000), ReportKind::Start);
        assert_eq!(c.event(2_000), Some(ReportKind::Progress));
        // a second start while running changes nothing
        assert_eq!(c.start(3_000), ReportKind::Start);
        assert_eq!(c.tick(12_000, false), Some(ReportKind::Progress)); // 10 s after the event at 2_000
        assert_eq!(c.stop(), Some(ReportKind::Stop));
        assert_eq!(c.event(13_000), None); // after stop
    }

    #[test]
    fn quality_choices_without_original() {
        assert_eq!(
            quality_choices(true),
            vec![
                ("Original", None),
                ("1080p", Some(8_000_000)),
                ("720p", Some(4_000_000)),
                ("480p", Some(1_500_000)),
            ]
        );
        assert_eq!(quality_choices(false)[0], ("1080p", Some(8_000_000)));
        assert_eq!(quality_choices(false).len(), 3);
    }
}
