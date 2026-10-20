# Android Player Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The native Android player gets every control of the web player's bar (episodes, scenes, cast & info, extended tracks, more menu, quality chip, trickplay, post-play, subtitle style, anime default) with Chromecast kept first-class.

**Architecture:** New features live in focused files under `player/` (pure logic files plus `panels/` views); `PlayerActivity.kt` only wires them. All data comes from existing server endpoints through `PlayerApi`. One bottom panel host replaces the `PopupMenu`s.

**Tech Stack:** Kotlin, Media3 1.11 (ExoPlayer, UI, Cast), OkHttp via `ServerApi`, `android.media.audiofx.DynamicsProcessing`, Robolectric + MockWebServer tests.

**Spec:** `docs/superpowers/specs/2026-10-20-android-player-parity-design.md`

## Global Constraints

- Paths: main code `android/app/src/main/kotlin/app/friendflix/android/player/` (= `P/`), tests `android/app/src/test/kotlin/app/friendflix/android/player/` (= `T/`), strings `android/app/src/main/res/values/strings.xml` and `values-de/strings.xml`.
- Test command (from `android/`, with `ANDROID_HOME=/home/user/android-sdk`): `./gradlew testDebugUnitTest --tests '<class>'`; before each commit also `./gradlew lint` (warnings are errors).
- No new dependency (no Material, no Coil/Glide). Views are plain Android views / XML layouts in the existing player style.
- No server change. Endpoints exactly as in spec §3. A missing capability flag counts as true.
- Every file starts with the two SPDX lines (`// SPDX-FileCopyrightText: 2026 Manuel Weißböck`, `// SPDX-License-Identifier: AGPL-3.0-or-later`; XML: `<!-- … -->`).
- User texts: English in `values`, German in `values-de`, copied from the web's `web/src/lib/i18n/locales/{en,de}/{player,scenes,postplay}.ts` where the web has the text. Never the word "Seerr".
- Network is off the main thread (`Dispatchers.IO`); a failed feature request never stops playback; URLs, cookies and tokens are never logged.
- Offline playback (`args.licenseId != null`) hides Episodes, Scenes, Cast & info, bookmarks, subtitle search, post-play.
- Chromecast: the `MediaRouteButton` stays in the top bar first on the right; while casting, seek/episode/sleep act on the TV, and audio/subtitle/quality changes, speed, audio effects, subtitle search and post-play are not offered (spec §4a).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`.

## Review Focus

- Back while a panel is open closes the panel, not the player (Task 4 test `backClosesPanelFirst`).
- Entering picture-in-picture or casting while a panel is open hides the panel; no panel shows in PiP (Task 4 test `pipHidesPanel`).
- A panel request that fails (network, 5xx, 403) shows the web's error text in the panel and playback keeps running (Task 6/7/8/9 tests `*FailureShowsError`).
- Sleep timer "after this episode" with autoplay on: the next-episode countdown does not start and playback pauses at the end (Task 5 test `afterEpisodeSuppressesAutoplay`).
- Switching episode from the Episodes panel resets per-title state (speed back to 1, bookmarks/chapters reloaded, sleep "after episode" consumed) like the next-episode path (Task 7 test `pickResetsTitleState`).

---

### Task 1: PlayerApi endpoints

**Files:**
- Modify: `P/PlayerApi.kt`
- Test: `T/PlayerApiExtrasTest.kt` (MockWebServer, pattern of existing `downloads` tests that build a `ServerApi` against MockWebServer)

**Interfaces:**
- Produces (all blocking, return `null` / empty on failure unless noted):
  - `data class ServerCaps(val chapters: Boolean = true, val trickplay: Boolean = true, val subtitleSearch: Boolean = true, val postplay: Boolean = true, val segments: Set<String> = ALL_SEGMENTS, val role: String? = null)`; `fun caps(): ServerCaps` (one `/api/me` read: `server.capabilities.*`, `features.postplay`, `user.role`); `segmentTypes()` stays and delegates to it.
  - `PlayerPrefs` gains `audioFx: String = "off"` (`off|voices|night|both`), `animeOriginal: Boolean = false`, `postplay: Boolean = true`.
  - `PlaybackInfo` gains `trickplay: TrickplayInfo?`; `data class TrickplayInfo(val width: Int, val height: Int, val tileWidth: Int, val tileHeight: Int, val count: Int, val intervalMs: Long, val url: String)`.
  - `data class Episode(val id: String, val name: String, val season: Int?, val episode: Int?, val image: String?, val runtimeTicks: Long, val positionTicks: Long, val played: Boolean)`, `data class Season(val id: String, val name: String, val index: Int?)`; `fun seasons(seriesId: String): List<Season>?`, `fun episodes(seriesId: String, seasonId: String?): List<Episode>?`.
  - `data class Chapter(val startSec: Double, val name: String, val image: String?)`; `fun chapters(itemId: String): List<Chapter>?` (raw, normalised in Task 2).
  - `data class Person(val id: String, val name: String, val image: String?, val role: String?)`, `data class CastInfo(val name: String, val year: Int?, val rating: String?, val communityRating: Double?, val cast: List<Person>, val guests: List<Person>, val directors: List<Person>, val writers: List<Person>, val creators: List<Person>, val studios: List<String>, val genres: List<String>)`; `fun castInfo(itemId: String): CastInfo?`; `data class Title(val id: String, val name: String, val type: String?, val year: Int?, val image: String?)`; `fun personTitles(personId: String): List<Title>?`; `fun similar(itemId: String): List<Title>?`.
  - `data class Bookmark(val id: String, val positionSec: Int, val note: String?)`; `fun bookmarks(itemId: String): List<Bookmark>?`; `fun addBookmark(itemId: String, positionSec: Int, note: String?): ApiResult<String>` (id); `fun removeBookmark(id: String): Boolean`.
  - `data class SubResult(val id: String, val name: String, val provider: String, val downloads: Int)`; `fun searchSubtitles(itemId: String, lang3: String): ApiResult<List<SubResult>>`; `fun downloadSubtitle(itemId: String, subtitleId: String): ApiResult<Unit>`.
  - `fun saveAudioFx(mode: String): Boolean` (`PUT /api/prefs/audiofx {audioFx}`).
  - `langPref(seriesOrItem: String, anime: Boolean = false): LangPref` with `data class LangPref(val audio: String?, val subtitle: String?, val anime: Boolean)` (replaces the `Pair`; update the one caller).
  - `fun postplay(itemId: String): JSONObject?` (kept raw, parsed in Task 10) and `fun postplayEvent(body: JSONObject)` (best effort).
  - `sealed interface ApiResult<out T> { data class Ok<T>(val value: T); data class Err(val code: Int, val error: String?) }`.
- DELETE uses `server.sendJson(path, profileId, JSONObject(), method = "DELETE")`.

- [ ] **Step 1: Write failing tests** — one per endpoint: success parse (fields above from a JSON fixture shaped as spec §3), non-200 → null/`Err(code, error)`, `caps()` with an empty `/api/me` → all flags true, `langPref(anime = true)` requests `?anime=1`, `addBookmark` 409 → `Err(409, "too_many_bookmarks")`, `searchSubtitles` 403 → `Err(403, …)`, 502 → `Err(502, "subtitle_provider_unavailable")`, `parseInfo` with `trickplay` → `TrickplayInfo` and without → null.
- [ ] **Step 2: Run** `./gradlew testDebugUnitTest --tests 'app.friendflix.android.player.PlayerApiExtrasTest'` — FAIL.
- [ ] **Step 3: Implement** in `PlayerApi.kt` (reuse the private `get`; `SessionExpired` still propagates).
- [ ] **Step 4: Run** same command — PASS; also `--tests 'app.friendflix.android.player.*'` stays green.
- [ ] **Step 5: Commit** `android: PlayerApi endpoints for the web player's controls`.

