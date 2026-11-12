# Live TV Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server-wide conversion budget that protects film playback (PR 1a), then optional Live TV: the `livetv` container an admin turns on (1b), provider lists and own feeds with a group picker, unreleased new groups, EPG matching basics and groups and rights (1c), watching through tokens, shared streams with a rewind buffer (30 min by default, up to 120) that are released at once when a switch needs their slot, the *Live-TV* tab with ordered favourites and *Zuletzt gesehen*, the live player with info banner, *Von Anfang an* and the *Senderliste* panel, and casting (1d), and the TV remote keys and Android cast bridge (1e).

**Architecture:** `backend/src/convbudget.ts` counts every running video conversion (media server sessions, pending grants, download preparation, later live and recordings) and admits new ones by limit and priority; `/api/playback/info` and cast fall back to a copy stream or `503 server_busy` when it is full. A new workspace `livetv/` (Node + jellyfin-ffmpeg + a small libsrt helper, own container, compose profile `livetv`) does all provider I/O behind an HMAC-signed internal API; the backend owns every row (migration 48), decides rights, mints path tokens and starts/stops one shared stream per channel; the gateway serves `/media/l/<token>/…` from `livetv`. The web adds `/admin/livetv`, `/live` and `/live/watch/[channelId]` built only from the existing glass, player and cast parts.

**Tech Stack:** Fastify + Zod + PostgreSQL (inline migrations) + Redis-backed KV (backend); Node 26 service `livetv/` with jellyfin-ffmpeg 7 and a C helper on libsrt (no npm dependencies); the Node gateway; the updater; SvelteKit with Svelte 4 syntax on the Svelte 5 compiler, hls.js; Kotlin (Android shell, Fire TV); Vitest, Playwright (Chromium, mocked API).

**Spec:** `docs/superpowers/specs/2026-11-11-live-tv-design.md` ("spec §n"; binding; updated 2026-11-12 with the eight owner-approved research changes, spec *Owner decisions* last entry — all of them are in this plan). Phase 1 = spec §1 rows 1a–1e. Phase 0 names come from `docs/superpowers/plans/2026-11-11-users-permissions.md` ("P0 Task n"): `PERM_KEYS` with `liveTv`/`liveRecord`, `effectiveRights()`, `permsOf()`, `featureFlags()`, `invalidateRights()`, `listRoles()`/`roleExists()`, the `roles` table, `effectiveLimits().maxStreams`, web `#lib/perms`, `RoleMatrix.svelte`, `user/Rights.svelte`, `user/CheckView.svelte`.

**Phase 2 guide:** the programme guide (`/live/guide`) is **Phase 2** and not in this plan; there is no Phase 2 plan yet, and spec §17 (G1–G44, owner decision *Programmführer* 2026-11-12) is its requirement list. Phase 1 only prepares for it where noted (rulings 57–59: the per-channel EPG state in Tasks 33, 35, 36, 39, 40, and a *Senderliste* panel built for the Phase 2 mini-guide in Task 40).

**Execution:** subagent-driven. **Base:** `main` after Phase 0 PRs 0a–0c are merged (they sit on the device hand-off PR that adds migration 46; Phase 0 adds 47). PR 1a ships and is released on its own (it changes film playback for everyone); PRs 1b–1e form one release, Live TV stays invisible until enabled. Task 12 checks that migration 47 exists before appending 48; Phase 2 appends 49, Phase 3 appends 50 — never reorder.

### Rulings on the spec (made here, apply to every task)

