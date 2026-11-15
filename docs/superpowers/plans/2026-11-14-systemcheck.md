# Systemcheck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One live checklist on Admin → Status (status, cause, fix, "Zur Einstellung") plus a tabbed, searchable Admin → Settings with `?setting=<KEY>` deep links.

**Architecture:** A thin engine in `backend/src/syscheck/` turns the existing health snapshot, sign-in check (`flowCheck.ts`), settings probes and Live-TV/updater state into coded check lines, served cached by `GET /api/admin/systemcheck`. The web renders the lines from a mirrored catalogue and adds four browser-only proxy checks. Settings gain tabs, search and a highlight helper on top of today's page state.

**Tech Stack:** Fastify + PostgreSQL + Redis (backend), Node gateway, SvelteKit/Svelte 5 (web), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-systemcheck-design.md`

## Global Constraints

- Four stages, each its own PR, green CI, merged with **merge** (never rebase, never squash-rebase); stage N+1 branches from main after N merged.
- All copy in 7 locales (de, en, es, fr, it, pl, tr) with **identical key order**; German is the source; no "Netflix"/"Seerr" in user-facing text.
- Placeholder hosts only: `friend.example.com`, `auth.example.com`, `192.0.2.x`.
- Never log or return a secret, URL with credentials, host path, exception text or upstream body; a secret is only *gültig / ungültig / fehlt*. Logs carry `{check, code}` only.
- UI: 44 px targets; animate only `transform`/`opacity`; nothing may jump (skeleton at final row count, stable line order); status never by colour alone (icon + word); every request through `api()`.
- Agents run `npm run typecheck` (or `-w backend` / `-w web`) plus the specific specs named in a task — never the full suites.
- Backend tests: `TEST_DATABASE_URL=… npx -w backend vitest run <files> --no-file-parallelism`. Web unit: `npx -w web vitest run <files>`. E2E: `npm run e2e -- <spec files>`.
- Commits end with the session's two trailer lines. Never `git stash`.
- PR LetsManu/friendflix#303 may land before or after Stage 3: the Updates check consumes `portainerSetup(ctx): { configured: boolean; mode: 'webhook' | 'api' | null; missing: string[] }`.

## Review Focus

1. A secret-looking config value (`AUTHENTIK_API_TOKEN='sekret-ak-0000'`, `PORTAINER_API_KEY='sekret-pt-0000'`, `REQUESTS_API_KEY`, a Discord URL) never appears in the JSON of any answer, even when probes fail with upstream bodies that echo it (Task 1 + Task 7 tests).
2. One hung dependency (Authentik never answering, Postgres stalled) still gives an answer within ~8.5 s with that group `unknown`/`check_timeout` and every other line filled (Task 1 test).
3. An optional feature that is not configured (no request service, no TMDB key, no Authentik API, Live TV never enabled, compose without updater) is `not_set_up` and counted in neither problems nor warnings (Task 2/3/7 tests; overview pill reads "Alles in Ordnung").
4. Redis down: the endpoint still answers (built in-process, `core.redis` = problem) instead of 500 (Task 1 test).
5. A deep link to a setting that is env-locked, on another tab, or unknown: the right tab opens and the row is highlighted (the Systemcheck line already said "steht in der .env", Task 4 test); an unknown key opens *Allgemein* without error (Task 10 tests).

---

## Stage 1 — check engine, endpoint, first lines (backend only)

### Task 1: Contract, engine and endpoint

**Files:**
- Create: `backend/src/syscheck/types.ts`, `backend/src/syscheck/engine.ts`, `backend/src/syscheck/checks/proxy.ts` (stub), `backend/src/routes/systemcheck.ts`
- Modify: `backend/src/app.ts` (register `systemcheckRoutes(app, ctx)` next to `healthRoutes`)
- Test: `backend/test/syscheck.test.ts` (new)

**Interfaces:**
- Produces (`types.ts`): `CheckStatus`, `CheckGroup`, `CheckLine`, `SystemcheckResult` exactly as in the spec; `CHECK_IDS: readonly CheckId[]` (the full catalogue in spec order, including later-stage ids) and `type CheckId = (typeof CHECK_IDS)[number]`; `CHECK_GROUPS: readonly CheckGroup[]` (`core, signin, media, livetv, updates, proxy`).
- Produces (`engine.ts`):
  - `interface CheckEnv { ctx: Ctx; snapshot: HealthSnapshot; login(): Promise<LoginCheck>; fresh: boolean }` (`login` memoised per run).
  - `interface GroupCheck { group: CheckGroup; ids: readonly CheckId[]; timeoutMs: number; run(env: CheckEnv): Promise<CheckLine[]> }`
  - `registerChecks(list: GroupCheck[]): void` (module registry; Tasks 2/3/7/8 add theirs) and `resetChecksForTests()`.
  - `safeParams(p: Record<string, unknown> | undefined): CheckLine['params']` — keeps only values matching the spec's three patterns.
  - `line(id: CheckId, status: CheckStatus, o?: Partial<Omit<CheckLine, 'id'|'group'|'status'|'runs'>>): CheckLine` — fills `group` from the id prefix, `runs: 'server'`, `settingGroup` and `locked` from `settingDef(key)` / `ctx.settings.sources()[key] === 'env'`, passes `params` through `safeParams`, validates `docs`.
  - `buildSystemcheck(ctx: Ctx, o?: { fresh?: boolean }): Promise<SystemcheckResult>` — every GroupCheck in parallel under its own limit (default `CHECK_TIMEOUT_MS = 4000`, sign-in `8000`); a miss → its `ids` as `unknown` + `check_timeout`; a throw → `unknown` + `check_failed`.
  - `getSystemcheck(ctx: Ctx, o?: { refresh?: boolean }): Promise<SystemcheckResult>` — kv `syscheck:result` TTL 300 s, fresh ≤ 60 s, stale → served + background rebuild, single flight per ctx (`WeakMap`), kv errors → build without cache. `systemcheckSettled(ctx)` for tests.
- Produces (route): `GET /api/admin/systemcheck[?refresh=1]` admin only, `cache-control: no-store`; refresh limited 6/min per session via `ctx.kv.incr('syscheck:refresh:<sid>', 60)` → 429 `{ error: 'rate_limited' }`; merges request-scoped lines from `requestLines(req, ctx)` (`checks/proxy.ts`; returns `[]` until Task 8) and recomputes `counts`.

- [ ] **Step 1: Write failing tests** in `syscheck.test.ts` with two fake GroupChecks registered:
  - `answers lines in catalogue order with counts per status` — `counts.problem === 1`, `lines.map(l => l.id)` follows `CHECK_IDS` order.
  - `a check over its limit yields unknown check_timeout for its ids and the answer comes within limit + 500 ms` (fake check never resolves, `timeoutMs: 200`).
  - `a throwing check yields unknown check_failed and no message in the answer`.
  - `safeParams drops urls, free text and secrets` — `{ n: 3, keys: 'PORTAINER_URL,PORTAINER_STACK_ID', code: 'view_flow', url: 'https://auth.example.com/x', t: 'sekret-ak-0000' }` → `{ n: 3, keys: …, code: 'view_flow' }`.
  - `line() sets settingGroup and locked for an env-set key` (env `PUBLIC_URL`) and rejects a docs value `'../x.md'` (dropped).
  - `serves the cached result without running checks within 60 s; refresh=1 reruns`.
  - `refresh=1 is limited to 6 per minute per session → 429 rate_limited`.
  - `non-admin → 403`.
  - `kv failing: still answers 200`.
- [ ] **Step 2: Run** `TEST_DATABASE_URL=… npx -w backend vitest run test/syscheck.test.ts --no-file-parallelism` → FAIL.
- [ ] **Step 3: Implement** types, engine (reuse the `bounded()` pattern of `health.ts`; export it from `health.ts` rather than copying), route.
- [ ] **Step 4: Run** the same file + `npm run typecheck -w backend` → PASS.
- [ ] **Step 5: Commit** `feat(syscheck): check engine and GET /api/admin/systemcheck`.

### Task 2: Core and media lines

**Files:**
- Create: `backend/src/syscheck/checks/core.ts`, `backend/src/syscheck/checks/media.ts`
- Modify: `backend/src/syscheck/engine.ts` (register both at module load via an `index` import list)
- Test: `backend/test/syscheck-core-media.test.ts`

**Interfaces:**
- Consumes: Task 1 (`line`, `GroupCheck`, `CheckEnv`), `HealthSnapshot` (`health.ts`), `runProbe` (`settings/probes.ts`), `removedEnvCount`.
- Produces: `coreCheck: GroupCheck` (ids `core.publicUrl, core.database, core.redis, core.gateway, core.disk.downloads, core.disk.previews, core.disk.database, core.env`), `mediaCheck: GroupCheck` (ids `media.server, media.requests, media.tmdb, media.omdb, media.playback, media.encoder`); `levelToStatus(level: Level, reason?: Reason): CheckStatus` (spec mapping, exported for Task 7). Downloads disk line is `not_set_up` when `DOWNLOADS_ENABLED !== 'true'`; a shared downloads/previews filesystem yields both lines from the one entry.
- Cause/fix codes and targets exactly as the spec's catalogue table.

- [ ] **Step 1: Failing tests** (fakeHttp + `makeEnv` like `health.test.ts`):
  - `database down → core.database problem db_down`; `redis slow → warning`.
  - `PUBLIC_URL http → core.publicUrl warning public_url_http, settingKey PUBLIC_URL`.
  - `no request service → media.requests not_set_up settingKey REQUESTS_URL; counts.problem and counts.warning are 0 for it`.
  - `request service answers 401 → media.requests warning requests_key_invalid settingKey REQUESTS_API_KEY`.
  - `TMDB key invalid → media.tmdb warning settingKey TMDB_API_KEY; no key value in JSON.stringify(result)`.
  - `media server down with MEDIA_SERVER=plex → settingKey PLEX_URL`.
  - `encoder advice no_hw_accel, no_tonemap → media.encoder warning cause no_hw_accel, params.advice 'no_hw_accel,no_tonemap'` (advice joined as codes).
  - `playback check never ran → media.playback unknown playback_never href /admin/playback`.
  - `downloads disabled → core.disk.downloads not_set_up`.
  - `every docs value names an existing docs/<file>.md heading` (reads `../docs`, slugifies `##`/`###` headings GitHub-style).
