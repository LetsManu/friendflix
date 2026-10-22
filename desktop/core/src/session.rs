// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! One player session (spec §4): it drives mpv through `Player` for a title and the episodes that follow it in the same
//! window. All server calls go through `Api`, the shell's side effects (reload, crash dialog, error, web player) through
//! `Host`, and every time through one monotonic `Clock`, so the logic is unit-tested with fakes on any OS.
//! The session cookie is only ever handed to mpv as a header property over the pipe; `Debug` never shows it.
use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::api::{ApiError, InfoAnswer, ReportKind, ServerApi};
use crate::bridge::PlayRequest;
use crate::model::{Chapter, ItemInfo, LangPref, PlaybackInfo, PlayerPrefs, Segment, ServerCaps};
use crate::origin::Origin;
use crate::playback::{
    first_stream, next_card_at_ms, quality_choices, skip_button, Fallback, ReportClock,
    StillWatching, Stream, COUNTDOWN_MS,
};
use crate::profile::device_profile;
use crate::subs::{anime_pick, mpv_style};
use crate::trickplay::{frame, sheet_url, tile_bgra, Frame, SheetCache};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlayerError {
    /// the pipe is closed
    Gone,
    /// mpv answered with an error
    Failed(String),
}

/// One event of mpv's JSON IPC.
#[derive(Debug, Clone, PartialEq)]
pub enum MpvEvent {
    Property {
        name: String,
        data: Value,
    },
    /// `script-message` arguments (`["ff-action", "<json>"]` from the skin)
    Message(Vec<String>),
    FileLoaded,
    PlaybackRestart,
    Seek,
    EndFile {
        reason: String,
    },
    Shutdown,
    Other,
}

impl MpvEvent {
    /// An IPC line that carries `event` (answers to commands carry `request_id` instead).
    pub fn parse(line: &Value) -> Option<MpvEvent> {
        let o = line.as_object()?;
        let event = o.get("event")?.as_str()?;
        Some(match event {
            "property-change" => MpvEvent::Property {
                name: o.get("name")?.as_str()?.to_string(),
                data: o.get("data").cloned().unwrap_or(Value::Null),
            },
            "client-message" => MpvEvent::Message(
                o.get("args")?
                    .as_array()?
                    .iter()
                    .map(|a| a.as_str().map(str::to_string))
                    .collect::<Option<Vec<_>>>()?,
            ),
            "file-loaded" => MpvEvent::FileLoaded,
            "playback-restart" => MpvEvent::PlaybackRestart,
            "seek" => MpvEvent::Seek,
            "end-file" => MpvEvent::EndFile {
                reason: o
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
            },
            "shutdown" => MpvEvent::Shutdown,
            _ => MpvEvent::Other,
        })
    }
}

/// mpv as the session sees it. `events` is taken once; the receiver closes when the pipe closes.
pub trait Player {
    fn command(&self, v: Value) -> Result<Value, PlayerError>;
    fn events(&self) -> Receiver<MpvEvent>;
    /// After the pipe closed: whether mpv exited with status 0 (the viewer quit it), waiting briefly for the exit.
    fn exited_cleanly(&self) -> bool;
}

/// The server calls of a session (implemented by `ServerApi`).
pub trait Api {
    fn info(&self, body: &Value) -> InfoAnswer;
    fn report(&self, kind: ReportKind, body: &Value) -> Result<(), ApiError>;
    fn item(&self, id: &str) -> Result<ItemInfo, ApiError>;
    fn next(&self, id: &str) -> Result<Option<ItemInfo>, ApiError>;
    fn segments(&self, id: &str) -> Result<Vec<Segment>, ApiError>;
    fn chapters(&self, id: &str) -> Result<Vec<Chapter>, ApiError>;
    fn caps(&self) -> Result<ServerCaps, ApiError>;
    fn prefs(&self) -> Result<PlayerPrefs, ApiError>;
    fn lang_pref(&self, id: &str, anime: bool) -> Result<LangPref, ApiError>;
    fn save_lang_pref(
        &self,
        series_id: &str,
        audio: Option<&str>,
        subtitle: Option<&str>,
    ) -> Result<(), ApiError>;
    fn bytes(&self, url: &str) -> Result<Vec<u8>, ApiError>;
}

/// The shell. Events: `ff-reload {}`, `ff-player-crashed {itemId}`, `ff-player-error {itemId, message}`,
/// `ff-open-web {itemId, path}`.
pub trait Host {
    fn emit(&self, event: &str, payload: Value);
}

/// Milliseconds of one monotonic clock, and the backoff sleep.
pub trait Clock {
    fn now_ms(&self) -> u64;
    fn sleep_ms(&self, ms: u64);
}

impl<T: Player + ?Sized> Player for &T {
    fn command(&self, v: Value) -> Result<Value, PlayerError> {
        (**self).command(v)
    }
    fn events(&self) -> Receiver<MpvEvent> {
        (**self).events()
    }
    fn exited_cleanly(&self) -> bool {
        (**self).exited_cleanly()
    }
}

impl<T: Api + ?Sized> Api for &T {
    fn info(&self, body: &Value) -> InfoAnswer {
        (**self).info(body)
    }
    fn report(&self, kind: ReportKind, body: &Value) -> Result<(), ApiError> {
        (**self).report(kind, body)
    }
    fn item(&self, id: &str) -> Result<ItemInfo, ApiError> {
        (**self).item(id)
    }
    fn next(&self, id: &str) -> Result<Option<ItemInfo>, ApiError> {
        (**self).next(id)
    }
    fn segments(&self, id: &str) -> Result<Vec<Segment>, ApiError> {
        (**self).segments(id)
    }
    fn chapters(&self, id: &str) -> Result<Vec<Chapter>, ApiError> {
        (**self).chapters(id)
    }
    fn caps(&self) -> Result<ServerCaps, ApiError> {
        (**self).caps()
    }
    fn prefs(&self) -> Result<PlayerPrefs, ApiError> {
        (**self).prefs()
    }
    fn lang_pref(&self, id: &str, anime: bool) -> Result<LangPref, ApiError> {
        (**self).lang_pref(id, anime)
    }
    fn save_lang_pref(
        &self,
        series_id: &str,
        audio: Option<&str>,
        subtitle: Option<&str>,
    ) -> Result<(), ApiError> {
        (**self).save_lang_pref(series_id, audio, subtitle)
    }
    fn bytes(&self, url: &str) -> Result<Vec<u8>, ApiError> {
        (**self).bytes(url)
    }
}

impl<T: Host + ?Sized> Host for &T {
    fn emit(&self, event: &str, payload: Value) {
        (**self).emit(event, payload)
    }
}

impl<T: Clock + ?Sized> Clock for &T {
    fn now_ms(&self) -> u64 {
        (**self).now_ms()
    }
    fn sleep_ms(&self, ms: u64) {
        (**self).sleep_ms(ms)
    }
}

/// How a session ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// back, end of the title or the window was closed
    Closed,
    /// a 401: the web app reloads and shows sign-in
    Unauthorized,
    /// mpv went away without a normal stop
    Crashed,
    /// the start failed with this message
    Failed(String),
    /// the web player takes over (a 409 profile answer) at this path
    OpenInWeb(String),
}

/// What a session needs besides its collaborators.
#[derive(Clone)]
pub struct SessionConfig {
    pub origin: Origin,
    /// the `Cookie` header value for the server origin
    pub cookie: String,
    pub profile_id: String,
    /// the app language for the anime default (`de`, `en`, …)
    pub app_lang: String,
    /// where trickplay tiles are written (deleted when the session ends); `None` disables previews
    pub temp_dir: Option<PathBuf>,
}

impl fmt::Debug for SessionConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionConfig")
            .field("origin", &self.origin)
            .field("profile_id", &self.profile_id)
            .field("app_lang", &self.app_lang)
            .finish_non_exhaustive()
    }
}

/// The real clock: milliseconds since the session's start on `Instant` (monotonic), real sleeps.
#[derive(Debug, Clone, Copy)]
pub struct MonotonicClock {
    start: Instant,
}

impl MonotonicClock {
    pub fn new() -> Self {
        MonotonicClock {
            start: Instant::now(),
        }
    }
}

