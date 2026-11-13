# Live TV with a shared conversion budget (design)

Date: 2026-11-11 · Status: design approved by the owner in chat (option B); this spec writes it down, grounds it in the code
and resolves the rest · Updated 2026-11-12 with the owner-approved changes from the competitor research (*Owner decisions*,
last entry)

## Goal

FriendFlix gets Live TV that feels like the rest of the app: a *Live-TV* tab next to *Serien* and *Filme*, channels from an
IPTV provider list and from the household's own feeds, a live player with pause and a rewind buffer (30 minutes by default,
up to 120), channel
switching with the remote, casting, a programme guide (Phase 2) and recordings (Phase 3). It is **optional**: nothing is
downloaded or run until an admin turns it on. A **server-wide conversion budget** (Phase 1, useful without Live TV) makes sure
films, HEVC conversions, live channels and recordings never overload the server together.

## Owner decisions (fixed, not reopened here)

**Approach.** Option B: FriendFlix manages channels itself (not Jellyfin Live TV).

**Sources.** Provider M3U list(s) with an optional XMLTV EPG URL, plus own feeds entered by hand (SRT, HLS or MPEG-TS).
Own feeds are either **pulled** (FriendFlix fetches the URL while watched or recorded) or **pushed** (an encoder such as OBS
sends SRT to FriendFlix; owner answer 2026-11-11, §3.5).
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

**Research follow-ups (owner decision, 2026-11-12).** The owner approved all eight changes proposed by the competitor
research (report of 2026-11-12 comparing 16 live-TV apps; not in the repository). All eight are **Phase 1** and binding;
where they change an earlier decision above, this entry wins:

1. **Release the old stream on a switch** (§7.4, §12.2): when a person switches channel and was the old stream's only
   viewer, and the new channel needs the provider connection or a conversion slot the old stream holds, the old stream stops
   at once instead of lingering 60 s. Otherwise the 60-s linger stays.
2. **Remote keys** (§11.3, §12.3, §12.4, §14): do not rely on LG CH+/CH− (LG staff: not available to webOS web apps).
   ▲/▼ zap on every TV; the hint line shows only keys the device has actually sent; a lone **0** = last channel; Tizen registers
   `ChannelList` and `Guide` where the TV supports them. Every live feature has a D-pad + OK + Back path.
3. ***Von Anfang an*** (§12.1): restart the running programme when its start is still in the time-shift buffer.
   `LIVETV_DVR_MINUTES` may be set up to **120** (default stays **30**) (§3.3, §6.4).
4. **Info banner** (§12.2): the 1-second channel card becomes an info banner (logo, number, name, *Jetzt* + progress +
   time left, *Danach*), shown until the first frame plus about 4 s.
5. **TV remote in the player** (§12.3): OK shows the controls (it does not pause); a long OK opens the *Senderliste* panel;
   Back from that panel (and, in Phase 2, from the guide) returns focus to the playing channel.
6. **EPG matching basics in Phase 1c** (§6.1, §9.1, §9.4): a time offset per source and per channel (`tvg-shift`),
   case-insensitive tvg-id → tvg-name → display name before any fuzzy match, a logo preference, a numbering policy.
7. **Large provider lists** (§8, §9.1, §9.3): after *Prüfen* the admin picks which groups to import; new provider groups are
   hidden and granted to no role until the admin releases them. This replaces the earlier default of granting new groups to
   admin, family and friend.
8. **Recently watched and ordered favourites** (§6.1, §11.1, §12.2): the last 10 channels (*Zuletzt gesehen*), favourites in
   the person's own order, and a time-left label ("noch 23 Min.").

Later items of the research stay out of Phases 1–3 (§25).

**Programmführer (owner decision, 2026-11-12).** The owner approved all 12 recommendations of the guide research (report of
2026-11-12 on the programme guides of 19 services; not in the repository) and decided its open questions. All are
**Phase 2** requirements, written in §17 (G1–G44); this entry wins over earlier guide text:

1. **Data states** shown honestly: loading placeholders per block, "Programmdaten bis {time}", "Programm gerade nicht
   verfügbar", stale EPG for admins only (§17.4).
2. **Filters and favourites in the TV guide** too. The guide opens on *Favoriten* if the profile has any, else on the group
   chosen last; *Alle* is paged by 300 channels and, above 1 000 channels, sits behind the group choice on TV (§17.2).
3. **Time jumps by remote**: `MediaRewind`/`MediaFastForward` ∓2 h, `ColorF0Red`/`ColorF1Green` ∓24 h, `ColorF2Yellow` =
   *Jetzt*, always with a button path; desktop `Home`, `Alt+←/→`, `PageUp/Down` (§17.3, §14).
4. **Mini-guide in the player** is Phase 2 and **extends the §12.2 *Senderliste* panel** (one component, not two) (§17.7).
5. **Progress and "läuft"** on the running cell, never fill only (§17.1).
6. **Von Anfang an marker** on cells; past cells use the style "vorbei, nicht abspielbar"; catch-up stays later (§17.1, §25).
7. **Genre stripe**: 4 px on the left edge, 6 classes (Film, Serie, Sport, Nachrichten, Kinder, Doku) from XMLTV
   `<category>` by a simple built-in mapping, user switch *Farben im Programmführer* (default on), no stripe without a
   genre, never colour alone (§17.1).
8. **Search in the guide header first**: title search over the held 8 days, a result jumps to its cell; global-search hits
   stay later (§17.5, §25).
9. **Phone**: a *Raster | Jetzt/Danach* toggle, last choice remembered (§17.6).
10. **Time-of-day jumps** (*Morgens*, *Mittags*, *Abends*, *20:15*, *Nachts*) next to the day chips (§17.3).
11. **Performance rules and acceptance numbers** (§17.8).
12. **Accessibility**: cell focus with roving tabindex, full cell announcements, contrast, reduced motion (§17.9, §21).

Also binding: TV guide text ≥ 28 px at 1080p (title, time, axis) and past cells ≥ 4.5:1 contrast — no `.55` opacity dimming
of text.

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
- No SRT push without a generated stream id + passphrase, no RTMP/WHIP/RTSP ingest, no TCP ingest ports: pushed feeds come in
  only over SRT on the published UDP range (§3.5).
- No adaptive bitrate ladder for live: one rendition per channel (the *Mobile-Qualität* rendition stays a later, off option).
- No catch-up / replay TV beyond the time-shift buffer (`LIVETV_DVR_MINUTES`, *Von Anfang an* included) and recordings; no
  provider VOD (M3U entries for films and series are skipped on import). Provider catch-up stays a later item (§25).
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
  rings (TV: `scale(1.08)` + 3 px white ring, one focused element). No Live-TV-specific palette; the only colour cues added are
  the guide's red *jetzt* line and the red recording dot, both using the existing danger red token `--err`, and (owner
  decision 2026-11-12, Phase 2) the guide's six genre stripe tokens `--fr-genre-*` (§17.1 G9); each is also carried by
  text or shape (never colour alone).
- **i18n:** everything through `#lib/i18n`, seven locales (`de` source, `en` second); copy table in §20.
- **Remote:** every live feature works with D-pad + OK + Back alone (the Android TV rule, and many remotes send nothing
  else). Channel, digit, colour, Info, `ChannelList` and `Guide` keys and a long OK are shortcuts, never the only way.
  Hints never name a key the device has not sent (§11.3).
- **Old TV browsers:** web code reaches Tizen (Chromium 85) and webOS (Chromium 87); live files use nothing newer.
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
| **1** | **1a** | Shared conversion budget + benchmark (backend `convbudget.ts`, `/api/playback/info` gate, card *Umwandlungen* in Admin → *Betrieb* → *Wiedergabe-Check*). No Live TV needed. |
| | **1b** | `livetv` image + compose profile + GPU overlays + updater actions + backend detection + *Live-TV (optional)* entry + enable/disable flow. |
| | **1c** | Sources, import (M3U/XMLTV) with the group picker and unreleased new groups, numbering policy, logo preference, EPG time offsets, channels (pulled and pushed own feeds, §3.5), groups & rights, logos, admin *Quellen* / *Kanäle* / *Gruppen & Rechte* / *Live-Status*; now/next from XMLTV (automatic matching in four exact passes, §9.4). Migration 48. |
| | **1d** | Watching: tokens, gateway route, shared streams (incl. SRT push ingest, §3.5), DVR up to 120 min, release on switch, budget admission, the *Live-TV* tab (desktop, phone, kids, TV), live player (info banner, *Von Anfang an*, *Senderliste* panel), favourites in own order, *Zuletzt gesehen*, last channel, Chromecast/AirPlay, *TV startet mit Live-TV*. |
| | **1e** | Platform keys and shells: Tizen key registration (incl. `ChannelList`/`Guide`), webOS key mapping, Fire TV `FireTvKeys`, Android shell cast bridge `castLive`. |
| **2** | 2a | EPG admin: *Programmführer* tab (matching with suggestions, unmatched list, manual EPG entries/rules), stale-EPG line in *Quellen* (§17 G29). Migration at the next free index at merge time. |
| | 2b | The guide for users (§17, G1–G44): grid on desktop, phone (with the *Jetzt/Danach* list) and TV, filters incl. TV, paged *Alle*, time chips and remote time jumps, data states, running progress, *Von Anfang an* markers, genre stripe, search in the guide, detail sheet, reminders, the mini-guide as the extended *Senderliste* panel, performance acceptance. |
| **3** | 3a | Recordings backend + `livetv` recorder + storage modes (incl. the library sub-folder mount, §15.3) + budget reservation + notifications. Migration at the next free index at merge time. |
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
     │  DB: sources, channels, groups, EPG,          │  ffmpeg / HLS proxy / DVR cache / recorder / SRT listener
     │  rights, recordings, budget                   │  networks: livetv (internal) + livetv-egress (internet / LAN)
     │                                               ▲  encoders (OBS …) push SRT to UDP ${LIVETV_SRT_PORTS} (§3.5)
     │                                               │
     └──signed HTTP──► updater ──► docker-proxy ──► docker (pull/up/stop livetv; profile livetv)
```

- **backend** owns all state (Postgres), decides who may watch what, admits conversions against the budget, mints tokens,
  schedules refreshes and recordings, and tells `livetv` what to run. It never talks to provider hosts itself.
- **livetv** (new service, Node + jellyfin-ffmpeg) is the only component that fetches provider/own-feed URLs: M3U and XMLTV
  downloads (parsed with hard limits), logos, stream inputs, probes, benchmarks, recordings. It is also the only component
  that accepts pushed SRT feeds (§3.5). It holds no database and no
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
  # in .env). Fetches provider lists, EPG and streams; the backend tells it what to run. No Docker socket. Its only published
  # ports are the UDP range for pushed SRT feeds (LIVETV_SRT_PORTS; open them on the firewall only if you push feeds).
  livetv:
    profiles: [livetv]
    image: ${FF_REGISTRY:-ghcr.io/letsmanu}/friendflix-livetv:${FF_TAG:-latest}
    pull_policy: always
    restart: unless-stopped
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    group_add: ["10001"] # reads bootstrap-livetv (livetv_key only; see the ruling below)
    environment:
      LIVETV_CACHE_MAX_GB: ${LIVETV_CACHE_MAX_GB:-6}
      LIVETV_SRT_PORTS: ${LIVETV_SRT_PORTS:-9000-9009}
      TZ: ${TZ:-Europe/Vienna}
    ports:
      # SRT push (§3.5): UDP only, same numbers outside and inside so the setup hint shows the real port.
      - "${LIVETV_SRT_BIND:-127.0.0.1}:${LIVETV_SRT_PORTS:-9000-9009}:${LIVETV_SRT_PORTS:-9000-9009}/udp"
    volumes:
      - livetv-cache:/cache                                   # DVR segments, previews (disposable)
      - ${RECORDINGS_PATH:-recordings}:/recordings             # Phase 3
      - bootstrap-livetv:/run/friendflix-livetv:ro
    depends_on:
      bootstrap: { condition: service_completed_successfully }
    networks: [livetv, livetv-egress]
```

- **Ruling (1b review): derived key, not the raw secret.** livetv never receives `INTERNAL_SECRET`. The `bootstrap` service
  writes only `HMAC-SHA256(INTERNAL_SECRET, 'friendflix-livetv/v1')` (64 hex) as `livetv_key` into its own volume
  `bootstrap-livetv` (root:10001, 0440, rewritten on every start), which only livetv mounts, read-only; the backend derives the
  same key in memory. Why: `INTERNAL_SECRET` is the key to the backend's `/internal/*` routes (the media server token among
  them) and the root of the updater key, and livetv parses hostile provider input with ffmpeg; a taken-over livetv must hold
  nothing but its own key. Without the key file livetv refuses to start.

- Networks (defined always, like `updater`): `livetv` (`internal: true`; backend, gateway and livetv join it) and
  `livetv-egress` (normal bridge; only livetv). Backend and gateway gain `livetv` in their `networks`; the gateway also mounts
  `${RECORDINGS_PATH:-recordings}:/data/recordings:ro` (Phase 3). Volumes `livetv-cache`, `recordings` are added to `volumes:`.
- Env-only keys (`ENV_ONLY_KEYS`): `LIVETV_URL` (backend and gateway; default `http://livetv:8090`). Compose-only:
  `LIVETV_SRT_PORTS` (a range `A-B`, 1–100 ports, default `9000-9009`; also passed into `livetv`, which listens on exactly
  these) and `LIVETV_SRT_BIND` (host address the range is published on, default `127.0.0.1` = push off from outside; `0.0.0.0` or
  the LAN address only when push is used). **Ruling (1b review M11):** the default was `0.0.0.0`; Docker-published ports bypass
  ufw/firewalld on most hosts, so the range would be open from outside as soon as livetv runs, push or not.
- **Library overlay** (Phase 3, opt-in, `compose.livetv-library.yaml`): the one read-write mount into the media share, see
  §15.3.
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
| `GET /healthz` | `{ ok, version, bootId }` (unsigned); with `?n=<32 hex>` also `proof` = hex `HMAC(key, 'healthz:' + n)` (ruling 1b review I2, §4.1) |
| `GET /v1/system` | `{ cpu: { model, cores, loadPct }, gpu: { devices: string[], driver: string \| null, readable: boolean, busyPct: number \| null }, encoders: Array<'h264_qsv'\|'h264_vaapi'\|'h264_nvenc'\|'libx264'>, cache: { usedBytes, maxBytes }, recordings: { usedBytes, freeBytes } \| null }` |
| `POST /v1/fetch/m3u` | `{ url, userAgent?, allowLan, skipGroups?: string[] }` → `{ entries: [{ key, name, tvgId?, tvgName?, chno?, group?, logo?, shiftMin?, url, kind }], groups: [{ name, channels }], listed, skipped: { vod, invalid, overLimit, groups } }`; entries of `skipGroups` are dropped **before** the 20 000 cap, so a big list keeps the picked groups; `groups` and `listed` count every live entry (for the picker and the shrink guard); `shiftMin` = the entry's `tvg-shift`, else the `#EXTM3U` header's, in minutes |
| `POST /v1/fetch/xmltv` | `{ url, userAgent?, allowLan, channels?: string[], from, to }` → NDJSON stream: `{ t:'channel', id, names[], icon? }` / `{ t:'prog', ch, start, end, title, subtitle?, desc?, cats?, episode?, seriesId?, isNew?, prevShown?, rating? }` |
| `POST /v1/fetch/logo` | `{ url, allowLan }` → image bytes (`image/png \| jpeg \| webp`) or 422 |
| `POST /v1/probe` | `{ input }` → `{ ok, video?: { codec, width, height, fps }, audio?: { codec, channels }, needs: 'passthrough'\|'remux'\|'transcode', error?: code }` (10 s budget) |
| `POST /v1/streams` | `{ channelId, input, mode, encoder, dvrSeconds, maxBitrate }` → `{ streamKey, state:'starting'\|'running' }` (idempotent per `channelId`) |
| `GET /v1/streams` | running streams: `{ channelId, streamKey, mode, since, state, bitrate, errors, lastSegmentAt }[]` |
| `DELETE /v1/streams/:channelId` | stop now |
| `GET /v1/streams/:channelId/preview.jpg` | latest keyframe snapshot (320 px wide, refreshed ≤ every 60 s while running; 404 when not running) |
| `POST /v1/benchmark` | `{ encoder }` → `{ speed, encoder, seconds }` (20 s of 1080p25 `testsrc2` → H.264 6 Mbit/s → null) |
| `PUT /v1/ingest` | `{ feeds: [{ channelId, port, streamId, passphrase }] }` → `{ ok, listening: number[] }`: the complete set of push feeds (§3.5), replaced atomically; sent by the backend at every change and whenever `livetv`'s `bootId` (in `/healthz`) changes |
| `GET /v1/ingest` | `[{ channelId, port, state: 'idle'\|'receiving', since, bitrate, rejected1h }]` (never the passphrase or the peer address) |
| `POST /v1/recordings` (Phase 3) | `{ id, input, mode, encoder, dir, startAt, endAt }` → `{ state }` |
| `DELETE /v1/recordings/:id` (Phase 3) | stop (keeps files) · `POST /v1/recordings/:id/delete` removes files · `POST /v1/recordings/:id/export` copies/concats into the library folder |
| `GET /s/<streamKey>/<file>` | `index.m3u8`, `init.mp4`, `<n>.ts` / `<n>.m4s` for the gateway |

