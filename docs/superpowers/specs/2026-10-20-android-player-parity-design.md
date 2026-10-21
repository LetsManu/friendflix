# Android native player: the web player's controls

Status: approved in conversation on 2026-10-20: port everything into the native player, no "use the web player" switch. The work ships as one PR.
Builds on [2026-10-19-android-app-design.md](2026-10-19-android-app-design.md) (the native Media3 player in `android/app/.../player/`).

## 1. Why

The Android app hands every `/watch` and Play button to the native Media3 player. The native player plays well, but the owner misses
"the buttons for all the settings" that the web player has. Today the native player has: back, title, Chromecast, quality, tracks
(audio and subtitles), picture-in-picture, ±10 s, play/pause, the seek bar and next episode.

Success: on an Android phone, everything that sits behind a button of the web player's control bar is reachable in the native
player in the same order. It uses the same server APIs, needs no server change, and keeps what only the native player can do:
background audio, the lock screen, picture-in-picture and offline playback.

## 2. Scope

In scope, in the order of the web player's bar:

| # | Button / place | Behind it |
|---|---|---|
| 1 | Bottom bar: **Episodes** (series only) | seasons and episodes, switch episode |
| 2 | Bottom bar: **Scenes** (when the server has chapters) | chapter list with images; chapter and bookmark marks on the seek bar |
| 3 | Top bar: **Cast & info** | cast, guests, crew, genres of the playing title; a person's other titles |
| 4 | Top bar: **Tracks** (extended) | audio, subtitles, *Search subtitles…*, **Clear voices**, **Night mode** |
| 5 | Top bar: **More (⋯)** | Speed, Bookmarks and share scene, Quality, Sleep timer, Lock controls, Picture-in-picture |
| 6 | Top bar: **quality chip** | "Original" or "Converted · 1080p"; a tap shows the reason |
| 7 | Seek bar | trickplay preview while scrubbing |
| 8 | End of a title | post-play card and screen; "More like this" for movies without post-play |
| 9 | Subtitles | the user's subtitle style; the anime default (original audio with subtitles) |

Not in scope (stay as they are): swipe gestures for volume/brightness, double-tap seek, keyboard shortcuts and the help overlay,
AirPlay, watch parties (`/party` is not handed to the native player), the automatic Cast & info panel on pause and the 6-second
"peek" while playing (the native panel opens on the button only).

## 3. Server APIs used (all exist; no server change)

| Feature | Endpoint | Gate |
|---|---|---|
| Episodes | `GET /api/items/:seriesId/seasons`, `GET /api/items/:seriesId/episodes?seasonId=` → `{items}` | none |
| Chapters | `GET /api/items/:id/chapters` → `{supported, chapters:[{start, name, image?}]}` | `/api/me` `server.capabilities.chapters` |
| Trickplay | `trickplay {width,height,tileWidth,tileHeight,count,interval,url}` in `/api/playback/info`; `url` has `{n}` = sheet | `capabilities.trickplay` |
| Cast & info | `GET /api/items/:id/castinfo`; `GET /api/people/:id` → `{items}` | none |
| Bookmarks | `GET /api/bookmarks?itemId=`, `POST /api/bookmarks {itemId, position, note?}`, `DELETE /api/bookmarks/:id` | none |
| Subtitle search | `GET /api/items/:id/subtitles/search?lang=` → `{results}`, `POST /api/items/:id/subtitles/download {subtitleId}` | `capabilities.subtitleSearch`; 403 for guests |
| Audio effects | `GET /api/prefs` `prefs.audioFx`; `PUT /api/prefs/audiofx {audioFx: off\|voices\|night\|both}` | none |
| Subtitle style | `GET /api/prefs` `prefs.subtitleStyle` (already parsed by `PlayerApi`) | none |
| Anime default | `GET /api/series/:id/langpref?anime=1` when `prefs.animeOriginal` | none |
| Post-play | `GET /api/items/:id/postplay`, `POST /api/postplay/event` | `/api/me` `features.postplay` and `prefs.postplay` |
| More like this | `GET /api/items/:id/similar` → `{items}` | none |

