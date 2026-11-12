# Users & permissions remodel (Phase 0 of Live TV) (design)

Date: 2026-11-11 · Status: direction approved by the owner in chat; this spec makes it precise and resolves the rest

## Goal

The *People* part of Admin (users, roles, invites, approvals, profiles) becomes as complete as the best admin areas
(Status, Update, Playback): one place that shows at a glance **what each role may do**, lets an admin give a single person an
exception, manage kids profiles and parental limits, answer "what does this person actually see?", and see who changed what.
It is also the foundation the Live TV block builds on (channel groups per role, per-user group exceptions, "may record"):
Phase 0 of `2026-11-11-live-tv-design.md`.

Owner decisions (chat, 2026-11-11; fixed, not reopened here):

1. Remodel the whole users & permissions section so it is feature-wise on par with the other admin areas.
2. A **role editor** that shows at a glance what each role may do: the features that exist (requests, downloads, casting,
   watch parties, comments, live TV, recording, …), the age-rating limit and (with Live TV) the channel groups.
3. **Per-user overrides**, **kids profiles and parental controls**, **invites and approvals integrated**, a **"What does this
   user see?"** preview, an **audit of changes**, **bulk actions**, **search and filter**.
4. Modern UI with the existing design system (glass `.frost*` / `--fr-*`, existing transitions, sheets, chips, tables, focus
   rings). Admin is desktop and phone only; TV is irrelevant here.
5. **Backwards compatible** with existing roles and data, with a migration plan.

Sources this spec is built from (code as of `main` = 3.3.0):
`backend/src/roles.ts`, `limits.ts`, `users.ts`, `profiles.ts`, `kids.ts`, `invites.ts`, `requestlimit.ts`, `audit.ts`,
`adminlist.ts`, `notify.ts`, `session.ts`, `routes/admin.ts`, `routes/adminUsers.ts`, `routes/auth.ts` (`/api/me`),
`routes/anime.ts`, `routes/party.ts`, `routes/cast.ts`, `settings/registry.ts`, `db.ts` (45 migrations),
`web/src/routes/admin/{users,users/[id],roles,audit,devices}/+page.svelte`, `web/src/lib/admin/**`, the Block 23 spec
`2026-10-14-block23-user-management-design.md`.

## What exists today (fact check)

- **Roles** are four built-ins in code (`roles.ts:29-34`: admin, family, friend, guest) plus whatever the env-only
  `ROLE_TEMPLATES` JSON adds or changes (`roles.ts:38-44`, `settings/registry.ts:184`). `role_settings` (migrations 13, 14, 20,
  34) lets the admin change seven fields per role: requests per month, transcoding, max height, download on/off, max downloads,
  download height, download days, remote bitrate cap (`roles.ts:44-71`, `routes/admin.ts:265-301`).
- **Per-user limits** (`user_limits`, migration 37; `limits.ts`) override five fields: max streams, remote bitrate, max
  downloads, download height, requests per month. `effectiveLimits()` = code ← env ← `role_settings` ← `user_limits`.
- **Kids profiles** (migration 31) carry `kids` + `kids_max_rating` (0/6/12); the parental cap goes into the profile's hidden
  Jellyfin user (`profiles.ts:60-72`); kids get 403 `kids_profile` on social routes (`kids.ts`, `requireGrownUp`).
- **Users page** (`/admin/users`): server-side search, filters (role, status, last active), sort, paging, bulk role / lock /
  unlock / access / sign out, tabs *Waiting for approval* and *Invites*. **Detail page** tabs: overview, profiles, devices,
  downloads, activity (audited), limits, audit.
- **Audit**: `audit_log(actor, action, target, meta)`, page `/admin/audit` with actor / action / date filters.

### Gaps (each fixed below)

| # | Gap | Where | Fixed in |
|---|---|---|---|
| G1 | Roles cannot be created, renamed or reordered in the UI; max streams, max bitrate, age rating and libraries of a role are env-only | `roles.ts:29-44`, `routes/admin.ts:267-276`, `settings/registry.ts:184` | §2, §3 |
| G2 | Invites and approvals only offer the built-in roles: a role added through `ROLE_TEMPLATES` can be set by PATCH but never invited or approved into | `roles.ts:36`, `routes/adminUsers.ts:241`, `:485` | §2.4, §6.5 |
| G3 | Per-user overrides cover 5 fields; no transcoding, max height, download on/off, age rating, libraries, features | `limits.ts:8`, `routes/adminUsers.ts:113-119` | §2.3 |
| G4 | Feature rights are hard-wired to role names instead of being settings: comments hidden for `guest` (`routes/anime.ts:206`, `:211`), the scheduled-party cap waived for `admin` only (`routes/party.ts:40`); casting (`routes/cast.ts:22`) and watch parties have no per-role switch at all | as listed | §2.2, §4 |
| G5 | Admins can only rename a profile or clear its PIN: no kids switch, no age cap, no delete; no way to see what a person can see | `routes/adminUsers.ts:458-480` | §6.3, §6.4 |
| G6 | Role audit entries store only the new value (`routes/admin.ts:290-295`); the audit API has no target filter (`:350-356`); `audit_log` has no index (`db.ts:23`) | as listed | §5 |
| G7 | The roles page shows neither streams, bitrate, age rating, libraries nor how many people a role has; it is a card per role, so roles cannot be compared | `web/src/routes/admin/roles/+page.svelte:20`, `:134-158` | §6.1 |

## Non-goals

- No change to sign-in, Authentik flows, approval/invite mechanics beyond role choice, access-until, deletion (Block 23 stays).
- No impersonation ("log in as"). The preview (§6.4) is read-only and computed; it never creates a session.
- No per-profile permissions for grown-up profiles: rights belong to the **account** (role + overrides); profiles add only the
  kids overlay (as today). Live TV favourites are per profile, which is not a permission.