`input` = `{ url, kind: 'hls'|'ts'|'srt', userAgent?, allowLan }` (pulled; decrypted by the backend just before the call) or
`{ push: channelId }` (a pushed feed, read from `livetv`'s own ingest, §3.5). `GET /v1/system` also reports
`srt: { ports: number[] }` (the parsed `LIVETV_SRT_PORTS`).

### 3.3 Stream modes

| Source | Default mode | Counts against budget |
|---|---|---|
| Provider/own **HLS** | **passthrough**: `livetv` acts as an HLS proxy. It picks one variant (highest bandwidth ≤ `maxBitrate`, default 10 Mbit/s, H.264 preferred), fetches its media playlist and segments once for all viewers, stores segments in the DVR cache, serves its own playlist with local names (`<seq>.ts` / `<seq>.m4s`, `init.mp4`). Provider URLs never leave `livetv`. | no |
| **MPEG-TS** over HTTP | **remux**: `ffmpeg -c:v copy`, audio copied when AAC/MP3, else AAC stereo 160 kbit/s (audio-only conversion is cheap and is **not** counted), HLS 4 s segments | no |
| **SRT** (caller, pulled) | probe → **remux** when H.264 + AAC/MP3 (or audio-only conversion as above), else **transcode** | only when transcoding |
| **SRT push** (listener, §3.5) | same as SRT caller, probed from the ingest when the first viewer or recording starts | only when transcoding |
| any source whose video is not H.264 (HEVC, MPEG-2) | **transcode**: H.264 High ≤ 1080p, 6 Mbit/s (720p: 3 Mbit/s), GOP 2 s, AAC stereo, HLS 4 s; encoder per `LIVETV_ENCODER` (§5.4) | yes |

- **One stream per channel** for all viewers; viewers join a running stream without any new work.
- **DVR window**: `LIVETV_DVR_MINUTES` (0–120, **default 30**; owner decision 2026-11-12) of segments on disk; the playlist
  is a sliding live playlist whose window is the DVR length (no `EXT-X-PLAYLIST-TYPE`), so hls.js and Safari offer pause and
  rewind inside it. When `livetv-cache` passes `LIVETV_CACHE_MAX_GB`, the oldest segments of the stream with the longest
  window are dropped first (windows shrink, never the live edge). Rough size: 120 min of a 6 Mbit/s channel ≈ 5.4 GB, so
  with the default cache cap of 6 GB two long windows already shrink each other; the setting's help text says so.
- **Wall-clock times:** every segment line carries `#EXT-X-PROGRAM-DATE-TIME` (the provider's value when its playlist has
  one, else the time the segment arrived in `livetv` minus its duration), so the player can map a programme's start to a
  position in the buffer (*Von Anfang an*, §12.1).
- **Stop**: the backend stops a stream 60 s after its last viewer left, or at once on a switch that needs its connection or
  slot (§7.4). Safety net inside `livetv`: a stream with no
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

### 3.5 SRT push (listener mode)

Owner answer (2026-11-11): own feeds may **push** into FriendFlix. Pull mode (§3.3, `srt://host:port` in caller mode, HLS,
MPEG-TS) stays exactly as it is; push is a second way to add an own feed.

- **Ports.** `livetv` listens on every UDP port of `LIVETV_SRT_PORTS` (compose, default `9000-9009`, published with the same
  numbers on the host, §3.1). Each push feed is assigned **one port** of the range (the lowest free one) when it is created; a
  range of 10 ports carries at most 10 push feeds. When the range is full, *Stream hinzufügen* says "Alle {n} Ports für
  gesendete Streams sind belegt. Vergrößere LIVETV_SRT_PORTS in der .env." Only UDP is published; nothing goes through the
  reverse proxy (it handles HTTP only).
- **Credentials.** Per push feed the backend generates a **stream id** (`ff-` + 16 random base32 chars, SRT `streamid`) and a
  **passphrase** (32 random base64url chars; SRT AES-256 encryption, `pbkeylen 32`). Both are stored encrypted
  (`APP_ENC_KEY`, as stream URLs) and shown to the admin **once**, in the result sheet of *Stream hinzufügen* (and after
  *Zugangsdaten neu erzeugen*), each with a copy button, plus the full SRT URL for encoders that take one
  (`srt://<host>:<port>?streamid=<id>&passphrase=<pass>&pbkeylen=32&mode=caller&latency=200000`) and an *OBS/Encoder einrichten*
  hint (§9.1). Afterwards the admin sees only the host, port and the first 6 characters of the stream id; a lost passphrase is
  replaced by *Zugangsdaten neu erzeugen* (the old one stops working at once; a running push is dropped).
- **Host shown in the hint:** setting `LIVETV_SRT_HOST` (DB, group `livetv`, string, default = the host of `PUBLIC_URL`). If
  the public name is proxied by a CDN that does not pass UDP (e.g. an orange-cloud Cloudflare record), the admin sets a DNS-only
  name or the public IP here; the hint says so.
- **Accepting a connection.** `livetv`'s ingest (`src/srtingest.ts`, libsrt through a small native binding with
  `srt_listen_callback`) reads the caller's stream id during the handshake, looks up the feed **of that port**, sets that feed's
  passphrase on the socket and accepts; an unknown stream id, a stream id of another port or a wrong passphrase is **rejected
  in the handshake** (SRT reject reason `SRT_REJX_FORBIDDEN`; a wrong passphrase fails the key exchange). One sender per feed:
  a second caller with valid credentials while one is sending is rejected (`SRT_REJX_CONFLICT`). An address with 20 rejected
  handshakes within 1 min is ignored for 10 min. Rejections are counted (`rejected1h`) and become one *Live-Status* event per
  feed per 10 min ("Verbindung abgelehnt: falsche Kennung oder Passphrase") — never with the passphrase, the stream id or the
  peer address.