1. **Node version of `livetv`:** spec §3.1 says Node 22; every image of the repo runs `node:26`. `livetv` uses Node 26 (binary copied from the pinned `node:26-bookworm-slim` image onto `debian:bookworm-slim` + jellyfin-ffmpeg 7). Cost if wrong: a base-image line.
2. **SRT ingest transport:** spec §3.5 asks for "a small native binding"; it is a standalone C helper `srtgate` (libsrt `srt_listen_callback`, built in the image) spawned once by `livetv`, framed data on stdout, feed set on stdin. Same libsrt calls, no N-API/node-gyp toolchain, a crash cannot take the Node process down. Cost if wrong: only the transport behind `IngestHub` changes.
3. **No input ever connects to an unchecked address (spec §3.4):** ffmpeg has no lookup hook, so HTTP(S) inputs (M3U, XMLTV, logos, HLS playlists/segments, MPEG-TS streams, probe bytes) are fetched by Node through `guardedFetch` (checked address, `node:http(s)` `lookup` option) and piped into ffmpeg/ffprobe on stdin; SRT caller inputs get the host replaced by the checked IP literal; ffmpeg runs with `-protocol_whitelist pipe` (or `srt,udp`). Cost if wrong: one extra copy through Node for MPEG-TS inputs.
4. **XMLTV parser without a dependency:** an in-house streaming tokenizer for the XMLTV subset; any `<!DOCTYPE`, `<!ENTITY` or entity reference other than the five predefined and numeric ones refuses the document (`doctype` / `invalid`). Spec "SAX, DTD/entities disabled" + "no new dependencies".
5. **`PlaybackOpts.noConvert` is `PlaybackOptions.noConvert`** (the interface's real name, `backend/src/media/types.ts:349`). The Plex adapter ignores it; Plex answers carry no `delivery`, so Plex playback is counted (its sessions) but never gated.
6. **What is admitted as a film conversion:** only an answer that converts on the server: `!info.directUrl && info.delivery && info.delivery.video !== 'copy'`. A direct-play answer is not gated. Cost if wrong: a player that falls back from a failed direct play to the same answer's HLS converts without a slot (still counted from the session list, never refused).
7. **HEVC inside the budget (spec §5.5 step 4):** the `hevcGate` closure passed to `playbackInfo` becomes "HEVC gate, then `admitConversion(film, hevc)`"; a budget refusal drops the HEVC grant and answers `h264_busy`, so the plan falls back to H.264, which the post-check admits or refuses. HEVC keeps its own grants (`hevcgrant:`) for its sub-cap.
8. **Conversions that are not counted:** preview clips, the HEVC probe and the budget benchmark mark their media-server play session `conv:exempt:<ps>` (TTL 15 min); a session whose play session is a preparing `download_jobs.play_session_id` counts as `download`, not `film`.
9. **`ConvKind` = `'film' | 'live' | 'record' | 'download' | 'reencode'`** with a `hevc` flag on film entries (spec §5.1 lists `hevc` as a subset of `film`). 1a counts film and download; Task 31 adds the `live` source; `record` reservations and `reencode` arrive with Phase 3/later — the pure rule covers every kind now.
10. **Downloads never starve:** spec §5.2 admits `download`/`reencode` when `U < L − H − 1`, which is never true at `L = 1`. The rule is `U < max(1, L − H − 1)`: they run when nothing else converts. An unreadable count makes a download wait (retried next tick), never fail.
11. **Benchmark exclusivity and staleness:** the benchmark takes the HEVC probe's claim (`claimHevcProbe`), so the two never overlap. A stale record (encoder fingerprint changed) makes *automatic* fall back to 2 and the 10-minute tick re-measures when idle.
12. **Gateway "path scrubbing" (spec §7.3) does not exist:** the gateway writes no per-request log line at all. The `/media/l/` tests pin that it stays silent and that metrics carry only code labels.
13. **`featureFlags(ctx).livetv` = detected-installed** (the follow-up P0 ruling 3 announced); `/api/me.features.livetv` = installed ∧ `perms.liveTv` ∧ the active profile sees ≥ 1 channel.
14. **How the TV knows to start with Live TV (spec §11.3):** `/api/me` gains `startLive: boolean` (session device id starts with `tv-`, `devices.start_live`, `features.livetv`); the TV start page `/tv` replaces to `/live?play=last` instead of `/`.
15. **Stream test in 1c shows probe facts only**; the 10-second preview player needs tokens and the gateway route and arrives in Task 42.
16. **Copy keys mapped onto the existing structure:** `player.serverBusy` → `player.error.serverBusy`; `player.capReason.serverBusy` → `player.quality.reasonServerBusy`. Everything else keeps the spec §20 key names, in new locale files `adminConv.ts`, `adminLive.ts`, `live.ts`.
17. **Signed `livetv` API:** the updater scheme with key label `friendflix-livetv/v1`, headers `x-ff-livetv-ts`, `x-ff-livetv-nonce`, `x-ff-livetv-signature`, 64 KB body cap (the ingest set and inputs exceed the updater's 1 KB), vectors `test-vectors/livetv-hmac.json`. `/healthz` adds `api: 1`; "version compatible" (spec §4.1) = `api === 1`.
18. **Channel identity without `tvg-id`:** spec §6.1 says `sha256(name + url without query)`. Xtream-style lists carry the credentials in the path (`/live/<user>/<pass>/101.ts`), so a password change would orphan every channel. The key is `sha256(normName(name) + '|' + host + '|' + last path segment)[0..32]` (userinfo, query and other path segments dropped); a second entry with the same key gets `:2`, `:3`. Cost if wrong: two channels with equal name, host and stream id merge (the `:n` suffix keeps them apart).
19. **Derived number without an extra column:** an entry without `tvg-chno` is imported with `import_number = number_base + index` (0-based position in the provider list), so "`number_base` + import position" needs no new column.
20. **Provider connection limit (spec §19)** answers `503 { error: 'provider_limit', max, running }`.
21. **Live playback records:** `playSessionId = 'ltv-' + tokenHash.slice(0, 24)`, `itemId = 'ch:<channelId>'`, `source: 'livetv'` (the `Live.source` union gains it).
22. **Channel logos for the cast receiver:** the receiver sends no cookies and the cast image token only reaches the media server; logos are served by the backend, so the cast metadata uses a signed URL `GET /api/livetv/logos/:hash?exp=<ms>&sig=<hmac>` (label `friendflix livetv logo v1`, like `castSubtitlePath`).
23. **ffmpeg output:** remux and transcode write `-f segment` TS segments and report each finished one as a CSV line on stdout; `livetv` owns the playlist for all three modes (`SegmentWindow`), so DVR, discontinuities and cache eviction are one code path.
24. **1c before the stream endpoints exist:** `GET /api/admin/livetv/status` and the ingest sync treat a `404` from `livetv` (`/v1/streams`, `/v1/ingest`) as "none yet".
25. **Settings group `livetv`** is listed in Admin → *Einstellungen* only while `livetvInstalled(ctx)`; `LIVETV_SRT_HOST` unset = the host of `PUBLIC_URL`, derived at read time.
26. **Recordings mount:** the `livetv` service ships with the spec §3.1 `/recordings` volume line now (empty until Phase 3); the gateway's read-only recordings mount waits for Phase 3.
27. **EPG refresh** replaces a source's imported programmes in one transaction only after a complete parse (§19: a broken file keeps the old ones). Phase 1 matching (updated 2026-11-12): the four passes of spec §9.4; within a pass the own source's EPG decides when it has any hit (exactly one → match, several → next pass), otherwise the other sources together (exactly one → match, else next pass).
28. **Logo refetch:** a logo URL is fetched once per 7 days (KV `ltvlogo:<sha256(url)>` → hash); the URL itself is never stored.
29. **"Fresh probe"** (spec §7.4, SRT) = younger than 24 h.
30. **Tizen key codes** are read with `tizen.tvinputdevice.getKey(name).code` at registration; constants are only the fallback.
31. **Android `castLive`:** the native side calls `POST /api/livetv/channels/:id/watch` itself with its authenticated session; no token crosses the bridge.
32. **Logo upload** is a raw image body (`content-type: image/png|jpeg|webp`, route `bodyLimit` 512 KB), not multipart (the backend has no multipart plugin; no new dependency).
33. **Docs language:** spec §23 says `docs/livetv.md` German; the repo convention is English in `docs/`, German in `docs/de/`. Both are written, per convention.
34. **Cache checkbox:** the updater's only data-deleting op is `remove` (image + optional cache). *Zwischenspeicher löschen* is enabled only together with *Image entfernen*; `{ removeImage: false, removeCache: true }` → `400 invalid`.
35. **Stream-id hint:** spec §3.5 shows the admin "the first 6 characters of the stream id", which would be `ff-` plus three; the hint is `ff-` + the first 6 random characters (e.g. "ff-AB12CD…", as in spec §9.1).

Rulings for the owner decisions of 2026-11-12 (the spec text they produced is marked "(spec)"; the rest is implementation only):

36. **Detecting a switch (spec §7.4):** the watch request carries no "from" field; the backend reads the calling device's own live view (the token `mintLiveToken` would replace). Cost if wrong: a client field later, no data change.
37. **Release under the budget lock:** `admitConversion` and `countConversions` take `exceptLive?: string` (a channel id left out of the count); the admission for B is decided with A left out, then A is released, so no other admission can take A's slot in between. `liveConversions`' 5-s cache is invalidated by the release.
38. **Release race (spec §7.4, §19):** marker `ltv:stopping:<channelId>` (setnx 20 s); viewers are counted again after setting it; `startOrJoin` for a channel with the marker polls every 200 ms for ≤ 5 s, then starts it through the normal start path. A recording never uses a channel in Phase 1 (`recordingUses` → false until Phase 3).
39. **Unreleased groups (spec §8):** invisible on the user side for everyone, admins included; per-person `allow` does not reach them either. Manual groups start released. (spec)
40. **Group selection is a skip-list (spec §9.1):** `skip_groups` (unticked groups), so groups the provider adds later still import (unreleased). Picker default: everything ticked, no name pattern — nothing is visible before release anyway. `/v1/fetch/m3u` drops skipped groups before its 20 000 cap. (spec)
41. **Numbering positions and the shrink guard count every live entry, skipped groups included** (spec §6.1, §10): a changed selection never renumbers and never looks like a shrunk list. (spec)
42. **EPG offsets (spec §6.1, §9.1, §19):** precedence channel override → entry `tvg-shift` → header `tvg-shift` → source; applied when reading, never stored into programmes; `tvg-shift` hours with decimals → whole minutes, outside −12…+14 h ignored; the admin steppers use 30-min steps. (spec)
43. **XMLTV icons:** never stored as URLs; the EPG refresh keeps `<icon>` URLs in memory and, after matching, fetches (through `importLogo`, 7-day memo) only for matched channels whose preference needs it; the hash goes to `livetv_channels.epg_logo_hash`.
44. **Matching pass 4** (`normName` equality, unique only) is exact after normalisation, not fuzzy; Dice suggestions stay Phase 2. (spec)
45. **`livetv_recent` replaces `livetv_last`** (one row per profile × channel, FK cascades, trimmed to 10 on write); the route stays `PUT /api/livetv/last`; the list answer gains `recent` and keeps `last` (derived). (spec)
46. ***Zuletzt gesehen* zapping walks a snapshot** taken when the filter is chosen. (spec)
47. **Buffer up to 120 min (spec §3.3, §12):** `dvrSeconds` 0–7200 on the wire; hls.js `backBufferLength = min(dvrSeconds, 1800)`, on TVs `min(dvrSeconds, 300)`; every segment line carries `#EXT-X-PROGRAM-DATE-TIME` (provider value, else arrival − duration). (spec)
48. ***Von Anfang an* target:** `max(oldest, start − 30 s)`; shown while `start ≥` the oldest segment's date-time. (spec)
49. **Info banner hold:** `BANNER_HOLD_MS = 4000` after the first frame (the decision says "about 4 s").
50. **Long OK:** one helper `createLongOk` (600 ms, key repeats ignored) for the list (favourite) and the player (*Senderliste*).
51. **Phase 1 `Guide` key** (Tizen where supported, Fire TV) opens the *Senderliste* panel; Phase 2 rebinds it to the grid. OK in the panel switches and closes it. (spec)
52. **Keys seen** are stored per device in `localStorage['ff-live-keys-seen']` (try/catch; empty = D-pad hints only), classes `channel`, `digit`, `colour`, `info`.
53. **Lone 0:** `commitNumber` answers `{ kind: 'last' }`; the player maps it to *previous*, the list to the last watched row. (spec)
54. **Menu names (spec §5.6, §11):** the budget card goes on `/admin/playback`, labelled *Wiedergabe-Check* in the sidebar group *Betrieb* (`admin.tabs.playback`); the phone tab is *Merkliste* (`shell.tabs.myList`). No label changes.
55. **Vorrang hint** keys are per option: `adminConv.priority.hint.films|live|equal` (spec §5.6/§20); the spec's worked example is now "Live-TV 4,4× · empfohlen 3", which `recommend` gives.
56. **`dragOrder.ts` lives in `web/src/lib/ui/`** (not under `admin/`), because the user-side favourites order (Task 38) reuses it.

Rulings for the guide decision of 2026-11-12 (*Programmführer*; Phase 2 except where a Phase 1 task is named):

57. **No Phase 2 plan is written now**; spec §17 G1–G44 plus spec §24 decisions 23–33 are binding for it. Phase 1 changes only as in 58–59.
58. **Per-channel EPG state in Phase 1** (spec §10, §11.1): `GET /api/livetv/channels` answers `epg: 'ok' | 'gap' | 'none'` per channel — `ok` = a programme covers now, `gap` = the channel has an EPG mapping (`epg_source_id`/`epg_channel_id` set) but nothing covers now, `none` = no mapping; rows, the banner and the panel show `live.gap` "Programm gerade nicht verfügbar" for `gap` and "Live" / "Kein Programm verfügbar" for `none` (Tasks 33, 35, 36, 39, 40). (spec)
59. **The *Senderliste* panel is the Phase 2 mini-guide's base** (spec §12.2, §17.7 G35–G36): Task 40 builds rows as `PanelRow.svelte` with a `showNext = false` prop (Phase 2 sets it and reserves the *Danach* line) and gives `ChannelPanel` an empty `foot` slot (Phase 2 puts *Programmführer* there); no second component later. Keys stay as decided: ▲/▼ outside the panel zap (spec §24 decision 29).
60. **Guide decisions made in the spec** (spec §24 23–33, Phase 2): opening filter fallback and per-device memory; explicit 300-row pages; time chips 06:00 / 12:00 / 18:00 / 20:15 / 23:00; genre keyword lists, class order and six colour tokens; search as a title substring with 50 results; phone list view shows *now* only; mini-guide openings; TV geometry 104-px rows / 300-px column for 28-px text; guide owns media and colour keys while open; admin stale-EPG after 72 h. (spec)

### Pull requests and order

| PR | Task | Implementer | Depends on |
| --- | --- | --- | --- |
| **1a** budget | 1 `convbudget.ts`: counting, admission rule, grants, settings | **Opus** · backend (concurrency) | Phase 0 merged |
| 1a | 2 `/api/playback/info` + cast gate, `noConvert` fallback, `503 server_busy` | **Opus** · backend (playback path) | 1 |
| 1a | 3 Download preparation waits for a slot | Sonnet · backend | 1 |
| 1a | 4 `convbench.ts`, recommendation, tick, admin API | **Opus** · backend (process claims) | 1 |
| 1a | 5 *Umwandlungen* card on Admin → *Betrieb* → *Wiedergabe-Check* | Sonnet · frontend | 4 |
| 1a | 6 Player server-busy states, docs, CHANGELOG | Sonnet · frontend + docs | 2 |
| **1b** container | 7 `livetv/` workspace, signed API, `/v1/system`, backend client | **Opus** · new service (signing) | PR 1a merged |
| 1b | 8 Compose profile, networks, GPU overlays, CI checks, setup docs | Sonnet · ops | 7 |
| 1b | 9 Updater `POST /v1/livetv` (enable/disable/remove) | **Opus** · updater (process control) | 7 |
| 1b | 10 Detection, admin state, enable/disable routes, GPU advice | Sonnet · backend | 7, 9 |
| 1b | 11 Web: optional entry and enable/disable flow | Sonnet · frontend | 10 |
| **1c** channels | 12 Migration 48 (incl. import options, unreleased groups, `livetv_recent`), `livetv` settings group, effective channel values | **Opus** · backend (migration) | PR 1b merged |
| 1c | 13 `livetv` address guard and guarded fetch | **Opus** · livetv (SSRF) | 12 |
| 1c | 14 M3U/XMLTV/logo fetch routes (`tvg-shift`, skipped groups, group counts, icons), stream probe | **Opus** · livetv (hostile input, processes) | 13 |
| 1c | 15 Sources CRUD with encrypted URLs and import options, test route with groups | **Opus** · backend (secrets) | 12, 14 |
| 1c | 16 Import merge (skip list, numbering policy, unreleased groups), refresh tick, events, failure notice, logos | **Opus** · backend (merge rules) | 15 |
| 1c | 17 EPG import, four-pass matching, offsets, logo preference, now/next, prune | Sonnet · backend | 16 |
| 1c | 18 Groups (incl. release), per-profile channel rights, `features.livetv`, P0 data | **Opus** · backend (authz) | 16 |
| 1c | 19 Channel administration API (incl. EPG offset), logos, stream test | Sonnet · backend | 18 |
| 1c | 20 Own feeds: pull and SRT push credentials, ports, ingest sync | **Opus** · backend (credentials) | 19 |
| 1c | 21 Web: `/admin/livetv` shell and *Quellen* tab | Sonnet · frontend | 15, 20 |
| 1c | **22 (new)** Web: group picker after *Prüfen*, import options | Sonnet · frontend | 21 |
| 1c | 23 Web: *Kanäle* list, bulk, logo, EPG offset, test sheet | Sonnet · frontend | 19, 22 |
| 1c | 24 Web: *Reihenfolge* drag and keyboard order (`#lib/ui/dragOrder`) | **Opus** · frontend (drag a11y, FLIP) | 23 |
| 1c | 25 Web: *Gruppen & Rechte* (incl. release) + Live-TV in the P0 people pages | Sonnet · frontend | 18, 21 |
| 1c | 26 *Live-Status* (API + tab), guide counts, off dialog | Sonnet · backend + frontend | 17, 21 |
| **1d** watching | 27 `livetv` streams, DVR window (≤ 120 min, date-times), cache, HLS passthrough | **Opus** · livetv (streaming) | PR 1c merged |
| 1d | 28 `livetv` remux/transcode, reconnect, previews, benchmark | **Opus** · livetv (ffmpeg) | 27 |
| 1d | 29 `livetv` SRT push ingest (`srtgate` + `IngestHub`) | **Opus** · livetv (native, credentials) | 28 |
| 1d | 30 Live tokens, pinning, `/internal/authz/live`, revocation | **Opus** · backend (security) | 27 |
| 1d | 31 Start/join/stop, `livetvTick`, budget live source, watch routes | **Opus** · backend (concurrency) | 28, 30 |
| 1d | **32 (new)** Release the old stream on a channel switch | **Opus** · backend (concurrency, races) | 31 |
| 1d | 33 Channel list, ordered favourites, *Zuletzt gesehen*, last channel, TV start, admin stop | Sonnet · backend | 31 |
| 1d | 34 Gateway `/media/l/<token>/<file>` | **Opus** · gateway (authz) | 30 |
| 1d | 35 Web live model, `livekeys.ts` (OK, long OK, lone 0), number entry, keys seen, compat scan | Sonnet · frontend | 33 |
| 1d | 36 Web `/live` desktop + phone (*Zuletzt gesehen*, time left), navigation entries | Sonnet · frontend | 35 |
| 1d | 37 Web `/live` on TVs (hint line, D-pad path) and for kids, *TV startet mit Live-TV* | Sonnet · frontend | 36 |
| 1d | **38 (new)** Web: *Favoriten ordnen* (drag, keyboard, TV move mode) | Sonnet · frontend | 24, 37 |
| 1d | 39 Web `LivePlayer` (DVR, info banner, *Von Anfang an*, switching, states) | **Opus** · frontend (player, timers) | 34, 35 |
| 1d | **40 (new)** Web: player on TV remotes — OK, long OK, *Senderliste* panel, focus return | **Opus** · frontend (focus, key timing) | 37, 39 |
| 1d | 41 Casting live (Chromecast, AirPlay, receiver) | **Opus** · frontend (cast engine) | 39 |
| 1d | 42 Admin stream test preview, Live-Status streams, Live-TV docs | Sonnet · full stack + docs | 39 |
| **1e** shells | 43 Tizen (incl. `ChannelList`/`Guide`) and webOS live keys | Sonnet · frontend | PR 1d merged |
| 1e | 44 Fire TV `FireTvKeys` | Sonnet · Android | PR 1d merged |
| 1e | 45 Android `castLive` bridge, release docs | Sonnet · Android + docs | 41 |

Tasks per PR: **1a: 6, 1b: 5, 1c: 15, 1d: 16, 1e: 3** (45; the 2026-11-12 update added Tasks 22, 32, 38 and 40 and renumbered the ones after them). Within a PR follow the order. Each PR leaves the app working; 1b–1e change nothing visible until an admin enables Live TV.

## Global Constraints

- **Svelte:** Svelte 4 syntax on the Svelte 5 compiler (`export let`, `$:`, `on:event`, slots, stores); no runes.
- **Styling:** plain CSS with the glass `.frost*` classes (`.panel`, `.frost`, `.frost-flat`, `.frost-safe`, `.frost-btn`, `.frost-pill`, `.frost-tile`, `.frost-sheet`, `.frost-dim`) and `--fr-*` tokens (`--fr-sel`, `--fr-r-*`, `--fr-solid`) from `web/src/app.css`; the existing admin components (`#lib/adminContent/AdminCard.svelte`, `#lib/ui/{DataTable,StatusPill,StatTile,Toggle,Select,Field,Button,ActionMenu}.svelte`, `#lib/glass/SlidePill.svelte`, `confirm`, `runAction` toasts with undo), the player's control bar, `TvControls`, the cast bar, chips, tiles and focus rings (TV: `scale(1.08)` + 3 px white ring, one focused element). No Live-TV palette: the only colour cue is the existing `--err`, always with text or shape. No new blur rule.
- **Motion:** animate only `transform` and `opacity`; nothing may jump (now/next lines, progress bars, error lines and save bars reserve their space first, or the element overlays). Opening and closing both animate (`growBoth`, `sheetSlide`, `barRise`, `toastRise`, `scrimFade` from `#lib/glass/fx`). Calm mode / reduced motion / TV / kids (`html.m-still`, `fxMode() === 'still'`): durations 0, solid panels (`--fr-solid`). `web/src/lib/admin/glass.test.ts` scans every `.svelte`/`.css` under `web/src` and must stay green.
- **Old TV browsers:** web code reaches Tizen (Chromium 85) and webOS (Chromium 87). New files under `web/src/lib/live/`, `web/src/routes/live/` and the TV paths use nothing newer than Chromium 85: no `structuredClone`, `Array.prototype.at`, `Object.hasOwn`, `findLast`, CSS `aspect-ratio`, `inset`, `:has()`, `@container` (scan test in Task 35).
- **Remote (spec Global constraints):** every live feature works with D-pad + OK + Back alone; CH, digit, colour, Info, `ChannelList`, `Guide` and a long OK are shortcuts, never the only way; hints never name a key the device has not sent. ▲/▼ zap on every TV; LG CH+/− are never relied on.
- **Copy:** German UI copy primary plus all locales (de, en, es, fr, it, pl, tr) with identical key order in all seven files (`web/src/lib/i18n/locales/<lang>/*.ts`; `de` is the typed source). DE and EN values from spec §20 or the task (the 2026-11-12 strings are all in spec §20 with DE and EN); translate the other five. Menu names as the app shows them today: *Wiedergabe-Check* (Admin → *Betrieb*), *Merkliste*. New area files `adminConv.ts` (Task 5), `adminLive.ts` (Task 11), `live.ts` (Task 35), registered in each `index.ts` after `desk`. Backend notification texts in `backend/src/messages.ts` (de + en blocks). Every user-facing string through `#lib/i18n` / `m()`.
- Never "Netflix"/"Seerr" in user-facing text.
- **Fictional names only:** channels *Nordlicht TV*, *Hafenkanal*, *Bergblick Sport*, *Kinderinsel*, *Sternwarte 24*, *Kanal Wolkenlos*; programmes *Die Leuchtturmwärter*, *Wetter am Hafen*, *Abenteuer Wattenmeer*, *Sternstunde Physik*; people Anna Beispiel, Ben Muster, Carla Probe; titles *Dunmoor*, *Saltwater Almanac*. Fixture M3U/XMLTV under `livetv/test/fixtures/`.
- **Placeholder hosts only:** `friend.example.com`, `iptv.example.com`, `192.0.2.x` (`192.0.2.10` for own feeds).
- **Secrets:** provider URLs, channel stream URLs, SRT stream ids and passphrases are stored encrypted (`encrypt(ctx.encKey, …)` from `backend/src/crypto.ts`, the settings-blob format), never sent to a browser except the one-time push result, never in logs, metrics labels, audit meta (field names and ids only), error texts (fixed codes), events or Diagnose. Live tokens: hashed in KV, never logged, never in browser storage. The Plex token never reaches clients. `livetv` logs channel ids only, never ffmpeg arguments; ffmpeg stderr passes `scrubLine`.
- **Containers:** `livetv` is its own service in compose profile `livetv` — nothing is pulled or run until enabled (updater or `COMPOSE_PROFILES=livetv`). No Docker socket for backend, web, gateway or `livetv`; only the updater talks to `docker-proxy`. `livetv`'s only published ports: UDP `LIVETV_SRT_PORTS` (default `9000-9009`) for SRT push; its API stays on the internal `livetv` network.
- **Workspace boundaries:** the backend never imports from `livetv/` (separate image); the answer shapes it consumes (`M3uEntry`, `XmlItem`, `ProbeResult`, `StreamView`, `IngestState`, `Encoder`) are re-declared in `backend/src/livetv/wire.ts` by the task that first consumes each, field-for-field equal to the `livetv` declaration.
- **Admin visibility:** the Live-TV admin area appears only while the backend detects the `livetv` container; before that only the small, hideable *Live-TV (optional)* entry.
- **Migrations** inline in `backend/src/db.ts`: append to `MIGRATIONS`, number **48** (one array element, spec §6.1 SQL verbatim), rerunnable where the spec SQL allows; 49/50 are Phase 2/3.
- **Errors** keep the `{ error: code }` shape; admin routes use `requireAdmin(ctx)`; admin writes are audited `livetv.*` with ids and changed field names only. Validation answers `{ error: 'invalid', field }` (Zod `safeParse`, never the input echoed).
- Every new source file starts with the SPDX header (`SPDX-FileCopyrightText: 2026 Manuel Weißböck`, `SPDX-License-Identifier: AGPL-3.0-or-later`; `.svelte` as HTML comments, `.c` as `//`). No new npm dependencies anywhere (`livetv` uses Node built-ins; `srtgate` links the system libsrt). Coverage thresholds are never lowered; `livetv/vitest.config.ts` starts at statements 90 / branches 80 like `updater/`.
- **Verification:** agents run only typecheck plus the specific test files they touch, CI runs the rest:
  - root `npm run typecheck` (all workspaces incl. `livetv`, plus `npx tsc -p e2e/tsconfig.json`);
  - backend `npx -w backend vitest run <file>` (PostgreSQL on `localhost:5433` or `TEST_DATABASE_URL`; if none is reachable, leave it to CI and say so); `npx -w livetv vitest run <file>`, `npx -w gateway vitest run <file>`, `npx -w updater vitest run <file>`, web unit `npx -w web vitest run <file>`;
  - e2e from `e2e/`: `E2E_PORT=<port> PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx playwright test <spec> --trace off` (only the task's spec files; delete `e2e/test-results` afterwards);
  - Kotlin (Tasks 44, 45): the named Gradle unit test only if the Android SDK is present, else CI;
  - tests never need a real ffmpeg, libsrt, Jellyfin or provider: process runners and fetches are injected fakes.
- **Commits:** Conventional Commits, one per task (the commit step names it), each ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`
  (`git commit -m "<subject>" -m "Co-Authored-By: …" -m "Claude-Session: …"`). No model names anywhere else. Do not push.

## Review Focus

1. **Two people start the same channel that is not running yet, within the same second** (a family on two TVs at 20:15): exactly one `POST /v1/streams`, one budget slot, two tokens on the same stream; nobody gets `live_full` from their own household's race. Test in Task 31 (`concurrent first viewers start one stream and take one slot`).
2. **The provider password changes in an Xtream-style list** (`/live/<user>/<pass>/101.ts`, no `tvg-id`): every channel keeps its id, overrides, favourites and last-channel entry; only the encrypted stream URL changes. Tests in Task 14 (`credential path segments do not change the key`) and Task 16 (`a provider password change keeps channel identity`).
3. **The media server's session list is slow or unreachable** while someone presses play: a title that can be copied still plays (copy fallback, chip "Server ausgelastet"); only a title that truly needs a conversion gets the busy message — never a spinner or a generic error. Test in Task 2 (`slow session list falls back to copy, not a hard error`).
4. **A phone moves from Wi-Fi to mobile data while watching live:** the pinned token re-pins through the next heartbeat of the same session; another address without that session's beat stays refused. Test in Task 30 (`a local token re-pins through a beat from the same session`).
5. **A provider restarts its encoder and the HLS media sequence jumps back** (or resets to 0): local segment numbers stay strictly increasing, a discontinuity is marked, players and the DVR window keep working. Test in Task 27 (`a provider media sequence that jumps back keeps local numbering monotonic`).
6. **A second person joins the old channel while a switch is releasing it** (Anna zaps away from *Hafenkanal* on a 1-connection provider while Ben's TV opens *Hafenkanal*): Ben never gets a dead stream — either he came first and keeps it (Anna's switch is refused with `provider_limit`), or he waits ≤ 5 s and *Hafenkanal* starts again through the normal start path. Tests in Task 32 (`a viewer who joins during the release never gets a dead stream`, `a viewer counted before the recount keeps the stream`).
7. **Zapping back and forth on a 1-connection provider or a budget of 1** (A → B → A within a few seconds): every switch starts within the normal start time; no minute-long `provider_limit`/`live_full` from the person's own previous channel. Test in Task 32 (`zapping on a 1-connection provider releases the old stream at once`).
8. **A 120-minute buffer on a Chromium 85 TV, rewound 90 minutes:** the player keeps ≤ 300 s of back buffer in memory and loads older segments from `livetv`; no `QuotaExceededError` loop, *Von Anfang an* still lands on the programme start. Tests in Task 39 (`liveHlsConfig caps the back buffer on TVs`, `Von Anfang an seeks into a long buffer`).
9. **A provider list with hundreds of groups, most unticked, plus a new adult group appearing a week later:** unticking does not trip the shrink guard or renumber picked channels; the new group arrives unreleased and nobody (admins included) sees it on the user side. Tests in Task 16 (`unticking most groups does not trip the shrink guard`, `a group the provider adds later arrives unreleased`) and Task 18 (`unreleased groups are invisible to everyone`).

---

## PR 1a — Shared conversion budget (Tasks 1–6)

### Task 1: `convbudget.ts` — counting, admission rule, grants, settings

**Implementer:** Opus (hard: concurrency, KV locks) · backend

**Files:**
- Create: `backend/src/convbudget.ts`
- Modify: `backend/src/config.ts` (`CONVERSION_SLOTS: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1).max(16).optional())`, `CONVERSION_PRIORITY: z.enum(['films', 'live', 'equal']).default('films')`), `backend/src/settings/registry.ts` (both in group `playback` after `HEVC_STREAMS`, comment "read per admission"), `backend/src/previews.ts` (`build()`: `markConvExempt` right after `clipTranscode`), `backend/src/hevcenc.ts` (`probeHevcEncoder`: `markConvExempt` after `clipTranscode`)
- Test: `backend/test/convbudget.test.ts`

**Interfaces:**
- Produces (`backend/src/convbudget.ts`):
  - `export type ConvKind = 'film' | 'live' | 'record' | 'download' | 'reencode'; export type ConvPriority = 'films' | 'live' | 'equal';`
  - `export interface ConvEntry { kind: ConvKind; key: string; hevc?: true; label: string | null; since: number | null; device: string | null; userId: string | null; pending?: true }`
  - `export interface BenchRecord { speed: number; hwAccel: string; fingerprint: string; at: number }` (livetv record: `hwAccel` holds the encoder name)
  - `export const CONV_DEFAULT_SLOTS = 2; CONV_GRANT_TTL_S = 30; CONV_EXEMPT_TTL_S = 900;` session read timeout = `HEVC_SESSIONS_TIMEOUT_MS` (800).
  - `export function holdback(limit: number, p: ConvPriority): 0 | 1` — `limit >= 2 && p !== 'equal' ? 1 : 0`.
  - `export function admits(kind: ConvKind, used: number, limit: number, p: ConvPriority): boolean` — spec §5.2 with ruling 10: `record` `U < L`; preferred (`film` for `films`, `live` for `live`, both for `equal`) `U < L`; the other of film/live `U < L − H`; `download`/`reencode` `U < max(1, L − H − 1)`.
  - `export function recommend(s: { jellyfin: number; livetv?: number }): number` — `clamp(floor(min(…) × 0.7), 1, 16)`.
  - `export async function readBench(ctx: Ctx): Promise<{ jellyfin: BenchRecord | null; livetv: BenchRecord | null; stale: boolean }>` — KV `conv:bench`, `conv:bench:livetv`; `stale` when the Jellyfin record's fingerprint ≠ `fingerprint(encoderSettings)` (settings read through a 60 s memo, 3 s timeout; unreadable = not stale).
  - `export async function conversionLimit(ctx: Ctx): Promise<{ limit: number; auto: number; custom: number | null; recommended: number | null; priority: ConvPriority }>` — `auto = stale || !jellyfin ? 2 : recommend(...)`; `limit = custom ?? auto`.
  - `export async function countConversions(ctx: Ctx, o?: { exceptUser?: string; exceptDevice?: string }): Promise<ConvEntry[] | null>` — `null` when `transcodeSessions()` does not answer within 800 ms (or is absent → `[]` from it, grants still counted). Counted: server sessions with `videoDirect === false`, or `playMethod === 'Transcode'` with `videoDirect` undefined (label = item name, series name first); skipped when `conv:exempt:<ps>` exists; kind `download` when `ps` is a `download_jobs.play_session_id` with `status = 'preparing'`; pending grants `conv:grant:*` whose `ps` the server does not list yet; the requester's own sessions (live records of `exceptUser`+`exceptDevice`) removed (the `hevcGate` rule).
  - `export async function admitConversion(ctx: Ctx, o: { kind: ConvKind; userId: string; deviceId?: string; hint: string; hevc?: boolean; label?: string }): Promise<{ ok: true } | { ok: false; why: 'full' | 'unknown' }>` — lock `conv:gate` (`setnx` 3 s, one retry after 150 ms; no lock → `unknown`), count, `admits`, on success `conv:grant:<hint>` = `{ kind, user, device?, hevc?, label? }` TTL 30 s.
  - `export async function bindConvGrant(ctx: Ctx, hint: string, playSessionId: string | null): Promise<void>` (moves the grant to `conv:grant:<ps>` with `ps` set; `null` drops it) and `export const dropConvGrant = (ctx: Ctx, hint: string) => bindConvGrant(ctx, hint, null);`
  - `export async function markConvExempt(ctx: Pick<Ctx, 'kv'>, playSessionId: string): Promise<void>`
- Running conversions are never stopped by this module (no `stopEncoding` call anywhere in it).

- [ ] **Step 1: Write the failing tests** in `backend/test/convbudget.test.ts` (fake `transcodeSessions` via the `makeEnv` Jellyfin handlers):
  - `admits follows the priority table` — `(L, U, kind, prio) → result`: `(3,2,film,films)` true; `(3,2,live,films)` false; `(3,1,live,films)` true; `(3,2,live,live)` true; `(3,2,film,live)` false; `(3,2,live,equal)` true; `(3,2,record,films)` true; `(3,3,record,films)` false; `(3,1,download,films)` false; `(3,0,download,films)` true; `(1,0,live,films)` true; `(1,0,download,films)` true; `(1,1,download,films)` false; `(2,1,download,equal)` false.
  - `holdback and recommend` — `holdback(1,'films') === 0`, `holdback(2,'films') === 1`, `holdback(4,'equal') === 0`; `recommend({jellyfin: 4.6}) === 3`, `recommend({jellyfin: 0.8}) === 1`, `recommend({jellyfin: 4.6, livetv: 3.9}) === 2`, `recommend({jellyfin: 4.6, livetv: 4.4}) === 3` (the spec §5.6 example), `recommend({jellyfin: 30}) === 16`.
  - `conversionLimit` — nothing measured → `{ limit: 2, auto: 2, custom: null, recommended: null, priority: 'films' }`; bench 4.6 → `auto 3, limit 3`; `CONVERSION_SLOTS 5` → `limit 5, auto 3`; bench with another fingerprint → `auto 2`.
  - `counts server conversions` — sessions: `Transcode` + `videoDirect false`, `DirectStream` + `videoDirect true`, `Transcode` + `videoDirect` undefined, `DirectPlay` → two `film` entries labelled "Dunmoor" and "Saltwater Almanac".
  - `exempt and download sessions` — a session whose `ps` has `conv:exempt:` is not counted; a session whose `ps` is a preparing download job's → one entry `kind 'download'`.
  - `pending grants count once` — admit film hint `h1` → 1 entry (`pending`); `bindConvGrant(h1, 'ps1')` and the server now lists `ps1` → still 1.
  - `own device is replaced` — `L=1`, user Anna device `d1` has a live record on converting `ps1` → `admitConversion({ kind: 'film', userId: anna, deviceId: 'd1' })` → ok.
  - `unreadable list means unknown` — `transcodeSessions` never resolves → `{ ok: false, why: 'unknown' }` in < 1 s.
  - `two asks for the last slot` — `L=1`, two admits for different devices in `Promise.all` → exactly one `ok`.
  - `other apps may push U above L and are never stopped` — three foreign transcodes, `L=2` → film refused; no `ActiveEncodings` DELETE recorded.
  - `probes and previews are exempt` — after `probeHevcEncoder` and a preview build with the fakes, `conv:exempt:<their ps>` exists.
- [ ] **Step 2: Run** `npx -w backend vitest run test/convbudget.test.ts` → FAIL.
- [ ] **Step 3: Implement** `convbudget.ts`, the two settings, the two `markConvExempt` calls.
- [ ] **Step 4: Verify** the file → PASS; `npx -w backend vitest run test/hevc-encoder.test.ts test/previews.test.ts test/settings-live.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(budget): count conversions and admit them against one shared budget`

### Task 2: Playback and cast admit conversions, copy fallback, `503 server_busy`

**Implementer:** Opus (hard: the film playback path) · backend

**Files:**
- Modify: `backend/src/media/types.ts` (`PlaybackOptions.noConvert?: boolean`; `CapReason` and `TranscodeReason` gain `'serverBusy'`), `backend/src/media/streamplan.ts` (`PlanInput.noConvert?: boolean` → `wantsHevcEncode = false`), `backend/src/jellyfin/service.ts:586-662` (pass `noConvert` into `planStream`; no other change), `backend/src/routes/media.ts:342-389` (`/api/playback/info`), `backend/src/routes/cast.ts:95-115` (`POST /api/cast/session`), every allowlist of transcode reasons (`grep -rn "'uploadCap'" backend/src` — e.g. `playtiming.ts`, `playstats.ts`) gains `'serverBusy'`
- Test: `backend/test/playback-budget.test.ts`

**Interfaces:**
- Consumes: `admitConversion`, `bindConvGrant`, `dropConvGrant` (Task 1); `hevcGate`, `bindHevcGrant` (`hevcenc.ts`).
- Route flow (`/api/playback/info`, after the existing caps; cast the same with its own options):
  1. `hevcGate` closure = `gateHevc(...)`; if ok, `admitConversion({ kind: 'film', hevc: true, hint: grantId, … })`; refused → `bindHevcGrant(ctx, grantId, null)` and return `{ ok: false, why: 'h264_busy' }` (ruling 7).
  2. After `playbackInfo` (+ `preparePlayback`): `converts = !info.directUrl && info.delivery && info.delivery.video !== 'copy'`. Not converting → `dropConvGrant(ctx, grantId)`. Converting `hevc` → grant already written. Converting `h264` → `admitConversion({ kind: 'film', hint: grantId, label: title })`.
  3. Refused (`full` or `unknown`) → second `playbackInfo` with `{ ...opts, noConvert: true, maxBitrate: ceiling-after-upload-cap, capReason: 'serverBusy' }` (the viewer's own lower pick is dropped, the role/remote/upload ceiling stays). `delivery.video === 'copy'` or a `directUrl` → answer it with `transcodeReason: 'serverBusy'`; otherwise answer `503 { error: 'server_busy' }` (no stream was fetched, nothing to stop).
  4. `bindConvGrant(grantId, converting ? info.playSessionId : null)`; the `pbinfo:` record as today.
- Cast: the same three steps (`kind 'film'`, `deviceId` = the sender's), `503 { error: 'server_busy' }`; a queued `next` cast keeps `h264_busy` for HEVC and is admitted like any conversion.

- [ ] **Step 1: Write the failing tests** in `backend/test/playback-budget.test.ts` (fake Jellyfin PlaybackInfo with a source chosen per test; `CONVERSION_SLOTS` set through test settings):
  - `copy plays without a slot` — `L=1` with one foreign transcode; an H.264 source that fits → 200, `delivery.video 'copy'`, no `conv:grant:` key.
  - `a conversion takes a slot and binds it` — `L=2`, source above the cap → 200 `delivery.video 'h264'`, `conv:grant:<playSessionId>` `{ kind: 'film' }`.
  - `full budget falls back to copy` — `L=1` + foreign transcode; H.264 8 Mbit/s source, request `maxBitrate 4_000_000` → second PlaybackInfo has `MaxStreamingBitrate` = role ceiling (20 000 000), answer `delivery.video 'copy'`, `transcodeReason 'serverBusy'`.
  - `no copy possible → 503 server_busy` — HEVC source, browser without HEVC → 503 `{ error: 'server_busy' }`, no grant key left.
  - `role cap below the source → 503` — friend `maxBitrate 4 000 000`, 8 Mbit/s source, budget full → 503.
  - `HEVC needs both slots` — HEVC ready, `L=2` one used → `delivery.video 'hevc'`, both `hevcgrant:` and `conv:grant:` keys; `L=1` one used → no `hevcgrant:` left, falls to copy (or 503 for a non-copyable source).
  - `a quality switch of the same device is not counted` — `L=1`, the device's own converting session → second request for the same device → 200 `h264`.
  - `cast uses the same gate` — `POST /api/cast/session`, `L=1` full, non-copyable → 503 `server_busy`.
  - `slow session list falls back to copy, not a hard error` (Review Focus 3) — `transcodeSessions` hangs: copyable source → 200 `copy` + `serverBusy`; non-copyable → 503 within 2 s.
  - `direct play answers are not gated` — direct-play-eligible source → `transcodeSessions` never called.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the option, the plan flag, the route flows.
- [ ] **Step 4: Verify** → PASS; `npx -w backend vitest run test/hevc-encoder.test.ts test/cast.test.ts test/playback-resume.test.ts test/remote-cap.test.ts test/media-seam.test.ts test/plex`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(budget): playback and cast admit conversions, fall back to copy when full`

### Task 3: Download preparation waits for a conversion slot

**Implementer:** Sonnet (routine) · backend

**Files:**
- Modify: `backend/src/downloadprep.ts` (`run()`: before the `status = 'preparing'` update, for `quality !== 'original'`: `admitConversion({ kind: 'download', userId: pullUser.id, hint: 'dl:' + jobId, label })`; refused → return (stays queued, retried by `tick()`), log `download <jobId> waits for a conversion slot` once per job (the `blocked` set pattern); after the play session is known → `bindConvGrant(ctx, 'dl:' + jobId, ps)`)
- Test: `backend/test/downloadprep-budget.test.ts`

**Interfaces:**
- Consumes: `admitConversion`, `bindConvGrant` (Task 1). `countConversions` already counts preparing jobs as `download`.

- [ ] **Step 1: Write the failing tests:**
  - `a queued download waits while the budget is full and starts when it frees` — `L=2`, priority films, one film converting → job stays `queued`, one log line; film session gone → next `tick()` → `preparing`.
  - `single slot: a download runs once nothing converts` — `L=1`, nothing running → admitted; while it prepares a film request is refused by the budget (the running download is never stopped).
  - `original quality needs no slot` — `quality 'original'` → `ready`, no `conv:grant:` written.
  - `unreadable session list waits, never fails` — `transcodeSessions` hangs → job `queued`, never `failed`.
- [ ] **Step 2: Run** `npx -w backend vitest run test/downloadprep-budget.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w backend vitest run test/downloadprep.test.ts test/downloads.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(budget): download preparation waits for a conversion slot`

### Task 4: Benchmark, recommendation, automatic first measurement, admin API

**Implementer:** Opus (hard: shared claims, media-server process control) · backend

**Files:**
- Create: `backend/src/cliptime.ts` (the timed clip extracted from `probeHevcEncoder`), `backend/src/convbench.ts`, `backend/src/routes/conversions.ts`
- Modify: `backend/src/hevcenc.ts` (`probeHevcEncoder` uses `timedClip`; behaviour and codes unchanged), `backend/src/server.ts:117` (`convBenchTick` every 10 min next to `hevcTick`), `backend/src/app.ts` (register `conversionRoutes` after `updaterRoutes`)
- Test: `backend/test/convbench.test.ts`

**Interfaces:**
- Produces (`cliptime.ts`): `export async function timedClip(ctx: Ctx, user: UserRow, o: { videoCodec: 'h264' | 'hevc'; segments: number; segmentSeconds: number; checkInit?: (init: Buffer) => boolean; now?: () => number }): Promise<{ ok: true; speed: number } | { ok: false; reason: 'http' | 'not_hevc' | 'no_title' }>` — title pick, PlaybackInfo, `clipTranscode` at 1920×1080 / 6 Mbit/s, `markConvExempt`, segments in order, `stopEncoding` always.
- Produces (`convbench.ts`):
  - `export const BENCH_TTL_S = 30 * 86_400; BENCH_ATTEMPT_GAP_S = 1800;` keys `conv:bench`, `conv:bench:livetv` (written by Task 31), `conv:bench:attempt`.
  - `export async function runBenchmark(ctx: Ctx, trigger: 'admin' | 'auto' | 'enable'): Promise<{ ok: true; jellyfin: BenchRecord | null; livetv: BenchRecord | null } | { ok: false; why: 'busy' | 'running' | 'no_title' | 'failed' }>` — `claimHevcProbe` (ruling 11; held → `running`), `hevcBusyReason` non-null → `busy`, previews paused and idle, Jellyfin H.264 7 × 3 s; stores `{ speed, hwAccel, fingerprint, at }`.
  - `export async function convBenchTick(ctx: Ctx): Promise<boolean>` — runs when there is no record or it is stale, nobody watches, previews idle, and `conv:bench:attempt` (`setnx`, 30 min) is free.
  - `export async function conversionsView(ctx: Ctx): Promise<ConversionsView>` with `ConversionsView = { limit; auto; custom; priority; used: number; running: Array<{ kind: ConvKind; hevc: boolean; label: string | null; since: string | null; device: string | null }>; bench: { jellyfin: { speed: number; hwAccel: string; at: string } | null; livetv: { speed: number; encoder: string; at: string } | null; recommended: number | null; stale: boolean; noRealtime: boolean }; measure: { running: boolean; busy: 'watching' | 'unknown' | null } }` (`noRealtime` = slowest speed < 1.0; `device` = the FriendFlix device label when known, else the server's device name).
- Routes (`requireAdmin`): `GET /api/admin/conversions` → `ConversionsView` (`cache-control: no-store`); `POST /api/admin/conversions/benchmark` → 202 `{ started: true }` (runs in the background), 409 `{ error: 'busy', reason }` / 409 `{ error: 'running' }`; rate limit 6 per 10 min; audit `conversions.benchmark`. Budget values are written through the existing `PUT /api/admin/settings`.

- [ ] **Step 1: Write the failing tests** in `backend/test/convbench.test.ts`:
  - `measures 21 s of 1080p H.264 and stores the speed` — 7 segments, fake clock 4.5 s → `conv:bench` `speed 4.67`, `hwAccel 'qsv'`; `clipTranscode` got `{ videoCodec: 'h264', videoBitrate: 6_000_000, maxWidth: 1920, maxHeight: 1080, segmentLength: 3 }`; `stopEncoding` called; `conv:exempt:<ps>` written.
  - `refused while anyone watches` → `{ ok: false, why: 'busy' }`, nothing stored.
  - `one heavy measurement at a time` — HEVC probe claim held → `running`; and the HEVC probe returns `null` while a benchmark holds the claim.
  - `the admin view` — bench 4.6 → `limit 3, auto 3, recommended 3`; bench 0.8 → `recommended 1, noRealtime true`; one film session → `running[0]` `{ kind: 'film', label: 'Dunmoor' }`.
  - `the tick measures once when idle` — first tick runs; after success the next tick does nothing; a failed run is retried only after 30 min.
  - `stale fingerprint` — encoder settings changed → `bench.stale true`, `auto 2`; the tick measures again.
  - `POST benchmark` — 202 then `GET` shows `measure.running true` until done; watching → 409 `busy`; non-admin 403.
- [ ] **Step 2: Run** `npx -w backend vitest run test/convbench.test.ts` → FAIL.
- [ ] **Step 3: Implement** `cliptime.ts`, `convbench.ts`, the routes, the timer.
- [ ] **Step 4: Verify** → PASS; `npx -w backend vitest run test/hevc-encoder.test.ts test/convbudget.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(budget): benchmark, recommendation and the admin conversions API`

### Task 5: *Umwandlungen* card on Admin → *Betrieb* → *Wiedergabe-Check*

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/admin/conversions.ts`, `web/src/lib/admin/conversions.test.ts`, `web/src/lib/admin/ConversionsCard.svelte`, `web/src/lib/i18n/locales/<lang>/adminConv.ts` (seven)
- Modify: `web/src/routes/admin/playback/+page.svelte` (the *Wiedergabe-Check* page, nav `admin.tabs.playback` in group *Betrieb*; new first card, menu label unchanged), locale `index.ts` files, `e2e/mocks/admin.ts` (`GET /api/admin/conversions`, `POST …/benchmark`, settings PUT), `e2e/tests/admin-conversions.spec.ts`, `e2e/tests/admin-conversions.mobile.spec.ts`
- Test: the files above

**Interfaces:**
- Consumes: `GET /api/admin/conversions`, `POST /api/admin/conversions/benchmark` (Task 4), `PUT /api/admin/settings`.
- Produces (`conversions.ts`): `export type ConversionsView` (mirror of Task 4); `export function slotSegments(v: ConversionsView): Array<{ kind: 'film' | 'live' | 'record' | 'other' | 'free'; over: boolean }>` — `max(limit, used)` segments, filled film → live → record → other (download/reencode), then free; segments beyond `limit` have `over: true`; `export function hwLabel(hwAccel: string): string` (`qsv` "Intel QSV", `vaapi` "VA-API", `nvenc` "NVIDIA NVENC", `amf` "AMD AMF", `videotoolbox` "VideoToolbox", `none` → `adminConv.cpu`); `export function measuredLine(v: ConversionsView, now: Date): string` ("Gemessen 4,6× Echtzeit (Jellyfin, Intel QSV) · Live-TV 4,4× · empfohlen 3 · geprüft heute 03:10"); `export function priorityHint(p: ConvPriority): TKey` (`adminConv.priority.hint.films` / `.live` / `.equal`, ruling 55).
- `ConversionsCard.svelte` props `readOnly = false`, `link: string | null = null` (Task 26 reuses it read-only). Content per spec §5.6: big "2 von 3 belegt", slot bar (icon + label per segment, never colour only), running list (kind icon, label, since, device), *Neu messen* (disabled with `adminConv.busyMeasure` while `measure.busy`, spinner while running), *Gleichzeitige Umwandlungen* segmented *Automatisch (3)* / *Eigener Wert* + stepper 1–16 (PUT `{ CONVERSION_SLOTS: n | null }`), *Vorrang* segmented (PUT `{ CONVERSION_PRIORITY }`) with the hint line of the **selected** option (`priorityHint`; the line's height is reserved so switching options moves nothing); polls every 5 s while visible (`#lib/adminContent/poll`). Space for the measured line and the warning line is reserved.
- Copy: spec §20 `adminConv.*` rows (incl. the three `adminConv.priority.hint.*` texts), plus DE/EN `adminConv.kind.film` "Film/Serie" / "Film/series", `kind.live` "Live-TV" / "Live TV", `kind.record` "Aufnahme" / "Recording", `kind.other` "Andere" / "Other", `free` "frei" / "free", `over` "über dem Limit" / "over the limit", `stale` "Messung veraltet – bitte neu messen" / "Measurement out of date – please measure again", `never` "Noch nicht gemessen · bis dahin 2" / "Not measured yet · 2 until then", `measuring` "Misst … (ca. 20 s)" / "Measuring… (about 20 s)", `cpu` "Prozessor" / "processor".

- [ ] **Step 1: Write the failing tests** — unit: `slotSegments` (`limit 3`, one film + one live → `[film, live, free]`; `used 4, limit 3` → 4 segments, last `over: true`), `hwLabel('qsv')`, `measuredLine` (de and en; Jellyfin 4.6 + livetv 4.4 → "… · Live-TV 4,4× · empfohlen 3 · …"), `priorityHint` per option; e2e (German UI): `card shows usage and the running list` ("2 von 3 belegt", two rows with "Dunmoor"), `own value saves CONVERSION_SLOTS` (stepper 4 → PUT body `{ CONVERSION_SLOTS: 4 }`), `Automatisch sends null`, `priority saves and the hint follows the option` (`{ CONVERSION_PRIORITY: 'live' }`; hint "Filme & Serien lassen einen Platz für Live-TV frei (ab 2 Plätzen)."; *Gleichrangig* → "Kein Platz wird freigehalten – wer zuerst kommt, bekommt ihn."), `Neu messen is disabled with the reason while someone watches`; mobile: the card fits 375 px with no horizontal scroll.
- [ ] **Step 2: Run** `npx -w web vitest run src/lib/admin/conversions.test.ts` and the two e2e specs → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts src/lib/i18n/i18n.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): Umwandlungen card on the Wiedergabe-Check page`

### Task 6: Player server-busy states, docs, CHANGELOG

**Implementer:** Sonnet (routine) · frontend + docs

**Files:**
- Modify: `web/src/lib/Player.svelte:494-498` (`503 { error: 'server_busy' }` → error state with `player.error.serverBusy` and *Erneut versuchen*, no automatic backoff; the `castErr` / `airErr` helpers at lines 713 and 873 map it too), `web/src/lib/player/QualityChip.svelte:14` (`serverBusy: 'player.quality.reasonServerBusy'`), `web/src/lib/admin/health.ts:57` (`TC_REASONS` + `'serverBusy'`), locales `player.ts` (seven: `error.serverBusy` DE "Server gerade ausgelastet. Versuch es gleich noch einmal." EN "The server is busy right now. Try again in a moment."; `quality.reasonServerBusy` DE "Server ausgelastet" EN "Server busy"), `e2e/mocks/api.ts` (playback info answer switchable to `serverBusy` / 503), `docs/operations.md` (section *Umwandlungen*: what counts, limit, priority, benchmark), `CHANGELOG.md` *Unreleased* (release note of spec §23 for 1a, DE text quoted)
- Test: `e2e/tests/player-busy.spec.ts`

**Interfaces:**
- Consumes: `transcodeReason: 'serverBusy'`, `503 server_busy` (Task 2).

- [ ] **Step 1: Write the failing tests** — `copy fallback shows the chip reason` (answer `transcodeReason 'serverBusy'` → the quality chip's reason reads "Server ausgelastet"); `503 shows the message and retries only on request` ("Server gerade ausgelastet. Versuch es gleich noch einmal." + *Erneut versuchen*; no second info request within 5 s; click → second request).
- [ ] **Step 2: Run** the spec → FAIL.
- [ ] **Step 3: Implement**, write the docs section and the CHANGELOG line.
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/health.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(player): server-busy states for the conversion budget`

**PR 1a boundary:** open the PR after Task 6 (`feat: shared conversion budget`). Released alone.

---

## PR 1b — The `livetv` container (Tasks 7–11)

### Task 7: `livetv/` workspace, signed internal API, `/v1/system`, backend client

**Implementer:** Opus (hard: request signing, a new service) · livetv + backend

**Files:**
- Create: `livetv/package.json` (`@friendflix/livetv`, scripts like `updater/package.json`), `livetv/tsconfig.json`, `livetv/tsconfig.test.json`, `livetv/vitest.config.ts` (thresholds 90/80), `livetv/Dockerfile`, `livetv/src/{server.ts,config.ts,protocol.ts,system.ts,log.ts}`, `livetv/test/{protocol.test.ts,server.test.ts,system.test.ts}`, `backend/src/livetv/client.ts`, `test-vectors/livetv-hmac.json`
- Modify: root `package.json` (`workspaces` + `"livetv"`), `package-lock.json` (`npm install`), the `COPY <ws>/package.json` blocks of `backend/Dockerfile`, `gateway/Dockerfile`, `web/Dockerfile`, `updater/Dockerfile` (+ `livetv/package.json`), `.github/workflows/publish.yml:30` (matrix + `livetv`), `.github/workflows/ci.yml:79,83` (coverage loop + summary + artifact list + `livetv`), `backend/src/config.ts` (`LIVETV_URL`, same regex as `UPDATER_URL`, default `http://livetv:8090`), `backend/src/settings/registry.ts:184` (`ENV_ONLY_KEYS` + `'LIVETV_URL'`)
- Test: `livetv/test/*.test.ts`, `backend/test/livetv-client.test.ts`

**Interfaces:**
- Produces (`livetv/src/protocol.ts`): a copy of `updater/src/protocol.ts` with `KEY_LABEL = 'friendflix-livetv/v1'`, `HEADER_TS = 'x-ff-livetv-ts'`, `HEADER_NONCE = 'x-ff-livetv-nonce'`, `HEADER_SIG = 'x-ff-livetv-signature'`, `WINDOW_MS = 60_000` (ruling 17).
- Produces (`livetv/src/server.ts`): `export function createApp(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void>` with a route table (later tasks add routes); `GET /healthz` unsigned → `{ ok: true, api: 1, version: string | null, bootId: string /* 16 hex, random per process */ }`; every `/v1/*` signed, JSON only, body ≤ 64 KB (413), unknown → 404; `/s/*` unsigned (404 until Task 27). Listens on `PORT` (8090).
- Produces (`livetv/src/system.ts`): `export function parseSrtPorts(raw: string | undefined): number[]` (`A-B` or one port, 1–100 ports, default `9000-9009`; invalid → throws at start); `export function cpuInfo(): { model: string; cores: number; loadPct: number }`; `export function gpuInfo(fs: FsLike): { devices: string[]; driver: string | null; readable: boolean; busyPct: number | null }` (`/dev/dri/renderD*`; driver = basename of `/sys/class/drm/renderD128/device/driver`, or `nvidia` from `/proc/driver/nvidia/version`; readable = R+W access; `gpu_busy_percent` of AMD else null); `export async function encoders(run: Run): Promise<Encoder[]>` (parse `ffmpeg -hide_banner -encoders` once; `Encoder = 'h264_qsv' | 'h264_vaapi' | 'h264_nvenc' | 'libx264'`); `GET /v1/system` → spec §3.2 shape + `srt: { ports }`, `recordings: null`.
- Produces (`livetv/src/config.ts`): `INTERNAL_SECRET` from env, `INTERNAL_SECRET_FILE` or `/run/friendflix-gateway/internal_secret` (the `gateway/src/env.ts` rule), `LIVETV_CACHE_MAX_GB` (default 6), `LIVETV_SRT_PORTS`, `APP_VERSION`.
- Produces (`backend/src/livetv/client.ts`): `export function livetvKey(secret: string): Buffer; export function signLivetv(key: Buffer, method: string, path: string, body?: string, ts?: string, nonce?: string): Record<string, string>; export class LivetvError extends Error { constructor(readonly status: number | null, readonly code: string) }; export async function livetvCall<T>(ctx: Ctx, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, o?: { timeoutMs?: number }): Promise<T>` (default 10 s; error code from `{ error }` only when it matches `^[a-z_]{1,40}$`, else `livetv_error`; network/timeout → `LivetvError(null, 'unreachable')`); `export async function livetvStream(ctx: Ctx, path: string, body: unknown, o: { timeoutMs: number }): Promise<Response>`; `export async function livetvHealth(ctx: Ctx): Promise<{ api: number; version: string | null; bootId: string } | null>` (unsigned, 3 s).
- `livetv/Dockerfile`: build stage on the pinned `node:26-bookworm-slim` (`npm ci`, `npm run build -w livetv`); runtime `debian:bookworm-slim` (pinned digest) + jellyfin-ffmpeg 7 from the Jellyfin apt repository (key verified) + `/usr/local/bin/node` from the build stage; user and group `10001`; `HEALTHCHECK` via `node -e` fetch of `/healthz`; `EXPOSE 8090`; `CMD ["node", "livetv/dist/server.js"]`; build args `GIT_SHA BUILD_TIME APP_VERSION APP_CODENAME` like the others.
- `test-vectors/livetv-hmac.json`: three cases (`GET /v1/system`, `POST /v1/streams` with a fictional body, `PUT /v1/ingest` with a fictional body), signatures computed once with the derivation above and checked by both test files.

- [ ] **Step 1: Write the failing tests:**
  - `livetv/test/protocol.test.ts` — every vector signs to its `signature`; verify refuses a 61 s old request (`expired`), a reused nonce (`replay`), a wrong signature, a request signed before start.
  - `livetv/test/server.test.ts` — `/healthz` shape with a 16-hex `bootId` and `api: 1`; unsigned `/v1/system` → 401; signed → 200 with `cpu`, `gpu`, `encoders`, `cache`, `srt.ports`; 70 KB body → 413; unknown path → 404.
  - `livetv/test/system.test.ts` — `parseSrtPorts('9000-9009')` 10 ports, `'9005'` → `[9005]`, `'9000-9200'` throws, `'abc'` throws; `gpuInfo` fake fs: i915 → `{ devices: ['/dev/dri/renderD128'], driver: 'i915', readable: true, busyPct: null }`, amdgpu with `gpu_busy_percent` 37 → 37, unreadable node → `readable false`; `encoders` of a fixture listing → `['h264_qsv','h264_vaapi','libx264']`.
  - `backend/test/livetv-client.test.ts` — `signLivetv` equals the vectors; 409 `{ error: 'srt_ports_full' }` → `LivetvError(409, 'srt_ports_full')`; `{ error: 'http://iptv.example.com/x' }` → code `livetv_error`; timeout → `LivetvError(null, 'unreachable')`.
- [ ] **Step 2: Run** `npx -w livetv vitest run` and `npx -w backend vitest run test/livetv-client.test.ts` → FAIL.
- [ ] **Step 3: Implement** the workspace, the client, the vectors, the CI/publish lines.
- [ ] **Step 4: Verify** → PASS; root `npm run typecheck`; `docker build -f livetv/Dockerfile .` only if Docker is available (else CI).
- [ ] **Step 5: Commit** `feat(livetv): livetv service skeleton with a signed internal API`

### Task 8: Compose profile, networks, GPU overlays, CI checks, setup docs

**Implementer:** Sonnet (routine) · ops

**Files:**
- Modify: `compose.prod.yaml` and `compose.yaml` (service `livetv` exactly as spec §3.1; networks `livetv: { internal: true }` and `livetv-egress: {}`, defined always; backend and gateway `networks` + `livetv`; backend and gateway environment `LIVETV_URL: ${LIVETV_URL:-http://livetv:8090}`; volumes `livetv-cache`, `recordings`), `.github/workflows/ci.yml:263-300` (compose checks: `--profile livetv config -q`, `-f compose.livetv-gpu.yaml` with `RENDER_GID=109`, `-f compose.livetv-nvidia.yaml`; `config --services` without the profile does not list `livetv`), `backend/test/compose-env.test.ts`, `docs/setup.md` + `docs/de/setup.md` (profile, overlays, `RENDER_GID` command, UDP ports), `docs/security.md` (the `livetv` container: no socket, read-only, networks, published UDP only)
- Create: `compose.livetv-gpu.yaml`, `compose.livetv-nvidia.yaml` (spec §3.1 values, SPDX + one comment line each), `docs/livetv.md`, `docs/de/livetv.md` (sections *Einschalten* / *Turning it on*, *GPU*, *Ports*; later tasks add the rest)
- Test: `backend/test/compose-env.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `LIVETV_URL` in `ENV_ONLY_KEYS` (Task 7).

- [ ] **Step 1: Write the failing tests** (`describe.each(['compose.prod.yaml', 'compose.yaml'])`):
  - `livetv runs only with its profile` — `profiles: [livetv]`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges`, no volume mentions `docker.sock`, every `ports` entry ends in `/udp`, `networks: [livetv, livetv-egress]`; network `livetv` is `internal: true`.
  - `backend and gateway reach livetv, web does not` — their networks include `livetv` and their env has `LIVETV_URL`; `web` has neither.
  - `GPU overlays` — `compose.livetv-gpu.yaml` maps `/dev/dri:/dev/dri` and `group_add` `${RENDER_GID:?…}`; `compose.livetv-nvidia.yaml` reserves `driver: nvidia, count: 1, capabilities: [gpu, video]`.
  - the existing `only docker-proxy has the socket` and `passes every env-only key` stay green.
- [ ] **Step 2: Run** `npx -w backend vitest run test/compose-env.test.ts` → FAIL.
- [ ] **Step 3: Implement** compose, overlays, CI lines, docs.
- [ ] **Step 4: Verify** → PASS; `docker compose -f compose.prod.yaml --profile livetv config -q` if Docker is available; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): compose profile, networks and GPU overlays`

### Task 9: Updater `POST /v1/livetv` — enable, disable, remove

**Implementer:** Opus (hard: process control on the Docker host) · updater + backend

**Files:**
- Modify: `updater/src/policy.ts` (`LIVETV_SERVICE = 'livetv'`, `IMAGE_OF.livetv = 'livetv'`, `export type LivetvOp`, `export function parseLivetvBody(raw: unknown): LivetvOp | null`, `export function ffServices(livetv: boolean): readonly string[]`, `export function healthServices(livetv: boolean): readonly string[]`), `updater/src/state.ts` (`State.livetv: 'enabled' | 'disabled' | 'absent'` default `'absent'`; `JobAction` + `'livetv-enable' | 'livetv-disable' | 'livetv-remove'`; `sanitize`/`sanitizeJob`), `updater/src/docker.ts` (compose `--profile livetv` while enabled; `stop(services)`, `rm(services)` (`rm -f`), `imageRm(image)`, `volumeRm(name)` with name `<project>_livetv-cache` from the backend container's `com.docker.compose.project` label; `psRows` includes `livetv`), `updater/src/job.ts` (`Ops` gains `stop`, `rm`, `imageRm`, `volumeRm`, `livetvContainer`; `startLivetv(op)`; update/rollback include `livetv` while enabled), `updater/src/server.ts` (route `POST /v1/livetv`; `status()` gains `livetv: { state, container: 'running' | 'exited' | null }`), `backend/src/updater.ts` (`UpdaterAction` + `'livetv'` for audit; `parseJob` accepts the three new actions; `UpdaterStatus.livetv`; `export async function startLivetvJob(ctx: Ctx, op: LivetvOp, actor: string): Promise<StartResult>`)
- Test: `updater/test/livetv.test.ts`, `backend/test/updater-livetv.test.ts`

**Interfaces:**
- `export type LivetvOp = { op: 'enable' } | { op: 'disable' } | { op: 'remove'; data: boolean }` (same in backend).
- enable: `refreshFiles` (foreign → `foreign_stack`), tag = `state.current ?? channelTag(...)`, `images(tag, ['livetv'])` → `pull` → cosign `verify` → `up -d --no-deps --pull never livetv` (profile added) → health: `livetv` running and healthy within 2 min → `state.livetv = 'enabled'`. Any failure leaves `state.livetv` unchanged; codes `pull_failed`, `verify_failed`, `restart_failed`, `health_timeout`.
- disable: `stop livetv`, `rm -f livetv` → `'disabled'`. remove: disable + `image rm` of the image the container ran and of `expectedImage(repo, 'livetv', tag)`; `data: true` also `volume rm <project>_livetv-cache`. The recordings volume is never named in any command.
- Backend `startLivetvJob`: refuses a foreign stack up front (`409 foreign_stack`), posts the signed body exactly `JSON.stringify(op)`, parses the job, audits `system.updater_start` with `{ action: 'livetv-<op>' }` like `startJob`.

- [ ] **Step 1: Write the failing tests:**
  - updater: `parseLivetvBody accepts exactly three shapes` (refuses `{ op: 'enable', x: 1 }`, `{ op: 'remove' }`, `{ op: 'remove', data: 'yes' }`, arrays); `enable pulls, verifies and starts livetv with the profile` (recorded commands: `… --profile updater --profile livetv … pull --quiet livetv`, `cosign verify …friendflix-livetv@sha256:…`, `up -d --no-deps --pull never livetv`; state `enabled`; steps ok); `a verify failure starts nothing`; `disable stops and removes the container`; `remove with data deletes the image and the cache volume, never recordings` (no command contains `recordings`); `updates include livetv only while enabled`; `foreign stack refused`; `status reports livetv`; `state file sanitises livetv` (`'bogus'` → `'absent'`).
  - backend: `startLivetvJob signs exactly the op` (`{"op":"remove","data":true}`); `foreign stack → 409 foreign_stack`; `the job is parsed and audited`.
- [ ] **Step 2: Run** `npx -w updater vitest run test/livetv.test.ts` and `npx -w backend vitest run test/updater-livetv.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w updater vitest run test/job.test.ts test/docker.test.ts test/server.test.ts test/policy.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(updater): enable, disable and remove the livetv service`

### Task 10: Detection, admin state, enable/disable routes, GPU advice

**Implementer:** Sonnet (routine) · backend

**Files:**
- Create: `backend/src/livetv/detect.ts`, `backend/src/livetv/gpu.ts`, `backend/src/livetv/adminRoutes.ts`
- Modify: `backend/src/config.ts` + `backend/src/settings/registry.ts` (`LIVETV_OFFER_HIDDEN` bool, group `general`, default false; `LIVETV_WANTED` bool, group `general`, `visible: false`, default false), `backend/src/perms.ts` (`featureFlags(ctx).livetv = livetvInstalled(ctx)`, ruling 13), `backend/src/server.ts` (`livetvDetectTick` every 60 s), `backend/src/app.ts` (register `livetvAdminRoutes`), `backend/src/routes/admin.ts` (`/api/admin/summary` gains `livetv: { installed: boolean; offerHidden: boolean; failedSources: number }`, `failedSources` 0 until Task 16)
- Test: `backend/test/livetv-detect.test.ts`

**Interfaces:**
- Produces (`detect.ts`): `export interface LivetvState { reachable: boolean; installed: boolean; version: string | null; bootId: string | null; checkedAt: number }`; `export function livetvInstalled(ctx: Ctx): boolean` (sync, last known); `export async function detectLivetv(ctx: Ctx, maxAgeMs = 10_000): Promise<LivetvState>` (single flight; `installed = reachable && api === 1`); `export async function livetvDetectTick(ctx: Ctx): Promise<void>` — on the transition not-installed → installed while `LIVETV_WANTED`, fires `runBenchmark(ctx, 'enable')` (spec §5.3).
- Produces (`gpu.ts`): `export type GpuAdvice = { level: 'warn' | 'info' | 'ok'; key: 'needsOverlay' | 'needsRenderGid' | 'needsNvidia' | 'cpuOnly' | 'both'; driver?: string }`; `export function gpuAdvice(jfHwAccel: string | null, sys: { gpu: { devices: string[]; readable: boolean; driver: string | null }; encoders: string[] }): GpuAdvice` — spec §4.4 rows in order: `qsv`/`vaapi` and no devices → `needsOverlay` warn; devices but not readable → `needsRenderGid` warn; `nvenc` without `h264_nvenc` → `needsNvidia` warn; `none`/null → `cpuOnly` info; else `both` ok with `driver`.
- Routes (`requireAdmin`):
  - `GET /api/admin/livetv/state` → `{ installed, reachable, version, wanted, offerHidden, updater: { available: boolean; stack: 'own' | 'foreign' | null; job: UpdaterJob | null; livetv: { state, container } | null }, envLine: 'COMPOSE_PROFILES=livetv', gpu: { jellyfin: string | null; livetv: { driver: string | null; devices: number } | null; advice: GpuAdvice | null } }`, `no-store`.
  - `POST /api/admin/livetv/enable` → stores `LIVETV_WANTED = true`; updater present and own → `startLivetvJob({ op: 'enable' })` → 202 `{ job }`; else 409 `{ error: 'no_updater' | 'foreign_stack', envLine }`.
  - `POST /api/admin/livetv/disable` `{ removeImage: boolean, removeCache: boolean }` → `LIVETV_WANTED = false`; `{ op: 'disable' }` or `{ op: 'remove', data: removeCache }`; `{ removeImage: false, removeCache: true }` → 400 (ruling 34). Without an updater: 409 `no_updater` with `envLine` (the page shows the manual command).
  - Rate limit 3 per 2 min (like the updater routes); audit `livetv.enable` / `livetv.disable` `{ removeImage, removeCache }`.

- [ ] **Step 1: Write the failing tests:** `installed needs a reachable livetv with api 1` (fake healthz → true; `api: 2` → false; unreachable → `reachable false`); `wanted but not reachable` (`LIVETV_WANTED` + unreachable → `{ installed: false, wanted: true }`); `enable through the updater` (202, signed body `{"op":"enable"}`, `LIVETV_WANTED` stored, audit); `no updater → 409 no_updater with envLine`; `foreign stack → 409 foreign_stack`; `disable maps the checkboxes` (three bodies); `gpuAdvice follows the five rows`; `featureFlags.livetv follows detection`; `first detection after enabling starts the benchmark once`; `non-admin 403`.
- [ ] **Step 2: Run** `npx -w backend vitest run test/livetv-detect.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w backend vitest run test/admin-summary.test.ts test/rights.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): detection, admin state and enable/disable through the updater`

### Task 11: Web — the optional entry and the enable/disable flow

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/routes/admin/livetv/+page.svelte`, `web/src/lib/admin/livetv/EnableCard.svelte`, `web/src/lib/admin/livetv/MiniStatus.svelte` (installed view until Task 26: version, GPU advice, *Live-TV ausschalten…*), `web/src/lib/admin/livetv/OffDialog.svelte`, `web/src/lib/admin/livetv/state.ts`, `web/src/lib/admin/livetv/state.test.ts`, `web/src/lib/admin/JobSteps.svelte` (the step list extracted from `UpdaterCard.svelte`, no behaviour change), `web/src/lib/i18n/locales/<lang>/adminLive.ts` (seven)
- Modify: `web/src/lib/admin/nav.ts` (`NavItem.chip?: TKey`; content group gains `{ href: '/admin/livetv', label: 'admin.tabs.livetv', icon: 'tv', chip: 'adminLive.optional', badge: 'livetv' }`, shown when `summary.livetv.installed || !summary.livetv.offerHidden`; chip only while not installed; `BadgeKey` + `'livetv'` red with `failedSources`), `web/src/lib/admin/AdminShell.svelte` (chip rendering), `web/src/lib/admin/UpdaterCard.svelte` (uses `JobSteps`), `web/src/lib/admin/summary.ts` (type), locales `admin.ts` (`tabs.livetv`), settings label key for `LIVETV_OFFER_HIDDEN` (DE "Optionales Modul Live-TV anbieten", EN "Offer the optional Live TV module"), `e2e/mocks/admin.ts` (livetv state, enable/disable, summary), `e2e/mocks/updater.ts` (livetv job), `e2e/tests/admin-livetv-enable.spec.ts`, `e2e/tests/admin-livetv-enable.mobile.spec.ts`
- Test: the files above

