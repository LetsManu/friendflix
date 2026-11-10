# Streaming Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The four quick wins of the streaming audit: fewer needless transcodes in browsers and on Samsung TVs, new remote streams that fit the server's upload instead of everyone stalling, faster start and seek where Jellyfin allows it (plus server advice), and a next episode that starts almost at once.

**Architecture:** Each item is one commit with its tests. Capability probing is pure, tested TypeScript in `web/src/lib/player/devicecaps.ts` that produces the same caps block Android and the desktop app already send; the backend validates it (`backend/src/media/clientCaps.ts`) and turns it into the Jellyfin device profile. The upload rule is a pure function in `backend/src/uploadcap.ts`, fed from the live-session records the backend already keeps. Segment length is one URL parameter in `backend/src/jellyfin/dto.ts`; the encoder check is one more Health row. The next-episode warm-up lives in `web/src/lib/player/prefetch.ts` next to today's play-button prefetch and reuses its single-entry cache.

**Tech Stack:** Fastify + zod (backend), SvelteKit with Svelte 4 syntax, TypeScript, vitest, Playwright.

**Source:** `scratchpad/streaming/audit.md` (2026-11-10), Part 3 "Quick wins".

## Global Constraints

- The media-server token never reaches a client; media URLs keep their token model (`ff_sid` cookie on `/media/`, cast path tokens). Nothing secret in logs.
- Playback timing stays anonymous (no user, profile, item, address or user agent) and is deleted after 14 days (`pruneTimings`).
- Never change the media server's settings; the encoder check only reads them.
- The Plex path keeps working: Jellyfin-only parts are guarded (`kind === 'jellyfin'`, optional `MediaAdmin` methods, `serverCaps.playbackPrefetch`).
- No new dependencies. Migrations are re-runnable (`add column if not exists`).
- Every new UI string in all 7 locales (de is the type source). Never "Netflix"/"Seerr" in user-facing text. Animate only transform and opacity. Placeholder hosts only in docs (friend.example.com, 192.0.2.x).
- Tests in the existing style (`backend/test/client-caps.test.ts`, `core.test.ts`, `playback-timing.test.ts`, web vitest next to the module); run the root `npm run typecheck` and only the test files added or changed.

## What we found before planning (answers the audit left open)

- **Default image subtitles do block direct play (confirmed).** FriendFlix posts PlaybackInfo without `SubtitleStreamIndex` (`backend/src/jellyfin/service.ts` `playbackInfo`). Jellyfin's `StreamBuilder.BuildVideoItem` then uses `options.SubtitleStreamIndex ?? GetDefaultSubtitleStreamIndex(...)`, i.e. the user's default subtitle, and when that stream has no External/Embed/Drop profile (PGS, VobSub: our profiles list only vtt/srt/ass) it adds `SubtitleCodecNotSupported` and direct play is refused (jellyfin `MediaBrowser.Model/Dlna/StreamBuilder.cs`, master and 10.9–10.11). Our own HLS URL burns nothing in (Jellyfin burns in only when the request carries `SubtitleStreamIndex >= 0`, `EncodingHelper.CanStreamCopyVideo`). Fix: send `SubtitleStreamIndex: -1` in the PlaybackInfo body (the query parameter is marked obsolete). Subtitles stay client-side WebVTT as today.
- **Segment length.** Jellyfin takes `SegmentLength` on `master.m3u8` (`DynamicHlsController`, all 10.9–10.11 and master) and in `TranscodingProfile`; there is no dashboard setting (the "3–4 s instead of 6 s" advice in `docs/monitoring.md` points at nothing). Without the parameter Jellyfin already uses **3 s when it re-encodes the video** and **6 s when it copies the video** (remux) (`StreamState.SegmentLength`). The 6 s for copies is deliberate: with copied video ffmpeg can only cut at the source's keyframes, so the playlist must follow them. Jellyfin does that for Matroska only by default (on-demand keyframe extraction, `AllowOnDemandMetadataBasedKeyframeExtractionForExtensions = ["mkv"]`, `DynamicHlsPlaylistGenerator.ComputeSegments`); other containers get equal-length playlists. So 3 s is safe exactly for re-encodes (already the default) and for Matroska sources with keyframe extraction on. Plex has no segment-length parameter in its universal transcoder API that FriendFlix uses: unchanged.

