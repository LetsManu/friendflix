# Notifications Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bell dropdown with variant B: a right-hand side sheet with sections, grouped rows, filters, read/clear with undo, and endless scrolling. The same rows appear inline on *Mein Bereich*.

**Architecture:**
- **Backend:**
  - Each notification gains `group_key` and `hidden_at`.
  - Broadcasts get per-person `notification_state`.
  - One feed query returns sections and groups per page, on an opaque cursor.
  - New `read`, `hide` and `unhide` routes expand group ids on the server.
  - A daily retention job deletes entries older than 90 days.
- **Web:** a `lib/notifications/` module (types, feed store, category map) and two components: `NoteRow.svelte` and `NotificationSheet.svelte`. The sheet replaces the DeskBar dropdown; /me reuses `NoteRow`.
- **Compatibility:** the legacy `GET /api/notifications` keeps its shape for the Android poller.

**Tech Stack:** Fastify, Postgres, `MemoryKV`/Redis kv, vitest (backend `TEST_DATABASE_URL`); SvelteKit with Svelte 4 syntax, vitest, Playwright e2e under `e2e/`.

**Spec:** `docs/superpowers/specs/2026-11-17-notifications-center-design.md`. It includes the "Decisions after the builder check"; read the whole spec.

## Global Constraints

- **UI:**
  - Animate only transform and opacity. Never scale text. Nothing may jump: reserve space for the pill, errors, skeleton pages and the end-of-list text.
  - 44 px touch targets (36 px for mouse only).
  - Glass look (`.frost`, `--fr-r-sheet` for the sheet), brand tokens `--acc*`.
  - Respect `prefers-reduced-motion`.
  - Web statements coverage ≥ 94 %.
- **Locales:** 7 locales (de, en, es, fr, it, pl, tr) with identical key order. German is the source, in the "du" form, with real umlauts. Use "…", never "...". New keys go in a new area `notes` (registered in every `locales/<lang>/index.ts`), except the existing `shell.bell.*` and `account.me.*` keys, which stay where they are.
- **Copy:** never "Netflix" or "Seerr" in user-facing text, code comments or docs. Fictional names (Anna Beispiel, Ben Muster, Nordlicht, Hafenkanal, Sternwarte 24) and placeholder hosts only.
- **Kids profiles:** every `/api/notifications*` route keeps `npre` (403 `kids_profile`).
- **Legacy endpoint:** `GET /api/notifications` keeps its fields (`id` numeric, `kind`, `title`, `body`, `link`, `created_at`, `read`), its newest-first order and limit 30. It only gains: hidden entries are left out, and `read` follows the combined rule.
- **Migration:** append exactly one new entry at the end of `MIGRATIONS` in `backend/src/db.ts`, with a `// N: notifications center` comment, rerunnable (`if not exists`).
  - When this branch is built, the last entry is 59, so the new one is 60.
  - If main already has a 60 when this branch merges (the managed media server adds one), the merge puts this entry after it. Never renumber an existing entry.
- **Checks agents run:** typecheck, the specific tests, build and lint. CI runs the rest.
  - Backend: `cd backend && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json --noEmit`, then `cd backend && TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/ff_test_notes npx vitest run test/<file>`. If the cluster is down, start it with `pg_ctlcluster 16 ffci start`. Create the DB once with `createdb -h 127.0.0.1 -p 5433 -U postgres ff_test_notes` if missing.
  - Web: `cd web && npx svelte-kit sync && npx svelte-check --threshold error` (4 known env errors in `routes/manifest.webmanifest/+server.ts` and `routes/cast-receiver/+server.ts`); `cd web && npx vitest run <file>`; `npm run build -w web`.
  - e2e: `flock /tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/e2e.lock -c 'cd e2e && E2E_PORT=<free> PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx playwright test <spec> --trace off'`.
  - `npx eslint <touched files>`.
- **Dependencies:** `node_modules` is a shared symlink: never run `npm install`, and add no new dependency.
- **Git:**
  - Merge, never rebase or force-push. Never `git stash`. Never `git add -f .superpowers`. Add only the files the task names.
  - Every commit ends with:
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
    `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`