- [ ] **Step 2: Run** `… vitest run test/syscheck-core-media.test.ts …` → FAIL.
- [ ] **Step 3: Implement** both checks from `env.snapshot` (no new probes except `runProbe('publicUrl')` and `runProbe('requests')` when the snapshot says down/warn).
- [ ] **Step 4: Run** the file + `test/syscheck.test.ts` + `test/health.test.ts` + backend typecheck → PASS.
- [ ] **Step 5: Commit** `feat(syscheck): core and media check lines`.

### Task 3: Sign-in lines

**Files:**
- Create: `backend/src/syscheck/checks/signin.ts`
- Test: `backend/test/syscheck-signin.test.ts` (reuse the Authentik fakes of `flow-check.test.ts` / `akflow-fake.ts`)

**Interfaces:**
- Consumes: `env.login()` (→ `checkLoginFlows(ctx, { fresh: env.fresh })`), snapshot `oidc`.
- Produces: `signinCheck: GroupCheck` (ids `signin.oidc, signin.authentik, signin.flows, signin.issuerHost, signin.passkeys, signin.mail`, `timeoutMs: 8000`). `ak_token_invalid` and `ak_unreachable` are `problem` when `LoginCheck.mode === 'app'`, else `warning`. `signin.flows` carries `params.n` = number of flow warnings and the first as cause. `signin.passkeys` precedence: passkeysReason first, then passkeySignIn, then uv.

