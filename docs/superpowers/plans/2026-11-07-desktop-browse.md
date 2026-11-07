# Desktop Browse Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the desktop web UI a pill top bar, a trailer billboard, paged rows, a wide hover preview and a full-page cinematic detail with view-transition motion, without touching phone, TV, kids or admin.

**Architecture:** New desktop components live in `web/src/lib/desk/` (like `lib/tv/`), with pure helpers unit-tested next to them. `+layout.svelte` and `routes/+page.svelte` swap the old desktop header/hero for the new components only when `!tv && !$mobile && !kidsUi`. Motion reuses `#lib/tv/motion` (springs, `glideRow`, `stagger`, `VT_ART`, `motionLevel`, `frameGuard`); a `deskPagePlan` mirrors `tvPagePlan` for the card→detail morph.

**Tech Stack:** SvelteKit (Svelte 4 syntax as in the repo), TypeScript, vitest, Playwright (e2e/, desktop project).

**Spec:** `docs/superpowers/specs/2026-11-07-desktop-browse-design.md`

## Global Constraints

- Desktop only: not `html.tv`, not `$mobile`, not kids UI, not admin. Phone, TV, kids, admin render exactly as today.
- Own look: coral `#ff4f6d`, `Logo.svelte`, Inter. Never another streaming service's name in user-facing text; no N marks, no red-on-black.
- Recommendation engine stays in charge: billboard title, row order, reco tags, `ReasonCaption`, match score from today's data. No backend change.
- Animate only `transform` and `opacity`. Respect `prefers-reduced-motion`, calm mode (`calmMode()`), `motionLevel()`/`frameGuard()`. `backdrop-filter` only when `motionLevel() === 'full'`.
- Trailers follow existing preview rules (`hoverTrailers` pref, `autoplayAllowed()`, Save-Data, hidden tab, `previewOwner`/`stopPreview`).
- Keyboard: every control reachable with Tab, visible focus ring, Esc closes search, menus and the hover preview.
- i18n: every new string in all seven locales (en, de, pl, es, fr, it, tr) under `desk.*` keys.
- Desktop ≥ 1024 px; hover preview off below 1100 px and for coarse pointers.
- Type check is `cd web && npm run typecheck`; unit tests `cd web && npx vitest run`; coverage thresholds statements 94 / branches 89 must hold; e2e `npx playwright test -c e2e/playwright.config.ts --project=desktop`.
- Placeholder hosts only (friend.example.com, 192.0.2.x). Fictional titles in tests and screenshots.

## Rulings (plan vs spec)

- P1: The spec's `DeskHome.svelte` is not created; `routes/+page.svelte` keeps its row composition and swaps `Hero` for `DeskBillboard` on desktop. Same visible result, no duplicated data loading.
- P2: Search keeps today's live behaviour (typing drives `/search?q=` with `replace`), restyled as the expanding pill field; no separate results panel. Today's search page already shows live results.

## Review Focus

1. Hover preview on the last card of a row or a row near the viewport bottom must stay fully inside the viewport (opens to the free side / upwards). → Task 1 `wideBox` tests + Task 5 e2e.
2. Window shrinks below 1100 px (or pointer turns coarse) while a preview is open: it closes, no stuck dimmed row. → Task 5 e2e.
3. Title without backdrop, logo or trailer (billboard and detail): falls back to name text and the poster/colour backdrop, no broken image, no empty eyebrow. → Task 3 and Task 6 e2e.
4. Deep link / reload of `/item/[id]`, then "‹ Back": with no in-app history it goes to `/`, without a morph. → Task 7 e2e.
5. A movie (no episodes, no extras): only tabs with content render; the first available tab is selected. → Task 1 `detailTabs` tests + Task 6 e2e.

---

### Task 1: Pure desktop helpers

**Files:**
- Create: `web/src/lib/desk/bar.ts`, `web/src/lib/desk/preview.ts`, `web/src/lib/desk/tabs.ts`, `web/src/lib/desk/rows.ts`
- Test: `web/src/lib/desk/bar.test.ts`, `preview.test.ts`, `tabs.test.ts`, `rows.test.ts`

