# FriendFlix for LG TVs

**English** · [Deutsch](de/webos.md)

The LG TV app is FriendFlix as an app on an LG smart TV with webOS (webOS 22 or newer, that is 2022 models and later; tested on webOS 25): a thin shell that asks for your server's address once and then opens the [TV mode](tv-mode.md) of your server, full screen. Everything you see is the web UI, so it always matches your server's version. Unlike the plain TV browser, the app has its own icon, remembers the server, and tells the server what the TV can play, so the server sends the original file wherever the TV can play it itself (direct play).

**How it works, in short.** The TV runs the app in LG's Developer Mode, so no LG certificate or store account is needed. Someone runs the install script on a PC in the same network as the TV. The app does **not** update itself: after a new release, run the install script again. The LG Content Store is a later phase ([webos-store.md](webos-store.md)).

**Requirements:** an LG TV with webOS 22 or newer; a Windows, macOS or Linux PC in the same network as the TV, with Node.js 20 or newer ([nodejs.org](https://nodejs.org/)); a free LG developer account; a FriendFlix server reachable over HTTPS with a certificate from a public CA, on the release that ships the LG TV app (see the [changelog](../CHANGELOG.md)) or newer; the TV paired for TV mode ([tv-mode.md](tv-mode.md)).

## Contents

- [Overview of the steps](#overview-of-the-steps)
- [TV: Developer Mode](#tv-developer-mode)
- [Install on the TV](#install-on-the-tv)
- [The passphrase and where it is stored](#the-passphrase-and-where-it-is-stored)
- [First start: the server address](#first-start-the-server-address)
- [The 50-hour session](#the-50-hour-session)
- [The remote](#the-remote)
- [What direct play covers](#what-direct-play-covers)
- [Change server](#change-server)
- [The probe and how to read its line](#the-probe-and-how-to-read-its-line)
- [Known open points / first-run checks](#known-open-points--first-run-checks)
- [Updates](#updates)
- [Troubleshooting](#troubleshooting)

## Overview of the steps

1. **Owner, per release:** the release workflow builds `FriendFlix-<version>.ipk` and `FriendFlix-probe-<version>.ipk` and attaches them with `SHA256SUMS-webos.txt` to the GitHub Release. They are unsigned developer-mode packages; no secrets are needed.
2. **Per TV:** Developer Mode on, then run the install script from a PC.
3. **Probe first (optional):** install the test app, read its line, send it to the owner of this project ([the probe](#the-probe-and-how-to-read-its-line)).
4. **Pair the TV** for TV mode ([tv-mode.md](tv-mode.md)).

## TV: Developer Mode

An LG TV installs your own apps only through the Developer Mode app.

1. On the TV open the **LG Content Store** and install the app **Developer Mode**.
2. Open it and sign in with an **LG developer account** (free; create one on [LG's webOS TV developer site](https://webostv.developer.lge.com/) if you have none).
3. Set **Dev Mode Status** to **On**. The TV restarts.
4. Open the Developer Mode app again and turn **Key Server** on.
5. Note the **passphrase** the app shows, and the TV's IP address (*Settings → Network → your connection*), for example `192.0.2.10`. You give both to the install script.

The passphrase changes whenever the key server is switched off and on again: always use the one the app shows now.

## Install on the TV

Run the script from a clone of the repository (the scripts are in its `webos` folder), on a PC in the TV's network. Both need Node.js 20 or newer.

**Linux or macOS:**

```sh
./webos/install.sh 192.0.2.10 --probe          # the test app first
./webos/install.sh 192.0.2.10                  # FriendFlix
./webos/install.sh 192.0.2.10 --version v2.4.0 # a specific release
./webos/install.sh 192.0.2.10 --ipk ./FriendFlix-2.4.0.ipk  # a local file
```

**Windows (PowerShell):**

```powershell
powershell -ExecutionPolicy Bypass -File .\webos\install.ps1 192.0.2.10 -Probe
powershell -ExecutionPolicy Bypass -File .\webos\install.ps1 192.0.2.10
powershell -ExecutionPolicy Bypass -File .\webos\install.ps1 192.0.2.10 -Version v2.4.0
powershell -ExecutionPolicy Bypass -File .\webos\install.ps1 192.0.2.10 -Ipk .\FriendFlix-2.4.0.ipk
```

`-ExecutionPolicy Bypass` only applies to this one call; without it Windows may refuse to run the script.

The full forms are `webos/install.sh <tv-ip> [passphrase] [--probe] [--ipk <file>] [--version vX.Y.Z]` and `webos/install.ps1 <TvIp> [-Probe] [-Ipk <file>] [-Version vX.Y.Z]`.

| Argument | Meaning |
|---|---|
| `<tv-ip>` / `<TvIp>` | The TV's IPv4 address. Required. |
| `[passphrase]` (install.sh only) | The Developer Mode passphrase. **Leave it out**: the script then asks for it, hidden. On the command line it would stay in your shell history. `install.ps1` takes no passphrase: LG's tool asks for it itself at `input passphrase:` (the typed characters are visible there). |
| `--probe` / `-Probe` | Install **FriendFlix Test** (the test app) instead of FriendFlix. |
| `--ipk <file>` / `-Ipk <file>` | Install this `.ipk` instead of downloading a release. |
| `--version vX.Y.Z` / `-Version vX.Y.Z` | A specific release. Without it, the latest. |

What the script does:

1. Checks for Node.js 20+.
2. Installs the pinned LG command-line tools (`@webos-tools/cli` 3.2.6, the "ares" tools) once into a cache folder of your user account (Linux and macOS: `~/.cache/friendflix-webos`, or under `$XDG_CACHE_HOME`; Windows: `%LOCALAPPDATA%\friendflix-webos`). Nothing is installed system-wide.
3. Downloads the `.ipk` and `SHA256SUMS-webos.txt` from the GitHub Release (the latest by default), checks the SHA-256 and refuses to install on a mismatch.
4. Registers the TV as `friendflix-tv` (port 9922), fetches its key with your passphrase, installs the app and starts it.

Exit codes: `0` installed; `1` it failed (the script prints hints); `2` the arguments are wrong (usage is shown). Running it again replaces the installed app. The app and the test app are different apps and can stay installed side by side. Afterwards open the app from the TV's app list.

## The passphrase and where it is stored

The FriendFlix scripts never write your passphrase anywhere: it is not printed, not logged and not saved by them. `install.sh` hands it to LG's tool on standard input only, never on a command line; with `install.ps1` you type it straight into LG's tool, so the script never sees it.

LG's own tool is different. `ares-novacom`, which fetches the TV's SSH key, **stores the passphrase in its device file** `novacom-devices.json` in your user's ares config folder, because it needs the passphrase to unlock the TV's key on every later call (install, launch). So after an install, the passphrase sits in that file on the PC. It is only useful while Developer Mode is on and the key server is running, and it changes when you switch the key server off and on, but treat the file like a password: do not share your home folder, and remove the entry when you no longer need it.

The file is `novacom-devices.json` inside the `.webos` folder of your user account: `~/.webos/` on Linux and macOS, `%APPDATA%\.webos\` on Windows (there may be a profile subfolder inside). The safe way to remove the entry is LG's own tool, so run it from the cache's `node_modules/.bin` folder:

```sh
~/.cache/friendflix-webos/node_modules/.bin/ares-setup-device --remove friendflix-tv
```

```powershell
& "$env:LOCALAPPDATA\friendflix-webos\node_modules\.bin\ares-setup-device.cmd" --remove friendflix-tv
```

(Use `$XDG_CACHE_HOME/friendflix-webos` if you have set it.) The next install registers the TV again by itself.

## First start: the server address

On the first start the app asks for your server's address, for example `friend.example.com`.

- Enter it with the TV's keyboard or the Magic Remote; the arrow keys move between the field and **Connect**.
- Only `https://` works; `https://` is added for you. A plain `http://` address is refused (the TV carries a sign-in cookie).
- The app checks that the address answers like a FriendFlix server (`GET /api/version`). If not, it says why.
- The address is remembered. At the next start the app shows its logo with *Press OK to change server* for 3 seconds, then opens your server's TV mode (see [Change server](#change-server)). If the TV is not paired yet, it shows the pairing code as usual: pair it as described in [tv-mode.md](tv-mode.md). **Back** on the pairing screen returns to the address form, filled in; Back there exits the app.
- If the server cannot be reached at start, an error card offers **Retry** and **Change server**.

## The 50-hour session

Developer Mode runs out after **50 hours**. Before that, open the **Developer Mode** app and press **Extend**. If you miss it, the TV removes the app: run the install script again. Switching Developer Mode off removes it too.

## The remote

In the player (the keys are ignored elsewhere). Every function works with **OK, the arrows and Back** alone, because the 2025 Magic Remote has no play, pause, fast-forward or colour keys; its **123** button opens an on-screen panel with the colour keys.

| Key | Code | Action |
|---|---|---|
| OK | 13 | play or pause while the control bar is hidden; on the bar it presses the selected button |
| ◀ / ▶ | 37 / 39 | -10 s / +10 s; holding the key goes faster (30 s steps after 1 s, 60 s after 3 s) |
| ▲ / ▼ | 38 / 40 | ▲: cast and info for the scene; ▼: the control bar (focus on play/pause) |
| Wheel | `wheel` | over the picture: one notch = +10 s (down) / -10 s (up); menus keep scrolling |
| Channel ▲ | 33 | next episode (series) |
| Play | 415 | play |
| Pause | 19 | pause |
| Play/Pause | 10252 | play or pause |
| Stop | 413 | leaves the player (progress is saved, as with Back) |
| Fast forward / Rewind | 417 / 412 | +30 s / -30 s |
| Red | 403 | subtitles on or off (the last track used, else the first) |
| Green | 404 | open the audio menu |

**Back** (461) works everywhere: it goes one level back; in the player it first hides the control bar, then leaves. **Back on the TV-mode home screen exits the app.** The control bar stays shown while you move along it and hides 5 seconds after the last key; when it hides it lets go of the selected button, so the next OK always means play/pause. The **Magic Remote** pointer works too: moving it shows the controls, hovering moves the focus ring, a click on a button presses it and a click on the picture plays or pauses. The arrow keys continue from where the pointer was. The general keys are in [tv-mode.md](tv-mode.md#bedienung-am-fernseher).

## What direct play covers

The app tells the server what the TV can play, and the server then sends the original file instead of converting it. The app sends **only formats the TV confirms** about itself (`canPlayType` / `MediaSource`); a format the TV does not confirm is simply not offered, and the server converts it. Candidates:

- containers: MKV, MP4, M4V, MOV, TS, WebM. MKV is always offered once the TV confirms any other format: LG's player plays MKV from a URL, but the browser engine answers "no" when asked (probe on webOS 25). An MKV that still shows no picture switches to the converted stream after 10 s;
- video: H.264, HEVC, AV1, VP9, MPEG-2 (up to 2160p), with the profiles the TV confirms (such as 10-bit);
- audio: AAC, AC3, E-AC3, MP3, FLAC, Opus, Vorbis;
- subtitles: SRT, ASS, SSA, VTT (drawn by the player, as everywhere).

**DTS and TrueHD are always converted**; the TV's player is not asked about them. Changing the audio track on a direct-play title goes through the converted stream.

If no picture appears within **10 seconds** on direct play, the player switches once to the converted stream at the same position. A decode error does the same. If the TV confirms nothing at all, the app sends no list and the server treats the TV like a plain browser. The player's quality chip reads *Original* for direct play.

## Change server

Two ways lead to the address form, filled in with the current address:

- **Account menu → Change server.** On webOS 25 the way back through the browser history does not reach the app's start page (the probe on an LG 43QNED82A6B reported `home=fail`), so the entry tells you to restart the app and press OK while the logo shows.
- **OK at start.** Every start with a stored address shows the logo with *Press OK to change server* for 3 seconds before the app opens your server. Press **OK** (13), **▲** (38) or the **blue** key (406) during that time to get the form instead.

## The probe and how to read its line

The test app finds out what your TV can really do and which route the player should use. Please run it on the TV you want to use.

1. [Install the test app](#install-on-the-tv) (`--probe` / `-Probe`) and open **FriendFlix Test** from the TV's app list. The first start shows the same server-address form.
2. **Pair the TV for TV mode first**, if it is not yet ([tv-mode.md](tv-mode.md)). The play check plays a title from your library with the TV's own session. While the TV is unpaired, `keys` and `home` show `skipped`.
3. The screen runs its checks, then asks you to press the play/pause key and the red key.
4. The screen shows **one line**. **Send the whole line to the project owner** (read it out or take a photo). **Back** closes the screen. The test app never saves progress for the title it plays.

The line looks like this:

```
FFPROBE v1 tv=webos os=25 direct=ok:1840ms hls=ok nativehls=ok palm=yes home=ok keys=ok video=h264,hevc+10,av1,vp9 audio=aac,ac3,eac3,mp3,flac,opus containers=mkv,mp4,ts,webm
```

| Field | Values | Meaning and what it decides |
|---|---|---|
| `tv` | `webos` | The platform. |
| `os` | number | The webOS version, for example `25`. |
| `direct` | `ok:<ms>ms` | A real direct play of the test title started (first picture) after that many milliseconds. |
| | `error:nodirect` | The server offered no direct stream for the test title. Not a TV problem: try with another title, or check the library. |
| | `error:unknown` | The check itself crashed before it could report a reason. |
| | `error:<reason>` | Direct play failed for that reason (for example a timeout or a player error). |
| `hls` | `ok`, `error:<code>` | Whether the converted stream plays through hls.js. |
| `nativehls` | `ok`, `error:<code>` | Whether it plays through the TV's own HLS. Together with `hls`, this decides the **HLS route**: hls.js, or the TV's native HLS if hls.js fails. |
| `palm` | `yes`, `no` | Whether the TV's `PalmSystem` is present. Decides the **exit method**: `platformBack()` when present, else `window.close()`. |
| `home` | `ok`, `fail`, `skipped` | Whether history back reaches the local start page. Decides the **Change server route**: with `fail`, the menu entry cannot reach the start page and the blue key at start is the way. `skipped` while the TV is unpaired. |
| `keys` | `ok`, `missing:<names>`, `skipped` | Whether the play/pause and red keys arrived. `missing` lists the ones that did not. `skipped` while unpaired. |
| `video` | codecs | The video codecs the TV confirmed; a `+10` after a codec means 10-bit is confirmed; `-` means nothing was confirmed. Decides the **final format list**. |
| `audio` | codecs | The audio codecs the TV confirmed (`-`: nothing confirmed). Decides the final format list. |
| `containers` | list | The containers the TV confirmed (`-`: nothing confirmed). Decides the final format list. |

Whatever the line says, send it complete: other values still tell which parts need another approach. The test app stays a diagnostic tool on each release.

## Known open points / first-run checks

These could only be checked on a real TV and are still unverified. If something behaves oddly on the first run, look here first:

- **Hidden test video.** The probe relies on a near-invisible 2x2 pixel video decoding on webOS. If it does not, the probe's play check misreports.
- **Native HLS events.** Whether the TV's own HLS player fires the events the player waits for.
- **Change server via history.** The start page detects "reached by going back" through the navigation type `back_forward`. A page restored from the back/forward cache (`pageshow` with `persisted`) counts the same. Whether webOS reports either is unverified; the probe's `home` field and the blue key at start cover it.
- **Undecodable originals.** Whether a file the TV cannot decode can still fire `loadeddata`. If so, the picture stays black and the 10-second fallback to the converted stream would not start.
- **Magic Remote hover after scrolling.** After any key press, hovering moves the focus again only once the pointer really moves (a pointer event with movement), so a scroll made with the arrow keys does not hand the focus to whatever lands under the resting pointer. Whether webOS reports that movement for the Magic Remote is unverified.
- **`install.ps1` on Windows.** It was never run on a real Windows PC; the Linux/macOS script was exercised. If it fails, please report the message.

## Updates

The app does not update itself (a developer-mode app cannot). After a new release, run the install script again; it installs the new version over the old one. The app shows your server's web UI, so server updates reach the TV without a reinstall.

## Troubleshooting

- **The TV is not found / "could not register" / "could not fetch the TV's key":** the Developer Mode app must be installed, **Dev Mode Status** and **Key Server** must be on, the TV and the PC must be in the same network (no guest network or VLAN between them), and nothing may block TCP port `9922`. Use the IP from the TV's network settings.
- **The passphrase changed:** it changes whenever the key server is switched off and on, or Developer Mode is reset. Read the current one in the Developer Mode app and run the script again.
- **The session expired (the app is gone, or the install says it cannot connect):** Developer Mode runs out after 50 hours. Open the Developer Mode app, switch Dev Mode on again if needed, and run the script again. Press **Extend** in time to avoid this ([the 50-hour session](#the-50-hour-session)).
- **"Plain http:// addresses are not allowed":** the server must be reachable over HTTPS with a public certificate (see [setup.md](setup.md)).
- **"Cannot reach that server":** check the address, the TV's network, and that the server runs. "That address answered, but it is not a FriendFlix server" means another service answers there (a router page, a proxy login).
- **"SHA-256 mismatch":** the download is damaged or was replaced; the script installs nothing. Try again; if it persists, look at the release's files.
- **"Node.js 20 or newer is needed":** install it from [nodejs.org](https://nodejs.org/).
- **"not an IPv4 address":** use the TV's address from its network settings, not a name.
- **Windows blocks the script:** run it as shown above with `-ExecutionPolicy Bypass`.
- **The release has no `.ipk` files:** the release job did not run for that tag. Check the release's *Actions* run.
- **Wrong server address stored:** use [Change server](#change-server).
