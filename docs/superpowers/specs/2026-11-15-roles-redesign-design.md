# Rollen & Rechte redesign: areas first, one page per role, Live-TV-only roles (design)

Status: approved direction (owner, 2026-11-15: A + C). Builds on `2026-11-11-users-permissions-design.md` (Phase 0 rights model)
and `2026-11-11-live-tv-design.md` §8 (channel group rights). Research with file:line facts: the recon report of 2026-11-15
(summarised in "What exists today" below).

## Intent

Today one question, "what may people with role X do?", is spread over three screens (the role matrix, the role sheet, and
Live-TV → *Gruppen & Rechte* → *Nach Rolle*) and about 95 matrix cells with dots, grips, outlines and menus. A role that "only
sees Live TV" cannot be built at all: the backend and the UI refuse an empty library list, a new role has no channel groups,
and the app shell shows empty Start/Serien/Filme pages to anyone without libraries.

The redesign makes a role read the way the owner talks about it: **which parts of the app** (Mediathek, Live-TV, Wünsche,
Gemeinsam, Downloads) and then, only for those parts, the details. Editing happens on one page per role; the matrix survives as
a compare view.

## What exists today (fact check, main 58276d41)

- Layered resolver `backend/src/rights.ts:13-17`: code default (`roles.ts:32-37`, `perms.ts:15-20`) ← `ROLE_TEMPLATES` env ←
  `role_settings` row ← `user_limits` override ← kids overlay (`KIDS_OFF`, `perms.ts:23`), with the deciding layer per field
  (`sources`). Admin switches always on (`rights.ts:57`).
- Registry `MATRIX_FIELDS` (`perms.ts:49-69`): 19 rows in 7 groups (access, playback, downloads, requests, together, cast, livetv).
- Role write `writeRole` (`roleWrite.ts:75-156`): partial patch, one audit entry, policy re-apply on media fields. Library list
  refused when empty: `.min(1)` at `roleWrite.ts:42`; the per-person override reuses that schema (`userRights.ts:28-31`).
- Duplicate `createRole` (`rolecat.ts:143-180`): snapshot of template, switches and wish limit; **no Live-TV group grants**.
- Live-TV access = `liveTv` switch **and** a group grant (`livetv_group_roles`, or a per-person allow in `livetv_group_users`),
  released groups only, kids → kid-friendly only (`livetv/rights.ts:9-57`). `/api/me.features.livetv` needs ≥ 1 visible channel
  (`livetv/rights.ts:95-98`, `routes/auth.ts:302`).
- Role grants are edited per group (`livetv/groups.ts` `setRoles`, `updateGroup`, `releaseIn`) in Live-TV → *Gruppen & Rechte*
  (list chips and `GroupMatrix.svelte`); the role matrix only shows them read-only (`RoleMatrix.svelte:240-250`).
- Media servers already accept "no library": Jellyfin `policyFromTemplate` sends `EnableAllFolders:false, EnabledFolders:[]`
  for an empty id list (`jellyfin/client.ts:39-40`, ids resolved in `jellyfin/service.ts:1130-1136`); Plex stores `[]`, and
  `resolveAccess` turns it into `sections: []` → `section_id = any('{}')` → nothing (`plex/access.ts:155-163,180`).
- The web shell has fixed tabs (`web/src/lib/menu.ts` `HEADER_TABS`, `TV_RAIL`), Live joins via `liveTabs` when
  `features.livetv` (`+layout.svelte:486`). Menu gating by feature/capability/perm is `linkShown` (`lib/capabilities.ts:88-97`):
  `/party` needs `party`, `/vote` needs nothing. Kids routing is a pure function `kidsRedirect` (`lib/gate.ts:37-40`).
- `/api/seerr/upcoming` only requires a grown-up profile (`routes/discover.ts:348`); the web already hides it without the
  `requests` right (`featuresOfMe`, `capabilities.ts:76-81`).
- Native shells: Android reads `/api/me` only for csrf, profile, kids, server capabilities and `features.postplay`
  (`android/.../downloads/ServerApi.kt:180-190`, player tests); desktop (Tauri), Tizen, webOS and `tv-shared` load the web UI
  and read no menus. **Every menu the user sees comes from the web app.**
- DVR recordings do not exist: "DVR minutes" is the time-shift buffer; `recordingUses()` is a stub
  (`livetv/streams.ts:567-569`); `liveRecord` ("Darf aufnehmen") is stored and shown but enforced nowhere.

## Goals

1. Rollen page = a **role list**; each role is edited on **its own page** that starts with **area switches**; details only
   for areas that are on.
