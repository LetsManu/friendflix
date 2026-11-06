# FriendFlix for Windows

**English** · [Deutsch](de/windows.md)

The Windows app is FriendFlix as a program on your PC: the same web UI you know from the browser, inside a locked-down window, with one part done natively: the **player**. Pressing Play opens a fullscreen player (mpv) that plays almost every file directly, including AC3, DTS and TrueHD sound, HEVC video and image subtitles, so the server converts much less. It has FriendFlix's own controls, resumes where you stopped, and reports your progress, so *Continue watching* stays in sync with the web, Android and TV.

Everything else (browsing, profiles, requests, settings of your account) is the web UI, so it always matches your server's version. Not in the app: downloads and offline playback, Chromecast, watch parties (`/party` stays in the web player), and the Android player's extras (cast & info panel, bookmarks, subtitle search, audio effects, speed, sleep timer, post-play screen). Use the browser for those.

**Requirements:** Windows 10 (22H2) or Windows 11, 64-bit, with the Microsoft Edge WebView2 runtime (part of Windows 11 and of current Windows 10 updates; the installer fetches it when it is missing). The player needs `vulkan-1.dll`, which the graphics driver installs. You also need a FriendFlix server reachable over HTTPS with a certificate from a public CA (for example Let's Encrypt), on the release that accepts the Windows app (the one that first ships it, see the [changelog](../CHANGELOG.md), or newer). The app version follows the server version.

## Contents

- [Install](#install)
- [First start](#first-start)
- [App settings](#app-settings)
- [Player](#player)
- [Tray, links and single instance](#tray-links-and-single-instance)
- [Updates](#updates)
- [Troubleshooting](#troubleshooting)
- [Owner steps: update signing](#owner-steps-update-signing)
- [Manual checklist](#manual-checklist)
- [Building it yourself](#building-it-yourself)

## Install

Every release (`vX.Y.Z`) has these files next to its notes:

- `FriendFlix_X.Y.Z_x64-setup.exe`: the installer for one user, no administrator rights needed. Use this one.
- `FriendFlix_X.Y.Z_x64_en-US.msi`: the same app as an MSI, for managed PCs.
- `SHA256SUMS-windows.txt`: the SHA-256 sums of the files, to check a download (`Get-FileHash .\FriendFlix_X.Y.Z_x64-setup.exe` in PowerShell).
- `.sig` files and `latest.json`: only for the app's own updates, nothing to download by hand.

**SmartScreen.** The installer is not signed with a paid code-signing certificate, so Windows shows *Windows protected your PC*. Click **More info**, then **Run anyway**. Check the SHA-256 sum first if you want to be sure the file is the one from the release.

FriendFlix is then in the Start menu. To uninstall use *Settings → Apps → Installed apps → FriendFlix*. Your remembered settings (`%APPDATA%\FriendFlix`) and the logs (`%LOCALAPPDATA%\FriendFlix`) may stay behind; delete those folders yourself for a clean slate.

## First start

1. Enter the address of your FriendFlix server, for example `friend.example.com` (`https://` is added for you). Plain `http://` addresses work too, for a server in your home network as in the Android app, but `https` is strongly recommended: over `http` the session cookie travels unencrypted through the network.
2. The app checks that the address answers like a compatible FriendFlix server (`GET /api/version`). If not, it says why.
3. Sign in exactly as in the browser, inside the app: the in-app sign-in, or your server's sign-in page at its identity provider (for example Authentik at `auth.example.com`), with a passkey where your provider offers one. If your server approves new devices, the PC shows up as a new device for the admin to approve.

The app opens only your server's address and, for signing in, your server's sign-in page (the `authOrigin` the server names in `GET /api/version`). The sign-in page never gets the app's native functions. Every other link (trailers, IMDb, help pages) opens in your normal browser.

## App settings

Open them from the tray icon (**Settings**) or from the web UI's settings. They are saved in `%APPDATA%\FriendFlix\settings.json`, together with the window size, position and maximised state.

| Setting | What it does |
|---|---|
| Server | Shows the server address. **New server address → Check and use** changes it after the same check as on the first start. |
| Updates | *Install updates automatically on the next start* (default) or *Ask me first*. See [Updates](#updates). |
| Use hardware decoding | On by default (`hwdec=auto-safe`). Turn it off if videos show artefacts or a green picture. Applies the next time the player starts. |
| Start the player in fullscreen | On by default. |
| Start FriendFlix with Windows | Off by default. |

Everything else, such as playback languages, subtitle appearance, autoplay and quality limits, is set in the web UI as usual; the player uses those settings.

## Player

Press Play anywhere in the web app. The player opens in its own window, fullscreen by default, and plays the original file when it can (**Original**). When the original does not start within 10 seconds or fails, it switches once to the server's converted stream at the same position, and the chip says **Converted** with the reason. The player resumes at your position on the server, or at the time of a `?t=` link.

**Controls** (they hide after 3 seconds without mouse movement while playing, and stay shown while paused):

- **Top bar:** back, the title (`S1:E3 · Name` for episodes), and the quality chip (*Original* or *Converted · 1080p*; hover for the reason).
- **Bottom bar:** play/pause, back and forward 10 seconds, the seek bar with chapter marks and a preview picture while you drag (when the server offers previews), elapsed and remaining time, next episode, chapters, audio and subtitles, quality, volume, fullscreen.
- **Audio and subtitles:** the server's tracks and external subtitles. Your pick is saved per series, like in the web player. With *Anime: original audio with subtitles* on in your profile, an anime series starts in Japanese with subtitles in your language, unless you chose something else.
- **Quality** (converted stream): Original (when your role allows it), 1080p, 720p, 480p. A change reloads the stream at the same position.
- **Chapters:** a list that jumps on click.
- **Skip intro / Skip recap:** a button during those segments, when the server has them and the type is enabled.
- **Next episode:** from the credits (else 25 seconds before the end) a card shows the next episode with a 10-second countdown when autoplay is on. After three episodes in a row without interaction, *Still watching?* appears and autoplay waits for your *Yes*.
- **Subtitle appearance** from your web settings (size, colour, background, font) applies to text subtitles. ASS subtitles keep their own style.

**Keys**

| Key | Action |
|---|---|
| Space or K | Play / pause |
| ← / → | 10 seconds back / forward |
| ↑ / ↓ | Volume +5 / −5 |
| M | Mute |
| F or double-click | Fullscreen |
| Esc | Close a menu; else leave fullscreen; else back to the app |
| N | Next episode |
| C | Subtitles on / off |

The media keys of your keyboard and the Windows media overlay (volume flyout, lock screen) control playback; the overlay shows the title, without a poster.

Progress is reported to the server (start, every 10 seconds, pause, resume, seek, stop), so the web and the other apps show the same position. A stall of more than 15 seconds shows *Reconnecting…* and reloads up to three times. If the session ends (sign-in expired), the player closes and the app shows the sign-in page.

## Tray, links and single instance

- **Tray icon:** *Open FriendFlix*, the server address (read-only), *Settings*, *Quit*. Closing the window quits the app.
- **Single instance:** starting FriendFlix again just brings the open window to the front.
- **`friendflix://watch/<id>` links** play that title for the profile you used last, or open `/watch/<id>` in the window when no profile is known yet.

## Updates

The app checks GitHub Releases at start and every 24 hours. The update is checked against the public key built into the app; a bad signature is refused and logged. It never installs while the player runs.

- **Automatic** (default): the update is downloaded and installed at the next start of the app.
- **Ask me first:** a banner shows *Install and restart*; nothing is installed before you click.

Updates are **off** in a build that has no update key (see the owner steps): the app then logs that and never checks. A release without a working key can still be installed by hand over the old version.

## Troubleshooting

- **Logs:** `%LOCALAPPDATA%\FriendFlix\logs`, one file per day (`friendflix-YYYY-MM-DD.log`), deleted after 14 days. They contain no passwords, cookies or tokens, and stream addresses without their query part. Nothing is sent anywhere; there is no telemetry. Attach the newest file when you report a problem.
- **The player does not start, or closes at once:** the player needs `vulkan-1.dll` from the graphics driver. Virtual machines and very old drivers often lack it. Update the graphics driver, or use *Play in the web player*, which the app offers when the player exits unexpectedly (it opens `/watch/<id>` in the window).
- **Picture with artefacts or green:** turn off hardware decoding in the settings.
- **"Converted" for a title you expected to play as it is:** hover the chip for the reason: a bitrate or resolution limit of your role, the network, or a format the server converts. AVI, M2TS, PCM audio, VC-1 video and image subtitles from DVD or Blu-ray (PGS, DVD) are not in the list the server accepts from apps, so such titles are converted.
- **Sign-in page does not open or links go to the browser:** the app opens only your server and its sign-in page. If you changed the identity provider's address, restart the app so it reads `authOrigin` again.
- **SmartScreen blocks the installer:** [Install](#install).
- **No updates arrive:** check the log for *updates are off in this build*. If you built or installed a build without an update key, install a release from GitHub once.

## Owner steps: update signing

Only needed if you want the app to update itself. Without it everything else works; each release then has installers without `latest.json`, and users install new versions by hand. The Windows app release job never fails because of a missing key.

**Updates need three things from the same key pair, made by one run:** the public key in the repository, and the private key plus its password as GitHub secrets. A public key from one run with secrets from another run makes every update fail the signature check on the PC.

1. Generate the key pair once, on your PC (it asks for a password; pick a strong one):

   ```sh
   npx @tauri-apps/cli@2.12.3 signer generate -w friendflix-updater.key
   ```

   This writes `friendflix-updater.key` (private) and `friendflix-updater.key.pub` (public). Keep the private key and its password in your password manager as well; do not commit them. Whoever holds them can push updates to every PC with the app. Losing them means PCs cannot be updated any more and have to install a new build by hand, because the public key is built into the app.
2. Put the content of `friendflix-updater.key.pub` (one line, `dW50cnVzdGVkIGNvbW1lbnQ6…`) into `desktop/app/updater.pub`, replacing `REPLACE_WITH_PUBLIC_KEY`, and commit it.
3. Add the two GitHub secrets (*Settings → Secrets and variables → Actions*, or with `gh`):

   ```sh
   gh secret set TAURI_SIGNING_PRIVATE_KEY < friendflix-updater.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
   ```

   `TAURI_SIGNING_PRIVATE_KEY` is the whole content of the private key file; the password secret is the password from step 1 (`gh` asks for the value).
4. Tag a release. The job signs the installers, and attaches `.sig` files and `latest.json`. The job summary says whether updates are on for that build.

What happens in the other cases: with the placeholder still in `updater.pub`, or without the secret, the build stays green, builds installers with updates turned off and leaves a notice in the run. A public key that is not a valid key turns updates off in the app (and logs it) instead of breaking it. The Tauri command line tool is pinned to 2.12.3 in the workflow.

### The mpv pin

The player is a pinned Windows build of mpv (a shinchiro build from SourceForge, mpv 0.41 git, LuaJIT), downloaded in CI and checked against its SHA-256 in `desktop/player/mpv.lock`; the release fails when the pin is incomplete. Its GPL licence texts are installed with it. To move to a newer build:

1. Pick a current `mpv-x86_64-<date>-git-<sha>.7z` (the baseline build, not `-v3`) from <https://sourceforge.net/projects/mpv-player-windows/files/64bit/>.
2. In `desktop/player/mpv.lock`, set `url` (the `downloads.sourceforge.net` form of the file) and `sha256` (`sha256sum` of the downloaded file), and update the comment lines above them (mpv version, Lua).
3. Run the Windows release job (*Actions → Windows app release → Run workflow* on a tag, or a test tag) and play a title. The control skin must stay Lua 5.1 / LuaJIT compatible; the `desktop-core` CI job checks that.

## Manual checklist

Unit tests and CI cover the logic and that the app builds; these points need a real Windows PC (Windows 10 22H2 or 11, a normal graphics driver). Use a test server with an Authentik sign-in, a second device (phone or browser) for the sync checks, and a few files: one with AC3 or DTS sound, one HEVC, one MKV with embedded and external subtitles, an anime series, and a series with intros and chapters.

**Install**
1. Download the installer from the release. SmartScreen shows *Windows protected your PC*; *More info → Run anyway* installs. The SHA-256 matches `SHA256SUMS-windows.txt`. FriendFlix is in the Start menu and starts.
2. Uninstall via *Installed apps* and install again: it works, `friendflix://` still opens the app.

**First start and sign-in**
3. Setup accepts `friend.example.com`, refuses `http://`, a wrong host and a server with a self-signed certificate with the right message.
4. Sign in with the in-app sign-in and with Authentik; sign in with a passkey. External links open in the default browser. The settings page and the tray's server entry show the address.

**Play and sync**
5. Press Play on the home page, a detail page and an episode list: the player opens fullscreen. A double click on Play does not open two players.
6. Resume across devices: stop at minute 10 on the PC; the phone or browser shows the same position and *Continue watching*. Stop on the phone, play on the PC: it continues there.
7. An AC3 or DTS file and an HEVC file play as *Original* (the admin's now-playing says direct).
8. The HLS fallback: set a bitrate cap on the role (or pick 720p in the quality menu): the chip shows *Converted · 720p*, the position stays. A file the original of which does not start falls back to the converted stream by itself after about 10 seconds.
9. Close the player with Esc (not fullscreen), with the back button and with the window's close button: the web app is back each time, the position is saved, a stop is reported.

**Tracks, subtitles and anime**
10. Audio and subtitle menus list the server's tracks, also external subtitles; the pick is remembered for the series and applies the next episode.
11. Subtitle style: change size, colour, background and font in the web settings; the next title shows it. An ASS subtitle keeps its own style. An image subtitle (PGS) is shown.
12. Anime: with *Anime: original audio with subtitles* on, an anime series starts in Japanese with subtitles; a saved choice wins.

**Skip, next and still watching**
13. Skip intro and Skip recap show during the segment and jump to its end.
14. Next episode: the card with the countdown appears at the credits (else 25 seconds before the end), N plays it at once, autoplay starts it in the same window with a new session. After three episodes in a row, *Still watching?* waits for *Yes*.

**Chapters, trickplay, keys**
15. The chapter list jumps on click; chapter marks show on the seek bar. Dragging the seek bar shows the preview picture; a server without previews shows none and seeking works.
16. All keys of the table in [Player](#player) do what is listed; the controls hide after 3 seconds and stay shown while paused.
17. Keyboard media keys (play/pause, next) and the Windows media overlay control the player and show the title.

**Errors**
18. Cut the network for 20 seconds while playing: *Reconnecting…* shows and playback resumes at its position afterwards.
19. End the session on the server (sign out on another device): the player closes and the app shows the sign-in page.
20. Kill `mpv.exe` in Task Manager: a message appears and *Play in the web player* opens the title in the window.
21. A user at the stream limit sees the server's limit text; a kids profile refused by the server shows the generic error.

**Shell, tray and links**
22. Tray: *Open FriendFlix*, the server address (greyed), *Settings*, *Quit*. Closing the window quits the app. Window size, position and maximised state are back after a restart.
23. Start FriendFlix a second time: the open window comes to the front. `friendflix://watch/<id>` (from *Win+R* or a link) plays that title for the last profile; with no profile known it opens the watch page in the window.
24. Settings: change the server address (a typo stays on the page); hardware decoding off then a title plays; fullscreen off then the player opens windowed; start with Windows on then it starts after signing in to Windows (and off removes it).

**Updates** (needs the owner steps and two released versions)
25. With *Install updates automatically*: install version N, publish N+1; after starting the app, the update installs at the next start. With *Ask me first*: the banner shows *Install and restart*, nothing installs before the click. While the player runs the update waits.
26. A build with a wrong public key or without one logs *updates are off* and the app works.

**Logs and privacy**
27. `%LOCALAPPDATA%\FriendFlix\logs` has the day's log; it contains no cookie, token or full stream URL.

## Building it yourself

The app lives in `desktop/`: `core/` (plain Rust, all logic, tested on any OS), `app/` (the Tauri v2 app, Windows) and `player/` (the mpv control skin in Lua). The Rust version is pinned in `desktop/rust-toolchain.toml`.

```sh
cd desktop
cargo fmt --check && cargo clippy --locked -p friendflix-core -- -D warnings
cargo test --locked -p friendflix-core            # logic, runs on Linux and macOS too
lua5.4 player/test/layout_test.lua                # the skin's tests
```

The app itself builds on Windows only. With Rust, Node and PowerShell on a Windows PC:

```powershell
./desktop/scripts/fetch-mpv.ps1 -Dest desktop/app/mpv      # downloads the pinned mpv, checks the SHA-256 from mpv.lock
cd desktop/app
npx --yes @tauri-apps/cli@2.12.3 build -- --locked        # installers in desktop/target/release/bundle/
```

Without a real key in `desktop/app/updater.pub` the build turns the self-update off. The version comes from `version.json` at the top of the repository. The release workflow is `.github/workflows/desktop-release.yml`; it runs from `ci.yml` on a `vX.Y.Z` tag.