impl Default for MonotonicClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for MonotonicClock {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
    fn sleep_ms(&self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

impl Api for ServerApi {
    fn info(&self, body: &Value) -> InfoAnswer {
        ServerApi::info(self, body)
    }
    fn report(&self, kind: ReportKind, body: &Value) -> Result<(), ApiError> {
        ServerApi::report(self, kind, body)
    }
    fn item(&self, id: &str) -> Result<ItemInfo, ApiError> {
        ServerApi::item(self, id)
    }
    fn next(&self, id: &str) -> Result<Option<ItemInfo>, ApiError> {
        ServerApi::next(self, id)
    }
    fn segments(&self, id: &str) -> Result<Vec<Segment>, ApiError> {
        ServerApi::segments(self, id)
    }
    fn chapters(&self, id: &str) -> Result<Vec<Chapter>, ApiError> {
        ServerApi::chapters(self, id)
    }
    fn caps(&self) -> Result<ServerCaps, ApiError> {
        ServerApi::caps(self)
    }
    fn prefs(&self) -> Result<PlayerPrefs, ApiError> {
        ServerApi::prefs(self)
    }
    fn lang_pref(&self, id: &str, anime: bool) -> Result<LangPref, ApiError> {
        ServerApi::lang_pref(self, id, anime)
    }
    fn save_lang_pref(
        &self,
        series_id: &str,
        audio: Option<&str>,
        subtitle: Option<&str>,
    ) -> Result<(), ApiError> {
        ServerApi::save_lang_pref(self, series_id, audio, subtitle)
    }
    fn bytes(&self, url: &str) -> Result<Vec<u8>, ApiError> {
        ServerApi::bytes(self, url)
    }
}

const TICKS_PER_MS: i64 = 10_000;
/// The direct file must play within this long, else HLS takes over (once).
const DIRECT_OPEN_MS: u64 = 10_000;
/// Buffering (or an HLS open) longer than this reloads the stream at the position.
const STALL_MS: u64 = 15_000;
const MAX_RELOADS: u32 = 3;
/// Backoff of the `playback/info` retries on 5xx or network errors.
const BACKOFF_MS: [u64; 3] = [1_000, 2_000, 4_000];
/// How often `run` wakes without an mpv event.
const TICK_MS: u64 = 250;
/// How long after the session's own seek mpv's `seek` event is taken as that seek.
const OWN_SEEK_MS: u64 = 2_000;
/// The range of a saved quality cap the server accepts (Android `infoBody`).
const BITRATES: std::ops::RangeInclusive<i64> = 300_000..=200_000_000;
/// The skin's mpv script name (`friendflix.lua`).
const SCRIPT: &str = "friendflix";
const OBSERVED: [&str; 4] = ["pause", "time-pos", "duration", "paused-for-cache"];

const GENERIC: &str = "Can’t play this.";
const CONNECTION: &str = "The connection to the server was lost or the video is damaged.";
const LATE: &str = "The original did not start in time";
const BROKEN: &str = "The original could not be opened";

fn max_streams_text(n: u32) -> String {
    if n == 1 {
        "At most 1 stream at a time is allowed.".into()
    } else {
        format!("At most {n} streams at a time are allowed.")
    }
}

fn header_safe(v: &str) -> bool {
    !v.is_empty() && !v.chars().any(|c| c == '\r' || c == '\n' || c == '\0')
}

fn secs(ms: u64) -> String {
    format!("{}.{:03}", ms / 1000, ms % 1000)
}

/// `S1:E3 · Name` for an episode with numbers, else the name.
fn title_of(i: &ItemInfo) -> String {
    match (i.kind.as_deref(), i.season, i.episode) {
        (Some("Episode"), Some(s), Some(e)) => format!("S{s}:E{e} · {}", i.name),
        _ => i.name.clone(),
    }
}

fn track_label(title: &str, lang: Option<&str>, index: i32) -> String {
    if !title.is_empty() {
        title.to_string()
    } else if let Some(l) = lang {
        l.to_string()
    } else {
        format!("Track {index}")
    }
}

pub struct Session<P: Player, A: Api, H: Host, C: Clock> {
    cfg: SessionConfig,
    player: P,
    api: A,
    host: H,
    clock: C,
    // the title
    item_id: String,
    start_ms: Option<u64>,
    want_audio: Option<String>,
    want_sub: Option<String>,
    first_title: bool,
    prefs: PlayerPrefs,
    caps: ServerCaps,
    item: Option<ItemInfo>,
    next: Option<ItemInfo>,
    segments: Vec<Segment>,
    chapters: Vec<Chapter>,
    lang: LangPref,
    anime_default: bool,
    still: StillWatching,
    // the stream (URLs resolved against the origin)
    info: Option<PlaybackInfo>,
    stream: Option<Stream>,
    direct_allowed: bool,
    force_hls: bool,
    fallback: Fallback,
    fallback_reason: Option<&'static str>,
    quality: Option<u64>,
    audio_index: Option<i32>,
    sub_index: Option<i32>,
    sub_chosen: bool,
    /// server subtitle index -> mpv track id
    sub_ids: HashMap<i32, i64>,
    report: ReportClock,
    started: bool,
    // mpv
    pos_ms: u64,
    duration_ms: u64,
    paused: bool,
    opening_since: Option<u64>,
    buffering_since: Option<u64>,
    reloads: u32,
    reconnecting: bool,
    // next episode
    card_since: Option<u64>,
    next_cancelled: bool,
    ask_still: bool,
    auto_skipped: Option<u64>,
    /// a seek the session issued itself: the next `seek` event (until this time) is not the viewer's
    own_seek_until: Option<u64>,
    // trickplay
    sheets: SheetCache,
    /// the tile files written so far (two at most, used in turn) and the frame in the last one
    previews: Vec<PathBuf>,
    preview_last: Option<(Frame, PathBuf)>,
    last_state: String,
    outcome: Option<Outcome>,
}

impl<P: Player, A: Api, H: Host, C: Clock> fmt::Debug for Session<P, A, H, C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session")
            .field("cfg", &self.cfg)
            .field("item_id", &self.item_id)
            .field("direct", &self.stream.as_ref().map(|s| s.direct))
            .field("started", &self.started)
            .field("outcome", &self.outcome)
            .finish_non_exhaustive()
    }
}

impl<P: Player, A: Api, H: Host, C: Clock> Session<P, A, H, C> {
    pub fn new(cfg: SessionConfig, req: PlayRequest, player: P, api: A, host: H, clock: C) -> Self {
        let now = clock.now_ms();
        Session {
            cfg,
            player,
            api,
            host,
            clock,
            item_id: req.item_id,
            start_ms: req.start_ms,
            want_audio: req.audio,
            want_sub: req.subtitle,
            first_title: true,
            prefs: PlayerPrefs::default(),
            caps: ServerCaps::default(),
            item: None,
            next: None,
            segments: vec![],
            chapters: vec![],
            lang: LangPref {
                audio: None,
                subtitle: None,
                anime: false,
            },
            anime_default: false,
            still: StillWatching::new(false, 0, now),
            info: None,
            stream: None,
            direct_allowed: false,
            force_hls: false,
            fallback: Fallback::default(),
            fallback_reason: None,
            quality: None,
            audio_index: None,
            sub_index: None,
            sub_chosen: false,
            sub_ids: HashMap::new(),
            report: ReportClock::new(),
            started: false,
            pos_ms: 0,
            duration_ms: 0,
            paused: false,
            opening_since: None,
            buffering_since: None,
            reloads: 0,
            reconnecting: false,
            card_since: None,
            next_cancelled: false,
            ask_still: false,
            auto_skipped: None,
            own_seek_until: None,
            sheets: SheetCache::new(),
            previews: vec![],
            preview_last: None,
            last_state: String::new(),
            outcome: None,
        }
    }

    pub fn outcome(&self) -> Option<&Outcome> {
        self.outcome.as_ref()
    }

    /// The item that plays now (it changes with the next episode).
    pub fn item_id(&self) -> &str {
        &self.item_id
    }

    fn done(&self) -> bool {
        self.outcome.is_some()
    }

    fn now(&self) -> u64 {
        self.clock.now_ms()
    }

    /// Runs the session until it ends: start, then mpv's events and a tick every 250 ms.
    pub fn run(mut self) -> Outcome {
        let events = self.player.events();
        self.start();
        while !self.done() {
            match events.recv_timeout(Duration::from_millis(TICK_MS)) {
                Ok(ev) => self.handle(ev),
                Err(RecvTimeoutError::Timeout) => {}
                // mpv's IPC closes the pipe on shutdown without an event: the exit status tells a quit from a crash
                Err(RecvTimeoutError::Disconnected) => {
                    if self.player.exited_cleanly() {
                        self.close(false);
                    } else {
                        self.crashed();
                    }
                }
            }
            self.tick();
        }
        self.outcome.take().unwrap_or(Outcome::Closed)
    }

    /// Observes mpv's properties, loads the title and opens its stream.
    pub fn start(&mut self) {
        for (i, name) in OBSERVED.iter().enumerate() {
            let _ = self
                .player
                .command(json!(["observe_property", i + 1, name]));
        }
        self.load_title();
        if self.done() {
            return;
        }
        self.open(self.start_ms);
    }

    pub fn handle(&mut self, ev: MpvEvent) {
        if self.done() {
            return;
        }
        match ev {
            MpvEvent::Property { name, data } => self.on_property(&name, &data),
            MpvEvent::Message(args) => {
                if args.first().map(String::as_str) == Some("ff-action") {
                    if let Some(a) = args.get(1).and_then(|s| serde_json::from_str(s).ok()) {
                        self.on_action(&a);
                    }
                }
            }
            MpvEvent::FileLoaded => self.on_file_loaded(),
            MpvEvent::PlaybackRestart => self.on_playing(),
            MpvEvent::Seek => {
                if self.opening_since.is_none() {
                    let now = self.now();
                    let own = self.own_seek_until.take().is_some_and(|t| now <= t);
                    if !own {
                        self.still.on_interaction(now);
                    }
                    if let Some(k) = self.report.event(now) {
                        self.send_report(k);
                    }
                }
            }
            MpvEvent::EndFile { reason } => self.on_end(&reason),
            // the viewer closed mpv's window
            MpvEvent::Shutdown => self.close(false),
            MpvEvent::Other => {}
        }
        if !self.done() {
            self.send_state();
        }
    }

    pub fn tick(&mut self) {
        if self.done() {
            return;
        }
        let now = self.now();
        let direct = self.stream.as_ref().is_some_and(|s| s.direct);
        if let Some(t0) = self.opening_since.filter(|_| direct) {
            if now.saturating_sub(t0) > DIRECT_OPEN_MS {
                // the open ended by timeout: only now may the fallback be asked
                self.opening_since = None;
                if self.fallback.on_open_result(true, None, false) {
                    self.switch_to_hls(LATE);
                } else {
                    self.buffering_since.get_or_insert(t0);
                }
            }
        }
        if self.done() {
            return;
        }
        let direct = self.stream.as_ref().is_some_and(|s| s.direct);
        let stall_from = if direct {
            self.buffering_since
        } else {
            self.opening_since.or(self.buffering_since)
        };
        if stall_from.is_some_and(|t| now.saturating_sub(t) > STALL_MS) {
            self.reconnect();
            if self.done() {
                return;
            }
        }
        if let Some(k) = self.report.tick(now, self.paused) {
            self.send_report(k);
        }
        if self.done() {
            return;
        }
        self.next_card(now);
        if self.done() {
            return;
        }
        self.auto_skip();
        if !self.done() {
            self.send_state();
        }
    }

    // ---- the title ----

    /// `Ok`, else `None`; a 401 ends the session.
    fn api_ok<T>(&mut self, r: Result<T, ApiError>) -> Option<T> {
        match r {
            Ok(v) => Some(v),
            Err(ApiError::Unauthorized) => {
                self.unauthorized();
                None
            }
            Err(_) => None,
        }
    }