2. Live-TV channel groups of a role are chosen **on the role page** (inline), saved with the role, copied with it.
3. A role with **no library** is valid end to end (backend, both media servers, admin UI, per-person override).
4. A person without libraries gets an app that is **only Live TV**: menus, start page, TV rail and deep links follow.
5. New roles start from **templates** (Familie, Freund, Gast, Nur Live-TV, Leer) or as a copy of an existing role.
6. Nobody's effective access changes by shipping this (no data migration; areas are derived).
7. Everything that works keeps working: layers and their markers, staged edits with review and leave guard, per-person
   overrides, kids profiles, phone layout, partial-failure retry, history.

## Non-goals

- DVR recordings and an "Aufnahmen herunterladen" right (Phase 3). This design only reserves the slot (§5.4).
- Enforcing `liveRecord` (nothing to enforce yet).
- Stored "area" flags or a new resolver layer (rejected, §2).
- Live channels in search, a Live-TV party, or library-free versions of Tonight/Match/Stats.
- Changing the per-person group exceptions UI (stays in the person's *Rechte* tab and in Live-TV → *Gruppen & Rechte*).
- Roles for the admin role beyond today's rules (admin switches stay locked on; admin sees every released group).

## Global constraints (restated)

- 7 locales (de, en, es, fr, it, pl, tr) with identical key order; German is the source. No "Netflix"/"Seerr" in user-facing
  text. Fictional names only (Anna Beispiel; channel groups Nordlicht TV, Hafenkanal); placeholder hosts only.
- 44 px targets; animate only `transform`/`opacity`; nothing may jump (reserved lines, skeletons at final size, the control
  a person pressed never moves).
- Never log secrets; logs carry codes, not values.
- Merge, never rebase; each stage its own PR with green CI.
- Agents run typecheck plus the specific specs of a task. E2E mocks must cover every new API call (fixtures fail on unmocked
  calls). Specs that open pages whose routes change are updated in the same task.

---

## 1. Approaches

**A. Role list + one page per role; the matrix becomes "Rollen vergleichen".** The Discord/GitHub/Jellyfin model. One mental
model at every width (the phone already works this way with cards + sheet). Cost: the biggest layout change; side-by-side
comparison is one click away.

**B. Keep the matrix, remove noise** (summary rows, dimmed details, legend instead of dots). Smallest change, but still a dense
grid, and it neither joins the group grants nor answers "what does this role see".

**C. Areas first, details second.** Five large switches per role; details fold away when an area is off; templates for new
roles. Matches the owner's words ("sieht nur Live-TV"), puts the 0-library and group-grant problems on the screen where they
arise, and gives the app shell a flag to follow.

**Chosen: A + C** (owner decision). A gives C a page to live on; C is what makes A simpler than the matrix rather than just a
different layout.

### 1.1 Compare view: read-only (decision)

The matrix stays as *Rollen vergleichen*, **read-only**: a cell (and each phone compare row) links to the role page at that
field. Keeping inline edit would be cheap in code (it exists) but not in rules: the role page enforces area coupling (§2.3:
Mediathek off ⇒ Wünsche, Gemeinsam, Downloads off; groups only with Live-TV) and stages group grants. A second editor would have
to duplicate every such rule or could save states the role page forbids. Removing the popover editor also removes
`CellPopover`, the drag grips and the column menus, which is most of the matrix's noise. Keyboard grid navigation stays (it is
reading, not editing).

## 2. The area model

### 2.1 Areas

| Area (UI) | Key | On when (derived from effective values) | Detail fields shown when on |
|---|---|---|---|
| Mediathek – Filme & Serien | `library` | `libraries === 'all'` or a non-empty list | `libraries`, `maxParentalRating`, `maxBitrate`, `remoteMaxBitrate`, `transcoding`, `maxHeight` |
| Live-TV | `livetv` | `liveTv === true` | channel groups (inline chips); later "Aufnahmen herunterladen" (§5.4) |
| Wünsche | `requests` | `requests === true` | `requestsPerMonth` |
| Gemeinsam | `together` | `party \|\| comments` | `party`, `partySchedule`, `comments` |
| Downloads | `downloads` | `download === true` | `maxDownloads`, `downloadMaxHeight`, `downloadDays` |
| *Allgemein* (always shown, no switch) | — | — | `maxStreams` (counts library **and** live streams, `livetv/routes.ts:125-133`), `cast` |

`liveRecord` is marked **planned** in the registry and hidden from every editor and from the compare view until recordings
exist (data kept, still resolved, still in old audit entries). Superseded in Stage 4, see §5.4: visible as "Darf aufnehmen"
since the recordings backend enforces it.

"Gemeinsam" covers what exists: watch parties (`party`, with `partySchedule`), votes (`/vote`, `/api/polls` — gated by `party`
today, `routes/polls.ts:47`) and comments (`comments`). "Freunde"-style signals (`/api/items/:id/friends`) are library data
and follow Mediathek, not a switch.

Wünsche is shown only with a request service (`features.requests`), Live-TV only when installed (`features.livetv` of the
matrix, i.e. `featureFlags`), exactly as the matrix rows today (`requires`).

