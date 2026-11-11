# Users & Permissions Remodel (Live TV Phase 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roles become editable rows with a permission registry, every template field and switch can be overridden per person, kids profiles are managed by admins, and Admin → *Personen* / *Rollen & Rechte* show at a glance what each role and person may do — without changing anyone's effective rights on upgrade.

**Architecture:** Migration 47 adds the `roles` catalogue, JSON `template`/`perms` on `role_settings`, the missing override columns on `user_limits` and audit indexes. One resolver, `effectiveRights()` in `backend/src/rights.ts`, layers code default ← `ROLE_TEMPLATES` ← role row ← user override ← kids overlay and reports the source of every field; `effectiveLimits()` becomes a thin wrapper so its ~20 callers and the gateway authz keep working. The web gets a staged role matrix (desktop) / role cards (phone), a *Rechte* tab, *Sicht prüfen* and kids-profile admin, all on the existing glass admin components.

**Tech Stack:** Fastify + Zod + PostgreSQL (inline migrations) + Redis-backed KV (backend), SvelteKit with Svelte 4 component syntax on the Svelte 5 compiler, TypeScript strict, Vitest, Playwright (Chromium, mocked API).

**Spec:** `docs/superpowers/specs/2026-11-11-users-permissions-design.md` ("spec §n"). Live TV context: `docs/superpowers/specs/2026-11-11-live-tv-design.md` §8 (only the `liveTv` / `liveRecord` registry entries are built here).

**Execution:** subagent-driven (chosen by the owner). **Base:** `main` after PR 1 of `docs/superpowers/plans/2026-11-11-device-handoff.md` is merged — that PR appends migration 46. Task 1 checks `MIGRATIONS.length === 46` before appending 47; if the hand-off migration is not on the base yet, stop and rebase, never add a placeholder.

### Rulings on the spec (made here, apply to every task)

1. **Library counts of *Sicht prüfen* (spec §6.4 item 2) have no endpoint in spec §4.** Added: `GET /api/admin/users/:id/check?profile=<pid>` → `{ libraries: Array<{ id, name, visible: boolean, seen: number | null, total: number }> }` (cached 10 min per profile), audited `user.check_viewed` with `{ profile, libraries: n }`. The title search stays `POST …/check` as specified.
2. **`null` means "inherit" in the new role and rights bodies (spec §4.1), but the shipped roles page sends `maxHeight: null` and `requestsPerMonth: null` for "unlimited".** New encodings: `maxHeight`, `maxParentalRating`, `requestsPerMonth` accept the literal `"unlimited"`; `null` = inherit. Task 3 changes the two lines of the old roles page that send `null` for "unlimited", so the app stays correct between PR 0a and PR 0b. Because `role_settings.requests_per_month` cannot tell "inherit" from "unlimited" (null already means unlimited), `requestsPerMonth: null` writes the code default `defaultLimit(base)`.
3. **The matrix needs to know which optional features exist** (spec §6.1 "Rows hidden when their feature is absent") but the §4.1 shape has no such field. Added: `matrix.features: { requests: boolean; cast: boolean; livetv: boolean }`. `livetv` is `false` in every Phase 0 build (Live TV detection ships with Live TV Phase 1b), so the *Live-TV* group never shows yet.
4. **Role key `order` is reserved** (it would be shadowed by `PUT /api/admin/roles/order`): `slugKey` skips it; an env role named `order` is skipped by `syncRoles` with one warning line.
5. **Client hiding of denied features** (cast button, party entries, wishes UI, comment section) is not listed in spec §10's phase split; it ships in PR 0a with the server enforcement (Task 7), so no PR shows buttons that answer 403.

### Pull requests and order

| PR | Task | Implementer | Depends on |
| --- | --- | --- | --- |
| **0a** backend | 1 Migration 47, role catalogue, `syncRoles`, `roleExists` | **Opus** · backend (migration) | hand-off PR 1 merged |
| 0a | 2 Permission registry and `effectiveRights` | **Opus** · backend (permission core) | 1 |
| 0a | 3 `GET /api/admin/roles` matrix, `PUT /api/admin/roles/:role` | **Opus** · backend (policy re-apply, admin lock) | 2 |
| 0a | 4 Role create (duplicate), delete with move, order | Sonnet · backend | 3 |
| 0a | 5 Per-user rights API (`/rights`, legacy `/limits` alias) | **Opus** · backend (overrides, policies) | 2 |
| 0a | 6 Enforcement of the switches + `/api/me.perms` | **Opus** · backend (security) | 2 |
| 0a | 7 Web: hide denied features, 403 texts | Sonnet · frontend | 6 |
| 0a | 8 Invites/approvals any invitable role, `pending.approvals` | Sonnet · backend | 1 |
| 0a | 9 Users list filters, columns, bulk `perm` / `repair` | Sonnet · backend | 5 |
| 0a | 10 Admin kids profiles (switch, cap, create, delete) | **Opus** · backend (parental controls) | 2 |
| 0a | 11 "Can this profile see it?" (`/check`, `findItems` seam) | **Opus** · backend (admin key, privacy) | 2 |
| 0a | 12 Audit filters, `area=people`, docs + CHANGELOG | Sonnet · backend + docs | 3–11 |
| **0b** Rollen & Rechte | 13 Web rights model (types, formatting, staging) | Sonnet · frontend | PR 0a merged |
| 0b | 14 Role matrix (desktop grid), save bar, review sheet | **Opus** · frontend (grid a11y, staging, partial failure) | 13 |
| 0b | 15 Role sheet, role menu: duplicate, rename, delete, order, history | Sonnet · frontend | 14 |
| 0b | 16 Phone role cards, *Vergleich*, nav label, settings note | Sonnet · frontend | 15 |
| **0c** Personen | 17 Users page: summary strip, filter chips, columns, bulk | Sonnet · frontend | PR 0b merged |
| 0c | 18 Shared `RolePicker` in invites and approvals | Sonnet · frontend | 17 |
| 0c | 19 Detail *Rechte* tab (replaces *Grenzen*) | Sonnet · frontend | 17 |
| 0c | 20 Detail *Profile* tab: kids admin | Sonnet · frontend | 19 |
| 0c | 21 *Sicht prüfen* tab + privacy sentence | Sonnet · frontend | 19 |
| 0c | 22 Audit page area/target filters, *Verlauf* sentences | Sonnet · frontend | 17 |

Tasks per PR: **0a: 12, 0b: 4, 0c: 6.** Within a PR follow the order. Each PR leaves the app working. The follow-up "drop old `role_settings` columns and legacy endpoints" (spec §5 step 5) is the next release's own plan, not this one.

## Global Constraints

