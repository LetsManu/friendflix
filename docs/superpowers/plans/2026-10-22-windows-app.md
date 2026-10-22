# Windows App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows app for FriendFlix. It wraps the server's web app in a Tauri v2 window and plays titles in a bundled
mpv with FriendFlix controls. Releases attach it to GitHub and it updates itself.

**Architecture:**
- `desktop/core` is a plain Rust library (no Tauri) holding all the logic. It is unit-tested on Linux in CI.
- `desktop/app` is the Tauri v2 Windows app. It covers the window, bridge, tray, settings, updater, the mpv process and its
  named-pipe IPC, and uses `core` for every decision.
- `desktop/player/friendflix.lua` draws the controls only. It talks to Rust through mpv `script-message`s.
- The web app changes in one place: the bridge recognises the desktop user agent.

**Tech Stack:**
- Rust 1.97 (edition 2024);
- Tauri 2 with the plugins `single-instance`, `deep-link`, `updater` and `autostart`;
- `reqwest` (blocking, rustls), `serde_json`, `url`, `regex`, `image` (jpeg) and `lru`, with `httpmock` for tests;
- mpv 0.40 (a pinned shinchiro build);
- Lua 5.4 for the skin tests;
- SvelteKit/vitest and Playwright on the web side.

**Spec:** `docs/superpowers/specs/2026-10-22-windows-app-design.md` (read it with this plan; section numbers below refer to it).

## Global Constraints

- The server does not change. On the web side only `web/src/lib/native/bridge.ts` and its tests change.
- The bridge protocol is the Android one, unchanged: `{id, method, args}` and `{id, ok, result}`. `capabilities` answers
  `{api: 1, play: true, download: false, cast: false}`. Any method other than `capabilities`, `play` and `openSettings` answers
  `{id, ok: false}`.
- The user agent marker is ` FriendFlixDesktop/<version>`, and the version is `version.json`'s `version`.
- The bridge and the cookie access exist only on the exact server origin (scheme, host, port). The `authOrigin` must be https,
  loads in the window and never gets the bridge. Every other URL opens in the default browser.
- These URLs are used only when they are on the server origin: stream, subtitle and trickplay.
- The session cookie is never logged, written to disk or put on a command line. Logs strip the query and fragment from every URL.
- mpv flags (spec §6) are exact: `--no-config --config-dir=<app>\mpv --load-scripts=no --script=<app>\friendflix.lua --ytdl=no
  --input-ipc-server=\\.\pipe\friendflix-<32 hex>`, plus `--demuxer-lavf-o=protocol_whitelist=[http,https,tls,tcp,crypto,file]`
  and `--media-controls=yes` (Windows media overlay).
