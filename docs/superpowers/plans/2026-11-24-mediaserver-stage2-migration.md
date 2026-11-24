# Managed media server stage 2 (move from Jellyfin) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An install linked to a Jellyfin on the same Docker host moves to managed Ferrofin from *Admin → Medienserver*, keeping user and item ids, with a one-click way back.

**Architecture:** The updater finds and scans the source (helpers mount its `/config` read-only), copies it in two passes, stops the source only for the final pass, and starts a migrated Ferrofin from the stage 1 template (media at Jellyfin's own container paths, data in `/ferrofin-data`). The backend then drives phases like stage 1's first run: NFO saver off, id verification, switch, request service repoint; any failure before the switch aborts (new container removed, source started). The way back starts the source, repairs users, restores the address.

**Tech Stack:** TypeScript (Node 26) updater and backend (Fastify, Postgres, vitest), Svelte web (vitest, Playwright e2e), Docker Engine API through `docker-proxy`.

**Spec:** `docs/superpowers/specs/2026-11-24-mediaserver-stage2-migration-design.md` (builds on `docs/superpowers/specs/2026-11-17-managed-mediaserver-design.md`).

## Global Constraints

- Security model of stage 1 stays: base folder confirmed by code; every create body through the guard; helpers only with listed mounts; Docker socket only on `docker-proxy`; no published port; `ReadonlyRootfs`; never uid 0.
- The old Jellyfin's config, data and media are never written: every source mount in a helper is read-only.
- The updater stops/starts only the **recorded source** (matched by `/config` mount source + server id, not by container id alone).
- Migrated media targets: absolute, normalised, 1–3 levels, not `/`, `/cache`, `/config`, `/tmp`, `/proc`, `/sys`, `/dev`, `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/var`, `/run`, `/root`, `/home`, `/ferrofin-data`, `/ffmedia` or below them; below `/data` allowed; `/data` itself refused. Empty `rel` (whole base) allowed only for migrated folders. New folders after a move mount at `/ffmedia/<slug>`.
- Migrated Ferrofin data volume target `/ferrofin-data`, env `FERROFIN_DATA_DIR=/ferrofin-data`; volume name stays `<project>_mediaserver-ferrofin-data`.
- id check: every `users.jellyfin_user_id` / `profiles.jellyfin_user_id` resolves; item sample ≤ 200 newest references, ≥ 98 % resolve.
- Free space: Docker data root free ≥ copy size × 1.2 (`no_space`).
- Old Jellyfin stays **stopped** after a successful switch; never removed.
- Request service: pointed at `http://mediaserver:8096` (same API key) on the move, back on the way back; failure there is a warning, not a failed move.
- New error codes (updater `MEDIA_ERRORS` and backend `client.ts` copy, same order appended): `source_missing`, `source_mismatch`, `source_layout`, `source_outside_base`, `source_version`, `no_space`, `adopt_failed`, `ids_mismatch`, `move_aborted`.
- New steps (`MEDIA_STEPS`): `copy_bulk`, `stop_source`, `copy`, `adopt`; backend move phases: `nfo`, `verify`, `switch`, `requests`.
- Texts: German first ("du"), then en, es, fr, it, pl, tr, identical key order; "…" not "..."; never "Netflix" or "Seerr" in user-facing text; fictional names and placeholder hosts in fixtures (`example.com`, `192.0.2.x`).
- UI: nothing jumps (reserve space), 44 px targets, transform/opacity motion only. Web statements coverage ≥ 94 %.
- Checks agents run: typecheck, the specific tests, build, lint. Backend tests: `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/ff_test_stage2` (create it once: `createdb -h 127.0.0.1 -p 5433 -U postgres ff_test_stage2`; if Postgres is down: `pg_ctlcluster 16 ffci start`). `node_modules`: `npm ci` once at the root; never `npm install`.
- Git: merge only, never rebase/force-push/`git stash`/`git add -f .superpowers`; stage only the task's files. Every commit ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`

## Review Focus

1. **A failure at any point between `stop_source` and the switch** must leave the old Jellyfin running and FriendFlix unchanged. Task 5: `every failure point restarts the source`; Task 7: `verify failure aborts and restarts the source`.
2. **A crash or restart of the updater/backend mid-move** must not strand a stopped Jellyfin. Task 5: `a move found unfinished at start restarts the source`; Task 7: `a phase found running after a backend restart resumes or aborts`.
3. **A container that merely looks like Jellyfin** (other server id, other `/config`) is never stopped. Task 4: `source_mismatch for another server id`; Task 5: `source op refuses any other container`.
4. **Jellyfin recreated with a new id** (redeploy) is still the source on the way back. Task 4: `rematch by config source and server id`.
5. **A profile created on Ferrofin, then the way back** still signs in on Jellyfin. Task 8: `way back recreates missing users and resets passwords`.

---

### Task 1: Updater types, state and op parsing

**Files:**
- Modify: `updater/src/mediaserver/types.ts`, `updater/src/mediaserver/parse.ts`, `updater/src/state.ts`, `updater/src/server.ts` (`JOB_OPS`, `ALWAYS_OPS`), `backend/src/mediaserver/client.ts` (`MEDIA_ERRORS` copy)
- Test: `updater/test/mediaserver-server.test.ts` (parse cases), `updater/test/config-state.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `Folder` gains `migrated?: true`.
  - `DesiredSpec` gains `migrated?: true` (a migrated Ferrofin: data at `/ferrofin-data`).
  - `MediaOp` gains `{op:'migrate-scan', serverId: string, source?: string}`, `{op:'migrate-done'}`, `{op:'migrate', source: string, trickplay: boolean, gpu: Gpu, uid: number, gid: number, tz: string, serverId: string}`, `{op:'migrate-abort'}`, `{op:'source-start'}`.
  - `MEDIA_JOB_ACTIONS` gains `'mediaserver-migrate'`, `'mediaserver-source'`; `MEDIA_STEPS` gains `'copy_bulk' | 'stop_source' | 'copy' | 'adopt'`; `MEDIA_ERRORS` appends the nine codes of Global Constraints.
  - `RecordedSource = { id: string; name: string; image: string; config: { type: 'bind' | 'volume'; source: string }; serverId: string; version: string | null; at: string }`.
  - `MoveState = { source: RecordedSource; folders: Folder[]; phase: 'running' | 'ready' | 'aborted' | 'done'; abort: boolean }`.
- Produces (`state.ts`): `MediaState.move?: MoveState` and `MediaState.source?: RecordedSource` (the source kept after `done` for the way back), each sanitised field by field, invalid → dropped.
- Container ids: `^[0-9a-f]{64}$`; `serverId`: `^[0-9a-f]{32}$`.

- [ ] **Step 1: Write the failing tests**
  - `parseMediaBody` accepts each new op exactly and rejects an extra key, a short container id, `trickplay` as a string, `serverId` of 31 hex.
  - `sanitizeMedia` keeps a valid `move` and `source`, drops one with an invalid id, and loads an old state without them (fields absent).
  - `JOB_OPS` contains `migrate`, `migrate-abort`, `source-start`; `migrate-scan` and `migrate-done` are synchronous (not jobs) and not in `ALWAYS_OPS`.
- [ ] **Step 2: Run** `cd updater && npx vitest run test/mediaserver-server.test.ts test/config-state.test.ts` — FAIL.
- [ ] **Step 3: Implement** the types, parse cases (reuse `exact()`), state sanitisers, server sets, and append the codes to `backend/src/mediaserver/client.ts` `MEDIA_ERRORS` in the same order.
- [ ] **Step 4: Run** the tests, `npm run typecheck -w updater`, `npm run typecheck -w backend` — PASS.
- [ ] **Step 5: Commit** `feat(updater): stage 2 ops, move state and codes`

### Task 2: Template and guard for a migrated server and source helpers

**Files:**
- Modify: `updater/src/mediaserver/template.ts`, `updater/src/mediaserver/guard.ts`
- Test: `updater/test/mediaserver-template.test.ts`, `updater/test/mediaserver-guard.test.ts`

**Interfaces:**
- Consumes: Task 1 `Folder.migrated`, `DesiredSpec.migrated`.
- Produces:
  - `isMigratedTarget(t: string): boolean` exported from `guard.ts` (the Global Constraints rule; the template imports it, the guard has its own copy of the regex/list, as stage 1 keeps two implementations — put the list in both files, not shared).
  - `containerSpec` for `d.migrated`: data mount target `/ferrofin-data`, env `FERROFIN_DATA_DIR=/ferrofin-data`; folders with `migrated` mount at their own `target` (any `isMigratedTarget`), `rel` may be `''` (then `VolumeOptions` has no `Subpath`); other folders keep `/media/<slug>` or `/ffmedia/<slug>`.
  - `assertManaged(body, e)` gains `e.migrated?: { targets: string[] }`: a target outside `/media/` and `/ffmedia/` is allowed only when listed there and `isMigratedTarget`; the data target `/ferrofin-data` and `FERROFIN_DATA_DIR` only when `e.migrated` is set (kind `ferrofin` only). `assertManagedInspect` takes the same.
  - `HelperVerb` gains `'migrate-scan' | 'migrate-copy'`; `HelperMount` gains `{ kind: 'source'; type: 'bind' | 'volume'; source: string }` mounted read-only at `/source`. `assertHelper(body, e)` gains `e.source?: { type; source }`: a `/source` mount only for the two new verbs, only read-only, only exactly `e.source`. `migrate-copy` may mount `/data` read-write (the ferrofin data volume), `migrate-scan` never mounts `/data`.

- [ ] **Step 1: Write the failing tests** (guard first, every rule, then template):
  - `migrated target rules`: accepted `/movies`, `/data/tv`, `/media`, `/srv/a/b`; refused `/`, `/data`, `/etc/x`, `/proc`, `/ferrofin-data`, `/ffmedia/x` as migrated, `/a/b/c/d`, `/a/../b`, `relative`.
  - `a non-listed target outside /media is refused even when migrated`, `empty rel only for a migrated folder`, `FERROFIN_DATA_DIR only for a migrated ferrofin`, `/ferrofin-data only when migrated`.
  - `source mount: read-only, only for migrate verbs, only the expected source`; `migrate-copy may write /data, migrate-scan may not`.
  - Template: `a migrated desired spec builds /ferrofin-data, FERROFIN_DATA_DIR and the original targets, and passes the guard`; `a later folder goes to /ffmedia/<slug>`.
- [ ] **Step 2: Run** `cd updater && npx vitest run test/mediaserver-guard.test.ts test/mediaserver-template.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the updater typecheck — PASS.
- [ ] **Step 5: Commit** `feat(updater): template and guard for a migrated Ferrofin and source helpers`

### Task 3: Helper verbs `migrate-scan` and `migrate-copy`

**Files:**
- Modify: `updater/src/mediaHelper.ts`
- Test: `updater/test/mediaserver-helpers.test.ts` (or a new `updater/test/mediaserver-migrate-helper.test.ts` with temp dir fixtures)

**Interfaces:**
- `migrate-scan` (args: none; `/source` read-only): answers `{layout: 'official' | 'linuxserver', serverId: string, bytes: number, trickplayBytes: number, plugins: string[], nfo: boolean}`; errors `source_layout`.
  - Layouts (builder confirms the server id file and the paths against the real images, Spec *Reading the source*): official `data/jellyfin.db`, `root/default`, `config/*.xml`, `metadata/`; linuxserver `data/data/jellyfin.db`, `data/root/default`, `*.xml`, `data/metadata/`.
  - `bytes` excludes logs, cache, transcodes and trickplay; `nfo` true when any library or the metadata options enable the NFO saver.
- `migrate-copy <pass: bulk|final> <trickplay: 0|1> <layout> <uid>` (`/source` read-only, `/data` read-write = the target volume): `bulk` copies everything except the database files (`*.db`, `*.db-wal`, `*.db-shm`); `final` copies the database files and every file whose size or mtime differs from the target; maps the layout to Ferrofin's data layout (`try.sh` lines ~290–300 are the reference); then, on `final`, adjusts the copied XMLs: `network.xml` (`BaseUrl` empty, HTTP port 8096, HTTPS off, the RFC1918 and Docker ranges as local networks), `encoding.xml` (ffmpeg path of our image = the template's `FFMPEG_DIR`, transcode path below `/cache`), `system.xml` (`MetadataPath`/`CachePath` cleared to defaults). Answers `{copied: number, adjusted: string[]}` (key names only).
- `check data` (existing) gains `{adopted: boolean}`: `jellyfin.db.pre-ferrofin` present under the data root.

