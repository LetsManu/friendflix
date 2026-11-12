# Device Hand-off, Media Controls, AirPlay Status and Continuous AirPlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every FriendFlix client offers "continue here" for what another of the profile's devices played (with user-chosen device names), the web player drives the lock screen and media keys, AirPlay says what it is doing, and continuous AirPlay ships dormant behind an admin switch.

**Architecture:** One small table `handoff` (one row per profile and device), written by the existing `playbackReport()` and read by `GET /api/handoff`; `devices` gains `client` (kind from the user agent) and `name` (the user's own name, set on *Geräte*). The web shows the answer as an overlay card on the start page and as a line on the title page, both starting playback at the shown position. Media Session gets a player binding next to the existing cast binding, with an owner token so only one writes. AirPlay's controller learns a `connecting` phase, a 30 s timeout and a one-off position guard. Continuous AirPlay is the cast plan's Tasks 23–27 rewritten here with the spec's amendments: a multi-item token, joined playlists with short segment URIs in the gateway, server-side per-episode progress, and the engine / remote screen in continuous mode, all gated by `CAST_AIRPLAY_CONTINUOUS` (off).

**Tech Stack:** Fastify + Zod + PostgreSQL (inline migrations) + Redis-backed KV (backend), Node gateway, SvelteKit with Svelte 4 component syntax on the Svelte 5 compiler, TypeScript strict, Vitest, Playwright (Chromium; Cast SDK, AirPlay, native bridge and `navigator.mediaSession` faked).

**Spec:** `docs/superpowers/specs/2026-11-11-device-handoff-design.md` ("spec §n"). Part E also leans on `docs/superpowers/specs/2026-11-10-cast-airplay-design.md` ("cast spec §n") and the spike findings (outside the repo: `/tmp/claude-0/-home-user/65bf3c9c-0207-5176-a7cc-9841c5a17402/scratchpad/sdd-cast/spike-22-findings.md`, §4 conditions; each E task restates what it needs).

**Ruling on spec §11:** the spec keeps E in the cast plan as an amendment section. The owner asked for this plan to cover E, so Tasks 15–23 here **replace** Tasks 22–28 of `docs/superpowers/plans/2026-11-10-cast-airplay.md` (that plan carries a pointer to here). The spike branch `spike/continuous-airplay` (local only, never merged) may be read with `git show spike/continuous-airplay:<path>` and ported where a task says so; if it is gone, the task brief is enough.

### Pull requests and order

| PR | Task | Implementer | Depends on |
| --- | --- | --- | --- |
| 1 (A) | 1 Migration 46, client kind of a device | Sonnet · backend | – |
| 1 | 2 Device rename API, display name in server lists | Sonnet · backend | 1 |
| 1 | 3 Hand-off write path (+ cast engine sends `via`) | **Opus** · backend + cast engine | 1 |
| 1 | 4 `GET /api/handoff` | Sonnet · backend | 2, 3 |
| 1 | 5 Web device names + rename on *Geräte* | Sonnet · frontend | 2 |
| 1 | 6 Hand-off card: desktop, phone, native action | Sonnet · frontend | 4, 5 |
| 1 | 7 Hand-off card in TV mode | **Opus** · frontend | 6 |
| 1 | 8 Title-page hint | Sonnet · frontend | 6 |
| 1 | 9 Docs PR 1 + owner checks A1–A5 | Sonnet · docs | 1–8 |
| 2 (C+D) | 10 Media Session owner token + player binding module | Sonnet · frontend | PR 1 merged |
| 2 | 11 Player binds Media Session, previous episode | Sonnet · frontend | 10 |
| 2 | 12 AirPlay controller: connecting, 30 s timeout, position guard | **Opus** · frontend (AirPlay + engine) | PR 1 merged |
| 2 | 13 AirPlay connecting layout and wording | Sonnet · frontend | 12 |
| 2 | 14 Docs PR 2 + owner checks C1, C2, D1 | Sonnet · docs | 10–13 |
| 3 (E) | 15 Admin switch `CAST_AIRPLAY_CONTINUOUS`, `continuous_off` | Sonnet · backend + settings UI | PR 2 merged |
| 3 | 16 Multi-item AirPlay token | **Opus** · backend | 15 |
| 3 | 17 Gateway: joined playlists, short segment URIs, tuple scope | **Opus** · gateway | 16 |
| 3 | 18 Server-side per-episode progress | **Opus** · gateway + backend | 16, 17 |
| 3 | 19 Web: continuous request, sheet row removed, Diagnose row | Sonnet · frontend | 15 |
| 3 | 20 Cast engine in continuous mode | **Opus** · cast engine | 19 |
| 3 | 21 Remote screen + Media Session in continuous mode | Sonnet · frontend | 20 |
| 3 | 22 Docs PR 3 (switch, acceptance procedure) | Sonnet · docs | 15–21 |
| after 3 | 23 Outcome docs after the owner's LG acceptance | Sonnet · docs | PR 3 merged + owner run |

Tasks per PR: PR 1: 9, PR 2: 5, PR 3: 8, follow-up: 1. Within a PR follow the order. Each PR leaves the app working.

## Global Constraints

- **Svelte:** Svelte 4 syntax on the Svelte 5 compiler (`export let`, `$:`, `on:event`, slots, stores); no runes.
- **Styling:** plain CSS with the glass `.frost*` classes (`.frost`, `.frost-safe`, `.frost-panel`, `.frost-btn`) and `--fr-*` tokens from `web/src/app.css`; coral accent, Inter; never a new blur rule.
- **Motion:** animate only `transform` and `opacity`; nothing may jump (space is reserved first, or the element overlays). Opening and closing both animate. Calm mode / reduced motion (`html.m-still`, `motionAllowed()` false, `fxMode() === 'still'`): durations 0, solid panels (`--fr-solid`), static spinners. TV and kids profiles are always solid. Use `#lib/glass/fx` (`outEase` etc.). `web/src/lib/admin/glass.test.ts` scans new stylesheets.
- **Copy:** German UI copy primary plus all locales (de, en, es, fr, it, pl, tr) with key order as the files have it (`web/src/lib/i18n/locales/<lang>/*.ts`; `de` is the typed source; DE and EN values are in spec §7, translate the other five). Every user-facing string through `#lib/i18n`.
- Never "Netflix"/"Seerr" in user-facing text.
- **Fictional titles** only in tests and screenshots: Dunmoor S1 E4 *The Lantern Road*, S1 E5 *Wrenfield Pier*; Saltwater Almanac S2 E1 *Night Market*, E2 *The Toll Keeper*, E3 *Glass Tides*; profile `Anna`; existing e2e fixtures keep theirs.
- **Placeholder hosts only** (friend.example.com, auth.example.com, 192.0.2.x).
- **Secrets:** the media-server token never reaches clients and no token/tokenised URL in metadata, logs or bridge payloads; device ids and play session ids never leave the server in the hand-off API; cast tokens stay hashed, IP-pinned, never logged.
- **Never log secrets.** New log lines carry an error class or fixed words only (no ids, titles, names, URLs).
- **Migrations** inline in `backend/src/db.ts` (append to `MIGRATIONS`; the next number is **46**; rerunnable with `if not exists`).
- **Accessibility at the 3.1 level:** contrast ≥ 4.5:1, targets ≥ 44 px, keyboard and remote operable with a visible focus ring, every control named, polite announcements, colour never the only carrier.
- Every new source file starts with the SPDX header (`SPDX-FileCopyrightText: 2026 Manuel Weißböck`, `SPDX-License-Identifier: AGPL-3.0-or-later`; `.svelte` as HTML comments). No new dependencies. Coverage thresholds are never lowered.
- **Verification:** agents run only typecheck plus the specific test files they touch, CI runs the rest:
  - root `npm run typecheck` (includes `npx tsc -p e2e/tsconfig.json`);
  - web unit `npx -w web vitest run <file>`; gateway unit `npx -w gateway vitest run <file>`; backend `npx -w backend vitest run <file>` (needs PostgreSQL: `TEST_DATABASE_URL` or `localhost:5433`; if none is reachable, leave it to CI and say so in the report);
  - e2e via `E2E_PORT=<port> PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx playwright test <spec> --trace off` from `e2e/` (only the task's spec files; delete `e2e/test-results` afterwards), and `npx tsc -p e2e/tsconfig.json`.
- No Android SDK install (Kotlin compile-checked with kotlinc + Robolectric as earlier tasks did). This plan changes no Kotlin; the Android and Windows apps already accept `play` with `startMs`.
- **Commits:** Conventional Commits, one per task (the commit step names it), each ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`
  (`git commit -m "<subject>" -m "Co-Authored-By: …" `). No model names anywhere else. Do not push.

## Review Focus

1. **A seek across a continuous-AirPlay boundary must not mark the skipped episode watched:** fetches jumping from episode 1 at minute 5 into episode 2 stop episode 1 at minute 5, not at its runtime; only a part that played to its end is stopped at its runtime. Test in Task 18 (`a seek into episode 2 stops episode 1 where it was`).
2. **The AirPlay picker closed without a TV leaves nothing hanging:** no connecting layout, no 30 s timeout, the phone plays on locally after the arm window. Tests in Task 12 (`the picker closed without a TV never arms the timeout`) and Task 13 (`closing the picker without a TV hides the connecting layout`).
3. **Device names from real keyboards:** emoji with joiners pass, bidi overrides and tabs are refused, whitespace-only resets, 40 code points pass and 41 fail (UTF-16 length must not decide). Tests in Task 2 (`refuses invalid names, keeps emoji`) and Task 5 (`cleanName mirrors the server`).
4. **A late hand-off answer never steals focus or moves the page:** on TV an answer after 2 s, or after any key press, leaves focus where it is; on every layout the rows keep their position when the card arrives. Tests in Task 6 (`a slow answer moves nothing`) and Task 7 (`a late answer does not take focus`).
5. **The admin turns the switch off while a joined stream plays:** the stream continues; the next renewal, audio change or reconnect silently gets a single-episode token at the same episode and offset, no error toast. Test in Task 20 (`switch off: a renewal falls back to a single token`).

---

## PR 1 — A: "Continue here" and device names (Tasks 1–9)

### Task 1: Migration 46, client kind of a device

**Implementer:** Sonnet (routine) · backend

**Files:**
- Modify: `backend/src/db.ts` (append migration 46)
- Create: `backend/src/deviceKind.ts`
- Modify: `backend/src/devices.ts` (`registerDevice`), `backend/src/routes/tv.ts` (`/api/tv/claim` insert), `backend/src/routes/auth.ts` (`GET /api/me`)
- Test: `backend/test/device-kind.test.ts`

**Interfaces:**
- Produces: schema of spec §2.1 exactly (`devices.client`, `devices.name`, table `handoff`, index `handoff_recent`), every statement `if not exists`.
- Produces (`backend/src/deviceKind.ts`): `export type ClientKind = 'web' | 'tizen' | 'webos' | 'firetv' | 'desktop' | 'android'`; `export function clientKind(ua: string): ClientKind` (rules and precedence of spec §2.1: ` FriendFlixFireTV/` → firetv, ` FriendFlixTizen/` or (`Tizen` and `SMART-TV`) → tizen, `Web0S` → webos, ` FriendFlixDesktop/` → desktop, ` FriendFlixAndroid/` → android, else web); `export async function noteClientKind(ctx: Pick<Ctx, 'db'>, userId: string, deviceId: string, ua: string): Promise<void>` = one `update devices set client = $3 where user_id = $1 and device_id = $2 and client is distinct from $3`.
- Called from `registerDevice` (both branches, after the row exists), from `/api/tv/claim` (the insert carries `client`), and from `GET /api/me` with `req.session.deviceId` and the request's user agent.

- [ ] **Step 1: Write the failing tests** in `backend/test/device-kind.test.ts`:
  - `clientKind maps every shell` – table: Fire TV app UA containing both ` FriendFlixAndroid/2.0.0` and ` FriendFlixFireTV/1.4.0` → `firetv`; `… Tizen 6.0 … SMART-TV …` → `tizen`; `… FriendFlixTizen/2.0` → `tizen`; `Mozilla/5.0 (Web0S; Linux/SmartTV) …` → `webos`; `… FriendFlixDesktop/1.2.0` → `desktop`; `… FriendFlixAndroid/2.0.0` → `android`; iPhone Safari UA → `web`; `''` → `web`.
  - `registration stores the kind` – login with an LG UA → `select client from devices` = `webos`.
  - `TV claim stores the kind` – the claim request with a Tizen UA → the new `tv-…` row has `tizen`.
  - `/api/me corrects a stored kind` – set `client = 'web'`, `GET /api/me` with a `FriendFlixDesktop/` UA → `desktop`.
  - `migration 46 is rerunnable` – delete `schema_migrations` rows ≥ 46, run `migrate()` again, no error, columns still there.
- [ ] **Step 2: Run** `npx -w backend vitest run test/device-kind.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the migration, `deviceKind.ts` and the three call sites.
- [ ] **Step 4: Verify** the test file → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(devices): remember which kind of client a device is (migration 46)`

### Task 2: Device rename API and the display name in server lists

**Implementer:** Sonnet (routine) · backend

**Files:**
- Create: `backend/src/deviceName.ts`
- Modify: `backend/src/routes/admin.ts` (own-device routes: new `PATCH /api/devices/:id`; `GET /api/devices` adds fields; `GET /api/admin/devices` shows the custom name), `backend/src/routes/adminUsers.ts` (`/api/admin/users/:id` device list), `backend/src/routes/usage.ts` (`/api/admin/usage/:userId`), `backend/src/playstats.ts` (device labels of live streams), `backend/src/export.ts` (export adds `name`)
- Test: `backend/test/device-rename.test.ts`

**Interfaces:**
- Consumes: `devices.name`, `devices.client` (Task 1).
- Produces: `export function cleanDeviceName(raw: unknown): { ok: true; name: string | null } | { ok: false }` (spec §2.8: `null` or blank → `null`; NFC, trim, inner whitespace runs → one space; 1–40 code points (`[...s].length`); refuse `\p{Cc}` and U+202A–U+202E, U+2066–U+2069).
- Produces: `PATCH /api/devices/:id` body `{ name: string | null }` → `200 { ok: true, name: string | null }` | `400 { error: 'invalid_name' }` | `404 { error: 'not_found' }`; `requireGrownUp(ctx)`; `config: { rateLimit: { max: 30, timeWindow: '1 minute' } }`; id validated like the neighbouring routes (`z.string().min(10).max(80)`); update `where user_id = req.user.id and device_id = :id`; audit `device.rename` with no meta.
- Produces: `GET /api/devices` rows gain `name: string | null` (custom) and `kind: ClientKind | null`; `label` stays the auto-detected label.
- Admin and usage lists select `coalesce(d.name, d.label)` where they select `label` today (same field names in the answers; search and sort on it too in `/api/admin/devices`).

- [ ] **Step 1: Write the failing tests** in `backend/test/device-rename.test.ts`:
  - `renames the own device and lists it` – PATCH `{ name: '  Wohnzimmer  ' }` → `{ ok: true, name: 'Wohnzimmer' }`; `GET /api/devices` row `name: 'Wohnzimmer'`, `label` unchanged, `kind` present.
  - `blank or null resets` – `'   '` → `name: null`; `null` → `null`.
  - `refuses invalid names, keeps emoji` – 400 `invalid_name` for `'a'.repeat(41)`, `'Wohn\u0000zimmer'`, `'a\tb'`, `'‮evil'`, `'⁦x'`; 200 for `'Wohnzimmer 📺'`, `'👨‍👩‍👧 Familie'`, `'📺'.repeat(40)`; 400 for `'📺'.repeat(41)`; `'Wohn   zimmer'` → `'Wohn zimmer'`.
  - `a foreign or missing device is 404` – another account's device id → 404 and its row unchanged; a made-up id → 404.
  - `kids profiles cannot rename` – 403 `kids_profile`.
  - `audited without the name` – `audit_log` row `device.rename`, its `meta` does not contain `Wohnzimmer`.
  - `admin views show the custom name` – `GET /api/admin/devices` and `GET /api/admin/users/:id` list `Wohnzimmer`.
- [ ] **Step 2: Run** the file → FAIL.
- [ ] **Step 3: Implement** `cleanDeviceName`, the route and the list changes.
- [ ] **Step 4: Verify** the file → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(devices): rename your own devices`

### Task 3: Hand-off write path

**Implementer:** Opus (hard: touches the cast engine) · backend + `web/src/lib/cast/engine.ts`

**Files:**
- Create: `backend/src/handoff.ts` (write part)
- Modify: `backend/src/live.ts` (`Live.seriesId?: string`), `backend/src/routes/media.ts` (`reportBody.via`, `PlaybackReporter.via`, the upsert in `playbackReport`, `seriesId` in the live record built there), `backend/src/routes/cast.ts` (`/api/cast/report` passes `via: 'chromecast'`), `web/src/lib/cast/engine.ts` (`report()` body carries `via: s.view.kind`)
- Test: `backend/test/handoff.test.ts` (describe `write`), `web/src/lib/cast/engine.test.ts`, `web/src/lib/cast/engine.airplay.test.ts`

**Interfaces:**
- Produces: `export type HandoffVia = 'airplay' | 'chromecast'`; `export async function noteHandoff(ctx: Pick<Ctx, 'db'>, w: { userId: string; profileId: string; deviceId: string; itemId: string; seriesId?: string; positionTicks: number; runtimeTicks?: number; via: HandoffVia | null; start: boolean }): Promise<void>` – never throws; first deletes the profile's rows older than 24 h, then upserts on `(profile_id, device_id)`: `position_ticks`, `via`, `updated_at = now()` always; `started_at = now()` when `start` or the item changed; `series_id` / `runtime_ticks` replaced when the item changed, else `coalesce(new, old)`. On error: `console.warn('handoff write failed', <error name or pg code>)` – no message, no ids.
- `reportBody` gains `via: z.enum(['airplay', 'chromecast']).optional()`; `PlaybackReporter` gains `via?: HandoffVia`; `/api/playback/*` passes `via` from the body.
- `playbackReport` calls `noteHandoff` after `ctx.jf.report(...)` for every kind when `who.profile` and `who.deviceId` are set, with `itemId`, `live.seriesId`, `ticks`, `live.runtimeTicks`, `start: kind === 'Playing'`.
- Engine: every `/api/playback/{start,progress,stop}` body it sends has `via: 'airplay' | 'chromecast'`.

- [ ] **Step 1: Write the failing tests**
  - backend `write`: `start writes the row` (item, series, runtime, `via` null, position); `progress keeps started_at, start or a new item resets it`; `via from the body` (`'airplay'` stored; `'x'` → 400); `/api/cast/report writes via chromecast` (reuse the report-token setup of `backend/test/cast.test.ts`); `no row without a device` (call `playbackReport` directly with `deviceId: undefined`); `a failing write never fails the report` (device row missing → report 200, no row, `console.warn` spy args contain neither the device id nor the item id); `rows older than 24 h go on write`.
  - web: `report bodies carry via` in `engine.test.ts` (Chromecast: `'chromecast'`) and `engine.airplay.test.ts` (`'airplay'`).
- [ ] **Step 2: Run** the three files → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** the three files → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(handoff): remember per profile and device what played last`

### Task 4: `GET /api/handoff`

**Implementer:** Sonnet (routine) · backend

**Files:**
- Modify: `backend/src/handoff.ts` (read part), `backend/src/routes/media.ts` (route)
- Test: `backend/test/handoff.test.ts` (describe `read`)

**Interfaces:**
- Consumes: `noteHandoff` rows (Task 3), `devices.client` / `devices.name` (Tasks 1–2), `ClientKind`.
- Produces: `export interface HandoffAnswer { id: string; itemId: string; type: 'Movie' | 'Episode'; title: string; year?: number; seriesName?: string; season?: number; episode?: number; imageId: string; positionTicks: number; runtimeTicks?: number; ageSec: number; device: { kind: ClientKind; name?: string; via?: HandoffVia } }` (spec §2.3 plus `year` for the film line of §2.4).
- Produces: `export async function selectHandoff(ctx: Ctx, who: { userId: string; profileId: string; deviceId: string; jfUser: JfUser }, item?: string): Promise<HandoffAnswer | null>` with the selection of spec §2.3 steps 1–5 (60 s = `600_000_000` ticks; 6 h; ≥ 90 % of `runtime_ticks` only when the runtime is known; `resume_hidden` for item or series with `hidden_at >= updated_at`; `dropped` for item or series; item loaded with `who.jfUser`, a `MediaError` 404/403 deletes the row; `played` → null).
- `id` = first 16 hex of `sha256(device_id + '|' + item_id + '|' + started_at.toISOString())`; `ageSec` = `extract(epoch from now() - updated_at)` floored; `device.kind` = `client ?? 'web'`; `device.name` = `name ?? (kind === 'web' ? label : undefined)`; `imageId` = the episode's id when it has an image, else its series id; films their own id.
- Route: `GET /api/handoff?item=<id32>` (`requireUser(ctx)`, `config: { rateLimit: { max: 60, timeWindow: '1 minute' } }`, `Cache-Control: no-store`) → `{ handoff: HandoffAnswer | null }`.

- [ ] **Step 1: Write the failing tests** (rows inserted directly; device A = the caller, device B = an LG row with `client 'webos'`):
  - `offers the other device's newest playback` – B played Dunmoor E4 to 1390 s, `updated_at = now() - interval '12 minutes'` → `itemId` E4, `positionTicks 13_900_000_000`, `ageSec` 720 ± 5, `device { kind: 'webos' }` without `name`, `id` matches `/^[0-9a-f]{16}$/`.
  - `nothing when the newest row is this device`; `nothing after 6 h` (6 h 1 min); `nothing under 60 s` (59 s); `nothing from 90 %` (runtime 2832 s: 2549 s → null, 2548 s → offered); `no runtime known: offered from 60 s`.
  - `played → null`; `hidden after the playback → null, hidden before → offered`; `dropped series → null`.
  - `?item= matches the episode or its series` – `item=<seriesId>` answers the series' newest row while a film is newer overall; an unrelated id → null.
  - `a title gone deletes the row` – fake Jellyfin 404 → null and the row is deleted.
  - `kids profile: own rows, looked up as its own Jellyfin user` – the item call's user id is the kids profile's.
  - `profiles are isolated` – rows of another profile never answer.
  - `custom name and via` – B renamed `Wohnzimmer` → `device.name 'Wohnzimmer'`; a `web` row with label `Safari auf iPhone` → that name; `via 'airplay'` → `device.via 'airplay'`.
  - `the answer carries no device id, play session id or URL` – `JSON.stringify(answer)` contains neither device id, nor `/media`, nor `http`; header `cache-control: no-store`.
  - `24 h cleanup on read`.
- [ ] **Step 2: Run** the file → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(handoff): GET /api/handoff offers what another device played`

### Task 5: Web device names and renaming on *Geräte*

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/handoff/deviceName.ts`, `web/src/lib/handoff/deviceName.test.ts`
- Modify: `web/src/lib/api.ts` (`export type ClientKind`; `OwnDevice` gains `name: string | null; kind: ClientKind | null`), `web/src/routes/devices/+page.svelte` (display name + inline rename), `web/src/lib/account/SessionsCard.svelte` (display name), locales `common.ts` (`deviceKind`) and `account.ts` (`devices.rename`, `renameAria`, `nameLabel`, `useAuto`, `renamed`, `nameInvalid`, `renameFailed`) in all seven languages, `e2e/mocks/api.ts` (`MockDevice.name/kind`, `PATCH /api/devices/:id` handler that applies the name and logs)
- Test: `e2e/tests/devices-rename.spec.ts`

**Interfaces:**
- Consumes: `PATCH /api/devices/:id`, `GET /api/devices` fields (Task 2).
- Produces (`deviceName.ts`): `export function deviceName(d: { kind?: ClientKind | null; name?: string | null; label?: string | null }, tf: TFn): string` (custom name → `common.deviceKind.<kind>` for non-web kinds → label → `common.unknown`); `export function castLabel(via: 'airplay' | 'chromecast', sender: string, tf: TFn): string` (`common.deviceKind.airplay` / `.chromecast` with `{ sender }`); `export function cleanName(raw: string): { ok: true; name: string | null } | { ok: false }` (same rules as the server's `cleanDeviceName`).
- Rename UI per spec §2.8 (inline form in the row, `common.save` / `common.cancel`, Enter / Escape, focus back to the rename button, field `maxlength="40"`, placeholder = `deviceName` without the custom name, rows reserve the field's height, error `role="alert"` + `aria-invalid`, success through the page's existing `role="status"` line).

- [ ] **Step 1: Write the failing tests**
  - unit: `custom name wins` (`{ kind: 'webos', name: 'Wohnzimmer', label: 'Fernseher (TV-Modus)' }` → `Wohnzimmer`); `kind names` (tizen `Samsung-Fernseher`, webos `LG-Fernseher`, firetv `Fire TV`, desktop `Windows-App`, android `Android-App`); `web and unknown kinds use the label`; `castLabel` → `AirPlay (Safari auf iPhone)`; `cleanName mirrors the server` (the cases of Task 2).
  - e2e `devices-rename.spec.ts`: `rename a device to Wohnzimmer` (row shows `LG-Fernseher`; button `LG-Fernseher umbenennen` opens the field `Gerätename`; the next row's y is unchanged; type `Wohnzimmer`, Enter → log has `PATCH /api/devices/<id> {"name":"Wohnzimmer"} -> 200`, status `Das Gerät heißt jetzt „Wohnzimmer“.`, focus on `Wohnzimmer umbenennen`); `Escape cancels` (no PATCH); `an invalid name shows the error` (`‮evil` → alert `Bitte 1 bis 40 Zeichen ohne Steuerzeichen.`, no PATCH); `use the detected name` (renamed device → `Automatischen Namen verwenden` → PATCH `{"name":null}`).
- [ ] **Step 2: Run** unit file and the spec → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** both → PASS; root `npm run typecheck`; the i18n tests `npx -w web vitest run src/lib/i18n` (they check every German key exists in each language).
- [ ] **Step 5: Commit** `feat(devices): rename devices on Geräte; custom names everywhere`

### Task 6: Hand-off card on desktop and phone, and its action

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/handoff/handoff.ts`, `web/src/lib/handoff/handoff.test.ts`, `web/src/lib/handoff/HandoffCard.svelte`
- Modify: `web/src/routes/+page.svelte` (load after mount and in `refreshProgress()`; render the card into the hosts' slot; not when `$kidsMode`), `web/src/lib/desk/DeskBillboard.svelte` and `web/src/lib/Hero.svelte` (`<slot name="handoff" />` right after the `<h1>`), `web/src/lib/cast/playOrCast.ts` (option `explicitStart`), locales `home.ts` (`handoff.region`, `last`, `play`, `playAria`, `dismiss`, `justNow`), `web/src/lib/admin/glass.test.ts` (scan `HandoffCard.svelte`: transform / opacity only, `html.m-still` off, reduced-motion block), `e2e/mocks/api.ts` (`MockState.handoff: { home: unknown | null; byItem: Record<string, unknown> }`, `GET /api/handoff`)
- Test: `e2e/tests/home-handoff.spec.ts`, `e2e/tests/home-handoff.mobile.spec.ts`, `e2e/tests/android-handoff.mobile.spec.ts`

**Interfaces:**
- Consumes: `GET /api/handoff` (Task 4), `deviceName` / `castLabel` (Task 5), `fmtClock` (`#lib/api`), `fmtRelative` (`#lib/i18n`, used as is: "vor 12 Minuten").
- Produces (`handoff.ts`): `export type Handoff` (= Task 4's `HandoffAnswer`, with `ClientKind` from `#lib/api`); `loadHandoff(item?: string): Promise<Handoff | null>` (any error → null); `DISMISS_KEY = 'ff-handoff-dismissed'`, `DISMISS_MAX = 20`; `isDismissed(id: string, store?: Storage | null): boolean`; `dismiss(id: string, store?: Storage | null): void` (last 20 ids, every access in try/catch, an in-memory set when storage throws); `handoffDevice(h: Handoff, tf: TFn): string`; `handoffTime(ticks: number): string` (`fmtClock(Math.floor(ticks / 1e7))`); `handoffAge(ageSec: number, tf: TFn, now?: number): string` (< 120 s → `home.handoff.justNow`); `handoffTitle(h: Handoff, tf: TFn): string` (episode: `Dunmoor S1:F4 · The Lantern Road` via `detail.view.episodeCode`; film: `title · year`); `handoffHref(h: Handoff): string` (`/watch/<itemId>?t=<seconds>`).
- Produces: `HandoffCard.svelte` props `handoff: Handoff | null`, `layout: 'desk' | 'phone' | 'tv'`; event `dismiss` with the id. Content, placement, sizes and motion of spec §2.4 (desk: top right inside `--pad-x` below the top bar, 380 px, `.frost .frost-safe .frost-panel`, radius 24, thumbnail; phone: under header and chips, 16 px gutters, absolute; enter opacity + `translateY(-8px)` 240 ms `outEase`, leave opacity 180 ms). `role="region"` named `home.handoff.region`; no live announcement. Each host places the slot at the earliest point after its `<h1>` whose containing block is the host root; on the phone carousel layout the card follows the page's `sr-only` `<h1>` in `+page.svelte`.
- Produces: `playOrCast(e, item, opts?: { audio?: string; subtitle?: string; explicitStart?: boolean })` – with `explicitStart` the native request carries `item.positionTicks` (→ `startMs`); the cast and web paths are unchanged. The card's primary button is a link to `handoffHref(h)` whose click calls `playOrCast(e, { id: h.itemId, positionTicks: h.positionTicks }, { explicitStart: true })` (web player via the href, native app with `startMs`, a running cast on the TV at that position).

- [ ] **Step 1: Write the failing tests**
  - unit `handoff.test.ts`: `device line per kind, custom name and via` (`AirPlay (Safari auf iPhone)`); `dismissal keeps the last 20 and survives a throwing storage`; `time m:ss and h:mm:ss` (1390 s → `23:10`, 3725 s → `1:02:05`); `age` (90 s → `gerade eben`, 720 s → `vor 12 Minuten`); `title lines` (episode and film); `href` (`/watch/<id>?t=1390`).
  - e2e desktop: `card overlays the billboard and moves nothing` (route answers after 500 ms; first `section.row` y identical before and after; region `Auf einem anderen Gerät angefangen` shows `Zuletzt auf LG-Fernseher · vor 12 Minuten`, `Dunmoor S1:F4 · The Lantern Road`, button named `Hier weiterschauen: Dunmoor S1:F4 · The Lantern Road ab 23:10, zuletzt auf LG-Fernseher` with text `Hier weiterschauen ab 23:10`); `reading order` (the region follows the `h1` and precedes the billboard's Play link in DOM order); `continue goes to the position` (URL `/watch/<E4>?t=1390`); `Ausblenden hides it for good` (gone, still gone after reload, a new `id` brings it back); `no card when there is none or the request fails` (null; 500 → no region, no error text); `a slow answer moves nothing` (2.5 s delay, row y unchanged); `kids profiles never ask` (`/kids` makes no `/api/handoff` request).
  - e2e mobile: `card under the header, full width, scrolls with the page` (box x = 16, width = 358; row y unchanged; after `scrollBy(0, 200)` the card's y is 200 smaller).
  - e2e android (`fakeNativeApp`): `the card's action plays natively at the position` (`nativeCalls(page, 'play')` args include `startMs: 1_390_000`).
- [ ] **Step 2: Run** the unit file and the three specs → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts src/lib/cast/playOrCast.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(home): continue here what another device played`

### Task 7: Hand-off card in TV mode

**Implementer:** Opus (hard: focus and spatial navigation on three TV platforms) · frontend

**Files:**
- Modify: `web/src/lib/tv/TvFocusTile.svelte` (slot `handoff` after its `<h1>`), `web/src/lib/handoff/HandoffCard.svelte` (TV layout and keys), `web/src/lib/handoff/handoff.ts` (`shouldTakeFocus`), `web/src/routes/+page.svelte` (mount time, first key press)
- Test: `web/src/lib/handoff/handoff.test.ts`, `e2e/tests/tv-handoff.spec.ts`

**Interfaces:**
- Consumes: `HandoffCard` (Task 6), `tvFocus` (`#lib/tv/focus`), `isBackKey` (`#lib/spatial`).
- Produces: `export function shouldTakeFocus(o: { mountedAt: number; arrivedAt: number; keyPressed: boolean }): boolean` (true only when `arrivedAt - mountedAt <= 2000` and no key yet).
- TV layout shows the 16:9 thumbnail (`img(h.imageId, …)`) like desktop.
- Card props added: `tvVisible: boolean` (the page passes `$tvFocus === null`; false fades the card out without dismissing), `focusTile: () => void` (focuses the tile's `[data-autofocus]`). TV rules of spec §2.4: solid panel, tile type scale, top right inside `--tv-gutter`; the primary button takes focus per `shouldTakeFocus`; Up from the tile's buttons reaches the card; Right moves to *Ausblenden*; Back on the card calls `focusTile()` without dismissing; after *Ausblenden* `focusTile()`.

- [ ] **Step 1: Write the failing tests**
  - unit: `shouldTakeFocus` (1.9 s no key → true; 2.1 s → false; key pressed → false).
  - e2e (TV via `/api/me` `tv: true`, as `tv-layout.spec.ts` does): `an early answer takes focus and OK plays` (focus on `Hier weiterschauen ab 23:10`; Enter → `/watch/<E4>?t=1390`); `a late answer does not take focus` (3 s delay → focus stays on the tile's Play; ArrowUp reaches the card); `Back returns to the tile without dismissing`; `Right then OK dismisses and focus returns to the tile`; `moving into the rows fades the card, coming back shows it` (opacity 0 then 1, still in the DOM, not dismissed); `the card is solid on TV` (no `backdrop-filter`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(tv): the hand-off card works with the remote`

### Task 8: Title-page hint

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Modify: `web/src/lib/detail/DetailView.svelte` (load `loadHandoff(item.id)` with the page; `hint = hintFor(answer, playTarget)`; play href with `t=`; `castPlay` passes the hand-off position; accessible name), `web/src/lib/detail/DetailDesk.svelte` (prop `handoffLine` replaces its `remaining` text; prop `playAria`), `web/src/lib/detail/DetailTv.svelte` (receives the replaced `resumeLine` and `playAria`), `web/src/lib/handoff/handoff.ts` (`hintFor`), locales `detail.ts` (`view.handoffLine`, new `view.handoffAria`: DE `{play}, weiter ab {time}, zuletzt auf {device}`, EN `{play}, continue from {time}, last on {device}`), `e2e/mocks/api.ts` (`byItem` answers)
- Test: `web/src/lib/handoff/handoff.test.ts`, `e2e/tests/detail-handoff.spec.ts`

**Interfaces:**
- Consumes: `loadHandoff`, `handoffTime`, `handoffDevice`, `handoffHref` (Task 6).
- Produces: `export function hintFor(h: Handoff | null, playTarget: string): Handoff | null` (h only when `h.itemId === playTarget`).
- Rules of spec §2.5: the button label never changes; the line swaps in place of the existing resume line (series: `[episodeCode, handoffLine].join(' · ')`; film: `handoffLine`). When the page has no resume line at that moment, no line is added (that would move the page); the play action and the accessible name still carry the hint. The play href is `/watch/<target>?<audio/sub qs>&t=<sec>`; native and cast plays start at the hint's position (`explicitStart`).

- [ ] **Step 1: Write the failing tests**
  - unit: `hintFor` (matching / other item / null).
  - e2e: `series page shows the hand-off line` (`S1:F4 · Weiter ab 23:10 (zuletzt auf LG-Fernseher)`; Play href ends `t=1390`; Play's accessible name `Fortsetzen, weiter ab 23:10, zuletzt auf LG-Fernseher`; the Play button's width is unchanged); `film page shows it without the episode code`; `nothing for this device's own playback` (answer null → the normal resume line); `no resume line: nothing is added, the link still starts at the position`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(detail): title page says where you stopped on another device`

### Task 9: Docs PR 1 and owner checks

**Implementer:** Sonnet (routine) · docs

**Files:** `docs/tv-mode.md` (the card with the remote), `docs/privacy.md` and `docs/de/privacy.md` (hand-off data and custom device names: what, how long, deleted with device / profile / account), `docs/windows.md` and `docs/de/windows.md` (the card's action opens mpv at the position), `docs/security.md` (hand-off answer carries no ids; rename ownership), `CHANGELOG.md` under *Unreleased*, `README.md` / `README.de.md` (one feature line each).

- [ ] **Step 1: Write the docs** in each file's language and style.
- [ ] **Step 2: Put owner checks A1–A5 of spec §9** (A5: rename the LG TV to "Wohnzimmer", the Windows app's card reads "Zuletzt auf Wohnzimmer") into the PR description as an unchecked list.
- [ ] **Step 3: Commit** `docs: continue here on another device, device names`

---

## PR 2 — C + D: media controls and AirPlay status (Tasks 10–14)

### Task 10: Media Session owner token and the player binding module

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Modify: `web/src/lib/cast/mediasession.ts` (owner token; the cast binding claims on bind, clears only what it still owns)
- Create: `web/src/lib/player/mediasession.ts`, `web/src/lib/player/mediasession.test.ts`
- Test: `web/src/lib/cast/mediasession.test.ts`

**Interfaces:**
- Produces (cast/mediasession.ts): `claimMediaSession(owner: symbol): void`; `releaseMediaSession(owner: symbol): boolean` (true when `owner` held it; then the owner is `null`; a non-owner's release is a no-op returning false); `mediaSessionOwner(): symbol | null`; `onMediaSessionOwner(fn: (o: symbol | null) => void): () => void`. `MediaSessionLike` stays exported.
- Produces (player/mediasession.ts): `PLAYER_ACTIONS = ['play', 'pause', 'seekto', 'seekbackward', 'seekforward', 'nexttrack', 'previoustrack'] as const`; `interface PlayerMediaItem { title: string; artist: string; artworkIds: string[] }`; `interface PlayerMediaActions { play(): void; pause(): void; seekTo(sec: number): void; seekBy(delta: number): void; next: (() => void) | null; prev: (() => void) | null }`; `interface MediaElementLike extends EventTarget { currentTime: number; duration: number; playbackRate: number; paused: boolean }`; `bindPlayerMediaSession(el: MediaElementLike, item: PlayerMediaItem, actions: PlayerMediaActions, ms?: MediaSessionLike, meta?: (m: { title: string; artist: string; artwork: Array<{ src: string }> }) => unknown, now?: () => number): { update(item: PlayerMediaItem, actions: PlayerMediaActions): void; release(): void }`.
- Behaviour of spec §3.1: artwork `img(id, 512)` per id, no `sizes`; seek offsets default 10 s; position state on `loadedmetadata`, `seeked`, `ratechange` and at most once per 1000 ms on `timeupdate`, position clamped to `[0, duration]`, skipped while `duration` is not finite; `playbackState` mirrors `play` / `pause` events; unsupported actions caught. Writes only while it owns the session; when the owner returns to `null` while still bound it claims again and re-applies metadata, handlers and position.

- [ ] **Step 1: Write the failing tests**
  - `binds metadata, handlers and position` (title `The Lantern Road`, artist `Dunmoor · S1:F4`, artwork srcs `/media/Items/<id>/Images/Primary?maxWidth=512&quality=85` for episode and series, no `sizes` key).
  - `actions call the player` (`seekbackward({})` → `seekBy(-10)`, `seekforward({ seekOffset: 30 })` → `seekBy(30)`, `seekto({ seekTime: 120 })` → `seekTo(120)`, `nexttrack` → `next`).
  - `no next or previous without a target` (handlers set to `null`).
  - `position clamped and at most once a second`.
  - `artwork never carries a cast token` (no `/media/c/` in any src).
  - `the cast binding takes over and gives back` (player bound; a live cast session → cast metadata; player `release()` meanwhile leaves the cast's metadata; cast ends → player metadata again, and `metadata` was never set to `null` in between).
  - `a throwing setActionHandler is caught`; `release clears what it owns`.
- [ ] **Step 2: Run** both files → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(player): Media Session module with a single owner`

### Task 11: The player binds Media Session

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Modify: `web/src/lib/Player.svelte` (bind while it plays locally: started, not `remote`, not `handedOff`, not `airOn`; release on destroy and when that ends; new prop `prevEpisodeId: string | null = null`), `web/src/routes/watch/[id]/+page.svelte` (passes `prevEpisodeId`)
- Create: `e2e/mocks/mediasession.ts` (`stubMediaSession(page)` init script recording `metadata`, handlers, `positionState`, `playbackState`; `mediaSessionLog(page)`)
- Test: `e2e/tests/player-mediasession.spec.ts`

**Interfaces:**
- Consumes: `bindPlayerMediaSession` (Task 10).
- Item: episode → title = episode name, artist = `<seriesName> · <episodeCode>`, artwork ids `[episode id, series id]`; film → title, artist = year, artwork `[id]`. Actions: `play` / `pause` call `togglePlay()` only when the state differs; `seekTo` → `seekTo(t)`; `seekBy` → `seekBy(d, true)`; `next` → `goNext()` when `hasNext`; `prev` → `dispatch('episode', { id: prevEpisodeId })` when set.
- `prevEpisodeId`: the watch page reads `GET /api/items/<seriesId>/episodes?seasonId=<seasonId>` (the request `EpisodesPanel` makes) once per episode after playback started, and takes the episode right before the current one; the first of a season, films and errors → `null`.

- [ ] **Step 1: Write the failing tests** (e2e, `stubMediaSession`): `local playback fills the media session` (metadata, artwork without `/media/c/`, handlers incl. `nexttrack` when a next episode exists and `previoustrack` on episode 2, none on episode 1); `a lock-screen pause pauses the player` (call the `pause` handler → `video.paused`); `leaving the player clears it` (Back → metadata `null`, handlers `null`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(player): lock screen and media keys control local playback`

### Task 12: AirPlay controller — connecting phase, 30 s timeout, position guard

**Implementer:** Opus (hard: AirPlay controller and cast engine) · frontend

**Files:**
- Modify: `web/src/lib/player/airplay.ts`, `web/src/lib/cast/engine.ts` (airDeps `connectTimeout`), `web/src/lib/Player.svelte` (`AIR_IDLE.connecting = false`)
- Test: `web/src/lib/player/airplay.test.ts`, `web/src/lib/cast/engine.airplay.test.ts`

**Interfaces:**
- Produces: `AirPlayState.connecting: boolean` – true from "TV picked" (a `connecting` event on `video.remote` or `video.remote.state === 'connecting'`, or wireless reported while our token is on the element) until the first `playing` while wireless, the timeout, or a restore; `export const CONNECT_TIMEOUT_MS = 30_000`; `export const POSITION_TOLERANCE_S = 5`; `AirPlayDeps.connectTimeout?(): void`; `AirPlayController.cancel(): void` (busy / ready / connecting and not yet playing on the TV: revoke and restore exactly like the arm timeout; otherwise no-op); `AirPlayVideo.remote` may carry `addEventListener`.
- Position guard (spec §4.2): the controller remembers the position it put the token URL on the element at; on the first `playing` while wireless for that token, if `|currentTime − pos| > 5` it sets `currentTime = pos` once; never again for that token.
- Log lines through `airLog`: `connecting`, `position corrected`, `connect timeout` (no URL, token or castId).
- Engine: `connectTimeout` → when the session is still `connecting`, `patch(s, { state: 'reconnect' })` and log; the Player's own deps ignore it (the hand-off follows `active`).

- [ ] **Step 1: Write the failing tests**
  - airplay: `phases busy → ready → connecting → active → playing` (emitted states in that order; `connecting` false after the first `playing`); `no playing within 30 s of the pick → connectTimeout once` (fake timers: 29 999 ms nothing, 30 000 ms once; a later `playing` adds nothing); `the picker closed without a TV never arms the timeout` (ready, `ARM_MS` passes, restore runs, `connectTimeout` never called, `connecting` never true); `first playing more than 5 s off seeks once` (token at 1390 s, TV reports 0 → `currentTime` 1390; a second `playing` at 0 → no seek); `within 5 s → no seek`; `cancel while busy restores and revokes`; `log lines carry no URL`.
  - engine: `connect timeout turns the remote screen to reconnect`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(airplay): a connecting phase, a 30 s timeout and one position correction`

### Task 13: AirPlay connecting layout and wording

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Create: `web/src/lib/player/AirPlayConnecting.svelte`
- Modify: `web/src/lib/Player.svelte` (render it over the video area while `airState.busy || airState.connecting` and the session is not handed off), locales `player.ts` (`castBar.airplayDevice` → DE/EN `AirPlay`; new `airplay.cancel` `Abbrechen` / `Cancel`), `web/src/lib/admin/glass.test.ts` (scan the new component), `e2e/tests/player-airplay.mobile.spec.ts`

**Interfaces:**
- Consumes: `AirPlayState.connecting`, `AirPlayController.cancel()` (Task 12).
- Produces: `AirPlayConnecting.svelte` props `backdropId: string | null`, `onCancel: () => void`. The title's backdrop with the remote screen's dim treatment (never the video frame), decorative spinner in the play slot, `role="status"` text `tr('player.castRemote.connecting', { device: tr('player.castBar.airplayDevice') })` = "Verbinde mit AirPlay …", *Abbrechen* (`player.airplay.cancel`) → `air.cancel()`. An overlay (nothing moves); phase changes crossfade with opacity 120 ms; calm mode 0 ms.
- The remote screen and cast bar read "Verbinde mit AirPlay …" / "Auf AirPlay · noch 32 Min." through the changed device word; the playing label stays `player.airplay.playing`.

- [ ] **Step 1: Write the failing tests** (e2e mobile, existing `stubAirPlay` / `castSessions` / `wireless` helpers): `busy shows the connecting layout over the backdrop` (POST delayed; status `Verbinde mit AirPlay …`; the overlay covers the video's box); `the remote screen says Verbinde mit AirPlay …, then Läuft über AirPlay` (wireless on → status; `playing` → eyebrow); `Abbrechen restores local playback` (log has `DELETE /api/cast/session/<id>`); `closing the picker without a TV hides the connecting layout` (no layout once the arm window ends).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(airplay): say what AirPlay is doing instead of freezing`

### Task 14: Docs PR 2 and owner checks

**Implementer:** Sonnet (routine) · docs

**Files:** `docs/cast.md` (AirPlay states and the 30 s timeout, lock screen / Control Center via Media Session, the platform limits of spec §4.3), `docs/windows.md` + `docs/de/windows.md` (mpv keeps its media keys; the web-player fallback uses Media Session, WebView2 forwarding recorded by the owner), `CHANGELOG.md` *Unreleased*.

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Owner checks C1, C2, D1 of spec §9** into the PR description.
- [ ] **Step 3: Commit** `docs: media controls and AirPlay status`

---

## PR 3 — E: continuous AirPlay behind the admin switch (Tasks 15–22)

Replaces Tasks 22–28 of the cast plan with spec §5's amendments: no GO gate before merging, the admin switch alone (no profile opt-in), the spike's §4 conditions as requirements, acceptance on the owner's LG webOS AirPlay TV only (Task 23).

### Task 15: Admin switch `CAST_AIRPLAY_CONTINUOUS` and `continuous_off`

**Implementer:** Sonnet (routine) · backend + admin settings UI

**Files:**
- Modify: `backend/src/config.ts`, `backend/src/settings/registry.ts`, `backend/src/cast.ts` (`airplayContinuousOn`), `backend/src/routes/cast.ts` (`/api/cast/config`, body fields), `compose.yaml` + `compose.prod.yaml` (generated block: `npm run compose:env`), `backend/test/helpers.ts` (cfg default), `web/src/lib/admin/settings/form.ts` + `SettingRow.svelte` (*Experimentell* badge), `web/src/lib/admin/settings/settings.test.ts` (`KEYS`), locales `settings.ts` (label + help of spec §7, seven languages), `web/src/lib/cast.ts` (`castConfigAirplayContinuous`)
- Test: `backend/test/cast-continuous.test.ts`, `backend/test/settings-registry.test.ts`, `web/src/lib/admin/settings/settings.test.ts`

**Interfaces:**
- Produces: config `CAST_AIRPLAY_CONTINUOUS: z.enum(['true', 'false']).default('false')`; registry `setting('CAST_AIRPLAY_CONTINUOUS', { kind: 'bool', group: 'playback' })` (applies live, stored in `settings`).
- Produces: `export const airplayContinuousOn = (ctx: Ctx): boolean => castEnabled(ctx) && ctx.cfg.CAST_AIRPLAY_CONTINUOUS === 'true' && ctx.jf.kind === 'jellyfin'` (joined playlists are built from Jellyfin's HLS playlists; Plex never offers it).
- `/api/cast/config` → `{ enabled, receiverAppId?, airplayContinuous: boolean }`.
- `POST /api/cast/session` body gains `continuous: z.boolean().optional()`, `maxEpisodes: z.number().int().min(1).max(3).optional()`; `continuous` with `via !== 'airplay'` → `400 bad_request`; with `airplayContinuous` off → `400 { error: 'continuous_off' }`; with it on, this task still mints a single token (Task 16 adds the joined path).
- Web: `castConfigAirplayContinuous(): boolean` (false until `/api/cast/config` answered).
- SettingRow shows `common.experimental` as a badge for keys in `EXPERIMENTAL_KEYS = new Set(['CAST_AIRPLAY_CONTINUOUS'])` (`form.ts`).

- [ ] **Step 1: Write the failing tests** – `registry: bool, playback, default false, live`; `config reports the switch` (off false; on true; on with Plex false; changed through the settings store without a restart); `continuous with the switch off is 400 continuous_off`; `continuous for Chromecast is 400 bad_request`; web `KEYS` includes the key and its German label exists.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (regenerate the compose block with `npm run compose:env`). **Step 4: Verify** the three files → PASS; `npx -w backend vitest run test/compose-env.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(cast): admin switch for continuous AirPlay, off by default`

### Task 16: Multi-item AirPlay token

**Implementer:** Opus (hard) · backend

**Files:**
- Modify: `backend/src/cast.ts` (`JoinedItem`, `CastRecord.items`, `CastAuth.scope.items` in `resolveCast`), `backend/src/routes/cast.ts` (joined mint and answer), `backend/src/media/types.ts` + `backend/src/jellyfin/service.ts` (`TrackList.subtitles[].index?: number`, filled by Jellyfin)
- Test: `backend/test/cast-continuous.test.ts` (port `git show spike/continuous-airplay:backend/test/joinedSpike.test.ts`; the mint code is in `git show spike/continuous-airplay:backend/src/routes/cast.ts`)

**Interfaces:**
- Consumes: `airplayContinuousOn`, body `continuous` / `maxEpisodes` (Task 15); `loadPrefs` (`backend/src/routes/prefs.ts`).
- Produces: `export interface JoinedItem { itemId: string; mediaSourceId: string; playSessionId: string; runtimeTicks?: number; hlsPath: string; hlsSubIndex?: number }` (`hlsPath` = the Jellyfin master path without `/media`, never a credential); `CastRecord.items?: JoinedItem[]` (item 0 = the record's own fields); `CastAuth.scope.items?: Array<Omit<JoinedItem, 'runtimeTicks'>>` (only `via 'airplay'`, kind `media`).
- Selection: the episode plus up to two following (`ctx.jf.nextEpisode`, across seasons), at most `maxEpisodes ?? 3`; a single token (no `items`, today's answer) when the profile's `autoplayNext` is false, the item is not an episode with a series, or no next episode exists; trailing episodes dropped while `Σ runtime − startTicks > 6 h`. TTL `castTtlSeconds(Σ runtime, startTicks)`. Counts as one stream.
- Per later episode one PlaybackInfo (start 0, same `maxBitrate` / `maxHeight`, `audioLang` = the language of episode 1's audio track, `hlsSubtitleIndex` = the index of the subtitle in `ctx.jf.tracks(jfUser, id).subtitles` whose language equals episode 1's chosen subtitle language, none → no subtitle for that part). No second PlaybackInfo.
- Minting needs `airplayContinuousOn`; resolving and serving a token never checks the switch, so a joined stream minted before the admin turned it off plays to its end (spec §5.2).
- Answer adds `joined: { items: Array<{ itemId: string; title: string; season?: number; episode?: number; start: number; duration: number }>; subtitles: boolean }` (seconds; `start` = sum of earlier runtimes; `subtitles` = every part carries one), `runtimeTicks` = Σ, `contentUrl` = `<PUBLIC_URL>/media/c/<ct>/joined/master.m3u8`.

- [ ] **Step 1: Write the failing tests** – `continuous picks the episode and the next two, across a season` (timeline `0 / r1 / r1+r2`, `contentUrl` ends `/joined/master.m3u8`, stored `hlsPath`s contain no `api_key` or token); `maxEpisodes 2 gives two`; `autoplay off, a film, or the last episode give a single token`; `cap keeps the joined runtime under 6 h`; `audio and subtitle by language per episode` (episode 1 subtitle index 3 `ger`, episode 3's `ger` is index 4 → its PlaybackInfo asks `SubtitleStreamIndex=4`); `a part without that subtitle → joined.subtitles false`; `scope lists each item as a tuple`; `a joined token keeps its scope after the switch is turned off`; `the profile-switch race revokes a joined token too`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS (and `test/cast.test.ts` unchanged green if PostgreSQL is there); root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(cast): one AirPlay token for several episodes in a row`

### Task 17: Gateway — joined playlists, short segment URIs, tuple scope

**Implementer:** Opus (hard) · gateway

**Files:**
- Create: `gateway/src/joined.ts` (port `git show spike/continuous-airplay:gateway/src/joinedSpike.ts` without the spike flag), `gateway/test/joined.test.ts` (port `gateway/test/joinedSpike.test.ts` from the spike, 24 tests, plus the new ones below)
- Modify: `gateway/src/gateway.ts` (`Authz.scope.items`; tuple `inScope`; per-item subtitle index for subtitle paths and the no-burn-in guard; routes; cache; subtitle warm-up; option `onJoinedSegment`)

**Interfaces:**
- Consumes: authz `scope.items` (Task 16).
- Produces (`joined.ts`): `joinPlaylists(parts: JoinPart[], o?: { shortUris?: boolean }): { text: string; parts: JoinedPartInfo[] } | null` – one VOD media playlist, `EXT-X-TARGETDURATION` = max, `EXT-X-DISCONTINUITY` before each later part, one `EXT-X-ENDLIST`; strict (refuses fMP4 maps, keys, byte ranges, masters, absolute or escaping URIs, unknown tags); with `shortUris` each video segment URI is `../s/<part>/<n>.ts` and `JoinedPartInfo.segments[n]` keeps the original URI (resolved against the part's playlist path, query included); `readMaster`, `joinedMaster(parts, withSubs)` (one variant, max `BANDWIDTH`, one `SUBTITLES` rendition `subs.m3u8` only when every part kept one).
- Routes, multi-item tokens only (single-item tokens and any query string → 403): `GET /media/c/<ct>/joined/master.m3u8`, `…/joined/main.m3u8` (short URIs), `…/joined/subs.m3u8` (prefixed URIs); `GET /media/c/<ct>/s/<part>/<n>.ts` → expanded to the part's original segment path and query, then the normal cast checks (`normalizeCastPath`, tuple `inScope`, authz) and the proxy; unknown part or index → 404.
- Tuple scope: an item is accepted only with its own media source and play session; subtitle paths and the burn-in guard use the index of the item in the path.
- Cache by token hash: `{ master, main, subs, parts: Array<{ itemId: string; segments: string[] }> }`, built once after authz (parts fetched in parallel), at most 50 entries, entries live 6 h, rebuilt on a miss; any part failing the URI check → the whole stream 502.
- Subtitle warm-up: after a build, fire-and-forget GET of the first subtitle segment of parts 2 and 3.
- `GatewayOptions.onJoinedSegment?: (e: { ct: string; part: number; itemId: string; positionTicks: number }) => void` – called for every `s/<part>/<n>.ts` fetch that passed authz, `positionTicks` from the original URI's `runtimeTicks` query parameter.

- [ ] **Step 1: Write the failing tests** – the ported spike tests (renamed off "spike") plus: `short segment URIs keep main.m3u8 small` (3 parts × 940 segments with Jellyfin's query string → `main.m3u8` < 200 KB); `s/<part>/<n>.ts expands to that part's own path and query`; `unknown part or index is 404`; `a single-item token gets 403 on /joined and /s`; `a query on /joined is 403`; `item 2's path with item 1's play session is 403`; `onJoinedSegment reports the segment's runtimeTicks`; `no api_key or media token in any emitted playlist`; `subtitle warm-up fetches parts 2 and 3 once`.
- [ ] **Step 2: Run** `npx -w gateway vitest run test/joined.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w gateway vitest run test/gateway.test.ts` (existing cast tests unchanged); root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(gateway): joined playlist with short segment URIs for continuous AirPlay`

### Task 18: Server-side per-episode progress

**Implementer:** Opus (hard) · gateway + backend

**Files:**
- Modify: `gateway/src/gateway.ts` (default `onJoinedSegment` = throttled progress sender), `backend/src/cast.ts` (`noteJoinedProgress`, `stopJoined`; `touch()` keeps the live record of the current part; revoke paths call `stopJoined`), `backend/src/routes/internal.ts` (`POST /internal/cast/progress`)
- Test: `backend/test/cast-progress.test.ts`, `gateway/test/joined.test.ts`

**Interfaces:**
- Consumes: `onJoinedSegment` (Task 17), `CastRecord.items` (Task 16), `playbackReport` with `PlaybackReporter.via` (Task 3).
- Gateway sender: per token, a call at once when the part changes, else at most every 15 s; `POST /internal/cast/progress` with `x-internal-secret`, body `{ token: ct, itemId, positionTicks }`, `AbortSignal.timeout(5000)`, never awaited by the segment response, errors swallowed, nothing logged.
- Backend route: `POST /internal/cast/progress` (internal secret, `rateLimit: false`): record by `hashToken(token)`; 404 when missing, not multi-item, or `itemId` not listed; → `{ ok: true }`.
- `export async function noteJoinedProgress(ctx: Ctx, hash: string, rec: CastRecord, p: { itemId: string; positionTicks: number }): Promise<void>` – state in KV `castjp:<hash>` `{ idx, pos, at }` (TTL = the token's); a new part: stop the previous part at its `runtimeTicks` when its last position ≥ `runtimeTicks − 300_000_000` (it played to its end), else at its last position; then `Playing` for the new part; the same part: `Playing/Progress` at most every 30 s. Reporter = the token's user, Jellyfin user, profile and device with `via: 'airplay'` (so hand-off rows follow the episode). No lead correction (spec decision 10). Log lines: none on success; failures as error class only.
- `export async function stopJoined(ctx: Ctx, hash: string, rec: CastRecord): Promise<void>` – stop of the current part at its last position; called where a multi-item token is revoked (`revokeCast`, `revokeCasts`). Expiry needs nothing: the last progress stands.

- [ ] **Step 1: Write the failing tests**
  - backend: `moving to episode 2 stops episode 1 at its runtime and starts episode 2` (Jellyfin report calls captured); `a seek into episode 2 stops episode 1 where it was` (episode 1 last at 300 s of 2832 s → stop at 300 s); `never more than one live stream` (`countLive` 1 throughout); `progress at most every 30 s`; `revoke stops the current episode at its last position`; `the hand-off row follows with via airplay`; `unknown token, unlisted item or single-item token is 404`.
  - gateway: `progress at once on a part change, then at most every 15 s`; `a hanging backend never delays the segment`; `the progress body carries no address`.
- [ ] **Step 2: Run** both files → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(cast): the server reports progress of continuous AirPlay per episode`

### Task 19: Web — continuous request, no sheet switch, Diagnose row

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Modify: `web/src/lib/cast.ts` (`JoinedInfo`, `CastInfo.joined`, `continuousFields`, `postAirPlayToken`), `web/src/lib/stillwatching.ts` (`episodesBeforeAsk`), `web/src/lib/Player.svelte` (`castRequest` for AirPlay goes through `postAirPlayToken` with `continuousFields`), `web/src/lib/cast/playOn.ts` + `PlayOnSheet.svelte` (remove the `continuous` row and `continuousAvailable`), locales `player.ts` (remove `castPicker.continuous` / `continuousHint` in all seven), `web/src/lib/cast/DiagnoseCast.svelte` (`continuous: castConfigAirplayContinuous() ? 'on' : null`), `e2e/mocks/cast.ts` (`castOn` option `airplayContinuous`)
- Test: `web/src/lib/cast.test.ts`, `web/src/lib/stillwatching.test.ts`, `web/src/lib/cast/playOn.test.ts`, `web/src/lib/cast/diagnose.test.ts`

**Interfaces:**
- Consumes: `castConfigAirplayContinuous` (Task 15), the joined answer (Task 16).
- Produces: `export interface JoinedInfo { items: Array<{ itemId: string; title: string; season?: number; episode?: number; start: number; duration: number }>; subtitles: boolean }`; `CastInfo.joined?: JoinedInfo`.
- Produces: `continuousFields(o: { episode: boolean; autoplay: boolean; sleepAfter: boolean; maxEpisodes: number }): { continuous?: true; maxEpisodes?: number }` (empty unless the config is on, it is an episode, autoplay is on and sleep-after is off).
- Produces: `postAirPlayToken(body: Record<string, unknown>): Promise<CastInfo>` – `POST /api/cast/session`; on `400 continuous_off` for a body with `continuous`, once more without `continuous` / `maxEpisodes`; no toast.
- Produces: `episodesBeforeAsk(p: Pick<Prefs, 'stillWatching' | 'stillWatchingEpisodes'>): number` = 3 when `stillWatching` is off, else `Math.min(3, Math.max(1, 1 + (p.stillWatchingEpisodes || 3) - chain))` with the module's autoplay chain.

- [ ] **Step 1: Write the failing tests** – `continuousFields` (config off / film / autoplay off / sleep-after → `{}`; else `{ continuous: true, maxEpisodes }`); `continuous_off retries once without continuous`; `episodesBeforeAsk` (off → 3; N 3, chain 0 → 3; chain 2 → 2; chain 5 → 1); `the sheet has no continuous row`; `Diagnose shows continuous on only with the switch`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; the i18n tests (`npx -w web vitest run src/lib/i18n`); root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(airplay): ask for a joined stream when the admin switch is on`

### Task 20: Cast engine in continuous mode

**Implementer:** Opus (hard: cast engine) · frontend

**Files:**
- Create: `web/src/lib/cast/joined.ts`, `web/src/lib/cast/joined.test.ts`
- Modify: `web/src/lib/cast/engine.ts`
- Test: `web/src/lib/cast/engine.airplay.test.ts`

**Interfaces:**
- Consumes: `JoinedInfo`, `continuousFields`, `postAirPlayToken`, `episodesBeforeAsk` (Task 19).
- Produces (`joined.ts`): `joinedAt(items: JoinedInfo['items'], pos: number): { index: number; offset: number }` (a position exactly on a boundary belongs to the later episode).
- Produces: `CastSession.joined?: { items: JoinedInfo['items']; index: number; streamPosition: number; streamDuration: number }`; while joined, `itemId`, `title`, `subtitle`, `position`, `duration` describe the current episode; `CastEngine.prev(): void` (new; seek to the previous boundary; no-op on the first or without `joined`); `next()` while joined seeks to the next boundary (no-op on the last); `seek(sec)` while joined is episode-relative.
- Renewal, audio or subtitle change and reconnect request a new joined stream at (current episode, offset) through `postAirPlayToken` + `continuousFields`; `continuous_off` falls back silently (single token, same episode and offset).
- Joined tokens (spec §5.4 f): the page sends no playback reports, runs no credits / up-next / skip-segment logic; `ended` on the element after the last part ends the session (token revoked, no page stop report).

- [ ] **Step 1: Write the failing tests** – `joinedAt` (inside, on a boundary, past the end); `the session shows the current episode` (stream 2900 s with r1 2832 s → episode 2, position 68); `next seeks to the next boundary, no-op on the last`; `prev seeks to the previous, no-op on the first`; `seek is episode-relative`; `no page progress reports for a joined token`; `a renewal restarts at the episode and offset` (POST body `itemId` episode 2, `startTicks 680_000_000`, `continuous: true`); `switch off: a renewal falls back to a single token` (first POST `400 continuous_off`, second without `continuous`, same position, no toast, session continues); `the stream ends after the last episode`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS (and `engine.test.ts` green); root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(airplay): the cast engine plays a joined stream episode by episode`

### Task 21: Remote screen and Media Session in continuous mode

**Implementer:** Sonnet (routine) · frontend

**Files:**
- Modify: `web/src/lib/cast/remotescreen.ts` (`continuousView`), `web/src/lib/cast/RemoteScreen.svelte` (continuous mode of cast spec §1), `web/src/lib/cast/mediasession.ts` (joined metadata, `previoustrack`, page visibility), `web/src/routes/+layout.svelte` (passes page visibility), locales `player.ts` (new `castRemote.episodeRange`: DE `S{s}:F{a}–F{b}`, EN `S{s}:E{a}–E{b}`)
- Test: `web/src/lib/cast/remotescreen.test.ts`, `web/src/lib/cast/mediasession.test.ts`, `e2e/tests/player-airplay.mobile.spec.ts`

**Interfaces:**
- Consumes: `CastSession.joined`, `castEngine.prev()` (Task 20).
- Produces: `continuousView(s: CastSession, tf: TFn): { info: string; line: string; list: Array<{ label: string; note: string; now: boolean }>; prevDisabled: boolean; nextDisabled: boolean } | null` using the shipped keys `player.castRemote.continuous`, `continuousInfo`, `inARow`, `now`, `minutes`, `episodeOf`, `played`, `left`, `prev`, `prevNone`.
- Remote screen while joined: info card with `common.experimental` badge; the scrubber covers the current episode only (`CastScrubber`'s single-episode range); transport's left slot *Vorherige Folge* (disabled on the first with `prevNone`); the list *Am Stück* as plain rows; no up-next card.
- `bindCastMediaSession(session, eng, ms?, meta?, page?: { visible(): boolean; onChange(fn: () => void): () => void })`; `Eng` gains `prev`; while joined: `previoustrack` → `eng.prev()` (null on the first); page hidden → metadata title = series name, artist = episode range (`episodeRange`, or two `episodeCode`s joined by `–` across seasons), position state over the whole stream; page visible → the current episode's metadata and position.

- [ ] **Step 1: Write the failing tests** – `continuousView` (`Folge 1 von 3`, list `Jetzt` / `44 Min.` / `47 Min.`, prev disabled on 1, next disabled on 3); media session `joined: series metadata and stream position while hidden, episode while visible`, `previoustrack only after the first episode`; e2e `continuous remote shows Folge 1 von 3 and the list` (joined answer from `castSessions` `deliver`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** → PASS; `npx -w web vitest run src/lib/admin/glass.test.ts`; root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(airplay): remote screen and lock screen in continuous mode`

### Task 22: Docs PR 3 — the switch and the acceptance procedure

**Implementer:** Sonnet (routine) · docs

**Files:** `docs/cast.md` (replace "Durchgehendes AirPlay (nicht verfügbar)" with: what it does, the admin switch, that it applies to every profile, the limits of cast spec §8 "Limits written down", and the owner's acceptance procedure of spec §5.5 on the merged build: LG webOS only, P1, P2, observations O1–O3, pass → on, fail → off), `docs/security.md` (the multi-item token: up to three items, tuple scope, short segment URIs expanded only in the gateway, the internal progress call, nothing logged), `ROADMAP.md` (continuous AirPlay: shipped dormant, waiting for the owner's run), `CHANGELOG.md` *Unreleased*: "Continuous AirPlay (experimental, off by default)".

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Put the acceptance checklist (P1, P2, O1–O3) into the PR description.**
- [ ] **Step 3: Commit** `docs(cast): continuous AirPlay behind an admin switch`

### Task 23 (after PR 3 is merged): outcome docs

**Implementer:** Sonnet (routine) · docs · only after the owner recorded the LG run

**Files:** `docs/cast.md`, `ROADMAP.md`, `CHANGELOG.md`.

- [ ] **Step 1:** Record the outcome: pass → "on" with the observations O1–O3; fail → the switch stays off, the feature dormant, `docs/cast.md` says so with the failed criterion. If O2 shows a stable lead, note it as the input for a later lead correction (not in this plan).
- [ ] **Step 2: Commit** `docs(cast): continuous AirPlay acceptance outcome`
