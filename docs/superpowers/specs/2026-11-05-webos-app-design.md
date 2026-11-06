# LG TV app (webOS): FriendFlix TV mode as an installable LG app with direct play

Status: design approved in conversation on 2026-11-05 (sections 1–3). The owner's TV is an LG 43QNED82A6B (2025, webOS 25). It
builds on the web TV mode ([docs/tv-mode.md](../../tv-mode.md): pairing, focus navigation, remote keys), on the Samsung app
([2026-10-25-tizen-app-design.md](2026-10-25-tizen-app-design.md): setup page, probe, install scripts, release job) and on the
capability block the Android, Windows and Samsung apps send (`backend/src/media/clientCaps.ts`).

## 1. Why and success

The web TV mode works in the LG browser, but the browser has no app icon, forgets the server, and the web player sends no
capability block. The server then plans for a generic browser and converts files the TV could play itself (HEVC, AV1, E-AC3, AC3,
MKV). webOS's `<video>` element plays those files directly on the TV's hardware.

Success means the owner can do the following on a webOS 22+ LG TV (tested on webOS 25):
- install a FriendFlix app with its own icon from the PC with one command;
- enter the server address once and pair with the phone code;
- browse the TV mode;
- press Play and get direct play for every file whose container and codecs the TV reports as playable (the player's
  quality chip reads "Original");
- have resume, *Continue watching*, skip intro and next episode work as everywhere else;
- use the remote's media keys and the red/green keys;
- leave the app with Back on the TV-mode home screen.

Not in scope (this spec):
- LG Content Store submission, and the public demo server with free films on the owner's VPS. Both are a **later phase**. This spec
  only makes the release package store-ready and writes the submission checklist (section 8).
- Native LG players (Luna media pipeline, `webOS.mediaPlayer`): `<video>` already plays the formats in section 4.
- DTS and TrueHD direct play (the server converts them).
- DRM, downloads, watch parties on the TV.
- Self-update (a developer-mode app can't update itself; the owner re-runs the install script).
- TVs older than webOS 22 (they may work, but are not tested or documented).

## 2. Architecture

```
webos/
  app/          appinfo.json, index.html, setup.js, setup.css, icon.png (80), largeIcon.png (130), icon-400.png, splash.png
  probe/        appinfo.json, index.html (the test app, section 6)
  build.mjs     checks appinfo.json, stamps the version, copies tv-shared/, runs ares-package
  check-config.mjs (+ test)
  install.ps1, install.sh
  package.json, package-lock.json   pinned @webos-tools/cli (the ares tools), nothing else
tv-shared/
  setup-core.js (+ test)            moved from tizen/shared/, used by both TV apps
web/src/lib/webos/
  detect.ts, keys.ts, caps.ts, probe.ts (+ tests)
```

- **App id** `com.friendflix.tv`, probe id `com.friendflix.tv.probe`. Title "FriendFlix" (probe: "FriendFlix Test").
- **`appinfo.json`**: `type: "web"`, `main: "index.html"`, `version` stamped from `version.json`, `vendor: "FriendFlix"`,
  `icon`, `largeIcon`, `splashBackground`, `bgColor`, `resolution: "1920x1080"`, `disableBackHistoryAPI: true` (Back arrives as
  key 461 instead of a history step, so the page decides), `uiRevision: 2`. No extra permissions.
- **Flow**: `index.html` (local, `file://`) reads the saved server from `localStorage`. None, or the server can't be reached:
  the setup page (section 7). Otherwise it navigates to `https://<server>/tv?ff_app=webos`. The server page is the normal TV
  mode; everything LG-specific runs in the web app behind `isLgApp()`.
- **`tv-shared/setup-core.js`**: moved unchanged from `tizen/shared/setup-core.js` (classic script exposing
  `window.FFSetupCore`, HTTPS only). The Tizen packaging, config check and tests read it from the new path; Tizen behaviour does
  not change.

## 3. Web side: detection, keys, exit, background

- **`isLgApp(win)`** (`web/src/lib/webos/detect.ts`): true when the user agent contains `Web0S` **and** either `ff_app=webos` is
  in the URL or `sessionStorage['ff.app'] === 'webos'` (the URL hint is stored there, like `isTizenApp`). The LG browser alone
  never counts. `webosVersion(win)` reads the platform version from the user agent where present, else null.
- **Navigation lock**: the Tizen navlock (`web/src/lib/tizen/navlock.ts`) is generalised to run when `isTizenApp() ||
  isLgApp()`. Links to other hosts don't leave the app.
- **Remote keys** (`web/src/lib/webos/keys.ts`, active only in the player, ignored elsewhere):

  | Key | keyCode | Action |
  |---|---|---|
  | Play | 415 | play |
  | Pause | 19 | pause |
  | Play/Pause | 10252 | toggle |
  | Stop | 413 | close the player (progress is reported, as on Back) |
  | Fast forward | 417 | +30 s |
  | Rewind | 412 | −30 s |
  | Red | 403 | subtitles on/off (last used track, else the first) |
  | Green | 404 | open the audio menu |

  Back (461) already works through `spatial.ts`. The ±30 s step is the same as the TV mode's.
- **Exit**: Back on the TV-mode home screen (nothing left to close, no history inside the TV mode) calls
  `PalmSystem.platformBack()` when present, else `window.close()`. LG's QA requires that Back on the first screen leaves the
  app.
- **Magic Remote pointer**: TV-mode cards are already clickable. Pointer hover moves the focus ring to the hovered element
  (a `pointerover` handler in `spatial.ts`, active in TV mode only), so arrows continue from where the pointer was.
- **Background**: on `visibilitychange` to hidden (Home key, input switch) the player pauses and sends the progress report,
  as on every platform. `webOSRelaunch` (the app icon pressed while it runs) does nothing beyond focusing the page; it does
  not reload.

## 4. Capability block and direct play

- **Server**: `ClientCaps.client` and its zod enum gain `'webos'`. No other server change: the block's rules (lists replace the
  browser defaults, role caps and kids rules always win, invalid block = no block) stay as they are.
