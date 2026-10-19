# FriendFlix for Android: design

Status: approved in conversation on 2026-10-19 (approach A, notifications option 1, private download storage).
Scope: **Phase 1, the phone and tablet app.** Phase 2 (an Android TV / Google TV app with its own remote-friendly UI that reuses the
native player and server client from phase 1) gets its own spec later. There is no iPhone app.

## 1. Why

The web app already streams, casts and downloads (OPFS, Background Fetch on Chromium). What the owner misses, and what this app fixes:

- **Storage:** downloads on the SD card or the phone, sized by the real free space, not by a browser quota.
- **App feel:** no browser bar, a back button that stays inside FriendFlix, real notifications, picture-in-picture.
- **Playback:** a native player that direct-plays more formats, keeps text subtitles offline and can keep playing audio in the
  background.

Success: on an Android phone, a household member installs the app from the Play Console closed test, signs in once, streams with
fewer server transcodes, downloads a season to the SD card while the screen is off, and watches it in flight mode with subtitles.

## 2. Approach: native shell, web UI, native where it matters

- The UI (home, detail, search, profiles, account, admin) is the existing web app, shown in a WebView without browser chrome.
  Every web feature is in the app on the day it ships; there is no second UI to keep in step.
- Native (Kotlin): the player, downloads and offline mode, the back button, notifications, picture-in-picture, media session,
  Chromecast, the app settings (server address, storage location).
- Rejected: a fully native UI (every feature built twice; the app would always lag behind, the same maintenance trap the Plex
  fork was) and a Trusted Web Activity only (fixes none of the three reasons).

## 3. Where the code lives and how it ships

- New folder `android/` in this repository (Gradle, Kotlin, minSdk 26, targetSdk = current Play requirement). Same version as the
  server: the release workflow writes `version.json` into the app's `versionName`; `versionCode` derives from it.
- CI: lint, unit tests and a release build (AAB + APK) on every PR touching `android/` or the web bridge; on a `vX.Y.Z` tag the AAB
  and a signed APK are attached to the GitHub release. Signing: Play App Signing; the upload key lives only in GitHub secrets
  (owner adds it), never in the repo. Reproducible-build checks as far as Gradle allows; dependency updates by Dependabot.
- Distribution: Play Console closed testing track for the household and friends. The APK on the GitHub release is the fallback.
- Compatibility: the app reads `GET /api/version` and refuses with a clear message when the server is older than the app's
  minimum server version (and tells the user to update the app when the server says it needs a newer one).

## 4. Security

- First start asks for the FriendFlix address (`https://friend.example.com`). HTTPS only (no cleartext, platform trust store, no
  user CAs in release builds). The WebView loads only that origin; every other link opens in the system browser.
- Sign-in is the existing web sign-in (in-app login or Authentik) inside the WebView, giving the normal session cookie. Native
  requests (player, downloads, polling) use the same cookie from the WebView cookie store; it never leaves the device. No new token
  type. The app is one more device: device approval, device revoke, account disable and sign-out work unchanged.
- The JS bridge (`FriendFlixNative`) is exposed only to the configured origin's main frame (checked on every call), with a small
  fixed API: `capabilities()`, `play(json)`, `download(json)`, `downloads()`, `deleteDownload(id)`, `openSettings()`. Inputs are
  validated (ids, numbers); nothing in it reads files, cookies or other origins.
- WebView hardening: no file / content access, no mixed content, safe browsing on, debugging only in debug builds,
  `setAllowFileAccess(false)`, no `addJavascriptInterface` on other origins.
- No analytics, ads, crash-reporting SDKs or Firebase. Logs never contain cookies, URLs with tokens, or titles.

## 5. Web app changes

- Detects the app (`window.FriendFlixNative` plus a UA marker) and then hands "Play" and "Download" to the bridge instead of the web
  player and the OPFS downloader. Everything else stays web. The browser behaviour is unchanged when the bridge is absent.
