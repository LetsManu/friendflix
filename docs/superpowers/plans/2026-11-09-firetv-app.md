# Fire TV App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Fire TV app (`com.friendflix.firetv`) built from `android/`: a TV-sized server address screen, then FriendFlix's TV web UI in a locked-down WebView with the Fire TV remote mapped like LG, the first-run probe, no Google Play services, the APK on every GitHub release and an Appstore guide for the owner.

**Architecture:** The shell classes both apps need move from `android/app` into a new library module `android/shell-core` (packages unchanged). A new application module `android/firetv` holds the start screen (`TvSetupActivity`) and the shell (`TvShellActivity`), with pure, unit-tested helpers for key routing, Back, page messages and the start URL. The web app learns the Fire TV shell from a user agent marker and reuses the LG paths (`isTvApp()`), the LG capability builder and the LG probe; the backend accepts `client: 'firetv'`.

**Tech Stack:** Kotlin, AGP 9.5 (built-in Kotlin), androidx.webkit (`WebViewCompat.addWebMessageListener`), DataStore, OkHttp, JUnit 4 + Robolectric; SvelteKit (Svelte 4 syntax), TypeScript, vitest, Playwright; GitHub Actions; headless Chromium + Pillow for store art.

**Spec:** `docs/superpowers/specs/2026-11-09-firetv-app-design.md`

## Global Constraints