**Interfaces:**
- Produces:
  - `deskUi(o: { tv: boolean; mobile: boolean; kids: boolean }): boolean` — true only when all three are false (bar.ts).
  - `PILL_SOLID_AT = 24`; `pillSolid(scrollY: number, heroPage: boolean): boolean` — true when `!heroPage || scrollY > 24` (bar.ts).
  - `HOVER_DELAY_MS = 500`, `HOVER_CLOSE_MS = 150`, `HOVER_MIN_WIDTH = 1100`; `hoverAllowed(o: { width: number; coarse: boolean; scrolling: boolean }): boolean` (preview.ts).
  - `wideBox(card: {left,top,width,height}, vp: {w,h}, margin = 12): { left: number; top: number; width: number; origin: 'left' | 'right' | 'center' }` — width = `card.width * 2.5`; anchored on the card's left edge, flipped to end at the card's right edge when it would cross `vp.w - margin`, clamped to `margin`; top = card top − 8% of the box height, moved up so `top + height ≤ vp.h - margin` where height = `width * 9 / 16 * 0.62` (preview.ts).
  - `type DetailTab = 'episodes' | 'more' | 'extras' | 'details'`; `detailTabs(o: { series: boolean; similar: number; extras: number }): DetailTab[]` — order episodes, more, extras, details; episodes only for series; more only if `similar > 0`; extras only if `extras > 0`; details always (tabs.ts).
  - `rowPages(o: { scroll: number; viewport: number; content: number }): { page: number; pages: number; canPrev: boolean; canNext: boolean }` and `pageTarget(o: { scroll; viewport; content }, dir: -1 | 1): number` — page width = viewport; target clamped to `[0, content - viewport]` (rows.ts).

- [ ] **Step 1: Write failing tests**

```ts
// bar.test.ts
expect(deskUi({ tv: false, mobile: false, kids: false })).toBe(true);
expect(deskUi({ tv: true, mobile: false, kids: false })).toBe(false);
expect(pillSolid(0, true)).toBe(false); expect(pillSolid(25, true)).toBe(true); expect(pillSolid(0, false)).toBe(true);
// preview.test.ts
expect(hoverAllowed({ width: 1099, coarse: false, scrolling: false })).toBe(false);
expect(hoverAllowed({ width: 1280, coarse: false, scrolling: true })).toBe(false);
const b = wideBox({ left: 1100, top: 300, width: 240, height: 135 }, { w: 1280, h: 800 });
expect(b.left + b.width).toBeLessThanOrEqual(1268); expect(b.origin).toBe('right');
const low = wideBox({ left: 100, top: 760, width: 240, height: 135 }, { w: 1280, h: 800 });
expect(low.top + low.width * 9 / 16 * 0.62).toBeLessThanOrEqual(788);
// tabs.test.ts
expect(detailTabs({ series: false, similar: 0, extras: 0 })).toEqual(['details']);
expect(detailTabs({ series: true, similar: 3, extras: 1 })).toEqual(['episodes', 'more', 'extras', 'details']);
// rows.test.ts
expect(rowPages({ scroll: 0, viewport: 1000, content: 3500 })).toEqual({ page: 0, pages: 4, canPrev: false, canNext: true });
expect(pageTarget({ scroll: 2600, viewport: 1000, content: 3500 }, 1)).toBe(2500);
```

- [ ] **Step 2:** `cd web && npx vitest run src/lib/desk` — FAIL (modules missing).
- [ ] **Step 3:** Implement the four modules with the signatures above.
- [ ] **Step 4:** Same command — PASS; `npm run typecheck` 0 errors.
- [ ] **Step 5:** Commit `feat(desk): pure helpers for bar, hover preview, detail tabs and row paging`.

### Task 2: Pill top bar (`DeskBar.svelte`)

**Files:**
- Create: `web/src/lib/desk/DeskBar.svelte`
- Modify: `web/src/routes/+layout.svelte` (desktop `<header class="nav">` block ~lines 602–660 and its state: search, cats, bell, menu), `web/src/lib/i18n/*` (new `desk.*` keys if any)
- Test: `e2e/tests/desk-bar.spec.ts`

