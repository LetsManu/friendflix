# Live TV Phase 3: Recordings (DVR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People record single programmes, series and fixed time slots from Live TV, watch them (also while they are still being recorded) in *Meine Aufnahmen* and the normal player, cast and hand them off, and download finished recordings for offline viewing; admins pick the storage mode, limit and retention, and the shared conversion budget never gets overbooked by recordings.

**Architecture:** The backend owns all recording state (new tables, a 15-s `livetvRecordTick`) and decides when to record; `livetv` gets a **recorder that taps the channel's shared live stream** (the stream already fetches the input once for every viewer) and copies each finished segment into `/recordings/<dir>/` with its own `EVENT` playlist. A recorded channel is kept running by the backend (`recordingUses()` becomes real) and its transcode slot is counted as kind `record`, reserved 5 min ahead. The gateway serves recordings read-only under `/media/r/<token>/…` (tokens like live) and offline copies under the existing `/media/d/<licence>`. Downloads reuse the `downloads` licence table and the web/Android offline code; only the file preparation is new (`livetv` derives an MP4 inside the recording folder).

**Tech Stack:** Fastify + PostgreSQL + Redis KV (backend), Node 22 + jellyfin-ffmpeg (`livetv`), Node gateway, SvelteKit/Svelte (web), vitest, Playwright; Android app unchanged (verified by a fixture test).

**Spec:** `docs/superpowers/specs/2026-11-11-live-tv-design.md` — §1 (Phase 3 rows 3a/3b/3c), *Owner decisions* → *Phase 3 recordings*, §3.1–3.2, §5.1–5.2, §6.3–6.4, §7.1–7.3, §8, §9.5–9.6, §15 (all), §16, §18–§20, §22, **§26 (addendum 2026-11-15: recording downloads)**.

## Where the code differs from the spec (code wins; the plan follows the code)

