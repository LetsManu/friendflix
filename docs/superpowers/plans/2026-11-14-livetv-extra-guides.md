# Live TV extra guides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extra programme guides (XMLTV links now, files and hand pins in later stages) as their own *Quellen*, with a "Gilt für" scope, filling channels that today have no programme.

**Architecture:** A new `livetv_sources.kind = 'guide'` reuses the per-source EPG import (`refreshEpg`, staging + swap), the `livetv_epg_channels` index and `livetv_programmes` (all keyed by `source_id`). Matching runs today's `matchChannel` unchanged first; a second, fill-only pass uses guide sources in `position` order, filtered by scope.

**Tech Stack:** Fastify + PostgreSQL (backend), Node livetv container (XMLTV parsing), SvelteKit/Svelte 5 (web), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-livetv-extra-guides-design.md` (and Phase 1 spec §6.1, §9.1, §9.4).

## Global Constraints

- Ship in three independently deployable stages; each stage is its own PR, green CI, merge (method merge).
- Parsing XML only in livetv; links pass livetv's address guard; guide links stored encrypted, shown as `epgHint` only.
- One new migration per stage at most, appended at the next free index at merge time, rerunnable (`if not exists`, `drop … if exists`).
- No secrets/URLs in logs or answers; placeholder hosts only (`iptv.example.com`, `192.0.2.x`); fictional names (Nordlicht TV, Hafenkanal, Sternwarte 24).
- All copy in 7 locales (de, en, es, fr, it, pl, tr) with identical key order; never "Netflix"/"Seerr" in UI text.
- UI: 44 px targets, animate only transform/opacity, nothing jumps (reserve heights); every request through `api()`.
- Never change what today's matching gives a channel: guides fill only channels left without a match.
- Commits end with the session's two trailer lines.

## Review Focus

1. A guide whose scope lists a source that is then deleted: scope shrinks; empty → guide disabled, card says "Gilt für keine Quelle mehr" (Task 1 test).
2. A channel matched today by a list's guide (own or pooled other lists) keeps exactly that match after a guide that also knows it is added (Task 2 test).
3. A disabled guide: not refreshed, not in the matching index, now/next not served from it (Task 2 test).
4. An empty `guideScope: []` in create/patch is refused 400 `invalid`, field `guideScope` (Task 1 test).
5. Two guides both knowing an unmatched channel: the one with the lower `position` wins; reordering flips it on the next pass (Task 2 test).

---

## Stage 1 — link guides, scope, fill-only matching, admin UI

### Task 1: Backend — guide sources (data, API, refresh)

**Files:**
- Modify: `backend/src/db.ts` (append migration: `kind` check gains `'guide'`; columns `guide_provider text check (guide_provider in ('xmltv_url','xmltv_file'))`, `guide_scope uuid[]`, `guide_file text`; drop/re-add the kind check by name, rerunnable)
- Modify: `backend/src/livetv/sources.ts` (SourceRow/SourceView, zod create/patch, create/update/delete, toView)
- Modify: `backend/src/livetv/refresh.ts` (tick: guides with a link refresh their EPG like a list's guide; `refreshSource` never runs list import for guides)
- Modify: `backend/src/livetv/epg.ts` (`refreshEpg` accepts a guide source; `indexRows` includes enabled guides)
- Modify: admin routes for sources (where `sourceCreate`/`sourcePatch` are used) and the admin overview count
- Test: `backend/test/livetv-guides.test.ts` (new), extend `backend/test/livetv-migration.test.ts`

**Interfaces:**
- Produces (API, `GET/POST /api/admin/livetv/sources`, `PATCH/DELETE …/:id`, `POST …/:id/refresh`, `POST …/sources/test`):
  - create body for a guide: `{ kind: 'guide', name: string, epgUrl: string, userAgent?: string|null, allowLan?: boolean, refresh?: Refresh, epgShiftMin?: number, guideScope: string[] | null, enabled?: boolean }` (list bodies unchanged; `kind` defaults to `'m3u'`).
  - `SourceView` gains `kind: 'm3u' | 'feeds' | 'guide'`, `guideProvider: 'xmltv_url' | 'xmltv_file' | null`, `guideScope: string[] | null`, `servedChannels: number` (channels currently matched to this source as `epg_source_id`).
  - `PATCH` accepts `guideScope`, `epgUrl`, `name`, `refresh`, `epgShiftMin`, `enabled`, `position`.
  - `POST …/sources/test` with `{ kind: 'guide', epgUrl, … }` answers `{ epgChannels: number, samples: string[] /* ≤ 8 display names */ }`.
  - Refusals: `guideScope: []` → 400 `{ error: 'invalid', field: 'guideScope' }`; a scope id that is not a list or the own-feeds source → 400 `invalid` `guideScope`.
- Produces (backend): `isGuide(kind: string): boolean` in `sources.ts`; `deleteSource` removes the id from every `guide_scope` and disables guides whose scope becomes empty; deleting a guide resets channels with `epg_source_id = id` to `epg_match = 'auto'`, `epg_source_id/epg_channel_id = null`.

- [ ] **Step 1: Write failing tests** in `livetv-guides.test.ts`: `creates a link guide and lists it with kind guide and its scope`; `refuses an empty guideScope`; `refuses a scope id of a guide`; `deleting a scoped list shrinks the scope; an empty scope disables the guide`; `deleting a guide resets its channels to auto`; `the refresh tick imports a due link guide's XMLTV (fakeHttp xmltv) and never runs the list import for it`; `a disabled guide is skipped by the tick`.
- [ ] **Step 2: Run** `TEST_DATABASE_URL=… npx -w backend vitest run test/livetv-guides.test.ts --no-file-parallelism` → FAIL.
- [ ] **Step 3: Implement** migration + sources/refresh/epg changes; reuse the existing encryption, `checkUrl(…, 'epgUrl')`, `epgChannels()` for test, and `refreshEpg` for the import.
- [ ] **Step 4: Run** the new file plus `livetv-sources`, `livetv-epg`, `livetv-import`, `livetv-migration` → PASS.
- [ ] **Step 5: Commit** `feat(livetv): guide sources (XMLTV links) with a scope`.