- **Svelte:** Svelte 4 syntax on the Svelte 5 compiler (`export let`, `$:`, `on:event`, slots, stores); no runes.
- **Styling:** plain CSS with the glass `.frost*` classes (`.panel`, `.frost`, `.frost-flat`, `.frost-safe`, `.frost-sheet`, `.frost-dim`, `.frost-pill`) and `--fr-*` tokens (`--fr-sel`, `--fr-r-*`, `--fr-solid`) from `web/src/app.css`; the existing admin components (`#lib/adminContent/AdminCard.svelte`, `#lib/ui/{DataTable,StatusPill,StatTile,Toggle,Select,Field,Button,ActionMenu}.svelte`, `#lib/glass/SlidePill.svelte`, `confirm`, `runAction` toasts with undo). No new visual language, no new blur rule.
- **Motion:** animate only `transform` and `opacity`; nothing may jump (space is reserved first — `--savebar-h`, inline error rows, override hints — or the element overlays). Opening and closing both animate (`growBoth`, `sheetSlide`, `barRise`, `scrimFade` from `#lib/glass/fx`). Calm mode / reduced motion (`html.m-still`, `fxMode() === 'still'`): durations 0, solid panels (`--fr-solid`). `web/src/lib/admin/glass.test.ts` scans every `.svelte`/`.css` under `web/src` and must stay green.
- **Copy:** German UI copy primary plus all locales (de, en, es, fr, it, pl, tr) with key order as the files have it (`web/src/lib/i18n/locales/<lang>/*.ts`; `de` is the typed source; DE and EN values from spec §7 or the task; translate the other five). New blocks in `adminPeople.ts` go directly after the existing `roles` block in this order: `rights`, `check`, `summary`, `profiles` — identical order in all seven files. Every user-facing string through `#lib/i18n`.
- Never "Netflix"/"Seerr" in user-facing text (the request service is "Wünsche" / "requests").
- **Fictional names in tests** and fixtures only: Anna Beispiel, Ben Muster, Carla Probe (people), titles *Dunmoor*, *Saltwater Almanac*, *Wrenfield Pier*; libraries *Filme*, *Serien*, *Kinder*.
- **Placeholder hosts only** (friend.example.com, auth.example.com, 192.0.2.x).
- **Never log secrets.** No PIN, token, password, title or search query in logs or audit meta (activity / check views store counts only).
- **Migrations** inline in `backend/src/db.ts`: append to `MIGRATIONS`, number **47**, one array element, rerunnable parts `if not exists` / `on conflict do nothing`.
- **Backwards compatible:** existing roles, overrides, profiles, invites and approvals keep identical effective values after migration 47 (tested). **One-release rollback:** old `role_settings` columns are dual-written by every role write; `GET /api/admin/roles` legacy fields and `PUT /api/admin/users/:id/limits` stay for one release; release notes carry the rollback caveat for admin-created roles (spec §5).
- **Errors** keep the `{ error: code }` shape; admin routes use `requireAdmin(ctx)`, account writes run in `accountSerial`.
- Every new source file starts with the SPDX header (`SPDX-FileCopyrightText: 2026 Manuel Weißböck`, `SPDX-License-Identifier: AGPL-3.0-or-later`; `.svelte` as HTML comments). No new dependencies. Coverage thresholds are never lowered.
- **Verification:** agents run only typecheck plus the specific test files they touch, CI runs the rest:
  - root `npm run typecheck` (includes `npx tsc -p e2e/tsconfig.json`);
  - backend `npx -w backend vitest run <file>` (needs PostgreSQL: `TEST_DATABASE_URL` or `localhost:5433`; if none is reachable, leave it to CI and say so in the report); web unit `npx -w web vitest run <file>`;
  - e2e via `E2E_PORT=<port> PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx playwright test <spec> --trace off` from `e2e/` (only the task's spec files; delete `e2e/test-results` afterwards), and `npx tsc -p e2e/tsconfig.json`.
- **Commits:** Conventional Commits, one per task (the commit step names it), each ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`
  (`git commit -m "<subject>" -m "Co-Authored-By: …" -m "Claude-Session: …"`). No model names anywhere else. Do not push.

## Review Focus

1. **Two admins edit different fields of the same role:** a `PUT` carries only the changed fields, so neither save loses the other's change, and the old columns written alongside reflect the merged result. Test in Task 3 (`two partial writes keep each other's fields`).
2. **Role labels from real keyboards:** "Großeltern", "Gäste 2", "Гости", "🎬 Kino", "Order" each get a valid unique hidden key (`^[a-z][a-z0-9_-]{1,23}$`, transliterated where possible, fallback `role`, `-2`… on clash, never `order`). Test in Task 4 (`labels slug to valid unique keys`).
3. **An env role removed from `.env` while people still hold it:** they keep playing with the role's last known values (base `friend` ← stored template), the editor shows "nicht mehr in .env", nobody gets `unknown role` errors. Test in Task 2 (`a role that left ROLE_TEMPLATES still resolves`).
4. **A role deleted while an invite for it is still open or being redeemed:** open invites move to the target role in the same transaction; redeeming afterwards creates an account with the target role, never one with a missing role. Test in Task 4 (`an invite redeemed after its role was deleted gets the new role`).
5. **Library names that no longer exist on the media server** (renamed or removed library) in a role template or a person's override: policy re-apply skips the unknown names instead of failing, the rights answer flags them (`missingLibraries: string[]`), the UI shows "nicht mehr vorhanden". Tests in Task 5 (`stale library names are skipped and reported`) and Task 19 (`a missing library shows as not available`).

---

## PR 0a — Backend (Tasks 1–12)

### Task 1: Migration 47, role catalogue, `syncRoles`, `roleExists`

**Implementer:** Opus (hard: migration) · backend

**Files:**
- Modify: `backend/src/db.ts` (append migration 47 = spec §3 SQL verbatim, comment line `// 47: users & permissions remodel …` like its neighbours)
- Create: `backend/src/rolecat.ts`
- Modify: `backend/src/server.ts` (call `syncRoles(ctx)` right after `migrate(pool)` once `ctx` exists, before `reapplyPoliciesOnce`), `backend/test/helpers.ts` (`makeEnv` calls `syncRoles(ctx)`), `backend/src/users.ts` (`setRole` line 162, `reapplyPoliciesOnce` iterates `listRoles`), `backend/src/routes/adminUsers.ts` (lines 76, 212), `backend/src/routes/admin.ts` (line 267 role existence; line 487 role label), `backend/src/routes/auth.ts` (line 302 role label)
- Test: `backend/test/roles-migration.test.ts`

**Interfaces:**
- Produces (`backend/src/rolecat.ts`):
  - `export const ROLE_KEY_RE = /^[a-z][a-z0-9_-]{1,23}$/;` `export const RESERVED_ROLE_KEYS = ['order'] as const;`
  - `export interface RoleRow { key: string; label: string | null; base: string; origin: 'code' | 'env' | 'admin'; invitable: boolean; position: number; createdAt: string }`
  - `export async function listRoles(ctx: Pick<Ctx, 'db' | 'roles'>): Promise<RoleRow[]>` — ordered by `position, key`; cached 30 s per ctx (WeakMap like `roles.ts`); a `ctx.roles` key without a row is appended in memory as `origin 'env'` (never persisted here) so nothing breaks before the sync ran.
  - `export async function roleExists(ctx: Pick<Ctx, 'db' | 'roles'>, key: string): Promise<boolean>`
  - `export async function invitableRoles(ctx): Promise<string[]>` (catalogue order, `invitable` and key ≠ `admin`)
  - `export async function catalogueLabel(ctx, key: string): Promise<string | undefined>` — `roles.label ?? ctx.roles[key]?.label ?? DEFAULT_ROLES[base]?.label`
  - `export async function syncRoles(ctx: Pick<Ctx, 'db' | 'roles'>): Promise<{ added: string[] }>` — inserts every `ctx.roles` key without a row: `origin 'env'`, `base` = key when built-in else `'friend'`, `position` = max + 1, `invitable` true; skips `RESERVED_ROLE_KEYS` and keys failing `ROLE_KEY_RE` with one `console.warn('role key skipped')` (no key in the message); idempotent.
  - `export const invalidateCatalogue = (ctx: object) => void` — also called from `invalidateRoles` in `roles.ts`.
- All four `Object.hasOwn(ctx.roles, …)` checks become `await roleExists(ctx, …)`; both `roleLabel(…, ctx.roles[k]?.label, …)` calls pass `await catalogueLabel(ctx, k)`.

- [ ] **Step 1: Verify the base:** `grep -n "^  // 46:" backend/src/db.ts` finds the hand-off migration (else stop and rebase); the test below asserts `MIGRATIONS.length === 47` after the change.
- [ ] **Step 2: Write the failing tests** in `backend/test/roles-migration.test.ts` (rewind pattern of `block23-migration.test.ts`: `delete from schema_migrations where version >= 47`, drop the new objects, seed old-shape rows, `migrate()` again):
  - `seeds the four built-ins` — `select key, origin, invitable, position from roles order by position` = admin/code/false/0, family/true/1, friend/true/2, guest/true/3.
  - `backfills template from every column combination` — rows: `family` with all seven columns set (`max_height 1080`) → `template` has all seven keys; `guest` with `max_height = 0` → `{"maxHeight": null}`; `friend` with only `requests_per_month = 5` → `template = {}`; a row whose `template` is already non-empty is not touched.
  - `user_limits gains the columns, existing rows untouched` — a row `max_streams 3` keeps it, `perms = {}`, new columns null.
  - `audit indexes exist` — `pg_indexes` has `audit_log_target` and `audit_log_action`.
  - `migration 47 is rerunnable` — run the rewind + migrate twice, no error.
  - `syncRoles adds env roles once` — ctx with `ROLE_TEMPLATES` `{"oma":{"label":"Oma"}}` → row `oma`, origin `env`, base `friend`, position 4; second call adds nothing; a key `order` is skipped.
  - `roleExists and invitableRoles` — `roleExists('oma')` true, `'nobody'` false; `invitableRoles` = `['family','friend','guest','oma']`.
  - `PATCH /api/admin/users/:id { role: 'oma' }` succeeds (was impossible only for non-env roles; now catalogue-checked) and `{ role: 'nobody' }` → 400 `unknown_role`.
- [ ] **Step 3: Run** `npx -w backend vitest run test/roles-migration.test.ts` → FAIL.
- [ ] **Step 4: Implement** the migration, `rolecat.ts` and the call sites.
- [ ] **Step 5: Verify** the file → PASS; `npx -w backend vitest run test/admin-users.test.ts test/invites.test.ts` (touched call sites); root `npm run typecheck`.
- [ ] **Step 6: Commit** `feat(roles): role catalogue and migration 47`

### Task 2: Permission registry and `effectiveRights`

**Implementer:** Opus (hard: permission-resolution core) · backend

**Files:**
- Create: `backend/src/perms.ts`, `backend/src/rights.ts`
- Modify: `backend/src/roles.ts` (`effectiveRole` reads `role_settings.template` and resolves admin-created / env-left roles from the catalogue), `backend/src/limits.ts` (`effectiveLimits` = wrapper; `UserOverrides`), `backend/src/requestlimit.ts` (no change in behaviour; `roleLimitFor` keeps reading its column)
- Test: `backend/test/rights.test.ts`

**Interfaces:**
- Produces (`backend/src/perms.ts`):
  - `export const PERM_KEYS = ['requests', 'cast', 'party', 'partySchedule', 'comments', 'liveTv', 'liveRecord'] as const; export type PermKey = (typeof PERM_KEYS)[number]; export type Perms = Record<PermKey, boolean>;`
  - `export const DEFAULT_PERMS: Record<'admin' | 'family' | 'friend' | 'guest', Perms>` — spec §1 table exactly (admin all true; family/friend all true except `partySchedule` false; guest `partySchedule`, `comments`, `liveRecord` false).
  - `export const KIDS_OFF: readonly PermKey[] = ['requests', 'party', 'partySchedule', 'comments', 'liveRecord'];`
  - `export const PERM_REQUIRES: Partial<Record<PermKey, 'requests' | 'cast' | 'livetv'>> = { requests: 'requests', cast: 'cast', liveTv: 'livetv', liveRecord: 'livetv' };`
  - `export function readPerms(raw: unknown): Partial<Perms>` — keeps only known keys with boolean values (unknown keys ignored on read).
  - `export const permsPatch: z.ZodType<Partial<Record<PermKey, boolean | null>>>` — `.strict()` (unknown keys rejected on write).
  - `export type FieldKind = 'bool' | 'int' | 'bitrate' | 'height' | 'rating' | 'libraries'; export type FieldGroup = 'access' | 'playback' | 'downloads' | 'requests' | 'together' | 'cast' | 'livetv';`
  - `export interface MatrixField { key: string; group: FieldGroup; kind: FieldKind; min?: number; max?: number; options?: Array<number | null>; requires?: 'requests' | 'cast' | 'livetv' }`
  - `export const MATRIX_FIELDS: readonly MatrixField[]` in this order: access: `libraries` (libraries), `maxParentalRating` (rating, options `[null, 0, 6, 12, 16, 18]`); playback: `maxStreams` (int 1–50), `maxBitrate` (bitrate 300 000–200 000 000), `remoteMaxBitrate` (bitrate 300 000–200 000 000), `transcoding` (bool), `maxHeight` (height, options `[null, 720, 1080, 1440, 2160]`); downloads: `download` (bool), `maxDownloads` (int 0–200), `downloadMaxHeight` (height, options `[480, 720, 1080, 2160]`), `downloadDays` (int 1–90); requests: `requests` (bool, requires requests), `requestsPerMonth` (int 0–100, options `[null]` = unlimited, requires requests); together: `party`, `partySchedule`, `comments` (bool); cast: `cast` (bool, requires cast); livetv: `liveTv`, `liveRecord` (bool, requires livetv).
  - `export function featureFlags(ctx: Ctx): { requests: boolean; cast: boolean; livetv: boolean }` — `requestsEnabled(ctx)`, `castEnabled(ctx)`, `livetv: false` (ruling 3).
- Produces (`backend/src/rights.ts`):
  - `export type RightSource = 'default' | 'env' | 'role' | 'user' | 'kids' | 'admin';`
  - `export type RightKey = Exclude<keyof RoleTemplate, 'label'> | 'requestsPerMonth' | PermKey;`
  - `export interface Rights { template: EffectiveLimits; perms: Perms; sources: Record<RightKey, RightSource> }`
  - `export async function roleRights(ctx: RightsCtx, role: string): Promise<{ template: EffectiveLimits; perms: Perms; sources: Record<RightKey, Exclude<RightSource, 'user' | 'kids'>> } | undefined>`
  - `export async function effectiveRights(ctx: RightsCtx, user: { id: string; role: string }, profile?: Pick<ProfileRow, 'kids' | 'kids_max_rating'> | null): Promise<Rights | undefined>` with `type RightsCtx = Pick<Ctx, 'db' | 'roles'>`; cached 30 s per (ctx, user) without profile; the kids overlay is applied on top of the cached account value.
  - `export async function accountsWithout(ctx: RightsCtx, perm: PermKey): Promise<string[]>` — ids of non-disabled accounts whose effective perm is off (account level, no kids overlay), cached 30 s.
  - `export function invalidateRights(userId?: string): void` — clears the user cache (all without id) and the `accountsWithout` cache; `invalidateLimits` calls it.
- Resolution rules (spec §1): template = `DEFAULT_ROLES[base]` ← `ctx.roles[key]` (env) ← `role_settings.template` ← user override; perms = `DEFAULT_PERMS[base] ?? DEFAULT_PERMS.friend` ← `role_settings.perms` ← `user_limits.perms`; `requestsPerMonth` = `roleLimitFor` ← `user_limits.requests_per_month`. Admin role: every perm `true`, source `admin`, whatever is stored. Kids overlay: `KIDS_OFF` false with source `kids`; `maxParentalRating = min(cap ?? kidsCap, kidsCap)` with source `kids` when it lowered the cap. A role whose key is neither in `ctx.roles` nor built-in resolves from `DEFAULT_ROLES[row.base] ?? DEFAULT_ROLES.friend` ← stored template (admin-created and env-left roles). `user_limits.max_parental_rating = -1` → `null` (unrestricted); `max_height = 0` → `null`.
- `limits.ts`: `export type UserOverrides = UserLimits & { transcoding: boolean | null; maxHeight: number | null; download: boolean | null; maxBitrate: number | null; maxParentalRating: number | null; libraries: 'all' | string[] | null; perms: Partial<Perms>; note: string | null }` with `getUserOverrides(ctx, userId)` / `setUserOverrides(ctx, userId, o)` (row deleted when every field is null, `perms` empty and `note` null); `effectiveLimits(ctx, user)` returns `(await effectiveRights(ctx, user))?.template` (same shape as today).

- [ ] **Step 1: Write the failing tests** in `backend/test/rights.test.ts`:
  - `defaults reproduce today` — for each built-in role with no rows: `perms` = `DEFAULT_PERMS[role]`, every source `default`.
  - `layer order and sources` — env `{"friend":{"maxStreams":3}}`, role_settings template `{ "maxHeight": 1080 }`, perms `{ "cast": false }`, user override `max_streams 5` → `maxStreams 5 (user)`, `maxHeight 1080 (role)`, `cast false (role)`, `downloadDays 30 (default)`; with the override removed `maxStreams 3 (env)`.
  - `admin perms are locked` — role_settings perms `{ "comments": false }` for admin → `comments true`, source `admin`.
  - `kids overlay` — guest (cap 12) kids profile with `kids_max_rating 6` → `maxParentalRating 6 (kids)`, `requests/party/partySchedule/comments/liveRecord` false (kids), `cast` true; family (cap null) kids 12 → `12 (kids)`.
  - `effective values identical before and after migration 47` — fixture of role_settings rows with every old-column combination and `user_limits` rows: compute `effectiveLimits` for every role and user with the pre-47 code path snapshot (a JSON fixture in the test of the expected 3.3 values) and compare to the new resolver; deep-equal.
  - `a role that left ROLE_TEMPLATES still resolves` — env role `oma` synced, a user with role `oma`, then a ctx whose `roles` lacks `oma` → `effectiveRights` defined, values = friend defaults ← stored template, `applyRole` does not throw.
  - `admin-created role resolves from base and full template` — insert `roles(key 'kino', base 'family', origin 'admin')` + full template → values match the template.
  - `accountsWithout('comments')` — lists the guest account and a friend with a `comments: false` override; not a locked account; cache cleared by `invalidateRights()`.
  - `unknown perm keys in stored JSON are ignored` — `perms {"telepathy": true}` → no error, not in the answer.
- [ ] **Step 2: Run** `npx -w backend vitest run test/rights.test.ts` → FAIL.
- [ ] **Step 3: Implement** `perms.ts`, `rights.ts`, the `effectiveRole` / `effectiveLimits` changes.
- [ ] **Step 4: Verify** the file → PASS; `npx -w backend vitest run test/limits.test.ts test/requestlimit.test.ts test/kids.test.ts` (unchanged behaviour); root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(rights): permission registry and one resolver for effective rights`

### Task 3: `GET /api/admin/roles` matrix and `PUT /api/admin/roles/:role`

**Implementer:** Opus (hard: policy re-apply, admin lock, dual write) · backend

**Files:**
- Create: `backend/src/roleWrite.ts`
- Modify: `backend/src/routes/admin.ts` (the two role routes), `backend/src/users.ts` (`reapplyRole` returns `{ identities, failed }`), `web/src/routes/admin/roles/+page.svelte` (ruling 2: `diff()` sends `maxHeight: 'unlimited'` instead of `null` and `requestsPerMonth: 'unlimited'` instead of `null`), `e2e/mocks/admin.ts` (accept the new literals)
- Test: `backend/test/roles-api.test.ts`

**Interfaces:**
- Consumes: `listRoles`, `roleExists` (Task 1); `roleRights`, `MATRIX_FIELDS`, `featureFlags`, `permsPatch` (Task 2).
- Produces: `GET /api/admin/roles` = legacy `{ roles, invitable, limits }` (unchanged fields; `invitable` now from `invitableRoles`) plus `matrix` of spec §4.1 plus `matrix.features` (ruling 3); `values` keys = `MatrixField.key`s; role `accounts`, `profiles`, `kidsProfiles` counted in one grouped query; `libraries` from `ctx.jf.admin.libraries()` cached 5 min (on error `[]`).
- Produces (`roleWrite.ts`): `export const rolePatch` (zod, spec §4.1 bounds; `maxHeight: 144–4320 | 'unlimited' | null`, `maxParentalRating: 0–21 | 'unlimited' | null`, `requestsPerMonth: 0–100 | 'unlimited' | null`, `libraries: 'all' | string[] (1–50 names) | null`, `label: string 1–30 | null`, `invitable: boolean`, `perms: permsPatch`) and `export async function writeRole(ctx: Ctx, actor: string, key: string, patch: RolePatch): Promise<{ changed: string[]; reapplied: { identities: number; failed: number } }>`.
- `writeRole` rules: merges into `role_settings.template` / `perms` (`null` deletes the key; `'unlimited'` stores JSON `null`), `requestsPerMonth` into its column (`null` → `defaultLimit(base)`, `'unlimited'` → SQL null); **dual-writes** the old columns from the merged effective template (`max_height` 0 for unlimited, null when inherited); `label`/`invitable` into `roles` (admin `invitable` refused 400 `admin_not_invitable`); admin + `perms` → 400 `admin_perms_locked`; library names must exist (`400 unknown_library`); `invalidateRoles(ctx)` + `invalidateRights()`; one audit `role.update` with `{ from, to }` of the changed fields only (none changed → no audit); `reapplyRole` only when a media-enforced field changed (`libraries`, `maxParentalRating`, `maxStreams`, `maxBitrate`, `transcoding`, `maxHeight`; spec §2.3); applyRole skips library names the server no longer has (Review Focus 5).
- Route answers `{ ok: true, reapplied }`; `failed > 0` → 502 `{ error: 'policy_partial', failed, identities }` (settings stay stored). Unknown role → 404.

- [ ] **Step 1: Write the failing tests** in `backend/test/roles-api.test.ts`:
  - `matrix lists fields, roles and sources` — `fields` order = `MATRIX_FIELDS` filtered by nothing (client filters with `features`), `features.livetv === false`; family `accounts` counts two seeded users and `kidsProfiles` one; a value changed via PUT has `sources[key] === 'role'`.
  - `partial write merges and audits once` — PUT guest `{ maxParentalRating: 16, perms: { cast: false } }` → template `{ maxParentalRating: 16 }`, perms `{ cast: false }`, one `role.update` entry `{ from: { maxParentalRating: 12, cast: true }, to: { maxParentalRating: 16, cast: false } }`.
  - `two partial writes keep each other's fields` — PUT family `{ maxStreams: 3 }` then `{ downloadDays: 14 }` → both in the template; old column `download_days = 14`.
  - `null inherits, 'unlimited' lifts` — `maxHeight: 'unlimited'` → template `maxHeight: null`, old `max_height = 0`; then `maxHeight: null` → key gone, old column null; `requestsPerMonth: 'unlimited'` → column null; `null` → `2`.
  - `admin perms are locked` — admin `{ perms: { party: false } }` → 400 `admin_perms_locked`; admin `{ maxStreams: 8 }` → 200.
  - `media fields re-apply, others do not` — fake Jellyfin counts policy POSTs: `transcoding` change → one per identity of the role; `downloadDays` → none; one identity's policy POST failing → 502 `policy_partial` with `failed: 1` and the value stored.
  - `unknown library refused` — `libraries: ['Nirgendwo']` → 400 `unknown_library`.
  - `stale library names are skipped and reported` (shared with Task 5) — template `libraries: ['Filme', 'Archiv']`, server has only *Filme* → re-apply succeeds with *Filme*; matrix answer for that role carries `missingLibraries: ['Archiv']`.
  - `legacy fields stay` — `limits[].remoteIsDefault`, `invitable` present.
- [ ] **Step 2: Run** the file → FAIL.
- [ ] **Step 3: Implement** `roleWrite.ts`, the two routes, the old page's two-line change and the mock.
- [ ] **Step 4: Verify** the file → PASS; `npx -w backend vitest run test/admin-people.test.ts`; `E2E_PORT=4311 PW_CHROMIUM=… npx playwright test tests/admin-people.spec.ts --trace off` (old roles page still saves); root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(roles): role matrix and partial role writes with one audit entry`

### Task 4: Role create (duplicate), delete with move, order

**Implementer:** Sonnet (routine) · backend

**Files:**
- Modify: `backend/src/rolecat.ts` (`slugKey`, `createRole`, `deleteRole`, `orderRoles`), `backend/src/routes/admin.ts` (three routes)
- Test: `backend/test/roles-api.test.ts` (describe `catalogue writes`)

**Interfaces:**
- Consumes: `roleRights` (Task 2), `writeRole` (Task 3), `setRole` (`users.ts`).
- Produces: `export function slugKey(label: string, taken: ReadonlySet<string>): string` — NFKD, `ß→ss`, `æ→ae`, `ø→o`, strip marks, lower-case, non-`[a-z0-9]` runs → `-`, trim `-`, cut to 21 chars, must start with a letter (else prefix `r-`), empty → `role`; `RESERVED_ROLE_KEYS` and `taken` → append `-2`, `-3` … (result always matches `ROLE_KEY_RE`).
- `POST /api/admin/roles` `{ label: string 1–30, from: roleKey }` → 201 `{ key }`: new `roles` row (`origin 'admin'`, `base` = `from`'s base, `invitable` = `from`'s unless `from` is admin → true, `position` = last + 1, `created_by`), `role_settings` row with the **full** effective template and perms of `from`, `requests_per_month` copied; duplicating `admin` copies its numbers only, with `base 'family'` and `DEFAULT_PERMS.family` (admin rights are never copied — they belong to the key `admin`); audit `role.create { from, label }`.
- `DELETE /api/admin/roles/:role` `{ moveTo?: roleKey }`: built-in → 400 `builtin_role`; origin `env` still in `ctx.roles` → 400 `env_role` (remove it from `.env` first); accounts or open invites (`uses < max_uses and expires_at >= now()`) and no `moveTo` → 409 `{ error: 'role_in_use', accounts, invites }`; `moveTo` = itself or unknown → 400. With `moveTo`: one transaction updates open invites' `role`, then per account `setRole` (audited `user.role` as today; last-admin guard irrelevant since `admin` is built-in), then deletes `role_settings` and `roles` rows; audit `role.delete { moveTo, accounts, invites }`.
- `PUT /api/admin/roles/order` `{ keys: string[] }` — must be a permutation of all catalogue keys (else 400 `bad_order`); `position` = index; audit `role.order`.

- [ ] **Step 1: Write the failing tests:**
  - `labels slug to valid unique keys` — `Großeltern` → `grosseltern`; `Gäste 2` → `gaste-2`; `Гости` → `role`, again → `role-2`; `🎬 Kino` → `kino`; `Order` → `order-2`; a 40-char label → ≤ 24 chars; every result matches `ROLE_KEY_RE`.
  - `duplicate snapshots the source` — duplicate *Familie* as "Oma & Opa" → `GET` matrix has the new column with family's values; a later PUT on `family` does not change the copy.
  - `delete needs a target while in use` — 2 accounts + 1 open invite → 409 with `{ accounts: 2, invites: 1 }`; with `moveTo: 'friend'` → both accounts `friend` (audit `user.role` ×2), the invite's role `friend`, rows gone, audit `role.delete`.
  - `an invite redeemed after its role was deleted gets the new role` — create invite for the custom role, delete with `moveTo: 'guest'`, redeem → the new account's role is `guest`.
  - `built-in and env roles cannot be deleted` — `guest` → 400 `builtin_role`; synced env role → 400 `env_role`.
  - `order must be a permutation` — missing key → 400; valid → positions follow; `invitableRoles` follows the order.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(roles): duplicate, delete with move and order roles`

### Task 5: Per-user rights API

**Implementer:** Opus (hard: overrides change media-server policies) · backend

**Files:**
- Modify: `backend/src/limits.ts` (`getUserOverrides` / `setUserOverrides` from Task 2 get their SQL), `backend/src/routes/adminUsers.ts` (`GET/PUT /api/admin/users/:id/rights`; `PUT /:id/limits` becomes an alias that maps its five fields; `reapplyAccount` unchanged), `backend/src/users.ts` (`applyRole` uses `effectiveRights` via `effectiveLimits` — no change needed beyond Task 2; verify)
- Test: `backend/test/user-rights.test.ts`

**Interfaces:**
- Consumes: `effectiveRights`, `roleRights`, `permsPatch`, `MATRIX_FIELDS` (Task 2).
- Produces: `GET /api/admin/users/:id/rights?profile=<pid>` → spec §4.2 shape `{ role, note, rows, profile, hardKids }` plus `missingLibraries: string[]`; one row per `MATRIX_FIELDS` key in that order; `value` = effective (with the profile's kids overlay when `profile` is a kids profile), `roleValue` = role's, `override` = stored override or null, `source`.
- Produces: `PUT /api/admin/users/:id/rights` body `{ overrides: Partial<Record<RightKey, value | null>>, note?: string (≤ 200) | null }` (`.strict()`; same value encodings as `rolePatch`; `remoteMaxBitrate` maps to column `remote_bitrate`, `maxParentalRating: 'unlimited'` → `-1`, `maxHeight: 'unlimited'` → `0`); an override equal to the role's value is dropped (stored as null / key removed); 409 `deletion_in_progress` like `/limits`; inside `accountSerial`; `invalidateRights(id)`; media-enforced field changed → `reapplyAccount` + `forgetUserAuth`; answer `{ ok: true, reapplied }` or 502 `policy_partial`; audit `user.rights` `{ from, to }` of changed fields only; a note change adds `note: 'changed'` (never the note text: audit meta stays free of free text).
- Legacy `PUT /:id/limits`: maps `maxStreams, remoteBitrate→remoteMaxBitrate, maxDownloads, downloadMaxHeight, requestsPerMonth` onto `/rights` logic; answer shape unchanged; audit `user.rights`.

- [ ] **Step 1: Write the failing tests** in `backend/test/user-rights.test.ts` (Anna Beispiel = friend):
  - `rows carry value, role value, override and source` — override `cast: false` → row `cast { value: false, roleValue: true, override: false, source: 'user' }`; `maxStreams` row source `default`.
  - `kids profile view` — `?profile=<kids pid>` → `comments` row source `kids`, `hardKids` = `KIDS_OFF`.
  - `equal to role is not stored` — PUT `{ overrides: { maxStreams: 2 } }` (friend default 2) → `user_limits` row absent.
  - `more and less permissive` — `download: true` for a friend and `cast: false` → stored; `effectiveRights` reflects both.
  - `media fields re-apply the account` — `maxParentalRating: 12` → one policy POST per identity (owner + profile identities), `forgetUserAuth` called; `note` only → none.
  - `audit holds changed fields only, no note text` — note "Darf am Wochenende mehr" + `cast: false` → meta `{ from: { cast: true }, to: { cast: false }, note: 'changed' }`, meta JSON does not contain `Wochenende`.
  - `stale library names are skipped and reported` — override `libraries: ['Filme', 'Archiv']` (validated against the server when written; *Archiv* removed from the fake afterwards) → re-apply sends only *Filme*'s folder id; `GET /rights` `missingLibraries: ['Archiv']`.
  - `legacy /limits maps to rights` — PUT `/limits { remoteBitrate: 4000000 }` → `user_limits.remote_bitrate = 4000000`, answer `{ limits }` as before.
  - `unknown field refused` — `{ overrides: { telepathy: true } }` → 400.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w backend vitest run test/admin-user-detail.test.ts test/limits.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(rights): per-person rights with every field and switch`

### Task 6: Enforcement of the switches and `/api/me.perms`

**Implementer:** Opus (hard: security-relevant enforcement) · backend

**Files:**
- Create: `backend/src/permGuard.ts`
- Modify: `backend/src/routes/anime.ts` (lines 206–211, 233, 245), `backend/src/routes/party.ts` (create line 40, list, invite, `GET /api/party/:id`, `/ws/party/:id`), `backend/src/routes/cast.ts` (`POST /api/cast/session`), `backend/src/routes/seerr.ts` (`requestsOn` pre-handler), `backend/src/routes/auth.ts` (`GET /api/me` gains `perms`)
- Test: `backend/test/perm-enforcement.test.ts`

**Interfaces:**
- Consumes: `effectiveRights`, `accountsWithout`, `PermKey` (Task 2).
- Produces (`permGuard.ts`): `export async function permsOf(ctx: Ctx, req: FastifyRequest): Promise<Perms>` (account + active profile's kids overlay; memoised on the request) and `export function requirePerm(ctx: Ctx, perm: PermKey, code: 'party_forbidden' | 'cast_forbidden' | 'requests_forbidden'): preHandlerAsyncHookHandler` (403 `{ error: code }`; runs after the existing sign-in pre-handlers).
- Comments: `isGuest(req)` → `!(await permsOf(ctx, req)).comments` (GET answers `{ watched, comments: [] }`, POST 403 `forbidden` as today); `commentSelect`'s `u.role <> 'guest'` → `not (c.user_id = any($2::uuid[]))` with `accountsWithout(ctx, 'comments')`.
- Party: scheduled cap waived when `perms.partySchedule` (was `role === 'admin'`); `POST /api/party`, `POST /api/party/:id/invite`, `GET /api/party/:id` → `requirePerm('party', 'party_forbidden')`; WebSocket: closes with `4403` `'party_forbidden'` before `room.join`; `GET /api/party` answers `{ rooms: [] }` without the perm.
- Cast: `POST /api/cast/session` → 403 `cast_forbidden`.
- Requests: `requestsOn(ctx)` additionally answers 403 `requests_forbidden` when the user lacks `requests` (admin routes keep `requireAdmin` + `on`; admin always has it).
- `/api/me` gains `perms: Perms` (kids overlay applied); `limits` / `downloads` unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `guest still has no comments, a friend override hides theirs` — guest GET → `comments: []`; friend Ben Muster with `comments: false` override: POST → 403, and Anna sees none of Ben's earlier comments; with the override back to role → visible again after `invalidateRights`.
  - `guest granted comments` — role PUT guest `perms.comments: true` → guest can read and post.
  - `partySchedule replaces the admin check` — friend with `partySchedule: true` override can schedule a 4th party; admin without anything can (locked perms).
  - `party denied` — `party: false` → `POST /api/party` 403 `party_forbidden`; WebSocket upgrade closes `4403`; `GET /api/party` → `rooms: []`.
  - `cast denied` — `cast: false` → `POST /api/cast/session` 403 `cast_forbidden`.
  - `requests denied` — `requests: false` → `POST /api/requests` 403 `requests_forbidden`; `GET /api/requests/quota` 403 too; admin unaffected.
  - `/api/me.perms` — friend: spec defaults; kids profile: `KIDS_OFF` false, `cast` true.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w backend vitest run test/anime.test.ts test/party.test.ts test/party-limit.test.ts test/cast.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(rights): enforce the role switches on the server`

### Task 7: Web: hide denied features, 403 texts

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/perms.ts`, `web/src/lib/perms.test.ts`
- Modify: `web/src/lib/api.ts` (`Me.perms?: Partial<Record<PermKey, boolean>>`), `web/src/routes/+layout.svelte` (boot sets `perms`; `features.set(featuresFrom({ ...m.features, requests: m.features?.requests !== false && m.perms?.requests !== false }))`), `web/src/lib/capabilities.ts` (`linkShown(c, href, f, p?: Perms)` with `PERM_NEEDS = { '/party': 'party' }`), `web/src/lib/cast.ts` (casting offered only when `get(perms).cast`), `web/src/lib/detail/DetailView.svelte` (party action needs `$perms.party`), `web/src/lib/detail/EpisodeComments.svelte` (hidden without `$perms.comments`), `web/src/lib/ui/action.ts` (`errorText` maps `body.error` `cast_forbidden` / `party_forbidden` / `requests_forbidden`), locales `ui.ts` (`error.castForbidden`, `partyForbidden`, `requestsForbidden` — spec §7 DE/EN) in all seven languages, `e2e/mocks/api.ts` (`me.perms` configurable)
- Test: `web/src/lib/perms.test.ts`, `web/src/lib/ui/action.test.ts`, `e2e/tests/perms-hidden.spec.ts`

**Interfaces:**
- Consumes: `/api/me.perms` (Task 6).
- Produces (`web/src/lib/perms.ts`): `export type PermKey = 'requests' | 'cast' | 'party' | 'partySchedule' | 'comments' | 'liveTv' | 'liveRecord'; export type Perms = Record<PermKey, boolean>; export const ALL_PERMS: Perms; export function permsFrom(raw: unknown): Perms` (only an explicit `false` turns one off; missing `perms` = everything allowed); `export const perms = writable<Perms>(ALL_PERMS)`.

- [ ] **Step 1: Write the failing tests** — unit: `permsFrom(undefined)` all true, `{ cast: false }` only cast false, `{ cast: 'no' }` true; `errorText` of `ApiError(403, { error: 'cast_forbidden' })` = the castForbidden text; e2e (German UI, mocked `me.perms { cast: false, party: false, requests: false, comments: false }`): detail page has no *Party* action and no cast button, `/new` shows no wish buttons, the episode comment region is absent, the menu has no *Watch-Party* link; with perms missing everything shows as before.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/capabilities.test.ts src/lib/i18n/i18n.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(web): hide features a person's rights switch off`

### Task 8: Invites and approvals for any invitable role, `pending.approvals`

**Implementer:** Sonnet (routine) · backend

**Files:**
- Modify: `backend/src/routes/adminUsers.ts` (`POST /api/admin/invites` `role`, `POST /api/admin/approvals/:id/approve` `role`), `backend/src/routes/admin.ts` (`/api/admin/summary` `pending.approvals`; users totals gain `expiring`), `backend/src/roles.ts` (`INVITABLE_ROLES` kept exported for one release, marked deprecated, no longer used by routes), `web/src/lib/admin/summary.ts` (type: `pending.approvals: number`, `users.expiring: number`), `e2e/mocks/admin.ts` (summary fields)
- Test: `backend/test/invites.test.ts` (new cases), `backend/test/admin-summary.test.ts`

**Interfaces:**
- Consumes: `invitableRoles`, `roleExists` (Task 1).
- Produces: invite `role` = `z.string().regex(ROLE_KEY_RE)` checked with `invitableRoles` → 400 `role_not_invitable`; approve `role` = invitable roles + `admin`. `/api/admin/summary` `pending.approvals` = count of `approval_requests where rejected_at is null`; `users.expiring` = accounts with `access_until` within 7 days.

- [ ] **Step 1: Write the failing tests** — `invite for an env role` (synced `oma`) → 200 and the redeemed account is `oma`; `a role switched to not invitable is refused` → 400 `role_not_invitable`; `admin is never invitable, approval may grant admin`; `summary counts open approvals and expiring access` (two open, one rejected → 2).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(people): invites and approvals offer every invitable role`

### Task 9: Users list filters, columns, bulk `perm` and `repair`

**Implementer:** Sonnet (routine) · backend

**Files:**
- Modify: `backend/src/routes/adminUsers.ts` (`GET /api/admin/users`, `bulkBody`, `bulkUsers`; the single `repair` body moved into `repairAccount(ctx, actor, user)` and reused)
- Test: `backend/test/admin-users.test.ts` (new cases)

**Interfaces:**
- Consumes: `effectiveRights` (Task 2), `getUserOverrides` / `setUserOverrides` (Tasks 2, 5), `akMfaState` (`authentik.ts`, KV-cached 10 min).
- Produces: query params `overrides=1`, `kids=1`, `perm=<PermKey>:on|off`, `mfa=off`; `perm` and `mfa` are applied in the backend after the SQL filter (set ≤ 1000 rows), `total` recomputed; `mfa` ignored without the Authentik API, looked up with concurrency 8. Row shape gains `overrides: number` (count of non-null override fields + perm keys), `kidsProfiles: number`, `note: string | null`.
- Produces: `bulkBody.action` adds `'perm'` (`perm: PermKey`, `value: boolean | null`; required when `action === 'perm'`) and `'repair'`. `perm` writes the override per account through `setUserOverrides` (equal-to-role dropped), audit `user.rights` per changed account; `repair` = `repairAccount` per account. Guards and `done` as today.

- [ ] **Step 1: Write the failing tests** — `overrides=1` lists only Ben (has one); `kids=1` only Carla (has a kids profile); `perm=cast:off` lists the account with a `cast: false` override and no one else, `perm=comments:off` lists guests; row fields `overrides`, `kidsProfiles`, `note`; bulk `perm cast false` on Anna + Ben → both stored, `done: 2`; again → `done: 0`; `value: null` clears; bulk `repair` re-applies policies (fake Jellyfin calls counted) and audits `user.repair` per account.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(people): rights filters, override counts and bulk rights`

### Task 10: Admin kids profiles

**Implementer:** Opus (hard: parental controls) · backend

**Files:**
- Modify: `backend/src/routes/adminUsers.ts` (`PATCH /api/admin/users/:id/profiles/:pid`; new `POST /api/admin/users/:id/profiles`, `DELETE /api/admin/users/:id/profiles/:pid`), `backend/src/profiles.ts` (no change to `createProfile` / `deleteProfile` signatures; verify they apply the kids policy)
- Test: `backend/test/admin-profiles.test.ts`

**Interfaces:**
- Consumes: `createProfile`, `deleteProfile`, `applyRole`, `setDeviceKids`, `KIDS_RATINGS` (`profiles.ts`), `invalidateRights`.
- Produces: PATCH body gains `kids: boolean` and `maxRating: 0 | 6 | 12` (`.strict()`; refine: at least one field); owner profile + `kids` → 400 `owner_not_kids`; `maxRating` without kids (and not turning kids on) → 400 `not_kids`; a kids change re-applies that identity (`applyRole(ctx, p.jellyfin_user_id, user.role, user.disabled, { userId, hidden: true })`); kids → off clears `devices.kids_profile_id = pid` rows; audit `profile.admin_update` with from/to of `kids`, `maxRating`.
- `POST …/profiles` `{ name: 1–20, kids: z.literal(true), maxRating, avatar? }` → 201 `{ profile }` via `createProfile` (its 409 `max_profiles` / `name_taken` pass through); audit `profile.admin_create { profile, maxRating }`.
- `DELETE …/profiles/:pid` → owner 400 `owner_profile`; else `deleteProfile`; audit `profile.admin_delete { profile }` (no name).

- [ ] **Step 1: Write the failing tests** — `switch a profile to kids with cap 6` → Jellyfin policy POST for that identity has `MaxParentalRating 6` and the unrated block; `kids off clears the device lock` → `devices.kids_profile_id` null; `owner cannot become kids` → 400; `create a kids profile` → 201, `kids true`, policy applied; at 5 profiles → 409; `delete removes the profile and its identity` (fake Jellyfin DELETE called), owner → 400; audit metas hold no names or PINs.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w backend vitest run test/kids.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(people): admins manage kids profiles`

### Task 11: "Can this profile see it?" — `/check` and the `findItems` seam

**Implementer:** Opus (hard: admin-key search, privacy) · backend

**Files:**
- Modify: `backend/src/media/types.ts` (`MediaAdmin.findItems?`), `backend/src/jellyfin/service.ts` + `backend/src/jellyfin/client.ts` (admin search + ancestor library), `backend/src/plex/service.ts` (library search; `librarySectionTitle`), `backend/src/routes/adminUsers.ts` (`GET` and `POST /api/admin/users/:id/check`)
- Create: `backend/src/viewcheck.ts`
- Test: `backend/test/view-check.test.ts`, `backend/test/plex-findItems.test.ts`

**Interfaces:**
- Consumes: `effectiveRights` (Task 2), `jfUserFor`, `getProfile` (`profiles.ts`), `serviceUser` (`previews.ts`), `ratingAge` (`reco/score.ts`).
- Produces: `MediaAdmin.findItems?(q: string, limit: number): Promise<Array<{ id: string; name: string; year?: number; type: 'Movie' | 'Series'; rating: string | null; library: string }>>` (Jellyfin: `/Items?searchTerm=&Recursive=true&IncludeItemTypes=Movie,Series&Limit=` with the admin key, library = the `CollectionFolder` from `/Items/{id}/Ancestors`, max 8 lookups; Plex: section search, `librarySectionTitle`).
- Produces (`viewcheck.ts`): `export async function checkTitles(ctx: Ctx, user: UserRow, profile: ProfileRow, query: string): Promise<CheckHit[]>` with `CheckHit = { id; name; year?; type; visible: boolean; why: 'library' | 'rating' | 'unrated_kids' | null; rating: string | null; library: string }` — visible = `ctx.jf.item(jfUserFor(user, profile), id)` succeeds; `why` derived from the admin facts and `effectiveRights` (library not in effective list → `library`; `ratingAge(rating) > cap` → `rating`; kids and `ratingAge` null → `unrated_kids`); without `findItems` the search runs as `serviceUser` and `why` is null. `export async function libraryCounts(ctx, user, profile): Promise<Array<{ id; name; visible: boolean; seen: number | null; total: number }>>` (ruling 1; `ctx.jf.items` with `limit: 0` as the profile identity and as the service user; cached 10 min in KV `viewcnt:<pid>`).
- Routes: `POST /api/admin/users/:id/check` `{ profileId: uuid, query: string 2–100 }` → `{ hits }`; `GET /api/admin/users/:id/check?profile=` → `{ libraries }`; both `config.rateLimit { max: 30, timeWindow: '1 minute' }`; profile of another account → 404; audit `user.check_viewed` `{ profile, hits: n }` / `{ profile, libraries: n }` — never titles or the query.

- [ ] **Step 1: Write the failing tests** — fake Jellyfin with *Dunmoor* (FSK-16, *Serien*), *Saltwater Almanac* (FSK-6, *Kinder*), *Wrenfield Pier* (unrated, *Filme*): guest (cap 12) owner → Dunmoor `visible false, why 'rating'`; role `libraries: ['Kinder', 'Serien']` → Wrenfield `why 'library'`; kids profile cap 12 → Wrenfield `why 'unrated_kids'`; Saltwater `visible true, why null`; `without findItems the service user searches and why is null`; `audit holds counts only` (meta JSON contains neither `Dunmoor` nor the query); `query of 1 char → 400`; `foreign profile → 404`; `library counts` → *Filme* `seen 1, total 1`, *Serien* `visible false, seen null`; Plex `findItems` maps `librarySectionTitle`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(people): check which titles a profile can see`

### Task 12: Audit filters, `area=people`, docs and CHANGELOG for PR 0a

**Implementer:** Sonnet (routine) · backend + docs

**Files:**
- Modify: `backend/src/routes/admin.ts` (`GET /api/admin/audit` gains `target` and `area`), `docs/security.md` (roles section: catalogue, permissions, overrides, kids overlay, admin lock, the check view is audited and never stores titles), `docs/setup.md` (`ROLE_TEMPLATES` note: keeps working, roles now editable under *Personen → Rollen & Rechte*, `.env` values apply below the admin's), `docs/privacy.md` (one sentence: admins can check which titles a profile can see), `CHANGELOG.md` *Unreleased* (Phase 0a lines + the rollback caveat of spec §5: "Vor einem Rückschritt auf 3.3: Personen in selbst angelegten Rollen in eine eingebaute Rolle verschieben.")
- Test: `backend/test/admin-people.test.ts` (new audit cases)

**Interfaces:**
- Produces: `target=<uuid | role key>` (`z.union([uuid, z.string().regex(ROLE_KEY_RE)])`, exact match on `a.target`), `area=people` → `split_part(a.action, '.', 1) in ('user','role','invite','profile','device')`; both combine with the existing filters.

- [ ] **Step 1: Write the failing tests** — `target filters one role's history` (two `role.update` on guest, one on family → `target=guest` answers 2); `area=people excludes list and settings entries`; `old role.* actions stay readable` (seed `role.request_limit` → listed under `area=people`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement + write the docs.** **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(audit): target and people-area filters; docs for roles and rights`

**PR 0a boundary:** open the PR after Task 12 (title `feat: users & permissions backend (Live TV phase 0a)`); the old admin pages keep working against the new API.

---

## PR 0b — Rollen & Rechte (Tasks 13–16)

### Task 13: Web rights model

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/admin/rights/model.ts`, `web/src/lib/admin/rights/model.test.ts`
- Modify: `e2e/mocks/admin.ts` (a stateful `matrix` mock for `GET/PUT/POST/DELETE /api/admin/roles*` with three built-ins + one env role, `features` switchable, PUT `policy_partial` switchable)

**Interfaces:**
- Consumes: the `matrix` answer (Task 3), `PermKey` (`#lib/perms`).
- Produces (`model.ts`): `export interface MatrixField` / `MatrixRole` / `RoleMatrix` mirroring spec §4.1 + `features` + `missingLibraries`; `export function visibleFields(m: RoleMatrix): MatrixField[]` (drops `requires` whose feature is off); `export function cellText(f: MatrixField, v: unknown, libCount: number): string` (`✓`/`–` for bool; `"2"`; `"20 Mbit/s"` from bit/s with one decimal under 10; `"1080p"` / `adminPeople.roles.ratingAll`-style "alle" for null height; rating `"ab 12"` / `"alle"`; libraries `"alle"` or `"3 Bibliotheken"`); `export function cellName(role: string, f: MatrixField, v: unknown, changed: boolean): string` (accessible name "Gast, Altersfreigabe: ab 12, geändert"); `export type Stage = Record<string /*role*/, Record<string /*field*/, unknown>>`; `export function stageSet(s: Stage, m: RoleMatrix, role: string, key: string, v: unknown): Stage` (setting the loaded value back removes the entry); `export function stageBodies(s: Stage): Record<string, Record<string, unknown>>` (perm keys nested under `perms`); `export function stageCounts(s: Stage, m: RoleMatrix): { changes: number; roles: number; people: number; profiles: number; policy: boolean }`; `export function reviewLines(s: Stage, m: RoleMatrix): Array<{ role: string; field: string; from: string; to: string }>`; `export function summaryLine(r: MatrixRole): string` (the 2-line phone summary "2 Streams · 20 Mbit/s · ab 12 · Downloads aus"). Locale keys of spec §7 (`adminPeople.roles.*` cells, groups, fields) in all seven languages.

- [ ] **Step 1: Write the failing tests** — `cellText` table (bool, int, bitrate 8 000 000 → "8 Mbit/s", 1 500 000 → "1,5 Mbit/s", height null → "alle", rating 12 → "ab 12", libraries 3 → "3 Bibliotheken"); `stageSet back to the loaded value clears it`; `stageCounts` (3 changes in 2 roles, people = sum of `accounts`, `policy` true when a media field is staged); `stageBodies nests perms`; `visibleFields hides requests without the service and Live TV always`; `summaryLine` per language (de, en).
- [ ] **Step 2: Run** `npx -w web vitest run src/lib/admin/rights/model.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/i18n/i18n.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): role matrix model with staging and formatting`

### Task 14: Role matrix (desktop), save bar, review sheet

**Implementer:** Opus (hard: keyboard grid, staging, partial-failure flow) · frontend

**Files:**
- Create: `web/src/lib/admin/rights/RoleMatrix.svelte`, `web/src/lib/admin/rights/FieldControl.svelte`, `web/src/lib/admin/rights/CellPopover.svelte`, `web/src/lib/admin/rights/SaveBar.svelte`, `web/src/lib/admin/rights/ReviewSheet.svelte`, `web/src/lib/admin/rights/gridKeys.ts`, `web/src/lib/admin/rights/gridKeys.test.ts`
- Modify: `web/src/routes/admin/roles/+page.svelte` (rewritten: loads the matrix, desktop ≥ 900 px renders `RoleMatrix`; below 900 px the old card list stays until Task 16), `web/src/lib/admin/glass.test.ts` (contrast pairs: amber `--warn` outline on `.panel`, muted role value `.72` white, changed-dot), locales
- Test: `e2e/tests/admin-roles.spec.ts`

**Interfaces:**
- Consumes: `model.ts` (Task 13); `PUT /api/admin/roles/:role` (Task 3).
- Produces: `SaveBar.svelte` props `count: number; text: string; busy: boolean; progress: string | null; error: string | null` events `discard`, `review`, `retry`; `role="region"` named "Ungespeicherte Änderungen", polite live count; sets `--savebar-h` on `document.documentElement` before it animates in (`barRise`), clears it after out. `FieldControl.svelte` props `field: MatrixField; value: unknown; placeholder?: unknown; libraries: Array<{ id; name }>` event `change` (Toggle / Field / Select with presets / library checklist) — reused by Tasks 15 and 19. `gridKeys.ts`: `export function moveCell(pos: { r: number; c: number }, key: string, rows: number, cols: number): { r: number; c: number } | null` (arrows, Home/End, Ctrl+Home/End).
- Behaviour (spec §6.1): sticky group headers and first column; horizontal scroll inside the panel beyond 5 roles; Enter/Space opens the `growBoth` popover from the cell, Escape closes and returns focus; staged cells get the `--warn` outline; admin column switches locked with lock icon + tooltip `adminLocked`; *Änderungen prüfen* opens `ReviewSheet` (`sheetSlide`) with `reviewLines` and the policy sentence; *Speichern* sends one PUT per role sequentially, progress "Aktualisiere {i} von {n} …", a 502 `policy_partial` keeps the stored values, shows `partialRetry` with *Erneut anwenden* (re-sends that role's last body); `beforeNavigate` guard kept.

- [ ] **Step 1: Write the failing tests** — unit `moveCell` (edges, Home/End); e2e (German, mocked): `edit → review → save` (guest *Altersfreigabe* ab 12 → ab 16, bar "1 Änderung in 1 Rolle · betrifft 3 Personen", review line "Gast · Altersfreigabe: ab 12 → ab 16", save → PUT body `{ maxParentalRating: 16 }`); `partial failure offers retry` (mock 502 → message, retry → 200); `grid keyboard` (arrows move, Enter opens, Escape returns focus, cell accessible name contains "geändert" after staging); `admin switches are locked`; `discard clears the outlines`; `the page does not move when the bar appears` (bounding box of the matrix head unchanged).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts src/lib/admin/rights/gridKeys.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): role matrix with staged edits and a save bar`

### Task 15: Role sheet and role menu actions

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/admin/rights/RoleSheet.svelte`, `web/src/lib/admin/rights/DeleteRoleDialog.svelte`, `web/src/lib/admin/rights/RoleHistory.svelte`, `web/src/lib/admin/rights/auditText.ts`, `web/src/lib/admin/rights/auditText.test.ts`
- Modify: `RoleMatrix.svelte` (column head `ActionMenu`: *Bearbeiten*, *Duplizieren*, *Umbenennen*, *Nach links/rechts*, *Verlauf*, *Löschen*; drag handle reorder with `transform` only), locales
- Test: `e2e/tests/admin-roles.spec.ts` (new cases)

**Interfaces:**
- Consumes: `POST /api/admin/roles`, `DELETE /api/admin/roles/:role`, `PUT /api/admin/roles/order` (Task 4), `GET /api/admin/audit?target=` (Task 12), `FieldControl`, `SaveBar`, `Stage` (Tasks 13–14).
- Produces: `auditText.ts` `export function auditSentence(e: { action: string; actorName: string | null; targetName: string | null; meta: Record<string, unknown> }): { text: string; chips: Array<{ label: string; from: string; to: string }> }` — sentences for `role.update`, `role.create`, `role.delete`, `role.order`, `user.rights`, `profile.admin_*`, `user.check_viewed`; the old `role.request_limit` / `role.remote_cap` / `role.downloads` / `role.playback` render as "… changed {field}" without from; reused by Task 22.
- Role sheet (right-hand `.frost-sheet`, `sheetSlide`): label, invitable toggle (absent for admin), every visible field grouped as the matrix, library checklist; stages into the same `Stage`/save bar. Rename = label field focused. Delete: with 0 people a `confirm`; otherwise `DeleteRoleDialog` names "{n} Personen und {i} offene Einladungen bekommen die Rolle:" + role `Select` (409 `role_in_use` counts from the server). Env roles that left `.env` show "nicht mehr in .env"; built-in and env roles have no *Löschen*.

- [ ] **Step 1: Write the failing tests** — unit `auditSentence` (role.update from/to chips; an old `role.playback` entry renders; no raw keys in the text); e2e: `duplicate Familie as Oma & Opa` (new column appears after the last, focus moves to its head); `delete with move` (dialog lists counts, picks *Freund*, column gone, toast with no undo); `move right` reorders and sends `PUT /order`; `history sheet lists the role's entries`; `role sheet edits stage into the save bar`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): role sheet, duplicate, delete with move, order and history`

### Task 16: Phone role cards, *Vergleich*, nav label, settings note

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/admin/rights/RoleCards.svelte`, `web/src/lib/admin/rights/CompareView.svelte`
- Modify: `web/src/routes/admin/roles/+page.svelte` (≤ 899 px: segmented `SlidePill` *Rollen* / *Vergleich*; cards; the old card form removed), locales `admin.ts` (`tabs.roles` = "Rollen & Rechte" / "Roles & rights") and the settings page text for `ROLE_TEMPLATES` (spec §5 step 4 sentence) in all seven languages
- Test: `e2e/tests/admin-roles.mobile.spec.ts`

**Interfaces:**
- Consumes: `summaryLine`, `stageSet` (Task 13), `RoleSheet` (Task 15, opened full-screen on phones), `SaveBar` (Task 14).
- Produces: `CompareView` props `matrix: RoleMatrix; stage: Stage` — a field `Select` ("Wer darf übertragen?" = `compareQ` with the field label) and all roles as rows with the cell control; edits stage like the matrix.

- [ ] **Step 1: Write the failing tests** (phone project): `cards show name, people and summary`; `tap opens the sheet full-screen and stages`; `Vergleich: who may cast` (switch guest off → save bar "1 Änderung"); nav shows "Rollen & Rechte"; no horizontal page scroll at 360 px.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts`; `E2E_PORT=… npx playwright test tests/admin-shell.spec.ts tests/admin-shell.mobile.spec.ts --trace off` (nav label); root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): role cards and compare view on phones`

**PR 0b boundary:** open the PR after Task 16 (`feat(admin): Rollen & Rechte`).

---

## PR 0c — Personen (Tasks 17–22)

### Task 17: Users page: summary strip, filter chips, columns, bulk

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/admin/userFilters.ts`, `web/src/lib/admin/userFilters.test.ts`
- Modify: `web/src/routes/admin/users/+page.svelte`, `web/src/lib/admin/nav.ts` (`BadgeKey` gains `'approvals'`; *Personen* item `badge: 'approvals'`), `web/src/lib/admin/summary.ts` (from Task 8), `e2e/mocks/admin.ts` (users rows `overrides`, `kidsProfiles`, `note`; filters; bulk `perm`/`repair`), locales (`adminPeople.summary.*`, `users.overrides`, `filter*`, `clearFilters`, `bulk.perm`, `bulk.repair` — spec §7)
- Test: `web/src/lib/admin/userFilters.test.ts`, `e2e/tests/admin-people.spec.ts`, `e2e/tests/admin-people.mobile.spec.ts` (new cases)

**Interfaces:**
- Consumes: `GET /api/admin/users` filters and row fields, bulk `perm` / `repair` (Task 9), `pending.approvals`, `users.expiring` (Task 8).
- Produces (`userFilters.ts`): `export interface UserFilters { q: string; role: string | null; status: string | null; lastActive: string | null; overrides: boolean; kids: boolean; noMfa: boolean; perm: { key: PermKey; on: boolean } | null }`; `export function toQuery(f: UserFilters): URLSearchParams`; `export function fromQuery(p: URLSearchParams): UserFilters`; `export function activeChips(f: UserFilters): Array<{ id: keyof UserFilters; label: string }>`.
- Page: four `StatTile`s (*Personen*, *Warten auf Freigabe* amber when > 0 linking to the tab, *Offene Einladungen*, *Läuft bald ab*); one horizontally scrolling chip row (`frost-pill`, active chips `--fr-sel` with ×, *Alle Filter löschen*; *Ohne 2FA* only with the Authentik API); columns *Ausnahmen* (badge → `?tab=rights` of that person), profiles with kids count, note tooltip; bulk bar *Recht setzen…* (perm `Select` + *Erlauben* / *Verbieten* / *Wie Rolle*) and *Richtlinien neu anwenden* with the existing confirm.

- [ ] **Step 1: Write the failing tests** — unit: `toQuery`/`fromQuery` round trip incl. `perm=cast:off`; e2e: `summary tiles and approvals badge` (mock 2 approvals → badge "2"); `filter chips` (tap *Mit Ausnahmen* → request has `overrides=1`, chip filled, × clears); `bulk Recht setzen` (select Anna + Ben, *Übertragen* → *Verbieten* → confirm names both → body `{ action: 'perm', perm: 'cast', value: false }`); phone: chip row scrolls, no page scroll.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): people summary, rights filters and bulk rights`

### Task 18: Shared `RolePicker` in invites and approvals

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/admin/RolePicker.svelte`
- Modify: `web/src/lib/admin/InvitesPanel.svelte`, `web/src/lib/admin/ApprovalsPanel.svelte`
- Test: `e2e/tests/admin-people.spec.ts` (new cases)

**Interfaces:**
- Consumes: `matrix.roles` (`invitable`, `position`), `summaryLine` (Task 13).
- Produces: `RolePicker` props `roles: MatrixRole[]; value: string; includeAdmin?: boolean` event `change`; options in catalogue order, invitable only (+ admin when `includeAdmin`), each with its one-line summary; built on `Select`.

- [ ] **Step 1: Write the failing tests** — `invite offers the env role with its summary` (mock role *Oma* → option "Oma · 2 Streams · ab 12 · keine Downloads", POST body `role: 'oma'`); `approval offers Admin, invite does not`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): one role picker with summaries for invites and approvals`

### Task 19: Detail *Rechte* tab

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/admin/user/Rights.svelte`, `web/src/lib/admin/user/rights.ts`, `web/src/lib/admin/user/rights.test.ts`
- Delete: `web/src/lib/admin/user/Limits.svelte` and the limits helpers in `web/src/lib/admin/user/detail.ts` (`Limits`, `LIMIT_FIELDS`, `limitsForm`, `parseLimit`, `limitsPatch`, `roleHint`) with their tests
- Modify: `web/src/lib/admin/user/detail.ts` (`DETAIL_TABS = ['overview', 'rights', 'check', 'profiles', 'devices', 'downloads', 'activity', 'audit']`; `detailTab('limits')` → `'rights'` so old links work), `web/src/routes/admin/users/[id]/+page.svelte`, `e2e/mocks/admin.ts` (`GET/PUT /rights`), locales (`adminPeople.rights.*`, `adminPeople.detail.tabs.rights`, `tabs.check`; `rights.missingLibrary` DE "nicht mehr vorhanden" / EN "no longer available")
- Test: `web/src/lib/admin/user/rights.test.ts`, `e2e/tests/admin-user-detail.spec.ts`, `e2e/tests/admin-user-detail.mobile.spec.ts`

**Interfaces:**
- Consumes: `GET/PUT /api/admin/users/:id/rights` (Task 5), `FieldControl`, `SaveBar` (Task 14), `visibleFields`, `cellText` (Task 13).
- Produces (`rights.ts`): `export type Tri = 'role' | 'allow' | 'deny'`; `export function triOf(row): Tri`; `export function rightsPatch(rows, staged: Record<string, unknown>, note: string | null, savedNote: string | null): { overrides: Record<string, unknown>; note?: string | null } | null`.
- Tab: groups as the matrix; per row label, muted role value, control (switches: 3-way `radiogroup` *Wie Rolle · Erlauben · Verbieten*; numbers: `FieldControl` with the role value as placeholder + *Wie Rolle* reset), source chip (*Rolle* / *Ausnahme* / *Kinderprofil* / *Admin* / *.env*); *Notiz* field (≤ 200, counter); missing libraries flagged; staged into `SaveBar`; save → `PUT /rights`, 502 `policy_partial` → message with *Erneut anwenden*.

- [ ] **Step 1: Write the failing tests** — unit: `triOf`, `rightsPatch` (only changed keys; back to role → `null`; note unchanged → absent); e2e: `3-way switch` (*Übertragen* → *Verbieten* → bar → save body `{ overrides: { cast: false } }`, chip *Ausnahme*); `note` (typed note saved, tooltip in the list after reload); `old ?tab=limits opens Rechte`; `a missing library shows as not available`; phone: rows stack, no page scroll.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/user/detail.test.ts src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): Rechte tab with per-person exceptions`

### Task 20: Detail *Profile* tab: kids admin

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Modify: `web/src/lib/admin/user/Profiles.svelte`, `e2e/mocks/admin.ts` (PATCH `kids`/`maxRating`, POST, DELETE), locales (`adminPeople.profiles.*` — spec §7)
- Test: `e2e/tests/admin-user-detail.spec.ts` (new cases)

**Interfaces:**
- Consumes: Task 10 routes.
- Behaviour: per profile row avatar, name, kids `Toggle` (absent on the owner), age cap `Select` 0/6/12 (kids only; its row space reserved so toggling kids does not move the list), PIN state + *PIN zurücksetzen*, last used, `ActionMenu` *Umbenennen* / *Löschen* (`confirm` with `deleteBody`); *Kinderprofil anlegen* button opens a small sheet (name, cap), disabled with hint at 5 profiles.

- [ ] **Step 1: Write the failing tests** — `switch Carla's second profile to kids, cap 6` (PATCH bodies); `create a kids profile` (POST body, new row); `delete asks and removes`; `owner row has no kids switch`; `at 5 profiles the create button is disabled with hint`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): manage kids profiles from the person page`

### Task 21: *Sicht prüfen* tab and the privacy sentence

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/admin/user/CheckView.svelte`, `web/src/lib/admin/user/checkText.ts`, `web/src/lib/admin/user/checkText.test.ts`
- Modify: `web/src/routes/admin/users/[id]/+page.svelte` (tab `check`), `e2e/mocks/admin.ts` (`GET/POST /check`), the account page privacy text (locale `account.ts` sentence: DE "Admins können prüfen, welche Titel ein Profil sehen kann." EN "Admins can check which titles a profile can see."), locales `adminPeople.check.*` (spec §7 plus the sentence keys below)
- Test: `web/src/lib/admin/user/checkText.test.ts`, `e2e/tests/admin-user-detail.spec.ts` (new cases)

**Interfaces:**
- Consumes: `GET /rights?profile=` (Task 5), `GET/POST /check` (Task 11).
- Produces (`checkText.ts`): `export function summarySentences(name: string, rows: RightsRow[], libs: { visible: number; total: number }, kids: { maxRating: 0 | 6 | 12 } | null): string[]` — one key per sentence (spec §7 note), keys and DE / EN:
  - `check.s.libsAll` "{name} sieht alle Bibliotheken." / "{name} sees all libraries."; `check.s.libsSome` "{name} sieht {n} von {m} Bibliotheken." / "{name} sees {n} of {m} libraries."
  - `check.s.ratingAll` "Keine Altersgrenze." / "No age limit."; `check.s.ratingCap` "Titel bis FSK {n}." / "Titles rated up to {n}."
  - `check.s.streams` "Bis zu {n} gleichzeitige Streams." / "Up to {n} streams at once."; `check.s.remote` "Unterwegs höchstens {mbit} Mbit/s." / "Away from home at most {mbit} Mbit/s."
  - `check.s.downloadYes` "Darf herunterladen." / "May download."; `check.s.downloadNo` "Darf nicht herunterladen." / "May not download."
  - `check.s.permsYes` "Darf: {list}." / "May: {list}."; `check.s.permsNo` "Darf nicht: {list}." / "May not: {list}." (`list` via `Intl.ListFormat` of the field labels)
  - `check.s.kids` "Kinderprofil: ab {n}, Titel ohne Freigabe sind ausgeblendet, keine Kommentare, keine Partys." / "Kids profile: from {n}, unrated titles are hidden, no comments, no parties."
- Panel: profile switcher chips (owner first, kids marked); *Kurzfassung*; *Bibliotheken* (✓ / –, "Filme · 812 von 1 204" via `libCount`); *Titel prüfen* search (debounced 300 ms, min 2 chars, results as compact rows with "sichtbar" or the reason text `hiddenRating` / `hiddenLibrary` / `hiddenUnrated`); no *Live-TV* section (Live TV not installed in Phase 0; it is added by Live TV Phase 1).

- [ ] **Step 1: Write the failing tests** — unit: `summarySentences` for a guest (de, en) and a kids profile; e2e: `kids profile view` (chips switch to the kids profile → *Kinderprofil* sentence, library counts); `title check` (type "Dunmoor" → row "ausgeblendet · Freigabe FSK-16 über FSK 12"); `nothing is sent under 2 chars`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): Sicht prüfen shows what a profile can see`

### Task 22: Audit page area/target filters and *Verlauf* sentences

**Implementer:** Sonnet (routine) · frontend + docs

**Files:**
- Modify: `web/src/routes/admin/audit/+page.svelte` (*Bereich* filter `Select` with *Personen*; target filter set from links `?target=`), `web/src/lib/admin/user/Audit.svelte` (renders with `auditSentence`), `e2e/mocks/admin.ts` (audit `area`/`target`), locales (`adminPeople.audit.area`, `people`), `CHANGELOG.md` *Unreleased* (PR 0b + 0c lines)
- Test: `e2e/tests/admin-people.spec.ts` (new cases)

**Interfaces:**
- Consumes: `GET /api/admin/audit?area=&target=` (Task 12), `auditSentence` (Task 15).

- [ ] **Step 1: Write the failing tests** — `Bereich Personen filters` (request has `area=people`); `person Verlauf reads as sentences` ("Ben Muster hat für Anna *Übertragen* verboten (vorher: wie Rolle)."); `a role's history link opens the audit page filtered by target`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): people audit area and readable history`

**PR 0c boundary:** open the PR after Task 22 (`feat(admin): Personen remodel`).

---

## Self-review (done while writing; fixes are inline above)

- **Spec coverage:** §1 → Tasks 2, 6; §2.1 → 1, 4; §2.2 → 6, 7; §2.3 → 5; §2.4 → 8, 17, 18; §3 → 1, 2; §4.1 → 3, 4; §4.2 → 5, 11; §4.3 → 10; §4.4 → 9; §4.5 → 3, 5, 10, 11, 12; §5 → 1, 3, 5, 12 (step 5 is the next release); §6.1 → 13–16; §6.2 → 17; §6.3 → 19, 20; §6.4 → 11, 21; §6.5 → 18; §6.6 → 15, 22; §7 → copy in the owning tasks; §8 → 14 (grid, save bar region, contrast pairs), 19 (radiogroups), 17 (chips `aria-pressed`); §9 → each task's tests; §10 → the three PRs. Live TV rows: registry entries from Task 2, hidden via ruling 3.
- **Type consistency:** `PermKey` / `Perms` (backend `perms.ts`, web `#lib/perms`) identical key lists; `RightKey` and `MatrixField.key` share the names `remoteMaxBitrate` (column `remote_bitrate` only inside `limits.ts`); `"unlimited"` literal used the same way in `rolePatch`, `/rights` and the web model; `effectiveRights` / `roleRights` / `accountsWithout` / `invalidateRights` names used consistently in Tasks 3–11.
- **Proportion:** the plan fixes names, encodings, routes, error codes and tests; bodies are left to the implementers except the slug rule and the sentence copy, which the spec does not determine.