- Never another streaming service's name in user-facing text, store text or screenshots (no "Netflix"); no Plex logo; fictional titles only in screenshots.
- Placeholder hosts only (`friend.example.com`, `192.0.2.x`), never a real domain or IP — in code, tests, docs, screenshots.
- Never log or print a secret (keystore, passwords, cookies, pairing tokens).
- i18n: every new web string in en, de, pl, es, fr, it, tr (this plan adds none); every Fire TV Android string in `values`, `values-de`, `values-pl`, `values-es`, `values-fr`, `values-it`, `values-tr` (lint `MissingTranslation` enforces it). The probe screen stays English-only.
- The phone app (`android/app`, `com.friendflix`) keeps its behaviour, package id, signing, output paths and Play upload.
- `android/firetv` must not depend on `com.google.android.gms` (directly or transitively).
- Fire TV module: `applicationId = "com.friendflix.firetv"`, `namespace = "app.friendflix.firetv"`, `minSdk = 28`, `compileSdk = 37`, `targetSdk = 36`, version from `../version.json` via the buildSrc helpers, the same `lint { … }` block as `android/app` (warnings are errors).
- The user agent marker is ` FriendFlixFireTV/<version> FFDisplay/<height>`; page messages are exactly `exit`, `changeServer`, `keepAwake:1`, `keepAwake:0` on `window.FriendFlixTv`; the start URL is `<origin>/tv?ff_app=firetv[&probe=1]`. Kotlin and web must agree on these strings.
- Web coverage thresholds statements 94 % / branches 89 %, every `web/src/**/*.ts` counts: new `.ts` files get full unit tests; DOM-only code stays in `.svelte`.
- Owner rule: implementers write tests; CI runs them. Implementers run only the root `npm run typecheck`, plus their own new tests and Gradle unit tests locally when an Android SDK is available (`ANDROID_HOME=/home/user/android-sdk`, from `android/`).
- Every commit ends with these two trailer lines (after a blank line):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN
  ```

## Review Focus

1. Back while a text field has the focus (the TV search field, the setup field with the keyboard closed): the field loses focus; the page must not navigate and the app must not close — tests in Task 3 (`TvBackTest`, `FireTvKeysTest` script) and Task 2 (setup keeps default IME handling).
2. Holding Fast-forward, Rewind or Play/Pause on the remote: exactly one action per press, key-ups and repeats never reach the page — test in Task 3 (`FireTvKeysTest`).
3. The server goes away: at start the failure card with Retry / Change server (never a blank WebView); mid-session Back on an error page closes the app instead of doing nothing — tests in Task 2 (`TvSetupFlowTest`) and Task 3 (`TvBackTest`).
4. A page of another origin inside the app (the identity provider's sign-in page, an embedded trailer frame) posting `exit` or `changeServer`: ignored — test in Task 3 (`TvMessagesTest`).
5. Any browser, the phone app, or a Fire TV's own browser opening `/tv?ff_app=firetv`: no Fire TV behaviour (no port messages, no viewport change, LG/browser paths unchanged); a missing or garbage `FFDisplay` gives 1080 — tests in Task 4 (`detect.test.ts`, `firetv.spec.ts`).

---

### Task 1: Shared shell core module

**Files:**
- Create: `android/shell-core/build.gradle.kts`, `android/shell-core/src/main/AndroidManifest.xml` (empty `<manifest/>`), `android/shell-core/proguard-rules.pro` (empty) if the build needs it
- Move (git mv, package unchanged) into `android/shell-core/src/main/kotlin/app/friendflix/android/…`: `shell/OriginPolicy.kt`, `shell/ServerAddress.kt`, `shell/WatchLinks.kt`, `setup/ServerProbe.kt`
- Create: `android/shell-core/src/main/kotlin/app/friendflix/android/shell/ShellWebViewClient.kt` — `ExternalLinks`, `ShellWebViewClient`, `Passkeys` cut out of `android/app/src/main/kotlin/app/friendflix/android/shell/WebViewFactory.kt` unchanged
- Modify: `android/app/src/main/kotlin/app/friendflix/android/shell/WebViewFactory.kt` (keeps only `object WebViewFactory`), `android/app/build.gradle.kts` (`implementation(project(":shell-core"))`), `android/settings.gradle.kts` (`include(":shell-core")`), `android/build.gradle.kts` (`alias(libs.plugins.android.library) apply false`), `android/gradle/libs.versions.toml` (`android-library = { id = "com.android.library", version.ref = "agp" }`)
- Test: the existing `android/app/src/test/**` (unchanged; they cover the moved classes through the dependency)

**Interfaces:**
- Produces (unchanged signatures, now in `:shell-core`): `OriginPolicy(origin: HttpUrl)` with `originRule(): String`, `isAppOrigin(url: Uri): Boolean`; `ServerAddress.normalize(input: String): Result<HttpUrl>`, `ServerAddressError { INVALID, INSECURE }`, `ServerAddressException(error)`, `HttpUrl.origin(): String`; `WatchLinks`, `WatchLink`; `ShellWebViewClient(policy, onRenderGone = {}, onWatch = null, openExternal)` with `var authOrigin: OriginPolicy?`; `ExternalLinks`; `Passkeys`; `ServerProbe(client = OkHttpClient(), appVersion, minServer = MIN_SERVER, timeoutMs = 15_000)`, `suspend fun probe(origin: HttpUrl): ProbeResult`, `sealed interface ProbeResult { Ok(serverVersion, authOrigin), NotFriendFlix, AppTooOld, ServerTooOld, TlsProblem, Unreachable }`, `Semver`, `MIN_SERVER`.

`shell-core/build.gradle.kts`: plugin `libs.plugins.android.library`; `namespace = "app.friendflix.android.core"`, `compileSdk = 37`, `minSdk = 26`, Java 17, the `lint { … }` block of `android/app`, `testOptions.unitTests.isIncludeAndroidResources = true`; `api(libs.okhttp)` (HttpUrl is in the public API), `implementation(libs.androidx.core.ktx)`, `implementation(libs.androidx.webkit)`, plus whatever the moved files import (coroutines come with androidx). No Play services, no resources.

- [ ] **Step 1: Move the files and wire the module** as listed (`git mv`, then split `WebViewFactory.kt`). Nothing else in `android/app` changes; its imports keep working because the packages are unchanged.
- [ ] **Step 2: Run the phone unit tests and lint**

Run (from `android/`, if the SDK is available): `./gradlew :shell-core:assembleRelease :app:testDebugUnitTest lint`
Expected: BUILD SUCCESSFUL, the same test count as before the move. Without an SDK: `npm run typecheck` at the root and leave the Gradle run to CI (`android.yml` runs `lint testDebugUnitTest assembleRelease` across all modules).

- [ ] **Step 3: Commit**

```bash
git add android/shell-core android/app android/settings.gradle.kts android/build.gradle.kts android/gradle/libs.versions.toml
git commit -m "refactor(android): shared shell classes in a shell-core module"
```

---

### Task 2: Fire TV module and start screen

**Files:**
- Create: `android/firetv/build.gradle.kts`, `android/firetv/proguard-rules.pro` (empty), `android/firetv/src/main/AndroidManifest.xml`
- Create: `android/firetv/src/main/kotlin/app/friendflix/firetv/TvSettings.kt`
- Create: `android/firetv/src/main/kotlin/app/friendflix/firetv/setup/TvSetupFlow.kt`, `…/setup/TvSetupActivity.kt`
- Create: `android/firetv/src/main/kotlin/app/friendflix/firetv/shell/TvShellActivity.kt` (stub in this task: reads the saved origin and finishes into setup when none; Task 3 fills it)
- Create: `android/firetv/src/main/res/layout/activity_tv_setup.xml`, `res/values/themes.xml`, `res/values/colors.xml`, `res/xml/network_security_config.xml` (copy of the phone app's), `res/drawable/tv_banner.xml` (vector, 320×180 dp: logo + "FriendFlix" wordmark as paths on `#0b0b10`), `res/mipmap-anydpi/ic_launcher.xml` + `res/drawable/ic_launcher_foreground.xml` (copies of the phone app's)
- Create: `res/values/strings.xml` and `res/values-{de,pl,es,fr,it,tr}/strings.xml`
- Modify: `android/settings.gradle.kts` (`include(":firetv")`)
- Test: `android/firetv/src/test/kotlin/app/friendflix/firetv/setup/TvSetupFlowTest.kt`, `android/firetv/src/test/kotlin/app/friendflix/firetv/TvSettingsTest.kt`

**Interfaces:**
- Consumes: Task 1's `ServerAddress`, `ServerAddressError`, `HttpUrl.origin()`, `ServerProbe`, `ProbeResult`.
- Produces:
  - `class TvSettings(store: DataStore<Preferences>)`: `val serverOrigin: Flow<HttpUrl?>`, `val authOrigin: Flow<HttpUrl?>`, `val probedOrigin: Flow<String?>`; `suspend fun setServer(origin: HttpUrl, auth: HttpUrl?)`, `suspend fun setAuthOrigin(auth: HttpUrl?)`, `suspend fun setProbedOrigin(origin: String)`; `companion object { fun from(context: Context): TvSettings }` (DataStore file `tv_settings`; keys `serverOrigin`, `authOrigin`, `probedOrigin`).
  - `enum class TvSetupMode { CHECK, FORM }`
  - `object TvSetupFlow`: `fun validate(input: String): Result<HttpUrl>` (= `ServerAddress.normalize(input)`); `fun startMode(stored: HttpUrl?, change: Boolean): TvSetupMode` (null or `change` → `FORM`, else `CHECK`); `fun prefill(stored: HttpUrl?, extra: String?): String` (`extra` ?: `stored?.origin()` ?: `""`); `@StringRes fun addressMessage(input: String, error: ServerAddressError): Int` (blank input → `tv_error_empty`, `INSECURE` → `tv_error_insecure`, else `tv_error_invalid`); `@StringRes fun probeMessage(result: ProbeResult): Int?` (`Ok` → null, `NotFriendFlix` → `tv_error_not_friendflix`, `TlsProblem` → `tv_error_tls`, `AppTooOld` → `tv_error_app_too_old`, `ServerTooOld` → `tv_error_server_too_old`, `Unreachable` → `tv_error_unreachable`).
  - `class TvSetupActivity` with `companion object { const val EXTRA_CHANGE = "app.friendflix.firetv.CHANGE"; const val EXTRA_ADDRESS = "app.friendflix.firetv.ADDRESS"; fun changeIntent(context: Context, current: String): Intent }`; on success it calls `TvSettings.setServer(...)` and starts `TvShellActivity`, then finishes.

Manifest (`android/firetv/src/main/AndroidManifest.xml`): only `android.permission.INTERNET`; `<uses-feature android:name="android.hardware.touchscreen" android:required="false"/>`, `<uses-feature android:name="android.software.leanback" android:required="false"/>`; `<application android:allowBackup="false" android:banner="@drawable/tv_banner" android:icon="@mipmap/ic_launcher" android:label="@string/app_name" android:networkSecurityConfig="@xml/network_security_config" android:supportsRtl="true" android:theme="@style/Theme.FriendFlixTv" android:usesCleartextTraffic="false">`; `TvSetupActivity` exported with `MAIN` + `LAUNCHER` + `LEANBACK_LAUNCHER` and `android:windowSoftInputMode="adjustResize"`; `TvShellActivity` not exported, `android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboard|keyboardHidden|navigation|uiMode|density"`.

`build.gradle.kts`: like `android/app/build.gradle.kts` (version from `version.json`, the same upload-key signing block reading the same three env variables, release minify + shrink, lint block, `buildConfig = true`, the Robolectric `jvmArgs`), with the Global Constraints' ids and SDK levels. Dependencies: `implementation(project(":shell-core"))`, `libs.androidx.core.ktx`, `libs.androidx.activity.ktx`, `libs.androidx.webkit`, `libs.androidx.datastore.preferences`, `libs.okhttp`; tests `libs.junit`, `libs.robolectric`, `libs.androidx.test.core`. Nothing from `play-services`, `media3`, `mediarouter`, `work`.

Screen (`activity_tv_setup.xml`, theme `Theme.FriendFlixTv` = `android:Theme.DeviceDefault.NoActionBar.Fullscreen`, background `#0b0b10`, text white, accent `#ff4f6d`, type ≥ 28sp, content max 1100dp wide centred): title `@string/app_name`; section *checking* (`tv_opening`); section *failure* (message, buttons `tv_retry`, `tv_change_server`; Retry focused; Left/Right/Up/Down move between them via `nextFocus*`); section *form* (label `tv_setup_label`, `EditText` `inputType="textUri"`, `imeOptions="actionGo"`, hint `tv_setup_example`, error line, button `tv_setup_connect`, hint `tv_setup_hint`; field and button link with `nextFocusDown`/`nextFocusUp`). Busy: button text `tv_setup_checking`, disabled. One section visible at a time.

Strings (`values/strings.xml`; `app_name` and `tv_setup_example` are `translatable="false"`):

| name | en | de |
|---|---|---|
| app_name | FriendFlix | – |
| tv_setup_example | friend.example.com | – |
| tv_setup_label | Server address | Serveradresse |
| tv_setup_connect | Connect | Verbinden |
| tv_setup_checking | Checking… | Wird geprüft… |
| tv_setup_hint | Press OK on the field to type with the remote. Up and Down move between the field and Connect. | Drücke OK auf dem Feld, um mit der Fernbedienung zu tippen. Hoch und Runter wechseln zwischen Feld und Verbinden. |
| tv_opening | Opening %1$s | %1$s wird geöffnet |
| tv_retry | Retry | Erneut versuchen |
| tv_change_server | Change server | Server wechseln |
| tv_error_empty | Enter the address of your FriendFlix server. | Gib die Adresse deines FriendFlix-Servers ein. |
| tv_error_insecure | Plain http:// addresses are not allowed. Use an https:// address. | Unverschlüsselte http://-Adressen sind nicht erlaubt. Verwende eine https://-Adresse. |
| tv_error_invalid | That does not look like a server address. Try something like friend.example.com. | Das sieht nicht nach einer Serveradresse aus. Versuche etwas wie friend.example.com. |
| tv_error_unreachable | Cannot reach that server. Check the address, the network and that the server is running. | Der Server ist nicht erreichbar. Prüfe die Adresse, das Netzwerk und ob der Server läuft. |
| tv_error_not_friendflix | That address answered, but it is not a FriendFlix server. | Diese Adresse antwortet, ist aber kein FriendFlix-Server. |
| tv_error_tls | The secure connection failed. The server\'s certificate is not trusted. | Die sichere Verbindung ist fehlgeschlagen. Dem Zertifikat des Servers wird nicht vertraut. |
| tv_error_app_too_old | This app is too old for the server. Update FriendFlix on this Fire TV. | Diese App ist zu alt für den Server. Aktualisiere FriendFlix auf diesem Fire TV. |
| tv_error_server_too_old | The server is too old for this app. Update FriendFlix on the server. | Der Server ist zu alt für diese App. Aktualisiere FriendFlix auf dem Server. |

pl, es, fr, it, tr: natural translations of the en column (informal "you" where the language has it, as in the web locales); `%1$s`, `http://`, `https://`, `friend.example.com`, "FriendFlix" and "Fire TV" stay as they are.

- [ ] **Step 1: Write the failing tests**

```kotlin
// TvSetupFlowTest.kt (plain JUnit)
@Test fun startsWithTheFormWithoutAServerOrOnChange() {
    assertEquals(TvSetupMode.FORM, TvSetupFlow.startMode(null, change = false))
    assertEquals(TvSetupMode.FORM, TvSetupFlow.startMode("https://friend.example.com".toHttpUrl(), change = true))
    assertEquals(TvSetupMode.CHECK, TvSetupFlow.startMode("https://friend.example.com".toHttpUrl(), change = false))
}
@Test fun acceptsHostsPortsAndIpv6() {
    assertEquals("https://friend.example.com", TvSetupFlow.validate(" friend.example.com/tv?x=1 ").getOrThrow().origin())
    assertEquals("https://192.0.2.10:8443", TvSetupFlow.validate("https://192.0.2.10:8443").getOrThrow().origin())
    assertEquals("https://[2001:db8::1]", TvSetupFlow.validate("[2001:db8::1]").getOrThrow().origin())
}
@Test fun addressMessages() {
    assertEquals(R.string.tv_error_empty, TvSetupFlow.addressMessage("   ", ServerAddressError.INVALID))
    assertEquals(R.string.tv_error_insecure, TvSetupFlow.addressMessage("http://friend.example.com", errorOf("http://friend.example.com")))
    assertEquals(R.string.tv_error_invalid, TvSetupFlow.addressMessage("friend", errorOf("friend")))
    assertEquals(R.string.tv_error_invalid, TvSetupFlow.addressMessage("ftp://friend.example.com", errorOf("ftp://friend.example.com")))
    assertEquals(R.string.tv_error_invalid, TvSetupFlow.addressMessage("user@friend.example.com", errorOf("user@friend.example.com")))
}
// errorOf(s) = (TvSetupFlow.validate(s).exceptionOrNull() as ServerAddressException).error
@Test fun probeMessages() {
    assertNull(TvSetupFlow.probeMessage(ProbeResult.Ok("3.0.0", null)))
    assertEquals(R.string.tv_error_unreachable, TvSetupFlow.probeMessage(ProbeResult.Unreachable))
    assertEquals(R.string.tv_error_not_friendflix, TvSetupFlow.probeMessage(ProbeResult.NotFriendFlix))
    assertEquals(R.string.tv_error_tls, TvSetupFlow.probeMessage(ProbeResult.TlsProblem))
    assertEquals(R.string.tv_error_app_too_old, TvSetupFlow.probeMessage(ProbeResult.AppTooOld))
    assertEquals(R.string.tv_error_server_too_old, TvSetupFlow.probeMessage(ProbeResult.ServerTooOld))
}
@Test fun prefillPrefersTheHandedOverAddress() {
    assertEquals("https://192.0.2.7", TvSetupFlow.prefill("https://friend.example.com".toHttpUrl(), "https://192.0.2.7"))
    assertEquals("https://friend.example.com", TvSetupFlow.prefill("https://friend.example.com".toHttpUrl(), null))
    assertEquals("", TvSetupFlow.prefill(null, null))
}

// TvSettingsTest.kt (Robolectric; DataStore from PreferenceDataStoreFactory on a temp file)
@Test fun storesServerAuthAndProbedOrigin() = runTest {
    s.setServer("https://friend.example.com".toHttpUrl(), "https://192.0.2.5".toHttpUrl())
    assertEquals("https://friend.example.com/", s.serverOrigin.first().toString())
    assertEquals("https://192.0.2.5/", s.authOrigin.first().toString())
    assertNull(s.probedOrigin.first())
    s.setProbedOrigin("https://friend.example.com")
    assertEquals("https://friend.example.com", s.probedOrigin.first())
    s.setServer("https://192.0.2.9".toHttpUrl(), null)
    assertNull(s.authOrigin.first())
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./gradlew :firetv:testDebugUnitTest --tests 'app.friendflix.firetv.*'`
Expected: FAIL (unresolved `TvSetupFlow`, `TvSettings`).

- [ ] **Step 3: Implement** `TvSettings`, `TvSetupFlow`, the strings in all seven locales, the layout and theme, `TvSetupActivity` (states as in spec section 3: CHECK runs `ServerProbe(appVersion = BuildConfig.VERSION_NAME).probe(stored)` and opens the shell on `Ok` after `setAuthOrigin`, else shows the failure card; Retry checks again; Change server shows the form; Connect validates, probes, `setServer`, opens the shell; default Back), the manifest, the banner and icon, and the `TvShellActivity` stub.
- [ ] **Step 4: Run the tests and lint**

Run: `./gradlew :firetv:testDebugUnitTest :firetv:lint :firetv:assembleDebug`
Expected: PASS, lint clean (no `MissingTranslation`, `MissingLeanbackLauncher`, `MissingTvBanner`, `ImpliedTouchscreenHardware`).

- [ ] **Step 5: Commit**

```bash
git add android/firetv android/settings.gradle.kts
git commit -m "feat(firetv): Fire TV module with the server address screen"
```

---

### Task 3: The Fire TV shell (WebView, remote keys, page messages)

**Files:**
- Create: `android/firetv/src/main/kotlin/app/friendflix/firetv/shell/FireTvKeys.kt`, `TvBack.kt`, `TvMessages.kt`, `TvStart.kt`, `TvWebView.kt`
- Modify: `android/firetv/src/main/kotlin/app/friendflix/firetv/shell/TvShellActivity.kt`
- Test: `android/firetv/src/test/kotlin/app/friendflix/firetv/shell/FireTvKeysTest.kt`, `TvBackTest.kt`, `TvMessagesTest.kt`, `TvStartTest.kt`, `TvWebViewTest.kt`

**Interfaces:**
- Consumes: Task 1's `OriginPolicy`, `ShellWebViewClient`, `HttpUrl.origin()`, `ServerProbe`; Task 2's `TvSettings`, `TvSetupActivity.changeIntent(context, current)`.
- Produces:
  - `object FireTvKeys`: `const val BACK = "GoBack"`; `fun webKey(keyCode: Int): String?` — `4 → "GoBack"`, `85 → "MediaPlayPause"`, `126 → "MediaPlay"`, `127 → "MediaPause"`, `90 → "MediaFastForward"`, `89 → "MediaRewind"`, `87 → "MediaTrackNext"`, else null; `sealed interface Route { data object Pass : Route; data object Swallow : Route; data class Dispatch(val key: String) : Route }`; `fun route(action: Int, keyCode: Int, repeatCount: Int): Route` — unmapped → `Pass`; mapped and `action == KeyEvent.ACTION_DOWN (0)` and `repeatCount == 0` → `Dispatch(key)`; mapped otherwise → `Swallow`; `fun script(key: String): String` — `require(key in` the seven names`)`; the JS below.
  - `enum class BackAction { NONE, GO_BACK, EXIT }`; `object TvBack { fun after(result: String?, canGoBack: Boolean): BackAction }` — `result` is what `evaluateJavascript` returns (JSON): `"\"handled\""` or `"\"blurred\""` → `NONE`; anything else (`"\"unhandled\""`, `"null"`, null, garbage) → `GO_BACK` when `canGoBack`, else `EXIT`.
  - `sealed interface TvMessage { data object Exit; data object ChangeServer; data class KeepAwake(val on: Boolean) }`; `object TvMessages { const val PORT = "FriendFlixTv"; fun parse(raw: String?): TvMessage?; fun accept(sourceOrigin: Uri, isMainFrame: Boolean, policy: OriginPolicy): Boolean }` — `parse` is exact-match on `exit`, `changeServer`, `keepAwake:1`, `keepAwake:0`; `accept` = `isMainFrame && policy.isAppOrigin(sourceOrigin)`.
  - `object TvStart { fun url(origin: HttpUrl, probedOrigin: String?): String }` — `"${origin.origin()}/tv?ff_app=firetv"` plus `"&probe=1"` when `probedOrigin != origin.origin()`.
  - `object TvWebView`: `fun userAgent(base: String, version: String, displayHeight: Int): String` = `"$base FriendFlixFireTV/$version FFDisplay/$displayHeight"`; `fun displayHeight(physicalHeights: List<Int>): Int` = largest positive value, else 1080; `fun create(context: Context, policy: OriginPolicy, versionName: String, displayHeight: Int, authOrigin: OriginPolicy?, onRenderGone: () -> Unit, onMessage: (TvMessage) -> Unit): WebView`.

The key script (`script(key)`), with `<KEY>` the checked name; the blur branch only for `GoBack`:

```js
(function(){var t=document.activeElement||document.body;if(!t)return 'unhandled';
var ok=t.dispatchEvent(new KeyboardEvent('keydown',{key:'<KEY>',bubbles:true,cancelable:true}));
t.dispatchEvent(new KeyboardEvent('keyup',{key:'<KEY>',bubbles:true}));
if(!ok)return 'handled';
/* GoBack only: */ var n=t.tagName;if(t.isContentEditable||n==='TEXTAREA'||(n==='INPUT'&&!/^(checkbox|radio|range|button|submit)$/.test(t.type))){t.blur();return 'blurred';}
return 'unhandled';})()
```

`TvWebView.create`: `WebView(context)` with JavaScript and DOM storage on, file and content access off, `MIXED_CONTENT_NEVER_ALLOW`, `mediaPlaybackRequiresUserGesture = false`, `useWideViewPort = true`, `loadWithOverviewMode = true`, `userAgentString = userAgent(userAgentString, versionName, displayHeight)`, `isFocusable = true`; `webViewClient = ShellWebViewClient(policy, onRenderGone, onWatch = null, openExternal = {})` with `authOrigin`; `webChromeClient = WebChromeClient()`; download listener that drops everything. Port: when `WebViewFeature.isFeatureSupported(WEB_MESSAGE_LISTENER)`, `WebViewCompat.addWebMessageListener(view, TvMessages.PORT, setOf(policy.originRule()))` passing `TvMessages.parse(message.data)` to `onMessage` only when `TvMessages.accept(sourceOrigin, isMainFrame, policy)`; otherwise `addJavascriptInterface` of an object named `TvMessages.PORT` with `@JavascriptInterface fun postMessage(s: String)` that posts to the main thread and acts only when `view.url` parses to an app origin (`policy.isAppOrigin`).

`TvShellActivity`: no saved server → `TvSetupActivity`, finish. Otherwise `WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)`, `displayHeight` from `display.supportedModes.map { it.physicalHeight }`, the view full screen with focus, `loadUrl(TvStart.url(origin, probedOrigin))` then `setProbedOrigin(origin.origin())`. `dispatchKeyEvent(e)`: `when (val r = FireTvKeys.route(e.action, e.keyCode, e.repeatCount))` — `Pass` → `super`; `Swallow` → true; `Dispatch` → `evaluateJavascript(FireTvKeys.script(r.key))` and true; for `GoBack` the callback applies `TvBack.after(result, view.canGoBack())` (`GO_BACK` → `goBack()`, `EXIT` → `finish()`). `onMessage`: `Exit` → `finish()`; `ChangeServer` → `startActivity(TvSetupActivity.changeIntent(this, origin.origin()))`, `finish()`; `KeepAwake(on)` → add/clear `FLAG_KEEP_SCREEN_ON`. `onStop`: clear the flag, `CookieManager.getInstance().flush()`. Renderer gone: `recreate()` at most twice per process, then `finish()`. `onDestroy`: `webView.destroy()`.

- [ ] **Step 1: Write the failing tests**

```kotlin
// FireTvKeysTest.kt (plain JUnit; KeyEvent constants as ints)
@Test fun mapsTheRemoteKeys() {
    assertEquals("GoBack", FireTvKeys.webKey(4)); assertEquals("MediaPlayPause", FireTvKeys.webKey(85))
    assertEquals("MediaPlay", FireTvKeys.webKey(126)); assertEquals("MediaPause", FireTvKeys.webKey(127))
    assertEquals("MediaFastForward", FireTvKeys.webKey(90)); assertEquals("MediaRewind", FireTvKeys.webKey(89))
    assertEquals("MediaTrackNext", FireTvKeys.webKey(87))
    for (dpad in listOf(19, 20, 21, 22, 23, 66, 82, 24, 25, 3)) assertNull(FireTvKeys.webKey(dpad))
}
@Test fun onlyTheFirstKeyDownIsDispatched() {
    assertEquals(FireTvKeys.Route.Dispatch("MediaFastForward"), FireTvKeys.route(0, 90, 0))
    assertEquals(FireTvKeys.Route.Swallow, FireTvKeys.route(0, 90, 1))   // held: repeats
    assertEquals(FireTvKeys.Route.Swallow, FireTvKeys.route(1, 90, 0))   // key up
    assertEquals(FireTvKeys.Route.Swallow, FireTvKeys.route(1, 4, 0))
    assertEquals(FireTvKeys.Route.Pass, FireTvKeys.route(0, 23, 0))      // OK stays native
    assertEquals(FireTvKeys.Route.Pass, FireTvKeys.route(0, 22, 0))
}
@Test fun scriptOnlyForKnownKeysAndBlursOnlyOnBack() {
    assertTrue(FireTvKeys.script("GoBack").contains("key:'GoBack'"))
    assertTrue(FireTvKeys.script("GoBack").contains("blur()"))
    assertFalse(FireTvKeys.script("MediaPlayPause").contains("blur()"))
    assertThrows(IllegalArgumentException::class.java) { FireTvKeys.script("x');alert(1);('") }
}

