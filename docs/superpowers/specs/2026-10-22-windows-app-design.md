# Windows app: FriendFlix shell with a native mpv player

Status: design approved in conversation on 2026-10-22 (sections 1–3). Built "for the fun of it" next to the Android app
([2026-10-19-android-app-design.md](2026-10-19-android-app-design.md)), and it follows that app's structure: a native shell around the
server's web app, a narrow bridge and a native player.

## 1. Why and success

The owner wants FriendFlix as a Windows program with a player that plays almost every file directly. With the converting load off
the server, there is no browser codec limit (AC3/DTS/TrueHD, HEVC without the Windows extension, image subtitles).

Success means a user can do the following on Windows 10 (22H2) or 11:
- install the app from the GitHub Release;
- enter their server address and sign in as in the browser;
- press Play anywhere in the web app and get a fullscreen mpv player with FriendFlix controls;
- have it resume from the server's position and report progress, so *Continue watching* and resume stay in sync with web, Android
  and TV;
- get updates by themselves.

Nothing on the server changes. The web app changes in one place only: the bridge recognises the desktop app (section 3).

Not in scope for v1:
- downloads and offline playback;
- Chromecast;
- watch parties in the native player (`/party` stays in the web player);
- the Cast & info, bookmarks, subtitle search, audio effects, speed, sleep timer and post-play panels of the Android player;
- a Microsoft Store listing;
- a code-signing certificate;
- macOS and Linux builds.

## 2. Architecture

```
desktop/
  core/     plain Rust library, no Tauri: all logic, unit-tested on Linux
  app/      Tauri v2 app (Windows): window, tray, settings, updater, mpv process + IPC; uses core
  player/   friendflix.lua: mpv control skin (look only), plus its small Lua tests
```

- **Shell window:** WebView2 shows the server's web app.
  - On first start a local setup page (bundled in the app) asks for the server address. It checks the address with
    `GET /api/version` (public, no cookies; answers the server version and the optional `authOrigin`), as the Android setup
    (`ServerProbe`) does.
  - The address can be changed later on the settings page.
- **Bridge:** the same JSON protocol as the Android bridge (`web/src/lib/native/bridge.ts`):
  - An init script defines `window.FriendFlixNative` with `postMessage(string)`, which goes to a Tauri command, and
    `message` events.
  - The user agent gets ` FriendFlixDesktop/<version>`.
  - `capabilities` answers `{api: 1, play: true, download: false, cast: false}`.
  - Methods other than `capabilities`, `play` and `openSettings` answer with the protocol's "no" value.
- **Origin lock:**
  - The bridge and the cookie access exist only on the exact server origin (scheme, host, port).
  - The identity provider's sign-in origin (`authOrigin` from `/api/version`, https only, as on Android) may load in the window but
    never gets the bridge.
  - Every other navigation opens in the default browser.
- **Player:** the bundled `mpv.exe` opens its own borderless window.
  - `app` starts it with a random named pipe for the JSON IPC and drives it from Rust.
  - All server calls are in `core`. `friendflix.lua` draws the controls and sends button presses as `script-message`s to Rust.
- **Session for mpv:**
  - `app` reads the session cookie for the server origin from WebView2's cookie manager.
  - It sets mpv's `http-header-fields` (Cookie, the profile header `x-ff-profile`) over the pipe before `loadfile`, never on
    the command line.

## 3. Web change

- `web/src/lib/native/bridge.ts`: `hasMarker()` accepts ` FriendFlixAndroid/` or ` FriendFlixDesktop/`. Everything else in
  the web app is already driven by `capabilities` (Play hands off when `play` is true, downloads stay the web way when
  `download` is false).
- Tests:
  - bridge unit tests for the desktop marker;
  - one e2e test: with the desktop UA and a mock bridge, a Play tap sends `play` and the page stays.

## 4. Player behaviour

**Start.**
- `play {itemId, profileId, startMs?, audio?, subtitle?}` leads to `POST /api/playback/info`. The request carries a device
  profile:
  - containers `mkv, mp4, m4v, mov, webm, avi, ts, m2ts`;
  - video `h264, hevc, av1, vp9, mpeg2video, vc1`;
  - audio `aac, ac3, eac3, dts, truehd, flac, opus, mp3, vorbis, pcm`;
  - subtitles `srt, ass, ssa, vtt, pgs, dvdsub` as embedded.
- Server answers are handled as on Android (`InfoAnswer`):
  - 429 `max_streams`: the web text with the limit;
  - another 4xx: the generic error;
  - 409 profile: the web app takes over (the player closes and the page plays it);
  - 5xx or network: up to 3 tries with 1 s, 2 s and 4 s backoff.
- Start position: `startMs` from an explicit `?t=` link, else `resumeTicks`.

