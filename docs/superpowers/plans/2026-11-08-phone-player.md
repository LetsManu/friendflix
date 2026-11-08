# Phone Player Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone player gets the cinema dock of the desktop player (title block, timeline row with both times, two glass pills), a glass top bar, panels that open above the timeline, a pause screen and the credits sequence, in landscape (either way round) and portrait, with nothing overlapping.

**Architecture:** Pure logic (orientation, tool list, panel geometry, sub line, layout gates) lives in tested TypeScript in `web/src/lib/player/phone/logic.ts`. `Player.svelte` keeps owning playback, gestures and menus; on phones it gets a new `phoneUi` layout (stage `.pui`) that reuses today's `.ctl` markup as a flex-column dock, the way block 2 reused it for `desk`, and wires state into new components under `web/src/lib/player/phone/`. Kids on a phone keep today's phone layout (`.stage.phone`) untouched. The watch page lifts the credits-sequence gate for phones.

**Tech Stack:** SvelteKit (Svelte 4 syntax, `$:`), TypeScript, vitest, Playwright (`mobile` project), motion helpers in `web/src/lib/tv/motion.ts`, the desk helpers in `web/src/lib/player/desk/` (`deskPauseDue`, `grow`, `springAt`).

**Spec:** `docs/superpowers/specs/2026-11-08-phone-player-design.md`

## Global Constraints

- Phone player only: `phoneUi = phonePlayer({ coarse, tv: tvUi, kids: $kidsMode })` (coarse pointer, not TV, not kids). Desktop (`desk`), TV (`tvUi`) and kids players render exactly as today; a kids profile on a phone keeps today's `.stage.phone` layout (`.cc` centre controls, `.next` card).
- Own look: coral `#ff4f6d`, FriendFlix logo, Inter. Never another streaming service's name in user-facing text.
- Every player feature stays (tracks, speed, quality, sound modes, subtitle search, scenes and bookmarks, cast & info, PiP, AirPlay, Chromecast, watch party, sleep timer, lock, error recovery, telemetry, the phone remote). No backend change.
- Gestures stay as today: double tap left/right third seeks with the cumulative ripple, vertical swipe brightness (left) / volume (right, not on iOS), horizontal swipe scrubs, lock with hold to unlock.
- Safe areas: all four `--safe-*` tokens (`env(safe-area-inset-*)` in `app.css`); landscape with the cut-out left or right, and portrait. Rotation re-lays out without a reload; nothing under the cut-out or the home indicator.
- Animate only `transform` and `opacity`; shared motion system (`#lib/tv/motion`); the layout's frame guard already runs with `DESK_GUARD` on phones (landscape ≥ 721 px sets `deskActive`, portrait sets `phoneShell`, see `routes/+layout.svelte` `syncDeskGuard`); reduced motion and calm (`motionAllowed()` false) switch instantly; blur only when `motionLevel() === 'full'`.
- Touch targets ≥ 44×44 px (pill buttons 48, play 56); every new string in all seven locales (en, de, pl, es, fr, it, tr), `de` is the type source.
- New phone parts live in their own files under `web/src/lib/player/phone/`; `Player.svelte` only wires state into them.
- Owner rule: implementers write the tests and run only the root `npm run typecheck` (they may run their own specs locally to debug); CI runs vitest and Playwright. Coverage thresholds statements 94 % / branches 89 % count every `src/**/*.ts`: every new `.ts` file gets full unit tests; DOM-only code goes in `.svelte` files.
- Placeholder hosts only (friend.example.com, 192.0.2.x).
- Every commit ends with these two trailer lines (after a blank line):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN
  ```

## Review Focus

1. Rotation with a panel open, while scrubbing or with the credits picture in the corner: the layout must re-lay out in place (panel re-anchors full width ↔ end side and stays above the timeline, the picture stays in the corner) — test in Task 3 and Task 5.
2. One Back still leaves the player after a panel was opened and closed, after picking an episode from the Episodes panel and after "Next episode" from More (portrait): the panel's history entry must be gone before the page navigates — tests in Task 3 (`player-back.mobile.spec.ts` must stay green).
3. Kids profile on a phone: today's phone player exactly (`.stage.phone`, `.cc`, `.next` card, no `.pui`, no `.cs`, no pause screen) — tests in Tasks 2, 4 and 5.
4. Very small phones and long localised titles (320×568 portrait, 568×320 landscape, a 90-character series name): dock parts never intersect, the tools pill fits, no horizontal overflow — test in Task 2.
5. Scrubbing the timeline with a finger after 3 s idle: the dock must not hide mid-drag, the thumbnail tip sits above the track (not under the thumb or off-screen at the edges) and the seek commits on release — test in Task 2.

---

### Task 1: Pure helpers and the episode line key

**Files:**
- Create: `web/src/lib/player/phone/logic.ts`
- Test: `web/src/lib/player/phone/logic.test.ts`
- Modify: `web/src/lib/i18n/locales/{en,de,pl,es,fr,it,tr}/player.ts` (new `phone` group)

**Interfaces:**
- Consumes: `fmtRuntime` (`#lib/hover`), `TFn` (`#lib/i18n`), `player.episodeOnly` key.
- Produces:
  - `phonePlayer(o: { coarse: boolean; tv: boolean; kids: boolean }): boolean` — `o.coarse && !o.tv && !o.kids`.
  - `creditsOn(o: { kids: boolean; tv: boolean; desk: boolean; phone: boolean }): boolean` — `!o.kids && (o.tv || o.desk || o.phone)`.
  - `type PhoneOrient = 'landscape' | 'portrait'`; `phoneOrient(w: number, h: number): PhoneOrient` — `h > w` → `'portrait'`, else `'landscape'`.
  - `type PhoneTool = 'next' | 'episodes' | 'tracks' | 'speed' | 'more'`; `type ToolFeatures = { next: boolean; episodes: boolean; tracks: boolean; speed: boolean }`
  - `phoneTools(o: PhoneOrient, f: ToolFeatures): PhoneTool[]` — landscape: `next, episodes, tracks, speed, more` in that order, each only when its feature is true (`more` always); portrait: `episodes, tracks, more`.
  - `moreExtras(o: PhoneOrient, f: ToolFeatures): ('speed' | 'next')[]` — what More lists on top in portrait: `speed` (when `f.speed`) then `next` (when `f.next`); landscape `[]`.
  - `type PanelAnchor = 'start' | 'end' | 'full'`; `panelAnchor(o: PhoneOrient, pill: 'start' | 'end'): PanelAnchor` — portrait `'full'`, landscape `pill`.
  - `PANEL_GAP = 8`, `PANEL_MAX_W = 380`
  - `panelBox(o: { stageH: number; tlTop: number; topBottom: number }): { bottom: number; maxH: number }` — `bottom = stageH - tlTop + PANEL_GAP`; `maxH = max(0, tlTop - PANEL_GAP - topBottom - PANEL_GAP)` (all px relative to the stage).
  - `growOrigin(o: { anchor: PanelAnchor; btnX: number; left: number; width: number }): string` — `'end'` → `'bottom right'`, `'start'` → `'bottom left'`, `'full'` → `` `${p}% 100%` `` with `p = clamp(round((btnX - left) / width * 100), 0, 100)` (`width <= 0` → 50).
  - `phoneSub(it: { type?: string; name: string; seriesName?: string; parentIndexNumber?: number | null; indexNumber?: number | null; year?: number; runtimeTicks?: number } | null, tf: TFn = tr): string` — episode (has `seriesName`): `tf('player.phone.episodeLine', { s, e, name })`; season unknown: `` `${tf('player.episodeOnly', { e })} · ${name}` ``; episode number unknown: `name`. Film: `[year, fmtRuntime(runtimeTicks)]` non-empty parts joined with `' · '`. `null` → `''`.