---

### Task 0: This plan

- [ ] Commit `docs: plan for the streaming quick wins`.

---

### Task 1: Real capability detection for browsers and Samsung Tizen (plus the image-subtitle fix)

**Files:**
- Create: `web/src/lib/player/devicecaps.ts`, `web/src/lib/player/devicecaps.test.ts`
- Modify: `web/src/lib/webos/caps.ts` (`appCaps()` asks devicecaps for browsers and Tizen; the LG / Fire TV path stays), `web/src/lib/player/prefetch.ts` (`prefetchPlayer` starts the async probe), `web/src/lib/Player.svelte` (first-frame watchdog also for probed blocks; failure memory)
- Modify: `backend/src/media/clientCaps.ts` (client `web`; optional `ranges` and per-codec `tags`), `backend/src/jellyfin/service.ts` (VideoRangeType / VideoCodecTag conditions; `SubtitleStreamIndex: -1`)
- Test: `backend/test/client-caps.test.ts` (parser + device profile + subtitle index)

**Interfaces:**
- `devicecaps.ts` produces:
  - `interface ProbeEnv { canPlayType(t: string): string; isTypeSupported?(t: string): boolean; decodingInfo?(c: MediaDecodingConfiguration): Promise<{ supported: boolean }>; hdrDisplay: boolean }`
  - `confirmsType(env, mime): boolean` — a MIME with a `codecs=` parameter needs `canPlayType === 'probably'`, or `'maybe'` plus `MediaSource.isTypeSupported === true`; a bare container MIME needs any non-empty answer. A throwing probe is "no".
  - `async probeDevice(env, o: { client: 'web' | 'tizen'; appVersion: string }): Promise<ClientCapsBody | null>` — h264 profiles (baseline … high 10), HEVC main / main 10 (and which tags: `hvc1`, `hev1`), AV1 (claimed only when 8 and 10 bit both pass), VP9 profile 0, audio aac/mp3/opus/flac/vorbis/ac3/eac3, containers mp4/m4v/webm/mov/mkv/ts. HEVC, AV1 and VP9 additionally need `decodingInfo({ type: 'file' }).supported` when the API exists; `maxHeight` is 2160 when a 3840×2160 probe passes, else 1080 when 1920×1080 passes, else the codec is not claimed. Ranges: `sdr` always; `hdr10` / `hlg` only with an HDR display (`(dynamic-range: high)`) **and** a passing PQ / HLG 10-bit decode probe; Dolby Vision never.
  - `syncCaps(env, o)` — the same without `decodingInfo` (HEVC/AV1/VP9 left out when the async API exists but has not answered yet: never claim before a positive probe).
  - `SAFE_CAPS(o)` — `mp4,m4v` + h264 (8 bit profiles) + `aac,mp3`: the profile after a failure.
  - Cache: `localStorage['ff_devcaps']` `{ v, ua, at, caps }` (probe version, user agent, 7 days); `localStorage['ff_devcaps_safe']` `{ ua, at }` (30 days) after a claimed format failed. Both wrapped in try/catch.
  - `deviceCaps(): ClientCapsBody | null` (sync, for the request body), `warmDeviceCaps(): void`, `noteDirectFailure(): void`.