- **Live only while sending.** A push feed is *live* while the encoder sends (state `receiving`: an accepted connection with
  data in the last 5 s). Otherwise the channel is listed normally with the line "Gerade keine Übertragung" instead of
  *Jetzt*/*Danach* (manual EPG entries still show in the guide) and *watch* answers 409 `not_receiving`; the player shows
  "Gerade keine Übertragung" and switches to the stream by itself when the encoder starts (it polls the channel state every
  10 s). If the encoder stops while people watch, the input-lost state (§12.5) shows "Gerade keine Übertragung" instead of
  "Sender gerade nicht erreichbar" and the stream stops 60 s later like any stream without input.
- **Cost while idle.** Listening costs no ffmpeg process. Received data goes into a 4-s in-memory ring per feed; an ffmpeg
  process (remux or transcode, §3.3) reads from it only while the channel has viewers or a recording, exactly like a pulled
  feed. The budget (§5) applies the same way: probe at start, `transcode` takes a `live` (or `record`) slot, remux does not.
- **Plays and records like a pulled feed:** same tokens, gateway route, DVR, sharing, casting, recordings (a recording of a
  push feed that is not receiving waits; the time without data is a gap, §15.2), same rights (the feed's group).
- **Sync.** The backend owns the feeds (DB) and sends the complete list with `PUT /v1/ingest` (§3.2); `livetv` keeps it in
  memory only and listens on every port of the range, accepting nothing on a port without a feed.
- **Firewall.** The owner opens (or forwards on the router) **UDP** `LIVETV_SRT_PORTS` (default 9000–9009) to the server, and
  only if a push feed is used; `docs/livetv.md` and the *Quellen* tab say which ports. No TCP port is needed.

## 4. Enabling, disabling and detection

### 4.1 Detection

- The backend polls `GET ${LIVETV_URL}/healthz` every 60 s (and on every admin page load of the area, cached 10 s).
  `installed = reachable && version compatible && proof of key`. **Ruling (1b review I2):** the signature authenticates the
  backend to livetv, never livetv to the backend, and while the profile is off the name `livetv` can resolve to a LAN host. So
  every check sends a fresh random nonce (`/healthz?n=<32 hex>`) and livetv answers `proof = HMAC(key, 'healthz:' + nonce)`; the
  backend compares it in constant time. A wrong or missing proof is "reachable, not installed" (a rate-limited warning, no
  secrets). No signed call (so no decrypted URL or other secret) is sent without a proof younger than 10 s (withdrawn at once by a failed connection or an accepted disable / remove; the remaining ≤ 10 s window is an accepted residual, signed responses are not part of Phase 1). A setting `LIVETV_WANTED` (internal, not shown) remembers that an admin turned
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

### 5.6 Admin UI (new first card *Umwandlungen* on Admin → *Betrieb* → *Wiedergabe-Check*)

Where it lives today: the admin sidebar group *Betrieb* (`admin.nav.groups.operations`) has the entry *Wiedergabe-Check*
(`admin.tabs.playback`, `/admin/playback`, `web/src/lib/admin/nav.ts`); that page already lists the running streams. The
card becomes its first card; the menu label stays *Wiedergabe-Check*.

- Big number "2 von 3 belegt" with a slot bar (`3` segments, filled by kind: film / live / recording / other, icon + label per
  segment, never colour only); list of what runs (kind icon, label: title or channel name, since, device); *Neu messen* button
  (disabled with reason while busy).
- "Gemessen 4,6× Echtzeit (Jellyfin, Intel QSV) · Live-TV 4,4× · empfohlen 3 · geprüft heute 03:10" (§5.3:
  floor(min(4,6; 4,4) × 0,7) = floor(3,08) = 3).
- *Gleichzeitige Umwandlungen*: segmented *Automatisch (3)* / *Eigener Wert* + number stepper 1–16.
- *Vorrang*: *Filme & Serien zuerst* / *Live-TV zuerst* / *Gleichrangig*, with a one-line explanation **for the selected
  option** (the same three texts in §20, `adminConv.priority.hint.*`):
  - *Filme & Serien zuerst*: "Live-TV lässt einen Platz für Filme & Serien frei (ab 2 Plätzen)."
  - *Live-TV zuerst*: "Filme & Serien lassen einen Platz für Live-TV frei (ab 2 Plätzen)."
  - *Gleichrangig*: "Kein Platz wird freigehalten – wer zuerst kommt, bekommt ihn."
- The same card (read-only, with a link) appears on *Live-Status*.

## 6. Data model

### 6.1 Migration 48 (Phase 1c) — Live TV core

Numbering (controller ruling, 2026-11-11): 46 is taken by the device hand-off plan (builds first), 47 by Phase 0 (users &
permissions); Live TV uses 48, 49, 50 in its phase order. Never reorder.

```sql
-- 48: Live TV core. Sources and channel stream URLs are stored encrypted (APP_ENC_KEY blob, like settings.enc); *_hint is a
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
  skip_groups text[] not null default '{}', -- provider group-titles the admin did not pick (§9.1); never imported
  numbering text not null default 'chno' check (numbering in ('chno','order')), -- tvg-chno first, or list order only
  number_base int not null default 1,
  logo_pref text not null default 'm3u' check (logo_pref in ('m3u','xmltv')), -- which imported logo wins (own upload always)
  epg_shift_min int not null default 0 check (epg_shift_min between -720 and 840), -- EPG time offset of the source
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
  released boolean not null default true, -- false: created by an import; hidden from every user until the admin releases it
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
  role text not null references roles(key) on delete cascade, -- roles table from migration 47 (Phase 0)
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
  stream_url_enc text,                    -- pulled feeds; null for push feeds
  stream_kind text not null check (stream_kind in ('hls','ts','srt')),
  ingest text not null default 'pull' check (ingest in ('pull','push')), -- push = SRT listener (§3.5), manual source only
  push_port int unique check (push_port between 1 and 65535),
  push_stream_id_enc text,                -- APP_ENC_KEY blob; push_stream_id_hint = first 6 chars for the admin
  push_stream_id_hint text,
  push_passphrase_enc text,
  allow_lan boolean,                      -- manual feeds; null = the source's value
  import_name text not null, import_number int, import_group text, import_logo_hash text, tvg_id text, tvg_name text,
  import_epg_shift_min int,               -- M3U tvg-shift (entry, else #EXTM3U header), in minutes; null = none
  name_override text check (char_length(name_override) between 1 and 60),
  number_override int check (number_override between 1 and 99999),
  group_override uuid references livetv_groups(id) on delete set null,
  logo_override_hash text,
  epg_shift_override_min int check (epg_shift_override_min between -720 and 840),
  hidden boolean not null default false,
  epg_source_id uuid references livetv_sources(id) on delete set null,
  epg_channel_id text,
  epg_match text not null default 'auto' check (epg_match in ('auto','manual','none')),
  epg_logo_hash text,                     -- <icon> of the matched XMLTV channel (fetched during the EPG refresh)
  probe jsonb,                            -- last probe: { at, ok, video, audio, needs }
  missing_since timestamptz,              -- not in the latest import; deleted 30 days later
  created_at timestamptz not null default now(),
  unique (source_id, source_key),
  check ((ingest = 'pull') = (stream_url_enc is not null)),
  check ((ingest = 'push') = (push_port is not null and push_stream_id_enc is not null and push_passphrase_enc is not null
                              and stream_kind = 'srt'))
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
create table livetv_recent (              -- Zuletzt gesehen: newest first, at most 10 rows per profile (trimmed on write)
  profile_id uuid not null references profiles(id) on delete cascade,
  channel_id uuid not null references livetv_channels(id) on delete cascade,
  at timestamptz not null default now(),
  primary key (profile_id, channel_id)
);
create index livetv_recent_profile on livetv_recent(profile_id, at desc);
alter table devices add column start_live boolean not null default false;
```

Derived values (one SQL view `livetv_channels_v` or a function in `livetv/channels.ts`): effective name =
`name_override ?? import_name`; number = `number_override ?? import_number`, where the import writes `import_number` by the
source's numbering policy (`chno`: the entry's `tvg-chno`, else `number_base` + its position in the list; `order`:
`number_base` + position, `tvg-chno` ignored; position counts every live entry of the list, skipped groups included, so a
changed group selection never renumbers other channels); group = `group_override ?? group_map(source, import_group)`; logo =
`logo_override_hash ??` (`logo_pref = 'm3u'`: `import_logo_hash ?? epg_logo_hash`; `'xmltv'`: `epg_logo_hash ??
import_logo_hash`); EPG offset = `epg_shift_override_min ?? import_epg_shift_min ?? source.epg_shift_min` (the most specific
value wins; offsets are applied when programmes are read, never stored into them, so one EPG channel can serve channels with
different offsets). *Last channel* = the profile's newest `livetv_recent` row, *previous* = the second newest. Duplicate
effective numbers are allowed but flagged in the admin (number entry picks the channel with the lowest group position).

### 6.2 Phase 2 migration (next free index at merge time) — manual EPG and reminders

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

### 6.3 Phase 3 migration (next free index at merge time) — recordings

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
| `LIVETV_SRT_HOST` | string (host name or IP shown in the push setup hint) | host of `PUBLIC_URL` | 1c |
| `LIVETV_DVR_MINUTES` | int 0–120 | 30 | 1d |
| `LIVETV_MAX_BITRATE` | int bit/s 1–40 Mbit/s | 10 000 000 | 1d |
| `LIVETV_RECORD_STORAGE` | enum ff / library / both | ff | 3 |
| `LIVETV_RECORD_LIBRARY_ID` | string (Jellyfin library id) | – | 3 |
| `LIVETV_RECORD_LIBRARY_JF_PATH` | string (the folder as Jellyfin sees it) | `/media/Aufnahmen` | 3 |
| `LIVETV_RECORD_LIMIT_GB` | number 1–100 000 | 200 | 3 |
| `LIVETV_RECORD_RETENTION_DAYS` | int 0–365 (0 = off) | 30 | 3 |
| `LIVETV_RECORD_PAD_BEFORE_MIN` / `_AFTER_MIN` | int 0–30 / 0–120 | 2 / 5 | 3 |
| `LIVETV_RECORD_MAX_PARALLEL` | int 1–8 | 4 | 3 |
| `LIVETV_REENCODE` + `LIVETV_REENCODE_HOURS` | bool + "HH:MM-HH:MM" | false, 01:00-06:00 | later |

Env-only: `LIVETV_URL`; compose-only (not settings): `LIVETV_CACHE_MAX_GB`, `RECORDINGS_PATH`, `RENDER_GID`,
`LIVETV_SRT_PORTS`, `LIVETV_SRT_BIND`, `RECORDINGS_LIBRARY_PATH`.

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
  start failed after 15 s), 409 `not_receiving` (a push feed whose encoder is not sending, §3.5), 429 `max_streams` (the account's `maxStreams` from Phase 0 rights; a live view counts as a stream,
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
  appear in the running streams of Admin → *Betrieb* → *Wiedergabe-Check*, and the upload-aware cap (`uploadcap.ts`)
  counts remote live viewers.
- **Start:** `watch` on a channel that is not running: (1) budget: if the expected mode is `transcode` (from `probe`; SRT
  without a fresh probe counts as transcode) → `admitConversion('live')`, refused → 503 `live_full`; (2) `POST /v1/streams`;
  (3) wait for the first segment (≤ 15 s; the client shows "Sender wird gestartet …"); (4) when the probe at start says
  `remux` after all, the slot is released.
- **Stop:** `livetvTick` (every 15 s, one runner via KV lock `ltv:tick`) stops a stream whose viewer count has been 0 for 60 s
  and no recording uses it (§15). Admin *Stoppen* stops it at once (viewers see the error state).
- **Release on switch** (owner decision 2026-11-12): a `watch` from a device whose own live view is on another channel A is a
  *switch*. The old stream A is stopped **at once**, before channel B starts, when all of these hold:
  1. the switching device was A's only viewer (no other live token on A touched within 45 s, casts and admin test previews
     count as viewers) and no recording uses A;
  2. B is not running; and
  3. B's start would otherwise be refused, and counting A as gone makes it pass: either B's source is at its *Max.
     gleichzeitige Sender* and A belongs to the same source, or A holds a `live` budget slot (mode `transcode`) and B's
     expected mode needs one while the budget is full.

  The check and B's admission happen under the budget lock with A left out of the count; then A is marked *stopping*
  (`ltv:stopping:<A>`), its viewers are counted once more (a viewer who joined meanwhile cancels the release: the marker is
  removed and the switch gets the refusal it would have got, `live_full` / `provider_limit`), and A is stopped with its
  grant dropped before B's `POST /v1/streams`. A `watch` on A while the marker exists waits (≤ 5 s) and then starts A again
  through the normal start path. Event `released_on_switch` in *Live-Status*. In every other case A lingers for 60 s as
  above, so switching back within a minute stays instant.
- **Join:** a viewer on a running channel never touches the budget.

## 8. Rights

- **Effective channel set of a profile** (`livetv/rights.ts`, cached 60 s, invalidated on any group/channel/rights write):
  1. Account lacks `liveTv` (Phase 0 rights, kids overlay included) → no channels.
  2. Groups allowed = groups granted to the account's role (`livetv_group_roles`), plus `livetv_group_users.allow = true`,
     minus `allow = false`. Admin role: all groups. Groups with `released = false` are left out for everyone, admins
     included (they see them only in the admin area).
  3. Kids profile → only allowed groups that are `kid_friendly` (a kids profile of an admin account sees kid-friendly groups
     only). No kid-friendly group → no tab.
  4. Channels: in those groups, not `hidden`, not `missing_since`, source enabled.
- **New provider groups are hidden** (owner decision 2026-11-12, replaces the earlier grant to admin/family/friend): a group
  an import creates is `released = false`, granted to no role and not kid-friendly. Its channels are imported (so the admin
  can test and sort them) but nobody sees them until the admin releases the group in *Gruppen & Rechte* (§9.3) and picks its
  roles. Groups the admin creates by hand start released. A provider group that maps onto an existing group (same name, or
  mapped earlier) keeps that group's state.
- **Recording** (Phase 3): `liveRecord` (Phase 0 permission; default ✓ for admin/family/friend, – for guest; never kids) and
  the channel must be in the profile's set.
- **Favourites** (in the person's own order), *Zuletzt gesehen* (the last 10 channels) and *last channel* are per profile; a
  favourite or recent channel the profile can no longer see is hidden (not deleted) and comes back if the right returns.
- Phase 0 integration: the role matrix shows *Live-TV* (switch), *Darf aufnehmen* (switch) and *Kanalgruppen* (chips: "Sport,
  Nachrichten +2"); the person's *Rechte* tab shows group exceptions; *Sicht prüfen* shows the profile's groups and channel
  count with reasons ("nicht kinderfreundlich", "für Gast nicht freigegeben", "Gruppe noch nicht freigegeben").

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
  with "unverändert lassen"), optional XMLTV URL, user agent (advanced), *LAN erlauben*, interval, and the import options
  (owner decision 2026-11-12, all in the sheet's *Import* section):
  - **Nummern:** segmented *Aus der Liste (tvg-chno)* (default) / *Nach Reihenfolge ab* + number field (`number_base`,
    1–99 999); help line "Eigene Nummern aus *Kanäle* bleiben erhalten." (§6.1 derived number).
  - **Senderlogos:** segmented *Aus der Senderliste zuerst* (default) / *Aus dem Programmführer zuerst*; help line "Ein
    eigenes Logo geht immer vor."
  - **Programm-Zeit verschieben:** stepper in hours, −12 to +14 in steps of 0,5 (`epg_shift_min`, default 0); help line
    "Für Programmführer, deren Zeiten um Stunden daneben liegen. `tvg-shift` aus der Senderliste und Werte einzelner Sender
    gehen vor."
- **Prüfen and the group picker.** *Prüfen* runs `POST /sources/test` and shows "412 Sender in 18 Gruppen · EPG: 398 Kanäle"
  plus five sample names, or the error, before *Speichern*. With a result, the sheet lists the provider groups as
  **"18 Gruppen gefunden – welche übernehmen?"**: a search field (from 12 groups on), *Alle* / *Keine*, then one checkbox row
  per group with its channel count ("DE | Sport · 42 Sender"), all ticked on first use; on edit, ticked = not in
  `skip_groups`. The counter line under it says "312 von 412 Sendern werden übernommen". Unticked groups are stored in
  `skip_groups` and never imported; their entries already imported become *missing* (hidden at once, deleted after 30
  days, back with their overrides when ticked again). The line below the list: "Neue Gruppen bleiben verborgen, bis du sie
  unter *Gruppen & Rechte* freigibst." The source card shows the selection ("Ohne 6 Gruppen · Auswahl ändern" opens the
  sheet at the picker, which runs *Prüfen* again). New groups that appear in later refreshes are imported unreleased (§8),
  never skipped, so a group the provider adds later (an adult group, say) reaches nobody until the admin releases it.
- Own feeds (*Eigene Streams* source, created on first use): *Stream hinzufügen* sheet with a segmented choice
  *FriendFlix holt den Stream* (pull) / *Encoder sendet an FriendFlix* (push, SRT):
  - **pull** (unchanged): name, URL (`https://…m3u8`, `http://…ts`, `srt://192.0.2.10:9000?…`), kind auto-detected from the URL
    (editable), number, group, *LAN erlauben*, *Testen*.
  - **push** (§3.5): name, number, group; *Anlegen* reserves a port and generates the credentials, then the sheet turns into
    the **one-time result**: *Server* (`LIVETV_SRT_HOST`), *Port*, *Stream-ID*, *Passphrase*, *SRT-Adresse* (the full URL),
    each a read-only field with a copy button (`runAction` toast "Kopiert"), the warning "Die Passphrase wird nur jetzt
    angezeigt." and the expandable **OBS/Encoder einrichten** hint: "OBS: Einstellungen → Stream → Dienst *Benutzerdefiniert*,
    Server = die SRT-Adresse, Streamschlüssel leer lassen. Andere Encoder: Modus *Caller*, Verschlüsselung AES-256
    (pbkeylen 32), Latenz 200 ms. Video H.264 + Audio AAC spart Umwandlungen." plus "Die Firewall bzw. der Router muss UDP-Port
    {port} an den Server weiterleiten." *Fertig* closes it; the values never come back.
  - The *Eigene Streams* card shows for each push feed: port, stream-id hint ("ff-AB12CD…"), state chip *Sendet* / *Keine
    Übertragung* (from `GET /v1/ingest`), rejected attempts in the last hour, menu *Zugangsdaten neu erzeugen* (confirm:
    "Der Encoder muss danach die neuen Daten bekommen.") and *Löschen* (frees the port). A line under the card names the
    ports: "Gesendete Streams kommen über UDP {range} an. Nur diese Ports in der Firewall öffnen."

### 9.2 Kanäle

- Toolbar: search (name, number, tvg-id), filter chips *Quelle ▾*, *Gruppe ▾*, *Sichtbar / Ausgeblendet / Fehlt*,
  *Ohne Programm*, *Mit Fehler*; result count; view toggle *Liste / Reihenfolge*.
- **Liste:** `DataTable`, server paging (100/page, lists of 20 000 channels stay fast): checkbox, logo (40 px tile on the
  glass, fallback = the number in a tile), number, name (edited inline on double click / Enter), group (inline select), source,
  stream kind chip (*HLS* / *TS* / *SRT* / *SRT empfangen*), mode chip from the last test (*Durchgereicht* / *Umverpackt* / *Umgewandelt*), EPG
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
- **Programm-Zeit verschieben…** (row menu, owner decision 2026-11-12): a small sheet with the effective offset and where
  it comes from ("+1 Std. · aus der Senderliste (tvg-shift)" / "aus der Quelle" / "keine"), a stepper −12 to +14 h in steps
  of 0,5 (`epg_shift_override_min`) and *Zurücksetzen* (back to the inherited value). The *Jetzt* line in the sheet previews
  the result at once.

### 9.3 Gruppen & Rechte

- Group list (drag order like channels): name, channel count, *Kinderfreundlich* toggle, role chips (which roles see it),
  provider groups mapped into it ("aus: DE | Sport, Sport HD"). *Gruppe anlegen*, *Zusammenführen…* (merge: maps the provider
  groups of the selected groups into one and deletes the rest), *Umbenennen*, *Löschen* (channels fall back to *Ohne Gruppe*,
  which only admins see).
- Matrix toggle *Nach Rolle*: groups × roles grid of switches (the Phase 0 matrix style), plus a *Personen mit Ausnahmen*
  list (person, +groups, −groups, link to their *Rechte* tab).
- Kids preview line: "Kinderprofile sehen: Kinderinsel, Natur & Tiere (23 Sender)".
- **Release** (owner decision 2026-11-12): groups an import created stay `released = false` until the admin releases them.
  They are listed first with the chip *Nicht freigegeben* (icon + text) and the line "Für niemanden sichtbar"; above the
  list a notice "{n} neue Gruppen warten auf Freigabe" with *Nur diese zeigen*. *Freigeben…* (row menu, or the bulk bar
  for several selected groups) opens a sheet: role chips (none preselected), *Kinderfreundlich* (off) and the line "Danach
  sehen Personen mit diesen Rollen die {n} Sender der Gruppe." *Freigeben* sets `released = true` with those roles (no
  role is allowed: then only admins and per-person exceptions see it). The row menu of a released group offers *Freigabe
  zurücknehmen* (confirm; hides it from everyone again, roles kept).

### 9.4 Programmführer (Phase 2; Phase 1 shows only the automatic match counts)

**Automatic matching (Phase 1c, owner decision 2026-11-12).** For each channel with `epg_match = 'auto'`, four exact passes
in this order; each pass looks at the channel's own source's EPG first, then at the other sources' EPG; a pass that finds
exactly one XMLTV channel matches, a pass that finds none or several moves on to the next pass:

1. `tvg-id` = XMLTV channel `id`, case-insensitive;
2. `tvg-name` = an XMLTV `display-name`, case-insensitive, `_` and space treated alike, trimmed;
3. the channel's import name = an XMLTV `display-name`, case-insensitive, same rules;
4. `normName` equality (diacritics, punctuation and a trailing `HD`/`FHD`/`UHD`/`4K` dropped).

No similarity ("fuzzy") match is ever applied automatically; the bigram suggestions below are Phase 2 and need *Übernehmen*.
The channel's effective EPG offset (§6.1) shifts every programme time it shows (now/next, guide, recordings planned from
the guide).

- Counters: "398 von 412 Sendern mit Programm · 14 ohne". **Ohne Programm** list: channel, up to three suggestions
  ("Nordlicht TV HD · 92 %") from the EPG channel names (bigram Dice similarity on normalised names, ≥ 0.5), *Übernehmen*,
  *Andere wählen…* (search all EPG channels of all sources), *Kein Programm* (sets `epg_match = 'none'`).
- **Eigene Einträge** (own feeds and any channel): list of rules and single entries; *Eintrag hinzufügen* sheet: channel,
  title, description, *Einmalig* (date, start, end) or *Wöchentlich* (weekday chips, start, duration, valid from/until).
  Rules are expanded 8 days ahead by the EPG tick; times are in the server time zone and stored as UTC.

### 9.5 Live-Status

- Top: the budget card (§5.6, read-only) and system tiles: *Laufende Sender*, *Zuschauer*, *CPU* (%), *GPU* (or "–"), *DVR-Speicher*
  ("3,1 von 6 GB").
- **Laufende Sender** table: logo, name, mode chip, viewers (count only: who watches is in Admin → *Betrieb* →
  *Wiedergabe-Check* like films), since, bitrate, input state (*läuft* / *verbinde neu (3)* / *gestört*), menu *Stoppen*, *Neu starten*.
- **Ereignisse** (last 200, KV ring, no URLs): time, level (icon + word), channel, text ("Eingang verloren · 12 s bis zur
  Wiederverbindung", "Start abgelehnt: alle Plätze belegt", "Quelle Anbieter A: Aktualisierung fehlgeschlagen (Zeitüberschreitung)").
- **Gesendete Streams** (only when push feeds exist): feed, port, state (*Sendet* since … / *Keine Übertragung*), bitrate,
  rejected attempts (1 h).
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
| `GET/POST /api/admin/livetv/sources`, `PATCH/DELETE /api/admin/livetv/sources/:id`, `POST …/:id/refresh`, `POST …/sources/test` | answers carry `urlHint`/`epgHint`, never URLs; `refresh` 202, result through polling `GET`; the source body carries the import options `skipGroups: string[]`, `numbering: 'chno' \| 'order'`, `numberBase`, `logoPref: 'm3u' \| 'xmltv'`, `epgShiftMin` (−720…840, multiples of 30); `test` answers `{ channels, groups: [{ name, channels }], samples, epgChannels }` (groups in list order, for the picker) |
| `GET /api/admin/livetv/channels?q&source&group&state&epg&error&sort&dir&limit&offset` | `{ channels, total }` |
| `POST /api/admin/livetv/channels` (own feed; `{ ingest: 'push', name, number?, groupId? }` answers 201 with `push: { host, port, streamId, passphrase, url }` **once**; 409 `srt_ports_full`) · `POST /api/admin/livetv/channels/:id/push-credentials` (regenerate; same one-time answer) · `PATCH /api/admin/livetv/channels/:id` `{ name?, number?, groupId?, hidden?, epg?, epgShiftMin? }` (`null` = back to import / inherited) | |
| `POST /api/admin/livetv/channels/bulk` `{ ids, action: 'hide'\|'show'\|'group'\|'renumber'\|'reset'\|'test', groupId?, from? }` | |
| `PUT /api/admin/livetv/channels/order` `{ ids }` · `POST …/:id/test` · `PUT …/:id/logo` (multipart) · `DELETE …/:id/logo` | |
| `GET/POST/PATCH/DELETE /api/admin/livetv/groups[/:id]` `{ name, kidFriendly, roles, released }` · `PUT …/groups/order` · `POST …/groups/merge { ids, into }` · `POST …/groups/release { ids, roles, kidFriendly }` | answers carry `released` and `channels` |
| `PUT /api/admin/users/:id/livetv-groups` `{ allow: string[], deny: string[] }` | Phase 0 *Rechte* tab |
| `GET /api/admin/livetv/epg/unmatched` · `GET …/epg/channels?q` · `PUT /api/admin/livetv/channels/:id/epg` `{ sourceId, xmlId } \| { none: true } \| null` | Phase 2 |
| `GET/POST/PATCH/DELETE /api/admin/livetv/epg/rules[/:id]` | Phase 2 |
| `GET /api/admin/livetv/status` · `POST /api/admin/livetv/streams/:channelId/stop` | |
| `GET /api/admin/conversions` · `POST /api/admin/conversions/benchmark` | 1a; budget values via `PUT /api/admin/settings` |
| `PATCH /api/admin/devices/:userId/:deviceId` `{ startLive }` | TV devices only (`tv-…`) |

**User** (`requireUser`; kids allowed except where noted):

| Route | Answer |
|---|---|
| `GET /api/livetv/channels` | `{ groups: [{ id, name }], channels: [{ id, number, name, logo, groupId, running, receiving?: boolean /* push feeds only */, epg: 'ok' \| 'gap' \| 'none' /* mapped with data now / mapped without data now / unmapped */, preview?: string, now?: Prog, next?: Prog, favourite }], favourites: string[] /* the person's order */, recent: string[] /* newest first, ≤ 10 */, last: { id, previous } \| null, dvrSeconds }`; `Prog = { title, start, end, subtitle? }` (times with the channel's EPG offset applied); ETag; 30 s client refresh of now/next |
| `GET /api/livetv/logos/:hash` | image, `cache-control: private, max-age=604800, immutable` |
| `GET /api/livetv/channels/:id/preview.jpg` | only while running and allowed; `max-age=60` |
| `POST /api/livetv/channels/:id/watch`, `POST /api/livetv/beat`, `DELETE /api/livetv/watch` | §7.2 |
| `PUT /api/livetv/favourites` `{ ids }` (the complete order) · `POST/DELETE /api/livetv/favourites/:id` (a new favourite goes last) | per profile |
| `PUT /api/livetv/last` `{ id }` | records a watch in `livetv_recent` (`at = now()`, rows beyond the newest 10 deleted); *last* = newest, *previous* = second newest |
| `GET /api/livetv/epg?start=<ISO, 6-h aligned UTC>&filter=<groupId\|fav\|recent\|all>&page=<n>` (Phase 2) | `{ start, end, page, pages, channels: number, rows: string[] /* channel ids of the page, ≤ 300 */, programmes: { [channelId]: GuideProg[] }, until: { [channelId]: string /* end of the last known programme */ }, restart: { [channelId]: string /* oldest buffered time, running channels only */ } }`; `GuideProg = Prog & { id, genre?: 'film' \| 'serie' \| 'sport' \| 'news' \| 'kids' \| 'doku', reminder?: true }`; ETag, server cache 5 min per (block, channel page); ≤ 150 KB (§17 G41) |
| `GET /api/livetv/epg/search?q=<2–100 chars>` (Phase 2) | `{ results: [{ channelId, number, name, start, end, title, subtitle? }] }` (≤ 50, the profile's channels, yesterday to +7 days, running → upcoming → past; §17 G30–G31) |
| `GET /api/livetv/programme/:channelId/:start` (Phase 2) | detail incl. description, episode, recording state |
| `POST/DELETE /api/livetv/reminders` (Phase 2, grown-ups) | |
| Recording routes (Phase 3, §15.8) | |

**Jobs** (`server.ts`, behind `op()` and `BACKGROUND_JOBS`): `livetvTick` 15 s (streams, viewers, recordings start/stop),
`livetvRefreshTick` 5 min (sources due; EPG due — never rarer than every 24 h, even for *manuell* sources, because the
guide would run dry), `livetvEpgPrune` daily 04:10 (programmes `end_at < now() − 1 day`, missing channels > 30 days,
orphaned logos), `livetvReminderTick` 60 s (Phase 2), `convBenchTick` 10 min (one automatic first measurement).

Ruling (1c final review M4/M5): migration 49 is the staging table below and migration 50 adds the group lookup indexes (`livetv_group_map(group_id)`, `livetv_channels(group_override)`); Phase 2 and Phase 3 append at the next free index at merge time (never a number fixed here; 51 went to Task 39 `playback_timings`).

Ruling (Task 17 review): staging table, swap in one short transaction. The XMLTV import streams its programmes into the unlogged
table `livetv_programmes_stage` (migration 49: the programme columns plus `run_id uuid not null`, `staged_at`; index on `(run_id)`)
with short autocommitted inserts tagged with a fresh run id, so no connection or row lock is held while the stream is read. Only the
`end` line triggers the swap: ONE short transaction deletes the source's programmes and inserts the run's staged rows. The run's
staging rows are always deleted afterwards (success or failure); `livetvEpgPrune` drops staging rows older than 1 day (crashed runs). A
broken stream never reaches the swap and changes nothing (ruling 27).

**Import merge rules** (`sources.ts`): entries whose `group-title` is in the source's `skip_groups` are dropped first (and
count as absent below); the rest are keyed by `source_key`; new → insert (group via `livetv_group_map`, creating the group
**unreleased and granted to no role** if new, §8); existing → update `import_*` (number by the numbering policy, `tvg-shift`
into `import_epg_shift_min`), `stream_url_enc`, `stream_kind`, clear `missing_since`; absent → `missing_since = now()`
(hidden from users at once, deleted after 30 days). Overrides are never touched. A refresh whose list has 0 live entries (or
< 20 % of the previous list's live entries, counted **before** group skipping, so unticking groups never trips it) is
treated as a provider error: nothing is marked missing, the source shows "Die Liste war leer – nichts geändert".

## 11. The Live-TV tab (`/live`)

Navigation: desktop pill `HEADER_TABS` gains `['/live', 'shell.nav.live']` after *Filme*; phone chip bar under the header
gains *Live-TV* after *Filme*; the phone **tab bar** gains *Live* (icon `tv`) between *Neu* (`shell.tabs.newShort`) and
*Merkliste* (`shell.tabs.myList`, the app's current label) (5 tabs with downloads; the 320-px fit uses the short label "Live"); `TV_RAIL` gains it after *Filme*; the kids header gains a *Fernsehen*
entry. All only when `me.features.livetv`.

### 11.1 Layout (desktop ≥ 900 px)

1. **Läuft gerade bei dir** (favourites in the person's own order, max 12, hidden when none): a row of 16:9 `.frost-tile`
   tiles: preview image only if the channel is running (§3.3) else the logo centred on the tile's glass; bottom: number +
   name, programme title, a 3-px progress line (`scaleX`, minute steps) and the time left ("noch 23 Min.", §12.1) on the
   title line, right-aligned in reserved space. Tap = watch. The row head has *Ordnen* (shown with ≥ 2 favourites): a sheet
   with the favourites as rows, each with a drag handle (pointer and touch; the lifted row moves by `transform`, the others
   slide FLIP-style) and the keyboard path of §9.2 (Space picks up, ↑/↓ move, Space drops, Escape cancels, announced);
   *Fertig* saves with `PUT /api/livetv/favourites` (undo toast). On TV the same sheet is a move mode: OK picks the focused
   row up ("verschieben"), ▲/▼ move it, OK drops and saves at once (undo toast), Back cancels a move in progress, a second
   Back closes the sheet.
2. **Group chips** (`frost-pill` chips, horizontally scrolling): *Alle*, *Favoriten* (in the person's order), *Zuletzt
   gesehen* (shown when the profile has watched at least one channel; the last 10, newest first), then the groups in order.
   Selection slides the pill highlight (`SlidePill`).
3. **Channel grid**, two columns of rows (each 72 px): number (tabular), 48-px logo tile, name, two text lines **always
   reserved**: *Jetzt* line ("20:15 Die Leuchtturmwärter" + thin progress) and *Danach* line ("21:00 Wetter am Hafen"); without
   EPG: "Live" and "Kein Programm verfügbar"; with EPG but no data for now (the provider's data ran out): "Programm gerade
   nicht verfügbar" (second line reserved; the same honest state as the guide, §17 G28); a push feed that is not receiving: "Gerade keine Übertragung" (one line, the
   second stays reserved). Star button (44 px, `aria-pressed`). Hover/focus: the existing row fill.
4. **Programmführer** button (Phase 2) in the page head next to the title; **Aufnahmen** row (Phase 3) under the favourites.
- Loading: skeleton rows of the final height; logos fade in (opacity).

### 11.2 Phone (≤ 720 px)

Same order; favourites as a carousel (`Carousel.svelte`) with *Ordnen* in its head, chips sticky under the header (with
*Zuletzt gesehen*), channels as a single-column compact list (64-px rows: logo, number + name, *Jetzt* line with progress,
star; no time-left label on rows, so nothing jumps). The *Danach* line moves into the info panel. Pull
the list to refresh now/next (existing pull pattern if present on the page type; otherwise the 30-s refresh only).

### 11.3 TV apps (Tizen, webOS, Fire TV, `html.tv`)

- Big tiles: favourites row of 16:9 tiles (360 px wide at 1080p), then the group chips as a focusable row, then the channel list
  as large rows (96 px, logo 72 px, text ≥ 28 px). Focus = `scale(1.08)` + 3-px white ring; the list scrolls to keep the focused
  row in the middle third.
- Keys in the list (owner decision 2026-11-12: nothing depends on CH keys): ▲/▼ move (held: repeat); ◀ opens the rail (TV
  layout spec); OK watches; ▶ on a row moves focus to its star (OK toggles favourite, ◀ back to the row); a long OK
  (≥ 600 ms) toggles favourite as a shortcut. Shortcuts where the remote sends them: **ChannelUp/ChannelDown** (Tizen, Fire
  TV; on LG only if the TV sends PageUp/PageDown, which LG says webOS web apps do not get) jump 8 rows; **digits** start
  number entry (§12.4) and focus that channel's row on OK; a lone **0** focuses the last watched channel's row; Info opens
  the info panel for the focused channel.
- **Hint line** (footer): names only keys this device has actually sent. D-pad hints are always shown ("OK: ansehen ·
  Lang OK: Favorit"); "CH ▲▼: 8 Zeilen" appears only after a ChannelUp/ChannelDown keydown, "0: letzter Sender" only after a
  digit keydown, from this device. The keys seen are kept per device in `localStorage` (`ff-live-keys-seen`, wrapped in
  try/catch; empty storage = D-pad hints only). The hint line's height is reserved, so a new hint never moves the list.
- **Remembers the last channel**: entering `/live` focuses the last watched channel's row; Back from the player returns to
  the list with focus on the row of the channel that was playing (owner decision 2026-11-12).
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
`liveSyncDurationCount 3`, `liveMaxLatencyDurationCount 10`, `backBufferLength = min(dvrSeconds, 1800)`, on TVs
`min(dvrSeconds, 300)`: with a buffer of up to 120 min, old TV WebViews must not hold it in memory; seeking further back
loads the segments again from `livetv`'s DVR), `volume.ts`, `gestures.ts`
(zones), `mediasession.ts`, the cast engine and `PlayOnSheet`, `firstframe.ts`, the TV Back handling (`playerBack`). It does
not reuse `Player.svelte`'s item logic (resume, episodes, credits, ABR ladder).

### 12.1 Controls

- **No seek bar.** Bottom bar: Play/Pause (white disc, the one primary), **Von Anfang an** (see below), −30 s, +30 s
  (disabled at the live edge), the **LIVE** pill (filled coral with a dot when at the live edge; outlined with "−12:30" when
  behind; click/OK = jump to live), channel ▲/▼ buttons with the neighbour's name in the tooltip, *Senderliste* (§12.2;
  desktop and TV; on phones in the info sheet), *Programm* (info panel), *Abspielen auf…* (cast), volume, fullscreen. The
  slot of *Von Anfang an* is reserved, so the bar never shifts when it appears.
- Top: channel logo, number + name, programme title, "20:15–21:00" and the time left ("noch 23 Min."); a thin programme
  progress line (not draggable).
- **Time left** (owner decision 2026-11-12): "noch {n} Min." from the *Jetzt* programme's end, updated each minute (minute
  steps, rounded up); "noch 1 Std. 20 Min." from 60 min; "endet gleich" under 1 min; nothing without EPG. Shown in the top
  bar, the info banner, the info panel and the *Läuft gerade bei dir* tiles; never on list rows. Tabular figures in a
  space reserved for the longest form, so a changing value never moves its neighbours.
- **Von Anfang an** (owner decision 2026-11-12): restarts the running programme. Shown (enabled) only while the *Jetzt*
  programme's start lies inside the buffer (`start ≥` the program date-time of the oldest segment, §3.3); otherwise its slot
  stays empty. It seeks to `max(oldest, start − 30 s)` (a little before the start, because broadcasts rarely start on the
  minute) and the player is then *behind* like after a rewind (LIVE pill "−…", *LIVE* returns to the edge). Also a button
  in the info panel and in the info banner while it is shown on OK. Works for a person who joined a channel that was
  already running: the shared DVR can hold the start from before they joined. Not offered without EPG or with
  `LIVETV_DVR_MINUTES = 0`.
- Pausing longer than the buffer: on resume, playback starts at the oldest available point with the toast "Die Pause war
  länger als {n} Minuten – es geht am ältesten gespeicherten Punkt weiter." ({n} = the buffer length in minutes).
- **Info panel** (glass sheet on phone, side panel on desktop, TV panel): *Jetzt* (title, time, progress, time left,
  description, episode, *Von Anfang an*), *Danach*, a *Letzter Sender* button ("Zurück zu 4 Hafenkanal"), on phones the
  *Senderliste* button, Phase 2 *Programmführer* and *Aufnehmen*.

### 12.2 Channel switching

- Order = the effective list of the current filter, wrapping around: groups and *Alle* by number; *Favoriten* in the
  person's own order; *Zuletzt gesehen* in the order it had when the filter was chosen (a snapshot, so zapping does not
  reshuffle the list under the viewer).
- Switching keeps the player open; the old token is revoked; `PUT /api/livetv/last`. Rapid presses are debounced (the request
  goes out 400 ms after the last press; the banner follows each press at once). When the old stream is released at once
  (§7.4), its picture ends when the new start begins; the banner covers the stage meanwhile.
- **Info banner** (owner decision 2026-11-12; replaces the 1-s channel card): a glass banner over the lower third of the
  stage (above the control bar when that is visible; it overlays, so nothing moves): logo, number + name, *Jetzt* title +
  thin progress line + time left, *Danach* ("21:00 Wetter am Hafen"); without EPG "Live" / "Kein Programm verfügbar"; data ran out "Programm gerade nicht
  verfügbar"; a push
  feed that is not sending: "Gerade keine Übertragung". Both programme lines are always reserved. It appears at once on each
  switch press (fade by opacity), shows "Sender wird gestartet …" while starting, stays until the first frame **plus 4 s**,
  then fades out; an error state (§12.5) replaces it. On TV it also appears with the controls on OK (§12.3) and stays while
  they are visible. Calm mode / reduced motion / TV / kids: it switches without fading.
- **Senderliste panel** (all platforms; on TV also long OK, §12.3): a side panel over the player (TV and desktop; a sheet on
  phones) with the filter chips of the list (*Alle*, *Favoriten*, *Zuletzt gesehen*, groups; it opens on the current filter)
  and compact rows (number, logo, name, *Jetzt* title with progress), focus and scroll on the playing channel. ▲/▼ move,
  ◀/▶ change the filter chip on TV, OK switches to the focused channel and closes the panel (the banner shows), Back (or
  Escape, or a tap outside) closes it and returns focus to the player with the playing channel; controls stay hidden. On TV
  the controls' footer line shows "Lang OK: Senderliste" (a D-pad hint, always shown). Rows show the same data states as the
  list (§11.1). **Phase 2 extends this panel into the mini-guide** (§17.7: a *Danach* line per row and *Programmführer* in
  the foot) — one component; Phase 1 builds it so the row and the foot can take those additions.
- **Last channel:** the profile's *previous* channel (second newest in `livetv_recent`); key/button jumps there (§12.3), and
  jumping again toggles between the two.
- A switch into a full budget shows the *alle Plätze belegt* sheet (§12.5) and stays on the current channel.

### 12.3 Input map (`web/src/lib/live/livekeys.ts`, pure like `keymap.ts`)

| Action | Desktop | Phone | TV remote |
|---|---|---|---|
| Channel up / down | ↑ / ↓, PageUp / PageDown | horizontal swipe on the centre zone (left = next, right = previous; the side zones keep brightness/volume), ▲/▼ buttons | **▲ / ▼ while the controls are hidden (the path on every TV)**; ChannelUp / ChannelDown where sent (Tizen, Fire TV); LG PageUp / PageDown only if the TV sends them (unverified, §14) |
| Show controls | mouse move, any key | tap | **OK** (controls hidden): controls + info banner, focus on Play/Pause (so OK, OK pauses); any arrow except ▲/▼ |
| Pause / play | Space, K, MediaPlayPause | tap Play/Pause | MediaPlayPause; OK on the focused Play/Pause button. OK never pauses while the controls are hidden. |
| −30 s / +30 s in buffer | ← / → (10 s), J / L (30 s) | double-tap left / right (±10 s, the existing gesture) | ◀ / ▶ show the controls with focus on −30 s / +30 s; MediaRewind / MediaFastForward ±30 s |
| Von Anfang an | button | button | button in the controls, info banner or info panel |
| Live | End | LIVE pill | LIVE pill; Blue key on LG |
| Info panel | I | tap the top title | Info; OK on *Programm* or on the title in the controls |
| Senderliste panel | button | button in the info sheet | **long OK (≥ 600 ms)**; `ChannelList` (Tizen, where supported); `Guide` (Tizen where supported, Fire TV) in Phase 1, the grid from Phase 2; button in the controls |
| Last channel | Q | button in the info panel | a lone **0** (§12.4); PreviousChannel (Tizen), KEYCODE_LAST_CHANNEL (Fire TV), Red key on LG; button in the info panel |
| Number entry | digits, Enter | – (list search instead) | digits, OK (§12.4) |
| Cast | – (button) | button | – |
| Close | Escape (fullscreen first), browser back | back gesture | Back: closes the open panel/sheet first (focus back on the player and the playing channel), then hides the controls, then closes the player (the list focuses the playing channel's row, §11.3) |

`Q` is used for "last channel" on desktop because Backspace is a back key on TVs (`isBackKey`) and must not change meaning.
In live mode PageUp/PageDown are channel keys, not "next episode" (`keymap.ts:64` stays for films). D-pad-only path
(Global constraints): zapping ▲/▼; controls, *Von Anfang an*, *Programm*, *Senderliste*, LIVE and *Letzter Sender* through
OK and the focusable controls; long OK, digits, colour, Info, `ChannelList` and `Guide` are shortcuts only.

### 12.4 Number entry (TV, desktop)

Digits open a small glass card top right showing the typed digits ("1 2 _") and the matching channel's logo/name as soon as it
is unique; OK/Enter (or 2 s without input) switches; up to 5 digits; no match → "Kein Sender 123" for 2 s. Works in the player
and in the Live list (there it focuses the row).

**A lone 0** (owner decision 2026-11-12, the Kodi convention): a "0" with no further digit before the 2-s timeout, or
followed directly by OK/Enter, is *last channel* (the player jumps to the previous channel; the list focuses the last
watched channel's row); the card shows "0 · Letzter Sender: 4 Hafenkanal" meanwhile. No channel has number 0 (§6.1 checks
1–99 999); a leading 0 followed by more digits types a number as usual ("0 5" = channel 5). Without a previous channel it
shows "Kein letzter Sender" for 2 s.

### 12.5 States and errors

| State | Player shows |
|---|---|
| starting (≤ 15 s) | info banner (§12.2) with "Sender wird gestartet …" (spinner in the play slot) |
| buffering | thin indeterminate line under the top bar (transform only) |
| input lost (playlist stalls > 8 s, or 502 from `watch`) | overlay card "Sender gerade nicht erreichbar" + "Verbinde neu …"; the player retries (playlist reload, then a new `watch` after 30 s) with backoff up to 2 min, then *Erneut versuchen*; the channel keys keep working; every outage is an event in *Live-Status* |
| `not_receiving` (push feed, §3.5) | info banner with "Gerade keine Übertragung"; polls every 10 s and starts by itself when the encoder sends; channel keys keep working |
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
| Tizen | web `LivePlayer` | `web/src/lib/tizen`: register `ChannelUp`, `ChannelDown`, `PreviousChannel`, `Info`, `0`–`9`, `ColorF0Red`, `ColorF3Blue`, and **`ChannelList` (10073) and `Guide` (458) where the TV supports them** (`tizen.tvinputdevice.getSupportedKeys()`; owner decision 2026-11-12) via `tizen.tvinputdevice.registerKey` when the Live area opens (each in its own try/catch, like `probe.ts`). `ChannelList` opens the *Senderliste* panel in the player (in the list it does nothing); `Guide` does the same in Phase 1 and opens the grid from Phase 2 |
| webOS | web `LivePlayer` | **CH+/CH− are not relied on** (owner decision 2026-11-12; LG staff: "Channel +/- keys are not available in webOS TV apps"): ▲/▼ zap. If a TV does send PageUp/PageDown (`keyCode 33/34`) they act as channel keys (unverified, on-device check). Digits natively, Red/Blue via `normaliseLgKey`; Info = `keyCode 457`. No copy promises CH keys on LG (§11.3 hint line) |
| Fire TV | web `LivePlayer` in the shell | `FireTvKeys.kt`: add `KEYCODE_CHANNEL_UP/DOWN` → `ChannelUp/ChannelDown`, `KEYCODE_0..9` → `"0".."9"`, `KEYCODE_LAST_CHANNEL` → `PreviousChannel`, `KEYCODE_INFO` → `Info`, `KEYCODE_GUIDE` → `Guide` (Phase 1: the *Senderliste* panel; Phase 2 opens the grid). Most Fire TV remotes send none of these: ▲/▼, OK and Back cover everything |
| Android app | web `LivePlayer` inside the shell (hls.js in WebView; films keep the native player) | swipe as phone; cast via `castLive` (§13). A native live mode in `PlayerActivity` is a later option, not in these phases. |
| Chromecast receiver | own receiver: live card, no progress bar, LIVE badge | `ui.live = true` from the sender |

**Guide keys (Phase 2, owner decision 2026-11-12, §17.3):** while the guide is open, `MediaRewind` / `MediaFastForward` =
−2 h / +2 h, `ColorF0Red` / `ColorF1Green` = −24 h / +24 h, `ColorF2Yellow` = *Jetzt*, `ChannelUp` / `ChannelDown` = a page
of rows; each also has a button path (time chips, day chips, *Jetzt*, ◀/▶ along a row). Tizen registers `ColorF1Green`,
`ColorF2Yellow`, `MediaRewind` and `MediaFastForward` when the guide opens (each in its own try/catch, only when
`getSupportedKeys()` lists it); webOS delivers the colour keys 403–406 and the media keys (real TVs: rewind 412, fast
forward 417; the emulator differs) without registration; Fire TV has the media keys but no colour keys, so its users use
the chips. Desktop: `Home` = *Jetzt*, `Alt+←` / `Alt+→` = ∓1 day, `PageUp` / `PageDown` = a screen of rows. The guide's
hint line follows the keys-seen rule of §11.3 ("⏪ ⏩: ±2 Std.", "Rot / Grün: ±1 Tag", "Gelb: Jetzt"); Phase 2 adds the
class `media` (MediaRewind / MediaFastForward) to the keys seen.

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
- **The library sub-folder** (owner answer 2026-11-11: `livetv` may write into one dedicated sub-folder of the media share):
  - **Mount:** opt-in overlay `compose.livetv-library.yaml` (added to `COMPOSE_FILE` like the GPU overlays):
    ```yaml
    services:
      livetv:
        volumes:
          - ${RECORDINGS_LIBRARY_PATH:?set RECORDINGS_LIBRARY_PATH, e.g. ./media/Aufnahmen}:/library:rw
    ```
    Only that sub-folder is mounted, read-write; the rest of the media share (`MEDIA_PATH`) is **not mounted into `livetv` at
    all**, not even read-only. Jellyfin keeps its existing read-only mount of the whole share (`${MEDIA_PATH}:/media:ro`), so it
    sees the folder as `/media/Aufnahmen`. No other FriendFlix container gains write access to the media share.
  - **Setup** (docs and the *Aufnahmen* tab): `mkdir -p <media>/Aufnahmen && chown 10001:10001 <media>/Aufnahmen` (`livetv`
    runs as uid 10001), set `RECORDINGS_LIBRARY_PATH`, add the overlay, `docker compose up -d`. In Jellyfin a library pointing at
    `/media/Aufnahmen` (type *Gemischte Inhalte* or *Heimvideos*).
  - **Dedicated-folder guard:** on first use `livetv` writes a marker `/library/.friendflix-recordings`; if `/library` is not
    empty and has no marker, `livetv` refuses every export with `library_not_dedicated` (the panel: "Der Ordner ist nicht leer.
    Bitte einen eigenen, leeren Unterordner nur für Aufnahmen verwenden."). This catches a mount of the whole media share by
    mistake. `GET /v1/system` reports `library: { mounted, writable, dedicated, freeBytes } | null`.
  - **Choosing the library:** *Aufnahmen* tab, *Jellyfin-Bibliothek* select lists the Jellyfin libraries **with their
    folders** (new optional seam method `MediaAdmin.libraryFolders?()` → `{ id, name, paths: string[] }[]`; Jellyfin
    `/Library/VirtualFolders`). The library whose folders contain `LIVETV_RECORD_LIBRARY_JF_PATH` (default `/media/Aufnahmen`,
    editable under *Erweitert*) is preselected and marked *passt*; a library without that folder can be saved only after a
    warning ("Diese Bibliothek enthält den Aufnahmeordner nicht – Jellyfin findet die Aufnahmen dann nicht."). When no library
    contains it, *Bibliothek „Aufnahmen“ anlegen* creates one through the optional seam method
    `MediaAdmin.createLibrary?(name, path, kind: 'homevideos'|'mixed')` (Jellyfin `POST /Library/VirtualFolders`). The library
    choice is stored in `LIVETV_RECORD_LIBRARY_ID`; *Jellyfin-Bibliothek* and *Beides* stay disabled with the setup steps while
    `library.mounted` is false.
  - **Security note** (in the panel, `docs/security.md` and `docs/livetv.md`): "Live-TV darf nur in diesen einen Ordner
    schreiben. Wer diese Bibliothek in Jellyfin sieht, sieht alle Aufnahmen darin." A compromised `livetv` could create, change
    or delete files **inside that sub-folder only**; it cannot read or change other media. `livetv` writes with `O_NOFOLLOW`,
    creates paths only below `/library` after `realpath` checks, sanitises file names (no `/`, `..`, control characters,
    max 120 chars) and never follows or creates symlinks; the backend deletes library recordings only through `livetv` by
    recording id, never by a client-supplied path.

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

Phase 2 has no implementation plan yet; this section is its binding requirement list (owner decision *Programmführer*,
2026-11-12, plus the earlier guide design). One requirement per line, with the exact values; G-numbers are for the plan.

### 17.1 Layout and cells

- **G1 Grid:** fixed channel column (desktop 200 px: logo + number + name; phone 112 px: logo + number, a channel without logo
  shows its number and name in two lines instead of a monogram; TV 300 px) and a time axis in half-hour steps (desktop
  180 px per 30 min, phone 120 px, TV 240 px at 1080p); rows 64 px (phone 56, TV 104).
- **G2 TV text:** on TV at 1080p every guide text is ≥ 28 px: programme title, time line, axis labels, the *jetzt* label,
  channel names, chips, search results and the detail panel (binding).
- **G3 Cell content:** title (one line, ellipsis; sticks to the left edge of a cell cut off by the viewport), time line
  ("20:15–21:00", second line when the cell is ≥ 120 px wide, TV ≥ 200 px), marker icons at the right end of the time line
  (Von Anfang an, reminder, Phase 3 recording dot + "Aufnahme"), each icon also in the cell's accessible name.
- **G4 Running cell:** subtle `--fr-sel` fill **plus** a 3-px progress line at the bottom edge (`transform: scaleX`, minute
  steps, space reserved) **plus** the text "läuft" (wide cells: "läuft · noch 23 Min.") in the time line; never fill only.
- **G5 Past cells — style "vorbei, nicht abspielbar":** a flat background (`--fr-past`, no glass highlight) and text in a
  colour with ≥ 4.5:1 contrast on it; **no opacity dimming of text** (the old `.55` is gone); accessible name ends with
  "vorbei". The style "vorbei, abspielbar" stays reserved for catch-up (§25).
- **G6 Von Anfang an marker:** a small restart arrow in running cells of channels whose stream is running and whose DVR
  window reaches back to the programme start (the guide answer's `restart[channelId]`, §10), with EPG; never on other
  cells; the detail sheet's *Von Anfang an* opens the player at that point (§12.1).
- **G7 Genre stripe:** a 4-px stripe on the cell's left edge (inside the cell, text padding unchanged, so it moves nothing)
  in one of 6 classes — Film, Serie, Sport, Nachrichten, Kinder, Doku — kept on running and focused cells; **no stripe when
  no class matches** (no guessing); never colour alone: the class name is in the detail sheet and the cell's accessible
  name.
- **G8 Genre mapping:** built in, no admin UI: each programme's XMLTV `<category>` values, lower-cased, are checked against
  keyword lists in this class order (first class with a hit wins): Kinder (`kinder`, `kids`, `children`, `zeichentrick`),
  Sport (`sport`, `fußball`, `fussball`, `football`, `soccer`, `tennis`, `motorsport`), Nachrichten (`nachrichten`, `news`),
  Doku (`doku`, `dokumentation`, `documentary`, `reportage`), Serie (`serie`, `series`, `sitcom`, `soap`), Film (`film`,
  `movie`, `spielfilm`); a keyword matches a whole word of the category text.
- **G9 Genre colours:** tokens `--fr-genre-film #f0a23b`, `--fr-genre-serie #a78bfa`, `--fr-genre-sport #34c77b`,
  `--fr-genre-news #4ea8f0`, `--fr-genre-kids #f47fb6`, `--fr-genre-doku #e8d44d`; each ≥ 3:1 against the cell backgrounds
  (glass, `--fr-sel`, `--fr-past`, `--fr-solid`), checked in the glass contrast test.
