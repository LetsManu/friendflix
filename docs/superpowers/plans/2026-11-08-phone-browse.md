# Phone Browse Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone layout gets a glass top bar and floating glass tab bar, a swipe carousel of five recommended titles on Home, a spring preview sheet, a reworked phone detail page and phone search.

**Architecture:** Pure logic (carousel picks, swipe decision, chips tuck state, tab list) lives in tested TypeScript under `web/src/lib/phone/`. The phone shell stays in `routes/+layout.svelte`; new visual parts are components under `web/src/lib/phone/`. Existing data flows (`/api/home`, `previewSheet` store, `DetailView` page variant, search page) are kept and restyled, not replaced.

**Tech Stack:** SvelteKit (Svelte 4 syntax), TypeScript, vitest, Playwright (`mobile` project, 390×844, touch), motion helpers in `web/src/lib/tv/motion.ts`.

**Spec:** `docs/superpowers/specs/2026-11-08-phone-browse-design.md`

## Global Constraints

- Phone layout only: `$mobile` (`lib/viewport.ts`, max-width 720px) and not kids and not TV. Desktop, TV, kids UI (incl. kids on phone) and admin render exactly as today.
- Own look: coral `#ff4f6d`, Inter, FriendFlix logo. Never another streaming service's name in user-facing text.
- No backend change; carousel, rows, reasons and match score come from today's data.
- Animate only `transform` and `opacity`; reduced motion and calm (`motionAllowed()` false) switch instantly; blur only when `motionLevel() === 'full'`.
- Touch targets ≥ 44×44 px; safe areas (`env(safe-area-inset-*)`, existing `--safe-bottom`); no horizontal page scroll.
- Every new string in all seven locales (en, de, pl, es, fr, it, tr); `de` is the type source.
- Owner rule: write the tests; run only root `npm run typecheck` locally (CI runs vitest and Playwright).
- Code map of the current phone code: `.superpowers/phone-map.md` (gitignored; line numbers from before this block).

## Review Focus

1. Fewer than five carousel candidates (new library, kids-like small catalogues): one card works without dots and swipe; zero candidates falls back to today's hero — test in Task 1 and Task 3.
2. A swipe that is really a vertical page scroll must scroll the page, not move the carousel (`touch-action: pan-y`, horizontal threshold) — test in Task 3.
3. Users without downloads: no Downloads tab, no Download buttons — tests in Tasks 2, 4, 5.
4. Landscape phones and very small phones (≤ 360 px): tab bar and carousel fit, no overflow — check in Task 2 and Task 3 e2e with `noHorizontalOverflow`.
5. Existing phone e2e selectors (`.tabbar`, `header.nav.m`, `.mrow`, `.mh`, `.pc`, dialog /^Vorschau: /, `.dv .hero`) keep working or are updated without weakening — every task.

---

### Task 1: Pure helpers

**Files:** Create `web/src/lib/phone/logic.ts`, test `web/src/lib/phone/logic.test.ts`.

**Interfaces (produces):**
- `CAROUSEL_MAX = 5`
- `carouselPicks(o: { hero: Item | null; candidates: Item[]; fresh: (id: string) => string | null }): Item[]` — hero first (when present), then candidates that have a fresh label (`fresh(id)` not null) in their given order, then the remaining candidates in order; deduplicated by `id`; only items with a poster (`imageTags?.Primary` or the field the project uses for posters — follow `PosterCard.svelte`); capped at `CAROUSEL_MAX`.
- `SWIPE_PX = 50`, `FLICK_PX_PER_MS = 0.5`
- `swipeTarget(o: { index: number; count: number; dx: number; vx: number }): number` — `dx < -SWIPE_PX || vx < -FLICK` → index+1; `dx > SWIPE_PX || vx > FLICK` → index-1; clamped to `[0, count-1]`; else index.
- `TUCK_AFTER = 90`, `SOLID_AFTER = 30`
- `chipsTucked(o: { y: number; lastY: number; tucked: boolean }): boolean` — `y < TUCK_AFTER` → false; `y > lastY + 4` → true; `y < lastY - 4` → false; else `tucked`.
- `type PhoneTab = { href: string; key: 'home' | 'new' | 'myList' | 'downloads'; icon: string }`
- `phoneTabs(canDownload: boolean): PhoneTab[]` — `/` home (icon `home`), `/new` new (icon the project's "new" icon), `/watchlist` myList (icon `bookmark` or the project's list icon), `/downloads` downloads (icon `download`) only when `canDownload`.