### 2.2 Areas are derived, not stored (decision)

An area is a pure function of the role's effective values (`areasOf(values)`, one implementation per side: backend
`backend/src/areas.ts`, web `web/src/lib/admin/rights/areas.ts`, both tested against the same table). Switching an area writes
the underlying fields through the normal role write; there is **no new column and no new resolver layer**.

Why: a stored flag that masks fields would need its own place in the layer chain (env? per person? kids?), would make
`sources` lie ("set on the role" while masked) and would need a data migration. Derived areas keep the five layers, the
per-person overrides and the markers exactly as they are, and need no migration.

### 2.3 What an area switch stages

| Switch | Off stages | On stages |
|---|---|---|
| Mediathek | `libraries: []`, and `requests`, `party`, `partySchedule`, `comments`, `download` → false | `libraries`: the role's `defaults.libraries` if not empty, else `'all'` |
| Live-TV | `liveTv: false` (group grants stay stored, shown dimmed) | `liveTv: true` |
| Wünsche | `requests: false` | `requests: true` |
| Gemeinsam | `party`, `partySchedule`, `comments` → false | `party: true`, `comments: true` (`partySchedule` unchanged) |
| Downloads | `download: false` | `download: true` |

Each staged field is an ordinary staged value: the review lists it ("Freund · Wünsche: erlaubt → nicht erlaubt"), discard
restores it, and a staged value equal to the loaded one unstages itself (`stageSet`). Turning an area off and on again in one
session restores the loaded values (the stage drops the entries) instead of writing defaults.

**Coupling (decision):** Wünsche, Gemeinsam and Downloads **need the Mediathek** (wished titles land in the library; parties,
votes and comments are about library titles; downloads are library items only, `downloads.ts:210`). While Mediathek is off
these three switches are shown off and disabled with the line "Braucht die Mediathek". The resolver does not enforce the
coupling (no new layer); the role page does, and `/api/me.areas` (§4.5) ANDs it so the app never offers them without a library.

### 2.4 Special roles

- **Admin:** all area switches on and locked (lock icon, "Admins dürfen immer alles"); Live-TV groups read "Alle freigegebenen
  Gruppen". Numbers stay editable (as today). Libraries stay editable for admin as today (`'all'` by default).
- **Env-only role** (key in `ROLE_TEMPLATES`, no row in `roles`): values editable as today (the role row overrides env), but
  name, order and channel groups are locked ("Steht in der .env" — group grants need a catalogue row, FK
  `livetv_group_roles.role → roles.key`).
- **Values from `.env`** keep the "aus .env" marker next to the control; values set on the role keep "geändert (Standard: …)";
  this is the existing `sources`/`defaults` data, shown per field on the role page.
- **Kids profiles** are unchanged: the kids overlay still forces `requests/party/partySchedule/comments/liveRecord` off and caps
  the age; Live TV for kids still needs kid-friendly groups.

## 3. Live-TV-only roles

### 3.1 Zero libraries

- `rolePatch.libraries` accepts `[]` (drop `.min(1)`); the person override inherits it (`rightsOverrides` reuses the shape).
  Stored as `[]` in `role_settings.template` / `user_limits.libraries`; `readLibraries`/`readTemplate` already accept it.
- `knownLibraries(ctx, [])` returns `[]` without asking the media server (today it would answer 502 while the server cannot
  list libraries, for a list that needs no lookup).
- Policy push: verified by reading, pinned by tests — Jellyfin gets `EnableAllFolders:false, EnabledFolders:[]`; Plex stores
  `libraries = '{}'` and `resolveAccess` yields `sections: []`. A change from/to `[]` is a `MEDIA_FIELDS` change, so the role's
  identities get the policy again (existing path).
- UI: `FieldControl`'s library checklist lets the last box go; with none ticked the reserved hint line reads "Keine Bibliothek
  – die Person sieht nur Live-TV" (the line exists today for "Mindestens eine…", so nothing moves). `cellText` says "Keine
  Bibliothek". On the role page the Mediathek area switch is the normal way to get there.
- `ROLE_TEMPLATES` with `libraries: []` was already accepted by `roleTemplateSchema`; such a role now also gets the Live-only
  shell (matches what its media server identity could see anyway).

### 3.2 What a person without libraries sees

`/api/me.areas.library === false` drives one routing rule and the menus (§6). In short: only the Live tab; Start goes to
`/live`; library pages redirect to `/live`; account pages (Einstellungen, Geräte, Profile, Fernbedienung) stay. With neither
library nor any visible channel the start page shows an empty state "Für dich ist noch nichts freigegeben" instead of empty
rows.

## 4. Data and API changes (backend)

### 4.1 Registry (`perms.ts`)

`MatrixField` gains `area: AreaKey | 'general'` and optional `planned?: 'recordings'` (only `liveRecord`). `group` stays (audit
text and compare view grouping). New `backend/src/areas.ts`:

```ts
export const AREA_KEYS = ['library', 'livetv', 'requests', 'together', 'downloads'] as const;
export type AreaKey = (typeof AREA_KEYS)[number];
export type Areas = Record<AreaKey, boolean>;
/** the areas of a set of effective values (MatrixField keys → value), §2.1 */
export function areasOf(v: Record<string, unknown>): Areas;
export const hasLibrary = (libraries: unknown): boolean; // 'all' or a non-empty array
```

### 4.2 Role write: libraries `[]` and channel groups

`rolePatch` gains `livetvGroups: z.array(uuid).max(500).optional()` — **the released groups the role sees** (a full set,
replacing the role's grants on released groups; grants on unreleased groups are kept, so a later release still knows its
roles). Inside `writeRole`'s transaction (same role lock, same connection):

1. 400 `admin_groups_locked` for `admin`; 400 `not_in_catalogue` for a role without a row.
2. `select id, name from livetv_groups where released for update` (serialises with group PATCH/release, which lock group rows).
3. Unknown or unreleased id → 400 `{ error: 'invalid', field: 'livetvGroups' }`.
4. Delete the role's rows for released groups not in the set, insert the missing ones.
5. Audit: the existing `role.update` entry gets `from.livetvGroups` / `to.livetvGroups` as **group names** in group order (the
   history must read without lookups; a later rename does not rewrite history). No change → no key.

After commit `invalidateRights()` already drops the Live-TV channel sets. Live TV not installed → the field is still accepted
(groups may exist from an earlier install), nothing else changes. One PUT per role keeps the page's sequential save, progress
and partial-failure retry unchanged.

### 4.3 `GET /api/admin/roles` additions

- `matrix.roles[].areas: Areas` (from the effective values; admin all true).
- `matrix.roles[].livetvGroupIds: string[]` (released groups granted to the role, group order; admin: all released).
  `livetvGroups` (names) stays for one release.
- `matrix.livetv: { groups: Array<{ id; name; kidFriendly; channels }>; pending: number } | null` — released groups in group
  order and the count of unreleased ones; `null` when Live TV is not installed.
- `matrix.templates: RoleTemplatePreset[]` (§4.4).
- `matrix.fields[]` carry `area` and `planned`.

### 4.4 Templates and creating a role

`POST /api/admin/roles` takes either `{ label, from }` (copy, as today) or `{ label, template }` with
`template ∈ 'family' | 'friend' | 'guest' | 'liveOnly' | 'empty'`. Presets (backend `roleTemplates.ts`, listed in
`matrix.templates` as `{ key, base, patch, areas }`):

| Template | base | stored on the new role | areas |
|---|---|---|---|
| Familie | family | nothing (inherits the family code defaults) | all on |
| Freund | friend | nothing | all but Downloads |
| Gast | guest | nothing | Mediathek, Live-TV, Wünsche, Gemeinsam (party only) |
| Nur Live-TV | friend | `libraries: []`, `download: false`, perms `requests/party/partySchedule/comments/liveRecord: false`, `liveTv: true` | Live-TV only |
| Leer | guest | `libraries: []`, `download: false`, every perm false | none |

Familie/Freund/Gast store no row, so the new role's values read "Standard" and follow later code-default changes, unlike a copy
(a frozen snapshot, as today). "Nur Live-TV" is offered only while Live TV is installed. A template role starts with **no
channel groups**; the role page then shows the 0-groups warning (§5.3). Audit `role.create` `{ template, label }`.

### 4.5 Copy keeps channel groups

`createRole(…, from)` also copies `livetv_group_roles` rows of `from` (released and unreleased) in the same transaction. A copy
of `admin` gets a grant on every **released** group (what admin sees; admin itself has no rows). `role.create` audit adds
`groups: n`.

### 4.6 `/api/me`

```ts
areas: {
  library: boolean;   // hasLibrary(effective template libraries)
  livetv: boolean;    // = features.livetv (installed ∧ liveTv ∧ ≥ 1 visible channel)
  requests: boolean;  // features.requests ∧ perms.requests ∧ library
  together: boolean;  // (perms.party ∨ perms.comments) ∧ library
  downloads: boolean; // downloads.allowed ∧ library
}
```

Computed from values `/api/me` already resolves (`effectiveLimits`, `permsOf`, `livetvFeature`); no extra query. Older web
builds ignore it; a missing `areas` means "all on" on the client (lenient parse, like `featuresFrom`).

### 4.7 Gating fixes

- `GET /api/seerr/upcoming` adds `requirePerm(ctx, 'requests', 'requests_forbidden')` (the web already hides it without the
  right, so nobody loses what they see).
- Web: `/vote` needs `party` like `/party` (`PERM_NEEDS`).

## 5. Admin UI

### 5.1 Rollen list (`/admin/roles`)