- **G10 Colour switch:** *Farben im Programmführer* (default **on**) in the guide's *Ansicht* menu; off = no stripes;
  remembered per profile on the device (`localStorage['ff-guide-colours:<profileId>']`, try/catch, unreadable = on).
- **G11 Jetzt line:** a 2-px `--err` line with a "jetzt" label in the axis, moved with `translateX` every 30 s; no
  transition in calm / reduced motion / TV / kids.
- **G12 Detail sheet** (glass sheet / TV panel): channel, title, time, time left when running, episode, description,
  genre class + categories, rating; buttons *Jetzt ansehen* (running), *Von Anfang an* (G6), *Aufnehmen* / *Aufnahme
  abbrechen* / *Serie aufnehmen* (Phase 3), *Erinnern* / *Erinnerung entfernen* (future only); past programmes show "Vorbei
  – nicht mehr abspielbar." Buttons a profile may not use are not rendered.
- **G13 Reminders:** `livetv_reminders`, notified 5 min before start; the cell shows a bell icon.

### 17.2 Head, filters and opening

- **G14 Head rows:** title *Programmführer*, search (G30), filter chips, day chips (*Gestern*, *Heute*, *Morgen*, then weekday +
  date up to 7 days ahead), time chips (G21), *Jetzt* button, *Ansicht* menu; on TV the head is a focusable stack above the
  grid, reached with ▲ from the first channel row.