// TvBackTest.kt
@Test fun handledOrBlurredBackDoesNothingMore() {
    assertEquals(BackAction.NONE, TvBack.after("\"handled\"", canGoBack = true))
    assertEquals(BackAction.NONE, TvBack.after("\"blurred\"", canGoBack = false))
}
@Test fun unhandledBackWalksHistoryThenExits() {
    assertEquals(BackAction.GO_BACK, TvBack.after("\"unhandled\"", canGoBack = true))
    assertEquals(BackAction.EXIT, TvBack.after("\"unhandled\"", canGoBack = false))
    assertEquals(BackAction.EXIT, TvBack.after("null", canGoBack = false))   // error page: no script ran
    assertEquals(BackAction.EXIT, TvBack.after(null, canGoBack = false))
    assertEquals(BackAction.GO_BACK, TvBack.after("garbage", canGoBack = true))
}

// TvMessagesTest.kt (Robolectric, for Uri)
@Test fun parsesExactMessagesOnly() {
    assertEquals(TvMessage.Exit, TvMessages.parse("exit")); assertEquals(TvMessage.ChangeServer, TvMessages.parse("changeServer"))
    assertEquals(TvMessage.KeepAwake(true), TvMessages.parse("keepAwake:1")); assertEquals(TvMessage.KeepAwake(false), TvMessages.parse("keepAwake:0"))
    for (bad in listOf(null, "", "EXIT", " exit", "keepAwake:2", "changeServer:https://192.0.2.1", "x".repeat(5000))) assertNull(TvMessages.parse(bad))
}
@Test fun acceptsTheAppOriginMainFrameOnly() {
    val p = OriginPolicy("https://friend.example.com".toHttpUrl())
    assertTrue(TvMessages.accept("https://friend.example.com".toUri(), isMainFrame = true, p))
    assertFalse(TvMessages.accept("https://friend.example.com".toUri(), isMainFrame = false, p))
    assertFalse(TvMessages.accept("https://login.friend.example.com".toUri(), isMainFrame = true, p))  // identity provider
    assertFalse(TvMessages.accept("http://friend.example.com".toUri(), isMainFrame = true, p))
    assertFalse(TvMessages.accept("https://friend.example.com:8443".toUri(), isMainFrame = true, p))
}