One column at every width (max ~720 px on desktop, centred in the admin content). Above: intro line, a segmented control
*Rollen | Vergleichen* (`?view=compare` deep-links the second), and **+ Neue Rolle** (primary). Each role is a `.panel` row
(≥ 64 px, whole row is the link to `/admin/roles/<key>`):

- line 1: name (+ chips "Admin", "aus .env", "nicht mehr in .env" as today);
- line 2: area summary, e.g. "Mediathek · Live-TV · Wünsche", "Nur Live-TV", "Nichts freigegeben"; Live-TV with 0 groups adds
  a warning icon + "Live-TV ohne Kanalgruppe";
- people: "8 Personen · 2 Kinderprofile" as a link to `/admin/users?role=<key>` (the users list already filters by role);
- ⋯ menu (`ActionMenu`): *Bearbeiten*, *Duplizieren*, *Nach oben*, *Nach unten*, *Verlauf*, *Löschen* (rules as today:
  env-only roles cannot move or be deleted; built-ins cannot be deleted). Order changes apply at once (`PUT /order`, the
  existing optimistic queue), the moved row glides by `transform`. No drag grip.

### 5.2 New role dialog

**+ Neue Rolle** opens a dialog: name field, then a radio list of start points (each ≥ 56 px, title + area summary line):
Familie, Freund, Gast, Nur Live-TV (when installed), Leer, and *Kopie von …* with a role `Select`. *Anlegen* posts and opens
the new role's page. *Duplizieren* in a menu opens the same dialog with *Kopie von <role>* preselected.

### 5.3 Role page (`/admin/roles/[key]`)

Header: back link "Rollen", the name as an inline field (staged; locked for env-only roles), people line (link), ⋯ menu
(*Duplizieren*, *Verlauf*, *Löschen*). Below:

1. **Bereiche** — five large switch cards in a grid (2 columns ≥ 600 px, 1 column on phones), each: icon, title, one-line
   description, a `Toggle` (the card is the label, 44 px+). Disabled cards say why ("Braucht die Mediathek", admin lock).
   The grid's size never changes when switches flip.
2. **Details per area that is on**, in the fixed order Mediathek, Live-TV, Wünsche, Gemeinsam, Downloads, then *Allgemein* and
   *Einladungen* (`invitable`). Each section is a `.panel` with its `FieldControl`s and, per field, the marker line ("aus .env",
   "geändert (Standard: …)", "nicht gespeichert") — the existing data. A section appears/disappears with an opacity fade; the
   switch grid above never moves, content below shifts only as the direct result of the press (no height animation).
3. **Live-TV section**: the released groups as toggle chips (44 px, name, "Kinderfreundlich" mark, "12 Kanäle"), staged as
   `livetvGroups`; *Alle* / *Keine* shortcuts; a reserved warning line "Ohne Kanalgruppe sieht diese Rolle kein Live-TV." when
   none is chosen; "2 Gruppen warten auf Freigabe" link to `/admin/livetv?tab=groups&pending=1`; *Gruppen verwalten* link.
   With Live-TV off the chips stay visible but dimmed and disabled ("Gespeichert, wirkt wenn Live-TV an ist").
4. Save bar and review sheet as today (the same components and `run()` loop, one role), plus the review line for groups
   ("Live-TV-Gruppen: Nordlicht TV → Nordlicht TV, Hafenkanal"). Leave guard as today. A partial policy failure offers
   *Erneut anwenden* as today.

Unknown key → "Diese Rolle gibt es nicht (mehr)" with a link back. A role deleted from its own page → toast + back to the list.

### 5.4 Reserved slot: recordings

Under Live-TV, the registry already carries `liveRecord` (planned). When Phase 3 ships it becomes visible again as "Darf
aufnehmen", and a new switch "Aufnahmen herunterladen" joins the Live-TV section — not the Downloads area, which stays "library
items only". If the owner chooses the Jellyfin-library storage mode for recordings, Phase 3 must treat that library as part of
Live-TV (excluded from `hasLibrary`), so a Live-TV-only role still has `library: false` (open question 2).

**Done for the switch (Stage 4, 2026-11-15):** the recordings backend (Phase 3a) enforces `liveRecord` on the recordings API,
so the registry no longer marks it planned. The switch is visible as "Darf aufnehmen" in the role page's Live-TV section
(read-only in the compare view, in the person's *Rechte* tab like any right) and coupled to Live-TV the way the Mediathek
coupling works: Live-TV off stages it off, and it stays off and locked ("Braucht Live-TV") until Live-TV is on again. The kids
overlay still forces it off; the "Nur Live-TV" template keeps `liveRecord: false`.
**Owner decision 2026-11-15 (supersedes the coupling and the defaults above):** "Switch off at start. LiveTv and Record should
be separated rights." `liveRecord` is off by default for Familie and Freund too (Admin stays on and locked; Gast, Nur Live-TV and
Leer were off already; a role an admin already saved keeps its value, nothing is migrated), and it is its own right: switching
Live-TV off or on never changes its stored or staged value. Recording still needs both (`liveTv` and `liveRecord`, enforced by the
recording routes). On the role page the switch shows its real value while Live-TV is off, disabled, with "Braucht Live-TV" on its
reserved marker line; the review sheet lists nothing for it. The compare view and the person's *Rechte* tab show the stored value
with the same hint. The recordings screens follow on their own
branch; "Aufnahmen herunterladen" is not added yet (it ships with recordings downloads, Phase 3c).