- Logs go to `%LOCALAPPDATA%\FriendFlix\logs` and are deleted after 14 days. There is no telemetry.
- Settings live in `%APPDATA%\FriendFlix\settings.json`.
- Docs and tests use placeholder hosts only: `friend.example.com`, `auth.example.com`, `192.0.2.x`.
- User-facing text (UI, docs, release notes) never says "Netflix" or "Seerr", and no trademark look-alikes are used.
- Every file starts with the SPDX header lines `SPDX-FileCopyrightText: 2026 Manuel Weißböck` and
  `SPDX-License-Identifier: AGPL-3.0-or-later` (`npm run spdx:check` must pass; extend `scripts/spdx.mjs` for `.rs`, `.lua` and
  `.toml` if needed).
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`.

## Review Focus

1. A server address with a trailing slash, a path, a different port or `http`. Expected: it is normalised to its origin, and the
   origin check still matches cookies and URLs exactly (a look-alike host such as `friend.example.com.evil.test` never matches).
   → Task 2 test `origin_lookalikes_and_ports`.
2. The server answers `directUrl` on another host (a misconfigured reverse proxy). Expected: that URL is refused and `hlsUrl`
   is used if it is on the origin, else the start fails with the generic error. → Task 4 test `foreign_direct_url_falls_to_hls`.
3. The session expires mid-title (401 on a progress report or the next-episode call). Expected: the player closes and the web
   app reloads to sign-in, never a silent stuck player. → Task 3 test `unauthorized_is_distinct` and Task 8 handling.
4. mpv crashes or the pipe breaks. Expected: no hang; the shell shows the error with "Play in the web player". → Task 8 test
   `pipe_eof_ends_session`.
5. An episode with no `next`, or segments past the duration. Expected: no card, no skip button, and the countdown never fires
   past the end. → Task 4 test `segments_clamped`, Task 8 test `no_next_no_card`.

---

### Task 1: Web bridge accepts the desktop app

**Files:**
- Modify: `web/src/lib/native/bridge.ts` (the doc comment, `UA_MARKER`, `hasMarker`)
- Test: `web/src/lib/native/bridge.test.ts`, `e2e/tests/desktop-play.spec.ts` (new)

**Interfaces:**
- Produces: `export const UA_MARKERS = [' FriendFlixAndroid/', ' FriendFlixDesktop/'] as const`. Keep the `UA_MARKER` export
  as the Android one for existing imports. `hasMarker()` is true when any marker is present.

- [ ] **Step 1: Failing unit test** in `bridge.test.ts`, `describe('desktop marker')`. With
  `navigator.userAgent = 'Mozilla/5.0 … FriendFlixDesktop/2.3.0'` and a stub `window.FriendFlixNative`, `native.available` is
  `true`. With `' FriendFlixDesk/'` it is `false`.
- [ ] **Step 2:** `npx vitest run src/lib/native/bridge.test.ts` (in `web/`). Expected: FAIL.
- [ ] **Step 3: Implement** `hasMarker` over `UA_MARKERS`, and update the doc comment to name both apps.
- [ ] **Step 4: e2e** `desktop-play.spec.ts`:
  - Set the context's `userAgent` with the desktop marker.
  - In an `addInitScript`, add a mock `window.FriendFlixNative` that records posted messages and answers `capabilities` with
    `{api:1,play:true,download:false,cast:false}` and `play` with `true`.
  - Open `/`, tap Play on the first *Weiterschauen* card, and assert that one `play` message with that `itemId` was posted and
    that the URL is not `/watch/…`.
- [ ] **Step 5:** run the unit test and `npx playwright test -c e2e/playwright.config.ts e2e/tests/desktop-play.spec.ts`.
  Expected: PASS.
- [ ] **Step 6:** commit `web: the bridge accepts the Windows app (FriendFlixDesktop marker)`.

### Task 2: `core` crate, origin policy and bridge protocol, CI job

**Files:**
- Create:
  - `desktop/Cargo.toml` (workspace with members `core` and `app`; `app` is excluded from Linux CI by building only `-p
    friendflix-core`);
  - `desktop/core/Cargo.toml` (`name = "friendflix-core"`);
  - `desktop/core/src/lib.rs`, `desktop/core/src/origin.rs`, `desktop/core/src/bridge.rs`;
  - `desktop/rust-toolchain.toml` (channel `1.97`);
  - `desktop/.gitignore` (`target/`).
- Modify: `.github/workflows/ci.yml`, a new job `desktop-core` on `ubuntu-latest`: `cargo fmt --check`, `cargo clippy -p
  friendflix-core -- -D warnings`, `cargo test -p friendflix-core`, working directory `desktop`. Add it to the `needs` of
  `android-release` and `publish`.

**Interfaces:**
- Produces in `origin.rs`:
  - `pub struct Origin { pub scheme: String, pub host: String, pub port: u16 }`;
  - `impl Origin { pub fn parse(input: &str) -> Option<Origin>; pub fn matches(&self, url: &str) -> bool; pub fn join(&self,
    path: &str) -> String; pub fn as_str(&self) -> String }`;
  - `pub enum Nav { App, Auth, External }`;
  - `pub fn classify(server: &Origin, auth: Option<&Origin>, url: &str) -> Nav`.
  - `parse` accepts `http`/`https` with a host, maps a bare `host` to `https://host`, and drops path, query, fragment and user
    info.
  - An auth origin is accepted only with https, through `pub fn parse_auth(input: &str) -> Option<Origin>`.
- Produces in `bridge.rs`:
  - `pub struct PlayRequest { pub item_id: String, pub profile_id: String, pub start_ms: Option<u64>, pub media_source_id:
    Option<String>, pub audio: Option<String>, pub subtitle: Option<String> }`;
  - `pub enum Request { Capabilities, Play(PlayRequest), OpenSettings, Unsupported }`;
  - `pub fn parse(msg: &str) -> Option<(String, Request)>`, which returns `None` for a message over 16384 bytes, bad JSON or a
    missing or invalid `id` (`^[A-Za-z0-9_-]{1,64}$`);
  - `pub fn reply(id: &str, ok: bool, result: Option<serde_json::Value>) -> String`;
  - `pub fn capabilities() -> serde_json::Value`.
  - Play validation is the web's: ids match `^[A-Za-z0-9-]{1,64}$`, tracks match `^[A-Za-z0-9_-]{1,32}$`, and `start_ms` is at
    most `604_800_000`. An invalid field makes the request `Unsupported`; it never panics.

