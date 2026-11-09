# Fire TV app (FriendFlix TV mode in an Android shell for Fire TV)

Date: 2026-11-09 · Status: approved by the owner (design of 2026-11-09; the choices it left open are decided below and marked *Decision*)

## Goal

Bring FriendFlix to Amazon Fire TV sticks, cubes and TVs (Fire OS) as an app that looks and works like the LG TV app: a server address screen on first start, then FriendFlix's TV interface (`html.tv`: side menu, focus tiles, detail with big buttons, TV player with credits sequence and pause screen), paired with a code or QR code and controlled with the Fire TV remote or the phone remote. It is built from the existing Android code base in `android/`, published as an APK on every GitHub release and submitted to the Amazon Appstore by the owner.

Owner choices (2026-11-09):
1. An Android build of the existing `android/` code base with its own package id (`com.friendflix.firetv`), for Fire OS; Amazon Appstore (owner submits with a free Amazon developer account) and the APK on every GitHub release.
2. Looks like the LG app: the same server address screen on first start, *Change server* later under Account in the TV side menu, then the TV web UI exactly as the LG app shows it. No phone UI, no native phone player. Pairing with code / QR as on LG (`docs/tv-mode.md`).
3. Remote: arrows / OK / Back / Play-Pause / Rewind / Fast-forward do what they do on LG; Back opens the menu, closes screens and leaves the app like on LG.
4. Left out: Chromecast and every Google Play services library (Fire OS has none; the app must neither depend on them nor crash without them), downloads, phone notifications. The phone remote still works.
5. Playback: the TV web player in the WebView, as on LG; the server converts what the device cannot play. A first-run check like the LG probe reports what this device plays directly, reusing the web probe.
6. Release: the release workflow also builds the Fire TV APK and attaches it to the GitHub release; the Appstore submission is a manual owner step with a step-by-step guide in `docs/firetv.md` and `docs/de/firetv.md`. Store assets: FriendFlix name and logo, a 1280×720 TV banner, screenshots with fictional titles only.
7. Tests: unit tests for server address validation and key mapping; CI builds the Fire TV APK; an e2e test that TV mode opens when the page is told it runs in the Fire TV shell.

## Constraints

- Own look and name: FriendFlix logo, coral `#ff4f6d`, Inter. Never another streaming service's name in user-facing text, store text or screenshots (no "Netflix"); no Plex logo. Screenshots and store art use fictional titles only.
- Placeholder hosts only in code, tests, docs and screenshots: `friend.example.com`, `192.0.2.x`. Never a real domain or IP.
- Never log or print a secret (signing passwords, keystore, cookies, pairing tokens). Signing material comes only from GitHub secrets as today.
- i18n: every new web string in all seven locales (en, de, pl, es, fr, it, tr); every string of the Fire TV app (Android resources) in the same seven locales. The probe screen stays an English-only diagnostic, as on LG and Samsung.
- The phone app (`com.friendflix`) is unchanged in behaviour, package id, signing and Play upload; its build commands and output paths stay the same.
- The Fire TV build has no dependency on `com.google.android.gms` (directly or transitively); CI proves it.
- Web: coverage thresholds statements 94 % / branches 89 %, every `web/src/**/*.ts` counts; new `.ts` files get full unit tests.
- Owner rule: implementers write the tests, CI runs them; implementers run only the root `npm run typecheck` (plus their own new tests and Gradle unit tests locally where the SDK is available).

## 1. Build: a second app module next to the phone app

*Decision:* a Gradle **module** `android/firetv` (application id `com.friendflix.firetv`) instead of a product flavor of `android/app`. The phone app's main source set uses the Cast framework directly (`PlayerActivity`, `cast/*`, `media3-cast`), so a `firetv` flavor would either still compile against Google Play services or force the whole phone app (player, downloads, offline, notifications) into a `phone` source set. A separate module keeps Fire TV free of Play services by construction and leaves the phone build, its paths and its Play upload untouched.