// TvStartTest.kt
@Test fun probeOnlyTheFirstTimeForAServer() {
    val o = "https://friend.example.com".toHttpUrl()
    assertEquals("https://friend.example.com/tv?ff_app=firetv&probe=1", TvStart.url(o, null))
    assertEquals("https://friend.example.com/tv?ff_app=firetv&probe=1", TvStart.url(o, "https://192.0.2.4"))
    assertEquals("https://friend.example.com/tv?ff_app=firetv", TvStart.url(o, "https://friend.example.com"))
    assertEquals("https://192.0.2.4:8443/tv?ff_app=firetv", TvStart.url("https://192.0.2.4:8443".toHttpUrl(), "https://192.0.2.4:8443"))
}

// TvWebViewTest.kt (Robolectric)
@Test fun userAgentMarkerAndDisplay() {
    assertEquals("UA FriendFlixFireTV/3.0.0 FFDisplay/2160", TvWebView.userAgent("UA", "3.0.0", 2160))
    assertEquals(2160, TvWebView.displayHeight(listOf(720, 1080, 2160)))
    assertEquals(1080, TvWebView.displayHeight(emptyList()))
    assertEquals(1080, TvWebView.displayHeight(listOf(0, -1)))
}
@Test fun lockedDownTvWebView() {
    val v = TvWebView.create(ctx, OriginPolicy("https://friend.example.com".toHttpUrl()), "3.0.0", 1080, null, {}, {})
    with(v.settings) {
        assertTrue(javaScriptEnabled); assertTrue(domStorageEnabled); assertFalse(allowFileAccess); assertFalse(allowContentAccess)
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, mixedContentMode); assertFalse(mediaPlaybackRequiresUserGesture)
        assertTrue(useWideViewPort); assertTrue(loadWithOverviewMode)
        assertTrue(userAgentString.endsWith(" FriendFlixFireTV/3.0.0 FFDisplay/1080")); assertFalse(userAgentString.contains("FriendFlixAndroid/"))
    }
    assertTrue(v.webViewClient is ShellWebViewClient)
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./gradlew :firetv:testDebugUnitTest --tests 'app.friendflix.firetv.shell.*'`
Expected: FAIL (unresolved classes).

- [ ] **Step 3: Implement** `FireTvKeys`, `TvBack`, `TvMessages`, `TvStart`, `TvWebView` and `TvShellActivity` as described.
- [ ] **Step 4: Run the tests and lint**

Run: `./gradlew :firetv:testDebugUnitTest :firetv:lint :firetv:assembleRelease`
Expected: PASS; an unsigned `firetv/build/outputs/apk/release/firetv-release-unsigned.apk`.

- [ ] **Step 5: Commit**

```bash
git add android/firetv
git commit -m "feat(firetv): TV shell with remote keys, Back and page messages"
```

---

### Task 4: Web and backend: Fire TV shell in TV mode, caps, probe

**Files:**
- Create: `web/src/lib/firetv/detect.ts`, `web/src/lib/tvapp.ts`
- Modify: `web/src/lib/webos/caps.ts`, `web/src/lib/webos/probe.ts`, `web/src/lib/player/infobody.ts`, `web/src/lib/Player.svelte`, `web/src/routes/+layout.svelte`, `web/src/routes/me/+page.svelte`
- Modify: `backend/src/media/clientCaps.ts` (`client` union and `z.enum` gain `'firetv'`; doc comment names the Fire TV app)
- Create: `e2e/mocks/firetv.ts`, `e2e/tests/firetv.spec.ts`
- Test: `web/src/lib/firetv/detect.test.ts`, `web/src/lib/tvapp.test.ts`, `web/src/lib/webos/caps.test.ts`, `web/src/lib/webos/probe.test.ts`, `backend/test/client-caps.test.ts`

**Interfaces:**
- Consumes: the Global Constraints' marker, messages and start URL (Task 3 sends them).
- Produces:
  - `firetv/detect.ts`: `export const FIRETV_UA = ' FriendFlixFireTV/'`; `export type FireTvMessage = 'exit' | 'changeServer' | 'keepAwake:1' | 'keepAwake:0'`; `export interface FireWin { navigator?: { userAgent?: string }; FriendFlixTv?: { postMessage?: (m: string) => void }; innerWidth?: number; innerHeight?: number }`; `isFireTvApp(win?: FireWin): boolean` (marker in the user agent; false without a window); `fireTvDisplayHeight(win?: FireWin): number` (`/ FFDisplay\/(\d{3,4})(?!\d)/`, ≥ 2160 → 2160, anything else or missing → 1080); `fireTvOs(win?: FireWin): string | null` (`/Android (\d+(?:\.\d+)?);\s*([A-Za-z0-9_-]+)/` → `'<version>/<model>'`, e.g. `'9/AFTMM'`); `postFireTv(m: FireTvMessage, win?: FireWin): boolean` (false outside the app, without a port, or when it throws); `applyFireTvViewport(doc?: Document, win?: FireWin): boolean` (in the app: sets the `meta[name=viewport]` content to `'width=1920'`, creating the tag when missing; true when set).
  - `tvapp.ts`: `isTvApp(win?): boolean` = `isLgApp(win) || isFireTvApp(win)`; `exitTvApp(win?): void` = Fire TV → `postFireTv('exit', win)`, else `exitLgApp(win)`.
  - `caps.ts`: `ClientCapsBody.client: 'webos' | 'firetv'`; `buildTvCaps(m: MediaProbe | null, o: { client: 'webos' | 'firetv'; appVersion: string; maxHeight: number; assumed: readonly string[] }): ClientCapsBody | null` (today's `buildLgCaps` body, parameterised); `buildLgCaps(m, appVersion)` = `buildTvCaps(m, { client: 'webos', appVersion, maxHeight: 2160, assumed: ASSUMED_CONTAINERS })` (existing tests unchanged); `appCaps(): ClientCapsBody | null` replaces `lgCaps()` (LG → as today; Fire TV → `client: 'firetv'`, `maxHeight: fireTvDisplayHeight()`, `assumed: []`; else null; cached per page load); `_resetAppCaps()` replaces `_resetLgCaps()`. Callers updated: `Player.svelte`, `player/infobody.ts`, `webos/probe.ts`.
  - `probe.ts`: `LgProbeDeps` gains `tv: 'webos' | 'firetv'` and `screen: string`; `LgProbeResult` gains `tv: 'webos' | 'firetv'` and `screen: string`; `formatLgProbe(r)` prints `tv=${r.tv}` and, for `firetv` only, appends ` screen=${r.screen}`; `runLgProbe` with `tv === 'firetv'` returns after the playback checks with `keys: 'skipped'`, `home: 'skipped'` (never waits for keys, never leaves the page); `shouldLgProbe` uses `isTvApp`; `realLgDeps` sets `tv` from `isFireTvApp`, `os` from `fireTvOs` (Fire TV) or `webosVersion` (LG), `palm` false on Fire TV, `screen = `${innerWidth}x${innerHeight}``; `failedLgProbeLine` prints the right `tv`.

Wiring (DOM, no new `.ts`):
- `+layout.svelte`: `tvApp = isTvApp()` next to `lgApp`; the probe overlay renders when `tvApp`; the nav lock installs when `isTizenApp() || isTvApp()`; `if (isFireTvApp()) applyFireTvViewport()` in `onMount` before `boot()`; the two "Back on home leaves the LG app" branches use `isTvApp()` and `exitTvApp()`; on the unpaired `/tv` page (`!tv && path === '/tv' && isBackKey(e)`): LG keeps `history.back()`, Fire TV `e.preventDefault(); postFireTv('changeServer')`. `DeskBar`'s `lgApp` prop is not touched (the TV never shows it).
- `me/+page.svelte`: the *Change server* button shows when `isTvApp()`; its click: Fire TV → `postFireTv('changeServer')`, LG → `changeServerViaHome(...)` as today.
- `Player.svelte`: `appCaps()` instead of `lgCaps()`; the first-frame fallback condition `isLgApp()` → `isTvApp()`; `on:playing` adds `postFireTv('keepAwake:1')`, and `pause`, `ended`, `error` and `onDestroy` add `postFireTv('keepAwake:0')` (no-ops outside the app). `normaliseLgKey` and the keymap's `lg` flag stay LG-only.

- [ ] **Step 1: Write the failing unit tests**

```ts
// firetv/detect.test.ts
const UA = 'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36';
const app = (extra = ' FriendFlixFireTV/3.0.0 FFDisplay/2160', port?: FireWin['FriendFlixTv']): FireWin => ({ navigator: { userAgent: UA + extra }, FriendFlixTv: port, innerWidth: 1920, innerHeight: 1080 });
it('the marker alone makes the Fire TV app', () => {
  expect(isFireTvApp(app())).toBe(true);
  expect(isFireTvApp({ navigator: { userAgent: UA } })).toBe(false);
  expect(isFireTvApp({ navigator: { userAgent: UA + ' FriendFlixAndroid/3.0.0' } })).toBe(false);
  expect(isFireTvApp(undefined)).toBe(false);
});
it('display height: 2160 only for a 4K display, else 1080', () => {
  expect(fireTvDisplayHeight(app())).toBe(2160);
  expect(fireTvDisplayHeight(app(' FriendFlixFireTV/3.0.0 FFDisplay/1080'))).toBe(1080);
  expect(fireTvDisplayHeight(app(' FriendFlixFireTV/3.0.0 FFDisplay/4320'))).toBe(2160);
  expect(fireTvDisplayHeight(app(' FriendFlixFireTV/3.0.0'))).toBe(1080);
  expect(fireTvDisplayHeight(app(' FriendFlixFireTV/3.0.0 FFDisplay/abc'))).toBe(1080);
});
it('os token', () => {
  expect(fireTvOs(app())).toBe('9/AFTMM');
  expect(fireTvOs({ navigator: { userAgent: 'Mozilla/5.0' } })).toBeNull();
});
it('posts only inside the app and never throws', () => {
  const sent: string[] = [];
  expect(postFireTv('exit', app(undefined, { postMessage: (m) => sent.push(m) }))).toBe(true);
  expect(sent).toEqual(['exit']);
  expect(postFireTv('exit', { navigator: { userAgent: UA }, FriendFlixTv: { postMessage: (m) => sent.push(m) } })).toBe(false);
  expect(postFireTv('exit', app())).toBe(false); // no port
  expect(postFireTv('exit', app(undefined, { postMessage: () => { throw new Error('gone'); } }))).toBe(false);
  expect(sent).toEqual(['exit']);
});
it('viewport is 1920 wide in the app only', () => {
  document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  expect(applyFireTvViewport(document, { navigator: { userAgent: UA } })).toBe(false);
  expect(document.querySelector('meta[name=viewport]')!.getAttribute('content')).toBe('width=device-width, initial-scale=1');
  expect(applyFireTvViewport(document, app())).toBe(true);
  expect(document.querySelector('meta[name=viewport]')!.getAttribute('content')).toBe('width=1920');
  document.head.innerHTML = '';
  expect(applyFireTvViewport(document, app())).toBe(true);
  expect(document.querySelectorAll('meta[name=viewport]')).toHaveLength(1);
});