New i18n group `player.phone` (7 locales; `de` first):
- `episodeLine`: de `'S{s} · F{e} · {name}'`, en `'S{s} · E{e} · {name}'`, pl `'S{s} · O{e} · {name}'`, es `'T{s} · E{e} · {name}'`, fr `'S{s} · E{e} · {name}'`, it `'S{s} · E{e} · {name}'`, tr `'S{s} · B{e} · {name}'`
- `playback` (left pill label): de `'Wiedergabe'`, en `'Playback'`, pl `'Odtwarzanie'`, es `'Reproducción'`, fr `'Lecture'`, it `'Riproduzione'`, tr `'Oynatma'`
- `tools` (right pill label): de `'Werkzeuge'`, en `'Tools'`, pl `'Narzędzia'`, es `'Herramientas'`, fr `'Outils'`, it `'Strumenti'`, tr `'Araçlar'`

- [ ] **Step 1: Write the failing tests** in `logic.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PANEL_GAP, PANEL_MAX_W, creditsOn, growOrigin, moreExtras, panelAnchor, panelBox, phoneOrient, phonePlayer, phoneSub, phoneTools } from './logic';

const all = { next: true, episodes: true, tracks: true, speed: true };
const tf = ((k: string, p?: Record<string, unknown>) => `${k}${p ? JSON.stringify(p) : ''}`) as never;

describe('gates', () => {
  it('phone player: coarse pointer, not TV, not kids', () => {
    expect(phonePlayer({ coarse: true, tv: false, kids: false })).toBe(true);
    expect(phonePlayer({ coarse: true, tv: true, kids: false })).toBe(false);
    expect(phonePlayer({ coarse: true, tv: false, kids: true })).toBe(false);
    expect(phonePlayer({ coarse: false, tv: false, kids: false })).toBe(false);
  });
  it('credits sequence on TV, desktop and phones, never for kids', () => {
    expect(creditsOn({ kids: false, tv: false, desk: false, phone: true })).toBe(true);
    expect(creditsOn({ kids: false, tv: true, desk: false, phone: false })).toBe(true);
    expect(creditsOn({ kids: false, tv: false, desk: true, phone: false })).toBe(true);
    expect(creditsOn({ kids: true, tv: false, desk: false, phone: true })).toBe(false);
    expect(creditsOn({ kids: false, tv: false, desk: false, phone: false })).toBe(false);
  });
});
describe('orientation and tools', () => {
  it('portrait only when taller than wide', () => {
    expect(phoneOrient(390, 844)).toBe('portrait');
    expect(phoneOrient(844, 390)).toBe('landscape');
    expect(phoneOrient(500, 500)).toBe('landscape');
  });
  it('landscape: next, episodes, tracks, speed, more; portrait: episodes, tracks, more', () => {
    expect(phoneTools('landscape', all)).toEqual(['next', 'episodes', 'tracks', 'speed', 'more']);
    expect(phoneTools('portrait', all)).toEqual(['episodes', 'tracks', 'more']);
  });
  it('missing features drop their button; more always stays', () => {
    const film = { next: false, episodes: false, tracks: true, speed: true };
    expect(phoneTools('landscape', film)).toEqual(['tracks', 'speed', 'more']);
    expect(phoneTools('portrait', { next: false, episodes: false, tracks: false, speed: false })).toEqual(['more']);
  });
  it('portrait moves speed and next into More', () => {
    expect(moreExtras('portrait', all)).toEqual(['speed', 'next']);
    expect(moreExtras('portrait', { ...all, speed: false, next: false })).toEqual([]);
    expect(moreExtras('landscape', all)).toEqual([]);
  });
});
describe('panels', () => {
  it('anchor: full width in portrait, the pill side in landscape', () => {
    expect(panelAnchor('portrait', 'end')).toBe('full');
    expect(panelAnchor('landscape', 'end')).toBe('end');
    expect(panelAnchor('landscape', 'start')).toBe('start');
  });
  it('bottom edge 8 px above the timeline row, height up to the top bar', () => {
    expect(PANEL_GAP).toBe(8); expect(PANEL_MAX_W).toBe(380);
    expect(panelBox({ stageH: 390, tlTop: 290, topBottom: 60 })).toEqual({ bottom: 108, maxH: 214 });
    expect(panelBox({ stageH: 390, tlTop: 60, topBottom: 60 }).maxH).toBe(0);
  });
  it('grows from the button corner', () => {
    expect(growOrigin({ anchor: 'end', btnX: 0, left: 0, width: 0 })).toBe('bottom right');
    expect(growOrigin({ anchor: 'start', btnX: 0, left: 0, width: 0 })).toBe('bottom left');
    expect(growOrigin({ anchor: 'full', btnX: 300, left: 16, width: 358 })).toBe('79% 100%');
    expect(growOrigin({ anchor: 'full', btnX: 900, left: 16, width: 358 })).toBe('100% 100%');
    expect(growOrigin({ anchor: 'full', btnX: 5, left: 16, width: 0 })).toBe('50% 100%');
  });
});
describe('phoneSub', () => {
  it('episode line, with and without a season, without a number', () => {
    const ep = { type: 'Episode', name: 'Der lange Winter', seriesName: 'Nordlicht', parentIndexNumber: 2, indexNumber: 5 };
    expect(phoneSub(ep, tf)).toBe('player.phone.episodeLine{"s":2,"e":5,"name":"Der lange Winter"}');
    expect(phoneSub({ ...ep, parentIndexNumber: null }, tf)).toBe('player.episodeOnly{"e":5} · Der lange Winter');
    expect(phoneSub({ ...ep, indexNumber: null }, tf)).toBe('Der lange Winter');
  });
  it('film: year · length; parts left out when unknown', () => {
    expect(phoneSub({ type: 'Movie', name: 'Inkwell', year: 2021 }, tf)).toBe('2021');
    expect(phoneSub({ type: 'Movie', name: 'Inkwell' }, tf)).toBe('');
    expect(phoneSub({ type: 'Movie', name: 'Inkwell', year: 2021, runtimeTicks: 112 * 600_000_000 })).toMatch(/^2021 · .+/);
    expect(phoneSub(null, tf)).toBe('');
  });
});
```