- **G15 Filter chips on every platform, TV included:** *Favoriten*, *Zuletzt gesehen*, the groups in order, *Alle*.
- **G16 Opening filter:** *Favoriten* when the profile has favourites; else the group chosen last in the guide on this
  device (`localStorage['ff-guide-filter:<profileId>']`); else *Alle* (or, on TV above 1 000 channels, the first group).
- **G17 Alle is paged:** 300 channel rows per page (by number); a focusable boundary row "Weitere Sender (301–600)" /
  "Vorherige Sender (1–300)" loads the neighbour page and keeps the time position; data is requested per page only.
- **G18 Alle above 1 000 channels on TV:** not a chip; it is the last entry of the *Gruppe wählen …* menu at the end of the
  chip row (which lists every group), so nobody lands in a list of 1 000+ channels by accident. Desktop and phone keep
  the chip (paged, G17).
- **G19 Filter change:** keeps the time position and puts focus on the first row's programme at the anchor time; rows are
  replaced, never animated in from elsewhere.

### 17.3 Time navigation and keys

- **G20 Range:** 1 day back to 7 days ahead; jumps beyond the range clamp and do nothing more (no wrap).
- **G21 Time chips:** *Morgens* 06:00, *Mittags* 12:00, *Abends* 18:00, *20:15*, *Nachts* 23:00 of the selected day; on TV
  they sit behind a *Zeit* button (one menu level).