- [ ] **Step 1: Tests** (`logic.test.ts`): picks — hero first; fresh-labelled before others; dedupe hero appearing in candidates; cap 5; items without poster skipped; `hero: null` and no candidates → `[]`. swipeTarget — -60 → +1; +60 → -1; -20 with vx -0.8 → +1; -20 vx 0 → same; clamp at 0 and count-1. chipsTucked — y 50 → false; y 200 lastY 100 → true; y 150 lastY 200 → false; y 200 lastY 202 tucked true → true. phoneTabs — 4 tabs with downloads, 3 without, hrefs in order.
- [ ] **Step 2: Implement.** **Step 3:** root `npm run typecheck`. **Step 4: Commit** `feat(phone): carousel picks, swipe and chip helpers, tab list`.

---

### Task 2: Shell — glass top bar, tucking chips, floating glass tab bar, categories sheet

**Files:** Modify `web/src/routes/+layout.svelte` (phone header ~l.662, tabbar ~l.681, categories ~l.686, CSS ~l.791–824); create `web/src/lib/phone/TabBar.svelte`; i18n `shell.ts` ×7; test `e2e/tests/phone-shell.mobile.spec.ts` (new).

**Interfaces:** consumes `phoneTabs`, `chipsTucked`, `SOLID_AFTER` (Task 1); `canDownload` (layout l.106). Produces `TabBar` props `{ path: string; canDownload: boolean }`.