- **Web**: `web/src/lib/webos/caps.ts` builds the block once per page load; `playbackInfoBody()` (`lib/player/infobody.ts`)
  adds it as `caps` when `isLgApp()`. Player and prefetch use that one function, so their bodies stay identical.
- **Candidates** (only entries the TV confirms are sent):
  - containers: mkv, mp4, m4v, mov, ts, webm;
  - video: h264 (profiles main, high, high 10), hevc (main, main 10), av1 (main, main 10), vp9, mpeg2video; `maxHeight` 2160;
  - audio: aac, ac3, eac3, mp3, flac, opus, vorbis (no dts, no truehd);
  - subtitles: srt, ass, ssa, vtt (drawn by the web player, as today).
- **Confirmation**: each candidate maps to MIME strings (e.g. `video/mp4; codecs="hvc1.2.4.L153.B0"`,
  `audio/mp4; codecs="ec-3"`, `video/x-matroska`). An entry counts when `video.canPlayType()` returns `probably`/`maybe` **or**
  `MediaSource.isTypeSupported()` is true. A codec with no confirmed profile is dropped. If nothing is confirmed, no block is
  sent (plain browser behaviour). The exact mapping table lives in `caps.ts` and its tests.
- **appVersion** is the web app's version from `version.json` (strict x.y.z, as the server expects).
- **Fallback**: the player's existing recovery stays: a decode error on direct play switches once to the server's converted
  stream at the same position (`force-hls`). New for LG: when direct play shows no first frame within **10 s**, the same
  `force-hls` step runs. Converted streams play through hls.js as today. If the probe (section 6) shows hls.js failing on
  webOS 25, the player uses the TV's own HLS (`video.src = hlsUrl`) when `isLgApp()`; that switch is decided by the probe line and
  recorded in the plan's ledger.

## 5. Player behaviour that does not change

Resume, *Continue watching*, skip intro/outro, next episode, post-play, trickplay, chapters, quality chip, still-watching and
progress reports are the normal web player's. Audio track change on direct play keeps going through the converted stream
(today's rule: `audioIndex` forces HLS).

## 6. Test app (probe)

`webos/probe/` is a minimal app that asks for the server address (same setup page) and opens
`https://<server>/tv?probe=1&ff_app=webos`. With both parameters, `web/src/lib/webos/probe.ts` runs (shared helpers with the Tizen
probe — picking the first *Continue watching* item, the on-screen result card — are moved to `web/src/lib/tvprobe/`):

1. the candidate list from section 4, run through `canPlayType` / `isTypeSupported`;
2. a real direct play of the first *Continue watching* item with the page's session: `playing` and the first frame within
   15 s, plus the time taken; the probe never sends a progress report (resume stays untouched, as fixed for Tizen);
3. hls.js playback of the same item's converted stream (`hls=ok|error:<code>`), then the TV's own HLS (`nativehls=…`);
4. `PalmSystem` present on the server page (`palm=yes|no`), and whether history back reaches the local start page
   (`home=ok|fail`, section 7);
5. a key test: "press ⏯" and "press red", recorded as `keys=ok|missing:<names>`.

It shows one line, for example:
`FFPROBE v1 tv=webos os=25 direct=ok:1840ms hls=ok nativehls=ok palm=yes home=ok keys=ok video=h264,hevc,av1,vp9 audio=aac,ac3,eac3,mp3,flac,opus containers=mkv,mp4,ts,webm`.
The owner photographs or types it. The line decides the final candidate list, the HLS route (section 4), the exit method and the Change server route; the
decisions go into the ledger and, where they change behaviour, into `docs/webos.md`.

## 7. Setup page and server change

- First start, or "Change server": an input for the address, checked by `FFSetupCore.normaliseServer` (HTTPS only) and the same
  `/api/version` answer check as the Samsung app (CORS `*` is already there). Saved in `localStorage` (`ff.server`).
- Server unreachable at start: an error card with **Retry** and **Change server**, focusable with the arrow keys.
- In the app only, the TV mode's profile menu gets **Change server**. A server page can't open the local `file://` page
  directly, so it goes back through history: on its first load the server page stores `history.length` in sessionStorage
  (`ff.histBase`), and Change server calls `history.go(-(history.length - base + 1))`. The start page shows the setup form
  when it is reached by back navigation (navigation type `back_forward`) instead of forwarding again.
- The probe checks this route (`home=ok|fail`, section 6). If it fails on webOS 25, the start page instead shows the logo for
  1.5 s with "Blue key: change server" and opens the setup form on key 406; the menu entry then explains that.

## 8. Build, release, install, store prep

- **`webos/package.json`** pins `@webos-tools/cli` to one exact version with a lockfile (`npm ci`); nothing else. The version
  is chosen at implementation (the newest release at least two weeks old).
- **`webos/build.mjs app|probe <outDir>`**: runs `check-config.mjs`, stamps `version.json`'s version into a copy of
  `appinfo.json`, copies `tv-shared/setup-core.js`, runs `ares-package` and writes `FriendFlix-<v>.ipk` /
  `FriendFlix-probe-<v>.ipk`. The release `.ipk` contains no probe or test code.
- **`webos/check-config.mjs`**: id, title, version format, `type`, `main`, icon files present with the exact pixel sizes (80, 130,
  400; splash 1920×1080), `disableBackHistoryAPI: true`, no unknown keys that LG rejects.
- **CI**:
  - `webos-check` (every PR): `node webos/check-config.mjs`, `npm run test:webos`, both packages build.
  - `webos-release.yml` (called from `ci.yml` for `v*` tags after test, e2e, secrets and webos-check): builds both packages and
    attaches them plus `SHA256SUMS-webos.txt` to the tag's GitHub Release. No secrets (developer-mode `.ipk` files are
    unsigned; LG signs store apps itself). Refuses a tag that doesn't match `version.json`.
