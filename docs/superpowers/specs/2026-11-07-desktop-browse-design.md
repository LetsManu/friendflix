# Desktop browse redesign (pill top bar, billboard, wide hover preview, full-page detail)

Date: 2026-11-07 · Status: draft for owner review

## Goal

Give the desktop web UI the same finish as the TV layout shipped in v2.5.0: the browse pattern of the large streaming services (top bar, billboard with trailer, rows, hover preview, detail), built in FriendFlix's own look and with the TV's motion quality. Today the desktop UI works but reads as plain: a solid top bar with a categories dropdown, a hero, rows, a small hover preview and a detail popup (`ItemModal`).

This is block 1 of 4. Later blocks, each with its own spec: desktop player, phone browse, phone player.

Owner choices (mockups reviewed 2026-11-07): floating pill top bar with search that expands from its icon; wide hover preview; full-page cinematic detail with nice animations.

## Constraints

- Applies only to the desktop UI: not `html.tv`, not `$mobile` (phone layout), not the kids UI, not admin. Those render exactly as today.
- Own look: coral `#ff4f6d` accent, FriendFlix logo (`Logo.svelte`), Inter. No other service's names, logos, N marks or red-on-black branding. Never another streaming service's name in user-facing text.
- The recommendation engine stays in charge: billboard title, row order, reco tags, `ReasonCaption`, match score all come from today's data (`homeOrder`, reco rows, `ReasonCaption`). No backend change.
- Animate only `transform` and `opacity`. Respect `prefers-reduced-motion`, calm mode and the TV motion system's frame guard (`motionLevel`, `frameGuard` from `#lib/tv/motion`, moved to a shared place if needed). Blur only where `motionLevel` is full.
- Trailers follow the existing preview rules (`hoverTrailers` pref, muted start, calm mode, reduced motion, Save-Data, hidden tab).
- Keyboard: every control reachable with Tab, visible focus ring, Esc closes search, menus and the hover preview.
- i18n: every new string in all seven locales (en, de, pl, es, fr, it, tr).
- Desktop width range: 1024 px and up. Between the phone breakpoint and 1024 px the layout scales down (pill shrinks, hover preview off below 1100 px).

## 1. Top bar