- **Exact values:**

  | What | Value |
  |---|---|
  | Retention | 90 days (`RETENTION_DAYS = 90`) |
  | Feed page | 30 groups per page, at most 20 `items` per group |
  | Undo | kv `notes:undo:<token>` (token = 16 random bytes, base64url), TTL 30 s; web toast 5 s |
  | Sections | `today` (the viewer's calendar today), `week` (the 6 calendar days before today), then `YYYY-MM` per calendar month |
  | Filters | `all`, `unread`, or a category |
  | Categories | `downloads`, `devices`, `series`, `achievements`, `livetv`, `system`, `requests`, `social`, `other` |
  | Never grouped (kinds) | `update_available`, `update_failed`, `syscheck_problem`, `pin_locked`, `deletion_requested`, `deletion_done`, `deletion_failed`, `deletion_restored`, `access_ended`, `access_soon` |
  | Poll | unchanged 60 s; it now calls `GET /api/notifications/feed?limit=0` |

## Review Focus

- **Shared broadcasts:** if Anna clears or reads a broadcast, it stays unread and visible for Ben (Task 3 test).
- **Large groups:** a group with more entries than the 20 `items` (*Fernseher verbunden 25×*) is read and cleared completely, and undo restores all 25 (Task 3 test).
- **Time zones:** a viewer in `America/New_York` sees an entry from 23:30 local time under *Heute*, and the same entry under the previous day for `Europe/Berlin` when it falls on a different calendar day there. An invalid `tz` falls back to the server's `TZ` (Task 2 test).
- **Android poller:** the legacy endpoint answers numeric ids, newest first, at most 30, with `read` computed by the combined rule and without hidden entries (Task 3 test).
- **New entries while reading:** they never move the rows under the reader (*N neu* pill in a reserved slot), and paging adds rows only below the last one (Task 5 e2e).

---

### Task 1: Backend — schema, group key, categories, store notify

**Files:**
- Modify: `backend/src/db.ts` (new migration at the end), `backend/src/notify.ts` (insert stores `group_key`)
- Create: `backend/src/notifications/categories.ts`
- Test: `backend/test/notes-schema.test.ts`

**Interfaces:**
- Migration:
  - `alter table notifications add column if not exists group_key text`, and `add column if not exists hidden_at timestamptz`.
  - Backfill `group_key` for existing rows with the same rule as `groupKey()`, done in SQL:
    - rows whose kind is in the never-grouped list → `'id:' || id`;
    - rows with `msg->'title'->>'key'` → that key;
    - otherwise → `title`.
  - `create table if not exists notification_state(user_id uuid not null references users(id) on delete cascade, notification_id bigint not null references notifications(id) on delete cascade, read_at timestamptz, hidden_at timestamptz, primary key (user_id, notification_id))`.
  - `create index if not exists notifications_created on notifications(created_at)`.
- `categories.ts`:
  - `export type Category = 'downloads'|'devices'|'series'|'achievements'|'livetv'|'system'|'requests'|'social'|'other'`.
  - `export const CATEGORIES: readonly Category[]`, in that order.
  - `export function categoryOf(kind: string): Category`. Map:
    - `download_*` → downloads
    - `tv_paired`, `device_pending` → devices
    - `episode`, `digest`, `available`, `available_all`, `leaving`, `reminder` → series
    - `achievement` → achievements
    - `livetv.*` → livetv
    - `update_*`, `syscheck_*`, `disk_low`, `flow_mail_cap`, `pin_locked`, `playback_check`, `deletion_*`, `access_*` → system
    - `poll_*`, `request_*`, `media_*`, `approval` → requests
    - `party_invite`, `list_invite`, `recommend` → social
    - everything else → other
  - `export const NEVER_GROUPED: ReadonlySet<string>` holds the Global Constraints list.
  - `export function groupKey(kind: string, title: Text, id?: number): string` follows the same rule as the backfill. The `id:` form is used only when the id is known: the insert writes a temporary `'id:pending'` and fills in the real key with `update … set group_key = 'id:' || id` in the same statement via a CTE. Use `returning id` and a second statement if simpler.
  - For a `join` Text, the key is the joined message keys separated by `+`.
  - Every key is prefixed with the kind: `<kind>|<key>`, so different kinds never merge.

- [ ] **Step 1: Write the failing tests** in `notes-schema.test.ts` (`makeEnv`):
  - `categoryOf maps every kind used in backend/src`: read `backend/src` recursively, collect `kind: '<x>'` literals inside `notify(`/`notifyAdmins(` calls, assert none falls to `other` except an explicit allowlist (empty at first).
  - `groupKey groups by kind and message key, never for single kinds`:
    - `groupKey('tv_paired', m('notify.tv.paired', {name:'Wohnzimmer'}))` equals `groupKey('tv_paired', m('notify.tv.paired', {name:'Küche'}))`;
    - `groupKey('update_available', 'x', 7)` is `'update_available|id:7'`;
    - plain-text titles group by text.
  - `notify stores group_key and the migration backfills old rows`:
    - insert two old rows without `group_key` (raw SQL with the column null) and run the migration again: the keys are set;
    - `notify()` twice with the same message key gives two rows with an equal `group_key`.
  - `notification_state cascades`: delete a notification → its state rows are gone.
- [ ] **Step 2: Run** `npx vitest run test/notes-schema.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration, `categories.ts` and the `notify()` insert change.
- [ ] **Step 4: Run** the file plus `test/fixes-notify.test.ts`, `test/i18n-messages.test.ts`, the typechecks and eslint. Expected: PASS. `push.test.ts` and `i18n-messages.test.ts` can fail locally only because of web-push 3.6.7 in the shared `node_modules`; note it, CI decides.
- [ ] **Step 5: Commit** `feat(backend): notification group keys, categories and per-person state table`.

### Task 2: Backend — feed query and route

**Files:**
- Create: `backend/src/notifications/feed.ts`
- Modify: `backend/src/routes/seerr.ts` (register the route next to the existing notification routes)
- Test: `backend/test/notes-feed.test.ts`

**Interfaces:**
- Consumes: Task 1 (`group_key`, `hidden_at`, `notification_state`, `categoryOf`, `CATEGORIES`).
- Produces:
  ```ts
  export type SectionKey = 'today' | 'week' | `${number}-${string}`; // YYYY-MM
  export interface FeedItem { id: number; title: string; body: string | null; at: string }
  export interface FeedGroup { id: string; kind: string; category: Category; title: string; body: string | null; link: string | null; at: string; count: number; unread: boolean; items: FeedItem[] }
  export interface Feed { sections: Array<{ key: SectionKey; groups: FeedGroup[] }>; next: string | null; unread: number; categories: Array<{ key: Category; n: number }> }
  export function visibleSql(): string; // shared WHERE fragment: the person's rows + broadcasts, not hidden (row hidden_at for personal, state hidden_at for broadcasts)
  export function readSql(): string;    // the combined read rule as a SQL boolean expression (spec decision 2)
  export async function feed(ctx: Ctx, userId: string, lang: Language, o: { tz: string; filter: 'all' | 'unread' | Category; cursor: string | null; limit: number }): Promise<Feed>;
  export function groupId(userId: string, groupKey: string, from: Date, to: Date): string;   // opaque, HMAC-signed with ctx.cfg.SESSION_SECRET (or the existing signing helper)
  export function parseGroupId(userId: string, id: string): { groupKey: string; from: Date; to: Date } | null;
  ```
- Route: `GET /api/notifications/feed?cursor=&filter=&tz=&limit=`, with `npre`.
  - `limit=0` answers only `{ unread, categories }`.
  - `limit` defaults to 30 and is capped at 30.
  - `tz` is checked with `Intl.supportedValuesOf('timeZone').includes(tz)`, else `process.env.TZ ?? 'UTC'`.
  - `filter` is validated (unknown → 400 `invalid_filter`).
  - The cursor is opaque base64url JSON `{ s: sectionKey, at: iso, id: number }`, checked with zod (bad → 400 `invalid_cursor`).
- Grouping:
  - Within a section, rows with the same `group_key` form one group.
  - The group's title, body, link and `at` come from its newest row.
  - `count` is the number of rows. `unread` is true if any row is unread.
  - `items` holds the newest 20 rows, rendered through `localizeStored` in `lang`.
  - Groups are ordered by `at` desc. A page ends at a group boundary.
- `unread` and `categories` are global (not filtered). Categories with `n = 0` are left out.
- `filter='unread'` keeps groups that have at least one unread row (count and items still show all rows of the group).

- [ ] **Step 1: Write the failing tests** (`notes-feed.test.ts`, `makeEnv`, rows seeded by SQL with explicit `created_at`):
  - `sections follow the viewer's time zone`: with `now` pinned via `vi.setSystemTime('2026-11-17T04:30:00Z')`, a row at `2026-11-17T04:00:00Z`:
    - `tz=Europe/Berlin` → section `today`;
    - `tz=America/New_York` (23:00 on the 16th) → `week`.
    - A row on 2026-10-02 → `2026-10`.
    - `tz=Mars/Base` behaves like the server `TZ`.
  - `six tv rows become one group with count 6 and the newest title`.
  - `a group with 25 rows has count 25 and 20 items`.
  - `paging never splits a group and next continues after the last group`: seed 70 single-row groups → page 1 has 30, page 2 has 30, page 3 has 10 and `next: null`. No id repeats across pages.
  - `hidden rows and other people's rows never appear; broadcasts appear for everyone`.
  - `read follows the watermark or the state row`:
    - a broadcast older than `users.notifications_read_at` is read;
    - a newer broadcast with a `notification_state.read_at` is read;
    - otherwise it is unread.
  - `filter unread and category`: `filter=devices` shows only the devices groups. `unread` and `categories` in the answer stay global.
  - `limit=0 answers counts only`: the keys are exactly `unread` and `categories`.
  - `bad input`: `filter=xyz` → 400 `invalid_filter`; a garbage cursor → 400 `invalid_cursor`.
  - `kids profile gets 403 kids_profile` (pattern from `kids.test.ts`).
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** `feed.ts` and the route. Do it in one SQL query per page:
  - Window over visible rows with a computed section (`date_trunc` in the `tz` via `at time zone`).
  - Group by section and `group_key`.
  - Order by the max `created_at`, then the max id.
  - Fetch `limit + 1` groups to know `next`.
  - A second query fetches the `items` for the page's groups.
- [ ] **Step 4: Run** the file, `test/fixes-notify.test.ts`, the typechecks and eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): grouped notifications feed with sections, filters and paging`.

### Task 3: Backend — read, hide, undo, legacy list, retention

**Files:**
- Create: `backend/src/notifications/actions.ts`, `backend/src/notifications/retention.ts`
- Modify: `backend/src/routes/seerr.ts` (`POST /read` extended, `POST /hide` and `POST /unhide` new, `GET /api/notifications` uses `visibleSql`/`readSql`), `backend/src/server.ts` (daily retention tick in the `BACKGROUND_JOBS` block, next to `updateAlertTick`)
- Test: `backend/test/notes-actions.test.ts`

**Interfaces:**
- Consumes: Task 2 (`visibleSql`, `readSql`, `parseGroupId`), Task 1 (`categoryOf`).
- Produces:
  - `markRead(ctx, userId, sel: Selection | null): Promise<void>`. `null` means today's "everything": it sets `users.notifications_read_at` and every personal `read_at`.
  - `hide(ctx, userId, sel: Selection): Promise<{ undo: string; n: number }>`.
  - `unhide(ctx, userId, token: string): Promise<{ n: number }>`.
  - `type Selection = { ids?: number[]; groups?: string[]; category?: Category | 'unread' | 'all' }`.
  - Bodies are zod strict:
    - `ids` holds at most 200 entries;
    - `groups` holds at most 50 entries, each a valid `groupId` for this person, otherwise 400 `invalid_group`;
    - `category` is one of the filters.
  - `{}` on `/hide` is 400 `invalid_body` (clearing everything needs `category:'all'`).
- Semantics:
  - **Expanding a selection:** a selection expands to the person's visible rows. A group expands to every row with that `group_key` in the group's time range.
  - **Personal rows:** these get `read_at` / `hidden_at` on the row itself.
  - **Broadcasts:** these get an upsert into `notification_state`. Never touch the broadcast row.
  - **Undo token:** `hide` stores `{ personal: number[], broadcast: number[] }` under `notes:undo:<token>` (TTL 30 s).
  - **Undo itself:** `unhide` `take`s the token (unknown or expired → 404 `undo_expired`) and clears exactly those `hidden_at` values for this person.
- `retention.ts`:
  - `notesRetentionTick(ctx, now = new Date()): Promise<number | null>` runs once per server-local day (kv day key `notes:retention:<YYYY-MM-DD>`, `setnx`, like `licenceExpiryTick`).
  - It deletes notifications with `created_at < now - 90 days`; their state rows cascade.
  - It returns the count, or null when it was already done today.

- [ ] **Step 1: Write the failing tests** (`notes-actions.test.ts`, users Anna and Ben as in `fixes-notify.test.ts`):
  - `reading one group of 25 marks all 25`: take the group id from the feed, POST `/read {groups:[id]}`, and the feed's `unread` count drops by that group.
  - `hide and undo a 25-row group`: POST `/hide {groups:[id]}` → `{undo, n:25}`. The feed no longer has it. POST `/unhide {token}` → `n:25`, and the group is back with the same count.
  - `a broadcast cleared by Anna stays for Ben`: Anna hides the broadcast; Ben's feed still has it as unread. Anna reads another broadcast; Ben's is still unread.
  - `clear by category and unread`:
    - `{category:'devices'}` hides only the devices rows;
    - `{category:'unread'}` hides only unread rows;
    - `{category:'all'}` hides everything visible;
    - `{}` → 400.
  - `undo expires`: with fake timers, 31 s later → 404 `undo_expired`. A second use of the same token → 404.
  - `another person's group id is refused` → 400 `invalid_group`.
  - `POST /read without a body keeps today's behaviour`: the watermark is set and personal rows are read.
  - `the legacy list keeps its shape for the Android poller`:
    - keys exactly `id kind title body link created_at read`;
    - `id` is a number; newest first; 30 at most;
    - a hidden row is missing;
    - `read` is true for a broadcast read through `notification_state`.
  - `retention deletes rows older than 90 days once a day`:
    - a row at 91 days is gone, a row at 89 days stays, and the state rows of the deleted one are gone;
    - a second call the same day → null.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** `actions.ts`, `retention.ts`, the routes and the tick (`setInterval(…, 3_600_000)` with `jobFailed(ctx, app.log, 'notes-retention', …)`, guarded by `op()` like its neighbours).
