# TV layout redesign (side bar, focus tile, button-list detail, player panel)

Date: 2026-11-06 · Status: draft for owner review

## Goal

Make FriendFlix comfortable on a TV with a D-pad remote (LG Magic Remote 2025, Samsung, Android TV via the web shell, `?tv=1` preview). Today the TV UI is the desktop UI scaled up: a top bar, a hero carousel, small rows, a long scrolling detail page, small player popup menus. The owner asked for the layout pattern current TV streaming apps use (the 2026 side-bar layout), built generically in FriendFlix's own look.

## Constraints

- Applies only in TV mode (`html.tv`, set by `+layout.svelte`). Desktop, phone, kids UI and admin do not change.
- Own look: FriendFlix colours, logo and type. No other service's names, logos or red-on-black branding. Never "Netflix" in user-facing text.
- Safe area: 96 px left/right, 54 px top/bottom at 1080p (scale with `vw`/`vh`).
- Text ≥ 28 px at 1080p for body copy on TV; focus targets ≥ 54 px tall.
- Exactly one focused element. Focus = `scale(1.08)` + 3 px accent ring. Nothing else changes on focus.
- Animate only `transform` and `opacity`. No `backdrop-filter`/`filter: blur` on TV (old webOS GPUs).
- Lazy images; at most two cards beyond the visible edge load eagerly.
- All interaction works with arrows, OK and Back. The Magic Remote pointer is a bonus, never required.
- Reuse existing data loads and components (`Card`, `Row`, `DetailView`, `EpisodesPanel`, `LangPick`, spatial navigation in `#lib/spatial`). No backend change.
- i18n: every new string in all seven locales (en, de, pl, es, fr, it, tr).

## 1. Navigation: side bar

- New `TvRail.svelte`, rendered by `+layout.svelte` in TV mode instead of the top `<header class="nav">`. The TV top bar is removed.
- Collapsed: 96 px wide icon column, full height, fixed left. Items in order: Search, Home, Series, Movies, My List. Profile avatar at the bottom (opens the profile switcher).
- Expanded: about 320 px with labels, over the content (content does not reflow), dark gradient behind it.
- Opens when it gets focus: ◀ from the leftmost focusable element of the content, Back from the content, or Magic Remote pointer hover.
- Inside: ▲/▼ move, OK opens the page and returns focus to the content, ▶ or Back closes the rail and restores focus to the element that had it.
- Back while the rail is open on Home keeps today's exit behaviour (exit prompt in the LG app).
- The active page's icon is highlighted (accent colour) in both states.
- Categories leave the navigation. On Home they become a row of large category tiles (see 2).

## 2. Home: focus tile and rows

- `routes/+page.svelte` renders `TvHome.svelte` in TV mode instead of `Hero` + `BrandHubs` + rows.
- **Focus tile** (top ~50% of the height, right of the rail): backdrop (right-anchored, fades to the page colour at left and bottom), title logo or name, meta line (genre · year · seasons or length · age rating), 2–3 line synopsis, labels ("New episode", "Top 10", "Recently added", from existing badge/fresh logic).
  - On open it shows the hero title with **Play** and **More info** buttons (focused: Play).
  - When a row card has focus, the tile shows that card's title after 300 ms without focus change, with a 200 ms crossfade. No buttons then; it never takes focus.
  - Continue Watching cards add "S2E4 · 23 min left" to the tile.
  - Trailer autoplay: the existing preview feature (`hoverTrailers` pref, muted, respects calm mode, reduced motion, Save-Data and hidden tabs) is turned on for TV. It starts in the focus tile after 1.5 s of rest on one title, replaces the backdrop, and stops as soon as focus moves. The sound toggle stays.
- **Recommendation engine (v2) stays in charge of the rows.** TV home does not build its own row list: it keeps the existing composition in `routes/+page.svelte` (server-chosen `homeOrder`, friends / because / more:<n> rows, the "never repeat what the first rows show" filter, themed lists, Top 10, genres) and only swaps how it is shown. `Row`'s `reco` tag keeps reporting impressions and clicks per row and engine (`recoTrack`).
  - Each recommended title's reason ("Because you watched X · same director", `reasonText`) is shown in the focus tile under the synopsis when that title has focus.
  - The row's `ReasonCaption` stays above the row; on TV it is focusable with ▲ from the row and OK opens the inline "Why am I seeing this?" list.