- **Install scripts** `webos/install.ps1 <TV-IP> <passphrase> [-Probe] [-Ipk <file>]` and
  `webos/install.sh <TV-IP> <passphrase> [--probe] [--ipk <file>]`:
  - check Node.js 18+ (clear message with the download link if missing);
  - install the pinned ares tools into a local cache (`npm ci` in a temp copy of `webos/`);
  - download the latest release `.ipk` (or use `-Ipk`) and check it against `SHA256SUMS-webos.txt`;
  - `ares-setup-device` (device name `friendflix-tv`, port 9922, the passphrase never printed or logged),
    `ares-install`, `ares-launch`;
  - re-running replaces the installed app.
- **Developer mode** (documented in `docs/webos.md`): install "Developer Mode" from the LG Content Store, sign in with an LG
  developer account, turn Dev Mode on (TV restarts), note IP and passphrase. The session lasts **50 hours**; press **Extend** in
  the Developer Mode app before it ends, or the TV removes the app (re-run the install script then).
- **Store-ready now**: Back on home exits, no test code in the release package, own FriendFlix artwork (no third-party logos or
  look-alikes), icons and splash in the sizes above.
- **`docs/webos-store.md`** (submission later): LG Seller Lounge account, what LG asks for (`.ipk`, store images, UX scenario
  document, self-checklist, age rating, a test server and account for LG QA), and the planned demo server on the owner's VPS
  with freely licensed films (Blender open movies) as that test server. Marked as a later phase.

## 9. Docs

- `docs/webos.md`: Dev Mode guide, install, probe, troubleshooting (TV not found, passphrase changed, session expired, server
  not HTTPS), what direct play covers.
- README: short "LG TV" section next to the Samsung one, linking `docs/webos.md`.
- `docs/tv-mode.md`: LG app keys.

## 10. Testing

- **Web (vitest)**: `detect` (UA plus hint, browser alone false, sessionStorage blocked), `keys` (each code, ignored outside the
  player), exit on Back at home (`platformBack` present / absent), `caps` (MIME mapping, only confirmed entries, nothing
  confirmed = no block, profile dropping), `playbackInfoBody` with and without caps (player and prefetch bodies identical), the
  10 s first-frame fallback, `probe` line formatting and that it never reports progress.
- **Backend**: `parseClientCaps` accepts `client: 'webos'`; an unknown client is still rejected.
- **webos/**: `check-config` (good config, each rule failing), `setup-core` tests at the new path, install scripts parse
  (`bash -n`, PowerShell parser) and never echo the passphrase.
- **Tizen regression**: Tizen tests and packaging still pass with `tv-shared/`.
- **Playwright**: TV mode with a stand-in LG environment (UA `Web0S`, `PalmSystem` stub, `ff_app=webos`): media keys in the
  player, red/green, Back on home calls `platformBack`, `caps` present in the playback request.
- **On the TV** (owner): the probe line, then app install and a direct-play check of one HEVC/E-AC3 MKV.