- [ ] **Step 4: Run** the file plus `notes-feed`, `notes-schema`, `fixes-notify`, `kids`, `seerr`, the typechecks and eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): read, clear and undo for notifications; 90-day retention`.

### Task 4: Web — notifications module (types, API, store, category look)

**Files:**
- Create: `web/src/lib/notifications/types.ts`, `web/src/lib/notifications/api.ts`, `web/src/lib/notifications/store.ts`, `web/src/lib/notifications/look.ts`
- Test: `web/src/lib/notifications/store.test.ts`, `web/src/lib/notifications/look.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 (routes and answer shapes, mirrored as types).
- Produces:
  - `types.ts`: `Category`, `FeedGroup`, `FeedItem`, `Feed`, `Filter = 'all' | 'unread' | Category` (mirrors of the backend types).
  - `api.ts`:
    - `feed(o: { filter: Filter; cursor?: string | null; limit?: number }): Promise<Feed>` adds `tz = Intl.DateTimeFormat().resolvedOptions().timeZone`.
    - `counts(): Promise<{ unread: number; categories: Array<{ key: Category; n: number }> }>` (`limit=0`).
    - `markRead(sel?: Selection)`, `hide(sel: Selection): Promise<{ undo: string; n: number }>`, `unhide(token: string)`.
  - `store.ts`: `createFeed(apiImpl = defaultApi)` returns a Svelte store with:
    - state `{ filter; sections; next; loading: 'idle'|'first'|'more'; error: string|null; fresh: number; open: Set<string> }`;
    - methods `load(filter)`, `more()`, `refresh()`, `noteFresh(unreadNow: number)`, `toggle(groupId)`, `read(sel)`, `hide(sel)` (optimistic removal), `undo(token)`.
  - Store rules:
    - `more()` appends a page. A section key that already exists merges its groups at the end of that section and never reorders earlier rows.
    - `noteFresh` sets `fresh` to the number of unread entries above what the loaded first page knows. It never inserts rows.
    - `refresh()` replaces the first page and resets `fresh`.
  - `look.ts`:
    - `iconOf(c: Category): IconName` maps: downloads → `download`, devices → `tv`, series → `film`, achievements → `crown`, livetv → `record`, system → `alert`, requests → `vote`, social → `users`, other → `bell`.
    - `toneOf(c): 'ok'|'info'|'acc'|'warn'|'gold'|'neutral'` maps: downloads ok, devices info, system acc, achievements gold, `download_expiring`/`access_soon` warn (by kind: `toneOf(c, kind)`), the rest neutral.
    - `actionKeyOf(c: Category, kind: string): 'notes.action.view'|'notes.action.devices'|'notes.action.update'|'notes.action.open'` maps: downloads and series → view, devices → devices, `update_available` → update, otherwise → open.
    - `sectionLabel(key, lang)`: `today` → `notes.section.today`, `week` → `notes.section.week`, `YYYY-MM` → the month name with `Intl.DateTimeFormat(lang, { month: 'long' })`, adding the year when it is not the current year.