- **G22 Jump behaviour:** a jump keeps the channel rows and the focused row; focus moves to the programme at the target time;
  the target time label in the axis is highlighted for 1 s (opacity); the grid moves by `transform`, the *Jetzt* line
  fades in by opacity when it comes into view; nothing else moves.
- **G23 TV keys (shortcuts; every one also has a button path):** `MediaRewind` / `MediaFastForward` = −2 h / +2 h (button
  path: ◀/▶ along the row, the time chips); `ColorF0Red` / `ColorF1Green` = −24 h / +24 h (button path: day chips);
  `ColorF2Yellow` = *Jetzt* (button path: *Jetzt*); `ChannelUp` / `ChannelDown` = a page of rows; ◀/▶ = previous/next
  programme; ▲/▼ = the anchor-time rule (the start of the programme focused before the vertical move, kept while moving
  vertically); OK = details; Info = details; Back = closes the sheet, then the grid (focus return G37). The guide owns these
  keys while it is open (Red is *last channel* only in the player).
- **G24 Desktop keys:** arrows as on TV, `Home` = *Jetzt*, `Alt+←` / `Alt+→` = −1 / +1 day, `PageUp` / `PageDown` = a screen of
  rows, Enter = details; wheel/trackpad pans both ways, Shift+wheel horizontal. Phone: native two-axis scroll with sticky
  column and axis, tap = details, chips for days and times.

### 17.4 Data and data states

- **G25 Data:** 6-hour blocks aligned to 00/06/12/18 UTC from `GET /api/livetv/epg` per channel page (G17), in-memory LRU
  of 16 blocks per session, prefetch of the neighbour block when the viewport is within 1 h of an edge; times UTC in
  transport (EPG offsets already applied, §6.1), labels with `Intl.DateTimeFormat`; a local day runs midnight to midnight
  (23 or 25 h on DST days, the axis shows the repeated or skipped hour as it is).
- **G26 Loading:** a block not loaded yet shows, per row, placeholder bars of cell height for its 6 h (opacity pulse 1.2 s;
  static in calm / reduced motion / TV / kids); the real cells replace them in place.
- **G27 End of data:** after a channel's last known programme, a cell "Programmdaten bis {time}" fills the rest of the
  visible window (also on later days, which are never just empty).
- **G28 No data:** a mapped channel without programmes in the window: one cell "Programm gerade nicht verfügbar"; an unmapped
  channel: "Live" / "Kein Programm verfügbar"; a block that failed to load: "Programm konnte nicht geladen werden ·
  Erneut laden" (OK/click retries that block).
- **G29 Admin only:** a source whose EPG last succeeded more than 72 h ago shows "Programmdaten seit {n} Tagen nicht
  aktualisiert" in its *Quellen* state line; users only ever see G27/G28.

### 17.5 Search in the guide

- **G30 Search:** a search field in the guide head (TV: a *Suchen* button that opens the system keyboard/dictation input);
  title search over the held 8 days (yesterday to +7 days), case-insensitive substring, ≥ 2 characters, 300 ms debounce,
  only the profile's channels, at most 50 results; server side a plain `lower(title) like` over the held programmes (no new
  index), answered in < 300 ms with 300 000 programmes.
- **G31 Results:** a list under the field, running first, then upcoming by start, then past (newest first): "Die
  Leuchtturmwärter · Heute 20:15 · 4 Hafenkanal"; none: "Keine Sendung gefunden".
- **G32 Jump to the cell:** OK/click closes the list, selects the day, scrolls the grid (transform) so the cell's start sits at
  20 % of the width and focuses the cell; if the channel is not in the current filter, the filter switches to the
  channel's group (TV above 1 000 channels) or *Alle* (otherwise), on the page that holds it. Global search hits stay
  §25 (later).

### 17.6 Phone list view

- **G33 Toggle:** segmented *Raster | Jetzt/Danach* in the phone head; default *Raster*; the last choice is remembered per
  profile on the device (`localStorage['ff-guide-view:<profileId>']`).
- **G34 List rows** (72 px, both lines always reserved): logo + channel name (name always visible), *Jetzt* title + 3-px
  progress + "noch 23 Min.", *Danach* "21:00 Wetter am Hafen"; data states of G28; tap = the detail sheet of the running
  programme. The list shows *now*; day and time chips are hidden in it, filters and search stay.

### 17.7 Mini-guide in the player

- **G35 One component:** the mini-guide is the §12.2 *Senderliste* panel extended in Phase 2, not a second panel: same
  openings (long OK, `ChannelList`, the button), same filters, same keys; ▲/▼ outside the panel keep zapping.