- No viewing-time limits for kids (roadmap item 3, own block).
- No new admin roles below "admin" (no "moderator"). `admin` stays the only role with admin rights; admin rights are not a
  permission switch.
- Plex: everything here works with Plex (policies go through the media seam as today); the "check a title" probe uses the seam.

## Global constraints (restated project rules)

- **Motion:** only `transform` and `opacity` animate (the stylesheet scan in `web/src/lib/admin/glass.test.ts` refuses others;
  this block adds its files to the scan). Opening and closing both animate (`growBoth`, `sheetSlide`, `barRise` from
  `#lib/glass/fx`). Nothing jumps: rows that can appear (save bar, inline errors, override hints) reserve their space or overlay.
  Calm mode / reduced motion: solid panels (`--fr-solid`), no motion.
- **Look:** existing glass (`.panel`, `.frost`, `.frost-flat`, `.frost-safe`, `.frost-sheet`, `.frost-dim`, `--fr-sel`,
  `--fr-r-*`), existing components (`DataTable`, `StatusPill`, `StatTile`, `Toggle`, `Select`, `Field`, `Button`, `confirm`,
  `runAction` toasts with undo, `AdminCard`, `ActionMenu`, `SlidePill`). No new visual language.
- **i18n:** every string through `#lib/i18n`, in all seven locales (`de` typed source, `en` second; per-language tests fail on a
  missing key). The copy table gives DE and EN.
- **Accessibility:** contrast ≥ 4.5:1 on glass (checked with the tone model as in `glass.test.ts`), targets ≥ 44 px, full
  keyboard operation, visible focus ring, `menuKeys` for menus, dialogs trap and return focus, colour never the only carrier.
- **Words:** never "Netflix" or "Seerr" in user-facing text (the request service is "Wünsche" / "requests").
- Fixtures use fictional people only (Anna Beispiel, Ben Muster, Carla Probe) and placeholder hosts (`friend.example.com`).
- Tests: Vitest unit + Playwright e2e in the existing style; locally the implementer runs only the root `npm run typecheck`
  and the new spec / unit files; CI runs the rest.

---

## 1. The permission model

One model, four layers, resolved per account (and per profile for the kids overlay):

```
code default (DEFAULT_ROLES / DEFAULT_PERMS)  ←  ROLE_TEMPLATES env  ←  role row (DB)  ←  user override (DB)  ←  kids overlay (hard)
```

- **Templates** (numbers and caps, as today's `RoleTemplate`): `libraries`, `maxParentalRating`, `maxBitrate`,
  `remoteMaxBitrate`, `maxStreams`, `transcoding`, `maxHeight`, `download`, `maxDownloads`, `downloadMaxHeight`,
  `downloadDays`, plus `requestsPerMonth` (kept in its own column, see §3).
- **Permissions** (on/off switches, new): a fixed registry in `backend/src/perms.ts`:

| Key | Means | Default admin / family / friend / guest | Shown when |
|---|---|---|---|
| `requests` | may make wishes (the request service) | ✓ / ✓ / ✓ / ✓ | request service set up |
| `cast` | may play on a TV (Chromecast, AirPlay) | ✓ / ✓ / ✓ / ✓ | `CAST_ENABLED` |
| `party` | may start and join watch parties | ✓ / ✓ / ✓ / ✓ | always |
| `partySchedule` | may keep more than 3 scheduled parties | ✓ / – / – / – | always |
| `comments` | may read and write episode/film comments | ✓ / ✓ / ✓ / – | always |
| `liveTv` | may use Live TV at all (channel groups decide which channels) | ✓ / ✓ / ✓ / ✓ | Live TV installed |
| `liveRecord` | may schedule recordings | ✓ / ✓ / ✓ / – | Live TV installed (Phase 3) |

  The defaults reproduce today's behaviour exactly (G4: `comments` false for guest = `anime.ts:206`; `partySchedule` true for
  admin = `party.ts:40`; everything else is allowed today). Downloads stay the existing template field `download` (no duplicate
  switch); the editor shows it in the same matrix.
- **Admin role:** permissions are always all on and locked (shown with a lock icon, not editable); its numbers stay editable.
- **Kids overlay (hard, not editable):** a kids profile never has `requests`, `party`, `partySchedule`, `comments`, `liveRecord`
  and the other grown-up features `requireGrownUp` already blocks (lists, reminders, push, trending, …); its age cap is the
  lower of role/override cap and the profile's 0/6/12 (`kidsPolicy`, unchanged); with Live TV it sees only kid-friendly
  channel groups. The preview (§6.4) shows these as "Kinderprofil" lines.