(The last film assertion uses the default `tf = tr`, like `barTitles`.)

- [ ] **Step 2: Run** `npx vitest run src/lib/player/phone/logic.test.ts` in `web/` (local debug only) — FAIL, module missing.
- [ ] **Step 3: Implement** `logic.ts` (SPDX header and a one-line module comment like `desk/logic.ts`) and the `player.phone` group in all seven locales.
- [ ] **Step 4: Verify** root `npm run typecheck` passes.
- [ ] **Step 5: Commit** `feat(phone-player): orientation, tool list, panel geometry and sub line helpers` (with the trailer lines).

---

### Task 2: Phone dock and top bar (rotation-safe, safe areas, no overlap)

**Files:**
- Create: `web/src/lib/player/phone/PhoneTitle.svelte`, `web/src/lib/player/phone/PhoneTopBar.svelte`, `web/src/lib/player/phone/ProgressLine.svelte`
- Modify: `web/src/lib/Player.svelte` (state ~l.180–240, `onMount` ~l.1252, markup `.ovl` ~l.1460, `.cc` ~l.1464, skip ~l.1474, `.ctl` ~l.1507–1660, phone CSS ~l.1885–1960)
- Modify: `web/src/routes/watch/[id]/+page.svelte` (`slot="top"` l.261–264 and its CSS)
- Create: `e2e/mocks/phone.ts` (moves `forceSafeArea`, `forceIosVolume`, `showControls`, the box helpers out of `player-phone.mobile.spec.ts`)
- Test: `e2e/tests/phone-player.mobile.spec.ts` (new)
- Modify (selectors only, no weaker assertions): `e2e/tests/player-phone.mobile.spec.ts`, `e2e/tests/player-scenes.mobile.spec.ts`, `e2e/tests/cast-remote.mobile.spec.ts`, `e2e/mocks/back.ts` (`ready`)

**Interfaces:**
- Consumes: Task 1 (`phonePlayer`, `phoneOrient`, `phoneTools`, `moreExtras`, `phoneSub`, `PhoneOrient`, `PhoneTool`); `kidsMode` (`#lib/kids`); `nowChapter`, `fmtClock`, `springAt`, `QualityChip`.
- Produces (later tasks rely on these): in `Player.svelte` `let winW = 0, winH = 0` bound from `<svelte:window bind:innerWidth={winW} bind:innerHeight={winH}>`; `$: phoneUi = phonePlayer({ coarse, tv: tvUi, kids: $kidsMode })`; `$: orient = phoneOrient(winW, winH)`; `export let orient: PhoneOrient = 'landscape'` is the same value made bindable (assign in the `$:`); `$: tools = phoneTools(orient, { next: hasNext, episodes: Boolean(seriesId), tracks: Boolean(info || tvSession), speed: !partyMode })`; stage classes `class:pui={phoneUi}` and `class:port={phoneUi && orient === 'portrait'}`, `class:phone={phone && !phoneUi}` (kids keep every `.stage.phone` rule); dock DOM: `.ctl.dock` > `.ptitle` (PhoneTitle) > `.ptx` (`em` chapter, `b` title, `span` sub) + slot `skip`; `.timeline.tlrow` (`.el`, `.track`, `.rem`); `.row` > `.grp.pill.lp` + `.grp.right.pill.tp`. Top bar: `.ovl` > page `.top` (back) + `.ptop` (PhoneTopBar). Hidden-state line: `.pline`.
- Components:
  - `PhoneTitle` props `{ chapter: string; title: string; sub: string; orient: PhoneOrient; hidden: boolean }`, named slot `skip`. Landscape: text block max 58 % wide, skip at the row's end; portrait: text full width, skip on its own row below (end-aligned). `hidden` → text `opacity: 0; visibility: hidden` (200 ms). Title 28 px (landscape) / 24 px (portrait), weight 900, wraps (2-line clamp), chapter coral uppercase one line, sub one line with ellipsis.
  - `PhoneTopBar` props `{ cast: { on: boolean; label: string } | null; airplay: { on: boolean; busy: boolean; label: string } | null; lock: boolean; blur: boolean }`, events `cast`, `airplay`, `lock`; default slot for the quality chip. Glass circles 44 px (`rgba(20,20,24,.62)`, 1 px `rgba(255,255,255,.12)` border, `backdrop-filter: blur(16px)` only with `blur`). Lock label `player.lock.lockAria`; AirPlay keeps `data-testid="airplay"`.
  - `ProgressLine` props `{ pct: number; shown: boolean }` — 3 px line at `bottom: var(--safe-bottom)`, coral fill by `transform: scaleX(pct/100)`, fades with `opacity` (250 ms).