### Task 2: Pure player logic

**Files:**
- Create: `P/Trickplay.kt`, `P/Chapters.kt`, `P/SubtitleLook.kt`, `P/AudioFx.kt` (config part only), `P/PostPlayTiming.kt`, `P/AnimePick.kt`, `P/SleepTimer.kt`, `P/Scene.kt`
- Test: `T/TrickplayTest.kt`, `T/ChaptersTest.kt`, `T/SubtitleLookTest.kt`, `T/AudioFxTest.kt`, `T/PostPlayTimingTest.kt`, `T/AnimePickTest.kt`, `T/SleepTimerTest.kt`, `T/SceneTest.kt`

**Interfaces:**
- Consumes: `TrickplayInfo`, `Chapter`, `SubtitleStyle`, `AudioTrack`, `SubtitleTrack`, `Segment` (Task 1 / existing).
- Produces:
  - `data class Frame(val sheet: Int, val x: Int, val y: Int, val width: Int, val height: Int)`; `fun trickplayFrame(t: TrickplayInfo, positionMs: Long): Frame`; `fun sheetUrl(t: TrickplayInfo, sheet: Int): String`.
  - `fun normaliseChapters(raw: List<Chapter>): List<Chapter>` (sorted by start, duplicate starts dropped, image kept only if it starts with `/`).
  - `data class CaptionLook(val foreground: Int, val background: Int, val edgeType: Int, val edgeColor: Int, val typeface: android.graphics.Typeface, val fractionalSize: Float)`; `fun captionLook(s: SubtitleStyle): CaptionLook`. Sizes: `s .9, m 1.15, l 1.5, xl 1.9` × `SubtitleView.DEFAULT_TEXT_SIZE_FRACTION`; colours `#FFFFFF #FFE14D #4DE8FF #6DFF7A`; background none = transparent, shadow = transparent + `EDGE_TYPE_DROP_SHADOW` black, semi = `#A6000000`, solid = `#FF000000`; font sans/serif/mono = `Typeface.SANS_SERIF/SERIF/MONOSPACE`; unknown values fall back to the defaults m/white/semi/sans.
  - `data class FxStage(...)`-free API: `fun fxConfig(mode: String): FxParams?` (null for `off`) with `data class FxParams(val preEq: List<Pair<Float, Float>>, val compressor: Comp?, val limiter: Comp?, val gainDb: Float)`, `data class Comp(val thresholdDb: Float, val ratio: Float, val attackMs: Float, val releaseMs: Float)`. Values from spec §4: voices preEq `(180f, -4f), (2500f, 6f), (8000f, -2f)` (band cutoffs `180, 4000, 20000` with gains `-4, +6, -2`), voices compressor `-24, 3, 10, 250`, voices-only gain `+1.94` dB; night compressor `-42, 8, 4, 300`, gain `+6.85` dB, limiter `-4, 20, 1, 100`; `both` = voices preEq + night compressor + night limiter + night gain.
  - `fun postplayAtSec(durationSec: Double, segments: List<Segment>, chapters: List<Chapter>): Double` — outro start if present, else last chapter start ≥ 80 % of duration, else 95 %.
  - `fun creditsStartSec(durationSec: Double, segments: List<Segment>): Double` — outro start if ≥ duration/2, else duration − 25 (reuse if `EpisodeFlow` already has it: then only re-export).
  - `data class AnimeChoice(val audioLang: String?, val subtitleLang: String?)`; `fun animeChoice(pref: LangPref, animeOriginal: Boolean, appLang: String, audioIsJapanese: Boolean): AnimeChoice?` — non-null only when `animeOriginal && pref.anime && pref.audio == null && pref.subtitle == null`: audio `"jpn"`, subtitle = `appLang` (ISO 639-2, e.g. `ger`/`eng`) only while `audioIsJapanese`.
  - `class SleepTimer(private val now: () -> Long)`: `fun set(minutes: Int)`, `fun setAfterEpisode()`, `fun off()`, `val afterEpisode: Boolean`, `fun remainingMs(): Long?`, `fun due(): Boolean` (true once when the time passed, then clears).
  - `fun shareUrl(origin: String, itemId: String, positionMs: Long): String` = `"$origin/watch/$itemId?t=${positionMs / 1000}"`; `val SPEEDS = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f)`.

