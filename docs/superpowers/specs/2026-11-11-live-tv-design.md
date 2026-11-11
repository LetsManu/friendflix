# Live TV with a shared conversion budget (design)

Date: 2026-11-11 · Status: design approved by the owner in chat (option B); this spec writes it down, grounds it in the code
and resolves the rest

## Goal

FriendFlix gets Live TV that feels like the rest of the app: a *Live-TV* tab next to *Serien* and *Filme*, channels from an
IPTV provider list and from the household's own feeds, a live player with pause and a 30-minute rewind buffer, channel
switching with the remote, casting, a programme guide (Phase 2) and recordings (Phase 3). It is **optional**: nothing is
downloaded or run until an admin turns it on. A **server-wide conversion budget** (Phase 1, useful without Live TV) makes sure
films, HEVC conversions, live channels and recordings never overload the server together.

## Owner decisions (fixed, not reopened here)

**Approach.** Option B: FriendFlix manages channels itself (not Jellyfin Live TV).

**Sources.** Provider M3U list(s) with an optional XMLTV EPG URL, plus own feeds entered by hand (SRT, HLS or MPEG-TS).
Refresh interval per source (6 h / 12 h / 24 h / weekly / manual) plus *Jetzt aktualisieren*; last refresh and error shown.
Credentials inside provider URLs stay on the server, never reach clients or logs. Optional manual tools: manual EPG entries
(single or recurring) for own feeds; time-based recording.

**Channels.** Name, logo, number, group, source, stream kind, EPG mapping; the admin can hide, rename, renumber and regroup;
overrides survive a re-import.

**Container.** Own container `livetv` (ffmpeg) in its own compose profile: image downloaded and container run only when
enabled. *Live-TV aktivieren* in Admin goes through the updater if it can (web and backend never get the Docker socket);
otherwise the panel shows the one line to add to `.env`. Disabling stops it, optionally removes image and data. The whole
Live-TV admin area appears only when the backend detects the container; before that only a small, hideable
*Live-TV (optional) → aktivieren* entry.

**Admin panel.** On par with the best admin pages: *Quellen*, *Kanäle* (search, filters, bulk edit, drag-and-drop order, logo
preview, stream test), *Gruppen & Rechte*, *Programmführer* (EPG matching, manual entries, unmatched list with suggestions),
*Live-Status* (running channels, viewers, CPU/GPU, conversions vs. budget), *Aufnahmen* (storage mode, limit, usage).

**Streaming.** Provider HLS passed through by `livetv` (segment URLs rewritten, provider URLs never exposed); MPEG-TS remuxed
to HLS without re-encoding; own SRT converted to HLS only while watched (remux if already H.264/AAC, else transcode, GPU if
available); all viewers of a channel share one running stream; it stops 60 s after the last viewer; clients get it through
the gateway with short-lived tokens like films. Player live mode: no seek bar, pause and rewind up to 30 min with a *LIVE*
button, channel up/down (swipe / buttons on phones, arrows / PageUp / PageDown on desktop, channel and up/down keys on TV
remotes), number entry on TV (digits + OK), info panel now/next, "last channel" jump. Casting to Chromecast and AirPlay.
Errors: "Sender gerade nicht erreichbar" + automatic reconnect, logged in *Live-Status*.