- [ ] **Step 1: Write the failing tests** on temp-dir trees for both layouts:
  - `scan: official and linuxserver layouts, sizes with and without trickplay, plugins, nfo, server id`; `scan: an unknown layout is source_layout`.
  - `copy bulk skips the database, final copies it and only changed files`; `final adjusts BaseUrl, port, https, ffmpeg path, transcode path, metadata path and lists the keys`; `the source tree is byte-identical after both passes` (hash before/after).
  - `check data reports adopted`.
- [ ] **Step 2: Run** the test file — FAIL.
- [ ] **Step 3: Implement** in `mediaHelper.ts` (plain `node:fs`, no new dependency; XML edits as targeted element replacements, a missing element is added; unknown structure leaves the file and lists nothing).
- [ ] **Step 4: Run** tests, updater typecheck, `npx eslint updater/src/mediaHelper.ts` — PASS.
- [ ] **Step 5: Commit** `feat(updater): helper verbs to scan and copy a Jellyfin config`

### Task 4: Source discovery and scan (updater, synchronous op)

**Files:**
- Create: `updater/src/mediaserver/source.ts`
- Modify: `updater/src/mediaserver/service.ts` (the synchronous ops), `updater/src/server.ts` (route the op)
- Test: `updater/test/mediaserver-source.test.ts` (use `media-world.ts`)