**Interfaces:**
- Consumes: Task 10 routes, `PUT /api/admin/settings`.
- Produces (`state.ts`): `export interface LivetvAdminState` (the Task 10 `GET /state` answer); `export type EnableMode = 'updater' | 'env' | 'portainer'; export function enableMode(s: LivetvAdminState): EnableMode` (`updater.available && stack === 'own'` → updater; `stack === 'foreign'` → portainer; else env); `export function navShown(s: AdminSummary | null): boolean`; `export function jobRunning(s): boolean`.
- Page behaviour (spec §4.3, §4.5): not installed → only `EnableCard` (3 lines what, the needs line, *Live-TV aktivieren* or the `.env` lines with a copy button, the Portainer line, the persist tip, *Nicht mehr anzeigen* → PUT `{ LIVETV_OFFER_HIDDEN: true }` and back to `/admin`); a running job shows `JobSteps` and polls `GET /state` every 3 s; installed → the area (in 1b `MiniStatus`) without reload; wanted but not reachable → `adminLive.offer.wantedDown` + *Wieder starten* (enable again). Off dialog: two checkboxes, cache disabled until *Image entfernen* is checked, "Aufnahmen bleiben erhalten." line.
- Copy: spec §20 `admin.tabs.livetv`, `adminLive.optional`, `adminLive.offer.*`, `adminLive.off.*`, `adminLive.gpu.*` (the five §4.4 lines; DE verbatim, EN translated).

- [ ] **Step 1: Write the failing tests** — unit `enableMode` three cases, `navShown`; e2e (German UI): `enable via the updater shows the job steps, then the area` (mock flips `installed` after two polls, no reload); `no updater shows the .env line and copies it` (clipboard text `COMPOSE_PROFILES=livetv`, toast "Kopiert"); `a foreign stack shows the Portainer line`; `Nicht mehr anzeigen hides the entry; the settings switch brings it back`; `wanted but down shows Wieder starten`; `disable dialog sends removeImage and removeCache; the cache box is disabled until the image box is checked`; mobile: the card and the admin chip row fit at 375 px.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts src/lib/admin/updater.test.ts`; `E2E_PORT=4321 … npx playwright test tests/admin-updater.spec.ts --trace off` (UpdaterCard unchanged); root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): optional Live-TV entry and the enable/disable flow`

**PR 1b boundary:** open the PR after Task 11 (`feat(livetv): optional livetv container`).

---

## PR 1c — Sources, channels, groups and rights (Tasks 12–26)

### Task 12: Migration 48, the `livetv` settings group, effective channel values

**Implementer:** Opus (hard: migration) · backend

**Files:**
- Modify: `backend/src/db.ts` (append migration 48 = spec §6.1 SQL verbatim, comment `// 48: Live TV core (sources with import options, groups with release, rights, channels, logos, EPG, favourites, recent channels; devices.start_live)`; the spec SQL as updated 2026-11-12: `skip_groups`, `numbering`, `logo_pref`, `epg_shift_min` on sources, `released` on groups, `import_epg_shift_min`, `epg_shift_override_min`, `epg_logo_hash` on channels, `livetv_recent` instead of `livetv_last`), `backend/src/config.ts` + `backend/src/settings/registry.ts` (`SettingGroup` + `'livetv'`; `LIVETV_ENCODER` enum `auto|qsv|vaapi|nvenc|software` default `auto`; `LIVETV_SRT_HOST` string, unset = derived), `backend/src/routes/adminSettings.ts:116` (group `livetv` listed only while `livetvInstalled(ctx)`, ruling 25), `web/src/lib/admin/settings/api.ts:12` (`SettingGroup` union) + settings locale labels (`LIVETV_ENCODER` DE "Encoder für Live-TV" EN "Live TV encoder"; `LIVETV_SRT_HOST` DE "Adresse für gesendete Streams" EN "Address for pushed streams")
- Create: `backend/src/livetv/channels.ts`
- Test: `backend/test/livetv-migration.test.ts`

