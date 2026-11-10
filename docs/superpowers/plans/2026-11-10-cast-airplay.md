# Cast & AirPlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Casting feels finished everywhere it shows: a redesigned remote screen (desktop, phone, AirPlay), a floating cast bar with an expanded state and honest error states, one "Play on" sheet, a restyled TV receiver with pause and loading screens, a casting section on `/diagnose`, the cast bar inside the Android app; a Chromecast cast survives closing the tab and is picked up again; AirPlay carries subtitles in the stream; continuous AirPlay ships as an experimental setting only if its spike passes.

**Architecture:** The cast engine (`web/src/lib/cast/engine.ts`) stays the single owner of a cast on the web. It stops ending Chromecast casts on `pagehide` and gains `resume()`, which re-adopts FriendFlix media found on the receiver through a new, token-free lookup (`GET /api/cast/session/:castId`, castId derived in the browser from the receiver's content URL). UI is new components that only read `castSession` and call `castEngine` (`RemoteScreen.svelte`, `PlayOnSheet.svelte`, restyled `CastBar.svelte`), so `Player.svelte` shrinks instead of growing. The receiver's tested logic (`web/static/cast-receiver/logic.js`) gets a richer view model (pause, loading, sender pill, key hints) that `receiver.js` renders into solid panels. AirPlay subtitles are one WebVTT rendition that the gateway keeps for AirPlay tokens that asked for it. Continuous AirPlay is decided by a spike on a throwaway branch; only on GO do the multi-item token, joined playlist and server-side progress land. Android moves its `CastController` into an app-scoped hub and exposes it to the shell's web UI over the native bridge, so the same web bar draws it.

**Tech Stack:** SvelteKit / Svelte 5 (legacy component syntax, `$:`), TypeScript strict, Vitest (Node, fakes for browser APIs), Playwright (Chromium; Cast SDK, AirPlay and the native bridge are faked), Fastify + Zod + Redis-backed KV (backend), Node gateway, Cast Application Framework v3 (receiver, plain JS + JSDoc), Kotlin + Media3 Cast + JUnit (Android).

**Spec:** `docs/superpowers/specs/2026-11-10-cast-airplay-design.md` (sections are referenced as "spec §n").

### Phases and order

Each phase is its own pull request and leaves the app working. Within a phase, follow the order.

| Phase | Task | Implementer | Depends on |
| --- | --- | --- | --- |
| 1 | 1 Cast lookup endpoint, refused counter, profile-switch revoke | backend · hard | – |
| 1 | 2 Queued token: pin at mint, life follows predecessor | backend · hard | 1 |
| 1 | 3 Phase 1 strings (7 locales) | frontend · routine | – |
| 1 | 4 Resume helpers + cast log | frontend · routine | – |
| 1 | 5 `cast.ts` resume plumbing + layout boot | frontend · hard | 4 |
| 1 | 6 Engine: tab survival, re-adoption, detached, autoplay switch, queue from start | frontend · hard | 1, 2, 4, 5 |
| 1 | 7 Remote screen: layout, transport, states, AirPlay variant | frontend · hard | 3, 6 |
| 1 | 8 Remote screen: up-next card, autoplay switch, track chips, first-use hint | frontend · routine | 7 |
| 1 | 9 Cast bar: collapsed (desktop, phone), states, layout reserve | frontend · routine | 3, 6 |
| 1 | 10 Cast bar: expanded (desktop) | frontend · routine | 9 |
| 1 | 11 "Play on" sheet + entry points | frontend · hard | 3, 6, 7 |
| 1 | 12 Diagnose: casting section + test clip | frontend · routine | 1, 4, 5 |
| 1 | 13 Motion scan + contrast checks for the new surfaces | frontend · routine | 7–12 |
| 1 | 14 Docs (Phase 1) + owner checks | routine (docs) | 1–13 |
| 2 | 15 Receiver logic: pause, loading, sender pill, key hints | frontend · hard | Phase 1 merged |
| 2 | 16 Sender: `meta`, `who`, `motion`, receiver strings | frontend · routine | 15 |
| 2 | 17 Receiver page: solid panels, up-next restyle, pause and loading screens, keys | frontend · hard | 15, 16 |
| 2 | 18 Docs (Phase 2) + owner checks | routine (docs) | 15–17 |
| 3 | 19 Backend: AirPlay subtitle rendition request | backend · hard | Phase 1 merged |
| 3 | 20 Gateway: keep one subtitle rendition for AirPlay | backend · hard | 19 |
| 3 | 21 Web: AirPlay subtitles chip, fallback, hint | frontend · hard | 19, 20 |
| 3 | 22 **Spike: continuous AirPlay (throwaway branch) + owner GO / NO-GO** | backend + frontend · hard | 19, 20 |
| 3 | 23 GO only: multi-item AirPlay token | backend · hard | 22 = GO |
| 3 | 24 GO only: joined playlist in the gateway | backend · hard | 23 |
| 3 | 25 GO only: server-side per-episode progress | backend · hard | 23, 24 |
| 3 | 26 GO only: admin switch, profile preference, sheet / account / Diagnose rows | frontend + backend · routine | 23 |
| 3 | 27 GO only: engine and remote screen in continuous mode | frontend · hard | 23–26 |
| 3 | 28 Docs (Phase 3, GO or NO-GO) + owner checks | routine (docs) | 21, 22 (+ 23–27 on GO) |
| 4 | 29 Android: app-scoped `CastHub`, `switchTo`, re-adoption, queue from start | android · hard | Phase 1 merged |
| 4 | 30 Android: native bridge cast API | android · routine | 29 |
| 4 | 31 Web: `CastBarSource`, native adapter, bar in the Android shell | frontend · routine | 30 |
| 4 | 32 Docs (Phase 4) + owner checks | routine (docs) | 29–31 |

Task counts: Phase 1: 14, Phase 2: 4, Phase 3: 10 (5 of them only on GO), Phase 4: 4.

**Task 22 is a gate.** Tasks 23–27 start only when the owner recorded GO in the Phase 3 pull request. On NO-GO they are skipped and Task 28 writes the honest note instead (spec §8).

## Global Constraints

- **Motion:** animate only `transform` and `opacity`; opening and closing both animate; nothing jumps (space is reserved before something appears, or it overlays). Calm mode / reduced motion (`fxMode() === 'still'`, `html.m-still`, `motionAllowed()` false): durations 0, solid panels (`--fr-solid`), static spinners. Use the existing helpers in `#lib/glass/fx` (`growBoth`, `sheetSlide`, `outEase`) and the `.frost*` classes from `web/src/app.css`; never a new blur rule. Progress fills are `transform: scaleX()` with `transform-origin: left`, never `width`.
- **Own look:** FriendFlix glass, coral, Inter, logo. No look-alike of any commercial streaming brand. The words "Netflix" and "Seerr" never appear in user-facing text.
- **Fictional titles** in tests, fixtures and screenshots: Dunmoor (S1 E4 *The Lantern Road*, S1 E5 *Wrenfield Pier*), Saltwater Almanac (S2 E1 *Night Market*, E2 *The Toll Keeper*, E3 *Glass Tides*); existing fixtures keep theirs. Device name in e2e: `Wohnzimmer-TV` (as today). Profile name in e2e: `Anna`.
- **Secrets:** the media-server token never reaches a client. Cast tokens stay hashed at rest, IP-pinned, and are never logged, never stored in the browser, never in Diagnose output, metric labels or error messages. Only the public `castId` may be stored (`ff-cast-hint`).
- No Docker socket for web or backend. Docs use only `friend.example.com` and `192.0.2.x`.
- **Accessibility at the 3.1 level:** text contrast ≥ 4.5:1, targets ≥ 44 px, keyboard operable with a visible focus ring, menus via `web/src/lib/ui/menuKeys.ts`, dialogs trap and return focus, every control named, state changes announced politely, colour never alone.
- **i18n:** every user-facing string through `#lib/i18n`, in **all seven** locales `web/src/lib/i18n/locales/{de,en,fr,es,it,tr,pl}/*.ts` (`de` is the typed source; the per-language tests require every German key). EN and DE values are in spec §11; translate the other five.
- Every new source file starts with the SPDX header (`SPDX-FileCopyrightText: 2026 Manuel Weißböck`, `SPDX-License-Identifier: AGPL-3.0-or-later`; `.svelte` as HTML comments, `.kt` as line comments).
- No new npm or Gradle dependencies. Web coverage thresholds in `web/vitest.config.ts` are never lowered.
- **Tests:** write unit and e2e tests in the existing style (German UI in e2e). Locally run only the root `npm run typecheck` and, at most, the specific new unit or spec files of the task:
  - web unit: `npx -w web vitest run <file>`; backend unit: `npx -w backend vitest run <file>` (needs PostgreSQL: if `TEST_DATABASE_URL` is not set, leave it to CI); gateway unit: `npx -w gateway vitest run <file>`
  - e2e: `E2E_PORT=4283 npx playwright test -c e2e/playwright.config.ts <spec>` (only the new spec; delete `e2e/test-results` afterwards)
  - Android: write JUnit tests; CI runs Gradle.
  CI runs everything else.
- **Commits:** Conventional Commits, one per task (the commit step names it), each ending with the trailer lines
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`
  (`git commit -m "<subject>" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN"`). No model names anywhere else (code, docs, subjects). Do not push unless the owner asks.
- Out of scope (do not touch): watch-party flow, paired-TV remote (`/remote`, `lib/remote.ts`), TV-mode UI, local mini player, the AirPlay availability probe logic.

## Review Focus

1. **Nothing revokes on Chromecast `pagehide`, everything still revokes on Stop.** After a `pagehide` with a Chromecast session, no `DELETE /api/cast/session/*`, no `/api/playback/stop`, no `castQueueRemove`, no `endCurrentSession(true)`; `castLeave()` once. After *Stop casting* (bar, remote, detached bar) exactly one stop report and one DELETE per live token, queued token included. Tests in Task 6 (`pagehide keeps a Chromecast cast`, `stop still revokes the queued token`) and Task 9 e2e (`reload keeps the cast; Stop ends it`).
2. **The lookup never leaks across account, profile or device, and never returns a token.** Tests in Task 1 (`lookup is scoped to account, profile and approved device`, `lookup answer carries no token or URL`).
3. **Re-adoption of foreign media:** the receiver plays something of another profile or device (lookup 404): no bar, no reports, no DELETE, hint cleared. Test in Task 6 (`resume ignores media that is not ours`).
4. **Queued token pin at mint:** a fetch of the queued token from any address other than the predecessor's pin is refused, also before the receiver's first fetch; an unpinned predecessor gives 409 and no token. Tests in Task 2.
5. **AirPlay subtitles cannot widen the gateway:** the kept rendition's URI must pass the same token-path check; Chromecast tokens and AirPlay tokens without `hlsSub` still lose every subtitle group; `CLOSED-CAPTIONS` always goes. Tests in Task 20.
6. **The cast log and the copied report never contain a token, URL, castId, item id or IP literal**, and device names are anonymised in the report. Tests in Task 4 (`scrub removes …`, `report anonymises devices`).
7. **Android: closing the player no longer stops the cast, but logout and profile switch do.** Tests in Task 29.

---

## Phase 1 – Web sender (pull request 1)

### Task 1: Cast lookup endpoint, refused counter, profile-switch revoke

**Implementer:** backend · hard

**Files:**
- Modify: `backend/src/cast.ts` (`CastRecord`, `createCast`, `pinned`, new `castLookup`, `noteRefused`, `addrFamily`)
- Modify: `backend/src/routes/cast.ts` (record fields at mint; new `GET /api/cast/session/:castId`)
- Modify: `backend/src/routes/profiles.ts` (`POST /api/profiles/:id/select`)
- Test: `backend/src/cast.test.ts`, `backend/src/routes/cast.test.ts`, `backend/src/routes/profiles.test.ts` (add cases; reuse their fixtures)

**Interfaces:**
- `CastRecord` gains `runtimeTicks?: number` and `subs?: Array<{ index: number; language?: string; title: string }>` (set in the session route from `info.runtimeTicks` / `info.subtitles`, URLs dropped).
- `export interface CastLookup { castId: string; itemId: string; mediaSourceId: string; playSessionId: string; expiresAt: number; runtimeTicks?: number; via: CastVia; next: boolean; reported: boolean; title: string; seriesName?: string; subtitles: Array<{ index: number; language?: string; title: string }>; pins: 0 | 1 | 2; refused: { count: number; families: Array<'v4' | 'v6'> } }`
- `export async function castLookup(ctx: Ctx, who: { userId: string; profileId: string; deviceId: string }, castId: string): Promise<CastLookup | null>` – null unless the idx entry exists, the record is a media token, and `userId`, `profileId`, `deviceId` all match. `reported` = the play session's live record has a `playMethod`. `next` = `Boolean(rec.afterPs)`. `seriesName` comes from the record (add `seriesName?: string` to the record at mint).
- `export const addrFamily = (client: string): 'v4' | 'v6'` (`net.isIPv6`).
- `noteRefused(ctx, hash, client, ttl)`: called from `pinned()` when it returns false; stores `castrefuse:<hash>` = `{ n, v4, v6 }` (counts only, never the address), TTL = the token's.
- Route `GET /api/cast/session/:castId` (`requireUser`, `rateLimit 30/min`, `Cache-Control: no-store`, castId `^[0-9a-f]{32}$`): `castLookup` with the session's user, profile and device; 404 `{ error: 'not_found' }` otherwise.
- Profile select: when the selected profile differs from the session's current one and the session has a device, `await revokeCasts(ctx, userId, deviceId)` before the switch.

- [ ] **Step 1: Write the failing tests**
  - `lookup is scoped to account, profile and approved device` – mint for (u1, p1, d1); `castLookup` with (u1, p1, d1) → object with `itemId`; with u2, p2 or d2 → null; an image token's castId → null; revoked → null.
  - `lookup answer carries no token or URL` – `JSON.stringify(answer)` matches none of `/media\/c\//`, the raw `ct`, `/https?:/`.
  - `lookup reports reported=true only after a start report` – before `playbackReport('Playing')` false, after true.
  - `refused counter stores families, never addresses` – resolve with client `192.0.2.10` (pins), then `192.0.2.11` and `2001:db8::1` → lookup `refused` = `{ count: 2, families: ['v4','v6'] }`; the raw KV value contains neither address.
  - Route: `GET /api/cast/session/:castId returns 404 for another device's cast` and `… returns the lookup for the caller's cast` (status, `cache-control: no-store`).
  - Profiles: `switching profile revokes this device's cast tokens` – mint, select another profile → `castLookup` null; selecting the same profile keeps it.
- [ ] **Step 2: Implement** the record fields, `castLookup`, `addrFamily`, `noteRefused`, the route and the profile-select revoke.
- [ ] **Step 3: Verify** root `npm run typecheck`; run the three test files if PostgreSQL is available.
- [ ] **Step 4: Commit** `feat(cast): token-free lookup of a device's running cast`

### Task 2: Queued token – pin at mint, life follows its predecessor

**Implementer:** backend · hard

**Files:**
- Modify: `backend/src/cast.ts` (`castPredecessor`, `createCast`, `touch`, new `castNextTtlSeconds`, `castnext:` index)
- Modify: `backend/src/routes/cast.ts` (next-token branch)
- Test: `backend/src/cast.test.ts`, `backend/src/routes/cast.test.ts`

**Interfaces:**
- `castPredecessor(...)` returns `{ castId: string; playSessionId: string; exp: number; hash: string } | null`.
- `export function castNextTtlSeconds(ownTtl: number, predExp: number, now = Date.now()): number` = `min(MAX_TTL, ownTtl + max(0, ceil((predExp - now) / 1000) - 3600))`.
- `createCast` with `rec.afterPs`: copies the predecessor's `castpin:` value into the new token's `castpin:` (same TTL as the new token) and writes `castnext:<userId>:<afterPs>` = new hash (TTL = new token's). Without a predecessor pin the route answers `409 { error: 'cast_unpinned' }` and mints nothing.
- `touch(...)` of a media token: if `castnext:<userId>:<rec.playSessionId>` exists, the successor's `cast:`, `castidx:`, `castpin:` keys get the same refreshed TTL (SET XX, never resurrecting a revoked one).

- [ ] **Step 1: Write the failing tests**
  - `queued token is pinned to the predecessor's address at mint` – predecessor pinned to `192.0.2.20`; next token resolved from `192.0.2.21` → null; from `192.0.2.20` → scope of the next item (inside the overlap window).
  - `unpinned predecessor refuses the queue` – route with `next: true` before any predecessor fetch → 409 `cast_unpinned`; no new idx entry.
  - `queued token idle life follows the predecessor` – fake clock: mint next, advance 44 min while touching the predecessor every 10 min, advance 2 more min → next token still resolvable; without predecessor touches it expires after 45 min.
  - `castNextTtlSeconds caps at 6 h` – `(4000, now + 7h, now)` → 21600; `(4000, now + 30 min, now)` → 4000.
  - Existing next-token gate tests (429 without predecessor, 409 mismatch, 180 s overlap, `predecessor_live`) still pass unchanged.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** root `npm run typecheck`; run the two test files if PostgreSQL is available.
- [ ] **Step 4: Commit** `feat(cast): queued next episode pinned at mint and kept alive with its predecessor`

### Task 3: Phase 1 strings

**Implementer:** frontend · routine

**Files:**
- Modify: `web/src/lib/i18n/locales/{de,en,fr,es,it,tr,pl}/player.ts` (`castRemote.*`, `castBar.*`, `castPicker.*` additions from spec §11)
- Modify: `web/src/lib/i18n/locales/{…}/diagnose.ts` (`cast.*` group), `…/common.ts` (`experimental`)

**Interfaces:** exactly the keys of spec §11 for `player.castRemote`, `player.castBar`, `player.castPicker`, `diagnose.cast`, `common.experimental`. `player.castTv.*` and the Phase 3 GO keys are added in their own tasks (16, 26). `diagnose.cast.rxErrors` value is a plural object (`{ one, other }` per locale rules).

- [ ] **Step 1: Add the keys** in `de` first (typed source), then `en`, then translate fr, es, it, tr, pl. Keep placeholders identical.
- [ ] **Step 2: Verify** root `npm run typecheck`; `npx -w web vitest run src/lib/i18n` (fast, no browser).
- [ ] **Step 3: Commit** `feat(cast): strings for the remote screen, bar, device sheet and casting diagnostics`

### Task 4: Resume helpers + cast log

**Implementer:** frontend · routine

**Files:**
- Create: `web/src/lib/cast/resume.ts`, `web/src/lib/cast/resume.test.ts`
- Create: `web/src/lib/cast/castLog.ts`, `web/src/lib/cast/castLog.test.ts`

**Interfaces:**
- `resume.ts`:
  - `export const CAST_HINT_KEY = 'ff-cast-hint', CAST_LAST_KEY = 'ff-cast-last', HINT_SEEN_KEY = 'ff-cast-hint-seen';`
  - `export interface CastHint { castId: string; itemId: string; device: string; exp: number; at: number }`
  - `export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;` – every accessor wrapped in try/catch.
  - `readHint(store: Store, now: number): CastHint | null` (null when missing, malformed, castId not 32 hex, or `exp <= now`); `writeHint(store, h)`; `clearHint(store)`.
  - `lastDevice(store): string | null`; `rememberDevice(store, name: string): void` (name trimmed, ≤ 80 chars).
  - `tokenOfContentUrl(url: string): string | null` – the 43-char base64url segment right after `/media/c/`.
  - `castIdOfContentUrl(url: string, digest: (s: string) => Promise<string>): Promise<string | null>` – `digest(token).slice(0, 32)`; `digest` returns lowercase hex sha256.
  - `export const sha256Hex: (s: string) => Promise<string>` (`crypto.subtle`).
  - `lookupToCastInfo(l: CastLookup, contentUrl: string): CastInfo` – `startTime: 0`, `contentType: 'application/x-mpegURL'`, `hlsSegmentFormat: 'ts'`, `subtitles` with `url: ''`; `CastLookup` is the type of Task 1, re-declared on the web side in this file.
- `castLog.ts`:
  - `export type CastLevel = 'info' | 'warn' | 'error'; export type CastTag = 'session' | 'load' | 'receiver' | 'queue' | 'network' | 'renew' | 'sender' | 'test';`
  - `export interface CastLogEntry { at: number; level: CastLevel; tag: CastTag; text: string }`
  - `export const CAST_LOG_KEY = 'ff-castlog', CAST_LOG_MAX = 200;`
  - `castLog(e: Omit<CastLogEntry, 'at'>, now?: number, store?: Store): void` (scrubs, appends, keeps the last 200); `readCastLog(store?): CastLogEntry[]`; `clearCastLog(store?)`.
  - `scrub(text: string): string` – replaces URLs, `/media/c/<anything>`, 32+ hex runs, base64url runs ≥ 32 chars, IPv4 and IPv6 literals with `…`.
  - `castReport(o: { rows: Array<[string, string]>; entries: CastLogEntry[]; air: string; devices: string[] }): string` – plain text; every occurrence of a name in `devices` becomes `TV 1`, `TV 2` … by first appearance.

- [ ] **Step 1: Write the failing tests**
  - `readHint drops expired, malformed and foreign shapes` – valid hint → object; `exp` past → null; `castId: 'x'` → null; `getItem` throws → null.
  - `tokenOfContentUrl` – `https://friend.example.com/media/c/<43 chars>/Videos/<id>/master.m3u8` → the 43 chars; `/media/Videos/...` → null.
  - `castIdOfContentUrl uses the first 32 hex of sha256(token)` – with a fake digest returning `'ab'.repeat(32)` → `'ab'.repeat(16)`; with the real `sha256Hex` for a known token → the hash `backend/src/cast.ts` `hashToken` gives for it (copy the value from a backend test vector into the test).
  - `scrub removes urls, tokens, ids and addresses` – input with `https://friend.example.com/x`, `/media/c/AbC…`, a 32-hex id, `192.0.2.7`, `2001:db8::5` → none of them in the output.
  - `ring buffer keeps the last 200` – 205 entries → 200, first is entry 6.
  - `report anonymises devices` – entries mention `Wohnzimmer-TV` twice and `Küche` once → report contains `TV 1` twice, `TV 2` once, no original names.
- [ ] **Step 2: Implement** both modules.
- [ ] **Step 3: Verify** root `npm run typecheck`; run both test files.
- [ ] **Step 4: Commit** `feat(cast): resume hint, castId derivation and the on-device cast log`

### Task 5: `cast.ts` resume plumbing + layout boot

**Implementer:** frontend · hard

**Files:**
- Modify: `web/src/lib/cast.ts`
- Modify: `web/src/routes/+layout.svelte` (boot)
- Test: `web/src/lib/cast.test.ts` (extend its `fakeSdk()`)

**Interfaces:**
- `CastEvent` gains `'session-resume'`: emitted on `SESSION_RESUMED` and once from `setup()` when `getCurrentSession()` already exists.
- `CastState` gains `castId: string` (`mediaInfo.customData.ff.castId` when it is 32 hex, else `''`) and `queue: Array<{ itemId: number; contentId: string; castId: string }>` (queue items after the current one, from `getMediaSession().items`).
- `castAdoptTracks(contentUrl: string, subs: Array<{ index: number }>): void` – rebuilds the track map like `mediaOf` (track id = position + 1).
- `castLeave(): void` – `endCurrentSession(false)` (sender disconnects, receiver keeps playing).
- `castTestClip(url: string, title: string): Promise<{ ok: boolean; firstFrameMs: number | null }>` – loads an MP4 `MediaInfo` (`video/mp4`, BUFFERED, no tracks) on the current session; resolves on the first `PLAYING` (time measured from `loadMedia`) or `{ ok: false }` after 20 s or on a load error; ends the session (`endCurrentSession(true)`) once the clip reports `IDLE` with `FINISHED` if the test opened it (`opened` flag passed by the caller as `castTestClip(url, title, { endAfter: true })`).
- Every session start / resume / end and every idle reason `ERROR` writes a `castLog` entry (`session`, `receiver`).
- Layout: on mount, `if (castCapableBrowser() && readHint(localStorage, Date.now())) void initCast()`. Nothing else is loaded for anyone without a hint.

- [ ] **Step 1: Write the failing tests**
  - `emits session-resume on SESSION_RESUMED and for a session present at setup` – two scenarios, listener called once each.
  - `castState carries the own receiver castId and the queued items` – fake media session with `customData.ff.castId` and two `items` → `castId`, `queue[0].contentId`.
  - `castAdoptTracks lets castSetSubtitle pick the right track id` – adopt `[{ index: 3 }, { index: 7 }]`, `castSetSubtitle(7)` → `EditTracksInfoRequest([2])`.
  - `castLeave disconnects without stopping the receiver` – `endCurrentSession` called with `false`.
  - `castTestClip measures the first frame and ends the session it opened` – fake clock; PLAYING after 1900 ms → `{ ok: true, firstFrameMs: 1900 }`; after FINISHED `endCurrentSession(true)`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** root `npm run typecheck`; `npx -w web vitest run src/lib/cast.test.ts`.
- [ ] **Step 4: Commit** `feat(cast): resume events, receiver castId and a test clip loader in the sender`

### Task 6: Engine – tab survival, re-adoption, detached, autoplay switch, queue from start

**Implementer:** frontend · hard

**Files:**
- Modify: `web/src/lib/cast/engine.ts`
- Test: `web/src/lib/cast/engine.test.ts`, `web/src/lib/cast/engine.airplay.test.ts`
- Create: `web/src/lib/cast/engine.resume.test.ts`

**Interfaces:**
- `CastPhase` gains `'detached'`. `CastSession` gains `autoplay: boolean` and `castId?: string` (the live token's public handle, for Diagnose).
- `CastEngine` gains:
  - `resume(): Promise<boolean>` – only when nothing is owned: waits ≤ 10 s for `castState.loaded && contentId`; castId from `castState.castId` or `castIdOfContentUrl(contentId, deps.digest)`; `GET /api/cast/session/:castId`; 404 → `clearHint`, false; 200 → `castAdoptTracks`, `adopt({ kind: 'chromecast', …, cast: lookupToCastInfo(l, contentId), started: l.reported, … })` with item metadata from `deps.item`; then for `castState.queue[0]` the same lookup, and with `next: true` it becomes `s.queued` (qid from the queue entry). Logs `session resumed · TV kept playing`. true.
  - `setAutoplay(on: boolean): void` – off: like `cancelNext` plus `noAuto` for every later episode of this session (a session flag `autoOff`), no queueing; on: clears the flag and allows `prequeue` again. `castSession.autoplay` reflects it; initial value `prefs.autoplayNext && !sleepAfterEpisode`.
- `EngineDeps` gains `store: Store`, `digest(s: string): Promise<string>`, `log(e: Omit<CastLogEntry, 'at'>): void`, `requestSession(): Promise<boolean>`, `leave(): void`, `whenReady(fn: () => void): void` (runs `fn` once the SDK is set up).
- `CastFns` gains `castLeave`, `castAdoptTracks`.
- Behaviour:
  - `onPageHide` for Chromecast: no `dequeue`, no stop report, no revoke, no `castStop`; `deps.leave()`; `end(s)` locally; hint stays. AirPlay: unchanged.
  - Hint: `writeHint` on adopt, after every successful `swap`, after `advanced`; `clearHint` on `stop()`, session end, `end()` after the title ended without a next episode.
  - Detached: on boot (`whenReady`) if `readHint` is fresh and no `resume()` succeeded within 5 s → `castSession` = view from the hint (title via `deps.item(hint.itemId)`), `state: 'detached'`. `reconnect()` in `detached`: `deps.requestSession()` (inside the tap), then `resume()`; false → toast `player.castBar.nothingThere`, `clearHint`, `castSession` null. `stop()` in `detached`: `DELETE /api/cast/session/<hint.castId>`, `clearHint`, null, no stop report.
  - Queue from the start: `QUEUE_WITHIN_S` is deleted; `atPosition` calls `prequeue` once per title when `duration > 0` and `!autoOff`. A `409 cast_unpinned` answer schedules one retry after 60 s (timer cleared on swap / end).
  - Fresh-token fallback: in `onEvent` (finished with a queued episode) and in `goNext`'s `ADVANCE_WAIT_MS` timer, when the queued token has not started, call `swap(s, q.it.id, undefined, true)` instead of `loadOnCast(ci)` with the old token.
  - Log calls (`deps.log`): adopt / resume / end (`session`), every swap (`load`, label "S1 E4" or "film", start position), first `playing` per token with time since load (`receiver`), queue issued / loaded / started / removed / refused with status (`queue`), buffering > 2 s and recovery (`network`), renewals with validity (`renew`), visibility hidden / visible and pagehide (`sender`).

- [ ] **Step 1: Write the failing tests**
  - `pagehide keeps a Chromecast cast` – adopted session; fire pagehide → calls recorded: no `/api/playback/stop`, no `DELETE`, `castQueueRemove` not called, `castStop` not called, `leave` called once; `get(castSession)` null; hint still readable.
  - `pagehide still ends AirPlay` (in `engine.airplay.test.ts`) – keepalive stop and controller destroyed, as today.
  - `stop still revokes the queued token` – queued episode present; `stop()` → `DELETE` for both castIds, one stop report.
  - `resume adopts our media and restores the queue` (resume test file) – fake `castState` with `contentId` of token A and `queue[0]` token B; lookup A → `{ reported: true }`, lookup B → `{ next: true }` → session `itemId` A, `state: 'playing'`, no `start` report (reported), `s.queued` set (assert via a later `stop()` deleting B).
  - `resume ignores media that is not ours` – lookup 404 → `castSession` null, no reports, no DELETE, hint cleared.
  - `detached bar after 5 s without a resume; Reconnect resumes` – fresh hint, no resume → after 5 s `state: 'detached'` with the hint's device; `reconnect()` → `requestSession` once, then lookup → `playing`.
  - `detached stop revokes by the hint's castId only` – `stop()` → exactly one `DELETE /api/cast/session/<hint castId>`, no stop report.
  - `queue from the start` – adopt a 50-minute episode at 0 s → one `POST /api/cast/session` with `next: true` right after the first `playing` tick.
  - `cast_unpinned retries once after 60 s` – first queue POST 409 → second POST after 60 s of fake time, no third.
  - `fallback requests a fresh token for the queued episode` – receiver finished, queued token never starts → after `ADVANCE_WAIT_MS` a new `POST /api/cast/session` for the queued item (without `next`), never a `loadOnCast` with the old token.
  - `setAutoplay(false) cancels the countdown, dequeues and stops further queueing` – credits countdown running → `startsAt: null`, `castQueueRemove` called, next title end: no queue POST.
  - `hint follows the live token` – after a `playOnTv` switch the hint's castId is the new one; after `stop()` it is gone.
- [ ] **Step 2: Implement** in `engine.ts`; wire the browser deps (`store: localStorage` guarded, `digest: sha256Hex`, `log: castLog`, `requestSession: requestCastSession`, `leave: castLeave`, `whenReady` from `cast.ts`); the layout calls `castEngine.resume()` on `session-resume`.
- [ ] **Step 3: Verify** root `npm run typecheck`; run the three engine test files.
- [ ] **Step 4: Commit** `feat(cast): a Chromecast cast survives the tab and is picked up again`

### Task 7: Remote screen – layout, transport, states, AirPlay variant

**Implementer:** frontend · hard

**Files:**
- Create: `web/src/lib/cast/RemoteScreen.svelte`, `web/src/lib/cast/remotescreen.ts`, `web/src/lib/cast/remotescreen.test.ts`
- Modify: `web/src/lib/Player.svelte` (render `<RemoteScreen />` instead of the `.remote.castov` markup and its styles; hide the bar while `remote`)
- Test: `e2e/tests/cast-remote.spec.ts`, `e2e/tests/cast-remote.mobile.spec.ts` (update selectors, add cases); shared fakes in `e2e/mocks/cast.ts`

**Interfaces:**
- `remotescreen.ts` (pure):
  - `remoteLayout(width: number): 'wide' | 'stacked' | 'phone'` – ≥ 1100 wide, 721–1099 stacked, ≤ 720 phone.
  - `statusOf(s: CastSession, tf: TFn): { tone: 'none' | 'warn' | 'error'; text: string; action: 'reconnect' | 'playHere' | null }` per spec §1 states table.
  - `timeLine(s: CastSession): { elapsed: string; remaining: string; valueText: string }` (`fmtClock`; `valueText` via `player.valueText`).
  - `volumeLine(kind: CastKind, platform: 'iPhone' | 'iPad' | 'Mac' | null, tf: TFn): string | null` – AirPlay → `player.castRemote.volumeAirplay` with the platform; Chromecast → null.
  - `segmentMarks(segs: Segment[], duration: number): Array<{ type: 'intro' | 'recap'; left: number; width: number }>` (fractions 0–1).
- `RemoteScreen.svelte` (no props): reads `castSession`, `castState` (volume), `castEngine.airState`; renders spec §1 common parts, desktop / phone layouts, AirPlay variant (eyebrow, chip "AirPlay", volume line instead of controls, no Subtitles chip until Task 21) and the states table. Stop asks the existing confirm. Device chip dispatches `pick` (Task 11 wires the sheet; until then it calls `castEngine.pick()` / `requestCastSession()` like today's chip).

- [ ] **Step 1: Write the failing unit tests** – `remoteLayout` breakpoints (1100 → wide, 1099 → stacked, 720 → phone); `statusOf` for `connecting` (text `Verbinde mit Wohnzimmer-TV …`), `reconnect` (`warn`, action `reconnect`), `failed` (`error`, `playHere`), `detached` (`warn`, `reconnect`), playing (`none`); `volumeLine('airplay','iPhone')` → `Lautstärke: Tasten am iPhone oder TV-Fernbedienung`; `segmentMarks` for an intro 60–180 s of 2830 s → left ≈ 0.0212.
- [ ] **Step 2: Write the e2e tests** (German UI, Dunmoor fixture, `fakeCastSdk`)
  - desktop: `remote screen shows title panel, scrubber and transport` – heading `Dunmoor`, eyebrow `Wird auf Wohnzimmer-TV abgespielt`, slider `Position auf dem Fernseher` with `aria-valuetext` containing ` von `, buttons `10 Sekunden zurück`, `Pause`, `10 Sekunden vor`, `Nächste Folge`.
  - `keyboard on the scrubber seeks the TV` – focus slider, `ArrowRight` → `sdk.calls()` contains `seek:` with +10.
  - `volume drives the TV` – slider `Fernseher-Lautstärke` `ArrowRight` → `setVolumeLevel` recorded; button `Fernseher stumm` → `muteOrUnmute`.
  - `connection lost shows Reconnect` – token request fails on a switch → status `Verbindung verloren` and button `Neu verbinden`.
  - `could not play shows Play here` – `loadMedia` rejects → `Konnte auf dem Fernseher nicht abspielen`, button `Hier abspielen`.
  - `stacked layout at 1024 px has no overlap and no horizontal scroll` – `noHorizontalOverflow(page)`; up-next region box below the title panel box.
  - mobile: `phone remote centres Pause and keeps 44 px targets` – Pause centre x within ±2 px of viewport centre; every button ≥ 44×44.
  - mobile AirPlay (`stubAirPlay`): `AirPlay remote shows the volume hint and no volume slider` – text `Lautstärke: Tasten am iPhone oder TV-Fernbedienung`, no slider named `Fernseher-Lautstärke`.
- [ ] **Step 3: Implement** the helpers, the component (`.frost-safe` panels, spec §1 values) and the Player swap. Keep `data-testid="cast-active"` / `airplay-active` on the root so existing specs keep finding it.
- [ ] **Step 4: Verify** root `npm run typecheck`; run `remotescreen.test.ts` and the two remote specs.
- [ ] **Step 5: Commit** `feat(cast): redesigned remote screen for desktop, phone and AirPlay`

### Task 8: Remote screen – up-next card, autoplay switch, track chips, first-use hint

**Implementer:** frontend · routine

**Files:**
- Create: `web/src/lib/cast/UpNextCard.svelte`, `web/src/lib/cast/TrackChips.svelte`
- Modify: `web/src/lib/cast/RemoteScreen.svelte`, `web/src/lib/cast/remotescreen.ts` (+ test)
- Test: `e2e/tests/cast-remote.spec.ts`, `e2e/tests/cast-remote.mobile.spec.ts`

**Interfaces:**
- `upNextLine(s: CastSession, now: number, tf: TFn): string` – countdown → `player.castRemote.startsIn`; `autoplay` → `startsBySelf`; else `waits`; AirPlay adds `onUnlock` as a second sentence when not continuous.
- `UpNextCard` props `{ session: CastSession; compact: boolean }`; *Play now* → `castEngine.next()`; switch → `castEngine.setAutoplay(checked)`; hidden without `session.next` and for films.
- `TrackChips` props `{ session: CastSession; airplay: boolean }`; menus with `menuKeys`, `menuitemradio`, `aria-checked`; audio → `castEngine.refresh({ audioIndex })`; subtitles → `castEngine.setSubtitle(index)`; on AirPlay only the Audio chip (Task 21 adds Subtitles).
- First-use hint (Chromecast only): visible unless `localStorage[HINT_SEEN_KEY]`; dismiss fades the row (opacity 200 ms, 0 in still mode) and keeps its height for this visit.
- Skip pill: `castSession.skip` → `castEngine.skipSegment()`.

- [ ] **Step 1: Write the failing tests** – unit `upNextLine` (three states + AirPlay sentence); e2e:
  - `up next card plays now and the switch stops autoplay` – credits reached (`sdk` time near the end) → `Als Nächstes`, `Startet in 10 s`; switch `Nächste Folge automatisch abspielen` off → text `Startet, wenn du es willst.`, `sdk.calls()` has a queue removal; `Jetzt abspielen` → new `POST /api/cast/session` for `Wrenfield Pier`.
  - `audio chip opens a keyboard menu` – `Audio: …` → menu; `ArrowDown`, `Enter` → `POST /api/cast/session` with `audioIndex`; `Escape` returns focus to the chip.
  - `hint is dismissed for good` – button `Hinweis ausblenden` → hint hidden; reload of `/watch/<id>` (attached) → no hint.
  - mobile: `Play now never wraps` – button height ≤ 44 px; title has `text-overflow: ellipsis`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** root `npm run typecheck`; the unit file and the two specs.
- [ ] **Step 4: Commit** `feat(cast): up-next card, session autoplay switch and track chips on the remote`

### Task 9: Cast bar – collapsed (desktop, phone), states, layout reserve

**Implementer:** frontend · routine

**Files:**
- Modify: `web/src/lib/cast/CastBar.svelte`, `web/src/lib/cast/bar.ts`, `web/src/lib/cast/bar.test.ts`
- Modify: `web/src/routes/+layout.svelte` (`--castbar-h`: 92 px desktop, 76 px phone; toasts and offline banner offsets; phone header cast indicator, spec §2)
- Test: `e2e/tests/cast-bar.spec.ts`, `e2e/tests/cast-bar.mobile.spec.ts` (update to the new geometry; add cases); new `e2e/tests/cast-survive.spec.ts`

**Interfaces:**
- `bar.ts` gains `barLine2(s: CastSession, now: number, tf: TFn): { text: string; tone: 'none' | 'warn' | 'error' }` – states table of spec §2 (`onLeft` with minutes left rounded up; `upNextLine`; connecting / lost / cannot play); `barProgress` unchanged (used as `scaleX` factor / 100).
- Desktop collapsed and phone bar per spec §2 (values there). Buttons: open remote (thumbnail + text), Pause/Play (coral), Next (desktop, episodes), `Übertragung beenden` pill, `Weitere Steuerung` (desktop; Task 10 wires it, until then hidden). States: spinner, *Reconnect*, *Play here*, Cancel during a countdown, *Choose TV* for AirPlay.
- Bar in / out with Svelte `in:` / `out:` transitions (translateY 16 px + opacity, 240 / 180 ms; 0 when `fxMode() === 'still'`); state text crossfade; progress `scaleX` with `transition: transform 1s linear` (none in still mode). `--castbar-h` is set on `<html>` before the bar mounts.

- [ ] **Step 1: Write the failing tests**
  - unit: `barLine2` → `Auf Wohnzimmer-TV · noch 28 Min.` for 18:42 of 47:10; `connecting` → `Verbinde mit Wohnzimmer-TV …`; `reconnect` → `{ tone: 'warn', text: 'Verbindung verloren' }`; `failed` → `error`.
  - desktop: `floating bar: centred, 76 px, progress by transform` – box height 76, centre x = viewport centre ± 2; progress fill `transform` matches `matrix(` and computed `transition-property` is `transform`.
  - desktop: `content ends above the bar` – scroll to bottom; last content element's bottom ≤ bar top.
  - desktop: `states: connecting, lost, failed` – one test per state with the texts above and the buttons `Neu verbinden`, `Hier abspielen`, `Übertragung beenden`.
  - mobile: `phone bar sits 8 px above the tab bar, 14 px inset` – `tabbar.top - bar.bottom` = 8 ± 1, `bar.left` = 14 ± 1; buttons ≥ 44 px; `noHorizontalOverflow`.
  - mobile: `header shows the casting indicator` – on `/` while casting, button `Überträgt auf Wohnzimmer-TV` (44 px, computed background transparent) opens `/watch/<id>`; absent without a cast.
  - `cast-survive.spec.ts`: `reload keeps the cast; the bar comes back; Stop ends it` – cast on `/`, `page.reload()`, fake SDK auto-joins (`SESSION_RESUMED` with the same media) → bar `Jetzt auf dem Fernseher` visible, recorded requests since reload contain no `DELETE` and no `/api/playback/stop`; `Übertragung beenden` → confirm → exactly one `DELETE`.
  - `cast-survive.spec.ts`: `no auto-join: detached bar, Reconnect asks the browser` – fake SDK does not auto-join → after 5 s text `Verbindung verloren`; click `Neu verbinden` → `requestSession` recorded, then the bar plays.
  - `reduced motion: no bar animation` – `reducedMotion: 'reduce'` → bar's computed `animation-name`/transition durations are 0.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** root `npm run typecheck`; `bar.test.ts` and the three specs.
- [ ] **Step 4: Commit** `feat(cast): floating glass cast bar with connecting, lost and failed states`

### Task 10: Cast bar – expanded (desktop)

**Implementer:** frontend · routine

**Files:**
- Create: `web/src/lib/cast/CastBarExpanded.svelte`
- Modify: `web/src/lib/cast/CastBar.svelte`
- Test: `e2e/tests/cast-bar.spec.ts`

**Interfaces:**
- `CastBarExpanded` props `{ session: CastSession }`, event `collapse`. Reuses the scrubber, transport and `TrackChips` from Tasks 7–8 (extract the scrubber into `web/src/lib/cast/CastScrubber.svelte` with props `{ session; label: string; episodeOnly?: boolean }` if Task 7 kept it inline). *Open remote* → `goto('/watch/' + itemId)`; *Stop casting* with confirm.
- Open: `growBoth` from the *More controls* button; close: the same in reverse; Escape, *Collapse* or outside click closes; focus to *Collapse* on open, back to *More controls* on close. Region label `player.castBar.regionExpanded`. Phone never shows the expand button.

- [ ] **Step 1: Write the failing e2e tests**
  - `expanded bar seeks, changes volume and opens the remote` – `Weitere Steuerung` → region `Jetzt auf dem Fernseher, ausgeklappt`; slider `Position auf dem Fernseher` `End` → `seek:` near the end; `Fernbedienung öffnen` → URL `/watch/<id>`, no new `POST /api/cast/session`.
  - `Escape collapses and returns focus` – focus on `Weitere Steuerung` afterwards.
  - `opening and closing both animate` – with `reducedMotion: 'no-preference'`, sample the expanded element's computed `transform` twice within the first 100 ms of opening and of closing → not equal (moving), and `transition-property`/animation never names `height` or `width`.
  - `height follows content` – expanded box bottom padding ≤ 24 px below the last row.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** root `npm run typecheck`; `cast-bar.spec.ts`.
- [ ] **Step 4: Commit** `feat(cast): expanded cast bar with scrubber, volume and tracks`

### Task 11: "Play on" sheet + entry points

**Implementer:** frontend · hard

**Files:**
- Create: `web/src/lib/cast/PlayOnSheet.svelte`, `web/src/lib/cast/playOn.ts`, `web/src/lib/cast/playOn.test.ts`
- Modify: `web/src/lib/Player.svelte` (one *Play on* button instead of the Chromecast item in More and the separate AirPlay button), `web/src/lib/cast/RemoteScreen.svelte` (device chip opens the sheet)
- Test: `e2e/tests/cast-picker.spec.ts`, `e2e/tests/cast-picker.mobile.spec.ts`; existing `player-airplay*.spec.ts` selectors updated (the AirPlay button is now the sheet's *AirPlay …* row; assertions stay)

**Interfaces:**
- `playOn.ts`:
  - `export type PlayOnRow = { id: 'last' | 'another' | 'airplay' | 'continuous' | 'here'; title: string; hint: string; checked: boolean }`
  - `playOnRows(o: { chromecast: boolean; devices: boolean; airplay: boolean; apple: boolean; continuousAvailable: boolean; episode: boolean; last: string | null; casting: CastKind | null; form: 'phone' | 'tablet' | 'computer'; tf: TFn }): PlayOnRow[]` – order and conditions of spec §3; `continuous` only when `apple && airplay && continuousAvailable && episode` (always false until Task 26).
  - `whatLine(o: { title: string; episode?: string; at: number; tf: TFn }): string`.
  - `formFactor(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'>, width: number): 'phone' | 'tablet' | 'computer'`.
- `PlayOnSheet` props `{ open: boolean; trigger: HTMLElement | null; at: number }`, event `close`. Rows call, **synchronously inside the click**: `last` / `another` → `requestCastSession()`; `airplay` → the Player's existing AirPlay tap handler (passed in as a prop `onAirPlay: () => void`); `here` while casting → `castEngine.stop()` then local playback at the TV's position (the Player's existing return path). On `session-start` `rememberDevice(name)`.
- Phone: bottom sheet (`sheetSlide`, `.frost-dim`), desktop: popover (`growBoth`). Dialog semantics, focus trap, Escape, focus return; *Close* button 44 px.

- [ ] **Step 1: Write the failing tests**
  - unit `playOnRows`: Chrome with devices and a remembered TV → ids `['last','another','here']`; Safari with AirPlay → `['airplay','here']`; nothing available → `['here']`; casting Chromecast → `here` title `Hier weiterschauen`; `continuous` never present while `continuousAvailable` is false.
  - unit `whatLine` → `Dunmoor · S1 E4 ab 18:42`.
  - e2e desktop: `Play on opens a popover; the last TV row asks the browser` – `Abspielen auf …` → dialog `Abspielen auf`; row `Wohnzimmer-TV` with hint `Chromecast · zuletzt verwendet` (seeded `ff-cast-last`) → `requestSession` recorded once; Escape → focus on `Abspielen auf …`.
  - e2e mobile Safari stub: `AirPlay row runs the token-then-picker flow` – row `AirPlay …` → one `POST /api/cast/session` with `via: 'airplay'`, `picks()` + 1.
  - e2e: `Continue here stops the cast and plays locally` – casting → device chip → `Hier weiterschauen` → `DELETE` once, `/api/playback/info` requested, remote screen gone.
  - e2e mobile: `sheet opens and closes with motion and has a 44 px close button` – sample transform during open and close; `Schließen` ≥ 44 px.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** root `npm run typecheck`; `playOn.test.ts`, both picker specs, `player-airplay.spec.ts`.
- [ ] **Step 4: Commit** `feat(cast): one "Play on" sheet for Chromecast, AirPlay and this device`

### Task 12: Diagnose – casting section + test clip

**Implementer:** frontend · routine

**Files:**
- Create: `web/src/lib/cast/DiagnoseCast.svelte`, `web/src/lib/cast/diagnose.ts`, `web/src/lib/cast/diagnose.test.ts`
- Create: `web/static/cast-test/clip.mp4` (6 s, 640×360, H.264 baseline, AAC stereo, < 400 KB: dark card with the FriendFlix logo and a 440 Hz tone), `scripts/cast-test-clip.sh` (the ffmpeg command that made it, documented; ffmpeg is not a build dependency)
- Modify: `web/src/routes/diagnose/+page.svelte` (section first)
- Test: `e2e/tests/diagnose-cast.spec.ts`

**Interfaces:**
- `diagnose.ts`:
  - `chromecastRows(o: { capable: boolean; enabled: boolean; custom: boolean; state: CastState; session: CastSession | null; lookup: CastLookup | null; errors: number; now: number; tf: TFn }): Array<{ label: string; value: string; tone: 'none' | 'ok' | 'warn' | 'error' }>`
  - `airplayRows(o: { available: boolean; continuous: 'on' | 'off' | null; subsInStream: boolean; last: { at: number; episodes: number; reconnects: number } | null; lookup: CastLookup | null; tf: TFn }): …same shape` – `continuous: null` hides the row; `subsInStream` false hides the Subtitles row (Task 21 turns it on); the Network row only when `lookup.refused.families` contains a family other than the pinned one.
  - `lastAirSession(entries: CastLogEntry[]): { at; episodes; reconnects } | null`.
  - `passLeft(expiresAt: number, now: number, tf: TFn): string` – "4 h 12 min".
- `DiagnoseCast.svelte`: header with *Testvideo an den Fernseher senden* (`castTestClip('/cast-test/clip.mp4', 'FriendFlix test', { endAfter: opened })`, disabled with `Beende zuerst die Übertragung.` while a session plays) and *Bericht kopieren* (`castReport`, includes the existing AirPlay log text); two cards (`dl`), events table (time, level icon + word, tag, text), *Kopieren*, *Leeren*. Lookup via `GET /api/cast/session/<castSession.castId>` when a session exists.

- [ ] **Step 1: Write the failing tests**
  - unit `chromecastRows` – own receiver connected and playing → `Bereit · FriendFlix-Empfänger`, `Verbunden mit Wohnzimmer-TV`, pass `Gültig 4 h 12 min, wird 10 Min. vor Ablauf erneuert`; non-Chromium → `In diesem Browser nicht verfügbar (Chrome oder Edge nötig)`.
  - unit `airplayRows` – Chrome → `Hier nicht verfügbar (AirPlay braucht Safari)`; no continuous row while `continuous: null`; network row only with `families: ['v6']` against a v4 pin.
  - unit `lastAirSession` – log with 3 AirPlay loads and 0 reconnects → `{ episodes: 3, reconnects: 0 }`.
  - e2e `test video reports the first frame` – fake SDK reports `PLAYING` 1.9 s after load → text `Testvideo lief auf Wohnzimmer-TV · erstes Bild nach 1,9 s`.
  - e2e `copy report has no tokens, urls or device names` – seed the log with an entry mentioning `Wohnzimmer-TV` and a cast session; grant clipboard; copied text contains `TV 1`, none of `Wohnzimmer-TV`, `/media/c/`, `https://`, a 32-hex run.
  - e2e `levels are text, not colour alone` – a warn entry row contains the word `Warnung`.
- [ ] **Step 2: Implement** (make the clip with the script; commit the binary).
- [ ] **Step 3: Verify** root `npm run typecheck`; `diagnose.test.ts`, `diagnose-cast.spec.ts`.
- [ ] **Step 4: Commit** `feat(diagnose): casting section with test video, status cards and events`

### Task 13: Motion scan + contrast checks for the new surfaces

**Implementer:** frontend · routine

**Files:**
- Modify: `web/src/lib/admin/glass.test.ts` (the stylesheet scan)
- Modify: `web/src/lib/a11y/contrast.test.ts`

**Interfaces:**
- The scan additionally refuses `width`, `height`, `left`, `top`, `right`, `bottom`, `max-height` in any `transition` or `@keyframes` of files under `web/src/lib/cast/` and of `web/static/cast-receiver/*.css` (the receiver CSS is added to the scanned set). Existing allowlist entries stay.
- Contrast pairs (WCAG ratio ≥ 4.5 with alpha compositing as the file already does): `.72` white on `.frost-safe` over a white backdrop; amber `#f7b344` and error `#ffa8a8` text on `.frost-safe`; `#ff8aa0` on the ambient base; `#ffa7b6` and `.78` white on `#1c1a21`.

- [ ] **Step 1: Write the tests** (`cast surfaces animate transform and opacity only`, `receiver css animates transform and opacity only`, `cast bar and remote text pairs pass 4.5:1`, `receiver panel text pairs pass 4.5:1`).
- [ ] **Step 2: Fix** any violation they find in Tasks 7–12 (today's `CastBar` `width` transition must already be gone; the receiver CSS is fixed in Task 17, so mark that one `it.todo` until Phase 2 if it fails now, with a comment naming Task 17).
- [ ] **Step 3: Verify** root `npm run typecheck`; the two test files.
- [ ] **Step 4: Commit** `test(cast): motion and contrast rules cover the cast surfaces`

### Task 14: Docs (Phase 1) + owner checks

**Implementer:** routine (docs)

**Files:**
- Modify: `ROADMAP.md` (item 1 rewritten per spec §13; the stale "token gate for 'next episode' on the receiver" goes)
- Modify: `docs/cast.md` (German: Ablauf step 4, "Übertragung überlebt den Tab", "Abspielen auf …", "Fernbedienung", "/diagnose → Übertragung", queueing from the start, "Fortschritt am Fernseher" → "Fortschritt melden")
- Modify: `docs/security.md` (cast token section: spec §4 security model change, lookup endpoint, queued-token pin, profile switch revoke)
- Modify: `README.md`, `README.de.md` (feature line), `CHANGELOG.md` (*Unreleased*, one line)

- [ ] **Step 1: Write the docs** (German in `docs/cast.md` and `README.de.md`, English elsewhere; placeholder hosts only).
- [ ] **Step 2: Owner on-device checks** (recorded in the pull request): desktop Chrome + Chromecast: cast, close the tab, TV keeps playing, reopen FriendFlix → bar returns within 10 s (or detached → *Reconnect*), *Stop casting* stops the TV; reload of the same tab (note whether Chrome auto-joins); Android Chrome: the same; let an episode end with the tab closed → the queued episode starts on the TV; Diagnose test video plays and reports a first-frame time.
- [ ] **Step 3: Commit** `docs(cast): casts survive the tab, new remote, bar, device sheet and diagnostics`

---

## Phase 2 – Chromecast receiver (pull request 2)

### Task 15: Receiver logic – pause, loading, sender pill, key hints

**Implementer:** frontend · hard

**Files:**
- Modify: `web/static/cast-receiver/logic.js` (JSDoc types)
- Test: `web/src/lib/cast/receiver.test.ts`

**Interfaces:**
- Constants: `PAUSE_SHOW_MS = 1500`, `WHO_MS = 5000`, `STALL_SHOW_MS = 3000`.
- `initialState()` gains `paused: false, pausedAt: null, loading: 'first' | 'stall' | null, firstFrame: false, stallAt: null, keySeen: false, touch: false, meta: null, who: '', whoUntil: 0, motion: true`.
- `step(st, ev)` new events: `{ type: 'load' }` (new media: `loading = 'first'`, `firstFrame = false`, `whoUntil = now + WHO_MS`), `{ type: 'firstFrame' }`, `{ type: 'buffering', on: boolean, at: number }`, `{ type: 'pause', paused: boolean, at: number }`, `{ type: 'key' }`, `{ type: 'touch' }`, `{ type: 'clock', now: number }`; `item` messages may carry `meta: { title, line }`; `ui` may carry `who`, `motion`.
- `view(st, t)` returns additionally `{ pause: { label, title, line, pos, dur } | null, load: { title, line, label } | null, who: string | null, hint: 'keys' | 'phone' | 'touch' }`; the card gets `{ title: 'Up next in {n} s' … }` from `t.upNextIn`, and `buttons: boolean` (touch only).
- `parseMessage` accepts `item.meta.title` / `line` (strings ≤ 200), `ui.who` (≤ 80), `ui.motion` (boolean), and the new strings (`upNextIn`, `keys`, `phoneCancel`, `stopHere`, `stillKeys`, `loading`, `stall`, `paused`), with `DEFAULT_STRINGS` English fallbacks.

- [ ] **Step 1: Write the failing tests**
  - `pause screen only after 1.5 s of pause` – pause at t, clock t + 1499 → `pause` null; t + 1500 → `{ label: 'Paused', title: 'Dunmoor' }`; play → null at once.
  - `loading screen until the first frame; a 3 s stall shows Loading…` – `load` → `load.label` 'Getting ready…'; `firstFrame` → null; buffering for 3000 ms → `pause.label` 'Loading…'.
  - `sender pill for 5 s after a load and with any overlay` – `who` shown until `WHO_MS`, then null, shown again while `pause` is set.
  - `key hint appears only after a key; touch shows buttons` – fresh → `hint: 'phone'`; after `key` → `'keys'`; after `touch` → `'touch'` and `card.buttons` true.
  - `parseMessage refuses an oversized who and non-boolean motion`.
  - existing receiver tests (countdown, still watching, skip, reporter) still pass.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** root `npm run typecheck`; `npx -w web vitest run src/lib/cast/receiver.test.ts`.
- [ ] **Step 4: Commit** `feat(cast-receiver): pause, loading, sender and key-hint states in the receiver logic`

### Task 16: Sender – `meta`, `who`, `motion`, receiver strings

**Implementer:** frontend · routine

**Files:**
- Modify: `web/src/lib/cast/engine.ts` (`tvSync` adds `meta`; `tvUi` adds `who`, `motion`; `receiverStrings()` new strings)
- Modify: `web/src/lib/i18n/locales/{de,en,fr,es,it,tr,pl}/player.ts` (`castTv.*` from spec §11)
- Test: `web/src/lib/cast/engine.test.ts`

**Interfaces:**
- `receiverStrings()` gains `upNextIn: string[]` (1..`COUNTDOWN_SECONDS`, like `startsIn`), `keys`, `phoneCancel`, `stopHere`, `stillKeys`, `loading`, `stall`, `paused`.
- `tvSync` sends `meta: { title, line }` where `line = tr('player.castTv.line', { s, e, name })` for episodes, `''` for films.
- `tvUi` sends `who: tr('player.castTv.from' + Phone|Tablet|Computer, { name: <active profile name> })` (form factor from `formFactor()` of Task 11) and `motion: motionAllowed()`.

- [ ] **Step 1: Write the failing tests** – `ui message carries who and motion` (`who` = `Vom Handy von Anna` with a phone form factor; `motion` false in calm mode); `item message carries meta` (`line` = `Staffel 1 · Folge 4 · The Lantern Road`); `receiverStrings has upNextIn per second`.
- [ ] **Step 2: Implement** + strings in seven locales.
- [ ] **Step 3: Verify** root `npm run typecheck`; `engine.test.ts`.
- [ ] **Step 4: Commit** `feat(cast): the sender tells the TV who casts, what plays and whether to move`

### Task 17: Receiver page – solid panels, up-next restyle, pause and loading screens, keys

**Implementer:** frontend · hard

**Files:**
- Modify: `web/src/lib/cast/receiverPage.ts` (markup), `web/static/cast-receiver/receiver.css`, `web/static/cast-receiver/receiver.js`
- Test: `e2e/tests/cast-receiver.spec.ts`, `e2e/tests/cast-receiver.mobile.spec.ts` (Nest Hub touch case), fake in `e2e/mocks/castReceiver.ts`

**Interfaces:**
- Markup: `#who` (pill), `#card` (thumbnail `img`, `#card-title`, `#card-name`, `#card-hint`, `#card-buttons` with `#card-primary` / `#card-secondary`, `.cbar > i`), `#pause` (`#pause-label`, `#pause-title`, `#pause-line`, progress with `#pause-pos` / `#pause-dur`), `#load` (`#load-art`, `#load-title`, `#load-line`, indeterminate bar, `#load-label`), `#skip`, `#still` (now the same solid card, centred).
- CSS: tokens `--u: calc(100vw / 1280)`, `--safe: 5vw`, `--solid: #1c1a21`; all panels solid with the spec §5 border, highlight and shadow; no `backdrop-filter`; sizes per spec §5; countdown and loading bars by `transform`; panel in = opacity + `translateY(calc(24 * var(--u)))` 260 ms, out = opacity 200 ms (class toggles, not `hidden` flips, so closing animates); `@media (prefers-reduced-motion: reduce)` and `body.still` (from `ui.motion === false`) remove motion.
- JS: `PLAYER_LOAD_COMPLETE` / `LOAD` → `load`; first `PLAYING` → `firstFrame`; `BUFFERING` → `buffering`; `PAUSE` / `PLAYING` → `pause`; a `setInterval` 250 ms → `clock`; keydown → `key` then the existing actions plus ←/→ ±10 s while `pause` shows; `touchstart` → `touch`; the card's image is the media metadata's first image URL (the poster token), absent → solid placeholder.

- [ ] **Step 1: Write the failing e2e tests** (receiver page with the fake framework, German strings from a `ui` message)
  - `up next card: solid, inside the margins, countdown by transform` – card computed `backdrop-filter` is `none`; card right edge ≤ 1280 − 64; text `Als Nächstes in 10 s`; `.cbar i` transform changes over 1 s.
  - `key hint only after a key` – before any key `Abbrechen am Handy`; after `ArrowLeft` `OK spielt sofort · Zurück stoppt hier`.
  - `pause screen after 1.5 s, gone on play` – fake `PAUSE` → after 1500 ms `#pause` visible with `Pausiert`, `Dunmoor`, `Staffel 1 · Folge 4 · The Lantern Road`; `PLAYING` → hidden.
  - `loading screen until the first frame` – `LOAD` → `Wird vorbereitet …`; `PLAYING` → hidden.
  - `sender pill shows for 5 s` – `Vom Handy von Anna` visible, hidden after 5 s.
  - `closing animates` – the card stays in the DOM with opacity transitioning after cancel, then hides.
  - mobile (Nest Hub size): `touch shows Play now and Stop here` – after a tap, both buttons visible; `Hier stoppen` sends `cancel` to the sender.
- [ ] **Step 2: Implement**; remove the `it.todo` from Task 13's receiver CSS scan.
- [ ] **Step 3: Verify** root `npm run typecheck`; the two receiver specs and `glass.test.ts`.
- [ ] **Step 4: Commit** `feat(cast-receiver): solid TV panels, restyled up next, pause and loading screens`

### Task 18: Docs (Phase 2) + owner checks

**Implementer:** routine (docs)

**Files:** `docs/cast-receiver.md`, `docs/de/cast-receiver.md` (what the TV shows now, key hints, sender pill, solid panels; the hardware checks list), `CHANGELOG.md`.

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Owner on-device checks** (recorded in the pull request): Chromecast with Google TV and a plain Chromecast (and a Nest Hub if available) with the own receiver: up-next card inside the overscan, countdown smooth; OK plays now, Back stops (or closes the app: write down which); pause screen after 1.5 s, gone on play; loading screen on start and on the next episode; sender pill names the profile; text readable from 3 m.
- [ ] **Step 3: Commit** `docs(cast-receiver): pause and loading screens, key hints, sender pill`

---

## Phase 3 – AirPlay (pull request 3)

### Task 19: Backend – AirPlay subtitle rendition request

**Implementer:** backend · hard

**Files:**
- Modify: `backend/src/media/types.ts` (`MediaCapabilities.castHlsSubtitles: boolean`, JSON form), `backend/src/jellyfin/service.ts` (`playbackInfo` opts `hlsSubtitleIndex?: number` → `SubtitleStreamIndex` + `SubtitleMethod=Hls` on the HLS URL; the `SubtitleProfiles` gain `{ Format: 'vtt', Method: 'Hls' }` only for that request), the Plex service (`castHlsSubtitles: false`)
- Modify: `backend/src/routes/cast.ts` (body `subtitleIndex`, only with `via: 'airplay'` and the capability; record `hlsSub: true`), `backend/src/cast.ts` (`CastRecord.hlsSub?: boolean`, `CastAuth.scope.hlsSub?: boolean`), `backend/src/routes/internal.ts` (authz answer carries `scope.hlsSub`)
- Test: `backend/src/jellyfin/service.test.ts`, `backend/src/routes/cast.test.ts`

**Interfaces:** as listed; `subtitleIndex` with `via` other than `airplay` → 400; capability false → the field is ignored and `hlsSub` stays unset.

- [ ] **Step 1: Write the failing tests** – `AirPlay token with subtitleIndex asks Jellyfin for an HLS subtitle` (captured PlaybackInfo / URL contains `SubtitleMethod=Hls` and `SubtitleStreamIndex=3`); `Chromecast request with subtitleIndex is refused`; `authz scope carries hlsSub`; `Plex ignores subtitleIndex`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** root `npm run typecheck`; the test files if PostgreSQL is available.
- [ ] **Step 4: Commit** `feat(cast): AirPlay tokens can carry one subtitle rendition`

### Task 20: Gateway – keep one subtitle rendition for AirPlay

**Implementer:** backend · hard

**Files:**
- Modify: `gateway/src/gateway.ts` (`compatPlaylist(lines, opts?: { keepSubtitles?: boolean })`, `sanitizePlaylist` passes it from the authz scope)
- Test: `gateway/src/gateway.test.ts` (or the file that tests `compatPlaylist`)

**Interfaces:** `keepSubtitles: true` keeps the **first** `#EXT-X-MEDIA:TYPE=SUBTITLES` only, rewritten to `TYPE, GROUP-ID, NAME, LANGUAGE, DEFAULT=YES, AUTOSELECT=YES, FORCED=NO, URI`; keeps `SUBTITLES="<that group>"` on `#EXT-X-STREAM-INF`; drops other subtitle groups and all `CLOSED-CAPTIONS`. Default (`false`) behaves exactly as today. The URI check in `sanitizePlaylist` runs before and covers the kept line.

- [ ] **Step 1: Write the failing tests** – `keeps one subtitle rendition for an AirPlay token that asked`; `drops subtitle groups without keepSubtitles (Chromecast, AirPlay without subtitles)`; `a second subtitle group and closed captions are dropped`; `a kept rendition with a URI outside the token path makes the playlist fail (null)`; existing compat tests unchanged.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** root `npm run typecheck`; the gateway test file.
- [ ] **Step 4: Commit** `feat(gateway): AirPlay playlists may keep their one subtitle rendition`

### Task 21: Web – AirPlay subtitles chip, fallback, hint

**Implementer:** frontend · hard

**Files:**
- Modify: `web/src/lib/player/airplay.ts` (`AirPlayDeps.subsRefused?(): void`; on video error code 4 while wireless on a token requested with subtitles: one retry without subtitles before the variant fallback), `web/src/lib/cast/engine.ts` (AirPlay `request` sends `subtitleIndex` when `subIndex >= 0` and allowed; `setSubtitle` on AirPlay → `refresh` at the current position with the new index; `subsRefused` → toast `player.castRemote.subsRefused`, `localStorage` `ff-air-subs-refused` = now, `subIndex = -1`), `web/src/lib/cast/TrackChips.svelte` (Subtitles chip on AirPlay; disabled with `subsNoServer` without the capability; value `Aus (vom Fernseher abgelehnt)` while the refusal is < 30 days old and the person has not picked subtitles since), `web/src/lib/cast/RemoteScreen.svelte` (hint `subsHint` while subtitles are on), `web/src/lib/cast/diagnose.ts` (`subsInStream` true)
- Test: `web/src/lib/player/airplay.test.ts`, `web/src/lib/cast/engine.airplay.test.ts`, `e2e/tests/player-airplay.mobile.spec.ts`

- [ ] **Step 1: Write the failing tests**
  - `subtitle choice on AirPlay re-requests the stream with subtitleIndex` – `setSubtitle(3)` → `POST /api/cast/session` body `{ via: 'airplay', subtitleIndex: 3 }`, position kept.
  - `code 4 with subtitles retries once without, then the variant fallback` – first error → one request without `subtitleIndex`, `subsRefused` called; second error → variant fallback as today; never a third request.
  - `a remembered refusal starts AirPlay without subtitles until picked again`.
  - e2e mobile: `AirPlay remote shows the subtitles chip and the hint` – chip `Untertitel: Deutsch`, text `Untertitel über AirPlay sind neu; manche Fernseher zeigen sie nicht.`
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** root `npm run typecheck`; the three test files.
- [ ] **Step 4: Commit** `feat(airplay): subtitles travel inside the stream, with a fallback for TVs that refuse them`

### Task 22: Spike – continuous AirPlay (throwaway branch) + owner GO / NO-GO

**Implementer:** backend + frontend · hard

**Files:** branch `spike/airplay-joined` off the Phase 3 branch, **never merged**: a dev-only env flag `CAST_JOINED_SPIKE=true`; a minimal multi-item token and `/media/c/<token>/joined/main.m3u8` (+ `joined/subs.m3u8`) in the gateway for the current episode and the next two; a hidden web toggle that loads the joined URL on the AirPlay element; backend logging of inferred position per segment fetch (item, index × segment length; never the token).

- [ ] **Step 1: Build the prototype** (no tests required; no changes to `main`'s code paths).
- [ ] **Step 2: Owner runs P1–P6 of spec §8** on iPhone + Apple TV and iPhone + LG webOS AirPlay TV, using the Saltwater Almanac fixture or any three short episodes on the owner's server; each criterion recorded with what was seen (times, screenshots of `/diagnose` AirPlay log, server log excerpts without tokens).
- [ ] **Step 3: Record GO or NO-GO** in the Phase 3 pull request description and as one line appended to spec §8 ("Spike result, <date>: GO/NO-GO, P-criteria that failed"). Commit that line: `docs(cast): continuous AirPlay spike result`.
- [ ] **Step 4:** GO → Tasks 23–27. NO-GO → skip to Task 28. Delete the spike branch after the decision.

### Task 23: GO only – multi-item AirPlay token

**Implementer:** backend · hard

**Files:** `backend/src/cast.ts`, `backend/src/routes/cast.ts`, `backend/src/routes/internal.ts`; tests `backend/src/cast.test.ts`, `backend/src/routes/cast.test.ts`

**Interfaces:**
- Body `continuous: true` (only with `via: 'airplay'`, admin setting on, profile pref on, an episode). The route picks the episodes (spec §8: current + up to two by `/next`, cut by `stillWatchingEpisodes`, by the 6 h cap, none with autoplay off; `sleepAfterEpisode` is sent by the client as `sleepAfter: true` and forces a single episode), calls `playbackInfo` per episode (audio by language, subtitle by language when `subtitleIndex` is set), and mints one token with `CastRecord.items: Array<{ itemId; mediaSourceId; playSessionId; runtimeTicks; hlsPath; subsPath? }>`.
- Answer adds `joined: { items: Array<{ itemId: string; label: string; title: string; start: number; duration: number }> }` and `contentUrl` = `…/media/c/<ct>/joined/main.m3u8`.
- Authz scope for a multi-item token: `items: Array<{ itemId; mediaSourceId; playSessionId }>`; `inScope` accepts any of them.

- [ ] **Step 1: Write the failing tests** – `continuous picks up to three episodes and stops before a due Still there?`; `cap keeps the joined runtime under 6 h`; `autoplay off gives no joined stream`; `scope accepts each listed item and refuses others`; `refused without the admin setting`.
- [ ] **Step 2: Implement.** **Step 3:** root `npm run typecheck`. **Step 4: Commit** `feat(cast): one AirPlay token for several episodes in a row`

### Task 24: GO only – joined playlist in the gateway

**Implementer:** backend · hard

**Files:** `gateway/src/gateway.ts`, gateway tests

**Interfaces:** `joinPlaylists(parts: Array<{ text: string; prefix: string }>): string | null` – one VOD media playlist: `EXT-X-TARGETDURATION` = max, `EXT-X-DISCONTINUITY` before each later part, each part's URIs prefixed with its own `Videos/<id>/` path, one `EXT-X-ENDLIST`; null if any part fails `sanitizePlaylist`. Routes `/media/c/<ct>/joined/main.m3u8` and `/media/c/<ct>/joined/subs.m3u8` (multi-item tokens only); authz requests for segments carry `seg: { itemId, index }` parsed from the path (`…/hls1/main/<n>.ts`).

- [ ] **Step 1: Failing tests** – `joins three variant playlists with discontinuities`, `rewritten URIs stay inside the token path`, `a part with a foreign URI fails the whole playlist`, `segment authz carries item and index`. **Step 2–3:** implement, typecheck. **Step 4: Commit** `feat(gateway): joined playlist for continuous AirPlay`

### Task 25: GO only – server-side per-episode progress

**Implementer:** backend · hard

**Files:** `backend/src/cast.ts` (new `noteSegment`), `backend/src/routes/internal.ts`, `backend/src/live.ts` usage; tests

**Interfaces:** `noteSegment(ctx, rec, seg: { itemId; index }, segSeconds: number): Promise<void>` – the item of the fetch becomes the live play session (the previous item's live record cleared, so one stream counts); position = index × `segSeconds`; `playbackReport` `Playing` on the first fetch of an item, `Playing/Progress` at most every 30 s, `Playing/Stopped` at the previous item's runtime when fetches move to the next item, and at the last fetched position when the token is revoked or expires.

- [ ] **Step 1: Failing tests** – `moving to episode 2 stops episode 1 at its runtime and starts episode 2`, `never more than one live stream`, `progress at most every 30 s`, `revoke stops the current episode at its last position`. **Step 2–3:** implement, typecheck. **Step 4: Commit** `feat(cast): progress for continuous AirPlay is reported by the server`

### Task 26: GO only – admin switch, profile preference, sheet / account / Diagnose rows

**Implementer:** frontend + backend · routine

**Files:** `backend/src/settings/registry.ts` (`CAST_AIRPLAY_CONTINUOUS`, kind bool, group playback, default false), `backend/src/routes/prefs.ts` (`airplayContinuous`, default false), `/api/cast/config` answer `airplayContinuous: boolean`; web `web/src/lib/stores.ts` (`Prefs.airplayContinuous`), `web/src/lib/cast/playOn.ts` (`continuousAvailable`), `PlayOnSheet.svelte` (switch row with `Experimentell` badge), account playback settings page, `web/src/lib/cast/diagnose.ts` (`continuous: 'on' | 'off'`), locales (admin label, `account.playback.airplayContinuous` from spec §11); tests: prefs route test, `playOn.test.ts`, `e2e/tests/cast-picker.mobile.spec.ts`.

- [ ] **Step 1: Failing tests** – `prefs default airplayContinuous false`, `config reports the admin switch`, `sheet shows the switch only on Apple with the admin switch on`, e2e `switch row is off by default and labelled Experimentell`. **Step 2–3:** implement, typecheck. **Step 4: Commit** `feat(cast): experimental continuous AirPlay setting, off by default`

### Task 27: GO only – engine and remote screen in continuous mode

**Implementer:** frontend · hard

**Files:** `web/src/lib/cast/engine.ts` (`CastSession.joined?: { items: JoinedItem[]; index: number }`, request with `continuous: true` when the pref and config allow, position mapping, `next()` / new `prev()` as boundary seeks, end after the last item, no page-side progress reports for joined tokens), `web/src/lib/cast/remotescreen.ts` (`joinedAt(pos, items): { index; offset }`), `RemoteScreen.svelte` (info card, per-episode scrubber, previous button, "Am Stück" list); tests `engine.airplay.test.ts`, `remotescreen.test.ts`, `e2e/tests/player-airplay.mobile.spec.ts`.

- [ ] **Step 1: Failing tests** – `joinedAt maps stream time to episode and offset`, `next seeks to the next boundary; disabled on the last`, `prev disabled on the first`, `no page progress reports for a joined token`, e2e `continuous remote shows Folge 1 von 3 and the list`. **Step 2–3:** implement, typecheck. **Step 4: Commit** `feat(airplay): continuous play across episodes on the remote screen`

### Task 28: Docs (Phase 3, GO or NO-GO) + owner checks

**Implementer:** routine (docs)

**Files:** `docs/cast.md` (AirPlay subtitles section and the compatibility-table exception; continuous AirPlay: the feature on GO, or the honest note on NO-GO), `docs/security.md` (subtitle rendition; on GO the multi-item token), `ROADMAP.md` (continuous AirPlay done, or "tried, not shipped" with the reason), `CHANGELOG.md`.

- [ ] **Step 1: Write the docs** for the actual outcome.
- [ ] **Step 2: Owner on-device checks** (recorded in the pull request): subtitles over AirPlay on the Apple TV and the LG TV (shown? in sync? does the LG play the stream at all; if not, the automatic retry without subtitles and the toast); turning subtitles off and on during AirPlay; on GO: P1–P3 again on the merged build with the setting on, and with the setting off nothing changes.
- [ ] **Step 3: Commit** `docs(cast): AirPlay subtitles and the continuous play outcome`

---

## Phase 4 – Android (pull request 4)

### Task 29: Android – app-scoped `CastHub`, `switchTo`, re-adoption, queue from start

**Implementer:** android · hard

**Files:**
- Create: `android/app/src/main/kotlin/app/friendflix/android/cast/CastHub.kt`
- Modify: `cast/CastController.kt` (`switchTo`, `resume`, queue from the start, fresh-token fallback, `409 cast_unpinned` retry), `cast/CastServerApi.kt` (`lookup(castId)`), `player/PlayerActivity.kt` (`setUpCast` attaches to the hub; `releaseAll` detaches instead of `cast?.stop()`), the logout and profile-switch paths of the shell (call `CastHub.stop()`)
- Test: `android/app/src/test/kotlin/app/friendflix/android/cast/CastControllerTest.kt`, new `CastHubTest.kt`

**Interfaces:**
- `object CastHub { fun attach(host: CastHost): CastController?; fun detach(host: CastHost); fun stop(); val state: StateFlow<CastSnapshot?> }` – owns the `CastController` and `MediaThreeReceiver` for the process; `CastSnapshot(kind, device, itemId, title, subtitle, posterId, isEpisode, positionMs, durationMs, paused, state, next: NextSnapshot?)`.
- `CastServer.lookup(castId: String): CastLookup?` (`GET /api/cast/session/:castId`).
- `CastController.switchTo(itemId: String, startMs: Long?)` (old stop reported, old token revoked, one live token), `resume(receiverCastId: String?, contentUrl: String?)` (castId from custom data, else `sha256` of the token segment, then `lookup`), `QUEUE_WITHIN_MS` removed.
- `CastOptionsProvider` unchanged (`setStopReceiverApplicationWhenEndingSession(true)` stays: only an explicit end stops the receiver).

- [ ] **Step 1: Write the failing tests**
  - `closing the player keeps the cast` – hub with a live session; `detach(host)` → no `revoke`, no `report(STOP)`, receiver `end()` not called.
  - `logout and profile switch stop the cast` – `CastHub.stop()` → stop report, revoke, `end()`.
  - `switchTo replaces the token` – revoke old castId, one new `session` call for the new item.
  - `resume adopts our media; ignores foreign media` – lookup hit → snapshot `itemId`; null → no snapshot.
  - `queue from the start` and `cast_unpinned retries once after 60 s`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** root `npm run typecheck` (web untouched); CI runs Gradle.
- [ ] **Step 4: Commit** `feat(android): casting outlives the player screen and is picked up after a restart`

### Task 30: Android – native bridge cast API

**Implementer:** android · routine

**Files:** `android/.../bridge/NativeBridge.kt`, `bridge/BridgeMessages.kt`, `shell/ShellActivity.kt` (wire `CastHub.state` to `emit("cast", …)`), tests `android/app/src/test/kotlin/app/friendflix/android/bridge/NativeBridgeTest.kt`

**Interfaces:** `API_VERSION` + 1; capabilities answer gains `castBar: true`; method `castState` (no args) → snapshot JSON or `null`; method `castControl` `{ action: 'playPause' | 'next' | 'stop' | 'open' }` (anything else → `bad_args`); event `cast` with the snapshot (or `null` when the cast ends), position changes throttled to one per second. `open` starts `PlayerActivity` as the remote for the snapshot's item. Same origin policy and message validation as the existing methods.

- [ ] **Step 1: Failing tests** – `castState returns the hub snapshot`, `castControl rejects unknown actions`, `cast events are throttled to 1 per second for position-only changes`, `stop routes to CastHub.stop`. **Step 2–3:** implement; CI runs Gradle. **Step 4: Commit** `feat(android): the shell's web UI can read and drive the running cast`

### Task 31: Web – `CastBarSource`, native adapter, bar in the Android shell

**Implementer:** frontend · routine

**Files:**
- Create: `web/src/lib/cast/barSource.ts`, `web/src/lib/cast/barSource.test.ts`
- Modify: `web/src/lib/native/bridge.ts` (`castState`, `castControl`, `cast` event store `nativeCast`), `web/src/lib/cast/CastBar.svelte` (reads a `CastBarSource`), `web/src/routes/+layout.svelte` (picks the source)
- Test: `e2e/tests/android-castbar.mobile.spec.ts` with `e2e/mocks/native.ts` (add the cast methods and events)

**Interfaces:**
- `export interface CastBarSource { session: Readable<CastSession | null>; playPause(): void; next(): void; stop(): Promise<void>; open(): void; canExpand: boolean }`
- `engineSource(): CastBarSource` (today's behaviour), `nativeSource(): CastBarSource` (maps the snapshot to a `CastSession` with `kind: 'chromecast'`; `open` → `castControl open`; `stop` → `castControl stop`; `canExpand: false`).
- Layout: inside the Android shell with `capabilities.castBar` → `nativeSource()`, else `engineSource()`; `barVisible` unchanged.

- [ ] **Step 1: Failing tests** – unit `nativeSource maps a snapshot to a session` and `stop and open call castControl`; e2e `Android shell shows the bar from native cast events` (native fake emits a snapshot → region `Jetzt auf dem Fernseher` with `Dunmoor · S1 E4`, `Auf Wohnzimmer-TV`; `Pause` → `castControl playPause`; `Übertragung beenden` → confirm → `castControl stop`; bar 8 px above the tab bar). **Step 2–3:** implement; root `npm run typecheck`; the unit file and the spec. **Step 4: Commit** `feat(android): cast bar while browsing in the app`

### Task 32: Docs (Phase 4) + owner checks

**Implementer:** routine (docs)

**Files:** `docs/android.md` ("Closing the player stops the cast." replaced; the bar while browsing; re-adoption after an app restart), `docs/cast.md` (Android note), `CHANGELOG.md`.

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Owner on-device checks** (recorded in the pull request): Android phone + Chromecast: cast from the player, close it → bar on Home, Pause and Stop work; open another title → the TV switches; swipe the app away and reopen → bar returns; logout ends the cast.
- [ ] **Step 3: Commit** `docs(android): cast bar while browsing`