- [ ] **Step 1: Failing tests:**
  - `no Authentik API → signin.authentik, signin.flows, signin.mail not_set_up; signin.passkeys not_set_up when PASSKEYS_IN_APP=off`.
  - `token refused in app mode → signin.authentik problem ak_token_invalid settingKey AUTHENTIK_API_TOKEN; JSON has no token value`.
  - `forwarded host ignored → signin.passkeys warning forwarded_host_ignored fix proxy_forward_host docs authentik.md#23-reverse-proxy-nginx-proxy-manager`.
  - `recovery flow with an e-mail stage → signin.mail ok cause mail_unverified; without → warning mail_no_stage`.
  - `two flows missing → signin.flows warning params.n 2 href /admin/status#login`.
  - `issuer not on the Authentik address → signin.issuerHost warning settingKey OIDC_ISSUER`.
  - `Authentik never answers → sign-in lines unknown check_timeout, other groups filled, answer < 8.5 s`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file + `test/flow-check.test.ts` + `test/syscheck.test.ts` + backend typecheck → PASS.
- [ ] **Step 5: Commit** `feat(syscheck): sign-in check lines`; add a CHANGELOG line under Unreleased ("Admin: GET /api/admin/systemcheck").

**Stage 1 ship:** PR `Systemcheck: check engine and first lines`, green CI, merge.