- **Rows** below the tile: same data and order as today's home rows. Cards are 16:9, sized so about 6.5 fit in the content width (the 7th peeks). Continue Watching cards show the progress bar.
- **Categories row**: large tiles from the existing category list, after the first three rows.
- **Movement**: ◀/▶ along a row (focused card scrolls into view with `scrollIntoView({inline:'nearest'})` semantics, smooth). ▼/▲ change row; the focused row sits directly under the focus tile and the rows scroll vertically under it. ▲ from the first row goes to the tile's buttons.
- OK opens the detail page; long-press OK opens the action sheet (from #229).
- Removed on TV: hero carousel, row arrows, hover previews, card overlay buttons.

## 3. Detail page

- `DetailView` gets a third variant `tv` (next to `page` and `modal`), chosen by the item route in TV mode. Same loads.
- No scrolling. Full-screen backdrop fading to the left. The existing trailer preview plays in the backdrop on TV too (same rules as on the focus tile). The "preview starts the title" countdown stays off on TV. Left column (~40% wide): title logo, meta line + quality chip, tagline, 3-line synopsis, one "With: A, B, C" line, resume line.
- **Vertical button list** (each ≥ 56 px, first focused on open):
  1. Play / Resume
  2. Restart (only with progress)
  3. Episodes & seasons (series)
  4. Trailer (if any)
  5. More like this
  6. My List (toggle, shows state)
  7. Rate (thumbs; existing `RatingButton`)
  8. Audio & subtitles (existing `LangPick`)
  9. Collection / Extras / Story so far (only if present)
  10. More info
- Sub-screens are routes so Back and history work: `/item/[id]/episodes`, `/item/[id]/more`, `/item/[id]/info`, `/item/[id]/extras`, `/item/[id]/collection`, `/item/[id]/story`. Trailer plays in the player. Back returns to the detail page with focus on the button that opened it.
  - Episodes: seasons list left, episode list right (16:9 still, name, length, 2-line synopsis, progress). ◀/▶ switch column. Next-up episode focused on open.
  - More like this / Collection / Extras: card grid. More like this uses the same recommendation data as today's detail page, with each card's reason in the focus area when focused.
  - More info: full cast, details tab content, ratings line.
- Hidden on TV: friends strip, comments, download, share. Back on the detail page goes to the previous page (not the rail).

## 4. Player menus

- Existing TV keys stay (OK play/pause, ◀/▶ seek with hold acceleration, wheel ±10 s, Channel ▲ next).
- ▼ while the control bar is visible opens a **bottom panel** with tabs: Episodes (series only) · Audio & subtitles · Speed · Quality. ◀/▶ on the tab strip switch tabs, ▼ enters the tab.
  - Episodes: horizontal row of 16:9 stills of the current season; OK plays.
  - Audio & subtitles: two vertical lists side by side, items ≥ 56 px; OK applies at once.
  - Speed / Quality: vertical list, same behaviour.
- The panel replaces the TV use of the popup menus (`menu` state); desktop keeps the popups.
- Back closes the panel, then the bar, then leaves the player.
- Skip intro / Next episode stay large buttons bottom right; when shown they take focus once.
- The panel counts as "menu open" for the auto-hide timer.

## Testing

- Recommendation engine: TV home shows the same row keys in the same order as desktop for the same `/api/home` response; reco impressions/clicks are still reported per row and engine; the focus tile shows the focused title's reason.
- Unit tests for the pure parts: rail open/close state machine, focus-tile debounce, row focus position, detail button list builder (which buttons for which item), player panel tab/back order.
- Playwright `webos.spec.ts` (TV mode via the LG marker) and a `?tv=1` desktop run: rail open/close with ◀/Back, OK on a rail item navigates, focus tile changes after resting on a card, ▼ moves rows, detail button list order and sub-screen Back, player ▼ opens the panel and Back order.
- Visual check screenshots at 1920×1080 for home, detail, episodes, player panel.
- No regressions: existing desktop/phone e2e suites stay green.

## Out of scope

- Vertical video feed (phone-only pattern).
- Tizen/Android-TV-specific shells beyond inheriting `html.tv`.

Both media servers (Jellyfin and Plex) live in this one codebase, so the redesign covers both; nothing is ported separately.