- [ ] **Step 1: Write the failing tests:**
  - `store.test.ts` (fake api):
    - `more appends below and merges a section`: page 1 ends in `2026-10`, page 2 starts with `2026-10`, so one `2026-10` section results with page-1 rows first.
    - `noteFresh never inserts rows`.
    - `hide removes optimistically and undo puts the group back in place`: same index.
    - `a failed hide puts the group back and sets error`.
    - `filter change reloads from the first page`.
  - `look.test.ts`:
    - every `Category` has an icon that exists in `Icon.svelte`'s name list (read the file as text);
    - `actionKeyOf` cases;
    - `sectionLabel('2026-10','de')` is `'Oktober'` in 2026 and `'Oktober 2025'` for `'2025-10'`.
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/notifications`. Expected: FAIL.
- [ ] **Step 3: Implement** the four modules.
- [ ] **Step 4: Run** the same tests, svelte-check and eslint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): notifications feed store, API and category look`.

### Task 5: Web — the side sheet replaces the bell dropdown

**Files:**
- Create: `web/src/lib/notifications/NoteRow.svelte`, `web/src/lib/notifications/NotificationSheet.svelte`, `web/src/lib/i18n/locales/<lang>/notes.ts` (7)
- Modify: `web/src/lib/i18n/locales/<lang>/index.ts` (7: area `notes`), `web/src/lib/desk/DeskBar.svelte` (the bell opens the sheet; dropdown markup and its CSS removed; no auto-read on open), `e2e/mocks/api.ts` (feed, hide, unhide, read with body; the legacy list unchanged)
- Test: `e2e/tests/notifications.spec.ts`; update `e2e/tests/desk-menus.spec.ts` and `desk-bar.spec.ts` where they assert the old `#ff-notes` dropdown.