// tvapp.test.ts (mock ./webos/detect and ./firetv/detect like caps.test.ts does)
it('isTvApp: LG or Fire TV', () => { /* lg.on / fire.on combinations → true, true, false */ });
it('exitTvApp posts exit in the Fire TV app and calls exitLgApp otherwise', () => { /* fire.on → postFireTv('exit') once, exitLgApp not called; else exitLgApp once */ });

// caps.test.ts (additions; mock '#lib/firetv/detect' with { isFireTvApp, fireTvDisplayHeight })
it('Fire TV: client firetv, maxHeight from the display, no assumed mkv', () => {
  const c = buildTvCaps(all, { client: 'firetv', appVersion: '1.2.3', maxHeight: 1080, assumed: [] })!;
  expect(c.client).toBe('firetv');
  expect(c.video.every((v) => v.maxHeight === 1080)).toBe(true);
  expect(c.containers).toEqual(['mp4', 'm4v', 'mov', 'ts', 'webm']);
});
it('appCaps: LG block, Fire TV block, null in a browser; cached', () => { /* lg.on → client webos; fire.on + height 2160 → client firetv with maxHeight 2160; neither → null */ });

// probe.test.ts (additions)
it('Fire TV: plays, skips keys and home, prints tv=firetv and screen', async () => {
  const m = mk({ /* all playbacks ok, as the existing happy-path test */ });
  const r = await runLgProbe({ ...m.deps, tv: 'firetv', screen: '1920x1080', os: '9/AFTMM', palm: false }, m.onStage);
  expect(m.deps.waitKey).not.toHaveBeenCalled(); expect(m.deps.goHome).not.toHaveBeenCalled();
  expect(formatLgProbe(r)).toMatch(/^FFPROBE v1 tv=firetv os=9\/AFTMM direct=ok:\d+ms hls=ok nativehls=ok palm=no home=skipped keys=skipped video=.* screen=1920x1080$/);
});
it('LG line is unchanged (no screen token)', () => { /* existing LG expectations + not.toContain('screen=') */ });
```

```ts
// backend/test/client-caps.test.ts (addition)
it('accepts the Fire TV app', () => {
  const c = parseClientCaps({ client: 'firetv', appVersion: '3.0.0', containers: ['mp4'], video: [{ codec: 'h264', maxHeight: 1080 }], audio: ['aac'], subtitles: ['vtt'] });
  expect(c?.client).toBe('firetv');
});
```

- [ ] **Step 2: Write the e2e spec** `e2e/tests/firetv.spec.ts` with `e2e/mocks/firetv.ts`:

`asFireTvApp(page): Promise<{ messages: () => Promise<string[]> }>` — user agent `FIRETV_UA_FULL = 'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 FriendFlixFireTV/3.0.0 FFDisplay/1080'` over CDP (as `asLgApp`), an init script defining `window.FriendFlixTv = { postMessage(m) { window.__ftv.push(m) } }` and `canPlayType = () => 'probably'`. Keys are sent the way the shell sends them: `new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })` on `document.activeElement ?? document.body`.

Tests (paired = `/api/me` with `tv: true` and a silent `/ws/remote`, as in `webos.spec.ts`):
1. Unpaired `/tv?ff_app=firetv` (mock `/api/tv/code`, `/api/tv/claim` as `webos.spec.ts` does): `main.pair .code` shows the code; `html.tv` count 0; key `GoBack` → `messages()` is `['changeServer']`.
2. Paired `/?ff_app=firetv`: `html.tv` count 1, `nav.rail` present, `meta[name=viewport]` content `width=1920`.
3. Paired home: `GoBack` → `nav.rail` has class `open`, `messages()` `[]`; `GoBack` again → `['exit']` exactly once.
4. Paired `/me`: `button.srv` visible; click → `['changeServer']`.
5. Paired, a movie's watch page with the `playerWithInfo` mocks of `webos.spec.ts`: the recorded `/api/playback/info` body has `caps.client === 'firetv'` and every `caps.video[].maxHeight === 1080`; after playback starts `messages()` contains `'keepAwake:1'`; `MediaPlayPause` pauses the video and `messages()` ends with `'keepAwake:0'`.
6. Plain browser user agent with `/?ff_app=firetv` and the same `window.FriendFlixTv` stub, paired: two `GoBack` presses post nothing; the viewport meta stays `width=device-width, initial-scale=1, viewport-fit=cover`.

- [ ] **Step 3: Run the unit tests to verify they fail**

Run: `npx vitest run --root web src/lib/firetv src/lib/tvapp.test.ts src/lib/webos` and `npx vitest run --root backend test/client-caps.test.ts`
Expected: FAIL (missing modules / `firetv` rejected).

- [ ] **Step 4: Implement** the modules and the wiring above.
- [ ] **Step 5: Typecheck and run the new tests**

Run: `npm run typecheck` (root), then the two vitest commands of Step 3.
Expected: typecheck clean; tests PASS. Playwright runs in CI (`e2e` job).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/firetv web/src/lib/tvapp.ts web/src/lib/tvapp.test.ts web/src/lib/webos web/src/lib/player/infobody.ts web/src/lib/Player.svelte web/src/routes/+layout.svelte web/src/routes/me/+page.svelte backend/src/media/clientCaps.ts backend/test/client-caps.test.ts e2e/mocks/firetv.ts e2e/tests/firetv.spec.ts
git commit -m "feat(web): Fire TV shell in TV mode (Back, change server, caps, probe)"
```

