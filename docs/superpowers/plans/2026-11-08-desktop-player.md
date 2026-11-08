# Desktop Player Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop player gets the cinema-split bar with glass pills, panels that grow out of their buttons, a pause screen, a credits sequence (desktop and TV) and a verified detail↔player morph.

**Architecture:** Pure logic (desk-player flag, pause-screen timing, credits beats) lives in tested TypeScript under `web/src/lib/player/desk/`. `Player.svelte` keeps owning playback and its menus; on desktop its bar markup gets a `desk` layout (title block, timeline row, two pills) instead of a rewrite, and new visual parts are their own components. The credits sequence is a component the watch page renders instead of today's `.next` card on desktop and TV; it tells the Player to shrink its picture through a `credits` prop.

**Tech Stack:** SvelteKit (Svelte 4 syntax, `$:`), TypeScript, vitest, Playwright, the motion system in `web/src/lib/tv/motion.ts`.

**Spec:** `docs/superpowers/specs/2026-11-08-desktop-player-design.md`

## Global Constraints

- Desktop player only where `$deskActive && !tvUi && !phone` (`deskActive` from `web/src/lib/desk/bar.ts`); phone, kids and TV bars render exactly as today. On TV only the credits sequence changes.
- Own look: coral `#ff4f6d`, Inter, FriendFlix logo. Never another streaming service's name in user-facing text.
- No backend change. Keep `creditsStart`, `nextKind`, `cardVisible`, `COUNTDOWN_SECONDS` (10), post-play data and every player feature (tracks, speed, quality, sleep timer, bookmarks, scenes, cast & info, PiP, AirPlay, Chromecast, party, errors, ABR, telemetry).
- Animate only `transform` and `opacity`; reduced motion and calm mode (`motionAllowed()` false) switch instantly; blur only when `motionLevel() === 'full'`; on TV a tripped frame guard (`html.tv-motion-reduced`) turns glides into crossfades.
- All current shortcuts in `web/src/lib/player/keymap.ts` keep working; every control reachable with Tab with a visible focus ring.
- Every new string in all seven locales (en, de, pl, es, fr, it, tr); `de` is the type source.
- Owner rule: write the tests, run only the root `npm run typecheck` locally; CI runs vitest and Playwright.
- Placeholder hosts only (friend.example.com, 192.0.2.x); no model identifiers in commits.

## Review Focus

1. Seeking while the credits sequence is in beat 2/3 (user drags back before `creditsAt`): the sequence must back out to full screen, not stay shrunk — test in Task 4.
2. A paused desktop player with an open panel or during scrubbing must not show the pause screen — test in Task 3.
3. Watch party guests and casting: no pause screen, no credits sequence, bar unchanged — tests in Tasks 3 and 4.
4. Window narrower than the desk layout (1024–1100 px): the two pills must not overlap; the tools pill may wrap labels away but stays one row — CSS check in Task 2's e2e (`noHorizontalOverflow`).
5. Keyboard-only use: Tab reaches both pills and panels; Esc closes a panel and returns focus to its button — test in Task 2.

---

### Task 1: Pure helpers (desk flag, pause timing, credits beats)

**Files:**
- Create: `web/src/lib/player/desk/logic.ts`
- Test: `web/src/lib/player/desk/logic.test.ts`

**Interfaces:**
- Produces:
  - `deskPlayer(o: { desk: boolean; tv: boolean; phone: boolean }): boolean` — `o.desk && !o.tv && !o.phone`.
  - `DESK_PAUSE_MS = 5000`
  - `deskPauseDue(o: { pausedAt: number; lastActive: number; now: number; blocked: boolean }): boolean` — false when `blocked` (menu open, scrubbing, party guest, casting, error, reconnecting, locked); else `now - max(pausedAt, lastActive) >= DESK_PAUSE_MS`. Calm mode still shows the screen, only without motion, so it is not an input.
  - `CHIP_MS = 2000`
  - `type CreditsBeat = 'off' | 'chip' | 'corner'`
  - `creditsBeat(o: { current: number; start: number; enteredAt: number | null; now: number; dismissed: boolean; kind: 'episode' | 'movie' | 'none'; blocked: boolean }): CreditsBeat` — `'off'` when `blocked` (party guest, casting/remote), `dismissed`, `kind === 'none'`, `!Number.isFinite(start)` or `current < start`; `'chip'` while `enteredAt === null || now - enteredAt < CHIP_MS`; else `'corner'`.