- **Overrides** can make a person more or less permissive than the role (admin's choice); an override equal to the role value
  is not stored (the API drops it).

`effectiveRights(ctx, user, profile?)` (new, `backend/src/rights.ts`) returns `{ template, perms, sources }` where `sources`
names, per field, which layer decided it (`default | env | role | user | kids | admin`). It replaces the direct
`effectiveLimits()` callers; `effectiveLimits()` stays as a thin wrapper (same return shape) so the ~20 existing callers and
the gateway authz keep working unchanged. Cached 30 s per (ctx, user) like today, invalidated by every write.

## 2. Roles

### 2.1 Role catalogue

Roles become rows (table `roles`, §3), so they can be created, labelled and ordered from the UI (G1):

- **Built-in roles** (`admin`, `family`, `friend`, `guest`): cannot be deleted, their key never changes, their label can be
  changed (`label null` = the translated built-in name, the existing `builtinLabel` rule).
- **Env roles** (keys from `ROLE_TEMPLATES` that are not built-in): synced into `roles` at startup with `origin 'env'`; they
  appear in the editor with a small "aus .env" note; their env template still applies under the DB row (precedence above).
- **Admin roles** (new, `origin 'admin'`): created by **Duplicate** of an existing role (copy of its effective template and
  permissions, stored in full on the new row, so later edits of the source do not leak). Key: slug of the label
  (`^[a-z][a-z0-9_-]{1,23}$`, unique, `-2` appended on clash), never shown to users.
- **Delete** (admin roles only): with 0 accounts directly; otherwise the dialog asks for the target role ("6 Personen und 1
  offene Einladung bekommen die Rolle …") and moves them first (`setRole` per account, audited; open invites updated), then
  deletes. Approval requests carry no role, nothing to move.
- **Order:** drag handle in the editor (keyboard: *Move left/right* in the role's menu); stored in `roles.position`; used by
  every role picker.
- **Invitable:** per role switch (built-ins: admin false, others true; admin never invitable). Invites and approvals offer the
  invitable roles (G2); approval additionally offers `admin` as today.

### 2.2 Enforcement of the new switches (G4)

| Switch | Server | Client |
|---|---|---|
| `comments` | `routes/anime.ts` `isGuest` → `!rights.perms.comments`; the comment list filter `u.role <> 'guest'` (`:211`) → `not (c.user_id = any($n))` with the set of accounts whose effective `comments` is off (`accountsWithout(ctx, 'comments')`, cached 30 s) | comment section hidden as today for guests |
| `partySchedule` | `routes/party.ts:40` `role !== 'admin'` → `!perms.partySchedule` | unchanged |
| `party` | `routes/party.ts` create/join + WebSocket: 403 `party_forbidden` | party entries hidden (`me.perms.party`) |
| `cast` | `POST /api/cast/session`: 403 `cast_forbidden` | *Play on* button / sheet rows hidden |
| `requests` | the request routes' `on` pre-handler: 403 `requests_forbidden` | wishes UI hidden like a missing request service |
| `liveTv`, `liveRecord` | Live TV routes (Live TV spec) | Live TV tab / record buttons |

`/api/me` gains `perms: Record<PermKey, boolean>` (kids overlay applied) and keeps `limits` / `downloads` unchanged. A
missing `perms` (older backend) counts as "everything allowed" in the web (`capabilities.ts` pattern).

### 2.3 Per-user overrides (G3)

Every template field and every permission can be overridden per account (`user_limits`, §3). New override fields:
`transcoding`, `maxHeight`, `download`, `downloadDays`, `maxParentalRating`, `libraries`, `maxBitrate`, `perms`, plus a free-text `note`
("why", max 200 chars, shown in the list tooltip and the detail page). With Live TV: channel-group exceptions per user (Live TV
spec §8). Policies follow as today: any override that the media server enforces (`libraries`, `maxParentalRating`,
`maxStreams`, `maxBitrate`, `transcoding`, `maxHeight`) re-applies the account's identities (`reapplyAccount`), the gateway
forgets the memoised identity (`forgetUserAuth`).

### 2.4 Invites and approvals (integrated)

- Invite form and approval dialog use the shared `RolePicker` (role list from the catalogue, invitable only; each option shows
  a one-line summary from the matrix, e.g. "2 Streams · ab 12 · keine Downloads").
- `POST /api/admin/invites` `role`: any invitable role key (was `z.enum(INVITABLE_ROLES)`); `approve`: invitable roles + admin.
- The users page header gets a summary strip (`StatTile`s): *Personen*, *Warten auf Freigabe* (links to the tab, amber when
  > 0), *Offene Einladungen*, *Läuft bald ab* (access ends within 7 days). The admin nav entry *Personen* gets a badge for
  waiting approvals (new `BadgeKey 'approvals'`; `/api/admin/summary` gains `pending.approvals` = open, not rejected
  `approval_requests`).

## 3. Data model (migration 47)

Migration **47** (controller ruling 2026-11-11: 46 is taken by the device hand-off plan, which builds first; Live TV follows
with 48–50; never reorder). One transaction, rerunnable parts use `if not exists`.

```sql
-- 47: users & permissions remodel. Roles become rows (built-ins seeded; env roles are synced at startup), role_settings and
-- user_limits get the full template + permission overrides as JSON, audit gets indexes. The old role_settings columns stay
-- (dual-written for one release so a rollback to 3.3 reads current values); a later migration drops them.
create table if not exists roles (
  key text primary key check (key ~ '^[a-z][a-z0-9_-]{1,23}$'),
  label text check (label is null or char_length(label) between 1 and 30),
  base text not null,
  origin text not null check (origin in ('code','env','admin')),
  invitable boolean not null default true,
  position int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references users(id) on delete set null
);
insert into roles(key, base, origin, invitable, position) values
  ('admin','admin','code',false,0), ('family','family','code',true,1), ('friend','friend','code',true,2), ('guest','guest','code',true,3)
  on conflict (key) do nothing;
alter table role_settings
  add column if not exists template jsonb not null default '{}',
  add column if not exists perms jsonb not null default '{}';
update role_settings set template =
     (case when transcoding is null then '{}'::jsonb else jsonb_build_object('transcoding', transcoding) end)
  || (case when max_height is null then '{}'::jsonb when max_height = 0 then '{"maxHeight": null}'::jsonb else jsonb_build_object('maxHeight', max_height) end)
  || (case when download is null then '{}'::jsonb else jsonb_build_object('download', download) end)
  || (case when max_downloads is null then '{}'::jsonb else jsonb_build_object('maxDownloads', max_downloads) end)
  || (case when download_max_height is null then '{}'::jsonb else jsonb_build_object('downloadMaxHeight', download_max_height) end)
  || (case when download_days is null then '{}'::jsonb else jsonb_build_object('downloadDays', download_days) end)
  || (case when remote_max_bitrate is null then '{}'::jsonb else jsonb_build_object('remoteMaxBitrate', remote_max_bitrate) end)
  where template = '{}'::jsonb;
alter table user_limits
  add column if not exists transcoding boolean,
  add column if not exists max_height int check (max_height between 0 and 4320),
  add column if not exists download boolean,
  add column if not exists max_bitrate int check (max_bitrate between 300000 and 200000000),
  add column if not exists max_parental_rating int check (max_parental_rating between -1 and 21),
  add column if not exists download_days int check (download_days between 1 and 90),
  add column if not exists libraries jsonb,
  add column if not exists perms jsonb not null default '{}',
  add column if not exists note text check (char_length(note) <= 200);
create index if not exists audit_log_target on audit_log(target, id desc) where target is not null;
create index if not exists audit_log_action on audit_log(action, id desc);
```

Semantics:

- `role_settings.template`: partial `RoleTemplate` (zod `roleTemplateSchema.partial()`); an absent key inherits, an explicit
  JSON `null` means "unlimited" for `maxHeight` and `maxParentalRating` (as `max_height = 0` did). `requests_per_month` stays
  its column (`reserve_request_slot` and `roleLimitFor` read it). For admin-created roles the row holds the full template.
- `role_settings.perms` / `user_limits.perms`: `{ [PermKey]: boolean }`, unknown keys rejected by zod on write and ignored on
  read (a key removed in a later version never breaks a load).
- `user_limits.max_parental_rating`: `null` = as role, `-1` = unrestricted, `0..21` = cap. `download_days`: `null` = as role, `1..90` days. `libraries`: `null` = as role,
  `"all"` or an array of library names (the format of `RoleTemplate.libraries`).
- Old `role_settings` columns: written alongside `template` by `PUT /api/admin/roles/:role` for one release, never read;
  migration "drop old role_settings columns" ships in the release after Phase 0.
- **Startup sync** (`syncRoles(ctx)`, after `migrate`, idempotent): every key of `ctx.roles` without a `roles` row is inserted
  (`origin 'env'`, `base` = key when built-in else `'friend'`, `position` after the last). A `roles` row of origin `env` whose key
  left `ROLE_TEMPLATES` stays (accounts may still hold it) and is shown as "nicht mehr in .env" until deleted or re-added.
- **Role existence:** `Object.hasOwn(ctx.roles, role)` checks (`users.ts:162`, `routes/adminUsers.ts:76`, `:212`,
  `routes/admin.ts:267`) become `roleExists(ctx, key)` (catalogue lookup, cached with the roles). `effectiveRole` resolves an
  admin-created role from `DEFAULT_ROLES[base]` ← `role_settings.template` (full copy).

No data is rewritten except the `template` backfill; every existing role, override, profile, invite and approval keeps working
with identical effective values (unit test: effective rights of every role and user before = after migration on a fixture DB).

## 4. Backend API

All admin routes: `requireAdmin` (admin account acting as its owner profile), CSRF as everywhere, writes run in
`accountSerial` where they touch accounts. Errors use the existing `{ error: code }` shape.

### 4.1 Roles

- `GET /api/admin/roles` — existing fields kept (`roles`, `invitable`, `limits`) for one release, plus:
  ```ts
  matrix: {
    fields: Array<{ key: string; group: 'access'|'playback'|'downloads'|'requests'|'together'|'cast'|'livetv'; kind: 'bool'|'int'|'bitrate'|'height'|'rating'|'libraries';
                    min?: number; max?: number; options?: Array<number|null>; requires?: 'requests'|'cast'|'livetv' }>;
    roles: Array<{ key: string; label: string | null; builtinLabel: boolean; origin: 'code'|'env'|'admin'; invitable: boolean; position: number;
                   accounts: number; profiles: number; kidsProfiles: number;
                   values: Record<string, unknown>;              // effective template + perms (+ requestsPerMonth)
                   sources: Record<string, 'default'|'env'|'role'|'admin'> }>;
    libraries: Array<{ id: string; name: string }>;              // ctx.jf.admin.libraries(), cached 5 min
  }
  ```
- `PUT /api/admin/roles/:role` — partial body; every field optional, `null` = back to the inherited value:
  `label`, `invitable`, `requestsPerMonth`, `maxStreams` (1–50), `maxBitrate` (0.3–200 Mbit/s in bit/s), `remoteMaxBitrate`,
  `transcoding`, `maxHeight` (144–4320 | `"unlimited"`), `maxParentalRating` (0–21 | `"unlimited"`), `libraries`
  (`"all"` | names that exist), `download`, `maxDownloads`, `downloadMaxHeight`, `downloadDays`, `perms` (partial map,
  `null` per key = inherit). Admin role: `perms` refused (400 `admin_perms_locked`). Answer:
  `{ ok: true, reapplied: { identities: number, failed: number } }`; `failed > 0` → 502 `policy_partial` as today (settings
  stored). Policy re-apply runs only when a media-enforced field changed.
- `POST /api/admin/roles` `{ label, from }` → 201 `{ key }` (duplicate). `DELETE /api/admin/roles/:role` `{ moveTo? }` →
  409 `role_in_use` with counts when `moveTo` is missing and accounts/invites use it; 400 `builtin_role` for built-ins.
- `PUT /api/admin/roles/order` `{ keys: string[] }` (must be a permutation of all keys).

### 4.2 Rights of one account

- `GET /api/admin/users/:id/rights?profile=<pid>` →
  ```ts
  { role: string; note: string | null;
    rows: Array<{ key: string; value: unknown; roleValue: unknown; override: unknown | null;
                  source: 'default'|'env'|'role'|'user'|'kids'|'admin' }>;
    profile: { id: string; name: string; kids: boolean; maxRating: 0|6|12|null } | null;
    hardKids: string[] }   // perms the kids overlay switches off
  ```
- `PUT /api/admin/users/:id/rights` — partial `{ overrides: { [field]: value | null }, note?: string | null }`; replaces
  `PUT /:id/limits` (kept as an alias mapping its five fields for one release). Audited `user.rights` with `{ from, to }` of the
  changed fields only. 409 `deletion_in_progress` as today; the admin cannot lower their own `perms`/rights in a way that locks
  them out (admin perms are locked anyway; own role change is already refused).
- `POST /api/admin/users/:id/check` `{ profileId, itemId? , query? }` — "Can this profile see this title?" (§6.4). With
  `query` (2–100 chars) the backend searches with the media server's **admin** key through a new optional seam method
  `MediaAdmin.findItems?(q, limit)` → `{ id, name, year, type, rating, library }[]` (max 8 hits, films and series; Jellyfin:
  `/Items?searchTerm` without a user, Plex: its library search), then asks the profile's own identity (`jfUserFor`) whether it
  can open each hit (`ctx.jf.item`). Without `findItems` (an adapter that lacks it) the search runs as the first active admin
  account (`serviceUser`, `previews.ts:17`) and `why` is `null`. Answer per hit:
  `{ id, name, year, type, visible: boolean, why: 'library'|'rating'|'unrated'|'unrated_kids'|null, rating: string|null, library: string }`
  (`why` derived from the admin-key facts: library not in the effective list → `library`; rating above cap → `rating`; kids and
  unrated → `unrated_kids`; a grown-up's profile with an age cap and unrated → `unrated`, as Plex hides those under any cap). Rate limit 30/min. Audited `user.check_viewed` (`{ profile, hits }`, no titles), like the activity
  tab.

### 4.3 Profiles (admin)

- `PATCH /api/admin/users/:id/profiles/:pid` gains `kids: boolean` and `maxRating: 0|6|12` (owner profile: `kids` refused,
  400 `owner_not_kids`, as today owners are never kids profiles). A kids change re-applies that identity's policy
  (`applyRole`), clears the device kids lock when kids goes off (`devices.kids_profile_id`), audited `profile.admin_update` with
  from/to.
- `POST /api/admin/users/:id/profiles` `{ name, kids: true, maxRating, avatar? }` → creates a kids profile through
  `createProfile` (same limits: max 5, unique name). Only kids profiles can be created by admins (grown-up profiles stay the
  account holder's choice).
- `DELETE /api/admin/users/:id/profiles/:pid` (non-owner) → `deleteProfile`; confirm in the UI names what goes (list,
  history, favourites of that profile); audited `profile.admin_delete`.

### 4.4 Users list and bulk

- `GET /api/admin/users` gains filters `overrides=1` (has any override), `kids=1` (has a kids profile), `perm=<key>:on|off`
  (effective; computed in the backend over the SQL-filtered set, which the endpoint already caps at 1000 rows), `mfa=off`
  (from the 10-min Authentik cache; ignored without the Authentik API). Row shape gains `overrides: number`,
  `kidsProfiles: number`, `note: string | null`.
- `POST /api/admin/users/bulk` gains `action: 'perm'` with `{ perm, value: true|false|null }` (null = back to role) and
  `action: 'repair'` (re-apply policies + request-service link, as the single repair). Guards as today (all or nothing on
  validation; per account afterwards; `done` count).

### 4.5 Audit (G6)

- Every role write audits **one** entry `role.update` with `meta { from: {changed fields}, to: {changed fields} }` (replaces
  the four partial actions `role.request_limit` / `role.remote_cap` / `role.downloads` / `role.playback`; old entries stay
  readable). New: `role.create`, `role.delete` (`{ moveTo, accounts }`), `role.order`, `user.rights`, `user.check_viewed`,
  `profile.admin_create`, `profile.admin_delete`.
- `GET /api/admin/audit` gains `target=<id|role key>` and `area=people` (actions `user.*`, `role.*`, `invite.*`, `profile.*`,
  `device.*`). The role editor's *Verlauf* and the detail page's *Verlauf* use it.
- Audit metadata never holds secrets, PINs, tokens or titles (activity and check views store counts only).

## 5. Migration and compatibility plan

1. Migration 47 (§3) + `syncRoles` at startup. Effective values unchanged (test).
2. Backend reads `template`/`perms`; writes dual (`template` + old columns) for one release.
3. Old endpoints kept one release: `GET /api/admin/roles` legacy fields, `PUT /api/admin/users/:id/limits`. The web uses the new
   ones from day one.
4. `ROLE_TEMPLATES` keeps working; the settings page notes "Rollen lassen sich jetzt unter Personen → Rollen & Rechte ändern;
   .env-Werte gelten weiter darunter".
5. Next release: drop the old `role_settings` columns and the legacy endpoints (own migration, own PR).

Rollback to 3.3 after Phase 0: works (old columns are current; `roles`, new `user_limits` columns and indexes are ignored by
3.3). The one caveat: 3.3 does not know admin-created roles (`effectiveRole` answers `undefined`, playback fails for those
accounts). The release notes say: before rolling back, move accounts of admin-created roles to a built-in role (bulk *Rolle
ändern*). Built-in and env roles are unaffected.

## 6. Admin UI

All pages keep the `AdminShell` frame. Phone (≤ 720 px) and desktop. Nav group *Personen*: **Personen** (badge: waiting
approvals), **Rollen & Rechte** (was *Rollen*), **Geräte**, **Nutzung**.

### 6.1 Rollen & Rechte (`/admin/roles`, rebuilt) — G7

**Desktop (≥ 900 px): the matrix.**

- A glass `.panel` holding a table: first column = the switches and numbers grouped under sticky group headers (*Zugang*,
  *Wiedergabe*, *Downloads*, *Wünsche*, *Gemeinsam*, *Übertragen*, *Live-TV*); one column per role in catalogue order. Column
  head: role name, "8 Personen · 2 Kinderprofile", and the role's menu (`ActionMenu`: *Bearbeiten*, *Duplizieren*,
  *Umbenennen*, *Nach links/rechts*, *Verlauf*, *Löschen*). First column and head row are sticky; the table scrolls
  horizontally inside the panel beyond 5 roles (no page scroll).
- **Cells** show the value as a compact chip: switches ✓ / – (icon **and** `aria-label` "erlaubt" / "nicht erlaubt"), numbers in
  their unit ("2", "20 Mbit/s", "1080p", "ab 12" / "alle", "3 Bibliotheken"). A value that differs from the code default carries
  a small dot and the tooltip "geändert (Standard: …)"; a value from `.env` the tooltip "aus .env".
- **Editing in place:** clicking a cell (or Enter on it; cells are a grid with arrow-key navigation, `role="grid"`) opens a
  small popover (`growBoth` from the cell) with the right control (`Toggle`, number `Field`, `Select` with presets, library
  checklist). Changes are staged, not saved: changed cells get the amber `--warn` outline, and a **save bar** rises from the
  bottom (`barRise`, space reserved by `--savebar-h` set before it animates in): "3 Änderungen in 2 Rollen · betrifft 11
  Personen" with *Verwerfen* and *Änderungen prüfen*. *Änderungen prüfen* opens a sheet listing each change
  ("Gast · Altersfreigabe: ab 12 → ab 16") and what follows ("Die Freigaben von 4 Personen und 6 Profilen werden auf dem
  Medienserver aktualisiert."), then *Speichern*. Progress shows in the bar ("Aktualisiere 6 von 10 …"); a partial failure keeps
  the stored values and says how many identities failed with *Erneut anwenden*.
- **Role sheet:** *Bearbeiten* (or a click on the role head) opens a right-hand glass sheet with the whole role as a form
  (label, invitable, every field grouped as in the matrix, library checklist, "Live-TV-Kanalgruppen" chip list when Live TV is
  installed), staged into the same save bar.
- **Verlauf:** a sheet listing `role.*` audit entries for that role (who, when, from → to).
- The unsaved-changes guard on navigation stays (existing `beforeNavigate` confirm).

**Phone:** one card per role (`.panel`, name, people count, a 2-line summary "2 Streams · 20 Mbit/s · ab 12 · Downloads aus"),
tap opens the role sheet full-screen (`sheetSlide`), same staging and save bar. A segmented control at the top switches to
*Vergleich*: a single-switch view ("Wer darf übertragen?" with all roles as rows), so comparison works on a phone too.

Rows hidden when their feature is absent (`requires`): no request service → no *Wünsche* group; Live TV not installed → no
*Live-TV* group. Admin column: switches locked (lock icon, tooltip "Admins dürfen immer alles").

### 6.2 Personen (`/admin/users`)

Existing page, kept and extended (no rewrite of what works):

- **Summary strip** (`StatTile` ×4, §2.4) above the tabs.
- **Search & filters:** search field, then filter chips in one horizontally scrolling row (`frost-pill` chips, the pattern of
  the phone category chips): Rolle ▾, Status ▾, Zuletzt aktiv ▾, *Mit Ausnahmen*, *Mit Kinderprofil*, *Ohne 2FA*, Recht ▾
  (e.g. "darf übertragen: nein"). Active chips are filled (`--fr-sel`) with an × to clear; *Alle Filter löschen* at the end.
- **Columns:** avatar, name (+ note tooltip), e-mail, role (inline `Select` as today), status, *Ausnahmen* (badge "2" →
  opens the person's *Rechte* tab), profiles (with a kids icon count), devices, last active, 2FA, access until.
- **Bulk bar** (existing): adds *Recht setzen…* (perm + erlauben / verbieten / wie Rolle) and *Richtlinien neu anwenden*.
  The confirm dialog lists names as today.
- Tabs *Warten auf Freigabe* and *Einladungen* unchanged except the shared `RolePicker` (any invitable role, with summary).

### 6.3 Person detail (`/admin/users/[id]`)

Tabs (URL `?tab=`): **Übersicht**, **Rechte** (replaces *Grenzen*), **Sicht prüfen** (new), **Profile**, **Geräte**,
**Downloads**, **Aktivität**, **Verlauf**.

- **Rechte:** the same groups as the matrix, one row per field: label, *Rolle* value (muted), the control, and the source
  chip ("Rolle", "Ausnahme", "Kinderprofil", "Admin"). Switch rows use a 3-way segmented control *Wie Rolle · Erlauben ·
  Verbieten*; number rows a `Field` with placeholder = role value and a *Wie Rolle* reset button. A *Notiz* field ("Warum
  diese Ausnahme?"). Staged with the same save bar; save → `PUT /rights`. With Live TV: *Kanalgruppen* row (chips: role
  groups, plus added groups with "+", removed with strike-through; *Bearbeiten* opens a checklist).
- **Profile** (G5): each profile row: avatar, name, kids switch (not on the owner), age cap select (0/6/12, kids only), PIN
  state with *PIN zurücksetzen*, last used, menu *Umbenennen* / *Löschen*. *Kinderprofil anlegen* button (disabled with hint at
  5 profiles).

### 6.4 Sicht prüfen ("What does this user see?")

A read-only panel for one profile (profile switcher chips at the top: owner first, kids marked):

1. **Kurzfassung** — plain sentences built from effective rights: "Anna sieht alle Bibliotheken bis FSK 12 · bis zu 2
   gleichzeitige Streams · unterwegs höchstens 8 Mbit/s · darf nicht herunterladen · darf übertragen · keine Wünsche." For a
   kids profile: "Kinderprofil: ab 6, Titel ohne Freigabe sind ausgeblendet, keine Kommentare, keine Partys."
2. **Bibliotheken** — the library list with ✓ / – and, per visible library, how many titles this profile sees vs. the whole
   library ("Filme · 812 von 1 204"), counted with the profile's own identity (`ctx.jf.items` with `limit 0` → total) and the
   admin key; cached 10 min.
3. **Titel prüfen** — search field; results as compact rows (poster thumb, name, year, rating) with "sichtbar" (✓) or
   "ausgeblendet · Altersfreigabe 16 über FSK 12" / "· Bibliothek nicht freigegeben" / "· ohne Freigabe (Kinderprofil)" / "· ohne Altersfreigabe"
   (`POST /check`).
4. **Live-TV** (when installed) — channel groups and the number of channels the profile sees, with the reason for hidden
   groups ("nicht kinderfreundlich", "für Gast nicht freigegeben").

Nothing here creates a session or touches the person's history; viewing it is audited (`user.check_viewed`). The privacy
notice (`docs/security.md`, account page) gets one sentence: admins can check which titles a profile can see.

### 6.5 Invites, approvals

Unchanged flows; role lists from the catalogue (G2); invite creation shows the chosen role's summary line.

### 6.6 Verlauf

Detail page *Verlauf* and role *Verlauf* render audit entries as sentences with from → to chips ("Ben Muster hat für Anna
*Übertragen* erlaubt (vorher: wie Rolle)."). `/admin/audit` gets the *Bereich: Personen* filter and the target filter.

## 7. Copy (EN / DE; the other five locales translated)

| Key | EN | DE |
|---|---|---|
| `admin.tabs.roles` | Roles & rights | Rollen & Rechte |
| `adminPeople.roles.groups.access` / `playback` / `downloads` / `requests` / `together` / `cast` / `livetv` | Access / Playback / Downloads / Requests / Together / Casting / Live TV | Zugang / Wiedergabe / Downloads / Wünsche / Gemeinsam / Übertragen / Live-TV |
| `adminPeople.roles.f.libraries` / `maxParentalRating` / `maxStreams` / `maxBitrate` | Libraries / Age rating / Streams at once / Max. quality | Bibliotheken / Altersfreigabe / Gleichzeitige Streams / Höchste Qualität |
| `adminPeople.roles.f.cast` / `party` / `partySchedule` / `comments` / `requests` / `liveTv` / `liveRecord` | May cast to a TV / Watch parties / More than 3 planned parties / Comments / May make requests / Live TV / May record | Auf Fernseher übertragen / Watch-Partys / Mehr als 3 geplante Partys / Kommentare / Darf sich Titel wünschen / Live-TV / Darf aufnehmen |
| `adminPeople.roles.people` | {n} people · {k} kids profiles | {n} Personen · {k} Kinderprofile |
| `adminPeople.roles.allowed` / `denied` | allowed / not allowed | erlaubt / nicht erlaubt |
| `adminPeople.roles.ratingAll` / `ratingFrom` | all / from {n} | alle / ab {n} |
| `adminPeople.roles.changedFrom` / `fromEnv` / `adminLocked` | changed (default: {v}) / from .env / Admins may always do everything | geändert (Standard: {v}) / aus .env / Admins dürfen immer alles |
| `adminPeople.roles.saveBar` | {n} changes in {r} roles · affects {p} people | {n} Änderungen in {r} Rollen · betrifft {p} Personen |
| `adminPeople.roles.review` / `discard` / `save` | Review changes / Discard / Save | Änderungen prüfen / Verwerfen / Speichern |
| `adminPeople.roles.reviewPolicy` | The access of {p} people and {k} profiles will be updated on the media server. | Die Freigaben von {p} Personen und {k} Profilen werden auf dem Medienserver aktualisiert. |
| `adminPeople.roles.applying` / `partialRetry` | Updating {i} of {n} … / {f} accounts could not be updated. Apply again | Aktualisiere {i} von {n} … / {f} Konten konnten nicht aktualisiert werden. Erneut anwenden |
| `adminPeople.roles.duplicate` / `rename` / `delete` / `history` / `moveLeft` / `moveRight` | Duplicate / Rename / Delete / History / Move left / Move right | Duplizieren / Umbenennen / Löschen / Verlauf / Nach links / Nach rechts |
| `adminPeople.roles.deleteMove` | {n} people and {i} open invites get the role: | {n} Personen und {i} offene Einladungen bekommen die Rolle: |
| `adminPeople.roles.compare` / `compareQ` | Compare / Who may {right}? | Vergleich / Wer darf {right}? |
| `adminPeople.rights.tab` / `asRole` / `allow` / `deny` / `note` / `noteHint` | Rights / As role / Allow / Deny / Note / Why this exception? | Rechte / Wie Rolle / Erlauben / Verbieten / Notiz / Warum diese Ausnahme? |
| `adminPeople.rights.src.role` / `user` / `kids` / `admin` / `env` | Role / Exception / Kids profile / Admin / .env | Rolle / Ausnahme / Kinderprofil / Admin / .env |
| `adminPeople.users.overrides` / `filterOverrides` / `filterKids` / `filterNoMfa` / `filterRight` / `clearFilters` | Exceptions / With exceptions / With kids profile / Without 2FA / Right / Clear all filters | Ausnahmen / Mit Ausnahmen / Mit Kinderprofil / Ohne 2FA / Recht / Alle Filter löschen |
| `adminPeople.bulk.perm` / `repair` | Set right… / Re-apply policies | Recht setzen … / Richtlinien neu anwenden |
| `adminPeople.summary.people` / `waiting` / `openInvites` / `expiring` | People / Waiting for approval / Open invites / Access ends soon | Personen / Warten auf Freigabe / Offene Einladungen / Läuft bald ab |
| `adminPeople.check.tab` / `summary` / `libraries` / `titles` / `titlesHint` | Check view / In short / Libraries / Check a title / Search a film or series | Sicht prüfen / Kurzfassung / Bibliotheken / Titel prüfen / Film oder Serie suchen |
| `adminPeople.check.visible` / `hiddenRating` / `hiddenLibrary` / `hiddenUnrated` / `hiddenUnratedAdult` | visible / hidden · rated {r}, above {cap} / hidden · library not shared / hidden · no rating (kids profile) / hidden · no age rating | sichtbar / ausgeblendet · Freigabe {r} über {cap} / ausgeblendet · Bibliothek nicht freigegeben / ausgeblendet · ohne Freigabe (Kinderprofil) / ausgeblendet · ohne Altersfreigabe |
| `adminPeople.check.libCount` | {lib} · {n} of {m} | {lib} · {n} von {m} |
| `adminPeople.profiles.kidsSwitch` / `maxRating` / `createKids` / `delete` / `deleteBody` | Kids profile / Age limit / Create kids profile / Delete profile / The profile's list, history and favourites are deleted. | Kinderprofil / Altersgrenze / Kinderprofil anlegen / Profil löschen / Merkliste, Verlauf und Favoriten des Profils werden gelöscht. |
| `adminPeople.audit.area` / `people` | Area / People | Bereich / Personen |
| `ui.error.castForbidden` / `partyForbidden` / `requestsForbidden` (mapped from the 403 codes in `errorText`) | Casting isn't enabled for your account. / Watch parties aren't enabled for your account. / Requests aren't enabled for your account. | Übertragen ist für dein Konto nicht freigeschaltet. / Watch-Partys sind für dein Konto nicht freigeschaltet. / Wünsche sind für dein Konto nicht freigeschaltet. |

The summary sentences of §6.4 are built from per-field keys (`adminPeople.check.s.*`), never by string concatenation of
translated fragments in the wrong order (each sentence is one key with parameters).

## 8. Accessibility

- Matrix: `role="grid"` with row/column headers (`th scope`), arrow keys move between cells, Enter/Space opens the cell editor,
  Escape closes it and returns focus to the cell; chip values have text equivalents; the dot "geändert" has a tooltip and is in
  the cell's accessible name ("Gast, Altersfreigabe: ab 12, geändert").
- Save bar: `role="region"` named "Ungespeicherte Änderungen", polite live announcement of the count.
- 3-way segmented controls are `radiogroup`s; filter chips are toggle buttons (`aria-pressed`) or menu buttons.
- Contrast pairs (amber outline on glass, muted role value `.72` white on `.panel`, source chips) added to
  `web/src/lib/admin/glass.test.ts`.

## 9. Testing

- **Unit (backend):** migration 47 on a fixture DB (role_settings with every column combination, user_limits) → effective
  rights identical before/after; `syncRoles` (env role added, removed, re-added); `effectiveRights` layer order and `sources`;
  kids overlay; admin lock; role create/duplicate/delete with move (accounts, invites); invitable roles in invites/approvals;
  `comments`/`party`/`partySchedule`/`cast`/`requests` enforcement (403 codes, comment list filter); `PUT /rights` audit
  from/to only changed fields; check endpoint `why` derivation with a fake media seam; bulk `perm`; audit `target` / `area`
  filters; the legacy endpoints' mapping.
- **Unit (web):** matrix staging/diff, save bar counts, cell formatting (units, "ab 12"), summary sentences per language,
  filter chip ↔ query mapping.
- **e2e (Playwright, mocked API, German UI):** matrix edit → review → save with progress and partial failure; role duplicate
  and delete with move; phone role cards and *Vergleich*; users filters and bulk *Recht setzen*; detail *Rechte* 3-way switch
  and note; *Sicht prüfen* with a kids profile; admin profile kids switch and kids creation; a11y names of grid cells.

## 10. Phases (each its own PR; the app works after each)

- **0a Backend:** migration 47, `syncRoles`, `perms.ts`, `rights.ts`, enforcement of the switches, new/extended endpoints,
  audit changes, `/api/me.perms`, docs (`docs/security.md` roles section, `docs/setup.md` ROLE_TEMPLATES note).
- **0b Rollen & Rechte:** the matrix, role sheet, phone cards and *Vergleich*, role create/duplicate/delete/order, history.
- **0c Personen:** summary strip, filters, columns, bulk; detail *Rechte*, *Sicht prüfen*, profile admin; audit filters;
  shared `RolePicker` in invites/approvals.
- **Next release:** drop old `role_settings` columns and legacy endpoints.

Live TV (Phase 1+) adds the *Live-TV* rows (`liveTv`, `liveRecord`, *Kanalgruppen*) to the matrix, the *Rechte* tab and *Sicht
prüfen*; their fields exist in the registry from 0a with `requires: 'livetv'`.

## 11. Decisions made here (owner may overrule)

1. Permissions are account-level; profiles only add the kids overlay (no per-profile rights for grown-ups).
2. Seven switches, chosen to cover exactly what exists plus Live TV; defaults reproduce today's behaviour (guest: no comments;
   admin: unlimited scheduled parties). Downloads stay the template's `download` field.
3. New roles are made by duplicating an existing one (full snapshot), keys are hidden slugs; built-ins cannot be deleted.
4. Admin permissions are locked on; only admin numbers are editable.
5. Overrides may be more or less permissive than the role; an override equal to the role value is not stored.
6. "What does this user see?" is computed (summary, library counts, title check, channel groups), never an impersonated
   session; viewing it is audited like the activity tab.
7. Admins may create, switch and delete **kids** profiles of an account; grown-up profiles stay the account holder's business.
8. Old `role_settings` columns are dual-written for one release (safe rollback), then dropped.
9. One `role.update` audit entry with from/to replaces the four partial role actions.
