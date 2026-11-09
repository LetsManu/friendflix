# FriendFlix for Fire TV

**English** · [Deutsch](de/firetv.md)

The Fire TV app opens your server's TV mode full screen on an Amazon Fire TV stick, cube or TV: side menu, big tiles, detail pages and the TV player, steered with the Fire TV remote or with your phone as the remote. It tells the server what the Fire TV can play, so files it handles itself are not converted.

It is the same web UI your server serves in [TV mode](tv-mode.md), inside a small locked-down app. It has no downloads, no Chromecast, no notifications and no native player; it uses no Google services.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [First start](#first-start)
- [The remote](#the-remote)
- [What plays directly](#what-plays-directly)
- [The first-run check line](#the-first-run-check-line)
- [Change server](#change-server)
- [Updates](#updates)
- [Owner steps: Amazon Appstore](#owner-steps-amazon-appstore)
- [Manual device checklist](#manual-device-checklist)
- [Troubleshooting](#troubleshooting)
- [Building it yourself](#building-it-yourself)

## Requirements

- **A Fire TV with Fire OS 7 or newer** (Android 9 and up): Fire TV Stick 3rd gen, Lite, 4K and 4K Max, Fire TV Cube 2nd and 3rd gen, and Fire TV smart TVs running Fire OS 7 or 8. Devices with Vega OS are not Android and cannot run the app. Fire tablets are not supported. *(Which models run which Fire OS version could not be checked offline; look under Settings → My Fire TV → About on your device.)*
- **A FriendFlix server reachable over HTTPS** with a certificate from a public CA (for example Let's Encrypt). Plain `http://` addresses are refused.
- **Server and app on the same version.** When one of them is too old, the app says which one to update.

## Install

**From the Amazon Appstore.** Once the owner has published the app ([Owner steps](#owner-steps-amazon-appstore)), search for **FriendFlix** on the Fire TV and choose **Get**. Updates come through the Appstore.

**From the GitHub release.** Every release (`vX.Y.Z`) has a signed `friendflix-firetv-<version>.apk` next to its notes, with a `friendflix-firetv-<version>.sha256` file to check it. Either way below needs the setting that lets your Fire TV install apps from outside the Appstore.

*Allow unknown sources.* On the Fire TV open **Settings → My Fire TV → Developer options**. If you do not see Developer options, open **About**, select the device name quickly seven times, and go back. Switch **Apps from Unknown Sources** on (newer Fire OS versions ask per app instead: allow it for the app you use in the next step). *(The menu names change between Fire OS versions; this could not be checked offline.)*

*Option A: Downloader app (no computer needed).*

1. Install the free **Downloader** app from the Appstore.
2. Allow Downloader to install unknown apps when Fire OS asks (**Settings → My Fire TV → Install unknown apps**, or the question on first install).
3. In Downloader, type the address of the APK on the GitHub release page of this project, or use a short link of your own that points to it, and download it.
4. Choose **Install**, then **Open**.

*Option B: ADB from a computer.* The computer and the Fire TV must be on the same network, and **ADB debugging** must be on in the Developer options.

1. Find the Fire TV's address under **Settings → My Fire TV → About → Network** (for example `192.0.2.20`).
2. Download the APK on the computer. To check it, compare its SHA-256 with the `.sha256` file (`sha256sum -c friendflix-firetv-<version>.sha256` on Linux and macOS, `Get-FileHash` in PowerShell).
3. In a terminal:

```sh
adb connect 192.0.2.20
adb install friendflix-firetv-<version>.apk
```

The Fire TV asks once to allow the connection from this computer; confirm it with the remote. To remove an old install first, run `adb uninstall com.friendflix.firetv`.

After installing, FriendFlix is in your apps list. Switch ADB debugging off again if you do not need it.

## First start

1. Open **FriendFlix**. The first time, it shows a **Server address** field.
2. Press **Select** (the centre button) on the field to type with the remote, for example `friend.example.com`, and confirm with the keyboard's check mark. Up and Down move between the field and **Connect**.
3. Choose **Connect**. The app shows *Opening friend.example.com* while it checks the server. A good check is saved; next time the app goes straight in.
4. A new TV shows a **pairing code** and a **QR code**. On your phone (signed in) open **Menu → Remote**, enter the code and tap **Pair**, or scan the QR code, as described in [tv-mode.md](tv-mode.md). Once paired, the TV opens your home screen.

The start screen is translated into the app's seven languages (the texts below are the English ones). If the check fails, the card says why and offers **Retry** and **Change server**:

| Message | What it means and what to do |
|---|---|
| Enter the address of your FriendFlix server. | The field is empty. |
| Plain http:// addresses are not allowed. | Use an `https://` address. |
| That does not look like a server address. | Try something like `friend.example.com`. |
| Cannot reach that server. | Check the address, the network and that the server is running. |
| That address answered, but it is not a FriendFlix server. | Wrong address, or a proxy in front of something else. |
| The secure connection failed. The server's certificate is not trusted. | The server needs a certificate from a public CA. |
| This app is too old for the server. | Update FriendFlix on the Fire TV. |
| The server is too old for this app. | Update FriendFlix on the server. |

Back on the address screen leaves the app.

## The remote

Arrow keys and Select move and open, like in any browser. These keys are handled by the app:

| Fire TV remote key | What it does |
|---|---|
| Back | One step back. On the TV pages (Home, Series, Films, My List, Search) the side menu opens first. On the home screen with the menu open, Back leaves the app. In a text field, Back only leaves the field. |
| Play/Pause | Pause or resume. |
| Play · Pause | Play · pause (remotes with separate keys). |
| Fast-forward | 30 seconds forward. |
| Rewind | 30 seconds back. |
| Next (where the remote has it) | Next episode, where there is one. |

Holding Fast-forward skips once, not minutes. Left at the edge opens the side menu, Right closes it. The full TV-mode controls (player bar, scene preview, panels) are in [tv-mode.md](tv-mode.md). Your **phone as the remote** works as on every TV: Menu → Remote on the phone.

*(Whether every Fire TV remote model sends the media keys to the app could not be checked offline; the checklist below covers it.)*

## What plays directly

The app asks the Fire TV's web engine which video and audio formats and containers it can play, and tells the server. The server then sends what the TV handles as it is and converts the rest (HLS). 4K is offered only when the connected display is a 4K display; otherwise the limit is 1080p. Audio the TV cannot decode (some surround formats) is converted to a format it can. While a title plays, the screen saver stays away.

## The first-run check line

The first time the app opens a server (and again after you change to another server, or to the same one again), it runs a short check on the TV. It confirms the formats, plays one title from your library three ways (direct, converted, and through the TV's own HLS; muted, at most 15 seconds each), and then shows **one line**. If the TV is not paired yet, a small strip shows on the pairing page and the full check runs after pairing.

**Please send the whole line to the project owner** (read it out or take a photo). **Back** closes the screen. The check never saves progress for the title it plays.

```
FFPROBE v1 tv=firetv os=<android>/<model> direct=ok:1840ms hls=ok nativehls=ok palm=no home=skipped keys=skipped video=h264,hevc+10,av1 audio=aac,ac3,eac3,mp3,opus containers=mp4,ts,webm screen=1920x1080
```

| Field | Meaning |
|---|---|
| `tv=firetv`, `os=` | The platform, the Android version and the device model. |
| `direct` | `ok:<ms>ms` when a direct play started its first picture after that many milliseconds. `error:nodirect` means the server offered no direct stream for the test title (try another title). Other `error:` values name the reason. |
| `hls`, `nativehls` | Whether the converted stream plays through the app's player script or through the TV's own HLS. |
| `palm`, `home`, `keys` | Always `no`, `skipped`, `skipped` on Fire TV (they belong to the LG test). |
| `video`, `audio`, `containers` | The formats the Fire TV confirms. |
| `screen` | The size the page sees. It should read **`1920x1080`**; anything else means the layout is not scaled as designed, and the line is the thing to send back. |

## Change server

In TV mode open the side menu, choose **Account**, then **Change server**. The app shows the address form with the current server filled in. Enter the new address and choose **Connect**. The TV pairs again with the new server. If a server cannot be reached at all, the failure card has a **Change server** button too.

## Updates

- **Appstore install:** the Fire TV updates it by itself (or via the Appstore's *My Apps*).
- **APK install:** download the next `friendflix-firetv-<version>.apk` and install it over the old one (same steps as above). The app does not update itself.
- **Do not mix the two.** Amazon re-signs apps it delivers, so the Appstore version and the GitHub APK carry different signatures and cannot update each other. To switch, uninstall the app first (**Settings → Applications → Manage Installed Applications → FriendFlix → Uninstall**); the TV then pairs again.

## Owner steps: Amazon Appstore

This is a one-time setup, then a short routine per release. The app is never uploaded automatically. *The console's screens and wording change; steps that depend on them are marked "(check in the console)" because they could not be verified offline.*

1. **Create a developer account.** Sign up (free) at the Amazon Developer Console with an Amazon account and fill in the developer profile. *(Check in the console: Amazon may ask for a phone number, tax or payment details even for free apps.)*
2. **Add a new app.** In the console choose **Apps & Services → My Apps → Add New App → Android**. Enter the title **FriendFlix**, pick the category that fits best (for example Entertainment), and choose that the app is free and does not use Amazon's in-app purchasing or Amazon-specific APIs. *(Check in the console.)*
3. **Upload the APK.** Download `friendflix-firetv-<version>.apk` from the GitHub release and upload it under **Upload your app file**. Amazon re-signs the app with its own key; that is expected (see [Updates](#updates)). The version code comes from `version.json` and always grows, which Amazon requires for every new upload.
4. **Choose the devices.** Keep only **Fire TV** enabled; switch Fire tablets and phones off. FriendFlix does not support them.
5. **Content rating.** Fill in the content rating questionnaire. FriendFlix has no content of its own: it shows what the owner's private server holds, so answer for an app that plays user-provided video, with no in-app purchases, ads or user-to-user messages. *(Check in the console: the questions and the resulting rating are Amazon's.)*
6. **Listing texts.** Add the title and the short and long descriptions in English and German. Describe what the app does (opens your own FriendFlix server in TV mode, pairing with a code, phone as remote) and do not name any other service. Example short text: *"Your own FriendFlix server on the big screen."*
7. **Images.** Upload from `android/firetv/store-listing/`:
   - `icon-512.png` (large icon) and `icon-114.png` (small icon),
   - `banner-1280x720.png` (the TV banner),
   - `tv-1.png`, `tv-2.png`, `tv-3.png` (TV screenshots, 1920×1080).
8. **Privacy policy.** Link [privacy.md](privacy.md) as published on GitHub (the URL of the file on the project's GitHub page).
9. **Testing instructions for Amazon's reviewers.** FriendFlix needs a server, so give the reviewers one: *a test server address (for example `https://friend.example.com`), a test account, and how to pair the TV*: start the app, enter the address, then on a computer or phone open the server in a browser, sign in with the test account, open `/remote` (Menu → Remote) and enter the code the TV shows. Use a demo server with freely licensed films and a throw-away account, **never your real personal server or your own account**. Say clearly that the app is a client for a private server and has nothing to show without one.
10. **Publish.** For a friends-only release choose **Live App Testing** (Amazon's testing channel: you invite people by email and they get the app from the Appstore before any public listing). To go public, submit for review and release. Review can take days. *(Check in the console: the names of these options.)*
11. **Each release:** open the app in the console, **Add new version** (or the equivalent), upload the new APK, update the release notes, and submit. The Appstore then updates the installed TVs.

## Manual device checklist

Run this on a Fire TV Stick 4K or Lite and on a Fire TV Cube before telling friends:

1. Install the APK (and, later, the Appstore build). The app appears in the apps list with its banner.
2. First start: enter the address, see *Opening …*, land on the pairing screen.
3. Pair with the QR code and with the typed code.
4. Remote keys: arrows, Select, Back (side menu first, a second Back on Home leaves the app), Play/Pause, Fast-forward and Rewind in the player.
5. Play a title that plays directly and one that is converted. Seek, switch audio and subtitles.
6. Read the first-run check line; `screen=` should be `1920x1080`.
7. **Account → Change server**, back to the same server.
8. Leave a title paused and playing for a long time: the screen saver must not start while it plays.
9. Press Home while a title plays: the sound stops.

## Troubleshooting

- **"Cannot reach that server".** Check the address and that the Fire TV has internet. Open the same address in a browser on your phone.
- **Certificate message.** The server needs a certificate from a public CA. A self-signed certificate does not work in the app.
- **"App too old" / "Server too old".** Update the one the message names.
- **Black screen after the start page.** Run the app again so the first-run check line shows (Change server to the same address runs it again), and send the line to the project owner. A converted stream often still plays when direct play does not.
- **The screen saver starts during a title.** Update the app; it keeps the screen awake while a title plays. If it still happens, send the first-run check line and your Fire OS version.
- **Back does nothing.** Update the app; older builds may not have the Back handling.
- **The Appstore does not offer the app / the APK will not install over it.** See [Updates](#updates): uninstall one before installing the other.

## Building it yourself

The Fire TV module lives next to the phone app in `android/` and builds with the same commands (JDK 21, Android SDK; see [android.md](android.md#building-it-yourself)):

```sh
cd android
./gradlew :firetv:lint :firetv:testDebugUnitTest :firetv:assembleDebug   # debug APK in firetv/build/outputs/apk/debug/
./gradlew :firetv:assembleRelease                                       # firetv/build/outputs/apk/release/firetv-release-unsigned.apk
bash firetv/check-apk.sh firetv/build/outputs/apk/release/firetv-release-unsigned.apk
```

The release build is signed only when the three signing environment variables of the phone app are set (`ANDROID_UPLOAD_KEYSTORE_FILE`, `ANDROID_UPLOAD_KEY_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS`); the file is then `firetv-release.apk`. `check-apk.sh` checks the package name, the leanback launcher, the banner, that the only permission is INTERNET, and that no Google Play services are inside; it prints nothing when everything is fine. The store images are rendered from the templates in `android/firetv/store-listing/src/` (`render.sh`). The version comes from `version.json` at the top of the repository. minSdk is 28 (Fire OS 7).