- **G36 Phase 2 additions:** each row gains a reserved *Danach* line ("21:00 Wetter am Hafen") under *Jetzt* + progress, and
  the panel foot gets *Programmführer* (opens the grid at now with focus on the focused channel's running programme). The
  sound stays with the playing channel; the panel never plays or previews the focused channel. `Guide` opens the grid
  from Phase 2 (Phase 1: the panel).
- **G37 Focus return:** a grid opened from the player (or its panel) returns to the player on Back, focus on the playing
  channel; a grid opened from the list returns to the list with focus on the playing (or last watched) channel's row.

### 17.8 Performance rules and acceptance

- **G38 DOM window:** only rows and cells inside the viewport ± one screen are in the DOM (about 20 channels × 4 h); cells
  are positioned with `transform: translate()`; scrolling never re-lays-out.
- **G39 TV scrolling:** on TV the grid layer moves by `transform` (no `scrollIntoView`, no native scroll), so the focus stays
  inside the middle 60 %; `PageUp`/`PageDown`/`ChannelUp`/`ChannelDown` move a page, never one row.
- **G40 Updates patch, never rebuild:** a reminder, a new block, a restart-marker change or now/next ticking patches the
  affected cells in place (keyed by programme); scroll position and focus never move.
- **G41 Request size:** `GET /api/livetv/epg` returns at most one page (300 channels) × one block; ≤ 150 KB JSON for 300
  channels × 6 h (fixture check).
- **G42 Acceptance on Chromium 85 (Tizen 2020 / webOS 6 class, and the e2e fixture with 4× CPU throttling as CI proxy):**
  opening the guide on *Alle* with 500 channels paints the first cells in < 2 s (backend cache warm); a 60-row page jump
  renders in < 100 ms; a ±2 h jump within loaded blocks in < 100 ms, with a block fetch in < 1 s; holding ▼ for 5 s never
  drops the focus ring or leaves blank rows on screen.

### 17.9 Accessibility (adds to §21)

- **G43 Grid semantics:** `role="grid"` with `aria-rowcount`/`aria-colcount`, row headers = channels, **roving tabindex**
  (exactly one cell tabbable), every cell focusable by keys and announced as "{title}, {channel}, {start} bis
  {end}{, läuft, noch {n} Min.}{, Von Anfang an möglich}{, Erinnerung}{, {genre}}{, vorbei}".
- **G44 Contrast and focus:** all cell text ≥ 4.5:1 including past cells (G5); the TV focus style (3-px white ring, one
  focused element); the jetzt line is `aria-hidden`; reduced motion: no transition on the jetzt line or on jumps.

## 18. Security & privacy summary

- **Provider credentials:** encrypted at rest (`url_enc`, `epg_url_enc`, `stream_url_enc`), decrypted only in the backend
  process right before a signed request to `livetv`, kept in `livetv` memory only for the running job; never in answers
  (masked `*_hint`), logs (backend: route logs exclude bodies of `/api/admin/livetv/sources*`; `livetv`: scrubbed ffmpeg
  stderr, no argument logging), audit (field names only), metrics, error messages (fixed codes), Diagnose.
- **Rewritten streams:** clients only see `/media/l/<token>/<local name>`; provider segment URLs live only in `livetv`.
- **Tokens:** hashed in KV, pinned, short idle TTL, capped, revoked on every relevant change (§7.1), scoped to one channel or
  recording, never logged.
- **Profile isolation:** favourites, *Zuletzt gesehen* (last channel), reminders, recordings and progress are per profile; every user route checks
  the profile's effective channel set; recordings are private by default; admins see recording metadata, not playback, unless
  shared.
- **Kids:** only kid-friendly groups; no recording, no guide reminders; shared kid-friendly recordings only.
- **SSRF / hostile input:** §3.4; the backend validates scheme and host form on save, `livetv` enforces the address rules at
  connect time; `livetv` has no route to the database, Redis or the media server (networks).
- **Container hardening:** read-only root, tmpfs `/tmp`, no capabilities, `no-new-privileges`, uid 10001, GPU only through the
  opt-in overlays, signed internal API. Published ports: only the UDP range `LIVETV_SRT_PORTS` for pushed SRT feeds (no TCP,
  no HTTP); the internal API stays on the internal network.
- **SRT push:** a connection is accepted only with the feed's stream id **and** passphrase on the feed's own port, encrypted
  with AES-256; credentials are random, stored encrypted, shown once; rejected handshakes are throttled per address and never
  logged with credentials or addresses (§3.5). Push data never leaves `livetv` except as HLS through the gateway.
- **Media share:** `livetv` has read-write access to one dedicated sub-folder only (opt-in overlay, guarded by the marker
  file); nothing else of the media share is mounted into it (§15.3).
- **Privacy notice** (`docs/privacy.md`, account page): which channels a profile watched is stored only as *Zuletzt
  gesehen* (the last 10 channels with the time each was last opened; older ones are deleted on each write) and favourites;
  live views appear in the admin's *Wiedergabe-Check* list (Admin → *Betrieb*) while they run (like films); no other viewing
  history (no durations, no programmes) is kept for live.

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
| provider EPG covers only 6 h ahead (Phase 2 guide) | after the last programme a cell "Programmdaten bis {time}"; later days show that state, never an empty grid (§17 G27) |
| a 6-h block fails to load | its cells say "Programm konnte nicht geladen werden · Erneut laden"; OK/click retries only that block; the rest of the grid keeps working (G28) |
| 1 000+ channels in the profile's set, TV guide | *Alle* only behind *Gruppe wählen …*; opens on *Favoriten* or the last group; pages of 300 elsewhere (G16–G18) |
| a search hit on a channel outside the current filter | the filter switches to the channel's group (TV, > 1 000 channels) or *Alle* on the right page, then the cell is focused (G32) |
| categories match two genre classes ("Kinder", "Serie") | the fixed class order decides (Kinder first); no category matches → no stripe (G8) |
| a TV without colour or media keys (Fire TV, many Samsung remotes) | day chips, time chips and *Jetzt* do the same; no hint names a key the device never sent (G23) |
| a reminder is set while the grid is scrolled | the cell gains its bell in place; scroll position and focus stay (G40) |
| media keys while the guide is open over the player | they move the guide (±2 h), never seek the playing stream; Red is −24 h in the guide and *last channel* only in the player (G23) |
| EPG programme overlaps / gaps | cells drawn as given; overlaps: the later start wins the visible slot, the other is in the detail list |
| channel hidden while someone watches | token revoked within 2 s (authz memo) → "nicht mehr verfügbar" |
| role/group right removed while watching | same |
| profile deleted | favourites, *Zuletzt gesehen*, reminders, recordings, progress cascade |
| a second viewer joins the old channel while a switch releases it (§7.4) | the release re-counts viewers after setting `ltv:stopping:<A>`: a viewer who came first keeps A and the switch gets `live_full` / `provider_limit`; a viewer who comes during the stop waits ≤ 5 s and starts A again through the normal start path (budget and provider limit apply), never a dead stream |
| the switching person was not the only viewer, or B starts fine anyway | no release; A lingers 60 s as usual |
| the admin unticks most groups in the picker | the shrink guard counts the list's live entries before group skipping, so it does not trip; the skipped groups' channels become missing |
| a provider adds a new group later | imported unreleased (§8), invisible until released; the source card and *Gruppen & Rechte* show "{n} neue Gruppen warten auf Freigabe" |
| `tvg-shift` with a fraction ("-1.5") or out of range | hours with up to two decimals, rounded to whole minutes; outside −12…+14 h the value is ignored (no offset from it) |
| *Von Anfang an* while the programme start has just left the buffer | the button disappears at the next minute tick; a press that races it seeks to the oldest point instead |
| 120-min buffer on a Chromium 85 TV | the player keeps ≤ 300 s behind the playhead in memory (§12); rewinding further loads from `livetv`, never a quota error |
| `livetv` disabled with scheduled recordings | they fail with `livetv_off`, owners notified once |
| Plex install | budget counts Plex transcodes via the adapter; library storage mode not offered |
| push encoder not sending | channel shows "Gerade keine Übertragung"; `watch` 409 `not_receiving`; player waits and starts by itself |
| push encoder stops while watched | "Gerade keine Übertragung" overlay; stream stops 60 s after input loss; resumes on a new `watch` when sending again |
| wrong stream id / passphrase | rejected in the SRT handshake; counted; one event per feed per 10 min; throttled per address |
| second encoder with valid credentials | rejected while the first one sends (`SRT_REJX_CONFLICT`) |
| UDP range full | *Stream hinzufügen* (push) refused with the range hint (409 `srt_ports_full`) |
| `LIVETV_SRT_PORTS` changed so a feed's port left the range | the feed shows "Port {p} liegt nicht mehr im Bereich" and *Neuen Port zuweisen* (keeps credentials) |
| library folder not empty and unmarked, or not writable | exports refused (`library_not_dedicated` / `library_not_writable`); recordings stay in the FriendFlix folder; admin event |

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
| `live.player.pauseTooLong` | The pause was longer than {n} minutes, continuing at the oldest saved point. | Die Pause war länger als {n} Minuten – es geht am ältesten gespeicherten Punkt weiter. |
| `live.player.restart` / `channelList` | From the start / Channel list | Von Anfang an / Senderliste |
| `live.timeLeft` / `timeLeftLong` / `endingNow` | {n} min left / {h} h {m} min left / ending now | noch {n} Min. / noch {h} Std. {m} Min. / endet gleich |
| `live.recentChip` | Recently watched | Zuletzt gesehen |
| `live.number.last` / `live.number.noLast` | 0 · Last channel: {number} {name} / No last channel | 0 · Letzter Sender: {number} {name} / Kein letzter Sender |
| `live.fav.order` / `orderTitle` / `orderDone` / `orderMove` | Arrange / Arrange favourites / Done / move | Ordnen / Favoriten ordnen / Fertig / verschieben |
| `live.fav.orderPicked` / `orderMoved` / `orderDropped` / `orderCancelled` | {name} picked up, position {n} of {m} / Position {n} of {m} / {name} dropped at position {n} / Move cancelled | {name} aufgenommen, Position {n} von {m} / Position {n} von {m} / {name} abgelegt auf Position {n} / Verschieben abgebrochen |
| `live.tvHint.ok` / `chJump` / `zeroLast` / `longOkList` | OK: watch / CH ▲▼: 8 rows / 0: last channel / Long OK: channel list | OK: ansehen / CH ▲▼: 8 Zeilen / 0: letzter Sender / Lang OK: Senderliste |
| `live.player.noChannel` / `notAvailable` | No channel {n} / This channel is no longer available to you. | Kein Sender {n} / Dieser Sender ist für dich nicht mehr verfügbar. |
| `live.full.title` / `live.full.body` / `live.full.join` | All live slots are taken right now / These channels are already on and start at once: / Watch {name} | Gerade sind alle Live-Plätze belegt / Diese Sender laufen schon und gehen sofort: / {name} ansehen |
| `live.providerLimit` | Your provider allows only {n} channels at once. | Dein Anbieter erlaubt nur {n} Sender gleichzeitig. |
| `player.serverBusy` / `player.capReason.serverBusy` | The server is busy right now. Try again in a moment. / Server busy | Server gerade ausgelastet. Versuch es gleich noch einmal. / Server ausgelastet |
| `live.tvHintFav` | Long OK: favourite | Lang OK: Favorit |
| `live.guide.today` / `yesterday` / `tomorrow` / `nowBtn` / `nowLine` | Today / Yesterday / Tomorrow / Now / now | Heute / Gestern / Morgen / Jetzt / jetzt |
| `live.guide.search` / `searchEmpty` / `searchHit` | Search programmes / No programme found / {title} · {when} · {number} {name} | Sendung suchen / Keine Sendung gefunden / {title} · {when} · {number} {name} |
| `live.guide.view` / `viewGrid` / `viewList` / `colours` | View / Grid / Now/Next / Colours in the guide | Ansicht / Raster / Jetzt/Danach / Farben im Programmführer |
| `live.guide.time` / `morning` / `midday` / `evening` / `night` (the 20:15 chip is a formatted time) | Time / Morning / Midday / Evening / Night | Zeit / Morgens / Mittags / Abends / Nachts |
| `live.guide.pickGroup` / `pageNext` / `pagePrev` | Choose group… / More channels ({from}–{to}) / Previous channels ({from}–{to}) | Gruppe wählen … / Weitere Sender ({from}–{to}) / Vorherige Sender ({from}–{to}) |
| `live.guide.until` / `gap` / `loadFailed` / `retry` / `loading` (aria) | Programme data until {time} / Programme not available right now / Programme could not be loaded / Load again / Loading programme data | Programmdaten bis {time} / Programm gerade nicht verfügbar / Programm konnte nicht geladen werden / Erneut laden / Programmdaten werden geladen |
| `live.guide.running` / `runningLeft` / `restartable` / `past` / `pastSheet` | on now / on now · {n} min left / can start from the beginning / over, not playable / Over – no longer playable. | läuft / läuft · noch {n} Min. / Von Anfang an möglich / vorbei, nicht abspielbar / Vorbei – nicht mehr abspielbar. |
| `live.guide.genre.film` / `serie` / `sport` / `news` / `kids` / `doku` | Film / Series / Sport / News / Kids / Documentary | Film / Serie / Sport / Nachrichten / Kinder / Doku |
| `live.guide.hint.media` / `hint.days` / `hint.now` | ⏪ ⏩: ±2 h / Red / Green: ±1 day / Yellow: now | ⏪ ⏩: ±2 Std. / Rot / Grün: ±1 Tag / Gelb: Jetzt |
| `live.gap` (list, banner, panel; Phase 1) | Programme not available right now | Programm gerade nicht verfügbar |
| `adminLive.src.epgStale` (Phase 2) | Programme data not updated for {n} days | Programmdaten seit {n} Tagen nicht aktualisiert |
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
| `adminLive.src.add` / `kindList` / `kindOwn` / `m3u` / `epg` / `lan` / `lanHint` / `interval` / `refreshNow` / `test` | Add source / Provider list / Own streams / Channel list URL (M3U) / Programme guide URL (XMLTV) / Allow home network / Only for addresses in your own network, e.g. a receiver at home. / Update / Update now / Check | Quelle hinzufügen / Anbieterliste / Eigene Streams / Senderliste (M3U-Adresse) / Programmführer (XMLTV-Adresse) / Heimnetz erlauben / Nur für Adressen in deinem eigenen Netz, z. B. ein Receiver zu Hause. / Aktualisieren / Jetzt aktualisieren / Prüfen |
| `adminLive.src.import` / `numbering` / `numChno` / `numOrder` / `numKeep` | Import / Channel numbers / From the list (tvg-chno) / In list order from / Numbers you set under Channels are kept. | Import / Nummern / Aus der Liste (tvg-chno) / Nach Reihenfolge ab / Eigene Nummern aus *Kanäle* bleiben erhalten. |
| `adminLive.src.logoPref` / `logoM3u` / `logoXmltv` / `logoOwn` | Channel logos / Channel list first / Programme guide first / A logo you upload always wins. | Senderlogos / Aus der Senderliste zuerst / Aus dem Programmführer zuerst / Ein eigenes Logo geht immer vor. |
| `adminLive.src.epgShift` / `epgShiftHint` / `hours` | Shift guide times / For programme guides whose times are hours off. tvg-shift from the channel list and values of single channels take precedence. / {n} h | Programm-Zeit verschieben / Für Programmführer, deren Zeiten um Stunden daneben liegen. tvg-shift aus der Senderliste und Werte einzelner Sender gehen vor. / {n} Std. |
| `adminLive.src.pick.title` / `search` / `all` / `none` / `count` / `total` / `hiddenNote` | {n} groups found – which should be imported? / Search groups / All / None / {n} channels / {m} of {n} channels will be imported / New groups stay hidden until you release them under Groups & rights. | {n} Gruppen gefunden – welche übernehmen? / Gruppe suchen / Alle / Keine / {n} Sender / {m} von {n} Sendern werden übernommen / Neue Gruppen bleiben verborgen, bis du sie unter *Gruppen & Rechte* freigibst. |
| `adminLive.src.skipped` / `changePick` / `pending` | Without {n} groups / Change selection / {n} new groups are waiting to be released | Ohne {n} Gruppen / Auswahl ändern / {n} neue Gruppen warten auf Freigabe |
| `adminLive.src.interval.*` | Every 6 h / Every 12 h / Daily / Weekly / Manual only | Alle 6 Std. / Alle 12 Std. / Täglich / Wöchentlich / Nur von Hand |
| `adminLive.src.state` / `stateEpg` / `unchanged` | Last updated {when} · {n} channels (+{a} / −{r}) / Guide: {n} programmes / leave unchanged | Zuletzt aktualisiert {when} · {n} Sender (+{a} / −{r}) / Programm: {n} Sendungen / unverändert lassen |
| `adminLive.src.err.*` | Not reachable / Access denied (username or password?) / Timed out / List too big (over 50 MB) / Not a valid channel list / The list was empty, nothing changed / Address not allowed (internal network) | Nicht erreichbar / Zugang abgelehnt (Benutzername oder Passwort?) / Zeitüberschreitung / Liste zu groß (über 50 MB) / Keine gültige Senderliste / Die Liste war leer – nichts geändert / Adresse nicht erlaubt (internes Netz) |
| `adminLive.push.mode` / `pull` / `push` | How does the stream arrive? / FriendFlix fetches the stream / Encoder sends to FriendFlix | Wie kommt der Stream an? / FriendFlix holt den Stream / Encoder sendet an FriendFlix |
| `adminLive.push.host` / `port` / `streamId` / `passphrase` / `url` / `copy` / `copied` | Server / Port / Stream ID / Passphrase / SRT address / Copy / Copied | Server / Port / Stream-ID / Passphrase / SRT-Adresse / Kopieren / Kopiert |
| `adminLive.push.onceWarning` | The passphrase is shown only now. | Die Passphrase wird nur jetzt angezeigt. |
| `adminLive.push.obsTitle` / `obsBody` | OBS/encoder setup / OBS: Settings → Stream → service *Custom*, server = the SRT address, leave the stream key empty. Other encoders: mode *Caller*, encryption AES-256 (pbkeylen 32), latency 200 ms. H.264 video + AAC audio avoids conversions. | OBS/Encoder einrichten / OBS: Einstellungen → Stream → Dienst *Benutzerdefiniert*, Server = die SRT-Adresse, Streamschlüssel leer lassen. Andere Encoder: Modus *Caller*, Verschlüsselung AES-256 (pbkeylen 32), Latenz 200 ms. Video H.264 + Audio AAC spart Umwandlungen. |
| `adminLive.push.firewall` / `portsLine` | Your firewall or router must forward UDP port {port} to the server. / Pushed streams arrive on UDP {range}. Open only these ports in the firewall. | Die Firewall bzw. der Router muss UDP-Port {port} an den Server weiterleiten. / Gesendete Streams kommen über UDP {range} an. Nur diese Ports in der Firewall öffnen. |
| `adminLive.push.receiving` / `idle` / `rejected` / `regenerate` / `regenerateBody` / `portsFull` | Sending / Not sending / {n} rejected attempts (1 h) / Generate new credentials / The encoder then needs the new credentials. / All {n} ports for pushed streams are taken. Enlarge LIVETV_SRT_PORTS in .env. | Sendet / Keine Übertragung / {n} abgelehnte Versuche (1 Std.) / Zugangsdaten neu erzeugen / Der Encoder muss danach die neuen Daten bekommen. / Alle {n} Ports für gesendete Streams sind belegt. Vergrößere LIVETV_SRT_PORTS in der .env. |
| `live.notReceiving` | Not broadcasting right now | Gerade keine Übertragung |
| `adminLive.rec.libFits` / `libMismatch` / `libCreate` / `libNotDedicated` / `libSecurity` | fits / This library does not contain the recordings folder, so Jellyfin will not find the recordings. / Create library "Recordings" / The folder is not empty. Please use a separate, empty sub-folder just for recordings. / Live TV may write only into this one folder. Everyone who sees this library in Jellyfin sees all recordings in it. | passt / Diese Bibliothek enthält den Aufnahmeordner nicht – Jellyfin findet die Aufnahmen dann nicht. / Bibliothek „Aufnahmen“ anlegen / Der Ordner ist nicht leer. Bitte einen eigenen, leeren Unterordner nur für Aufnahmen verwenden. / Live-TV darf nur in diesen einen Ordner schreiben. Wer diese Bibliothek in Jellyfin sieht, sieht alle Aufnahmen darin. |
| `adminLive.ch.mode.*` | Passed through / Repackaged / Converted | Durchgereicht / Umverpackt / Umgewandelt |
| `adminLive.ch.epgShift` / `shiftFromList` / `shiftFromSource` / `shiftNone` / `shiftReset` | Shift guide times… / from the channel list (tvg-shift) / from the source / none / Reset | Programm-Zeit verschieben … / aus der Senderliste (tvg-shift) / aus der Quelle / keine / Zurücksetzen |
| `adminLive.ch.hide` / `show` / `regroup` / `renumber` / `reset` / `order` / `dupNumber` / `changedFrom` | Hide / Show / Change group… / Number from… / Reset changes / Order / Duplicate number / changed (import: {v}) | Ausblenden / Einblenden / Gruppe ändern … / Ab Nummer … durchnummerieren / Änderungen zurücksetzen / Reihenfolge / Nummer doppelt / geändert (Import: {v}) |
| `adminLive.grp.kidFriendly` / `merge` / `kidsSee` / `noGroup` | Kid-friendly / Merge… / Kids profiles see: {groups} ({n} channels) / No group | Kinderfreundlich / Zusammenführen … / Kinderprofile sehen: {groups} ({n} Sender) / Ohne Gruppe |
| `adminLive.grp.unreleased` / `unreleasedLine` / `onlyPending` / `release` / `releaseBody` / `releaseDo` / `unrelease` | Not released / Visible to nobody / Show only these / Release… / People with these roles will then see the group's {n} channels. / Release / Withdraw release | Nicht freigegeben / Für niemanden sichtbar / Nur diese zeigen / Freigeben … / Danach sehen Personen mit diesen Rollen die {n} Sender der Gruppe. / Freigeben / Freigabe zurücknehmen |
| `adminPeople.check.livetvNotReleased` | Group not released yet | Gruppe noch nicht freigegeben |
| `adminLive.dvrHint` (settings help of `LIVETV_DVR_MINUTES`) | 0 to 120 minutes. 120 minutes of an HD channel take about 5 GB of cache; LIVETV_CACHE_MAX_GB (default 6) limits all channels together. | 0 bis 120 Minuten. 120 Minuten eines HD-Senders brauchen ca. 5 GB Zwischenspeicher; LIVETV_CACHE_MAX_GB (Standard 6) begrenzt alle Sender zusammen. |
| `adminLive.ev.released_on_switch` | Stopped at once on a switch (slot or connection needed) | Beim Umschalten sofort beendet (Platz oder Verbindung gebraucht) |
| `adminLive.epg.matched` / `unmatched` / `apply` / `other` / `none` | {m} of {n} channels with a guide · {u} without / Without a guide / Apply / Choose another… / No guide | {m} von {n} Sendern mit Programm · {u} ohne / Ohne Programm / Übernehmen / Andere wählen … / Kein Programm |
| `adminLive.status.running` / `viewers` / `stop` / `restart` / `events` / `off` | Running channels / Viewers / Stop / Restart / Events / Turn off Live TV… | Laufende Sender / Zuschauer / Stoppen / Neu starten / Ereignisse / Live-TV ausschalten … |
| `adminLive.off.removeImage` / `removeCache` / `keepsRecordings` | Remove image / Delete cache / Recordings are kept. | Image entfernen / Zwischenspeicher löschen / Aufnahmen bleiben erhalten. |
| `adminLive.gpu.*` | (the five lines of §4.4) | (the five lines of §4.4) |
| `adminLive.offer.updaterOld` / `updaterOldGo` (1b review I3) | This updater does not know Live TV yet. Update the updater first: Admin → Update → “Update the updater”, then turn it on here. / Update the updater first | Dieser Updater kennt Live-TV noch nicht. Erst den Updater aktualisieren: Admin → Update → „Updater aktualisieren“, danach hier einschalten. / Erst den Updater aktualisieren |
| `adminLive.err.compose_outdated` / `network_missing` (1b review I3) | Your compose.prod.yaml is from before Live TV. Replace it in the stack folder with the one from the current release and run docker compose up -d there once. / Backend and gateway are not on the livetv network yet. Run docker compose up -d once in the stack folder, then try again. | Deine compose.prod.yaml stammt von vor Live-TV. Ersetze sie im Stack-Ordner durch die aus dem aktuellen Release und führe dort einmal docker compose up -d aus. / Backend und Gateway hängen noch nicht im Netz livetv. Führe im Stack-Ordner einmal docker compose up -d aus und versuch es dann noch einmal. |
| `adminLive.err.unauthorized` (1b review M7; `updater_outdated`, `stop_failed`, `interrupted`, `no_target`, `updater_error`, `not_found` in the locale files) | The updater refuses the signature – update or restart the updater (Admin → Update). | Der Updater lehnt die Signatur ab – Updater aktualisieren oder neu starten (Admin → Update). |
| `adminConv.title` / `used` / `measured` / `recommended` / `remeasure` / `auto` / `custom` / `noRealtime` | Conversions / {u} of {l} in use / Measured {s}× real time ({engine}) / recommended {n} / Measure again / Automatic ({n}) / Custom / The server cannot convert in real time. | Umwandlungen / {u} von {l} belegt / Gemessen {s}× Echtzeit ({engine}) / empfohlen {n} / Neu messen / Automatisch ({n}) / Eigener Wert / Der Server schafft keine Umwandlung in Echtzeit. |
| `adminConv.priority.*` | Films & series first / Live TV first / Equal | Filme & Serien zuerst / Live-TV zuerst / Gleichrangig |
| `adminConv.priority.hint.films` / `hint.live` / `hint.equal` (one per option, §5.6) | Live TV leaves one slot free for films & series (with 2 or more slots). / Films & series leave one slot free for Live TV (with 2 or more slots). / No slot is kept free – whoever comes first gets it. | Live-TV lässt einen Platz für Filme & Serien frei (ab 2 Plätzen). / Filme & Serien lassen einen Platz für Live-TV frei (ab 2 Plätzen). / Kein Platz wird freigehalten – wer zuerst kommt, bekommt ihn. |
| `adminConv.busyMeasure` | Measuring works only while nobody is watching. | Messen geht nur, wenn gerade niemand schaut. |
| `adminDevices.startLive` | TV starts with Live TV | TV startet mit Live-TV |
| notification texts | §16 | §16 |

## 21. Accessibility

- Channel rows/tiles: one button each with the accessible name "{number} {name}, jetzt: {title}, bis {time}"; the star is a
  separate toggle button. Group chips: `role="tablist"`-free toggle buttons with `aria-pressed` (they filter, they are not tabs).
- Live player: control bar `role="group"`; LIVE pill announces "Live" / "{time} hinter live"; channel changes announce
  "{number} {name}, {title}, noch {n} Min." politely (the info banner itself is `aria-hidden`, so it is not read twice);
  number entry announces the typed number and the match (a lone 0: "Letzter Sender: {number} {name}"); the *Senderliste*
  panel is a dialog with a focus trap, rows are buttons named like list rows, Back/Escape closes it and focus returns to
  the player; *Von Anfang an* is a normal button, absent (not just hidden) from the accessibility tree while unavailable.
- Favourites order: the keyboard path and announcements of §9.2 (`live.fav.order*` texts); on TV the move mode announces
  pick, position and drop the same way.
- Guide (Phase 2, §17.9 G43–G44): `role="grid"` with `aria-rowcount`/`aria-colcount` for the virtualised grid, row headers
  = channels, roving tabindex (one tabbable cell), cells named "{title}, {channel}, {start} bis {end}{, läuft, noch {n}
  Min.}{, Von Anfang an möglich}{, Erinnerung}{, {genre}}{, vorbei}{, Aufnahme geplant}"; the *jetzt* line is decorative
  (`aria-hidden`), *Jetzt* moves focus to the running programme of the first visible row; search results are a listbox.