**Interfaces:**
- Consumes: `deskUi`, `pillSolid` (Task 1); `HEADER_TABS`, `isTabActive` (`#lib/menu`); today's search functions (`openSearch`, `commitSearch`, `onSearchKey`), categories dropdown, bell and account menu.
- Produces: `<DeskBar {path} {heroPage} />` rendered by `+layout.svelte` when `deskUi(...)`. Exposes `data-desk-bar` on its root and `.pill [aria-current="page"]` for the active tab.

- [ ] **Step 1: Write failing e2e** (`desk-bar.spec.ts`, desktop project, `tv: false`):
  - `pill tabs: Home active, clicking Series moves aria-current and the fill (.pill .fill transform changes)`
  - `bar is transparent over the billboard and solid after scrolling 40px` (`[data-desk-bar]` has class `solid` only after scroll)
  - `search: clicking the icon expands the field and focuses it; "/" does the same; typing goes to /search?q=; Esc clears then closes and focus returns to the icon`
  - `categories, notifications and profile menus open from the bar and close with Esc`
  - `phone layout (390px) still renders header.nav.m; TV (?tv=1) still renders nav.rail`
- [ ] **Step 2:** Run the spec — FAIL.
- [ ] **Step 3:** Move the desktop header markup and its state into `DeskBar.svelte` (layout keeps phone/TV/kids headers). Style: logo left; centred pill (rounded 999px, dark translucent fill, 1px `rgba(255,255,255,.09)` border, blur only when `motionLevel()==='full'`) holding `HEADER_TABS` + Categories button; right: round search button that expands left to 280px field (transform/opacity on the field, width animated via `scaleX` on a backing layer), bell with coral unread badge, avatar. Active-tab fill is one absolutely positioned `.fill` element moved with `animateTo` to the active tab's rect (instant under reduced motion). No full-width band; `solid` = pill opaque.
- [ ] **Step 4:** Spec PASS; existing header/search/menu e2e specs still PASS (`npx playwright test -c e2e/playwright.config.ts --project=desktop -g "search|header|menu|categories|bell"`); typecheck 0.
- [ ] **Step 5:** Commit `feat(desk): floating pill top bar with expanding search`.

### Task 3: Billboard (`DeskBillboard.svelte`)

**Files:**
- Create: `web/src/lib/desk/DeskBillboard.svelte`
- Modify: `web/src/routes/+page.svelte` (render `DeskBillboard` instead of `Hero` when `deskUi`)
- Test: `e2e/tests/desk-home.spec.ts`

**Interfaces:**
- Consumes: same props `Hero` gets today (`item`, `rank`, play href/label logic), `badge`/`fresh` labels, preview trailer API (`#lib/preview`), `decodeFade`.
- Produces: `<DeskBillboard item rank />`, root `section.billboard[data-vt-art]`.

- [ ] **Step 1: Write failing e2e:**
  - `billboard: 80vh (min 520px), eyebrow only when a label exists, title logo or name, meta line, Play and More info`
  - `trailer fades in after 1.5s and the synopsis collapses to one line; mute toggle and age badge at the right edge` (use `page.clock`)
  - `trailer pauses when the billboard scrolls out of view`
  - `title without backdrop and logo shows the name and no broken image` (Review Focus 3)
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Build the billboard per spec §2 (right-anchored backdrop, left+bottom fades, coral eyebrow, synopsis 3 lines → 1 line via opacity+translate after the trailer starts, `holdBillboard`/`billboardHeld` and `previewOwner` honoured so a hover preview pauses it). Phone keeps `Hero`.
- [ ] **Step 4:** PASS; phone home e2e unchanged; typecheck 0.
- [ ] **Step 5:** Commit `feat(desk): trailer billboard`.

### Task 4: Paged rows

**Files:**
- Modify: `web/src/lib/Row.svelte` (desktop branch only: `!$mobile && !tvOn`)
- Test: `e2e/tests/desk-home.spec.ts` (append)