**Interfaces:**
- Consumes: Task 4.
- Produces:
  - `NoteRow.svelte`:
    - Props: `group: FeedGroup`, `open: boolean`, `compact = false`.
    - Events: `toggle`, `read`, `hide`, `follow`.
    - Layout: a 40-px icon tile (`iconOf`/`toneOf`) with an unread dot, the title (plus a count chip when `count > 1`), one body line (ellipsis), the relative time (`fmtRelative`), and at most one action link (`actionKeyOf`; none without `link`). A ✕ button shows on hover or focus (always on touch, 44 px). Open items list beneath with time.
    - Accessible name: title, count, "neu", time.
  - `NotificationSheet.svelte`:
    - Props: `trigger: HTMLElement`, `full = false` (full height on phones).
    - Event: `close`.
    - Built on the right-sheet pattern of `web/src/lib/admin/livetv/SheetFrame.svelte` (`sheetSlide`, `scrimFade`, `dialogKeys`, `sheetRoom('right')`, focus back to `trigger`), with `role="dialog"` and `aria-modal`.
    - Header: title, the unread count, a gear link to `/settings?tab=notifications` (check the real notification settings path in the routes and use it), and close.
    - Then the chips (`Alle`, `Ungelesen`, then the categories with `n > 0`).
    - Then a reserved 44-px slot for the *N neu* pill.
    - Then the scroll list: section labels, rows, two skeleton rows reserved while `loading='more'`, and the end text `notes.end` with `{days}`.
    - Footer: `notes.readAll` and the clear button, labelled *Alles leeren* / *<Kategorie> leeren* / *Ungelesene leeren* per filter.
    - Clearing shows a `toast.info(…, { action: { label: notes.undo, run: undo } })` for 5 s. An IntersectionObserver on the end sentinel calls `more()`.