- [ ] **Step 1: Write the failing tests** in `logic.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CHIP_MS, DESK_PAUSE_MS, creditsBeat, deskPauseDue, deskPlayer } from './logic';

describe('deskPlayer', () => {
  it('only desktop, never TV or phone', () => {
    expect(deskPlayer({ desk: true, tv: false, phone: false })).toBe(true);
    expect(deskPlayer({ desk: true, tv: true, phone: false })).toBe(false);
    expect(deskPlayer({ desk: true, tv: false, phone: true })).toBe(false);
    expect(deskPlayer({ desk: false, tv: false, phone: false })).toBe(false);
  });
});
describe('deskPauseDue', () => {
  const base = { pausedAt: 1000, lastActive: 0, blocked: false };
  it('after 5 s since pause or the last activity, whichever is later', () => {
    expect(DESK_PAUSE_MS).toBe(5000);
    expect(deskPauseDue({ ...base, now: 5999 })).toBe(false);
    expect(deskPauseDue({ ...base, now: 6000 })).toBe(true);
    expect(deskPauseDue({ ...base, lastActive: 4000, now: 8999 })).toBe(false);
    expect(deskPauseDue({ ...base, lastActive: 4000, now: 9000 })).toBe(true);
  });
  it('never while blocked (menu, scrubbing, party, casting, error)', () => {
    expect(deskPauseDue({ ...base, now: 60_000, blocked: true })).toBe(false);
  });
});
describe('creditsBeat', () => {
  const base = { current: 100, start: 90, enteredAt: 1000, now: 1000, dismissed: false, kind: 'episode' as const, blocked: false };
  it('chip for the first 2 s after the credits start, then corner', () => {
    expect(CHIP_MS).toBe(2000);
    expect(creditsBeat(base)).toBe('chip');
    expect(creditsBeat({ ...base, now: 2999 })).toBe('chip');
    expect(creditsBeat({ ...base, now: 3000 })).toBe('corner');
    expect(creditsBeat({ ...base, enteredAt: null })).toBe('chip');
  });
  it('off before the credits, after Watch credits, without a next kind, while blocked, with an unknown start', () => {
    expect(creditsBeat({ ...base, current: 89 })).toBe('off');
    expect(creditsBeat({ ...base, dismissed: true })).toBe('off');
    expect(creditsBeat({ ...base, kind: 'none' })).toBe('off');
    expect(creditsBeat({ ...base, blocked: true })).toBe('off');
    expect(creditsBeat({ ...base, start: Infinity })).toBe('off');
  });
  it('a film reaches the corner too (suggestions instead of a countdown)', () => {
    expect(creditsBeat({ ...base, kind: 'movie', now: 4000 })).toBe('corner');
  });
});
```

- [ ] **Step 2: Implement** the three functions and constants in `logic.ts` (SPDX header like the neighbours).
- [ ] **Step 3: Verify** `npm run typecheck` (root) passes.
- [ ] **Step 4: Commit** `feat(player): desk player flag, pause-screen timing and credits beats`.

---

### Task 2: Desktop bar layout (title block, timeline row, two glass pills, labels, panel cards)

**Files:**
- Modify: `web/src/lib/Player.svelte` (desk flag, markup 1446–1585 and styles)
- Create: `web/src/lib/player/desk/grow.ts` (Svelte transition)
- Modify: `web/src/lib/i18n/locales/{en,de,pl,es,fr,it,tr}/player.ts` (new keys below)
- Test: `e2e/tests/desk-player.spec.ts` (new; desktop project)

**Interfaces:**
- Consumes: `deskPlayer` from Task 1; `deskActive` from `#lib/desk/bar`; `motionLevel`, `motionAllowed` (`#lib/preview`).
- Produces (later tasks rely on these): in `Player.svelte` `$: desk = deskPlayer({ desk: $deskActive, tv: tvUi, phone })`; stage gets `class:desk`; `$: nowChapter = chapterAt(shown)` (label or `''`); `grow(node, { origin: string })` transition in `grow.ts` returning `{ duration, css }` — scale 0.6→1 from `origin` with the `--m-spring`-like overshoot curve over 300 ms (opacity 0→1 in the first 120 ms); duration 0 when `!motionAllowed()`.