- Download UI shows the native state (queued, downloading %, ready, expired) read from `downloads()`.
- Back button: the shell sends Android back to the WebView history; at the root it leaves the app.

## 6. Downloads (native)

- Licences, quotas, role quality caps, preparation on the server, revoke and expiry stay exactly as in docs/downloads.md. The web UI
  creates the licence; the bridge hands the licence id to native.
- Transfer: WorkManager long-running worker as a foreground service with a progress notification; HTTP Range resume after any
  interruption (network change, reboot, app killed); runs with the screen off; respects "only on Wi-Fi" (app setting, default on).
- Storage: app-specific external storage (`getExternalFilesDirs`), the user picks "Phone" or "SD card" in the app settings, with
  free space shown. Files are private to the app (licences and revocation stay enforceable); uninstalling removes them. Moving
  between locations is offered when the setting changes.
- Text subtitles (SRT/VTT) and artwork are downloaded with the file. Image subtitles (PGS/VobSub) stay unavailable offline.
- Offline mode: a native "Downloads" screen (shown when the server is unreachable, or from the menu) lists the active profile's
  downloads and plays them. Watched state and position are queued and synced on reconnect; newer server states win. Offline grace
  `DOWNLOAD_OFFLINE_GRACE_DAYS` and the clock-rollback check apply as on the web; revoked or expired licences delete the file at the
  next online check.

## 7. Player (native, Media3 / ExoPlayer)

- One player for streams and downloads, started by the bridge with the item, start position and profile.
- Direct play: the app reports a device profile (containers, video codecs incl. HEVC/AV1 where the device decodes them in hardware,
  audio codecs incl. AC3/EAC3 when available, subtitle formats) through `POST /api/playback/info`. The server passes it to the
  media server so more items direct-play or direct-stream; role caps (max height / bitrate, download rights) still apply on the
  server and win. Server change: accept a validated `client: "android"` capability block; unknown or oversized values are ignored.
- Parity with the web player: skip intro / recap, next-episode card with countdown at the credits, "Are you still watching?", audio
  / subtitle / quality selection, resume, progress via `/api/playback/start|progress|stop`, kids and max_streams rules unchanged.
- Native extras: background audio (setting, default off), picture-in-picture, media session (lock screen, notification, Bluetooth
  and headset buttons).
- Chromecast: Media3 Cast with the configured `CAST_RECEIVER_APP_ID` (or the Default Media Receiver), through the existing cast
  token flow; the next-token gate, `povl` window and `DRAIN_MS` rules are not changed or bypassed.

## 8. Notifications (no third party)

- The app creates its own notifications for download progress and "download ready".
- Server notifications (new episode, request done, access approved): a periodic WorkManager job (about every 15-30 minutes, as
  Android allows) reads the existing `GET /api/notifications` with the session cookie and shows new items as Android notifications.
  No Firebase, no other push service. The user can turn categories off in the app settings. Optional later: UnifiedPush through a
  self-hosted ntfy server (not part of phase 1).

## 9. Testing

- Kotlin unit tests (bridge validation, origin checks, licence/expiry logic, download resume, device profile building).
- Instrumented tests on an emulator in CI (WebView loads only the origin, bridge refuses other frames, offline screen, player starts
  a local test file).
- Server / web: unit + e2e for the bridge hand-off (a fake bridge in Playwright), the `client: "android"` capability validation,
  and no change to browser behaviour without the bridge.
- Manual checklist on a real phone in docs/android.md (SD card, screen off download, flight mode, PiP, cast, background audio).

## 10. Docs

docs/android.md + docs/de/android.md (install from the closed test, first start, storage, notifications, troubleshooting),
README section, CHANGELOG, security.md (app threat model: bridge, cookie reuse, WebView hardening).

## Out of scope (phase 1)

Android TV UI, iPhone, Firebase / any push provider, a public download folder, DRM, a native UI for browsing.