### Task 2: Backend — fill-only matching across guides

**Files:**
- Modify: `backend/src/livetv/epg.ts` (`matchIds`, a new `matchGuides`, `filterIds`)
- Test: extend `backend/test/livetv-epg.test.ts` (or `livetv-guides.test.ts`)

**Interfaces:**
- Consumes: Task 1 columns and `isGuide`.
- Produces: `export function matchGuides(ch: MatchInput, guides: ReadonlyArray<{ sourceId: string; scope: readonly string[] | null; index: EpgSourceIndex }>): { sourceId: string; xmlId: string; pass: 1|2|3|4 } | null` — the four `PASSES` in order; per pass, guides in the given (position) order, skipping a guide whose scope is not null and does not contain `ch.sourceId`; the first guide with any hit decides (one hit → match, several → next pass).
- `matchIds`: builds the list index from provider lists only (as today) and runs `matchChannel`; only when it returns null runs `matchGuides` over enabled guides ordered by `position`. `filterIds(ctx, sourceId)` for a guide collects candidate ids only from channels in its scope that are unmatched by lists (plus its manual pins).

- [ ] **Step 1: Failing tests:** `a guide fills a channel no list guide matches`; `a channel matched by its own list's guide keeps that match when a guide also knows it`; `a channel matched by another list's pooled guide keeps that match`; `a guide outside a channel's scope is never used`; `the lower position guide wins; after reordering the other one wins on the next pass`; `a disabled guide is not used and now/next ignores it`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** as in Interfaces; keep `matchChannel` untouched.
- [ ] **Step 4: Run** `livetv-epg`, `livetv-guides`, `livetv-channels-admin` → PASS; matching of 20 000 channels × 3 guides stays within the existing perf test budget if one exists.
- [ ] **Step 5: Commit** `feat(livetv): extra guides fill channels without a match`.

### Task 3: Web — Programmführer in Quellen

**Files:**
- Modify: `web/src/lib/admin/livetv/{api.ts,sources.ts,SourcesTab.svelte,SourceSheet.svelte}`; create `GuideCard.svelte`
- Modify: locales `web/src/lib/i18n/locales/*/adminLive.ts` (new keys under `src.guide.*`)
- Modify: `e2e/mocks/admin.ts` (guide sources in the Live-TV mock)
- Test: `web/src/lib/admin/livetv/sources.test.ts` (unit), `e2e/tests/admin-livetv-guides.spec.ts` (+ `.mobile.spec.ts`)