Layout when `phoneUi` (otherwise today's markup):
- Top bar: `.ovl` is a flex row (`justify-content: space-between`), padding `calc(var(--safe-top) + 8px) calc(var(--safe-right) + 16px + var(--inset, 0px)) 0 calc(var(--safe-left) + 16px)`, top scrim gradient. The page's `.top` shows only the back button, as a 44 px glass circle; its `.ttl.phone` renders only when `!phonePlayer({ coarse, tv: tvUi, kids: $kidsMode })` (kids phones keep it). `PhoneTopBar` holds the quality chip (`compact`, today's `phoneChip` condition), Cast (`!partyMode && ($castState.available || $castState.connected)`, label `castLabel`, `on:cast={castClick}`), AirPlay (today's condition, `on:airplay={() => air?.pick()}`), lock (`!remote`, `on:lock={lockNow}`). These leave the pill and More on `phoneUi` (no duplicates).
- Dock: `.ctl` gets `class:dock={phoneUi}`: `display: flex; flex-direction: column; gap: 10px`, padding `0 calc(var(--safe-right) + 16px + var(--inset, 0px)) calc(var(--safe-bottom) + 12px) calc(var(--safe-left) + 16px)`, bottom scrim (`::before`, opacity fade). Order: `PhoneTitle` (`chapter={nowChapter}`, `title={barTitle || title}`, `sub={phoneSub(item, $t)}`), timeline row (`.el` elapsed, track, `.rem` `−mm:ss` with today's desk `role="timer"` label, tabular figures; `.cur` stays only for `phone && !phoneUi`), pill row (`justify-content: space-between`).
- Left pill (`aria-label` `player.phone.playback`, `role="group"`): −10, play/pause (`big`, 56 px), +10. Right pill (`player.phone.tools`): `<slot name="extra" />` first, then one button per entry of `tools` (today's buttons and menus, `!coarse` guards on speed replaced by `tools.includes('speed')`). Not in the pill on `phoneUi`: cast & info (`users`), AirPlay, mute, fullscreen.
- More on `phoneUi`: `moreExtras(orient, …)` items first (speed → existing `menu = 'speed'` sub-view; next → `player.controls.next`, calls `goNext`), then today's items without lock and Cast, plus mute (`player.mute`/`player.unmute`, only where `volOk && tvSession?.kind !== 'airplay'`) and fullscreen (`player.controls.fullscreen`/`exitFullscreen`, only `!tvSession`). Kids phones: More unchanged.
- Skip: on `phoneUi` the skip button (class `skipbtn`, same handler, `aria-keyshortcuts="S"`) is rendered in `PhoneTitle`'s `skip` slot instead of the absolute one; while the dock is hidden it stays visible and tappable (on `.pui` `.ctl.hide` fades its children except `.ptitle .skipbtn`, not itself).
- No `.cc` on `phoneUi` (play and ±10 live in the left pill); `ccOn` gains `&& !phoneUi`.
- Hiding: `.ovl`, `.ctl` children and both scrims fade with `opacity` 250 ms (today's `showUi`, `hideMs` 3000); `ProgressLine shown={phoneUi && !showUi && !locked}`.
- Rotation: no reload; everything follows `orient` and CSS; a `resize` re-measures nothing else in this task.
- `blur = (desk || phoneUi) && fullMotion($prefs, $motionTripped)`; the pills use the desk pill fill/border/blur rule.
- CSS: keep every bar/menu/`.cc`/skip rule under `.stage.phone`; change the cast-screen rules (`.stage.phone.rmt`, `.remote`, `.rmid`, `.rcard`, `.rthumb`, `.racts`, `.ron`, `.castov`, `.castbox`, `.lockbtn`) to `:is(.stage.phone, .stage.pui)` so casting looks as today.

- [ ] **Step 1: Move helpers** from `player-phone.mobile.spec.ts` into `e2e/mocks/phone.ts`: `forceSafeArea(page, insets)`, `setSafeArea(page, insets)` (same tokens via `page.evaluate`, for rotation), `forceIosVolume(page)`, `showControls(page)` (tap at `x: 30, y: 30 %` only when `.ctl.hide`), `openPhoneEpisode(page, name?)` (today's `openEpisode`, item name overridable; waits for `.ptitle` instead of `.top .ttl`), `boxes(page, selectors: string[])` and `overlap(a, b)`. Insets: `PORTRAIT = { top: 59, right: 0, bottom: 34, left: 0 }`, `LAND_L = { top: 0, right: 0, bottom: 21, left: 59 }`, `LAND_R = { top: 0, right: 59, bottom: 21, left: 0 }`.
- [ ] **Step 2: Write `phone-player.mobile.spec.ts`** (German UI, `mockPlayer` + `videoReady` like `player-phone.mobile.spec.ts`; viewports per `test.describe` with `test.use({ viewport: { width: 844, height: 390 } })` / `{ width: 390, height: 844 }` — `isMobile`, `hasTouch` and `deviceScaleFactor` come from the `mobile` project). Long title fixture: `seriesName` `'Die außergewöhnlich lange Chronik der Schmiede im Tal der vergessenen Königinnen und Könige'`, episode name `'Der Schmied, der nicht aufhören wollte zu reden, und sein Lehrling'`, skip segment `{ type: 'Intro', start: 0, end: 300 }`. For each of `landscape, cut-out left` (844×390, `LAND_L`), `landscape, cut-out right` (844×390, `LAND_R`), `portrait` (390×844, `PORTRAIT`):
  - `dock order and no overlap with a long title` — `.stage.pui` present, `.cc` count 0; boxes of `.ptitle .ptx`, `.ptitle .skipbtn`, `.ctl .tlrow`, `.pill.lp`, `.pill.tp`, `.ptop`, `.top .icon-btn` pairwise do not overlap; each inside `[left, vw - right] × [top, vh - bottom]`; vertical order `.ptx` bottom ≤ `.tlrow` top ≤ `.pill` top; landscape: `.ptx` width ≤ 0.58 × dock width and skip's centre-y within the title row; portrait: skip top ≥ `.ptx` bottom; every button in `.pill` and `.ptop` ≥ 44×44; `.el` matches `/^(\d+:)?\d+:\d\d$/`, `.rem` matches `/^−(\d+:)?\d+:\d\d$/`.
  - `tools per orientation` — landscape (episode with next, `**/api/items/*/next` mocked): `.pill.tp` buttons in order 'Nächste Folge', 'Folgen', 'Audio und Untertitel', `/^Wiedergabetempo/`, 'Mehr'; portrait: 'Folgen', 'Audio und Untertitel', 'Mehr', and More lists `/^Wiedergabetempo/` and 'Nächste Folge'; a film (`MOVIE`) has no 'Nächste Folge' and no 'Folgen'; 'Besetzung & Infos' is not in the pills but in More; the top bar has 'Bedienung sperren'.
- [ ] **Step 3: Append single tests** (portrait unless stated):
  - `rotation re-lays out without a reload` — set `window.__ff = 1`, `setViewportSize(844×390)` + `setSafeArea(LAND_L)` → `.stage.port` count 0, dock checks of Step 2 hold, `window.__ff` still 1; back to 390×844 → `.stage.port` count 1.
  - `controls hide after 3 s and return on a tap; the progress line shows meanwhile; skip stays` — `page.clock.install()`, play, `runFor(3500)` → `.ctl.hide`, `.ovl.hide`, `.pline` visible with bottom ≤ `844 - 34`, `.ptitle .skipbtn` visible and its centre hit-tests to itself (`elementFromPoint`); tap → `.ctl` not `hide`.
  - `double tap right seeks, lock in the top bar holds until hold-to-unlock` — double tap at 80 % width → `.riplbl.right` visible, `currentTime` +10 (±1); tap 'Bedienung sperren' → `.stage.locked`, `.ctl.hide`; the unlock button sits inside the safe area.
  - `scrubbing holds the dock and commits on release` — `page.clock.install()`, play; `mouse.down` on `.track` at 20 %, move to 60 %, `runFor(4000)` → `.ctl` not `hide`, `.tip` visible with its bottom ≤ the track's top and inside the viewport; also at 99 %; `mouse.up` → `currentTime` within 2 % of 99 % of the duration.
  - `iOS: no mute anywhere; fullscreen in More` / `mute lives in More where the volume works` (replace the two old tests).
  - `small phones: 320×568 and 568×320 keep the dock apart` — Step 2's overlap check with the long title; `noHorizontalOverflow(page)` true.
  - `kids on a phone keep today's player` — `/api/me` → the `KID` object from `kids.mobile.spec.ts`, its init script; `/watch/<id>` → `.stage.phone` and `.cc` present, `.stage.pui` count 0, `.top .ttl` visible.
- [ ] **Step 4: Update existing specs without weakening:** `player-phone.mobile.spec.ts` keeps its iPhone 393×852 / 852×393 overlap-and-safe-area test, pointed at `.ovl button, .ctl button, .ctl [role="slider"]` (no `.cc`), drops the centre-control and one-line-title tests (replaced in Step 2), moves "lock lives in More" to "lock lives in the top bar", keeps "menus open above the bottom bar" (Task 3 tightens it); `player-scenes.mobile.spec.ts` opens Cast & info through 'Mehr' → 'Besetzung & Infos' and asserts the full panel (`als Dom Cobb`, inside 390 px) instead of the peek; `cast-remote.mobile.spec.ts` reads 'Stumm' inside 'Mehr' (Chromecast: present; AirPlay: absent; 'Vollbild' absent in both); `e2e/mocks/back.ts` `ready` checks `expect(page.locator('.stage')).toContainText(ep.name)`.
- [ ] **Step 5: Implement** the components, Player wiring, page slot change and CSS.
- [ ] **Step 6: Verify** root `npm run typecheck`.
- [ ] **Step 7: Commit** `feat(phone-player): cinema dock, glass pills and top bar in both orientations`.

---

### Task 3: Panels above the timeline (title fades, grow, close, Back)

**Files:**
- Create: `web/src/lib/player/phone/BackLayer.svelte` (renderless)
- Modify: `web/src/lib/Player.svelte` (`cardIn`/`cardOut`, menus ~l.1560–1655, `pickEpisode`, `goNext` from More, phone menu CSS), `web/src/lib/player/EpisodesPanel.svelte` (prop `synopsis`), `web/src/app.d.ts` (`PageState.panel?: string`)
- Test: `e2e/tests/phone-player.mobile.spec.ts` (append), `e2e/tests/player-phone.mobile.spec.ts` (tighten the menu test)

**Interfaces:**
- Consumes: `panelAnchor`, `panelBox`, `growOrigin`, `PANEL_MAX_W` (Task 1); `phoneUi`, `orient`, `.tlrow`, `.ptop`, `PhoneTitle.hidden` (Task 2); `grow(node, { origin, on })` from `#lib/player/desk/grow`; `pushState` (`$app/navigation`), `pageStore` (`#lib/page`).
- Produces: `BackLayer` props `{ open: boolean; key: 'panel' }`, event `back`, method `drop(): Promise<void>`; Player `async function leaveMenu(): Promise<void>` (awaits `drop()`, then `menu = ''`).

Behaviour on `phoneUi`:
- When a menu opens (and on `resize` while open) the Player measures the stage, `.tlrow` top and `.ptop` bottom (`getBoundingClientRect`, relative to the stage) and sets `--pnl-b` / `--pnl-h` from `panelBox`; `.stage.pui .menu` (all menu classes incl. `.bare`): `position: absolute; bottom: var(--pnl-b); max-height: var(--pnl-h); overflow-y: auto`; landscape (`panelAnchor(orient, 'end')`): `right: calc(var(--safe-right) + 16px + var(--inset, 0px)); width: min(380px, …)`; portrait: `left: calc(var(--safe-left) + 16px); right: calc(var(--safe-right) + 16px)`. Glass card like the desk menus (radius 14 px, blur rule).
- `cardIn` / `cardOut` use the desk behaviour for `desk || phoneUi`: first card grows (`grow`, origin `growOrigin({ anchor, btnX: opener centre x, left: card left, width: card width })`), switching crossfades (200/120 ms); none without motion.
- `PhoneTitle hidden={menu !== ''}`; `showUi` already keeps the dock while a menu is open.
- Closing: tap outside (today's `handleTap` / `onOutsideClick`), the button again (today's toggle), Back: `<BackLayer open={phoneUi && menu !== ''} key="panel" on:back={() => (menu = '')} bind:this={menuLayer} />` — on open it pushes one shallow entry (`pushState('', { ...$page.state, panel: token })`); when the state loses the token it dispatches `back`; when `open` turns false any other way and the token is still current it calls `history.back()` once (ignoring the resulting popstate). `drop()` pops the entry (if current) and resolves on `popstate`. `pickEpisode` and the More "Next episode" item `await leaveMenu()` before dispatching `episode` / `next`, so one Back still leaves the player.
- Episodes: `EpisodesPanel` gets `export let synopsis = false`; with it every row shows its overview clamped to one line (`.ov`); Player passes `synopsis={phoneUi}`. Current row highlighted and scrolled into view (today). Audio & subtitles: today's `.menu.tracks` — columns in landscape, sections in portrait.
- Playback continues while a panel is open (no pause on open).

- [ ] **Step 1: Append e2e tests** (`phone-player.mobile.spec.ts`; an episode with a next episode):
  - `a panel opens above the timeline without covering it or the pills` (landscape `LAND_L` and portrait): tap 'Audio und Untertitel' → dialog 'Audio und Untertitel' visible; its bottom ≤ `.tlrow` top − 7.5; its top ≥ `.ptop` bottom; `.ptitle .ptx` computed opacity `'0'`; landscape: its right edge within 16.5 px of the dock's right edge and width ≤ 380; portrait: its left/right within 16.5 px of the dock's sides; the video is not paused.
  - `outside tap, the button again and Back close it` — tap the picture at 50 %/30 % → dialog count 0 and `.ptx` opacity `'1'`; reopen, tap the button again → closed; reopen, `page.goBack()` → closed and still on `/watch/<id>`; `page.goBack()` once more → the previous page (open the player from `/` first).
  - `switching panels crossfades: one card at a time` — open 'Folgen', then 'Audio und Untertitel' → exactly one `.menu` in the DOM after the transition.
  - `episodes: rows with a one-line synopsis, the current one in view` — open 'Folgen' → `.eps .ep.cur` in the viewport of the list; every `.ep .ov` has computed `-webkit-line-clamp` `'1'`.
  - `rotating with a panel open keeps it above the timeline` — portrait panel open → `setViewportSize(844×390)` + `setSafeArea(LAND_L)` → still open, bottom ≤ new `.tlrow` top, width ≤ 380.
  - `picking an episode from the panel: one Back leaves the player` — open from `/`, 'Folgen' → another episode row → URL `/watch/<other>`; `page.goBack()` → `/`.
  - `portrait: Next episode from More, then one Back leaves the player` — same shape via 'Mehr' → 'Nächste Folge'.
- [ ] **Step 2: Tighten** `player-phone.mobile.spec.ts` "menus open above the bottom bar": the 'Mehr' dialog's bottom ≤ `.tlrow` top − 7.5 (was the old timeline top).
- [ ] **Step 3: Implement** BackLayer, PageState field, measurement, CSS, transitions, EpisodesPanel prop.
- [ ] **Step 4: Verify** root `npm run typecheck`; `player-back.mobile.spec.ts` is unchanged and must stay green in CI.
- [ ] **Step 5: Commit** `feat(phone-player): panels above the timeline that grow out of their button`.

---

### Task 4: Phone pause screen

**Files:**
- Create: `web/src/lib/player/phone/PhonePauseScreen.svelte`
- Modify: `web/src/lib/Player.svelte` (`deskBlocked` → `pauseBlocked`, `phonePause`, `showUi`, `showXray` auto path l.852, stage class, markup next to `DeskPauseScreen`)
- Test: `e2e/tests/phone-player.mobile.spec.ts` (append), `e2e/tests/cast-remote.mobile.spec.ts` (append)

**Interfaces:**
- Consumes: `deskPauseDue`, `DESK_PAUSE_MS` (`#lib/player/desk/logic`); `phoneUi`, `orient`, `phoneSub` (Tasks 1–2); `stagger` and `motionLevel` (`#lib/tv/motion`); `Logo`.
- Produces: `PhonePauseScreen` props `{ title: string; sub: string; overview: string; orient: PhoneOrient }` (no events); Player `$: phonePause`; stage `class:ppause={phonePause}`.

Behaviour:
- Rename `deskBlocked` to `pauseBlocked` (same terms: menu, scrubbing, party, remote/casting, error, reconnecting, locked, help, subtitle dialog, cast & info, peek, credits). `$: phonePause = phoneUi && paused && started && deskPauseDue({ pausedAt, lastActive, now: tick, blocked: pauseBlocked })`; `showUi` gains `&& !phonePause`; the bar's "stay while paused" holds until then.
- The picture: `.stage.ppause > video { transform: scale(1.03) }` (transition 500 ms, none without motion); the dimming is the pause screen's own black layer at `opacity: .62` (equals brightness .38 without animating `filter`, and without fighting the brightness gesture's inline `filter`).
- `PhonePauseScreen`: `.pps` (`data-testid="phone-pause-screen"`, `pointer-events: none`) with `.dim` layer; start-side column inside the safe area (`left: calc(var(--safe-left) + 16px)`, portrait `bottom` above the home indicator, landscape vertically centred, max 58 % wide): `player.pause.watching`, title, sub (`phoneSub(item, $t)`), overview clamped to 3 lines (portrait) / 4 (landscape); end-side bottom: `Logo` + `player.pause.paused` (`right: calc(var(--safe-right) + 16px)`, `bottom: calc(var(--safe-bottom) + 12px)`). Parts `stagger` 40 ms when `motionLevel() === 'full'`; fade out 200 ms. No Cast & info button.
- A tap ends it (today's `handleTap` → `toggleControls` → `wake()`); the left pill's play button resumes.
- The automatic cast & info panel after a pause is off on phones: `showXray`'s `pausedLong` term gains `&& !phoneUi` (kids phones keep it).

- [ ] **Step 1: Append e2e tests** (`page.clock.install()` before opening):
  - `after 5 s paused the pause screen shows; a tap brings the controls back` (portrait and `LAND_R`) — pause, `runFor(5200)` → `.pps` visible with 'Du siehst gerade', the title and 'Pausiert'; `.ctl.hide`; `.pps .ov` inside the safe area; portrait `-webkit-line-clamp` `'3'`, landscape `'4'`; `.pps` has no button; tap → `.pps` count 0, `.ctl` not `hide`; 'Abspielen' in `.pill.lp` → video playing.
  - `not before 5 s, and not while a panel is open` — pause, `runFor(4800)` → count 0; open 'Audio und Untertitel', `runFor(8000)` → count 0.
  - `not while locked` — lock via the top bar, `video.pause()` by `evaluate`, `runFor(8000)` → count 0.
  - `no automatic Cast & info panel on phones` — pause, `runFor(8000)` → complementary 'Besetzung & Infos' count 0.
  - `kids on a phone: no pause screen` — `KID` setup, pause, `runFor(8000)` → `.pps` count 0.
- [ ] **Step 2: Append to `cast-remote.mobile.spec.ts`:** `no pause screen while casting` — `page.clock.install()` before `chromecastRemote(page)`, pause through the remote's play/pause button, `runFor(8000)` → `.pps` count 0.
- [ ] **Step 3: Implement** component and Player wiring.
- [ ] **Step 4: Verify** root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(phone-player): pause screen`.

---

### Task 5: Credits sequence on phones

**Files:**
- Modify: `web/src/routes/watch/[id]/+page.svelte` (`csOn` l.55, `bind:orient`, `.next.pp.aside` phone CSS)
- Modify: `web/src/lib/player/CreditsSequence.svelte` (prop `phone`, phone CSS)
- Modify: `web/src/lib/Player.svelte` (`credMotion`, `gUp` corner tap, `.cred` phone CSS)
- Test: `e2e/tests/phone-credits.mobile.spec.ts` (new); check `postplay.mobile.spec.ts`, `player-back.mobile.spec.ts`, `player-hit.mobile.spec.ts` stay valid (they already accept `.cs .chip`)

**Interfaces:**
- Consumes: `creditsOn`, `phonePlayer`, `PhoneOrient` (Task 1); Player `orient` (bindable, Task 2); `creditsBeat`, `CHIP_MS`, `creditPicks` (desk logic); `e2e/mocks/credits.ts` (`openEpisode`, `openMovie`, `toChip`, `seekPlaying`, `CREDITS_AT`, `NEXT`, `EP_NEXT`); `e2e/mocks/phone.ts` (Task 2).
- Produces: `CreditsSequence` prop `phone: 'off' | PhoneOrient = 'off'` (classes `.ph-land` / `.ph-port`).

Behaviour:
- Page: `$: csOn = creditsOn({ kids: $kidsMode, tv: tvUi, desk: deskPlayer({ desk: $deskActive, tv: tvUi, phone: coarse && !tvUi }), phone: phonePlayer({ coarse, tv: tvUi, kids: $kidsMode }) })`; `let orient: PhoneOrient = 'landscape'` with `bind:orient` on the Player; `<CreditsSequence phone={csOn && phonePlayer(…) ? orient : 'off'} …>`. Party, casting and "still watching?" stay blocked as today. Kids phones keep the `.next` card.
- Player: `credMotion = (desk || tvUi || phoneUi) && motionAllowed()` (the tripped-guard crossfade CSS already keys on `.cmo`); in `gUp`, before `handleTap`: `if (credits === 'corner') { if (e.target === video) dispatch('credits'); return; }` (touch never reaches `onSurfaceClick`'s check).
- Picture in the corner (top-start, inside the safe area, light edge kept):
  - landscape: `.stage.pui.cred > video { transform: translate(calc(-29% + var(--safe-left)), -26%) scale(.42) }` (tune so the element's box starts ≥ `safe-left + 12px` and ≥ 12 px from the top);
  - portrait: `.stage.pui.port.cred > video { transform: translateY(calc(-50% + 28.125vw + var(--safe-top) + 12px)) scale(.92) }` (the letterboxed 16:9 picture rises to just below the status bar).
- `CreditsSequence` on phones: chip (beat 1) at the end-side bottom above the home indicator (`right: calc(var(--safe-right) + 16px)`, `bottom: calc(var(--safe-bottom) + 16px)`); corner beat — landscape: `.up` and `.sugg` in the end-side column right of the picture (`left: calc(var(--safe-left) + 44vw)`, `right: calc(var(--safe-right) + 16px)`, scrolls if short); portrait: below the small picture (`top: calc(var(--safe-top) + 56.25vw * .92 + 28px)`, sides safe + 16 px), suggestions as a horizontal row; the `.wc` pill over the picture's top-start corner; every button ≥ 44 px.
- Back out: "Watch credits", a tap on the small picture, Esc (today's Player branch) reverse the glide (spring, or the crossfade when the guard tripped). The browser / Android Back is not intercepted during credits (see resolved ambiguities).
- Page CSS: on phones during the sequence the post-play card (`.next.pp.aside`) sits at the start-side bottom (`left: calc(var(--safe-left) + 16px); bottom: calc(var(--safe-bottom) + 16px); top: auto`), full width minus insets in portrait.

- [ ] **Step 1: Write `phone-credits.mobile.spec.ts`** (`test.beforeEach` `sessionStorage.setItem('ff-intro-seen', '1')` by `addInitScript`, as `desk-credits.spec.ts` does; `openEpisode` installs the clock; `toChip` freezes it; describes for `LAND_L` 844×390 and `PORTRAIT` 390×844 with `forceSafeArea`):
  - `chip, then the picture glides into the corner, then up next with the countdown` — `.cs .chip` with 'Abspann ansehen' and 'Nächste Folge', both inside the safe area; `.stage.cred` count 0; `runFor(2100)` → `.stage.cred`; video box: landscape `x ≥ 59`, `y ≥ 0`, right edge < 50 % width; portrait `y ≥ 59`, height < 50 % of the viewport; `.cs .up` visible with `NEXT.name` and 'Als Nächstes', `.cs .ring` count 1; landscape `.up` box x ≥ video right edge; portrait `.up` top ≥ video bottom; every `.cs` button inside the viewport minus insets and ≥ 44 px tall; `.next` count 0.
  - `the countdown plays the next episode` — `runFor(2100)`, `runFor(10_500)`, `clock.resume()` → URL `/watch/<NEXT.id>`.
  - `a tap on the small picture backs out; the sequence does not return` — tap the video's centre → `.stage.cred` count 0, `.cs .up` count 0; `runFor(5000)` → still 0.
  - `Watch credits backs out to full screen` — tap 'Abspann ansehen' in the corner beat → `.stage.cred` count 0.
  - `rotating in the corner keeps the picture in the corner` — portrait corner beat → `setViewportSize(844×390)` + `setSafeArea(LAND_L)` → `.stage.cred` still 1, landscape box checks hold.
  - `a film shows suggestions without a countdown` — `openMovie`, `seekPlaying(CREDITS_AT + 5, true)`, chip 'Mehr davon' → tap → `.cs .up` has the post-play headline, `.cs .ring` count 0.
  - `kids on a phone keep the next-episode card` — `KID` setup, `openEpisode`, `toChip`-like seek → `.next` visible, `.cs .chip` count 0.
- [ ] **Step 2: Implement** page gate and binding, CreditsSequence prop and CSS, Player changes.
- [ ] **Step 3: Check** `postplay.mobile.spec.ts` (card inside the viewport during the sequence), `player-back.mobile.spec.ts`, `player-hit.mobile.spec.ts` against the new phone path; fix only selectors or comments that name "phones keep the card" (`e2e/mocks/hit.ts`, `e2e/mocks/back.ts` comments), never the assertions.
- [ ] **Step 4: Verify** root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(phone-player): credits sequence on phones`.

---

### Task 6: Docs and changelog

**Files:**
- Modify: `CHANGELOG.md` (Unreleased → `### Phone`: append the player lines after the browse lines)
- Modify: `README.md`, `README.de.md` ("A player made for binge nights" / its German counterpart: one phone paragraph after the desktop one; "Phone and TV" / "Handy und TV" intro sentence mentions the cinema player; README line 126 "on desktop and TV the credits sequence" → "on desktop, phones and TV")

- [ ] **Step 1: Write** `### Phone` entries in the existing style: **Cinema player** (title bottom left with the chapter, both times on the timeline, play and ±10 s in one glass pill, tools in the other; landscape either way round and portrait, nothing overlaps); **Glass top bar** (back, quality, Cast/AirPlay, lock); **Panels above the timeline** (grow out of their button; tap outside, the button or Back closes); **Pause screen** (after 5 s, *You're watching*); **Credits sequence** (as on desktop, with the picture in the corner in landscape and at the top in portrait). Mention calm mode / reduced motion switch at once. No screenshots of real titles.
- [ ] **Step 2: Commit** `docs: phone player redesign`.

---

## Resolved ambiguities

- Kids on a phone keep today's phone player (`.stage.phone`), as "not the kids UI" and "kids players render exactly as today" require.
- Cast & info, AirPlay, mute and fullscreen leave the pills on phones: Cast & info, mute and fullscreen live in More, Cast/AirPlay and lock in the top bar; the cast peek is no longer reachable on phones (More opens the full panel).
- Pause dimming is a black layer at opacity .62 instead of `filter: brightness(.38)`: same look, only `opacity` animates, and the brightness gesture's inline filter stays untouched.
- Browser / Android Back closes panels (one shallow history entry, opened by a tap); during the credits sequence Back is not intercepted because Chrome skips history entries created without a user gesture — the sequence backs out through "Watch credits", a tap on the small picture or Esc.
- The skip button stays visible while the dock is hidden (today's behaviour), inside the title row.
- The film line is year · length from `year` and `runtimeTicks`; the episode line uses a new `player.phone.episodeLine` key with each locale's episode letter.
