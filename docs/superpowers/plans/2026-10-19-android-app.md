# FriendFlix for Android (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Android phone/tablet app: native shell around the existing web UI, with a native player, encrypted downloads (phone or SD card), an offline screen, Chromecast and notifications without a third-party push service.

**Architecture:** `android/` Gradle project in this repo. One Activity hosts a hardened WebView locked to the configured FriendFlix origin; a narrow JS bridge hands "play" and "download" to native modules (Media3 player, WorkManager downloader with AES encryption at rest). The web app detects the bridge; without it nothing changes. Small server additions: an Android capability block for `/api/playback/info` and app compatibility fields in `/api/version`.

**Tech Stack:** Kotlin 2.x, Android Gradle Plugin (current stable), minSdk 26, targetSdk = current Play requirement, AndroidX WebKit, Media3 (ExoPlayer, Session, Cast, DataSource), WorkManager, Jetpack Compose (only for native screens: setup, settings, offline), kotlinx.serialization, OkHttp, JUnit + Robolectric + Turbine; web side TypeScript/Svelte + Vitest + Playwright.

**Spec:** docs/superpowers/specs/2026-10-19-android-app-design.md (read it first; it is the authority).

## Global Constraints

- Package id `app.friendflix.android`; app name "FriendFlix"; FriendFlix brand only, no trademark look-alikes, no Plex logo.
- `versionName` = `version.json` `version`; `versionCode` = major*10000 + minor*100 + patch. Never edited by hand.
- HTTPS only: `usesCleartextTraffic=false`, network security config without user CAs in release.
- WebView loads only the configured origin; bridge only for that origin's main frame; no file/content access; debugging only in debug builds.
- No Firebase, analytics, ads or crash-reporting SDKs. Logs never contain cookies, tokens, URLs with query strings or titles.
- Auth = the existing session cookie from the WebView cookie store; no new token type; the server never trusts anything just because it comes from the app.
- Downloads: Wi-Fi and mobile data (setting "Only on Wi-Fi", default off); storage "Phone" / "SD card" in app-specific external dirs; AES-256-CTR + per-chunk HMAC-SHA256, key in Android Keystore; licence/expiry/revoke/grace rules exactly as docs/downloads.md.
- Role caps, kids rules, max_streams and the cast next-token gate are enforced by the server and never bypassed.
- UI strings of native screens: German and English at least (app follows device language; web UI already covers 7 locales); web-side strings in all 7 locales.
- Placeholder hosts only in docs/tests (friend.example.com). Never real domains or tokens. Merge, never rebase.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`.
- Android SDK in the sandbox: install cmdline-tools into the scratchpad (`$ANDROID_HOME`), never commit SDK files; no emulator locally — Robolectric locally, emulator tests only in GitHub Actions.

## Review Focus

1. Server address typed with a path, trailing slash, `http://` or an IP → setup normalises to `https://host[:port]`, refuses `http`, and the origin check compares scheme+host+port exactly (test in Task 2).
2. Download interrupted at 99 %, app killed, phone rebooted → resumes by Range from the encrypted file's last complete chunk, never re-encrypts a chunk twice, final HMAC check passes (test in Task 6).
3. SD card removed while files are on it → offline list shows "storage not available", no crash, files reappear when the card returns (test in Task 6).
4. Licence revoked while offline for 8 days / clock set back → files deleted at next online check / playback refused (test in Task 7).
5. Session expired while the app was closed → WebView shows sign-in, native requests get 401 and stop cleanly (no retry storm), downloads pause until sign-in (test in Task 6).

---

### Task 1: Project scaffold + CI

**Files:**
- Create: `android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle/libs.versions.toml`, `android/gradle/wrapper/*`, `android/gradlew`, `android/app/build.gradle.kts`, `android/app/src/main/AndroidManifest.xml`, `android/app/src/main/res/xml/network_security_config.xml`, `android/app/src/main/kotlin/app/friendflix/android/App.kt`, `android/app/src/test/kotlin/app/friendflix/android/VersionTest.kt`
- Create: `.github/workflows/android.yml`; Modify: `.github/dependabot.yml` (gradle ecosystem, `/android`)
- Modify: `scripts/release.mjs` only if needed so release bumps keep the app version in sync (preferred: Gradle reads `../version.json` at build time, no release change)