**Interfaces:**
- Produces (`channels.ts`): `export interface ChannelRow` (the table's columns, snake_case); `export interface ProbeRec { at: string; ok: boolean; video?: { codec: string; width: number; height: number; fps: number }; audio?: { codec: string; channels: number }; needs: 'passthrough' | 'remux' | 'transcode' | null; error?: string }` (the `probe` jsonb); `export interface EffectiveChannel { id: string; sourceId: string; number: number | null; name: string; groupId: string | null; logoHash: string | null; hidden: boolean; missing: boolean; streamKind: 'hls' | 'ts' | 'srt'; ingest: 'pull' | 'push'; epg: { sourceId: string; channelId: string } | null; epgShiftMin: number; epgShiftFrom: 'channel' | 'list' | 'source' | 'none'; probe: ProbeRec | null }`; `export const CHANNEL_SELECT: string` — select list over `livetv_channels c join livetv_sources s on s.id = c.source_id` computing `coalesce(c.name_override, c.import_name) as name`, `coalesce(c.number_override, c.import_number) as number`, `coalesce(c.group_override, (select m.group_id from livetv_group_map m where m.source_id = c.source_id and m.provider_group = c.import_group)) as group_id`, `coalesce(c.logo_override_hash, case when s.logo_pref = 'xmltv' then coalesce(c.epg_logo_hash, c.import_logo_hash) else coalesce(c.import_logo_hash, c.epg_logo_hash) end) as logo_hash`, `coalesce(c.epg_shift_override_min, c.import_epg_shift_min, s.epg_shift_min) as epg_shift_min` and its origin (`s.epg_shift_min = 0` with no channel value → `none`); `export function toEffective(r): EffectiveChannel`; `export function srtHost(ctx: Ctx): string` (`LIVETV_SRT_HOST ?? new URL(PUBLIC_URL).hostname`). Ruling: derived values live here, not in a SQL view, so they evolve without a migration.

- [ ] **Step 1: Verify the base:** `grep -n "^  // 47:" backend/src/db.ts` finds Phase 0's migration (else stop and rebase, never add a placeholder); the test asserts `MIGRATIONS.length === 48`.
- [ ] **Step 2: Write the failing tests** in `backend/test/livetv-migration.test.ts` (rewind pattern of `block23-migration.test.ts`: delete `schema_migrations` ≥ 48, drop the new objects, `migrate()` again):
  - `all tables and the devices column exist` — eleven `livetv_*` tables (`livetv_recent`, no `livetv_last`), `devices.start_live` default false; a new source has `skip_groups '{}'`, `numbering 'chno'`, `logo_pref 'm3u'`, `epg_shift_min 0`; a new group `released true`.
  - `checks hold` — `epg_shift_min 900` and `epg_shift_override_min -800` → violations; `numbering 'x'`, `logo_pref 'svg'` → violations; m3u source without `url_enc` → check violation; push channel without passphrase → violation; push with `stream_kind 'hls'` → violation; duplicate `push_port` → unique violation; 600 KB logo → violation; `livetv_group_roles` with an unknown role → FK violation.
  - `cascades` — deleting a source deletes its channels, maps and EPG channels; deleting a profile deletes favourites and `livetv_recent`; deleting a channel deletes its `livetv_recent` rows.
  - `effective values` — `import_number 7` → 7, `number_override 12` → 12; group via `livetv_group_map`; `group_override` wins; `name_override` wins; logo: `logo_pref 'm3u'` → import logo, else the EPG logo, `'xmltv'` → the EPG logo first, an override always wins; EPG offset: override 30 > import −90 > source 60, each falling through when null (`epgShiftFrom` `channel` / `list` / `source` / `none`).
  - `settings group livetv only while installed` — settings view omits group `livetv` before detection, lists it after.
  - `migration 48 runs twice after a rewind` without error.
- [ ] **Step 3: Run** `npx -w backend vitest run test/livetv-migration.test.ts` → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Verify** → PASS; `npx -w backend vitest run test/roles-migration.test.ts test/admin-settings.test.ts`; root `npm run typecheck`.
- [ ] **Step 6: Commit** `feat(livetv): migration 48 and the livetv settings group`

### Task 13: `livetv` address guard and guarded fetch

**Implementer:** Opus (hard: SSRF) · livetv

**Files:**
- Create: `livetv/src/netguard.ts`, `livetv/src/fetch.ts`
- Test: `livetv/test/netguard.test.ts`, `livetv/test/fetch.test.ts`

**Interfaces:**
- Produces (`netguard.ts`): `export type Cidr = { addr: string; bits: number }`; `export function classifyAddress(ip: string, own: readonly Cidr[]): 'public' | 'private' | 'refused'` — refused: `127.0.0.0/8`, `::1`, `0.0.0.0/8`, `::`, `169.254.0.0/16`, `fe80::/10`, `224.0.0.0/4`, `ff00::/8`, `100.64.0.0/10`, `255.255.255.255`, the container's own subnets; private: `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`; IPv4-mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::/96`) classified by the embedded IPv4; `export function checkUrl(raw: string, schemes: ReadonlyArray<'http:' | 'https:' | 'srt:'>): { url: URL } | { error: 'scheme' | 'host' | 'invalid' }` (single-label host → `host`); `export async function resolveChecked(host: string, allowLan: boolean, deps: { lookup(h: string): Promise<string[]>; own: Cidr[] }): Promise<string>` (every address must pass; refused → `FetchError('address_refused')`); `export function ownSubnets(): Cidr[]` (from `os.networkInterfaces()`); `export function ipLiteralUrl(url: URL, ip: string): string` (IPv6 bracketed).
- Produces (`fetch.ts`): `export class FetchError extends Error { constructor(readonly code: 'unreachable' | 'denied' | 'timeout' | 'too_big' | 'address_refused' | 'scheme' | 'redirects' | 'not_found' | 'http_error') }` (message = code only, never the URL); `export async function guardedFetch(raw: string, o: { allowLan: boolean; userAgent?: string; timeoutMs: number; connectTimeoutMs?: number; maxBytes: number }, deps: GuardDeps): Promise<{ status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> }>` — `node:http`/`node:https` with `lookup` returning the checked address (no second DNS answer is used), redirects manual (max 3, each URL re-checked, scheme change refused), connect timeout 10 s, 401/403 → `denied`, 404 → `not_found`, other ≥ 400 → `http_error`, byte cap enforced while streaming. `GuardDeps = { lookup; own; dial?(ip: string, port: number): string }` (`dial` is a test hook that maps the checked address to a local test server).

- [ ] **Step 1: Write the failing tests:**
  - `refused ranges` — a table of 20 addresses (each refused range, IPv4-mapped `::ffff:127.0.0.1`, NAT64 `64:ff9b::a9fe:a9fe`) → `refused`; `::ffff:192.168.1.5` → `private`; `192.0.2.10` → `public`.
  - `LAN switch` — `192.168.1.5` without `allowLan` → `address_refused`, with → ok; `127.0.0.1` refused either way.
  - `single-label hosts` — `http://backend/x`, `http://postgres/` → `host`.
  - `rebinding cannot switch the address` — fake resolver answers `192.0.2.10` then `10.0.0.5`; the test server sees exactly one connection, to the first answer.
  - `redirect re-checks` — 302 to `http://127.0.0.1/` → `address_refused`; https → `srt://` → `scheme`; four redirects → `redirects`.
  - `byte cap` — 1 MB body with `maxBytes 512_000` → `too_big`.
  - `credentials never in errors` — `https://anna:geheim@iptv.example.com/x` failing → `String(err)` contains neither `geheim` nor `iptv.example.com`.
- [ ] **Step 2: Run** `npx -w livetv vitest run test/netguard.test.ts test/fetch.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): address guard and the guarded fetch`

### Task 14: M3U, XMLTV and logo fetch routes; stream probe

**Implementer:** Opus (hard: hostile files, child processes) · livetv

**Files:**
- Create: `livetv/src/m3u.ts`, `livetv/src/xmltv.ts`, `livetv/src/logo.ts`, `livetv/src/probe.ts`, `livetv/src/run.ts` (process runner), `livetv/src/routes/fetch.ts` (registered in `server.ts`), fixtures `livetv/test/fixtures/{provider.m3u,provider-crlf-bom.m3u,xtream.m3u,guide.xml,guide.xml.gz,doctype.xml,entity.xml,ffprobe-h264-aac.json,ffprobe-hevc.json,ffprobe-h264-mp2.json}`
- Test: `livetv/test/{m3u.test.ts,xmltv.test.ts,logo.test.ts,probe.test.ts,fetch-routes.test.ts}`

**Interfaces:**
- Produces (`run.ts`): `export type Run = (cmd: 'ffmpeg' | 'ffprobe', args: string[], o: { stdin?: AsyncIterable<Uint8Array>; timeoutMs: number; onStdout?(chunk: Buffer): void }) => Promise<{ code: number; stdout: Buffer; stderr: string }>` (no shell; stderr through `scrubLine` from Task 28 once it exists — here kept, never logged).
- Produces (`m3u.ts`): `export interface M3uEntry { key: string; name: string; tvgId?: string; tvgName?: string; chno?: number; group?: string; logo?: string; shiftMin?: number; pos: number /* 0-based among all live entries */; url: string; kind: 'hls' | 'ts' | 'srt'; userAgent?: string }`; `export function parseShift(raw: string | undefined): number | undefined` (`tvg-shift` hours, decimals allowed, → whole minutes; outside −12…+14 h or not a number → undefined; ruling 42); `export function normName(s: string): string` (lowercase, NFKD without marks, non-alphanumerics dropped, trailing `hd|fhd|uhd|4k` dropped); `export function entryKey(e: { tvgId?: string; name: string; url: string }): string` (ruling 18); `export async function parseM3u(lines: AsyncIterable<string>, o: { max: number; skipGroups?: ReadonlySet<string> }): Promise<{ entries: M3uEntry[]; groups: Array<{ name: string; channels: number }>; listed: number; skipped: { vod: number; invalid: number; overLimit: number; groups: number } }>` — `#EXTM3U` required (else `not_m3u`), its `tvg-shift` attribute is the default `shiftMin` of every entry (an entry's own `tvg-shift` wins), `groups` (list order) and `listed` count every live entry; entries of `skipGroups` are dropped before the `max` cap (ruling 40); `pos` counts skipped ones too (ruling 41); BOM and CRLF, quoted and unquoted `tvg-id tvg-name tvg-logo tvg-chno group-title`, `#EXTGRP`, `#EXTVLCOPT:http-user-agent=`, a line > 8 KB skips its entry (`invalid`), VOD filter of spec §3.4, kind `.m3u8` → hls, `srt:` → srt, else ts; duplicate keys get `:2`, `:3`.
- Produces (`xmltv.ts`): `export type XmlItem = { t: 'channel'; id: string; names: string[]; icon?: string /* first <icon src>, http(s) only */ } | { t: 'prog'; ch: string; start: number; end: number; title: string; subtitle?: string; desc?: string; cats?: string[]; episode?: string; seriesId?: string; isNew?: boolean; prevShown?: boolean; rating?: string }`; `export async function* parseXmltv(bytes: AsyncIterable<Uint8Array>, o: { from: number; to: number; channels?: Set<string>; maxProgrammes: number }): AsyncGenerator<XmlItem>` — gzip by magic bytes, ≤ 1 GB decompressed and a 20:1 ratio guard (`ratio`), DOCTYPE/ENTITY refused (`doctype`), only the five predefined and numeric entities (`invalid`), `YYYYMMDDHHmmss ±HHMM` → epoch ms, programmes outside `[from, to]` and invalid times skipped, cuts title 200 / sub-title 200 / description 2 000, episode = `onscreen` text else `xmltv_ns` as `S<s+1>E<e+1>`, series id = `dd_progid` series part or `<series-id>`, stops after `maxProgrammes`.
- Produces (`logo.ts`): `export function sniffImage(b: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null` (magic bytes only; SVG → null).
- Produces (`probe.ts`): `export type StreamInput = { url: string; kind: 'hls' | 'ts' | 'srt'; userAgent?: string; allowLan: boolean } | { push: string }`; `export interface ProbeResult { ok: boolean; video?: { codec: string; width: number; height: number; fps: number }; audio?: { codec: string; channels: number }; needs: 'passthrough' | 'remux' | 'transcode'; error?: 'unreachable' | 'timeout' | 'denied' | 'no_video' | 'invalid' | 'address_refused' }`; `export function pickVariant(master: string, maxBitrate: number): { uri: string; bandwidth: number; codecs: string | null } | null` (highest bandwidth ≤ max, H.264 preferred; Task 27 reuses it); `export async function probe(input: StreamInput, deps: { run: Run; guard: GuardDeps }): Promise<ProbeResult>` — 10 s budget; HLS: master (≤ 2 MB) → variant → first media segment (≤ 50 MB) → `ffprobe -v error -show_streams -of json -i pipe:0`; TS: the first 4 MB or 10 s piped; SRT: `-protocol_whitelist srt,udp -i <ipLiteralUrl>`; `{ push }` → `error: 'invalid'` until Task 29. `needs`: hls with H.264 → passthrough; ts/srt with H.264 → remux (any audio; audio-only conversion is not counted); other video → transcode.
- Routes (signed): `POST /v1/fetch/m3u` `{ url, userAgent?, allowLan, skipGroups?: string[] /* ≤ 2 000 */ }` → `{ entries, groups, listed, skipped }` (spec §3.2; ≤ 50 MB, 60 s, ≤ 20 000 entries after skipping); `POST /v1/fetch/xmltv` `{ url, userAgent?, allowLan, channels?, from, to }` → `application/x-ndjson`, one item per line, a failure ends with `{ "t": "error", "code": … }` (≤ 300 MB transferred, 10 min); `POST /v1/fetch/logo` `{ url, allowLan }` → image bytes or 422 `{ error: 'not_image' | 'too_big' }` (≤ 512 KB, 10 s); `POST /v1/probe` `{ input }` → `ProbeResult`. Every failure answers a fixed code.

- [ ] **Step 1: Write the failing tests** (fixtures use the fictional channels and `iptv.example.com`):
  - m3u: attributes and quoting (`group-title="DE | Sport"`), unquoted attributes, user agent from `#EXTVLCOPT`, VOD skipped and counted (`/movie/`, `.mkv`), 20 005 entries → 20 000 + `overLimit 5`, a 9 KB line → `invalid 1`, the BOM/CRLF fixture parses equal to the plain one, no header → `not_m3u`; `credential path segments do not change the key` (Review Focus 2: `xtream.m3u` entries `/live/anna/alt/101.ts` vs `/live/anna/neu/101.ts` without tvg-id → equal keys); same derived key twice → `…:2`; `tvg-shift` (header `tvg-shift="1"` → every entry 60; an entry's `tvg-shift="-1.5"` → −90; `"20"` and `"abc"` → undefined); `groups and skipping` (fixture with "DE | Sport" 3, "Kinder" 2, "Nachrichten" 1 → `groups` in list order with those counts, `listed 6`; `skipGroups {'Kinder'}` → 4 entries, `skipped.groups 2`, `pos` of "Nachrichten" still 5; a 20 005-entry list whose first 10 000 are in a skipped group → the other 10 005 kept with `overLimit 0`).
  - xmltv: plain and gzip give the same items; `start="20261111201500 +0100"` → `Date.UTC(2026,10,11,19,15)`; `20261025023000 +0200` and `20261025023000 +0100` → two instants one hour apart; programmes outside the window skipped; `doctype.xml` → `doctype`; `&custom;` → `invalid`; a 1 MB zero gzip → `ratio`; `maxProgrammes 3` stops after three; title cut at 200, description at 2 000; `channels` filter; `<icon src="https://iptv.example.com/logo/nordlicht.png"/>` → `icon`, a `file:` icon → none.
  - logo: PNG/JPEG/WebP sniffed, SVG → null.
  - probe: `ffprobe-h264-aac.json` → hls `passthrough`, ts `remux`; `ffprobe-hevc.json` → `transcode`; `ffprobe-h264-mp2.json` (ts) → `remux`; for http inputs ffprobe's args contain `pipe:0` and no `http`; SRT args contain the IP literal and `srt,udp`; a 12 s ffprobe → `timeout`.
  - routes: signed m3u call → entries; logo SVG → 422 `not_image`; 600 KB PNG → 422 `too_big`; xmltv answers NDJSON and ends with an error line on a broken file.
- [ ] **Step 2: Run** `npx -w livetv vitest run test/m3u.test.ts test/xmltv.test.ts test/logo.test.ts test/probe.test.ts test/fetch-routes.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): M3U, XMLTV, logo fetching and stream probes with hard limits`

### Task 15: Sources with encrypted URLs, test route

**Implementer:** Opus (hard: secrets) · backend

**Files:**
- Create: `backend/src/livetv/sources.ts`, `backend/src/livetv/urls.ts`
- Modify: `backend/src/livetv/adminRoutes.ts` (source routes)
- Test: `backend/test/livetv-sources.test.ts`

**Interfaces:**
- Produces (`urls.ts`): `export function checkSourceUrl(raw: string, o: { allowLan: boolean; schemes: Array<'http:' | 'https:' | 'srt:'> }): { ok: true } | { ok: false; code: 'scheme' | 'host' | 'lan_required' | 'refused' | 'invalid' }` (scheme, host form, single-label refused, IP literals classified like Task 13 — the backend never resolves provider names, spec §3.4); `export function maskUrl(raw: string): string` → `scheme://host/…`.
- Produces (`sources.ts`): `export interface SourceRow` (the `livetv_sources` columns, snake_case, `*_enc` still encrypted); `export interface SourceView { id; kind: 'm3u' | 'manual'; name; urlHint: string | null; epgHint: string | null; userAgent: string | null; allowLan: boolean; refresh: '6h' | '12h' | '24h' | 'weekly' | 'manual'; skipGroups: string[]; numbering: 'chno' | 'order'; numberBase: number; logoPref: 'm3u' | 'xmltv'; epgShiftMin: number; maxStreams: number | null; enabled: boolean; position: number; channelCount: number; pendingGroups: number /* unreleased groups holding channels of this source */; state: { lastRefreshAt: string | null; lastOkAt: string | null; lastError: string | null; counts: { channels: number; added: number; removed: number } | null; epg: { lastRefreshAt: string | null; lastOkAt: string | null; lastError: string | null; programmes: number | null } } }`; `export async function listSources(ctx): Promise<SourceView[]>`; `export async function createSource(ctx, actor: string, b: SourceBody): Promise<SourceView>`; `export async function updateSource(ctx, actor, id, patch: Partial<SourceBody>): Promise<SourceView>` (absent `url`/`epgUrl` = unchanged, `epgUrl: null` removes); `export async function deleteSource(ctx, actor, id): Promise<{ channels: number }>`; `export async function sourceSecrets(ctx, id): Promise<{ url: string | null; epgUrl: string | null }>` (decrypt, only for calls to `livetv`).
- `SourceBody` (zod, `.strict()`): `name` 1–60, `url` ≤ 2048 (http/https), `epgUrl` ≤ 2048 optional, `userAgent` ≤ 200, `allowLan`, `refresh`, `skipGroups` (≤ 2 000 strings of 1–200 chars, duplicates removed), `numbering` (`chno` | `order`), `numberBase` 1–99 999, `logoPref` (`m3u` | `xmltv`), `epgShiftMin` (−720…840, a multiple of 30), `maxStreams` 1–50 | null, `enabled`. A changed `skipGroups`, `numbering` or `numberBase` marks the source due, so the next tick re-imports it.
- Routes (`requireAdmin`): `GET /api/admin/livetv/sources`, `POST` (201), `PATCH /:id`, `DELETE /:id` → `{ channels }`, `POST /api/admin/livetv/sources/test` `{ url?, epgUrl?, userAgent?, allowLan, sourceId? }` (a missing `url` with `sourceId` uses the stored one) → `{ channels: number /* listed */, groups: Array<{ name: string; channels: number }> /* list order, for the picker */, samples: string[] /* 5 names */, epgChannels: number | null }` or 422 `{ error: code }` (it calls `/v1/fetch/m3u` without `skipGroups`, so every group is counted). Audits `livetv.source.create|update|delete` `{ fields: string[] }`.

- [ ] **Step 1: Write the failing tests:**
  - `urls are stored encrypted and answered masked` — POST with `https://anna:geheim@iptv.example.com/get.php?username=anna&password=geheim` → `url_enc` decrypts to it; answer and `GET` contain `https://iptv.example.com/…` and neither `geheim` nor `password=`.
  - `edit without url keeps it` — PATCH `{ name }` → `url_enc` unchanged.
  - `save-time validation` — `ftp://…` → 400 `field url`; `http://backend/list` → 400; `http://192.168.1.5/x` → 400 `lan_required`, with `allowLan` → 201; `http://127.0.0.1/` → 400 with `allowLan` too.
  - `import options validate and are answered` — `epgShiftMin 45` → 400 `field epgShiftMin`, `900` → 400, `-90` → 201; `numbering 'x'` → 400; `logoPref 'svg'` → 400; a new source answers `skipGroups []`, `numbering 'chno'`, `logoPref 'm3u'`, `epgShiftMin 0`; PATCH `{ skipGroups: ['Kinder'] }` makes the source due.
  - `test lists the groups with counts` — fixture → `groups [{ name: 'DE | Sport', channels: 3 }, { name: 'Kinder', channels: 2 }, { name: 'Nachrichten', channels: 1 }]`, `channels 6`, also when the stored source skips "Kinder".
  - `no secret in logs, audit or errors` — logger stream captured; invalid bodies carrying the URL; grep logs, answers and `audit_log.meta` for `iptv.example.com` and `geheim` → none.
  - `test asks livetv, never the provider` — fake `livetv` `/v1/fetch/m3u` receives the decrypted URL; `fakeHttp` has no route for `iptv.example.com`; answer `{ channels: 6, groups: 2, samples: [...] }`.
  - `delete cascades channels and reports the count`; `non-admin 403`.
- [ ] **Step 2: Run** `npx -w backend vitest run test/livetv-sources.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): provider sources with encrypted URLs`

### Task 16: Import merge, refresh tick, events, failure notice, logos

**Implementer:** Opus (hard: merge rules over 20 000 rows) · backend

**Files:**
- Create: `backend/src/livetv/import.ts`, `backend/src/livetv/refresh.ts`, `backend/src/livetv/events.ts`, `backend/src/livetv/logos.ts`
- Modify: `backend/src/livetv/adminRoutes.ts` (`POST /api/admin/livetv/sources/:id/refresh` → 202, result via `GET`), `backend/src/server.ts` (`livetvRefreshTick` every 5 min behind `op()`), `backend/src/messages.ts` (`livetv.source.failed.title` DE "Senderliste lässt sich nicht aktualisieren" EN "Channel list cannot be updated"; `.body` DE "Senderliste {source} lässt sich nicht aktualisieren" EN "Channel list {source} cannot be updated"), `backend/src/routes/admin.ts` (`summary.livetv.failedSources`)
- Test: `backend/test/livetv-import.test.ts`

**Interfaces:**
- Produces (`import.ts`): `export interface ImportResult { added: number; updated: number; missing: number; returned: number; total: number; listed: number; newGroups: number }`; `export function importNumber(e: Pick<M3uEntry, 'chno' | 'pos'>, src: { numbering: 'chno' | 'order'; number_base: number }): number` (`chno` → `e.chno ?? base + pos`; `order` → `base + pos`; rulings 19, 41); `export async function mergeImport(ctx: Ctx, source: SourceRow, fetched: { entries: M3uEntry[]; listed: number }, now?: Date): Promise<ImportResult | { error: 'empty' }>` — spec §10 rules in one transaction: keyed by `source_key`; new → insert (group via `livetv_group_map`; a new provider group maps to an existing group with the same `lower(name)`, else creates the group (name cut to 40) with `released = false`, no `livetv_group_roles` row, not kid-friendly); existing → `import_*` (`import_number = importNumber(…)`, `import_epg_shift_min = shiftMin ?? null`), `stream_url_enc`, `stream_kind`, `tvg_*`, `missing_since = null`; absent (incl. entries of skipped groups, which `livetv` never sends) → `missing_since = now`; overrides never touched; `listed` 0 or < 20 % of the previous `last_counts.listed` → `{ error: 'empty' }`, nothing changed (counted before group skipping, ruling 41).
- Produces (`refresh.ts`): `export async function refreshSource(ctx: Ctx, id: string, trigger: 'tick' | 'admin'): Promise<void>` (single flight `ltv:refresh:<id>` setnx 15 min; `/v1/fetch/m3u` with the source's `skipGroups` → `mergeImport` → logos → `last_*` columns (`last_counts` gains `listed` and `newGroups`); error code from `LivetvError`; consecutive failures `ltv:fails:<id>`; the third → `notifyAdmins` kind `livetv.source.failed`, dedupe `livetv-source-<id>-<yyyy-mm-dd>`; Task 17 adds the EPG step); `export async function livetvRefreshTick(ctx: Ctx): Promise<void>` (lock `ltv:refresh-tick`; due by `refresh`; `manual` sources only by admin).
- Produces (`events.ts`): `export interface LiveEvent { at: number; level: 'info' | 'warn' | 'error'; code: string; channelId?: string; sourceId?: string; n?: number }` (codes, never text or URLs); `export async function pushEvent(ctx: Ctx, e: Omit<LiveEvent, 'at'>): Promise<void>` (KV `ltv:events`, newest 200, TTL 7 days, short lock); `export async function listEvents(ctx: Ctx, limit?: number): Promise<LiveEvent[]>`.
- Produces (`logos.ts`): `export async function importLogo(ctx: Ctx, url: string, allowLan: boolean): Promise<string | null>` (ruling 28; insert `on conflict do nothing`).

- [ ] **Step 1: Write the failing tests:**
  - `first import creates channels and unreleased groups` — six fixture channels, groups "DE | Sport", "Kinder", "Nachrichten" → each `released false`, `kid_friendly false`, no `livetv_group_roles` row; `newGroups 3`.
  - `skipped groups are not imported and their channels go missing` — source skips "Kinder": first import has 4 channels; then "Kinder" ticked again → its 2 channels arrive; skipped again → those 2 get `missing_since`, overrides kept.
  - `unticking most groups does not trip the shrink guard` (Review Focus 9) — 100 listed before, 100 listed now with 90 in skipped groups → no `empty` error, 90 missing, the picked channels keep their numbers.
  - `numbering policies` — `chno`: `tvg-chno="7"` → 7, none at `pos 3` with base 100 → 103; `order` with base 1 → `pos + 1` even with `tvg-chno`; an admin `number_override` survives a policy change.
  - `tvg-shift is stored per channel` — header +60, one entry −90 → `import_epg_shift_min` 60 and −90; removed from the list → null.
  - `a group the provider adds later arrives unreleased` (Review Focus 9) — second import adds "Erwachsene" → new group `released false`, no roles; a provider group that maps to the existing released group "Sport" keeps it released.
  - `overrides survive a re-import` — `name_override`, `number_override`, `group_override`, `hidden` set; re-import with a changed `import_name` → overrides untouched, `import_name` updated.
  - `missing and return` — an entry gone → `missing_since` set; back → null, same id.
  - `shrink guard` — 100 before, 15 now → `{ error: 'empty' }`, nothing missing, `last_error 'empty'`.
  - `a provider password change keeps channel identity` (Review Focus 2) — `/live/anna/alt/101.ts` → `/live/anna/neu/101.ts`, no tvg-id → same channel ids, favourite and `livetv_recent` rows intact, `stream_url_enc` now decrypts to the new URL.
  - `an existing group of the same name is reused` — group "Sport" exists → provider "sport" maps to it.
  - `three failures notify the admins once` — fake 502 three times → one notification naming the source, not the URL.
  - `a failing refresh leaks no URL` — `livetv` answers `{ error: 'http://anna:geheim@iptv.example.com/…' }` → `last_error 'livetv_error'`; logs, events, notifications and audit contain neither `iptv.example.com` nor `geheim`.
  - `logos fetched once per URL` — two refreshes → one `/v1/fetch/logo` call.
  - `summary counts failing sources`.
- [ ] **Step 2: Run** `npx -w backend vitest run test/livetv-import.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w backend vitest run test/livetv-sources.test.ts test/admin-summary.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): channel import with merge rules and source refresh`

### Task 17: EPG import, four-pass matching, offsets, logo preference, now/next, prune

**Implementer:** Sonnet (routine) · backend

**Files:**
- Create: `backend/src/livetv/epg.ts`
- Modify: `backend/src/livetv/refresh.ts` (EPG after the list; EPG due at least every 24 h, also for `manual` sources), `backend/src/server.ts` (`livetvEpgPrune` once a day at 04:10 server time: 10-minute tick + KV day key), `backend/src/livetv/adminRoutes.ts` (`GET /api/admin/livetv/epg/summary` → `{ matched, total, unmatched }`)
- Test: `backend/test/livetv-epg.test.ts`

**Interfaces:**
- Produces: `export async function refreshEpg(ctx: Ctx, source: SourceRow): Promise<{ channels: number; programmes: number } | { error: string }>` (ruling 27: reads the NDJSON stream, upserts `livetv_epg_channels`, in one transaction deletes the source's imported programmes and inserts in batches of 5 000; an error line rolls back; channel `icon` URLs kept in memory only, ruling 43); `export interface EpgIndex` (per source: `byId` lower-cased id → xml ids, `byName` lower-cased display-name with `_` → space → xml ids, `byNorm` normName → xml ids); `export function buildEpgIndex(rows: Array<{ sourceId: string; xmlId: string; names: string[] }>): EpgIndex`; `export function matchChannel(ch: { sourceId: string; tvgId: string | null; tvgName: string | null; importName: string }, idx: EpgIndex): { sourceId: string; xmlId: string; pass: 1 | 2 | 3 | 4 } | null` — spec §9.4 passes in order (1 tvg-id, 2 tvg-name, 3 import name, 4 `normName`), each pass: own source first, then the other sources (source position order); exactly one hit matches, none or several → next pass; never similarity (ruling 44); `normName` from Task 14's rules re-implemented in `epg.ts`, unit-equal; `export async function autoMatch(ctx: Ctx): Promise<{ matched: number; total: number }>` (channels with `epg_match = 'auto'`; then `epgLogos`); `export async function epgLogos(ctx: Ctx, icons: Map<string /* sourceId|xmlId */, string>): Promise<number>` (matched channels whose `logo_pref` is `xmltv`, or `m3u` without an import logo → `importLogo` → `epg_logo_hash`; others cleared to null when unmatched); `export interface Prog { title: string; start: string; end: string; subtitle?: string }`; `export async function nowNext(ctx: Ctx, channelIds: string[], at?: Date): Promise<Map<string, { now?: Prog; next?: Prog }>>` (one query; per channel it looks up `at − epgShiftMin` and adds the offset to the answered times, ruling 42); `export async function epgPrune(ctx: Ctx, now?: Date): Promise<{ programmes: number; channels: number; logos: number }>` (programmes `end_at < now − 1 day`; channels `missing_since < now − 30 days`; logos referenced by no channel).

- [ ] **Step 1: Write the failing tests:** `a broken file keeps the old programmes`; `the four passes in order` (`matchChannel` table: tvg-id `nordlicht.de` ↔ id `Nordlicht.DE` → pass 1; tvg-name `Hafen_Kanal` ↔ display-name "Hafen Kanal" → pass 2; import name "bergblick sport" ↔ "Bergblick Sport" → pass 3; "Nordlicht TV HD" ↔ "Nordlicht TV" → pass 4; pass order beats source order — a pass-1 hit in another source beats a pass-2 hit in the own source; two pass-2 candidates → pass 3 decides); `own source first` (the same id in both sources → the channel's own source); `no fuzzy match is applied` ("Nordlicht" ↔ only "Nordlicht TV 2" → null); `offsets shift now and next on read` (programme 19:15–20:00 UTC, channel shift +60 → `now` 20:15–21:00 UTC at 20:30 UTC; channel override 0 wins over import +60; source +60 applies when the channel has neither); `one EPG channel serves two channels with different offsets` (two channels mapped to one xml id, shifts 0 and +60 → different `now`); `logo preference` (`xmltv` → `epg_logo_hash` is the effective logo; `m3u` with a tvg-logo → no icon fetch; `m3u` without → icon fetched once per URL; no icon URL in any table); `now and next` (at 20:30 local `now` "Die Leuchtturmwärter" 20:15–21:00, `next` "Wetter am Hafen" 21:00); `UTC is stored` (an XMLTV `+0200` start reads back as the same instant); `prune` (counts per kind); `a manual source's EPG still refreshes every 24 h`; `summary counts`.
- [ ] **Step 2: Run** `npx -w backend vitest run test/livetv-epg.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): XMLTV import, automatic matching and now/next`

### Task 18: Groups, per-profile channel rights, `features.livetv`, Phase 0 data

**Implementer:** Opus (hard: authorization) · backend

**Files:**
- Create: `backend/src/livetv/groups.ts`, `backend/src/livetv/rights.ts`
- Modify: `backend/src/livetv/adminRoutes.ts` (group routes), `backend/src/routes/adminUsers.ts` (`PUT /api/admin/users/:id/livetv-groups`; `GET …/:id/rights` answer gains `livetvGroups: { allow: Array<{ id: string; name: string }>; deny: Array<{ id: string; name: string }> }`; `GET/POST …/:id/check` answer gains `livetv: { groups: Array<{ id: string; name: string; visible: boolean; reason: 'notReleased' | 'notKidFriendly' | 'notGranted' | 'denied' | null }>; channels: number } | null`), `backend/src/routes/admin.ts` (P0 `GET /api/admin/roles`: each `matrix.roles[]` entry gains `livetvGroups: string[]` names), `backend/src/rights.ts` (P0 `invalidateRights` also calls `invalidateLivetvRights`), `backend/src/routes/auth.ts:334` (`features.livetv = await livetvFeature(…)`)
- Test: `backend/test/livetv-rights.test.ts`

**Interfaces:**
- Consumes: `effectiveRights`, `invalidateRights`, `roleExists` (P0 Tasks 1–2), `livetvInstalled` (Task 10), `CHANNEL_SELECT` (Task 12).
- Produces (`rights.ts`): `export async function allowedGroups(ctx: Ctx, user: { id: string; role: string }, profile: { id: string; kids: boolean }): Promise<{ all: boolean; ids: Set<string> } | null>` (`null` without `perms.liveTv`; groups with `released = false` never in it, for any role and despite a per-user `allow` (ruling 39); admin role → all released groups incl. channels without a group; kids → kid-friendly only, also for an admin's kids profile); `export async function channelSet(ctx, user, profile): Promise<Set<string>>` (spec §8 steps 1–4: not hidden, not missing, source enabled; cached 60 s per profile); `export async function channelAllowed(ctx, user, profile, channelId: string): Promise<boolean>`; `export function invalidateLivetvRights(): void`; `export async function livetvFeature(ctx, user, profile): Promise<boolean>` (installed ∧ `liveTv` ∧ `channelSet.size ≥ 1`, cached 60 s).
- Produces (`groups.ts` + routes, `requireAdmin`): `GET/POST/PATCH/DELETE /api/admin/livetv/groups[/:id]` `{ name 1–40, kidFriendly, roles: string[], released: boolean }` (POST defaults `released: true`; answer adds `channels`, `providerGroups: string[]`; GET lists unreleased groups first, then by position, and answers `pending: number`); `POST /groups/release { ids (1–500), roles: string[] (each roleExists, may be empty), kidFriendly: boolean }` → sets `released = true`, replaces the roles and the flag of each, answers `{ released: number }`; PATCH `{ released: false }` = *Freigabe zurücknehmen* (roles kept); `PUT /groups/order { ids }`; `POST /groups/merge { ids, into }` (maps and `group_override`s move to `into`, the others are deleted); `PUT /api/admin/users/:id/livetv-groups { allow: string[], deny: string[] }` (overlap → 400). Every write calls `invalidateLivetvRights()`; audits `livetv.group.*` (`livetv.group.release` with ids and role keys), `user.livetv_groups`.

- [ ] **Step 1: Write the failing tests:**
  - `unreleased groups are invisible to everyone` (Review Focus 9) — an import-created group with channels: admin, family and a friend with a per-user `allow` see none of its channels; `features.livetv` false when it is the only group; `/check` reason `notReleased`.
  - `release grants roles and shows the channels` — `POST /groups/release { ids: [g], roles: ['family'], kidFriendly: false }` → family sees the channels at once (invalidation), friend not, admin yes; `roles: []` → only admins and per-user allows; `PATCH { released: false }` hides them again and keeps `roles`.
  - `manual groups start released` — POST without `released` → visible to its roles.
  - `roles and exceptions` — group Sport `roles [family]`: friend sees nothing of it; friend with allow → sees; family with deny → not; admin sees all including channels without a group; guest nothing until granted.
  - `kids see kid-friendly groups only` — family kids profile → Kinderinsel only; an admin's kids profile → kid-friendly only; no kid-friendly group → `features.livetv false`.
  - `liveTv switched off → nothing` (P0 user override `liveTv: false`).
  - `hidden, missing and disabled sources are out`.
  - `writes invalidate at once` — change group roles → next `channelSet` reflects it without waiting.
  - `features.livetv` — not installed → false; installed + one visible channel → true.
  - `merge moves maps and overrides`.
  - `people pages carry the data` — `/rights` lists Ben's allow/deny groups; `/check` for a kids profile gives reason `notKidFriendly` for Sport and a channel count; the role matrix lists group names per role.
- [ ] **Step 2: Run** `npx -w backend vitest run test/livetv-rights.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w backend vitest run test/rights.test.ts test/roles-api.test.ts test/admin-user-detail.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): channel groups and per-profile channel rights`

### Task 19: Channel administration API, logos, stream test

**Implementer:** Sonnet (routine) · backend

**Files:**
- Create: `backend/src/livetv/adminChannels.ts`
- Modify: `backend/src/livetv/adminRoutes.ts`, `backend/src/livetv/logos.ts` (upload, serve), `backend/src/livetv/routes.ts` (new: user routes file, registered in `app.ts`; here only `GET /api/livetv/logos/:hash`)
- Test: `backend/test/livetv-channels-admin.test.ts`

**Interfaces:**
- `GET /api/admin/livetv/channels?q&source&group&state=visible|hidden|missing&epg=yes|no&error=1&sort=number|name|source&dir=asc|desc&limit=1–500 (100)&offset` → `{ channels: AdminChannel[]; total: number }` with `AdminChannel = { id; number: number | null; name; groupId: string | null; sourceId; streamKind; ingest; logoHash: string | null; hidden; missing: boolean; epg: boolean; mode: 'passthrough' | 'remux' | 'transcode' | null; probeError: string | null; overridden: { name?: string; number?: number | null; group?: string | null; logo?: true }; dupNumber: boolean; epgShift: { min: number; from: 'channel' | 'list' | 'source' | 'none' }; push?: { port: number; hint: string; portInRange: boolean } }` (`q` matches name, number, tvg-id).
- `PATCH /api/admin/livetv/channels/:id { name?, number?, groupId?, hidden?, epg?, epgShiftMin? }` (`null` = back to import; `epg: null` = `epg_match 'auto'` and re-match; `epgShiftMin` −720…840 in steps of 30 → `epg_shift_override_min`, `null` = inherited; the answer's `now` line uses the new offset); `POST /channels/bulk { ids (≤ 20 000), action: 'hide' | 'show' | 'group' | 'renumber' | 'reset' | 'test', groupId?, from? }` (`test` ≤ 20 ids, sequential, answers `{ results: Array<{ id; ok; needs?; error? }> }`); `PUT /channels/order { ids }` (renumbers from the smallest number in the set via `number_override`); `POST /channels/:id/test` → `/v1/probe` with the decrypted input → stores `probe = { at, ok, video, audio, needs }` → `{ ok, video, audio, needs, error? }` (ruling 15: no preview yet); `PUT /channels/:id/logo` (raw `image/png|jpeg|webp` body ≤ 512 KB, magic bytes checked → `logo_override_hash`; ruling 32), `DELETE /channels/:id/logo`.
- `GET /api/livetv/logos/:hash` (`requireUser`, kids allowed) → bytes, `cache-control: private, max-age=604800, immutable`; unknown → 404.

- [ ] **Step 1: Write the failing tests:** `filters and paging` (25 channels, `limit 10 offset 10`, `q` by tvg-id); `override and back to import`; `EPG offset override and back to inherited` (`epgShiftMin 60` → `epgShift { min: 60, from: 'channel' }`; `null` → the list's `tvg-shift` value with `from 'list'`; `45` → 400); `duplicate numbers are flagged`; `bulk renumber from 100`; `order renumbers from the smallest number`; `test stores the probe and answers no URL`; `logo upload refuses SVG (415) and 600 KB (413), stores a PNG`; `logos route sends the cache header`; `no stream URL in any answer` (grep every answer JSON for `iptv.example.com`).
- [ ] **Step 2: Run** `npx -w backend vitest run test/livetv-channels-admin.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): channel administration API`

### Task 20: Own feeds — pull and SRT push credentials, ports, ingest sync

**Implementer:** Opus (hard: credentials) · backend

**Files:**
- Create: `backend/src/livetv/ownfeeds.ts`
- Modify: `backend/src/livetv/adminRoutes.ts`
- Test: `backend/test/livetv-ownfeeds.test.ts`

**Interfaces:**
- `POST /api/admin/livetv/channels` body `{ ingest: 'pull'; name; url; kind?: 'hls' | 'ts' | 'srt'; number?; groupId?; allowLan? } | { ingest: 'push'; name; number?; groupId? }`. The *Eigene Streams* source (`kind 'manual'`, stored name `Eigene Streams`, shown through i18n by kind) is created on first use. Pull URLs pass `checkSourceUrl` with `srt:` allowed. Push: port = lowest free of `/v1/system.srt.ports` (cached 60 s; unreachable → 503 `livetv_unreachable`); none free → 409 `{ error: 'srt_ports_full', n }`; `streamId = 'ff-' + 16 base32 chars (A–Z, 2–7)`; `passphrase` = 32 base64url chars; both encrypted; `push_stream_id_hint = 'ff-' + first 6 random chars` (ruling 35); answer 201 `{ channel: AdminChannel, push?: { host: srtHost(ctx), port, streamId, passphrase, url } }` with `url = srt://<host>:<port>?streamid=<id>&passphrase=<pass>&pbkeylen=32&mode=caller&latency=200000` — shown once, `cache-control: no-store`.
- `POST /channels/:id/push-credentials` → the same one-time answer with new values; `POST /channels/:id/push-port` (*Neuen Port zuweisen*, spec §19) → `{ port }`, credentials kept; `DELETE /channels/:id` (manual source only) frees the port.
- `export async function syncIngest(ctx: Ctx): Promise<'ok' | 'pending' | 'failed'>` — `PUT /v1/ingest { feeds: [{ channelId, port, streamId, passphrase }] }` with every push feed whose port is in range; 404 → `pending` (ruling 24, one `ingest_sync_pending` event); called after every push change (Task 31 also on a `bootId` change).

- [ ] **Step 1: Write the failing tests:** `credentials have the spec format` (`^ff-[A-Z2-7]{16}$`, `^[A-Za-z0-9_-]{32}$`; stored encrypted; a second `GET` shows only `hint` and `port`); `ports are the lowest free` (9000, 9001; delete the first → next gets 9000); `the range can be full` (10 feeds → the 11th 409 `srt_ports_full` `n 10`); `regenerate replaces both and syncs` (`PUT /v1/ingest` body has the new pair); `a port that left the range` (`LIVETV_SRT_PORTS` now `9100-9109` → `portInRange false`; `push-port` gives 9100 and keeps credentials); `pull feeds validate like sources` (`srt://192.0.2.10:9000` ok; `srt://192.168.1.5:9000` needs `allowLan`); `no credential in audit or logs` (grep for the passphrase and the full stream id).
- [ ] **Step 2: Run** `npx -w backend vitest run test/livetv-ownfeeds.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): own feeds with SRT push credentials`

### Task 21: Web — `/admin/livetv` shell and the *Quellen* tab

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/admin/livetv/{api.ts,sources.ts,sources.test.ts,SourcesTab.svelte,SourceCard.svelte,SourceSheet.svelte,OwnFeedsCard.svelte,StreamSheet.svelte}`, `e2e/tests/admin-livetv-sources.spec.ts`, `e2e/tests/admin-livetv-sources.mobile.spec.ts`
- Modify: `web/src/routes/admin/livetv/+page.svelte` (installed: tabs in `?tab=` — `sources`, `channels`, `groups`, `guide`, `status`; `AdminShell` header; phone: scrolling chip row), locales `adminLive.ts` (spec §20 `adminLive.tabs.*`, `src.*`, `push.*`), `e2e/mocks/admin.ts` (stateful sources, own feeds)
- Test: the files above

**Interfaces:**
- Consumes: Tasks 15, 16, 20 routes.
- Produces (`sources.ts`): `export function detectKind(url: string): 'hls' | 'ts' | 'srt'`; `export function stateLine(s: SourceView, now: Date): string` ("Zuletzt aktualisiert heute 06:12 · 412 Sender (+3 / −1) · Programm: 6 812 Sendungen"); `export function sourceError(code: string): string` (spec §19 / §20 `adminLive.src.err.*`); `export function portsLine(ports: number[]): string` ("Gesendete Streams kommen über UDP 9000–9009 an. Nur diese Ports in der Firewall öffnen.").
- Behaviour: spec §9.1 — source cards; *Quelle hinzufügen* sheet (password-type URL field with *anzeigen*, on edit empty with `adminLive.src.unchanged`, *Prüfen* before *Speichern*; the *Import* section and the group picker are Task 22's, so this task leaves an empty slot for them in the sheet); *Jetzt aktualisieren* with the spinner in the button and a result toast; delete confirm names the channel count; *Stream hinzufügen* with the pull/push segmented choice; the push result sheet (five read-only fields with copy buttons, `onceWarning`, expandable *OBS/Encoder einrichten*, firewall line); feed rows with state chip, rejected count, menu *Zugangsdaten neu erzeugen* (confirm) / *Neuen Port zuweisen* / *Löschen*.

- [ ] **Step 1: Write the failing tests** — unit: `detectKind` three URLs, `stateLine` (de, en), `sourceError` for each §19 code, `portsLine`; e2e (German): `add a list source: Prüfen then Speichern` (POST body has the url; the card shows `https://iptv.example.com/…`); `edit leaves the url empty and PATCH has none`; `Jetzt aktualisieren shows the spinner and a toast`; `delete confirm names 412 channels`; `push feed shows the one-time result` (five copy fields, "Die Passphrase wird nur jetzt angezeigt.", *Fertig* closes, the row shows "ff-AB12CD…", port 9000, *Keine Übertragung*); `ports full shows the message`; mobile: tabs become a chip row, cards fit 375 px.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): Live-TV area with the sources tab`

### Task 22: Web — group picker after *Prüfen*, import options

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/admin/livetv/{GroupPicker.svelte,ImportOptions.svelte,picker.ts,picker.test.ts}`, `e2e/tests/admin-livetv-picker.spec.ts`
- Modify: `web/src/lib/admin/livetv/SourceSheet.svelte` (the *Import* section and the picker under the *Prüfen* result), `web/src/lib/admin/livetv/SourceCard.svelte` (selection line "Ohne 6 Gruppen · Auswahl ändern", pending line "3 neue Gruppen warten auf Freigabe" linking to `?tab=groups&pending=1`), locales `adminLive.ts` (spec §20 `adminLive.src.import`, `numbering`, `numChno`, `numOrder`, `numKeep`, `logoPref`, `logoM3u`, `logoXmltv`, `logoOwn`, `epgShift`, `epgShiftHint`, `hours`, `pick.*`, `skipped`, `changePick`, `pending`), `e2e/mocks/admin.ts` (test answer with `groups`, source fields)
- Test: the files above

**Interfaces:**
- Consumes: `POST /api/admin/livetv/sources/test` → `groups`, `SourceBody`/`SourceView` import fields (Task 15).
- Produces (`picker.ts`): `export interface PickerState { groups: Array<{ name: string; channels: number }>; skipped: Set<string>; q: string }`; `export function initPicker(groups: PickerState['groups'], skipGroups: string[]): PickerState` (skip names no longer in the list are dropped); `export function shownGroups(s: PickerState): PickerState['groups']` (case-insensitive substring of `q`; search field from 12 groups on); `export function setAll(s: PickerState, on: boolean): PickerState` (*Alle* / *Keine* act on the shown groups only); `export function toggle(s: PickerState, name: string): PickerState`; `export function totals(s: PickerState): { picked: number; total: number }` (channels); `export function skipList(s: PickerState): string[]` (list order); `export function shiftLabel(min: number): string` ("+1,5 Std.", "−2 Std.", "0"); `export function stepShift(min: number, dir: 1 | -1): number` (±30, clamped −720…840).
- Behaviour: spec §9.1 — *Import* section (numbering segmented + base field shown for *Nach Reihenfolge ab*, logo segmented, offset stepper with `shiftLabel`, each with its help line); after *Prüfen*: title `adminLive.src.pick.title`, search, *Alle* / *Keine*, checkbox rows "DE | Sport · 42 Sender" (all ticked on first use), counter line `pick.total`, note `pick.hiddenNote`; *Speichern* sends `skipGroups: skipList(s)`; *Auswahl ändern* on the card opens the sheet and runs *Prüfen* at once. The list's height is fixed with an inner scroll, so ticking never moves the sheet's buttons.

- [ ] **Step 1: Write the failing tests** — unit: `initPicker` drops unknown skip names; `shownGroups` ("sport" finds "DE | Sport"); `setAll(false)` with `q 'sport'` unticks only the shown ones; `totals` (412 listed, "Kinder" 100 skipped → `{ picked: 312, total: 412 }`); `skipList` in list order; `shiftLabel(90)` "+1,5 Std.", `stepShift(840, 1)` 840; e2e (German UI): `Prüfen shows the groups with counts, all ticked` ("18 Gruppen gefunden – welche übernehmen?", "DE | Sport · 42 Sender"); `unticking a group sends skipGroups` (POST body `skipGroups: ['Erwachsene']`, counter "312 von 412 Sendern werden übernommen"); `search then Keine unticks only the shown groups`; `import options save` (`numbering 'order'`, `numberBase 100`, `logoPref 'xmltv'`, `epgShiftMin -60`); `the card shows the selection and Auswahl ändern reopens the picker with a new Prüfen`; `the card's pending line links to the groups tab`; mobile: the sheet with 40 groups fits 375 px, buttons stay put while ticking.
- [ ] **Step 2: Run** `npx -w web vitest run src/lib/admin/livetv/picker.test.ts` and the e2e spec → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): group picker and import options for provider lists`

### Task 23: Web — *Kanäle* list, bulk, logo, test sheet

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/admin/livetv/{ChannelsTab.svelte,BulkBar.svelte,TestSheet.svelte,LogoSheet.svelte,EpgShiftSheet.svelte,channels.ts,channels.test.ts}`, `e2e/tests/admin-livetv-channels.spec.ts`, `e2e/tests/admin-livetv-channels.mobile.spec.ts`
- Modify: locales (`adminLive.ch.*`), `e2e/mocks/admin.ts`
- Test: the files above

**Interfaces:**
- Consumes: Task 19 routes; `shiftLabel` (Task 22).
- Produces (`channels.ts`): `export interface ChannelFilter { q: string; source: string | null; group: string | null; state: 'visible' | 'hidden' | 'missing' | null; epg: 'yes' | 'no' | null; error: boolean; sort; dir; offset: number }`; `export function queryString(f: ChannelFilter): string`; `export function overrideHint(c: AdminChannel): string | null` ("geändert (Import: Nordlicht TV)"); `export function factsLine(p: Pick<ProbeRec, 'video' | 'audio' | 'needs'>): string` ("H.264 1920×1080 25 fps · AAC 2.0 · wird umverpackt"); `export function kindChip(c): TKey` (*HLS* / *TS* / *SRT* / *SRT empfangen*); `export function shiftFromLine(c: Pick<AdminChannel, 'epgShift'>): string` ("+1 Std. · aus der Senderliste (tvg-shift)", "aus der Quelle", "keine"; uses `shiftLabel` from Task 22).
- Behaviour: spec §9.2 list mode — `DataTable` with server paging (100/page), checkbox, 40-px logo tile (fallback: number in a tile), number, name (inline edit on double click / Enter), group (inline select), source, kind chip, mode chip, EPG state, visibility toggle, row menu (*Testen*, *Logo ändern*, *Programm-Zeit verschieben…*, *Zurücksetzen*), changed dot; the offset sheet (spec §9.2): effective value with `shiftFromLine`, stepper ±30 min (−12…+14 h), *Zurücksetzen* (PATCH `epgShiftMin: null`), the *Jetzt* line from the PATCH answer; bulk bar keeps the selection by id across pages (*Ausblenden*, *Einblenden*, *Gruppe ändern…*, *Ab Nummer … durchnummerieren*, *Überschreibungen zurücksetzen*, *Testen* ≤ 20 sequential with results in a sheet); logo sheet previews list/tile/TV sizes and uploads (client refuses SVG and > 512 KB before sending); test sheet shows facts or the failure in words (no player, ruling 15).

- [ ] **Step 1: Write the failing tests** — unit: `queryString`, `overrideHint`, `factsLine`; e2e: `search sends q`, `filter chips and paging`, `inline rename sends PATCH name`, `group select`, `visibility toggle`, `bulk hide keeps the selection across pages`, `renumber from 100`, `test sheet shows the facts`, `the offset sheet saves epgShiftMin and Zurücksetzen sends null` (shows "+1 Std. · aus der Senderliste (tvg-shift)" first), `logo upload refuses SVG`; mobile: rows become cards.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): Kanäle tab`

### Task 24: Web — *Reihenfolge* drag and keyboard order

**Implementer:** Opus (hard: drag accessibility, FLIP with transforms) · frontend

**Files:**
- Create: `web/src/lib/admin/livetv/OrderView.svelte`, `web/src/lib/ui/{dragOrder.ts,dragOrder.test.ts}` (ruling 56: Task 38 reuses it on the user side), `e2e/tests/admin-livetv-order.spec.ts`
- Modify: `web/src/lib/admin/livetv/ChannelsTab.svelte` (view toggle *Liste / Reihenfolge*; one group or one source, ≤ 500 rows), locales (`adminLive.ch.orderPicked` "{name} aufgenommen, Position {n} von {m}", `orderMoved` "Position {n} von {m}", `orderDropped` "{name} abgelegt auf Position {n}", `orderCancelled` "Verschieben abgebrochen"; EN equivalents)
- Test: the files above

**Interfaces:**
- Produces (`#lib/ui/dragOrder`): `export interface DragState { ids: string[]; picked: string | null; origin: number }`; `export function pick(s: DragState, id: string): DragState`; `export function move(s: DragState, delta: -1 | 1): DragState`; `export function drop(s: DragState): DragState`; `export function cancel(s: DragState): DragState`; `export function flipOffsets(before: Map<string, number>, after: Map<string, number>): Map<string, number>`; `export function renumber(ids: string[], numbers: Map<string, number | null>): Array<{ id: string; number: number }>` (from the smallest number in the set, ascending). Task 25 reuses `OrderView` for groups; Task 38 reuses the pure functions for favourites.
- Behaviour: pointer and touch drag; the lifted row moves by `transform` only, the others slide by FLIP with `transform`; keyboard: focus the handle, Space picks up, ↑/↓ move, Space drops, Escape cancels, each step announced politely; *Speichern* → `PUT /channels/order`; calm/reduced motion: no transitions.

- [ ] **Step 1: Write the failing tests** — unit: pick/move/drop/cancel sequences, `flipOffsets`, `renumber` (numbers 4, 7, 9 reordered → 4, 5, 6); e2e: `keyboard reorder saves the new order` (PUT body), `Escape cancels`, `mouse drag reorders`, `reduced motion has no transitions` (computed `transition-duration` `0s`), announcements present in the live region.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): drag and keyboard channel order`

### Task 25: Web — *Gruppen & Rechte*, Live-TV in the Phase 0 people pages

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/admin/livetv/{GroupsTab.svelte,GroupMatrix.svelte,ReleaseSheet.svelte,groups.ts,groups.test.ts}`, `e2e/tests/admin-livetv-groups.spec.ts`
- Modify: `web/src/lib/admin/rights/RoleMatrix.svelte` + `web/src/lib/admin/rights/model.ts` (P0 Tasks 13–14: the *Live-TV* group shows when `features.livetv`, with a read-only *Kanalgruppen* row "Sport, Nachrichten +2" linking to `/admin/livetv?tab=groups`), `web/src/lib/admin/rights/RoleSheet.svelte` (P0 Task 15, users spec §6.1: a read-only *Kanalgruppen* chip list of the role's groups, same link; shown only with `features.livetv`), `web/src/lib/admin/user/Rights.svelte` (P0 Task 19: *Kanalgruppen-Ausnahmen* with + / − chips → `PUT …/livetv-groups`), `web/src/lib/admin/user/CheckView.svelte` (P0 Task 21: *Live-TV* section — groups with ✓/– and the reason, channel count), locales (`adminLive.grp.*`, `adminPeople.rights.livetvGroups` DE "Kanalgruppen-Ausnahmen" EN "Channel group exceptions", `adminPeople.check.livetv*` reasons DE "nicht kinderfreundlich" / "für {role} nicht freigegeben" / "für diese Person gesperrt" / "Gruppe noch nicht freigegeben" (`livetvNotReleased`, spec §20), EN equivalents; `adminLive.grp.unreleased`, `unreleasedLine`, `onlyPending`, `release`, `releaseBody`, `releaseDo`, `unrelease`, `adminLive.src.pending` from spec §20), `e2e/mocks/admin.ts`, `e2e/tests/admin-user-detail.spec.ts` (new cases)
- Test: the files above

**Interfaces:**
- Consumes: Task 18 routes and answers; `OrderView` (Task 24).
- Produces (`groups.ts`): `export function chipsText(names: string[], max = 2): string`; `export function kidsLine(groups: GroupView[]): string` ("Kinderprofile sehen: Kinderinsel, Natur & Tiere (23 Sender)"); `export function exceptionsOf(rows): Array<{ userId; name; plus: string[]; minus: string[] }>`; `export function pendingFirst(groups: GroupView[], onlyPending: boolean): GroupView[]` (unreleased first, then by position; `onlyPending` keeps the unreleased).
- Behaviour: spec §9.3 — unreleased groups first with the chip *Nicht freigegeben* (icon + text) and "Für niemanden sichtbar"; notice "{n} neue Gruppen warten auf Freigabe" with *Nur diese zeigen* (also opened by `?pending=1` from Task 22's card link); *Freigeben…* in the row menu and in the bulk bar for selected groups opens `ReleaseSheet` (role chips none preselected, *Kinderfreundlich* off, `releaseBody` with the channel count) → `POST /groups/release`; *Freigabe zurücknehmen* (confirm) → PATCH `{ released: false }`; list with drag order, channel count, *Kinderfreundlich* toggle, role chips, mapped provider groups line; *Gruppe anlegen*, *Zusammenführen…*, *Umbenennen*, *Löschen* (channels fall back to *Ohne Gruppe*); matrix toggle *Nach Rolle* (groups × roles switches, P0 matrix style) + *Personen mit Ausnahmen*; kids preview line.

- [ ] **Step 1: Write the failing tests** — unit: `chipsText(['Sport','Nachrichten','Natur','Kinder'])` = "Sport, Nachrichten +2", `kidsLine`, `pendingFirst`; e2e: `unreleased groups come first with the chip and the notice`, `release two groups for family` (POST body `{ ids: [a, b], roles: ['family'], kidFriendly: false }`; the chips disappear), `withdraw a release confirms and PATCHes released false`, `?pending=1 shows only the waiting groups`, `create a group, mark it kid-friendly, grant family` (bodies), `matrix switch saves the group's roles`, `merge dialog`, `delete confirm`, `exceptions list links to the person`, `Rechte tab adds Sport for a guest` (PUT `{ allow: [id], deny: [] }`), `Sicht prüfen explains a hidden group` ("nicht kinderfreundlich"; an unreleased one: "Gruppe noch nicht freigegeben"), `role matrix shows the Kanalgruppen row only with Live TV`, `role sheet lists the role's channel groups as chips` (only with Live TV).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/rights/model.test.ts src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): channel groups and rights, Live-TV in the people pages`

### Task 26: *Live-Status* (API + tab), guide counts, off dialog

**Implementer:** Sonnet (routine) · backend + frontend

**Files:**
- Create: `backend/src/livetv/status.ts`, `web/src/lib/admin/livetv/{StatusTab.svelte,GuideTab.svelte,status.ts,status.test.ts}`, `backend/test/livetv-status.test.ts`, `e2e/tests/admin-livetv-status.spec.ts`
- Modify: `backend/src/livetv/adminRoutes.ts` (`GET /api/admin/livetv/status`, `POST /api/admin/livetv/streams/:channelId/stop`), `web/src/routes/admin/livetv/+page.svelte` (`MiniStatus` from Task 11 replaced by `StatusTab`; `OffDialog` moves here), locales (`adminLive.status.*`, `adminLive.epg.matched`, event code texts `adminLive.ev.<code>`)
- Test: the files above

**Interfaces:**
- `GET /api/admin/livetv/status` → `{ version, budget: ConversionsView, system: { cpuPct, gpuPct: number | null, cache: { usedBytes, maxBytes } }, streams: Array<{ channelId; name; logoHash; mode; viewers: number; since; bitrate; input: 'ok' | 'reconnecting' | 'failed'; reconnects: number }>, ingest: Array<{ channelId; name; port; state; since; bitrate; rejected1h }>, events: LiveEvent[], gpu: { advice: GpuAdvice | null } }` — `livetv` 404s give `[]` (ruling 24); viewers from Task 31's viewer keys (0 before 1d); never URLs.
- `POST /api/admin/livetv/streams/:channelId/stop` → `DELETE /v1/streams/:channelId` (404 tolerated), event `stopped_by_admin`, audit `livetv.stream.stop`.
- Web (`status.ts`): `export function cacheLine(c): string` ("3,1 von 6 GB"); `export function eventText(e: LiveEvent): string` (by code, e.g. `input_lost` "Eingang verloren · {n} s bis zur Wiederverbindung", `start_refused_full` "Start abgelehnt: alle Plätze belegt", `source_refresh_failed` "Quelle {source}: Aktualisierung fehlgeschlagen ({reason})", `push_rejected` "Verbindung abgelehnt: falsche Kennung oder Passphrase", `released_on_switch` "Beim Umschalten sofort beendet (Platz oder Verbindung gebraucht)" — raised from Task 32 on); level shown as icon + word.
- `StatusTab`: `ConversionsCard readOnly link="/admin/playback"`, tiles (*Laufende Sender*, *Zuschauer*, *CPU*, *GPU* or "–", *DVR-Speicher*), *Laufende Sender* table (menu *Stoppen* with confirm, *Neu starten*), *Ereignisse*, *Gesendete Streams* (only with push feeds), GPU message, `livetv` version, *Live-TV ausschalten…*. `GuideTab` (Phase 1): "398 von 412 Sendern mit Programm · 14 ohne".

- [ ] **Step 1: Write the failing tests** — backend: `status tolerates a livetv without stream endpoints`, `no URL in the status answer`, `stop calls DELETE and audits`; unit `cacheLine`, `eventText` per code; e2e: `tiles, events and the GPU message`, `push table only with push feeds`, `Stoppen confirms`, `guide counts`, `off dialog from the status tab`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): Live-Status and guide counts`

**PR 1c boundary:** open the PR after Task 26 (`feat(livetv): sources, channels, groups and rights`).

---

## PR 1d — Watching (Tasks 27–42)

### Task 27: `livetv` streams, DVR window (≤ 120 min, date-times), cache eviction, HLS passthrough

**Implementer:** Opus (hard: streaming, timing) · livetv

**Files:**
- Create: `livetv/src/streams.ts`, `livetv/src/window.ts`, `livetv/src/cache.ts`, `livetv/src/passthrough.ts`, `livetv/src/routes/streams.ts`, `livetv/src/routes/files.ts`
- Test: `livetv/test/{window.test.ts,cache.test.ts,passthrough.test.ts,streams-api.test.ts}`

**Interfaces:**
- Produces: `export type Mode = 'passthrough' | 'remux' | 'transcode'`; `export interface StartBody { channelId: string; input: StreamInput; mode: Mode; encoder: Encoder; dvrSeconds: number /* 0–7200, ruling 47 */; maxBitrate: number }`; `export interface StreamView { channelId; streamKey: string /* 32 hex */; mode: Mode; since: number; state: 'starting' | 'running' | 'reconnecting' | 'failed'; bitrate: number | null; errors: Array<{ at: number; code: 'input_lost' | 'input_back'; seconds?: number }>; lastSegmentAt: number | null }`.
- `export class Streams { start(b: StartBody): { streamKey: string; state: StreamView['state'] }; list(): StreamView[]; stop(channelId: string): void; touch(streamKey: string): void; file(streamKey: string, name: string): { path: string; type: string } | null }` — idempotent per `channelId` (a second `start` returns the running key); modes register a driver (`passthrough` here, Task 28 adds the ffmpeg modes); safety net: no `/s/` fetch for 180 s → stop.
- `export class SegmentWindow { constructor(o: { dvrSeconds: number; ext: 'ts' | 'm4s'; init?: boolean }); add(s: { file: string; duration: number; discontinuity?: boolean; pdt: number /* epoch ms of the segment start */ }): number /* local seq */; oldest(): { seq: number; pdt: number } | null; playlist(): string; dropOldest(): string | null; get seconds(): number; get bytes(): number }` — local names `<seq>.<ext>` strictly increasing; playlist `#EXTM3U`, version 7 (fMP4) or 6, `#EXT-X-TARGETDURATION`, `#EXT-X-MEDIA-SEQUENCE`, `#EXT-X-DISCONTINUITY-SEQUENCE`, `#EXT-X-MAP:URI="init.mp4"` for fMP4, `#EXT-X-DISCONTINUITY` where marked, `#EXT-X-PROGRAM-DATE-TIME:<ISO with ms, Z>` before every segment (spec §3.3), no `#EXT-X-PLAYLIST-TYPE`, no `#EXT-X-ENDLIST`; keeps segments while the rest still covers `dvrSeconds`, never fewer than the newest 3.
- `export function evict(windows: Array<{ id: string; w: SegmentWindow }>, maxBytes: number): Array<{ id: string; file: string }>` — while over the cap, the window with the most seconds drops its oldest segment; the newest 3 of any window are never dropped.
- Passthrough driver: `pickVariant` (Task 14) with `maxBitrate`; media playlist polled every `max(1, targetDuration / 2)` s via `guardedFetch` (≤ 2 MB), new segments fetched once (≤ 50 MB) into `/cache/<streamKey>/`; a media sequence that goes back or skips → discontinuity, local numbering continues; `pdt` = the provider's `#EXT-X-PROGRAM-DATE-TIME` of that segment when present, else arrival time − duration (ruling 47); fetch errors → reconnect backoff 2, 4, 8, 15, 30 s then every 30 s, events `input_lost` / `input_back` with seconds.
- Routes: `POST /v1/streams` → `{ streamKey, state }` (`dvrSeconds` outside 0–7200 → 400 `invalid`); `GET /v1/streams` → `StreamView[]`; `DELETE /v1/streams/:channelId` (files removed); `GET /s/<streamKey>/<file>` (key `^[0-9a-f]{32}$`, file `^(index\.m3u8|init\.mp4|[0-9]{1,10}\.(ts|m4s))$`; types `application/vnd.apple.mpegurl`, `video/mp2t`, `video/mp4`; unknown → 404; every hit `touch`es).

- [ ] **Step 1: Write the failing tests:**
  - window: `dvr 30 s keeps 32 s of 4-s segments` (10 added → 8 in the playlist, media sequence 2); `dvr 0 keeps 3`; `dvr 7200 keeps 120 min` (1 900 segments added → 1 800 kept) and `7201 → 400`; `every segment carries a program date-time` (provider PDT `2026-11-11T19:15:00.000Z` kept; without one → arrival − duration on the fake clock; `oldest()` answers the first kept one); discontinuity tag placement and `DISCONTINUITY-SEQUENCE` after the marked segment leaves; no `ENDLIST`, no `PLAYLIST-TYPE`; fMP4 has the `MAP` line.
  - `a provider media sequence that jumps back keeps local numbering monotonic` (Review Focus 5) — provider 100…105 then 3…5 → local 0…8 ascending, `#EXT-X-DISCONTINUITY` before local 6, event `input_back` not raised (no outage).
  - passthrough: master with 2.5 / 6 / 12 Mbit/s H.264 and a 5 Mbit/s HEVC variant, `maxBitrate 10_000_000` → the 6 Mbit/s one; the served playlist contains no `iptv.example.com`; a fetch error starts the backoff `[2,4,8,15,30,30]` s (fake clock).
  - cache: windows of 30 and 10 min over the cap → only the 30-min one loses its oldest; the newest 3 never go.
  - api: `start is idempotent per channel`; `DELETE stops and deletes files`; `/s/` with an unknown key or a bad name → 404; `stops by itself after 180 s without a fetch`.
- [ ] **Step 2: Run** `npx -w livetv vitest run test/window.test.ts test/cache.test.ts test/passthrough.test.ts test/streams-api.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): shared streams, DVR window and HLS passthrough`

### Task 28: `livetv` remux and transcode, reconnect, previews, benchmark

**Implementer:** Opus (hard: ffmpeg process control) · livetv

**Files:**
- Create: `livetv/src/ffmpeg.ts`, `livetv/src/inputs.ts`, `livetv/src/remux.ts`, `livetv/src/preview.ts`, `livetv/src/routes/benchmark.ts`
- Modify: `livetv/src/streams.ts` (register the `remux`/`transcode` driver), `livetv/src/routes/streams.ts` (`GET /v1/streams/:channelId/preview.jpg`), `livetv/src/run.ts` (stderr through `scrubLine`, logged with the channel id only)
- Test: `livetv/test/{ffmpeg.test.ts,remux.test.ts,preview.test.ts,benchmark.test.ts}`

**Interfaces:**
- Produces (`ffmpeg.ts`): `export function ffmpegArgs(o: { mode: 'remux' | 'transcode'; input: { kind: 'pipe' } | { kind: 'srt'; url: string }; encoder: Encoder; audio: 'copy' | 'aac'; srcHeight: number | null; dir: string; startNumber: number }): string[]` — `-hide_banner -loglevel error`, `-protocol_whitelist pipe` or `srt,udp`; remux `-c:v copy`; transcode: the encoder (`h264_qsv` / `h264_vaapi` / `h264_nvenc` / `libx264 -preset veryfast`), H.264 High, scaled to ≤ 1080 lines, `-b:v 6M` (source ≤ 720 lines: `3M`) with equal `-maxrate` and twice `-bufsize`, keyframes every 2 s (`-force_key_frames expr:gte(t,n_forced*2)`); audio `copy` when AAC/MP3 else `-c:a aac -ac 2 -b:a 160k`; output `-f segment -segment_time 4 -segment_format mpegts -segment_list pipe:1 -segment_list_type csv -segment_start_number <n> <dir>/%d.ts` (ruling 23); `export function scrubLine(line: string): string` (`[a-z]+://\S+` → `<input>`; `(user|pass|password|token|key)=[^&\s]+` → `$1=•••`).
- Produces (`inputs.ts`): `export async function openInput(input: StreamInput, deps): Promise<{ ffInput: { kind: 'pipe'; stdin: AsyncIterable<Uint8Array> } | { kind: 'srt'; url: string } }>` (ruling 3: HTTP via `guardedFetch` → stdin; SRT → `ipLiteralUrl`; `{ push }` added by Task 29).
- Driver (`remux.ts`): probes at start (Task 14); a requested `transcode` that probes as remuxable runs as `remux` and reports `mode: 'remux'` (spec §7.4 step 4); CSV lines feed `SegmentWindow` (`pdt` = the CSV line's arrival − the segment duration); ffmpeg exit while the stream lives → restart with backoff 2, 4, 8, 15, 30 s then 30 s, discontinuity marked, events as Task 27; an encoder not in `/v1/system.encoders` → `400 encoder_unavailable`.
- Previews (`preview.ts`): while running, at most every 60 s, the newest segment → `ffmpeg -i <segment> -frames:v 1 -vf scale=320:-2 -f image2 -c:v mjpeg pipe:1` kept in memory; `GET /v1/streams/:channelId/preview.jpg` → JPEG or 404 (not running / none yet). Never starts a stream.
- Benchmark: `POST /v1/benchmark { encoder }` → `ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=25 -t 20 <transcode video args> -f null -` → `{ speed: round2(20 / wallSeconds), encoder, seconds }`; one at a time (409 `busy`), 120 s timeout.

- [ ] **Step 1: Write the failing tests:** `transcode args per encoder` (each contains its encoder name, `-b:v 6M`, `-c:a aac -ac 2 -b:a 160k` for MP2 audio, `-segment_time 4`; libx264 has `-preset veryfast`; a 720-line source gets `3M`); `http inputs reach ffmpeg only through stdin` (args contain `pipe:0`, no `http`); `srt inputs carry the IP literal`; `scrubLine table` (URL, `password=geheim`, `token=abc`); `reconnect backoff` (exits at fake times → restarts after 2, 4, 8, 15, 30, 30 s; discontinuity in the window); `CSV lines become window entries` (each with an arrival-based `pdt`); `transcode that probes remuxable runs as remux`; `preview 404 before the first segment, JPEG after`; `benchmark speed` (20 s in 5 s → 4.0; parallel call → 409); `no log line contains iptv.example.com or an ffmpeg argument`.
- [ ] **Step 2: Run** `npx -w livetv vitest run test/ffmpeg.test.ts test/remux.test.ts test/preview.test.ts test/benchmark.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w livetv vitest run test/streams-api.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): remux and transcode with reconnect, previews and benchmark`

### Task 29: `livetv` SRT push ingest (`srtgate` + `IngestHub`)

**Implementer:** Opus (hard: native code, credentials in the handshake) · livetv

**Files:**
- Create: `livetv/native/srtgate.c`, `livetv/native/Makefile`, `livetv/src/srtingest.ts`, `livetv/src/routes/ingest.ts`, `livetv/test/fake-srtgate.mjs`
- Modify: `livetv/Dockerfile` (build stage: `gcc make libsrt-openssl-dev`; `RUN srtgate --selftest`; runtime: `libsrt1.5-openssl`, binary at `/usr/local/bin/srtgate`), `livetv/src/inputs.ts` (`{ push }` → the feed's ring on stdin), `livetv/src/probe.ts` (`{ push }` → ffprobe on the ring's first 4 s)
- Test: `livetv/test/srtingest.test.ts`

**Interfaces:**
- `srtgate` (ruling 2): `srtgate --ports 9000-9009` listens on every port; stdin JSON lines `{"t":"feeds","feeds":[{"port":9000,"streamId":"ff-…","passphrase":"…"}]}` replace the set; stdout frames: data `0x01 <u16 port BE> <u32 len BE> <payload>`, event `0x02 <u32 len BE> <json>` with `{"t":"accepted","port"}`, `{"t":"closed","port"}`, `{"t":"rejected","port","reason":"forbidden"|"conflict"|"passphrase"}` — never a stream id, passphrase or address. `srt_listen_callback`: reads the stream id, compares it in constant time with the feed of that port, sets `SRTO_PASSPHRASE` + `SRTO_PBKEYLEN 32`, rejects with `SRT_REJX_FORBIDDEN` (unknown id / other port's id) or `SRT_REJX_CONFLICT` (a sender is connected); an address with 20 rejections within 1 min is ignored for 10 min (inside `srtgate`); `--selftest` runs an in-process caller: right pair accepted, wrong passphrase refused, other port's id refused, second sender refused.
- Produces (`srtingest.ts`): `export interface Feed { channelId: string; port: number; streamId: string; passphrase: string }`; `export interface IngestState { channelId; port; state: 'idle' | 'receiving'; since: number | null; bitrate: number | null; rejected1h: number }`; `export class IngestHub { constructor(deps: { spawn(): ChildLike; now(): number; log(m: string): void }); setFeeds(feeds: Feed[]): { listening: number[] }; state(): IngestState[]; receiving(channelId: string): boolean /* data in the last 5 s */; reader(channelId: string): AsyncIterable<Uint8Array> /* starts at the oldest of a 4-s ring */ }` — respawns `srtgate` with backoff on exit and re-sends the set.
- Routes (signed): `PUT /v1/ingest { feeds }` → `{ ok: true, listening }` (atomic replace; ports outside `LIVETV_SRT_PORTS` ignored); `GET /v1/ingest` → `IngestState[]`.

- [ ] **Step 1: Write the failing tests** (`fake-srtgate.mjs` speaks the frame protocol): `setFeeds writes the exact JSON line`; `receiving within 5 s of data, idle after 5 s without` (fake clock); `the reader yields the last 4 s`; `rejections count per feed for one hour`; `a crashed helper is respawned and gets the set again`; `PUT replaces the set` (a removed feed disappears from `GET`); `no log line contains a passphrase, a stream id or an address`; `a push input feeds ffmpeg through stdin`.
- [ ] **Step 2: Run** `npx -w livetv vitest run test/srtingest.test.ts` → FAIL.
- [ ] **Step 3: Implement** the helper, the hub, the routes; `docker build -f livetv/Dockerfile .` runs `--selftest` when Docker is available (else CI).
- [ ] **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): SRT push ingest with per-feed stream id and passphrase`

### Task 30: Live tokens, pinning, `/internal/authz/live`, revocation

**Implementer:** Opus (hard: security) · backend

**Files:**
- Create: `backend/src/livetv/tokens.ts`
- Modify: `backend/src/routes/internal.ts` (`POST /internal/authz/live`), `backend/src/live.ts` (`Live.source` + `'livetv'`), `backend/src/devices.ts:71` and `backend/src/routes/profiles.ts:215` (`revokeLiveTokens` next to `revokeCasts`)
- Test: `backend/test/livetv-tokens.test.ts`

**Interfaces:**
- Produces: `export const LIVE_IDLE_TTL_S = 90; LIVE_TOUCH_MS = 20_000; LIVE_CAP_S = 12 * 3600; MAX_LIVE_TOKENS = 4; VIEW_TTL_S = 45;`; `export interface LiveTokenRec { userId; profileId; deviceId; sidHash: string; channelId: string; channelName: string; kind: 'live'; via: 'local' | 'chromecast' | 'airplay'; remote: boolean; exp: number; createdAt: number }`; `export async function mintLiveToken(ctx: Ctx, rec: Omit<LiveTokenRec, 'exp' | 'createdAt'>): Promise<{ token: string; hash: string; expiresAt: number }>` (32 random bytes base64url; KV `ltv:<hash>` sliding 90 s, cap 12 h; index `ltvidx:<userId>`; a fifth token revokes the oldest; the same device's previous live token is revoked); `export async function revokeLiveToken(ctx: Ctx, hash: string): Promise<void>` (marker `ltvgone:<hash>` 10 min, `clearLive`); `export async function revokeLiveTokens(ctx: Ctx, userId: string, deviceId?: string, exceptDevice?: string): Promise<number>`; `export async function beatLiveToken(ctx: Ctx, token: string, who: { userId: string; sidHash: string; ip: string }): Promise<{ ok: true; expiresAt: number } | { ok: false; status: 410 }>` (slides the TTL; a `local` token re-pins to `ip` when the session matches); `export async function resolveLiveToken(ctx: Ctx, token: string, ip: string, deps: { streamKeyFor(channelId: string): Promise<string | null> }): Promise<{ status: 200; streamKey: string; kind: 'live'; maxAgeS: number } | { status: 401 | 403 | 410 }>` — unknown/expired 401, revoked or stream gone 410, pinned elsewhere / right lost / channel hidden 403 (rights memo 2 s via `channelAllowed`); pins: first address (`ltvpin:<hash>`), `chromecast` one address, `airplay` two within 120 s (the cast rules); touches `ltv:view:<hash>` (45 s, value `channelId`) and `setLive` (ruling 21) at most every 20 s.
- `/internal/authz/live` `{ token: CAST_TOKEN_RE, ip: string 1–64 }` strict, `x-internal-secret`, rate limit off; answers the status with `{ error }` or the 200 body. Task 31 passes the real `streamKeyFor`.

- [ ] **Step 1: Write the failing tests:** `only the hash is stored` (no KV key or value contains the token); `pins and refusals` (other address 403; chromecast one; airplay a second within 120 s, a third refused); `a local token re-pins through a beat from the same session` (Review Focus 4: a beat from the same session at the new address → 200 there; the new address without that beat stays 403, a beat from another session → no re-pin); `idle 90 s` (91 s without touch → 401); `four per account` (the fifth revokes the oldest → 410); `revocation paths` (sign-out via `revokeSessions`, profile switch, device removal, account lock → 410; channel hidden or group right removed → 403 after 2.1 s); `stream gone → 410`; `viewer and live record` (`ltv:view:<hash>` TTL 45, `play:<user>:ltv-<24 hex>` with `source 'livetv'`, title = channel name; second touch within 20 s writes nothing); `never logged` (captured logs have no token substring).
- [ ] **Step 2: Run** `npx -w backend vitest run test/livetv-tokens.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w backend vitest run test/cast.test.ts test/device-signout.test.ts test/profiles.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): live tokens, pinning and gateway authz`

### Task 31: Start, join, stop; `livetvTick`; budget live source; watch routes

**Implementer:** Opus (hard: concurrency, budget) · backend

**Files:**
- Create: `backend/src/livetv/streams.ts`, `backend/src/livetv/encoder.ts`
- Modify: `backend/src/livetv/routes.ts` (watch, beat, stop watching), `backend/src/convbudget.ts` (`countConversions` adds `liveConversions`), `backend/src/convbench.ts` (`runBenchmark` also measures `livetv` when installed → `conv:bench:livetv`), `backend/src/config.ts` + `backend/src/settings/registry.ts` (group `livetv`: `LIVETV_DVR_MINUTES` int 0–120 default 30 with the settings help `adminLive.dvrHint` of spec §20 (DE "0 bis 120 Minuten. 120 Minuten eines HD-Senders brauchen ca. 5 GB Zwischenspeicher; LIVETV_CACHE_MAX_GB (Standard 6) begrenzt alle Sender zusammen."), `LIVETV_MAX_BITRATE` int 1 000 000–40 000 000 default 10 000 000), `backend/src/routes/internal.ts` (real `streamKeyFor`), `backend/src/server.ts` (`livetvTick` every 15 s behind `op()`)
- Test: `backend/test/livetv-streams.test.ts`

**Interfaces:**
- Produces (`encoder.ts`): `export function resolveEncoder(setting: 'auto' | 'qsv' | 'vaapi' | 'nvenc' | 'software', jfHwAccel: string | null, sys: { encoders: Encoder[]; gpu: { readable: boolean } }): Encoder` — spec §5.4; an explicit choice that is not available → `libx264`.
- Produces (`streams.ts`): `export function expectedMode(ch: { streamKind; probe: ProbeRec | null }, now: number): Mode` (hls → passthrough; ts → probe says transcode ? transcode : remux; srt → probe younger than 24 h (ruling 29) ? its `needs` : transcode); `export type WatchError = { status: 503; error: 'live_full'; running: RunningChannel[] } | { status: 503; error: 'provider_limit'; max: number; running: RunningChannel[] } | { status: 502; error: 'channel_unreachable' } | { status: 409; error: 'not_receiving' }`; `export interface RunningChannel { id; number; name; logo: string | null; now?: Prog }`; `export async function startOrJoin(ctx: Ctx, who: { userId; deviceId }, ch: EffectiveChannel, profile): Promise<{ streamKey: string; mode: Mode } | WatchError>` — running → join (no budget); else lock `ltv:start:<channelId>` (setnx 20 s; others wait for the stream and join); push not receiving → 409; provider `max_streams` reached → 503 `provider_limit`; expected transcode → `admitConversion({ kind: 'live', hint: 'live:' + channelId })`, refused → 503 `live_full` with `runningList`; `POST /v1/streams` (decrypted input, `resolveEncoder`, `dvrSeconds`, `LIVETV_MAX_BITRATE`); wait ≤ 15 s for `lastSegmentAt` (poll 500 ms) else stop + 502; reported mode ≠ transcode → `dropConvGrant`; events `start_refused_full`, `start_failed`; `export async function runningList(ctx, user, profile): Promise<RunningChannel[]>` (only channels this profile may see); `export async function streamKeyFor(ctx, channelId): Promise<string | null>`; `export async function viewerCounts(ctx: Ctx, o?: { exceptHash?: string }): Promise<Map<string, number>>` (live tokens touched within 45 s per channel, from `ltv:view:*`; used by the tick and Task 32); `export async function liveConversions(ctx: Ctx): Promise<ConvEntry[]>` (`GET /v1/streams` cached 5 s, mode transcode → `{ kind: 'live', key: 'live:' + channelId, label: channel name }`); `export function invalidateLiveConversions(): void` (drops that cache); `export async function livetvTick(ctx: Ctx): Promise<void>` (lock `ltv:tick` 14 s; viewers per channel from `ltv:view:*`; zero since `ltv:zero:<channelId>` → stop after 60 s; streams nobody watched since a backend restart stop after 60 s too; `bootId` change → `syncIngest`; `rejected1h > 0` → one `push_rejected` event per feed per 10 min; new stream errors → events).
- Routes (`requireUser`, kids allowed):
  - `POST /api/livetv/channels/:id/watch` `{ via?: 'local' | 'chromecast' | 'airplay' }` (rate limit 30/min): not installed → 404 `livetv_off`; no `liveTv` or not in `channelSet` → 403 `forbidden`; unknown → 404; `countLive` minus this device's own live views ≥ `maxStreams` → 429 `{ error: 'max_streams', max }`; `startOrJoin`; `mintLiveToken`; 200 `{ token, url: '/media/l/<token>/index.m3u8', expiresAt, dvrSeconds, mode, channel: { id, number, name, logo }, now, next }`, `cache-control: no-store` (the client writes the last channel itself, Task 33).
  - `POST /api/livetv/beat { token }` → `{ ok: true, expiresAt }` / 410 `gone`; `DELETE /api/livetv/watch { token }` → revoke, `clearLive`.

- [ ] **Step 1: Write the failing tests:**
  - `concurrent first viewers start one stream and take one slot` (Review Focus 1) — SRT channel without a fresh probe, two watches in `Promise.all` → one `POST /v1/streams`, one `conv:grant:live:<id>`, both 200, different tokens, same stream.
  - `a join never touches the budget` — running channel, budget full → 200.
  - `full budget → live_full with only channels this profile may see`.
  - `remux after all releases the slot`.
  - `no first segment within 15 s → 502 and the stream is stopped` (fake clock).
  - `push feed not sending → 409 not_receiving`.
  - `provider limit` — `max_streams 1`, one running from that source → 503 `provider_limit` `max 1`.
  - `max_streams` — friend `maxStreams 2` with two film records → 429; the same device switching channel → 200 and its old token 410.
  - `the tick stops 60 s after the last viewer` — viewer key gone at t; tick at t+59 s no DELETE; at t+61 s DELETE.
  - `the budget counts live transcodes` — fake `/v1/streams` with one transcode and one remux → one `live` entry; a second call within 5 s makes no request; after `invalidateLiveConversions()` it asks again.
  - `the DVR setting reaches livetv` — `LIVETV_DVR_MINUTES 120` → `POST /v1/streams` with `dvrSeconds 7200` and the watch answer's `dvrSeconds 7200`; `121` → settings PUT 400.
  - `resolveEncoder table` (spec §5.4 rows).
  - `bootId change re-syncs the ingest`.
  - `livetv is measured too` — installed → `POST /v1/benchmark { encoder }`, `conv:bench:livetv` stored, recommendation = `recommend` of both.
- [ ] **Step 2: Run** `npx -w backend vitest run test/livetv-streams.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w backend vitest run test/convbudget.test.ts test/convbench.test.ts test/livetv-tokens.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): start, join and stop shared streams within the budget`

### Task 32: Release the old stream on a channel switch

**Implementer:** Opus (hard: races between a release and a join) · backend

**Files:**
- Modify: `backend/src/livetv/streams.ts` (`startOrJoin` switch path, `releasableOld`, `releaseForSwitch`, the wait on `ltv:stopping:`), `backend/src/convbudget.ts` (`countConversions(ctx, o?: { exceptUser?; exceptDevice?; exceptLive?: string })` leaves out the entry `live:<exceptLive>` and its grant; `admitConversion(ctx, o: { …; exceptLive?: string })` passes it through, ruling 37), `backend/src/livetv/tokens.ts` (`deviceLiveView`)
- Test: `backend/test/livetv-switch.test.ts`

**Interfaces:**
- Consumes: `startOrJoin`, `viewerCounts`, `invalidateLiveConversions`, `expectedMode`, `runningList` (Task 31); `admitConversion`, `dropConvGrant` (Task 1); `mintLiveToken` index `ltvidx:<userId>` (Task 30); `pushEvent` (Task 16).
- Produces (`tokens.ts`): `export async function deviceLiveView(ctx: Ctx, userId: string, deviceId: string): Promise<{ hash: string; channelId: string } | null>` (the device's current live token, ruling 36).
- Produces (`streams.ts`): `export async function releasableOld(ctx: Ctx, who: { userId: string; deviceId: string }, target: EffectiveChannel): Promise<{ channelId: string; sourceId: string; mode: Mode; hash: string } | null>` — the device's live view is on another channel A that is running, `viewerCounts(ctx, { exceptHash: hash }).get(A)` is 0 (casts and admin test previews are tokens too, so they count), and `recordingUses(A)` is false (always false until Phase 3, ruling 38); `export async function releaseForSwitch(ctx: Ctx, old: { channelId: string; hash: string }): Promise<boolean>` — `setnx ltv:stopping:<A>` 20 s (held → false); recount viewers except `hash` (> 0 → delete the marker, false); `DELETE /v1/streams/<A>` (404 tolerated), `dropConvGrant(ctx, 'live:' + A)`, delete `ltv:zero:<A>`, `invalidateLiveConversions()`, `pushEvent({ level: 'info', code: 'released_on_switch', channelId: A })`, delete the marker → true.
- `startOrJoin` (Task 31) gains, only when B is not running: `old = await releasableOld(…)`; the provider check counts B's source's running streams without A when `old` is on the same source; the budget check calls `admitConversion({ kind: 'live', hint: 'live:' + B, exceptLive: old?.mode === 'transcode' ? A : undefined })`; when a check passed **only** because A was left out (the same check with A counted would refuse; decided under the same `conv:gate` lock), `releaseForSwitch` runs before `POST /v1/streams` for B; `false` → `dropConvGrant('live:' + B)` and the refusal the switch would have had (`provider_limit` / `live_full`). Otherwise A is untouched (60-s linger). A `startOrJoin` (join or start) for a channel whose `ltv:stopping:` marker exists polls every 200 ms for ≤ 5 s, then treats it as not running.

- [ ] **Step 1: Write the failing tests** in `backend/test/livetv-switch.test.ts` (fake `livetv` records the order of `DELETE` and `POST /v1/streams`; fake clock):
  - `zapping on a 1-connection provider releases the old stream at once` (Review Focus 7) — source `max_streams 1`, Anna's TV is the only viewer of *Hafenkanal* (A) → watch *Nordlicht TV* (B, same source) → `DELETE /v1/streams/A` before `POST` B, 200, event `released_on_switch`; back to A within 3 s → 200 again (B released); no 60-s wait anywhere.
  - `a budget of 1 releases the old transcode` — `CONVERSION_SLOTS 1`, A transcode, B expected transcode → A deleted, one `conv:grant:live:B`, no `conv:grant:live:A`; `countConversions` right after lists only B.
  - `no release when someone else watches the old channel` — Ben's token on A touched 10 s ago → no DELETE, 503 `provider_limit` `max 1` for Anna; with Ben's token 50 s old (not a viewer) → released.
  - `a cast of the old channel counts as a viewer` — A also cast to the living-room TV (`via 'chromecast'` token) → no release.
  - `a viewer counted before the recount keeps the stream` (Review Focus 6) — Ben's watch on A lands between the admission and the recount (test hook) → no DELETE, Anna gets 503, Ben 200 on the running A, no `ltv:stopping:` key left.
  - `a viewer who joins during the release never gets a dead stream` (Review Focus 6) — Ben's watch on A arrives after the marker is set → it waits, then starts A through the normal path: on a 1-connection provider (B now holds it) Ben gets 503 `provider_limit` with B in `running`; with `max_streams 2` Ben gets 200 and a second `POST /v1/streams` for A after its DELETE.
  - `not needed → the old stream lingers` — free budget and no provider limit → no DELETE at the switch; the tick deletes A 60 s later.
  - `a remux old stream is not released for the budget` — A remux, B transcode, budget full → 503 `live_full`, A untouched.
  - `a running target is a join, never a release` — B already running → 200, A untouched.
  - `the old token is still replaced` — after the switch Anna's old token answers 410 at authz.
- [ ] **Step 2: Run** `npx -w backend vitest run test/livetv-switch.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w backend vitest run test/livetv-streams.test.ts test/convbudget.test.ts test/livetv-tokens.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): release the old stream at once when a switch needs its slot`

### Task 33: Channel list, ordered favourites, *Zuletzt gesehen*, last channel, TV start, admin stop

**Implementer:** Sonnet (routine) · backend

**Files:**
- Modify: `backend/src/livetv/routes.ts`, `backend/src/livetv/adminRoutes.ts` (`PATCH /api/admin/devices/:userId/:deviceId { startLive }`), `backend/src/routes/admin.ts:391` (`GET /api/admin/devices` rows gain `startLive`), `backend/src/routes/auth.ts` (`/api/me.startLive`, ruling 14)
- Test: `backend/test/livetv-user.test.ts`

**Interfaces:**
- `GET /api/livetv/channels` → spec §10 user table shape: `{ groups: [{ id, name }], channels: [{ id, number, name, logo, groupId, running, receiving?, epg: 'ok' | 'gap' | 'none' /* ruling 58 */, preview?, now?, next?, favourite }], favourites: string[] /* by position */, recent: string[] /* newest first, ≤ 10 */, last: { id, previous } | null /* recent[0], recent[1] */, dvrSeconds }` — only `channelSet` channels (also in `favourites` and `recent`), groups in position order, `preview` = `/api/livetv/channels/<id>/preview.jpg` only while running, `receiving` for push feeds from `GET /v1/ingest`; `ETag` (sha1 of the body) and `304` on `If-None-Match`.
- `GET /api/livetv/channels/:id/preview.jpg` → proxied JPEG while running and allowed (`max-age=60`), else 404.
- `PUT /api/livetv/favourites { ids }` (the complete order: positions 0…n−1 for the given current favourites; ids that are not favourites → 400 `invalid`; favourites missing from `ids` — e.g. hidden by a lost right — keep their relative order after the given ones), `POST /api/livetv/favourites/:id` (appends: `max(position) + 1`), `DELETE …/:id`; a favourite the profile can no longer see is hidden, not deleted.
- `PUT /api/livetv/last { id }` → upsert `livetv_recent (profile, id, at = now())` and delete the profile's rows beyond the newest 10, in one statement pair inside a transaction (ruling 45); the channel must be in `channelSet` (else 403).
- `PATCH /api/admin/devices/:userId/:deviceId { startLive: boolean }` → 400 `not_tv` unless `deviceId` starts with `tv-`; audit `device.start_live`.

- [ ] **Step 1: Write the failing tests:** `the list shape` (now/next, running + preview, receiving for a push feed, favourite flags); `epg states` (mapped with a programme now → `ok`; mapped, last programme ended 19:00, at 20:30 → `gap` without `now`; unmapped → `none`); `ETag 304`; `favourites per profile; hidden ones come back with the right`; `favourites order round-trip` (PUT `[c, a, b]` → list answer `favourites [c, a, b]`; a new favourite goes last; an unknown id → 400); `recent keeps the 10 newest` (12 watches → 10 rows, newest first; re-watching the 5th moves it to the front without a duplicate); `last and previous` (from `recent[0]`/`recent[1]`; A, B, A → last A, previous B); `recent hides channels the profile cannot see` (and shows them again with the right); `preview 404 when not running`; `startLive only for TVs` (phone → 400; TV → `/api/me.startLive true` when installed and the profile sees a channel); `a kids profile lists kid-friendly channels only`.
- [ ] **Step 2: Run** `npx -w backend vitest run test/livetv-user.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(livetv): channel list, ordered favourites, recently watched and TV start`

### Task 34: Gateway `/media/l/<token>/<file>`

**Implementer:** Opus (hard: gateway authorization) · gateway

**Files:**
- Modify: `gateway/src/gateway.ts` (`LIVE_ROUTE`, `handleLive`, dispatched in `handle()` before the "no media server yet" check at line 417; `authorizeLive`; metrics), `gateway/src/server.ts` (`livetvUrl: optional(process.env, 'LIVETV_URL') ?? 'http://livetv:8090'`), `GatewayOptions.livetvUrl`
- Test: `gateway/test/live.test.ts`

**Interfaces:**
- `const LIVE_ROUTE = /^\/media\/l\/([A-Za-z0-9_-]{43})\/(index\.m3u8|init\.mp4|[0-9]{1,10}\.(?:ts|m4s))$/` — GET/HEAD/OPTIONS only; any query string → 403.
- `authorizeLive(token, ip)` → `POST /internal/authz/live { token, ip }`, memo 2 s keyed `sha256(token)|ip` (never the raw token), backend failure → 503 not memoised; failing tokens counted with the cast `noteFail` limiter.
- Forward `GET ${livetvUrl}/s/<streamKey>/<file>` with no client headers; playlists ≤ 2 MB; answer types allowlisted (`application/vnd.apple.mpegurl`, `video/mp2t`, `video/mp4`); `cache-control: no-store` for `index.m3u8`, `private, max-age=600` for segments and `init.mp4`; `CAST_CORS` on every answer; 401/403/410 from authz passed through; `livetv` 404 → 404, unreachable → 503.
- Metrics: `friendflix_gateway_live_requests_total{code="…"}` only. No log line per request (ruling 12).

- [ ] **Step 1: Write the failing tests:** `path allowlist` (`/media/l/<t>/../x`, `index.m3u8?x=1`, `12345678901.ts`, `seg.ts` → 403/404, nothing forwarded); `the token never reaches livetv` (fake livetv sees only `/s/<key>/<file>`, no header carries the token); `authz memo 2 s` (two fetches within 2 s → one authz; after 2.1 s → two); `headers per file type` (+ CORS); `410 passes through`; `works while the media server is not set up` (no 503); `metrics carry only code labels`; `the gateway prints nothing` (console spies stay empty).
- [ ] **Step 2: Run** `npx -w gateway vitest run test/live.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w gateway vitest run test/gateway.test.ts test/failures.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(gateway): /media/l live stream route`

### Task 35: Web live model, `livekeys.ts` (OK, long OK, lone 0), number entry, keys seen, compat scan

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/live/{api.ts,order.ts,order.test.ts,livekeys.ts,livekeys.test.ts,longok.ts,longok.test.ts,keyhints.ts,keyhints.test.ts,numberEntry.ts,numberEntry.test.ts,compat.test.ts}`, `web/src/lib/i18n/locales/<lang>/live.ts` (seven)
- Modify: `web/src/lib/capabilities.ts` (`Features.livetv`; `featuresFrom`: only an explicit `true`), `web/src/lib/api.ts:118` (`Me.features.livetv?`, `Me.startLive?`), `web/src/lib/webos/keys.ts` (`457: 'Info'`; `33`/`34` → `PageUp`/`PageDown` when `e.key` is `Unidentified`), locale `index.ts` files
- Test: the files above