1. **Recorder input.** §3.2 lists `POST /v1/recordings { id, input, mode, encoder, dir, startAt, endAt }`. §15.2 also says a recording shares the input with the live stream. In the code a stream is a driver feeding one `SegmentWindow` (`livetv/src/streams.ts`), with an `onSegment` hook already used by the previews. So the recorder **taps that stream**: the backend starts or joins the channel's stream through the normal start path (budget kind `record`), then `POST /v1/recordings { id, channelId, dir, endAt }`. The recording's mode is the stream's (`passthrough | remux | transcode`), not §6.3's `copy | remux | transcode`. No decrypted input URL is sent twice.
2. **`recordingUses(channelId)`** (`backend/src/livetv/streams.ts:567`) is a sync Phase-1 stub. It becomes `recordingUses(ctx, channelId): Promise<boolean>` (DB, 5-s memo). All three callers (`releasableOld`, `beginRelease`, `livetvTick`) await it.
3. **Segment format.** Passthrough of fMP4/CMAF providers serves `init-<n>.mp4` + `.m4s` (bughunt M2). Recordings store whatever the stream serves (`segments: 'ts' | 'fmp4'`). The library export concatenates to `.ts` **or** `.mp4` (init + fragments), not always `.ts` as §15.3 says.
4. **Budget reservations.** `convbudget.ts` has the `record` kind and its admission rule, but no reservations (`conv:resv:*`) yet, and `liveConversions()` labels every transcoding stream `live`. Phase 3 adds per-**channel** reservations (two recordings of one channel share one stream and one slot) and labels a stream that a recording uses as `record`.
5. **The guide's detail sheet does not exist yet.** Phase 2b (the user guide, `/live/guide`, `GET /api/livetv/programme/:channelId/:start`) has not shipped. 3a builds the programme route. 3b builds the detail sheet as `RecordSheet.svelte`, opened from the player's info panel (*Jetzt* / *Danach*) and from *Meine Aufnahmen*. Phase 2b reuses it instead of building its own. The guide's red recording dot stays with Phase 2b.
6. **`liveRecord` exists but nobody enforces it.** It is in the permission registry (`backend/src/perms.ts`: default off for guests, in `KIDS_OFF`), but no route checks it yet. 3a enforces it on every recording write.
7. **No per-kind notification preferences exist** (`notify.ts` has none). `livetv.rec.started` was off by default behind an account preference `livetvRecStarted`, so it is **not sent** in Phase 3 (listed under *Later*). The other recording notifications ship as §16 says.
8. **Playback token route.** §15.8 has `GET /api/livetv/recordings/:id/playback`. A route that mints a credential is a `POST` here (`/play`), like `POST /api/livetv/channels/:id/watch`.
9. **Mounts.** The gateway does not mount recordings yet (compose has only `livetv`'s `/recordings`), and `GET /v1/system` answers `recordings: null`. Both are added in 3a.
10. **Migration numbers.** 54 is the highest today (`backend/src/db.ts`). 3a and 3c each append **one** migration at the next free index at merge time. The roles redesign (`claude/roles-redesign`) may take an index first, so never hard-code the number in tests: assert on the tables and columns.

## Global Constraints

- **Stages ship independently**, each its own PR with green CI, merged with a merge commit (never rebase): **3a** (backend + recorder + storage + budget + notifications; usable through the API and admin events only), **3b** (UI), **3c** (recording downloads). Every PR leaves the app working; Live TV stays invisible until enabled.
- **Merge order vs. `claude/roles-redesign`:** either order works. Rights are read only through the existing API: `permsOf(ctx, req)` / `effectiveRights(...).perms.liveRecord` / `.perms.liveTv` for recording, and `roleAllowsDownloads(ctx, await effectiveLimits(ctx, user))` for downloads (3c). **One function, `recordingDownloadGate()` in `backend/src/livetv/recdownloads.ts`, is the only place that combines them.** If the roles branch merges first and adds a Downloads area switch outside `template.download`, the 3c PR adds that one check there. If 3c merges first, the roles PR must keep `roleAllowsDownloads` / `effectiveRights` as the gate (note it in the 3c PR description). The migration index goes to whoever merges first; the other takes the next index.
- **Locales:** every new string goes into all 7 locales (`de` source, `en`, `es`, `fr`, `it`, `pl`, `tr`) with **identical key order**, through `#lib/i18n` (web) and `m()` (backend notifications).
- **UI:** the existing glass system only; touch targets ≥ 44 px (TV ≥ 54 px, text ≥ 28 px at 1080p). Animate only `transform` / `opacity`, both when opening and when closing. **Nothing may jump:** progress lines, state chips, the conflict warning and error lines reserve their space before content arrives. Calm mode, reduced motion, TV and kids switch at once on solid panels. Extend `web/src/lib/admin/glass.test.ts` and the live stylesheet scan with every new file. Every request goes through `api()`.
- **Words and fixtures:** never "Netflix" or "Seerr" in user-facing text. Fictional channels and titles only (*Nordlicht TV*, *Hafenkanal*, *Sternwarte 24*; *Die Leuchtturmwärter*, *Sternstunde Physik*). People: *Anna Beispiel*. Placeholder hosts only (`friend.example.com`, `iptv.example.com`, `192.0.2.x`).
- **Secrets:** never log or answer stream URLs, stream keys, recording/playback tokens or file system paths. Logs carry recording ids and fixed codes only. `livetv` logs never name a title (the backend owns them). A test greps captured logs for `iptv.example.com` and for the token.
- **Containers:** the Docker socket never goes to `livetv` (or backend/web/gateway). `livetv` writes only `/recordings` (and `/library` with the opt-in overlay). The gateway mounts `/recordings` **read-only**. The backend never mounts `/recordings`: it deletes and inspects files through signed `livetv` calls only.
- **Workspace boundaries:** the backend never imports from `livetv/`. Every `livetv` answer the backend consumes is re-declared in `backend/src/livetv/wire.ts`, field for field.
- **Settings and env:** a task that adds a registry setting or env variable runs `npm run compose:env`, commits the regenerated compose blocks, and runs `npx -w backend vitest run test/compose-env.test.ts`.
- **New files** start with the SPDX header. No new npm dependencies. Errors keep the `{ error: code }` shape. Validation failures answer `{ error: 'invalid', field }`. Admin writes are audited as `livetv.rec.*` with ids and field names only.
- **Verification (agents run typecheck + the task's own specs; CI runs the rest):**
  - root `npm run typecheck`;
  - backend `npx -w backend vitest run test/<file>` (PostgreSQL on `localhost:5433` or `TEST_DATABASE_URL`; if none is reachable, leave it to CI and say so);
  - `npx -w livetv vitest run test/<file>`, `npx -w gateway vitest run test/<file>`, `npx -w web vitest run <file>`;
  - e2e: `E2E_PORT=<port> PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx playwright test -c e2e/playwright.config.ts <spec> --trace off`, then delete `e2e/test-results`;
  - **e2e mocks must answer every new API call** the page makes (`e2e/mocks/livetv.ts`, `e2e/mocks/admin.ts`, `e2e/mocks/api.ts` for downloads); an unmocked call fails the spec;
  - no test needs a real ffmpeg, Jellyfin or provider: runners, fetches and the clock are injected.
- **Commits:** Conventional Commits, one per task, `git commit -m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN"`. Never `git stash`. Do not push unless the controller says so.

## Review Focus

1. **Disk full mid-recording:** `ENOSPC` while copying a segment ends that recording as `partial` (or `failed` with nothing written), code `storage_full`, closes its playlist with `ENDLIST` and frees the stream. The owner and the admins are notified. No new recording starts while free space is under 2 GiB. Tests in Tasks 2 and 3.
2. **Recorder crash or restart:** a `livetv` restart (new `bootId`) or a backend restart resumes every `recording` row **into the same folder**: same numbering, a `DISCONTINUITY`, the outage stored as a gap. Never two recorders for one id; never an orphan recorder after a cancel. Tests in Tasks 2 and 3.
3. **Overlapping schedules vs. the budget:** two recordings of one channel share one stream and one slot. Reservations stop new viewers from taking a recording's slot 5 min ahead. The conflict forecast counts distinct transcoding channels, parallel recordings and the provider's connection limit. Release-on-switch and the idle stop never stop a channel that is being recorded. A refused start retries every 60 s until its end. Tests in Tasks 3 and 4.
4. **EPG time change or shift:** until it starts, an EPG-based recording follows its programme (same channel, same normalised title and episode/sub-title, nearest within ±3 h) when the guide is re-imported, the channel/source offset changes, or across DST. A started recording only grows if the programme's end moved later (≤ +3 h). It never shortens itself. Tests in Task 3.
5. **Deleting a recording that is being watched or downloaded:** the delete revokes playback tokens (the player gets 410 and shows "Aufnahme nicht mehr verfügbar") and download licences (devices drop the copy at check-in). It cancels a running derive, stops a running recorder before removing files, and removes the files through `livetv` only. A gateway read of a removed file answers 404, never a partial body. Tests in Tasks 4, 5 and 14.

---

## Stage 3a — recordings backend, recorder, storage, budget, notifications

### Task 1: Migration, settings, recording model and visibility

**Files:**
- Modify `backend/src/db.ts`: append one migration (next free index; rerunnable `if not exists`). It holds §6.3's three tables with these changes:
  - `livetv_recordings.mode` check `('passthrough','remux','transcode')`;
  - new columns `segments text check (segments in ('ts','fmp4'))`, `follow_epg boolean not null default false`, `prog_key text` (normalised title + `\n` + episode or sub-title);
  - `dir uuid not null unique`; `error text check (char_length(error) <= 40)`;
  - `unique index livetv_recordings_slot on (profile_id, channel_id, start_at) where state in ('scheduled','recording')`;
  - `unique (rule_id, channel_id, start_at)`.
- Modify `backend/src/settings/registry.ts`: add §6.4's `LIVETV_RECORD_*` keys (group `livetv`, without `LIVETV_REENCODE*`), then run `npm run compose:env`.
- Create `backend/src/livetv/recordings.ts` (rows, views, visibility, keep/share, the delete helper).
- Tests: create `backend/test/livetv-recordings.test.ts`; extend `backend/test/livetv-migration.test.ts`.

**Interfaces:**
- Produces:
  - `type RecState = 'scheduled'|'recording'|'done'|'partial'|'failed'|'cancelled'`.
  - `interface RecordingView { id; title; subtitle; episode; channel: { id: string|null; name; logo: string|null }; start; end; padBefore; padAfter; state; error: string|null; gaps: number; durationS: number|null; bytes; keep; visibility: 'private'|'account'|'everyone'; mine: boolean; seriesKey: string|null; ruleId: string|null; positionS: number; watched: boolean; deleteAfter: string|null; storage: 'ff'|'library'; growing: boolean }`.
  - `visibleRecording(ctx, user: LivetvUser, profile: LivetvProfile, id): Promise<RecRow|null>`. The owner profile sees its own while the account has `liveTv`. `account`: any profile of the owner's account. `everyone`: a profile whose channel set contains the channel. Kids: only `account`/`everyone` **and** a kid-friendly group. Admins get no playback without a share (spec §15.6).
  - `listRecordings(ctx, user, profile, { state?: 'done'|'scheduled'|'all' })`.
  - `setKeep()`, `setVisibility()` (owner or admin).
  - `deleteRecording(ctx, id, by: 'owner'|'admin'|'retention'|'space')`: scheduled → `cancelled`; recording → stop first; then `livetv` file delete; revokes tokens (Task 5) and licences (Task 14 hook `onRecordingDeleted`).
  - `recordSettings(ctx)` → `{ storage, libraryId, libraryJfPath, limitBytes, retentionDays, padBeforeS, padAfterS, maxParallel }`.

- [ ] **Step 1: failing tests:**
  - `migration creates recordings tables and is rerunnable`;
  - `private recording visible only to the owner profile`;
  - `account share reaches every profile of the account, not other accounts`;
  - `everyone share needs the channel in the profile's set`;
  - `kids see only shared recordings of kid-friendly groups`;
  - `admin list shows metadata but visibleRecording refuses an unshared one`;
  - `profile delete cascades recordings, rules and progress`;
  - `recordSettings defaults are ff, 200 GB, 30 days, 2/5 min, 4`.
- [ ] **Step 2: run** `npx -w backend vitest run test/livetv-recordings.test.ts test/livetv-migration.test.ts`: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** the same two files plus `test/compose-env.test.ts`, then `npm run typecheck`: PASS.
- [ ] **Step 5: commit** `feat(livetv): recordings tables, settings and visibility`.

### Task 2: `livetv` recorder (tap on the shared stream), system facts

**Files:**
- Modify `livetv/src/streams.ts`: `onSegment(channelId, info: SegmentInfo)` with `SegmentInfo = { path; file; duration; discontinuity; init: number|null; initPath: string|null; pdt: number }`. Update the previews call site in `server.ts`. Add `keepAlive(channelId)`, which counts like a `/s/` fetch for `IDLE_STOP_MS`.
- Create `livetv/src/recorder.ts`.
- Create `livetv/src/routes/recordings.ts`.
- Modify `livetv/src/system.ts`: `recordings: { usedBytes, freeBytes }` via `statfs` + a cached `du` of `/recordings`, refreshed at most every 60 s.
- Modify `livetv/src/config.ts`: `recordingsDir: '/recordings'`.
- Modify `backend/src/livetv/wire.ts` (re-declare the answers).
- Tests: create `livetv/test/recorder.test.ts`; extend `livetv/test/streams-api.test.ts` and `livetv/test/system.test.ts`.

**Interfaces (signed `/v1/*`, HMAC as today):**
- `POST /v1/recordings { id: uuid, channelId, dir: uuid, endAt: epoch-ms }` → 200 `{ state: 'recording', segments: 'ts'|'fmp4'|null }`.
  - It is idempotent per `id`. When the folder already has an `index.m3u8` it **resumes**: numbering continues after the last segment, the next segment gets `#EXT-X-DISCONTINUITY`, and the gap from the last segment's end to the first new one is recorded.
  - Errors: 409 `stream_not_running` (the backend starts the stream first); 507 `storage_full` (free < 2 GiB).
- `PATCH /v1/recordings/:id { endAt }` sets a new end.
- `DELETE /v1/recordings/:id` stops now and writes `ENDLIST`.
- `GET /v1/recordings` → `[{ id, channelId, state: 'recording'|'done'|'failed', segments, bytes, durationS, gaps: [{ from, to }], error: null|'storage_full'|'write_failed'|'stream_gone', since }]`. Finished entries stay listed for 1 h so the backend can collect them.
- `POST /v1/recordings/:id/delete { dir }` stops the recorder if needed, then removes `/recordings/<dir>`. It checks the uuid shape and that `realpath` stays under the root, never follows a symlink, and answers 404 when the folder is already gone.
- Recorder rules:
  - It copies each segment (and each new init file) from the cache into `<dir>/` (`copyFile` + `O_NOFOLLOW` open checks).
  - It rewrites `index.m3u8` atomically: tmp + rename, `#EXT-X-PLAYLIST-TYPE:EVENT`, `TARGETDURATION`, `EXT-X-MAP` per init, `PROGRAM-DATE-TIME` per segment.
  - It calls `keepAlive` on every segment.
  - Gap detection: a stream stop while recording, or ≥ 3 × the target duration without a segment. The gap ends at the next segment, which also gets a discontinuity.
  - At `endAt` it writes `ENDLIST`.
  - On `ENOSPC` it writes `ENDLIST` with what it has; the state becomes `failed` with `storage_full` (the backend maps it to `partial` when bytes > 0). Other write errors give `write_failed`.
  - Logs name the recording id only.

- [ ] **Step 1: failing tests:**
  - `copies segments and writes an EVENT playlist with program date-times`;
  - `fmp4 stream: init files are copied once and EXT-X-MAP changes with the init`;
  - `ENDLIST at endAt; PATCH extends endAt`;
  - `resume after restart continues numbering with a discontinuity and records the gap`;
  - `ENOSPC ends with storage_full and a closed playlist`;
  - `stream stop during recording records a gap; segments after a restart continue`;
  - `keepAlive prevents the idle stop while recording`;
  - `delete refuses a non-uuid dir and a symlinked folder`;
  - `POST is idempotent per id`;
  - `system reports recordings used and free bytes`;
  - `no log line contains a path, a stream key or a title`.
- [ ] **Step 2: run** `npx -w livetv vitest run test/recorder.test.ts test/streams-api.test.ts test/system.test.ts`: FAIL.
- [ ] **Step 3: implement** (fake fs store and clock as in `streams-helpers.ts`).
- [ ] **Step 4: run** the same files plus `test/preview.test.ts`, then `npm run typecheck`: PASS.
- [ ] **Step 5: commit** `feat(livetv): recorder taps the shared stream into /recordings`.

### Task 3: Scheduler: rules, EPG follow, start/stop, reconcile, budget reservation

**Files:**
- Create `backend/src/livetv/recsched.ts`.
- Modify `backend/src/livetv/streams.ts`:
  - `startForRecording(ctx, ch): Promise<{ mode, segments } | { error: 'no_slot'|'provider_limit'|'channel_unreachable'|'not_receiving' }>`, which shares `startOrJoin`'s start internals with admission kind `record` and no viewer;
  - async `recordingUses(ctx, id)`;
  - `liveConversions()` gives kind `record` to channels a recording uses;
  - the idle stop and the release path await `recordingUses`.
- Modify `backend/src/convbudget.ts`:
  - reservations `conv:resv:<channelId>` (KV, indexed, TTL 120 s, refreshed by the tick) are counted unless that channel already runs a transcode;
  - `admitConversion({ …, exceptResv?: channelId })` leaves a recording's own reservation out.
- Modify `backend/src/livetv/epg.ts`: `refreshEpg`'s success calls `afterEpgImport(ctx, sourceId)` (rule expansion + follow).
- Modify `backend/src/server.ts`: add `livetvRecordTick` every 15 s behind `op()` and `BACKGROUND_JOBS`, with KV lock `ltv:rectick`.
- Modify `backend/src/livetv/events.ts`: event codes `rec_started`, `rec_done`, `rec_partial`, `rec_failed`, `rec_moved`, `rec_no_slot`, `rec_storage_full`.
- Modify `backend/src/notify.ts` callers via `recsched.ts`: `livetv.rec.failed`, `livetv.rec.episode` (§16 texts, dedupe per recording), plus `livetv.rec.storage` for admins on `storage_full`.
- Tests: create `backend/test/livetv-recsched.test.ts`; extend `backend/test/convbudget.test.ts` and `backend/test/livetv-switch.test.ts`.

**Interfaces:**
- `expandRules(ctx, now)`:
  - Series rules match upcoming programmes (next 8 days, effective offset via `EFFECTIVE_SHIFT_SQL`) by `series_key`, on the rule's channel or on all channels in the owner profile's set.
  - *Nur neue Folgen* follows §15.1 (previously-shown / `<new/>` and the same episode or sub-title already recorded by the rule).
  - Time rules expand weekly occurrences in the rule's `tz`.
  - It inserts `scheduled` rows (`on conflict do nothing`).
  - `keep_max` deletes the oldest unprotected finished recordings of the rule beyond N.
- `followEpg(ctx, now)`: a `scheduled` row with `follow_epg` moves to the nearest programme with the same `prog_key` on its channel within ±3 h (event `rec_moved`). If none is found it keeps its time.
- `livetvRecordTick(ctx, now)`, in order:
  1. reservations for transcode-expected rows starting within pad + 5 min;
  2. due starts:
     - owner lost `liveRecord` or the channel right → `cancelled`/`forbidden`;
     - `livetv` not installed → `failed`/`livetv_off`, owners notified once;
     - over the limit with nothing deletable, or free < 2 GiB → `failed`/`storage_full`;
     - otherwise `startForRecording`, then `POST /v1/recordings`. `no_slot` retries every 60 s until the end (event once), then the row ends `failed`/`no_slot`, or `partial` when something was recorded;
  3. reconcile with `GET /v1/recordings`: a `recording` row missing in `livetv` (new `bootId`) is resumed; finished entries are collected into `bytes`, `duration_s`, `gaps`, state (`done` without gaps or late start, `partial`, `failed`), then the library export when storage is `library` (Task 6);
  4. due stops at `end + pad_after` → `DELETE`.
  - A running EPG recording extends `endAt` when its programme's end moved later (≤ +3 h).
- `recordingUses(ctx, channelId)` is true while a row of that channel is `recording` or starts within pad + 5 min.

- [ ] **Step 1: failing tests:**
  - `series rule schedules only new episodes on this channel / all channels`;
  - `keep_max deletes the oldest unprotected of the rule`;
  - `time rule expands weekdays in its time zone across DST`;
  - `EPG re-import moves a scheduled recording to its programme's new time`;
  - `a channel EPG offset change moves scheduled recordings`;
  - `a started recording grows when the programme end moves later, never shrinks`;
  - `due start posts the stream then the recording with padding`;
  - `two recordings of one channel share one stream and one record slot`;
  - `reservation keeps a new viewer's transcode out 5 minutes ahead`;
  - `a refused start retries every 60 s and ends no_slot`;
  - `livetv restart resumes recording rows into the same dir`;
  - `backend restart: the tick adopts running recorders and starts nothing twice`;
  - `storage_full from livetv ends partial and notifies owner and admins once`;
  - `owner without liveRecord at start: cancelled forbidden`;
  - `livetv disabled: scheduled recordings fail livetv_off, owners notified once`;
  - `idle stop and release on switch leave a recorded channel running` (in `livetv-switch.test.ts`);
  - `liveConversions labels a recorded transcode as record` (in `convbudget.test.ts`);
  - `own reservation not counted against the recording's start`.
- [ ] **Step 2: run** `npx -w backend vitest run test/livetv-recsched.test.ts test/convbudget.test.ts test/livetv-switch.test.ts test/livetv-streams.test.ts`: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** the same files plus `test/livetv-events.test.ts` and `npm run typecheck`: PASS.
- [ ] **Step 5: commit** `feat(livetv): recording scheduler, EPG follow and budget reservations`.

### Task 4: User and admin recording routes, conflict forecast, `liveRecord` enforced

**Files:**
- Create `backend/src/livetv/recroutes.ts` (registered from `routes.ts` and `adminRoutes.ts`).
- Modify `backend/src/livetv/recsched.ts` (add `forecast`).
- Modify `backend/src/permGuard.ts` (add `'record_forbidden'` to the code union).
- Tests: create `backend/test/livetv-recroutes.test.ts`.

**Interfaces:**
- `forecast(ctx, { channelId, from, to, exceptId? })` → `{ slots: { used, limit }, parallel: { used, max }, provider: { used, max } | null, conflict: boolean }`. It sweeps overlapping `scheduled`/`recording` rows. `slots` counts **distinct channels** whose expected mode is `transcode` against `limit − holdback`. `parallel` counts distinct recorded channels against `LIVETV_RECORD_MAX_PARALLEL`. `provider` counts against the source's `max_streams`. A copy-mode recording never conflicts on slots.
- User routes (`requireUser`; writes add `requirePerm(ctx, 'liveRecord', 'record_forbidden')` + `channelAllowed`; kids are refused by the kids overlay):
  - `GET /api/livetv/programme/:channelId/:start` → `{ channelId, start, end, title, subtitle?, description?, episode?, seriesKey?, categories?, recording?: { id, state }, rule?: { id }, canRecord }` (offset applied).
  - `POST /api/livetv/recordings { channelId, start, end?, title?, padBefore?, padAfter?, force? }`:
    - with a programme at `start` it is EPG-based (`follow_epg`); with `end` + `title` it is time-based;
    - 201 `{ recording }`; 409 `{ error: 'conflict', forecast }` unless `force`; 200 with the existing row on a duplicate; 403 `record_forbidden`; 404 `not_found`.
  - `GET /api/livetv/recordings?state=done|scheduled|all` → `{ recordings, rules }`.
  - `GET /api/livetv/recordings/:id`.
  - `PATCH /api/livetv/recordings/:id { keep?, visibility?, padBefore?, padAfter? }` (pads only while `scheduled`).
  - `DELETE /api/livetv/recordings/:id` → 204.
  - `POST /api/livetv/recordings/:id/library` (only in `both` mode).
  - `GET/POST/PATCH/DELETE /api/livetv/rules[/:id]`. Body: `{ kind: 'series', channelId|null, seriesKey, title, onlyNew, keepMax?, padBefore?, padAfter? }` or `{ kind: 'time', channelId, weekdays, startTime, durationMin, tz, title }`. A rule `POST` also answers `forecast` for its first occurrence.
  - `POST /api/livetv/recordings/:id/progress { positionS, played? }`.
- Admin (`requireAdmin`, audited):
  - `GET /api/admin/livetv/recordings?state&limit&offset` (owner profile name, channel, time, mode, state, error; no playback);
  - `DELETE /api/admin/livetv/recordings/:id`;
  - `POST /api/admin/livetv/recordings/delete-all { confirm: 'LÖSCHEN' }`;
  - `GET /api/admin/livetv/recordings/storage` → `{ usedBytes, limitBytes, freeBytes, hoursLeftHd, library }`.
- Rate limits: 30/min for writes.

- [ ] **Step 1: failing tests:**
  - `guest (liveRecord off) gets 403 record_forbidden on POST`;
  - `kids profile cannot schedule or delete`;
  - `a channel outside the profile's set is 404`;
  - `conflict answers the forecast; force plans anyway`;
  - `forecast counts a channel once for two recordings`;
  - `parallel and provider limits conflict`;
  - `copy-mode never conflicts on slots`;
  - `duplicate POST returns the existing recording`;
  - `DELETE of a running recording stops it then removes its files`;
  - `PATCH visibility only by owner or admin`;
  - `admin list shows metadata only; delete-all needs LÖSCHEN`;
  - `programme route applies the channel's EPG offset`;
  - `no answer or log line contains a stream URL`.
- [ ] **Step 2: run** `npx -w backend vitest run test/livetv-recroutes.test.ts`: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** the same file plus `test/livetv-user.test.ts test/livetv-recordings.test.ts` and `npm run typecheck`: PASS.
- [ ] **Step 5: commit** `feat(livetv): recording routes with conflict forecast; liveRecord enforced`.

### Task 5: Recording playback tokens and gateway `/media/r/`

**Files:**
- Modify `backend/src/livetv/tokens.ts`: `mintRecToken`, `resolveRecToken`; rec records under the same `ltv:` / `ltvidx:` keys with `kind: 'rec'`, `recordingId`.
- Modify `backend/src/livetv/recroutes.ts`: `POST /api/livetv/recordings/:id/play`.
- Modify `backend/src/routes/internal.ts`: `POST /internal/authz/rec`.
- Modify `gateway/src/gateway.ts` and `gateway/src/env.ts` (`RECORDINGS_DIR`).
- Modify `compose.yaml` and `compose.prod.yaml`: gateway gets `${RECORDINGS_PATH:-recordings}:/data/recordings:ro` and `RECORDINGS_DIR: /data/recordings`; run `npm run compose:env`.
- Tests: extend `backend/test/livetv-tokens.test.ts`; create `gateway/test/rec.test.ts`.

**Interfaces:**
- `POST /api/livetv/recordings/:id/play { via?: 'local'|'chromecast'|'airplay' }` → `{ token, url: '/media/r/<token>/index.m3u8', growing, segments, durationS, positionS, expiresAt }`. 404 when the recording is not visible; 409 `not_ready` while nothing is recorded.
- Tokens: idle 90 s sliding, renewed by `POST /api/livetv/beat` (accepts rec tokens); cap = remaining duration + 1 h, while growing the end + pad + 1 h. They share the 4-per-account cap. They are revoked by `deleteRecording`, a visibility change and the live revoke paths.
- `/internal/authz/rec { token, ip }` → `{ dir, growing, maxAgeS: 2 }` or 401/403/410.
- Gateway `/media/r/<token>/<file>`:
  - `file` must match `^(index\.m3u8|init-[0-9]{1,4}\.mp4|[0-9]{1,10}\.(ts|m4s))$`;
  - files are served from `RECORDINGS_DIR/<dir>/` with the download path's `serveFile` checks (realpath under the root, `O_NOFOLLOW`, single ranges);
  - the playlist is `no-store` while growing, else `private, max-age=60`; segments are `private, max-age=3600`;
  - CORS as the cast path; the token is scrubbed from logs like `/media/l/`; metrics carry the route class `rec` only.

- [ ] **Step 1: failing tests:**
  - `play mints a rec token for a visible recording, 404 otherwise`;
  - `rec token is revoked when the recording is deleted (410)`;
  - `visibility change to private revokes other profiles' tokens`;
  - `growing playlist is no-store`;
  - gateway: `path allowlist refuses ../ and unknown names`, `serves a range of a segment`, `a removed file is 404, never a partial body`, `token never in a log line`.
- [ ] **Step 2: run** `npx -w backend vitest run test/livetv-tokens.test.ts` and `npx -w gateway vitest run test/rec.test.ts`: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** the same files plus `npx -w gateway vitest run test/live.test.ts`, `npx -w backend vitest run test/compose-env.test.ts` and `npm run typecheck`: PASS.
- [ ] **Step 5: commit** `feat(livetv): recording playback through /media/r tokens`.

### Task 6: Storage modes, space and retention, library export

**Files:**
- Create `backend/src/livetv/recstore.ts`.
- Create `livetv/src/library.ts`.
- Modify `livetv/src/routes/recordings.ts` (export, library delete).
- Modify `livetv/src/system.ts` (`library` facts).
- Modify `backend/src/media/types.ts` and the Jellyfin adapter: optional `MediaAdmin.refreshLibrary?(id)`, `libraryFolders?()`, `createLibrary?(name, path, kind)`. The Plex adapter leaves them out.
- Create `compose.livetv-library.yaml` (§15.3 text).
- Modify `backend/src/livetv/recroutes.ts`: admin `GET/POST /api/admin/livetv/recordings/libraries`.
- Tests: create `livetv/test/library.test.ts` and `backend/test/livetv-recstore.test.ts`.

**Interfaces:**
- `livetv POST /v1/recordings/:id/export { dir, folder, file }` → `{ path, bytes }`:
  - it concatenates the segments without re-encoding into `/library/<folder>/<file>.ts|.mp4` (`.mp4` = init + fragments);
  - file names are sanitised (no `/`, `..`, control characters, ≤ 120 chars), written with `O_NOFOLLOW`, with `realpath` under `/library`;
  - the marker guard writes `.friendflix-recordings` on first use; a folder that is not empty and has no marker gives 409 `library_not_dedicated`; also 409 `library_not_writable` and 404 `no_library`.
- `POST /v1/recordings/:id/library-delete { path }`: `path` comes only from the backend's `library_path`, checked again under `/library`.
- `/v1/system.library` → `{ mounted, writable, dedicated, freeBytes } | null`.
- `recstore.ts`:
  - `usage(ctx)` = sum of `bytes` (FriendFlix and library).
  - `spaceTick` (daily, plus after every finished recording): above 90 % of the limit, the oldest unprotected finished recordings get `delete_after = now + 24h` until the forecast is ≤ 80 %; owners get `livetv.rec.deleting`; admins get `livetv.rec.storage` once a day. Due `delete_after` rows are deleted.
  - Retention: `LIVETV_RECORD_RETENTION_DAYS` after `watched_at` (≥ 90 % watched by the owner profile), never for `keep`.
  - `exportToLibrary(ctx, id)` (mode `library` after the end; `both` on *Behalten → in Bibliothek*, which also sets `keep`) then `refreshLibrary` and matches `jellyfin_item_id` by path. In mode `library` the HLS folder is deleted after a successful export. Export failures keep the FriendFlix copy and log an admin event.

- [ ] **Step 1: failing tests:**
  - livetv: `export concatenates ts / fmp4 without re-encoding`, `refuses a non-empty unmarked folder`, `sanitises names and never follows a symlink`, `paths stay below /library`;
  - backend: `usage over 90 % schedules the oldest unprotected for deletion with a 24-h notice`, `keep protects; new recordings then fail storage_full`, `retention deletes N days after watched`, `library mode exports, deletes the HLS folder and links the item`, `export failure keeps the recording in the FriendFlix folder`, `Plex: library mode not offered`.
- [ ] **Step 2: run** `npx -w livetv vitest run test/library.test.ts` and `npx -w backend vitest run test/livetv-recstore.test.ts`: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** the same files and `npm run typecheck`: PASS.
- [ ] **Step 5: commit** `feat(livetv): recording storage modes, space and retention`.

**Stage 3a ship:** PR "Live TV: recordings backend", green CI, merge. Docs line in `CHANGELOG` ("Aufnahmen: Backend, noch ohne Oberfläche").

---

## Stage 3b — recording UI, player seam, casting, hand-off

### Task 7: Web API client, copy, `RecordSheet`

**Files:**
- Create `web/src/lib/live/recordings.ts` (API + pure helpers) and `web/src/lib/live/RecordSheet.svelte`.
- Modify `web/src/lib/live/InfoPanel.svelte`: *Aufnehmen* on *Jetzt* and *Danach*; "● Wird aufgenommen" when it applies.
- Modify the locales `web/src/lib/i18n/locales/*/live.ts` (`live.rec.*`, `live.guide.record*` from §20) and the backend notification messages.
- Modify `e2e/mocks/livetv.ts` (programme, recordings, rules, conflict).
- Tests: create `web/src/lib/live/recordings.test.ts` and `e2e/tests/live-record.spec.ts` (+ `.mobile.spec.ts`).

**Interfaces:**
- Consumes Task 4's routes exactly.
- Produces `RecordSheet` props `{ channel, programme | null }` and events `close | watch | changed`. It shows title, time, channel and description, then the actions *Jetzt ansehen* (only while it runs), *Aufnehmen* / *Aufnahme abbrechen*, *Serie aufnehmen* (only with `seriesKey`: *Nur neue Folgen*, *Nur dieser Sender* / *Alle Sender*, *Höchstens … behalten*), and *Vorlauf / Nachlauf* steppers under *Mehr*.
- A conflict shows the §20 line inline in a **reserved** slot with *Trotzdem planen*.
- The sheet appears only with `me.perms.liveRecord`.
- Phase 2b's guide imports this sheet.

- [ ] **Step 1: failing tests:**
  - unit: `groupBySeries orders episodes newest first`, `stateLabel covers every state with gaps count`, `padding stepper clamps 0–30 / 0–120`;
  - e2e: `info panel Aufnehmen schedules the running programme`, `conflict shows the warning without moving the buttons; Trotzdem planen sends force`, `Serie aufnehmen sends the rule`, `guest sees no Aufnehmen`, `kids see no Aufnehmen`;
  - mobile: `sheet fits 375 px, buttons ≥ 44 px`.
- [ ] **Step 2: run** `npx -w web vitest run src/lib/live/recordings.test.ts` and the e2e specs: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** the same, plus `npx -w web vitest run src/lib/i18n` and `npm run typecheck`: PASS.
- [ ] **Step 5: commit** `feat(live): record from the player's info panel`.

### Task 8: *Aufnahmen* row and *Meine Aufnahmen*

**Files:**
- Create `web/src/lib/live/RecordingsRow.svelte`, `web/src/routes/live/recordings/+page.svelte`, `web/src/lib/live/RecordingItem.svelte` and `web/src/lib/live/TimeRecordSheet.svelte` (*Neue Aufnahme*: channel, date, start, duration, weekday chips).
- Modify `web/src/routes/live/+page.svelte`, `web/src/lib/live/TvLiveList.svelte` and `web/src/lib/live/KidsLive.svelte` (read-only row of shared kid-friendly recordings).
- Modify `e2e/mocks/livetv.ts`.
- Tests: create `e2e/tests/live-recordings.spec.ts` (+ `.mobile.spec.ts`, a TV case in the same file); extend `web/src/lib/admin/glass.test.ts` with the new files.

**Interfaces:**
- Row: the latest 12 of the profile. Tile with logo, title, date, duration, a red dot + "läuft" while recording, and a progress bar when started (space reserved). It is hidden when there are no recordings and no `liveRecord`.
- Page (§15.7): segmented *Fertig* / *Geplant* / *Serien*. *Fertig* is grouped by series with episode lists, singles by date. Each item has play, *Behalten*, *Teilen…* (owner/admin), *Löschen* with an undo toast (the DELETE is delayed 5 s), and later *Herunterladen* (3c). *Geplant* has cancel and a *Konflikt* chip from `forecast`. *Serien* has the rule settings.
- TV: D-pad + OK + Back only, one focused element, `scale(1.08)` ring.

- [ ] **Step 1: failing tests:**
  - `row shows the latest recordings with a running dot`;
  - `Alle opens Meine Aufnahmen on Fertig`;
  - `series group lists episodes`;
  - `Behalten toggles in place without layout shift`;
  - `Löschen undo within 5 s sends nothing`;
  - `Geplant cancel`;
  - `Neue Aufnahme with weekdays creates a time rule`;
  - `kids row shows only shared recordings, no actions`;
  - TV: `arrow keys move between tiles and OK plays`.
- [ ] **Step 2: run** the e2e specs: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** the e2e specs plus `npx -w web vitest run src/lib/admin/glass.test.ts` and `npm run typecheck`: PASS.
- [ ] **Step 5: commit** `feat(live): Aufnahmen row and Meine Aufnahmen`.

### Task 9: Player source seam and recording playback

**Files:**
- Create `web/src/lib/player/source.ts` (`PlaybackSource`, `jellyfinSource`, `recordingSource`).
- Modify `web/src/lib/Player.svelte`: the info request, progress reports and stop go through `source`; Jellyfin-only parts are gated by `source.caps`.
- Create `web/src/routes/live/recordings/[id]/+page.svelte`.
- Tests: create `web/src/lib/player/source.test.ts` and `e2e/tests/live-recording-player.spec.ts` (uses the fake HLS server of `e2e/mocks/hls.ts`).

**Interfaces:**
- `interface PlaybackSource { kind: 'item'|'recording'; id: string; caps: { episodes; credits; scenes; trickplay; abr; bookmarks; subtitleSearch }; info(startSec): Promise<{ url; kind: 'hls'; growing: boolean; durationS: number|null; positionS: number }>; progress(posS, state: 'playing'|'paused'|'stopped'): Promise<void>; beat?(): Promise<void>; stop(): Promise<void> }`.
- `jellyfinSource` wraps today's code unchanged (the default when no `source` prop is given), so film playback must behave byte for byte as before; existing player e2e specs are the guard.
- `recordingSource` uses `/play`, `/progress` (every 10 s and on pause/stop) and `/api/livetv/beat` every 20 s; all caps are false.
- Growing recordings are seekable from the start; the end follows the live edge and a "Aufnahme läuft" chip occupies a reserved slot. A 410 shows "Aufnahme nicht mehr verfügbar".

- [ ] **Step 1: failing tests:**
  - unit: `jellyfinSource sends the same /api/playback/info body as before`, `recordingSource reports progress at 10 s and on stop`;
  - e2e: `a finished recording resumes at its saved position`, `a growing recording seeks back to the start and returns to the live edge`, `410 shows the gone state`, `film playback specs unchanged` (run `e2e/tests/player*.spec.ts` as the guard).
- [ ] **Step 2: run** the unit and e2e specs: FAIL.
- [ ] **Step 3: implement**, keeping the Player diff to the seam points.
- [ ] **Step 4: run** the same specs plus `npx -w web vitest run src/lib/player` and `npm run typecheck`: PASS.
- [ ] **Step 5: commit** `feat(player): playback source seam; recordings play in the normal player`.

### Task 10: Casting and hand-off of recordings

**Files:**
- Modify `web/src/lib/cast/engine.ts`, `web/src/lib/cast/liveInfo.ts` (rec info, `segments` for CAF) and `web/src/lib/cast/playOn.ts`.
- Modify `backend/src/handoff.ts` and `backend/src/routes/media.ts`: `itemId` may be `rec:<uuid>`, accepted only for a recording visible to the profile.
- Modify `web/src/lib/remote.ts` (open `/live/recordings/<id>`).
- Tests: create `web/src/lib/cast/engine.rec.test.ts`; extend `backend/test/handoff.test.ts`; create `e2e/tests/live-recording-cast.spec.ts` (cast SDK fake).

**Interfaces:**
- `POST …/play { via: 'chromecast'|'airplay' }` uses the pin rules of live tokens.
- Hand-off rows carry `rec:<uuid>`; *Weiter auf dem Fernseher* opens the recording at the saved position.

- [ ] **Step 1: failing tests:**
  - `cast a recording loads /media/r with the right segment format`;
  - `AirPlay pins two addresses within the window`;
  - `hand-off row for a recording resumes on another device`;
  - `rec: item of another profile is refused`.
- [ ] **Step 2: run** them: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** them plus `npx -w web vitest run src/lib/cast/engine.live.test.ts` and `npm run typecheck`: PASS.
- [ ] **Step 5: commit** `feat(live): cast and hand off recordings`.

### Task 11: Admin *Aufnahmen* tab and Live-Status events

**Files:**
- Create `web/src/lib/admin/livetv/RecordingsTab.svelte`.
- Modify `web/src/lib/admin/livetv/sources.ts` (`TABS` gains `recordings` before `settings`), `web/src/routes/admin/livetv/+page.svelte`, `web/src/lib/admin/livetv/status.ts` (texts for the `rec_*` events) and the locales `*/adminLive.ts`.
- Modify `e2e/mocks/admin.ts`.
- Tests: create `e2e/tests/admin-livetv-recordings.spec.ts` (+ `.mobile.spec.ts`); extend `web/src/lib/admin/livetv/status.test.ts`.

**Interfaces (§9.6):**
- Storage mode (*FriendFlix-Ordner* / *Jellyfin-Bibliothek* / *Beides*). The library modes are disabled with the setup steps while `library.mounted` is false.
- Library select with folders, *passt*, the mismatch warning and *Bibliothek „Aufnahmen“ anlegen*.
- The note "Aufnahmen in der Bibliothek sieht jede Person, die diese Bibliothek sieht" plus, from §26, a warning when a role with *Darf aufnehmen* cannot see that library.
- Limit with a usage bar ("143 von 200 GB · noch ca. 41 h in HD"), retention, padding defaults, max parallel. These are registry rows reused from `SettingRow` (no second store).
- A list of scheduled, running and failed recordings with *Abbrechen*, and *Alle Aufnahmen löschen…* (typed "LÖSCHEN").

- [ ] **Step 1: failing tests:**
  - `library modes disabled until mounted, with setup lines`;
  - `mismatch warning before saving a library without the folder`;
  - `delete-all needs LÖSCHEN`;
  - `usage bar text`;
  - `rec_storage_full event text`;
  - mobile: `rows become cards`.
- [ ] **Step 2: run** them: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** them plus `npx -w web vitest run src/lib/admin` and `npm run typecheck`: PASS.
- [ ] **Step 5: commit** `feat(admin): Live-TV Aufnahmen tab`.

### Task 12: Docs

**Files:** `docs/livetv.md` + `docs/de/livetv.md` (recordings, storage modes, the library overlay with its security note, retention), `docs/security.md`, `docs/privacy.md` (recordings and progress per profile; sharing), `docs/setup.md` (`compose.livetv-library.yaml`, `RECORDINGS_PATH`), `CHANGELOG.md`, `README` feature line.
- [ ] Write both language versions per the docs convention; run `node --test scripts/spdx.test.mjs`; commit `docs(livetv): recordings`.

**Stage 3b ship:** PR "Live TV: recordings UI", green CI, merge. On-device checks for the owner: record and play back on the household TVs, cast a recording, a library recording appearing in Jellyfin.

---

## Stage 3c — downloading recordings (spec §26)

### Task 13: `livetv` derives offline files

**Files:** create `livetv/src/derive.ts`; modify `livetv/src/routes/recordings.ts`; create the test `livetv/test/derive.test.ts`.

**Interfaces:**
- `POST /v1/recordings/:id/derive { dir, fileId: uuid, variant: 'copy' | { maxHeight, maxBitrate }, encoder }` → 202. One derive runs at a time (FIFO queue).
  - `copy`: concat + remux to a faststart MP4, video copied, audio converted to AAC when it is not AAC.
  - Otherwise: H.264 transcode at the caps with the configured encoder.
  - Output goes to `<dir>/dl/<fileId>.part`, renamed to `.mp4` when done; `ENOSPC` gives `storage_full`.
- `GET /v1/recordings/:id/derive/:fileId` → `{ state: 'queued'|'running'|'ready'|'failed', pct, bytes, error }`.
- `DELETE /v1/recordings/:id/derive/:fileId` cancels the job and removes its files.
- The ffmpeg input is restricted with `-protocol_whitelist file,concat`; no shell.
- [ ] **Steps:**
  - failing tests: `copy remuxes with AAC audio`, `variant transcodes at caps`, `cancel removes the part file`, `ENOSPC fails storage_full`, `one at a time`;
  - run `npx -w livetv vitest run test/derive.test.ts`: FAIL;
  - implement;
  - run it again plus `npm run typecheck`: PASS;
  - commit `feat(livetv): derive offline files from recordings`.

### Task 14: Backend recording downloads on the licence machinery

**Files:**
- Modify `backend/src/db.ts`: next free migration with `livetv_recording_files(id uuid pk, recording_id uuid not null references livetv_recordings on delete cascade, quality text, max_height int, max_bitrate int, status text check (status in ('queued','preparing','ready','failed')), pct int, bytes bigint, error text, created_at, last_used_at, unique (recording_id, quality, max_height, max_bitrate) where status <> 'failed')` and `alter table downloads add column if not exists rec_file_id uuid references livetv_recording_files(id) on delete set null`.
- Create `backend/src/livetv/recdownloads.ts`.
- Modify `backend/src/downloads.ts`: the `rec:` branches in `viewLicenses`, `authorizeDownload`, `checkLicenses`, `syncProgress` and `adminOverview`.
- Modify `backend/src/routes/downloads.ts`: options and create accept `recordingId`.
- Modify `backend/src/livetv/recsched.ts` (derive tick) and `backend/src/livetv/recordings.ts` (`onRecordingDeleted` revokes licences and deletes files).
- Tests: create `backend/test/livetv-recdownloads.test.ts`; extend `backend/test/downloads.test.ts`.

**Interfaces:**
- `recordingDownloadGate(ctx, user, profile, deviceId): Promise<DownloadRole | null>` is the **only** combination of the rights: `effectiveRights(...).perms.liveTv` ∧ `roleAllowsDownloads(ctx, await effectiveLimits(ctx, user))` ∧ the device is not `tv-…`. It needs no library: it is tested with a role whose `libraries` is `[]`.
- `GET /api/downloads/options/rec:<uuid>` → the same `DownloadOptions` shape. Qualities come from `qualityOptions(role, src)` with `src = { originalEligible: video h264 ∧ height ≤ cap ∧ bitrate ≤ role.maxBitrate, sizeBytes: bytes, runtimeTicks: durationS × 1e7 }`. There are no audio or subtitle choices.
- `POST /api/downloads { recordingId, quality }` creates one licence (`item_id = 'rec:<uuid>'`, `job_id null`, `rec_file_id`) in the same quota and transaction pattern as films (`serial`, `quota_exceeded`, `expiresAt = downloadDays`). Errors: only `done`/`partial` in storage `ff` (or the FriendFlix copy in `both`), else 409 `not_downloadable`; 404 when not visible.
- `LicenseView` for recordings: `itemId 'rec:<uuid>'`, `title`, `seriesName` = series title or channel name, `poster` = the channel logo URL or null, `runtimeTicks`, `prep` from the file row. The shape is unchanged, so Android and web parse it as is.
- Derive tick:
  - a `queued` file with variant `copy` starts at once;
  - a transcode variant first needs `admitConversion({ kind: 'download', hint: 'recdl:<fileId>' })` and waits otherwise; the grant is held while `livetv` reports `running`;
  - statuses are mirrored into the file row.
  - A file with no `pending` licence and unused for 3 days is deleted through `livetv`.
  - `bytes` of the files count towards the recordings usage.
- `authorizeDownload` for `rec:` returns `{ kind: 'file', root: 'recordings', file: '<dir>/dl/<fileId>.mp4', size, etag }` after the visibility check (`visibleRecording`, memo 5 s). A visibility loss revokes the licence, as for items.
- `checkLicenses` revokes when the recording is gone or no longer visible.
- `syncProgress` writes `livetv_recording_progress` for `rec:` items.

- [ ] **Step 1: failing tests:**
  - `a Live-TV-only role (libraries [], download on) can download its own recording`;
  - `shared recording downloadable by another profile of the account`;
  - `no download right → 403 downloads_not_allowed`;
  - `liveTv off → 403`;
  - `TV device refused`;
  - `quota shared with films`;
  - `original offered only for h264 within caps`;
  - `transcode variant waits for a download slot`;
  - `running recording not downloadable`;
  - `deleting the recording revokes licences and the file`;
  - `visibility change revokes at the next check`;
  - `offline progress for rec: lands in recording progress`;
  - `authorize returns the recordings root file`.
- [ ] **Step 2: run** `npx -w backend vitest run test/livetv-recdownloads.test.ts test/downloads.test.ts`: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** them plus `test/downloadprep.test.ts` and `npm run typecheck`: PASS.
- [ ] **Step 5: commit** `feat(livetv): recordings use the offline download licences`.

### Task 15: Gateway serves recording downloads

**Files:** modify `gateway/src/gateway.ts` (`DownloadTarget.root?: 'downloads'|'recordings'`; for `recordings` the file pattern `^[0-9a-f-]{36}/dl/[0-9a-f-]{36}\.mp4$` under `RECORDINGS_DIR`); create the test `gateway/test/rec-download.test.ts`.
- [ ] **Steps:**
  - failing tests: `serves a recording download with ranges`, `refuses a path outside dl/`, `size mismatch answers 503 not ready`, `missing recordings dir answers 503`;
  - run `npx -w gateway vitest run test/rec-download.test.ts`: FAIL;
  - implement;
  - run it again plus `test/gateway.test.ts` and `npm run typecheck`: PASS;
  - commit `feat(gateway): serve recording downloads from the recordings mount`.

### Task 16: Web and app: *Herunterladen* for recordings

**Files:**
- Modify `web/src/lib/DownloadButton.svelte` (prop `recordingId`, mutually exclusive with `itemId`; `fetchOptions('rec:<id>')`) and `web/src/lib/offline/manager.ts` (requests carry `recordingId`).
- Modify `web/src/routes/downloads/+page.svelte` and `web/src/lib/OfflinePlayer.svelte`: recordings show the channel logo or a placeholder; play from the offline file; queue progress with `itemId 'rec:<id>'`.
- Modify `RecordingItem.svelte` (the *Herunterladen* action).
- Modify `e2e/mocks/api.ts` (rec licences, options) and `e2e/mocks/livetv.ts`.
- Android: add a fixture test `android/app/src/test/kotlin/app/friendflix/android/downloads/ServerApiTest.kt` case `parses a recording licence (rec: item, no poster)`. No app code change is expected; if parsing fails, fix it in this task. Desktop: no change (`download: false`, the browser downloader applies where available).
- Tests: create `e2e/tests/live-recording-download.spec.ts` (+ `.mobile.spec.ts`).

**Interfaces:**
- Consumes Task 14 exactly.
- *Herunterladen* is shown only when `me.downloads.allowed`, the recording is `done`/`partial` and its storage is `ff`.
- The `/downloads` nav entry already depends on `downloads.allowed` only (no libraries needed).

- [ ] **Step 1: failing tests:**
  - e2e: `Herunterladen on a finished recording creates a licence and shows progress`, `a running recording has no Herunterladen`, `downloads page lists the recording with its channel logo`, `a Live-TV-only account (no libraries) sees Downloads and its recording`, `offline playback reports rec: progress on check-in`;
  - Android: the fixture case.
- [ ] **Step 2: run** them: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4: run** them plus `npx -w web vitest run src/lib/offline` and `npm run typecheck`; run the Gradle unit test only if the Android SDK is present, else leave it to CI: PASS.
- [ ] **Step 5: commit** `feat(live): download recordings for offline viewing`.

**Stage 3c ship:** PR "Live TV: download recordings", green CI, merge after checking the roles-redesign order note above. Owner on-device check: download a recording on Android, watch it in flight mode, delete it on the server, and see the copy disappear at the next check-in.

---

## Open owner questions (defaults used until answered)

1. **Default storage mode:** the plan uses *FriendFlix-Ordner* (spec default). In library mode a Live-TV-only role (no libraries) cannot see or download its recordings. Keep `ff` as the default?
2. **Retention:** the plan uses delete 30 days after watched and never for unwatched (spec). Should unwatched recordings also expire, e.g. after 90 days?
3. **Per-role recording quota:** the spec has only the global limit (200 GB, oldest unprotected first). Is a per-role quota (GB or count) wanted? It would become a role-matrix field after the roles redesign; not planned here.
4. **Offline copies after the server copy is deleted automatically** (retention or space): the plan revokes them at the next check-in (§26). Should they instead stay valid until their own expiry?
5. **Download quota:** the plan shares `maxDownloads` between films and recordings. Should recordings get their own count?

## Later (listed only, not planned here)

- Optional **H.265 re-encode** of finished recordings (`LIVETV_REENCODE`, quiet hours `LIVETV_REENCODE_HOURS`, budget kind `reencode`, off by default).
- `livetv.rec.started` notifications (needs per-kind notification preferences).
- §25 notes: *Aufnehmen* in the player from the buffered programme start; a partial recording schedules the next airing.
- The red recording dot in the guide grid (Phase 2b, consuming `RecordSheet` and `GET /api/livetv/programme/…`).
- A per-role recording quota (see the open owner question).