**Shared conversion budget** (server-wide, Phase 1, useful without Live TV). It counts every real conversion: Jellyfin
film/series transcodes, FriendFlix HEVC conversions, live-TV transcodes, recordings that need conversion, and the optional
later H.265 re-encode of recordings. Whenever a conversion is needed it takes a slot. Direct play, passthrough and pure remux
do not count. When full: a new live conversion does not start ("Gerade sind alle Live-Plätze belegt" + list of running
channels to join); a film that needs a conversion gets the existing fallback (lower quality / direct where possible) or
"Server gerade ausgelastet"; running sessions are never interrupted; admin-configurable priority (e.g. films before live
TV); recordings reserve their slot ahead of new viewers. On enabling and on *Neu messen*: a ~20 s 1080p benchmark on the
hardware Jellyfin uses (GPU if mapped) → speed vs. real time → recommended maximum with a safety margin ("gemessen 4,6×
Echtzeit → empfohlen 3"); detected CPU/GPU and live load shown; the admin can override; default 2 before measuring.
`livetv` needs the same GPU mapping as Jellyfin (`/dev/dri` for Intel/AMD); setup detects and explains. Reuse/extend the
HEVC probe and stream-limit code.

**Viewers.** Any number of viewers per converted channel (bandwidth only); the limit counts conversions, not viewers;
everyone on a converted channel gets the same quality (an extra *Mobile-Qualität* rendition is a possible later option, off).

**Live-TV tab.** Next to *Serien*/*Filme* (also in the phone tab bar), only if installed **and** the profile may see ≥ 1
channel. Layout: *Läuft gerade bei dir* favourite tiles (logo, programme, progress, cheap preview only where free), group
chips, channel list (number, logo, name, now/next, favourite star; compact list on phones, two-column grid on desktop),
*Programmführer* button (Phase 2), *Aufnahmen* row (Phase 3). TV apps: big tiles, clear focus, Back closes the player, remote
channel keys in player and list, last channel remembered; optional admin setting per device *TV startet mit Live-TV*. Kids
profiles: only kid-friendly groups. Existing design system and animations only (glass `.frost*` / `--fr-*`, transitions,
sheets, chips, tiles, player, cast bar, focus rings); no separate Live-TV style; only `transform`/`opacity`; nothing jumps;
space reserved for now/next lines.

**Phase 2 EPG grid.** Fixed channel column + half-hour time axis, red moving *jetzt* line, day selector (7 days ahead, 1
back), *Jetzt* button, group chips; past dimmed, recording dot; detail sheet (*Jetzt ansehen* / *Aufnehmen* / *Serie
aufnehmen* / *Erinnern*); desktop / phone / TV navigation (TV: arrows move programme to programme, grid follows, OK details,
channel keys, Info); virtualised drawing (~20 channels × 4 h visible), 6-hour EPG blocks cached; channels without EPG show
"Live" / "Kein Programm verfügbar"; EPG matching by tvg-id then name, manual mapping with suggestions; UTC stored, local time
shown, DST correct. EPG kept ~7 days ahead, 1 day back.

**Phase 3 recordings.** Single, series (EPG series id or title; only new episodes; this channel / all; keep max N),
time-based with weekly repeat; padding 2 min before / 5 after (configurable); conflict warning against the budget; recording
straight to file (passthrough/remux cheap; converted SRT takes a budget slot); automatic reconnect, gaps noted, failures shown
in *Live-Status* and to the recording's owner; watch while recording; recordings in a Live-TV tab row and a *Meine Aufnahmen*
page, grouped; normal player with progress / resume / hand-off / casting; *Behalten* protects from automatic deletion; storage
mode chosen by the admin: FriendFlix folder (`/recordings` volume), Jellyfin library folder, or both (with *Behalten → in
Bibliothek*); size limit with usage, oldest unprotected deleted first, owner notified 24 h before; retention rule (e.g. delete
30 days after watched); recordings stored as recorded; optional later H.265 re-encode, off by default, counted against the
budget in quiet hours. Who may record is set per role; recordings are private to the profile unless shared by an admin or the
owner; kids cannot record and only see shared kid-friendly recordings. Notifications through the existing system (started /
failed, new series episode, storage nearly full).

**Permissions.** Channel groups allowed per role, with per-user overrides (e.g. a guest gets "Sport"); groups can be marked
kid-friendly; kids profiles see only kid-friendly groups (none → no tab). Favourites per profile.

## Sources this spec is built from

Code as of `main` = 3.3.0: `backend/src/hevcenc.ts` (probe, gate, grants), `media/streamplan.ts` (`applyGate`),
`routes/media.ts:333-380` (`/api/playback/info`: `maxStreams`, upload cap, HEVC gate), `live.ts` (live records, `countLive`),
`uploadcap.ts`, `cast.ts` (token model), `routes/internal.ts` (`/internal/authz*`), `gateway/src/gateway.ts` (`/media/*`,
`/media/c/<token>/*`, file serving for `/media/d/*`), `updater/src/{policy,docker,server}.ts`, `backend/src/updater.ts`,
`compose.prod.yaml` (profiles `updater`, `backup`, `bundled`; networks; `docker-proxy`), `settings/registry.ts`,
`notify.ts`, `db.ts` (45 migrations), `server.ts` (job timers), `web/src/lib/Player.svelte`, `lib/player/keymap.ts`,
`lib/cast/*`, `lib/phone/TabBar.svelte` + `logic.ts`, `lib/menu.ts` (`HEADER_TABS`, `TV_RAIL`), `lib/glass/fx.ts`,
`android/firetv/.../FireTvKeys.kt`, `tizen/app/setup.js`, and the specs for HEVC/surround, cast/AirPlay, TV layout, glass,
and `2026-11-11-users-permissions-design.md` (Phase 0).

## Non-goals

- No Jellyfin Live TV / tuner integration, no HDHomeRun discovery, no DVB hardware. Jellyfin keeps doing films and series.
- No SRT **listener** (feeds pushing into FriendFlix) in these phases: own SRT feeds are pulled (`srt://host:port`,
  caller mode) only while watched or recorded (see open question 1).
- No adaptive bitrate ladder for live: one rendition per channel (the *Mobile-Qualität* rendition stays a later, off option).
- No catch-up / replay TV beyond the 30-minute buffer and recordings; no provider VOD (M3U entries for films and series are
  skipped on import).
- No ad skipping, no DRM sources, no subtitles/teletext for live in these phases (DVB subtitles are dropped on remux; listed
  as a known limit).
- No live TV in offline downloads.
- Plex installs: Live TV works (it does not need the media server); the budget counts what the Plex adapter reports
  (`transcodeSessions`) plus FriendFlix's own conversions; the *Jellyfin library* recording mode is Jellyfin only.

## Global constraints (restated project rules)

- **Motion:** only `transform` and `opacity` animate; opening and closing both animate (`growBoth`, `sheetSlide`, `barRise`,
  `toastRise`); nothing jumps: now/next lines, progress bars, error lines and the save bar reserve their space before content
  arrives. Calm mode / reduced motion / TV / kids: solid panels (`--fr-solid`), state changes switch at once. The existing
  stylesheet scan (`web/src/lib/admin/glass.test.ts`) is extended to every new file of this block.
- **Look:** the existing glass system only (`.frost`, `.frost-safe`, `.frost-btn`, `.frost-pill`, `.frost-tile`,
  `.frost-sheet`, `.frost-dim`, `.panel`, `--fr-*`), the player's existing control bar, the cast bar, chips, tiles and focus
  rings (TV: `scale(1.08)` + 3 px white ring, one focused element). No Live-TV-specific palette; the only colour cue added is
  the guide's red *jetzt* line and the red recording dot, both using the existing danger red token `--err`, each also carried
  by text or shape (never colour alone).
- **i18n:** everything through `#lib/i18n`, seven locales (`de` source, `en` second); copy table in §20.
- **Secrets:** provider URLs (and every channel stream URL, which usually carries the same credentials) are stored encrypted
  (`APP_ENC_KEY`, the settings-blob format), never sent to a browser, never logged, never in metrics labels, audit metadata,
  error texts or Diagnose output. Clients only ever see FriendFlix token paths.
- **No Docker socket** for backend, web, gateway or `livetv`; only the updater talks to `docker-proxy`.
- **Words and fixtures:** never "Netflix"/"Seerr" in user-facing text. Fictional channels and titles only (§22). Placeholder
  hosts only: `friend.example.com`, `iptv.example.com`, `192.0.2.x`.
- **Accessibility at the 3.1 level** (contrast ≥ 4.5:1 on glass, targets ≥ 44 px, TV focus targets ≥ 54 px and text ≥ 28 px at
  1080p, keyboard everywhere, `menuKeys`, focus traps, polite announcements).
- **Tests:** Vitest + Playwright in the existing style; locally only `npm run typecheck` and the new spec/unit files; CI runs
  the rest.

---

## 1. Phases and pull requests

The phase split (each PR leaves the app working; Live TV stays invisible until enabled):

| Phase | PR | Content |
|---|---|---|
| **0** | 0a–0c | Users & permissions remodel (`2026-11-11-users-permissions-design.md`): permission registry with `liveTv` / `liveRecord`, role editor, per-user overrides. Live TV depends on it. |
| **1** | **1a** | Shared conversion budget + benchmark (backend `convbudget.ts`, `/api/playback/info` gate, Admin → *Wiedergabe* card). No Live TV needed. |
| | **1b** | `livetv` image + compose profile + GPU overlays + updater actions + backend detection + *Live-TV (optional)* entry + enable/disable flow. |
| | **1c** | Sources, import (M3U/XMLTV), channels, groups & rights, logos, admin *Quellen* / *Kanäle* / *Gruppen & Rechte* / *Live-Status*; now/next from XMLTV (auto-matching only). Migration 47. |
| | **1d** | Watching: tokens, gateway route, shared streams, DVR, budget admission, the *Live-TV* tab (desktop, phone, kids, TV), live player, favourites, last channel, Chromecast/AirPlay, *TV startet mit Live-TV*. |
| | **1e** | Platform keys and shells: Tizen key registration, webOS key mapping, Fire TV `FireTvKeys`, Android shell cast bridge `castLive`. |
| **2** | 2a | EPG admin: *Programmführer* tab (matching with suggestions, unmatched list, manual EPG entries/rules). Migration 48. |
| | 2b | EPG grid for users (desktop, phone, TV), detail sheet, reminders. |
| **3** | 3a | Recordings backend + `livetv` recorder + storage modes + budget reservation + notifications. Migration 49. |
| | 3b | Recording UI (detail sheet actions, Live-TV row, *Meine Aufnahmen*, admin *Aufnahmen*), player source seam for recordings, casting/hand-off of recordings. |
| | later | Optional H.265 re-encode of recordings (off by default, quiet hours, budget). |

Recommended plans: one implementation plan per phase (Phase 1 plan covering 1a–1e with 1a first, because it changes film
playback for everyone and should ship and settle on its own), Phase 2 plan, Phase 3 plan.

## 2. Architecture

```
 browsers / TV WebViews / Android shell / Chromecast / AirPlay
        │  /api/* (cookie session)                 │  /media/l/<token>/…  /media/r/<token>/…  (token in path)
        ▼                                          ▼
   backend (Fastify) ──signed HTTP──► livetv ◄──── gateway (proxies HLS from livetv, serves recordings read-only)
     │  DB: sources, channels, groups, EPG,          │  ffmpeg / HLS proxy / DVR cache / recorder
     │  rights, recordings, budget                   │  networks: livetv (internal) + livetv-egress (internet / LAN)
     │                                               ▼
     └──signed HTTP──► updater ──► docker-proxy ──► docker (pull/up/stop livetv; profile livetv)
```

- **backend** owns all state (Postgres), decides who may watch what, admits conversions against the budget, mints tokens,
  schedules refreshes and recordings, and tells `livetv` what to run. It never talks to provider hosts itself.
- **livetv** (new service, Node + jellyfin-ffmpeg) is the only component that fetches provider/own-feed URLs: M3U and XMLTV
  downloads (parsed with hard limits), logos, stream inputs, probes, benchmarks, recordings. It holds no database and no
  credentials at rest: the backend sends the decrypted input URL in each signed start request; `livetv` keeps it in memory only.
- **gateway** serves live HLS to clients from `livetv` under `/media/l/<token>/…` (the existing `/media` location of the
  reverse proxy, so no proxy change), and recordings from a read-only mount under `/media/r/<token>/…`.
- **updater** gains three fixed actions for the `livetv` service (§4).

## 3. The `livetv` container

### 3.1 Image and compose service

- Image `ghcr.io/<owner>/friendflix-livetv:<tag>`, built and cosign-signed by `publish.yml` like the others; base
  `debian:bookworm-slim` + `jellyfin-ffmpeg7` (same hardware support as Jellyfin: QSV, VA-API, NVENC) + Node 22; runs as
  uid 10001; healthcheck `GET /healthz`.
- Service in `compose.yaml` and `compose.prod.yaml`:

```yaml
  # Live TV (optional): only with the profile `livetv` (Admin -> Live-TV aktivieren through the updater, or COMPOSE_PROFILES=livetv
  # in .env). Fetches provider lists, EPG and streams; the backend tells it what to run. No ports, no Docker socket.
  livetv:
    profiles: [livetv]
    image: ${FF_REGISTRY:-ghcr.io/letsmanu}/friendflix-livetv:${FF_TAG:-latest}
    pull_policy: always
    restart: unless-stopped
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    group_add: ["10001"] # reads bootstrap-gateway (internal_secret only)
    environment:
      INTERNAL_SECRET: ${INTERNAL_SECRET:-} # unset: the copy in the bootstrap-gateway volume
      LIVETV_CACHE_MAX_GB: ${LIVETV_CACHE_MAX_GB:-6}
      TZ: ${TZ:-Europe/Vienna}
    volumes:
      - livetv-cache:/cache                                   # DVR segments, previews (disposable)
      - ${RECORDINGS_PATH:-recordings}:/recordings             # Phase 3
      - bootstrap-gateway:/run/friendflix-gateway:ro
    depends_on:
      bootstrap: { condition: service_completed_successfully }
    networks: [livetv, livetv-egress]
```

- Networks (defined always, like `updater`): `livetv` (`internal: true`; backend, gateway and livetv join it) and
  `livetv-egress` (normal bridge; only livetv). Backend and gateway gain `livetv` in their `networks`; the gateway also mounts
  `${RECORDINGS_PATH:-recordings}:/data/recordings:ro` (Phase 3). Volumes `livetv-cache`, `recordings` are added to `volumes:`.
- Env-only keys (`ENV_ONLY_KEYS`): `LIVETV_URL` (backend and gateway; default `http://livetv:8090`).
- **GPU overlays** (new files, opt-in like `compose.plex.yaml`):
  - `compose.livetv-gpu.yaml` (Intel/AMD): `livetv: { devices: ["/dev/dri:/dev/dri"], group_add: ["${RENDER_GID:?set RENDER_GID}"] }`.
  - `compose.livetv-nvidia.yaml`: `deploy.resources.reservations.devices: [{ driver: nvidia, count: 1, capabilities: [gpu, video] }]`.
  - The updater already re-uses the compose files the stack was started with (`updater/src/docker.ts` `refreshFiles`), so an
    overlay added to `COMPOSE_FILE` stays on updates.

### 3.2 Internal API (port 8090, only on the `livetv` network)

Every `/v1/*` request is HMAC-signed like the updater (`signUpdater` scheme, key label `friendflix-livetv/v1` derived from
`INTERNAL_SECRET`, timestamp + nonce, 60 s window, replay refused; shared test vectors `test-vectors/livetv-hmac.json`).
`/s/*` (stream files) is unsigned but reachable only on the internal network and addressed by a 128-bit random `streamKey`.

| Method & path | Body → answer |
|---|---|
| `GET /healthz` | `{ ok, version }` (unsigned) |
| `GET /v1/system` | `{ cpu: { model, cores, loadPct }, gpu: { devices: string[], driver: string \| null, readable: boolean, busyPct: number \| null }, encoders: Array<'h264_qsv'\|'h264_vaapi'\|'h264_nvenc'\|'libx264'>, cache: { usedBytes, maxBytes }, recordings: { usedBytes, freeBytes } \| null }` |
| `POST /v1/fetch/m3u` | `{ url, userAgent?, allowLan }` → `{ entries: [{ key, name, tvgId?, tvgName?, chno?, group?, logo?, url, kind }], skipped: { vod, invalid, overLimit } }` |
| `POST /v1/fetch/xmltv` | `{ url, userAgent?, allowLan, channels?: string[], from, to }` → NDJSON stream: `{ t:'channel', id, names[] }` / `{ t:'prog', ch, start, end, title, subtitle?, desc?, cats?, episode?, seriesId?, isNew?, prevShown?, rating? }` |
| `POST /v1/fetch/logo` | `{ url, allowLan }` → image bytes (`image/png \| jpeg \| webp`) or 422 |
| `POST /v1/probe` | `{ input }` → `{ ok, video?: { codec, width, height, fps }, audio?: { codec, channels }, needs: 'passthrough'\|'remux'\|'transcode', error?: code }` (10 s budget) |
| `POST /v1/streams` | `{ channelId, input, mode, encoder, dvrSeconds, maxBitrate }` → `{ streamKey, state:'starting'\|'running' }` (idempotent per `channelId`) |
| `GET /v1/streams` | running streams: `{ channelId, streamKey, mode, since, state, bitrate, errors, lastSegmentAt }[]` |
| `DELETE /v1/streams/:channelId` | stop now |
| `GET /v1/streams/:channelId/preview.jpg` | latest keyframe snapshot (320 px wide, refreshed ≤ every 60 s while running; 404 when not running) |
| `POST /v1/benchmark` | `{ encoder }` → `{ speed, encoder, seconds }` (20 s of 1080p25 `testsrc2` → H.264 6 Mbit/s → null) |
| `POST /v1/recordings` (Phase 3) | `{ id, input, mode, encoder, dir, startAt, endAt }` → `{ state }` |
| `DELETE /v1/recordings/:id` (Phase 3) | stop (keeps files) · `POST /v1/recordings/:id/delete` removes files · `POST /v1/recordings/:id/export` copies/concats into the library folder |
| `GET /s/<streamKey>/<file>` | `index.m3u8`, `init.mp4`, `<n>.ts` / `<n>.m4s` for the gateway |

`input` = `{ url, kind: 'hls'|'ts'|'srt', userAgent?, allowLan }`, decrypted by the backend just before the call.

### 3.3 Stream modes

| Source | Default mode | Counts against budget |
|---|---|---|
| Provider/own **HLS** | **passthrough**: `livetv` acts as an HLS proxy. It picks one variant (highest bandwidth ≤ `maxBitrate`, default 10 Mbit/s, H.264 preferred), fetches its media playlist and segments once for all viewers, stores segments in the DVR cache, serves its own playlist with local names (`<seq>.ts` / `<seq>.m4s`, `init.mp4`). Provider URLs never leave `livetv`. | no |
| **MPEG-TS** over HTTP | **remux**: `ffmpeg -c:v copy`, audio copied when AAC/MP3, else AAC stereo 160 kbit/s (audio-only conversion is cheap and is **not** counted), HLS 4 s segments | no |
| **SRT** (caller) | probe → **remux** when H.264 + AAC/MP3 (or audio-only conversion as above), else **transcode** | only when transcoding |
| any source whose video is not H.264 (HEVC, MPEG-2) | **transcode**: H.264 High ≤ 1080p, 6 Mbit/s (720p: 3 Mbit/s), GOP 2 s, AAC stereo, HLS 4 s; encoder per `LIVETV_ENCODER` (§5.4) | yes |

- **One stream per channel** for all viewers; viewers join a running stream without any new work.
- **DVR window**: `LIVETV_DVR_MINUTES` (0–30, default 30) of segments on disk; the playlist is a sliding live playlist whose
  window is the DVR length (no `EXT-X-PLAYLIST-TYPE`), so hls.js and Safari offer pause and rewind inside it. When
  `livetv-cache` passes `LIVETV_CACHE_MAX_GB`, the oldest segments of the stream with the longest window are dropped first
  (windows shrink, never the live edge).
- **Stop**: the backend stops a stream 60 s after its last viewer left (§7.4). Safety net inside `livetv`: a stream with no
  `/s/` fetch for 180 s stops by itself.
- **Reconnect**: input errors retry with backoff 2, 4, 8, 15, 30 s (then every 30 s) while viewers exist; segments continue
  with a discontinuity; each outage is an event (`input_lost`, `input_back`, seconds) reported in `GET /v1/streams`.
- **Previews**: only for running streams (a keyframe of the newest segment, never a stream started for a picture).
- **Logging**: ffmpeg runs with `-hide_banner -loglevel error`; its stderr lines pass a URL scrubber (`[a-z]+://\S+` →
  `<input>`, `user`/`pass`/`token`/`key` query values → `•••`) before they are logged; arguments are never logged; logs name
  the channel id only.

### 3.4 Fetch safety (SSRF and hostile files)

Implemented in `livetv` (`src/netguard.ts`), mirrored by backend validation on save:

- **Schemes:** `http`, `https`, `srt` only. No credentials-in-userinfo rewriting tricks: userinfo is allowed (some providers
  use it) but stays secret like the rest.
- **Address check after DNS:** the host is resolved once; every address must be public unicast. Always refused: loopback,
  `0.0.0.0/8`, link-local (`169.254.0.0/16`, `fe80::/10`, which includes cloud metadata), multicast, `100.64.0.0/10`, the
  container networks' own subnets (read from the interfaces at start), and single-label host names (Docker service names
  such as `backend`, `postgres`). Private ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`) only when the source has
  **LAN erlauben** (`allow_lan`). The connection is made to the checked address (custom `lookup`), so DNS rebinding cannot
  switch it; redirects (max 3) are checked again; a redirect to another scheme is refused.
- **Limits:** M3U ≤ 50 MB, line ≤ 8 KB, ≤ 20 000 live entries kept per source (more → the first 20 000, warning
  `over_limit`); XMLTV ≤ 300 MB transferred, gzip allowed, ≤ 1 GB decompressed and a 20:1 ratio guard, streamed SAX parser with
  DTD, entities and external references disabled, ≤ 300 000 programmes per refresh, text fields cut (title 200, sub-title
  200, description 2 000 chars), programmes outside [now − 1 day, now + 7 days] skipped, invalid times skipped; logos
  ≤ 512 KB, PNG/JPEG/WebP by magic bytes only (SVG refused); playlists for passthrough ≤ 2 MB, segments ≤ 50 MB; timeouts
  (connect 10 s, M3U 60 s, XMLTV 10 min, logo 10 s).
- **VOD filter:** M3U entries whose path contains `/movie/` or `/series/` or ends in `.mp4|.mkv|.avi|.mov` are skipped
  (`skipped.vod`).
- The backend never follows provider URLs; `POST /api/admin/livetv/sources/test` only asks `livetv`.

## 4. Enabling, disabling and detection

### 4.1 Detection

- The backend polls `GET ${LIVETV_URL}/healthz` every 60 s (and on every admin page load of the area, cached 10 s).
  `installed = reachable && version compatible`. A setting `LIVETV_WANTED` (internal, not shown) remembers that an admin turned
  it on, so "wanted but not reachable" can be told apart from "never enabled".
- `/api/me` gains `features.livetv: boolean` = installed ∧ `perms.liveTv` ∧ the active profile sees ≥ 1 channel (cached
  60 s per profile, invalidated on rights/group changes). It drives the tab.

### 4.2 Updater actions

`updater/src/server.ts` gains one route `POST /v1/livetv` with a body that is exactly `{ op: 'enable' }`,
`{ op: 'disable' }` or `{ op: 'remove', data: boolean }` (anything else refused, like `parseChannelBody`):

- **enable**: pull `livetv` at the current tag (cosign verify as for the others, `IMAGE_OF.livetv = 'livetv'`), `up -d
  --no-deps --pull never livetv` with `--profile livetv` added, wait for health (2 min). State `livetv: 'enabled'` in
  `/state`. From then on every compose command of the updater adds `--profile livetv` and updates include `livetv` in
  `FF_SERVICES` / `HEALTH_SERVICES`, so it follows the channel like the other images.
- **disable**: `compose stop livetv` + `compose rm -f livetv`; state `disabled`.
- **remove**: disable + `docker image rm` of the livetv image; with `data: true` also the `livetv-cache` volume. The
  recordings volume is **never** removed by the updater (the admin deletes recordings in FriendFlix first, §15.9).
- Job steps reuse the job model (`pull`, `verify`, `restart`, `health`); `GET /v1/status` gains
  `livetv: { state: 'enabled'|'disabled'|'absent', container: 'running'|'exited'|null }`. Foreign stacks (Portainer) are
  refused as for updates (`foreign_stack`).
- Backend: `updater.ts` gains `UpdaterAction 'livetv'` with the op; routes `POST /api/admin/livetv/enable|disable` call it.

### 4.3 Without the updater (or a foreign stack)

The enable page shows the exact line and command, with a copy button:

```
COMPOSE_PROFILES=livetv          (steht dort schon COMPOSE_PROFILES, hänge ,livetv an)
docker compose up -d
```

and, when the stack runs from Portainer, "In Portainer: Umgebungsvariable COMPOSE_PROFILES=livetv im Stack setzen und neu
bereitstellen." Disabling shows `docker compose stop livetv && docker compose rm -f livetv` and removing the line. Even with
the updater, the panel shows a quiet tip: "Damit Live-TV auch nach `docker compose down` wieder startet, trage
COMPOSE_PROFILES=livetv in die .env ein."

### 4.4 GPU setup check

After enabling (and on the *Live-Status* tab) the backend compares Jellyfin's encoder settings (`encoderSettings().hwAccel`)
with `GET /v1/system`:

| Situation | Message (DE) |
|---|---|
| Jellyfin `qsv`/`vaapi`, livetv has no `/dev/dri` | "Jellyfin nutzt die Grafikeinheit, Live-TV noch nicht. Füge `compose.livetv-gpu.yaml` zu COMPOSE_FILE hinzu, setze RENDER_GID (Befehl: `getent group render \| cut -d: -f3`) und starte neu." |
| `/dev/dri` present, not readable | "Live-TV sieht die Grafikeinheit, darf sie aber nicht benutzen: RENDER_GID in der .env setzen." |
| Jellyfin `nvenc`, livetv without NVIDIA | "… `compose.livetv-nvidia.yaml` hinzufügen …" |
| Jellyfin `none` | "Umwandlungen laufen auf dem Prozessor." (info) |
| both use the GPU | "Grafikeinheit: {driver} · auch für Live-TV aktiv." (ok) |

Only remuxed/passthrough channels work fine without a GPU; the message is advice, never a blocker.

### 4.5 Admin entry before installation

- Admin nav, group *Inhalte*: **Live-TV** with a small *optional* chip, leading to `/admin/livetv` which then shows only the
  enable card: what it is (3 lines), what it needs ("ein zusätzlicher Container, ca. 250 MB; Senderlisten von deinem Anbieter
  oder eigene Streams"), *Live-TV aktivieren* (updater) or the `.env` instructions, and *Nicht mehr anzeigen*.
- *Nicht mehr anzeigen* sets `LIVETV_OFFER_HIDDEN = true` (DB setting, group `general`); Admin → Einstellungen → Allgemein
  shows the switch *Optionales Modul Live-TV anbieten* to bring it back.
- While enabling: the card shows the updater job steps (the existing update progress component), then the detection result.
  After success the full area appears (no reload needed: the page polls `GET /api/admin/livetv/state` every 3 s while a job runs).
- Disabling: *Live-Status* → *Live-TV ausschalten* opens a dialog with two checkboxes: *Image entfernen* and *Zwischenspeicher
  löschen* (cache volume); recordings are mentioned ("Aufnahmen bleiben erhalten") with a link to delete them. All channel
  configuration stays in the database, so enabling later restores everything.

## 5. Shared conversion budget (Phase 1a)

### 5.1 What counts

A **conversion** is any running job that re-encodes **video**:

| Kind (`ConvKind`) | Counted when | Source of truth |
|---|---|---|
| `film` | a Jellyfin session whose `videoDirect === false`, or `playMethod === 'Transcode'` with `videoDirect` unknown (fail-safe), from FriendFlix or any other client | `ctx.jf.admin.transcodeSessions()` (Plex: its adapter's sessions) |
| `film` (pending) | a grant handed out in the last 30 s whose session the server does not list yet | KV `conv:grant:*` (the HEVC grant mechanism, generalised) |
| `hevc` | subset of `film` with HEVC output; still limited by `HEVC_STREAMS` and the HEVC probe rules | as today |
| `live` | a running `livetv` stream in mode `transcode` | `livetv GET /v1/streams` (cached 5 s) |
| `record` | a running recording in mode `transcode`, plus reserved slots of recordings starting within 5 min | `livetv` + KV `conv:resv:<recordingId>` |
| `download` | a download preparation that transcodes (`downloadprep.ts`) | its job state |
| `reencode` | the later H.265 re-encode of recordings | its job state |

Not counted: direct play, direct stream/remux (video copied), passthrough, audio-only conversion, preview clips (short,
already paused while anyone watches), the benchmark itself.

### 5.2 Limit and priority

- Setting `CONVERSION_SLOTS` (DB, group `playback`, int 1–16, **unset = automatic**): automatic = the measured recommendation
  (§5.3), or **2** while nothing is measured. An admin value overrides; the card shows both.
- Setting `CONVERSION_PRIORITY` (enum `films` | `live` | `equal`, default `films`). Rule with `limit L`, used `U`,
  `holdback H = (L ≥ 2 && priority ≠ 'equal') ? 1 : 0`:
  - recordings (`record`) at their start: admitted when `U < L`, not counting their own reservation (their slot is reserved from start − padding − 5 min, so new
    viewers cannot take it; a reservation is only refused when reservations alone already fill `L`, which the scheduling
    conflict warning prevents, §15.4);
  - the preferred kind (`film` for `films`, `live` for `live`): admitted when `U < L`;
  - the other of the two: admitted when `U < L − H`;
  - `download` and `reencode`: admitted when `U < L − H − 1` (they wait, never refused; `reencode` only in quiet hours).
- Running conversions are **never** stopped by the budget. Sessions of other Jellyfin apps count but cannot be refused (they
  may push `U` above `L`; then nothing new is admitted until it drops).
- `HEVC_STREAMS` stays as a cap for HEVC conversions inside the budget (an HEVC conversion needs both an HEVC slot and a
  budget slot); the "below 3× real time only one HEVC conversion" rule stays.

### 5.3 Benchmark and recommendation

- `backend/src/convbench.ts` (built from `probeHevcEncoder`): a Jellyfin **H.264** clip conversion at 1080p / 6 Mbit/s,
  seven 3-s segments (21 s of media), timed like the HEVC probe; `speed = media seconds / wall seconds`. Never while anything
  converts or anyone watches (`hevcBusyReason`), previews paused, one at a time (KV claim). Result in KV `conv:bench`
  `{ speed, hwAccel, fingerprint, at }` for 30 days; a change of the encoder settings fingerprint makes it stale.
- With `livetv` installed: `POST /v1/benchmark` with the encoder `livetv` would use; stored as `conv:bench:livetv`.
- **Recommendation** = `clamp(floor(min(speedJellyfin, speedLivetv?) × 0.7), 1, 16)` (30 % safety margin; e.g. 4.6× → 3).
  Below 1.0× the card warns "Der Server schafft keine Umwandlung in Echtzeit." and recommends 1.
- When it runs: on *Live-TV aktivieren*, on *Neu messen*, and once automatically after the update that ships Phase 1a when
  the server is idle (same 10-minute idle tick as `hevcTick`; one attempt per 30 min until it succeeded once).
- Shown with it: Jellyfin's hardware acceleration, livetv's CPU model / cores / load and GPU device + driver (§4.4); GPU load
  only where the kernel exposes it without privileges (`gpu_busy_percent` on AMD), else "–".

### 5.4 Encoder for `livetv`

Setting `LIVETV_ENCODER` (`auto` | `qsv` | `vaapi` | `nvenc` | `software`, default `auto`): `auto` = Jellyfin's
`hwAccel` when `livetv` can use that device, else `vaapi` when `/dev/dri` is usable, else `nvenc` when present, else
`software` (`libx264 -preset veryfast`). The benchmark uses the same choice.

### 5.5 Gate in `/api/playback/info` (films and series)

`convbudget.ts` exports `admitConversion(ctx, { kind, userId, deviceId?, hint })` (KV lock + count + grant, the `hevcGate`
pattern; unreadable session list within 800 ms = busy). In `routes/media.ts` after `playbackInfo`:

1. If `info.delivery.video` is `copy` (or there is no HLS plan) → nothing to admit.
2. Else admit `film`. Granted → as today (grant bound to the play session, `bindHevcGrant` generalised).
3. Refused → **fallback**: ask the media server again with the new `PlaybackOpts.noConvert` (stream plan: video copy only,
   `videoCodecs` = the source codec; the role ceiling still applies). If that yields `delivery.video === 'copy'` → answer it with `capReason: 'serverBusy'` (the player
   shows its existing quality chip reason "Server ausgelastet"). If not (the device cannot take the original, or the role
   caps the bitrate below the source) → `503 { error: 'server_busy' }`; the player shows "Server gerade ausgelastet. Versuch es
   gleich noch einmal." with *Erneut versuchen*.
4. An HEVC conversion refused by the budget falls back to H.264 only if an H.264 conversion is admitted (it is still a
   conversion); otherwise step 3.

Cast (`routes/cast.ts`) uses the same gate. A quality switch or audio change of the same device replaces its own running
conversion (its own session is not counted, as in `hevcGate`).

### 5.6 Admin UI (Admin → *Wiedergabe*, new first card *Umwandlungen*)

- Big number "2 von 3 belegt" with a slot bar (`3` segments, filled by kind: film / live / recording / other, icon + label per
  segment, never colour only); list of what runs (kind icon, label: title or channel name, since, device); *Neu messen* button
  (disabled with reason while busy).
- "Gemessen 4,6× Echtzeit (Jellyfin, Intel QSV) · Live-TV 3,9× · empfohlen 3 · geprüft heute 03:10".
- *Gleichzeitige Umwandlungen*: segmented *Automatisch (3)* / *Eigener Wert* + number stepper 1–16.
- *Vorrang*: *Filme & Serien zuerst* / *Live-TV zuerst* / *Gleichrangig*, with a one-line explanation ("Live-TV lässt einen
  Platz für Filme frei.").
- The same card (read-only, with a link) appears on *Live-Status*.

## 6. Data model

### 6.1 Migration 47 (Phase 1c) — Live TV core

Numbers are the next free ones after Phase 0's 46 at the time of writing; if another migration lands first, take the next free
number, never reorder.

```sql
-- 47: Live TV core. Sources and channel stream URLs are stored encrypted (APP_ENC_KEY blob, like settings.enc); *_hint is a
-- masked display form (scheme://host/…) for the admin. Import fields (import_*) are rewritten by every refresh; admin
-- overrides (*_override, hidden, group_id) never are. Programmes are EPG facts only (no user data) and are pruned daily.
create table livetv_sources (
  id uuid primary key,
  kind text not null check (kind in ('m3u','manual')),
  name text not null check (char_length(name) between 1 and 60),
  url_enc text,                       -- m3u only
  url_hint text,
  epg_url_enc text,
  epg_hint text,
  user_agent text check (char_length(user_agent) <= 200),
  allow_lan boolean not null default false,
  refresh text not null default '24h' check (refresh in ('6h','12h','24h','weekly','manual')),
  auto_roles text[] not null default '{admin,family,friend}', -- roles new provider groups are granted to
  number_base int not null default 1,
  max_streams int check (max_streams between 1 and 50), -- provider's limit of channels at once; null = unknown
  enabled boolean not null default true,
  position int not null default 0,
  last_refresh_at timestamptz, last_ok_at timestamptz, last_error text, last_counts jsonb,
  epg_last_refresh_at timestamptz, epg_last_ok_at timestamptz, epg_last_error text, epg_counts jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((kind = 'm3u') = (url_enc is not null))
);
create table livetv_groups (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 40),
  kid_friendly boolean not null default false,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create unique index livetv_groups_name on livetv_groups(lower(name));
create table livetv_group_map (           -- provider group-title -> group
  source_id uuid not null references livetv_sources(id) on delete cascade,
  provider_group text not null,
  group_id uuid not null references livetv_groups(id) on delete cascade,
  primary key (source_id, provider_group)
);
create table livetv_group_roles (
  group_id uuid not null references livetv_groups(id) on delete cascade,
  role text not null references roles(key) on delete cascade, -- roles table from migration 46 (Phase 0)
  primary key (group_id, role)
);
create table livetv_group_users (         -- per-user exception: allow = true adds, false removes
  group_id uuid not null references livetv_groups(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  allow boolean not null,
  primary key (group_id, user_id)
);
create table livetv_channels (
  id uuid primary key,
  source_id uuid not null references livetv_sources(id) on delete cascade,
  source_key text not null,               -- tvg-id, else sha256(name + url without query)[0..32]
  stream_url_enc text not null,
  stream_kind text not null check (stream_kind in ('hls','ts','srt')),
  allow_lan boolean,                      -- manual feeds; null = the source's value
  import_name text not null, import_number int, import_group text, import_logo_hash text, tvg_id text, tvg_name text,
  name_override text check (char_length(name_override) between 1 and 60),
  number_override int check (number_override between 1 and 99999),
  group_override uuid references livetv_groups(id) on delete set null,
  logo_override_hash text,
  hidden boolean not null default false,
  epg_source_id uuid references livetv_sources(id) on delete set null,
  epg_channel_id text,
  epg_match text not null default 'auto' check (epg_match in ('auto','manual','none')),
  probe jsonb,                            -- last probe: { at, ok, video, audio, needs }
  missing_since timestamptz,              -- not in the latest import; deleted 30 days later
  created_at timestamptz not null default now(),
  unique (source_id, source_key)
);
create index livetv_channels_epg on livetv_channels(epg_source_id, epg_channel_id);
create table livetv_logos (
  hash text primary key,                  -- sha256 of the bytes
  mime text not null check (mime in ('image/png','image/jpeg','image/webp')),
  bytes bytea not null check (octet_length(bytes) <= 524288),
  fetched_at timestamptz not null default now()
);
create table livetv_epg_channels (
  source_id uuid not null references livetv_sources(id) on delete cascade,
  xml_id text not null,
  names text[] not null,
  primary key (source_id, xml_id)
);
create table livetv_programmes (
  id bigserial primary key,
  source_id uuid references livetv_sources(id) on delete cascade, -- imported
  xml_channel text,
  channel_id uuid references livetv_channels(id) on delete cascade, -- manual entries (Phase 2)
  rule_id uuid,                                                      -- manual rule (Phase 2)
  start_at timestamptz not null,
  end_at timestamptz not null check (end_at > start_at),
  title text not null,
  subtitle text, description text, categories text[], episode text, series_key text,
  is_new boolean, previously_shown boolean, rating text,
  check ((source_id is not null and xml_channel is not null) or channel_id is not null)
);
create index livetv_programmes_src on livetv_programmes(source_id, xml_channel, start_at);
create index livetv_programmes_ch on livetv_programmes(channel_id, start_at) where channel_id is not null;
create index livetv_programmes_end on livetv_programmes(end_at);
create table livetv_favourites (
  profile_id uuid not null references profiles(id) on delete cascade,
  channel_id uuid not null references livetv_channels(id) on delete cascade,
  position int not null default 0,
  primary key (profile_id, channel_id)
);
create table livetv_last (
  profile_id uuid primary key references profiles(id) on delete cascade,
  channel_id uuid references livetv_channels(id) on delete set null,
  previous_id uuid references livetv_channels(id) on delete set null,
  at timestamptz not null default now()
);
alter table devices add column start_live boolean not null default false;
```

Derived values (one SQL view `livetv_channels_v` or a function in `livetv/channels.ts`): effective name =
`name_override ?? import_name`; number = `number_override ?? import_number ?? number_base + import position`; group =
`group_override ?? group_map(source, import_group)`; logo = `logo_override_hash ?? import_logo_hash`. Duplicate effective
numbers are allowed but flagged in the admin (number entry picks the channel with the lowest group position).

### 6.2 Migration 48 (Phase 2) — manual EPG and reminders

```sql
create table livetv_epg_rules (
  id uuid primary key,
  channel_id uuid not null references livetv_channels(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  description text check (char_length(description) <= 2000),
  kind text not null check (kind in ('once','weekly')),
  starts_at timestamptz,                         -- once
  weekdays smallint[],                           -- weekly, ISO 1-7
  start_time time, duration_min int check (duration_min between 1 and 1440),
  tz text not null default 'Europe/Vienna',      -- the server TZ at creation
  valid_from date, valid_until date,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'once' and starts_at is not null) or (kind = 'weekly' and weekdays is not null and start_time is not null))
);
alter table livetv_programmes add constraint livetv_programmes_rule foreign key (rule_id) references livetv_epg_rules(id) on delete cascade;
create table livetv_reminders (
  id uuid primary key,
  profile_id uuid not null references profiles(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  channel_id uuid not null references livetv_channels(id) on delete cascade,
  start_at timestamptz not null,
  title text not null,
  notified_at timestamptz,
  unique (profile_id, channel_id, start_at)
);
```

### 6.3 Migration 49 (Phase 3) — recordings

```sql
create table livetv_recording_rules (
  id uuid primary key,
  profile_id uuid not null references profiles(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('series','time')),
  channel_id uuid references livetv_channels(id) on delete cascade, -- null = all channels (series only)
  series_key text, title text not null,
  weekdays smallint[], start_time time, duration_min int, tz text,   -- time rules
  only_new boolean not null default true,
  keep_max int check (keep_max between 1 and 100),
  pad_before_s int, pad_after_s int,                                  -- null = settings default
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create table livetv_recordings (
  id uuid primary key,
  profile_id uuid references profiles(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  rule_id uuid references livetv_recording_rules(id) on delete set null,
  channel_id uuid references livetv_channels(id) on delete set null,
  channel_name text not null,
  title text not null, subtitle text, description text, episode text, series_key text,
  start_at timestamptz not null, end_at timestamptz not null, pad_before_s int not null, pad_after_s int not null,
  state text not null default 'scheduled' check (state in ('scheduled','recording','done','partial','failed','cancelled')),
  mode text check (mode in ('copy','remux','transcode')),
  storage text not null check (storage in ('ff','library')),
  dir text not null,                    -- uuid folder under /recordings
  library_path text,                    -- relative path inside the library folder once exported
  jellyfin_item_id text,
  bytes bigint not null default 0, duration_s int, gaps jsonb not null default '[]',
  error text,
  keep boolean not null default false,
  visibility text not null default 'private' check (visibility in ('private','account','everyone')),
  shared_by uuid references users(id) on delete set null,
  watched_at timestamptz, delete_warned_at timestamptz, delete_after timestamptz,
  created_at timestamptz not null default now()
);
create index livetv_recordings_due on livetv_recordings(start_at) where state = 'scheduled';
create index livetv_recordings_profile on livetv_recordings(profile_id, start_at desc);
create table livetv_recording_progress (
  profile_id uuid not null references profiles(id) on delete cascade,
  recording_id uuid not null references livetv_recordings(id) on delete cascade,
  position_s int not null, updated_at timestamptz not null default now(),
  primary key (profile_id, recording_id)
);
```

### 6.4 Settings (registry, new group `livetv`)

| Key | Kind | Default | Phase |
|---|---|---|---|
| `CONVERSION_SLOTS` | int 1–16, unset = automatic | unset | 1a (group `playback`) |
| `CONVERSION_PRIORITY` | enum films / live / equal | films | 1a (group `playback`) |
| `LIVETV_OFFER_HIDDEN` | bool | false | 1b (group `general`) |
| `LIVETV_WANTED` | bool, `visible: false` | false | 1b |
| `LIVETV_ENCODER` | enum auto / qsv / vaapi / nvenc / software | auto | 1c |
| `LIVETV_DVR_MINUTES` | int 0–30 | 30 | 1d |
| `LIVETV_MAX_BITRATE` | int bit/s 1–40 Mbit/s | 10 000 000 | 1d |
| `LIVETV_RECORD_STORAGE` | enum ff / library / both | ff | 3 |
| `LIVETV_RECORD_LIBRARY_ID` | string (Jellyfin library id) | – | 3 |
| `LIVETV_RECORD_LIMIT_GB` | number 1–100 000 | 200 | 3 |
| `LIVETV_RECORD_RETENTION_DAYS` | int 0–365 (0 = off) | 30 | 3 |
| `LIVETV_RECORD_PAD_BEFORE_MIN` / `_AFTER_MIN` | int 0–30 / 0–120 | 2 / 5 | 3 |
| `LIVETV_RECORD_MAX_PARALLEL` | int 1–8 | 4 | 3 |
| `LIVETV_REENCODE` + `LIVETV_REENCODE_HOURS` | bool + "HH:MM-HH:MM" | false, 01:00-06:00 | later |

Env-only: `LIVETV_URL`; compose-only (not settings): `LIVETV_CACHE_MAX_GB`, `RECORDINGS_PATH`, `RENDER_GID`.

## 7. Watching: tokens, gateway, shared streams

### 7.1 Token model (`backend/src/livetv/tokens.ts`, modelled on `cast.ts`)

- Token: 32 random bytes, base64url (43 chars, `CAST_TOKEN_RE` shape); KV stores only `sha256(token)` →
  `{ userId, profileId, deviceId, channelId | recordingId, kind: 'live'|'rec', via: 'local'|'chromecast'|'airplay', exp }`.
- Idle TTL **90 s** sliding (touched by gateway fetches and heartbeats at most every 20 s), absolute cap **12 h** (live) /
  remaining duration + 1 h (recordings, as cast). Renewed by the client before the cap.
- **Pinning:** first client address pins (`ltvpin:`); `local` tokens may re-pin through a heartbeat from the same session
  (a phone moving from Wi-Fi to mobile data); `chromecast` one address, `airplay` two addresses within 120 s (the cast rules).
- Max **4** live tokens per account (more than any sensible household device count for one person; the oldest is revoked).
- Revoked on: stop, channel switch (old token revoked when the new one is minted), logout, profile switch, device removal, the
  account being locked, the channel being hidden or the profile losing the group (checked at every authz, memo 2 s).
- Never logged, never stored in browser storage, never in metrics labels or Diagnose output.

### 7.2 Routes

- `POST /api/livetv/channels/:id/watch` `{ via?: 'local'|'chromecast'|'airplay' }` → 200
  `{ token, url: '/media/l/<token>/index.m3u8', expiresAt, dvrSeconds, mode: 'passthrough'|'remux'|'transcode', channel: {…},
  now, next }`; errors: 403 `forbidden` (no right / hidden), 404, **503 `live_full`** with
  `{ running: [{ id, number, name, logo }] }` (running channels **this profile may see**), 502 `channel_unreachable` (first
  start failed after 15 s), 429 `max_streams` (the account's `maxStreams` from Phase 0 rights; a live view counts as a stream,
  see §7.4; the calling device's own current live view is replaced by the new one and not counted). Rate limit 30/min.
- `POST /api/livetv/beat` `{ token }` → `{ ok, expiresAt }` every 20 s while the live player is open
  (playing **or** paused); 410 `gone` when the token was revoked (the client re-requests watch once).
- `DELETE /api/livetv/watch` `{ token }` (sent with `keepalive` on `pagehide` and on player close).
- `/internal/authz/live` `{ token, ip }` → `{ streamKey, kind, maxAgeS }` or 401/403/410; touches the viewer.

### 7.3 Gateway

- New route `/media/l/<token>/<file>`: file must match `^(index\.m3u8|init\.mp4|[0-9]{1,10}\.(ts|m4s))$`; authz via
  `/internal/authz/live` (memo 2 s per token+ip); proxied to `${LIVETV_URL}/s/<streamKey>/<file>`; playlists
  `cache-control: no-store`, segments `private, max-age=600`; CORS headers of the cast path (receivers fetch cross-origin);
  the token never reaches `livetv` or any log (the gateway's existing path scrubbing covers `/media/l/` like `/media/c/`).
- New route `/media/r/<token>/<file>` (Phase 3): same authz (`kind: 'rec'` → `dir`), served from `/data/recordings/<dir>/`
  with the download path's file-serving code (realpath inside the root, `O_NOFOLLOW`, ranges).
- Metrics: request counters per route class only (`live`, `rec`), never per channel.

### 7.4 Viewers, streams and limits

- A **viewer** = a live token touched within the last 45 s (KV `ltv:view:<hash>` with TTL). A Chromecast/AirPlay viewer is kept
  alive by the TV's own fetches, so a cast survives the sender tab closing.
- Live views are also written as live playback records (`live.ts` `setLive`, `source: 'livetv'`, `itemId: 'ch:<channelId>'`,
  title = channel name, `bitrate` = the stream's bitrate, `remote` flag): so they count against the account's `maxStreams`,
  appear in Admin → *Wiedergabe* streams, and the upload-aware cap (`uploadcap.ts`) counts remote live viewers.
- **Start:** `watch` on a channel that is not running: (1) budget: if the expected mode is `transcode` (from `probe`; SRT
  without a fresh probe counts as transcode) → `admitConversion('live')`, refused → 503 `live_full`; (2) `POST /v1/streams`;
  (3) wait for the first segment (≤ 15 s; the client shows "Sender wird gestartet …"); (4) when the probe at start says
  `remux` after all, the slot is released.
- **Stop:** `livetvTick` (every 15 s, one runner via KV lock `ltv:tick`) stops a stream whose viewer count has been 0 for 60 s
  and no recording uses it (§15). Admin *Stoppen* stops it at once (viewers see the error state).
- **Join:** a viewer on a running channel never touches the budget.

## 8. Rights

- **Effective channel set of a profile** (`livetv/rights.ts`, cached 60 s, invalidated on any group/channel/rights write):
  1. Account lacks `liveTv` (Phase 0 rights, kids overlay included) → no channels.
  2. Groups allowed = groups granted to the account's role (`livetv_group_roles`), plus `livetv_group_users.allow = true`,
     minus `allow = false`. Admin role: all groups.
  3. Kids profile → only allowed groups that are `kid_friendly` (a kids profile of an admin account sees kid-friendly groups
     only). No kid-friendly group → no tab.
  4. Channels: in those groups, not `hidden`, not `missing_since`, source enabled.
- New groups created by an import are granted to the source's `auto_roles` (default admin, family, friend); a guest gets nothing
  until the admin grants a group to the guest role or to that person.
- **Recording** (Phase 3): `liveRecord` (Phase 0 permission; default ✓ for admin/family/friend, – for guest; never kids) and
  the channel must be in the profile's set.
- **Favourites** and *last channel* are per profile; a favourite of a channel the profile can no longer see is hidden (not
  deleted) and comes back if the right returns.
- Phase 0 integration: the role matrix shows *Live-TV* (switch), *Darf aufnehmen* (switch) and *Kanalgruppen* (chips: "Sport,
  Nachrichten +2"); the person's *Rechte* tab shows group exceptions; *Sicht prüfen* shows the profile's groups and channel
  count with reasons ("nicht kinderfreundlich", "für Gast nicht freigegeben").

## 9. Admin area (`/admin/livetv`, after installation)

Nav entry *Live-TV* (group *Inhalte*; badge red with the number of sources whose last refresh failed). Tabs in the URL
(`?tab=`), the `AdminShell` header, the glass admin components (`AdminCard`, `DataTable` with server paging, `StatusPill`,
`StatTile`, `Toggle`, `Select`, `Field`, `ActionMenu`, `confirm`, `runAction` + undo toasts). Phone: tabs become a scrolling
chip row; tables become row cards (the existing `DataTable` phone mode).

### 9.1 Quellen

- One `AdminCard` per source: name, kind chip (*Anbieterliste* / *Eigene Streams*), masked URL ("https://iptv.example.com/…"),
  *EPG* line, refresh interval select, state line ("Zuletzt aktualisiert heute 06:12 · 412 Sender (+3 / −1) · EPG 6 812
  Sendungen" or the error in words, §19), *Jetzt aktualisieren* (spinner in the button, result toast), menu *Bearbeiten*,
  *Deaktivieren*, *Löschen* (confirm names how many channels go; their overrides go too).
- *Quelle hinzufügen* sheet: kind; for lists: name, M3U URL (password-type field with *anzeigen*; on edit the field is empty
  with "unverändert lassen"), optional XMLTV URL, user agent (advanced), *LAN erlauben*, interval, *Neue Gruppen freigeben
  für* (role chips). *Prüfen* runs `POST /sources/test` and shows "412 Sender in 18 Gruppen · EPG: 398 Kanäle" plus five sample
  names, or the error, before *Speichern*.
- Own feeds (*Eigene Streams* source, created on first use): *Stream hinzufügen* sheet: name, URL (`https://…m3u8`,
  `http://…ts`, `srt://192.0.2.10:9000?…`), kind auto-detected from the URL (editable), number, group, *LAN erlauben*,
  *Testen*.

### 9.2 Kanäle

- Toolbar: search (name, number, tvg-id), filter chips *Quelle ▾*, *Gruppe ▾*, *Sichtbar / Ausgeblendet / Fehlt*,
  *Ohne Programm*, *Mit Fehler*; result count; view toggle *Liste / Reihenfolge*.
- **Liste:** `DataTable`, server paging (100/page, lists of 20 000 channels stay fast): checkbox, logo (40 px tile on the
  glass, fallback = the number in a tile), number, name (edited inline on double click / Enter), group (inline select), source,
  stream kind chip (*HLS* / *TS* / *SRT*), mode chip from the last test (*Durchgereicht* / *Umverpackt* / *Umgewandelt*), EPG
  state (*Programm* ✓ / *Kein Programm*), visibility toggle, menu (*Testen*, *Logo ändern*, *Zurücksetzen* = drop overrides).
  Overridden values show a small dot with "geändert (Import: …)".
- **Bulk bar** (selection across pages kept by id): *Ausblenden*, *Einblenden*, *Gruppe ändern…*, *Ab Nummer … durchnummerieren*,
  *Überschreibungen zurücksetzen*, *Testen* (max 20 at a time, sequential, results in a sheet).
- **Reihenfolge** view (one group or one source, ≤ 500 rows): drag handles (pointer and touch) with the moving row lifted by
  `transform` only and the others sliding (FLIP with transform); keyboard: focus handle, Space to pick up, ↑/↓ to move, Space
  to drop, Escape to cancel (announced). *Speichern* renumbers the shown channels in the new order starting at the smallest
  number in the set (`PUT /channels/order`).
- **Stream test** (`POST /channels/:id/test`): a sheet with a 10-s preview player (the live player in a small frame, muted, a
  temporary admin token) and the probe facts ("H.264 1920×1080 25 fps · AAC 2.0 · wird umverpackt"); failures in words.
- **Logo:** preview at the sizes users see (list, tile, TV); *Eigenes Logo hochladen* (PNG/JPEG/WebP ≤ 512 KB, checked by magic
  bytes, stored in `livetv_logos`).

### 9.3 Gruppen & Rechte

- Group list (drag order like channels): name, channel count, *Kinderfreundlich* toggle, role chips (which roles see it),
  provider groups mapped into it ("aus: DE | Sport, Sport HD"). *Gruppe anlegen*, *Zusammenführen…* (merge: maps the provider
  groups of the selected groups into one and deletes the rest), *Umbenennen*, *Löschen* (channels fall back to *Ohne Gruppe*,
  which only admins see).
- Matrix toggle *Nach Rolle*: groups × roles grid of switches (the Phase 0 matrix style), plus a *Personen mit Ausnahmen*
  list (person, +groups, −groups, link to their *Rechte* tab).
- Kids preview line: "Kinderprofile sehen: Kinderinsel, Natur & Tiere (23 Sender)".

### 9.4 Programmführer (Phase 2; Phase 1 shows only the automatic match counts)

- Counters: "398 von 412 Sendern mit Programm · 14 ohne". **Ohne Programm** list: channel, up to three suggestions
  ("Nordlicht TV HD · 92 %") from the EPG channel names (bigram Dice similarity on normalised names, ≥ 0.5), *Übernehmen*,
  *Andere wählen…* (search all EPG channels of all sources), *Kein Programm* (sets `epg_match = 'none'`).
- **Eigene Einträge** (own feeds and any channel): list of rules and single entries; *Eintrag hinzufügen* sheet: channel,
  title, description, *Einmalig* (date, start, end) or *Wöchentlich* (weekday chips, start, duration, valid from/until).
  Rules are expanded 8 days ahead by the EPG tick; times are in the server time zone and stored as UTC.

### 9.5 Live-Status

- Top: the budget card (§5.6, read-only) and system tiles: *Laufende Sender*, *Zuschauer*, *CPU* (%), *GPU* (or "–"), *DVR-Speicher*
  ("3,1 von 6 GB").
- **Laufende Sender** table: logo, name, mode chip, viewers (count only: who watches is in Admin → *Wiedergabe* like films),
  since, bitrate, input state (*läuft* / *verbinde neu (3)* / *gestört*), menu *Stoppen*, *Neu starten*.
- **Ereignisse** (last 200, KV ring, no URLs): time, level (icon + word), channel, text ("Eingang verloren · 12 s bis zur
  Wiederverbindung", "Start abgelehnt: alle Plätze belegt", "Quelle Anbieter A: Aktualisierung fehlgeschlagen (Zeitüberschreitung)").
- GPU setup message (§4.4), version of `livetv`, *Live-TV ausschalten…*.

### 9.6 Aufnahmen (Phase 3)

Storage mode (*FriendFlix-Ordner* / *Jellyfin-Bibliothek* / *Beides*), library select (Jellyfin libraries; with the note
"Aufnahmen in der Bibliothek sieht jede Person, die diese Bibliothek sieht"), limit (GB) with a usage bar ("143 von 200 GB ·
noch ca. 41 h in HD"), retention (*Nach dem Ansehen löschen nach … Tagen* / *nie*), padding defaults, max. parallel
recordings, list of all scheduled and running recordings (owner profile, channel, time, mode, state) with *Abbrechen*, and
failed ones with the reason.

## 10. Backend modules and APIs

`backend/src/livetv/` — `client.ts` (signed calls to `livetv`), `sources.ts` (CRUD, refresh, import merge), `channels.ts`,
`groups.ts`, `rights.ts`, `epg.ts` (import, prune, rules expansion, now/next, blocks), `tokens.ts`, `streams.ts` (start,
join, stop, tick), `logos.ts`, `recordings.ts` (Phase 3), `events.ts` (KV ring), `routes.ts` (user), `adminRoutes.ts`.
`backend/src/convbudget.ts`, `convbench.ts`.

**Admin** (all `requireAdmin`; writes audited `livetv.*` with ids and changed field names only, never URLs):

| Route | Notes |
|---|---|
| `GET /api/admin/livetv/state` | `{ installed, reachable, version, wanted, offerHidden, updater: { available, stack, job }, envLine: 'COMPOSE_PROFILES=livetv', gpu: { jellyfin, livetv, advice } }` |
| `POST /api/admin/livetv/enable` · `POST /api/admin/livetv/disable { removeImage, removeCache }` | 202 `{ job }`; 409 `no_updater` / `foreign_stack` with `envLine` |
| `GET/POST /api/admin/livetv/sources`, `PATCH/DELETE /api/admin/livetv/sources/:id`, `POST …/:id/refresh`, `POST …/sources/test` | answers carry `urlHint`/`epgHint`, never URLs; `refresh` 202, result through polling `GET` |
| `GET /api/admin/livetv/channels?q&source&group&state&epg&error&sort&dir&limit&offset` | `{ channels, total }` |
| `POST /api/admin/livetv/channels` (own feed) · `PATCH /api/admin/livetv/channels/:id` `{ name?, number?, groupId?, hidden?, epg? }` (`null` = back to import) | |
| `POST /api/admin/livetv/channels/bulk` `{ ids, action: 'hide'\|'show'\|'group'\|'renumber'\|'reset'\|'test', groupId?, from? }` | |
| `PUT /api/admin/livetv/channels/order` `{ ids }` · `POST …/:id/test` · `PUT …/:id/logo` (multipart) · `DELETE …/:id/logo` | |
| `GET/POST/PATCH/DELETE /api/admin/livetv/groups[/:id]` `{ name, kidFriendly, roles }` · `PUT …/groups/order` · `POST …/groups/merge { ids, into }` | |
| `PUT /api/admin/users/:id/livetv-groups` `{ allow: string[], deny: string[] }` | Phase 0 *Rechte* tab |
| `GET /api/admin/livetv/epg/unmatched` · `GET …/epg/channels?q` · `PUT /api/admin/livetv/channels/:id/epg` `{ sourceId, xmlId } \| { none: true } \| null` | Phase 2 |
| `GET/POST/PATCH/DELETE /api/admin/livetv/epg/rules[/:id]` | Phase 2 |
| `GET /api/admin/livetv/status` · `POST /api/admin/livetv/streams/:channelId/stop` | |
| `GET /api/admin/conversions` · `POST /api/admin/conversions/benchmark` | 1a; budget values via `PUT /api/admin/settings` |
| `PATCH /api/admin/devices/:userId/:deviceId` `{ startLive }` | TV devices only (`tv-…`) |

**User** (`requireUser`; kids allowed except where noted):

| Route | Answer |
|---|---|
| `GET /api/livetv/channels` | `{ groups: [{ id, name }], channels: [{ id, number, name, logo, groupId, running, preview?: string, now?: Prog, next?: Prog, favourite }], favourites: string[], last: { id, previous } \| null, dvrSeconds }`; `Prog = { title, start, end, subtitle? }`; ETag; 30 s client refresh of now/next |
| `GET /api/livetv/logos/:hash` | image, `cache-control: private, max-age=604800, immutable` |
| `GET /api/livetv/channels/:id/preview.jpg` | only while running and allowed; `max-age=60` |
| `POST /api/livetv/channels/:id/watch`, `POST /api/livetv/beat`, `DELETE /api/livetv/watch` | §7.2 |
| `PUT /api/livetv/favourites` `{ ids }` · `POST/DELETE /api/livetv/favourites/:id` | per profile |
| `PUT /api/livetv/last` `{ id }` | updates `livetv_last` (previous = old current) |
| `GET /api/livetv/epg?start=<ISO, 6-h aligned UTC>&group=<id>` (Phase 2) | `{ start, end, programmes: { [channelId]: Prog[] } }`, ETag, server cache 5 min per (block, channel set) |
| `GET /api/livetv/programme/:channelId/:start` (Phase 2) | detail incl. description, episode, recording state |
| `POST/DELETE /api/livetv/reminders` (Phase 2, grown-ups) | |
| Recording routes (Phase 3, §15.8) | |

**Jobs** (`server.ts`, behind `op()` and `BACKGROUND_JOBS`): `livetvTick` 15 s (streams, viewers, recordings start/stop),
`livetvRefreshTick` 5 min (sources due; EPG due — never rarer than every 24 h, even for *manuell* sources, because the
guide would run dry), `livetvEpgPrune` daily 04:10 (programmes `end_at < now() − 1 day`, missing channels > 30 days,
orphaned logos), `livetvReminderTick` 60 s (Phase 2), `convBenchTick` 10 min (one automatic first measurement).

**Import merge rules** (`sources.ts`): entries keyed by `source_key`; new → insert (group via `livetv_group_map`, creating
the group with the source's `auto_roles` if new); existing → update `import_*`, `stream_url_enc`, `stream_kind`, clear
`missing_since`; absent → `missing_since = now()` (hidden from users at once, deleted after 30 days). Overrides are never
touched. A refresh that returns 0 entries (or < 20 % of the previous count) is treated as a provider error: nothing is marked
missing, the source shows "Die Liste war leer – nichts geändert".

## 11. The Live-TV tab (`/live`)

Navigation: desktop pill `HEADER_TABS` gains `['/live', 'shell.nav.live']` after *Filme*; phone chip bar under the header
gains *Live-TV* after *Filme*; the phone **tab bar** gains *Live* (icon `tv`) between *Neu* and *Meine Liste* (5 tabs with
downloads; the 320-px fit uses the short label "Live"); `TV_RAIL` gains it after *Filme*; the kids header gains a *Fernsehen*
entry. All only when `me.features.livetv`.

### 11.1 Layout (desktop ≥ 900 px)

1. **Läuft gerade bei dir** (favourites, max 12, hidden when none): a row of 16:9 `.frost-tile` tiles: preview image only if
   the channel is running (§3.3) else the logo centred on the tile's glass; bottom: number + name, programme title, a 3-px
   progress line (`scaleX`, minute steps). Tap = watch.
2. **Group chips** (`frost-pill` chips, horizontally scrolling): *Alle*, *Favoriten*, then the groups in order. Selection
   slides the pill highlight (`SlidePill`).
3. **Channel grid**, two columns of rows (each 72 px): number (tabular), 48-px logo tile, name, two text lines **always
   reserved**: *Jetzt* line ("20:15 Die Leuchtturmwärter" + thin progress) and *Danach* line ("21:00 Wetter am Hafen"); without
   EPG: "Live" and "Kein Programm verfügbar". Star button (44 px, `aria-pressed`). Hover/focus: the existing row fill.
4. **Programmführer** button (Phase 2) in the page head next to the title; **Aufnahmen** row (Phase 3) under the favourites.
- Loading: skeleton rows of the final height; logos fade in (opacity).

### 11.2 Phone (≤ 720 px)

Same order; favourites as a carousel (`Carousel.svelte`), chips sticky under the header, channels as a single-column compact
list (64-px rows: logo, number + name, *Jetzt* line with progress, star). The *Danach* line moves into the info panel. Pull
the list to refresh now/next (existing pull pattern if present on the page type; otherwise the 30-s refresh only).

### 11.3 TV apps (Tizen, webOS, Fire TV, `html.tv`)

- Big tiles: favourites row of 16:9 tiles (360 px wide at 1080p), then the group chips as a focusable row, then the channel list
  as large rows (96 px, logo 72 px, text ≥ 28 px). Focus = `scale(1.08)` + 3-px white ring; the list scrolls to keep the focused
  row in the middle third.
- Keys in the list: ▲/▼ move; ◀ opens the rail (TV layout spec); OK watches; **ChannelUp/ChannelDown** (and PageUp/PageDown on
  LG) jump 8 rows; **digits** start number entry (§12.4) and jump to that channel's row on OK; Info opens the info panel for the
  focused channel; a long OK (≥ 600 ms) toggles favourite (hint in the footer line "Lang OK: Favorit").
- **Remembers the last channel**: entering `/live` focuses the last watched channel's row.
- **TV startet mit Live-TV** (`devices.start_live`, set by the admin in Admin → *Geräte* for paired TVs): the TV app's start
  route opens `/live?play=last`, which starts the last channel of the profile (or shows the list if none). Back from that player
  goes to the Live list; Back from the list goes Home.

### 11.4 Kids profiles

Kids layout (solid panels, bigger tiles): favourites and a grid of channel tiles (logo + name + *Jetzt* title); favourites
per profile (long press / long OK); the guide (Phase 2) read-only (only *Jetzt ansehen* in the detail sheet); an *Aufnahmen*
row (Phase 3) only with recordings shared with them from kid-friendly groups (§15.6).

## 12. The live player

`web/src/lib/live/LivePlayer.svelte`, opened at `/live/watch/[channelId]` (desktop/phone/TV). It is built from the existing
player parts so it looks and behaves like `Player.svelte`: the same stage, the same control bar classes and auto-hide, the
same TV control layer style (`TvControls`), `lib/player/hls.ts` (`loadHls`, `hlsConfig` with live settings:
`liveSyncDurationCount 3`, `liveMaxLatencyDurationCount 10`, `backBufferLength = dvrSeconds`), `volume.ts`, `gestures.ts`
(zones), `mediasession.ts`, the cast engine and `PlayOnSheet`, `firstframe.ts`, the TV Back handling (`playerBack`). It does
not reuse `Player.svelte`'s item logic (resume, episodes, credits, ABR ladder).

### 12.1 Controls

- **No seek bar.** Bottom bar: Play/Pause (white disc, the one primary), −30 s, +30 s (disabled at the live edge), the **LIVE**
  pill (filled coral with a dot when at the live edge; outlined with "−12:30" when behind; click/OK = jump to live), channel
  ▲/▼ buttons with the neighbour's name in the tooltip, *Programm* (info panel), *Abspielen auf…* (cast), volume, fullscreen.
- Top: channel logo, number + name, programme title and "20:15–21:00"; a thin programme progress line (not draggable).
- Pausing longer than the buffer: on resume, playback starts at the oldest available point with the toast "Die Pause war
  länger als 30 Minuten – es geht am ältesten gespeicherten Punkt weiter."
- **Info panel** (glass sheet on phone, side panel on desktop, TV panel): *Jetzt* (title, time, progress, description,
  episode), *Danach*, a *Letzter Sender* button ("Zurück zu 4 Hafenkanal"), Phase 2 *Programmführer* and *Aufnehmen*.

### 12.2 Channel switching

- Order = the effective list of the current group filter (or all) by number; wraps around.
- Switching keeps the player open: the stage shows the next channel's logo + name in a centred glass card (fade, 1 s) while the
  new token/stream starts; the old token is revoked; `PUT /api/livetv/last`. Rapid presses are debounced (the request goes
  out 400 ms after the last press; the card follows each press at once).
- **Last channel:** `livetv_last.previous_id`; key/button jumps there (§12.3).
- A switch into a full budget shows the *alle Plätze belegt* sheet (§12.5) and stays on the current channel.

### 12.3 Input map (`web/src/lib/live/livekeys.ts`, pure like `keymap.ts`)

| Action | Desktop | Phone | TV remote |
|---|---|---|---|
| Channel up / down | ↑ / ↓, PageUp / PageDown | horizontal swipe on the centre zone (left = next, right = previous; the side zones keep brightness/volume), ▲/▼ buttons | ChannelUp / ChannelDown; ▲ / ▼ while the controls are hidden; LG PageUp / PageDown |
| Pause / play | Space, K, MediaPlayPause | tap Play/Pause | OK (controls hidden) / MediaPlayPause |
| −30 s / +30 s in buffer | ← / → (10 s), J / L (30 s) | double-tap left / right (±10 s, the existing gesture) | ◀ / ▶ show the controls with focus on −30 s / +30 s; MediaRewind / MediaFastForward ±30 s |
| Live | End | LIVE pill | LIVE pill; Blue key on LG |
| Info panel | I | tap the top title | Info; OK when controls visible and focus on the title |
| Last channel | Q | button in the info panel | PreviousChannel (Tizen), KEYCODE_LAST_CHANNEL (Fire TV), Red key on LG; button in the info panel |
| Number entry | digits, Enter | – (list search instead) | digits, OK (§12.4) |
| Cast | – (button) | button | – |
| Close | Escape (fullscreen first), browser back | back gesture | Back |

`Q` is used for "last channel" on desktop because Backspace is a back key on TVs (`isBackKey`) and must not change meaning.
In live mode PageUp/PageDown are channel keys, not "next episode" (`keymap.ts:64` stays for films).

### 12.4 Number entry (TV, desktop)

Digits open a small glass card top right showing the typed digits ("1 2 _") and the matching channel's logo/name as soon as it
is unique; OK/Enter (or 2 s without input) switches; up to 5 digits; no match → "Kein Sender 123" for 2 s. Works in the player
and in the Live list (there it focuses the row).

### 12.5 States and errors

| State | Player shows |
|---|---|
| starting (≤ 15 s) | channel card + "Sender wird gestartet …" (spinner in the play slot) |
| buffering | thin indeterminate line under the top bar (transform only) |
| input lost (playlist stalls > 8 s, or 502 from `watch`) | overlay card "Sender gerade nicht erreichbar" + "Verbinde neu …"; the player retries (playlist reload, then a new `watch` after 30 s) with backoff up to 2 min, then *Erneut versuchen*; the channel keys keep working; every outage is an event in *Live-Status* |
| `live_full` | sheet "Gerade sind alle Live-Plätze belegt" + "Diese Sender laufen schon und gehen sofort:" list of running channels (logo, number, name, *Jetzt* title) → tap joins; *Schließen* |
| `max_streams` | the existing max-streams message of the film player |
| right lost / channel hidden (403/410 during play) | "Dieser Sender ist für dich nicht mehr verfügbar." → back to the list |
| token renewal failed | silent retry, then the input-lost state |

Telemetry: the anonymous playback timing (`playtiming.ts`) gains `mode: 'live'` with first-frame time only (no channel, no
user).

## 13. Casting live channels

- **Chromecast:** the cast engine gains a `loadLive({ channelId })` path: `POST /api/livetv/channels/:id/watch { via:
  'chromecast' }` → `contentId = https://friend.example.com/media/l/<token>/index.m3u8`, `contentType
  application/x-mpegURL`, `streamType LIVE`, metadata: channel name and programme title; the logo reaches the TV through the
  existing cast **img token** (`kind 'img'`, extended from posters to logo hashes), because the receiver sends no cookies.
  FriendFlix's own receiver shows the channel
  card on load and the *Jetzt* line; the Default Media Receiver shows its own UI. The remote screen and cast bar get a *live*
  variant: no scrubber, LIVE pill, channel ▲/▼ (switch = new token, `loadLive` again), info line now/next.
- **AirPlay:** Safari: the live `<video>` gets the token URL (`via: 'airplay'`, two-address pin), picker as today; channel
  switching while AirPlaying = new token + `src` swap from the user's tap.
- **Survives the tab:** like film casts, a Chromecast live cast keeps playing when the tab closes (the receiver's fetches keep
  the token and the viewer alive, §7.4); re-adoption uses the existing hint mechanism with `kind: 'live'`.
- **Android shell:** bridge method `castLive { channelId }` (native `CastHub` loads the URL the backend minted through the
  bridge's authenticated call), cast bar via the existing `castState` events.

## 14. Platform specifics

| Platform | Live player | Keys / changes |
|---|---|---|
| Browsers (desktop, phone) | `LivePlayer` (hls.js; Safari native HLS) | §12.3 |
| Windows app | the web `LivePlayer` in WebView2 (mpv stays for films) | same as desktop |
| Tizen | web `LivePlayer` | `web/src/lib/tizen`: register `ChannelUp`, `ChannelDown`, `PreviousChannel`, `Info`, `0`–`9`, `ColorF0Red`, `ColorF3Blue` via `tizen.tvinputdevice.registerKey` when the Live area opens (in a try/catch, like `probe.ts`) |
| webOS | web `LivePlayer` | channel keys arrive as PageUp/PageDown (`keyCode 33/34`), digits natively, Red/Blue via `normaliseLgKey`; Info = `keyCode 457` |
| Fire TV | web `LivePlayer` in the shell | `FireTvKeys.kt`: add `KEYCODE_CHANNEL_UP/DOWN` → `ChannelUp/ChannelDown`, `KEYCODE_0..9` → `"0".."9"`, `KEYCODE_LAST_CHANNEL` → `PreviousChannel`, `KEYCODE_INFO` → `Info`, `KEYCODE_GUIDE` → `Guide` (Phase 2 opens the grid) |
| Android app | web `LivePlayer` inside the shell (hls.js in WebView; films keep the native player) | swipe as phone; cast via `castLive` (§13). A native live mode in `PlayerActivity` is a later option, not in these phases. |
| Chromecast receiver | own receiver: live card, no progress bar, LIVE badge | `ui.live = true` from the sender |

## 15. Recordings (Phase 3)

### 15.1 Kinds

- **Single:** from a programme (detail sheet *Aufnehmen*) or the player's *Aufnehmen* (the running programme to its end).
- **Series:** *Serie aufnehmen* → rule with `series_key` (XMLTV `dd_progid` series part or `<series-id>` when the EPG carries
  it, else the normalised title), *Nur neue Folgen* (default on: skip when XMLTV says `previously-shown` or, when the source
  uses `<new/>` at all, when it is not new; and skip when an earlier recording of this rule has the same `episode`, or the same
  sub-title when there is no episode number), *Nur dieser Sender* / *Alle Sender*, *Höchstens … behalten* (oldest unprotected
  of the rule deleted when exceeded).
- **Time-based:** channel + start + duration (+ weekly weekday chips); for own feeds without EPG.
- Padding from settings (2 / 5 min), editable per recording and rule.

### 15.2 Recorder

- At `start − pad_before` the tick calls `POST /v1/recordings`; `livetv` writes HLS (4-s TS segments + `index.m3u8`, an
  `EVENT` playlist while recording, `ENDLIST` at the end) under `/recordings/<dir>/`. Mode: passthrough/remux (copy) when the
  channel allows, transcode otherwise (budget slot, reserved from start − pad − 5 min).
- A recording shares the input with a running live stream of the same channel (one input fetch), not the live stream's DVR
  cache.
- Input loss: reconnect as for live; each gap is stored (`gaps`); the result is `done` (no gaps), `partial` (gaps or late
  start), `failed` (nothing recorded); failures and gaps are events in *Live-Status* and notifications to the owner (§16).
- **Watch while recording:** the EVENT playlist is played through `/media/r/<token>/index.m3u8`; the player shows it as a
  growing recording (seekable from the start).

### 15.3 Storage modes

- **FriendFlix-Ordner** (`ff`, default): files stay in `/recordings/<dir>/`, played through the gateway.
- **Jellyfin-Bibliothek** (`library`): after the end `livetv` concatenates the segments without re-encoding into one file
  `<library folder>/<Serie oder Titel>/<Titel> – <YYYY-MM-DD HH.mm>.ts` (`POST /v1/recordings/:id/export`), the HLS folder is
  deleted, the backend asks Jellyfin to scan that library (new optional seam method `MediaAdmin.refreshLibrary?(id)`), and the
  recording links to the new item (`jellyfin_item_id`, matched by path). Played with the **normal film player** as a Jellyfin
  item. Library items follow Jellyfin's rules (everyone with that library sees them; unrated items are hidden from kids by the
  existing kids block), so the per-recording privacy does not apply in this mode (the admin panel says so).
- **Beides** (`both`): recorded into the FriendFlix folder; *Behalten → in Bibliothek* on a recording exports a copy into the
  library and marks it `keep`.
- The library folder is a dedicated sub-folder mounted read-write into `livetv` only (`${RECORDINGS_LIBRARY_PATH}:/library`,
  e.g. `${MEDIA_PATH}/Aufnahmen`), never the whole media path (see open question 2).

### 15.4 Budget and conflicts

At scheduling, the backend forecasts each minute of the new recording: reserved conversions of other recordings that need a
conversion + this one. If that exceeds the limit (minus the holdback the priority rule keeps for the preferred kind), the sheet
warns: "Zu dieser Zeit sind schon 2 von 2 Umwandlungsplätzen für Aufnahmen verplant. Diese Aufnahme kann ausfallen." with
*Trotzdem planen* / *Abbrechen*. Copy-mode recordings need no slot and never warn. A parallel-recordings limit
(`LIVETV_RECORD_MAX_PARALLEL`) warns the same way. At start, a recording that cannot get its slot (only possible when other
Jellyfin apps fill the server) retries every 60 s until its end and reports `partial`/`failed`.

### 15.5 Space, retention, protection

- Usage = the sum of `bytes` of all recordings FriendFlix made, in the FriendFlix folder **and** exported into the library
  (free disk space from `GET /v1/system`); when usage passes 90 % of `LIVETV_RECORD_LIMIT_GB`, the oldest
  unprotected (`keep = false`) finished recordings are scheduled for deletion (`delete_after = now + 24 h`) until the forecast
  usage is ≤ 80 % (a library recording is deleted as a file and the library rescanned); owners are notified at scheduling time (24 h ahead); admins get "Aufnahmespeicher fast voll" once per day.
- Retention: `LIVETV_RECORD_RETENTION_DAYS` after `watched_at` (≥ 90 % watched by the owner profile), not for `keep`.
- *Behalten* (`keep`) protects from both; the limit can then be exceeded only by new recordings, which then fail with
  `storage_full` (owner + admins notified).
- Recordings are stored as recorded. The later **H.265 re-encode** (setting off by default) converts finished, unwatched-for-7-
  days recordings in quiet hours, one at a time, as budget kind `reencode`.

### 15.6 Visibility

- Default `private`: only the owner profile (and admins in Admin → *Aufnahmen*, metadata only, no playback unless shared).
- The owner (or an admin) can share: *Mit meinem Konto* (`account`: all profiles of the owner's account) or *Mit allen*
  (`everyone`: every profile that may see the channel's group). Kids profiles see a recording only when it is shared
  (`account` or `everyone`) **and** its channel's group is kid-friendly.
- Kids profiles never schedule or delete recordings.

### 15.7 UI

- Live-TV tab: **Aufnahmen** row (latest 12 of the profile: tile with logo/preview frame, title, date, duration, red dot +
  "läuft" while recording, progress if started). *Alle* → `/live/recordings` (**Meine Aufnahmen**): segmented *Fertig* /
  *Geplant* / *Serien*; finished grouped by series (rule or series key) with episode lists, singles by date; each item: play,
  *Behalten* toggle, *Teilen…*, *Löschen* (undo toast); *Geplant*: cancel; *Serien*: rule settings.
- Player: recordings in `ff` mode play in `Player.svelte` through a new narrow **source seam** (`PlaybackSource` with two
  implementations: Jellyfin item (today) and FriendFlix recording: info from `GET /api/livetv/recordings/:id/playback`,
  progress to `/api/livetv/recordings/:id/progress`, no episodes/credits/ABR). Resume, hand-off ("Weiter auf dem Fernseher",
  `remote.ts`, with `kind: 'recording'`) and casting (`/media/r/` token, `via` as for live) work like films.
- Admin → *Aufnahmen* (§9.6) and Live-Status events.

### 15.8 Routes (Phase 3, grown-ups only unless noted)

`GET /api/livetv/recordings?state&group` (kids: shared kid-friendly only) · `POST /api/livetv/recordings` `{ channelId,
start, end, title?, padBefore?, padAfter? }` (409 `conflict` with forecast when not forced; `force: true` to plan anyway) ·
`PATCH /api/livetv/recordings/:id` `{ keep?, visibility? }` · `DELETE /api/livetv/recordings/:id` · `POST
/api/livetv/recordings/:id/library` (*Behalten → in Bibliothek*) · `GET /api/livetv/recordings/:id/playback` → token URL ·
`POST /api/livetv/recordings/:id/progress` · `GET/POST/PATCH/DELETE /api/livetv/rules[/:id]` · admin: `GET
/api/admin/livetv/recordings`, `DELETE /api/admin/livetv/recordings/:id`.

### 15.9 Deleting recordings in bulk

Admin → *Aufnahmen* → *Alle Aufnahmen löschen…* (typed confirmation "LÖSCHEN"), the only way to empty the recordings volume
from FriendFlix; disabling Live TV never deletes recordings.

## 16. Notifications (existing `notify()` / `notifyAdmins()`)

| Kind | To | When | DE text |
|---|---|---|---|
| `livetv.rec.started` | owner account | a recording starts (off by default per account pref `livetvRecStarted`) | "Aufnahme läuft: {title} auf {channel}" |
| `livetv.rec.failed` | owner | failed or partial | "Aufnahme fehlgeschlagen: {title} ({reason})" / "Aufnahme unvollständig: {title} – {n} Lücken" |
| `livetv.rec.episode` | owner | a series rule recorded a new episode | "Neue Folge aufgenommen: {series} – {episode}" |
| `livetv.rec.deleting` | owner | 24 h before automatic deletion | "{title} wird morgen gelöscht, um Platz zu schaffen. Behalten?" (link) |
| `livetv.rec.storage` | admins | ≥ 90 % used (daily) | "Aufnahmespeicher fast voll: {used} von {limit}" |
| `livetv.reminder` | profile's account | 5 min before (Phase 2) | "Gleich auf {channel}: {title} um {time}" |
| `livetv.source.failed` | admins | 3 refreshes in a row failed | "Senderliste {source} lässt sich nicht aktualisieren" |

Dedupe keys per recording/reminder; texts are i18n messages (`m()`), rendered per recipient as today. Titles appear only in
the recipient's own notifications (they chose to record it), never in admin broadcasts.

## 17. Phase 2: the guide (`/live/guide`)

- **Layout:** fixed channel column (desktop 200 px: logo + number + name; phone 112 px: logo + number; TV 280 px) and a time
  header in half-hour steps (desktop 180 px per 30 min, phone 120 px, TV 240 px at 1080p); rows 64 px (phone 56, TV 96).
  Programme cells: title (one line, ellipsis), time range (second line when ≥ 120 px wide), past programmes at `.55`
  opacity, a red dot + "Aufnahme" for planned/running recordings, the running programme with a subtle `--fr-sel` fill.
  Channels without EPG: one cell across the whole window "Live" / "Kein Programm verfügbar".
- **Jetzt line:** a 2-px `--err` line with a small "jetzt" label in the header, moved with `translateX` every 30 s.
- **Head:** day chips (*Gestern*, *Heute*, *Morgen*, then weekday + date up to 7 days ahead), *Jetzt* button (scrolls the grid
  so now sits at 20 % of the width), group chips, a *Programmführer* title.
- **Virtualised drawing:** only rows and cells inside the viewport ± one screen are in the DOM (window ~20 channels × 4 h);
  cells are absolutely positioned by `transform: translate()`; scrolling never re-lays-out, nothing jumps.
- **Data:** 6-hour blocks aligned to 00/06/12/18 UTC (`GET /api/livetv/epg`), in-memory LRU of 16 blocks per session,
  prefetch of the neighbour block when the viewport is within 1 h of an edge. All times UTC in transport; labels with
  `Intl.DateTimeFormat` in the device's time zone; a local day runs from local midnight to midnight (23 or 25 hours on DST
  days: the axis shows the repeated or skipped hour as it is).
- **Detail sheet** (glass sheet / TV panel): channel, title, time, episode, description, categories, rating; buttons *Jetzt
  ansehen* (running only), *Aufnehmen* / *Aufnahme abbrechen*, *Serie aufnehmen* (when a series key exists), *Erinnern* /
  *Erinnerung entfernen* (future only). Buttons a profile may not use are not rendered.
- **Navigation:** desktop: wheel/trackpad pans both ways, Shift+wheel horizontal, arrow keys move focus programme to programme
  (the TV rule), PageUp/PageDown by a screen of rows, Home = *Jetzt*, Enter = details; phone: native two-axis scroll with sticky
  column and header, tap = details; **TV:** ◀/▶ move to the previous/next programme of the row, ▲/▼ move to the programme in
  the row above/below that overlaps the **anchor time** (the start of the programme focused before the vertical move, kept
  while moving vertically), the grid scrolls so the focus stays inside the middle 60 %; OK = details; ChannelUp/Down = a page of
  rows; Info = details; Guide (Fire TV) opens/closes the grid; Back closes the sheet, then the grid.
- **Reminders:** `livetv_reminders`, notified 5 min before start; the cell shows a bell icon.

## 18. Security & privacy summary

- **Provider credentials:** encrypted at rest (`url_enc`, `epg_url_enc`, `stream_url_enc`), decrypted only in the backend
  process right before a signed request to `livetv`, kept in `livetv` memory only for the running job; never in answers
  (masked `*_hint`), logs (backend: route logs exclude bodies of `/api/admin/livetv/sources*`; `livetv`: scrubbed ffmpeg
  stderr, no argument logging), audit (field names only), metrics, error messages (fixed codes), Diagnose.
- **Rewritten streams:** clients only see `/media/l/<token>/<local name>`; provider segment URLs live only in `livetv`.
- **Tokens:** hashed in KV, pinned, short idle TTL, capped, revoked on every relevant change (§7.1), scoped to one channel or
  recording, never logged.
- **Profile isolation:** favourites, last channel, reminders, recordings and progress are per profile; every user route checks
  the profile's effective channel set; recordings are private by default; admins see recording metadata, not playback, unless
  shared.
- **Kids:** only kid-friendly groups; no recording, no guide reminders; shared kid-friendly recordings only.
- **SSRF / hostile input:** §3.4; the backend validates scheme and host form on save, `livetv` enforces the address rules at
  connect time; `livetv` has no route to the database, Redis or the media server (networks).
- **Container hardening:** read-only root, tmpfs `/tmp`, no capabilities, `no-new-privileges`, uid 10001, no ports, GPU only
  through the opt-in overlays, signed internal API.
- **Privacy notice** (`docs/privacy.md`, account page): which channels a profile watched is stored only as *last channel* and
  favourites; live views appear in the admin's *Wiedergabe* list while they run (like films); no viewing history is kept for live.

## 19. Errors and edge cases

| Case | Behaviour |
|---|---|
| M3U unreachable / 401 / 403 / timeout / too big / not an M3U | source state "Nicht erreichbar" / "Zugang abgelehnt (Benutzername oder Passwort?)" / "Zeitüberschreitung" / "Liste zu groß (über 50 MB)" / "Keine gültige Senderliste"; nothing changes; event; after 3 failures admin notification |
| empty or shrunk list (< 20 %) | treated as error, nothing marked missing (§10) |
| XMLTV broken / too big | EPG state error, previous programmes kept until they expire |
| duplicate channel numbers | admin warning chip "Nummer doppelt"; number entry picks the first by group position |
| channel disappears and comes back | same `source_key` → overrides intact; missing channels invisible meanwhile |
| tvg-id changes at the provider | channel treated as new (`source_key` changed); old one goes missing; the admin can *Zusammenführen* two channels (moves overrides, favourites, rules; deletes the old) |
| provider limits connections (e.g. 1 stream per account) | the second channel fails to start → "Sender gerade nicht erreichbar"; the source's *Max. gleichzeitige Sender* field (int, optional) makes the backend refuse earlier with "Dein Anbieter erlaubt nur {n} Sender gleichzeitig" and the running channels list |
| budget full | §12.5 sheet; films §5.5 |
| `livetv` down while watching | gateway 503 → player input-lost state; `/api/me.features.livetv` false after the next detection → tab disappears on next navigation (not while a page is open) |
| backend restart | streams keep running in `livetv`; viewers re-beat; tokens in Redis survive; the tick reconciles `GET /v1/streams` with its viewer table and stops orphans after 60 s |
| `livetv` restart | streams gone; clients get 410 at authz → re-`watch` once automatically |
| DST change during a recording | times are UTC; the recording runs its real duration |
| EPG programme overlaps / gaps | cells drawn as given; overlaps: the later start wins the visible slot, the other is in the detail list |
| channel hidden while someone watches | token revoked within 2 s (authz memo) → "nicht mehr verfügbar" |
| role/group right removed while watching | same |
| profile deleted | favourites, last, reminders, recordings, progress cascade |
| `livetv` disabled with scheduled recordings | they fail with `livetv_off`, owners notified once |
| Plex install | budget counts Plex transcodes via the adapter; library storage mode not offered |

## 20. Copy (EN / DE; the other five locales translated)

| Key | EN | DE |
|---|---|---|
| `shell.nav.live` / `shell.tabs.live` / `shell.tabs.liveShort` | Live TV / Live TV / Live | Live-TV / Live-TV / Live |
| `kids.nav.live` | TV | Fernsehen |
| `live.title` / `live.favourites` / `live.all` / `live.favouritesChip` | Live TV / On for you now / All / Favourites | Live-TV / Läuft gerade bei dir / Alle / Favoriten |
| `live.now` / `live.next` / `live.noEpg` / `live.liveOnly` | Now / Next / No programme available / Live | Jetzt / Danach / Kein Programm verfügbar / Live |
| `live.favourite` / `live.unfavourite` | Add to favourites / Remove from favourites | Zu Favoriten / Aus Favoriten entfernen |
| `live.guide` / `live.recordings` / `live.myRecordings` | Programme guide / Recordings / My recordings | Programmführer / Aufnahmen / Meine Aufnahmen |
| `live.player.live` / `live.player.behind` / `live.player.toLive` | LIVE / −{time} / Back to live | LIVE / −{time} / Zurück zu live |
| `live.player.chUp` / `chDown` / `lastChannel` / `lastChannelTo` | Next channel / Previous channel / Last channel / Back to {number} {name} | Nächster Sender / Vorheriger Sender / Letzter Sender / Zurück zu {number} {name} |
| `live.player.starting` / `unreachable` / `reconnecting` / `retry` | Starting channel… / Channel not reachable right now / Reconnecting… / Try again | Sender wird gestartet … / Sender gerade nicht erreichbar / Verbinde neu … / Erneut versuchen |
| `live.player.pauseTooLong` | The pause was longer than 30 minutes, continuing at the oldest saved point. | Die Pause war länger als 30 Minuten – es geht am ältesten gespeicherten Punkt weiter. |
| `live.player.noChannel` / `notAvailable` | No channel {n} / This channel is no longer available to you. | Kein Sender {n} / Dieser Sender ist für dich nicht mehr verfügbar. |
| `live.full.title` / `live.full.body` / `live.full.join` | All live slots are taken right now / These channels are already on and start at once: / Watch {name} | Gerade sind alle Live-Plätze belegt / Diese Sender laufen schon und gehen sofort: / {name} ansehen |
| `live.providerLimit` | Your provider allows only {n} channels at once. | Dein Anbieter erlaubt nur {n} Sender gleichzeitig. |
| `player.serverBusy` / `player.capReason.serverBusy` | The server is busy right now. Try again in a moment. / Server busy | Server gerade ausgelastet. Versuch es gleich noch einmal. / Server ausgelastet |
| `live.tvHintFav` | Long OK: favourite | Lang OK: Favorit |
| `live.guide.today` / `yesterday` / `tomorrow` / `nowBtn` / `nowLine` | Today / Yesterday / Tomorrow / Now / now | Heute / Gestern / Morgen / Jetzt / jetzt |
| `live.guide.watch` / `record` / `cancelRecord` / `recordSeries` / `remind` / `unremind` | Watch now / Record / Cancel recording / Record series / Remind me / Remove reminder | Jetzt ansehen / Aufnehmen / Aufnahme abbrechen / Serie aufnehmen / Erinnern / Erinnerung entfernen |
| `live.rec.recording` / `keep` / `share` / `shareAccount` / `shareAll` / `toLibrary` | recording / Keep / Share… / With my account / With everyone / Keep in library | läuft / Behalten / Teilen … / Mit meinem Konto / Mit allen / Behalten → in Bibliothek |
| `live.rec.onlyNew` / `thisChannel` / `allChannels` / `keepMax` | Only new episodes / This channel only / All channels / Keep at most {n} | Nur neue Folgen / Nur dieser Sender / Alle Sender / Höchstens {n} behalten |
| `live.rec.conflict` / `planAnyway` | At that time {u} of {l} conversion slots are already planned for recordings. This recording may fail. / Plan anyway | Zu dieser Zeit sind schon {u} von {l} Umwandlungsplätzen für Aufnahmen verplant. Diese Aufnahme kann ausfallen. / Trotzdem planen |
| `live.rec.state.*` | Scheduled / Recording / Done / Incomplete ({n} gaps) / Failed / Cancelled | Geplant / Läuft / Fertig / Unvollständig ({n} Lücken) / Fehlgeschlagen / Abgebrochen |
| `admin.tabs.livetv` / `adminLive.optional` | Live TV / optional | Live-TV / optional |
| `adminLive.offer.title` / `body` / `needs` / `enable` / `hide` | Live TV (optional) / Watch TV channels from your provider list or your own streams in FriendFlix. / Needs one more container (about 250 MB). Nothing is downloaded until you turn it on. / Turn on Live TV / Don't show again | Live-TV (optional) / Fernsehsender aus deiner Anbieterliste oder eigene Streams direkt in FriendFlix. / Braucht einen zusätzlichen Container (ca. 250 MB). Es wird nichts geladen, bis du es einschaltest. / Live-TV aktivieren / Nicht mehr anzeigen |
| `adminLive.offer.envTitle` / `envBody` / `envProfilesNote` | Turn on by hand / Add this line to the .env of your stack and restart: / If COMPOSE_PROFILES is already there, append ,livetv. | Von Hand einschalten / Füge diese Zeile in die .env deines Stacks ein und starte neu: / Steht dort schon COMPOSE_PROFILES, hänge ,livetv an. |
| `adminLive.offer.persistTip` | So that Live TV starts again after `docker compose down`, add COMPOSE_PROFILES=livetv to .env. | Damit Live-TV auch nach `docker compose down` wieder startet, trage COMPOSE_PROFILES=livetv in die .env ein. |
| `adminLive.offer.wantedDown` / `restart` | Live TV is turned on, but the service is not running. / Start again | Live-TV ist eingeschaltet, der Dienst läuft aber nicht. / Wieder starten |
| `adminLive.tabs.*` | Sources / Channels / Groups & rights / Programme guide / Live status / Recordings | Quellen / Kanäle / Gruppen & Rechte / Programmführer / Live-Status / Aufnahmen |
| `adminLive.src.add` / `kindList` / `kindOwn` / `m3u` / `epg` / `lan` / `lanHint` / `interval` / `refreshNow` / `test` / `autoRoles` | Add source / Provider list / Own streams / Channel list URL (M3U) / Programme guide URL (XMLTV) / Allow home network / Only for addresses in your own network, e.g. a receiver at home. / Update / Update now / Check / Grant new groups to | Quelle hinzufügen / Anbieterliste / Eigene Streams / Senderliste (M3U-Adresse) / Programmführer (XMLTV-Adresse) / Heimnetz erlauben / Nur für Adressen in deinem eigenen Netz, z. B. ein Receiver zu Hause. / Aktualisieren / Jetzt aktualisieren / Prüfen / Neue Gruppen freigeben für |
| `adminLive.src.interval.*` | Every 6 h / Every 12 h / Daily / Weekly / Manual only | Alle 6 Std. / Alle 12 Std. / Täglich / Wöchentlich / Nur von Hand |
| `adminLive.src.state` / `stateEpg` / `unchanged` | Last updated {when} · {n} channels (+{a} / −{r}) / Guide: {n} programmes / leave unchanged | Zuletzt aktualisiert {when} · {n} Sender (+{a} / −{r}) / Programm: {n} Sendungen / unverändert lassen |
| `adminLive.src.err.*` | Not reachable / Access denied (username or password?) / Timed out / List too big (over 50 MB) / Not a valid channel list / The list was empty, nothing changed / Address not allowed (internal network) | Nicht erreichbar / Zugang abgelehnt (Benutzername oder Passwort?) / Zeitüberschreitung / Liste zu groß (über 50 MB) / Keine gültige Senderliste / Die Liste war leer – nichts geändert / Adresse nicht erlaubt (internes Netz) |
| `adminLive.ch.mode.*` | Passed through / Repackaged / Converted | Durchgereicht / Umverpackt / Umgewandelt |
| `adminLive.ch.hide` / `show` / `regroup` / `renumber` / `reset` / `order` / `dupNumber` / `changedFrom` | Hide / Show / Change group… / Number from… / Reset changes / Order / Duplicate number / changed (import: {v}) | Ausblenden / Einblenden / Gruppe ändern … / Ab Nummer … durchnummerieren / Änderungen zurücksetzen / Reihenfolge / Nummer doppelt / geändert (Import: {v}) |
| `adminLive.grp.kidFriendly` / `merge` / `kidsSee` / `noGroup` | Kid-friendly / Merge… / Kids profiles see: {groups} ({n} channels) / No group | Kinderfreundlich / Zusammenführen … / Kinderprofile sehen: {groups} ({n} Sender) / Ohne Gruppe |
| `adminLive.epg.matched` / `unmatched` / `apply` / `other` / `none` | {m} of {n} channels with a guide · {u} without / Without a guide / Apply / Choose another… / No guide | {m} von {n} Sendern mit Programm · {u} ohne / Ohne Programm / Übernehmen / Andere wählen … / Kein Programm |
| `adminLive.status.running` / `viewers` / `stop` / `restart` / `events` / `off` | Running channels / Viewers / Stop / Restart / Events / Turn off Live TV… | Laufende Sender / Zuschauer / Stoppen / Neu starten / Ereignisse / Live-TV ausschalten … |
| `adminLive.off.removeImage` / `removeCache` / `keepsRecordings` | Remove image / Delete cache / Recordings are kept. | Image entfernen / Zwischenspeicher löschen / Aufnahmen bleiben erhalten. |
| `adminLive.gpu.*` | (the five lines of §4.4) | (the five lines of §4.4) |
| `adminConv.title` / `used` / `measured` / `recommended` / `remeasure` / `auto` / `custom` / `noRealtime` | Conversions / {u} of {l} in use / Measured {s}× real time ({engine}) / recommended {n} / Measure again / Automatic ({n}) / Custom / The server cannot convert in real time. | Umwandlungen / {u} von {l} belegt / Gemessen {s}× Echtzeit ({engine}) / empfohlen {n} / Neu messen / Automatisch ({n}) / Eigener Wert / Der Server schafft keine Umwandlung in Echtzeit. |
| `adminConv.priority.*` | Films & series first / Live TV first / Equal | Filme & Serien zuerst / Live-TV zuerst / Gleichrangig |
| `adminConv.priority.hint` | The other kind leaves one slot free. | Die andere Art lässt einen Platz frei. |
| `adminConv.busyMeasure` | Measuring works only while nobody is watching. | Messen geht nur, wenn gerade niemand schaut. |
| `adminDevices.startLive` | TV starts with Live TV | TV startet mit Live-TV |
| notification texts | §16 | §16 |

## 21. Accessibility

- Channel rows/tiles: one button each with the accessible name "{number} {name}, jetzt: {title}, bis {time}"; the star is a
  separate toggle button. Group chips: `role="tablist"`-free toggle buttons with `aria-pressed` (they filter, they are not tabs).
- Live player: control bar `role="group"`; LIVE pill announces "Live" / "{time} hinter live"; channel changes announce
  "{number} {name}, {title}" politely; number entry announces the typed number and the match.
- Guide: `role="grid"` with `aria-rowcount`/`aria-colcount` for the virtualised grid, row headers = channels, cells name
  "{title}, {start} bis {end}{, läuft}{, Aufnahme geplant}"; the *jetzt* line is decorative (`aria-hidden`), *Jetzt* button
  moves focus to the running programme of the first visible row.
- Drag-and-drop in the admin has the keyboard alternative of §9.2 with live announcements.
- Contrast pairs (logo tile glass, `.55` past programmes still ≥ 4.5:1 for their text by raising the text colour, not lowering
  the background; red dot paired with text) added to the glass tests.
- TV: focus targets ≥ 54 px, text ≥ 28 px at 1080p, one focused element.

## 22. Testing

Fictional channels and programmes only: *Nordlicht TV*, *Hafenkanal*, *Bergblick Sport*, *Kinderinsel*, *Sternwarte 24*,
*Kanal Wolkenlos*; programmes *Die Leuchtturmwärter*, *Wetter am Hafen*, *Abenteuer Wattenmeer*, *Sternstunde Physik*.
Hosts `iptv.example.com`, `friend.example.com`, `192.0.2.10`. Fixture M3U/XMLTV files under `livetv/test/fixtures/`.

- **Unit (`livetv/`):** M3U parser (attributes, quoting, `#EXTVLCOPT` user agent, VOD skip, 20 000 cap, oversized lines,
  BOM, CRLF), XMLTV parser (gzip, time zones in `start="20261111201500 +0100"`, DST, overlaps, entity/DTD refusal, ratio guard,
  300 000 cap), netguard (every refused range, IPv4-mapped IPv6, rebinding via a fake resolver, redirect re-checks, LAN
  switch), stderr scrubber, passthrough playlist rewriting (variant choice, discontinuities, DVR window), DVR cache eviction,
  stop rules, signed API (vectors).
- **Unit (backend):** import merge (overrides survive, missing/return, shrink guard, group auto-create with `auto_roles`), rights
  (roles, user allow/deny, admin, kids kid-friendly only, no group → no tab), tokens (hash only, pin, re-pin by beat, caps,
  revoke paths), viewer/stop tick, budget counting (all kinds, grants, holdback per priority, HEVC sub-cap, never stops
  running), `/api/playback/info` fallback to copy and 503 `server_busy`, benchmark recommendation (4.6 → 3, 0.8 → 1 with
  warning), EPG now/next and 6-h blocks across DST, rules expansion, recording scheduler (padding, series only-new, keep-max,
  conflicts, reservation, gaps, retention, 24-h warning), notifications dedupe, secret scrubbing (no URL in any answer, log line
  or audit meta — a test greps captured logs for `iptv.example.com`).
- **Unit (gateway):** `/media/l/` path allowlist, authz memo, headers, token never forwarded; `/media/r/` file serving bounds.
- **Unit (updater):** `livetv` op parsing, compose argument building with `--profile livetv`, state persistence, update
  includes livetv only when enabled.
- **Unit (web):** `livekeys.ts` map per platform, number entry, channel order/wrap, guide geometry (time → x, anchor-time
  vertical move, DST day width), virtual window, favourites ordering.
- **e2e (Playwright, mocked API + a fake HLS server for the stream):** admin enable flow (updater job and `.env` fallback);
  sources add/test/error states; channels search, bulk, drag order with keyboard; groups & rights matrix; Live-Status; budget
  card and *Neu messen*; Live tab desktop/phone/kids/TV (spatial nav, channel keys, digits); live player pause/rewind/LIVE,
  channel switch, unreachable and `live_full` states; Chromecast live with the cast SDK fake; guide navigation on desktop and
  TV; recordings scheduling, conflict warning, *Meine Aufnahmen*, recording playback through the source seam. German UI.
- **On-device checks for the owner** (listed per phase in the plans): Tizen/webOS/Fire TV channel keys and digits, QSV
  transcode of an SRT test feed on the N5095, Chromecast and AirPlay live, 30-min pause on a TV.

## 23. Rollout

- **Order:** Phase 0 → 1a (budget; release note: "Gleichzeitige Umwandlungen sind jetzt begrenzt – Standard 2 bis zur ersten
  Messung, danach automatisch; Admin → Wiedergabe") → 1b–1e (one release; Live TV invisible until enabled) → 2 → 3.
- **Migrations:** 46 (Phase 0), 47 (1c), 48 (2a), 49 (3a); all additive; Live TV tables are empty until a source is added.
- **Defaults:** budget automatic (2 before measuring), priority films; Live TV offered (hideable), not installed; DVR 30 min;
  new groups visible to admin/family/friend; `liveRecord` off for guests; recording storage FriendFlix folder, 200 GB,
  retention 30 days, padding 2/5 min; re-encode off.
- **Docs:** new `docs/livetv.md` (German; enabling, sources, rights, GPU overlays, troubleshooting) + `docs/de` counterpart
  per the docs convention; `docs/setup.md` (profile, overlays, `RENDER_GID`), `docs/security.md` (livetv container, SSRF,
  tokens, credentials), `docs/privacy.md`, `docs/operations.md` (budget, benchmark), `docs/architecture.md` diagram,
  `docs/tv-mode.md` (keys), `README` feature lines, `CHANGELOG` per phase, `ROADMAP` item.
- **CI/publish:** `publish.yml` builds and signs `friendflix-livetv`; the updater's cosign identity check is unchanged (same
  workflow).

## 24. Decisions made here (owner may overrule)

1. Live TV lives in its own namespaces (`/live`, `/api/livetv`, `/api/admin/livetv`, `backend/src/livetv/`) so it never
   collides with today's `live.ts` / `/api/admin/live` ("now playing") or the `/tv` pairing page.
2. `livetv` does all provider I/O and parsing; the backend never contacts provider hosts; credentials travel only in signed
   internal requests.
3. Live streams go through the existing `/media` location (`/media/l/<token>/…`), so no reverse-proxy change; every client
   (web, TV, cast) uses path tokens.
4. Passthrough picks one variant (≤ 10 Mbit/s), so DVR and sharing work and everyone gets the same quality.
5. Audio-only conversion (e.g. AC3/MP2 → AAC) counts as remux, not as a budget conversion.
6. Live views count against the account's `maxStreams` and the upload-aware cap, like films.
7. Budget: `holdback = 1` for the non-preferred kind; download preparation counts as lowest priority; HEVC keeps its own cap
   inside the budget; recommendation = floor(speed × 0.7), using the slower of Jellyfin and `livetv`.
8. The first benchmark runs once automatically when the server is idle after the Phase 1a update (besides enabling and
   *Neu messen*).
9. When enabled through the updater, `livetv` follows updates automatically (updater state); the `.env` line is still
   recommended to survive `docker compose down`.
10. New provider groups are visible to admin/family/friend, not guests, until granted.
11. Desktop "last channel" key is Q; channel keys on desktop are ↑/↓ and PageUp/PageDown; phones swipe horizontally.
12. The Android app plays live in the shell's web player; a native live mode is a later option.
13. Recordings are HLS folders in FriendFlix mode (seekable while recording) and one concatenated `.ts` file in library mode;
    library mode makes recordings visible to everyone with that library.
14. Admin sees recording metadata but not playback of private recordings.

## 25. Open questions for the owner

1. **SRT push:** do any of your own feeds need to **push** into FriendFlix (SRT listener, e.g. OBS sending to the server)? That
   needs a published UDP port and a permanently running input; these phases support pulled feeds only.
2. **Library recordings:** may `livetv` get **write** access to one dedicated sub-folder of the media path (e.g.
   `media/Aufnahmen`) for the *Jellyfin-Bibliothek* mode? Today no FriendFlix container writes into the media folder.