A missing capability flag counts as true (as in the web, `web/src/lib/capabilities.ts`). When a request fails, the matching button
or row is hidden or shows the web's error text; playback never stops because of these features. Offline playback (a download)
hides every button that needs the server: Episodes, Scenes from the server, Cast & info, bookmarks, subtitle search and post-play.
Speed, audio effects, subtitle style, sleep timer and lock work offline (audio effects use the last known setting).

## 4. Behaviour, matching the web

- **Episodes:** the current season is preselected (else the first); with no seasons, all episodes. Each row shows code, name,
  runtime, a progress bar and a "playing" mark. A pick plays that episode in the same player (the path the next-episode button
  already uses). Cached per series while the player is open.
- **Scenes:** chapters sorted, duplicate starts dropped, an image only when its path starts with `/`. A tap seeks and closes the
  panel. Chapter starts and bookmark positions are drawn as marks on the seek bar.
- **Trickplay:** while scrubbing, a 168 dp wide preview above the thumb. Frame: `idx = clamp(floor(t·1000 / interval), 0, count-1)`,
  `per = tileWidth·tileHeight`, sheet `idx / per`, tile `idx % per`, `x = (tile % tileWidth)·width`,
  `y = (tile / tileWidth)·height`; the sheet URL is `url` with `{n}` replaced. Sheets are cached in memory (LRU).
- **Cast & info:** the title line (name, year, rating), then cast, guests, directors, writers, creators, studios and genres,
  with portraits. A tap on a person lists their titles; a tap on a title closes the player and opens that title's page in the app.
- **Tracks:** as today, plus *Search subtitles…* (when allowed): languages German, English, French, Spanish, Italian, a result
  list (name, provider, downloads), download, then a playback-info reload at the same position (the path a quality change already
  uses) and the toast "Subtitles added – pick them in the menu". Errors: not allowed, nothing found, provider down, download failed.
- **Clear voices / night mode:** two switches; the setting is saved with `PUT /api/prefs/audiofx` and read from `/api/prefs`.
  Natively with `android.media.audiofx.DynamicsProcessing` on the player's audio session (Android 9, API 28, and newer), mapped from
  the web's chain (`web/src/lib/player/audiofx.ts`):
  - clear voices: pre-EQ −4 dB below 180 Hz, +6 dB around 2.5 kHz, −2 dB above 8 kHz; compressor threshold −24 dB, ratio 3,
    attack 10 ms, release 250 ms; +1.9 dB (×1.25) when night mode is off;
  - night mode: compressor threshold −42 dB, ratio 8, attack 4 ms, release 300 ms; +6.8 dB (×2.2); limiter threshold −4 dB,
    ratio 20, attack 1 ms, release 100 ms.
  The switches are disabled with a note on Android 8, while casting, and when the audio is passed through undecoded.
- **Speed:** 0.5, 0.75, 1, 1.25, 1.5, 2; a badge on the More button when not 1; not saved (starts at 1 for every title), as in
  the web; disabled while casting.
- **Bookmarks:** "Share scene (12:34)" shares `${origin}/watch/${itemId}?t=${seconds}` with the Android share sheet; a note field
  (max 140) and an add button; the list seeks on tap and has a remove button. Errors as in the web (too many, failed).
- **Quality:** the existing quality choices move into More; the chip shows "Original" (direct play) or "Converted · {rung}" and
  a tap explains the reason (network, remote cap, role cap, container, video codec, audio codec, audio track, subtitles,
  resolution, manual, other).
- **Sleep timer:** off, 15, 30, 45, 60 minutes, "After this episode". When it fires: pause and toast "Sleep timer: playback
  paused". "After this episode" suppresses the next-episode countdown and pauses at the end. The time left shows in More and as a
  dot on the More button. It keeps running with background audio.
- **Lock controls:** hides all controls and ignores touches except a lock icon; hold it 0.6 s to unlock (a short tap shows
  "Press and hold to unlock").
- **Picture-in-picture:** moves from the top bar into More (still entered automatically on Home, as today).
- **Subtitle style:** applied to Media3's subtitle view: size s/m/l/xl, colour white/yellow/cyan/green, background
  none/shadow/semi/solid, font sans/serif/mono, the web's values (`web/src/lib/Player.svelte` CSS: sizes .9/1.15/1.5/1.9 em, colours
  `#fff`/`#ffe14d`/`#4de8ff`/`#6dff7a`, semi = black at 65 %).