---

### Task 5: CI and release: build, check and attach the Fire TV APK

**Files:**
- Create: `android/firetv/check-apk.sh`
- Modify: `.github/workflows/android.yml`, `.github/workflows/android-release.yml`, `.github/workflows/ci.yml` (comments of `android-release`), `.github/workflows/release.yml` (the line that says what CI attaches)

**Interfaces:**
- Consumes: Task 2/3's module (`android/firetv/build/outputs/apk/release/firetv-release-unsigned.apk` unsigned, `firetv-release.apk` signed).
- Produces: release files `friendflix-firetv-<version>.apk`, `friendflix-firetv-<version>.sha256`; CI artifact `friendflix-firetv-unsigned-apk`.

`check-apk.sh <apk>` (bash, `set -euo pipefail`, aapt2 from the newest `$ANDROID_HOME/build-tools/*`; prints each failed check as `::error::…` and exits 1):
- `aapt2 dump badging`: `package: name='com.friendflix.firetv'`; a `leanback-launchable-activity:` line; every `uses-permission:` line is `android.permission.INTERNET` or the package's own `com.friendflix.firetv.*` (androidx.core adds `com.friendflix.firetv.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`); `android.permission.INTERNET` is present.
- `aapt2 dump xmltree --file AndroidManifest.xml`: an `android:banner` attribute on `application`; `android.hardware.touchscreen` with `required` false; no `com.google.android.gms` anywhere.