- `android/shell-core` (new Android library, namespace `app.friendflix.android.core`): the shell pieces both apps share, moved out of `android/app` with their packages unchanged — `OriginPolicy`, `ServerAddress` (+ `HttpUrl.origin()`), `WatchLinks`/`WatchLink`, `ShellWebViewClient`, `ExternalLinks`, `Passkeys` (from `WebViewFactory.kt`), and `ServerProbe`/`ProbeResult`/`Semver`/`MIN_SERVER`. No resources, no Play services. `android/app` depends on it; its existing tests stay where they are and keep covering the moved code.
- `android/firetv` (new application, namespace `app.friendflix.firetv`): `minSdk 28` (*Decision:* Fire OS 7 = Android 9 and Fire OS 8 = Android 11; Fire OS 6 devices on Android 7.1 are left out, their WebView is too old for the TV UI), `compileSdk 37`, `targetSdk 36`, `versionName`/`versionCode` from `version.json` like the phone app (buildSrc helpers). Dependencies: `:shell-core`, `androidx.core`, `androidx.activity`, `androidx.webkit`, `androidx.datastore.preferences`, `okhttp`. Release: R8 minify + resource shrinking, the same lint block (warnings are errors).
- Signing (*Decision*): the existing **upload key** from the three existing secrets signs the Fire TV release APK as well (no new secret, same env variables `ANDROID_UPLOAD_KEYSTORE_FILE` / `ANDROID_UPLOAD_KEY_PASSWORD` / `ANDROID_UPLOAD_KEY_ALIAS`; unsigned without them). The package id differs from the phone app, so nothing collides. The Appstore re-signs what it delivers with a key of the owner's Amazon account (see *Unverified*), so an Appstore install and a GitHub APK install cannot update each other; the docs say so.

## 2. Manifest and launcher

- One permission: `INTERNET` (plus the signature-level receiver permission androidx.core declares for the package itself). No notification, foreground service, storage or network-state permission.
- `<uses-feature android:name="android.hardware.touchscreen" android:required="false"/>`, `<uses-feature android:name="android.software.leanback" android:required="false"/>` (*Decision:* not required, so Appstore device filtering never hides the app on a Fire TV model that does not report the feature).
- `<application android:banner="@drawable/tv_banner" android:icon="@mipmap/ic_launcher" android:label="FriendFlix">`, dark full-screen theme, `usesCleartextTraffic="false"`, the same network security config as the phone app (system CAs only), `allowBackup="false"`.
- Launcher entry: `TvSetupActivity` with `MAIN` + `LAUNCHER` + `LEANBACK_LAUNCHER`. `TvShellActivity` is not exported.
- The banner: FriendFlix logo and wordmark on the dark surface, 320×180 dp, a vector drawable (sharp on 1080p and 4K launchers).

## 3. Start screen: server address (as on LG)

Native, TV sized (10-foot: large type, D-pad focus), with the states of `webos/app/setup.js`:

