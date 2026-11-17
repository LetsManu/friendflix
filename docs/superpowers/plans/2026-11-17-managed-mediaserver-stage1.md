# Managed media server, stage 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FriendFlix sets up, supervises, updates, backs up and restores its own media server (managed Ferrofin or managed Jellyfin) from *Admin → Einstellungen → Medienserver* and wizard step 3, through the updater and a fixed container template, while an existing Jellyfin/Plex by address keeps working.

**Architecture:**
- **Updater** (`updater/src/mediaserver/`): pure rules (body, paths, code) → a fixed **template** and an independent **guard** that checks every create body (and every inspect) → an **Engine HTTP API client** (`fetch` to `docker-proxy`, negotiated API ≥ 1.45) → short-lived **helper containers** of the updater's own image (`dist/mediaHelper.js`) → **media jobs** that share `Updater`'s one-job lock, the **update phase** at the end of every update job, and a 60-s **supervisor**. One new signed route `POST /v1/mediaserver` plus two signed stream routes for the age-encrypted backup download/upload; `GET /v1/status` gains `mediaserver`.
- **Pins** follow the FriendFlix build: the backend image carries the label `io.github.letsmanu.friendflix.mediaserver.pins`. Every read of it goes through **one function, `readPins()` in `updater/src/mediaserver/pins.ts`**, so the later move of the pins into the signed release manifest (parallel project `docs/superpowers/specs/2026-11-17-ci-changed-only-design.md`, *Media server*) changes that file only (its `source` becomes the stack commit instead of the backend image id).
- **Backend** (`backend/src/mediaserver/`, `routes/adminMediaserver.ts`): migration 60 `media_managed`, the signed client, admin and setup routes, the first-run tick against the server's API, the pin-change trigger, audit, Systemcheck `media.managed`, and the streamed backup download/upload. **Web**: the *Medienserver* card first on the media tab and the same components in wizard step 3.