**Interfaces:**
- Consumes: `rowPages`, `pageTarget` (Task 1); `glideRow`/`animateTo` from `#lib/tv/motion`.
- Produces: row arrows `button.pg.prev` / `button.pg.next`, dots `.pgdots [aria-current]`.

- [ ] **Step 1: Write failing e2e:**
  - `row hover shows arrows; next moves one page with a transform, dots follow; prev hidden on the first page`
  - `ranked rows show large outlined rank numbers on desktop`
  - `rows keep today's order and reco captions` (compare titles with a fixture order)
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Add arrows (visible on row hover/focus-within, 56px wide gradient edges), page by `pageTarget`, scroll with spring, dots from `rowPages`. Left edge aligns with the bar's logo (4% gutter, min 32px). Ranked rows: big outlined numerals beside posters.
- [ ] **Step 4:** PASS; `-g "row|home"` desktop and mobile specs PASS; typecheck 0.
- [ ] **Step 5:** Commit `feat(desk): paged rows with spring arrows and rank numerals`.

### Task 5: Wide hover preview (`DeskPreview.svelte`)

**Files:**
- Create: `web/src/lib/desk/DeskPreview.svelte`
- Modify: `web/src/lib/Card.svelte` (desktop uses `DeskPreview` instead of `HoverPreview`; delays from Task 1)
- Delete when unused: `web/src/lib/HoverPreview.svelte` (only if no other import remains)
- Test: `e2e/tests/desk-preview.spec.ts`

**Interfaces:**
- Consumes: `wideBox`, `hoverAllowed`, `HOVER_DELAY_MS`, `HOVER_CLOSE_MS` (Task 1); `hoverOwner`, `fmtRuntime`, `lengthLabel`, `genreLine` (`#lib/hover`); actions from `#lib/actions` (play, list, rating); `ReasonCaption` data.
- Produces: portal element `.dpv[role=dialog]`, closes on pointerleave/Esc; ⌄ button `a.dpv-more` links `/item/[id]`.

- [ ] **Step 1: Write failing e2e:**
  - `opens after 500ms rest, not before; not while wheel-scrolling`
  - `wide tile: trailer left, Play / My list / rating / more right, match score, quality badges, synopsis, reco reason when present; neighbours dim`
  - `last card in a row and a row at the viewport bottom: preview fully inside the viewport` (Review Focus 1)
  - `closes 150ms after pointer leaves and on Esc; never takes keyboard focus`
  - `resizing to 1000px closes an open preview and undims the row` (Review Focus 2)
  - `My list toggles from the preview; ⌄ opens /item/[id]`
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Grow from the card rect (FLIP transform, origin from `wideBox`), 2-column grid (video 1.15fr, info 1fr), trailer via the preview API (pauses the billboard), Continue Watching shows next episode. Off when `!hoverAllowed`.
- [ ] **Step 4:** PASS; existing hover/card e2e adjusted only where they assert old `HoverPreview` markup on desktop; typecheck 0.
- [ ] **Step 5:** Commit `feat(desk): wide hover preview`.

### Task 6: Full-page detail (`DetailDesk.svelte`)

**Files:**
- Create: `web/src/lib/detail/DetailDesk.svelte`
- Modify: `web/src/lib/detail/DetailView.svelte` (variant `'desk'`), `web/src/routes/item/[id]/+page.svelte` (desktop uses `'desk'`), `web/src/lib/modal.ts` (`openModal` navigates with `goto(href)` when `deskUi`), callers that open `ItemModal` on desktop
- Test: `e2e/tests/desk-detail.spec.ts`

**Interfaces:**
- Consumes: `detailTabs` (Task 1); today's DetailView data and sub-components (episodes panel, cast, extras, collection, RatingButton, LangPick, lists, MoreActions).
- Produces: `DetailView variant="desk"`; tab list `[role=tablist] [role=tab][aria-selected]`, panels `[role=tabpanel]`, back link `a.dback`.