**Stream choice.**
- mpv opens `directUrl` when it is present, else `hlsUrl`. Both must be on the server origin, or the start is refused.
- If the original does not reach playback within 10 s, or fails while opening, mpv switches once to `hlsUrl` at the same
  position, and the chip shows "Converted" with the reason.
- The quality menu (converted stream only):
  - Original (when allowed), 1080p, 720p, 480p.
  - A change reloads `playback/info` with `maxBitrate` at the current position, as on Android.

**Reporting.**
- `POST /api/playback/start`, then `progress` every 10 s and on pause, resume and seek, and `POST /api/playback/stop` on close or end. The
  bodies are the same as on Android (`PlaybackReporter`), with `playSessionId` and `mediaSourceId`.
- On a network error a report is dropped. The next one carries the current position.

**Controls** (`friendflix.lua`, FriendFlix colours `--bg #101418`, accent `#ff4f6d`, Inter where installed, else Segoe UI):
- Top bar: back, title (`S1:E3 · Name` for episodes), quality chip ("Original" or "Converted · 1080p"; hover shows the reason).
- Bottom bar:
  - play/pause, −10 s, +10 s;
  - the seek bar with chapter marks and the trickplay preview, elapsed and remaining time;
  - next episode, chapters;
  - audio and subtitles, quality, volume, fullscreen.
- The controls hide after 3 s without mouse movement while playing, and stay shown while paused.
- Keys and mouse:
  - Space or K: play/pause; ←/→: ±10 s; ↑/↓: volume ±5; M: mute; F or double-click: fullscreen; Esc: leave fullscreen, else
    back; N: next episode; C: subtitles on/off.
  - Media keys and the Windows media overlay (SMTC) show title and poster.

**Audio and subtitles.**
- The menus list `audioTracks` and `subtitles` from `playback/info`, with external subtitles added through mpv's `sub-add`
  from the server URLs.
- A pick is saved per series with `PUT /api/series/:id/langpref`, as in the web player. The saved choice applies at start.
- Anime default, when `prefs.animeOriginal` is on and nothing is saved: `GET /api/series/:id/langpref?anime=1`. When the
  answer says `anime`, prefer Japanese audio and, while the audio is Japanese, subtitles in the app language (the web's
  `anime.ts` rule).
- Subtitle style from `/api/prefs` `subtitleStyle`:
  - size s/m/l/xl sets `sub-font-size` 38/48/60/76;
  - colour white/yellow/cyan/green: `#ffffff`/`#ffe14d`/`#4de8ff`/`#6dff7a`;
  - background none sets no border and no shadow;
  - shadow sets `sub-shadow-offset` 2;
  - semi sets `sub-back-color` `#A6000000` with `sub-border-style=background-box`;
  - solid sets `#FF000000` with the same box;
  - font sans/serif/mono: Segoe UI / Georgia / Consolas.
  - For ASS subtitles the file's own style stays (`sub-ass-override=no`).

**Skip and next.**
- Segments from `GET /api/items/:id/segments`, limited to the server's enabled types (`/api/me`).
- During an Intro or Recap segment a "Skip intro" or "Skip recap" button seeks to its end.
- Next episode (`GET /api/items/:id/next`):
  - From the Outro start, else 25 s before the end, a card shows the episode and a 10 s countdown when autoplay is on in
    `/api/prefs`.
  - "Still watching?" after the web's rule (3 episodes in a row without interaction) stops the autoplay.
  - The next episode loads in the same mpv window (new `playback/info`, new session).

**Chapters.** From `GET /api/items/:id/chapters` when `capabilities.chapters`, sorted and de-duplicated, else mpv's own chapter
list. They appear as marks on the seek bar and in a list that seeks on click.

**Trickplay.**
- Uses `trickplay` from `playback/info`, with the frame maths of the Android spec (`idx = clamp(floor(t·1000/interval), 0,
  count−1)`, sheet and tile from `tileWidth·tileHeight`).
- `core` downloads each sheet once per player session (memory LRU, 8 sheets), cuts out the tile and gives it to mpv as a raw
  BGRA file in the app's temp folder through `overlay-add`. The file is deleted when the player closes.

**Errors.**
- A stall over 15 s shows "Reconnecting…", and mpv reloads at the position up to 3 times.
- A 401 from any call closes the player and reloads the web app, which shows sign-in.
- If mpv exits unexpectedly, the app shows a message and offers "Play in the web player" (`/watch/<id>` in the window).

## 5. Desktop shell extras

- **Tray icon:** open, the server address (read-only), settings, quit. Closing the window quits the app.
- **Single instance:** a second start, or a `friendflix://watch/<id>` link, focuses the window. A watch link plays that title
  for the last active profile, or opens `/watch/<id>` in the window when no profile is known yet.