- [ ] **Step 1: Failing tests** (`#[cfg(test)]` in each file):
  - `origin_parse_normalises`: `"friend.example.com/"` becomes `https://friend.example.com:443`, and
    `"http://192.0.2.5:8096/x?y"` becomes `http://192.0.2.5:8096`.
  - `origin_lookalikes_and_ports`: `matches` is false for `https://friend.example.com.evil.test/`,
    `https://friend.example.com:8443/`, `http://friend.example.com/` and `https://user@friend.example.com/` against
    `https://friend.example.com`.
  - `classify_auth_and_external`: `auth.example.com` gives `Auth` only when passed as auth; anything else gives `External`.
  - `bridge_parse_methods`: covers each method, unknown methods, invalid ids, the size limit and a play request with bad
    tracks.
  - `capabilities_shape`.
- [ ] **Step 2:** `cd desktop && cargo test -p friendflix-core`. Expected: compile FAIL.
- [ ] **Step 3: Implement** with the `url` and `regex` crates.
- [ ] **Step 4:** `cargo fmt --check && cargo clippy -p friendflix-core -- -D warnings && cargo test -p friendflix-core`.
  Expected: PASS.
- [ ] **Step 5:** commit `desktop: core crate with origin policy and bridge protocol; CI job`.

### Task 3: `core` server API client

**Files:**
- Create: `desktop/core/src/api.rs`, `desktop/core/src/model.rs`, `desktop/core/src/profile.rs`

**Interfaces:**
- Consumes: `Origin` (Task 2).
- Produces in `model.rs`:
  - `PlaybackInfo`, `AudioTrack`, `SubtitleTrack`, `TrickplayInfo`, `Segment`, `Chapter`, `ItemInfo`, `ServerCaps`,
    `PlayerPrefs`, `SubtitleStyle` and `LangPref`.
  - Field names and JSON keys mirror `android/.../player/PlayerApi.kt` (`parseInfo`, `parseItem`, `caps`, `prefs`, `langPref`,
    `segments`, `chapters`). Missing capability flags count as `true`. Strings are capped as in the Android parser.
- Produces in `api.rs`:
  - `pub enum ApiError { Unauthorized, Status(u16), Network, Malformed }`;
  - `pub enum InfoAnswer { Ok(PlaybackInfo), MaxStreams(u32), Refused, ProfileMismatch, Retry }`;
  - `pub enum ReportKind { Start, Progress, Stop }` with paths `start`, `progress` and `stop`;
  - `pub struct ServerApi { origin: Origin, cookie: String, profile_id: String, http: reqwest::blocking::Client }`, built with
    `ServerApi::new(origin, cookie, profile_id) -> ServerApi`. It uses a 15 s timeout and sends `cookie`, `x-ff-profile` and
    the CSRF header the server expects (as `ServerApi.kt`).
  - Methods:
    - `info(&self, body: &serde_json::Value) -> InfoAnswer`, with the status mapping of spec §4 (a 401 maps to `Refused`
      here; the caller checks `me()` afterwards);
    - `report(&self, kind: ReportKind, body: &serde_json::Value) -> Result<(), ApiError>`;
    - `item`, `next`, `segments`, `chapters`, `caps`, `prefs` and `lang_pref(id, anime: bool)`, each returning
      `Result<T, ApiError>`;
    - `save_lang_pref(series_id, audio: Option<&str>, subtitle: Option<&str>) -> Result<(), ApiError>`;
    - `bytes(&self, url: &str) -> Result<Vec<u8>, ApiError>`, which returns `Malformed` for a URL off the origin and caps the
      body at 8 MiB.
  - A 401 on any call is `ApiError::Unauthorized`.
- Produces in `profile.rs`: `pub fn device_profile() -> serde_json::Value`, with the spec §4 containers, video, audio and
  subtitle lists, in the same JSON shape as `android/.../player/DeviceProfile.kt` `toJson()`.

