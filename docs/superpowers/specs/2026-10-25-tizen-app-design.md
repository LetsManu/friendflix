# Samsung TV app (Tizen): FriendFlix TV mode with Samsung's native player

Status: design approved in conversation on 2026-10-25 (sections 1–3). The owner's TV is a 2022 or newer model (Tizen 6.5+) and
is already in developer mode. It is modelled on the Jellyfin Tizen app (a small web app that opens the server's UI). It
builds on the existing web TV mode ([docs/tv-mode.md](../../tv-mode.md): pairing, focus navigation, remote keys) and the
native-app pattern of the Android and Windows apps.

## 1. Why and success

The web TV mode already works in the Samsung browser. It plays through `<video>`/hls.js, though, so the server must convert
everything the browser engine can't play: E-AC3, DTS, TrueHD, often HEVC/HDR and 4K. Samsung's own player (AVPlay) plays those
files directly on the TV's hardware.

Success means the owner can do the following on a 2022+ Samsung TV:
- install a FriendFlix app with its own icon from the PC with one command;
- enter the server address once and pair with the phone code;
- browse the TV mode;
- press Play and get the web player's controls over video that AVPlay plays directly;
- have resume, *Continue watching*, skip intro and next episode work as everywhere else;
- use the remote's media keys.

Not in scope:
- the Samsung store, and a code-signing setup beyond the owner's Samsung certificate;
- TVs older than 2022 (they may work, but are not tested or documented);
- DRM, downloads, watch parties on the TV;
- self-update (a Tizen developer app can't update itself; the owner re-runs the install script);
- LG webOS.

## 2. Phase 0: probe build (decides plan A or B)

`tizen/probe/` is a minimal Tizen web app (`config.xml` and `index.html`). It asks for the server address, then opens
`https://<server>/tv?probe=1`. With `probe=1`, the web app (`web/src/lib/tizen/probe.ts`, only active with the
` FriendFlixTizen/` user agent) checks:

1. `typeof webapis !== 'undefined' && webapis.avplay` exists on the server page;
2. AVPlay opens a FriendFlix stream with the page's session. It opens `/api/playback/info` for the first *Continue watching*
   item, then reaches `PLAYING` and shows the first frame within 15 s. The result is a status (`ok` / `error:<code>`) and the
   time taken;
3. `tizen.tvinputdevice.registerKey('MediaPlayPause')` succeeds, and a key press arrives as `keydown` (the TV shows "press ⏯");
4. `tizen.application.getCurrentApplication()` is available.

It shows one line, for example `FFPROBE v1 avplay=ok play=ok:2310ms keys=ok app=ok tizen=6.5 model=QE55Q80B`. The owner reads
it out or photographs it.

- `avplay=ok` and `play=ok` mean plan A (sections 3–5).
- Otherwise plan B (section 6).

The probe is installed with the same script and signing as the app (section 8). Whichever plan wins, the probe stays in the
repo as a diagnostic.

## 3. Plan A: architecture

- **`tizen/app/`**: the Tizen web app (`config.xml`, `index.html`, `setup.js`, `keys.js`, `icon.png`, `setup.css`).
  - `config.xml`:
    - privileges `http://tizen.org/privilege/internet`, `http://tizen.org/privilege/tv.inputdevice`,
      `http://developer.samsung.com/privilege/avplay`, `http://tizen.org/privilege/application.launch`;
    - `tizen:allow-navigation` lists only the configured server host and the sign-in host. It is rewritten by the app at
      setup, or fixed to `*` if Tizen ignores runtime changes. In that case the local `index.html` enforces the lock before
      navigating (decided at implementation, documented);
    - `tizen:setting screen-orientation="landscape" background-support="disable"`;
    - required version 6.5.
  - The user agent marker ` FriendFlixTizen/<version>` is added through `tizen:app-control` / `navigator.userAgent` override if
    available. If not, the web side recognises the app by `typeof tizen !== 'undefined'` plus the `ff_app=tizen` query parameter
    the shell appends to `/tv`.
- **Web (`web/src/lib/tizen/`)**:
  - `detect.ts`: `isTizenApp()`;
  - `avplay.ts`: the media adapter (section 4);
  - `keys.ts`: key registration and mapping (section 5);
  - `caps.ts`: the device capability block;
  - `probe.ts`: section 2.
  - `Player.svelte` uses the adapter where it now uses the `<video>` element, behind one seam (a small `MediaLike` interface).
    The rest of the player is unchanged.
- **Backend:** `backend/src/media/clientCaps.ts` accepts `client: 'tizen'` (same allowlists, no widening), with a test.

## 4. Plan A: the AVPlay adapter

`createAvPlayMedia(api = webapis.avplay): MediaLike` exposes what Player.svelte uses from `<video>`:
- `currentTime` (get/set, which seeks with `seekTo`), `duration`, `paused`, `ended`, `readyState`, `volume`/`muted` (the TV's
  own volume stays in charge; `muted` maps to `setMute`);
- `play()`, `pause()`, `load(url, startMs)`, `destroy()`;
- `addEventListener` / `removeEventListener` for `loadedmetadata`, `playing`, `pause`, `waiting`, `timeupdate` (every 250 ms
  from `oncurrentplaytime`), `seeked`, `ended`, `error`.

Behaviour:
- **Setup:** `open(url)`, then `setListener`, then `setDisplayRect(0, 0, 1920, 1080)` (scaled from the player area; full screen
  in the TV mode), then `setStreamingProperty('ADAPTIVE_INFO', …)` for HLS, then `prepareAsync`, then `seekTo(startMs)` if > 0,
  then `play`.
- **Picture:** AVPlay renders below the page. The player area's background becomes transparent while the adapter is active,
  and an `<object type="application/avplayer">` sits in the player area as Samsung requires.
- **Session:** AVPlay fetches the stream itself. The probe proves whether the page's cookies go with it (plan A requires it).
- **Tracks:** audio tracks from `getTotalTrackInfo()` (type AUDIO, `extra_info` language and channels), mapped to the
  player's audio menu. A pick calls `setSelectTrack('AUDIO', index)`. Subtitles stay rendered by the web player from the
  server's text subtitles, timed by the adapter's `currentTime`. Image subtitles are converted by the server, as now.
- **Errors:**
  - `onerror` or a failed `prepareAsync` on the direct URL switches once to the server's converted `hlsUrl` in AVPlay at the
    same position.
  - A second failure falls back to the normal web player (`<video>`/hls.js) for this title, with a toast.
- **Background:** on `visibilitychange` to hidden, `suspend()` and a progress report. On visible, `restore()` at the position,
  as Samsung requires for multitasking.
- **End:** `onstreamcompleted` fires `ended`. Next episode and post-play run as in the web player.

## 5. Plan A: keys and the capability block

- **Keys:** `keys.ts` registers MediaPlay, MediaPause, MediaPlayPause, MediaStop, MediaFastForward, MediaRewind,
  MediaTrackNext, ColorF0Red and ColorF1Green at start. They are mapped to the player's existing actions (play/pause, stop,
  ±30 s, next episode) and to subtitles on/off (red) and the audio menu (green). Red held on the start page means
  "change server". Back keeps the TV mode's behaviour. Back on the TV home screen exits the app
  (`tizen.application.getCurrentApplication().exit()`).
- **Capability block** (`caps.ts`, sent with `/api/playback/info` like Android's, `client: 'tizen'`, `appVersion` = app
  version):
  - containers: mkv, mp4, m4v, mov, ts, webm;
  - video: h264 (`profiles` main, high, high 10), hevc (main, main 10), av1 (main, main 10), vp9, mpeg2video, each with
    `maxHeight` 2160;
  - audio: aac, ac3, eac3, mp3, flac, opus, vorbis;
  - dts and truehd only when the model reports support (`webapis.productinfo` / AVPlay capability query if available, else
    left out so the server converts);
  - subtitles: srt, subrip, ass, ssa, vtt.
  - avi and m2ts are not on the server's allowlist and stay converted (unchanged).

## 6. Plan B (only if the probe fails)

- The app keeps a local player page (`tizen/app/player.html` + `player.js`) with AVPlay and its own TV controls: play/pause,
  seek bar, audio, subtitles, skip intro, next episode. It is a reduced Android-style control set.
- The web TV mode hands Play to the app through `window.parent`/`postMessage`, or a local navigation with the item id.
- Streams are fetched with a short-lived, stream-scoped ticket instead of the cookie. This needs a new endpoint
  `POST /api/playback/ticket {itemId, mediaSourceId}` returning a URL with a signed token, valid for 6 h, bound to the
  user/profile and item, and accepted only on `/media/...`. That is its own reviewed server change.
- Section 4's adapter logic (setup order, tracks, fallback, background) is reused in `player.js`.

If plan B is needed, the plan document gets an extra task set for it. This spec stays the authority.

## 7. Setup screen and server change

- `index.html` is shown when no server is stored or when the user asks to change it.
  - A TV-sized form with an on-screen keyboard (the TV's IME), operated with the arrows.
  - The address is normalised to `https://host[:port]`. `http://` is refused, as on Android.
  - It is checked with `GET /api/version` (a FriendFlix answer, as in ServerProbe.kt). `authOrigin` is accepted only as
    `https://host`.
  - The server is stored in `localStorage` (`ff.server`, `ff.authOrigin`).
- The app then navigates to `https://<server>/tv` (plus `?ff_app=tizen` if needed for detection). The existing pairing signs
  in for 90 days.
- In the app only, the TV mode's profile menu gets **Change server**, which returns to the local setup page.

## 8. Signing, release and install

- **CI job `tizen-release`** (`.github/workflows/tizen-release.yml`, called from ci.yml on v* tags like android-release;
  it is not in the `needs` of publish or android-release):
  - installs the Tizen CLI (a pinned version, archive checked by SHA-256);
  - writes the author and distributor certificates from the secrets `TIZEN_AUTHOR_P12`, `TIZEN_AUTHOR_PASSWORD`,
    `TIZEN_DISTRIBUTOR_P12`, `TIZEN_DISTRIBUTOR_PASSWORD` (base64), creates a security profile, and runs `tizen package -t wgt`
    for `tizen/app` and `tizen/probe`;
  - attaches `FriendFlix-<version>.wgt`, `FriendFlix-probe-<version>.wgt` and `SHA256SUMS-tizen.txt` to the release;
  - without the secrets, it leaves a `::notice` and attaches nothing.
  - A PR CI job checks `config.xml` (privileges and required version present, no wildcard navigation unless the documented
    decision) and packages an unsigned `.wgt` to catch errors.
- **Install** (`tizen/install.ps1`, `tizen/install.sh`):
  - arguments are the TV IP and optionally `-Probe` / `--probe` and `-Version`;
  - downloads the `.wgt` and `SHA256SUMS-tizen.txt` from the GitHub release (latest by default) and checks the hash;
  - runs `sdb connect <ip>:26101`, then `tizen install -n <wgt> -t <device>`, and on failure prints the documented hints
    (developer mode host IP, certificate DUID, TV on the same network).
- **Docs** (`docs/tizen.md` + `docs/de/tizen.md`):
  - developer mode on the TV (Apps, 1-2-3-4-5, Host PC IP, restart);
  - Tizen Studio / CLI with the Samsung certificate extension;
  - a Samsung certificate with the owner's Samsung account and the TV's DUID; friends' TVs by DUID, then re-sign;
  - exporting the p12 files as base64 secrets;
  - running the install script; the probe first and what its line means;
  - remote keys; troubleshooting (developer mode expiring after reboot on some models, a certificate DUID mismatch
    "install failed: author certificate", the server not reachable);
  - the manual checklist (section 9); a README line; a CHANGELOG entry `### Samsung TV app`.

## 9. Testing

- **vitest:**
  - `avplay.ts` against a fake `webapis.avplay` that records calls and fires listener callbacks:
    - the setup order and `startMs` seek;
    - play/pause/seek states;
    - `timeupdate` cadence;
    - the audio track mapping and `setSelectTrack`;
    - fallback once to HLS, then to `<video>`;
    - suspend/restore on visibility;
    - `ended` on stream completed;
    - `error` mapping;
    - `destroy` closing the player.
  - `keys.ts`: registration list and the mapping to player actions.
  - `caps.ts`: list shapes (each list at most 16 entries, accepted by the server's parser).
  - `probe.ts`: result line format.
  - `detect.ts`.
- **e2e (Playwright):** the TV mode with the Tizen user agent and an injected fake `webapis`/`tizen`. Play uses the adapter
  (no `<video>` src set), the controls show, ←/→ seek through the adapter, and the media keys map.
- **Backend:** `client: 'tizen'` is accepted, unknown clients are still refused, out-of-allowlist values are dropped.
- **Tizen app:** unit tests for `setup.js` (address normalisation, http refused, `/api/version` answer check, `authOrigin`
  check) run under vitest/jsdom.
- **Manual (owner's TV):**
  1. probe line;
  2. install; first start; setup with wrong and right address; pairing;
  3. Play from home, detail and episodes;
  4. direct play of an HEVC 10-bit 4K file and an E-AC3 file (the chip says Original);
  5. resume across devices;
  6. audio track switch; subtitles style;
  7. skip intro, next episode, still watching;
  8. media keys and colour keys;
  9. Home and return (suspend/restore);
  10. Back exits from home;
  11. change server;
  12. the HLS fallback (remote cap) and the `<video>` fallback.