### 5.5 Compare view (`/admin/roles?view=compare`)

Desktop (≥ 900 px): the existing matrix, read-only: an **Bereiche** group on top (one ✓/– row per area), then the detail rows
grouped by area (planned rows hidden; none since Stage 4, §5.4), and the Live-TV groups row with names. A cell is a link to
`/admin/roles/<key>?field=<fieldKey>` (the role page scrolls to and focuses that control). No popover, no grips, no column menus
(the head is a link to the role page). Phone: the existing *Vergleich* (one right, all roles), read-only rows with
"Bearbeiten" links.

### 5.6 Live-TV → *Gruppen & Rechte*

- *Nach Rolle* (GroupMatrix) is removed; that view becomes **Personen**: the per-person exceptions list (unchanged) and a
  line "Welche Rolle welche Gruppen sieht, stellst du in Rollen & Rechte ein." with a link.
- The list view keeps its per-group role chips (who sees *this* group — the group-centric question) and the release sheet
  keeps choosing roles. Both write the same table as the role page.

### 5.7 Person → *Rechte*

Unchanged except: libraries may go to none (same `FieldControl` change), `liveRecord` hidden (planned; superseded in Stage 4,
see §5.4), and a line
"Ohne Bibliothek sieht {name} nur Live-TV." when the effective list is empty.

## 6. App shell for people without libraries

A pure function next to `kidsRedirect` (`lib/gate.ts`):

```ts
/** where the layout sends a person without the area of `path`, or null */
export const areaRedirect = (me: { areas?: Partial<Areas> } | null | undefined, path: string, livetv: boolean): string | null;
```

- `areas.library === false`: allowed paths `LIBRARY_FREE = /^\/(live|profiles|settings|devices|me|remote|offline|welcome|admin|invite|login|reset|restore|confirm-email|pending|setup|diagnose|tv|cast-receiver)(\/|$)/`
  (an allowlist, so a future library page is redirected by default). Anything else → `/live` when `livetv`, else `/`
  (which then renders the empty state; `/` is allowed only in that case).
- Runs before `kidsRedirect` in both places that call it (`+layout.svelte` boot and the reactive guard); a kids profile
  without library therefore lands on `/live` (kid-friendly groups) instead of the library-based `/kids`, and `kidsRedirect` applies only while `areas.library` is true (otherwise `/` and `/kids` would send to each other).
  A kids profile without library may open only the paths both rules allow (`KIDS_ALLOWED` ∩ `LIBRARY_FREE`: `/live`,
  `/profiles`, `/offline`, `/welcome`, `/settings`), plus `/` when there is no Live TV; everything else goes to `/live` (or `/`),
  so the kids boundary (no account, device or admin pages) stays.
- The boot hint (`BootHint`) stores `library: false` and `livetv: true` (when on), so a live-only first paint has its Live tab
  and its home at once. While the hint says library, the library tabs and controls (bar, phone tab bar, chips, search, footer
  links) are laid out at their size but unseen (opacity 0, `visibility: hidden`) until `/api/me` confirms, then fade in (opacity,
  150 ms). A stale hint (the libraries were taken away since) removes them without them ever showing, and nothing moves.

Menus (all from `lib/menu.ts` + `linkShown`):

- `HEADER_TABS`, `TV_RAIL` and the phone `TabBar` drop library entries when `!areas.library` (`libraryTabs(tabs, areas)`);
  Live is added by `liveTabs` as today. Desktop bar (`DeskBar`), phone `TabBar`, TV rail (`TvRail`), the phone category chips
  (`showsChips`) all use these.
- `linkShown` gets an `areas` argument: library-only links (`/tonight /favorites /lists /history /match /collections /now
  /calendar /stats /downloads`, and `/watchlist`) need `library`; `/upcoming` needs `requests`; `/party` and `/vote` need
  `together`. Used by the account menu, `/me`, and the footer.
  `/requests` needs `library`, not `requests` (amended in Stage 2): the page keeps today's reminders without a request service
  or the requests right, and the backend already folds those into `areas.requests` (`features.requests ∧ perms.requests ∧
  library`), so gating on it would take the page away from people who see it today. Without a library the reminders mean
  nothing, so the Mediathek alone decides.