- Locale area `notes` (German source, du-form), keys in this order:
  - `title`
  - `fresh` (plural: '{n} neu')
  - `filter.all` 'Alle', `filter.unread` 'Ungelesen'
  - `category.<each>`:
    - downloads 'Downloads'
    - devices 'Geräte'
    - series 'Serien & Filme'
    - achievements 'Achievements'
    - livetv 'Live TV'
    - system 'System'
    - requests 'Wünsche'
    - social 'Freunde'
    - other 'Sonstiges'
  - `section.today` 'Heute', `section.week` 'Diese Woche'
  - `action.view` 'Ansehen', `action.devices` 'Geräte prüfen', `action.update` 'Aktualisieren', `action.open` 'Öffnen'
  - `readAll` 'Alle gelesen'
  - `clearAll` 'Alles leeren', `clearCategory` '{category} leeren', `clearUnread` 'Ungelesene leeren'
  - `cleared` (plural: '{n} Mitteilung entfernt' / '{n} Mitteilungen entfernt')
  - `undo` 'Rückgängig'
  - `remove` 'Entfernen'
  - `empty` 'Keine Mitteilungen'
  - `end` 'Das waren alle. Mitteilungen werden nach {days} Tagen entfernt.'
  - `error` 'Mitteilungen konnten nicht geladen werden.'
  - `retry` 'Nochmal'
  - `settings` 'Einstellungen'
  - `close` 'Schließen'
  - `newLabel` 'neu'