---

## Stage 2 — Systemcheck UI on Status, overview summary

### Task 4: Web data layer and i18n area

**Files:**
- Create: `web/src/lib/admin/syscheck.ts`, `web/src/lib/admin/syscheck.test.ts`
- Create: `web/src/lib/i18n/locales/{de,en,es,fr,it,pl,tr}/syscheck.ts`; Modify: each locale's `index.ts` (import + export entry, same position after `adminLive`)

**Interfaces:**
- Consumes: the Task 1 wire shape.
- Produces (`syscheck.ts`): types mirrored from `backend/src/syscheck/types.ts`; `CHECK_IDS` (same order — a test compares with a copied list to catch drift); `loadSystemcheck(refresh?: boolean): Promise<SystemcheckResult>`; `lineText(l: CheckLine): { label: string; cause: string; fix: string }` (unknown codes → '' never the raw code; `locked` appends `syscheck.fix.envLocked`); `settingHref(key: string, group?: string): string` (`livetv` → `/admin/livetv?tab=settings&setting=KEY`, else `/admin/settings?setting=KEY`, key matched against `^[A-Z][A-Z0-9_]*$`); `docsHref(docs: string): string`; `statusTone(s): Tone`, `statusIcon(s): string`; `summaryOf(counts): { tone: Tone; text: string }` (problems before warnings, plural; all else → "Alles in Ordnung"); `mergeLines(server: CheckLine[], browser: CheckLine[]): CheckLine[]` (catalogue order, browser ids replace placeholders).
- i18n keys exactly as the spec's i18n section; line keys `syscheck.line.<id with . → _>`.

- [ ] **Step 1: Failing tests:** `lineText of a known cause/fix`; `an unknown cause gives ''`; `locked adds the .env sentence`; `settingHref for livetv and other groups, refuses 'x"><script'` (→ `/admin/settings`); `docsHref builds the blob/main URL and refuses '../'`; `summaryOf: {problem:2,warning:1} → '2 Probleme' err; {warning:1} → '1 Warnung' warn; only not_set_up → 'Alles in Ordnung' ok`; `mergeLines keeps catalogue order`; `CHECK_IDS matches the backend list` (literal copy); plus the existing per-locale tests pick up the new area.
- [ ] **Step 2: Run** `npx -w web vitest run src/lib/admin/syscheck.test.ts src/lib/i18n` → FAIL.
- [ ] **Step 3: Implement** helpers + German texts, then the six translations (same key order).
- [ ] **Step 4: Run** the same + `npm run typecheck -w web` → PASS.
- [ ] **Step 5: Commit** `feat(web): Systemcheck data layer and texts`.

### Task 5: Systemcheck section on Admin → Status

**Files:**
- Create: `web/src/lib/admin/SystemCheck.svelte`, `web/src/lib/admin/CheckLine.svelte`, `web/src/lib/admin/HevcCheck.svelte` (the HEVC "Jetzt prüfen" logic moved out of `ServiceLights.svelte`)
- Modify: `web/src/routes/admin/status/+page.svelte` (section `#systemcheck` replaces the ServiceLights section; `LoginCard` wrapper gets `id="login"`), delete `ServiceLights.svelte` if nothing else imports it
- Modify: `docs/operations.md` (§ "Warnband und Status-Seite": a Systemcheck paragraph)
- Create: `e2e/mocks/syscheck.ts`; Test: `e2e/tests/admin-systemcheck.spec.ts`, `e2e/tests/admin-systemcheck.mobile.spec.ts`; Modify: `e2e/tests/admin-health*.spec.ts` where they asserted ServiceLights rows