- [ ] **Step 1: `android.yml`** — the build step runs `./gradlew lint testDebugUnitTest assembleRelease :app:bundleRelease` (all modules; the phone AAB as before); new step "Fire TV: no Google Play services": `./gradlew -q :firetv:dependencies --configuration releaseRuntimeClasspath > "$RUNNER_TEMP/firetv-deps.txt"` and fail with `::error::` when `grep -q 'com.google.android.gms'` matches; new step `bash firetv/check-apk.sh firetv/build/outputs/apk/release/firetv-release-unsigned.apk`; new artifact `friendflix-firetv-unsigned-apk` from `android/firetv/build/outputs/apk/release/*.apk` (`if-no-files-found: error`, 14 days). The existing phone artifact paths stay.
- [ ] **Step 2: `android-release.yml`** — header comment adds the Fire TV APK; the Gradle step runs `lint testDebugUnitTest :app:bundleRelease assembleRelease`; the check step also runs `apksigner verify` and `check-apk.sh` on `android/firetv/build/outputs/apk/release/firetv-release.apk`, copies it to `$RUNNER_TEMP/dist/friendflix-firetv-$VERSION.apk` and writes `friendflix-firetv-$VERSION.sha256` (`sha256sum friendflix-firetv-*.apk`); the step summary adds "Signed Fire TV APK attached (Amazon Appstore: docs/firetv.md)". The Play upload, the notices without secrets and the key deletion stay as they are; no step echoes a secret.
- [ ] **Step 3: Comments** in `ci.yml` (`android-release` job: "the signed Android app (AAB + APK) and the Fire TV APK") and the `release.yml` echo line ("…and the Fire TV APK…").
- [ ] **Step 4: Verify**

Run (if the SDK is available): `cd android && ./gradlew :firetv:assembleRelease && bash firetv/check-apk.sh firetv/build/outputs/apk/release/firetv-release-unsigned.apk && ./gradlew -q :firetv:dependencies --configuration releaseRuntimeClasspath | grep -c com.google.android.gms`
Expected: the script prints nothing and exits 0; the count is `0`. Otherwise CI's `Android` workflow on the PR is the check.

- [ ] **Step 5: Commit**

```bash
git add android/firetv/check-apk.sh .github/workflows/android.yml .github/workflows/android-release.yml .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci(firetv): build, check and attach the Fire TV APK"
```

---

### Task 6: Store listing assets

**Files:**
- Create: `android/firetv/store-listing/src/icon.html`, `banner.html`, `tv1.html`, `tv2.html`, `tv3.html`, `render.sh`
- Create (rendered, committed): `android/firetv/store-listing/icon-512.png`, `icon-114.png`, `banner-1280x720.png`, `tv-1.png`, `tv-2.png`, `tv-3.png`
- Test: `android/firetv/src/test/kotlin/app/friendflix/firetv/StoreAssetsTest.kt`

**Interfaces:**
- Consumes: the logo source `android/play-listing/src/icon.html` uses; the TV look of `web/src/app.css` (`html.tv`).
- Produces: the files `docs/firetv.md` (Task 7) points to.

`render.sh`: modelled on `android/play-listing/src/render.sh` (headless Chromium, `--force-device-scale-factor=1`; Pillow): `icon.html` at 512×512 → `icon-512.png` and a Pillow resize to `icon-114.png`; `banner.html` at 1280×720 → `banner-1280x720.png` (RGB, no alpha); `tv1..3.html` at 1920×1080 → `tv-1..3.png`. Screens: the TV home (side menu, focus tile, a row of posters), a detail page with big buttons, the TV player with the progress bar — built from CSS shapes and gradients, titles only fictional (`Harbour Lights`, `The Paper Kite`, `Copper Valley`, `Night Ferry`, `Salt & Signal`), no real posters, no other service's name or logo, no host names.

- [ ] **Step 1: Write the failing test**