- Drag-and-drop in the admin has the keyboard alternative of §9.2 with live announcements.
- Contrast pairs (logo tile glass; past guide cells ≥ 4.5:1 with no opacity dimming of text (owner decision 2026-11-12);
  genre stripes ≥ 3:1 against every cell background; red dot paired with text) added to the glass tests.
- TV: focus targets ≥ 54 px, text ≥ 28 px at 1080p, one focused element.

## 22. Testing

Fictional channels and programmes only: *Nordlicht TV*, *Hafenkanal*, *Bergblick Sport*, *Kinderinsel*, *Sternwarte 24*,
*Kanal Wolkenlos*; programmes *Die Leuchtturmwärter*, *Wetter am Hafen*, *Abenteuer Wattenmeer*, *Sternstunde Physik*.
Hosts `iptv.example.com`, `friend.example.com`, `192.0.2.10`. Fixture M3U/XMLTV files under `livetv/test/fixtures/`.

- **Unit (`livetv/`):** M3U parser (attributes, quoting, `#EXTVLCOPT` user agent, VOD skip, 20 000 cap, oversized lines,
  BOM, CRLF), XMLTV parser (gzip, time zones in `start="20261111201500 +0100"`, DST, overlaps, entity/DTD refusal, ratio guard,
  300 000 cap), netguard (every refused range, IPv4-mapped IPv6, rebinding via a fake resolver, redirect re-checks, LAN
  switch), stderr scrubber, passthrough playlist rewriting (variant choice, discontinuities, DVR window), DVR cache eviction,
  stop rules, signed API (vectors), SRT ingest (accept with the right stream id + passphrase on the feed's port; reject an
  unknown id, another port's id, a wrong passphrase, a second sender; per-address throttle; `PUT /v1/ingest` replaces the set;
  no credential or address in any log line), library export (marker guard, not-empty refusal, name sanitising, no symlink
  follow, paths stay below `/library`).
- **Unit (backend):** import merge (overrides survive, missing/return, shrink guard counted before group skipping, skipped
  groups, new groups created unreleased with no roles, numbering policies, `tvg-shift` header and entry), EPG matching (the
  four passes in order, ambiguity moves on, own source first, offsets applied on read, logo preference), rights (roles, user
  allow/deny, admin, unreleased groups invisible to everyone incl. admins, kids kid-friendly only, no group → no tab),
  release on switch (only viewer + needed → stopped before the new start; another viewer → no release; a join during the
  release restarts the stream; not needed → 60-s linger), *Zuletzt gesehen* (cap 10, last/previous), tokens (hash only, pin, re-pin by beat, caps,
  revoke paths), viewer/stop tick, budget counting (all kinds, grants, holdback per priority, HEVC sub-cap, never stops
  running), `/api/playback/info` fallback to copy and 503 `server_busy`, benchmark recommendation (4.6 → 3, 0.8 → 1 with
  warning), EPG now/next and 6-h blocks across DST, rules expansion, recording scheduler (padding, series only-new, keep-max,
  conflicts, reservation, gaps, retention, 24-h warning), notifications dedupe, secret scrubbing (no URL in any answer, log line
  or audit meta — a test greps captured logs for `iptv.example.com`).
- **Unit (gateway):** `/media/l/` path allowlist, authz memo, headers, token never forwarded; `/media/r/` file serving bounds.
- **Unit (updater):** `livetv` op parsing, compose argument building with `--profile livetv`, state persistence, update
  includes livetv only when enabled.
- **Unit (web):** `livekeys.ts` map per platform (OK shows controls and never pauses while they are hidden, long OK opens the
  *Senderliste*, `ChannelList`/`Guide`), number entry (lone 0 = last channel, "0 5" = 5), keys-seen hint filter, channel
  order/wrap (favourites order, *Zuletzt gesehen* snapshot), time left, *Von Anfang an* target, banner timing (first frame +
  4 s), guide geometry (time → x, anchor-time vertical move, DST day width), virtual window, favourites ordering.
- **e2e (Playwright, mocked API + a fake HLS server for the stream):** admin enable flow (updater job and `.env` fallback);
  sources add/test/error states; channels search, bulk, drag order with keyboard; groups & rights matrix; Live-Status; budget
  card and *Neu messen*; Live tab desktop/phone/kids/TV (spatial nav, channel keys, digits); live player pause/rewind/LIVE,
  channel switch with the info banner, *Von Anfang an*, the *Senderliste* panel and focus return on Back, unreachable and
  `live_full` states; the group picker and group release; favourites ordering (drag, keyboard, TV move mode); Chromecast
  live with the cast SDK fake; the guide (Phase 2) on desktop, phone (*Raster* and *Jetzt/Danach*) and TV: filters and
  the opening rule, paged *Alle*, time chips, remote time jumps, data states, search jumping to a cell, genre switch, the
  mini-guide panel, a 500-channel fixture under 4× CPU throttling against the §17.8 numbers; recordings scheduling, conflict warning, *Meine Aufnahmen*, recording playback through the source seam. German UI.
- **On-device checks for the owner** (listed per phase in the plans): Tizen/webOS/Fire TV channel keys and digits (on LG:
  whether CH+/− arrive at all), Tizen `ChannelList`/`Guide`, long OK on each remote, a 120-min buffer rewound 90 min on a TV,
  zapping between two channels of a 1-connection provider, the Phase 2 guide with 500 channels on the household's LG and
  Samsung (open < 2 s, page jump < 100 ms, colour and media keys), QSV
  transcode of an SRT test feed on the N5095, an OBS push through the opened UDP port (and a refused push with a wrong
  passphrase), a library recording appearing in the Jellyfin library, Chromecast and AirPlay live, 30-min pause on a TV.

## 23. Rollout

- **Order:** Phase 0 → 1a (budget; release note: "Gleichzeitige Umwandlungen sind jetzt begrenzt – Standard 2 bis zur ersten
  Messung, danach automatisch; Admin → Betrieb → Wiedergabe-Check") → 1b–1e (one release; Live TV invisible until enabled) → 2 → 3.
- **Migrations:** 46 is the device hand-off plan (builds first); 47 (Phase 0), 48 (1c), 49 (1c, XMLTV staging), 50 (1c, group indexes), the 2a and 3a migrations take the next free index at merge time; all additive; Live
  TV tables are empty until a source is added.
- **Defaults:** budget automatic (2 before measuring), priority films; Live TV offered (hideable), not installed; DVR 30 min
  (up to 120); new provider groups hidden and granted to no role until released; numbering from `tvg-chno`; logos from the
  channel list first; EPG offset 0; `liveRecord` off for guests; recording storage FriendFlix folder, 200 GB,
  retention 30 days, padding 2/5 min; re-encode off.
- **Docs:** new `docs/livetv.md` (German; enabling, sources, rights, GPU overlays, **SRT push: which ports — UDP
  `LIVETV_SRT_PORTS`, default 9000–9009, no TCP, not through the reverse proxy, only needed when a feed pushes — and the
  OBS/encoder setup**, the library overlay with its security note, troubleshooting) + `docs/de` counterpart
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
10. ~~New provider groups are visible to admin/family/friend, not guests, until granted.~~ Superseded by the owner decision
    of 2026-11-12: new provider groups are hidden and granted to no role until the admin releases them (§8).
11. Desktop "last channel" key is Q; channel keys on desktop are ↑/↓ and PageUp/PageDown; phones swipe horizontally; on TVs
    ▲/▼ zap and a lone 0 is last channel (owner decision 2026-11-12).
12. The Android app plays live in the shell's web player; a native live mode is a later option.
13. Recordings are HLS folders in FriendFlix mode (seekable while recording) and one concatenated `.ts` file in library mode;
    library mode makes recordings visible to everyone with that library.
14. Admin sees recording metadata but not playback of private recordings.
15. SRT push: one port of the published UDP range per push feed, stream id + AES-256 passphrase checked in the handshake,
    credentials shown once; listening is cheap, ffmpeg runs only while watched or recorded (owner answer 1).
16. Library recordings: the only write access into the media share is one dedicated sub-folder mounted read-write into
    `livetv` through an opt-in overlay, guarded by a marker file (owner answer 2).
17. *Von Anfang an* seeks to 30 s before the programme start (clamped to the oldest buffered point); the player keeps at
    most 300 s (TV) / 1 800 s (elsewhere) of back buffer in memory and reloads older parts from `livetv`.
18. A changed group selection never renumbers other channels: list positions count skipped groups too.
19. The *Senderliste* panel exists on every platform (button), with long OK, `ChannelList` and Phase-1 `Guide` as TV
    shortcuts; OK on a row switches and closes it.
20. Unreleased groups are invisible on the user side to admins too; the group picker starts with every group ticked (no
    name pattern), because nothing imported is visible before release.
21. EPG offsets: the most specific value wins (channel → `tvg-shift` of the entry → of the header → source), applied when
    programmes are read.
22. Zapping inside *Zuletzt gesehen* walks the order the filter had when it was chosen; on TV each drop in the favourites
    move mode saves at once.

Guide decisions made here (Phase 2, within the owner decision *Programmführer*, 2026-11-12):

23. Opening filter when nothing was chosen yet and there are no favourites: *Alle* (≤ 1 000 channels) or the first group (TV,
    > 1 000). Filter, phone view and the colour switch are remembered per profile on the device (`localStorage`).
24. *Alle* pages are explicit (300 rows, boundary rows to the neighbour pages); the guide requests data per page.
25. Time chips: *Morgens* 06:00, *Mittags* 12:00, *Abends* 18:00, *20:15*, *Nachts* 23:00.
26. Genre mapping: built-in keyword lists, class order Kinder → Sport → Nachrichten → Doku → Serie → Film; the six colour
    tokens of §17 G9.
27. Guide search: substring over titles, the profile's channels, yesterday to +7 days, 50 results, running → upcoming →
    past; a hit outside the current filter switches the filter.
28. The phone *Jetzt/Danach* view shows *now* only (no day/time chips); a tap opens the running programme's details.
29. The mini-guide opens like the *Senderliste* panel (long OK, `ChannelList`, button); ▲/▼ outside it keep zapping (the
    Phase 1 remote decision wins over the research's "▼ opens the mini-guide").
30. TV guide geometry for 28-px text: rows 104 px, channel column 300 px, 240 px per 30 min.
31. While the guide is open the media and colour keys move the guide, never the playing stream.
32. Phase 1 already tells "data ran out" from "no EPG" (`epg: 'gap'`, "Programm gerade nicht verfügbar") in the list, the
    banner and the panel, so the guide's state is not new to people.
33. Admin stale-EPG warning after 72 h without a successful EPG refresh.

## 25. Later (from the 2026-11-12 research, not in Phases 1–3)

Kept as a list so they are not lost; none is planned or binding:

- **Provider catch-up**: read the M3U `catchup*` tags at import and offer *Abspielen* on past guide cells (passthrough, no
  storage, no budget); those cells then get the reserved style "vorbei, abspielbar" (§17 G5).
- **Picture-in-picture**: the browser PiP button on desktop and iPhone Safari (not on TV WebViews).
- **Sleep timer** on TV: *Ausschalten nach 30 / 60 / 90 Min. / Ende der Sendung*.
- **EPG hits in the global search** (*Läuft gerade* / *Demnächst*); the search inside the guide is Phase 2 (§17.5).
- **Multiview**: not now (each tile is a stream, old TVs cannot decode four); maybe a desktop-only two-up.
- **Phase 3 recording notes**: the conflict forecast also counts provider connections; *Aufnehmen* in the player starts
  from the buffered programme start; a visible *Konflikt* marker in *Geplant* and the guide; a partial recording schedules
  the next airing.
- Other research suggestions the owner has not decided (*Jetzt läuft* genre rows on the Live-TV tab, a reminders overview /
  *Meine Erinnerungen* filter, audio
  tracks, live hand-off, Chromecast programme metadata, a `max_streams` message naming the devices, the error action
  *Zurück zu …*, Magic Remote hover rules, refresh at a fixed time) stay with the research report until decided.