**Interfaces:**
- Consumes: Task 4 helpers.
- Produces: `<SystemCheck />` (self-loading; props `browserLines: CheckLine[] = []` for Task 9); `<CheckLine line={CheckLine} />` with actions *Zur Einstellung* / *Details* / *Anleitung* and, for `media.encoder` with `hevc` advice, `<HevcCheck />`. "Jetzt prüfen" calls `loadSystemcheck(true)` and then `refreshBanner()`; 429 → toast `syscheck.rateLimited`, last list kept.

- [ ] **Step 1: Failing e2e:** `shows six groups and every catalogue line in order`; `a problem line shows cause, fix and Zur Einstellung linking to /admin/settings?setting=AUTHENTIK_API_TOKEN`; `a not_set_up line is neutral and has no red pill`; `Jetzt prüfen sends refresh=1 and updates the time`; `429 keeps the list and shows the toast`; `skeleton and loaded list have the same height` (bounding box of `#systemcheck` before/after within 1 px); `Details of a sign-in line scrolls to #login`; mobile: `no horizontal scroll at 375 px; action targets ≥ 44 px`.
- [ ] **Step 2: Run** `npm run e2e -- e2e/tests/admin-systemcheck.spec.ts e2e/tests/admin-systemcheck.mobile.spec.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the two specs + `admin-health.spec.ts admin-health.mobile.spec.ts` + web typecheck → PASS.
- [ ] **Step 5: Commit** `feat(admin): Systemcheck on the status page`.

### Task 6: Overview summary

**Files:**
- Modify: `web/src/routes/admin/+page.svelte` (health strip: first item *Systemcheck*)
- Test: extend `e2e/tests/admin-systemcheck.spec.ts`

**Interfaces:**
- Consumes: `loadSystemcheck()`, `summaryOf(counts)`.
- Produces: strip item `{ label: syscheck.title, icon: 'activity', href: '/admin/status#systemcheck', tone, text }`; skeleton while loading; on error the item shows *unbekannt* (muted), never blocks the strip.

- [ ] **Step 1: Failing e2e:** `overview shows "2 Probleme" and links to /admin/status#systemcheck`; `only not_set_up lines → "Alles in Ordnung"`; `systemcheck 500 → muted unknown, other strip items still render`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the spec + `admin-content.spec.ts` + web typecheck → PASS.
- [ ] **Step 5: Commit** `feat(admin): Systemcheck summary on the overview`; CHANGELOG line.

**Stage 2 ship:** PR `Systemcheck: status page and overview`, green CI, merge.

---

## Stage 3 — remaining lines, browser-side proxy checks

### Task 7: Live TV and Updates lines

**Files:**
- Create: `backend/src/syscheck/checks/livetv.ts`, `backend/src/syscheck/checks/updates.ts`
- Modify: web `syscheck.ts` locales (new cause/fix keys, 7 locales)
- Test: `backend/test/syscheck-livetv-updates.test.ts`

**Interfaces:**
- Consumes: `detectLivetv`, `livetvInstalled`, `livetvSystem`, `readHwAccel`, `gpuAdvice`, `REFRESH_INTERVAL_MS`, `EPG_MAX_AGE_MS`, `updaterView`, `portainerMode`, `runProbe('portainer')`.
- Produces: `livetvCheck: GroupCheck` (ids `livetv.container, livetv.encoder, livetv.sources, livetv.guides`), `updatesCheck: GroupCheck` (ids `updates.updater, updates.path, updates.portainer`).
- **#303 seam:** if `updates.ts` already exports `portainerSetup`, import it. Otherwise define in `checks/updates.ts`: `function portainerSetup(ctx: Ctx): { configured: boolean; mode: 'webhook' | 'api' | null; missing: string[] }` with #303's rule (`missing` = the unset ones of `PORTAINER_URL, PORTAINER_API_KEY, PORTAINER_STACK_ID` when some are set and `portainerMode` is null). Whichever of the two PRs merges second removes the copy (merge, not rebase).