- [ ] Step 1: Test `VersionTest.versionCodeFromSemver`: `versionCode("2.0.1") == 20001`, `versionCode("10.2.3") == 100203`, invalid → throws.
- [ ] Step 2: Run `cd android && ./gradlew testDebugUnitTest` → FAIL.
- [ ] Step 3: Gradle reads `../version.json` (`versionName`, `versionCode` via `fun versionCode(v: String): Int` in `buildSrc` or the app script); manifest with `usesCleartextTraffic=false`, INTERNET, POST_NOTIFICATIONS, FOREGROUND_SERVICE(_DATA_SYNC), no storage permission; release `minifyEnabled`.
- [ ] Step 4: `./gradlew lint testDebugUnitTest assembleDebug` → PASS.
- [ ] Step 5: CI `android.yml`: on PRs touching `android/**`, `web/src/lib/native/**`, the workflow itself: setup JDK 21, Gradle cache, `lint testDebugUnitTest assembleRelease` (unsigned), upload APK artifact; emulator job (`reactivecircus/android-emulator-runner`, API 34, pinned by SHA) running `connectedDebugAndroidTest`. All actions pinned by SHA like the existing workflows.
- [ ] Step 6: Commit `build(android): project scaffold, version from version.json, CI`.

### Task 2: Server address setup + hardened WebView shell

**Files:**
- Create: `android/app/src/main/kotlin/app/friendflix/android/shell/ServerAddress.kt`, `ShellActivity.kt`, `WebViewFactory.kt`, `OriginPolicy.kt`, `setup/SetupScreen.kt`, `settings/AppSettings.kt` (DataStore)
- Test: `android/app/src/test/.../shell/ServerAddressTest.kt`, `OriginPolicyTest.kt`; `android/app/src/androidTest/.../ShellTest.kt`

**Interfaces:**
- Produces: `object ServerAddress { fun normalize(input: String): Result<HttpUrl> }` (origin only, https); `class OriginPolicy(origin: HttpUrl) { fun isAppOrigin(url: Uri): Boolean; fun isMainFrameAppOrigin(view: WebView): Boolean }`; `AppSettings` keys `serverOrigin`, `storage` (`PHONE|SD`), `wifiOnly` (false), `backgroundAudio` (false), `notifyCategories`.