- `appCaps()` keeps its signature: LG / Fire TV unchanged; Tizen app and plain browsers get `deviceCaps()`; no `document` → null (server's fixed list as before).
- Backend: `ClientCaps.client` gains `'web'`; `ranges?: Array<'sdr'|'hdr10'|'hlg'|'hdr10plus'|'dovi'>`; `ClientVideoCap.tags?: string[]` (allowlist `avc1, avc3, hvc1, hev1, dvh1, dvhe, av01, vp09`). Jellyfin profile: when `ranges` is present, one CodecProfile (all video codecs) `VideoRangeType EqualsAny` of the mapped Jellyfin values (`SDR`, `HDR10`, `HLG`, `HDR10Plus`, `DOVI…` variants that fall back to a claimed base); per codec `VideoCodecTag EqualsAny` when `tags` is present. PlaybackInfo body carries `SubtitleStreamIndex: -1`.
- Escape hatch: when a direct play that relied on a probed block shows no first frame in time (the existing 10 s watchdog, now also for probed browsers/Tizen) or fails to decode, the player already retries once as HLS (H.264, always safe). New: it also calls `noteDirectFailure()`, so the device sends `SAFE_CAPS` from then on (30 days, or until the browser's user agent changes).

- [ ] **Step 1: Tests** — `devicecaps.test.ts`: positive-only claims ('maybe' with codecs is not enough without MSE; throwing probes are "no"); HEVC needs decodingInfo when the API exists; 4K vs 1080 cap; AV1 needs both bit depths; ranges need HDR display and decode probe; sync result before the async probe leaves HEVC/AV1/VP9 out; cache by UA and version; safe mode after `noteDirectFailure`. Backend: parser accepts `web`, `ranges`, `tags`, drops unknown ones; the device profile carries the range and tag conditions; no range condition without `ranges` (Android unchanged); the PlaybackInfo body has `SubtitleStreamIndex: -1`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** root `npm run typecheck`, the two test files.
- [ ] **Step 4: Commit** `feat(playback): probe what browsers and Samsung TVs decode; default image subtitles no longer block direct play`.

**Number that shows it worked:** in `playback_timings` (TT) the share of starts with `delivery = 'direct'` for `device = 'pc'` and `'tv'` (7 days before vs after; target +25 % relative), and in `play_daily.reasons` the `subtitles` reason near 0. A rise of `reconnects` or of the `forcedHls` fallbacks (first-frame failures show as starts with `mode = 'hls'` after a direct attempt) would show a wrong claim.

---

### Task 2: Upload-aware cap for new remote streams

**The rule (simple and predictable):** the admin enters the server's upload in Mbit/s (`UPLOAD_MBPS`, Admin → Settings → Playback; empty = off). For a new playback request from **outside** the home networks: `free = 0.85 × upload − Σ bitrates of the other remote streams that are live now` (portal streams only, paused ones included because they resume, the requesting device's own earlier stream excluded because it is being replaced). If `free` is at least the viewer's normal ceiling, nothing changes. Otherwise the stream starts at the highest rung of the player's ladder (8 / 4 / 1.5 Mbit/s) that fits in `free`, never below 1.5 Mbit/s. Streams already running are never touched; the reserve (15 %) covers protocol overhead and the owner's own traffic. Home-network viewers are never capped and never counted. The bitrate of a stream is the cap it was granted at start (an upper bound: a direct play never exceeds it). Nothing about the viewer is measured or stored.

**Files:**
- Create: `backend/src/uploadcap.ts`, `backend/test/upload-cap.test.ts`
- Modify: `backend/src/config.ts`, `backend/src/settings/registry.ts` (`UPLOAD_MBPS`, group playback), `compose.yaml`, `compose.prod.yaml` (generated block), `backend/src/live.ts` (`bitrate?`, `remote?` on `Live`), `backend/src/routes/media.ts` (info: compute the cap; pbinfo kv carries bitrate + remote; start report copies them), `backend/src/media/types.ts` + `jellyfin/service.ts` + `jellyfin/dto.ts` + `plex/reason.ts` (cap reason `uploadCap`), `backend/src/routes/usage.ts` (reason list)
- Modify (web): `web/src/lib/admin/health.ts` (`TC_REASONS`), `web/src/lib/player/QualityChip.svelte`, `web/src/lib/player/timing.ts` (`VIDEO_REASONS`), locales `settings.ts`, `adminContent.ts`, `player.ts` ×7, `web/src/lib/admin/settings/settings.test.ts` (key list), `e2e/mocks/settings.ts`
- Docs: `docs/operations.md` (the rule), `README.md` / `README.de.md` settings table

**Interfaces:**
- `uploadCap(o: { uploadMbps: number | undefined; remote: boolean; ceiling: number; others: Array<{ bitrate?: number; remote?: boolean }> }): { cap: number; limited: boolean }`; `UPLOAD_RESERVE = 0.15`, `UPLOAD_RUNGS = [8e6, 4e6, 1.5e6]`, `UPLOAD_FLOOR = 1.5e6`.
- `Live.bitrate?: number; Live.remote?: boolean` (bits/s; set on the start report from the info-time record).
- `TranscodeReason` gains `'uploadCap'`; `capReason` is `'uploadCap'` when this cap is the binding one.

- [ ] **Step 1: Tests** — pure rule (off when unset, home never capped, own device excluded, rung snapping, floor, paused counted, sessions without a bitrate ignored); route: second remote device gets the lowered `maxBitrate` and reason `uploadCap`, a home request is not capped, Plex still answers.
- [ ] **Step 2: Implement**, settings texts in 7 locales, compose block (`npm run compose:env` semantics).
- [ ] **Step 3: Verify** typecheck, `upload-cap.test.ts`, `compose-env.test.ts`, web `settings.test.ts`.
- [ ] **Step 4: Commit** `feat(playback): new remote streams start below the server's free upload`.

**Number that shows it worked:** TT remote rows (`home = false`): `stallsPerSession` and `stallMsPerSession` (7 days before/after, target −50 % on evenings with 3+ remote streams); the count of `uploadCap` in `play_daily.reasons` shows how often it acted; quality switches (`switches`) caused by stalls drop.

---

### Task 3: Faster start and seek (segments, BBR advice, encoder health check)

**Files:**
- Modify: `backend/src/jellyfin/dto.ts` (`SegmentLength=3` for Matroska sources: copied video then gets keyframe-aligned 3 s segments; re-encodes already get 3 s from Jellyfin), `backend/test/core.test.ts` or the dto test that covers `toPlaybackDto`
- Modify: `backend/src/media/types.ts` (`MediaAdmin.encoderSettings?(): Promise<EncoderSettings | null>`), `backend/src/jellyfin/client.ts` + `service.ts` (GET `/System/Configuration/encoding`, admin key, read-only), `backend/src/health.ts` (service `encoder`: level, reason, `advice` codes), `backend/test/health*.test.ts`
- Modify (web): `web/src/lib/admin/health.ts`, `web/src/lib/admin/ServiceLights.svelte` (advice lines), locales `adminContent.ts` ×7
- Docs: `docs/monitoring.md` (replace the non-existent segment setting with what Jellyfin does; encoder check), `docs/operations.md` (reverse proxy: BBR + `fq`, buffering off, HTTP/2; placeholder hosts)

**Interfaces:**
- `EncoderSettings { hwAccel: string; tonemap: boolean; throttle: boolean; segmentDeletion: boolean; keyframeMkv: boolean }` (mapped from `HardwareAccelerationType`, `EnableTonemapping || EnableVppTonemapping || EnableVideoToolboxTonemapping`, `EnableThrottling`, `EnableSegmentDeletion`, `AllowOnDemandMetadataBasedKeyframeExtractionForExtensions` contains `mkv`).
- Health row `encoder` (Jellyfin only; Plex: no row): `ok`, or `warn` with the first of `no_hw_accel`, `no_tonemap`, `no_throttle`, `no_keyframes` as `reason` and all of them in `advice`; `off`/`unavailable` when the call fails. Nothing from the answer is stored except these codes.

- [ ] **Step 1: Tests** — dto: Matroska source → `SegmentLength=3` in `hlsUrl`, mp4 source → none, cast unchanged; health: each advice code from a fake encoding config, Plex without the method → no row, failure → off.
- [ ] **Step 2: Implement** + docs.
- [ ] **Step 3: Verify** typecheck and the changed test files.
- [ ] **Step 4: Commit** `feat(playback): 3 s segments for Matroska remuxes, encoder advice in Health, BBR in the docs`.

**Number that shows it worked:** TT remote `targetDuration` p50 for remux rows (`delivery = 'remux'`) from 6 to 3; `firstFrag` step p50 and total p50 (time to first frame) −20 %; `seekP50` −30 %. BBR: remote `stallsPerSession` (owner's server change, outside the code).

---

### Task 4: Prebuffer the next episode (web)

**Files:**
- Modify: `web/src/lib/player/prefetch.ts` (`prepareNext`, `releaseNext`, warm-up, cleanup; `holdPrefetch` keeps a next-episode entry of another title), `web/src/lib/player/prefetch.test.ts`
- Modify: `web/src/lib/Player.svelte` (prop `prepNext: string | null`; builds the next title's first request body exactly as its own first start would, so the answer is reused; timing flag `fromNext`), `web/src/routes/watch/[id]/+page.svelte` (`prepNext` = next episode id while the autoplay countdown runs)
- Modify: `web/src/lib/player/timing.ts` (`fromNext`), `backend/src/playtiming.ts` + `backend/src/db.ts` (migration 44: `from_next boolean not null default false`), `backend/test/playback-timing.test.ts`
- Create: backend route `POST /api/playback/warm/stop { playSessionId }` (stops the warmed transcode via `stopEncoding`; Jellyfin only, no-op elsewhere) in `backend/src/routes/media.ts`, test in `backend/test/core.test.ts` style
- Test (e2e): `e2e/tests/desk-credits.spec.ts` — the countdown asks for the next episode's playback info once, and the next player start does not ask again.

**Interfaces:**
- `prepareNext(itemId: string, body: InfoBody, o: { warm: boolean }): void` — once per item: POST `/api/playback/info` (counted as a prefetch, no stream slot; a 429 at the stream limit simply drops it). When `warm` and the answer has no direct URL and starts near 0 (resume < 10 s): GET master playlist → first variant → first segment headers (body aborted), which starts Jellyfin's transcoder for exactly the play session the player will use.
- `releaseNext(): void` — the countdown stopped: the warmed transcode is stopped after `WARM_GRACE_MS` (8 s) unless the player took the entry. Every warm is stopped at the latest `PREFETCH_TTL_MS` (30 s) after it began when nobody took it, so a second transcode never runs longer than that.
- Conditions: Jellyfin only (`serverCaps.playbackPrefetch`), autoplay-next on and the countdown running, not casting, not in a watch party.
- Android: not in this change (its player has no info prefetch to build on; noted for later).

- [ ] **Step 1: Tests** — prefetch: entry survives `holdPrefetch` of the current title; warm fetch order; release stops encoding after the grace unless taken; TTL stop; Plex never prefetches; timing `fromNext` round trip and migration rerun.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** typecheck, `prefetch.test.ts`, `timing.test.ts`, `playback-timing.test.ts`.
- [ ] **Step 4: Commit** `feat(player): warm the next episode during the autoplay countdown`.

**Number that shows it worked:** TT total p50 (time to first frame) of rows with `from_next = true` under 1.5 s (vs. all starts today), with no rise in remote stalls.

---

## Review Focus

1. A wrong capability claim must never end in a black screen: the first-frame watchdog and decode-error fallback both lead to HLS once, and the device then stays on the safe profile.
2. The upload cap must not lower home viewers or streams already running, and a quality switch on the same device must not count its own old stream.
3. The next-episode warm-up must never leave a transcode running for more than ~30 s when unused, and never start one for Plex.
4. `SegmentLength=3` only where Jellyfin's playlist follows keyframes (Matroska) or it re-encodes; mp4 remuxes keep 6 s.