- New `DeskBar.svelte`, rendered by `+layout.svelte` for desktop instead of today's `<header class="nav">` (phone, TV and kids headers unchanged).
- Left: logo (links Home). Centre: floating pill with Home, Series, Movies, New & popular, My list (`HEADER_TABS`) plus **Categories** (opens today's categories dropdown: genres, languages, collections). Right: search, notifications (unread badge), profile avatar.
- Pill: rounded, `rgba` dark fill, 1 px light border, light blur where allowed. The active tab has a light fill that slides to the newly chosen tab (FLIP via the motion system).
- Over the billboard the bar has no background; after 24 px of scroll the pill becomes opaque. No full-width bar band at any time.
- Search: a round icon button. Click or `/` stretches it leftwards into a field (~280 px) with the cursor in it; results show live in a panel under the bar (today's search logic); Enter opens `/search?q=`; Esc, ✕ or clicking outside shrinks it back. Focus returns to the icon.
- Profile menu: profiles, account, settings, devices, notifications, admin (admins only), log out — today's account menu, restyled.

## 2. Home

- `routes/+page.svelte` renders `DeskHome.svelte` on desktop; the data loading and row composition stay exactly as today (same order, reco tags, `ReasonCaption`, hubs, themed lists).
- **Billboard** (80% of the viewport height, at least 520 px): the recommendation engine's hero title. Backdrop right-anchored with a left and bottom fade to the page colour. Eyebrow (coral, from existing badge/fresh labels: "New season", "New episode", "Recently added"; none if no label), title logo or name, meta line (year · age · seasons or length · genre), synopsis (3 lines), **Play/Continue** and **More info**.
  - After 1.5 s the trailer fades in over the backdrop, muted; the synopsis then collapses to one line (opacity + translate). Right edge: mute toggle and age badge.
  - The trailer pauses when the billboard leaves the viewport or the tab hides, and when a hover preview opens.
- **Rows**: same rows and order as today, left edge aligned with the logo.
  - On row hover, ◀ ▶ arrows appear at the edges; a click moves one page with a spring (`glideRow`); page dots above the right end show the position.
  - Top 10 rows show large outlined rank numbers next to posters.
  - Continue Watching cards keep their progress bar.
- **Wide hover preview** (replaces `HoverPreview.svelte` on desktop): opens when the pointer rests 500 ms on a card and the page is not scrolling.
  - Grows out of the card (transform from the card's rect) to a wide tile ~2.5 cards wide: trailer or backdrop left with title and mute; right: Play, My list, rating, ⌄ (opens the detail), match score ("94% for you"), age, seasons/length, quality badges, two-line synopsis, and the reco reason ("Because you liked …") when present. Continue Watching shows the next episode.
  - Stays inside the viewport (opens towards the free side at row ends). Neighbouring cards dim to 55%.
  - Closes 150 ms after the pointer leaves it or on Esc; never steals keyboard focus. Keyboard users open the detail with Enter on the card.
  - Off below 1100 px width and when the pointer is coarse.

## 3. Detail page (full page)

- Desktop opens titles as the full page `/item/[id]` (today's route) instead of the `ItemModal` popup. `ItemModal` stays only where phone/TV still use it; on desktop links and "More info" navigate.
- New `DetailDesk.svelte` as `DetailView` variant `'desk'` (alongside `'tv'`), reusing today's data and sub-components (episodes, cast, extras, collection, rating, lists, language picker).
- Layout: full-viewport backdrop (trailer after 1.5 s, muted, mute toggle in the action row) with left and bottom fades. The pill bar stays on top; a "‹ Back" link under it.
  - Left column (~42% width): eyebrow, title logo or name, meta line with match score and quality badges, synopsis (4 lines, "More" expands), actions: Play/Continue S·E, Restart (when in progress), My list, rating, trailer, mute.
  - Below, tabs: **Episodes** (series: season picker, episode tiles with progress, next-up highlighted), **More like this**, **Trailers & extras**, **Details** (cast with photos, genres, studio, languages, audio/subtitles, collection). Tabs only appear when they have content. The coral underline slides between tabs; the panel crossfades (120 ms out, 200 ms in, 8 px rise).
  - The page scrolls normally; the backdrop stays fixed and darkens as the tabs reach the top.
- **Motion in**: View Transition from the card or hover preview: the artwork morphs into the backdrop (`VT_ART`, as on TV), then title, meta, synopsis and actions stagger in (40 ms apart). Without View Transitions: crossfade.
- **Motion back**: browser Back or "‹ Back" morphs the backdrop back into the card it came from; the row keeps its page position and the card gets focus.
- Deep links and reloads of `/item/[id]` render the page without the morph.

## 4. Visual and motion tokens (desktop)

- Reuse the TV tokens where they apply (`--tv-spring`, `--tv-emph-out`, `--tv-emph-in`, durations) under neutral names shared by TV and desktop; the TV keeps its values.
- Side gutter 4% of the width (min 32 px). Type scale: billboard title 4.5vw (max 88 px), row title 20 px/700, body 16 px/1.5, meta 14 px with `.sep` dots and the `.age` box.
- Cards: radius 6 px, no border; focus ring 2 px white outside the card. Buttons: Play white fill, secondary translucent grey, round icon buttons 1.5 px border.
- Banned: emoji as icons, gradient text, glows, generic eyebrows on every section, uniform rounded cards with shadows everywhere.

## Testing

- Unit (vitest): pure helpers (bar scroll state, search open/close state machine, hover-preview placement inside the viewport, tab availability).
- E2E (Playwright, desktop project): pill tabs and active fill; search opens from the icon and with `/`, Esc closes and returns focus; hover preview opens after the delay, not while scrolling, stays inside the viewport, Play/My list work; More info and ⌄ open `/item/[id]`; Back returns to the row with the card focused; tabs on a series and a movie; phone and TV layouts unchanged (header, rows, `ItemModal` on phone).
- Coverage thresholds stay (statements 94%, branches 89%). Full desktop e2e suite green.

## Release

- The redesign ships as **v3.0.0** (major bump, next codename), per the owner. It is released once all four blocks (desktop browse, desktop player, phone browse, phone player) are merged; each block merges to main on its own without a release.

## Out of scope

- Desktop and phone players (blocks 2 and 4), phone browse (block 3).
- Kids UI, admin, TV.
- Backend or API changes, new recommendation logic.