- [ ] Step 1: Tests: `normalize("friend.example.com")` → `https://friend.example.com`; `"https://friend.example.com/home/"` → `https://friend.example.com`; `"http://friend.example.com"` → failure `insecure`; `"https://friend.example.com:8443"` keeps port; empty/garbage → failure `invalid`. `OriginPolicy`: same host other port → false; subdomain → false; `https://friend.example.com.evil.test` → false.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement; setup screen probes `GET /api/version` (must answer FriendFlix JSON) before saving and compares `minAndroid` (Task 3) with the app version (too old → "Please update the app"; server older than the app's `MIN_SERVER` constant → "Please update FriendFlix on the server"); `WebViewFactory` sets: JS on, DOM storage on, file/content access off, mixed content never, safe browsing on, `WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)`; `shouldOverrideUrlLoading`: app origin stays, everything else → `Intent.ACTION_VIEW`; back press → `goBack()` else finish; downloads via `DownloadListener` ignored (bridge only); UA suffix ` FriendFlixAndroid/<versionName>`.
- [ ] Step 4: Unit tests PASS; instrumented `ShellTest` (CI): external link opens chooser intent, back navigates history.
- [ ] Step 5: Commit `feat(android): server setup and hardened web shell`.

### Task 3: Server: Android capability block + app compatibility

**Files:**
- Modify: `backend/src/routes/media.ts` (`/api/playback/info`), `backend/src/routes/*version*` (where `/api/version` lives), `backend/src/version.ts` or equivalent
- Create: `backend/src/media/clientCaps.ts`
- Test: `backend/test/client-caps.test.ts`, extend the playback-info and version tests

**Interfaces:**
- Produces: `parseClientCaps(body: unknown): ClientCaps | null` (zod; `{ client: 'android', appVersion: semver, containers: string[≤16], video: {codec, maxHeight?, profiles?}[≤16], audio: string[≤16], subtitles: string[≤16] }`, unknown codec strings dropped against an allowlist, oversized → null); `/api/playback/info` merges valid caps into the device profile it sends to the media server (Jellyfin `DeviceProfile` direct-play/codec profiles; Plex equivalent through the media seam), then applies role caps (they always win). `/api/version` adds `{ minAndroid: "2.1.0" }` (constant beside the version) and the app compares.

- [ ] Step 1: Tests: valid caps → HEVC in direct-play profile; role max height 720 still forces a 720p cap with HEVC 4K source; `client: 'ios'` → ignored; 17 entries → null; `codec: "<script>"` → dropped; no caps → identical profile to today (snapshot of current output).
- [ ] Step 2: Run backend tests → FAIL. Step 3: Implement via the media seam (no imports of `backend/src/jellyfin` outside it; media-seam test passes). Step 4: PASS incl. full backend suite. Step 5: Commit `feat(playback): android capability block, app compatibility in /api/version`.

### Task 4: JS bridge + web hand-off

**Files:**
- Create: `android/app/src/main/kotlin/.../bridge/NativeBridge.kt`, `bridge/BridgeMessages.kt`; `web/src/lib/native/bridge.ts`, `web/src/lib/native/bridge.test.ts`, `e2e/tests/native-bridge.spec.ts`
- Modify: the web play entry points (player route / play buttons) and download button component to call the bridge when present; i18n keys for native download states (7 locales)

**Interfaces:**
- Produces (Kotlin, `@JavascriptInterface` on object name `FriendFlixNative`): `capabilities(): String` (JSON `{api:1, play:true, download:true, cast:true}`), `play(json: String): Boolean` (`{itemId, startMs?, profileId, mediaSourceId?, audio?, subtitle?}`), `download(json: String): Boolean` (`{licenseId, itemId, profileId}`), `downloads(): String` (JSON list `{licenseId,itemId,state,progress,bytes,expiresAt}`), `deleteDownload(licenseId: String): Boolean`, `openSettings()`. Every method first checks `OriginPolicy.isMainFrameAppOrigin`, validates ids (`^[A-Za-z0-9-]{1,64}$`), numbers (≥0, bounded), and returns false on any violation. Events to web: `window.dispatchEvent(new CustomEvent('friendflix-native', {detail}))` via `evaluateJavascript` with JSON-escaped payloads.
- Produces (web): `export const native: { available: boolean; play(...): boolean; download(...): boolean; downloads(): NativeDownload[]; onEvent(cb): () => void }`.

- [ ] Step 1: Tests: Kotlin – call from other origin → false; `itemId="../x"` → false; `startMs=-1` → false; valid → dispatches to `PlayerLauncher`/`DownloadQueue` fakes. Web – without `window.FriendFlixNative` the play button uses the web player (existing e2e unchanged); with a fake bridge in Playwright, Play calls `play` with the expected JSON and Download calls `download` after the licence is created.
- [ ] Step 2–4: FAIL → implement → PASS (gradle tests, web vitest, e2e spec desktop + mobile).
- [ ] Step 5: Commit `feat(android,web): narrow native bridge for play and download`.

### Task 5: Encrypted file store

**Files:**
- Create: `android/app/src/main/kotlin/.../crypto/KeyProvider.kt`, `crypto/EncryptedFile.kt`, `crypto/EncryptedDataSource.kt`
- Test: `android/app/src/test/.../crypto/EncryptedFileTest.kt`, `EncryptedDataSourceTest.kt`

**Interfaces:**
- Produces: `interface KeyProvider { fun key(): SecretKey; fun macKey(): SecretKey }` (Keystore AES-256 + HMAC keys, alias `ff-dl-v1`; test impl in-memory); file format `FFE1` header (magic, version, 16-byte IV, chunk size 1 MiB) + ciphertext (AES-256-CTR, counter = IV + offset/16) + trailer of per-chunk HMAC-SHA256(macKey, chunkIndex ‖ ciphertextChunk); `class EncryptedWriter(file, keys) { fun append(bytes); fun resumeOffset(): Long; fun finish() }`; `class EncryptedReader(file, keys) { fun read(pos: Long, buf, off, len): Int }` (verifies the chunk HMAC before returning plaintext); `EncryptedDataSource : androidx.media3.datasource.DataSource`.

- [ ] Step 1: Tests: round trip 0, 1, 1 MiB, 1 MiB+1, 10 MiB random bytes; random-access reads at 100 random positions equal plaintext; flipping one ciphertext byte → `IOException("integrity")` for that chunk; `resumeOffset()` after a simulated crash mid-chunk returns the last complete chunk boundary and appending the rest yields a valid file; reading with another key → integrity error.
- [ ] Step 2–4: FAIL → implement (javax.crypto, no third-party crypto lib) → PASS. Step 5: Commit `feat(android): encrypted download files with seekable reads`.

### Task 6: Downloader (WorkManager) + storage location

**Files:**
- Create: `android/app/src/main/kotlin/.../downloads/DownloadQueue.kt`, `DownloadWorker.kt`, `DownloadStore.kt` (Room or DataStore JSON, one table: licenseId, itemId, profileId, state, bytes, total, file, subtitles, expiresAt, lastCheck), `StorageLocations.kt`, `ServerApi.kt` (OkHttp with WebView cookie jar, 401 → `SessionExpired`)
- Test: unit tests with MockWebServer and Robolectric WorkManager test helpers

**Interfaces:**
- Consumes: Task 5 `EncryptedWriter`; Task 2 `AppSettings`; bridge `download(...)`.
- Produces: `DownloadQueue.enqueue(req: DownloadRequest)`, `observe(): Flow<List<DownloadEntry>>`, `delete(licenseId)`; `StorageLocations.available(): List<Location(kind, freeBytes, mounted)>`, `move(to)`.
- Behaviour: fetch `/media/d/<id>` with Range from `resumeOffset()`; foreground notification with %; constraints: network CONNECTED (UNMETERED when `wifiOnly`); exponential backoff; 401 → pause all + notify "sign in again"; 4xx licence revoked → delete; subtitles (text only) + artwork stored encrypted next to the file; SD unmounted → entries `unavailable`, no deletion.

- [ ] Step 1: Tests: Review Focus 2 (kill at 99 %, resume by Range, final HMAC ok); Review Focus 3 (SD unmounted → `unavailable`, back → `ready`); Review Focus 5 (401 → paused, no retry loop: at most 1 request per backoff); `wifiOnly=true` → constraint UNMETERED; revoked (410/403 with `revoked`) → file deleted.
- [ ] Step 2–4: FAIL → implement → PASS. Step 5: Commit `feat(android): background downloads to phone or SD card`.

### Task 7: Licence checks, offline screen, sync queue

**Files:**
- Create: `.../offline/LicenseChecker.kt`, `offline/OfflineScreen.kt`, `offline/SyncQueue.kt`
- Test: `LicenseCheckerTest.kt`, `SyncQueueTest.kt`

**Interfaces:**
- Behaviour mirrors docs/downloads.md §5: online check at app start and reconnect via the existing licence endpoints; offline grace `DOWNLOAD_OFFLINE_GRACE_DAYS` from `/api/version` or licence payload (default 7); clock rollback (now < lastCheck − 5 min) → refuse playback until online; position/watched queued in `SyncQueue` and posted on reconnect (newer server state wins). Offline screen (Compose) lists the active profile's entries, play → player with `EncryptedDataSource`; shown automatically when the origin is unreachable at start.

- [ ] Step 1: Tests: Review Focus 4 (8 days offline → playback refused; online check returns revoked → file deleted; clock set back → refused); sync: two queued positions → newest posted once; server newer → local not posted.
- [ ] Step 2–4: FAIL → implement → PASS. Step 5: Commit `feat(android): offline screen, licence checks, sync on reconnect`.

### Task 8: Native player

**Files:**
- Create: `.../player/PlayerActivity.kt`, `player/PlaybackSession.kt` (Media3 MediaSessionService), `player/DeviceProfile.kt`, `player/PlaybackReporter.kt`, `player/EpisodeFlow.kt` (intro/recap skip, credits next-up with countdown, still-watching), `player/PlayerControls.kt` (Compose overlay)
- Test: `DeviceProfileTest.kt`, `PlaybackReporterTest.kt`, `EpisodeFlowTest.kt`

**Interfaces:**
- Consumes: Task 3 caps schema (exact JSON keys), Task 4 `play(...)` payload, Task 5 data source for offline.
- Produces: `DeviceProfile.build(context): ClientCaps` (MediaCodecList, hardware decoders only for HEVC/AV1); `PlaybackReporter` posts `/api/playback/start|progress|stop` with the same body shape the web player sends (copy from `web/src/lib` player reporter); `EpisodeFlow` uses the same markers and timings as the web player (read them from the web implementation; same "still watching" rule).
- Native extras: PiP (`supportsPictureInPicture`, auto-enter on home while playing), background audio when the setting is on, media session notification + Bluetooth buttons.

- [ ] Step 1: Tests: profile on a fake codec list without HW HEVC → no HEVC; reporter sends progress every 10 s and stop on release; EpisodeFlow: intro segment → skip shown in range, credits → next-up countdown 10 s, 3 autoplayed episodes → still-watching prompt.
- [ ] Step 2–4: FAIL → implement → PASS (+ CI instrumented test: plays a bundled 5 s test clip from an encrypted file and seeks).
- [ ] Step 5: Commit `feat(android): native Media3 player with direct play, PiP and background audio`.

### Task 9: Chromecast from the native player

**Files:** Create `.../cast/CastController.kt`; Modify `PlayerActivity.kt`; Test `CastControllerTest.kt`
- Uses Media3 Cast (`CastPlayer`) with receiver id from the server config the web uses (`CAST_RECEIVER_APP_ID`, else default receiver); obtains cast tokens through the existing `/api/cast/*` endpoints exactly like `web/src/lib/cast/engine.ts` (same payloads, `next: true` for queue items); never builds media URLs itself.
- [ ] Step 1: Tests: empty app id → default receiver; token request body equals the web engine's for the same item; queue next uses `next: true` with the predecessor. Step 2–4: FAIL → implement → PASS. Step 5: Commit `feat(android): Chromecast through the existing cast token flow`.

### Task 10: Notifications without a push service

**Files:** Create `.../notify/NotificationPoller.kt` (PeriodicWorkRequest 15 min, flex), `notify/Channels.kt`; Test `NotificationPollerTest.kt`
- Reads `GET /api/notifications` (cookie), stores the last seen id, posts new items per category channel; categories toggle in settings; 401 → stop until next app open; no Firebase.
- [ ] Step 1: Tests: two new items → two notifications, rerun → none; disabled category → none; 401 → no notification, worker returns success (no retry storm). Step 2–4: FAIL → implement → PASS. Step 5: Commit `feat(android): notifications by periodic polling`.

### Task 11: Settings screen, release pipeline, docs

**Files:**
- Create: `.../settings/SettingsScreen.kt` (server address change with confirm, storage Phone/SD with free space + move, Wi-Fi only, background audio, notification categories, app version, "sign out of this device" → clears WebView cookies + keys + downloads after confirm)
- Modify: `.github/workflows/release.yml` / publish flow to build a signed AAB + APK on `v*` tags when the secrets `ANDROID_UPLOAD_KEYSTORE`, `ANDROID_UPLOAD_KEY_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS` exist (skip with a notice otherwise) and attach them to the GitHub release
- Create: `docs/android.md`, `docs/de/android.md`; Modify: `README.md`, `README.de.md` (if present), `docs/security.md` (app threat model: bridge, cookie reuse, WebView hardening, encryption at rest limits), `CHANGELOG.md` (Unreleased)

- [ ] Step 1: Tests: settings "sign out of this device" wipes cookies, keystore alias and download store (Robolectric); release workflow lint (`actionlint`) passes; docs contain no real hosts (`grep` check in the existing docs test if any).
- [ ] Step 2–4: FAIL → implement → PASS; full checks: `./gradlew lint testDebugUnitTest assembleRelease`, web `vitest`, `e2e` native-bridge spec, backend tests, gitleaks.
- [ ] Step 5: Commit `feat(android): settings, release signing, docs`.

## Owner steps (not code)

Create the upload key and add the three GitHub secrets; create the app in the Play Console (package `app.friendflix.android`), enable Play App Signing, add testers to the closed track; install from the test link. Documented in docs/android.md.