Behaviour (phone, not kids, not TV):
- Header `.mrow`: logo `a.mlogo` now links `/` (label `shell.mobile.home`); search; avatar `/me` with unread dot (unchanged labels). The downloads icon leaves the header (it is a tab now). Header transparent over hero pages, glass (`rgba(10,10,12,.78)` + blur when `motionLevel()==='full'`) after `SOLID_AFTER` px of scroll (use a scroll listener with rAF throttle; keep `class:solid`).
- Chips: tuck with `transform: translateY(-12px)` + `opacity 0` (and header height animation via `transform` on the header's content, not `height`) per `chipsTucked`; return on scroll up.
- Tab bar: replaces the phone `.tabbar` markup for non-kids with `<TabBar>`: floating pill (left/right 14px, bottom `calc(10px + var(--safe-bottom))`), glass fill, 4 or 3 tabs (icon + label, ≥ 44px tall), active highlight that springs to the active tab (transform), `nav` with `aria-label` `shell.mobile.tabbar`, links with `aria-current="page"`. Kids keep today's `.tabbar`.
- Page bottom padding on phone grows to clear the floating bar.
- Categories sheet: bottom sheet (rounded 22px top, grab handle, spring up, drag down to close) with today's content and focus handling.
- New i18n keys: `shell.mobile.home` (en "Home", de "Startseite", pl "Strona główna", es "Inicio", fr "Accueil", it "Home", tr "Ana sayfa"), `shell.tabs.myList` (en "My list", de "Merkliste", pl "Moja lista", es "Mi lista", fr "Ma liste", it "La mia lista", tr "Listem"), `shell.tabs.downloads` (en "Downloads", de "Downloads", pl "Pobrane", es "Descargas", fr "Téléchargements", it "Download", tr "İndirilenler").

- [ ] **Step 1: e2e** `phone-shell.mobile.spec.ts`: tab bar has Startseite/Neu (today's `shell.tabs.new` text)/Merkliste/Downloads links with `aria-current` on the active one; without downloads permission (mock `me.downloads.allowed=false` as existing specs mock `/api/me`) 3 tabs; header gets `.solid` after scrolling 40px on `/`; chips get a tucked class after scrolling down 300px and lose it after scrolling up 50px; logo link goes to `/`; avatar link goes to `/me`; `noHorizontalOverflow` at 390×844 and 320×640; kids profile still shows the old `.tabbar` (follow `kids.mobile.spec.ts` setup).
- [ ] **Step 2: Implement.** **Step 3: Update existing mobile specs** that relied on the header downloads link or the old tabbar markup (`pages.mobile.spec.ts` link 'Downloads', `home.mobile.spec.ts` `.tabbar`, `safe-area.mobile.spec.ts` `nav.tabbar`) to the new markup without weakening (keep a `nav` with class `tabbar` on the new bar so selectors survive where possible).
- [ ] **Step 4:** root `npm run typecheck`. **Step 5: Commit** `feat(phone): glass top bar, tucking chips and floating tab bar`.

---

### Task 3: Home swipe carousel

**Files:** Create `web/src/lib/phone/Carousel.svelte`, `web/src/lib/phone/glow.ts` (+ `glow.test.ts`); modify `web/src/routes/+page.svelte` (hero area ~l.226–234) and row styles where needed (`Row.svelte` mobile branch, `PosterCard.svelte` only for radius/rank numeral look); i18n `home.ts` ×7; test `e2e/tests/phone-home.mobile.spec.ts` (new).

**Interfaces:** consumes `carouselPicks`, `swipeTarget`, `CAROUSEL_MAX` (Task 1); `openPreview` (`lib/previewSheet.ts`); `badges`/`wantBadge` (`lib/fresh.ts`); `spring` helpers from `#lib/tv/motion`. Produces `Carousel` props `{ items: Item[] }`; `glow.ts` `averageColor(img: HTMLImageElement): [number, number, number] | null` (canvas 16×16 sample; null on error/tainted) and `glowCss(rgb: [number,number,number] | null): string` (radial + linear gradient string; neutral dark when null).

Behaviour:
- On phone (not kids) `+page.svelte` renders `<Carousel items={picks}>` instead of `<Hero … portrait>`; `picks = carouselPicks({ hero, candidates: [...recs-row items, ...latest], fresh: (id) => $badges[id] ?? null })` using the lists the page already loads (follow the map: `recs`, `latest`; do not add requests). With `picks.length === 0` render today's `Hero` (fallback).
- Carousel: region `aria-roledescription="carousel"` with label `home.carousel.label`; slides `role="group"` `aria-roledescription="slide"` labelled "n of m"; live region announces the centred title; ArrowLeft/ArrowRight move. Centre card ≈ 70% width, neighbours scale .86 and dim; drag follows the finger (pointer events, horizontal intent after 8px, `touch-action: pan-y`), release decides via `swipeTarget`, then a spring settles (no auto-advance). Dots under it (hidden for one card). Play/Continue and My list act on the centred card (reuse Hero's play href/label logic and list toggle). Tap on the centred card → `openPreview(item, el)`; tap on a side card centres it. Glow behind from `averageColor` of the centred poster (crossfade 600 ms; none without motion). No trailer.
- Rows: Top 10 numerals outlined large next to posters; Continue Watching 16:9 with progress (existing PosterCard landscape) — style only.
- New i18n keys: `home.carousel.label` (en "Top picks for you", de "Top-Tipps für dich", pl "Najlepsze propozycje dla ciebie", es "Lo mejor para ti", fr "Nos meilleurs choix pour vous", it "I migliori per te", tr "Senin için en iyiler"), `home.carousel.slide` (en "{n} of {m}", de "{n} von {m}", pl "{n} z {m}", es "{n} de {m}", fr "{n} sur {m}", it "{n} di {m}", tr "{m} içinde {n}").

- [ ] **Step 1: Tests:** `glow.test.ts` — `glowCss(null)` contains no `rgba(` from a colour and is a valid gradient string; `glowCss([200,100,50])` contains `200,100,50`. e2e `phone-home.mobile.spec.ts` (mock `/api/home` with a hero and recs with 5+ poster items, one with a fresh badge): carousel region visible with 5 slides; the hero is slide 1; dragging the track left by 120px makes slide 2 centred (its title in the live region) and the second dot current; a 20px drag returns to the same slide; a vertical swipe (`page.mouse` down/move 0,−300/up on the track) scrolls the page and keeps the slide; tap centred card opens dialog /^Vorschau: /; Play link targets the centred item; one-candidate fixture shows no dots; zero candidates shows today's `.mh` hero; `noHorizontalOverflow`.
- [ ] **Step 2: Implement.** **Step 3: Update** existing mobile specs that target `.mh`/`.pcard` on Home (`safe-area`, `home`, `fresh`, `preview-sheet`) to the carousel without weakening.
- [ ] **Step 4:** root `npm run typecheck`. **Step 5: Commit** `feat(phone): home swipe carousel`.

---

### Task 4: Preview sheet

**Files:** Modify `web/src/lib/MobilePreviewSheet.svelte`; i18n only if a new string is needed; test `e2e/tests/preview-sheet.mobile.spec.ts` (extend).

**Interfaces:** consumes `previewSheet`/`closePreview`; `itemPath`, `playPath`; DownloadButton (only when downloads allowed — read the same `me.downloads.allowed` source the layout uses).

Behaviour: sheet springs up (transform) over a dim (opacity); grab handle; header grid poster / title / year · age · seasons-or-length / 3-line synopsis / close button; reason line "Because you watched …" when the opened item carries reco reason data (reuse what `ReasonCaption` renders for that item; omit when absent); Play/Continue + Download (allowed only); icon row My list, Rate (existing rating action if available on phone, else omit), Share (not kids), Details. Drag down > 90px or tap dim closes; drag up > 90px or Details navigates to `itemPath`. Focus trap and Esc as today. Reduced motion: no spring.

- [ ] **Step 1: e2e:** extend `preview-sheet.mobile.spec.ts`: opening from a carousel poster and from a row poster shows dialog /^Vorschau: / with Play and Details; dragging the grab handle down 150px closes it; dragging up 150px navigates to `/item/<id>`; without downloads permission no Download button; Esc closes and focus returns to the opener.
- [ ] **Step 2: Implement.** **Step 3:** root `npm run typecheck`. **Step 4: Commit** `feat(phone): spring preview sheet with drag to close or open`.

---

### Task 5: Phone detail page

**Files:** Modify `web/src/lib/detail/DetailView.svelte` (phone branch: hero ~l.690, title/buttons ~l.499, download removal ~l.297/585, tabs ~l.571/706, trailer rule ~l.306–312); test `e2e/tests/detail.mobile.spec.ts` (extend).

Behaviour (phone, page/modal variant): backdrop ~300px with glass round back and Cast buttons over it; eyebrow (fresh label), title logo or name, meta line with match score, year, age, seasons/length, quality; full-width Play/Continue S·E (white) and Download S·E (glass; only when downloads allowed — reverses today's phone removal); synopsis 3 lines with "Mehr lesen" as today; cast line; icon row My list / Rate / Share; tabs keep today's set and order, coral underline slides (transform) between tabs, panel crossfades. Trailer rule on phone gains `autoplayAllowed()` (calm + reduced motion) while keeping today's other conditions.

- [ ] **Step 1: e2e:** backdrop and back button visible; Play and Download (allowed) full width; Download absent when not allowed; tablist 'Weitere Inhalte' underline moves (its `transform` changes) when another tab is chosen; with calm on no trailer `<video>` starts (mock trailer as existing detail specs do).
- [ ] **Step 2: Implement.** **Step 3:** root `npm run typecheck`. **Step 4: Commit** `feat(phone): reworked phone detail page`.

---

### Task 6: Phone search

**Files:** Modify `web/src/routes/search/+page.svelte` (phone form ~l.124, before-typing ~l.136–149); i18n `home.ts`/search keys ×7 if new strings; test `e2e/tests/search.mobile.spec.ts` (new).

Behaviour (phone, not kids): rounded field (44px, radius 12px) focused on open; before typing: recent chips as today, "Popular here" as rows (16:9 thumb, title, round play button linking `playPath`), then "Browse by genre" tiles (two columns, 74px, gradient from a per-genre colour derived deterministically from the genre name in the app palette; link `categoryHref`); typing behaves as today. Genres from the existing `/api/library/genres`.

New i18n keys: `home.search.popularHere` (en "Popular here", de "Beliebt hier", pl "Popularne tutaj", es "Popular aquí", fr "Populaire ici", it "Popolari qui", tr "Burada popüler"), `home.search.byGenre` (en "Browse by genre", de "Nach Genre stöbern", pl "Przeglądaj według gatunku", es "Explorar por género", fr "Parcourir par genre", it "Sfoglia per genere", tr "Türe göre göz at").

- [ ] **Step 1: e2e** `search.mobile.spec.ts`: field focused; 'Beliebt hier' rows with play links; genre tiles link to `/browse/…?genre=`; typing shows results as today; kids search unchanged.
- [ ] **Step 2: Implement.** **Step 3:** root `npm run typecheck`. **Step 4: Commit** `feat(phone): phone search with popular rows and genre tiles`.

---

### Task 7: Docs and changelog

**Files:** `CHANGELOG.md` (Unreleased → new `### Phone` section: tab bar, carousel, preview sheet, detail, search), `README.md`, `README.de.md` (phone section).

- [ ] **Step 1: Write.** **Step 2: Commit** `docs: phone browse redesign`.