- [ ] **Step 1: Write failing e2e:**
  - `More info on the billboard and ⌄ in the preview navigate to /item/[id] (no ItemModal on desktop); phone still opens the modal/sheet`
  - `series: Episodes tab first with season picker and next-up highlighted; More like this; Extras; Details`
  - `movie without extras or similar: only Details` (Review Focus 5)
  - `tab change: coral underline moves, panel crossfades, arrow keys move between tabs`
  - `backdrop fixed while scrolling; trailer after 1.5s with mute in the action row`
  - `title without backdrop/logo renders name text and no broken image` (Review Focus 3)
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Build per spec §3: full-viewport backdrop with fades, left column (~42%): eyebrow, title, meta with match score, synopsis 4 lines + More, actions (Play/Continue S·E, Restart, My list, rating, trailer, mute); tabs below, only from `detailTabs`; "‹ Back" (`history.back()` when in-app history exists, else `goto('/')`).
- [ ] **Step 4:** PASS; `-g "detail|item|modal"` desktop + mobile specs PASS; typecheck 0.
- [ ] **Step 5:** Commit `feat(desk): full-page cinematic detail with tabs`.

### Task 7: Desktop page motion

**Files:**
- Modify: `web/src/lib/tv/motion.ts` (add `deskPagePlan`), `web/src/routes/+layout.svelte` (desktop branch of the view-transition hook next to `tvTransition`), `web/src/app.css` (desktop VT rules)
- Test: `web/src/lib/tv/motion.test.ts` (append), `e2e/tests/desk-detail.spec.ts` (append)

**Interfaces:**
- Consumes: `VT_ART`, `vtBegin`/`vtName`/`vtEnd`, `stagger`, focus memory (`memo`/`sameSpot`) in `+layout.svelte`.
- Produces: `deskPagePlan(o: { from: string; to: string; back: boolean; motion: boolean; level: 'full' | 'reduced'; hasApi: boolean }): { kind: 'none' | 'fade' | 'view'; morph: 'in' | 'back' | null }` — `view` + `morph:'in'` for any → `/item/:id`; `view` + `morph:'back'` for `/item/:id` → anything with `back`; `fade` when `!hasApi` or `level==='reduced'`; `none` when `!motion`.

- [ ] **Step 1: Write failing tests:**
  - unit: `deskPagePlan` table: home→item = view/in; item→home back = view/back; reduced = fade; motion off = none; item→item (More like this) = view/in.
  - e2e: `clicking a card names the card art and the detail backdrop with the same view-transition-name`; `Back returns to the row, same row page, card focused`; `deep link /item/x then Back link goes to / without a morph` (Review Focus 4); `after the morph, title/meta/synopsis/actions stagger in (data-st order)`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement `deskPagePlan` and a `deskTransition(nav, start)` in `+layout.svelte` reusing the TV token/naming flow; stagger 40 ms apart with `stagger`; reduced set crossfades.
- [ ] **Step 4:** PASS; TV transition e2e (`tv-layout`, `tv-detail`) unchanged; typecheck 0.
- [ ] **Step 5:** Commit `feat(desk): card to detail morph and staggered entry`.

### Task 8: Cleanup, docs, full verification

**Files:**
- Modify: `CHANGELOG.md` (Unreleased → "Desktop" section), `README.md` / `docs/` where they describe the desktop header, popup detail or hover preview (EN and DE), remove dead desktop CSS/markup left in `+layout.svelte`, `Hero.svelte` (phone-only paths stay), unused i18n keys.
- Test: full suites.

- [ ] **Step 1:** Grep for leftovers: `HoverPreview`, desktop-only `ItemModal` paths, old `header.nav` desktop CSS; remove what nothing references.
- [ ] **Step 2:** Docs + CHANGELOG (no other service's name; fictional titles).
- [ ] **Step 3:** `cd web && npm run typecheck` 0 errors; `npx vitest run --coverage` ≥ 94/89; full e2e (desktop + mobile projects) green (known flakes: admin-settings passkey, plex X-Plex-Token, i18n-boot, cast-receiver — rerun once).
- [ ] **Step 4:** Commit `docs: desktop redesign; cleanup`.