**Interfaces:**
- Produces (`api.ts`): types of Task 33's list and Task 31's watch answer (`LiveChannel`, `LiveList`, `WatchAnswer`, `RunningChannel`, `Prog`) and calls `channels(etag?)`, `watch(id, via?)`, `beat(token)`, `stopWatching(token, keepalive: boolean)`, `setLast(id)`, `favourite(id, on)`, `setFavouriteOrder(ids: string[])` (`LiveList` carries `favourites`, `recent`, `last`; `LiveChannel.epg: 'ok' | 'gap' | 'none'`, ruling 58); `export function nowLines(c: LiveChannel): { now: string; next: string | null }` (the two reserved lines by state: `none` → "Live" / "Kein Programm verfügbar", `gap` → `live.gap` / null, push not receiving → `live.notReceiving` / null, else the programmes) — used by the list, the banner and the panel.
- Produces (`livekeys.ts`): `export type LiveKeyAction = { type: 'chUp' } | { type: 'chDown' } | { type: 'showControls' } | { type: 'channelList' } | { type: 'toggle' } | { type: 'seek'; by: number } | { type: 'live' } | { type: 'info' } | { type: 'last' } | { type: 'digit'; d: number } | { type: 'enter' } | { type: 'close' } | { type: 'controls'; focus: 'back30' | 'fwd30' } | { type: 'volume'; delta: number } | { type: 'mute' } | { type: 'fullscreen' }`; `export function resolveLiveKey(e: KeyInput, c: { tv: boolean; lg: boolean; controlsVisible: boolean; onBody: boolean; overlayOpen: boolean; numberOpen: boolean }): LiveKeyAction | null` — spec §12.3 table as updated 2026-11-12: on TV, Enter/OK with the controls hidden → `showControls` (never `toggle`; the long variant is `createLongOk`'s, the caller only passes short presses here), with the controls visible → null (the focused button handles it); `MediaPlayPause` → `toggle`; `ChannelList` and `Guide` → `channelList` (ruling 51); ▲/▼ with the controls hidden → `chUp`/`chDown` on every TV; PageUp/PageDown → channel keys only when they arrive; Backspace never `last` (`isBackKey` keeps its meaning); `keymap.ts` stays untouched for films.
- Produces (`longok.ts`, ruling 50): `export const LONG_OK_MS = 600;` `export function createLongOk(o: { ms?: number; timers: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }; onShort(): void; onLong(): void }): { down(e: { repeat: boolean }): void; up(): void; cancel(): void }` — the first keydown starts the timer, repeats are ignored, `onLong` fires once at 600 ms while held (the keyup after it does nothing), a keyup before it fires `onShort`.
- Produces (`keyhints.ts`, ruling 52): `export type SeenKey = 'channel' | 'digit' | 'colour' | 'info';` `export function classify(key: string): SeenKey | null` (`ChannelUp`/`ChannelDown`/`PageUp`/`PageDown` → channel, `0`–`9` → digit, `ColorF0Red`…`ColorF3Blue` → colour, `Info` → info); `export function noteKey(key: string, store?: StorageLike): Set<SeenKey>` (adds and persists `ff-live-keys-seen` as a JSON array; any storage error is swallowed); `export function seenKeys(store?: StorageLike): Set<SeenKey>`; `export function hintKeys(where: 'list' | 'player', seen: Set<SeenKey>): TKey[]` (list: `live.tvHint.ok`, `live.tvHintFav`, + `live.tvHint.chJump` when `channel`, + `live.tvHint.zeroLast` when `digit`; player: `live.tvHint.longOkList`).
- Produces (`order.ts`): `export type LiveFilter = 'all' | 'fav' | 'recent' | string /* group id */;` `export function channelOrder(list: LiveChannel[], filter: LiveFilter, favourites: string[], recent: string[]): LiveChannel[]` (groups and `all` by number, ties by group position; `fav` in the `favourites` order; `recent` in the given `recent` order — the caller passes the snapshot taken when the filter was chosen, ruling 46); `export function neighbour(list: LiveChannel[], id: string, dir: 1 | -1): LiveChannel` (wraps).
- Produces (`numberEntry.ts`): `export const NUMBER_TIMEOUT_MS = 2000; NUMBER_MAX_DIGITS = 5;` `export interface NumberState { digits: string; match: LiveChannel | null; unique: boolean; zero: boolean /* exactly "0" so far */ }`; `export function typeDigit(s: NumberState, d: number, list: LiveChannel[]): NumberState`; `export function commitNumber(s: NumberState, list: LiveChannel[]): { kind: 'channel'; channel: LiveChannel } | { kind: 'last' } | { kind: 'none'; text: string }` (duplicates → lowest group position; a lone "0" → `last` (ruling 53); leading zeros ignored, "05" → channel 5).
- `compat.test.ts`: reads every file under `web/src/lib/live/` and `web/src/routes/live/` (and, from Task 37 on, the TV files it names) and fails on `structuredClone(`, `.at(`, `Object.hasOwn(`, `.findLast(`, `aspect-ratio`, `inset:`, `:has(`, `@container`.
- Copy: the Phase 1 rows of spec §20 — `shell.nav.live`/`shell.tabs.*` go to `shell.ts` (Task 36), `live.title`, `favourites`, `all`, `favouritesChip`, `now`, `next`, `noEpg`, `liveOnly`, `favourite`, `unfavourite`, `player.*`, `full.*`, `providerLimit`, `tvHintFav`, `notReceiving` into `live.ts`, plus `live.player.info` DE "Programm" EN "Programme", `live.player.noChannel` used by `commitNumber`, and the 2026-11-12 rows of spec §20 with their DE and EN text: `live.player.restart`, `live.player.channelList`, `live.timeLeft`, `timeLeftLong`, `endingNow`, `live.recentChip`, `live.number.last`, `live.number.noLast`, `live.fav.*`, `live.tvHint.*` (`live.player.pauseTooLong` with `{n}`), and `live.gap` DE "Programm gerade nicht verfügbar" EN "Programme not available right now". Guide and recording keys wait for Phases 2/3.

- [ ] **Step 1: Write the failing tests:** `resolveLiveKey` table (desktop: ArrowUp / PageUp → `chUp`, ArrowDown / PageDown → `chDown`, Space/K → `toggle`, ←/→ `seek ±10`, J/L `seek ±30`, End → `live`, I → `info`, Q → `last`, digit → `digit`, Enter with `numberOpen` → `enter`, Backspace → null; TV: ChannelUp → `chUp`, ArrowUp with controls hidden → `chUp`, with controls visible → null, **Enter with controls hidden → `showControls` (never `toggle`)**, MediaPlayPause → `toggle`, `ChannelList` → `channelList`, `Guide` → `channelList`, ◀ with controls hidden → `controls back30`, MediaRewind → `seek −30`, PreviousChannel → `last`, Info → `info`; LG: ColorF0Red → `last`, ColorF3Blue → `live`, ArrowUp → `chUp` without any PageUp ever seen); `createLongOk` (keyup at 300 ms → short; held 600 ms → long once, the keyup after it nothing; key repeats ignored); `keyhints` (fresh storage → list hints `ok` + `tvHintFav` only; after `noteKey('ChannelDown')` → + `chJump`, also from a new `seenKeys()` read; a throwing storage → D-pad hints, no exception); `channelOrder` (`fav` follows the given order, `recent` the given snapshot) and `neighbour` wrap; number entry ("1","2" unique → match; "12" without a channel → `{ kind: 'none', text: 'Kein Sender 12' }`; "0" alone → `{ kind: 'last' }`; "0","5" → channel 5; a sixth digit ignored; duplicate number → lowest group position); webOS `457` → `Info`; `featuresFrom({})` has `livetv false`, `{ livetv: true }` → true; `nowLines` per state (`ok`, `gap`, `none`, push not receiving); compat scan passes on the new files.
- [ ] **Step 2: Run** `npx -w web vitest run src/lib/live src/lib/webos/keys.test.ts src/lib/capabilities.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/i18n/i18n.test.ts src/lib/player/keymap.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(web): live TV model, key map, long OK, key hints and number entry`

### Task 36: Web `/live` on desktop and phone, navigation entries

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/routes/live/+page.svelte`, `web/src/lib/live/{LiveList.svelte,ChannelRow.svelte,FavTiles.svelte,GroupChips.svelte,progress.ts,progress.test.ts}`, `e2e/mocks/livetv.ts` (channel list, watch/beat/stop, a sliding live playlist without `ENDLIST` built from `HLS_SEGMENTS`), `e2e/tests/live-tab.spec.ts`, `e2e/tests/live-tab.mobile.spec.ts`
- Modify: `web/src/lib/menu.ts:44,56` (after *Filme*: `HEADER_TABS` gains `['/live', 'shell.nav.live']`, `TV_RAIL` gains `['/live', 'shell.nav.live', 'tv']`, both through `export function liveTabs<T extends [string, ...unknown[]]>(tabs: T[], entry: T, on: boolean): T[]`), `web/src/lib/phone/logic.ts:57` (`phoneTabs(canDownload, live: boolean)`; `live` between *Neu* and *Merkliste* (`shell.tabs.myList`, the current label; ruling 54), key `'live'`, icon `tv`), `web/src/lib/phone/TabBar.svelte:30`, the phone chip bar under the header (`*Live-TV*` after *Filme*), `web/src/routes/+layout.svelte` (passes `$features.livetv`), locales `shell.ts` (`nav.live`, `tabs.live`, `tabs.liveShort`), `web/src/lib/menu.test.ts`, `web/src/lib/phone/logic.test.ts`
- Test: the files above

**Interfaces:**
- Consumes: `api.ts`, `channelOrder` (Task 35), `features.livetv`.
- Produces (`progress.ts`): `export function progressAt(p: Prog, now: Date): number` (0–1, minute steps); `export function timeLeft(p: Prog | undefined, now: Date): { key: 'live.timeLeft'; n: number } | { key: 'live.timeLeftLong'; h: number; m: number } | { key: 'live.endingNow' } | null` (minutes rounded up; ≥ 60 → long form; < 1 → `endingNow`; no programme → null; spec §12.1); `export function rowName(c: LiveChannel, now: Date): string` (spec §21 "{number} {name}, jetzt: {title}, bis {time}").
- Behaviour: spec §11.1/§11.2 — favourites row (≤ 12 in the person's order, 16:9 `.frost-tile`, preview only while running, else the logo on the glass; number + name, programme title with the time left right-aligned in a reserved, tabular-figure slot, 3-px progress `scaleX`; the row head leaves the slot for Task 38's *Ordnen*), group chips (*Alle*, *Favoriten*, *Zuletzt gesehen* when `recent` is not empty — newest first —, groups; `SlidePill`; `aria-pressed`), two-column grid of 72-px rows with both lines always reserved (`epg 'none'`: "Live" / "Kein Programm verfügbar"; `epg 'gap'`: "Programm gerade nicht verfügbar"; push not sending: "Gerade keine Übertragung"), 44-px star (`aria-pressed`), skeleton rows of the final height, logos fade in by opacity; phone: carousel favourites (`Carousel.svelte`), sticky chips, one-column 64-px rows, *Danach* moves to the info panel; 30-s refresh with `ETag`. Tab hidden unless `features.livetv`.

- [ ] **Step 1: Write the failing tests** — unit: `progressAt` (20:15–21:00 at 20:30 → 0.333…, minute steps), `timeLeft` (20:15–21:00 at 20:37:10 → `{ key: 'live.timeLeft', n: 23 }`; 19:00–21:00 at 19:40 → `{ h: 1, m: 20 }`; at 20:59:30 → `endingNow`; no programme → null), `rowName`, `liveTabs`, `phoneTabs(true, true)` order `home, new, live, myList, downloads` (labels "Start", "Neu", "Live", "Merkliste", "Downloads"); e2e (German): `no tab without features.livetv`; `desktop layout` (favourites row, chips filter to *Kinderinsel*, two columns, *Jetzt*/*Danach* lines, "Kein Programm verfügbar", "Programm gerade nicht verfügbar" for a `gap` channel, "Gerade keine Übertragung"); `star toggles` (POST then DELETE); `Zuletzt gesehen lists the recent channels newest first` (chip absent with `recent []`); `tiles show noch 23 Min. and a minute later noch 22 Min. without moving` (`page.clock`; tile text boxes equal); `a row opens the player` (`/live/watch/<id>`); `now/next arriving moves nothing` (row bounding boxes equal before and after); mobile: compact list, carousel, five tabs fit 320 px with "Live".
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/live/compat.test.ts src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(web): the Live-TV tab on desktop and phone`

### Task 37: Web `/live` on TVs (hint line, D-pad path) and for kids, *TV startet mit Live-TV*

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/live/{TvLiveList.svelte,KidsLive.svelte,NumberCard.svelte,TvHintLine.svelte}`, `e2e/tests/live-tv.spec.ts`, `e2e/tests/live-kids.spec.ts`
- Modify: `web/src/routes/live/+page.svelte` (`html.tv` and kids branches; `?play=last`), `web/src/routes/kids/+page.svelte` (kids header *Fernsehen* when `features.livetv`), `web/src/routes/tv/+page.svelte:39` (`me.startLive` → `location.replace('/live?play=last')`), `web/src/routes/admin/devices/+page.svelte` (*TV startet mit Live-TV* toggle on `tv-` devices → PATCH), locales (`kids.nav.live`, `adminDevices.startLive` in the admin devices area file), `web/src/lib/live/compat.test.ts` (scan also `web/src/routes/tv/+page.svelte`)
- Test: the files above

**Interfaces:**
- Consumes: `resolveLiveKey`, `createLongOk`, `noteKey`/`seenKeys`/`hintKeys`, `typeDigit`/`commitNumber` (Task 35), `PATCH /api/admin/devices/…` and `/api/me.startLive` (Task 33).
- Behaviour: spec §11.3 as updated 2026-11-12 — favourites row (16:9 tiles 360 px wide at 1080p), focusable chip row, 96-px rows (72-px logo, text ≥ 28 px), focus `scale(1.08)` + 3-px ring, focused row kept in the middle third; ▲/▼ move (held: repeat), ◀ opens the rail, OK watches, ▶ moves focus to the row's star (OK toggles, ◀ back), long OK ≥ 600 ms (`createLongOk`) toggles favourite as a shortcut; ChannelUp/ChannelDown (when the remote sends them) jump 8 rows; digits open `NumberCard` and focus the matched row on OK; a lone 0 focuses the last watched row (card "0 · Letzter Sender: 4 Hafenkanal"); Info opens the info panel; every keydown goes through `noteKey`; `TvHintLine` shows `hintKeys('list', seenKeys())` in a footer of reserved height; entering `/live` focuses the last watched row (also after Back from the player: the player committed `PUT /last`, so `last` is the playing channel); `/live?play=last` opens the last channel's player (list when none); Back from that player → `/live`, Back from the list → `/`. Spec §11.4 kids: solid panels, big tiles (logo + name + *Jetzt* title), long press / long OK favourite.

- [ ] **Step 1: Write the failing tests** — e2e TV (`?tv=1`): `spatial navigation and ChannelDown jumps 8 rows`; `the hint line names only keys this device sent` (fresh storage: "OK: ansehen · Lang OK: Favorit", no "CH ▲▼"; after one ChannelDown keydown: "CH ▲▼: 8 Zeilen" appears without moving the list; after a reload it is still there; a digit adds "0: letzter Sender"); `D-pad only: ▶ star and OK toggle favourite` (no long press used); `digits 4 then OK focus Hafenkanal`; `a lone 0 focuses the last watched row`; `long OK toggles favourite`; `entering focuses the last channel`; `play=last opens the player and Back returns to the list, Back again goes home`; kids: `only kid-friendly tiles, long press favourite`; `/tv with startLive replaces to /live?play=last`; admin devices: `the toggle sends { startLive: true } for a TV only`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/live/compat.test.ts`; `E2E_PORT=4331 … npx playwright test tests/tv-layout.spec.ts --trace off`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(web): Live-TV on TVs and for kids, TV starts with Live-TV`

### Task 38: Web — *Favoriten ordnen* (drag, keyboard, TV move mode)

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/live/{FavOrderSheet.svelte,favOrder.ts,favOrder.test.ts}`, `e2e/tests/live-favorder.spec.ts`
- Modify: `web/src/lib/live/FavTiles.svelte` (*Ordnen* in the row head, shown with ≥ 2 favourites), `web/src/lib/live/TvLiveList.svelte` (*Ordnen* focusable in the favourites row head), `web/src/lib/live/KidsLive.svelte` (same button), locales `live.ts` (`live.fav.*` from spec §20 if Task 35 left any out)
- Test: the files above

**Interfaces:**
- Consumes: `DragState`, `pick`, `move`, `drop`, `cancel`, `flipOffsets` (`#lib/ui/dragOrder`, Task 24); `setFavouriteOrder` (Task 35); `PUT /api/livetv/favourites` (Task 33).
- Produces (`favOrder.ts`): `export type TvOrderKey = 'ok' | 'up' | 'down' | 'back';` `export function tvOrderKey(s: { drag: DragState; focus: number }, key: TvOrderKey): { drag: DragState; focus: number; close: boolean; announce: { key: TKey; params: Record<string, string | number> } | null }` — nothing picked: ▲/▼ move the focus, OK picks the focused row (`live.fav.orderPicked`), Back closes; picked: ▲/▼ move it (`orderMoved`), OK drops (`orderDropped`), Back cancels the move (`orderCancelled`) and a second Back closes.
- Behaviour: spec §11.1 — `FavOrderSheet` (glass sheet, `sheetSlide`; TV panel) lists the favourites (logo, number, name) with drag handles: pointer and touch drag, the lifted row by `transform`, the others FLIP with `transform`; keyboard on desktop: Space picks up, ↑/↓, Space drops, Escape cancels; announcements in a polite live region; *Fertig* → `setFavouriteOrder(ids)` with `runAction` (undo toast puts the old order back); on TV each drop saves at once the same way (no button to reach below a long list), Back only closes — the favourites row, the *Favoriten* chip and player zapping in *Favoriten* use the new order at once; calm / reduced motion / TV / kids: no transitions.

- [ ] **Step 1: Write the failing tests** — unit `tvOrderKey`: focus 0, ▼ → focus 1; OK → picked (announce "Hafenkanal aufgenommen, Position 2 von 4"); ▲ → order changed, "Position 1 von 4"; OK → dropped; picked + Back → original order, `close false`; Back again → `close true`. e2e: `mouse drag reorders and Fertig saves` (PUT body `{ ids: [c, a, b] }`, the favourites row shows the new order); `keyboard Space ↓ Space saves`; `Escape cancels the move`; `TV move mode: OK ▼ OK saves at the drop, Back closes` (`?tv=1`; one PUT after the drop); `undo restores the old order`; `the button is absent with one favourite`; `reduced motion has no transitions` (computed `transition-duration` `0s`).
- [ ] **Step 2: Run** `npx -w web vitest run src/lib/live/favOrder.test.ts` and the e2e spec → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/ui/dragOrder.test.ts src/lib/live/compat.test.ts src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(web): arrange favourite channels by drag, keyboard and remote`

### Task 39: Web `LivePlayer` (DVR, info banner, *Von Anfang an*, switching, states)

**Implementer:** Opus (hard: player, timers, error recovery) · frontend

**Files:**
- Create: `web/src/lib/live/{LivePlayer.svelte,InfoPanel.svelte,InfoBanner.svelte,FullSheet.svelte,liveState.ts,liveState.test.ts,dvr.ts,dvr.test.ts,banner.ts,banner.test.ts,switcher.ts,switcher.test.ts}`, `web/src/routes/live/watch/[channelId]/+page.svelte`, `e2e/tests/live-player.spec.ts`, `e2e/tests/live-player.mobile.spec.ts`
- Modify: `web/src/lib/player/hls.ts` (`export function liveHlsConfig(dvrSeconds: number, tv: boolean): Partial<HlsConfig>` — `liveSyncDurationCount 3`, `liveMaxLatencyDurationCount 10`, `backBufferLength = min(dvrSeconds, tv ? 300 : 1800)` (ruling 47), the existing load policies), `web/src/lib/player/timing.ts` + `backend/src/playtiming.ts` (`mode: 'live'`, first-frame time only, allowlisted), locales `live.ts`
- Test: the files above

**Interfaces:**
- Consumes: `api.ts`, `resolveLiveKey`, `channelOrder`, `neighbour`, `typeDigit`/`commitNumber` (Task 35); `progressAt`, `timeLeft` (Task 36); the existing `loadHls`, `volume.ts`, `gestures.ts` (zones), `mediasession.ts`, `firstframe.ts`, `TvControls` style, `playerBack`.
- Produces (`liveState.ts`): `export type LiveUi = { k: 'starting' } | { k: 'playing' } | { k: 'buffering' } | { k: 'lost'; attempt: number } | { k: 'retry' } | { k: 'notReceiving' } | { k: 'full'; running: RunningChannel[] } | { k: 'providerLimit'; max: number; running: RunningChannel[] } | { k: 'forbidden' } | { k: 'maxStreams'; max: number }`; `export function fromWatchError(status: number, body: unknown): LiveUi`; `export function lostDelay(attempt: number): number` (2, 4, 8, 16, 30, 60 s; after 2 min total → `retry`); stall > 8 s → `lost`.
- Produces (`dvr.ts`): `export function behind(video: { currentTime: number }, liveEdge: number): number`; `export function atEdge(behindSec: number): boolean` (≤ 6 s); `export function resumePoint(pausedSec: number, dvrSeconds: number, oldest: number): { at: number; tooLong: boolean }` (`tooLong` → toast `live.player.pauseTooLong` with `n = dvrSeconds / 60`); `export interface Oldest { pdt: number /* epoch ms */; time: number /* media time */ }`; `export function oldestPoint(src: { hls?: { levels: Array<{ details?: { fragments: Array<{ programDateTime: number | null; start: number }> } }>; currentLevel: number } | null; video: { seekable: TimeRanges; getStartDate?(): Date } }): Oldest | null` (hls.js: first fragment of the current level; Safari: `getStartDate()` + `seekable.start(0)`); `export function restartTarget(progStart: number, o: Oldest | null): number | null` (null when `o` is null or `progStart < o.pdt`; else `o.time + (max(o.pdt, progStart − 30 000) − o.pdt) / 1000`, ruling 48).
- Produces (`banner.ts`): `export const BANNER_HOLD_MS = 4000;` (ruling 49) `export function bannerVisible(s: { starting: boolean; switchingAt: number | null; firstFrameAt: number | null; controlsVisible: boolean; error: boolean }, now: number): boolean` — `error` → false; `controlsVisible` or `starting` → true; else true until `firstFrameAt + 4000` after the latest switch (a switch with no first frame yet keeps it).
- Produces (`switcher.ts`): `export function createSwitcher(o: { delayMs: 400; onCard(c: LiveChannel): void; onCommit(c: LiveChannel): void; timers }): { press(dir: 1 | -1): void; jump(c: LiveChannel): void; dispose(): void }` (the banner follows each press at once via `onCard`; one commit 400 ms after the last).
- Behaviour (spec §12 as updated 2026-11-12): no seek bar; Play/Pause (white disc), *Von Anfang an* (reserved slot; shown while `restartTarget(now.start, oldestPoint(…))` is not null, re-checked each minute and on each playlist update; seeks there), −30 s, +30 s (disabled at the edge), LIVE pill (filled coral with a dot at the edge; outlined "−12:30" behind; jumps to live), channel ▲/▼ with the neighbour's name as tooltip, a reserved slot for Task 40's *Senderliste* button, *Programm*, *Abspielen auf…*, volume, fullscreen; top: logo, number + name, programme, "20:15–21:00" and `timeLeft` (tabular figures, reserved width), thin progress line; info panel (sheet on phone, side panel on desktop, TV panel) with time left, *Von Anfang an*, *Letzter Sender* ("Zurück zu 4 Hafenkanal"); `InfoBanner` (spec §12.2: logo, number + name, *Jetzt* + progress + time left, *Danach*, or `nowLines` for the `gap` / `none` / not-sending states; both lines reserved; opacity fade, none in calm / reduced motion / TV / kids; `aria-hidden`, the polite announcement carries the text) driven by `bannerVisible`, replacing the old 1-s card; zapping order by `channelOrder` of the filter the list was on (passed in the URL `?f=`; *Zuletzt gesehen* uses the snapshot taken on open); `PUT /api/livetv/last` on each committed switch; beat every 20 s while open (playing or paused), 410 → one new watch; `DELETE /api/livetv/watch` with `keepalive` on `pagehide` and close; the token lives in memory only; `not_receiving` polls watch every 10 s and starts by itself; announcements of spec §21; the Windows app uses this player in WebView2 unchanged.

- [ ] **Step 1: Write the failing tests** — unit: `fromWatchError` per code, `lostDelay` sequence and the 2-min switch to `retry`, `resumePoint` with a 40-min pause → `tooLong`, `switcher` (three presses within 400 ms → three banners, one commit), `restartTarget` (oldest pdt 20:00:00 at media 100 s, programme 20:15 → 100 + 870 = 970; programme 20:00:10 → 100 (clamped to the oldest); programme 19:59 → null), `oldestPoint` from a fake hls level and from Safari's `getStartDate`, `bannerVisible` (starting → true; first frame at t → true at t+3 999, false at t+4 000; controls visible → true; error → false), `liveHlsConfig caps the back buffer on TVs` (Review Focus 8: `(7200, true)` → 300, `(7200, false)` → 1800, `(120, true)` → 120); e2e (mock live HLS): `starts and plays` (`currentTime` advances); `pause shows the behind pill and LIVE returns to the edge`; `−30 s`; `the banner shows on a switch and fades 4 s after the first frame` (`page.clock`; no layout shift: the control bar box is equal before, during and after); `Von Anfang an appears when the programme start is in the buffer and seeks there` (mock playlist with `PROGRAM-DATE-TIME`, programme started 5 min ago, DVR 30 → button; click → LIVE pill "−5:30"); `Von Anfang an seeks into a long buffer` (Review Focus 8: DVR 120, programme started 95 min ago → pill "−95:30"); `Von Anfang an is absent when the start is older than the buffer` (its slot keeps its width); `the pause-too-long toast names the buffer` (DVR 60 → "länger als 60 Minuten"); `the top bar shows noch 23 Min.`; `ArrowUp switches after one watch request for three quick presses`; `Q jumps to the last channel`; `live_full sheet lists running channels and a tap joins`; `502 shows Sender gerade nicht erreichbar and reconnects`; `not_receiving waits and starts when the feed sends`; `403 during play shows nicht mehr verfügbar and goes back to the list`; `beat every 20 s` (`page.clock`); `410 at beat re-watches once`; `pagehide sends a keepalive DELETE`; mobile: horizontal swipe on the centre zone switches channel, side zones keep brightness/volume; reduced motion: no transitions.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/live/compat.test.ts src/lib/player/hls.test.ts src/lib/player/timing.test.ts`; `npx -w backend vitest run test/playback-timing.test.ts`; `E2E_PORT=4341 … npx playwright test tests/player-controls.spec.ts --trace off` (film player unchanged); root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(web): live player with rewind buffer, info banner, restart and error states`

### Task 40: Web — player on TV remotes: OK, long OK, *Senderliste* panel, focus return

**Implementer:** Opus (hard: focus management and key timing on old TV WebViews) · frontend

**Files:**
- Create: `web/src/lib/live/{ChannelPanel.svelte,PanelRow.svelte,panel.ts,panel.test.ts}`, `e2e/tests/live-player-tv.spec.ts`
- Modify: `web/src/lib/live/LivePlayer.svelte` (OK through `createLongOk`: short → `showControls`, long → panel; `channelList` action → panel; the *Senderliste* button in the reserved slot (desktop, TV) and in the info sheet (phone); Back order by `backStep`; the TV controls' footer `hintKeys('player', …)` "Lang OK: Senderliste"; every keydown through `noteKey`), `web/src/lib/live/InfoPanel.svelte` (phone *Senderliste* button), locales `live.ts` (`live.player.channelList`, `live.tvHint.longOkList` if not yet there), `web/src/lib/live/compat.test.ts` (new files scanned)
- Test: the files above

**Interfaces:**
- Consumes: `resolveLiveKey`, `createLongOk`, `noteKey`/`hintKeys`, `channelOrder`, `LiveFilter` (Task 35); `LivePlayer`, `createSwitcher`, `InfoBanner` (Task 39); the list's chips data (Task 36).
- Produces (`PanelRow.svelte`, ruling 59): props `channel: LiveChannel`, `focused: boolean`, `playing: boolean`, `showNext = false` (Phase 1 never sets it; Phase 2's mini-guide does and gets a reserved *Danach* line); content number, logo, name, `nowLines(channel).now` with progress for `ok` (data states for the others); `ChannelPanel.svelte` exposes a `foot` slot, empty in Phase 1 (Phase 2: *Programmführer*).
- Produces (`panel.ts`): `export interface PanelState { filter: LiveFilter; filters: LiveFilter[]; rows: LiveChannel[]; focus: number }`; `export function openPanel(o: { list: LiveChannel[]; filter: LiveFilter; filters: LiveFilter[]; favourites: string[]; recentSnapshot: string[]; playingId: string }): PanelState` (rows = `channelOrder(…)` of the current filter, focus on the playing channel, else 0); `export function panelKey(s: PanelState, key: 'up' | 'down' | 'left' | 'right' | 'ok' | 'back', ctx: { list; favourites; recentSnapshot; playingId }): { state: PanelState; act: null | { switchTo: string } | { close: true } }` (▲/▼ move and clamp; ◀/▶ change the filter chip and refocus — on the playing channel if it is in the new rows, else the first; OK → `{ switchTo }` (the caller switches, closes the panel and shows the banner, ruling 51); Back → `{ close: true }`); `export function backStep(s: { panel: boolean; sheet: boolean; numberOpen: boolean; controls: boolean }): 'closePanel' | 'closeSheet' | 'closeNumber' | 'hideControls' | 'exit'` (in that order; spec §12.3 Close row).
- Behaviour: spec §12.2/§12.3 — on TV, OK with the controls hidden shows the controls with focus on Play/Pause and the banner (`bannerVisible` with `controlsVisible`), never pauses; OK on the focused Play/Pause pauses; MediaPlayPause pauses directly; a long OK opens `ChannelPanel` (side panel, `growBoth`; solid on TV) on the playing channel; `ChannelList` / `Guide` open it too; closing it returns focus to the player (`focus()` on the stage, controls stay hidden) with the playing channel unchanged; Back from the player goes to `/live` where Task 37 focuses the playing channel's row. Desktop: the button opens the panel as a dialog with a focus trap, Escape and a click outside close it. Phone: the info sheet's button opens it as a sheet. D-pad-only path: every control (incl. *Von Anfang an*, *Programm*, *Senderliste*, LIVE, *Letzter Sender* in the info panel) is reachable with the arrows from the focused Play/Pause.

- [ ] **Step 1: Write the failing tests** — unit: `openPanel` focuses the playing channel in *Favoriten* order; `panelKey` (▼ at the end stays; ▶ from *Alle* to *Favoriten* refocuses the playing channel when it is a favourite, else row 0; OK → `{ switchTo }`; Back → close); `backStep` order (panel → sheet → number card → controls → exit). e2e TV (`?tv=1`, mock live HLS): `OK shows the controls and the banner with focus on Play/Pause; OK again pauses`; `OK with the controls hidden never pauses` (the video keeps playing after five OK presses spread over 30 s); `long OK opens the Senderliste on the playing channel`; `panel rows show the data states` ("Programm gerade nicht verfügbar" for a `gap` channel, "Live" for an unmapped one, "Gerade keine Übertragung" for a silent push feed; every row the same height); `▼ then OK in the panel switches, closes it and shows the banner`; `Back closes the panel and focus returns to the player; Back hides the controls; Back goes to the list with the playing row focused`; `ChannelList opens the panel` (synthetic `key: 'ChannelList'`); `Guide opens the panel in Phase 1`; `the controls' footer says Lang OK: Senderliste`; `D-pad only reaches Senderliste, Programm and Letzter Sender` (arrows + OK, no long press, no colour keys). Desktop: `the Senderliste button opens the dialog; Escape closes it and focus returns to the button`. Phone: `the info sheet has Senderliste`.
- [ ] **Step 2: Run** `npx -w web vitest run src/lib/live/panel.test.ts` and the e2e spec → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/live/compat.test.ts src/lib/admin/glass.test.ts`; `E2E_PORT=4345 … npx playwright test tests/live-player.spec.ts --trace off` (Task 39 behaviour unchanged); root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(web): TV remote in the live player, Senderliste panel and focus return`

### Task 41: Casting live channels (Chromecast, AirPlay, receiver)

**Implementer:** Opus (hard: the cast engine) · frontend + backend

**Files:**
- Modify: `web/src/lib/cast/engine.ts` (`CastEngine.loadLive(channelId: string): Promise<void>`; `CastSession.live?: { channelId: string; number: number | null; name: string; now?: string; next?: string }`; renew before the 12-h cap; the hint `ff-cast-hint` gains `kind: 'live'` for re-adoption), `web/src/lib/cast/{CastBar.svelte,CastBarExpanded.svelte,RemoteScreen.svelte}` (live variant: no scrubber, LIVE pill, channel ▲/▼ = new token + `loadLive`, now/next line), `web/static/cast-receiver/{logic.js,receiver.js,receiver.css}` (`customData.ui.live`: channel card on load, *Jetzt* line, LIVE badge, no progress bar), `web/src/lib/live/LivePlayer.svelte` (*Abspielen auf…*: `PlayOnSheet`; AirPlay: the `<video>` gets a `via: 'airplay'` token URL from the user's tap; channel switch while AirPlaying = new token + `src` swap from the tap), `backend/src/livetv/routes.ts` (`export function logoUrl(ctx: Ctx, hash: string, exp: number): string` and `GET /api/livetv/logos/:hash?exp&sig` without a cookie when the signature (ruling 22) is valid and not expired)
- Test: `web/src/lib/cast/engine.live.test.ts`, `web/src/lib/cast/receiver.test.ts` (cases), `backend/test/livetv-user.test.ts` (logo signature cases), `e2e/tests/live-cast.spec.ts`

**Interfaces:**
- Consumes: `POST /api/livetv/channels/:id/watch { via }` (Task 31), the cast SDK fake `e2e/mocks/cast.ts`.
- `loadLive`: watch `via 'chromecast'` → `loadOnCast({ contentId: <PUBLIC_URL origin> + url, contentType: 'application/x-mpegURL', streamType: 'LIVE', metadata: { title: channel name, subtitle: programme title, images: [logoUrl] }, customData: { ui: { live: true } } })`; a sender tab closing leaves the cast running (receiver fetches keep the token and viewer alive).

- [ ] **Step 1: Write the failing tests** — unit: `loadLive sends via chromecast and loads a LIVE stream`; `a channel switch mints a new token and loads again`; `the live bar has no scrubber and shows the LIVE pill`; `a live hint re-adopts`; receiver: `ui.live shows the channel card and the Jetzt line, no progress bar`; backend: `a signed logo URL works without a cookie until it expires; a wrong signature is 403`; e2e (cast fake): `Abspielen auf… plays the channel on the TV`, `the bar's ▲ loads the next channel`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/cast`; `E2E_PORT=4351 … npx playwright test tests/cast-bar.spec.ts tests/cast-handoff.spec.ts --trace off` (film casting unchanged); root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(cast): live channels on Chromecast and AirPlay`

### Task 42: Admin stream test preview, Live-Status streams, Live-TV docs

**Implementer:** Sonnet (routine) · full stack + docs

**Files:**
- Modify: `backend/src/livetv/adminRoutes.ts` (`POST /channels/:id/test` answer gains `preview?: { url: string; token: string }` when the channel can start: `startOrJoin` + `mintLiveToken` `via 'local'`; budget refusal → no preview, facts only), `web/src/lib/admin/livetv/TestSheet.svelte` (10-s muted preview in a small frame with `liveHlsConfig(dvrSeconds, false)`, then `DELETE /api/livetv/watch`), `web/src/lib/admin/livetv/StatusTab.svelte` (running table filled, *Neu starten* = stop + test start), `docs/livetv.md` + `docs/de/livetv.md` (*Quellen* incl. the group picker, numbering, logo preference and EPG offsets; *Rechte* incl. releasing new groups; *Ansehen* incl. the buffer up to 120 min and its cache size, *Von Anfang an*, the *Senderliste*, the remote keys and their D-pad path, the release on switch for 1-connection providers; *Casting*, *Gesendete Streams*: UDP `LIVETV_SRT_PORTS` 9000–9009, no TCP, not through the reverse proxy, only with push feeds, OBS/encoder setup; *Fehlersuche*), `docs/privacy.md` + `docs/de/privacy.md` (spec §18 privacy notice: *Zuletzt gesehen* = the last 10 channels with the time each was last opened, nothing else), `docs/security.md` (tokens, SSRF, credentials, SRT push), `docs/architecture.md` (diagram of spec §2), `docs/operations.md` (`livetv` service, events)
- Test: `backend/test/livetv-channels-admin.test.ts` (new cases), `e2e/tests/admin-livetv-test.spec.ts`

**Interfaces:**
- Consumes: `startOrJoin`, `mintLiveToken` (Tasks 30–31), `liveHlsConfig` (Task 39).

- [ ] **Step 1: Write the failing tests** — backend: `test answers a preview token only when the channel can start`; e2e: `the test sheet plays 10 s muted, then stops watching` (DELETE seen); `Live-Status lists running channels; Stoppen confirms`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** and write the docs.
- [ ] **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): stream test preview and running streams; Live-TV docs`

**PR 1d boundary:** open the PR after Task 42 (`feat(livetv): watching live TV`).

---

## PR 1e — Platform keys and shells (Tasks 43–45)

### Task 43: Tizen and webOS live keys

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/tizen/livekeys.ts`, `web/src/lib/tizen/livekeys.test.ts`
- Modify: `web/src/routes/live/+page.svelte` and `web/src/lib/live/LivePlayer.svelte` (register on mount; normalise `keydown` with `normaliseTizenKey` / `normaliseLgKey` before `resolveLiveKey`), `docs/tv-mode.md` (keys table of spec §12.3 as updated 2026-11-12: ▲/▼ zap everywhere, OK shows the controls, long OK = *Senderliste*, lone 0 = last channel, the D-pad path; LG CH keys "nicht verlässlich / unverified"), `docs/tizen.md` + `docs/de/tizen.md`, `docs/webos.md` + `docs/de/webos.md`, `e2e/tests/live-tv.spec.ts` (LG cases)
- Test: the files above

**Interfaces:**
- Produces: `export const TIZEN_LIVE_KEYS = ['ChannelUp', 'ChannelDown', 'PreviousChannel', 'Info', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'ColorF0Red', 'ColorF3Blue'] as const;` `export const TIZEN_OPTIONAL_KEYS = ['ChannelList', 'Guide'] as const;` (spec §14, owner decision 2026-11-12) `export function registerLiveKeys(tz: TizenLike | undefined): Record<number, string>` (each `registerKey` in its own try/catch; the optional keys only when `tz.tvinputdevice.getSupportedKeys()` lists them (a throwing `getSupportedKeys` → skip them); codes from `getKey(name).code`, ruling 30; fallback `{ 427: 'ChannelUp', 428: 'ChannelDown', 10190: 'PreviousChannel', 457: 'Info', 403: 'ColorF0Red', 406: 'ColorF3Blue', 10073: 'ChannelList', 458: 'Guide' }`); `export function normaliseTizenKey(e: { key: string; keyCode: number }, map: Record<number, string>): string`.

- [ ] **Step 1: Write the failing tests** — unit: `registers every key and maps codes from getKey`; `a throwing registerKey leaves the others registered`; `no tizen object → fallback map, nothing thrown`; `normaliseTizenKey('Unidentified', 427) === 'ChannelUp'`; `ChannelList and Guide are registered only when supported` (supported list without them → not registered, no error; with them → registered, `normaliseTizenKey('Unidentified', 10073) === 'ChannelList'`); e2e (`ff_app=tizen`): `ChannelList opens the Senderliste`; e2e (`ff_app=webos`): `▲ switches the channel up without any CH key`, `keyCode 33 also switches up when the TV sends it`, `457 opens the info panel`, `Red jumps to the last channel`, `the list's hint line shows no CH hint until a PageUp/PageDown arrived`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**, update the docs.
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/tizen src/lib/webos src/lib/live/compat.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(tv): channel, digit and colour keys on Samsung and LG`

### Task 44: Fire TV `FireTvKeys`

**Implementer:** Sonnet (routine) · Android

**Files:**
- Modify: `android/firetv/src/main/kotlin/app/friendflix/firetv/shell/FireTvKeys.kt` (`KEYCODE_CHANNEL_UP` → `ChannelUp`, `KEYCODE_CHANNEL_DOWN` → `ChannelDown`, `KEYCODE_0`..`KEYCODE_9` → `"0"`..`"9"`, `KEYCODE_LAST_CHANNEL` → `PreviousChannel`, `KEYCODE_INFO` → `Info`, `KEYCODE_GUIDE` → `Guide` (Phase 1: the *Senderliste* panel, ruling 51); repeats swallowed like the media keys; `KEYCODE_DPAD_CENTER` stays untouched so the page sees its keydown/keyup for the long OK), `docs/firetv.md` + `docs/de/firetv.md` (most Fire TV remotes have no CH, digit or guide keys: ▲/▼, OK, long OK and Back cover everything)
- Test: `android/firetv/src/test/kotlin/app/friendflix/firetv/shell/FireTvKeysTest.kt` (new cases)

**Interfaces:**
- Consumes: the web names of Task 35 (`resolveLiveKey`).

- [ ] **Step 1: Write the failing tests:** `webKey maps each new code`; `route dispatches the first key-down and swallows repeats of ChannelUp`; `script accepts the new names and still refuses unknown ones`; `DPAD_CENTER is not intercepted` (down and up both reach the WebView, repeats included).
- [ ] **Step 2: Run** `cd android && ./gradlew :firetv:testDebugUnitTest --tests '*FireTvKeysTest*'` → FAIL (only with the Android SDK; else leave to CI and say so).
- [ ] **Step 3: Implement**, update the docs.
- [ ] **Step 4: Verify** → PASS (same command); root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(firetv): channel, digit, info and guide keys`

### Task 45: Android `castLive` bridge, release docs

**Implementer:** Sonnet (routine) · Android + docs

**Files:**
- Modify: `android/app/src/main/kotlin/app/friendflix/android/bridge/BridgeMessages.kt` (`CastBridge.castLive(channelId: String): Boolean`; placeholder answers false), `android/app/src/main/kotlin/app/friendflix/android/bridge/NativeBridge.kt:142` (method `"castLive"` with `{ channelId }` checked against `ID_PATTERN`), `android/app/src/main/kotlin/app/friendflix/android/cast/CastServerApi.kt` (`watchLive(channelId)`: `POST /api/livetv/channels/:id/watch { via: 'chromecast' }` with the shell's session, ruling 31), `android/app/src/main/kotlin/app/friendflix/android/cast/CastHub.kt` + `CastController.kt` (load `streamType LIVE`, `application/x-mpegURL`, channel metadata; cast bar through the existing `castState` events), `web/src/lib/native/bridge.ts` (`castLive(channelId: string): Promise<boolean>`), `web/src/lib/live/LivePlayer.svelte` (inside the Android shell the cast button calls `castLive`), `docs/android.md` + `docs/de/android.md`, `CHANGELOG.md` *Unreleased* (Live TV lines for 1b–1e), `README.md` + `README.de.md` (feature lines), `ROADMAP.md` (item done for Phase 1, Phases 2–3 listed)
- Test: `android/app/src/test/kotlin/app/friendflix/android/bridge/NativeBridgeTest.kt`, `android/app/src/test/kotlin/app/friendflix/android/cast/CastControllerTest.kt` (new cases), `web/src/lib/native/bridge.test.ts` (new cases)

**Interfaces:**
- Consumes: Task 31's watch route; the cast hub's existing load path.

- [ ] **Step 1: Write the failing tests:** `castLive dispatches the channel id`; `a malformed id is refused`; `the controller loads a LIVE stream with the channel metadata`; web `castLive sends the method and answers the boolean`.
- [ ] **Step 2: Run** `npx -w web vitest run src/lib/native/bridge.test.ts` and `cd android && ./gradlew :app:testDebugUnitTest --tests '*NativeBridgeTest*' --tests '*CastControllerTest*'` (SDK only) → FAIL.
- [ ] **Step 3: Implement**, write the release docs.
- [ ] **Step 4: Verify** → PASS (same commands); root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(android): cast live channels from the app`

**PR 1e boundary:** open the PR after Task 45 (`feat(livetv): TV keys and Android cast`). The PR description lists the owner's on-device checks of spec §22: Tizen/webOS/Fire TV channel keys and digits (on LG: do CH+/− arrive at all?); Tizen `ChannelList`/`Guide`; long OK and the *Senderliste* on each remote; ▲/▼ zapping and a lone 0 on each TV; a 120-min buffer rewound 90 min with *Von Anfang an* on a TV; zapping back and forth between two channels of a 1-connection provider; QSV transcode of an SRT test feed on the N5095; an OBS push through the opened UDP port and a refused push with a wrong passphrase; Chromecast and AirPlay live; a 30-minute pause on a TV.

---

## Self-review (done while writing; fixes are inline above; re-run on 2026-11-12 for the changed parts)

- **Spec coverage:** §1 → PR split; §3.1 → 7, 8; §3.2 → 7, 14, 27–29; §3.3 → 27, 28 (DVR ≤ 120, date-times); §3.4 → 13, 14 (ruling 3); §3.5 → 20, 29, 31; §4.1 → 10, 18; §4.2 → 9; §4.3 → 11; §4.4 → 10, 11, 26; §4.5 → 11; §5.1–5.2 → 1, 2, 3, 31, 32; §5.3 → 4, 10, 31; §5.4 → 31; §5.5 → 2, 6; §5.6 → 5 (example 4,4×, per-option hint, *Wiedergabe-Check*), 26; §6.1 → 12 (import options, `released`, offsets, `livetv_recent`), 16, 17; §6.4 (Phase 1 keys) → 1, 10, 12, 31; §7.1 → 30; §7.2 → 31; §7.3 → 34; §7.4 → 30, 31, 32 (release on switch); §8 → 16, 18, 25, 33; §9.1 → 15, 21, 22 (picker, import options); §9.2 → 19, 23, 24, 42; §9.3 → 18, 25 (release); §9.4 (Phase 1 four passes, offsets) → 17, 26; §9.5 → 26, 42; §10 → 15–20, 30–33; §11 → 36, 37, 38 (*Zuletzt gesehen*, *Ordnen*, hint line, D-pad path, *Merkliste*); §12 → 35, 39, 40 (banner, *Von Anfang an*, time left, OK / long OK, *Senderliste*, lone 0, focus return); §13 → 41, 45; §14 → 39 (Windows unchanged), 43 (`ChannelList`/`Guide`, LG CH unverified), 44, 45; §16 (`livetv.source.failed`) → 16; §17 (the guide, G1–G44) → Phase 2, no plan here (ruling 57); Phase 1 prepares it with the EPG state (ruling 58: 33, 35, 36, 39, 40) and the extensible panel (ruling 59: 40), and `Guide` opens the panel in Phase 1 (ruling 51); §18 → constraints, 15, 30, 34, 42 (privacy: *Zuletzt gesehen*); §19 → 16, 17, 20, 27, 30, 31, 32, 39; §20 → copy in the owning tasks (ruling 16; the 2026-11-12 rows in 5, 22, 23, 25, 31, 35, 38, 40); §21 → 24, 36–40; §22 → each task's tests, on-device list in PR 1e; §23 → 6, 8, 42, 43–45; §25 → nothing (later items, deliberately absent). Owner decisions 2026-11-12: 1 → 31, 32; 2 → 35, 37, 40, 43, 44; 3 → 27, 31, 39; 4 → 39; 5 → 35, 40; 6 → 12, 14–17, 19, 22, 23; 7 → 12, 14–16, 18, 22, 25; 8 → 12, 33, 35, 36, 38. Owner decision *Programmführer* 2026-11-12: Phase 2 (spec §17), Phase 1 prep in 33, 35, 36, 39, 40. Phase 2/3 rows only as hooks: migrations 49/50, `ConvKind` `record`/`reencode`, the `/recordings` volume, `recordingUses` (Task 32), `/media/r/` left out.
- **Type consistency:** `ConvKind`/`ConvEntry`/`BenchRecord`/`admitConversion` (+ `exceptLive`)/`bindConvGrant`/`dropConvGrant` (Tasks 1–4, 31, 32); `StreamInput`/`ProbeResult`/`pickVariant` (14, 27, 28); `M3uEntry` (`shiftMin`, `pos`)/`parseM3u` (`groups`, `listed`) (14, 15, 16); `Encoder` (7, 28, 31); `Mode`/`StreamView`/`SegmentWindow` (`pdt`, `oldest`) (27, 28, 31, 26); `LivetvOp` (9, 10); `EffectiveChannel` (`epgShiftMin`, `epgShiftFrom`)/`CHANNEL_SELECT` (12, 17, 18, 19, 31, 32); `SourceView`/`SourceBody` (`skipGroups`, `numbering`, `numberBase`, `logoPref`, `epgShiftMin`) (15, 16, 22); `matchChannel`/`EpgIndex` (17); `channelSet`/`channelAllowed`/`livetvFeature` (18, 30, 31, 33); `mintLiveToken`/`resolveLiveToken`/`revokeLiveTokens`/`deviceLiveView` (30, 31, 32, 42); `startOrJoin`/`viewerCounts`/`invalidateLiveConversions`/`releasableOld`/`releaseForSwitch` (31, 32, 42); `LiveChannel`/`RunningChannel`/`Prog`/`LiveList` (`recent`) (17, 31, 33, 35–41); `LiveFilter`/`channelOrder` (35, 36, 39, 40); `resolveLiveKey`/`LiveKeyAction` (`showControls`, `channelList`) (35, 37, 39, 40, 43, 44); `createLongOk` (35, 37, 40); `noteKey`/`seenKeys`/`hintKeys` (35, 37, 40); `commitNumber` (`kind`) (35, 37, 39); `timeLeft`/`progressAt` (36, 39); `restartTarget`/`oldestPoint`/`bannerVisible`/`liveHlsConfig(dvr, tv)` (39, 40, 42); `DragState` and friends in `#lib/ui/dragOrder` (24, 38); `shiftLabel` (22, 23).
- **Step scan (changed parts):** every new or changed step names its function, file, values (600 ms, 4 000 ms, 30 s lead, 300/1 800 s, 10 recent, −720…840 in 30-min steps, 5-s wait, 20-s marker) and its test assertions; no "handle edge cases" lines; Task 32's race tests use a hook between admission and recount rather than timing luck.
- **Type consistency (guide prep):** `LiveChannel.epg` / `nowLines` (33, 35, 36, 39, 40); `PanelRow` `showNext`, `ChannelPanel` `foot` slot (40).
- **Review Focus:** 6–9 added for the new failure modes (release racing a join, zapping on a 1-connection provider, a 120-min buffer on Chromium 85, a large list with skipped and later-added groups); each has its test in the owning task.
- **Proportion:** the plan fixes names, encodings, routes, codes, limits and tests; bodies are left to implementers except ruling 18's key, the ffmpeg values the spec pins and the `restartTarget` formula.