- [ ] **Step 1: Failing tests:**
  - `Live TV never enabled → all four livetv lines not_set_up, none counted as problem`.
  - `LIVETV_WANTED and livetv not answering → livetv.container problem livetv_down; encoder/sources/guides unknown`.
  - `a list with last_error → livetv.sources warning params.n 1`; `last ok 3 days ago on a 24h list → sources_stale`.
  - `gpu advice needsRenderGid → livetv.encoder warning gpu_needsRenderGid settingKey LIVETV_ENCODER settingGroup livetv`.
  - `no UPDATER_URL → updates.updater not_set_up; updates.path still evaluated from portainer settings`.
  - `stack own → updates.path ok path_compose; updates.portainer not_set_up`.
  - `stack foreign, PORTAINER_URL only → updates.path problem portainer_missing params.keys 'PORTAINER_API_KEY,PORTAINER_STACK_ID' settingKey PORTAINER_API_KEY`.
  - `stack null (old updater) → updates.path warning stack_unknown`.
  - `Portainer answers 401 → updates.portainer problem portainer_key_invalid; JSON never contains 'sekret-pt-0000'`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the file + `test/syscheck.test.ts` + `test/updater.test.ts` + backend typecheck → PASS.
- [ ] **Step 5: Commit** `feat(syscheck): Live TV and update path lines`.

### Task 8: Server-side proxy lines and the probe endpoints

**Files:**
- Modify: `backend/src/syscheck/checks/proxy.ts` (fill the Task 1 stub), `backend/src/routes/systemcheck.ts` (adds `GET /ws/syscheck`)
- Modify: `backend/src/livetv/adminRoutes.ts` (guide-file route: probe id), `gateway/src/gateway.ts` (`/media/probe/drip`, before the `upstreamBase()` check)
- Test: `backend/test/syscheck-proxy.test.ts`, `gateway/test/gateway.test.ts` (extend)

**Interfaces:**
- Produces: `requestLines(req: FastifyRequest, ctx: Ctx): CheckLine[]` (ids `proxy.forwardedProto`, `proxy.peer`; uses `isTrustedPeer` from `netaddr.ts`; `localhost` PUBLIC_URL → ok).
- `GET /ws/syscheck` (websocket, admin session required; non-admin → close 4403): sends `{"ok":true}` then closes 1000; rate limit 10/min.
- `PROBE_SOURCE_ID = '00000000-0000-0000-0000-000000000000'` exported from `livetv/guidefiles.ts`: `PUT /api/admin/livetv/sources/<PROBE_SOURCE_ID>/file` (admin + CSRF as today) drains the body, counting at most `4 MiB` (more → 413 `too_large`), writes nothing, no audit, answers 200 `{ probe: 'ok', bytes }`; rate limit 10/min.
- Gateway `GET /media/probe/drip`: `200`, `content-type: application/octet-stream`, `cache-control: no-store`, `x-content-type-options: nosniff`, 1024 bytes, 1500 ms pause, 1024 bytes, end; at most 4 at once (5th → 429); no auth, no upstream call, no log line per request.

- [ ] **Step 1: Failing tests:**
  - `request arriving as http while PUBLIC_URL is https → proxy.forwardedProto warning proxy_no_proto`; `x-forwarded-proto https from a trusted peer → ok`.
  - `x-forwarded-for from a public peer (203.0.113.9 via injected socket address) → proxy.peer warning proxy_untrusted_peer`.
  - `GET /ws/syscheck as admin receives {"ok":true} and close 1000; as a user → 4403`.
  - `probe upload of 2 MiB → 200 {probe:'ok', bytes: 2097152}, no file in guideDir, no audit row`; `5 MiB → 413`; `non-admin → 403`; `missing CSRF → 403`.
  - gateway: `drip sends the first 1024 bytes before the pause` (time to first chunk < 300 ms, total ≥ 1500 ms); `a fifth concurrent drip → 429`.
- [ ] **Step 2: Run** `… vitest run test/syscheck-proxy.test.ts` and `npx -w gateway vitest run test/gateway.test.ts` → FAIL.
- [ ] **Step 3: Implement.** No proxy config change: `/ws/` and `/media/` already route to backend and gateway in `deploy/npm/portal.advanced.conf`, and the probe upload path matches the existing guide-file location.
- [ ] **Step 4: Run** both + backend and gateway typecheck → PASS.
- [ ] **Step 5: Commit** `feat(syscheck): proxy lines, websocket, upload and buffering probes`.

