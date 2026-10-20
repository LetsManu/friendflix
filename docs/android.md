# FriendFlix for Android

**English** · [Deutsch](de/android.md)

The Android app is FriendFlix in your pocket: the same web UI you know from the browser, inside a locked-down app, with four parts done natively where a phone needs them:

- **Player:** a native player (Media3) with direct play when the phone can decode the file, picture-in-picture, the lock screen and Bluetooth buttons, and optional background audio.
- **Downloads:** movies and episodes download in the background, also with the screen off, to the phone or an SD card, and are stored encrypted. When the server cannot be reached, the app opens a list of your downloads to watch offline.
- **Chromecast** from the native player.
- **Notifications** about new episodes, requests and your account, fetched by the app itself about every 10–20 minutes (Android may delay it further; no Google push service).

Everything else (browsing, profiles, watch parties, requests, settings of your account) is the web UI, so it always matches your server's version.

**Requirements:** Android 8.0 or newer, and a FriendFlix server of version 2.0.0 or newer reachable over HTTPS with a certificate from a public CA (for example Let's Encrypt). The app version follows the server version; when one of them is too old, the app says which one to update.

## Contents

- [Install](#install)
- [First start](#first-start)
- [App settings](#app-settings)
- [Player](#player)
- [Downloads and storage](#downloads-and-storage)
- [Encryption at rest and its limits](#encryption-at-rest-and-its-limits)
- [Offline](#offline)
- [Notifications](#notifications)
- [Chromecast](#chromecast)
- [Troubleshooting](#troubleshooting)
- [Owner steps: signing and Google Play](#owner-steps-signing-and-google-play)
- [Manual device checklist](#manual-device-checklist)
- [Building it yourself](#building-it-yourself)

## Install

**From Google Play (closed test).** The app is shared with the household and friends through a closed testing track, not the public Play Store.

1. The FriendFlix admin adds your Google account to the testers (see [Owner steps](#owner-steps-signing-and-google-play)) and sends you the test link.
2. Open the link on your phone while signed in to Google Play with that account, tap **Become a tester**, then **Download it on Google Play**.
3. Updates come through Google Play like for any other app.

**From the GitHub release (fallback).** Every release (`vX.Y.Z`) has a signed `friendflix-android-X.Y.Z.apk` next to its notes, with a `.sha256` file to check it. Download the APK on the phone, allow your browser to install unknown apps when Android asks, and install it. Updates are not automatic this way: install the next APK over it.

> The Play version and the APK are signed with different keys (Google Play re-signs what it delivers). Android cannot update one with the other: to switch, uninstall the app first. Uninstalling deletes the downloads on the phone.

## First start

1. Enter the address of your FriendFlix server, for example `friend.example.com` (`https://` is added for you; plain `http` is refused).
2. The app checks that the address answers like a compatible FriendFlix server (`GET /api/version`). If not, it says why: not reachable, certificate not trusted, not a FriendFlix server, or which side needs an update.
3. Sign in exactly as in the browser, inside the app: the in-app sign-in, or your server's sign-in page at its identity provider (for example Authentik). Re-authentication for account security and *Forgot PIN* work the same way. If your server approves new devices, the phone shows up as a new device for the admin to approve, like a browser would.
4. On Android 13 and newer the app asks **once** whether it may show notifications. If you say no, it does not ask again; you can allow them later in the app settings.

The app opens only your server's address and, for signing in, your server's sign-in page (the identity provider's address the server names in `GET /api/version` as `authOrigin`; the app reads it at setup and at every start). Every other link (trailers, IMDb, help pages) opens in your normal browser. The sign-in page never gets the app's native functions, and the app's own requests (player, downloads, notifications) never send your session there.

**Passkeys.** Where the phone's WebView supports it, the app passes passkey requests to Android's credential manager. Android only offers a passkey to an app that the passkey's site has linked to (Digital Asset Links), so passkeys work in the app after the owner step [5. Passkeys in the app](#5-passkeys-in-the-app-optional). Without it, sign in with your password (and second factor) as usual.

**Fullscreen.** The web player's fullscreen button fills the screen and hides the system bars; Android back leaves fullscreen.

## App settings

Open them in the web UI under **Settings → App on this device → Open app settings**, from the offline list, or from Android's app info screen (the gear icon).

| Setting | What it does |
|---|---|
| Server | Shows the server address. **Change server** asks for the new address and warns first: you are signed out on this device and all downloads on this device are removed. Licences are given back to the old server when it can be reached, and its session is ended. Then the new address goes through the same check as on the first start. |
| Downloads: Phone / SD card | Where new downloads go, with the free space of each. The SD card shows as *not inserted* when there is none. When finished downloads exist, the app offers to **move** them; each file is copied and checked before the original is deleted. |
| Download only on Wi-Fi | Off by default. When on, downloads wait for Wi-Fi and never use mobile data. |
| Background audio | Off by default. When on, the sound keeps playing with the screen off or in another app, with controls in the notification and on the lock screen. When off, playback pauses (picture-in-picture still works). |
| Notifications | Shows whether the app may notify you, with **Allow notifications** when it may not. Four categories can be switched on and off: *New episodes and titles*, *Requests*, *Account and access*, *Other*. |
| Downloads on this device | Opens the offline list. |
| (kids profiles) | The offline list has no settings button while a kids profile was the last one used (the app learns that at each online start), like the web UI hides the entry. Android's app info screen (the gear icon) still opens the settings: that is the device owner's way in. |
| Sign out of this device | After a confirmation: closes the player if one is open, ends your session on the server (when reachable), gives the licences back, deletes every download on this device and the keys that encrypt them, clears the app's cookies and stored web data, and forgets which notifications you have seen. Your account, profiles and watch history stay as they are. |
| Version | The app version (the same as the server release it belongs to). |

Everything else, such as playback languages, subtitles, autoplay and the default download quality, is set in the web UI as usual.

## Player

The native player has the buttons of the web player's control bar, in the same order. Buttons that need the server only show when the server offers that feature.

**Top bar** (from the right: *More*, *Audio and subtitles*, *Cast & info*, the Chromecast button, the quality chip):

- **More (⋯):**
  - *Playback speed:* 0.5× to 2×. It is not saved: every title starts at 1×. A badge on the button shows a speed other than 1×.
  - *Bookmarks:* *Share scene* shares a link to the current position with Android's share sheet. You can add a bookmark with a short note (up to 140 characters), tap one to jump there, or remove it.
  - *Quality:* the quality choices that used to be in the top bar.
  - *Sleep timer:* off, 15, 30, 45 or 60 minutes, or *After this episode*. When it runs out, playback pauses with the note *Sleep timer: playback paused*. A dot on the button shows that a timer runs, and the time left is shown in More. *After this episode* stops the next episode from starting. The timer keeps running with background audio.
  - *Lock controls:* hides every control and ignores touches, so that nothing happens by accident. Only a lock icon stays; hold it for a moment to unlock. A short tap, or Android back, shows *Press and hold to unlock*.
  - *Picture-in-picture:* the same small window you get with Home while playing.
  - *Play on TV* / *Playing on TV:* the Chromecast choice, shown when a Cast device is available or connected.
- **Audio and subtitles:** the audio track and subtitles as before, plus:
  - *Find subtitles …* when your server allows subtitle search and your role may use it. Pick a language, then a result. The player reloads at the same position and says *Subtitles added – pick them in the menu*.
  - *Clear voices* (dialogue stands out from music and effects) and *Night mode* (loud scenes quieter, quiet ones louder). They need Android 9 or newer; on Android 8 they are greyed out with a note. The setting is saved for your profile, like in the web player.
- **Cast & info:** cast, guest stars, crew, studios and genres of the title, with pictures. A tap on a person lists their other titles, and a tap on a title closes the player and opens that title's page in the app.
- **Quality chip:** *Original* when the file plays as it is, or *Converted · 1080p* when the server converts it. A tap says why, for example the network, a limit for your role, or a codec the phone cannot play.

**Bottom bar:**

- **Episodes** (episodes of a series only): the seasons and their episodes, with progress. A tap plays that episode in the same player.
- **Scenes** (when the server has chapters): the chapters, with pictures where the server has them. A tap jumps there. Chapter starts and your bookmarks are marked on the seek bar.
- **Seek bar:** while you drag it, a small preview picture shows the frame at that point, when the server offers previews.

**At the end of a title:** when post-play is on (on the server and in your profile) and no next episode follows, a card *Done? See what's next* appears near the end. At the end the *What's next?* screen opens with rows of suggestions: *Play* starts the next part in the player, and a tap on a title opens its page. For a movie without post-play, *More like this* shows three similar titles. In picture-in-picture the screen waits until you open the player again. The player never closes by itself at the end.

Your *Subtitle appearance* from the web settings (size, colour, background, font) is used for subtitles. With *Anime: original audio with subtitles* on in your profile, an anime series starts in Japanese with subtitles in the app language, unless you chose something else for that series.

**Offline (a download):** *Episodes*, *Scenes*, *Cast & info*, bookmarks, subtitle search, quality, the quality chip, Chromecast and post-play need the server and are hidden. Speed, *Clear voices* and *Night mode* (with your last setting on this phone), subtitles and their style, the sleep timer, lock and picture-in-picture work.

**While casting:** the phone is the remote for the TV. *Episodes* plays the picked episode on the TV, *Scenes* and bookmarks jump on the TV, a new bookmark takes the TV's position, the sleep timer pauses the TV, and *Cast & info* shows the title the TV plays. Not offered while casting: audio, subtitles, subtitle search, *Clear voices* and *Night mode*, quality and its chip, speed, lock, picture-in-picture and post-play. The Chromecast button stays first on the right of the top bar, and More shows *Playing on TV*.

## Downloads and storage

You start a download in the web UI as in the browser: the server creates the licence with its quality and expiry (see [downloads.md](downloads.md)), and the app takes over the transfer.

- Downloads run as background jobs and continue after the app is closed, the network drops, or the phone restarts; an interrupted file resumes where it stopped. While a file transfers, Android shows a notification with the progress (without the title).
- Files live in the app's own folder on the phone or the SD card (`Android/data/com.friendflix/files/downloads`). The app needs no storage permission. Other apps cannot use the files, and uninstalling the app removes them.
- Text subtitles (SRT, VTT) and the poster are downloaded with the title. Image subtitles (PGS, VobSub) are not available offline.
- When the card holding a download is taken out, the download shows as paused and continues when the card is back.
- If the session on the server ends (signed out elsewhere, expired), downloads pause with a *Sign in again* notice and continue after the next sign-in.
- The web UI's **Downloads** page (also *Go to Downloads* on a title) lists the app's downloads of the active profile, with Play (native player) and Delete, also for expired ones.
- Deleting a download in the app (on the Downloads page or with **Remove** in the offline list) gives the licence back to the server, so it no longer counts against your limit. An expired download can be removed the same way.

## Encryption at rest and its limits

Every downloaded file (video, subtitles, artwork) is written encrypted: AES-256 in counter mode with a random IV per file, and an HMAC-SHA256 tag per 1 MiB chunk, so the player can seek and any change to the file is detected. The keys are made on the phone: a random data key and MAC key, wrapped by a key in the Android Keystore (in the secure hardware where the phone has it) and stored in a folder that is never backed up.

What this gives you: a file copied off the phone, for example from an SD card put into a computer, is unreadable, and it plays only in this app on this phone. A modified file is refused instead of played.

What it does **not** give you:

- **It is not DRM.** While the app runs, the unwrapped keys are in its memory. Someone with full control of the phone (root, or a debugger on an unlocked device) can reach them and decrypt the files.
- The file size shows roughly how long a video is.
- Clearing the app's data, uninstalling the app or **Sign out of this device** deletes the keys; the downloads are gone with them and have to be downloaded again. If Android loses the Keystore key (rare, for example after some device resets), the app notices and removes the downloads it can no longer read.
- Licences, expiry and revocation are enforced by the server and checked by the app (next section). They protect against misuse by mistake, not against a determined owner of a rooted phone.

## Offline

When the app starts and the server cannot be reached (no network, flight mode, the server is down), and the active profile has finished downloads, the app opens the **offline list**. You can also open it from the app settings.

- It lists the downloads of the profile you used last, with size and how many days are left. *Days left* is the **offline window**: the licence's expiry or the end of the offline grace period, whichever comes first.
- The offline grace period is the server's `DOWNLOAD_OFFLINE_GRACE_DAYS` (default 7 days) after the last online check. After that a download asks you to go online briefly; one check renews it.
- If the phone's clock was turned back, playback is refused until the next online check.
- Watched positions and "watched" are saved on the phone and sent to the server on the next start or when the network is back. A newer state on the server wins.
- **Remove** on a row deletes that download from the phone after a confirmation (also an expired one).
- **Reconnect** checks the server and goes back to the web UI. Licences revoked on the server (device removed, role changed, account disabled) delete the files at that check.

## Notifications

Server notifications (a new episode of a series you follow, a request that is done, an approved device, invitations and so on) reach the phone without any third-party push service:

- A background job asks your server for new notifications (`GET /api/notifications`, with the session of the app) about every 10–20 minutes (Android may delay it further). Android decides the exact time and delays it more in battery saver or Doze; it is not instant.
- Only new items are shown. The first run after signing in shows nothing (it only notes what is there), and items you already read in the web UI are skipped. The app does not mark items as read on the server.
- Tapping a notification opens the matching page in the app; a link to a title plays it in the native player.
- Each category is its own Android notification channel, so you can also change sound and importance per category in Android's settings.
- When the session ends, the app stops asking until you open it and sign in again.
- The text is the server's text and can contain a title. To hide it on the lock screen, use Android's lock screen notification setting.

Download notifications (progress, *sign in again*) never show titles.

## Chromecast

In the native player a Cast button appears when a Chromecast or Google TV is on the same Wi-Fi and your server allows casting.

- Casting uses the same short-lived cast tokens as the web UI. If the server sets `CAST_RECEIVER_APP_ID`, the TV runs FriendFlix's own receiver, otherwise Google's Default Media Receiver ([cast.md](cast.md)). The app reads that setting when it starts, so after a change restart the app.
- The next episode is queued on the TV when autoplay allows it; the phone keeps the controls, also on the lock screen.
- Stopping the cast continues on the phone where the TV was. Closing the player stops the cast.
- Downloads are never cast; the Cast button is hidden while you play one.
- Audio, subtitle and quality changes, speed, subtitle search, *Clear voices* and *Night mode* are not offered while casting; choose them before. *Episodes*, *Scenes*, bookmarks, the sleep timer and *Cast & info* act on the TV ([Player](#player)).
- The Cast feature comes from Google's Cast SDK, which brings Google's own Cast telemetry (it reports to Google as in every app that uses Google Cast). FriendFlix itself sends no analytics. On a phone without Google Play services there is no Cast button; everything else works. Details: [security.md, Android app](security.md#android-app).

## Troubleshooting

| What you see | What to check |
|---|---|
| *This address does not answer like a FriendFlix server.* | The address opens FriendFlix in a browser? A captive portal (hotel Wi-Fi) or a reverse proxy rule can answer instead. `https://friend.example.com/api/version` must return FriendFlix's version. |
| *The secure connection failed.* | The certificate must come from a public CA. Self-signed certificates and user-installed CAs are not accepted, also not in debug builds. |
| *Please update the app.* / *Please update FriendFlix on the server.* | App and server versions are too far apart. Update the side the message names. |
| A download stays *paused* | *Download only on Wi-Fi* is on and there is no Wi-Fi; the SD card is not inserted; another profile is active in the web UI (it continues when that download's profile is active again); or a *Sign in again* notice is waiting. |
| A download stops with an error | *Not enough space* or a storage error: free some space, then start the download again in the web UI. |
| *Please go online briefly to confirm the download.* | The offline window is over. Connect once; the check renews it. |
| *The device clock is wrong.* | The clock was turned back. Set the time automatically and go online once. |
| *Not available on this device right now.* | Android's Keystore did not answer. Try again in a moment or restart the phone; nothing is deleted. |
| No notifications | Allowed in the app settings? Category switched on? Battery optimization for FriendFlix in Android's settings can delay them further. Wait at least 20 minutes after something happened. |
| No Cast button | Same Wi-Fi as the TV? Casting enabled on the server? Google Play services installed? Playing a download? |
| *At most N streams at a time are allowed.* | Your account's stream limit is reached (other devices, or a cast still running). Stop one. |
| The APK does not install over the Play version (or the other way round) | Different signatures, see [Install](#install). Uninstall first. |
| Something else | Open the same page in a browser: if it fails there too, it is the server. Sign out of this device and sign in again as a last resort (downloads are deleted). |

## Owner steps: signing and Google Play

These steps are done once by the owner of the repository and the Play Console account. Nothing here goes into the repository.

### 1. Create the upload key

The upload key signs what you upload to Google Play; Google then signs the app for delivery with its own key (Play App Signing). On a trusted computer with a JDK:

```sh
keytool -genkeypair -v -storetype PKCS12 -keystore friendflix-upload.jks \
  -alias upload -keyalg RSA -keysize 4096 -validity 10000
```

Use one strong password (PKCS12 uses the same password for the store and the key). Keep `friendflix-upload.jks` and the password in your password manager or an offline backup. If you lose it, Google can reset the upload key (Play Console → *Test and release* → *App integrity*).

### 2. Add the three GitHub secrets

In the repository: *Settings → Secrets and variables → Actions → New repository secret*, or with the GitHub CLI:

```sh
base64 -w0 friendflix-upload.jks > upload.b64        # macOS: base64 -i friendflix-upload.jks > upload.b64
gh secret set ANDROID_UPLOAD_KEYSTORE < upload.b64
gh secret set ANDROID_UPLOAD_KEY_PASSWORD             # asks for the password, nothing lands in the shell history
gh secret set ANDROID_UPLOAD_KEY_ALIAS --body upload
rm upload.b64
```

| Secret | Value |
|---|---|
| `ANDROID_UPLOAD_KEYSTORE` | the keystore file, base64 |
| `ANDROID_UPLOAD_KEY_PASSWORD` | the store and key password |
| `ANDROID_UPLOAD_KEY_ALIAS` | the key's alias (`upload` above) |

From then on, every release tag (`vX.Y.Z`, cut by the *Release* workflow) builds a signed AAB and APK in CI (`.github/workflows/android-release.yml`) and attaches `friendflix-android-X.Y.Z.aab`, `friendflix-android-X.Y.Z.apk` and `friendflix-android-X.Y.Z.sha256` to the GitHub Release. The keystore is decoded only for that build and deleted right after it. Without the three secrets the job leaves a notice and attaches nothing; pull requests always build unsigned. To attach the files to a release that was cut before the secrets existed, run *Actions → Android release → Run workflow* on that tag.

### 3. Create the app in the Play Console

1. In the Play Console, *Create app*: name FriendFlix, app (not game), free. The store listing graphics (app icon 512×512, feature graphic 1024×500, three phone screenshots 1080×1920 with fictional titles) are in `android/play-listing/`; `android/play-listing/src/render.sh` renders them again from the README screenshots and the logo.
2. Fill in what Google asks before testing (*Dashboard → Set up your app*): privacy policy URL (the app's policy is [privacy.md](privacy.md); use its GitHub address `https://github.com/LetsManu/friendflix/blob/main/docs/privacy.md`), app access (testers need a FriendFlix account on your server; give Google's reviewers a test account or explain that access is by invitation), ads (none), content rating, target audience, data safety. For data safety: the app sends what you do only to your own FriendFlix server; it contains no analytics or advertising SDK; Google's Cast SDK sends its own Cast telemetry to Google.
3. *Test and release → Testing → Closed testing → Create track*, then *Create new release*. Play App Signing is on by default for new apps: keep *Google-generated key*.
4. Upload `friendflix-android-X.Y.Z.aab` from the GitHub Release. The first upload fixes the package name `com.friendflix` for good.
5. Roll the release out to the closed track. Google reviews it (usually hours to a few days).

### 4. Add testers

1. In the closed track: *Testers → Create email list* (or use a Google Group) with the Google accounts of your household and friends, and choose the countries.
2. Copy the **opt-in link** and send it to them ([Install](#install)).
3. For each later release, upload the new AAB to the same track. Testers get it as an update.

Closed testing is enough for a household and friends; the app does not need a public Play Store listing.

### 5. Passkeys in the app (optional)

The app uses the WebView's app mode for passkeys (WebAuthn): Android's credential manager hands a passkey to the app only when the passkey's **relying party** (its RP ID, the domain the passkeys belong to; with Authentik this is set on the WebAuthn authenticator stage, usually the sign-in host or the shared parent domain) has linked the app. Publish this file at `https://<rp-id>/.well-known/assetlinks.json` (for example `https://auth.example.com/.well-known/assetlinks.json`), served as `application/json` without redirects:

```json
[
  {
    "relation": ["delegate_permission/common.get_login_creds"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.friendflix",
      "sha256_cert_fingerprints": [
        "<SHA-256 OF THE PLAY APP SIGNING KEY>",
        "<SHA-256 OF YOUR UPLOAD KEY>"
      ]
    }
  }
]
```

- *Play App Signing key*: Play Console → *Test and release* → *App integrity* → *App signing key certificate*, SHA-256 (the app installed from Google Play is signed with it).
- *Upload key*: `keytool -list -v -keystore friendflix-upload.jks -alias upload` (the APK from the GitHub release is signed with it). Both fingerprints have the form `AA:BB:…` (32 pairs).

If the file is missing or wrong, the app simply offers no passkeys; password sign-in works regardless.

## Manual device checklist

Unit tests and the emulator in CI cover the logic; these points need a real phone (from the development notes of the app). Use a test server, an SD card if the phone has a slot, a Chromecast, and Bluetooth headphones.

**Install and shell**
1. Fresh install, first start: setup accepts `friend.example.com`, refuses `http://`, a wrong host and a server with a self-signed certificate with the right message.
2. Sign in (in-app sign-in and your sign-in page). External links open in the browser; Android back walks the web UI's history and leaves the app at the start page.
3. Classic sign-in via the identity provider: on a server whose sign-in page is the identity provider (`LOGIN_UI=authentik`, or `/auth/login?classic=1`), the sign-in page opens inside the app and after signing in you are back in the web UI; no browser opens. A link on the sign-in page to another site opens in the browser.
4. Reauth (e.g. account security): an action that asks you to sign in again opens the identity provider inside the app and comes back to the page.
5. Forgot PIN: *Forgot PIN* on a profile's PIN screen signs in again at the identity provider inside the app and comes back to set a new PIN.
6. Passkeys: with `assetlinks.json` published (owner step 5), sign in with a passkey on the sign-in page. Without it no passkey is offered and password sign-in works.
7. A title in the web player (for example after the native player handed it back): the fullscreen button fills the screen without system bars; Android back leaves fullscreen first.
8. `adb shell am start -n com.friendflix/app.friendflix.android.shell.ShellActivity --es app.friendflix.android.OPEN_PATH /requests` opens the start page, not `/requests`; a notification tap still opens its page (it uses the non-exported entry).
9. Android 13+: the notification permission is asked once on the first start, never again by itself; *Allow notifications* in the app settings asks again or opens Android's settings after two refusals.

**Downloads and storage**
10. Download a movie on mobile data and on Wi-Fi; with *Download only on Wi-Fi* on, it waits until Wi-Fi is back.
11. Screen off during a download: it keeps going with the progress notification (no title in it). Kill the app from recents, restart the phone: it resumes from where it stopped.
12. Flight mode in the middle of a download: it pauses and resumes by itself afterwards.
13. SD card: pick it in the settings with downloads on the phone and choose *Move*; they move and still play. Take the card out: the downloads show as paused; put it back: they continue. Copy a file from the card to a computer: it is unreadable.
14. Sign out in the web UI on another device (session ends): downloads pause with *Sign in again*; after signing in they continue.
15. Delete a download in the app: the licence disappears on the server (Account → Downloads in the browser).
16. The web UI's Downloads page in the app (also *Go to Downloads* on a title): it lists the app's downloads of the active profile (no browser storage bar), Play opens the native player, the X removes a download, also an expired one.
17. Offline list: **Remove** on a row asks first, then the download is gone (an expired one too). With a kids profile used last (open the app online once with it), the offline list shows no settings button; the gear on Android's app info screen still opens the settings.

**Offline**
18. Flight mode, start the app with finished downloads: the offline list opens (only once, also when the start check runs again), shows the days left as the offline window, and plays.
19. Watch offline for a while, go online: the position shows on the web. Set the clock back by a day: playback is refused until the next online check. Stay offline beyond the grace period: *Please go online briefly*.
20. Revoke the device on the server, reconnect: the files are deleted.

**Player**
21. Play from the web UI (detail page, episode list, hero): the native player opens. A double tap or a retry after 5 s does not open two players.
22. Episode cards (favourites, search, a library page), the history page and the cast bar's *Play here*: the native player opens and the web UI stays on its page. With a profile the native player hands back, the web player opens once (no second question).
23. Direct play of an H.264 MP4. HEVC 10-bit on a phone with hardware HEVC → direct (admin "now playing" says direct), and on a phone without → transcode.
24. Audio track change → new session (one stop and one start in the admin view), the choice is remembered for the series. Subtitle on/off, and the series choice is remembered. Quality pick → transcode at that rung.
25. Episode with an intro: the skip button shows in range; with auto-skip on, it skips once. At the credits: the next-up card and a 10 s countdown that waits while paused. "Watch credits" brings the card back at the end. Three autoplays → "Still there?".
26. Resume: stop at minute 10, open again → it continues there. The web shows the same position.
27. Home while playing → picture-in-picture (Android 12+ automatically; older on Home). The play/pause action works. Closing it stops playback and sends a stop report.
28. Background audio off: screen off or Home without picture-in-picture → pauses; pause with the screen off, then press play on Bluetooth or in the notification → nothing happens; back on the screen play works. Background audio on → audio continues with the notification; lock screen and Bluetooth play/pause work.
29. An account at its stream limit → "At most N streams …". Kids profile → the server's refusal shows the generic error.
30. Offline list → play a download: plays, seeks, the position syncs on reconnect. Kill the app while playing an offline title, reopen from recents → the offline check runs again. An offline title paused in the background for more than 5 min, then resumed from the notification → the check runs again (refused after the offline window).
31. Open `https://friend.example.com/watch/<id>` through a reload or a link → the native player opens, the web UI stays on the previous page. With no profile known yet → the web player loads. A watch link while the web UI runs another profile → the player closes and the web watch page plays.
32. Rotate and resize (split screen): playback continues without a new session. Replay a finished episode from the end → the admin's now-playing shows it again, and a stop is reported when leaving.
33. A direct-played MKV with embedded text subtitles: they are not offered (only the server's WebVTT); check that the server lists them as external subtitles.

**Player controls**
34. The bar: top bar from the right *More*, *Audio and subtitles*, *Cast & info*, the Chromecast button, the quality chip; bottom bar *Episodes*, *Scenes*, next episode. The bar looks right in portrait and landscape and on a tablet.
35. Episodes: on an episode the panel opens on the current season, with progress and a mark on the playing one; a movie has no *Episodes* button. Pick another episode: it plays in the same player, speed is back to 1×, a sleep timer *After this episode* is cleared, and its scenes and bookmarks load.
36. Scenes and marks: a title with chapters shows *Scenes* with pictures; a tap jumps there and closes the panel. Chapter starts and bookmarks are marks on the seek bar. A title without chapters has no *Scenes* button.
37. Preview while scrubbing: drag the seek bar; a picture above the thumb follows. Check a long movie whose server previews use large sheets: the preview keeps up, the app does not slow down or crash. A server without previews: no picture, seeking works.
38. Cast & info: the panel shows the title line, cast, crew and genres with pictures. A tap on a person lists their titles; a tap on a title closes the player and opens its page in the app.
39. Audio and subtitles, *Find subtitles …*: pick German, pick a result: the player reloads at the same position and says *Subtitles added – pick them in the menu*; the new subtitle is in the list. A guest, or a server without subtitle search: no row. No result and provider errors show the web's texts.
40. *Clear voices* and *Night mode* on Android 9 or newer: the sound changes audibly; the web player shows the same setting for the profile. On Android 8 the switches are greyed out with *Not available on this device*. While casting the *Audio and subtitles* button is gone.
41. More, speed: 1.5× shows a badge on More; the next episode starts at 1×. More, bookmarks: *Share scene* opens Android's share sheet with a `/watch/<id>?t=` link; add a bookmark with a note, tap it to jump, remove it. More, quality: pick 720p; the chip shows *Converted · 720p*.
42. Sleep timer: 15 minutes shows a dot on More and the time left in More; when it runs out playback pauses with *Sleep timer: playback paused*. *After this episode* on the phone: no next-episode countdown, playback pauses at the end. *After this episode* while casting: the TV stops at the end of the episode and does not move on.
43. Lock controls: touches do nothing; Android back shows *Press and hold to unlock* and keeps the player; holding the lock icon unlocks.
44. More, picture-in-picture: the small window opens; an open panel closes and no panel shows in the window.
45. Quality chip: *Original* for a direct file; a converted stream shows the reason on a tap.
46. Post-play: a movie with post-play on: *Done? See what's next* near the end, the *What's next?* screen at the end; *Play* on the next part plays it in the player, a title opens its page. A movie without post-play: *More like this* with three titles. Let a title end in picture-in-picture: the screen shows once the player is opened again. The player never closes by itself at the end.
47. Offline (a download): no *Episodes*, *Scenes*, *Cast & info*, bookmarks, *Find subtitles …*, quality, chip or Chromecast button; speed, sleep timer, lock, subtitles, *Clear voices* and *Night mode* work.

**Chromecast**
48. A Cast device on the Wi-Fi and casting enabled → the Cast icon shows in the player. No device → no icon. Playing a download → never an icon.
49. Tap the icon, pick the TV: the phone shows "Playing on …" and its controls drive the TV; the admin's "now playing" shows the local session stopped and the cast session started.
50. Default Media Receiver (no `CAST_RECEIVER_APP_ID`): plays from the phone's position with the chosen subtitle; pause and seek work; progress shows in the admin view.
51. Own receiver: set `CAST_RECEIVER_APP_ID`, open a title once, restart the app, cast: the own receiver starts, its reports arrive, its next-up card is in the app's language.
52. Episode with autoplay: about 40 min before the end the next episode is queued; at the end the TV moves on by itself, also with the phone locked, and the phone's title updates.
53. Stop casting from the Cast dialog → local playback continues at the TV's position (paused if the TV was paused). Turn the TV off or cut its network → the phone takes over at the last position. Close the player while casting → the TV stops.
54. Account at its stream limit → casting shows the limit and local playback goes on. A role without transcoding → "Chromecast needs transcoding …".
55. Cast for over 50 min, also with the phone locked → the TV keeps playing after a short reload (token renewal; if it stops, check whether Doze suspended the app).
56. Notification and lock screen controls while casting work; tapping brings the player back. Kill the app while casting: the TV may play on until the token expires; reopening starts nothing by itself.
57. The player's menus and the Cast dialog look right in light and dark system mode.
58. While casting: *Episodes* plays the picked episode on the TV; *Scenes* and a bookmark jump on the TV; a new bookmark takes the TV's position; *Cast & info* shows the TV's title, also after the TV moved on to the next episode. *Audio and subtitles*, the quality chip, the next-episode button, speed, quality, lock and picture-in-picture are gone. The Chromecast button stays first on the right and More shows *Playing on TV*.
59. Stop casting: *Audio and subtitles*, the quality chip and the next-episode button are back.

**Notifications**
60. Fresh install, signed in: no flood on the first poll. Create a notification on the server (for example an invite) and see it within roughly 10–20 min (Android may delay it further). Check the channel names in Android's settings in German and English.
61. Tap: the shell opens the right page; a `/watch/…` link opens the native player; with the app already open the page changes in place.
62. Switch a category off in the app settings: nothing of it is posted. Revoke the permission: no crash, and the items appear after allowing it again.
63. Session expires on the server: no notification and no more polling; open the app, sign in: polling resumes.

**App settings**
64. Change the server to a second test server: the warning names the new address; afterwards the downloads are gone, the old server shows the licences returned and the session ended, and setup checks the new address (a typo stays on the setup screen with the address filled in).
65. Sign out of this device: after the confirmation the app shows the sign-in page; downloads and their files are gone (also on the SD card), the next download works (new keys), and the old session no longer works on the server.
66. Android's app info → the gear icon opens the app settings; the version shown matches the release.

## Building it yourself

The app lives in `android/` (Kotlin, Gradle, minSdk 26, targetSdk 36). With JDK 21 and the Android SDK (platform 36):

```sh
cd android
./gradlew lint testDebugUnitTest assembleDebug    # debug APK in app/build/outputs/apk/debug/
```

Release builds (`assembleRelease`, `bundleRelease`) are unsigned unless all three signing environment variables are set (`android/app/build.gradle.kts` reads them; the release workflow sets them from the secrets):

| Gradle environment variable | Value |
|---|---|
| `ANDROID_UPLOAD_KEYSTORE_FILE` | the **path** of the keystore file (`.jks`), not base64 |
| `ANDROID_UPLOAD_KEY_PASSWORD` | the store and key password |
| `ANDROID_UPLOAD_KEY_ALIAS` | the key's alias |

```sh
read -rs ANDROID_UPLOAD_KEY_PASSWORD && export ANDROID_UPLOAD_KEY_PASSWORD   # asks for the password, keeps it out of the shell history
ANDROID_UPLOAD_KEYSTORE_FILE=$HOME/keys/friendflix-upload.jks ANDROID_UPLOAD_KEY_ALIAS=upload \
  ./gradlew bundleRelease assembleRelease
```

The GitHub secret `ANDROID_UPLOAD_KEYSTORE` is something else: the same keystore as base64, which the workflow decodes into a temporary file and passes as `ANDROID_UPLOAD_KEYSTORE_FILE`. The version comes from `version.json` at the top of the repository. Security notes for the app: [security.md, Android app](security.md#android-app).