    fn load_title(&mut self) {
        if self.first_title {
            self.first_title = false;
            if let Some(p) = self.api_ok(self.api.prefs()) {
                self.prefs = p;
            }
            if self.done() {
                return;
            }
            if let Some(c) = self.api_ok(self.api.caps()) {
                self.caps = c;
            }
            if self.done() {
                return;
            }
            let f = &self.prefs.flow;
            self.still =
                StillWatching::new(f.still_watching, f.still_watching_episodes, self.now());
            if BITRATES.contains(&self.prefs.quality) {
                self.quality = Some(self.prefs.quality as u64);
            }
        }
        let id = self.item_id.clone();
        self.item = self.api_ok(self.api.item(&id));
        if self.done() {
            return;
        }
        let episode = self
            .item
            .as_ref()
            .is_some_and(|i| i.kind.as_deref() == Some("Episode"));
        self.next = None;
        if episode {
            self.next = self.api_ok(self.api.next(&id)).flatten();
            if self.done() {
                return;
            }
        }
        let segments = self.api_ok(self.api.segments(&id)).unwrap_or_default();
        if self.done() {
            return;
        }
        let allowed = &self.caps.segments;
        self.segments = segments
            .into_iter()
            .filter(|s| allowed.iter().any(|a| a.eq_ignore_ascii_case(&s.kind)))
            .collect();
        self.chapters = vec![];
        if self.caps.chapters {
            let mut c = self.api_ok(self.api.chapters(&id)).unwrap_or_default();
            if self.done() {
                return;
            }
            c.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));
            c.dedup_by(|a, b| (a.start_sec * 1000.0).round() == (b.start_sec * 1000.0).round());
            self.chapters = c;
        }
        self.lang = LangPref {
            audio: None,
            subtitle: None,
            anime: false,
        };
        if episode {
            let series = self
                .item
                .as_ref()
                .and_then(|i| i.series_id.clone())
                .unwrap_or_else(|| id.clone());
            let anime = self.prefs.anime_original;
            if let Some(l) = self.api_ok(self.api.lang_pref(&series, anime)) {
                self.lang = l;
            }
            if self.done() {
                return;
            }
        }
        self.anime_default = self.prefs.anime_original
            && self.lang.anime
            && self.lang.audio.is_none()
            && self.lang.subtitle.is_none();
    }

    /// The audio language asked for at the start: the link's, the series', the anime default, the global one.
    fn audio_lang(&self) -> Option<String> {
        self.want_audio
            .clone()
            .or_else(|| self.lang.audio.clone())
            .or_else(|| self.anime_default.then(|| "jpn".to_string()))
            .or_else(|| Some(self.prefs.audio_lang.clone()))
            .filter(|l| !l.is_empty() && l.len() <= 16)
    }

    fn info_body(&self, start_ms: Option<u64>) -> Value {
        let mut b = Map::new();
        b.insert("itemId".into(), json!(self.item_id));
        let hint = if self.quality.is_some() {
            "manual"
        } else {
            "network"
        };
        b.insert("reasonHint".into(), json!(hint));
        if let Some(ms) = start_ms {
            b.insert("startTicks".into(), json!(ms as i64 * TICKS_PER_MS));
        }
        match self.audio_index {
            Some(a) => {
                b.insert("audioIndex".into(), json!(a));
            }
            None => {
                if let Some(l) = self.audio_lang() {
                    b.insert("audioLang".into(), json!(l));
                }
            }
        }
        if let Some(q) = self.quality {
            b.insert("maxBitrate".into(), json!(q));
        }
        b.insert("caps".into(), device_profile());
        Value::Object(b)
    }

    // ---- the stream ----

    /// `POST /api/playback/info` (3 retries on 5xx/network), then the stream.
    fn open(&mut self, start_ms: Option<u64>) {
        let body = self.info_body(start_ms);
        let mut answer = self.api.info(&body);
        for wait in BACKOFF_MS {
            if !matches!(answer, InfoAnswer::Retry) {
                break;
            }
            self.clock.sleep_ms(wait);
            answer = self.api.info(&body);
        }
        match answer {
            InfoAnswer::Ok(info) => self.attach(info, start_ms),
            InfoAnswer::MaxStreams(n) => self.fail(max_streams_text(n)),
            InfoAnswer::Unauthorized => self.unauthorized(),
            InfoAnswer::Refused => self.fail(GENERIC.into()),
            InfoAnswer::ProfileMismatch => self.open_web(start_ms),
            InfoAnswer::Retry => self.fail(CONNECTION.into()),
        }
    }

    fn attach(&mut self, mut info: PlaybackInfo, start_ms: Option<u64>) {
        let start = start_ms.unwrap_or((info.resume_ticks.max(0) / TICKS_PER_MS) as u64);
        let origin = &self.cfg.origin;
        info.direct_url = info.direct_url.as_deref().and_then(|u| origin.resolve(u));
        if info.direct_url.is_some() {
            // the server allows the original for this title: the quality menu offers it even on HLS
            self.direct_allowed = true;
        }
        if self.force_hls {
            info.direct_url = None;
        }
        info.hls_url = origin.resolve(&info.hls_url).unwrap_or_default();
        let Some(stream) = first_stream(&info, origin) else {
            return self.fail(GENERIC.into());
        };
        if info.audio_index.is_some() {
            self.audio_index = info.audio_index;
        }
        let title = self.item.as_ref().map(title_of).unwrap_or_default();
        self.info = Some(info);
        self.report = ReportClock::new();
        self.started = false;
        self.reloads = 0;
        self.set_headers();
        for (k, v) in mpv_style(&self.prefs.subtitle_style) {
            let _ = self.player.command(json!(["set_property", k, v]));
        }
        let _ = self
            .player
            .command(json!(["set_property", "force-media-title", title]));
        let url = stream.url.clone();
        self.stream = Some(stream);
        self.load(&url, start);
    }

    /// The cookie and the profile header go to mpv only here, before any `loadfile`. mpv sends these headers with every
    /// HTTP request it makes, so it must only ever be given server URLs: the stream, subtitle (`sub-add`) and trickplay
    /// URLs are all resolved with `Origin::resolve` (on-origin only) first; nothing else is loaded.
    fn set_headers(&self) {
        let mut h = vec![];
        if header_safe(&self.cfg.cookie) {
            h.push(format!("Cookie: {}", self.cfg.cookie));
        }
        if header_safe(&self.cfg.profile_id) {
            h.push(format!("x-ff-profile: {}", self.cfg.profile_id));
        }
        let _ = self
            .player
            .command(json!(["set_property", "http-header-fields", h]));
    }

    fn load(&mut self, url: &str, start_ms: u64) {
        let _ = self.player.command(json!({
            "name": "loadfile", "url": url, "flags": "replace",
            "options": format!("start={}", secs(start_ms)),
        }));
        self.pos_ms = start_ms;
        self.opening_since = Some(self.now());
        self.buffering_since = None;
        self.send_state();
    }

    /// The one switch from the direct file to HLS at the same position.
    fn switch_to_hls(&mut self, reason: &'static str) {
        self.fallback_reason = Some(reason);
        self.force_hls = true;
        let hls = self
            .info
            .as_ref()
            .map(|i| i.hls_url.clone())
            .unwrap_or_default();
        if !self.cfg.origin.matches(&hls) {
            return self.fail(GENERIC.into());
        }
        self.stream = Some(Stream {
            url: hls.clone(),
            direct: false,
        });
        self.load(&hls, self.pos_ms);
    }

    /// A stall: reload at the position, up to 3 times.
    fn reconnect(&mut self) {
        if self.reloads >= MAX_RELOADS {
            return self.fail(CONNECTION.into());
        }
        self.reloads += 1;
        self.reconnecting = true;
        if let Some(url) = self.stream.as_ref().map(|s| s.url.clone()) {
            self.load(&url, self.pos_ms);
        }
    }

    /// A new play session for the same title at the position (audio track on HLS, quality).
    fn switch_stream(&mut self) {
        let pos = self.pos_ms;
        self.stop_report();
        if !self.done() {
            self.open(Some(pos));
        }
    }

    // ---- mpv events ----

    fn on_property(&mut self, name: &str, data: &Value) {
        let now = self.now();
        match name {
            "pause" => {
                let p = data.as_bool().unwrap_or(false);
                if p != self.paused {
                    self.paused = p;
                    if !self.ask_still {
                        self.still.on_interaction(now);
                    }
                    if let Some(k) = self.report.event(now) {
                        self.send_report(k);
                    }
                }
            }
            "time-pos" => {
                if let Some(t) = data.as_f64().filter(|t| t.is_finite()) {
                    self.pos_ms = (t * 1000.0).round().max(0.0) as u64;
                }
            }
            "duration" => {
                self.duration_ms = data
                    .as_f64()
                    .filter(|d| d.is_finite())
                    .map_or(0, |d| (d * 1000.0).round().max(0.0) as u64);
            }
            "paused-for-cache" => {
                if data.as_bool() == Some(true) {
                    self.buffering_since.get_or_insert(now);
                } else {
                    self.buffering_since = None;
                }
            }
            _ => {}
        }
    }

    /// External subtitles (they belong to the loaded file), then the audio and subtitle choice.
    fn on_file_loaded(&mut self) {
        let Some(info) = self.info.clone() else {
            return;
        };
        let origin = self.cfg.origin.clone();
        let mut urls = HashMap::new();
        for s in &info.subtitles {
            if let Some(u) = origin.resolve(&s.url) {
                let lang = s.language.clone().unwrap_or_default();
                let _ = self
                    .player
                    .command(json!(["sub-add", u, "auto", s.title, lang]));
                urls.insert(u, s.index);
            }
        }
        self.sub_ids.clear();
        if let Ok(Value::Array(tracks)) = self.player.command(json!(["get_property", "track-list"]))
        {
            for t in &tracks {
                let file = t.get("external-filename").and_then(Value::as_str);
                if let (Some("sub"), Some(f), Some(id)) = (
                    t.get("type").and_then(Value::as_str),
                    file,
                    t.get("id").and_then(Value::as_i64),
                ) {
                    if let Some(index) = urls.get(f) {
                        self.sub_ids.insert(*index, id);
                    }
                }
            }
        }
        let direct = self.stream.as_ref().is_some_and(|s| s.direct);
        if direct {
            if let Some(k) = self
                .audio_index
                .and_then(|a| info.audio_tracks.iter().position(|t| t.index == a))
            {
                let _ = self.player.command(json!(["set_property", "aid", k + 1]));
            }
        }
        if !self.sub_chosen {
            self.sub_chosen = true;
            self.sub_index = self.initial_sub(&info);
        }
        self.apply_sub();
    }

    /// The link's pick, else the series' saved choice (when this episode has it), else the anime default (while the
    /// Japanese track plays), else the global subtitle language.
    fn initial_sub(&self, info: &PlaybackInfo) -> Option<i32> {
        let lang_of = |l: &str| {
            info.subtitles
                .iter()
                .find(|s| s.language.as_deref() == Some(l))
                .map(|s| s.index)
        };
        match self.want_sub.as_deref() {
            Some("off") => return None,
            Some(l) => return lang_of(l),
            None => {}
        }
        match self.lang.subtitle.as_deref() {
            Some("off") => return None,
            Some(l) if lang_of(l).is_some() => return lang_of(l),
            _ => {}
        }
        if self.anime_default && self.want_audio.is_none() {
            let playing = info
                .audio_tracks
                .iter()
                .find(|a| Some(a.index) == self.audio_index)
                .or_else(|| info.audio_tracks.iter().find(|a| a.is_default));
            let (jp, sub) = anime_pick(&info.audio_tracks, &info.subtitles, &self.cfg.app_lang);
            if jp.is_some() && playing.map(|a| a.index) == jp && sub.is_some() {
                return sub;
            }
        }
        Some(self.prefs.subtitle_lang.as_str())
            .filter(|l| !l.is_empty())
            .and_then(lang_of)
    }

    fn apply_sub(&self) {
        let sid = match self.sub_index.and_then(|i| self.sub_ids.get(&i)) {
            Some(id) => json!(id),
            None => json!("no"),
        };
        let _ = self.player.command(json!(["set_property", "sid", sid]));
    }

    fn on_playing(&mut self) {
        let now = self.now();
        if self.reconnecting {
            // the stall is over: the next one gets its own 3 tries
            self.reloads = 0;
        }
        self.reconnecting = false;
        self.buffering_since = None;
        if let Some(t0) = self.opening_since.take() {
            let direct = self.stream.as_ref().is_some_and(|s| s.direct);
            if self
                .fallback
                .on_open_result(direct, Some(now.saturating_sub(t0)), false)
            {
                return self.switch_to_hls(LATE);
            }
        }
        if !self.started {
            self.started = true;
            let k = self.report.start(now);
            self.send_report(k);
        }
    }

    fn on_end(&mut self, reason: &str) {
        match reason {
            "eof" => {
                self.stop_report();
                if self.done() {
                    return;
                }
                if self.next.is_some() && !self.next_cancelled {
                    // autoplay goes on at once; without it the card stays for "Play now" or back
                    if self.prefs.flow.autoplay_next && !self.ask_still {
                        self.auto_next(self.now());
                    }
                } else {
                    self.close(true);
                }
            }
            "error" => {
                if self.opening_since.take().is_some() {
                    let direct = self.stream.as_ref().is_some_and(|s| s.direct);
                    if self.fallback.on_open_result(direct, None, true) {
                        return self.switch_to_hls(BROKEN);
                    }
                }
                self.reconnect();
            }
            // the viewer quit mpv (window closed, `q`)
            "quit" => self.close(false),
            // stop (our own loadfile replace), redirect
            _ => {}
        }
    }

    // ---- next episode and still watching ----

    fn next_card(&mut self, now: u64) {
        if self.next.is_none() || self.duration_ms == 0 || !self.started {
            self.card_since = None;
            return;
        }
        if self.pos_ms < next_card_at_ms(self.duration_ms, &self.segments) || self.next_cancelled {
            self.card_since = None;
            return;
        }
        let since = *self.card_since.get_or_insert(now);
        if self.prefs.flow.autoplay_next
            && !self.ask_still
            && now.saturating_sub(since) >= COUNTDOWN_MS
        {
            self.auto_next(now);
        }
    }

    fn auto_next(&mut self, now: u64) {
        if self.still.should_ask(now) {
            self.ask_still = true;
            let _ = self.player.command(json!(["set_property", "pause", true]));
        } else {
            self.still.on_auto_advance();
            self.play_next();
        }
    }

    /// The next episode in the same mpv: stop for this one, its title, a new `playback/info`, `loadfile … replace`.
    fn play_next(&mut self) {
        let Some(next) = self.next.take() else {
            return;
        };
        self.stop_report();
        if self.done() {
            return;
        }
        self.item_id = next.id;
        self.start_ms = None;
        self.want_audio = None;
        self.want_sub = None;
        self.audio_index = None;
        self.sub_index = None;
        self.sub_chosen = false;
        self.card_since = None;
        self.next_cancelled = false;
        self.ask_still = false;
        self.auto_skipped = None;
        self.fallback = Fallback::default();
        self.fallback_reason = None;
        self.force_hls = false;
        self.direct_allowed = false;
        self.info = None;
        self.stream = None;
        self.started = false;
        self.pos_ms = 0;
        self.duration_ms = 0;
        self.sheets = SheetCache::new();
        self.preview_last = None;
        let _ = self.player.command(json!(["set_property", "pause", false]));
        self.load_title();
        if !self.done() {
            self.open(None);
        }
    }

    fn skip(&self) -> Option<(String, u64)> {
        skip_button(
            self.pos_ms,
            &self.segments,
            &self.caps.segments,
            self.duration_ms,
        )
    }

    fn auto_skip(&mut self) {
        if !self.prefs.flow.auto_skip_intro || !self.started {
            return;
        }
        if let Some((kind, end)) = self.skip() {
            if kind.eq_ignore_ascii_case("intro") && self.auto_skipped != Some(end) {
                self.auto_skipped = Some(end);
                self.seek(end);
            }
        }
    }

    fn seek(&mut self, ms: u64) {
        self.own_seek_until = Some(self.now() + OWN_SEEK_MS);
        let _ = self
            .player
            .command(json!(["seek", secs(ms), "absolute+exact"]));
    }

    // ---- the skin's actions ----

    fn on_action(&mut self, a: &Value) {
        let now = self.now();
        let kind = a.get("a").and_then(Value::as_str).unwrap_or("");
        let id = a
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if kind != "preview" {
            self.still.on_interaction(now);
        }
        match kind {
            "back" => self.close(true),
            "next" => self.play_next(),
            "cancelNext" => {
                self.next_cancelled = true;
                self.card_since = None;
            }
            "skip" => {
                if let Some((_, end)) = self.skip() {
                    self.seek(end);
                }
            }
            "stillYes" => {
                self.still.on_answer_yes(now);
                let asked = std::mem::replace(&mut self.ask_still, false);
                let _ = self.player.command(json!(["set_property", "pause", false]));
                if asked {
                    self.play_next();
                }
            }
            "audio" => self.pick_audio(&id),
            "sub" => self.pick_sub(&id),
            "quality" => self.pick_quality(&id),
            "preview" => {
                let t = a.get("tMs").and_then(Value::as_u64).unwrap_or(0);
                self.preview(t);
            }
            _ => {}
        }
    }

    fn save_lang(&mut self, audio: Option<&str>, subtitle: Option<&str>) {
        let Some(series) = self.item.as_ref().and_then(|i| i.series_id.clone()) else {
            return;
        };
        let r = self.api.save_lang_pref(&series, audio, subtitle);
        self.api_ok(r);
    }

    fn pick_audio(&mut self, id: &str) {
        let Ok(index) = id.parse::<i32>() else {
            return;
        };
        let Some(info) = &self.info else {
            return;
        };
        let Some(k) = info.audio_tracks.iter().position(|t| t.index == index) else {
            return;
        };
        let lang = info.audio_tracks[k].language.clone();
        self.audio_index = Some(index);
        if self.stream.as_ref().is_some_and(|s| s.direct) {
            let _ = self.player.command(json!(["set_property", "aid", k + 1]));
        } else {
            self.switch_stream();
        }
        if let (Some(l), false) = (lang, self.done()) {
            self.save_lang(Some(&l), None);
        }
    }

    fn pick_sub(&mut self, id: &str) {
        if id == "off" {
            self.sub_index = None;
            self.apply_sub();
            return self.save_lang(None, Some("off"));
        }
        let Ok(index) = id.parse::<i32>() else {
            return;
        };
        let Some(track) = self
            .info
            .as_ref()
            .and_then(|i| i.subtitles.iter().find(|s| s.index == index))
        else {
            return;
        };
        let lang = track.language.clone();
        self.sub_index = Some(index);
        self.apply_sub();
        if let Some(l) = lang {
            self.save_lang(None, Some(&l));
        }
    }

    fn pick_quality(&mut self, id: &str) {
        let choices = quality_choices(self.direct_allowed);
        let wanted = if id == "orig" {
            None
        } else {
            match id.parse::<u64>() {
                Ok(b) => Some(b),
                Err(_) => return,
            }
        };
        if !choices.iter().any(|(_, b)| *b == wanted) {
            return;
        }
        let direct = self.stream.as_ref().is_some_and(|s| s.direct);
        // the same choice again changes nothing, except "Original" while a converted stream plays
        if wanted == self.quality && (wanted.is_some() || direct) {
            return;
        }
        if wanted.is_none() {
            self.force_hls = false; // the viewer asks for the original again
        }
        self.quality = wanted;
        self.switch_stream();
    }

    /// The trickplay tile for `t_ms` as a raw BGRA file (stride w*4) for the skin's `overlay-add`.
    fn preview(&mut self, t_ms: u64) {
        let tp = self
            .info
            .as_ref()
            .and_then(|i| i.trickplay.clone())
            .filter(|_| self.caps.trickplay);
        let (Some(dir), Some(tp)) = (self.cfg.temp_dir.clone(), tp) else {
            return self.script_message("ff-preview-hide", None);
        };
        let f = frame(t_ms, &tp);
        let Some(url) = self.cfg.origin.resolve(&sheet_url(&tp, f.sheet)) else {
            return self.script_message("ff-preview-hide", None);
        };
        let (w, h) = (tp.width as u32, tp.height as u32);
        let path = match &self.preview_last {
            Some((last, p)) if *last == f => p.clone(),
            last => {
                // two files in turn: the one the skin may still be reading is never rewritten
                let slot = match last {
                    Some((_, p)) if p.ends_with("preview-a.bgra") => "preview-b.bgra",
                    _ => "preview-a.bgra",
                };
                let path = dir.join(slot);
                let api = &self.api;
                let mut unauthorized = false;
                let tile = self
                    .sheets
                    .get_or_fetch(f.sheet, || match api.bytes(&url) {
                        Ok(b) => Some(b),
                        Err(e) => {
                            unauthorized = e == ApiError::Unauthorized;
                            None
                        }
                    })
                    .and_then(|jpeg| tile_bgra(jpeg, &f, w, h));
                if unauthorized {
                    return self.unauthorized();
                }
                let written = tile.is_some_and(|t| std::fs::write(&path, t).is_ok());
                if !written {
                    self.preview_last = None;
                    return self.script_message("ff-preview-hide", None);
                }
                if !self.previews.contains(&path) {
                    self.previews.push(path.clone());
                }
                self.preview_last = Some((f, path.clone()));
                path
            }
        };
        let msg = json!({"path": path.to_string_lossy(), "w": w, "h": h}).to_string();
        self.script_message("ff-preview", Some(msg));
    }

    // ---- ff-state ----

    fn script_message(&self, name: &str, arg: Option<String>) {
        let cmd = match arg {
            Some(a) => json!(["script-message-to", SCRIPT, name, a]),
            None => json!(["script-message-to", SCRIPT, name]),
        };
        let _ = self.player.command(cmd);
    }

    /// Sends `ff-state` when anything in it changed.
    fn send_state(&mut self) {
        let s = self.state().to_string();
        if s != self.last_state {
            self.script_message("ff-state", Some(s.clone()));
            self.last_state = s;
        }
    }

    fn state(&self) -> Value {
        let direct = self.stream.as_ref().is_some_and(|s| s.direct);
        let info = self.info.as_ref();
        let (chip, reason) = if direct || self.stream.is_none() {
            ("Original".to_string(), String::new())
        } else {
            let label = quality_choices(false)
                .into_iter()
                .find(|(_, b)| self.quality.is_some() && *b == self.quality)
                .map(|(l, _)| l);
            let chip = label.map_or("Converted".to_string(), |l| format!("Converted · {l}"));
            let reason = self
                .fallback_reason
                .map(str::to_string)
                .or_else(|| info.and_then(|i| i.transcode_reason.clone()))
                .unwrap_or_default();
            (chip, reason)
        };
        let next = match (&self.next, self.card_since) {
            (Some(n), Some(since)) => {
                let mut o = json!({"title": title_of(n)});
                if self.prefs.flow.autoplay_next && !self.ask_still {
                    let left = COUNTDOWN_MS.saturating_sub(self.now().saturating_sub(since));
                    o["inS"] = json!(left.div_ceil(1000));
                }
                o
            }
            _ => Value::Null,
        };
        let skip = self.skip().map(|(k, end)| {
            let label = if k.eq_ignore_ascii_case("recap") {
                "Skip recap"
            } else {
                "Skip intro"
            };
            json!({"label": label, "endS": end as f64 / 1000.0})
        });
        let qualities: Vec<Value> = if direct || self.stream.is_none() {
            vec![]
        } else {
            quality_choices(self.direct_allowed)
                .into_iter()
                .map(|(label, b)| {
                    let id = b.map_or("orig".to_string(), |b| b.to_string());
                    json!({"id": id, "label": label, "current": b == self.quality})
                })
                .collect()
        };
        let audio: Vec<Value> = info.map_or(vec![], |i| {
            let current = self.audio_index.or_else(|| {
                i.audio_tracks
                    .iter()
                    .find(|t| t.is_default)
                    .map(|t| t.index)
            });
            i.audio_tracks
                .iter()
                .map(|t| {
                    json!({"id": t.index.to_string(),
                           "label": track_label(&t.title, t.language.as_deref(), t.index),
                           "current": Some(t.index) == current})
                })
                .collect()
        });
        let mut subs =
            vec![json!({"id": "off", "label": "Off", "current": self.sub_index.is_none()})];
        if let Some(i) = info {
            subs.extend(i.subtitles.iter().map(|t| {
                json!({"id": t.index.to_string(),
                       "label": track_label(&t.title, t.language.as_deref(), t.index),
                       "current": Some(t.index) == self.sub_index})
            }));
        }
        let chapters: Vec<Value> = self
            .chapters
            .iter()
            .map(|c| json!({"t": c.start_sec, "name": c.name}))
            .collect();
        json!({
            "title": self.item.as_ref().map(title_of).unwrap_or_default(),
            "chip": chip,
            "chipReason": reason,
            "chapters": chapters,
            "skip": skip,
            "next": next,
            "qualities": qualities,
            "audio": audio,
            "subs": subs,
            "reconnecting": self.reconnecting,
            "askStillWatching": self.ask_still,
        })
    }

    // ---- reports and the end ----

    fn report_body(&self) -> Option<Value> {
        let info = self.info.as_ref()?;
        let direct = self.stream.as_ref()?.direct;
        let mut b = Map::new();
        b.insert("itemId".into(), json!(self.item_id));
        b.insert("playSessionId".into(), json!(info.play_session_id));
        b.insert("mediaSourceId".into(), json!(info.media_source_id));
        b.insert(
            "positionTicks".into(),
            json!(self.pos_ms as i64 * TICKS_PER_MS),
        );
        b.insert("isPaused".into(), json!(self.paused));
        if let Some(a) = self.audio_index {
            b.insert("audioIndex".into(), json!(a));
        }
        let method = if direct { "DirectPlay" } else { "Transcode" };
        b.insert("playMethod".into(), json!(method));
        Some(Value::Object(b))
    }

    /// A failed report is dropped (the next one carries the position); a 401 ends the session.
    fn send_report(&mut self, kind: ReportKind) {
        let Some(body) = self.report_body() else {
            return;
        };
        if let Err(ApiError::Unauthorized) = self.api.report(kind, &body) {
            self.unauthorized();
        }
    }

    fn stop_report(&mut self) {
        if let Some(k) = self.report.stop() {
            self.send_report(k);
        }
    }

    fn end(&mut self, outcome: Outcome) {
        self.outcome = Some(outcome);
        for p in self.previews.drain(..) {
            let _ = std::fs::remove_file(p);
        }
    }

    /// Back, the end of the title or the window closed (`quit` = we close mpv).
    fn close(&mut self, quit: bool) {
        if self.done() {
            return;
        }
        self.stop_report();
        if self.done() {
            return;
        }
        if quit {
            let _ = self.player.command(json!(["quit"]));
        }
        self.end(Outcome::Closed);
    }

    /// A 401: stop mpv, a best-effort Stop, then the web app reloads (and shows sign-in).
    fn unauthorized(&mut self) {
        if self.done() {
            return;
        }
        self.end(Outcome::Unauthorized);
        let _ = self.player.command(json!(["quit"]));
        if let (Some(k), Some(body)) = (self.report.stop(), self.report_body()) {
            let _ = self.api.report(k, &body);
        }
        self.host.emit("ff-reload", json!({}));
    }

    fn fail(&mut self, message: String) {
        if self.done() {
            return;
        }
        self.stop_report();
        if self.done() {
            return;
        }
        let _ = self.player.command(json!(["quit"]));
        self.host.emit(
            "ff-player-error",
            json!({"itemId": self.item_id, "message": message}),
        );
        self.end(Outcome::Failed(message));
    }

    /// The web player takes over (409 profile): `/watch/<id>` with the start position and the link's tracks.
    fn open_web(&mut self, start_ms: Option<u64>) {
        let mut q = url::form_urlencoded::Serializer::new(String::new());
        if let Some(ms) = start_ms.filter(|ms| *ms >= 1000) {
            q.append_pair("t", &(ms / 1000).to_string());
        }
        if let Some(a) = &self.want_audio {
            q.append_pair("audio", a);
        }
        if let Some(s) = &self.want_sub {
            q.append_pair("sub", s);
        }
        let q = q.finish();
        let mut path = format!("/watch/{}", self.item_id);
        if !q.is_empty() {
            path = format!("{path}?{q}");
        }
        let _ = self.player.command(json!(["quit"]));
        self.host
            .emit("ff-open-web", json!({"itemId": self.item_id, "path": path}));
        self.end(Outcome::OpenInWeb(path));
    }

    /// The pipe closed without a normal stop: Stop once (best effort) and the crash dialog.
    fn crashed(&mut self) {
        if self.done() {
            return;
        }
        self.stop_report();
        if self.done() {
            return;
        }
        self.host
            .emit("ff-player-crashed", json!({"itemId": self.item_id}));
        self.end(Outcome::Crashed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AudioTrack, FlowPrefs, PlaybackInfo, SubtitleTrack, TrickplayInfo};
    use serde_json::json;
    use std::cell::{Cell, RefCell};
    use std::collections::{HashMap, VecDeque};
    use std::sync::mpsc::{channel, Sender};

    const COOKIE: &str = "ff_sid=SECRETCOOKIE";
    const BASE: &str = "https://friend.example.com";

    // ---- fakes ----

    struct FakePlayer {
        log: RefCell<Vec<Value>>,
        tracks: Value,
        rx: RefCell<Option<Receiver<MpvEvent>>>,
        clean_exit: Cell<bool>,
    }

    impl FakePlayer {
        fn new() -> (FakePlayer, Sender<MpvEvent>) {
            let (tx, rx) = channel();
            let tracks = json!([
                {"id": 1, "type": "audio"}, {"id": 2, "type": "audio"},
                {"id": 1, "type": "sub", "external": true, "external-filename": format!("{BASE}/subs/3.vtt")},
                {"id": 2, "type": "sub", "external": true, "external-filename": format!("{BASE}/subs/4.vtt")},
            ]);
            let p = FakePlayer {
                log: RefCell::new(vec![]),
                tracks,
                rx: RefCell::new(Some(rx)),
                clean_exit: Cell::new(false),
            };
            (p, tx)
        }
        fn commands(&self) -> Vec<Value> {
            self.log.borrow().clone()
        }
        fn position(&self, pred: impl Fn(&Value) -> bool) -> Option<usize> {
            self.log.borrow().iter().position(pred)
        }
        fn loadfiles(&self) -> Vec<Value> {
            self.commands()
                .into_iter()
                .filter(|c| c["name"] == "loadfile")
                .collect()
        }
        fn states(&self) -> Vec<Value> {
            self.commands()
                .into_iter()
                .filter(|c| c[0] == "script-message-to" && c[2] == "ff-state")
                .map(|c| serde_json::from_str(c[3].as_str().unwrap()).unwrap())
                .collect()
        }
        fn state(&self) -> Value {
            self.states().pop().expect("an ff-state was sent")
        }
        fn has(&self, v: Value) -> bool {
            self.log.borrow().contains(&v)
        }
    }

    impl Player for FakePlayer {
        fn command(&self, v: Value) -> Result<Value, PlayerError> {
            self.log.borrow_mut().push(v.clone());
            if v == json!(["get_property", "track-list"]) {
                return Ok(self.tracks.clone());
            }
            Ok(Value::Null)
        }
        fn events(&self) -> Receiver<MpvEvent> {
            self.rx.borrow_mut().take().expect("events taken once")
        }
        fn exited_cleanly(&self) -> bool {
            self.clean_exit.get()
        }
    }

    fn info(ps: &str) -> PlaybackInfo {
        PlaybackInfo {
            play_session_id: ps.into(),
            media_source_id: "ms1".into(),
            direct_url: Some("/media/d?x=1".into()),
            hls_url: "/media/h.m3u8".into(),
            resume_ticks: 123_450_000,
            max_bitrate: 8_000_000,
            role_max_bitrate: None,
            audio_index: None,
            transcode_reason: None,
            audio_tracks: vec![
                AudioTrack {
                    index: 1,
                    title: "Japanese".into(),
                    language: Some("jpn".into()),
                    is_default: true,
                },
                AudioTrack {
                    index: 2,
                    title: "English".into(),
                    language: Some("eng".into()),
                    is_default: false,
                },
            ],
            subtitles: vec![
                SubtitleTrack {
                    index: 3,
                    title: "English".into(),
                    language: Some("eng".into()),
                    url: "/subs/3.vtt".into(),
                    is_default: false,
                },
                SubtitleTrack {
                    index: 4,
                    title: "German".into(),
                    language: Some("deu".into()),
                    url: "/subs/4.vtt".into(),
                    is_default: false,
                },
            ],
            trickplay: None,
        }
    }

    fn episode(id: &str, n: i32, name: &str) -> ItemInfo {
        ItemInfo {
            id: id.into(),
            kind: Some("Episode".into()),
            name: name.into(),
            series_name: Some("Show".into()),
            series_id: Some("s1".into()),
            season: Some(1),
            episode: Some(n),
        }
    }

    /// (series, audio, subtitle) of a `save_lang_pref`
    type Saved = (String, Option<String>, Option<String>);

    struct FakeApi {
        infos: RefCell<VecDeque<InfoAnswer>>,
        bodies: RefCell<Vec<Value>>,
        reports: RefCell<Vec<(ReportKind, Value)>>,
        report_error: Cell<Option<ApiError>>,
        next: HashMap<String, Option<ItemInfo>>,
        prefs: PlayerPrefs,
        lang: LangPref,
        saved: RefCell<Vec<Saved>>,
        sessions: Cell<u32>,
        trickplay: Option<TrickplayInfo>,
        sheet: Option<Vec<u8>>,
        segments: Vec<Segment>,
        hls_only: bool,
        fetched: RefCell<Vec<String>>,
    }

    impl FakeApi {
        fn new() -> FakeApi {
            FakeApi {
                infos: RefCell::new(VecDeque::new()),
                bodies: RefCell::new(vec![]),
                reports: RefCell::new(vec![]),
                report_error: Cell::new(None),
                next: HashMap::new(),
                prefs: PlayerPrefs::default(),
                lang: LangPref {
                    audio: None,
                    subtitle: None,
                    anime: false,
                },
                saved: RefCell::new(vec![]),
                sessions: Cell::new(0),
                trickplay: None,
                sheet: None,
                segments: vec![],
                hls_only: false,
                fetched: RefCell::new(vec![]),
            }
        }
        fn kinds(&self) -> Vec<ReportKind> {
            self.reports.borrow().iter().map(|(k, _)| *k).collect()
        }
        fn stops(&self) -> Vec<Value> {
            self.reports
                .borrow()
                .iter()
                .filter(|(k, _)| *k == ReportKind::Stop)
                .map(|(_, b)| b.clone())
                .collect()
        }
    }

    impl Api for FakeApi {
        fn info(&self, body: &Value) -> InfoAnswer {
            self.bodies.borrow_mut().push(body.clone());
            if let Some(a) = self.infos.borrow_mut().pop_front() {
                return a;
            }
            self.sessions.set(self.sessions.get() + 1);
            let mut i = info(&format!("ps{}", self.sessions.get()));
            i.trickplay = self.trickplay.clone();
            if self.hls_only {
                i.direct_url = None;
            }
            InfoAnswer::Ok(i)
        }
        fn report(&self, kind: ReportKind, body: &Value) -> Result<(), ApiError> {
            self.reports.borrow_mut().push((kind, body.clone()));
            match self.report_error.get() {
                Some(e) => Err(e),
                None => Ok(()),
            }
        }
        fn item(&self, id: &str) -> Result<ItemInfo, ApiError> {
            let n = id.trim_start_matches('e').parse().unwrap_or(1);
            Ok(episode(id, n, &format!("Name {n}")))
        }
        fn next(&self, id: &str) -> Result<Option<ItemInfo>, ApiError> {
            Ok(self.next.get(id).cloned().flatten())
        }
        fn segments(&self, _id: &str) -> Result<Vec<Segment>, ApiError> {
            Ok(self.segments.clone())
        }
        fn chapters(&self, _id: &str) -> Result<Vec<Chapter>, ApiError> {
            Ok(vec![])
        }
        fn caps(&self) -> Result<ServerCaps, ApiError> {
            Ok(ServerCaps::default())
        }
        fn prefs(&self) -> Result<PlayerPrefs, ApiError> {
            Ok(self.prefs.clone())
        }
        fn lang_pref(&self, _id: &str, _anime: bool) -> Result<LangPref, ApiError> {
            Ok(self.lang.clone())
        }
        fn save_lang_pref(
            &self,
            series_id: &str,
            audio: Option<&str>,
            subtitle: Option<&str>,
        ) -> Result<(), ApiError> {
            self.saved.borrow_mut().push((
                series_id.into(),
                audio.map(Into::into),
                subtitle.map(Into::into),
            ));
            Ok(())
        }
        fn bytes(&self, url: &str) -> Result<Vec<u8>, ApiError> {
            self.fetched.borrow_mut().push(url.into());
            self.sheet.clone().ok_or(ApiError::Network)
        }
    }

    #[derive(Default)]
    struct FakeHost {
        events: RefCell<Vec<(String, Value)>>,
    }

    impl Host for FakeHost {
        fn emit(&self, event: &str, payload: Value) {
            self.events.borrow_mut().push((event.into(), payload));
        }
    }

    impl FakeHost {
        fn names(&self) -> Vec<String> {
            self.events
                .borrow()
                .iter()
                .map(|(e, _)| e.clone())
                .collect()
        }
    }

    #[derive(Default)]
    struct FakeClock {
        now: Cell<u64>,
    }

    impl FakeClock {
        fn advance(&self, ms: u64) {
            self.now.set(self.now.get() + ms);
        }
    }

    impl Clock for FakeClock {
        fn now_ms(&self) -> u64 {
            self.now.get()
        }
        fn sleep_ms(&self, ms: u64) {
            self.advance(ms);
        }
    }

    struct Rig {
        player: FakePlayer,
        api: FakeApi,
        host: FakeHost,
        clock: FakeClock,
    }

    type S<'a> = Session<&'a FakePlayer, &'a FakeApi, &'a FakeHost, &'a FakeClock>;

    impl Rig {
        fn new(api: FakeApi) -> Rig {
            let (player, _tx) = FakePlayer::new();
            Rig {
                player,
                api,
                host: FakeHost::default(),
                clock: FakeClock::default(),
            }
        }
        fn session(&self, req: PlayRequest) -> S<'_> {
            Session::new(
                config(),
                req,
                &self.player,
                &self.api,
                &self.host,
                &self.clock,
            )
        }
    }

    fn config() -> SessionConfig {
        SessionConfig {
            origin: Origin::parse(BASE).unwrap(),
            cookie: COOKIE.into(),
            profile_id: "prof1".into(),
            app_lang: "de".into(),
            temp_dir: None,
        }
    }

    fn req(item: &str) -> PlayRequest {
        PlayRequest {
            item_id: item.into(),
            profile_id: "prof1".into(),
            start_ms: None,
            media_source_id: None,
            audio: None,
            subtitle: None,
        }
    }

    fn prop(name: &str, data: Value) -> MpvEvent {
        MpvEvent::Property {
            name: name.into(),
            data,
        }
    }

    fn action(v: Value) -> MpvEvent {
        MpvEvent::Message(vec!["ff-action".into(), v.to_string()])
    }

    /// file loaded and playing at `pos` seconds of `dur`
    fn playing(s: &mut S<'_>, pos: f64, dur: f64) {
        s.handle(MpvEvent::FileLoaded);
        s.handle(prop("duration", json!(dur)));
        s.handle(MpvEvent::PlaybackRestart);
        s.handle(prop("pause", json!(false)));
        s.handle(prop("time-pos", json!(pos)));
    }

    // ---- tests ----

    #[test]
    fn starts_direct_with_resume_and_headers() {
        let rig = Rig::new(FakeApi::new());
        let mut s = rig.session(req("e1"));
        s.start();
        let header = rig
            .player
            .position(|c| c[0] == "set_property" && c[1] == "http-header-fields")
            .expect("headers set");
        let load = rig
            .player
            .position(|c| c["name"] == "loadfile")
            .expect("loadfile");
        assert!(header < load, "headers before loadfile");
        let cmds = rig.player.commands();
        assert_eq!(
            cmds[header][2],
            json!([format!("Cookie: {COOKIE}"), "x-ff-profile: prof1"])
        );
        assert_eq!(
            cmds[load],
            json!({"name": "loadfile", "url": format!("{BASE}/media/d?x=1"), "flags": "replace",
                   "options": "start=12.345"})
        );
        let body = rig.api.bodies.borrow()[0].clone();
        assert_eq!(body["itemId"], "e1");
        assert_eq!(body["caps"]["client"], "windows");
        assert!(
            body.get("startTicks").is_none(),
            "resume comes from the server"
        );
        // the subtitle style is applied, the title shown
        assert!(rig
            .player
            .has(json!(["set_property", "sub-ass-override", "no"])));
        assert_eq!(rig.player.state()["title"], "S1:E1 · Name 1");
        assert_eq!(rig.player.state()["chip"], "Original");
        assert_eq!(s.outcome(), None);
    }

    #[test]
    fn explicit_start_ms_wins() {
        let rig = Rig::new(FakeApi::new());
        let mut r = req("e1");
        r.start_ms = Some(60_000);
        let mut s = rig.session(r);
        s.start();
        assert_eq!(rig.player.loadfiles()[0]["options"], "start=60.000");
        assert_eq!(rig.api.bodies.borrow()[0]["startTicks"], 600_000_000i64);
    }

    #[test]
    fn falls_back_to_hls_once() {
        let rig = Rig::new(FakeApi::new());
        let mut s = rig.session(req("e1"));
        s.start();
        s.handle(MpvEvent::FileLoaded);
        rig.clock.advance(9_000);
        s.tick();
        assert_eq!(rig.player.loadfiles().len(), 1, "still within 10 s");
        rig.clock.advance(1_001);
        s.tick();
        let loads = rig.player.loadfiles();
        assert_eq!(loads.len(), 2);
        assert_eq!(loads[1]["url"], format!("{BASE}/media/h.m3u8"));
        assert_eq!(loads[1]["options"], "start=12.345", "same position");
        let st = rig.player.state();
        assert!(
            st["chip"].as_str().unwrap().starts_with("Converted"),
            "{st}"
        );
        assert_ne!(st["chipReason"], "");
        // the HLS stream fails too: it never goes back to the direct file
        s.handle(MpvEvent::EndFile {
            reason: "error".into(),
        });
        rig.clock.advance(11_000);
        s.tick();
        let direct = rig
            .player
            .loadfiles()
            .iter()
            .filter(|l| l["url"] == format!("{BASE}/media/d?x=1"))
            .count();
        assert_eq!(direct, 1);

        // a direct stream that fails while opening falls back at once
        let rig = Rig::new(FakeApi::new());
        let mut s = rig.session(req("e1"));
        s.start();
        s.handle(MpvEvent::EndFile {
            reason: "error".into(),
        });
        assert_eq!(
            rig.player.loadfiles()[1]["url"],
            format!("{BASE}/media/h.m3u8")
        );
    }

    #[test]
    fn reports_start_progress_stop() {
        let rig = Rig::new(FakeApi::new());
        let mut s = rig.session(req("e1"));
        s.start();
        s.handle(MpvEvent::FileLoaded);
        assert!(rig.api.kinds().is_empty(), "nothing before playback");
        playing(&mut s, 30.0, 1_000.0);
        assert_eq!(rig.api.kinds(), vec![ReportKind::Start]);
        rig.clock.advance(10_000);
        s.tick();
        assert_eq!(
            rig.api.kinds(),
            vec![ReportKind::Start, ReportKind::Progress]
        );
        let (_, body) = rig.api.reports.borrow()[1].clone();
        assert_eq!(
            body,
            json!({"itemId": "e1", "playSessionId": "ps1", "mediaSourceId": "ms1",
                   "positionTicks": 300_000_000i64, "isPaused": false, "playMethod": "DirectPlay"})
        );
        s.handle(prop("pause", json!(true)));
        assert_eq!(rig.api.kinds().len(), 3);
        assert_eq!(rig.api.reports.borrow()[2].1["isPaused"], true);
        s.handle(action(json!({"a": "back"})));
        assert_eq!(rig.api.kinds().last(), Some(&ReportKind::Stop));
        assert!(rig.player.has(json!(["quit"])));
        assert_eq!(s.outcome(), Some(&Outcome::Closed));
        assert!(rig.host.names().is_empty(), "a normal stop emits nothing");
    }

    #[test]
    fn unauthorized_stops_and_reloads() {
        let api = FakeApi::new();
        api.infos.borrow_mut().push_back(InfoAnswer::Unauthorized);
        let rig = Rig::new(api);
        let mut s = rig.session(req("e1"));
        s.start();
        assert!(rig.player.has(json!(["quit"])));
        assert_eq!(rig.host.names(), vec!["ff-reload"]);
        assert_eq!(s.outcome(), Some(&Outcome::Unauthorized));
        assert!(rig.player.loadfiles().is_empty());

        // a 401 on a report while playing: mpv stops, one Stop attempt, reload
        let rig = Rig::new(FakeApi::new());
        let mut s = rig.session(req("e1"));
        s.start();
        playing(&mut s, 30.0, 1_000.0);
        rig.api.report_error.set(Some(ApiError::Unauthorized));
        rig.clock.advance(10_000);
        s.tick();
        assert!(rig.player.has(json!(["quit"])));
        assert_eq!(rig.api.stops().len(), 1);
        assert_eq!(rig.host.names(), vec!["ff-reload"]);
        assert_eq!(s.outcome(), Some(&Outcome::Unauthorized));
    }

    #[test]
    fn pipe_eof_ends_session() {
        let (player, tx) = FakePlayer::new();
        let (api, host, clock) = (FakeApi::new(), FakeHost::default(), FakeClock::default());
        for ev in [
            MpvEvent::FileLoaded,
            prop("duration", json!(1_000.0)),
            MpvEvent::PlaybackRestart,
            prop("time-pos", json!(42.0)),
        ] {
            tx.send(ev).unwrap();
        }
        drop(tx); // the pipe closes without a shutdown event
        let s = Session::new(config(), req("e1"), &player, &api, &host, &clock);
        assert_eq!(s.run(), Outcome::Crashed);
        assert_eq!(api.stops().len(), 1, "Stop once");
        assert_eq!(api.stops()[0]["positionTicks"], 420_000_000i64);
        assert_eq!(
            *host.events.borrow(),
            vec![("ff-player-crashed".to_string(), json!({"itemId": "e1"}))]
        );
    }

    #[test]
    fn window_closed_is_a_normal_stop() {
        // mpv's IPC never forwards `shutdown`: closing the window is `end-file quit`, then the pipe closes
        let (player, tx) = FakePlayer::new();
        let (api, host, clock) = (FakeApi::new(), FakeHost::default(), FakeClock::default());
        for ev in [
            MpvEvent::FileLoaded,
            prop("duration", json!(100.0)),
            MpvEvent::PlaybackRestart,
            prop("time-pos", json!(5.0)),
            MpvEvent::EndFile {
                reason: "quit".into(),
            },
        ] {
            tx.send(ev).unwrap();
        }
        drop(tx);
        let s = Session::new(config(), req("e1"), &player, &api, &host, &clock);
        assert_eq!(s.run(), Outcome::Closed);
        assert_eq!(api.stops().len(), 1);
        assert!(host.names().is_empty(), "no crash dialog");
    }

    #[test]
    fn eof_without_end_file_uses_the_exit_status() {
        // e.g. `q` while idle (still-watching question, no file loaded): only the exit status tells
        for (clean, outcome, events) in [
            (true, Outcome::Closed, vec![]),
            (
                false,
                Outcome::Crashed,
                vec!["ff-player-crashed".to_string()],
            ),
        ] {
            let (player, tx) = FakePlayer::new();
            player.clean_exit.set(clean);
            let (api, host, clock) = (FakeApi::new(), FakeHost::default(), FakeClock::default());
            for ev in [MpvEvent::FileLoaded, MpvEvent::PlaybackRestart] {
                tx.send(ev).unwrap();
            }
            drop(tx);
            let s = Session::new(config(), req("e1"), &player, &api, &host, &clock);
            assert_eq!(s.run(), outcome);
            assert_eq!(api.stops().len(), 1, "Stop once either way");
            assert_eq!(host.names(), events);
        }
    }

    #[test]
    fn own_skip_seeks_are_not_interactions() {
        let mut api = FakeApi::new();
        api.prefs.flow = FlowPrefs {
            autoplay_next: true,
            auto_skip_intro: true,
            still_watching: true,
            still_watching_episodes: 3,
        };
        api.segments = vec![Segment {
            kind: "intro".into(),
            start_sec: 0.0,
            end_sec: 30.0,
        }];
        for (a, b) in [("e1", 2), ("e2", 3), ("e3", 4), ("e4", 5)] {
            api.next
                .insert(a.into(), Some(episode(&format!("e{b}"), b, "x")));
        }
        let rig = Rig::new(api);
        let mut s = rig.session(req("e1"));
        s.start();
        for n in 1..=4 {
            playing(&mut s, 10.0, 100.0);
            s.tick(); // auto-skips the intro
            assert!(rig.player.has(json!(["seek", "30.000", "absolute+exact"])));
            s.handle(MpvEvent::Seek); // mpv's event for our own seek
            s.handle(prop("time-pos", json!(80.0)));
            s.tick();
            rig.clock.advance(10_000);
            s.tick();
            if n < 4 {
                assert_eq!(rig.player.loadfiles().len(), n + 1, "autoplay {n}");
            }
        }
        assert_eq!(rig.player.loadfiles().len(), 4, "the 4th episode asks");
        assert_eq!(rig.player.state()["askStillWatching"], true);
        // "Yes" plays on
        s.handle(action(json!({"a": "stillYes"})));
        assert_eq!(rig.player.loadfiles().len(), 5);
    }

    #[test]
    fn no_next_no_card() {
        let mut api = FakeApi::new();
        api.next.insert("e1".into(), None);
        let rig = Rig::new(api);
        let mut s = rig.session(req("e1"));
        s.start();
        playing(&mut s, 990.0, 1_000.0);
        s.tick();
        assert_eq!(rig.player.state()["next"], Value::Null);
        // the end of the title closes the player
        s.handle(MpvEvent::EndFile {
            reason: "eof".into(),
        });
        assert_eq!(s.outcome(), Some(&Outcome::Closed));
        assert_eq!(rig.player.loadfiles().len(), 1);
    }

    #[test]
    fn next_episode_same_window() {
        let mut api = FakeApi::new();
        api.next
            .insert("e1".into(), Some(episode("e2", 2, "Second")));
        let rig = Rig::new(api);
        let mut s = rig.session(req("e1"));
        s.start();
        playing(&mut s, 70.0, 100.0);
        s.tick();
        assert_eq!(
            rig.player.state()["next"],
            Value::Null,
            "not before 25 s to the end"
        );
        s.handle(prop("time-pos", json!(80.0)));
        s.tick();
        let st = rig.player.state();
        assert_eq!(st["next"]["title"], "S1:E2 · Second", "{st}");
        assert_eq!(st["next"]["inS"], 10);
        s.handle(action(json!({"a": "next"})));
        let stops = rig.api.stops();
        assert_eq!(stops.len(), 1);
        assert_eq!(stops[0]["itemId"], "e1");
        let loads = rig.player.loadfiles();
        assert_eq!(loads.len(), 2);
        assert_eq!(loads[1]["flags"], "replace");
        assert_eq!(rig.api.bodies.borrow()[1]["itemId"], "e2");
        assert!(!rig.player.has(json!(["quit"])));
        assert_eq!(rig.player.state()["title"], "S1:E2 · Name 2");
        assert_eq!(rig.player.state()["next"], Value::Null);
        // the new episode reports with its own play session
        playing(&mut s, 1.0, 100.0);
        let last = rig.api.reports.borrow().last().cloned().unwrap();
        assert_eq!(last.0, ReportKind::Start);
        assert_eq!(last.1["itemId"], "e2");
        assert_eq!(last.1["playSessionId"], "ps2");
    }

    #[test]
    fn still_watching_blocks_autoplay() {
        let mut api = FakeApi::new();
        api.prefs.flow = FlowPrefs {
            autoplay_next: true,
            auto_skip_intro: false,
            still_watching: true,
            still_watching_episodes: 1,
        };
        api.next.insert("e1".into(), Some(episode("e2", 2, "B")));
        api.next.insert("e2".into(), Some(episode("e3", 3, "C")));
        let rig = Rig::new(api);
        let mut s = rig.session(req("e1"));
        s.start();
        playing(&mut s, 80.0, 100.0);
        s.tick();
        rig.clock.advance(10_000);
        s.tick();
        assert_eq!(rig.player.loadfiles().len(), 2, "first autoplay runs");
        playing(&mut s, 80.0, 100.0);
        s.tick();
        rig.clock.advance(10_000);
        s.tick();
        assert_eq!(rig.player.loadfiles().len(), 2, "the second one asks");
        assert_eq!(rig.player.state()["askStillWatching"], true);
        assert!(rig.player.has(json!(["set_property", "pause", true])));
        s.handle(action(json!({"a": "stillYes"})));
        assert_eq!(rig.player.loadfiles().len(), 3);
        assert_eq!(rig.api.bodies.borrow()[2]["itemId"], "e3");
        assert_eq!(rig.player.state()["askStillWatching"], false);
    }

    #[test]
    fn lang_pref_saved_on_pick() {
        let mut api = FakeApi::new();
        api.lang = LangPref {
            audio: None,
            subtitle: Some("eng".into()),
            anime: false,
        };
        let rig = Rig::new(api);
        let mut s = rig.session(req("e1"));
        s.start();
        s.handle(MpvEvent::FileLoaded);
        assert!(rig.player.has(json!([
            "sub-add",
            format!("{BASE}/subs/3.vtt"),
            "auto",
            "English",
            "eng"
        ])));
        // the saved choice applies at start: English is mpv's sub 1
        assert!(rig.player.has(json!(["set_property", "sid", 1])));
        s.handle(action(json!({"a": "sub", "id": "4"})));
        assert!(rig.player.has(json!(["set_property", "sid", 2])));
        assert_eq!(
            rig.api.saved.borrow().last().cloned(),
            Some(("s1".into(), None, Some("deu".into())))
        );
        let subs = rig.player.state()["subs"].clone();
        assert_eq!(subs[0]["id"], "off");
        assert_eq!(subs[2]["current"], true, "{subs}");
        s.handle(action(json!({"a": "sub", "id": "off"})));
        assert!(rig.player.has(json!(["set_property", "sid", "no"])));
        assert_eq!(
            rig.api.saved.borrow().last().cloned(),
            Some(("s1".into(), None, Some("off".into())))
        );
        // a direct stream switches audio in mpv and saves the language
        s.handle(action(json!({"a": "audio", "id": "2"})));
        assert!(rig.player.has(json!(["set_property", "aid", 2])));
        assert_eq!(
            rig.api.saved.borrow().last().cloned(),
            Some(("s1".into(), Some("eng".into()), None))
        );
    }

    #[test]
    fn anime_default_picks_app_language_subtitles() {
        let mut api = FakeApi::new();
        api.prefs.anime_original = true;
        api.lang = LangPref {
            audio: None,
            subtitle: None,
            anime: true,
        };
        let rig = Rig::new(api);
        let mut s = rig.session(req("e1"));
        s.start();
        assert_eq!(rig.api.bodies.borrow()[0]["audioLang"], "jpn");
        s.handle(MpvEvent::FileLoaded);
        // app language de: the German subtitle (mpv sub 2) while the Japanese track plays
        assert!(rig.player.has(json!(["set_property", "sid", 2])));
    }

    #[test]
    fn info_answers_end_the_session() {
        let api = FakeApi::new();
        api.infos.borrow_mut().push_back(InfoAnswer::MaxStreams(2));
        let rig = Rig::new(api);
        let mut s = rig.session(req("e1"));
        s.start();
        let msg = "At most 2 streams at a time are allowed.";
        assert_eq!(s.outcome(), Some(&Outcome::Failed(msg.into())));
        assert_eq!(
            *rig.host.events.borrow(),
            vec![(
                "ff-player-error".to_string(),
                json!({"itemId": "e1", "message": msg})
            )]
        );

        let api = FakeApi::new();
        api.infos
            .borrow_mut()
            .push_back(InfoAnswer::ProfileMismatch);
        let rig = Rig::new(api);
        let mut r = req("e1");
        r.start_ms = Some(61_500);
        let mut s = rig.session(r);
        s.start();
        assert_eq!(
            s.outcome(),
            Some(&Outcome::OpenInWeb("/watch/e1?t=61".into()))
        );
        assert_eq!(rig.host.names(), vec!["ff-open-web"]);

        // 5xx: three retries with 1, 2 and 4 s, then it plays
        let api = FakeApi::new();
        for _ in 0..3 {
            api.infos.borrow_mut().push_back(InfoAnswer::Retry);
        }
        let rig = Rig::new(api);
        let mut s = rig.session(req("e1"));
        s.start();
        assert_eq!(rig.clock.now_ms(), 7_000);
        assert_eq!(rig.player.loadfiles().len(), 1);
    }

    #[test]
    fn stall_reloads_three_times_then_fails() {
        let mut api = FakeApi::new();
        api.hls_only = true;
        let rig = Rig::new(api);
        let mut s = rig.session(req("e1"));
        s.start();
        playing(&mut s, 50.0, 1_000.0);
        // stalls that recover: each one gets its own 3 tries
        for n in 1..=4 {
            s.handle(prop("paused-for-cache", json!(true)));
            rig.clock.advance(15_001);
            s.tick();
            assert_eq!(rig.player.loadfiles().len(), 1 + n, "reload {n}");
            assert_eq!(rig.player.state()["reconnecting"], true);
            assert_eq!(rig.player.loadfiles()[n]["options"], "start=50.000");
            s.handle(MpvEvent::PlaybackRestart);
            assert_eq!(rig.player.state()["reconnecting"], false);
        }
        // one stall that does not recover: 3 reloads, then the error
        s.handle(prop("paused-for-cache", json!(true)));
        for n in 1..=3 {
            rig.clock.advance(15_001);
            s.tick();
            assert_eq!(rig.player.loadfiles().len(), 5 + n, "reload {n}");
        }
        assert_eq!(s.outcome(), None);
        rig.clock.advance(15_001);
        s.tick();
        assert!(matches!(s.outcome(), Some(Outcome::Failed(_))));
        assert!(rig.player.has(json!(["quit"])));
    }

    #[test]
    fn original_offered_on_a_converted_stream() {
        let rig = Rig::new(FakeApi::new());
        let mut s = rig.session(req("e1"));
        s.start();
        s.handle(MpvEvent::FileLoaded);
        s.handle(MpvEvent::EndFile {
            reason: "error".into(),
        });
        let st = rig.player.state();
        assert_eq!(st["qualities"][0]["id"], "orig", "{st}");
        s.handle(action(json!({"a": "quality", "id": "orig"})));
        let loads = rig.player.loadfiles();
        assert_eq!(loads.last().unwrap()["url"], format!("{BASE}/media/d?x=1"));
        assert_eq!(rig.player.state()["chip"], "Original");
    }

    #[test]
    fn web_path_query_is_encoded() {
        let api = FakeApi::new();
        api.infos
            .borrow_mut()
            .push_back(InfoAnswer::ProfileMismatch);
        let rig = Rig::new(api);
        let mut r = req("e1");
        r.audio = Some("a b&c".into());
        r.subtitle = Some("x=y".into());
        let mut s = rig.session(r);
        s.start();
        assert_eq!(
            s.outcome(),
            Some(&Outcome::OpenInWeb(
                "/watch/e1?audio=a+b%26c&sub=x%3Dy".into()
            ))
        );
    }

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        use image::codecs::jpeg::JpegEncoder;
        use image::{ExtendedColorType, ImageEncoder};
        let rgb = vec![200u8; (w * h * 3) as usize];
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, 90)
            .write_image(&rgb, w, h, ExtendedColorType::Rgb8)
            .unwrap();
        out
    }

    #[test]
    fn preview_tile_written_and_removed_on_close() {
        let dir = std::env::temp_dir().join(format!("ff-session-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut api = FakeApi::new();
        api.trickplay = Some(TrickplayInfo {
            width: 16,
            height: 8,
            tile_width: 2,
            tile_height: 2,
            count: 4,
            interval_ms: 10_000,
            url: "/trick/{n}.jpg".into(),
        });
        api.sheet = Some(jpeg(32, 16));
        let (player, _tx) = FakePlayer::new();
        let (host, clock) = (FakeHost::default(), FakeClock::default());
        let mut cfg = config();
        cfg.temp_dir = Some(dir.clone());
        let mut s = Session::new(cfg, req("e1"), &player, &api, &host, &clock);
        s.start();
        s.handle(action(json!({"a": "preview", "tMs": 25_000})));
        s.handle(action(json!({"a": "preview", "tMs": 26_000})));
        assert_eq!(
            *api.fetched.borrow(),
            vec![format!("{BASE}/trick/0.jpg")],
            "one fetch per sheet"
        );
        let shown: Vec<Value> = player
            .commands()
            .into_iter()
            .filter(|c| c[2] == "ff-preview")
            .map(|c| serde_json::from_str(c[3].as_str().unwrap()).unwrap())
            .collect();
        assert_eq!(shown.len(), 2);
        assert_eq!(
            (shown[0]["w"].clone(), shown[0]["h"].clone()),
            (json!(16), json!(8))
        );
        assert_eq!(
            shown[0]["path"], shown[1]["path"],
            "the same frame is not written again"
        );
        let path = PathBuf::from(shown[0]["path"].as_str().unwrap());
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            16 * 8 * 4,
            "raw BGRA, stride w*4"
        );
        // scrubbing over many frames keeps at most two files (the one shown and the next)
        for t in [5_000, 15_000, 35_000, 5_000] {
            s.handle(action(json!({"a": "preview", "tMs": t})));
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        s.handle(action(json!({"a": "back"})));
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            0,
            "deleted when the player closes"
        );
        let _ = std::fs::remove_dir(&dir);

        // no trickplay: the skin hides the preview
        let rig = Rig::new(FakeApi::new());
        let mut s = rig.session(req("e1"));
        s.start();
        s.handle(action(json!({"a": "preview", "tMs": 1_000})));
        assert!(rig.player.has(json!([
            "script-message-to",
            "friendflix",
            "ff-preview-hide"
        ])));
    }

    #[test]
    fn cookie_never_in_debug_or_logs() {
        let rig = Rig::new(FakeApi::new());
        let mut s = rig.session(req("e1"));
        s.start();
        playing(&mut s, 1.0, 10.0);
        let shown = format!("{s:?} {:?}", config());
        assert!(!shown.contains("SECRETCOOKIE"), "{shown}");
        assert!(shown.contains("Session"));
        // the cookie only ever goes to mpv in the header property
        let with_cookie: Vec<Value> = rig
            .player
            .commands()
            .into_iter()
            .filter(|c| c.to_string().contains("SECRETCOOKIE"))
            .collect();
        assert!(with_cookie
            .iter()
            .all(|c| c[0] == "set_property" && c[1] == "http-header-fields"));
        assert!(rig
            .host
            .events
            .borrow()
            .iter()
            .all(|(_, p)| !p.to_string().contains("SECRETCOOKIE")));
    }

    #[test]
    fn parses_mpv_events() {
        let p = |v: Value| MpvEvent::parse(&v);
        assert_eq!(
            p(json!({"event": "property-change", "id": 1, "name": "time-pos", "data": 1.5})),
            Some(prop("time-pos", json!(1.5)))
        );
        assert_eq!(
            p(json!({"event": "client-message", "args": ["ff-action", "{}"]})),
            Some(MpvEvent::Message(vec!["ff-action".into(), "{}".into()]))
        );
        assert_eq!(
            p(json!({"event": "end-file", "reason": "eof", "playlist_entry_id": 1})),
            Some(MpvEvent::EndFile {
                reason: "eof".into()
            })
        );
        assert_eq!(
            p(json!({"event": "file-loaded"})),
            Some(MpvEvent::FileLoaded)
        );
        assert_eq!(
            p(json!({"event": "playback-restart"})),
            Some(MpvEvent::PlaybackRestart)
        );
        assert_eq!(p(json!({"event": "seek"})), Some(MpvEvent::Seek));
        assert_eq!(p(json!({"event": "shutdown"})), Some(MpvEvent::Shutdown));
        assert_eq!(p(json!({"event": "idle"})), Some(MpvEvent::Other));
        assert_eq!(p(json!({"request_id": 3, "error": "success"})), None);
        assert_eq!(p(json!({"event": "client-message", "args": [1]})), None);
    }
}