### Task 9: Browser checks in the Systemcheck

**Files:**
- Create: `web/src/lib/admin/syscheckBrowser.ts`, `web/src/lib/admin/syscheckBrowser.test.ts`
- Modify: `web/src/lib/admin/SystemCheck.svelte` (runs browser checks on mount and on Jetzt prüfen; merges via `mergeLines`), locales (proxy keys, 7 locales), `docs/setup.md` § 6 (one sentence: Admin → Status → Systemcheck checks websockets, buffering, upload limit and headers)
- Test: extend `e2e/tests/admin-systemcheck.spec.ts`

**Interfaces:**
- Produces: `runBrowserChecks(o: { livetvInstalled: boolean; origin?: string; deps?: BrowserDeps }): Promise<CheckLine[]>` (ids `proxy.websocket, proxy.buffering, proxy.upload, proxy.headers`, `runs: 'browser'`, each with its own 6 s limit, all in parallel); `interface BrowserDeps { fetch: typeof fetch; WebSocket: typeof WebSocket; now(): number }` for tests. Pure classifiers: `classifyDrip(firstChunkMs: number, totalMs: number, status: number): CheckLine`, `classifyUpload(status: number, json: unknown | null, networkError: boolean): CheckLine`, `classifyHeaders(h: Headers, https: boolean): CheckLine`.
- `livetvInstalled` comes from the server line `livetv.container` (status not `not_set_up`/`problem`).

- [ ] **Step 1: Failing tests (unit):** `classifyDrip(150, 1600, 200) → ok`; `classifyDrip(1580, 1600, 200) → warning proxy_buffers_media`; `classifyDrip(0, 0, 404) → unknown probe_missing`; `classifyUpload(200, {probe:'ok'}, false) → ok`; `classifyUpload(413, null, false) → warning upload_limit_low`; `classifyUpload(0, null, true) → unknown`; `classifyHeaders without HSTS on https → warning hsts_missing`; `classifyHeaders without nosniff → warning headers_stripped`; `ws that never opens → problem ws_blocked within 6 s (fake timers)`; `livetv not installed → proxy.upload not_set_up and no PUT sent`.
- [ ] **Step 2: Failing e2e:** `browser lines show wird geprüft… then their result`; `a mocked 413 on the probe upload shows the upload warning with the Anleitung link`.
- [ ] **Step 3: Run** `npx -w web vitest run src/lib/admin/syscheckBrowser.test.ts` and the e2e spec → FAIL.
- [ ] **Step 4: Implement** (the upload body is `new Blob([new Uint8Array(2 * 1024 * 1024)])` through `api()` raw, `content-type: application/octet-stream`).
- [ ] **Step 5: Run** both + web typecheck → PASS.
- [ ] **Step 6: Commit** `feat(admin): browser-side proxy checks`; CHANGELOG line.

**Stage 3 ship:** PR `Systemcheck: Live TV, updates and reverse proxy`, green CI, merge.

---

## Stage 4 — settings tabs, search, deep links

### Task 10: Tabs and `?setting=` deep links

**Files:**
- Create: `web/src/lib/admin/settings/tabs.ts`, `web/src/lib/admin/settings/highlight.ts`, `web/src/lib/admin/settings/tabs.test.ts`
- Modify: `web/src/routes/admin/settings/+page.svelte` (tab bar, `?tab=`, `?setting=`, legacy `#settings-<group>`), `web/src/lib/admin/settings/SettingRow.svelte` (`id="setting-{item.key}"`, `data-flash` class hook), `web/src/lib/admin/livetv/SettingsTab.svelte` (honour `?setting=`), `web/src/lib/admin/RecoCard.svelte` (link → `?setting=RECO_ENGINE`), locales `settings.tabs.*` (7 locales)
- Test: `e2e/tests/admin-settings.spec.ts`, `admin-settings.mobile.spec.ts` (extend), `admin-livetv-settings.spec.ts` (extend)