**Interfaces:**
- Consumes: Task 1 API exactly.
- UI: the add sheet's *Art der Quelle* gets a third option **Programmführer** (`kindGuide`); fields: Name, *Programmführer (XMLTV-Adresse)*, Aktualisieren (interval), Zeitversatz, **Gilt für** (radio *Alle Sender* / *Nur diese Quellen* + checklist of lists and *Eigene Streams*; at least one when chosen), *Prüfen* (shows "{n} Sender im Programmführer" and up to 8 names), *Speichern*. Guide cards list after the lists, before *Eigene Streams*, showing name, link hint, *Gilt für* summary ("Alle Sender" / "Nordlicht Paket, Eigene Streams"), last import ("Programm: {n} Sendungen"), "versorgt {n} Sender", and the existing refresh/edit/delete/enable actions; order among guides with up/down buttons (PATCH `position`). Disabled-by-empty-scope shows "Gilt für keine Quelle mehr".

- [ ] **Step 1: Failing tests:** unit `guideScopeLabel` (all / named / none); e2e `add a guide: Prüfen then Speichern sends kind guide and its scope`, `Gilt für Nur diese Quellen needs one checked`, `the guide card shows its scope and served channels`, `moving a guide up sends its new position`; mobile: sheet fits 375 px.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** vitest admin + i18n, root typecheck, e2e specs above + `admin-livetv-sources` → PASS.
- [ ] **Step 5: Commit** `feat(admin): Programmführer sources in Live-TV Quellen`.

**Stage 1 ship:** PR `Live TV: extra programme guides (links)`, green CI, merge; nightly deploys it.

## Stage 2 — uploaded XMLTV files

### Task 4: livetv `POST /v1/parse/xmltv`
- Files: `livetv/src/routes/fetch.ts` (or a new `parse.ts`), tests in `livetv/test/fetch-routes.test.ts`.
- Produces: signed route, body = the file (raw `.xml` or gzip, detected by magic bytes), `maxBody = XMLTV_MAX_BYTES`, same NDJSON lines and `channels`/`from`/`to` filter query as `/v1/fetch/xmltv`.
- Tests: `parses a posted guide`, `a gzip body is inflated`, `a body over the cap answers 413`, `NUL and limits behave as /v1/fetch/xmltv`.

### Task 5: Backend file guides
- Files: `backend/src/livetv/guidefiles.ts` (new), `sources.ts`, `epg.ts`, admin route `PUT /api/admin/livetv/sources/:id/file`.
- Produces: upload streamed to `<data>/livetv-guides/<id>.pending.xml[.gz]` (≤ 300 MB, admin + CSRF, 413 `too_large`, 409 `import_running` under the import lock); import posts it to `/v1/parse/xmltv`; success renames to `<id>.xml[.gz]`, failure keeps the old file + programmes and records the error; index re-runs on SHA-256 change; tick skips file guides; *Jetzt aktualisieren* re-imports the stored file; delete removes files. View adds `fileName`, `fileBytes`.
- Tests: one per sentence above.

### Task 6: Web file option
- The guide sheet gets *Link* / *Datei*; file picker (`.xml`, `.xml.gz`), upload through `api()` raw Blob with progress, then the card shows file name + size; 413/409 copy.
- Tests: e2e upload, too big, running.

## Stage 3 — hand pins

### Task 7: Backend pin routes
- `PUT /api/admin/livetv/channels/:id/epg` `{ sourceId, xmlId } | { none: true } | null`; `GET /api/admin/livetv/epg/channels?source=<id>&q=` (≤ 50, name search over the guide's index, enabled guides and lists with a guide).
- Tests: pin sets `manual`; `none`; `null` back to auto and re-matched; pin to a disabled guide stays and the view says `guideDisabled: true`.

### Task 8: Web *Programm zuordnen…*
- Channel row menu item opens a sheet: guide picker, search, result list, *Automatisch*, *Kein Programm*; the EPG column shows the pinned guide's name.
- Tests: e2e pin, back to automatic, none.