- [ ] **Step 1: Write the failing e2e** `notifications.spec.ts`. The mock is a stateful feed with 70 groups over 3 pages, 6× tv in one group, and one broadcast.
  - `the bell opens the sheet with sections, groups and chips; the header stays put`:
    - the dialog is visible;
    - *Heute*, *Diese Woche* and *Oktober* are present;
    - "6" appears on the tv row;
    - the header box is the same before and after scrolling to the end.
  - `opening no longer marks everything read`: no `/read` call on open.
  - `a group opens in place and lists its entries`.
  - `scrolling loads more below; rows above keep their position`: the bounding box of the first row is unchanged after page 2 arrives, and the end text appears after page 3.
  - `clearing a category shows Rückgängig and undo brings it back`: `Geräte leeren` → the rows are gone → the toast *Rückgängig* → the rows are back in place, with the same boxes.
  - `new entries show a pill, not rows`: the mock raises the unread count, then `ff-notes` fires → the pill *1 neu* is in the reserved slot and the first row box is unchanged. Clicking the pill reloads the top.
  - `Escape closes and focus returns to the bell`.
  - `kids profile: no bell` (existing behaviour kept).
- [ ] **Step 2: Run** the spec. Expected: FAIL.
- [ ] **Step 3: Implement** the components, the DeskBar change, the locales (7, same key order) and the mocks. Update the old dropdown assertions in `desk-menus.spec.ts` and `desk-bar.spec.ts` to the sheet. Keep the bell button's accessible name and `.dot`.
- [ ] **Step 4: Run** the spec, `desk-menus`, `desk-bar`, `a11y`, `glass-menus`, `motion-frames`, `kids`, the i18n tests (`src/lib/i18n`), svelte-check, the build, eslint, and `cd web && npx vitest run --coverage` for the statements total. Expected: PASS and ≥ 94 %.
- [ ] **Step 5: Commit** `feat(web): notifications side sheet with groups, filters, clear and undo`.