**Interfaces:**
- Produces (`tabs.ts`): `SETTINGS_TABS = ['general', 'signin', 'media', 'playback', 'updates', 'notifications'] as const`; `type SettingsTab`; `TAB_GROUPS: Record<SettingsTab, readonly SettingGroup[]>` (spec table); `tabOfGroup(g: SettingGroup): SettingsTab | 'livetv'`; `tabOf(param: string | null): SettingsTab` (unknown → `general`); `tabOfKey(key: string, groups: SettingsGroupView[]): SettingsTab | 'livetv' | null`; `dirtyTabs(changes: Record<SettingGroup, Record<string, unknown>>): Set<SettingsTab>`.
- Produces (`highlight.ts`): `highlightSetting(key: string, o?: { reducedMotion?: boolean }): Promise<boolean>` — waits a tick, finds `#setting-<KEY>`, `scrollIntoView({ block: 'center', behavior })`, focuses the first input/select/button with `preventScroll`, sets `data-flash` for 2400 ms (opacity keyframes on `::after`); reduced motion → static outline until the next pointerdown/keydown; false when not found.

- [ ] **Step 1: Failing tests (unit):** `every registry group except livetv maps to exactly one tab`; `tabOf('nope') → general`; `tabOfKey('PORTAINER_API_KEY') → updates`; `tabOfKey('LIVETV_ENCODER') → livetv`; `dirtyTabs marks media when REQUESTS_URL changed`.
- [ ] **Step 2: Failing e2e:** `?setting=AUTHENTIK_API_TOKEN opens Anmeldung, the row is in view and focused, data-flash set`; `an env-locked key is highlighted the same`; `?setting=UNKNOWN opens Allgemein without error`; `#settings-recommendations opens Medien at the card`; `edits survive a tab switch and the tab shows the unsaved dot`; `?setting=LIVETV_ENCODER on /admin/livetv?tab=settings highlights it`; mobile: `tab chips scroll, no horizontal page scroll at 375 px, chips ≥ 44 px`; `the highlight animates only opacity` (computed animation property list).
- [ ] **Step 3: Run** `npx -w web vitest run src/lib/admin/settings` and `npm run e2e -- e2e/tests/admin-settings.spec.ts e2e/tests/admin-settings.mobile.spec.ts e2e/tests/admin-livetv-settings.spec.ts` → FAIL.
- [ ] **Step 4: Implement** (tab markup and keyboard handling as Live-TV's tablist: arrows, Home/End, roving tabindex).
- [ ] **Step 5: Run** the same + `admin-reco-settings.spec.ts admin-settings.plex.spec.ts` + web typecheck → PASS.
- [ ] **Step 6: Commit** `feat(admin): settings tabs and ?setting= deep links`.

### Task 11: Settings search

**Files:**
- Create: `web/src/lib/admin/settings/search.ts` (+ tests in `tabs.test.ts` or `search.test.ts`)
- Modify: `web/src/routes/admin/settings/+page.svelte` (search field + result list), locales `settings.search.*` (7 locales)
- Test: extend `e2e/tests/admin-settings.spec.ts`, `admin-settings.mobile.spec.ts`

**Interfaces:**
- Consumes: Task 10 `tabOfKey`, `settingHref` (Task 4), `keyLabel`, `keyHelp`, `enumOptions`.
- Produces: `fold(s: string): string` (lowercase, NFD, strip combining marks); `searchSettings(q: string, groups: SettingsGroupView[]): Array<{ key: string; label: string; tab: SettingsTab | 'livetv' }>` — empty for `q.trim().length < 2`; matches every word of `q` in label/key/help/option labels; label matches first, then key, stable by registry order; at most 30.

- [ ] **Step 1: Failing tests:** `"portainer" finds the five PORTAINER_* keys in Updates`; `"überg" and "uberg" find the same rows`; `a one-letter query finds nothing`; `key search "OIDC_ISS" finds OIDC_ISSUER`; e2e: `typing shows results in place of the tab panel; Enter on a result opens ?setting=KEY and clears the query`; `Esc clears and restores the tab`; `no results says so (role=status)`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** unit + e2e specs + web typecheck → PASS.
- [ ] **Step 5: Commit** `feat(admin): search over all settings`; CHANGELOG line.

**Stage 4 ship:** PR `Admin settings: tabs, search, deep links`, green CI, merge.