- **Remembered** in `%APPDATA%\FriendFlix\settings.json`: window size, position and maximised state, the server address and the
  settings below.
- **Settings page** (local, bundled; opened from the tray or the web app's `openSettings`):
  - server address;
  - updates: automatic or ask first (default automatic);
  - hardware decoding auto or off (`hwdec=auto-safe` / `no`);
  - start the player in fullscreen (default on);
  - start with Windows (default off).
- **Updates:**
  - The Tauri updater checks `latest.json` on GitHub Releases at start and every 24 h.
  - "Automatic" installs on the next app start. "Ask first" shows a banner with *Install and restart*.
  - It never installs while the player runs.
  - The update is checked against the public key in the app; a bad signature is refused and logged.

## 6. Security

- Tauri capabilities:
  - the remote server origin may call only `bridge_message`;
  - the bundled local pages (setup, settings) may call only the settings commands;
  - no shell, file-system or HTTP plugins for any web page.
- Stream, subtitle and trickplay URLs are used only when they are on the server origin. The server answers' JSON is checked
  for size and types before use (as `PlayerApi` does).
- mpv is started as `mpv.exe --no-config --config-dir=<app>\mpv --load-scripts=no --script=<app>\friendflix.lua --ytdl=no
  --input-ipc-server=\\.\pipe\friendflix-<random 128-bit>`, plus the `protocol_whitelist` `http,https,tls,tcp,crypto,file`
  (`file` only for the local trickplay overlays).
- The named pipe is created by mpv for the current user. `app` checks after connecting that the pipe's owner is the current
  user and drops the connection otherwise.
- The session cookie is never logged, written to disk by the app or put on a command line.
- Logs are in `%LOCALAPPDATA%\FriendFlix\logs`, with no tokens, cookies or full stream URLs (query strings removed), and are
  deleted after 14 days. There is no telemetry.
- mpv binary:
  - a pinned Windows build (shinchiro's mpv-winbuild-cmake release) downloaded in CI and checked against its SHA-256 in
    `desktop/player/mpv.lock`;
  - its licence texts are installed next to it (GPL/LGPL, compatible with FriendFlix's AGPL-3.0).

## 7. Build, release and owner steps

- `ci.yml`:
  - a job `desktop-core` runs `cargo fmt --check`, `cargo clippy -D warnings` and `cargo test` for `desktop/core` on Linux;
  - the Lua tests run in the same job with `lua5.4`.
- `release.yml`, on a tag, runs the job `desktop-release` (`windows-latest`, a new `desktop-release.yml` called like
  `android-release.yml`):
  - builds `app` with the pinned mpv;
  - signs the update with `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`;
  - attaches `FriendFlix_<version>_x64-setup.exe`, the `.msi`, their `.sig` files, `latest.json` and SHA-256 sums to the GitHub
    Release.
  - Without the secrets it builds unsigned installers, skips `latest.json` and leaves a notice.
- The app's version is `version.json`'s version, which is the Tauri bundle version.
- Owner steps (in `docs/windows.md`):
  - generate the key once with `npx @tauri-apps/cli signer generate`;
  - store the two secrets in GitHub; keep the private key in the password manager as well;
  - test the first build on a Windows PC with the manual checklist.

## 8. Testing

- `core` unit tests:
  - bridge parsing and answers (each method, bad JSON, size limit);
  - the origin check (exact origin, `authOrigin`, look-alike hosts, ports, `http` vs `https`);
  - the `playback/info` parsing and `InfoAnswer` mapping, with a mock HTTP server and each status;
  - stream choice and the one-time HLS fallback;
  - the reporting schedule (start, 10 s, pause, seek, stop, dropped on error);
  - the next-episode card time (Outro, else 25 s);
  - "still watching?" counting;
  - segment skip windows;
  - subtitle-style mapping (each value, unknown values fall back);
  - the anime choice;
  - trickplay frame maths (first, last, sheet boundary, clamping);
  - URL scrubbing for logs.
- Lua tests: time format, seek-bar position to time, chapter-mark positions, control auto-hide timing.
- Web: the bridge marker tests and the e2e hand-off test (section 3).
- Manual checklist in `docs/windows.md`:
  - install, SmartScreen, first start, sign-in with Authentik and with a passkey;
  - Play from home, detail page and episode list; resume across devices;
  - the HLS fallback with the remote cap;
  - tracks and the saved choice, the subtitle style, anime;
  - skip intro, next episode and still watching;
  - chapters and trickplay; media keys and SMTC;
  - tray, single instance, `friendflix://`;
  - update automatic and ask first; uninstall.
- Docs: `docs/windows.md` and `docs/de/windows.md`, a README line, a CHANGELOG entry under "### Windows app".