- [ ] **Step 1: Failing tests** with `httpmock`:
  - `info_maps_each_status`: 200, 429 with `{max:3}`, 403, 409 `profile_changed`, 500 and malformed JSON.
  - `unauthorized_is_distinct`: a 401 on `segments` gives `Err(Unauthorized)`.
  - `bytes_refuses_foreign_url`.
  - `headers_sent`: the cookie, `x-ff-profile` and the CSRF header are present, and the cookie never shows in `Debug` of
    `ServerApi` (implement `Debug` manually as `ServerApi { origin }`).
  - `parse_caps_missing_flags_true`.
  - `device_profile_lists`: the exact lists.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** fmt, clippy and test. Expected: PASS.
- [ ] **Step 5:** commit `desktop: core server API client and device profile`.

### Task 4: `core` playback rules

**Files:**
- Create: `desktop/core/src/playback.rs`

**Interfaces:**
- Consumes: `model` and `Origin`.
- Produces:
  - `pub struct Stream { pub url: String, pub direct: bool }`.
  - `pub fn first_stream(info: &PlaybackInfo, origin: &Origin) -> Option<Stream>`: the direct URL if it is on the origin,
    else the HLS URL if it is on the origin, else `None`.
  - `pub struct Fallback { used: bool }` with
    `pub fn on_open_result(&mut self, direct: bool, playing_after_ms: Option<u64>, failed: bool) -> bool`. It returns `true`
    exactly once, when a direct stream failed or did not play within `10_000` ms.
  - `pub struct ReportClock`:
    - `new() -> Self`;
    - `fn start(&mut self, now_ms: u64) -> ReportKind`;
    - `fn tick(&mut self, now_ms: u64, paused: bool) -> Option<ReportKind>`, which gives `Progress` every `10_000` ms while
      playing and none while paused;
    - `fn event(&mut self, now_ms: u64) -> ReportKind`, which gives `Progress` on pause, resume and seek and resets the clock;
    - `fn stop(&mut self) -> Option<ReportKind>`, which gives `Stop` once, and only after a start.
  - `pub fn next_card_at_ms(duration_ms: u64, segments: &[Segment]) -> u64`: the Outro start clamped to the duration, else
    `duration_ms.saturating_sub(25_000)`.
  - `pub const COUNTDOWN_MS: u64 = 10_000;`
  - `pub struct StillWatching { auto_in_a_row: u8 }` with `on_auto_advance(&mut self) -> bool` (true means ask, at 3),
    `on_interaction(&mut self)` and `on_answer_yes(&mut self)`.
  - `pub fn skip_button(pos_ms: u64, segments: &[Segment], enabled: &[String], duration_ms: u64) -> Option<(String, u64)>`: the
    `Intro` or `Recap` type and the end clamped to the duration, only while `start <= pos < end`.
  - `pub fn quality_choices(direct_allowed: bool) -> Vec<(&'static str, Option<u64>)>`: Original when allowed, then 1080p, 720p
    and 480p, with the bitrates of the Android quality menu (copy the values from `PlayerActivity.kt`'s quality list).

- [ ] **Step 1: Failing tests:**
  - `foreign_direct_url_falls_to_hls`, `both_foreign_none`;
  - `fallback_once_on_timeout_and_failure`;
  - `report_clock_schedule`: start, 10 s, pause, seek, stop once, no stop without a start;
  - `next_card_outro_else_25s`, plus the clamps: an Outro past the duration, and a duration under 25 s (gives 0);
  - `segments_clamped`;
  - `still_watching_after_three`;
  - `quality_choices_without_original`.
- [ ] **Step 2–4:** run (FAIL), implement, then run fmt, clippy and test (PASS).
- [ ] **Step 5:** commit `desktop: core playback rules (stream choice, fallback, reporting, next, skip)`.

### Task 5: `core` subtitles, anime default, trickplay, log scrubbing

**Files:**
- Create: `desktop/core/src/subs.rs`, `desktop/core/src/trickplay.rs`, `desktop/core/src/logs.rs`

**Interfaces:**
- Produces in `subs.rs`:
  - `pub fn mpv_style(style: &SubtitleStyle) -> Vec<(&'static str, String)>`, with the spec §4 values. Size s/m/l/xl sets
    `sub-font-size` 38/48/60/76. The colours are `#ffffff`, `#ffe14d`, `#4de8ff` and `#6dff7a`. The backgrounds are none,
    shadow (`sub-shadow-offset=2`), semi (`sub-back-color=#A6000000` with `sub-border-style=background-box`) and solid
    (`#FF000000` with the box). The fonts are Segoe UI, Georgia and Consolas. Every result also contains
    `sub-ass-override=no`. Unknown values fall back to m, white, shadow and sans.
  - `pub fn anime_pick(audio: &[AudioTrack], subs: &[SubtitleTrack], app_lang: &str) -> (Option<i32>, Option<i32>)`, ported
    from `web/src/lib/player/anime.ts`.
- Produces in `trickplay.rs`:
  - `pub struct Frame { pub sheet: u32, pub x: u32, pub y: u32 }`;
  - `pub fn frame(t_ms: u64, tp: &TrickplayInfo) -> Frame`, using the formula of spec §4;
  - `pub fn sheet_url(tp: &TrickplayInfo, sheet: u32) -> String`, which replaces `{n}`;
  - `pub fn tile_bgra(jpeg: &[u8], f: &Frame, w: u32, h: u32) -> Option<Vec<u8>>`, which returns BGRA bytes of `w*h*4`;
  - `pub struct SheetCache`, an LRU of 8: `get_or_fetch(&mut self, sheet: u32, fetch: impl FnOnce() -> Option<Vec<u8>>) ->
    Option<&[u8]>`.
- Produces in `logs.rs`: `pub fn scrub(text: &str) -> String`, which removes `?…` and `#…` from every `http(s)://` URL in the
  text and replaces any `ff_sid=…` or `cookie: …` value with `***`.

- [ ] **Step 1: Failing tests:**
  - `style_each_value`, `style_unknown_falls_back`;
  - `anime_prefers_japanese_with_app_lang_subs` and `anime_no_japanese_keeps_none`, mirroring the cases in
    `web/src/lib/player/anime.test.ts`;
  - `frame_first_last_boundary_clamp` (t=0; the last frame; idx at the sheet boundary `per`; t past the end clamps to
    `count-1`);
  - `tile_bgra_size_and_pixel`: a 2×2-tile JPEG made in the test with `image`; check the length and the top-left pixel of
    tile 3 within a JPEG tolerance of ±8;
  - `cache_evicts_after_8`;
  - `scrub_urls_and_cookies`.
- [ ] **Step 2–4:** run (FAIL), implement, then run fmt, clippy and test (PASS).
- [ ] **Step 5:** commit `desktop: core subtitle style, anime default, trickplay tiles, log scrubbing`.

### Task 6: mpv control skin

**Files:**
- Create: `desktop/player/friendflix.lua`, `desktop/player/layout.lua` (pure helpers, `return` a table),
  `desktop/player/test/layout_test.lua`
- Modify: the `desktop-core` CI job: `sudo apt-get install -y lua5.4` and `lua5.4 desktop/player/test/layout_test.lua`

**Interfaces (Rust ⇄ Lua, JSON strings):**
- Rust → Lua: `script-message-to friendflix ff-state <json>`. Fields:
  - `title`, `chip` (`"Original"` or `"Converted · 1080p"`), `chipReason`;
  - `chapters: [{t, name}]`;
  - `skip: {label, endS}|null`, `next: {title, inS}|null`;
  - `qualities: [{id, label, current}]`;
  - `audio: [{id, label, current}]`, `subs: [{id, label, current}]`;
  - `reconnecting: bool`, `askStillWatching: bool`.
- Rust → Lua: `ff-preview <json>` `{path, w, h}` puts the overlay above the cursor x; `ff-preview-hide`.
- Lua → Rust: `script-message ff-action <json>`. `{a: ...}` is one of:
  - `back`, `next`, `cancelNext`, `skip`, `stillYes`;
  - `quality` with `id`, `audio` with `id`, `sub` with `id`;
  - `chapter` with `i`;
  - `preview` with `tMs`.
- `layout.lua` exports:
  - `fmt_time(s) -> "1:02:03" | "2:03"`;
  - `seek_to_time(x, bar_x, bar_w, duration) -> s` (clamped);
  - `chapter_marks(chapters, bar_x, bar_w, duration) -> {x…}`;
  - `should_hide(now, last_move, paused) -> bool` (3 s rule).

- [ ] **Step 1: Failing Lua tests** with plain `assert`, one function per helper, including clamping and hours.
- [ ] **Step 2:** `lua5.4 desktop/player/test/layout_test.lua`. Expected: FAIL. (Locally, if `lua5.4` is missing, use
  `apt-get install -y lua5.4`.)
- [ ] **Step 3: Implement** `layout.lua`, then `friendflix.lua`:
  - an ASS overlay (`mp.create_osd_overlay`) with the bars, chip, buttons and cards of spec §4, in the colours `#101418` and
    `#ff4f6d`;
  - mouse and key bindings as in spec §4, with `mp.add_forced_key_binding`;
  - every state arrives from `ff-state`. Lua never calls the network.
- [ ] **Step 4:** the tests PASS. Also run `luac5.4 -p desktop/player/friendflix.lua` (syntax check) if it is available.
- [ ] **Step 5:** commit `desktop: mpv control skin`.

### Task 7: Tauri shell (window, bridge, settings, tray, single instance, deep link)

**Files:**
- Create:
  - `desktop/app/Cargo.toml`, `desktop/app/build.rs`, `desktop/app/tauri.conf.json`;
  - `desktop/app/capabilities/{remote.json,local.json}`;
  - `desktop/app/icons/*` (from `android/play-listing/icon-512.png` via `tauri icon`);
  - `desktop/app/ui/{setup.html,settings.html,ui.js,ui.css}`;
  - `desktop/app/src/{main.rs,settings.rs,shell.rs,bridge_cmd.rs,tray.rs,logging.rs}`.
- Modify: `.github/workflows/ci.yml`, a job `desktop-app` on `windows-latest` for every push and PR (working directory
  `desktop`): `cargo clippy -p friendflix-app -- -D warnings`, `cargo test -p friendflix-app` and `cargo build -p
  friendflix-app` (no installer and no mpv). Add it to the `needs` of `android-release` and `publish`, next to
  `desktop-core`.

**Interfaces:**
- Consumes: `origin::{Origin, classify, Nav}`, `bridge::{parse, reply, capabilities, Request}` and `logs::scrub`.
- Produces:
  - `settings.rs`: `pub struct Settings { server: Option<String>, auth_origin: Option<String>, updates: UpdateMode /* Auto |
    Ask */, hwdec: bool, start_fullscreen: bool, autostart: bool, window: Option<WindowState>, last_profile: Option<String> }`
    with `load() -> Settings` and `save(&self)`, at `%APPDATA%\FriendFlix\settings.json`. The defaults are spec §5.
  - `shell.rs`:
    - `pub fn open_main(app: &AppHandle, s: &Settings)`. It loads the server origin, or `ui/setup.html` without one. The user
      agent is WebView2's default plus ` FriendFlixDesktop/<version>`.
    - The init script defines `window.FriendFlixNative` only when `location.origin` equals the server origin: `postMessage(s)`
      calls `invoke('bridge_message', {msg: s})`, and replies come back by `emit` to a listener that dispatches `message` events.
    - The navigation handler uses `classify`: `App` and `Auth` stay, `External` opens through the `opener` crate and is
      cancelled.
  - `bridge_cmd.rs`: `#[tauri::command] fn bridge_message(window, msg: String)`. It rejects calls whose webview URL is not on
    the server origin. `Play` hands off to `player::start` (Task 8; until then answer `false`), and `OpenSettings` opens
    `settings.html`.
  - `tray.rs`: the menu of spec §5. Closing the main window calls `app.exit(0)`.
  - The `single-instance` plugin focuses the window and forwards argv to the deep-link handler. The `deep-link` scheme is
    `friendflix`, and `friendflix://watch/<id>` follows spec §5.
  - `setup.html` posts the address to `#[tauri::command] fn probe_server(address) -> Result<ProbeOk, String>`, which calls
    `GET /api/version` without cookies, checks it is a FriendFlix answer and stores `authOrigin` through
    `origin::parse_auth`.
  - `settings.html` uses `get_settings` and `set_settings`.
  - `logging.rs` writes through `scrub` and keeps 14 days.
  - Capabilities:
    - `remote.json` allows the server origin only `bridge_message`;
    - `local.json` allows the bundled pages `probe_server`, `get_settings` and `set_settings`;
    - no fs, shell or http plugin permissions anywhere.

- [ ] **Step 1: Tests** in `settings.rs` (`defaults`, `roundtrip`, `unknown_fields_ignored`) and `bridge_cmd.rs` (an
  `origin_gate` that is a pure helper `fn allowed(webview_url: &str, server: &Origin) -> bool`). Run them with `cargo test -p
  friendflix-app` in the `desktop-app` CI job. Locally, run `cargo check -p friendflix-app --target x86_64-pc-windows-msvc` after `rustup
  target add x86_64-pc-windows-msvc` if it works; else rely on CI and say so in the report.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify:** `cargo test -p friendflix-core` stays green. The app check passes, or the report says it is
  unverified locally.
- [ ] **Step 4:** commit `desktop: Tauri shell with bridge, settings, tray, single instance and deep links`.

### Task 8: Player host (mpv process, IPC, session)

**Files:**
- Create: `desktop/core/src/session.rs` (the logic, with the `Player` and `Api` traits),
  `desktop/app/src/player/{mod.rs,mpv.rs,ipc.rs,cookies.rs,session.rs}` (wiring only)
- Modify: `bridge_cmd.rs` (the `Play` route), `tauri.conf.json` (`bundle.resources`: `mpv/` and `player/*.lua`)

**Interfaces:**
- Consumes: everything from Tasks 2–5 and the Task 6 message protocol.
- Produces:
  - `cookies.rs`: `pub fn session_cookie(webview: &Webview, origin: &Origin) -> Option<String>`. It reads WebView2's cookies
    for the origin URL (Tauri `Webview::cookies_for_url`) and returns the `name=value; …` header value.
  - `ipc.rs`: `pub struct Ipc` over `\\.\pipe\friendflix-<hex>` (tokio named-pipe client).
    - `connect(name, timeout) -> Result<Ipc>` checks that the pipe server process is the child's PID
      (`GetNamedPipeServerProcessId`) and that its token user is the current user; otherwise it fails.
    - Commands: `command(&self, args: serde_json::Value) -> Result<Value>`, `set_property`, `observe(name)`.
    - `events() -> Receiver<MpvEvent>`. The receiver closes on pipe EOF.
  - `mpv.rs`: `pub fn spawn(paths: &Paths, pipe: &str, s: &Settings) -> Result<Child>`, with the exact flags of the Global
    Constraints plus `--hwdec=auto-safe|no`, `--fullscreen=yes|no` and `--force-window=immediate`.
  - `session.rs`: `pub struct Session` drives one title:
    - It calls `ServerApi::info` with `device_profile()`.
    - It picks the stream with `first_stream` and sets `http-header-fields` (`Cookie: …`, `x-ff-profile: …`) through IPC
      before `loadfile <url> replace start=<s>`.
    - It adds external subtitles with `sub-add`, applies `mpv_style`, the saved `langpref` or `anime_pick`, and the skip,
      next and still-watching rules.
    - It sends `ff-state` on every change and serves `ff-action`s.
    - It reports with `ReportClock` and swaps streams with `Fallback`.
    - On a stall over 15 s it reloads up to 3 times while showing `reconnecting`.
    - On `ApiError::Unauthorized` it stops mpv, sends `Stop` best-effort and emits `ff-reload` to the main webview, which
      reloads.
    - On pipe EOF or mpv exit without a normal stop it emits `ff-player-crashed {itemId}`. The shell shows a dialog with
      "Play in the web player", which navigates to `/watch/<id>`.
    - Next episode: `api.next`, then a new `info` in the same mpv (`loadfile … replace`). The card shows only when `next` is
      `Some`.
  - `mod.rs`: `pub fn start(app: &AppHandle, req: PlayRequest) -> bool`. It refuses while another session runs by focusing
    it and returning `true`, and stores `last_profile`.
- Testability: `Session` takes `trait Player { fn command(&self, v: Value) -> Result<Value>; fn events(&self) ->
  Receiver<MpvEvent>; }` and `trait Api` (implemented by `ServerApi`), so its logic is unit-tested with fakes on any OS. Put
  `Session` and the traits in `desktop/core/src/session.rs` instead of `app`; `app/player/session.rs` only wires the real
  `Ipc` and `ServerApi`.

- [ ] **Step 1: Failing tests** in `core/src/session.rs` with fake `Player` and `Api`:
  - `starts_direct_with_resume_and_headers`: the header command comes before `loadfile`, and `start=` uses `resumeTicks`;
  - `explicit_start_ms_wins`;
  - `falls_back_to_hls_once`;
  - `reports_start_progress_stop`;
  - `unauthorized_stops_and_reloads`;
  - `pipe_eof_ends_session` (it emits crashed and sends `Stop` once);
  - `no_next_no_card` (`ff-state.next` is null when `api.next` is `Ok(None)`);
  - `next_episode_same_window`;
  - `still_watching_blocks_autoplay`;
  - `lang_pref_saved_on_pick`;
  - `cookie_never_in_debug_or_logs` (format `Session` with `{:?}` and assert that no cookie value appears).
- [ ] **Step 2–4:** run (FAIL), implement, then run fmt, clippy and test (PASS). Run the app check as in Task 7.
- [ ] **Step 5:** commit `desktop: mpv player host (process, IPC, session)`.

### Task 9: Updater and release build

**Files:**
- Create:
  - `desktop/app/src/updater.rs`;
  - `desktop/player/mpv.lock` (the URL and SHA-256 of the pinned `mpv-x86_64-<date>-git-<sha>.7z` from shinchiro's
    mpv-winbuild-cmake releases, with the version noted);
  - `desktop/scripts/fetch-mpv.ps1`;
  - `.github/workflows/desktop-release.yml`.
- Modify:
  - `.github/workflows/ci.yml`, a job `desktop-release` modelled on `android-release` (same `if`, `needs: [test, e2e,
    secrets, desktop-core, desktop-app]`, `permissions: { contents: write }`, secrets `TAURI_SIGNING_PRIVATE_KEY` and
    `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`);
  - `tauri.conf.json` (`plugins.updater.endpoints:
    ["https://github.com/LetsManu/friendflix/releases/latest/download/latest.json"]` and `pubkey` = the placeholder
    `REPLACE_WITH_PUBLIC_KEY`, read from `desktop/app/updater.pub` at build time).

**Interfaces:**
- `updater.rs`: `pub fn schedule(app: &AppHandle)`. It checks at start and every 24 h. With `Auto` it downloads and installs on
  the next start. With `Ask` it emits `ff-update-available {version}` to the main window, which shows a banner (injected by the
  init script, local text) with *Install and restart*. It never installs while `player::running()` is true.
- `fetch-mpv.ps1 -Dest desktop/app/mpv`: downloads the URL in `mpv.lock`, checks the SHA-256 (it fails with a non-zero exit on
  a mismatch), extracts `mpv.exe`, `d3dcompiler_43.dll` if present, and the licence texts.
- `desktop-release.yml` on `windows-latest`:
  - checks the tag matches `version.json` (as in `android-release.yml`) and sets the Tauri version from it;
  - runs `cargo test -p friendflix-app` and `fetch-mpv.ps1`;
  - runs `npx @tauri-apps/cli@2 build` with `TAURI_SIGNING_PRIVATE_KEY` when it is set;
  - attaches `*-setup.exe`, `*.msi`, `*.sig`, `latest.json` (Tauri's `createUpdaterArtifacts: true`) and `SHA256SUMS-windows.txt`
    with `gh release upload`;
  - without the key: builds unsigned, skips `.sig` and `latest.json`, and leaves a `::notice` (as Android does without its
    secrets).

- [ ] **Step 1: Test** `updater.rs`'s pure helper `fn due(last_check_ms: u64, now_ms: u64) -> bool` (24 h) and `fn
  may_install(running: bool, mode: UpdateMode, user_ok: bool) -> bool`. They run in the `desktop-app` CI job.
- [ ] **Step 2: Implement.** Validate the workflow YAML with `python3 -c "import yaml;
  yaml.safe_load(open('.github/workflows/desktop-release.yml'))"` and `actionlint` if it is installed. Pin every action by
  commit SHA, as the existing workflows do.
- [ ] **Step 3:** commit `desktop: self-update and Windows release build`.

### Task 10: Docs, README, CHANGELOG

**Files:**
- Create: `docs/windows.md`, `docs/de/windows.md`
- Modify: `README.md` (and the German README if present), a line next to the Android app; `CHANGELOG.md` under `##
  [Unreleased]` → `### Windows app`; `docs/android.md`'s "Contents" style is the model.

- [ ] **Step 1: Write the docs**, mirroring `docs/android.md`:
  - install, including the SmartScreen notice (*More info → Run anyway*);
  - first start, settings, the player with its keys, updates and troubleshooting, including the logs folder;
  - owner steps: `npx @tauri-apps/cli signer generate -w friendflix-updater.key`, the two secrets, the public key into
    `desktop/app/updater.pub`, and keeping the private key in a password manager;
  - the full manual checklist of spec §8;
  - building it yourself.
  - The German version has the same content.
- [ ] **Step 2:** `npm run spdx:check` passes; the links check passes if a docs link check exists in CI.
- [ ] **Step 3:** commit `docs: Windows app`.

---

## Execution notes

- Tasks 2–6 are fully testable here (Linux). Tasks 7–9 compile only for Windows. Each such task must state in its report what
  was verified locally (`cargo check --target x86_64-pc-windows-msvc`, or nothing) and leave the rest to the Windows CI job,
  which must be green before the PR is ready.
- The owner tests the first installer on a Windows PC with the checklist. Bugs found there are a follow-up PR.