- **Checking:** "Opening <origin>" while `GET /api/version` runs (the shared `ServerProbe` with its default 15 s limit, the same check as the phone app's setup).
- **Failure card:** the reason (unreachable, not FriendFlix, certificate not trusted, app too old, server too old) with **Retry** and **Change server** buttons; Left/Right/Up/Down move between them, Retry has the focus.
- **Form:** title FriendFlix, label *Server address*, a field with hint `friend.example.com` (OK opens the Fire TV keyboard), an error line, **Connect**, and the hint *Press OK on the field to type with the remote. Up and Down move between the field and Connect.* Up/Down move between field and button. The field is prefilled with the stored or last tried address.
- Start: a stored valid server → Checking → success opens the shell; no stored server, or *Change server* from the web UI → the form. *Decision:* no 3-second "Press OK to change server" logo window; LG needs it because its in-app *Change server* can fail, the Fire TV one cannot.
- Address rules are the shell's existing `ServerAddress.normalize`: `https` only (an `http://` address gets the insecure message), scheme optional, path/query/fragment dropped, user info and single-label hosts rejected, IPv6 in brackets, explicit ports kept. An empty field gets its own message. A good check stores the origin and the server's `authOrigin`, then opens the shell.
- Back on this screen leaves the app (the keyboard closes first, which Android does by itself).

## 4. The shell

- One WebView, full screen, focused at start. Settings: JavaScript and DOM storage on, file and content access off, mixed content never, `mediaPlaybackRequiresUserGesture = false` (the phone remote and the TV home start playback without a key press; the page is only ever the user's own server), `useWideViewPort` and `loadWithOverviewMode` on (see 6), debugging only in debug builds.
- User agent: the WebView's own plus ` FriendFlixFireTV/<version> FFDisplay/<height>`, where `<height>` is the largest physical height among the display's supported modes (2160 on a 4K TV, 1080 otherwise). It is **not** ` FriendFlixAndroid/`, so the web never offers the phone app's native player, downloads or Cast bridge.
- Origin lock: the shared `ShellWebViewClient` with the saved origin and `authOrigin`, no native watch interception; links to other sites are dropped (*Decision:* a TV app never leaves for a browser).
- Page → shell: a message port `window.FriendFlixTv` (`WebViewCompat.addWebMessageListener`, allowed origin = the server origin, main frame only). Messages are exact strings: `exit` (leave the app), `changeServer` (open the start screen's form prefilled with the current server), `keepAwake:1` / `keepAwake:0` (keep the screen on while the web player plays). Anything else is ignored. Where the WebView lacks the listener feature, a `@JavascriptInterface` of the same name takes the same messages and acts only while the main frame's URL is the app origin.
- Keep awake: `FLAG_KEEP_SCREEN_ON` follows `keepAwake`, cleared in `onStop` (*Decision:* explicit instead of relying on the WebView keeping the screen on during video, which is not verified on Fire OS).
- Start page: `<origin>/tv?ff_app=firetv`, plus `&probe=1` the first time the shell opens for a server (see 7). The `/tv` page pairs an unpaired TV and sends a paired one home, as on LG.
- Cookies are flushed in `onStop` (the TV session survives a force stop). A crashed renderer recreates the activity at most twice per process, then the app closes (as in the phone shell).

## 5. Remote keys

The D-pad and OK reach the page natively (arrow keys and Enter), so focus movement and text fields behave like any WebView. The shell takes these keys itself and hands them to the page as `keydown` events with the standard key names that `lib/spatial.ts` (`isBackKey`) and `lib/player/keymap.ts` (`resolveKey`) already understand:

| Fire TV key (Android `KEYCODE_*`) | web `key` | effect (as on LG) |
|---|---|---|
| Back (4) | `GoBack` | one step back; on TV-mode pages the side menu first; on home with the menu open: leave the app |
| Play/Pause (85) | `MediaPlayPause` | toggle playback |
| Play (126) · Pause (127) | `MediaPlay` · `MediaPause` | play · pause |
| Fast-forward (90) · Rewind (89) | `MediaFastForward` · `MediaRewind` | +30 s · −30 s |
| Next (87) | `MediaTrackNext` | next episode where there is one |

- Only the first key-down acts; repeats and key-ups of these keys are swallowed (holding Fast-forward does not skip minutes). Other keys (D-pad, OK, Menu, volume, Home) pass through unchanged.
- The event goes to the focused element and bubbles. The script reports whether the page handled it. For Back: handled → nothing more; not handled while a text field has the focus → the field loses the focus (no navigation); not handled otherwise (or no page, e.g. an error page) → the WebView goes back in its history, or the app closes when there is none.
- The web side completes the LG behaviour for the Fire TV shell: Back on the TV-mode home with the menu open posts `exit`; Back on the unpaired pairing page posts `changeServer` (LG goes back to its start page there). The LG-only keys (stop, colour keys) stay LG-only.

## 6. Web: the Fire TV shell and TV mode

- `isFireTvApp()` is true when the user agent carries ` FriendFlixFireTV/`. *Decision:* the marker alone counts (unlike LG, whose token is shared with LG's own browser); `?ff_app=firetv` without it changes nothing.
- `isTvApp()` (LG or Fire TV) replaces the LG-only checks where both apps behave alike: leaving the app on Back at home, the navigation lock, the *Change server* button on the Account page, the probe overlay, the 10 s first-frame fallback to HLS, and the capability block.
- *Change server* on the Account page posts `changeServer` in the Fire TV shell (LG keeps its history route and hint).
- TV mode itself is unchanged: an unpaired Fire TV shows the pairing code and QR on `/tv`; a paired one gets `html.tv` with the side menu, focus tiles, detail and TV player, exactly like LG. Downloads stay off in TV mode as today.
- Size: the Fire TV WebView reports 960×540 CSS px on a 1080p screen. In the Fire TV shell the page sets its viewport meta to `width=1920`, so the TV UI lays out at 1920×1080 CSS px like on LG (the shell's wide viewport + overview mode honour it).
- The player posts `keepAwake:1` while it plays and `keepAwake:0` on pause, end, error and when it closes.
- No new user-facing strings (*Change server* exists in all seven locales).

## 7. Playback and the first-run check

- The TV web player plays in the WebView; the server direct-plays what the device confirms and converts the rest (HLS via hls.js).
- Capability block (POST `/api/playback/info` `caps`): the LG builder is generalised. The Fire TV shell sends `client: 'firetv'` with the codec profiles, audio codecs and containers its WebView confirms (`canPlayType` / `MediaSource.isTypeSupported`), `maxHeight` 2160 when `FFDisplay` is ≥ 2160 and 1080 otherwise, the same subtitle list, and none of LG's assumed containers (LG's `mkv` assumption is an LG finding). The backend accepts `firetv` in its client enum; an older server ignores the block (it then behaves like no block).
- First-run check: the LG probe (`lib/webos/probe.ts`) runs in the Fire TV shell with `probe=1`, which the shell adds the first time it opens a server (the origin it ran for is stored; a *Change server* to a new server, or to the same address again, runs it again). It confirms the formats, plays one library title directly, through hls.js and through the WebView's own HLS (muted, at most 15 s each, one stop report), skips the remote-key and home stages, and shows one line on the existing probe screen (English diagnostic; Back closes it):
  `FFPROBE v1 tv=firetv os=<android>/<model> direct=… hls=… nativehls=… palm=no home=skipped keys=skipped video=… audio=… containers=… screen=<w>x<h>`
  Unpaired, it shows the compact strip on the pairing page and runs again full screen after pairing, as on LG.

## 8. Left out on Fire TV

Chromecast and Google Play services, the native player, downloads and the offline list, phone notifications, the app settings screen, picture-in-picture, passkeys. The web UI's own TV mode decides what it shows; the phone remote (WebSocket) works as on every TV.

## 9. Release

- `android.yml` (PRs and main): builds and lints all three modules, runs all unit tests, builds the unsigned Fire TV release APK and uploads it as an artifact, checks that the Fire TV runtime classpath has no `com.google.android.gms`, and checks the APK's manifest (package `com.friendflix.firetv`, a leanback launcher activity, a banner, touchscreen not required, no permission besides `INTERNET` and the package's own androidx signature permission).
- `android-release.yml` (v* tags): the same Gradle run also builds the signed Fire TV APK; it is verified (`apksigner`), checked like above, attached to the GitHub release as `friendflix-firetv-<version>.apk` with `friendflix-firetv-<version>.sha256`. Without the upload key secrets the job leaves its notice as today. Nothing prints a secret.
- Amazon Appstore: manual, by the owner, with the guide in `docs/firetv.md` (step by step: account, new app, APK upload, device targeting Fire TV only, content rating, images, descriptions, privacy policy link, test server and pairing instructions for Amazon's reviewers, Live App Testing for a friends-only release, submitting updates).
- Store assets in `android/firetv/store-listing/`, rendered from HTML templates like `android/play-listing`: `icon-512.png`, `icon-114.png`, `banner-1280x720.png` (the TV banner), three 1920×1080 TV screenshots (`tv-1.png` … `tv-3.png`) showing the TV home, a detail page and the player with fictional titles only.

## 10. Docs

- `docs/firetv.md` + `docs/de/firetv.md` (English + German, like `docs/android.md` / `docs/de/android.md`): what it is, requirements (Fire OS 7 or newer, an HTTPS server with a public certificate), install (Appstore; or sideload the release APK with ADB or a downloader app), first start and pairing, the remote, what plays directly, the probe line, Change server, updates (Appstore and APK cannot update each other), the owner's Appstore guide, manual device checklist, troubleshooting, building it yourself.
- `docs/tv-mode.md`: a Fire TV key table next to the LG one. `README.md` / `README.de.md`: a *Fire TV app* paragraph and a docs table row. `CHANGELOG.md` *Unreleased*: a `### Fire TV` section.

## Testing

- Android unit tests (JUnit / Robolectric, CI): start-screen logic (start mode, address validation messages with `friend.example.com`, `192.0.2.10:8443`, IPv6, `http://`, empty, garbage; probe result messages), key mapping (each key, repeats and key-ups swallowed, D-pad passes), the Back decision, message parsing and the origin/main-frame gate, start URL with and without the probe, store asset sizes.
- Web unit tests (vitest): Fire TV detection (marker, display height, os token), `isTvApp`/`exitTvApp`, port messages without a port, viewport, caps for `firetv`, the probe line for `firetv`; backend: `firetv` accepted in `parseClientCaps`.
- E2E (Playwright): a stand-in Fire TV shell (user agent marker + a recording `window.FriendFlixTv`): the unpaired `/tv` shows the pairing screen and Back posts `changeServer`; paired, `/` opens in `html.tv`; Back on home opens the side menu, a second Back posts `exit` once; Account → *Change server* posts `changeServer`; the playback info request carries `caps.client = 'firetv'`; playing posts `keepAwake:1`, pausing `keepAwake:0`; the viewport is 1920 wide; `?ff_app=firetv` without the marker stays an ordinary browser.
- CI builds the Fire TV APK on every Android PR and on release tags.
- Manual device checklist in `docs/firetv.md` (Fire TV Stick 4K or Lite, Fire TV Cube): install, first start, pairing, remote keys, Back to exit, playback direct and converted, probe line, Change server, screen saver stays away during playback.

## Out of scope

- Automatic Appstore upload (Amazon's submission API), Appstore in-app updates.
- Android TV / Google TV as a target (the APK may run there, untested and unsupported).
- Fire TV devices running Vega OS (not Android); tablets (Fire HD).
- Voice search (Alexa), the Fire TV home screen's content rows / recommendations, a native player on Fire TV.

## Unverified offline (to confirm on a device or in Amazon's current documentation)

- Fire OS 7 = Android 9 (API 28), Fire OS 8 = Android 11 (API 30); which Fire TV models still run Fire OS 6 (API 25); that Vega OS models cannot run Android apps.
- Fire OS's WebView is Amazon's Chromium-based WebView; its Chromium version on Fire OS 7/8 (MSE, `isTypeSupported` for HEVC/AV1, `WebViewFeature.WEB_MESSAGE_LISTENER`).
- That `KEYCODE_BACK` and the media keys are not delivered to page JavaScript by default (the design forwards them itself, which works either way), and that `DPAD_CENTER` arrives as `Enter`.
- That the Fire TV launcher shows sideloaded apps with `LEANBACK_LAUNCHER` and uses `android:banner`; that Fire TV devices report `android.software.leanback` and `amazon.hardware.fire_tv` (the design relies on neither; `Build.MANUFACTURER == "Amazon"` is not used either).
- That `useWideViewPort` + a `width=1920` viewport meta set after load gives a 1920 CSS px layout in Amazon's WebView (the probe line's `screen=` shows it).
- Amazon Appstore: that it re-signs apps with an account key (or offers keeping the developer's key), the current image sizes (512×512 and 114×114 icons, 1280×720 Fire TV banner/icon, 1920×1080 screenshots), Live App Testing limits, and how reviewers handle apps that need a private server.
- How to enable *Developer options* / ADB on current Fire OS versions (the "About → click the device name seven times" step).