- `/tv` (TV start): `areas.library === false` → `/live?play=last` (like `startLive`).
- `/welcome`: skips step 2 ("three titles you like") when `!areas.library` (2 steps instead of 3).
- Search: hidden in the bar and rail for `!library` (it searches the library).
- Native shells need no change (they load the web UI; Android's native code reads no menus). Android's offline downloads list
  is empty for such a person anyway.

## 7. Copy (German source; English shown; the other five translated)

New keys (namespace `adminPeople.roles` unless noted), in this order:

- `areas.title` Bereiche / Areas; `areas.library` Mediathek / Library; `areas.libraryDesc` Filme und Serien aus deinen
  Bibliotheken / Films and series from your libraries; `areas.livetv` Live-TV / Live TV; `areas.livetvDesc` Fernsehsender aus
  den freigegebenen Kanalgruppen / Channels from the released channel groups; `areas.requests` Wünsche / Wishes;
  `areas.requestsDesc` Filme und Serien wünschen / Wish for films and series; `areas.together` Gemeinsam / Together;
  `areas.togetherDesc` Watchpartys, Abstimmungen und Kommentare / Watch parties, votes and comments; `areas.downloads`
  Downloads; `areas.downloadsDesc` Filme und Folgen offline speichern / Save films and episodes offline; `areas.general`
  Allgemein / General; `areas.needsLibrary` Braucht die Mediathek / Needs the library; `areas.adminLocked` Admins dürfen immer
  alles / Admins may always do everything.
- `summary.only` Nur {area} / Only {area}; `summary.none` Nichts freigegeben / Nothing shared; `summary.noGroups` Live-TV ohne
  Kanalgruppe / Live TV without a channel group.
- `groups.title` Kanalgruppen / Channel groups; `groups.all` Alle / All; `groups.none` Keine / None; `groups.empty` Ohne
  Kanalgruppe sieht diese Rolle kein Live-TV. / Without a channel group this role sees no live TV.; `groups.dormant`
  Gespeichert, wirkt wenn Live-TV an ist / Saved, applies when Live TV is on; `groups.pending` {n} Gruppen warten auf Freigabe
  (plural); `groups.manage` Gruppen verwalten / Manage groups; `groups.adminAll` Alle freigegebenen Gruppen / All released
  groups; `groups.channels` {n} Kanäle (plural); `groups.review` Live-TV-Gruppen / Live TV groups.
- `libsNone` Keine Bibliothek / No library; `libsNoneHint` Keine Bibliothek – die Person sieht nur Live-TV. / No library –
  the person sees only live TV. (replaces `libsMin`, which is removed in all 7 locales in the same position).
- `new.title` Neue Rolle / New role; `new.startFrom` Starten mit / Start from; `new.family`/`friend`/`guest` (role names via
  `admin.roleNames`), `new.liveOnly` Nur Live-TV / Live TV only; `new.empty` Leer / Empty; `new.emptyDesc` Alles aus, du
  schaltest frei / Everything off, you switch on; `new.copy` Kopie von … / Copy of …; `new.create` Anlegen / Create.
- `page.back` Rollen / Roles; `page.missing` Diese Rolle gibt es nicht (mehr). / This role does not exist (any more).;
  `page.envLocked` Steht in der .env / Set in .env.
- `compare.title` Rollen vergleichen / Compare roles; `compare.edit` Bearbeiten / Edit.
- `adminLive.grp.viewPeople` Personen / People; `adminLive.grp.rolesMoved` Welche Rolle welche Gruppen sieht, stellst du in
  Rollen & Rechte ein. / Which role sees which groups is set in Roles & rights.
- `home.noAccess.title` Für dich ist noch nichts freigegeben / Nothing has been shared with you yet; `home.noAccess.body`
  Frag die Person, die FriendFlix betreibt. / Ask the person who runs FriendFlix.
- `adminPeople.rights.libsNoneLine` Ohne Bibliothek sieht {name} nur Live-TV. / Without a library {name} sees only live TV.

## 8. Accessibility and motion

- Area cards: `Toggle` with the card text as label and the description via `aria-describedby`; disabled reason in the
  description. Group chips: `aria-pressed` buttons inside a `role="group"` labelled "Kanalgruppen von {role}".
- Role list rows are links; the ⋯ button is a separate 44 px target outside the link.
- Compare cells: links with the existing accessible cell names plus ", bearbeiten".
- Motion: section fade (opacity), list reorder glide (transform), save bar rise (existing). The warning and hint lines are
  reserved (no jump when they appear).

## 9. Migration of existing roles

No data migration. Areas are computed from today's values on every read; the first page load writes nothing.

- Built-ins with code defaults: Familie → all five on; Freund → all but Downloads; Gast → Mediathek, Live-TV, Wünsche,
  Gemeinsam (party on, comments off), Downloads off; Admin → all on (locked).
- Any stored role: `libraries` is never `[]` today (refused since Phase 0), so Mediathek is on for every stored role and the
  coupling rule (§2.3) never conflicts with existing data. A role that already has Wünsche on and Mediathek on stays exactly so.
- Effective access is unchanged because nothing is written: proven by tests that resolve every role and every person of a
  fixture before and after the migration code path runs (it is a no-op), and that `/api/me.areas` is all-true for every
  existing fixture account with libraries.
- Group grants are unchanged (same table). `livetvGroups` names stay in the answer for one release.
- `liveRecord` values stay stored and resolved; only hidden (until Stage 4, see §5.4).

## 10. Testing

- Backend: `areasOf` table (shared fixture with the web test); libraries `[]` accepted by role and person writes and refused
  nowhere; `knownLibraries([])` without a server call; Jellyfin `policyFromTemplate([])`; Plex `resolveAccess([])` → no
  sections; role write with `livetvGroups` (set, replace, keep unreleased grants, refuse unknown/unreleased, admin/env-only
  refused, audit names, channel sets invalidated); copy keeps grants (and admin copy gets all released); template create
  (no row for Familie/Freund/Gast, stored patch for Nur Live-TV/Leer); `/api/me.areas` for full, live-only, empty and kids;
  upcoming 403 without `requests`.
- Web unit: `areas.ts` (derive, stage on/off, coupling, restore on re-on), `gate.ts` `areaRedirect`, `menu.ts`/`capabilities.ts`
  link filtering, model review lines for groups.
- E2E (mocks extended: `/api/admin/roles` answer fields, `POST` with `template`, `PUT` with `livetvGroups`, `/api/me.areas`):
  live-only shell (desktop, phone, TV rail, deep link redirect, empty state), role list, role page area switches and groups,
  new role from template, compare view read-only links, Live-TV groups tab "Personen" view.

## 11. Stages (each its own PR; the app works after each)

1. **Backend** — areas registry, `[]` libraries, `livetvGroups` in the role write, GET additions, templates in POST, copy
   keeps grants, `/api/me.areas`, upcoming gating.
2. **App shell** — `areas` parsing and hint, `areaRedirect`, menus/rail/tab bar/footer/me, TV start, welcome, empty home state,
   `/vote` gating; `FieldControl` allows 0 libraries (so the existing editors can already make a Live-only role).
3. **Role list + role page** — list (with *Vergleichen* still showing today's editable matrix), role page with area switches
   and inline Live-TV groups, *Duplizieren* via the page; `liveRecord` hidden (planned) in every editor (superseded in Stage 4,
   see §5.4).
4. **Compare + templates + cleanup** — compare view read-only with links; new-role dialog with templates; remove
   `RoleSheet`, `CellPopover`, the matrix edit paths, `RoleCards`, `GroupMatrix` and the *Nach Rolle* view.

## 12. Decisions made here (owner may overrule)

1. Areas are derived from existing fields; no stored flag, no new layer, no data migration (§2.2).
2. Wünsche, Gemeinsam and Downloads need the Mediathek; the role page enforces it, `/api/me.areas` ANDs it (§2.3).
3. `maxStreams` and `cast` live in *Allgemein* (they apply to Live-TV too); age rating and bitrates belong to Mediathek.
4. The compare view is read-only; cells link to the role page (§1.1).
5. Channel groups are saved with the role (one PUT, one audit entry with group names); grants on unreleased groups are kept.
6. Familie/Freund/Gast templates store nothing (inherit code defaults); copies stay frozen snapshots.
7. A copy of Admin grants every released group; other copies copy the source's grants exactly.
8. `liveRecord` is hidden (planned), not removed; recordings will get a Live-TV-area switch, not the Downloads area (superseded
   in Stage 4, see §5.4: the switch is visible in the Live-TV area).
9. Library-free routing uses an allowlist; search is hidden without a library.
10. `/admin/roles?view=compare` instead of a `/admin/roles/compare` route, so no role key can collide with a sub-route.

## 13. Left to the builder

- Exact icons per area (from the existing icon set: `film`, `tv`, `gift`, `users`, `download`).
- Whether the list's role rows show a small area icon strip in addition to the text summary (text is required).
- The role page's scroll-to-field mechanics for `?field=` (focus the control, `scrollIntoView({ block: 'center' })`, no
  smooth scroll on reduced motion).
- Splitting `roles/[key]/+page.svelte` into components (`AreaGrid`, `AreaSection`, `GroupChips`) as size demands.

## 14. Open questions (owner only)

1. **Live-TV plus Wünsche without a library** — is there any case where a person should wish for films but not see the
   library (e.g. a relative who only requests)? This design says no (§2.3); a yes would drop the coupling for Wünsche only.
2. **Recording storage mode (Phase 3, not blocking now)** — FriendFlix `/recordings` folder or a Jellyfin library folder? With
   the library mode, a Live-TV-only role needs that one library, and "Mediathek off" must exclude it (§5.4).
