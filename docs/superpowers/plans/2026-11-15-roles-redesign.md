# Rollen & Rechte Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roles read as areas (Mediathek, Live-TV, Wünsche, Gemeinsam, Downloads) and are edited one page per role with their Live-TV channel groups inline; a role may have no library, and a person without libraries gets a Live-TV-only app.

**Architecture:** Areas are a pure function of the existing effective values (`areasOf`), on both sides; switching an area stages ordinary field changes through the existing role write, which also takes the role's released channel groups (`livetvGroups`) in the same transaction. `/api/me.areas` drives one web routing rule (`areaRedirect`) and the menu filters. The matrix becomes a read-only compare view linking into the role page.

**Tech Stack:** Fastify + PostgreSQL + zod (backend), SvelteKit/Svelte (web), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-15-roles-redesign-design.md`

## Global Constraints

- Four stages, each its own PR with green CI, merged with **merge** (never rebase); stage N+1 branches from main after N merged.
- All copy in 7 locales (de, en, es, fr, it, pl, tr) with **identical key order**, German is the source; no "Netflix"/"Seerr" in user-facing text; fictional names only (Anna Beispiel; groups Nordlicht TV, Hafenkanal); placeholder hosts only (`friend.example.com`).
- UI: 44 px targets; animate only `transform`/`opacity`; nothing may jump (reserved hint/warning lines, skeletons at final size, a pressed control never moves).
- Never log secrets; logs carry codes only.
- Agents run `npm run typecheck` (or `-w backend` / `-w web`) plus the specific specs named in a task — never the full suites. No subagents inside a task.
- Backend tests: `TEST_DATABASE_URL=… npx -w backend vitest run <files> --no-file-parallelism`. Web unit: `npx -w web vitest run <files>`. E2E: `npm run e2e -- <spec files>`.
- E2E fixtures fail on unmocked API calls: every new call or answer field is added to `e2e/mocks/*.ts` in the same task. Specs that open a page whose route or controls change are updated in the same task.
- Commits end with the session's two trailer lines. Never `git stash`.

## Review Focus

1. Nobody's effective access changes on upgrade: no write on load; `areasOf` of every existing fixture role/person has Mediathek on; `/api/me.areas` all-true for existing accounts (Task 1, Task 5 tests).
2. `libraries: []` reaches both media servers as "nothing" (Jellyfin `EnableAllFolders:false, EnabledFolders:[]`; Plex `sections: []`) and never as "all" (Task 2).
3. `livetvGroups` in the role write: replaces only released-group grants, keeps unreleased ones, refuses admin/env-only/unknown/unreleased, audits names, drops the channel caches (Task 3).
4. A person without libraries can reach no library page by any path (menu, rail, tab bar, footer, deep link, TV start, welcome, kids) and never sees a library tab flash on boot (Tasks 6–8).
5. The role page can only stage coupled states (Mediathek off ⇒ Wünsche/Gemeinsam/Downloads off) and the compare view can no longer edit (Tasks 9, 11, 13).

---

## Stage 1 — Backend: areas, zero libraries, group grants on the role, templates, `/api/me.areas`

### Task 1: Areas registry

**Files:**
- Create: `backend/src/areas.ts`
- Modify: `backend/src/perms.ts` (`MatrixField.area`, `planned`; annotate every `MATRIX_FIELDS` row)
- Test: `backend/test/areas.test.ts` (new); shared fixture `test-vectors/areas.json` (new; read by the web test in Task 9)

**Interfaces:**
- Produces: `AREA_KEYS`, `AreaKey`, `Areas`, `areasOf(values: Record<string, unknown>): Areas`, `hasLibrary(libraries: unknown): boolean` (spec §2.1, §4.1). `MatrixField.area: AreaKey | 'general'`, `MatrixField.planned?: 'recordings'` (only `liveRecord`).
- Field → area exactly as spec §2.1: library = libraries, maxParentalRating, maxBitrate, remoteMaxBitrate, transcoding, maxHeight; livetv = liveTv, liveRecord (planned); requests = requests, requestsPerMonth; together = party, partySchedule, comments; downloads = download, maxDownloads, downloadMaxHeight, downloadDays; general = maxStreams, cast.

- [ ] **Step 1: Failing tests** in `areas.test.ts`:
  - `every MATRIX_FIELDS row has an area and only liveRecord is planned`.
  - `areasOf follows test-vectors/areas.json` — vectors: family defaults → all true; friend defaults → downloads false; guest defaults (comments false, party true) → together true, downloads false; `libraries: []` → library false; `libraries: ['Filme']` → true; `party:false, comments:true` → together true; `party:false, comments:false, partySchedule:true` → together false.
  - `hasLibrary('all') && hasLibrary(['Filme']) && !hasLibrary([]) && !hasLibrary(null)`.
- [ ] **Step 2: Run** `TEST_DATABASE_URL=… npx -w backend vitest run test/areas.test.ts --no-file-parallelism` → FAIL.
- [ ] **Step 3: Implement** `areas.ts` (no imports from rights.ts — pure) and the registry annotations.
- [ ] **Step 4: Run** the file + `test/rights.test.ts` + `npm run typecheck -w backend` → PASS.
- [ ] **Step 5: Commit** `feat(roles): areas registry and areasOf`.

### Task 2: Zero libraries accepted

**Files:**
- Modify: `backend/src/roleWrite.ts:42` (drop `.min(1)`), `backend/src/libraries.ts` (`knownLibraries` short-circuit)
- Test: `backend/test/roles-api.test.ts`, `backend/test/user-rights.test.ts`, `backend/test/media-hooks.test.ts` (or the Jellyfin policy test file that already covers `policyFromTemplate`), `backend/test/plex/access.test.ts`

**Interfaces:**
- Consumes: `rolePatch`, `rightsOverrides` (reuses `rolePatch.shape.libraries`).
- Produces: `PUT /api/admin/roles/:role { libraries: [] }` and `PUT /api/admin/users/:id/rights { overrides: { libraries: [] } }` → 200; `knownLibraries(ctx, [])` → `[]` with **no** `ctx.jf.admin.libraries()` call.

- [ ] **Step 1: Failing tests:**
  - roles-api: `a role may have no library: stored [], audited libraries ['Filme'] → [], policy re-applied` (`reapplied.identities` = the role's accounts).
  - roles-api: `libraries [] while the media server cannot list libraries still saves` (fake `libraries()` throws; no 502).
  - user-rights: `a person override may be no library; effectiveRights.template.libraries is []`.
  - Jellyfin policy: `policyFromTemplate({ libraries: [] }, []) → EnableAllFolders false, EnabledFolders []` and `applyPolicy with [] sends EnabledFolders []` (no folder ids).
  - Plex: `resolveAccess({ libraries: [] }) → sections [] and the SQL predicate matches no item`.
- [ ] **Step 2: Run** `TEST_DATABASE_URL=… npx -w backend vitest run test/roles-api.test.ts test/user-rights.test.ts test/media-hooks.test.ts test/plex/access.test.ts --no-file-parallelism` → FAIL (first two).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same files + backend typecheck → PASS.
- [ ] **Step 5: Commit** `feat(roles): a role or a person may have no library`.

### Task 3: Channel groups in the role write and the roles answer

**Files:**
- Modify: `backend/src/roleWrite.ts` (`rolePatch.livetvGroups`, `writeRole`, `rolesOverview`), `backend/src/livetv/groups.ts` (export `setRoleGroupsIn`, `roleGroupIds`, `releasedGroupsSummary`)
- Test: `backend/test/roles-api.test.ts`, `backend/test/livetv-rights.test.ts`

**Interfaces:**
- Produces (`groups.ts`):
  - `setRoleGroupsIn(c: pg.PoolClient, role: string, ids: readonly string[]): Promise<{ from: string[]; to: string[] } | null>` — locks released groups (`for update`), 400 `{error:'invalid', field:'livetvGroups'}` for unknown/unreleased ids, replaces the role's grants on released groups only, returns before/after **names** in group order, `null` when unchanged.
  - `roleGroupIds(ctx): Promise<Map<string, string[]>>` (released groups per role; `admin` → all released).
  - `releasedGroupsSummary(ctx): Promise<{ groups: Array<{ id: string; name: string; kidFriendly: boolean; channels: number }>; pending: number }>`.
- Produces (`roleWrite.ts`): `rolePatch.livetvGroups?: string[]` (uuid, max 500); `writeRole` runs `setRoleGroupsIn` inside its transaction and merges `{ livetvGroups }` into the `role.update` audit's `from`/`to`; 400 `admin_groups_locked` (admin), 400 `not_in_catalogue` (no row). `MatrixRole.areas`, `MatrixRole.livetvGroupIds`; `RolesOverview.matrix.livetv` (`null` when `!livetvInstalled(ctx)`); `matrix.fields[].area/planned`.

- [ ] **Step 1: Failing tests:**
  - `PUT livetvGroups sets the released groups of the role; GET shows livetvGroupIds in group order`.
  - `PUT livetvGroups keeps the role's grant on an unreleased group` (release it afterwards → the role sees it).
  - `PUT livetvGroups with an unreleased or unknown id → 400 invalid livetvGroups, nothing stored`.
  - `PUT livetvGroups on admin → 400 admin_groups_locked; on an env-only role → 400 not_in_catalogue`.
  - `the role.update audit carries livetvGroups as names (Nordlicht TV → Nordlicht TV, Hafenkanal); an unchanged set writes no entry`.
  - `a person of the role sees the new group's channels at once` (channelSet after the PUT, no 60 s wait).
  - `GET matrix.livetv is null without Live TV; with it lists released groups with channel counts and pending`.
  - `GET matrix.roles[].areas: family all true; a role with libraries [] has library false`.
- [ ] **Step 2: Run** `… vitest run test/roles-api.test.ts test/livetv-rights.test.ts …` → FAIL.
- [ ] **Step 3: Implement.** Lock order: role advisory lock, then group rows (group PATCH takes only group rows, so no cycle).
- [ ] **Step 4: Run** the files + `test/livetv-user.test.ts` + backend typecheck → PASS.
- [ ] **Step 5: Commit** `feat(roles): a role's Live-TV channel groups saved with the role`.

### Task 4: Copy keeps groups; create from a template

**Files:**
- Create: `backend/src/roleTemplates.ts`
- Modify: `backend/src/rolecat.ts` (`createRole` copies grants; new `createRoleFromTemplate`), `backend/src/routes/admin.ts` (POST body union), `backend/src/roleWrite.ts` (`matrix.templates`)
- Test: `backend/test/roles-api.test.ts`

**Interfaces:**
- Produces: `ROLE_PRESETS: Record<'family'|'friend'|'guest'|'liveOnly'|'empty', { base: 'family'|'friend'|'guest'; patch: Partial<RolePatch> }>` exactly as spec §4.4; `RoleTemplatePreset = { key; base; patch; areas }`; `matrix.templates` (liveOnly only while Live TV is installed).
- Produces: `createRoleFromTemplate(ctx, actor, label, template): Promise<string>` — inserts the catalogue row (same key derivation/retry as `createRole`), writes `role_settings` only when `patch` is non-empty (via the template/perms merge used by `writeRole`), audits `role.create { template, label }`.
- Produces: `POST /api/admin/roles` body `z.union([{ label, from }, { label, template }])` (strict); 400 `template_unavailable` for `liveOnly` without Live TV.
- `createRole(…, from)`: inside its transaction `insert into livetv_group_roles(group_id, role) select group_id, $new from livetv_group_roles where role = $from`; for `from = 'admin'` every released group; audit adds `groups: n`.

- [ ] **Step 1: Failing tests:**
  - `duplicate copies the source's channel groups, released and unreleased; audit groups 2`.
  - `duplicate of admin grants every released group`.
  - `template friend: new role with base friend, no role_settings row, every source 'default'`.
  - `template liveOnly: libraries [], download false, requests/party/partySchedule/comments/liveRecord false, liveTv true; areas = livetv only; no groups`.
  - `template empty: every area false`.
  - `template liveOnly without Live TV → 400 template_unavailable; GET matrix.templates has no liveOnly`.
  - `a body with both from and template → 400`.
- [ ] **Step 2: Run** `… vitest run test/roles-api.test.ts …` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file + `test/roles-migration.test.ts` + backend typecheck → PASS.
- [ ] **Step 5: Commit** `feat(roles): copies keep channel groups; roles from templates`.

### Task 5: `/api/me.areas` and upcoming gating

**Files:**
- Modify: `backend/src/routes/auth.ts` (`/api/me`), `backend/src/routes/discover.ts:348`
- Test: `backend/test/livetv-user.test.ts` (or the file that asserts `/api/me.features.livetv`), `backend/test/perm-enforcement.test.ts`

**Interfaces:**
- Produces: `/api/me.areas: { library; livetv; requests; together; downloads }` per spec §4.6 from `dlRole`, `perms`, `livetv`, `requestsEnabled(ctx)`, `downloads.allowed` (no new query).
- Produces: `GET /api/seerr/upcoming` → 403 `requests_forbidden` without `requests`.

- [ ] **Step 1: Failing tests:**
  - `/api/me areas: a family account → all true` and `existing fixture accounts all have library true` (loop over seeded users).
  - `/api/me areas: a liveOnly account with one granted group → { library:false, livetv:true, requests:false, together:false, downloads:false }`.
  - `/api/me areas: library [] with the role's requests on → requests false (ANDed)`.
  - `/api/me areas: kids profile → requests false, together false`.
  - `upcoming without the requests right → 403 requests_forbidden; with it → 200`.
- [ ] **Step 2: Run** `… vitest run test/livetv-user.test.ts test/perm-enforcement.test.ts …` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files + backend typecheck → PASS.
- [ ] **Step 5: Commit** `feat(me): areas flag; upcoming follows the wishes right`; CHANGELOG (Unreleased): "Roles may have no library; role writes take Live-TV channel groups; new roles from templates; `/api/me.areas`."

---

## Stage 2 — App shell for people without libraries

### Task 6: Areas on the client, routing rule, link filters

**Files:**
- Modify: `web/src/lib/capabilities.ts` (`Areas`, `ALL_AREAS`, `areasFrom`, `areas` store, `linkShown(..., a)`), `web/src/lib/gate.ts` (`areaRedirect`, `BootHint.library`), `web/src/lib/menu.ts` (`libraryTabs`), `web/src/lib/phone/logic.ts` (`phoneTabs(canDownload, live, library)`)
- Test: `web/src/lib/capabilities.test.ts`, `web/src/lib/gate.test.ts`, `web/src/lib/menu.test.ts`, `web/src/lib/phone/logic.test.ts`

**Interfaces:**
- Produces: `areasFrom(raw: unknown): Areas` (missing/non-boolean → true); `areas` writable store; `linkShown(c, href, f, p, a = ALL_AREAS)` with `AREA_NEEDS` per spec §6 (`/vote` also needs `party` in `PERM_NEEDS`); `areaRedirect(me, path, livetv): string | null` with the `LIBRARY_FREE` allowlist of spec §6; `hintOf` stores `library`, `parseHint` reads it; `libraryTabs<T>(tabs: T[], library: boolean): T[]` (keeps only `/live` and non-library entries; `/search` dropped without library).

- [ ] **Step 1: Failing tests:**
  - `areasFrom(undefined) is all true; areasFrom({ library: false }) only library false`.
  - `areaRedirect: library false + livetv → /browse/movies → /live, /item/x → /live, /settings → null, /live → null, /admin/users → null`.
  - `areaRedirect: library false, no livetv → /new → /, / → null`; `library true → always null`.
  - `linkShown hides /tonight, /lists, /stats, /downloads without library; /upcoming without requests; /party and /vote without together; /vote without party`.
  - `libraryTabs(HEADER_TABS, false) is []; liveTabs(libraryTabs(...), LIVE_HEADER, true) is [/live]`; `libraryTabs(TV_RAIL, false)` keeps nothing.
  - `phoneTabs(false, true, false) → [live]`.
  - `hintOf keeps library false; parseHint of an old hint → library true`.
- [ ] **Step 2: Run** `npx -w web vitest run src/lib/capabilities.test.ts src/lib/gate.test.ts src/lib/menu.test.ts src/lib/phone/logic.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same + `npm run typecheck -w web` → PASS.
- [ ] **Step 5: Commit** `feat(shell): areas, library-free routing rule and link filters`.

### Task 7: Shell wiring (layout, bars, rail, footer, /me, TV start, welcome)

**Files:**
- Modify: `web/src/routes/+layout.svelte` (set `areas` from `/api/me`; call `areaRedirect` before `kidsRedirect` at boot and in the reactive guard; `tvRail` via `libraryTabs`; chips only with library), `web/src/lib/desk/DeskBar.svelte`, `web/src/lib/phone/TabBar.svelte`, `web/src/lib/tv/TvRail.svelte` (if it filters itself), `web/src/lib/Footer.svelte`, `web/src/routes/me/+page.svelte`, `web/src/routes/tv/+page.svelte` (`areas.library === false` → `/live?play=last`), `web/src/routes/welcome/+page.svelte` (skip the titles step without library)
- Modify (mocks): `e2e/mocks/api.ts` (`st.areas` knob merged into `/api/me`)
- Test: `e2e/tests/live-only.spec.ts`, `e2e/tests/live-only.mobile.spec.ts` (new)

**Interfaces:**
- Consumes: Task 6; `/api/me.areas` (Task 5).
- Mock: `api.areas = { library: false, …}` plus `api.features = { livetv: true }` and the existing Live TV mocks (`mocks/livetv.ts`).

- [ ] **Step 1: Failing e2e** (`live-only.spec.ts`, Anna Beispiel, groups Nordlicht TV, Hafenkanal):
  - `desktop bar shows only Live; account menu shows no library entries; footer has no library links`.
  - `/ opens /live; deep links /browse/movies, /item/<id>, /watchlist, /party land on /live (replace, Back does not return)`.
  - `boot with a hint library:false never renders the Start tab` (assert tab count 0 before `/api/me` resolves, mock delays `/api/me`).
  - `TV: /tv goes to /live?play=last; the rail shows Live only`.
  - `kids profile without library opens /live, not /kids; with no channel either it stays on / with the empty state (no redirect loop)`.
  - `welcome without library has 2 steps`.
  - mobile: `tab bar shows only Live; no category chips`.
- [ ] **Step 2: Run** `npm run e2e -- e2e/tests/live-only.spec.ts e2e/tests/live-only.mobile.spec.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the two + `e2e/tests/shell.spec.ts e2e/tests/phone-shell.mobile.spec.ts e2e/tests/live-tab.spec.ts e2e/tests/live-kids.spec.ts e2e/tests/perms-hidden.spec.ts` + web typecheck → PASS.
- [ ] **Step 5: Commit** `feat(shell): a person without libraries sees only Live TV`.

### Task 8: Empty start state; zero libraries in the editors

**Files:**
- Create: `web/src/lib/home/NoAccess.svelte`
- Modify: `web/src/routes/+page.svelte` (render `NoAccess` when `!areas.library && !features.livetv`, before any library request), `web/src/lib/admin/rights/FieldControl.svelte` (last box may go; reserved line shows `libsNoneHint` when none), `web/src/lib/admin/rights/model.ts` (`cellText` → `libsNone` for `[]`), `web/src/lib/admin/user/Rights.svelte` (`libsNoneLine`), i18n `home.ts`, `adminPeople.ts` × 7 (`libsMin` replaced by `libsNone`, `libsNoneHint`; `rights.libsNoneLine`; `home.noAccess.*`)
- Modify (e2e): `e2e/tests/admin-roles.spec.ts` (the test "libraries: the last ticked one cannot be unticked" becomes "libraries: none may be ticked; the hint says Live-TV only")
- Test: `web/src/lib/admin/rights/model.test.ts`, `e2e/tests/live-only.spec.ts`, `e2e/tests/admin-user-detail.spec.ts`

- [ ] **Step 1: Failing tests:**
  - unit `cellText(libraries, []) is "Keine Bibliothek"`.
  - e2e `no library and no channel: the start page says Für dich ist noch nichts freigegeben and calls no /api/library endpoint` (the fixture's unmocked check catches calls).
  - e2e admin-roles `untick every library: PUT body libraries [], review line "1 Bibliothek → Keine Bibliothek"`; the hint line keeps its height (bounding box equal before/after).
  - e2e user detail `override libraries none shows the Live-TV-only line`.
- [ ] **Step 2: Run** `npx -w web vitest run src/lib/admin/rights/model.test.ts src/lib/i18n` and `npm run e2e -- e2e/tests/live-only.spec.ts e2e/tests/admin-roles.spec.ts e2e/tests/admin-user-detail.spec.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same + web typecheck → PASS.
- [ ] **Step 5: Commit** `feat(roles): no library selectable; empty start state`; CHANGELOG line.

---

## Stage 3 — Role list and role page

### Task 9: Web areas model and staging

**Files:**
- Create: `web/src/lib/admin/rights/areas.ts`
- Modify: `web/src/lib/admin/rights/model.ts` (types: `MatrixField.area/planned`, `MatrixRole.areas/livetvGroupIds`, `RoleMatrix.livetv/templates`; `visibleFields` drops `planned`; `stageBodies` passes `livetvGroups`; `reviewLines` adds the groups line; `stageSet` loaded value for `livetvGroups` = `livetvGroupIds`)
- Test: `web/src/lib/admin/rights/areas.test.ts` (new; reads `test-vectors/areas.json`), `web/src/lib/admin/rights/model.test.ts`

**Interfaces:**
- Produces: `areasOf(values)` (same vectors as the backend), `stagedAreas(stage, role)`, `stageArea(stage, matrix, role, area, on): Stage` per spec §2.3 (coupling, restore-on-reenable by unstaging), `areaDisabled(role, area, staged): 'needsLibrary' | 'admin' | null`, `areaSummary(areas, features): string` ("Mediathek · Live-TV · Wünsche" / "Nur Live-TV" / "Nichts freigegeben"), `fieldsOfArea(matrix, area)`.

- [ ] **Step 1: Failing tests:**
  - `areasOf matches test-vectors/areas.json`.
  - `stageArea library off stages libraries [], requests/party/partySchedule/comments/download false`.
  - `stageArea library on again in the same session unstages everything it staged`.
  - `stageArea library on for a role saved with [] stages defaults.libraries or 'all'`.
  - `together on stages party and comments true, leaves partySchedule`.
  - `areaDisabled(requests) is needsLibrary while library is staged off; admin areas are 'admin'`.
  - `stageBodies carries livetvGroups; reviewLines shows "Live-TV-Gruppen: Nordlicht TV → Nordlicht TV, Hafenkanal"`.
  - `visibleFields never lists liveRecord`.
  - `areaSummary: only livetv → "Nur Live-TV"; none → "Nichts freigegeben"; requests hidden without the request feature`.
- [ ] **Step 2: Run** `npx -w web vitest run src/lib/admin/rights/areas.test.ts src/lib/admin/rights/model.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same + web typecheck → PASS.
- [ ] **Step 5: Commit** `feat(roles): areas and their staging on the web`.

### Task 10: Role list page

**Files:**
- Create: `web/src/lib/admin/rights/RoleList.svelte`
- Modify: `web/src/routes/admin/roles/+page.svelte` (list as the *Rollen* view at every width; *Vergleichen* = `?view=compare` showing today's `RoleMatrix` ≥ 900 px / `CompareView` below, still editable in this stage; *+ Neue Rolle* opens today's `NameDialog` copy flow with a role select until Task 14), i18n `adminPeople.ts` × 7 (`summary.*`, `page.*`, `compare.title`)
- Modify (mocks): `e2e/mocks/admin.ts` (`/api/admin/roles` GET adds `areas`, `livetvGroupIds`, `matrix.livetv`, `matrix.templates`, `fields[].area/planned`)
- Test: `e2e/tests/admin-roles.spec.ts`, `e2e/tests/admin-roles.mobile.spec.ts`

**Interfaces:**
- Consumes: Task 9 (`areaSummary`), existing `moveRole`, `removeRole`, `duplicate`, `RoleHistory`.
- Row: link to `/admin/roles/<key>`; people link `/admin/users?role=<key>`; ⋯ `ActionMenu` (*Bearbeiten, Duplizieren, Nach oben, Nach unten, Verlauf, Löschen*).

- [ ] **Step 1: Failing e2e** (move the matrix tests under `test.describe('compare', …)` with `page.goto('/admin/roles?view=compare')`; they keep passing unchanged otherwise):
  - `the list shows each role with its area summary and people link; a role with Live-TV and no group shows the warning`.
  - `Nach unten moves the row by transform (no snap) and sends PUT /order`.
  - `the people link opens Personen filtered by the role`.
  - `?view=compare opens the matrix; the segmented control switches without reload`.
  - mobile: `rows are ≥ 64 px, the ⋯ button is 44 px and outside the row link`.
- [ ] **Step 2: Run** `npm run e2e -- e2e/tests/admin-roles.spec.ts e2e/tests/admin-roles.mobile.spec.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same + `e2e/tests/admin-livetv-groups.spec.ts` (it opens `/admin/roles`; point it at `?view=compare`) + web typecheck → PASS.
- [ ] **Step 5: Commit** `feat(roles): role list with area summaries`.

### Task 11: Role page with area switches and inline channel groups

**Files:**
- Create: `web/src/routes/admin/roles/[key]/+page.svelte`, `web/src/lib/admin/rights/AreaGrid.svelte`, `web/src/lib/admin/rights/AreaSection.svelte`, `web/src/lib/admin/rights/GroupChips.svelte`
- Modify: `web/src/lib/admin/rights/model.ts` (helpers shared with the list page: the sequential `run()` save moved to `web/src/lib/admin/rights/save.ts` so both pages use it), i18n `adminPeople.ts` × 7 (`areas.*`, `groups.*`)
- Modify (mocks): `e2e/mocks/admin.ts` (`PUT /api/admin/roles/:role` accepts `livetvGroups`: updates the mock groups' `roles`, 400 for admin; logs the body)
- Test: `e2e/tests/admin-role-page.spec.ts`, `e2e/tests/admin-role-page.mobile.spec.ts` (new)

**Interfaces:**
- Consumes: Tasks 3, 9; `FieldControl`, `SaveBar`, `ReviewSheet`, `leaveGuard`, `RoleHistory`, `DeleteRoleDialog`, `NameDialog`.
- `?field=<key>` focuses that control (spec §13).

- [ ] **Step 1: Failing e2e:**
  - `Freund: switching Mediathek off disables Wünsche, Gemeinsam, Downloads with "Braucht die Mediathek"; review lists the six changes; save sends one PUT with libraries [] and the three perms false and download false`.
  - `Mediathek off then on before saving leaves nothing staged (save bar gone)`.
  - `Live-TV groups: tick Hafenkanal → review "Live-TV-Gruppen: Nordlicht TV → Nordlicht TV, Hafenkanal" → PUT body livetvGroups [ids]`.
  - `no group chosen: the reserved warning line appears without moving the chips (bounding boxes equal)`.
  - `Live-TV off: chips dimmed and disabled, still listed`.
  - `admin page: area switches locked with "Admins dürfen immer alles"; groups read "Alle freigegebenen Gruppen"`.
  - `env-only role: name and groups locked with "Steht in der .env"`.
  - `a value from .env says "aus .env"; a role-set value says "geändert (Standard: …)"`.
  - `pressing an area switch never moves it` (bounding box before/after).
  - `leaving with staged changes asks first`; `a 502 policy_partial offers Erneut anwenden`.
  - `/admin/roles/unknown shows the missing state with a link back`.
  - `?field=maxStreams focuses that field`.
  - mobile: `one column of area cards, every toggle ≥ 44 px, the save bar does not cover the last section`.
- [ ] **Step 2: Run** `npm run e2e -- e2e/tests/admin-role-page.spec.ts e2e/tests/admin-role-page.mobile.spec.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same + `e2e/tests/admin-roles.spec.ts` + `npx -w web vitest run src/lib/admin/rights src/lib/i18n` + web typecheck → PASS.
- [ ] **Step 5: Commit** `feat(roles): one page per role with areas and channel groups`; CHANGELOG line.

---

## Stage 4 — Compare view, templates UI, cleanup

### Task 12: Compare view read-only

**Files:**
- Modify: `web/src/lib/admin/rights/RoleMatrix.svelte` (no `CellPopover`, no drag, no column menus; *Bereiche* row group on top; rows grouped by `area`; cells and heads are links to `/admin/roles/<key>?field=<f>`; keep `gridKeys` reading navigation, Enter follows the link), `web/src/lib/admin/rights/CompareView.svelte` (read-only rows with *Bearbeiten* links), `web/src/routes/admin/roles/+page.svelte` (compare view without stage/save bar)
- Delete: `web/src/lib/admin/rights/CellPopover.svelte`
- Test: `e2e/tests/admin-roles.spec.ts`, `e2e/tests/admin-roles.mobile.spec.ts` (the old edit-in-matrix tests are rewritten as role-page tests in Task 11's spec or removed when the role page already covers them; list each removed test name in the commit body)

- [ ] **Step 1: Failing e2e:**
  - `compare: Enter on a cell opens the role page with that field focused`.
  - `compare: the Bereiche rows show ✓/– per role; Darf aufnehmen is not listed`.
  - `compare: no save bar, no drag grip, no popover` (counts 0).
  - `grid keyboard still moves between cells`.
  - mobile `Vergleich rows link to the role page`.
- [ ] **Step 2: Run** `npm run e2e -- e2e/tests/admin-roles.spec.ts e2e/tests/admin-roles.mobile.spec.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same + `npx -w web vitest run src/lib/admin/rights` + web typecheck → PASS.
- [ ] **Step 5: Commit** `feat(roles): read-only compare view linking into the role page`.

### Task 13: New role dialog with templates

**Files:**
- Create: `web/src/lib/admin/rights/NewRoleDialog.svelte`
- Modify: `web/src/routes/admin/roles/+page.svelte`, `web/src/routes/admin/roles/[key]/+page.svelte` (*Duplizieren* opens it with *Kopie von* preselected), i18n `adminPeople.ts` × 7 (`new.*`)
- Modify (mocks): `e2e/mocks/admin.ts` (`POST /api/admin/roles` with `template`: builds the role from `matrix.templates`, copies the source's mock group roles on `from`)
- Test: `e2e/tests/admin-roles.spec.ts`, `e2e/tests/admin-roles.mobile.spec.ts`

- [ ] **Step 1: Failing e2e:**
  - `Neue Rolle "Nur Live-TV" named Hafenblick: POST { label, template: 'liveOnly' }, opens /admin/roles/hafenblick with only Live-TV on and the no-group warning`.
  - `Leer: every area off`.
  - `Kopie von Familie keeps Familie's groups` (role page shows the same chips ticked).
  - `without Live TV the Nur Live-TV option is absent`.
  - `each option is ≥ 56 px; the dialog's height does not change when the copy select appears` (select row reserved).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the specs + web typecheck → PASS.
- [ ] **Step 5: Commit** `feat(roles): new roles from templates`.

### Task 14: Cleanup — old editors, GroupMatrix, liveRecord hidden

**Files:**
- Delete: `web/src/lib/admin/rights/RoleSheet.svelte`, `web/src/lib/admin/rights/RoleCards.svelte`, `web/src/lib/admin/livetv/GroupMatrix.svelte`
- Modify: `web/src/lib/admin/livetv/GroupsTab.svelte` (*Nach Rolle* → *Personen*: the exceptions list + the "Rollen & Rechte" line and link), i18n `adminLive.ts` × 7 (`grp.viewPeople`, `grp.rolesMoved`; remove keys only used by GroupMatrix in the same position in all 7), `web/src/lib/admin/rights/model.ts` (drop `livetvGroups` names fallback once the backend sends ids — backend keeps sending names for one release), `docs/superpowers/specs/2026-11-11-users-permissions-design.md` and `2026-11-11-live-tv-design.md` (one "superseded by 2026-11-15-roles-redesign" note each at §6.1 / §9.3), `CHANGELOG.md`
- Test: `e2e/tests/admin-livetv-groups.spec.ts`, `e2e/tests/admin-livetv-groups.mobile.spec.ts`, `web/src/lib/i18n` tests

- [ ] **Step 1: Failing e2e:** `Gruppen & Rechte: the Personen view lists exceptions and links to Rollen & Rechte; no role × group switches`; the list view's per-group role chips still write (existing test stays).
- [ ] **Step 2: Run** `npm run e2e -- e2e/tests/admin-livetv-groups.spec.ts e2e/tests/admin-livetv-groups.mobile.spec.ts` → FAIL.
- [ ] **Step 3: Implement**; `grep -rn "RoleSheet\|RoleCards\|GroupMatrix\|CellPopover" web/src e2e` returns nothing.
- [ ] **Step 4: Run** the specs + `e2e/tests/admin-roles.spec.ts e2e/tests/admin-role-page.spec.ts` + `npx -w web vitest run src/lib/i18n src/lib/admin` + `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `chore(roles): remove the matrix editors and the role × group matrix`.