Layout when `desk` (else today's markup unchanged):
- Title block above the timeline, left aligned: `nowChapter` as coral uppercase eyebrow (only when chapters exist), title `barTitle || title` (2.1em/800), `barSub` below. `.mid` is not rendered in desk.
- Timeline row: elapsed `fmtClock(shown)` left, track, remaining `−fmtClock(duration - shown)` right (tabular figures). Track grows 3 px → 6 px on hover/scrub via `transform: scaleY(2)` on a wrapper; the existing `.tip` stays.
- Row: left `.pill` (play/pause, back10, forward10, volume with `.vslider` revealed by transform on hover/focus-within, clock moved out — the times live on the timeline row), right `.pill` with today's right group in today's order. Every `button.ic` in the pills gets `data-label={its aria-label}` and a CSS label chip (`::after`, white, rises 4 px, opacity 150 ms) on `:hover` and `:focus-visible`.
- Pills: `background: rgba(20,20,24,.62)`, `border: 1px solid rgba(255,255,255,.12)`, `border-radius: 99px`, `backdrop-filter: blur(16px)` only when `motionLevel()==='full'` (class `blur` from a `$:` on `$motionTripped`).
- Menus (`.menu` popovers) in desk: glass card (same fill, radius 14px, blur rule as pills), `in:grow={{ origin: 'bottom right' }}` (episodes, chapters, tracks, speed, more; `more`'s sub-views swap with `in:fade={{ duration: 200 }} out:fade={{ duration: 120 }}`).
- Skip button in desk: above the right pill (`bottom` = bar height + 12px), rising in with `fly={{ y: 12, duration: 250 }}` (duration 0 when `!motionAllowed()`).

New i18n key (all 7 locales): `player.controls.remaining: '−{time}'` (aria label for the remaining time: en "{time} remaining" — **value**: en `'{time} remaining'`, de `'noch {time}'`, pl `'pozostało {time}'`, es `'quedan {time}'`, fr `'reste {time}'`, it `'mancano {time}'`, tr `'{time} kaldı'`).

- [ ] **Step 1: Write the e2e spec** `desk-player.spec.ts` (German UI like the other player specs; open `/watch/<id>` the way `player-controls.spec.ts` does). Tests:
  - `desktop bar: title block, both pills, times on the timeline row` — `.stage.desk` visible; `.stage.desk .ttlblock` contains the title; `.stage.desk .pill` count 2; `.stage.desk .tlrow .el` and `.tlrow .rem` visible; `.ctl .mid` count 0; `noHorizontalOverflow(page)` true at 1024×700 and at 1440×900.
  - `a label rises above a tool on hover` — hover `getByRole('button', { name: 'Mehr', exact: true })`; its computed `::after` opacity becomes `1` (poll `getComputedStyle(el, '::after').opacity`).
  - `the bar fades after 3 s idle and returns on movement` — `page.clock.install()`, play, `runFor(3500)` → `.ctl` has class `hide`; `mouse.move` → not `hide`.
  - `a panel opens from its button; Esc closes it and focus returns` — click 'Audio und Untertitel' → `.menu.tracks` visible; `Escape` → hidden; that button focused.
  - `Tab reaches both pills` — focus play button, press Tab until the fullscreen button ('Vollbild') is focused within 20 presses.
  - `phone and TV keep their bars` — mobile project untouched (no change to `player-controls.mobile.spec.ts`); in this spec with `html.tv` set (as `tv-layout.spec.ts` sets it) `.stage.desk` count 0.
- [ ] **Step 2: Implement** the flag, `nowChapter`, markup and styles in `Player.svelte`, `grow.ts`, and the i18n key.
- [ ] **Step 3: Update existing desktop e2e selectors only where the desk layout moved them** (`.ctl .row .ic` still exists inside the pills; `.clock` moved — adjust `player-controls.spec.ts` assertions that read `.clock` to `.tlrow .el`). Do not weaken assertions.
- [ ] **Step 4: Verify** root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(player): desktop bar with title block and glass pills`.

---

### Task 3: Desktop pause screen

**Files:**
- Create: `web/src/lib/player/desk/DeskPauseScreen.svelte`
- Modify: `web/src/lib/Player.svelte` (pause state, auto cast & info off on desk)
- Modify: i18n `player.ts` ×7
- Test: `e2e/tests/desk-player.spec.ts` (append)

**Interfaces:**
- Consumes: `deskPauseDue`, `DESK_PAUSE_MS` (Task 1); `desk`, stage classes (Task 2); `stagger` from `#lib/tv/motion`; `openCastInfo(focus: boolean)` in Player.
- Produces: `DeskPauseScreen` props `{ title: string; sub: string; overview: string }`, event `castinfo`; Player `$: deskPause` boolean; stage `class:dpause`.

Behaviour:
- `deskPause = desk && paused && started && deskPauseDue({ pausedAt, lastActive, now: tick, blocked })` with `blocked = menu !== '' || scrubbing || partyMode && !canControl || remote || Boolean(error) || reconnecting > 0 || locked || help || subDlg`. Track `pausedAt` (set when `paused` turns true).
- When `deskPause`: `showUi` false (extend line 192's condition), stage `.dpause` darkens the video (`filter: brightness(.35)`) and scales it to 1.03 (transition 500 ms; none when `!motionAllowed()`).
- `DeskPauseScreen`: left column — eyebrow `$t('player.pause.watching')`, title, sub, overview clamped to 4 lines, a secondary button `$t('player.pause.castInfo')` dispatching `castinfo`; bottom right logo + `$t('player.pause.paused')`. On mount `stagger(parts)` (40 ms gap) when `motionLevel()==='full'`; fades out in 200 ms.
- Any pointer move or key (existing `wake()`) ends it; Space resumes (existing toggle).
- In desk the automatic cast & info panel (`pausedLong` path at line 804) is off: add `!desk` to that condition. The `castinfo` event calls `openCastInfo(true)`.

New i18n keys (7 locales): `player.pause.watching` (en "You're watching", de "Du siehst gerade", pl "Oglądasz", es "Estás viendo", fr "Vous regardez", it "Stai guardando", tr "Şu an izliyorsun"), `player.pause.paused` (en "Paused", de "Pausiert", pl "Wstrzymano", es "En pausa", fr "En pause", it "In pausa", tr "Duraklatıldı"), `player.pause.castInfo` (en "Cast & info", de "Besetzung & Infos", pl "Obsada i informacje", es "Reparto e información", fr "Distribution et infos", it "Cast e info", tr "Oyuncular ve bilgi").

- [ ] **Step 1: Append e2e tests**:
  - `after 5 s paused the pause screen shows; movement brings the bar back` — clock installed, pause, `runFor(5200)` → `.dps` visible with title text and 'Du siehst gerade'; `.ctl` has `hide`; `mouse.move` → `.dps` count 0.
  - `no pause screen while a panel is open` — pause, open 'Audio und Untertitel', `runFor(8000)` → `.dps` count 0.
  - `no automatic cast & info panel on desktop` — pause, `runFor(8000)` → complementary 'Besetzung & Infos' count 0; the pause screen's 'Besetzung & Infos' button opens it.
  - `Space resumes from the pause screen` — `.dps` visible, `keyboard.press(' ')` → video not paused (read via `evaluate`).
- [ ] **Step 2: Implement** component, Player wiring and i18n.
- [ ] **Step 3: Check existing specs** that rely on the automatic cast & info panel on desktop (`player-scenes.spec.ts`, search for 'Besetzung auf einen Blick'): switch those to open it through the button; do not drop their assertions.
- [ ] **Step 4: Verify** root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(player): desktop pause screen`.

---

### Task 4: Credits sequence (desktop and TV)

**Files:**
- Create: `web/src/lib/player/CreditsSequence.svelte`
- Modify: `web/src/routes/watch/[id]/+page.svelte` (render it instead of the `.next` card and the movie `.next.more` card on desk and TV; phone keeps today's cards)
- Modify: `web/src/lib/Player.svelte` (prop `credits: 'off' | 'chip' | 'corner' = 'off'`, stage classes)
- Modify: i18n `player.ts` ×7
- Test: `e2e/tests/desk-credits.spec.ts` (new), `e2e/tests/tv-credits.spec.ts` (new)

**Interfaces:**
- Consumes: `creditsBeat`, `CHIP_MS` (Task 1); `nextKind`, `COUNTDOWN_SECONDS`, `secondsLeft`, `ringOffset`, `advanceCountdown`, `mayAutoplay` (`lib/player/nextup.ts`); post-play data `ppData` and `loadPostplay` in the page; `desk` and `tvUi` (page reads `$deskActive` and `html.tv` the same way the Player does).
- Produces: `CreditsSequence` props `{ beat: CreditsBeat; kind: 'episode' | 'movie'; next: Item | null; rows: PostplayRow[] | null; headline: string; seconds: number; total: number; tv: boolean }`, events `play` (next episode), `credits` (watch credits / back out), `pick` (detail: `{ item: Item }`).

Behaviour:
- Page: `enteredAt` = timestamp when `curTime` first reaches `creditsAt` (reset when it drops below); `beat = creditsBeat({ current: curTime, start: creditsAt, enteredAt, now, dismissed, kind, blocked: remote || partyGuest })`; a 250 ms ticker updates `now` only while `curTime >= creditsAt`. Seeking below `creditsAt` resets `enteredAt` (→ `'off'`, picture grows back).
- Countdown (episode only) starts when the beat becomes `'corner'` (existing `startCountdown`), plays the next episode when done (existing `toEpisode`), stops on `credits`.
- `credits` event = today's `watchCredits()` (sets `dismissed`). Esc, a click on the shrunk picture (Player dispatches `credits` on a stage click while `credits === 'corner'`) and TV Back (existing back handling: when `beat !== 'off'`, Back dispatches `credits` instead of leaving) do the same.
- Player prop `credits`: `'corner'` → stage `.cred` moves the video wrapper with `transform: translate(-27%, -24%) scale(.42)` and `border-radius: 14px` + shadow, transition `transform 750ms var(--m-spring)`; `'chip'`/`'off'` → full screen. On TV with `html.tv-motion-reduced`, or with `!motionAllowed()`: no transform transition; the picture fades (opacity 0→1, 300 ms) into the corner position. While `credits !== 'off'` the bar is hidden in `'corner'` only.
- `CreditsSequence`:
  - `'chip'`: bottom-right two buttons — `$t('player.watch.watchCredits')` (secondary) and next (`kind==='episode'`: `$t('player.watch.next')` with a fill bar animating over `CHIP_MS`; `movie`: `$t('player.watch.more')`). Rise in with `fly y:16`.
  - `'corner'`: right column — episode: small caption `$t('player.credits.upNext')`, next title (`S·E · name`), overview (2 lines), Play button with an SVG ring (`ringOffset(seconds,total)`) and `$t('player.watch.inSeconds', { s: seconds })`; movie / last episode: `headline` (from `postplay.head.*` as the PostPlay screen picks it) instead, no countdown. Below: `$t('player.watch.more')` and the first post-play row's first five items as cards (`pick` on click). Parts stagger in (`stagger`, 40 ms) after the picture's glide (delay 250 ms); a small `$t('player.watch.watchCredits')` pill top left over the picture.
  - TV: buttons are `data-nav` focusable; on entering `'corner'` focus the Play button (or the first suggestion for a film) once; OK on Play → `play`.
- Phone: unchanged (`.next` cards stay for `!desk && !tvUi`).

New i18n key (7 locales): `player.credits.upNext` (en "Up next", de "Als Nächstes", pl "Następnie", es "A continuación", fr "À suivre", it "Prossimo", tr "Sıradaki").

- [ ] **Step 1: Write `desk-credits.spec.ts`** (episode with a next episode and an outro segment mocked the way `postplay.spec.ts` mocks playback and post-play; clock installed):
  - `credits: chip, then the picture glides into the corner, then up next with the countdown` — seek to `creditsAt`; `.cs .chip` visible with 'Abspann ansehen' and 'Nächste Folge'; `runFor(2100)` → `.stage.cred` present, `.cs .up` visible with the next episode title and five `.cs .sugg a`.
  - `the countdown plays the next episode` — after `'corner'`, `runFor(10_500)` → URL is `/watch/<nextId>`.
  - `Watch credits backs out to full screen and the sequence does not return` — click 'Abspann ansehen' → `.stage.cred` count 0, `.cs` count 0; `runFor(5000)` → still 0.
  - `seeking back before the credits backs out` — in `'corner'`, set `video.currentTime` to `creditsAt - 30` via the timeline (press `Home` on the slider then seek) → `.stage.cred` count 0.
  - `a film shows suggestions without a countdown` — movie item: `'corner'` → `.cs .up` has the post-play headline, no `.cs .ring`.
  - `watch party guest: no credits sequence` — party mode as `player-controls.spec.ts` sets it → `.cs` count 0 at `creditsAt + 5`.
- [ ] **Step 2: Write `tv-credits.spec.ts`** (`html.tv` set as `tv-layout.spec.ts` does): `OK on the focused Play plays the next episode`; `Back shows the credits instead of leaving` (`.stage.cred` count 0, still on `/watch/<id>`); `a tripped frame guard crossfades` (add `tv-motion-reduced` to `html` before seeking; `.stage.cred` reached, its computed `transition-property` on the video wrapper does not include `transform`).
- [ ] **Step 3: Implement** component, page wiring, Player prop and i18n; remove the desk/TV branches of the old `.next` card (keep phone).
- [ ] **Step 4: Verify** root `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(player): credits sequence on desktop and TV`.

---

### Task 5: Start and exit morph

**Files:**
- Modify (only if the checks below show a gap): `web/src/routes/+layout.svelte` (watch transition, lines ~340–356), `web/src/lib/player/transition.ts`, `web/src/lib/Player.svelte`
- Test: `e2e/tests/player-transition.spec.ts` (append desktop cases)

**Interfaces:**
- Consumes: existing `playTransition()`, `markPlayArt`/`takePlayArt`, `PLAY_ART_NAME`, `DetailDesk.svelte` `img.bg[data-play-art]` and `<a class="play">`; Task 2's `desk` stage class.

Behaviour to guarantee:
- From the desk detail page, Play names `img.bg[data-play-art]` as `ff-play-art` and the player's `.ff-poster` takes the name (existing); the bar and title block stay hidden until `posterOut` (existing `class:hide` rule) and then fade in (opacity 250 ms).
- Back from `/watch/<id>` to `/item/<id>` on desktop morphs the poster/video frame back into `DetailDesk`'s `[data-vt-art]` backdrop and the detail entry stagger (`[data-st]`) plays.
- Deep link / reload of `/watch/<id>`: no `ff-vt-play` class, poster shown as today.

- [ ] **Step 1: Append tests** to `player-transition.spec.ts` (desktop, `reducedMotion: 'no-preference'`, `sessionStorage` `ff-intro-seen` set): `desk detail Play morphs into the player` (record `html` classes during navigation as the existing tests do; expect `ff-vt-play`); `Back from the player morphs into the desk detail backdrop` (expect the back class the layout sets and `main .dd [data-vt-art]` visible afterwards); `a reload of /watch shows the poster without a morph`.
- [ ] **Step 2: Fix** what the tests show missing (most likely the back direction naming `main .dd [data-vt-art]`); otherwise only the bar fade-in.
- [ ] **Step 3: Verify** root `npm run typecheck`.
- [ ] **Step 4: Commit** `feat(player): detail-player morph on desktop, both directions`.

---

### Task 6: Docs and changelog

**Files:**
- Modify: `CHANGELOG.md` (Unreleased → `### Desktop`: bar, panels, pause screen, credits sequence, start/exit; and a `### TV` line for the credits sequence)
- Modify: `README.md`, `README.de.md` (player section: the new desktop bar, pause screen and credits sequence; no screenshots of real titles)

- [ ] **Step 1: Write** the entries in the existing style of the block 1 entries.
- [ ] **Step 2: Commit** `docs: desktop player redesign`.