```kotlin
// StoreAssetsTest.kt (plain JUnit; the working directory is android/firetv)
private fun size(path: String): Pair<Int, Int> = File(path).readBytes().let { b ->
    val bb = ByteBuffer.wrap(b, 16, 8); bb.int to bb.int }   // PNG IHDR width, height
@Test fun storeImagesHaveTheirSizes() {
    assertEquals(512 to 512, size("store-listing/icon-512.png")); assertEquals(114 to 114, size("store-listing/icon-114.png"))
    assertEquals(1280 to 720, size("store-listing/banner-1280x720.png"))
    for (i in 1..3) assertEquals(1920 to 1080, size("store-listing/tv-$i.png"))
}
@Test fun templatesNameNoOtherServiceAndNoRealHost() {
    File("store-listing/src").listFiles()!!.filter { it.extension == "html" }.forEach { f ->
        val t = f.readText()
        assertFalse(f.name, Regex("(?i)netflix|plex|prime video|disney|hulu").containsMatchIn(t))
        assertFalse(f.name, Regex("https?://").containsMatchIn(t))
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./gradlew :firetv:testDebugUnitTest --tests 'app.friendflix.firetv.StoreAssetsTest'`
Expected: FAIL (files missing).

- [ ] **Step 3: Write the templates and `render.sh`, run** `CHROME=<chromium> android/firetv/store-listing/src/render.sh` **and look at every image** (fictional titles, logo sharp, nothing cut off).
- [ ] **Step 4: Run the test**

Run: the command of Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/firetv/store-listing android/firetv/src/test/kotlin/app/friendflix/firetv/StoreAssetsTest.kt
git commit -m "feat(firetv): Appstore icons, TV banner and screenshots"
```

---

### Task 7: Docs

**Files:**
- Create: `docs/firetv.md`, `docs/de/firetv.md`
- Modify: `CHANGELOG.md` (*Unreleased*), `README.md`, `README.de.md`, `docs/tv-mode.md`, `docs/android.md` + `docs/de/android.md` ("Building it yourself": one line that the Fire TV module builds with the same commands, link to `firetv.md`)

**Interfaces:**
- Consumes: everything above (names, files, keys, probe line, release file names, check script).

- [ ] **Step 1: `docs/firetv.md`** (English; header `**English** · [Deutsch](de/firetv.md)`, a Contents list like `docs/android.md`) with these sections: *What it is* (TV mode of your server, phone remote works, no downloads / Chromecast / notifications / native player); *Requirements* (Fire OS 7 or newer — Fire TV Stick 3rd gen / Lite / 4K / 4K Max, Fire TV Cube 2nd/3rd gen, Fire TV smart TVs on Fire OS 7/8; not Vega OS devices; an HTTPS server with a public certificate, server and app on the same version); *Install* (Amazon Appstore; or the release's `friendflix-firetv-<version>.apk`: Developer options → ADB debugging, `adb connect 192.0.2.20`, `adb install friendflix-firetv-<version>.apk`, or a downloader app with "Install unknown apps"; check the `.sha256`); *First start* (the address screen, `friend.example.com`, error messages, pairing as in `tv-mode.md`); *The remote* (table from spec section 5); *What plays directly* (caps, 4K only on a 4K display, the rest converted); *The probe line* (when it shows, how to read `FFPROBE v1 tv=firetv …`, `screen=` should be `1920x1080`); *Change server*; *Updates* (Appstore updates itself; the APK is installed over the old one; an Appstore install and an APK install have different signatures and cannot update each other — uninstall first, the TV pairs again); *Owner steps: Amazon Appstore* (numbered: free account at the Amazon Developer Console; Add new app → Android; title FriendFlix, category; upload `friendflix-firetv-<version>.apk`; device support: Fire TV only, tablets and phones off; content rating questionnaire; images from `android/firetv/store-listing/` (`icon-512.png`, `icon-114.png`, `banner-1280x720.png`, `tv-1..3.png`); short and long description en + de, no other service's name; privacy policy link (`docs/privacy.md` on GitHub); testing instructions for Amazon's reviewers: a test server address and test account, how to pair the TV from a browser (`/remote`), never a real personal server; choose Live App Testing for a friends-only release or submit for the public store; each release: new version with the new APK, version code from `version.json` always grows; mark the steps that depend on Amazon's current console wording); *Manual device checklist* (spec Testing list); *Troubleshooting* (unreachable, certificate, too old, black screen → probe line, screen saver during playback, Back does nothing → update the app); *Building it yourself* (`cd android && ./gradlew :firetv:assembleDebug`, output path, signing env variables, `firetv/check-apk.sh`).
- [ ] **Step 2: `docs/de/firetv.md`** — the same page in German (header `[English](../firetv.md) · **Deutsch**`).
- [ ] **Step 3: `docs/tv-mode.md`** — after the LG section, a `### Fire-TV-App` section in German with the key table of spec section 5 (Zurück / Play-Pause / Play / Pause / Vorspulen / Zurückspulen / Weiter) and one sentence that *Server wechseln* sits under Konto in the side menu; link to `firetv.md`.
- [ ] **Step 4: README lines** — after the LG paragraph in `README.md`:

  `**Fire TV app:** FriendFlix for Amazon Fire TV sticks, cubes and TVs (Fire OS 7 and newer), from the Amazon Appstore or as an APK on each release. It opens your TV mode full screen, works with the Fire TV remote and your phone as the remote, and tells the server what the device can play, so files it handles itself are not converted. No Google services, no downloads. Install, remote keys and the owner's Appstore steps: [docs/firetv.md](docs/firetv.md).`

  `README.de.md`:

  `**Fire-TV-App:** FriendFlix für Amazon Fire TV Sticks, Cubes und Fernseher (Fire OS 7 und neuer), aus dem Amazon Appstore oder als APK an jedem Release. Sie öffnet deinen TV-Modus im Vollbild, lässt sich mit der Fire-TV-Fernbedienung und deinem Handy als Fernbedienung steuern und sagt dem Server, was das Gerät abspielen kann, damit Dateien, die es selbst kann, nicht umgewandelt werden. Ohne Google-Dienste, ohne Downloads. Installation, Fernbedienungstasten und die Appstore-Schritte für den Betreiber: [docs/de/firetv.md](docs/de/firetv.md).`

  Docs table rows: `| Fire TV app: install, remote keys, probe, Amazon Appstore steps | [docs/firetv.md](docs/firetv.md) |` and the German row in `README.de.md` (`| Fire-TV-App: Installation, Fernbedienung, Test, Amazon-Appstore-Schritte | [docs/de/firetv.md](docs/de/firetv.md) |`), each after the LG row.
- [ ] **Step 5: `CHANGELOG.md`** under `## [Unreleased]`:

```markdown
### Fire TV
- **FriendFlix on Fire TV.** A new app for Fire TV sticks, cubes and TVs (Fire OS 7 and newer) opens your server's TV mode: side menu, big tiles, detail pages and the TV player with the credits sequence, paired with a code or QR code like the LG app.
- **Server address on first start.** The app asks for your server's address and checks it; *Change server* sits under Account in the side menu.
- **Fire TV remote.** Arrows and OK move and open, Back steps back and opens the side menu, a second Back on the home screen leaves the app; Play/Pause, Rewind and Fast-forward work in the player. Your phone remote works as on every TV.
- **Direct play where the device can.** The app tells the server which formats this Fire TV plays itself (4K only on a 4K display); the server converts the rest. A one-line check on first start shows what plays directly.
- **No Google services.** No Chromecast, downloads or notifications on Fire TV; the screen stays awake while a title plays.
- **Download.** The APK is attached to every release (`friendflix-firetv-<version>.apk`); the owner publishes it in the Amazon Appstore ([docs/firetv.md](docs/firetv.md)).
```

- [ ] **Step 6: Check** every link in the new and changed docs points to an existing file or anchor, only placeholder hosts appear, and no other service's name appears (`grep -niE 'netflix|plex logo' docs/firetv.md docs/de/firetv.md README.md README.de.md CHANGELOG.md` finds nothing new).
- [ ] **Step 7: Commit**

```bash
git add docs/firetv.md docs/de/firetv.md docs/tv-mode.md docs/android.md docs/de/android.md README.md README.de.md CHANGELOG.md
git commit -m "docs(firetv): Fire TV app guide, Appstore steps, changelog"
```