**Interfaces:**
- Consumes: Task 1 types, Task 2 helper mount, Task 3 `migrate-scan`.
- Produces (`source.ts`):
  - `JELLYFIN_REPOS = ['jellyfin/jellyfin','docker.io/jellyfin/jellyfin','linuxserver/jellyfin','lscr.io/linuxserver/jellyfin']`.
  - `findCandidates(engine): Promise<Array<{id, name, image, state}>>` (running or stopped, repository match on `Config.Image` without tag/digest).
  - `classifyMounts(inspect, base: {path: string} ): { config: {type, source} | null; media: Folder[]; outside: string[] }` — skips `/cache`, transcodes, devices and `docker.sock`; a bind (or a volume whose `device` option is a host path) inside the base becomes `{rel, target, migrated: true}` (`rel` `''` for the base itself); outside → its container path in `outside`.
  - `scanSource(deps, id, expectServerId): Promise<ScanResult>`; `ScanResult = {source: RecordedSource, folders: Folder[], bytes, trickplayBytes, plugins, nfo, layout}`; errors `source_missing`, `source_mismatch` (helper's serverId ≠ expect), `source_outside_base` (with `outside` list in the answer), `source_layout`; `version` from the image's `org.opencontainers.image.version` label or tag (Ruling: the spec says "from the database"; reading SQLite needs a dependency, the image version is equivalent for the guard decision).
  - `rematch(deps, recorded: RecordedSource): Promise<string | null>` — a container with the same config source and server id; returns its id (recorded id replaced and audited by the caller), else null.
- Op answer: `migrate-scan` without `source` → `{candidates}` (each with `matches: boolean` from a scan of its server id); with `source` → `{candidates, scan}`. The backend passes FriendFlix's server id in each scan (Task 1 `serverId`).

- [ ] **Step 1: Write the failing tests:** `candidates by repository, any tag or digest, running or stopped`; `source_mismatch for another server id`; `media inside the base become migrated folders, the base itself with rel ''`; `a mount outside the base is source_outside_base with its container path only (never a host path)`; `rematch by config source and server id`; `a container with the same name but another config source is not the source`.
- [ ] **Step 2: Run** `cd updater && npx vitest run test/mediaserver-source.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests and typecheck — PASS.
- [ ] **Step 5: Commit** `feat(updater): find and scan the Jellyfin to move`

### Task 5: The move job, abort and source start (updater)

**Files:**
- Create: `updater/src/mediaserver/move.ts`
- Modify: `updater/src/mediaserver/jobs.ts` (`start()` dispatch to `move.ts`; reuse `deploy()` for create/start/health with a migrated desired spec), `updater/src/mediaserver/supervise.ts` (boot: unfinished move), `updater/src/mediaserver/status.ts` (`move` and `source` in the view)
- Test: `updater/test/mediaserver-move.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `MediaJobs.start({op:'migrate', ...})` → job `mediaserver-migrate`, steps: `check` (base confirmed; rescan matches the recorded scan's folders; free space via helper `check data`'s new `free` field or engine `info` — builder picks, ≥ bytes × 1.2 else `no_space`; Ferrofin pin present else `image_missing`) → `pull` → `verify` → `copy_bulk` → `stop_source` → `copy` (final) → `create`/`start`/`health` (`deploy()` with `{kind:'ferrofin', migrated:true, folders: scan.folders, uid, gid, gpu, mediaGid:null, egress:true, tz}`, no first-run password) → `adopt` (`check data` `adopted` else `adopt_failed`). Success: `move.phase = 'ready'`, source **left stopped**, `source` recorded.
  - Abort/failure at any step after `stop_source` or with `move.abort`: remove the new container if created (data volume kept), **start the source**, `move.phase='aborted'`, `lastError` = the code or `move_aborted`. The source start sits in a `finally`.
  - `{op:'migrate-abort'}`: during the job sets `move.abort` (checked between steps); when `phase==='ready'` it runs the abort as its own `mediaserver-migrate` job (backend calls it when its phases fail).
  - `{op:'source-start'}` → job `mediaserver-source`: `rematch` the recorded source, start it; refuses anything but the recorded source (`source_missing`).
  - Supervisor boot: a `move` with `phase==='running'` (updater restarted mid-job) → abort path (start source, remove new container).
  - `MediaStatusView` gains `move: {phase, step, source: {name, version}, folders, abort} | null` and `source: {name, state, version} | null`.
  - Done marker from the backend: `{op:'migrate-done'}` (Task 1) sets `phase='done'`, drops `move`, keeps `source`.

- [ ] **Step 1: Write the failing tests** (fake engine/helpers from `media-world.ts`):
  - `the steps run in order and the source is stopped only after copy_bulk`;
  - `every failure point restarts the source` (fail each step from `stop_source` to `adopt` in turn; assert source started, new container removed, data volume kept);
  - `abort during the job and in ready`; `a move found unfinished at start restarts the source`;
  - `source op refuses any other container`; `source-start rematches a recreated source`;
  - `no_space`, `image_missing` before anything is stopped.
- [ ] **Step 2: Run** `cd updater && npx vitest run test/mediaserver-move.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the move tests, the whole updater suite once, typecheck, eslint on touched files — PASS.
- [ ] **Step 5: Commit** `feat(updater): move job with abort, source start and recovery`

### Task 6: Backend storage, client and routes

**Files:**
- Modify: `backend/src/db.ts` (migration 62), `backend/src/mediaserver/store.ts`, `backend/src/mediaserver/client.ts`, `backend/src/routes/adminMediaserver.ts`
- Test: `backend/test/mediaserver-store.test.ts`, `backend/test/mediaserver-routes.test.ts`, `backend/test/mediaserver-client.test.ts`

**Interfaces:**
- Migration `// 62:` adds to `media_managed`: `migrated_from jsonb` (`{name, version, at}`), `move jsonb` (`{phase: 'copying'|'nfo'|'verify'|'switch'|'requests'|'done'|'failed', error, jobId, startedAt}`), `requests_prev jsonb` (`{hostname, port, useSsl, urlBase}` of the request service's Jellyfin connection; no secret).
- `store.ts`: `MediaManaged` gains `migratedFrom`, `move`, `requestsPrev`; `writeManaged` accepts them.
- `client.ts`: `parseMediaStatus` reads `move` and `source`; helpers `mediaScan(ctx, source?, serverId)`.
- `MediaView` (`adminMediaserver.ts`) gains `move: {offered: boolean, reason: OfferReason | 'plex' | null, state: …, migratedFrom, sourceState, requestsWarning: boolean}`; offered exactly when `ids_in_use` holds, the current server is an external Jellyfin, `url_pinned` does not, and the updater's media status is available.
- Routes (`P='/api/admin/mediaserver'`): `POST /move/scan` (body `{source?}`; backend adds `serverId` from `publicInfo`), `POST /move` (reauth; body `{source, trickplay}`; uid/gid/gpu from the scan + GPU detection defaults), `POST /move/abort`, `POST /back` (reauth). Rate limits like `/apply`. Audit `mediaserver.move`, `mediaserver.move_abort`, `mediaserver.back`, `mediaserver.requests_repointed` (Ruling: the spec wrote `system.mediaserver_*`; existing media server audits are `mediaserver.*`).

- [ ] **Step 1: Write the failing tests:** migration on a fresh DB and on one at 61; store round-trip; `move offered only for an external Jellyfin with linked ids`, `not for Plex`, `not when url_pinned`; route bodies (strict), reauth on `/move` and `/back`, 409 busy, audit rows.
- [ ] **Step 2: Run** the three files with `TEST_DATABASE_URL=…` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, backend typecheck, eslint — PASS.
- [ ] **Step 5: Commit** `feat(backend): stage 2 storage, updater client and move routes`

### Task 7: Backend move phases (NFO, verify, switch)

**Files:**
- Create: `backend/src/mediaserver/move.ts`
- Modify: `backend/src/mediaserver/firstRun.ts` (the tick calls `moveTick` next to `mediaManagedTick`), `backend/src/jellyfin/client.ts` (`userExists(id): Promise<boolean>` via `GET /Users/{id}`, 404 → false)
- Test: `backend/test/mediaserver-move.test.ts`

**Interfaces:**
- `moveTick(ctx, log?)`: kv lock like `mediaManagedTick`; reads `media_managed.move` and the updater's move status; phases:
  - `copying` → when the updater job ends `ready` → `nfo`; `aborted`/failed → `failed` with the code.
  - `nfo`: for every library (`GET /Library/VirtualFolders`) whose options save local metadata or have savers, `POST /Library/VirtualFolders/LibraryOptions` with `SaveLocalMetadata:false, MetadataSavers:[]` (`try.sh` recipe) against `http://mediaserver:8096` with the current key.
  - `verify`: `verifyIds(ctx, client): Promise<{users: {total, missing}, items: {sampled, missing}}>` — all `users`/`profiles` `jellyfin_user_id` via `userExists`; item sample: up to 200 newest `item_id` across `watchlist`, `play_seconds`, `list_items`, `bookmarks`, `thumbs`, `ratings`, `reminders.jf_item_id`, `livetv_recordings.jellyfin_item_id` (union by recency, distinct) via `itemById`; pass when users missing = 0 and items resolve ≥ 98 % (`ids_mismatch` otherwise, numbers in `move.error` meta).
  - `switch`: in one transaction: `external_url`/`external_key_enc` = current values; `JELLYFIN_URL` setting = `MANAGED_URL`, key unchanged; `kind='ferrofin'`, `setup='done'`; `migrated_from`; then updater `{op:'migrate-done'}`.
  - `requests` (Task 9 fills it; here a no-op step) → `done`.
  - Any failure before `switch` → updater `{op:'migrate-abort'}`, `move.phase='failed'`. A backend restart resumes the current phase (idempotent phases).
- `MANAGED_URL` from `serverApi.ts`.

- [ ] **Step 1: Write the failing tests** (fake updater client and fake Jellyfin HTTP like `mediaserver-firstrun.test.ts`):
  - `phases advance copying → nfo → verify → switch → requests → done`;
  - `nfo turns savers off only where on`;
  - `verify failure aborts and restarts the source` (users missing; items 97 %);
  - `98 % passes`; `switch keeps the key and saves the way back`;
  - `a phase found running after a backend restart resumes or aborts`.
- [ ] **Step 2: Run** with `TEST_DATABASE_URL=…` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, backend typecheck, eslint — PASS.
- [ ] **Step 5: Commit** `feat(backend): move phases: NFO saver off, id check, switch`

### Task 8: Way back and user repair; Systemcheck

**Files:**
- Modify: `backend/src/mediaserver/move.ts`, `backend/src/syscheck/checks/media.ts`
- Test: `backend/test/mediaserver-move.test.ts`, `backend/test/syscheck-core-media.test.ts`

**Interfaces:**
- `goBack(ctx, actor): Promise<{ok: true} | {ok: false, error: MediaError | 'jellyfin_unreachable'}>`: updater `source-start` job (wait ≤ 3 min), ping the saved external address with the saved key (`jellyfin_unreachable`), switch the settings back to `external_url`/key, request service back (Task 9), updater `{op:'stop'}` for the managed server, then `repairUsers(ctx)`.
- `repairUsers(ctx): Promise<{created: number, passwords: number}>`: for each user/profile with a `jellyfin_user_id` that does not resolve, create a new identity through the existing `ctx.jf.admin.createIdentity(name, password)` (password from `jellyfin_pw_enc`) and store the new id; then set every linked password again from `jellyfin_pw_enc`. Also run in the `verify` phase of a repeated move before the user check (`Erneut umziehen`).
- Systemcheck `media.managed`: info line when `migrated_from` is set ("umgezogen von „<name>“; altes Jellyfin gestoppt, für den Rückweg erhalten"); warning when `requestsWarning`.

- [ ] **Step 1: Write the failing tests:** `way back recreates missing users and resets passwords`; `way back refuses when the old Jellyfin does not answer, nothing switched`; `a repeated move repairs before verifying`; syscheck info and warning lines.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, typecheck, eslint — PASS.
- [ ] **Step 5: Commit** `feat(backend): way back with user repair; Systemcheck lines`

### Task 9: Request service repoint

**Files:**
- Modify: `backend/src/seerr/client.ts` (settings calls), `backend/src/mediaserver/move.ts` (the `requests` phase and the way back)
- Test: `backend/test/mediaserver-move.test.ts` (request service fake)

**Interfaces:**
- `SeerrClient.jellyfinSettings(): Promise<{hostname, port, useSsl, urlBase}>` (`GET /settings/jellyfin`), `SeerrClient.setJellyfinSettings(s): Promise<void>` (`POST /settings/jellyfin`, keeps the server's other fields), `SeerrClient.syncJellyfinLibraries(): Promise<void>` (`POST /settings/jellyfin/sync`). The builder confirms paths and fields against the pinned request service image (`compose.prod.yaml`); a different API → the phase records `requestsWarning` and still ends `done`.
- `requests` phase: no request service configured → skip; else save `requests_prev`, set `{hostname: 'mediaserver', port: 8096, useSsl: false, urlBase: ''}`, start the sync; failure → `requestsWarning: true`, audit `mediaserver.requests_repointed` with `ok:false`.
- Way back: restore `requests_prev` (same warning rule).

- [ ] **Step 1: Write the failing tests:** `requests repointed and synced, previous saved`; `request service refuses: move done with a warning`; `no request service: skipped`; `way back restores the previous connection`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, typecheck, eslint — PASS.
- [ ] **Step 5: Commit** `feat(backend): point the request service at the moved server and back`

### Task 10: Web: move sheet, way back, texts

**Files:**
- Create: `web/src/lib/admin/mediaserver/MoveSheet.svelte`
- Modify: `web/src/lib/admin/mediaserver/api.ts`, `model.ts`, `MediaChoice.svelte` (the reason line becomes *Von Jellyfin umziehen* when `move.offered`), `MediaServerCard.svelte` (moved state: "Umgezogen von „<name>“ am …", *Zurück zu Jellyfin*, *Erneut umziehen*, request service warning), `web/src/lib/i18n/locales/{de,en,es,fr,it,pl,tr}/mediaserver.ts`
- Test: `web/src/lib/admin/mediaserver/model.test.ts`, `api.test.ts`; `e2e/tests/admin-mediaserver.spec.ts`, `e2e/tests/admin-mediaserver.mobile.spec.ts` and the e2e API mock

**Interfaces:**
- `MediaApi` gains `moveScan(source?)`, `move({source, trickplay})`, `moveAbort()`, `back()`.
- `model.ts`: `moveSummary(scan, trickplay): {folders: string[], bytes: number, downtimeMin: number, plugins: string[]}` (downtime = final-pass estimate: database + changed files at 50 MB/s, minimum 1 min; Ruling: a fixed rate is good enough for an estimate the UI labels "etwa"), `moveSteps(view)` for the step list (`copy_bulk`, `stop_source`, `copy`, `create`, `start`, `health`, `adopt`, then `nfo`, `verify`, `switch`, `requests`).
- Sheet content and wording: the Spec's sketch (German), with *Anfrage-Dienst* and *Altes Jellyfin* lines; candidate picker when several; `source_outside_base` shows the container paths and *Basisordner ändern*; abort button while running; space reserved for scan, sizes and step list.
- All new keys in the 7 locales, identical order; error texts for the nine new codes and `jellyfin_unreachable`.

- [ ] **Step 1: Write the failing tests:** `moveSummary` (sizes, trickplay, downtime minimum), `moveSteps` order and states, api routes/bodies; e2e: one candidate → summary → steps → done; several candidates; outside the base; way back with its warning; mobile layout without horizontal scroll.
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/admin/mediaserver` and the two e2e specs (`flock … npx playwright test tests/admin-mediaserver.spec.ts tests/admin-mediaserver.mobile.spec.ts --trace off`) — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `cd web && npx svelte-kit sync && npx svelte-check --threshold error`, the e2e specs, then the full web suite once with coverage (statements ≥ 94 %) — PASS.
- [ ] **Step 5: Commit** `feat(web): move from Jellyfin and the way back in Admin → Medienserver`

### Task 11: Docs and CHANGELOG

**Files:**
- Modify: `docs/mediaserver.md`, `docs/de/mediaserver.md` (new section *Moving from Jellyfin* / *Umzug von Jellyfin* before the trial section; the trial section says the UI is the normal way now), `docs/security.md` (`## Updater`: the op list, the source mount, the one recorded source the updater may stop/start, the migrated media paths; the threat table rows at the updater), `CHANGELOG.md` (`## [Unreleased]` → `### Admin`)
- Test: the docs readers (`npm run test:docs -w backend`, `-w updater`, `-w web`, `node --test scripts/*.test.mjs`)

- [ ] **Step 1: Write** the sections: requirements (Jellyfin on this Docker host, media inside the base, the official or linuxserver image), what is copied and adjusted, the two-pass copy and downtime, what is not taken over (plugins), the request service, the old Jellyfin stopped and kept, the way back and its watch-progress note, error codes with what to do.
- [ ] **Step 2: Run** the docs readers — PASS.
- [ ] **Step 3: Commit** `docs: moving from Jellyfin to the managed Ferrofin`