**Tech Stack:** Node 26 (updater: no framework, `node:http`), Docker Engine API 1.45–1.52 through linuxserver/socket-proxy, `age-encryption` 0.3.1 (new, updater runtime), Fastify + Postgres + zod 4 (backend), SvelteKit SPA, vitest, Playwright e2e with mocks, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-17-managed-mediaserver-design.md` — stage 1 only (sections *Owner decisions* … *Testing (stage 1)*). Stages 2–4 are not planned here.

## Controller's calls (stage 1)

Rulings where the spec is silent or contradicts itself; the tasks follow them.

1. **Backup volume mounted into the updater.** The spec streams archives from `<project>_mediaserver-backup` but gives the updater no path to it (archive endpoint blocked, helpers have no network). `compose.prod.yaml` declares volume `mediaserver-backup` (compose names it `<project>_mediaserver-backup`; label `friendflix.managed: mediaserver-backup`) mounted into `updater` at `/backups`; the updater image creates `/backups` mode `0777`, so the copy-up makes it writable for uid 1000 and every helper uid. Ships with the `ALLOW_LOGS` compose refresh; The compose volume carries only `friendflix.managed` (no `friendflix.project`: compose names it by project). `docker compose down -v` removes the backup volume; the encrypted download is the off-host copy (owner-approved, spec *Backup and restore* amended).
2. **Stream routes are signed over the passphrase header:** `x-ff-backup-passphrase` carries **base64url(UTF-8 passphrase)** (header values cannot carry `ł`/`ş`); for the download and upload routes the signature's body string is that header value; every side checks 12–1024 code points after decoding; age authenticates the stream (`backup_invalid` on any change). Docs and UI keep `age -d` with the typed passphrase.
3. **Status additions:** `mediaserver.pins: {ferrofin, jellyfin}` (booleans), `mediaserver.backups`, `mediaserver.hdr`; `container.template` is `'current' | 'update_pending'`; `container.createdAt`; `container` is also built for a labelled container of this project that is not adopted (`tampered: true`).
4. **`base-confirm` with a container** keeps folders that exist below the new base, drops the rest, starts a `mediaserver-apply` job itself (answer carries `job`); the old base volume goes when it succeeds. `busy` while a job runs (code not consumed).
5. **Extra backend routes:** `DELETE /api/admin/mediaserver/base`, `GET /api/admin/mediaserver/libraries`, `DELETE /api/admin/mediaserver/libraries/:slug`.
6. **Rate limits** (spec amended, owner-approved): browse and gpu 30/min; job actions 3 per 2 min portal-wide (the livetv limit); base 3/10 min, confirm 10/10 min, logs 20/min.
7. **Pin label:** one value, entries joined by one space, `jellyfin=…` first; set through build-push-action `labels:` (not a Dockerfile `ARG`: `scripts/reproduce-image.sh --compare` copies labels, so the backend stays reproducible). `docker` gets `needs: mediaserver-image` + `if: ${{ !cancelled() }}`; `mediaserver-image` outputs `digest` (empty on PRs or failure → no `ferrofin` entry). The ci-changed-only project removes this wait.
8. **Browser download** by `fetch` with the passphrase header into `showSaveFilePicker()`, else a Blob; nothing stored server-side.
9. **First-run failures** keep `setup` at the failing step with `setup_error`; the tick skips such a row; *Nochmal* clears it. `setup = 'failed'` only for `wizard_taken`.
10. **Id rule:** in use when `exists(select 1 from users) or exists(select 1 from profiles where jellyfin_user_id is not null)`. Library references: lists = `list_items` + `watchlist`, resume = `resume_hidden`, recordings = `livetv_recordings.jellyfin_item_id`, against the library's item ids from the server.
11. **Base path extras:** below the Docker root is refused like containing it; below the stack directory is allowed (chosen folders need ≥ 1 component, so the stack directory's own files are never mounted). A bound base that looks like a system root (≥ 3 of `bin boot dev etc proc sys usr`) or a Docker root (`volumes` plus one of `image overlay2 containers`) is `path_refused` (catches a symlink to `/`).
12. **Timeouts:** updater `requestTimeout` 3 h (uploads) with a 10-s `readBody` deadline; synchronous ops' helpers 25 s; backend media calls 30 s.
13. **Interrupted recreate:** a labelled `<project>-mediaserver-old` without `<project>-mediaserver` is renamed back (started when `desired.run`); `-old` beside a healthy main container is removed.
14. **Backups:** id `<kind>-<YYYYMMDD-HHMM>-<upstream>` (UTC; a clash replaces the older); first tar entry `friendflix-backup.json` `{v:1, kind, upstream, createdAt}`; another kind is `kind_mismatch`.
15. **Seed rule** (spec amended: "a directory writable by the uid"): seed when `${uid}:${gid}` differs from the image's owner of the target, at a per-kind directory the uid can write (an image directory owned by it, or mode 1777); `uid_unsupported` when a seed is needed and the kind has none.
17. **`desired.run` is the owner's choice:** only `apply`, `start` and `restart` set `run: true`; `stop` and *Managed → external* set `false`; `update`, the update phase, the pin tick, `recover` and `finish-setup` keep it, and with `run: false` the update/phase/pin tick skip (status keeps `update_pending`).
18. **`media.pinSource`** is set by every deploy that reads pins (apply, update, recover, finish, phase); the status read only compares.
19. **Helper containers are removed with their anonymous volumes** (`Engine.remove(id, { volumes: true })`, `?v=1`): helpers, seeds, HDR runs and `cleanupHelpers`; never the media server.
16. **Folder depth:** chosen `rel` 1–3 components; `browse` `rel` 0–2.

## Global Constraints

- **Security boundary (Anti-goals):** no route from any role can make the media server or a helper see a host path outside the confirmed base, write to it, or see it outside the picked folders; the backend can send no image, path outside the base, device, capability, port, network or environment variable; a body with an unknown key is 400 `invalid_body`; every create body passes the guard before it leaves the process; a refusal is `template_violation` and never retried.
- **Docker socket** only for `docker-proxy`, never for web, backend, gateway, livetv or the media server. The proxy gains `ALLOW_LOGS: 1` and nothing else.
- **Secrets never logged:** the base code goes only to the updater's stdout (one line), never into the job log, `/v1/status`, an answer, an audit row or an error; the generated admin password, API keys, backup passphrases and server log secrets never reach a log, an audit row, an answer or the job log. Job log lines are fixed messages and codes (never a path below the base, never server output). Answers carry codes, never Docker or server text.
- **Never "Netflix" or "Seerr"** in user-facing text, code comments or docs. **Fictional names and placeholder hosts only:** Anna Beispiel, Ben Muster; `friend.example.com`, `192.0.2.x`; host paths `/srv/media`, `/srv/friendflix`.
- **7 locales** de, en, es, fr, it, pl, tr with identical key order; German is the source, "du" form, real umlauts; "…" not "...". The spec's German names are used verbatim (*Ferrofin (eigener)*, *Jellyfin (offiziell, verwaltet)*, *Bestehender Jellyfin/Plex (Adresse)*, *Code anfordern*, *Einrichten*, *Übernehmen*, *Starten*, *Stoppen*, *Neu starten*, *Aktualisieren*, *Sicherung*, *Wiederherstellen*, *Protokoll*, *Entfernen*, *Neu anlegen*, *Nochmal*, *Erneut versuchen*, *Herunterladen*, *Aus Datei wiederherstellen*, *HDR-Test*, *Test*, "Umzug von deinem Jellyfin: kommt mit Stufe 2", "Wechsel von Plex: kommt mit Stufe 4", "neuer als dieser FriendFlix-Stand").
- **UI:** animate only transform/opacity; never scale text; nothing may jump (reserve space for results, errors, countdowns, progress); 44 px touch targets (36 px mouse-only); glass look (`.frost`, `--fr-r-*`), brand tokens `--acc*`. **Web coverage gate** ≥ 94 % statements.
- **Checks agents run:** typecheck, the specific tests, build, lint; CI runs the rest.
  - Updater: `cd updater && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json --noEmit`; `cd updater && npx vitest run test/<file>`.
  - Backend: `cd backend && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json --noEmit`; `cd backend && TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/ff_test_media npx vitest run test/<file>`.
  - Web: `cd web && npx svelte-kit sync && npx svelte-check --threshold error` (4 known env errors in `routes/manifest.webmanifest/+server.ts` and `routes/cast-receiver/+server.ts`); `cd web && npx vitest run <file>`; `npm run build -w web`.
  - e2e: `flock /tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/e2e.lock -c 'cd e2e && E2E_PORT=<free> PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx playwright test <spec> --trace off'`.
  - `npx eslint <touched files>`.
- **Dependencies:** `node_modules` is a shared symlink: never run `npm install`. The one new dependency is `age-encryption` **0.3.1** (exact, `updater/package.json` `dependencies` + root `package-lock.json`); the controller installs it before Task 8 starts.
- **gitleaks:** token-shaped test values (43-char passwords, API keys) are built from pieces (`'A'.repeat(43)`, `'k' + 'ey-' + n`), or their fingerprint goes into `.gitleaksignore` in the same commit.
- **Git:** merge, never rebase or force-push; never `git stash`; never `git add -f .superpowers`; add only the files the task names. Every commit ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`
- **Exact values:**

  | What | Value |
  |---|---|
  | Kinds / GPU | `ferrofin` \| `jellyfin`; `off` \| `dri` \| `nvidia` |
  | Names | container `<project>-mediaserver`, hostname/alias `mediaserver`, aside `<project>-mediaserver-old`; volumes `<project>_mediaserver-ferrofin-data` (→ `/data`), `<project>_mediaserver-ferrofin-cache` (→ `/cache`), `<project>_mediaserver-jellyfin-config` (→ `/config`), `<project>_mediaserver-jellyfin-cache` (→ `/cache`), `<project>_mediaserver-base-<first 8 hex of sha256(path)>`, `<project>_mediaserver-backup`; helpers `<project>-mediahelper-<8 hex>`; networks `<project>_media`, `<project>_egress` |
  | Labels | container: `friendflix.managed=mediaserver`, `friendflix.project=<project>`, `friendflix.kind=<kind>`, `friendflix.template=1`, `friendflix.spec=<sha256 hex>`, `com.centurylinklabs.watchtower.enable=false`; volumes `friendflix.managed=mediaserver-data\|-cache\|-base\|-backup` + `friendflix.project`; helpers `friendflix.managed=helper` + `friendflix.project` |
  | Pin label | `io.github.letsmanu.friendflix.mediaserver.pins`; entries `jellyfin=docker.io/jellyfin/jellyfin:X.Y.Z@sha256:<64 hex>` and `ferrofin=ghcr.io/<owner lc>/<repo lc>-mediaserver@sha256:<64 hex>`; Ferrofin upstream label `io.github.letsmanu.friendflix.mediaserver.ferrofin` |
  | Engine | API floor `1.45` (`engine_old` below), cap `1.52`, path `/v<negotiated>/…`, base `http://docker-proxy:2375` from `DOCKER_HOST` |
  | Base code | 12 Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), shown `XXXX-XXXX-XXXX`, sha256 stored, 30 min, 5th wrong attempt clears, one pending, `base-request` ≤ 3 per 10 min (updater, in memory) |
  | Log line | `FriendFlix media folder: to allow <path> as the media base folder, enter the code <XXXX-XXXX-XXXX> in Admin (valid until <HH:MM> UTC).` |
  | Paths | absolute, normalised, ≤ 200 chars, components `^[\p{L}\p{N} ._\-+()&']+$` (u flag) not starting with `.`; folders ≤ 20, `rel` 1–3 components ≤ 200 chars; target `^/media(/[a-z0-9-]{1,40}){1,3}$`; slug `[a-z0-9-]{1,40}`; library name 1–60 chars; browse ≤ 300 entries |
  | Body | `MAX_BODY` 8192 for `/v1/mediaserver`, 1024 elsewhere; `password` `^[A-Za-z0-9_-]{43}$`; `tz` `^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$`; `uid`, `gid`, `mediaGid` integers 1–65535; `tail` 50–500 |
  | Times | helper 2 min (sync ops 25 s; backup/restore 2 h); health 3 min (`healthy`, or running 60 s without a healthcheck); supervisor 60 s, folder/GPU re-check every 10 min; `StopTimeout` 30; first-run tick 10 s; backend media calls 30 s |
  | Backups | keep last 3 manual+upload, last 2 auto; file `<id>.tar.gz`, download name `<id>.tar.gz.age`; passphrase 12–1024 code points, header `x-ff-backup-passphrase` = base64url(UTF-8) (Controller's call 2); upload ≤ 20 GiB (encrypted bytes) |
  | First run | admin `friendflix-admin`, password 32 random bytes base64url (43 chars, stored `crypto.encrypt`); `JELLYFIN_URL=http://mediaserver:8096` |
  | Job actions | `mediaserver-apply`, `-finish`, `-start`, `-stop`, `-restart`, `-update`, `-hdr-test`, `-backup`, `-restore`, `-remove`, `-recover`; new job state `succeeded_mediaserver_failed` |
  | Audit | `mediaserver.base_request` {path}, `mediaserver.base_confirm` {result: ok\|wrong\|expired\|locked, path on ok}, `mediaserver.base_clear`, `mediaserver.apply` {kind, folders: n, gpu, egress}, `mediaserver.action` {op}, `mediaserver.result` {action, result, error}, `mediaserver.recover`, `mediaserver.backup_download` {id}, `mediaserver.backup_upload` {size}, `mediaserver.mode` {from, to} |

## Review Focus

1. **A base path that leads somewhere else:** a symlink (or a symlinked component) to `/` or to the Docker root, a path below a custom Docker root (`/data/docker/volumes`), or `/srv/media/` with a trailing slash. Expected: refused (`path_refused` / `path_invalid`), nothing created, no log line. Tests: Task 1 `refuses a path below the Docker root and accepts one below the stack dir`, Task 4 `checkBase flags a system root and a Docker root`, Task 5 `a base that looks like a system root issues no code`.
2. **The NAS share is unmounted or a folder renamed after setup:** the supervisor must not recreate in a loop or remove anything; the status names `base_missing`/`folder_missing`; an update or apply fails at `check` and the running container stays. Tests: Task 7 `missing base: no recreate loop, error reported, container untouched`, Task 6 `apply with a vanished folder fails at check and keeps the old container`.
3. **The updater dies in the middle of a recreate** (old container renamed aside, new one not healthy yet). Expected: after its restart the old server comes back under its name (started when it should run), the job reads `interrupted`, nothing is removed. Tests: Task 7 `an -old container without a main one is renamed back and started`.
4. **A damaged or wrong backup transfer:** wrong passphrase, a truncated or > 20 GiB upload, the browser closing a download midway, a restore of the other kind or a newer upstream. Expected: `backup_invalid` / `kind_mismatch` / `downgrade_refused`, no partial file left in `/backups`, no job lock held, the data volume untouched. Tests: Task 8 `wrong passphrase leaves nothing`, `an upload over the limit is cut and removed`, `an aborted download releases the backup`; Task 16 `the backend passes the client abort on`.
5. **Two backend instances run the first-run tick, or a restart lands mid-step.** Expected: one administrator, one API key, one library per folder (each step idempotent under a kv lock). Tests: Task 14 `two ticks at once run one step`, `a restart after the libraries step creates no second library`.

---

### Task 1: Updater — media types, body parsing, path and folder rules, base code

**Files:**
- Create: `updater/src/mediaserver/types.ts`, `updater/src/mediaserver/parse.ts`, `updater/src/mediaserver/paths.ts`, `updater/src/mediaserver/code.ts`
- Test: `updater/test/mediaserver-rules.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export const KINDS = ['ferrofin', 'jellyfin'] as const; export type Kind = (typeof KINDS)[number];
  export const GPUS = ['off', 'dri', 'nvidia'] as const; export type Gpu = (typeof GPUS)[number];
  export interface Folder { rel: string; target: string }
  export interface DesiredSpec { kind: Kind; folders: Folder[]; uid: number; gid: number; gpu: Gpu; mediaGid: number | null; egress: boolean; tz: string }
  export type Desired = DesiredSpec & { run: boolean };
  export type MediaOp =
    | { op: 'base-request'; path: string } | { op: 'base-confirm'; code: string } | { op: 'base-clear' }
    | { op: 'browse'; rel: string } | { op: 'gpu' } | { op: 'logs'; tail: number }
    | { op: 'apply'; spec: DesiredSpec; firstRun?: { password: string } } | { op: 'finish-setup' }
    | { op: 'start' | 'stop' | 'restart' | 'update' } | { op: 'hdr-test'; kind: Kind }
    | { op: 'backup'; trickplay: boolean } | { op: 'restore'; id: string } | { op: 'remove'; data: boolean };
  export const MEDIA_JOB_ACTIONS = ['mediaserver-apply', 'mediaserver-finish', 'mediaserver-start', 'mediaserver-stop', 'mediaserver-restart', 'mediaserver-update', 'mediaserver-hdr-test', 'mediaserver-backup', 'mediaserver-restore', 'mediaserver-remove', 'mediaserver-recover'] as const;
  export type MediaJobAction = (typeof MEDIA_JOB_ACTIONS)[number];
  export const MEDIA_STEPS = ['check', 'pull', 'verify', 'snapshot', 'create', 'start', 'health', 'rollback'] as const; export type MediaStep = (typeof MEDIA_STEPS)[number];
  export const MEDIA_ERRORS = ['no_base', 'base_missing', 'folder_missing', 'folder_symlink', 'folder_nested', 'folder_unreadable', 'too_many_folders', 'gpu_missing', 'nvidia_missing', 'no_network', 'name_taken', 'pull_failed', 'image_missing', 'arch_unsupported', 'verify_failed', 'snapshot_failed', 'downgrade_refused', 'template_violation', 'uid_unsupported', 'uid_mismatch', 'library_referenced', 'engine_old', 'create_failed', 'start_failed', 'unhealthy', 'managed_tampered', 'backup_failed', 'backup_invalid', 'kind_mismatch', 'restore_failed', 'remove_failed', 'interrupted', 'pin_invalid', 'no_logs', 'no_project', 'helper_timeout', 'helper_failed'] as const;
  export type MediaError = (typeof MEDIA_ERRORS)[number];
  export type BackupTag = 'manual' | 'auto' | 'upload';
  export interface BackupMeta { id: string; kind: Kind; upstream: string; at: string; tag: BackupTag; size: number }
  export interface HdrResult { kind: Kind; at: string; opencl: 'pass' | 'fail'; qsv: 'pass' | 'fail' }
  export const BACKUP_ID_RE = /^(ferrofin|jellyfin)-[0-9]{8}-[0-9]{4}-[0-9A-Za-z.+_-]{1,40}$/;
  ```
- Produces (`parse.ts`): `parseMediaBody(raw: unknown): MediaOp | null` — exactly the keys of one variant (extra or missing keys, wrong types → null); `firstRun` only with `kind: 'ferrofin'`; `mediaGid` is `number | null` and required in `spec`; folders 0–20 (0 allowed: an apply with no folder yet is refused later by `check`, not here), no duplicate `rel` or `target`.
- Produces (`paths.ts`): `checkBasePath(path: string, f: { dockerRoot: string | null; stackDir: string | null }): null | 'path_invalid' | 'path_refused'`; `isRel(rel: string, min: number, max: number): boolean`; `isTarget(t: string): boolean`; `nestedFolders(rels: readonly string[]): boolean`.
- Produces (`code.ts`): `newBaseCode(): { display: string; hash: string }`, `normalizeBaseCode(input: string): string` (upper case, strip spaces and `-`, `O`→`0`, `I`/`L`→`1`, exactly like `backend/src/setup/code.ts` `normalizeCode`), `hashBaseCode(normalized: string): string` (sha256 hex), `baseCodeLogLine(path: string, display: string, expiresAt: Date): string`.

- [ ] **Step 1: Write the failing tests** (`mediaserver-rules.test.ts`):
  - `parses every op exactly`: each variant of `MediaOp` with the minimal valid body round-trips; `{op:'apply', spec, firstRun:{password:'A'.repeat(43)}}` with `kind:'ferrofin'` passes, with `kind:'jellyfin'` → null; `{op:'start', x:1}`, `{op:'logs', tail:49}`, `{op:'logs', tail:501}`, `{op:'logs', tail:'300'}`, `{op:'remove'}`, `{op:'restore', id:'../x'}`, arrays and `null` → null; `uid: 0`, `gid: 65536`, `mediaGid: 0`, `tz: 'Europe/Berlin;rm'`, `password: 'A'.repeat(42)`, 21 folders, two folders with the same target, an unknown key inside `spec` or inside a folder → null; `tz: 'America/Argentina/Buenos_Aires'` and `'UTC'` pass.
  - `base path syntax`: `/srv/media`, `/mnt/nas/Filme & Serien`, `/volume1/Medien (alt)`, `/srv/médias`, `/srv/media's` → null; `srv/media`, `/srv/media/`, `/srv//media`, `/srv/./media`, `/srv/../etc`, `/srv/.hidden`, `/srv/media$x`, 201 characters → `'path_invalid'`.
  - `refused bases`: `/`, `/etc`, `/etc/x`, `/lib64/x`, `/usr/share/media`, `/var/run`, `/var/lib/docker/volumes`, `/home`, `/var`, `/opt`, `/mnt`, `/media`, `/srv`, `/volume1` → `'path_refused'`; `/home/anna/Filme`, `/mnt/nas`, `/srv/media`, `/volume1/video` → null.
  - `refuses a path below the Docker root and accepts one below the stack dir`: with `{ dockerRoot: '/data/docker', stackDir: '/srv/friendflix' }`: `/data` (contains), `/data/docker` (equals), `/data/docker/volumes` (below) → `'path_refused'`; `/srv` (contains stack, also a top-level tree) and `/srv/friendflix` → `'path_refused'`; `/srv/friendflix/media` → null.
  - `folder rules`: `isRel('Filme', 1, 3)`, `isRel('Serien/Kinder/Neu', 1, 3)` true; `''`, `'a/b/c/d'`, `'/Filme'`, `'Filme/'`, `'.cache'`, `'a/../b'` false for `(1, 3)`; `isRel('', 0, 2)` true; `nestedFolders(['Filme', 'Filme/Kinder'])` true, `(['Filme', 'Filmeklassiker'])` false; `isTarget('/media/filme')` true, `'/media'`, `'/data/x'`, `'/media/../data'`, `'/media/Filme'` false.
  - `base code`: 1000 codes from `newBaseCode()` all match `^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$`; `hash === hashBaseCode(normalizeBaseCode(display))`; `normalizeBaseCode('k7qm 2d9x-ht4r')` → `'K7QM2D9XHT4R'`, `'oil'` → `'011'`; `baseCodeLogLine('/srv/media', 'K7QM-2D9X-HT4R', new Date('2026-11-17T14:32:10Z'))` → `'FriendFlix media folder: to allow /srv/media as the media base folder, enter the code K7QM-2D9X-HT4R in Admin (valid until 14:32 UTC).'`
- [ ] **Step 2: Run** `cd updater && npx vitest run test/mediaserver-rules.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the four modules. `checkBasePath`: syntax first, then the refused trees (prefix match on whole components; first component `^lib` counts as `/lib*`), the top-level-only list (`home var opt mnt media srv` and `^volume[0-9]+$` as the whole path), then Docker root (contains, equals or below) and stack dir (contains or equals). Code generation like `newSetupCode` (`randomBytes(12)`, `byte & 31`).
- [ ] **Step 4: Run** the test file and the updater typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(updater): media server body parsing, path rules and base code`.

### Task 2: Updater — container template, helper template, guard

**Files:**
- Create: `updater/src/mediaserver/template.ts`, `updater/src/mediaserver/guard.ts`, `updater/test/fixtures/mediaserver-inspect.json`
- Test: `updater/test/mediaserver-template.test.ts`, `updater/test/mediaserver-guard.test.ts`

**Interfaces:**
- Consumes: Task 1 `DesiredSpec`, `Kind`, `Gpu`, `isTarget`.
- Produces (`template.ts`):
  ```ts
  export interface CreateRequest { name: string; body: Record<string, unknown> }
  export interface TemplateFacts { project: string; image: string /* repo@sha256:… */; renderGids: number[]; baseVolume: string }
  export const names: (project: string) => { container: string; old: string; data(k: Kind): string; cache(k: Kind): string; base(path: string): string; backup: string; helper(): string };
  export const STATE_TARGETS: Record<Kind, { data: string; cache: string }>; // ferrofin /data,/cache; jellyfin /config,/cache
  export const ENV_KEYS: Record<Kind, readonly string[]>; // ferrofin ['TZ','FERROFIN_ADMIN_PASSWORD','NVIDIA_DRIVER_CAPABILITIES'] (+ Ferrofin v1.5.x's admin-name variable if it has one: FERROFIN_ADMIN_NAME const, builder); jellyfin ['TZ','XDG_CACHE_HOME','NVIDIA_DRIVER_CAPABILITIES']
  export const IMAGE_OWNER: Record<Kind, string>; // ferrofin '1000:1000', jellyfin '0:0'
  export const SEED_DIR: Record<Kind, string | null>; // Controller's call 15: a directory the uid can write (image dir owned by it, or mode 1777); start with '/tmp' for both, confirm on the pinned images, null where the copy-up does not give the uid a writable volume
  export function needsSeed(kind: Kind, uid: number, gid: number): boolean;
  export function uidSupported(kind: Kind, uid: number, gid: number): boolean;
  export function containerSpec(d: DesiredSpec, f: TemplateFacts, o?: { password?: string }): CreateRequest;
  export function seedSpec(kind: Kind, which: 'data' | 'cache', d: DesiredSpec, f: TemplateFacts): CreateRequest; // never started; mounts the fresh volume at SEED_DIR[kind]
  export function canonical(v: unknown): string;       // JSON with keys sorted recursively
  export function specHash(body: Record<string, unknown>): string; // sha256 hex of canonical(body) with Labels['friendflix.spec'] removed
  export function volumeSpec(project: string, which: 'base' | 'data' | 'cache', o: { kind?: Kind; path?: string }): { Name: string; Driver: 'local'; DriverOpts: Record<string, string>; Labels: Record<string, string> };
  export type HelperVerb = 'check' | 'browse' | 'gpu' | 'backup' | 'restore';
  export type HelperMount = { kind: 'base'; volume: string } | { kind: 'request'; path: string } | { kind: 'dri' } | { kind: 'drm' } | { kind: 'data'; volume: string; rw: boolean } | { kind: 'backup'; rw: boolean };
  export interface HelperRequest { verb: HelperVerb; args: string[]; uid: number; gid: number; groups: number[]; mounts: HelperMount[] }
  export function helperSpec(h: HelperRequest, f: { project: string; image: string /* updater image id */ }): CreateRequest;
  export function hdrSpec(test: 1 | 2, o: { project: string; kind: Kind; image: string; uid: number; gid: number; renderGids: number[]; node: string /* renderD128 */ }): CreateRequest;
  export const FFMPEG_DIR: Record<Kind, string>; // ferrofin '/usr/local/bin', jellyfin '/usr/lib/jellyfin-ffmpeg' (confirm on the pinned images)
  export const HDR_TEST1_ARGS: readonly string[]; // probe.sh test 1 argv after the ffmpeg path, device as '/dev/dri/<node>'
  export const HDR_INNER: string; // probe.sh's INNER script verbatim, with its FF=/FP= line built from FFMPEG_DIR[kind]; run as `sh -c HDR_INNER probe /dev/dri/<node>`
  ```
  Helper mount targets: base → `/base` (volume, ro, `NoCopy`), request → `/base` (bind, ro), dri → `/dev/dri` (bind, ro), drm → `/sys-drm` (bind of `/sys/class/drm`, ro), data → `/data`, backup → `/backups` (volume `names(project).backup`). Helper body: `Cmd ['node','updater/dist/mediaHelper.js', verb, ...args]`, `User '<uid>:<gid>'`, `GroupAdd` = groups as strings, `HostConfig { NetworkMode:'none', ReadonlyRootfs:true, CapDrop:['ALL'], SecurityOpt:['no-new-privileges:true'], AutoRemove:false, Tmpfs:{'/tmp':'size=64m'}, Mounts }`, labels `friendflix.managed=helper`, `friendflix.project`. `hdrSpec`: the media image; test 1 `Entrypoint [<FFMPEG_DIR[kind]>/ffmpeg]`, `Cmd HDR_TEST1_ARGS` (pass = exit 0); test 2 `Entrypoint ['/bin/sh']`, `Cmd ['-c', HDR_INNER, 'probe', '/dev/dri/<node>']` (pass = stdout has a line starting `RESULT qsv PASS`); the `/dev/dri` device as in the template, `GroupAdd` render gids, `NetworkMode:'none'`, read-only root, `/tmp` tmpfs `size=256m`, no mounts.
- Produces (`guard.ts`):
  ```ts
  export class TemplateViolation extends Error { constructor(readonly field: string) }
  export interface ManagedExpect { project: string; kind: Kind; uid: number; gid: number; repo: string /* UPDATE_REPO */ }
  export function assertManaged(body: unknown, e: ManagedExpect): void;
  export function assertManagedInspect(inspect: unknown, e: ManagedExpect & { image: { env: string[]; entrypoint: string[] | null; cmd: string[] | null; volumes: string[] } }): void;
  export function assertHelper(body: unknown, e: { project: string; uid: number; gid: number; image: string; verb: HelperVerb | 'hdr' | 'seed'; bind?: string /* the requested path, check base only */; kind?: Kind /* seed */ }): void;
  ```
  Helper rules: bind mounts only `e.bind` at `/base` (verb `check`) and `/dev/dri` + `/sys/class/drm` (verb `gpu`); `data` volume rw only for `restore`; `backup` rw only for `backup`/`restore`. `seed` has its own rule: exactly one rw volume `<project>_mediaserver-<kind>-(data|cache|config)` at `SEED_DIR[kind]`, `Cmd ['true']`, the kind's pinned image, nothing else (never started).
  The guard imports only types from `template.ts` and keeps its own literals (allowed repositories `ghcr.io/<owner lc>/<repo lc>-mediaserver` and `docker.io/jellyfin/jellyfin`, env key lists, targets).

- [ ] **Step 1: Write the failing tests:**
  - `mediaserver-template.test.ts`, with `IMG = 'ghcr.io/letsmanu/friendflix-mediaserver@sha256:' + 'a'.repeat(64)`, `BASE = 'friendflix_mediaserver-base-' + sha256('/srv/media').slice(0, 8)`, `D = { kind:'ferrofin', folders:[{rel:'Filme', target:'/media/filme'}, {rel:'Serien', target:'/media/serien'}], uid:1000, gid:1000, gpu:'dri', mediaGid:2000, egress:true, tz:'Europe/Berlin' }`, facts `{ project:'friendflix', image: IMG, renderGids:[993], baseVolume: BASE }`:
    - `golden: ferrofin with Intel/AMD`:
      ```ts
      const req = containerSpec(D, F);
      expect(req.name).toBe('friendflix-mediaserver');
      const { Labels, ...rest } = req.body as { Labels: Record<string, string> };
      expect(rest).toEqual({
        Hostname: 'mediaserver', User: '1000:1000', Image: IMG, Env: ['TZ=Europe/Berlin'], StopTimeout: 30,
        HostConfig: {
          NetworkMode: 'friendflix_media',
          Mounts: [
            { Type: 'volume', Source: 'friendflix_mediaserver-ferrofin-data', Target: '/data', ReadOnly: false },
            { Type: 'volume', Source: 'friendflix_mediaserver-ferrofin-cache', Target: '/cache', ReadOnly: false },
            { Type: 'volume', Source: BASE, Target: '/media/filme', ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: 'Filme' } },
            { Type: 'volume', Source: BASE, Target: '/media/serien', ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: 'Serien' } },
          ],
          Tmpfs: { '/tmp': 'size=512m,mode=1777' }, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
          Devices: [{ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' }], GroupAdd: ['993', '2000'],
          RestartPolicy: { Name: 'unless-stopped' }, Init: true, PidsLimit: 4096,
          LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
        },
        NetworkingConfig: { EndpointsConfig: { friendflix_media: { Aliases: ['mediaserver'] } } },
      });
      expect(Labels).toEqual({ 'friendflix.managed': 'mediaserver', 'friendflix.project': 'friendflix', 'friendflix.kind': 'ferrofin',
        'friendflix.template': '1', 'com.centurylinklabs.watchtower.enable': 'false', 'friendflix.spec': specHash(req.body) });
      ```
    - `golden: jellyfin with NVIDIA, no egress, no media group`: `Image 'docker.io/jellyfin/jellyfin@sha256:' + 'b'.repeat(64)`, `Env ['TZ=Europe/Berlin', 'XDG_CACHE_HOME=/cache/xdg', 'NVIDIA_DRIVER_CAPABILITIES=compute,video,utility']`, mounts `/config` (`…-jellyfin-config`) and `/cache` (`…-jellyfin-cache`) then the media mounts, `DeviceRequests: [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]`, no `Devices`, no `GroupAdd` key, `friendflix.kind` `jellyfin`; everything else as above.
    - `gpu off: no Devices, DeviceRequests or GroupAdd`; `first run adds FERROFIN_ADMIN_PASSWORD after TZ only when given`; `render gids sorted, deduplicated with mediaGid, at most 4 render gids` (`[44, 993, 44, 105, 106, 107]` → throws `TemplateViolation('GroupAdd')`).
    - `the spec hash is stable and changes with every field`: same input twice → same `friendflix.spec`; each of uid, a folder, gpu, egress-irrelevant (egress is not in the body: same hash), tz, render gids changes it.
    - `seed only where the uid differs from the image owner`: `needsSeed('ferrofin', 1000, 1000)` false, `needsSeed('jellyfin', 1000, 1000)` true; `seedSpec('jellyfin','data', …)` mounts `friendflix_mediaserver-jellyfin-config` at `SEED_DIR.jellyfin` with the same image, user, labels `friendflix.managed=helper`, `Cmd ['true']`, and passes `assertHelper(…, { verb: 'seed' })`; with `SEED_DIR.jellyfin = null` (override through a test-only parameter) `uidSupported('jellyfin', 1000, 1000)` false.
    - `volumes`: `volumeSpec('friendflix','base',{path:'/srv/media'})` → `{ Name: BASE, Driver: 'local', DriverOpts: { type: 'none', o: 'bind,ro', device: '/srv/media' }, Labels: { 'friendflix.managed': 'mediaserver-base', 'friendflix.project': 'friendflix' } }`; data/cache volumes have empty `DriverOpts` and `-data`/`-cache` labels.
    - `helpers`: `helperSpec({ verb:'browse', args:['Filme'], uid:1000, gid:1000, groups:[2000], mounts:[{kind:'base', volume: BASE}] }, { project:'friendflix', image:'sha256:' + 'c'.repeat(64) })` → name matches `^friendflix-mediahelper-[0-9a-f]{8}$`, the body fields above, one mount `{Type:'volume', Source: BASE, Target:'/base', ReadOnly:true, VolumeOptions:{NoCopy:true}}`.
    - `HDR tests match probe.sh`: read `../mediaserver/probe.sh`, join `\`-continued lines; test 1's argv (device `$RENDER_NODE` for `/dev/dri/<node>`) occurs in the script; `HDR_INNER` equals the script's `INNER='…'` body with the `FF=…FP=…` line normalised to `FFMPEG_DIR.ferrofin`.
  - `mediaserver-guard.test.ts`: `ok = containerSpec(D, F).body`, `E = { project:'friendflix', kind:'ferrofin', uid:1000, gid:1000, repo:'LetsManu/friendflix' }`; `assertManaged(ok, E)` passes, then `widening field <path> is refused` for each mutation (a table, each its own `it.each` row, expecting `TemplateViolation`): `HostConfig.Privileged=true`, `CapAdd=['NET_ADMIN']`, `CapDrop=[]`, `SecurityOpt=['seccomp=unconfined']`, `SecurityOpt` with an extra `apparmor=unconfined`, `NetworkMode='host'`, `NetworkMode='container:x'`, `PidMode='host'`, `IpcMode='host'`, `UsernsMode='host'`, `CgroupnsMode='host'`, `PortBindings={'8096/tcp':[{HostPort:'8096'}]}`, `PublishAllPorts=true`, top-level `ExposedPorts={'8096/tcp':{}}`, `Binds=['/:/host']`, a `bind` mount, a mount of `/var/run/docker.sock`, a volume named `other_x`, a media mount at `/data/x`, a media mount without `ReadOnly`, a base mount without `NoCopy`, `Devices` with `/dev/sda`, `Devices` permission on `/dev/dri` path changed to `/dev/dri/../sda`, a second `DeviceRequests` entry or `Count: -1`, `ReadonlyRootfs=false`, `User='0:0'`, `User='1000:0'`, `User='1001:1000'` (spec 1000), `Image` with a tag only, `Image` of another repository, `Env` with `LD_PRELOAD=x`, `Env` with `FERROFIN_DATA_DIR=/x`, a missing managed label, `friendflix.project=other`, `Sysctls`, `Dns`, `ExtraHosts`, `VolumesFrom`, `Links`, `DeviceCgroupRules`, `OomScoreAdj`, `Runtime='nvidia'`, `Entrypoint`, `Cmd`, `WorkingDir`, `Healthcheck={Test:['NONE']}`, `GroupAdd=['0']`, `Tmpfs={'/tmp':'exec'}` plus a second tmpfs `/data`.
    - `inspect: engine defaults pass, tampering is caught`: a realistic inspect object (fixture `updater/test/fixtures/mediaserver-inspect.json`, a Docker 27 inspect of the golden container with image env, `CgroupnsMode:'private'`, `IpcMode:'private'`, `ShmSize`, non-empty `MaskedPaths`/`ReadonlyPaths`, the image's `ExposedPorts`, null `PortBindings` values) passes `assertManagedInspect`; the same with `PortBindings` set, `Privileged`, `MaskedPaths: []`, an extra bind in top-level `Mounts`, or an anonymous volume at a path not in the image's `Config.Volumes` is refused.
    - `helper guard`: the helper body above passes for `verb:'browse'`; a `check base` helper with `bind:'/srv/media'` and a `gpu` helper with its two binds pass; refused: any bind for `browse`/`backup`/`restore`, a `check` bind source other than `e.bind`, `/dev/dri` or `/sys/class/drm` outside `gpu`, `data` read-write outside `restore`, `backup` read-write outside `backup`/`restore`, `NetworkMode` other than `none`, `AutoRemove=true`, an image other than `e.image`, a `Cmd` not starting with `node updater/dist/mediaHelper.js <verb>`; `seed`: the `seedSpec` body passes, a second volume, a non-`true` `Cmd` or a volume of another name is refused.
- [ ] **Step 2: Run** `cd updater && npx vitest run test/mediaserver-template.test.ts test/mediaserver-guard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `template.ts` exactly per the spec's template table and the golden; `guard.ts` as an allowlist: create-body top-level keys `Hostname User Image Env Labels StopTimeout HostConfig NetworkingConfig` (helpers also `Cmd`, `Entrypoint` for hdr), HostConfig keys `NetworkMode Mounts Tmpfs ReadonlyRootfs CapDrop SecurityOpt Devices DeviceRequests GroupAdd RestartPolicy Init PidsLimit LogConfig AutoRemove`; any other key must be unset (`null`, `false`, `''`, `0`, `[]`, `{}`). Inspect mode maps `Config`/`HostConfig`/top-level `Mounts` to the same checks, tolerates image env entries and `Entrypoint`/`Cmd` equal to the image's, and these engine defaults: `CgroupnsMode '' | 'private'`, `IpcMode '' | 'private' | 'shareable'`, `ShmSize`, `ConsoleSize`, `Runtime '' | 'runc'`; it requires non-empty `MaskedPaths` and `ReadonlyPaths`.
- [ ] **Step 4: Run** both files and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(updater): media server container template and independent guard`.

### Task 3: Updater — Engine API client, facts, pin reader, proxy and compose change

**Files:**
- Create: `updater/src/mediaserver/engine.ts`, `updater/src/mediaserver/facts.ts`, `updater/src/mediaserver/pins.ts`
- Modify: `compose.prod.yaml` (`docker-proxy` `ALLOW_LOGS: 1` + comment; `updater` volume `mediaserver-backup:/backups`; top-level volume `mediaserver-backup: { labels: { friendflix.managed: mediaserver-backup } }`), `backend/test/compose-env.test.ts`
- Test: `updater/test/mediaserver-engine.test.ts`, `updater/test/mediaserver-pins.test.ts`

**Interfaces:**
- Consumes: Task 1 `Kind`; `policy.ts` `cosignIdentity`, `pinnedRef`; `docker.ts` `Docker.verify(image)`.
- Produces (`engine.ts`):
  ```ts
  export const MIN_API = '1.45'; export const MAX_API = '1.52';
  export class EngineError extends Error { constructor(readonly status: number, readonly code: string) }
  export class Engine {
    constructor(dockerHost: string /* tcp://host:port */, fetchImpl?: typeof fetch);
    negotiate(): Promise<{ api: string | null; ok: boolean }>; // GET /version (unversioned) → ApiVersion capped at MAX_API; ok = ≥ MIN_API
    version(): Promise<{ arch: string }>; info(): Promise<{ dockerRoot: string; nvidia: boolean }>;
    inspectContainer(idOrName: string): Promise<Record<string, unknown> | null>; // 404 → null
    listContainers(labels: Record<string, string>, all?: boolean): Promise<Array<{ id: string; names: string[]; state: string; labels: Record<string, string> }>>;
    create(req: { name: string; body: Record<string, unknown> }): Promise<string>; start(id: string): Promise<void>; stop(id: string, seconds?: number): Promise<void>;
    rename(id: string, name: string): Promise<void>; remove(id: string, o?: { force?: boolean; volumes?: boolean /* ?v=1: helpers, seeds, HDR runs only */ }): Promise<void>; wait(id: string, timeoutMs: number): Promise<number>;
    logs(id: string, tail: number, streams?: 'both' | 'stdout'): Promise<string[]>; // frames decoded; consecutive frames of the same stream concatenated (Docker splits entries at 16 KiB), split on '\n' only
    logsAllowed(self: string): Promise<boolean>; // GET /containers/<self>/logs?tail=0 → 403 = false
    pull(ref: string /* repo@sha256:… */): Promise<void>; inspectImage(ref: string): Promise<{ id: string; repoDigests: string[]; labels: Record<string, string>; env: string[]; entrypoint: string[] | null; cmd: string[] | null; volumes: string[]; user: string } | null>;
    createVolume(v: { Name: string; Driver: 'local'; DriverOpts: Record<string, string>; Labels: Record<string, string> }): Promise<void>;
    inspectVolume(name: string): Promise<{ labels: Record<string, string>; options: Record<string, string> } | null>; removeVolume(name: string): Promise<void>;
    listNetworks(labels: Record<string, string>): Promise<Array<{ id: string; name: string; containers: string[] }>>; connect(network: string, container: string): Promise<void>;
  }
  ```
  Every method sends `/v<negotiated>/…` (negotiate once, cached); only constants, ids/names matching `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$` or 64-hex, and values from Task 2 builders reach a path or query. Error mapping: never put a Docker message into an error or log (status and a fixed code only).
- Produces (`facts.ts`): `readFacts(engine: Engine, self: string | undefined): Promise<EngineFacts>` with `EngineFacts = { api: string | null; logs: boolean; arch: string | null; nvidia: boolean; dockerRoot: string | null; project: string | null; mediaNetwork: string | null; egressNetwork: string | null; stackDir: string | null; selfImage: string | null; reason: null | 'engine_old' | 'no_logs' | 'no_project' | 'no_network' }` — project from the own container's `com.docker.compose.project`; networks by labels `com.docker.compose.project=<project>` + `com.docker.compose.network=media|egress`; `no_network` also when the project's `backend` or `gateway` container is not attached to the media network; `stackDir` = backend's `com.docker.compose.project.working_dir`; reason priority `engine_old` → `no_logs` → `no_project` → `no_network`. `renderGids(engine, …)` is not here (helper, Task 4).
- Produces (`pins.ts`) — **the only place that knows where pins come from**:
  ```ts
  export const PIN_LABEL = 'io.github.letsmanu.friendflix.mediaserver.pins';
  export interface Pin { kind: Kind; image: string /* repo@sha256:… */; digest: string; upstream: string | null /* jellyfin: tag; ferrofin: null until pulled */ }
  export function parsePinLabel(value: string | undefined, repo: string): { pins: Partial<Record<Kind, Pin>>; invalid: Kind[] };
  export interface PinDeps { engine: Engine; project: string; verify(imageRef: string): Promise<boolean>; repo: string }
  export type PinRead = { source: string; pins: Partial<Record<Kind, Pin>>; invalid: Kind[] } | { error: 'no_backend' | 'verify_failed' };
  export function readPins(d: PinDeps): Promise<PinRead>; // cached per backend image id (verify once per id)
  ```
  `source` = the backend container's image id; the image is cosign-verified through `verify(<Config.Image ref>)` (the existing `Docker.verify`, same identity as every FriendFlix image) before its label is read.

- [ ] **Step 1: Write the failing tests:**
  - `mediaserver-engine.test.ts` (fake `fetch` recording method, URL, body):
    - `negotiates the API version and refuses below 1.45`: `/version` answers `ApiVersion '1.47'` → later calls go to `/v1.47/…`; `'1.60'` → `/v1.52/…`; `'1.44'` → `{ ok: false }`; the `/version` call itself has no version prefix.
    - `create sends the body unchanged with the name in the query`: `create({ name:'friendflix-mediaserver', body })` → `POST /v1.47/containers/create?name=friendflix-mediaserver`, JSON body deep-equal; a 409 → `EngineError(409, 'name_taken')`.
    - `logs decodes multiplexed frames`: two frames (stdout `"a\nb"`, stderr `"c\n"`) → `['a', 'b', 'c']`; a 40-KB stdout line in three frames → one line; `streams 'stdout'` → only stdout lines (query `stdout=1&stderr=0`); `logsAllowed('abc')` true on 200, false on 403; `remove('id', { volumes: true })` → `DELETE …/containers/id?v=1`.
    - `refuses names and ids that are not plain`: `inspectContainer('../x')`, `rename('id', 'x y')` throw before any fetch.
    - `pull splits repo and digest`: `pull('docker.io/jellyfin/jellyfin@sha256:' + 'b'.repeat(64))` → `POST …/images/create?fromImage=docker.io%2Fjellyfin%2Fjellyfin&tag=sha256%3Abbb…`; an `{"error":…}` line in the stream → `EngineError(…, 'pull_failed')` without the message.
    - `facts: reasons in order` with a fake Engine: API 1.44 → `engine_old`; logs 403 → `no_logs`; no compose project label on the own container → `no_project`; no `media` network, or backend missing from it → `no_network`; all present → `reason: null` with `mediaNetwork 'friendflix_media'`, `stackDir '/srv/friendflix'`, `dockerRoot '/var/lib/docker'`.
  - `mediaserver-pins.test.ts`:
    - `parses both entries`: `'jellyfin=docker.io/jellyfin/jellyfin:10.11.3@sha256:' + 'b'.repeat(64) + ' ferrofin=ghcr.io/letsmanu/friendflix-mediaserver@sha256:' + 'a'.repeat(64)` with repo `LetsManu/friendflix` → both pins, jellyfin `upstream '10.11.3'`, `invalid []`.
    - `an invalid entry disables only its kind`: ferrofin of another owner, a tag without digest, an uppercase digest, a duplicated kind, an unknown kind → that kind in `invalid`, the other still parsed; `undefined` → `{ pins: {}, invalid: [] }`.
    - `pins are read only from a verified backend image, once per image id`: fake engine with the backend container (labels project + service `backend`), `verify` false → `{ error: 'verify_failed' }`; true → `source` = image id; a second call with the same id does not verify again; a new id verifies again.
  - `compose-env.test.ts` (extend `updater default`): `docker-proxy` block contains `ALLOW_LOGS: 1` and no `ALLOW_LOGS: 0`; every other `ALLOW_*`/section value is unchanged (compare against a literal list of the 34 current lines other than `ALLOW_LOGS`); the `updater` block mounts `mediaserver-backup:/backups` (no `:ro`) and no other service mounts it; the socket check still finds only `docker-proxy`.
- [ ] **Step 2: Run** `cd updater && npx vitest run test/mediaserver-engine.test.ts test/mediaserver-pins.test.ts` and the backend `test/compose-env.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules and the compose change; the `docker-proxy` comment says the logs endpoint is used for the media server's log and helper output and that the updater asks only for containers carrying our labels.
- [ ] **Step 4: Run** the same tests, both typechecks, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(updater): Engine API client, media facts and the pin reader; proxy allows logs`.

### Task 4: Updater — helper runner and the helper program

**Files:**
- Create: `updater/src/mediaserver/helpers.ts`, `updater/src/mediaHelper.ts` (built to `updater/dist/mediaHelper.js`)
- Test: `updater/test/mediaserver-helpers.test.ts`

**Interfaces:**
- Consumes: Task 2 `helperSpec`, `hdrSpec`, `seedSpec`, `assertHelper`; Task 3 `Engine`.
- Produces (`helpers.ts`):
  ```ts
  export function runHelper(engine: Engine, req: CreateRequest, expect: Parameters<typeof assertHelper>[1], limitMs: number): Promise<Record<string, unknown>>;
  // assertHelper → create → start → wait (limit; on timeout stop + remove, throw StepError('helper_timeout')) → logs(tail 50, 'stdout') → remove({ volumes: true }) → JSON.parse of the last non-empty stdout line (object, else StepError('helper_failed'))
  export function cleanupHelpers(engine: Engine, project: string): Promise<number>; // removes ({ force: true, volumes: true }) every container labelled friendflix.managed=helper + friendflix.project=<project>
  export function runHdr(engine: Engine, test: 1 | 2, o: Parameters<typeof hdrSpec>[1], limitMs: number): Promise<'pass' | 'fail'>; // test 1: exit 0; test 2: a stdout line starting 'RESULT qsv PASS'; removed with volumes
  ```
- Produces (`mediaHelper.ts`), verbs and their stdout JSON (one line, codes/names/numbers only):
  - `check base` (request bind at `/base`) → `{ exists: boolean, dir: boolean, listable: boolean, looksSystem: boolean }`.
  - `check folders <json rels>` (base volume at `/base`) → `{ folders: Array<{ rel, code: 'ok'|'folder_missing'|'folder_symlink'|'folder_unreadable', read: boolean, watch: boolean, maxWatches: number | null }> }` (`lstat` of every component below `/base`; read = one file read; watch = an inotify watch on one subfolder via `fs.watch`; `maxWatches` from `/proc/sys/fs/inotify/max_user_watches` when the watch fails).
  - `check data` (data volume at `/data`, ro) → `{ owner: number | null }` (uid of the newest top-level entry; null when empty).
  - `browse <rel>` → `{ entries: Array<{ name, symlink: boolean, unreadable: boolean }>, truncated: boolean }` (directories only, sorted by name, hidden skipped, ≤ 300; the helper re-checks `isRel(rel, 0, 2)` and answers `{"error":"invalid_body"}` otherwise).
  - `gpu` (`/dev/dri` and `/sys-drm` ro) → `{ nodes: Array<{ node: string /* renderD128 */, gid: number, vendor: 'intel'|'amd'|'other' }> }` (`0x8086` intel, `0x1002` amd).
  - `backup <id> <trickplay 0|1> <kind> <upstream>` / `restore <id> <kind>`: Task 8.
  Exported pure functions for tests: `checkBase(dir)`, `checkFolders(root, rels)`, `browseDir(root, rel)`, `detectGpu(devDir, drmDir)`.

- [ ] **Step 1: Write the failing tests** (`mediaserver-helpers.test.ts`; helper functions run against a temp directory, the runner against a fake Engine):
  - `browse lists directories only, flags symlinks and unreadable ones`: temp tree `Filme/`, `Serien/`, `.hidden/`, `notiz.txt`, `link -> /etc`, `zu/` (mode 000) → `browseDir(root, '')` → `[{name:'Filme'…}, {name:'link', symlink:true…}, {name:'Serien'…}, {name:'zu', unreadable:true…}]` (skip the unreadable flag when running as root); 301 directories → 300 entries, `truncated: true`.
  - `checkFolders reports each code`: `Filme` ok, `Weg` missing, `Kinder` where `Kinder` is a symlink → `folder_symlink`, `Filme/Neu` where `Filme` is a symlink → `folder_symlink`.
  - `checkBase flags a system root and a Docker root`: a temp dir with `bin etc usr` → `looksSystem: true`; with `volumes overlay2` → true; with `Filme Serien` → false; a file path → `dir: false`.
  - `detectGpu reads gid and vendor`: temp `dri/renderD128` (a regular file stands in for the node; gid read with `statSync`), `drm/renderD128/device/vendor` = `0x8086\n` → `{ node:'renderD128', gid:<file gid>, vendor:'intel' }`; `card0` ignored.
  - `runHelper creates, waits, reads the last line and always removes`: fake engine stdout lines `['noise', '{"entries":[]}']` → `{ entries: [] }`; logs requested with `'stdout'`; call order `create, start, wait, logs, remove` with `remove` getting `{ volumes: true }`; a body the guard refuses → `TemplateViolation`, no `create`; wait past the limit → `stop`, `remove`, `StepError('helper_timeout')`; logs throwing → still `remove`.
  - `cleanupHelpers removes only this project's helpers`: three containers (helper of `friendflix`, helper of `other`, the media server) → one `remove`, with `volumes: true`.
  - `runHdr reads test 2 from stdout`: test 2 stdout `['RESULT vpp FAIL x', 'RESULT qsv PASS codec_name=h264']` → `'pass'`; `['RESULT qsv FAIL no frames']` → `'fail'`; test 1 exit 1 → `'fail'`.
- [ ] **Step 2: Run** `cd updater && npx vitest run test/mediaserver-helpers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `helpers.ts` and `mediaHelper.ts` (`main(process.argv.slice(2))` only when run as the entry; exit code 0 with the JSON line, 2 with `{"error":"<code>"}` on a bad verb).
- [ ] **Step 4: Run** the file, the typecheck, `npm run build -w updater` (expect `updater/dist/mediaHelper.js`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(updater): helper containers for media checks, browsing and GPU detection`.

### Task 5: Updater — media state and the base-folder flow

**Files:**
- Create: `updater/src/mediaserver/service.ts`, `updater/src/mediaserver/logs.ts`
- Modify: `updater/src/state.ts` (`MediaState`, `sanitizeMedia`, `Job.media`, `JobState`, `JobAction`), `updater/src/job.ts` (media accessors and `startMediaJob`)
- Test: `updater/test/mediaserver-base.test.ts`, extend `updater/test/config-state.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces (`state.ts`):
  ```ts
  export interface MediaState {
    base: { path: string; volume: string; confirmedAt: string; previousVolume: string | null } | null;
    pending: { path: string; codeHash: string; expiresAt: string; failures: number } | null;
    desired: Desired | null;
    container: { id: string; kind: Kind; digest: string; upstream: string; specHash: string } | null;
    pinSource: string | null; backups: BackupMeta[]; hdr: HdrResult | null; lastError: MediaError | null; tampered: boolean;
  }
  export const DEFAULT_MEDIA: MediaState; // all null, [] and false
  // State gains `media: MediaState`; JobState gains 'succeeded_mediaserver_failed'; JobAction gains MediaJobAction;
  // Job gains `media: { step: MediaStep | null; steps: Record<MediaStep, StepState> } | null` (null for core jobs that did no media phase)
  ```
  `sanitize` re-validates `media` field by field (paths with `checkBasePath` syntax, volumes with the Task 2 name patterns, `desired` through the same checks as `parseMediaBody`'s spec, ids 64-hex, backups with `BACKUP_ID_RE`, codes in `MEDIA_ERRORS`); anything wrong falls back to the default for that field.
- Produces (`job.ts`): `Updater.mediaState(): MediaState` (clone), `Updater.updateMedia(fn: (m: MediaState) => void): void` (persists), `Updater.startMediaJob(action: MediaJobAction, run: (job: Job) => Promise<void>): StartResult` (busy check, `to` = `state.current ?? channelTag(…) ?? 'latest'`, core steps all `'skipped'`, `job.media` all `'pending'`, `rollback` `'skipped'`; same lock as every job), `Updater.finishJob(job: Job, state: JobState, error: string | null): void` (the current private `finish`, made public), `Updater.persistNow(): void`. `recover()` also marks an interrupted media job `failed`/`interrupted`.
- Produces (`logs.ts`): `redactLine(line: string): string` — strip ANSI, replace values after `api_key=`, `apikey=`, `token=`, `X-Emby-Token`, `X-MediaBrowser-Token`, `Authorization`, `Pw` and `password` (case-insensitive; `=`, `:` or `": "` separators; up to the next space, `&`, `"` or `,`) with `…`, cut at 500 characters.
- Produces (`service.ts`):
  ```ts
  export interface MediaDeps { engine: Engine; updater: Updater; facts(): Promise<EngineFacts>; helper: typeof runHelper; print(line: string): void; now(): number; repo: string }
  export class MediaService {
    constructor(d: MediaDeps);
    request(path: string): Promise<{ ok: true; expiresAt: string; warning: 'base_unreadable' | null } | { ok: false; status: 400 | 409 | 429; error: 'path_invalid' | 'path_refused' | 'base_missing' | 'rate_limited' | 'not_available' }>;
    confirm(code: string): Promise<{ result: 'ok'; path: string; kept: string[]; dropped: string[]; job: Job | null } | { result: 'wrong' | 'expired' | 'locked' | 'no_pending' } | { error: 'busy' }>;
    clear(): { ok: true } | { error: 'container_exists' | 'busy' };
    browse(rel: string): Promise<{ entries: …; truncated: boolean } | { error: 'no_base' | 'base_missing' | 'invalid_body' }>;
    gpu(): Promise<{ dri: Array<{ node: string; gid: number; vendor: 'intel' | 'amd' | 'other' }>; nvidia: boolean }>;
    logs(tail: number): Promise<{ lines: string[] } | { error: 'no_container' }>;
  }
  ```
  `confirm` with an existing container needs Task 6's apply; until then it records `kept`/`dropped` and returns `job: null` (Task 6 replaces that branch). A missing base path makes the `check base` helper's **create** fail (bind source does not exist): that `EngineError` maps to `base_missing`, like a path that is not a directory.

- [ ] **Step 1: Write the failing tests** (`mediaserver-base.test.ts`, fake engine + fake helper + captured `print` + memory store + fake clock):
  - `request issues one code, logs one line to stdout only`: `request('/srv/media')` → `{ ok: true, expiresAt: <now + 30 min>, warning: null }`; `print` called once with the exact log line; `updater.log.tail()` and the JSON of `updater.snapshot()` and `mediaState()` contain neither the display code nor its normalised form; `state.media.pending.codeHash` is 64-hex.
  - `a base that looks like a system root issues no code`: helper `check base` answers `looksSystem: true` → `{ ok:false, status:400, error:'path_refused' }`, no `print`, no pending.
  - `refusals before any helper`: `/etc` → `path_refused`, `srv/media` → `path_invalid`, both without a helper call; not a directory → `base_missing`; helper create refused because the bind source is missing → `base_missing`; `listable: false` → `ok` with `warning: 'base_unreadable'`.
  - `rate limit 3 per 10 minutes`: 4th request in 10 min → 429 `rate_limited`; after 10 min allowed.
  - `one pending request; a new one replaces it`: two requests → the first code answers `wrong`.
  - `confirm: right, wrong, expired, locked`: right (typed `k7qm 2d9x-ht4r` style, lowercase with spaces) → `result:'ok'`, `media.base` `toMatchObject({ path, volume: 'friendflix_mediaserver-base-<8hex>', previousVolume: null })` with an ISO `confirmedAt`, pending null; four wrong → `wrong`, 5th wrong → `locked` and pending cleared; after 30 min → `expired`; no request → `no_pending`.
  - `confirm while a job runs is busy and keeps the code`: a running job → `{ error: 'busy' }`, pending unchanged, failures unchanged.
  - `changing the base keeps folders that exist below the new one`: desired folders `Filme`, `Serien`; helper `check folders` on the new base answers `Filme` ok, `Serien` missing → `kept ['Filme']`, `dropped ['Serien']`, `base.previousVolume` = the old volume name.
  - `clear only without a container`: with `media.container` set → `container_exists`; without → base and pending null.
  - `logs are redacted`: engine log lines `'GET /Items?api_key=abc123 200'`, `'\x1b[32mInfo\x1b[0m X-Emby-Token: zzz'`, `'{"Pw":"hunter2-fixture"}'`, a 900-char line → `'GET /Items?api_key=… 200'`, `'Info X-Emby-Token: …'`, `'{"Pw":"…"}'`, 500 chars.
  - `config-state.test.ts`: `an old state file without media loads with the defaults`; `a tampered media section falls back field by field` (base path `/etc`, a volume `other_x`, desired uid 0, backup id `../x`, lastError `rm -rf` → each default; a valid sibling field survives).
- [ ] **Step 2: Run** `cd updater && npx vitest run test/mediaserver-base.test.ts test/config-state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the state changes, the `Updater` accessors, `logs.ts` and `service.ts` (helpers: `check base` with a `request` mount and `SYNC_HELPER_MS = 25_000`; browse and folder checks with the base volume; the base volume is created on confirm with `volumeSpec`).
- [ ] **Step 4: Run** the two files plus `test/job.test.ts test/livetv.test.ts` (nothing old breaks), the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(updater): media state and the base folder confirmed by a code from the updater log`.

### Task 6: Updater — media jobs

**Files:**
- Create: `updater/src/mediaserver/jobs.ts`
- Modify: `updater/src/mediaserver/service.ts` (confirm starts the apply job)
- Test: `updater/test/mediaserver-jobs.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5; `docker.ts` `StepError`, `Docker.verify`.
- Produces:
  ```ts
  export interface JobDeps extends MediaDeps { pins(): Promise<PinRead>; verify(ref: string): Promise<boolean>; healthTimeoutMs?: number; healthIntervalMs?: number; sleep?(ms: number): Promise<void> }
  export class MediaJobs {
    constructor(d: JobDeps);
    start(op: Extract<MediaOp, { op: 'apply' | 'finish-setup' | 'start' | 'stop' | 'restart' | 'update' | 'hdr-test' | 'remove' }>): StartResult; // Task 8 widens it with 'backup' | 'restore'
    /** check → pull → verify → snapshot → create → start → health, as a recreate when a container exists; throws StepError(code) */
    deploy(job: Job, d: DesiredSpec, o: { password?: string; reason: 'apply' | 'update' | 'recover' | 'finish' }): Promise<void>;
    snapshot(job: Job | null, tag: 'auto'): Promise<BackupMeta>; // runHelper verb 'backup' (data ro, backup rw); Task 8 adds the verb body and retention
    restoreSnapshot(id: string, kind: Kind): Promise<void>;       // runHelper verb 'restore' (data rw, backup ro)
  }
  ```
  Step results land in `job.media.steps`; the job ends `succeeded`, `failed` (nothing changed) or `rolled_back` (old container back). On success `media.container = { id, kind, digest, upstream, specHash }`, `desired = { ...spec, run }` where `run` is `true` for `apply` and the previous `desired.run` for `update`/`recover`/`finish` (Controller's call 17), `lastError = null`, the previous base volume removed. Every deploy sets `media.pinSource` to the `source` of the pins it read (Controller's call 18). `update` with `desired.run === false` does not deploy: media steps `skipped`, job `succeeded`, log `media server stopped: update skipped`. Jobs: `apply` → `mediaserver-apply` (also the `base-confirm` recreate), `finish-setup` → `-finish` (recreate from the current desired without the password; only for ferrofin), `start`/`restart` set `desired.run = true`, `stop` sets `false`, each calls the engine, `update` → `-update` (deploy with the current desired and the current pin), `hdr-test` → `-hdr-test` (two `runHdr` runs with the kind's pinned image, pulled and verified first; result in `media.hdr`), `remove` → `-remove` (stop, remove; `data` also removes the data and cache volumes; desired and container null; backup and base volumes stay). `remove` also stops and removes a labelled container of this project that fails the guard (`tampered`, removing only narrows), so *Neu anlegen* = `remove {data:false}` + `apply`. Seed containers are removed with `{ volumes: true }`.
  - **check:** `no_base`; base volume missing or helper `check base`-style failure → `base_missing`; helper `check folders` codes, nested → `folder_nested`, > 20 → `too_many_folders`, no folder → `folder_missing`; `gpu: 'dri'` with no render node → `gpu_missing`, `nvidia` without the runtime → `nvidia_missing`; facts reason → that code; a container named `<project>-mediaserver` without our labels → `name_taken`; a labelled one that fails `assertManagedInspect` → `managed_tampered`; ferrofin on `arch !== 'amd64'` → `arch_unsupported`; no pin for the kind → `image_missing` (`pin_invalid` when listed invalid); `!uidSupported` → `uid_unsupported`; existing data volume whose `check data` owner differs from `uid` → `uid_mismatch`.
  - **pull** `pull_failed`; **verify** ferrofin: `verify(pin.image)` (`verify_failed`), jellyfin: the pulled image's `repoDigests` contain the pinned digest (`verify_failed` otherwise); upstream of the new image (ferrofin label, jellyfin tag) older than `media.container.upstream` of the same kind → `downgrade_refused` (numeric compare of `v?X.Y.Z`).
  - **snapshot** only when a data volume of this kind exists and its recorded upstream differs from the new one (old container stopped first) → `snapshot_failed`.
  - **create:** render gids re-read through the helper `gpu` right before every create (GPU `dri`); base volume ensured; data/cache volumes created with `volumeSpec`, a fresh one seeded through `seedSpec` when `needsSeed` (created, never started, removed); `assertManaged`; existing container: stop, rename to `<project>-mediaserver-old`; create; egress: `connect(egressNetwork, id)` when `egress`; `create_failed`.
  - **start** `start_failed`; **health**: `healthy` within 3 min, or `running` for 60 s when the image has no healthcheck; else `unhealthy`.
  - **rollback** (any failure after the old container was stopped): stop and remove the new container; if a snapshot was taken, `restoreSnapshot` it into the data volume; rename `-old` back; start it when `desired.run` was true. Success removes `-old`.
  - A `TemplateViolation` anywhere ends the job `failed` with `template_violation` (never retried).

- [ ] **Step 1: Write the failing tests** (`mediaserver-jobs.test.ts`, fake engine that tracks containers/volumes/networks by name, fake helper answers, fake pins, instant sleep and clock):
  - `first apply creates volumes, container and egress, then is healthy`: no container; `apply` ferrofin → engine calls in order `pull`, `create(volume data)`, `create(volume cache)`, `create(container)`, `connect(egress)`, `start`; steps check…health `ok`, `snapshot` `skipped`; `media.container.upstream 'v1.5.1'`; `media.pinSource` = the fake pins' `source`; job `succeeded`; first-run password appears only in the create body's `Env`, never in `updater.log.tail()` or the state file.
  - `jellyfin seeds its fresh volumes`: one `seed` create per fresh volume with the seed labels, never started, removed with `{ volumes: true }` before the real create.
  - `recreate keeps the old container until the new one is healthy`: existing healthy container → `stop(old)`, `rename(old, '-old')`, create, start, health ok, `remove(old)`; data volume never removed.
  - `a failed start brings the old one back`: new container `start` throws → new removed, `-old` renamed back and started, job `rolled_back` / `start_failed`.
  - `snapshot before an upstream change and restored on failure`: running upstream `10.11.2`, pin `10.11.3`, new container unhealthy → a `backup` helper ran before create; a `restore` helper (data rw) ran before the old one was renamed back; job `rolled_back` / `unhealthy`.
  - `downgrade is refused before anything stops`: running `10.11.3`, pin `10.11.2` → `failed` / `downgrade_refused`, old container untouched.
  - `apply with a vanished folder fails at check and keeps the old container`: helper says `Serien` missing → `failed` / `folder_missing`, no stop, no create.
  - `codes from check`: one test per code listed under *check* above, each asserting no `pull` and no `create`.
  - `a foreign container with our name is never touched`: `<project>-mediaserver` without labels → `name_taken`, no stop/remove/rename call.
  - `template violation is final`: patch `containerSpec` output in the test via the guard's input (a test-only facts value that yields a render gid 0) → `failed` / `template_violation`, no create.
  - `start, stop, restart set desired.run`: `stop` → engine stop, `desired.run === false`; `start` → `true`.
  - `update keeps a stopped server stopped`: `desired.run:false`, a new pin → `update` job `succeeded`, no stop/create/start, `desired.run` still false; with `run:true` → recreated and `run` stays true.
  - `remove clears a tampered container`: a labelled container with `PortBindings` → `remove {data:false}` stops and removes it; data volume stays.
  - `remove keeps data unless asked`: `remove {data:false}` → container gone, data/cache/base/backup volumes stay; `{data:true}` → data and cache volumes removed, base and backup stay; desired and container null.
  - `finish-setup recreates without the password`: create body `Env` without `FERROFIN_ADMIN_PASSWORD`, spec hash differs.
  - `hdr-test records pass and fail per test`: test 1 exit 0, test 2 stdout without `RESULT qsv PASS` → `media.hdr = { kind:'ferrofin', opencl:'pass', qsv:'fail', at }`; containers run with `NetworkMode 'none'`.
  - `confirm on a new base with a container starts the recreate`: `service.confirm` → answer with `job.action === 'mediaserver-apply'`; after the job, the old base volume is removed.
  - `busy`: a second job while one runs → `{ ok:false, error:'busy' }`.
- [ ] **Step 2: Run** `cd updater && npx vitest run test/mediaserver-jobs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `jobs.ts` and the confirm branch. Job log lines are fixed: `media <step>`, `media <code>`, `media server created`, `media server restored to the previous container` (never a path, name of a folder, digest of a foreign image or server output).
- [ ] **Step 4: Run** the file plus Task 5's file, the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(updater): media server jobs with recreate and rollback`.

### Task 7: Updater — update phase, supervision, adoption, interrupted-recreate recovery

**Files:**
- Create: `updater/src/mediaserver/supervise.ts`
- Modify: `updater/src/job.ts` (`UpdaterOpts.mediaPhase`, called by `deployJob`), `updater/src/mediaserver/jobs.ts` (`phase`)
- Test: `updater/test/mediaserver-supervise.test.ts`, extend `updater/test/job.test.ts`

**Interfaces:**
- Consumes: Task 6 `MediaJobs.deploy`, Task 3 `readPins`.
- Produces: `UpdaterOpts.mediaPhase?: (job: Job) => Promise<'ok' | MediaError | null>` — in `deployJob`, once core health passed (never in a rollback job, never when the job rolls back), the phase runs **before** `finish`; `deployJob` then calls `finish(job, 'succeeded_mediaserver_failed', code)` when the phase returned a code, else `finish(job, 'succeeded', null)`. `MediaJobs.phase(job: Job): Promise<'ok' | MediaError | null>`: no desired, no container or `desired.run === false` → null (status keeps `update_pending`); read pins (the new backend); `media.pinSource = source` always; deploy (`reason: 'update'`, steps in `job.media`) when the pin digest differs from the running one **or** `MediaJobs.templateState()` (new in this task, in `jobs.ts`) is `'update_pending'` (template or render-gid change, F22), else null; failure → its code. `downgrade_refused` leaves the container and records `lastError`.
- Produces (`supervise.ts`):
  ```ts
  export class Supervisor {
    constructor(d: JobDeps & { jobs: MediaJobs; checkEveryMs?: number });
    startup(): Promise<void>; // cleanupHelpers, recoverAside, adopt
    tick(): Promise<'busy' | 'idle' | 'recover' | 'aside' | 'tampered'>; // every 60 s from server.ts, skipped while updater.busy
    templateState(): Promise<'current' | 'update_pending' | null>; // delegates to MediaJobs.templateState(): spec hash of the running container vs containerSpec(desired, current facts incl. render gids)
  }
  ```
  `tick`: (1) interrupted recreate: `-old` with our labels and no main container → rename back, start when `desired.run`, `lastError 'interrupted'`; `-old` next to a main container → remove `-old` when the main one is healthy; (2) adoption: no `media.container` but a container labelled `friendflix.managed=mediaserver` + own project that passes `assertManagedInspect` → `media.container` from inspect, `desired` rebuilt from it (kind label, mounts → folders, `User`, devices → gpu, `GroupAdd` minus render gids → mediaGid, egress from its networks, `TZ`), `base` from the base volume's `device` option; a labelled one that fails the guard → `tampered = true` (never started or adopted); (3) desired running and container **missing** → `startMediaJob('mediaserver-recover', job => deploy(job, desired, {reason:'recover'}))`; **stopped** → nothing; (4) every `checkEveryMs` (600 000): helper folder/GPU check → `lastError` `base_missing` / `folder_missing` / `gpu_missing` / `nvidia_missing` or null. It never removes a volume and never touches a container without both labels.

- [ ] **Step 1: Write the failing tests:**
  - `job.test.ts`: `the media phase runs after a healthy update and never in a rollback`: `mediaPhase` spy called once after core health; a job that rolls back → not called; a phase returning `'unhealthy'` → job state `succeeded_mediaserver_failed`, error `unhealthy`, `state.current` on the new tag.
  - `mediaserver-supervise.test.ts`:
    - `the phase moves the container to the new pin and records the source`: pin digest differs → deploy with `reason 'update'`, `pinSource` = backend image id; equal digest → no deploy, `pinSource` still recorded; equal digest but `update_pending` (render gid changed) → deploy; `desired.run:false` → no deploy.
    - `a failed phase rolls back only the media server`: deploy fails `unhealthy` → job `succeeded_mediaserver_failed`, `job.error 'unhealthy'`, old media container running.
    - `a FriendFlix rollback never moves the media server`: rollback job → `mediaPhase` not called.
    - `missing container is recreated, stopped one is left`: desired run + container missing → `mediaserver-recover` job; container `exited` → nothing; desired `run:false` + missing → nothing.
    - `missing base: no recreate loop, error reported, container untouched`: container missing, recover job fails `base_missing` → next ticks within the check interval start no new job (a failed recover waits for the next 10-min check to clear `lastError`); status `lastError 'base_missing'`; no volume removed.
    - `an -old container without a main one is renamed back and started`: after `startup()` → `rename('-old', main)`, `start`; with `desired.run:false` → renamed, not started.
    - `adoption after a lost state volume`: empty state, a guard-clean labelled container and its base volume (`options.device '/srv/media'`) → `media.container` set, `desired.kind 'jellyfin'`, folders from mounts, `base.path '/srv/media'`.
    - `a tampered container is flagged, never started`: labelled container with `PortBindings` → `tampered: true`, no `start`, no recover job (the status still shows it: Task 9).
    - `another project's or an unlabelled container is ignored`.
    - `template change is reported, never applied on its own`: running spec hash ≠ current template → `templateState() === 'update_pending'`, no job.
- [ ] **Step 2: Run** `cd updater && npx vitest run test/mediaserver-supervise.test.ts test/job.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the phase, the `deployJob` hook and `supervise.ts`.
- [ ] **Step 4: Run** the two files plus Tasks 5–6 files, the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(updater): media server follows FriendFlix updates; minimal supervision and adoption`.

### Task 8: Updater — backups, restore, encrypted download and upload

**Files:**
- Create: `updater/src/mediaserver/backup.ts`
- Modify: `updater/src/mediaHelper.ts` (verbs `backup`, `restore`), `updater/src/mediaserver/jobs.ts` (`snapshot`, jobs `backup`, `restore`), `updater/package.json` and root `package-lock.json` (`"dependencies": { "age-encryption": "0.3.1" }` — the controller installs it into the shared `node_modules` and commits both files before this task; the implementer never runs `npm install`), `updater/Dockerfile` (a prod-deps stage `npm ci --omit=dev -w updater` copied as `node_modules`; `mkdir -p /backups && chmod 0777 /backups`)
- Test: `updater/test/mediaserver-backup.test.ts`

**Interfaces:**
- Consumes: Task 4 `runHelper`, Task 6 `MediaJobs` (its `snapshot`/`restoreSnapshot` already call these verbs; this task adds the verb bodies, retention, the `backup`/`restore` jobs, and widens `MediaJobs.start`'s op union with `'backup' | 'restore'`). age-encryption works on web streams: `Readable.toWeb` / `Readable.fromWeb` around Node streams.
- Produces (helper verbs): `backup <id> <trickplay 0|1> <kind> <upstream>` → writes `/backups/<id>.tar.gz.part` (busybox `tar czf`, first entry `friendflix-backup.json` = `{"v":1,"kind","upstream","createdAt"}`, then the data volume without `BACKUP_EXCLUDE[kind].always` and, unless trickplay, `BACKUP_EXCLUDE[kind].trickplay`), `chmod 0644`, renames to `<id>.tar.gz`, prints `{size}`; `restore <id> <kind>` → empties `/data`, extracts, skips `friendflix-backup.json`, prints `{ok:true}`. `BACKUP_EXCLUDE: Record<Kind, { always: string[]; trickplay: string[] }>` starts as ferrofin `{ always: ['log', 'transcodes'], trickplay: ['data/trickplay'] }`, jellyfin `{ always: ['log', 'cache', 'transcodes'], trickplay: ['data/trickplay', 'metadata/trickplay'] }`; the builder checks the pinned images' layouts and corrects them (comment names the image version checked).
- Produces (`backup.ts`):
  ```ts
  export const BACKUP_DIR = '/backups'; export const UPLOAD_MAX = 20 * 1024 ** 3; export const PASSPHRASE_MIN = 12; export const PASSPHRASE_MAX = 1024;
  export function decodePassphrase(header: string | undefined): string | null; // base64url → UTF-8, 12–1024 code points, else null (Controller's call 2)
  export function backupId(kind: Kind, upstream: string, at: Date): string; // <kind>-<YYYYMMDD-HHMM UTC>-<upstream>
  export function prune(list: BackupMeta[]): { keep: BackupMeta[]; drop: BackupMeta[] }; // last 3 manual+upload, last 2 auto
  export function download(d: { dir: string; updater: Updater }, id: string, passphrase: string, res: ServerResponse): Promise<void>;
  export function upload(d: { dir: string; updater: Updater; now(): number }, req: IncomingMessage, passphrase: string): Promise<{ ok: true; backup: BackupMeta } | { ok: false; status: 400 | 409 | 413; error: 'backup_invalid' | 'busy' | 'too_large' | 'invalid_passphrase' }>;
  ```
  `passphrase` arguments are already decoded. `download`: refused `busy` (409) while a `mediaserver-restore` of that id runs or the file is missing (404 `not_found`); streams `createReadStream` → age `Encrypter` (`setPassphrase`) → `res` with `content-type: application/octet-stream`, `content-disposition: attachment; filename="<id>.tar.gz.age"`, no `content-length`; a client abort destroys the file stream. `upload`: streams `req` → age `Decrypter` (`addPassphrase`) → `<dir>/.upload-<random>.part`, counting encrypted bytes (over `UPLOAD_MAX` → abort, `too_large`), reading the first tar entry through `zlib.createGunzip()` to get the metadata (`kind`, `upstream`); any decrypt, gzip, metadata or stream error → the part file is removed, `backup_invalid`; success → renamed to `<id>.tar.gz`, `media.backups` gets `{ tag: 'upload' }`, `prune` applied (files of dropped entries deleted).
- Jobs: `backup {trickplay}` → `mediaserver-backup`: stop the container, helper `backup` (data volume ro, backup volume rw, 2-h limit), start it again whatever happened (when `desired.run`), record `{ tag: 'manual' }`, prune. `restore {id}` → `mediaserver-restore`: same kind or `kind_mismatch`, backup upstream newer than the running image → `downgrade_refused`; stop, helper `restore` (data rw, backup ro), start, health; failure → `restore_failed`. `snapshot` → same as backup with `tag: 'auto'` inside the deploy job.

- [ ] **Step 1: Write the failing tests** (`mediaserver-backup.test.ts`; temp dir as `BACKUP_DIR`, real `age-encryption`, a fake `ServerResponse`/`IncomingMessage` from `node:stream`):
  - `download is age with the passphrase and decrypts with age -d semantics`: a 3-MB `.tar.gz` fixture → collected output starts with `age-encryption.org/v1\n-> scrypt`; decrypting with `Decrypter.addPassphrase('korrekt pferd batterie')` gives the same bytes; the passphrase appears in no log line.
  - `an aborted download releases the backup`: destroy the response after the first chunk → read stream closed, a restore of that id can start.
  - `upload round-trip`: encrypt a fixture archive whose first entry is `friendflix-backup.json` `{v:1, kind:'jellyfin', upstream:'10.11.3', createdAt}` → `upload` → `ok`, file `jellyfin-…-10.11.3.tar.gz` present, `media.backups` has `tag 'upload'`.
  - `wrong passphrase leaves nothing`: → `backup_invalid`, the directory holds no `.part` and no new file.
  - `an upload over the limit is cut and removed`: `UPLOAD_MAX` overridden to 1 MB in the test, a 2-MB stream → `too_large`, no file.
  - `a damaged file or missing metadata is invalid`: flipped byte in the ciphertext → `backup_invalid`; a valid age file of a tar without the metadata entry → `backup_invalid`.
  - `retention keeps 3 manual and upload, 2 auto`: 5 manual, 1 upload, 3 auto → drops the 3 oldest manual/upload and the oldest auto, their files deleted.
  - `backup job stops and restarts the server`: engine `stop`, helper `backup`, `start`; helper failure → `start` still called, job `failed` / `backup_failed`.
  - `restore refuses another kind and a newer upstream`: jellyfin backup on ferrofin → `kind_mismatch`; backup `10.11.4` on running `10.11.3` → `downgrade_refused`; neither stops the container.
  - `backupId uses UTC minutes`: `backupId('ferrofin', 'v1.5.1', new Date('2026-11-17T08:05:59Z'))` → `'ferrofin-20261117-0805-v1.5.1'`.
- [ ] **Step 2: Run** `cd updater && npx vitest run test/mediaserver-backup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helper verbs, `backup.ts`, the jobs, the `snapshot` body, the Dockerfile changes.
- [ ] **Step 4: Run** the file plus Task 6's file, the typecheck, `npm run build -w updater`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(updater): media server backups, restore and age-encrypted download and upload`.

### Task 9: Updater — the `/v1/mediaserver` route, the stream routes and the `mediaserver` status

**Files:**
- Create: `updater/src/mediaserver/status.ts`
- Modify: `updater/src/server.ts` (route, per-route body limit, stream routes, wiring in `start()`), `updater/src/protocol.ts` (doc comment on the stream signature rule only)
- Test: `updater/test/mediaserver-server.test.ts`, extend `updater/test/server.test.ts`

**Interfaces:**
- Consumes: Tasks 3–8.
- Produces: `ROUTES['/v1/mediaserver'] = { method: 'POST', route: 'mediaserver' }` (seven routes); `MAX_BODY_FOR: Record<Route, number>` with 8192 for `mediaserver`, 1024 for the others; stream paths matched by `^/v1/mediaserver/backups/(<BACKUP_ID_RE body>)/download$` (GET) and `^/v1/mediaserver/backups/upload$` (POST), verified with `verify(…, { body: <x-ff-backup-passphrase header value as sent, i.e. base64url> })` before anything is read or written; `decodePassphrase(header)` null → 400 `invalid_passphrase`; the decoded passphrase goes to `download`/`upload`. `AppDeps` gains `media?: { service: MediaService; jobs: MediaJobs; status(): Promise<MediaStatusView>; download(id: string, passphrase: string, res: ServerResponse): Promise<void>; upload(req: IncomingMessage, passphrase: string): ReturnType<typeof upload> }` (Task 8's functions bound to their deps).
- Answers of `POST /v1/mediaserver` (after `jsonBody` and `parseMediaBody`; null → 400 `invalid_body`): `base-request` → 200 `{ pending: true, expiresAt, warning }` / 400·429 `{ error }`; `base-confirm` → 200 `{ result, path?, kept?, dropped?, job? }` / 409 `busy`; `base-clear` → 200 `{ ok: true }` / 409 `{ error }`; `browse` → 200 `{ entries, truncated }`; `gpu` → 200 `{ dri, nvidia }`; `logs` → 200 `{ lines }`; job ops → 202 `{ job }` / 409 `busy` / 400 `{ error }`; any op while `status().available === false` (except `logs`, `gpu`, `base-clear`, `stop`, `remove`) → 409 `{ error: <reason> }`.
- Produces (`status.ts`): `mediaStatusView(d): () => Promise<MediaStatusView>` cached 10 s, the spec's shape plus Controller's call 3:
  ```ts
  { available: boolean; reason: 'engine_old' | 'no_logs' | 'no_project' | 'no_network' | null;
    base: { set: boolean; path: string | null; pending: boolean; expiresAt: string | null };
    desired: { kind; folders: Folder[]; uid; gid; gpu; mediaGid; egress; run } | null;
    container: { state: string /* running|exited|… */; health: 'healthy' | 'unhealthy' | 'starting' | ''; kind: Kind; image: { digest: string; upstream: string }; template: 'current' | 'update_pending'; tampered: boolean; createdAt: string /* ISO */ } | null; // also for a labelled, not adopted, tampered container of this project
    pin: { image: string | null; upstream: string | null; changed: boolean } | null; pins: { ferrofin: boolean; jellyfin: boolean };
    engine: { api: string | null; logs: boolean; arch: string | null; nvidia: boolean };
    error: MediaError | null; backups: BackupMeta[]; hdr: HdrResult | null }
  ```
  `pin.changed` = `readPins().source !== media.pinSource` (false when either is unknown); the status only compares, deploys record `pinSource` (Controller's call 18). `status()` (the existing function) gains `mediaserver: await d.media?.status() ?? null`.
- `start()`: builds `Engine`, `MediaService`, `MediaJobs`, `Supervisor`, passes `mediaPhase` into `Updater`; `server.requestTimeout = 3 * 3600_000`; `readBody` gets a 10-s deadline (→ 408 `timeout`); `supervisor.startup()` once, then `setInterval(() => { if (!updater.busy) void supervisor.tick().catch(() => undefined) }, 60_000)`; the base-code line goes through `console.log` only.

- [ ] **Step 1: Write the failing tests:**
  - `server.test.ts`: update `unknown paths and wrong methods; no other action exists` to the seven routes; `a body over 1 KB is refused before the signature check` still holds for `/v1/livetv`; `the media route takes up to 8 KB` (8192 bytes signed → handled, 8193 → 413).
  - `mediaserver-server.test.ts` (fake service/jobs/status, real verifier):
    - `unsigned or replayed media requests are refused` (401, no service call).
    - `strict bodies`: `{op:'start', image:'x'}` → 400 `invalid_body`, no call; `text/plain` → 415.
    - `job ops answer 202 with the job, 409 while busy`.
    - `not available: only safe ops pass`: status `available:false, reason:'no_logs'` → `apply` 409 `{error:'no_logs'}`, `stop` 202.
    - `status carries mediaserver and never a code or password`: after a `base-request` and an `apply` with `firstRun`, the `/v1/status` JSON contains `mediaserver.base.pending === true` and does not contain the display code, its normalised form, the password, or `codeHash`.
    - `stream routes: signed over the passphrase header`: header = base64url of `'zażółć gęślą jaźń'`; a download signed over a different header value → 401; correct → 200 `application/octet-stream` with `content-disposition` `<id>.tar.gz.age`, and the fake `download` got the decoded UTF-8 passphrase; an id `../x` → 404 before verification; 11 code points → 400 `invalid_passphrase`; upload over the fake `upload` → 200 `{ backup }`.
    - `a tampered, unadopted container shows in the status`: `media.container` null, a labelled container failing the guard → `mediaserver.container.tampered === true`.
    - `status view is cached for 10 s`.
- [ ] **Step 2: Run** `cd updater && npx vitest run test/mediaserver-server.test.ts test/server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `status.ts`, the routes and the wiring.
- [ ] **Step 4: Run** the whole updater suite once (`cd updater && npx vitest run`), the typecheck, the build, eslint on touched files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(updater): POST /v1/mediaserver, encrypted backup streams and the media status`.

### Task 10: CI — the pin label on the backend image, the Jellyfin pin file, Dependabot

**Files:**
- Create: `mediaserver/pins/jellyfin/Dockerfile` (SPDX comment lines, then exactly one line `FROM docker.io/jellyfin/jellyfin:X.Y.Z@sha256:<64 hex>`, the current Jellyfin release when the PR lands), `scripts/mediaserver-pins.sh`
- Modify: `.github/workflows/ci.yml` (`mediaserver-image` `outputs.digest`; `docker` `needs: mediaserver-image`, `if: ${{ !cancelled() }}`; backend leg labels; a `compose`-job step running the test script), `.github/dependabot.yml` (`/mediaserver/pins/jellyfin` in the docker ecosystem as its own entry, `open-pull-requests-limit: 1`, comment)
- Test: `scripts/mediaserver-pins.test.sh` run by a new step in the `compose` job

**Interfaces:**
- Produces (`scripts/mediaserver-pins.sh <repository> [<ferrofin digest>]`): prints the label value; exits 1 with `::error file=mediaserver/pins/jellyfin/Dockerfile::…` unless its non-empty, non-`#` lines are exactly one, matching `^FROM docker\.io/jellyfin/jellyfin:([0-9]+\.[0-9]+\.[0-9]+)@(sha256:[0-9a-f]{64})$`. Output `jellyfin=docker.io/jellyfin/jellyfin:<v>@<d>` and, when a digest matching `^sha256:[0-9a-f]{64}$` is given, ` ferrofin=ghcr.io/<owner lc>/<repo lc>-mediaserver@<digest>` (one space). The parse rule matches Task 3 `parsePinLabel` exactly.
- CI: the backend leg's *OCI labels* step (publishable runs) adds `io.github.letsmanu.friendflix.mediaserver.pins=<script output>`, with `needs.mediaserver-image.outputs.digest` (empty when that job failed or was skipped); other legs unchanged; the job comment explains the wait and that the ci-changed-only project removes it.

- [ ] **Step 1: Write the failing test** `scripts/mediaserver-pins.test.sh`: runs the script against temp copies of the pin file: the real file → exit 0 and output starting `jellyfin=docker.io/jellyfin/jellyfin:`; with `LetsManu/friendflix` and `sha256:` + 64×`a` → ends with ` ferrofin=ghcr.io/letsmanu/friendflix-mediaserver@sha256:aaa…`; an invalid digest argument → no ferrofin entry; comment lines are ignored; a second instruction, a tag without digest, `jellyfin/jellyfin:latest` → exit 1.
- [ ] **Step 2: Run** `bash scripts/mediaserver-pins.test.sh`. Expected: FAIL (script missing).
- [ ] **Step 3: Implement** the script, the pin file (look up the current Jellyfin release tag and its multi-arch index digest with `docker buildx imagetools inspect docker.io/jellyfin/jellyfin:<tag>` or the registry API), the CI and Dependabot changes.
- [ ] **Step 4: Run** the test script; `actionlint .github/workflows/ci.yml` if available, else `python3 -c 'import yaml,sys; yaml.safe_load(open(".github/workflows/ci.yml"))'`. Expected: PASS.
- [ ] **Step 5: Commit** `ci: pin the media server images on the backend image label`.

### Task 11: Image — change 0003 HEALTHCHECK, change 0004 no web client, smoke test, README

**Files:**
- Create: `mediaserver/patches/0003-healthcheck.md`, `mediaserver/patches/0004-no-web-client.md`
- Modify: `mediaserver/Dockerfile`, `mediaserver/README.md` (changes table rows 0003, 0004; *Files*; the trial sentence "The FriendFlix updater never pulls or recreates it" → "The FriendFlix updater pulls and recreates it only as the managed media server, from its pin."), `.github/workflows/ci.yml` (`mediaserver-image`: smoke step), `updater/src/mediaserver/template.ts` + `guard.ts` + the goldens **only if** the read-only smoke run shows a write path outside `/data`, `/cache`, `/tmp` (then as a `Tmpfs` entry or an env var into `/cache`, in both template and guard)
- Test: the CI smoke step (run locally when Docker is available: `docker buildx build --platform linux/amd64 -f mediaserver/Dockerfile -t friendflix-mediaserver:dev .` then the step's script)

**Interfaces:**
- Produces (`Dockerfile`): `HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["curl","-fsS","-o","/dev/null","http://127.0.0.1:8096/health"]` (when the pinned base has no `curl`, the same check through `bash -c` with `/dev/tcp`; the patch file says which); 0004 removes the bundled web client directory and points Ferrofin's web directory setting at nothing (the builder finds both in Ferrofin v1.5.1 and names them in `0004-no-web-client.md`); `io.github.letsmanu.friendflix.mediaserver.changes="0001,0003,0004"`; description label lists the changes.
- Smoke step (`scripts/mediaserver-smoke.sh <image>`, called from both the PR and the push branch of `mediaserver-image`): runs the image exactly as the template does (`--read-only --tmpfs /tmp:size=512m,mode=1777 --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 4096 -v ms-data:/data -v ms-cache:/cache -p 127.0.0.1:18096:8096`), then within 180 s: `GET /System/Info/Public` 200, `GET /web/` 404, `docker inspect -f '{{.State.Health.Status}}'` is `healthy`; prints the container log tail and fails otherwise; removes container and volumes.

- [ ] **Step 1: Write the failing check**: the smoke script against the current image fails on `/web/` (200) and on the missing health status.
- [ ] **Step 2: Run** it locally if Docker is available (else rely on CI and say so in the report). Expected: FAIL.
- [ ] **Step 3: Implement** the Dockerfile changes, the two patch notes (what, why, upstream offer as an optional "API only" setting, how it is checked), the README rows and sentence, the CI step.
- [ ] **Step 4: Run** the smoke script (or `bash -n scripts/mediaserver-smoke.sh` + `hadolint mediaserver/Dockerfile` when Docker is not available). Expected: PASS.
- [ ] **Step 5: Commit** `feat(mediaserver): healthcheck and API-only image (changes 0003, 0004)`.

### Task 12: Backend — migration 60, the `media_managed` store, the updater client for media

**Files:**
- Create: `backend/src/mediaserver/store.ts`, `backend/src/mediaserver/client.ts`
- Modify: `backend/src/db.ts` (migration 60), `backend/src/updater.ts` (job actions and states, `UpdaterJob.media`, `UpdaterStatus.mediaserver`, exported `updaterCall` with a timeout parameter, `reconcileAudit` for media jobs), `backend/test/updater-livetv.test.ts` (lines ~101–103 pin the job shape with `toEqual`: add `media: null`)
- Test: `backend/test/mediaserver-store.test.ts`, `backend/test/mediaserver-client.test.ts`

**Interfaces:**
- Produces (migration 60, comment `// 60: managed media server stage 1 (…spec…): the backend's half of managed mode. Rerunnable.`): exactly the spec's `create table if not exists media_managed (…)`.
- Produces (`store.ts`):
  ```ts
  export type Kind = 'ferrofin' | 'jellyfin'; export type LibraryType = 'movies' | 'tvshows' | 'music' | 'mixed';
  export type SetupStep = 'none' | 'applying' | 'first_run' | 'api_key' | 'libraries' | 'hwaccel' | 'finishing' | 'done' | 'failed';
  export interface LibraryEntry { slug: string; name: string; type: LibraryType; rel: string; created: boolean }
  export interface MediaManaged { kind: Kind | null; setup: SetupStep; setupError: string | null; adminUser: string | null; hasPassword: boolean; libraries: LibraryEntry[]; externalUrl: string | null; hasExternalKey: boolean; updatedAt: string | null }
  export function readManaged(db: Db): Promise<MediaManaged>; // no row → defaults (setup 'none')
  export function writeManaged(ctx: Pick<Ctx, 'db' | 'encKey'>, patch: Partial<Omit<MediaManaged, 'hasPassword' | 'hasExternalKey' | 'updatedAt'>> & { adminPassword?: string | null; externalKey?: string | null }): Promise<void>; // upsert id 1
  export function adminPassword(ctx: Pick<Ctx, 'db' | 'encKey'>): Promise<string | null>; export function externalKey(ctx: Pick<Ctx, 'db' | 'encKey'>): Promise<string | null>;
  export function slugFor(name: string, taken: ReadonlySet<string>): string; // lower case, umlauts ä→ae ö→oe ü→ue ß→ss, other non [a-z0-9] → '-', trimmed, ≤ 40, empty → 'bibliothek', clash → '-2', '-3' …
  export function idsInUse(db: Db): Promise<boolean>; // Controller's call 10
  ```
- Produces (`client.ts`): `MediaStatus` (Task 9's view type, all fields incl. `container.createdAt` and `container.tampered`), `parseMediaStatus(raw: unknown): MediaStatus | null` (field by field, like `parseStatus`: enums — the error enum is the updater's `MEDIA_ERRORS` incl. `helper_timeout`, `helper_failed` — regexes for paths/ids/digests/ISO, arrays capped: folders 20, backups 10), `mediaOp(ctx: Ctx, body: Record<string, unknown>): Promise<{ status: number; json: unknown } | null>` (signed `POST /v1/mediaserver`, 30 s, `JSON.stringify` of a body the caller built from fixed keys), `startMediaJob(ctx: Ctx, body: Record<string, unknown>, actor: string | null, auditMeta: Record<string, unknown>): Promise<StartResult>` (records `updater:pending:<id>` with `{actor, action: 'mediaserver', op}` and audits `mediaserver.action` {op} — `apply` audits `mediaserver.apply` instead), `mediaDownload(ctx: Ctx, id: string, passphraseHeader: string, signal: AbortSignal): Promise<Response | null>`, `mediaUpload(ctx: Ctx, body: ReadableStream | NodeJS.ReadableStream, length: number, passphraseHeader: string, signal: AbortSignal): Promise<{ status: number; json: unknown } | null>` (`passphraseHeader` = base64url(UTF-8 passphrase), sent as `x-ff-backup-passphrase` and signed as the body string, Controller's call 2; no timeout but the signal), `encodePassphrase(p: string): string` and `decodePassphrase(h: string | undefined): string | null` (12–1024 code points).
- Produces (`updater.ts`): `UpdaterJobAction` gains the 11 media actions; job state `succeeded_mediaserver_failed`; `UpdaterJob.media: { step: string | null; steps: Record<MediaStep, StepState> } | null`; `UpdaterStatus.mediaserver: MediaStatus | null`; `updaterCall(ctx, method, path, body?, timeoutMs = 5_000)` exported (the existing `call`); `TickLog` exported; `reconcileAudit` writes `mediaserver.result` {action, result, error} instead of `system.updater_result` for a pending entry with `action: 'mediaserver'`.

- [ ] **Step 1: Write the failing tests:**
  - `mediaserver-store.test.ts`: `the migration creates the one-row table` (insert `id = 2` fails the check; `setup 'x'` fails; `setup_error 'Bad Code'` fails); `defaults without a row`; `round-trip with encrypted secrets` (`adminPassword: 'A'.repeat(43)` → column value ≠ plain, `adminPassword(ctx)` returns it, `readManaged` shows only `hasPassword: true`); `slugFor('Filme & Serien', ∅)` → `'filme-serien'`, `'Kinderfilme'` with `kinderfilme` taken → `'kinderfilme-2'`, `'Über uns'` → `'ueber-uns'`, `'!!!'` → `'bibliothek'`, 70 chars → 40; `ids in use`: empty tables → false, one user → true, only a profile with `jellyfin_user_id` → true.
  - `mediaserver-client.test.ts` (fake `fetchImpl`): `parses a full media status` (fixture from Task 9's shape) and `drops what does not fit` (a path with `\n`, an unknown kind, a 65-char digest, 30 backups → 10); `old updater without mediaserver → null`; `media jobs parse with their steps`; `signs media ops and stream calls` (signature verifies with `updater/src/protocol.ts` `verify` semantics re-implemented as in `test-vectors/updater-hmac.json`; the stream call's signed body is the base64url header value, and `decodePassphrase(encodePassphrase('zażółć gęślą jaźń'))` round-trips); `the result of a media job is audited as mediaserver.result once`; `helper_failed` survives parsing as `error`.
- [ ] **Step 2: Run** `cd backend && TEST_DATABASE_URL=… npx vitest run test/mediaserver-store.test.ts test/mediaserver-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration, `store.ts`, `client.ts` and the `updater.ts` changes.
- [ ] **Step 4: Run** the two files plus `test/updater*.test.ts`, the backend typecheck, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): media_managed table and the updater client for the managed media server`.

### Task 13: Backend — admin and setup routes, id rule, switching, audit

**Files:**
- Create: `backend/src/routes/adminMediaserver.ts`
- Modify: `backend/src/app.ts` (register both route sets; `SENSITIVE_BODY` gains `admin\/mediaserver`)
- Test: `backend/test/mediaserver-routes.test.ts`

**Interfaces:**
- Consumes: Task 12.
- Produces: `adminMediaserverRoutes(app, ctx)` and `setupMediaserverRoutes(app, ctx)`; shared view builder `mediaView(ctx): Promise<MediaView>`:
  ```ts
  export interface MediaView {
    mode: 'managed' | 'external'; // managed = media_managed.kind not null
    offer: { managed: boolean; reason: null | 'no_updater' | 'plex' | 'url_pinned' | 'ids_in_use' | 'engine_old' | 'proxy_outdated' | 'no_project' | 'no_network' | 'updater_outdated' };
    kinds: { ferrofin: boolean; jellyfin: boolean }; // pins present
    status: MediaStatus | null; managed: MediaManaged; external: { url: string | null; hasKey: boolean };
    livetvLibraryPath: string | null; // LIVETV_RECORD_LIBRARY_JF_PATH (spec *Subfolders*, last point)
  }
  ```
  `offer.reason` priority: `plex` (`MEDIA_SERVER=plex`) → `url_pinned` (`JELLYFIN_URL` or `JELLYFIN_ADMIN_API_KEY` source `env`) → `no_updater` (not present) → `updater_outdated` (status without `mediaserver`) → `engine_old` / `proxy_outdated` (`no_logs`) / `no_project` / `no_network` → `ids_in_use` (only when `mode === 'external'` or the requested kind differs from `managed.kind`).
- Admin routes (`requireAdmin`; `R` = `requireRecentAuth`-style 401 `reauth_required` check):

  | Route | Body (zod, strict) | Limit | Re-auth | Updater op / effect | Audit |
  |---|---|---|---|---|---|
  | `GET /api/admin/mediaserver` | – | – | – | `MediaView` | – |
  | `POST …/base` | `{path: string ≤ 200}` | 3/10 min | R | `base-request` | `base_request` {path} |
  | `POST …/base/confirm` | `{code: string ≤ 20}` | 10/10 min | – | `base-confirm`; when the answer carries a `job` (recreate on a new base) record `updater:pending:<id>` `{actor, action:'mediaserver', op:'apply'}` | `base_confirm` {result, path on ok} |
  | `DELETE …/base` | – | 3/2 min | – | `base-clear` | `base_clear` |
  | `POST …/browse` | `{rel: string ≤ 200}` | 30/min | – | `browse` | – |
  | `POST …/gpu` | – | 30/min | – | `gpu` | – |
  | `POST …/apply` | `{kind, folders: [{rel, name 1–60, type}] ≤ 20, uid, gid, gpu, mediaGid: int\|null, egress: boolean}` | 3/2 min | R | `apply` (backend adds `target` from `slugFor`, `tz` = `process.env.TZ` matching the tz rule else `'Etc/UTC'`, `firstRun` for ferrofin when `setup` is `none`/`failed` or the kind changes) | `apply` {kind, folders: n, gpu, egress} |
  | `POST …/action` | `{op: 'start'\|'stop'\|'restart'\|'update'\|'backup'\|'restore'\|'remove'\|'hdr-test'\|'retry', trickplay?, id?, data?, kind?}` (per-op keys only) | 3/2 min | R for `restore` and `remove` with `data: true` | the job op; `retry` clears `setup_error` (no updater call); an accepted `remove` also switches to external like `mode`; `start`/`restart` are the only ops that make a stopped server run again | `action` {op} |
  | `POST …/logs` | `{tail: 50–500}` | 20/min | – | `logs` → `{lines}` (each ≤ 500 chars) | – |
  | `GET …/backups` | – | – | – | `status.backups` | – |
  | `GET …/libraries` | – | 20/min | – | `libraries` with `references` (Task 14) | – |
  | `DELETE …/libraries/:slug` | – | 3/2 min | R | Task 14 | `action` {op: 'library_delete'} |
  | `POST …/mode` | `{mode: 'external', restore: boolean}` | 3/2 min | R | stop the container (job `stop`); `restore` → save `external_url`/key back to `JELLYFIN_URL`/`JELLYFIN_ADMIN_API_KEY`, else save both empty; `kind` → null | `mode` {from, to} |

  The apply route on a new managed setup (mode external): saves the current `JELLYFIN_URL` (`addressOnly`) and key into `external_url`/`external_key_enc` first; writes `kind`, `libraries` (from the folders, `created: false`), `setup: 'applying'`, a fresh `admin_user` (`'friendflix-admin'`; for Ferrofin its default name when its first-run variables take no name — Task 2's `FERROFIN_ADMIN_NAME` note) and password (`randomBytes(32).toString('base64url')`) when first-run; refuses `ids_in_use` (409) per the id rule; rename or type change of a library whose `created` is true and has references → 409 `library_referenced` (Task 14's counter; until Task 14 a stub returning zero).
- Setup routes (`requireSetupSession`, CSRF header): `GET /api/setup/mediaserver`, `POST /api/setup/mediaserver/base`, `/base/confirm`, `/browse`, `/gpu`, `/apply`, `/action` with `op: 'retry' | 'hdr-test'` only — same handlers, no re-auth, actor null, same limits. No setup route for base-clear, logs, backups, libraries or mode.
- Every answer carries codes (`{ error }`), never updater or Docker text; updater 409/400 codes are passed through only when they match `^[a-z_]{1,40}$`.

- [ ] **Step 1: Write the failing tests** (`mediaserver-routes.test.ts`, `makeEnv`, a fake updater on `ctx.fetchImpl` answering `/v1/status` and recording `/v1/mediaserver` bodies):
  - `admin only`: a friend → 403 on every route; signed-out → 401.
  - `re-auth where the spec asks`: an admin session older than 10 min → 401 `reauth_required` on `base`, `apply`, `action restore`, `action remove {data:true}`, `mode`, `libraries DELETE`; 202/200 on `action stop`, `base/confirm`, `browse`; with a fresh stamp → pass.
  - `strict bodies`: `apply` with an extra key or `image` → 400, no updater call; `action {op:'start', id:'x'}` → 400.
  - `limits`: the 4th `base` in 10 min → 429; the 31st `browse` in a minute → 429.
  - `the backend adds target and tz, never more`: apply `{folders:[{rel:'Filme', name:'Filme', type:'movies'}, {rel:'Serien/Neu', name:'Serien', type:'tvshows'}]}` → updater body `spec.folders` `[{rel:'Filme', target:'/media/filme'}, {rel:'Serien/Neu', target:'/media/serien'}]`, `spec` keys exactly `kind folders uid gid gpu mediaGid egress tz`, `firstRun.password` 43 chars for ferrofin, absent for jellyfin.
  - `id rule`: a users row exists → `GET` `offer.reason 'ids_in_use'`, `apply` 409 `ids_in_use`, nothing sent; without users → allowed.
  - `offer reasons`: `MEDIA_SERVER=plex` → `plex`; `JELLYFIN_URL` from env → `url_pinned`; no `UPDATER_URL` → `no_updater`; status `reason:'no_logs'` → `proxy_outdated`; `engine_old` → `engine_old`.
  - `switching saves the external server and brings it back`: settings `JELLYFIN_URL=http://192.0.2.10:8096` + key → apply → `external_url 'http://192.0.2.10:8096'`, key encrypted; `mode {restore:true}` → settings back to both values, `kind` null, a `stop` job sent; audit `mediaserver.mode` {from:'managed', to:'external'}.
  - `a base change with a container records its job`: confirm answer with `job` → kv `updater:pending:<job id>` holds `{action:'mediaserver', op:'apply'}`.
  - `audit rows carry no code or password`: after `base`, `base/confirm` (wrong and ok), `apply` → rows `mediaserver.base_request` {path:'/srv/media'}, `mediaserver.base_confirm` {result:'wrong'} and {result:'ok', path}, `mediaserver.apply` {kind:'ferrofin', folders:2, gpu:'dri', egress:true}; no row contains the typed code or the password.
  - `setup routes need the setup session and its CSRF`: without → 401/403; with → same behaviour, audit actor null.
- [ ] **Step 2: Run** `cd backend && TEST_DATABASE_URL=… npx vitest run test/mediaserver-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes and registration.
- [ ] **Step 4: Run** the file plus `test/setup*.test.ts`, the typecheck, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): admin and setup routes for the managed media server`.

### Task 14: Backend — first run and folder/library changes

**Files:**
- Create: `backend/src/mediaserver/serverApi.ts`, `backend/src/mediaserver/firstRun.ts`, `backend/src/mediaserver/references.ts`
- Modify: `backend/src/server.ts` (timer), `backend/src/routes/adminMediaserver.ts` (libraries routes, `library_referenced`), `backend/src/media/types.ts` (the closed `MediaSetupCode` union gains `wizard_taken`)
- Test: `backend/test/mediaserver-firstrun.test.ts`

**Interfaces:**
- Consumes: Tasks 12–13; `jellyfin/setup.ts` `jellyfinSetup.auto.run` (unchanged); `routes/adminSettings.ts` `saveWithProbes`; `i18n.ts` `instanceLanguage`.
- Produces (`serverApi.ts`, all requests 5-s deadline, `redirect: 'manual'`, `mediaBrowserHeader`, base `http://mediaserver:8096`):
  ```ts
  export function publicInfo(f: typeof fetch, base: string): Promise<{ wizardDone: boolean } | null>;
  export function startupWizard(f: typeof fetch, base: string, o: { name: string; password: string; culture: string; language: string; country: string }): Promise<void>; // throws MediaSetupError('wizard_taken') when StartupWizardCompleted is already true
  export function ensureLibrary(f: typeof fetch, base: string, key: string, lib: LibraryEntry, o: { language: string; country: string }): Promise<void>; // no-op when a library of that name exists
  export function deleteLibrary(f: typeof fetch, base: string, key: string, name: string): Promise<void>;
  export function libraryItemIds(f: typeof fetch, base: string, key: string, name: string): Promise<string[]>;
  export function setEncoding(f: typeof fetch, base: string, key: string, hw: { gpu: 'off' | 'dri' | 'nvidia'; vendor: 'intel' | 'amd' | 'other' | null; node: string | null }): Promise<void>;
  export function refreshLibraries(f: typeof fetch, base: string, key: string): Promise<void>;
  ```
  Startup wizard: `POST /Startup/Configuration {UICulture, MetadataCountryCode, PreferredMetadataLanguage}`, `GET /Startup/User`, `POST /Startup/User {Name, Password}`, `POST /Startup/RemoteAccess {EnableRemoteAccess: false, EnableAutomaticPortMapping: false}`, `POST /Startup/Complete` (the builder confirms the field names on the pinned Jellyfin and whether the gateway counts as local; spec *First run* 3). Library: `POST /Library/VirtualFolders?name=<n>&collectionType=<t>&paths=/media/<slug>&refreshLibrary=false` with `{ LibraryOptions: { EnableRealtimeMonitor: true, SaveLocalMetadata: false, MetadataSavers: [], PreferredMetadataLanguage, MetadataCountryCode } }`. Encoding (`GET` then `POST /System/Configuration/encoding`, other fields kept): intel → `HardwareAccelerationType 'qsv'`, amd → `'vaapi'`, nvidia → `'nvenc'`, off → `'none'`; `VaapiDevice '/dev/dri/<node>'` (default `renderD128`); `EnableTonemapping true`, `TonemappingAlgorithm 'bt2390'`; `HardwareDecodingCodecs` intel `['h264','hevc','mpeg2video','vc1','vp8','vp9','av1']`, amd `['h264','hevc','mpeg2video','vc1','vp9','av1']`, nvidia `['h264','hevc','mpeg2video','mpeg4','vc1','vp8','vp9','av1']`, off `[]`.
- Produces (`firstRun.ts`): `mediaManagedTick(ctx: Ctx, log?: TickLog): Promise<SetupStep | 'idle' | 'locked' | 'waiting'>` — runs where `BACKGROUND_JOBS=true`, every 10 s, **not** gated by `op()` (the wizard runs before the portal is operational); returns `idle` unless `setup` ∈ `applying … finishing` and `setup_error` is null; kv lock `media:managed:tick` (`setnx`, 60 s, released with `delIfEquals`). Steps (each idempotent, the step advances only after its work is confirmed):
  1. `applying`: the apply job (status `job.action === 'mediaserver-apply'`) `running` → `waiting`; `succeeded` → `first_run`; failed → `setup_error = job.error`.
  2. `first_run`: `publicInfo` null → `waiting` (until 3 min after the step started, then `setup_error 'unhealthy'`); Ferrofin → `api_key`; Jellyfin: `wizardDone` already true → `setup = 'failed'`, `setup_error 'wizard_taken'`; else `startupWizard` (culture from `instanceLanguage` → `de-DE`…`pl-PL`, country `TZ_COUNTRY[tz] ?? LANG_COUNTRY[lang]` with `TZ_COUNTRY = {'Europe/Berlin':'DE','Europe/Vienna':'AT','Europe/Zurich':'CH','Europe/Paris':'FR','Europe/Madrid':'ES','Europe/Rome':'IT','Europe/Warsaw':'PL','Europe/Istanbul':'TR','Europe/London':'GB','America/New_York':'US'}`, `LANG_COUNTRY = {de:'DE',en:'GB',fr:'FR',es:'ES',it:'IT',pl:'PL',tr:'TR'}`) → `api_key`.
  3. `api_key`: settings already `JELLYFIN_URL=http://mediaserver:8096` with a working key (probe) → `libraries`; else `jellyfinSetup.auto.run({url, username: admin_user, password})` then `saveWithProbes(ctx, values, { force: false, actor: null, allowedKeys: ['JELLYFIN_URL','JELLYFIN_ADMIN_API_KEY'] })` (source `db`, audited as a settings change) → `libraries`.
  4. `libraries`: `ensureLibrary` for each `created: false` entry, marking it `created` after each; then `refreshLibraries` → `hwaccel`.
  5. `hwaccel`: `mediaOp({op:'gpu'})` for vendor/node when `gpu === 'dri'` → `setEncoding` → `finishing`.
  6. `finishing`: Ferrofin → start `finish-setup` once (kv `media:managed:finish:<apply job id>`), wait for it → `done`; Jellyfin → `done`.
  Errors become `setup_error` codes (`MediaSetupError.code`, `unreachable`, `unhealthy`, job error codes); never a message.
- Produces (`references.ts`): `libraryReferences(ctx: Ctx, slug: string): Promise<{ lists: number; resume: number; recordings: number }>` — item ids from `libraryItemIds`; `lists` = rows in `list_items.item_id` + `watchlist.item_id`, `resume` = `resume_hidden.item_id`, `recordings` = `livetv_recordings.jellyfin_item_id` (each `= any($1)`).
- Folder and GPU changes in the apply route (Task 13): a changed `gpu` after `done` → `setup` back to `hwaccel`; a new folder → library entry `created: false` and `setup` back to `libraries` when it was `done` (the tick creates it); a removed folder → unmounted, entry kept (`created` stays, the library stays in the server); rename/type change of a created library with references → 409 `library_referenced`, unreferenced → `PATCH`-style update through `ensureLibrary` rename (`POST /Library/VirtualFolders/Name?name=…&newName=…`) and type change by delete + create. `DELETE /api/admin/mediaserver/libraries/:slug` → `deleteLibrary` and the entry removed; `GET …/libraries` → entries with `references`.

- [ ] **Step 1: Write the failing tests** (`mediaserver-firstrun.test.ts`, fake updater + a fake Jellyfin API on `ctx.fetchImpl` keyed by path, recording calls):
  - `jellyfin: from applying to done`: ticks drive `applying → first_run → api_key → libraries → hwaccel → finishing → done` (`finishing → done` may happen in the same tick for Jellyfin; assert the steps seen, in order); the fake server saw the startup calls in order with `Name 'friendflix-admin'` and the generated password, `EnableRemoteAccess:false`; two `VirtualFolders` posts with `paths=/media/filme` / `/media/serien`, options `SaveLocalMetadata:false`, `MetadataSavers:[]`, `EnableRealtimeMonitor:true`; encoding posted with `qsv`, `bt2390`, the intel codec list; settings `JELLYFIN_URL 'http://mediaserver:8096'` and the key saved with source `db`.
  - `ferrofin: no wizard, finish-setup once`: no `/Startup/*` call; one `finish-setup` op sent even after two extra ticks.
  - `wizard_taken`: `StartupWizardCompleted: true` at `first_run` → `setup 'failed'`, `setup_error 'wizard_taken'`, no `/Startup/User` call.
  - `a failure keeps its step and Nochmal resumes there`: libraries post 500 → `setup 'libraries'`, `setup_error 'unexpected'`; next tick does nothing; `action retry` clears the error; next tick creates only the missing library.
  - `two ticks at once run one step`: two concurrent `mediaManagedTick` → one does the step, the other `locked`; one admin user created.
  - `a restart after the libraries step creates no second library`: entries already `created: true` → no `VirtualFolders` post.
  - `the password never leaves`: `log.warn` spy and audit rows contain no admin password and no API key.
  - `references count lists, resume points and recordings`: item ids `i1 i2 i3 i4` in the library; one `list_items` row with `i1`, one `watchlist` row with `i4`, two `resume_hidden` rows with `i2`, one recording with `i3` → `{ lists:2, resume:2, recordings:1 }`; renaming that library → 409 `library_referenced`; deleting it → the server's delete called, entry gone.
  - `adding a folder after done creates its library`: apply with a third folder → `setup 'libraries'` → one new post, back to `done`.
- [ ] **Step 2: Run** `cd backend && TEST_DATABASE_URL=… npx vitest run test/mediaserver-firstrun.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `serverApi.ts`, `firstRun.ts`, `references.ts`, the route additions, and the 10-s timer in `server.ts` inside the `BACKGROUND_JOBS === 'true'` block, without `op()`, with `jobFailed(ctx, app.log, 'media-managed', …)`.
- [ ] **Step 4: Run** the file plus Task 13's, the typecheck, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): first run of the managed media server without a person`.

### Task 15: Backend + web — update trigger, recover audit, Systemcheck `media.managed`, update page state

**Files:**
- Create: `backend/src/mediaserver/pinTick.ts`
- Modify: `backend/src/server.ts` (timer), `backend/src/syscheck/types.ts` (`CHECK_IDS` gains `'media.managed'` after `'media.server'`), `backend/src/syscheck/checks/media.ts` (`managedLine`; `mediaCheck.ids` gains the id), `backend/test/syscheck-core-media.test.ts` (lines ~72–79 pin the media ids and "every media line ok": add `media.managed`, expected `not_set_up` / `managed_off` there), `web/src/lib/admin/syscheck.ts` (mirror), `web/src/lib/admin/updater.ts` (job state and media actions), `web/src/lib/admin/steps.ts` (used by `JobSteps.svelte`: a job with `media` shows its media steps; `succeeded_mediaserver_failed` as its own warn result), `web/src/lib/i18n/locales/*/syscheck.ts` (line label, causes, fixes), `web/src/lib/i18n/locales/*/admin.ts` (the job-result texts next to `rolled_back`, line ~277 in `de`, gain `succeeded_mediaserver_failed`; labels of the media actions)
- Test: `backend/test/mediaserver-pintick.test.ts`, `backend/test/syscheck-managed.test.ts`, extend `web/src/lib/admin/syscheck.test.ts`, `web/src/lib/admin/updater.test.ts`, `web/src/lib/admin/steps.test.ts`

**Interfaces:**
- Consumes: Tasks 12–14.
- Produces (`pinTick.ts`): `mediaPinTick(ctx: Ctx, log?: TickLog): Promise<'off' | 'idle' | 'started' | 'busy'>` — every 60 s where `BACKGROUND_JOBS=true` and `op()`: when `status.mediaserver.pin.changed` and `desired` and `container` and not busy → `startMediaJob(ctx, {op:'update'}, null, {op:'update', auto: true})` (kv `media:pin:<jobless source key>` not needed: the updater records the source on any attempt); also audits `mediaserver.recover` once per `mediaserver-recover` job id seen in the status (kv `media:recover:<id>` `setnx`, 7 days); records the first time a differing pin was seen (kv `media:pindiff:<pin image>` `setnx`, 30 days) for the Systemcheck.
- Produces (`checks/media.ts`): `managedLine(env: CheckEnv, view: MediaView | null, updater: UpdaterView): Promise<CheckLine>` (the `UpdaterView` gives the last job) with id `media.managed`, group `media`, `runs: 'server'`, `href: '/admin/settings?tab=media'`, `docs: 'mediaserver.md'`, the spec's table in this order (first match wins):

  | Condition | Status / cause |
  |---|---|
  | `mode === 'external'` and no managed container | `not_set_up` / `managed_off` |
  | updater missing | `warning` / `managed_no_updater` when a managed `kind` is set, else `not_set_up` / `managed_off` |
  | `engine_old` | `problem` / `managed_engine_old` when a container exists, else `not_set_up` / `managed_engine_old` |
  | `no_logs` | `warning` / `managed_proxy_outdated` (`docs: 'mediaserver.md#update-the-compose-files'`) |
  | container `tampered` | `problem` / `managed_tampered` |
  | desired running and container missing or not `running` | `problem` / `managed_down` |
  | health `unhealthy` | `problem` / `managed_unhealthy` |
  | `error === 'base_missing'` | `problem` / `managed_base_missing` |
  | `error === 'folder_missing'` | `warning` / `managed_folder_missing` |
  | `error` ∈ `gpu_missing`, `nvidia_missing` | `warning` / `managed_gpu_missing` |
  | last job a media action (or an update with `succeeded_mediaserver_failed`) that failed | `warning` / `managed_job_failed` (params `code`) |
  | pin differs from the running image for more than 7 days (kv first-seen) | `warning` / `managed_update_pending` |
  | newest backup older than 30 days, or none and `container.createdAt` older than 30 days | `warning` / `managed_backup_old` |
  | else | `ok` (params `kind`, `upstream`) |
- Web: `CHECK_IDS` mirror; `syscheck.line.media_managed` 'Verwalteter Medienserver'; `syscheck.cause.managed_*` and `syscheck.fix.managed_*` for the 12 causes; `admin/updater.ts` `JobState` gains `'succeeded_mediaserver_failed'` (tone warn, text "FriendFlix aktualisiert, Medienserver nicht: <code>" with *Erneut versuchen* linking to the media tab) and `UpdaterJobAction` gains the media actions (labels).

- [ ] **Step 1: Write the failing tests:**
  - `mediaserver-pintick.test.ts`: `a changed pin starts one media update`: status `pin.changed:true` → one `{op:'update'}` sent, audit `mediaserver.action` {op:'update'} with actor null; busy → nothing; `changed:false` → nothing; `desired.run:false` → nothing (Controller's call 17); `a recover job is audited once`: the same recover job in three status reads → one `mediaserver.recover` row.
  - `syscheck-managed.test.ts`: one `it` per table row building the view, asserting `{status, cause}` (and `params.code` for `managed_job_failed`, `params.kind/upstream` for `ok`); `the line has no path, code or address in its params`.
  - web `syscheck.test.ts`: `CHECK_IDS` equals the backend list (read `backend/src/syscheck/types.ts` as text like the existing mirror test does, or extend the existing equality test) and every `managed_*` cause has a text in all 7 locales; `updater.test.ts`: `succeeded_mediaserver_failed` maps to the warn tone and its text; `steps.test.ts`: a `mediaserver-apply` job lists its media steps (check … health) with their states, an update job with `media` adds them after the core steps.
- [ ] **Step 2: Run** `cd backend && TEST_DATABASE_URL=… npx vitest run test/mediaserver-pintick.test.ts test/syscheck-managed.test.ts` and `cd web && npx vitest run src/lib/admin/syscheck.test.ts src/lib/admin/updater.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `pinTick.ts`, its timer, `managedLine` (wired into `mediaCheck` right after `serverLine`), the web mirrors and the locale keys (all 7, same order).
- [ ] **Step 4: Run** the same files plus `web/src/lib/i18n/i18n.test.ts`, both typechecks, svelte-check, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat: media server moves with FriendFlix updates; Systemcheck line for the managed media server`.

### Task 16: Backend — encrypted backup download and upload streams

**Files:**
- Modify: `backend/src/routes/adminMediaserver.ts` (two stream routes), `backend/src/app.ts` (parser scope, logger redact)
- Test: `backend/test/mediaserver-backup.test.ts`

**Interfaces:**
- Consumes: Task 12 `mediaDownload`, `mediaUpload`, `startMediaJob`.
- Produces:
  - `GET /api/admin/mediaserver/backups/:id/download` — admin, re-auth, `id` matches `BACKUP_ID_RE`, header `x-ff-backup-passphrase` = base64url(UTF-8 passphrase) whose `decodePassphrase` is not null (12–1024 code points; else 400 `invalid_passphrase`), forwarded unchanged to the updater, 3 per 2 minutes; pipes the updater's body to the reply unchanged (`content-type: application/octet-stream`, `content-disposition` from the updater re-built from the id, `cache-control: no-store`) without buffering; the client's `close` aborts the updater request; audit `mediaserver.backup_download` {id} once the updater answered 200; updater 404/409 → the same status with its code.
  - `POST /api/admin/mediaserver/backups/upload` — admin, re-auth, `content-type: application/octet-stream` (scoped parser `'*'` → raw stream, like `livetv/adminRoutes.ts` line 658), `content-length` required and ≤ 20 GiB (else 411/413 before reading), same passphrase header, 3 per 10 minutes; streams `req.raw` to the updater; on `{backup}` audits `mediaserver.backup_upload` {size: content-length} and starts `{op:'restore', id}` (`startMediaJob`, audit `mediaserver.action` {op:'restore'}); answers 202 `{ backup, job }`; updater `backup_invalid` → 400 `backup_invalid`.
  - `app.ts`: both paths are outside the JSON body parser and their headers are never logged (`redact` of `x-ff-backup-passphrase` in the logger config).

- [ ] **Step 1: Write the failing tests** (`mediaserver-backup.test.ts`, fake updater streaming a 5-MB body in chunks):
  - `download streams without buffering`: the fake updater sends the first chunk and waits; the client receives it before the updater finishes (`inject` with `payloadAsStream`); the updater request carried the passphrase header and a signature over it.
  - `the backend passes the client abort on`: destroying the response stream aborts the fake updater's request (its `signal.aborted`).
  - `re-auth and passphrase rules`: stale session → 401 `reauth_required`; a header that is not base64url or decodes to 11 code points → 400; a Polish passphrase (encoded) passes; id `../x` → 404; nothing sent to the updater in these cases.
  - `upload streams to the updater and starts the restore`: a 3-MB body → the fake updater received exactly those bytes; then a `{op:'restore', id}` op; answer 202; audit rows `backup_upload` {size: 3145728} and `action` {op:'restore'}; no row and no log line contains the passphrase.
  - `upload limits before reading`: no `content-length` → 411; `content-length` 20 GiB + 1 → 413; `backup_invalid` from the updater → 400 and no restore op.
- [ ] **Step 2: Run** `cd backend && TEST_DATABASE_URL=… npx vitest run test/mediaserver-backup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes and the logger redaction.
- [ ] **Step 4: Run** the file plus Task 13's, the typecheck, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): encrypted media server backup download and upload`.

### Task 17: Web — Admin card *Medienserver*

**Files:**
- Create: `web/src/lib/admin/mediaserver/api.ts`, `web/src/lib/admin/mediaserver/model.ts`, `web/src/lib/admin/mediaserver/MediaServerCard.svelte`, `BaseFolder.svelte`, `FolderPicker.svelte`, `GpuSection.svelte`, `MediaStatus.svelte`, `BackupDialogs.svelte`, `LogDialog.svelte`, `SetupProgress.svelte` (all in `web/src/lib/admin/mediaserver/`), `web/src/lib/i18n/locales/<lang>/mediaserver.ts` (7)
- Modify: `web/src/lib/i18n/locales/<lang>/index.ts` (7: area `mediaserver` after `syscheck`), `web/src/routes/admin/settings/+page.svelte` (card first on the media tab; the `media` group card only while `mode === 'external'`), `e2e/mocks/admin.ts` (the media routes)
- Test: `web/src/lib/admin/mediaserver/model.test.ts`, `web/src/lib/admin/mediaserver/api.test.ts`, `e2e/tests/admin-mediaserver.spec.ts`, `e2e/tests/admin-mediaserver.mobile.spec.ts`

**Interfaces:**
- Consumes: Task 13 routes and `MediaView`, Task 16 stream routes.
- Produces (`api.ts`): `interface MediaApi { view(): Promise<MediaView>; requestBase(path): …; confirmBase(code): …; clearBase(): …; browse(rel): …; gpu(): …; apply(input: ApplyInput): …; action(op: ActionOp): …; logs(tail): Promise<{ lines: string[] }>; libraries(): …; deleteLibrary(slug): …; mode(restore: boolean): …; download(id, passphrase): Promise<void>; upload(file: File, passphrase): Promise<{ backup; job }> }`; `adminMediaApi: MediaApi` (paths `/api/admin/mediaserver…`, app CSRF) and `setupMediaApi(): MediaApi` (paths `/api/setup/mediaserver…`, setup CSRF; clearBase/logs/libraries/deleteLibrary/mode/download/upload reject with `not_supported`). `download` and `upload` send `x-ff-backup-passphrase` = base64url(UTF-8 passphrase) (`TextEncoder` + base64url, Controller's call 2). `download` streams `response.body` into `showSaveFilePicker({ suggestedName: '<id>.tar.gz.age' })` when it exists, else a Blob + object URL.
- Produces (`model.ts`): `type Choice = 'ferrofin' | 'jellyfin' | 'external'`; `DEFAULT_MANAGED: Kind = 'jellyfin'`; `TRIAL_KINDS: readonly Kind[] = ['ferrofin']`; `currentChoice(v: MediaView): Choice`; `choiceDisabled(v: MediaView, c: Choice): null | ReasonKey` (`kinds[c] === false` → `image_missing`); `countdown(expiresAt: string, now: number): string` (`mm:ss`, `00:00` when past); `passphraseError(a: string, b: string): null | 'short' | 'long' | 'mismatch'` (12–1024 code points); `folderRowsError(rows: Array<{ rel; name; type }>): null | 'none' | 'too_many' | 'name' | 'duplicate_name' | 'nested'`; `setupSteps(m: MediaManaged): Array<{ step: SetupStep; state: 'done' | 'running' | 'failed' | 'todo' }>`; `actionsFor(v: MediaView): ActionOp[]`; `codeLogHint` = the two places (`docker compose logs updater | grep "media folder"`, Portainer → Container `updater` → *Logs*).
- UI (spec *Admin and wizard*): segmented control with the three choices (*Test* badge and docs link on Ferrofin while it is in `TRIAL_KINDS`; disabled choices show their reason line); managed sections *Basisordner* (path field + *Code anfordern* → code field with countdown and the hint; confirmed path read-only with *Ändern*), *Ordner* (breadcrumb browser one level at a time; symlinks shown, not selectable; unreadable marked; per chosen folder name 1–60 and type *Filme*/*Serien*/*Musik*/*Gemischt*; read-check warnings next to the folder incl. `max_user_watches`; removal confirmation says the library stays; *Bibliothek löschen* lists the reference counts), *Benutzer* (uid, gid default 1000:1000, *Gruppe <gid> hinzufügen* when the check says the group can read), picking the folder that holds `livetvLibraryPath` offers to save `LIVETV_RECORD_LIBRARY_JF_PATH` as its new target path; *Grafikkarte* (detection, *Aus* / *Intel/AMD (VA-API/QSV)* / *NVIDIA* only when detected, *HDR-Test* with PASS/FAIL per test), *Metadaten aus dem Internet* (on by default), *Status* (state, health, kind and upstream, image vs pin incl. "neuer als dieser FriendFlix-Stand", last job with its steps through the existing `JobSteps.svelte` (Task 15 taught `steps.ts` the media steps), `SetupProgress` with *Nochmal*), actions per `actionsFor`, *Protokoll* (300 lines, copy button), *Entfernen* with *Daten löschen* requiring the kind's name typed, backups list with *Herunterladen* (passphrase twice, ≥ 12) and *Aus Datei wiederherstellen*; *Bestehender Jellyfin/Plex* switches through `mode` with the id warning and *Zurück zu <address>* when saved. Re-auth errors go through `isReauthError` / `reauthenticate` like the settings page.

- [ ] **Step 1: Write the failing tests:**
  - `model.test.ts`: every function above with its edge values (`countdown` at 30:00, 0:01, past; `passphraseError('kurz', 'kurz')` `short`, 12 chars mismatched `mismatch`; `folderRowsError` for 0, 21, a 61-char name, two equal names, `Filme` + `Filme/Neu`; `setupSteps` with `setup 'libraries'` + error → libraries `failed`, earlier `done`, later `todo`; `choiceDisabled` for each offer reason and `kinds.ferrofin=false`; `currentChoice` external/managed).
  - `api.test.ts`: `admin and setup APIs call their paths with their CSRF header`; `download prefers showSaveFilePicker and falls back to a Blob link`; `upload sends the file as octet-stream with the passphrase header` (header = base64url of `'zażółć gęślą jaźń'`).
  - `admin-mediaserver.spec.ts` (mocked routes): `choose managed Jellyfin, confirm the base with the code, pick two folders, set up` (the code step shows the countdown and the hint; the progress list advances through the mocked `setup` values; nothing above the progress moves: bounding boxes of the card header and the segmented control stay put); `disabled choices say why` (`ids_in_use` → "Umzug von deinem Jellyfin: kommt mit Stufe 2"; `plex` → "Wechsel von Plex: kommt mit Stufe 4"); `remove with data asks for the kind's name`; `download asks for the passphrase twice`; `log dialog shows redacted lines and copies them`. `admin-mediaserver.mobile.spec.ts`: the same first flow at phone width, 44-px targets for the segmented control and actions, no horizontal scroll.
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/admin/mediaserver` and the two e2e specs. Expected: FAIL.
- [ ] **Step 3: Implement** the modules, components, page change, mocks and the `mediaserver` area in 7 locales (German first; same key order everywhere).
- [ ] **Step 4: Run** the same tests plus `src/lib/i18n/i18n.test.ts`, svelte-check, `npm run build -w web`, eslint, and `cd web && npx vitest run --coverage` for the statements total (≥ 94 %). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Admin card for the managed media server`.

### Task 18: Web — wizard step 3 managed path

**Files:**
- Modify: `web/src/lib/setup/StepMedia.svelte`, `web/src/lib/setup/api.ts` (`SetupState.mediaserver?: { offer; kinds }` read from `GET /api/setup/mediaserver` lazily), `web/src/lib/i18n/locales/<lang>/setup.ts` (7), `e2e/mocks/setup.ts`
- Test: extend `web/src/lib/setup/setup.test.ts`, `e2e/tests/setup.spec.ts`, `e2e/tests/setup.mobile.spec.ts`

**Interfaces:**
- Consumes: Task 17 components with `setupMediaApi()`, `DEFAULT_MANAGED`.
- Produces: step 3 shows the three choices with *Jellyfin (offiziell, verwaltet)* preselected (`DEFAULT_MANAGED`; a one-line change switches it to Ferrofin later, owner decision 8) when `offer.managed`, else today's fields with the reason line; the managed path runs *Basisordner* → *Ordner* → *Grafikkarte* (+ metadata switch) → *Einrichten* with `SetupProgress`, and dispatches `done` when `setup === 'done'`; *Bestehender Jellyfin/Plex* keeps today's auto/manual flow unchanged.

- [ ] **Step 1: Write the failing tests:** `setup.test.ts`: `managed is preselected when offered` / `external when not offered` (pure helper `initialChoice(state)` exported from `StepMedia`'s companion module in `setup/api.ts`); `setup.spec.ts`: `wizard sets up managed Jellyfin and continues to step 4` (mocked progress ending in `done`); `with Plex the step stays as before`; mobile variant of the first.
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/setup/setup.test.ts` and the e2e specs. Expected: FAIL.
- [ ] **Step 3: Implement** the step and texts (7 locales).
- [ ] **Step 4: Run** the same tests plus `setup.plex.spec.ts`, svelte-check, build, eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): managed media server in the setup wizard`.

### Task 19: Docs and CHANGELOG

**Files:**
- Modify: `docs/mediaserver.md` and `docs/de/mediaserver.md` (rewritten: managed first — choices, base folder and code, folders, user and group, GPU and HDR test, metadata, updates with FriendFlix and *never down*, backups and the encrypted download (`age -d -o backup.tar.gz <file>.age`), and that `docker compose down -v` removes the backup volume (the encrypted download is the off-host copy), `docker compose down` stops at the `media` network and how to stop the media server first, Portainer, several instances, the compose refresh for `ALLOW_LOGS` and the backup volume with anchor `#update-the-compose-files`; trial `try.sh`/`probe.sh` second), `docs/security.md` (*Updater*: seventh route and bodies, stream routes signed over the base64url passphrase header, template and guard, helpers, base code only on stdout, `ALLOW_LOGS`, the backup volume mount; *Proxy allowlist* gains logs; *What the proxy blocks* loses logs; backend-attacker paragraph per spec; residual risks per spec), `docs/setup.md` and `docs/de/setup.md` (step 3 choices), `docs/operations.md` (*Backups & Wiederherstellung*: the media server backup volume and the one command that copies it to the host: `docker run --rm -v <project>_mediaserver-backup:/b:ro -v "$PWD":/out alpine cp -a /b/. /out/`), `CHANGELOG.md` (*Unreleased*: *Upgrade notes* — refresh the compose files and `docker compose up -d` once / Portainer: update the stack file, for `ALLOW_LOGS` and the backup volume; *Admin* — the managed media server; *Added* — image changes 0003/0004), `mediaserver/README.md` only if Task 11 left something
- Test: every relative link in the touched files resolves to an existing file, and `mediaserver.md#update-the-compose-files` (used by Task 15) exists as a heading.

- [ ] **Step 1: Write** the docs (fictional names and placeholder hosts only; German copies follow the English structure).
- [ ] **Step 2: Check** the links. Expected: every target exists.
- [ ] **Step 3: Commit** `docs: managed media server (setup, security, operations, changelog)`.

---

## Manual checklist for the PR (spec *Testing*, real host)

Both kinds boot read-only and transcode with the Intel GPU; a Portainer stack runs every media job; a Portainer-driven FriendFlix update moves the pin (`pin.changed` trigger); an engine below 26 shows `engine_old`; `age -d` decrypts a downloaded backup.