- **Anime default:** `langpref` asks with `?anime=1` when `prefs.animeOriginal`; when the answer says `anime` and there is no saved
  audio or subtitle choice, prefer Japanese audio and, while the audio is Japanese, subtitles in the app language
  (`web/src/lib/player/anime.ts`).
- **Post-play:** when post-play is wanted (feature on, preference on, no next episode, a movie or episode, not casting): at the
  post-play time (the outro start, else the last chapter after 80 %, else 95 %) a card "Done? See what's next"; at the end the
  post-play screen opens by itself. The screen shows the rows from `/api/items/:id/postplay` as poster rows; a tap on a title
  closes the player and opens its page in the app; *Play* on the `next` or `sequel` entry plays it in the player. It sends the same
  `POST /api/postplay/event` events as the web. For a movie without post-play: "More like this" with three titles from `/similar`.

## 4a. Chromecast stays a first-class part of the player

Chromecast is a must for the app. Nothing in this work removes or hides it:

- The Chromecast button stays in the top bar, first on the right, as today. More (⋯) also gets a *Play on TV* / *Playing on TV*
  entry (the web's cast row), shown when a Cast device is available or connected.
- While casting, the new controls act on the TV session:
  - Episodes plays the picked episode on the TV, through the cast queue the next-episode flow already uses.
  - Scenes and bookmarks seek the TV, and a new bookmark takes the TV's position.
  - The sleep timer pauses the TV.
  - Cast & info and the quality chip show the cast title.
- Not offered while casting, as today or as in the web: changing audio, subtitles or quality, speed, Clear voices and Night
  mode, subtitle search, and post-play.
- The subtitle style keeps going to the receiver (it already does).
- A Robolectric test checks that the Chromecast button and the More entry are present when a Cast device is available, and that
  the controls listed above switch to the cast player while a cast session runs.

## 5. Code structure

`PlayerActivity.kt` is 1,219 lines; the new features go into their own files under `player/`, and the activity only wires them:

- `PlayerApi.kt`: the new endpoints (methods returning parsed data classes, `null` or an error code on failure).
- `ImageLoader.kt`: OkHttp with the session cookie of the server origin only, memory LRU, sampled decoding; posters, portraits,
  chapter images and trickplay sheets.
- `panels/PlayerPanel.kt`: one bottom panel host (overlay inside the player, back closes it, the player keeps running); the
  panels `EpisodesPanel`, `ScenesPanel`, `CastInfoPanel`, `TracksPanel`, `MorePanel`, `BookmarksPanel`, `SubtitleSearchPanel`,
  `PostPlayPanel` are views built on it.
- `AudioFx.kt`: the mode → `DynamicsProcessing.Config` mapping (pure, unit-tested) and attach/release on the audio session.
- `SubtitleLook.kt`: style → `CaptionStyleCompat` and text size (pure, unit-tested).
- `Trickplay.kt`: frame math (pure, unit-tested) and the preview view.
- `SleepTimer.kt`, `ControlsLock.kt`, `QualityChip.kt`, `Chapters.kt` (normalise, marks), `PostPlayTiming.kt` (the card time, pure).
- Strings in `res/values` and `res/values-de`, taken from the web's English and German texts.

## 6. Testing

- Robolectric unit tests for every pure part: trickplay frames (first, last, sheet boundary, clamping), chapter normalisation,
  audio-effect configs for each mode, subtitle-style mapping (each value and unknown values), sleep-timer firing and "after this
  episode", post-play time selection, anime track choice, the share URL, and `PlayerApi` parsing with MockWebServer (each endpoint,
  error codes, a missing capability).
- Robolectric activity tests: the bar shows Episodes only for episodes, Scenes only with chapters, subtitle search only when
  allowed; offline playback hides the server buttons; lock blocks the controls until a long press.
- The emulator test keeps passing; the manual device checklist in `docs/android.md` gets the new controls.
- Docs: `docs/android.md` and `docs/de/android.md` (player section, checklist), CHANGELOG.