### Task 6: Web — badge, poll, Mein Bereich and phone

**Files:**
- Modify: `web/src/routes/+layout.svelte` (`loadNotes` → `counts()`; `notes` → `unread: number` passed to DeskBar; the 60-s poll and `ff-notes` unchanged in timing; on `ff-notes` an open sheet gets `noteFresh`), `web/src/lib/desk/DeskBar.svelte` (prop `unread: number` instead of `notes`), `web/src/lib/badge.ts` (`syncBadge` uses `counts()`), `web/src/routes/me/+page.svelte` (newest 5 groups via `feed({filter:'all', limit:5})` rendered with `NoteRow compact`; *Alle ({n})* opens `NotificationSheet full`; no auto-read; the old list markup and CSS removed), `web/src/lib/i18n/locales/<lang>/account.ts` (7: drop `me.less` if unused, keep `me.all`, `me.notifications`, `me.noNotifications`), `e2e/mocks/api.ts` (`limit=0` and `limit=5`)
- Test: `web/src/lib/badge.test.ts` (update), `e2e/tests/notifications.mobile.spec.ts`, update `e2e/tests/account.spec.ts` where it asserts the old /me list

**Interfaces:**
- Consumes: Tasks 4–5.
- Produces:
  - The phone has no bell (the header shows the avatar linking to `/me` with the unread dot, unchanged). On /me, *Alle ({n})* opens the sheet full height. This is the controller's reading of spec decision 4 for a header without a bell; ledger it.
  - The bell badge counts every unread entry, with no 30 cap. `setAppBadge` stays capped at 99.

- [ ] **Step 1: Write the failing tests:**
  - `badge.test.ts`: `syncBadge uses the counts endpoint and caps at 99`; kids → 0.
  - `notifications.mobile.spec.ts`, at phone width:
    - `Mein Bereich shows the newest 5 groups and does not mark read`: no `/read` call.
    - `Alle opens the full-height sheet`: the dialog height equals the viewport height minus the safe areas; 44-px targets for chips, ✕ and footer buttons; no horizontal scroll.
    - `swipe or ✕ removes one group with undo`: use ✕ if swipe is not built. Swipe is optional; if not built, ledger it.
  - The desktop badge: `the bell shows 45 when 45 are unread`, with the mock answering `unread: 45`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests plus `account`, `desk-bar`, `home-fast`, `pages`, `kids`, the i18n tests, svelte-check, the build, eslint, and the coverage total. Expected: PASS and ≥ 94 %.
- [ ] **Step 5: Commit** `feat(web): unread badge without cap, Mein Bereich list and full-height sheet on phones`.

### Task 7: Docs and CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (*Unreleased*: notifications center, 90-day retention), the user docs that describe notifications (find them with `grep -ril "benachrichtigung\|notification" docs/`; update the bell description and add the retention note), `docs/superpowers/specs/2026-11-17-notifications-center-design.md` (one line under decision 4: phone has no bell, so /me's *Alle* opens the full-height sheet)
- Test: every relative link in the touched files resolves.

- [ ] **Step 1: Write** the docs (fictional names only; German copies follow the English).
- [ ] **Step 2: Check** the links.
- [ ] **Step 3: Commit** `docs: notifications center`.