- [ ] **Step 1: Write failing tests** — trickplay: `t=0` → sheet 0 x0 y0; last frame of sheet 0 and first of sheet 1 with tile 10×10; `positionMs` beyond count clamps to `count-1`; `sheetUrl` replaces `{n}`. Chapters: unsorted+duplicate input, `image="http://x"` dropped. SubtitleLook: each value of each field, unknown → defaults. AudioFx: `off` → null; each mode's exact numbers above. PostPlayTiming: outro, chapter ≥ 80 %, chapter < 80 % ignored, fallback 95 %. Anime: the three branches. SleepTimer: `set(15)` due at +15 min once; `off()`; `setAfterEpisode` → `afterEpisode` true and `remainingMs` null. Scene: `shareUrl("https://friend.example.com","abc",754_900)` = `https://friend.example.com/watch/abc?t=754`.
- [ ] **Step 2: Run** `./gradlew testDebugUnitTest --tests 'app.friendflix.android.player.*'` — the new tests FAIL.
- [ ] **Step 3: Implement** the functions above (pure Kotlin; `captionLook` uses `CaptionStyleCompat` constants and `android.graphics.Color`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `android: player logic for trickplay, chapters, subtitle look, audio effects, sleep timer`.

### Task 3: ImageLoader

**Files:**
- Create: `P/ImageLoader.kt`
- Test: `T/ImageLoaderTest.kt` (MockWebServer serving a small PNG)

**Interfaces:**
- Consumes: `ServerApi.resolve(path)`, `ServerApi.small(url, max)`.
- Produces: `class ImageLoader(private val server: ServerApi, maxBytes: Int = 4 * 1024 * 1024)`: `suspend fun load(path: String, targetWidthPx: Int): Bitmap?` (same-origin paths only — a path not starting with `/` or resolving to another origin returns null; memory `LruCache` keyed by path+width, 24 MB; `BitmapFactory` with `inSampleSize` for the target width); `fun into(view: ImageView, path: String?, targetWidthPx: Int, scope: CoroutineScope)` (sets a tag so a recycled view never shows a stale bitmap).

- [ ] **Step 1: Failing tests** — loads and caches (second call makes no request), foreign origin / absolute URL → null without a request, 404 → null, oversize → null.
- [ ] **Step 2: Run** `--tests 'app.friendflix.android.player.ImageLoaderTest'` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `android: same-origin image loader for the player panels`.

### Task 4: Control bar, panel host, Tracks and More panels

**Files:**
- Create: `P/panels/PlayerPanel.kt`, `P/panels/TracksPanel.kt`, `P/panels/MorePanel.kt`, `P/QualityChip.kt`, `android/app/src/main/res/layout/player_panel.xml`, icons in `res/drawable/` (`ic_player_episodes`, `ic_player_scenes`, `ic_player_info`, `ic_player_more`, `ic_player_lock`, `ic_player_speed`, `ic_player_sleep`, `ic_player_bookmark`, `ic_player_search` as vector drawables in the style of the existing `ic_player_*`)
- Modify: `res/layout/player_controls.xml`, `res/layout/activity_player.xml`, `P/PlayerActivity.kt` (remove `showTracks`/`showQuality` PopupMenus, wire panels), strings EN/DE
- Test: `T/PlayerControlsTest.kt` (Robolectric, `PlayerActivity` started with a fake server via MockWebServer like existing activity tests, or the panel classes directly when the activity is too heavy)

**Interfaces:**
- Produces:
  - `class PlayerPanel(root: FrameLayout)`: `fun show(title: CharSequence, content: View, onClose: () -> Unit = {})`, `fun close(): Boolean` (false when none open), `val isOpen: Boolean`. A bottom sheet overlay (max 60 % height on phones, scrollable), dim behind, tap outside or back closes; the player keeps running.
  - `TracksPanel.build(ctx, state: TracksState, actions: TracksActions): View` with `data class TracksState(val audio: List<AudioTrack>, val audioIndex: Int?, val subs: List<Pair<Int, String>>, val subIndex: Int?, val canSearch: Boolean, val fxMode: String, val fxDisabledReason: Int?)` and `interface TracksActions { fun audio(t: AudioTrack); fun subtitle(index: Int?); fun search(); fun fx(mode: String) }` (`fxDisabledReason` = string res id or null).
  - `MorePanel.build(ctx, state: MoreState, actions: MoreActions): View` with rows: Speed (opens speed list `SPEEDS`), Bookmarks (Task 8 fills it; hidden offline), Quality (existing `QUALITIES` + Auto, hidden offline/casting), Sleep timer (Off, 15, 30, 45, 60, After this episode, remaining time), Lock controls, Picture-in-picture (when supported), Play on TV / Playing on TV (when cast available or connected).
  - `QualityChip`: text "Original" / "Converted · {label}", tap shows the reason string for `transcodeReason` (`network, remoteCap, roleCap, container, videoCodec, audioCodec, audioTrack, subtitles, height, manual, other`).
- Bar layout: top bar right = `[Chromecast][Cast & info][Tracks][More]` + quality chip left of them; bottom bar right of duration = `[Episodes][Scenes][Next]`. The old `player_quality` and `player_pip` top-bar buttons go into More.
- In the activity: speed via `player.setPlaybackSpeed`, reset to 1 on every new title, badge on More when ≠ 1; sleep via `SleepTimer` checked in the existing `tick()`; lock = hide controller (`view.useController = false`), overlay with a lock icon, `OnLongClickListener` after 600 ms unlocks, a short tap toasts "Press and hold to unlock".

- [ ] **Step 1: Failing tests** — `backClosesPanelFirst` (panel open → `onBackPressed` closes panel, activity not finishing); `pipHidesPanel` (enter PiP state → panel closed); More shows Play on TV only when cast devices are available; Speed 1.5 → `player.playbackParameters.speed == 1.5f` and a new title resets to 1; lock hides the controller and a long press restores it; Tracks lists audio only when more than one track; the Chromecast button stays visible in the top bar when cast devices are available.
- [ ] **Step 2: Run** `--tests 'app.friendflix.android.player.PlayerControlsTest'` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all player tests + `./gradlew lint` — PASS.
- [ ] **Step 5: Commit** `android: player bar with panels for tracks and more (speed, quality, sleep, lock, pip, cast)`.

### Task 5: Subtitle style, audio effects, anime default, sleep wiring

**Files:**
- Create: `P/AudioFxAttach.kt` (DynamicsProcessing on the audio session)
- Modify: `P/PlayerActivity.kt`, `P/EpisodeFlow.kt` (only if needed for "after this episode"), strings
- Test: `T/AudioFxAttachTest.kt`, `T/PlayerControlsTest.kt` (extend)

**Interfaces:**
- Consumes: `captionLook`, `fxConfig`, `animeChoice`, `SleepTimer`, `PlayerApi.saveAudioFx`, `langPref(…, anime)`, `TracksActions.fx`.
- Produces: `class AudioFxAttach(private val sdk: Int = Build.VERSION.SDK_INT)`: `fun supported(): Boolean` (API ≥ 28), `fun apply(sessionId: Int, mode: String)` (builds `DynamicsProcessing.Config` from `fxConfig`: pre-EQ on, 3 bands; MBC 1 band with the compressor; limiter; input gain; releases the old instance), `fun release()`.
- Rules: subtitle look applied to `view.subtitleView` on start and when prefs load (`setStyle`, `setFractionalTextSize`, `setApplyEmbeddedStyles(false)`); fx mode from `prefs.audioFx`, a switch saves via `saveAudioFx` and applies at once; fx disabled reason = Android 8 / casting / offline-unknown; anime choice used for the first `infoBody` audioLang and the initial subtitle pick when it applies; sleep "after this episode" makes the next-episode card not count down and pauses at the end; a 15–60 min timer pauses the local player or the cast session when due and toasts "Sleep timer: playback paused".

- [ ] **Step 1: Failing tests** — `AudioFxAttach.supported()` false on 26, true on 28; `apply` with `night` creates a config whose limiter and MBC thresholds equal Task 2 values (Robolectric shadow or a seam that returns the built `Config`); `afterEpisodeSuppressesAutoplay`; anime: prefs `animeOriginal=true` + langpref `{anime:true}` → the first info body has `audioLang=jpn`; subtitle style `{size:"xl", color:"yellow"}` → `subtitleView` got the yellow foreground.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** player tests + lint — PASS.
- [ ] **Step 5: Commit** `android: subtitle style, clear voices and night mode, anime default, sleep timer`.

### Task 6: Subtitle search

**Files:**
- Create: `P/panels/SubtitleSearchPanel.kt`
- Modify: `P/PlayerActivity.kt` (`TracksActions.search`), strings
- Test: `T/SubtitleSearchPanelTest.kt`

**Interfaces:**
- Consumes: `searchSubtitles`, `downloadSubtitle`, `ServerCaps.subtitleSearch`, `reload(positionMs)` (existing activity path).
- Produces: `SubtitleSearchPanel.build(ctx, scope, api: PlayerApi, itemId: String, defaultLang: String, onAdded: () -> Unit): View` — language choice German/English/French/Spanish/Italian (`ger, eng, fre, spa, ita`, default = app language), result rows (name, provider, downloads), download; on success `onAdded` (activity reloads at the current position and toasts "Subtitles added – pick them in the menu").
- Shown only when `caps.subtitleSearch`, online and not casting. Error texts: 403 not allowed, empty results not found, 502 provider down, download 502 failed.

- [ ] **Step 1: Failing tests** — results render; 403 → not-allowed text (`subtitleSearchFailureShowsError`); download success calls `onAdded` once; empty list → not-found text.
- [ ] **Step 2: Run** — FAIL. - [ ] **Step 3: Implement.** - [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `android: subtitle search in the player`.

### Task 7: Episodes panel

**Files:**
- Create: `P/panels/EpisodesPanel.kt`, `res/layout/item_player_episode.xml`
- Modify: `P/PlayerActivity.kt` (bottom-bar Episodes button; a `playItem(id)` extracted from `goNext` and used by both)
- Test: `T/EpisodesPanelTest.kt`

**Interfaces:**
- Consumes: `seasons`, `episodes`, `ImageLoader`, cast start path for the TV.
- Produces: `EpisodesPanel.build(ctx, scope, api, images, seriesId: String, currentSeason: Int?, currentId: String, onPick: (String) -> Unit): View` — season tabs (current season preselected, else first; no seasons → all episodes), rows: `S1:E2`, name, runtime, progress bar from `positionTicks/runtimeTicks`, playing mark on `currentId`; results cached per series while the player lives. Activity `playItem(id)`: same reset as `goNext` (speed 1, sleep "after episode" consumed, chapters/bookmarks reloaded); while casting it starts that episode on the TV through `CastController`.

- [ ] **Step 1: Failing tests** — current season preselected; no seasons → episodes without `seasonId`; `episodesFailureShowsError`; `pickResetsTitleState` (speed back to 1 after a pick at 1.5).
- [ ] **Step 2–4:** run (FAIL) / implement / run (PASS, lint).
- [ ] **Step 5: Commit** `android: episodes panel in the player`.

### Task 8: Scenes, marks, trickplay preview, bookmarks

**Files:**
- Create: `P/panels/ScenesPanel.kt`, `P/panels/BookmarksPanel.kt`, `P/TrickplayPreview.kt`
- Modify: `P/PlayerActivity.kt`, `res/layout/player_controls.xml` (preview `ImageView` above the time bar), strings
- Test: `T/ScenesPanelTest.kt`, `T/BookmarksPanelTest.kt`

**Interfaces:**
- Consumes: `chapters`, `normaliseChapters`, `bookmarks`, `addBookmark`, `removeBookmark`, `trickplayFrame`, `sheetUrl`, `shareUrl`, `ImageLoader`, `ServerCaps.chapters/trickplay`.
- Produces: `ScenesPanel.build(ctx, images, chapters: List<Chapter>, currentSec: Double, onSeek: (Double) -> Unit): View`; `BookmarksPanel.build(ctx, scope, api, itemId, positionMs: () -> Long, onSeek: (Long) -> Unit, onShare: (String) -> Unit, onChanged: (List<Bookmark>) -> Unit): View`; `class TrickplayPreview(view: ImageView, images: ImageLoader, scope)`: `fun show(info: TrickplayInfo, positionMs: Long)`, `fun hide()` (crops the sheet bitmap to the frame, 168 dp wide).
- Marks: chapter starts and bookmark positions via `DefaultTimeBar.setAdGroupTimesMs` (played colour = unplayed colour so they read as marks). Scenes button only when chapters are non-empty. Share uses `Intent.ACTION_SEND` text with `shareUrl(server.origin, itemId, position)`. Seek and bookmark position use the cast player while casting.

- [ ] **Step 1: Failing tests** — Scenes tap seeks to chapter start; Scenes button hidden with empty chapters; bookmarks add (note ≤ 140) → list refresh + marks callback; 409 → "too many" text (`bookmarksFailureShowsError`); share intent text equals `shareUrl`; preview requests the sheet from `sheetUrl` for the scrub position.
- [ ] **Step 2–4:** run / implement / run (PASS, lint).
- [ ] **Step 5: Commit** `android: scenes, bookmarks and trickplay preview in the player`.

### Task 9: Cast & info panel

**Files:**
- Create: `P/panels/CastInfoPanel.kt`, `res/layout/item_player_person.xml`
- Modify: `P/PlayerActivity.kt` (top-bar button; title tap = close player and open `/title/<id>` in the shell — reuse the existing hand-back intent with `ShellIntents.EXTRA_OPEN_PATH`), strings
- Test: `T/CastInfoPanelTest.kt`

**Interfaces:**
- Consumes: `castInfo`, `personTitles`, `ImageLoader`.
- Produces: `CastInfoPanel.build(ctx, scope, api, images, itemId: String, onOpenTitle: (String) -> Unit): View` — header (name, year, rating), sections cast / guests / directors / writers / creators (portrait + name + role), studios and genres as text; a person tap shows that person's titles in the same panel with a back row; a title tap calls `onOpenTitle(id)`.

- [ ] **Step 1: Failing tests** — sections render only when non-empty; person tap loads `/api/people/:id`; title tap → `onOpenTitle`; `castInfoFailureShowsError`.
- [ ] **Step 2–4:** run / implement / run (PASS, lint).
- [ ] **Step 5: Commit** `android: cast & info panel in the player`.

### Task 10: Post-play and More like this

**Files:**
- Create: `P/panels/PostPlayPanel.kt`, `res/layout/item_player_poster.xml`
- Modify: `P/PlayerActivity.kt` (card at `postplayAtSec`, open at the end), `res/layout/activity_player.xml` (post-play card like the next card), strings
- Test: `T/PostPlayPanelTest.kt`

**Interfaces:**
- Consumes: `postplay`, `postplayEvent`, `similar`, `postplayAtSec`, `ServerCaps.postplay`, `PlayerPrefs.postplay`, `ImageLoader`, `playItem`.
- Produces: `PostPlayPanel.build(ctx, scope, api, images, data: JSONObject, onPlay: (String) -> Unit, onOpenTitle: (String) -> Unit): View` — header by `state` (`next|movie_end|series_finished|caught_up|gap`, texts from web `postplay.ts`), `next`/`sequel` entry with a Play button, then each `rows[]` entry as a titled horizontal poster row; sends the web's `POST /api/postplay/event` bodies (copy kinds and fields from `web/src/lib/postplay/*` / WATCH page) on show, play and open.
- Wanted = `caps.postplay && prefs.postplay && no next episode && type in (Movie, Episode) && !casting && online`. Not wanted and a movie → at the end a "More like this" panel with up to 3 `similar` titles (self excluded).

- [ ] **Step 1: Failing tests** — card appears at `postplayAtSec`; end opens the panel; not wanted (casting) → no card; movie without post-play → 3 similar titles, self excluded; `postplayFailureShowsError` (null data → panel not shown, player finishes as today).
- [ ] **Step 2–4:** run / implement / run (PASS, lint).
- [ ] **Step 5: Commit** `android: post-play and more like this in the player`.

### Task 11: Offline and casting rules, docs

**Files:**
- Modify: `P/PlayerActivity.kt` (one `updateBar()` deciding visibility from `offline`, `casting`, caps, data), `docs/android.md`, `docs/de/android.md` (player section: the new controls, Chromecast behaviour; manual device checklist rows for each new control), `CHANGELOG.md` (Unreleased → *Android app*)
- Test: `T/PlayerControlsTest.kt` (extend)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Failing tests** — offline playback: Episodes, Scenes, Cast & info, bookmarks row, subtitle search hidden, speed/sleep/lock shown; casting: speed, fx, subtitle search, quality and audio/subtitle changes hidden or disabled, Episodes pick starts the TV, Chromecast button and *Playing on TV* row present.
- [ ] **Step 2–4:** run / implement / run (all `testDebugUnitTest`, lint).
- [ ] **Step 5: Commit** `android: player controls follow offline and Chromecast state; docs`.
