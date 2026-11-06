# TV layout redesign (side bar, focus tile, button-list detail, player panel)

Date: 2026-11-06 · Status: draft for owner review

## Goal

Make FriendFlix comfortable on a TV with a D-pad remote (LG Magic Remote 2025, Samsung, Android TV via the web shell, `?tv=1` preview). Today the TV UI is the desktop UI scaled up: a top bar, a hero carousel, small rows, a long scrolling detail page, small player popup menus. The owner asked for the layout pattern current TV streaming apps use (the 2026 side-bar layout), built generically in FriendFlix's own look.

## Constraints

- Applies only in TV mode (`html.tv`, set by `+layout.svelte`). Desktop, phone, kids UI and admin do not change.
- Own look: FriendFlix colours, logo and type. No other service's names, logos or red-on-black branding. Never "Netflix" in user-facing text.
- Safe area: 96 px left/right, 54 px top/bottom at 1080p (scale with `vw`/`vh`).
- Text ≥ 28 px at 1080p for body copy on TV; focus targets ≥ 54 px tall.
- Exactly one focused element. Focus = `scale(1.08)` + 3 px white ring. Nothing else changes on focus.
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

## 4. Player

- **Controls layout:** top left ← Back + title (series: "S2 E4 · episode name"). Bottom: wide progress bar with chapter marks and remaining time on the right ("−23:41"). Under it a row of labelled icon buttons (each ≥ 56 px): Episodes (series) · Next episode (when there is one) · Audio & subtitles · Speed · Quality. Bar and row slide in from below, title fades in (transform/opacity only). Controls hide after 5 s (existing `hideMs`).
- **Seek preview:** with focus on the progress bar, ◀/▶ do not seek at once; they move a preview marker with the trickplay thumbnail (`trickFrame`) and the target time above it (hold acceleration 10 → 30 → 60 s from #229). OK or 1 s without a key commits the seek; Back cancels and keeps the position. Video keeps playing meanwhile. Without trickplay: time + chapter name only. Wheel ±10 s and Channel ▲ keep their direct behaviour.
- **Keys:** OK while playing = play/pause (as now). Any arrow while playing shows the controls with focus on the progress bar. ▼ from the bar goes to the button row, ◀/▶ along it, OK opens:
  - Episodes: full-screen overlay, seasons list left, row of 16:9 episode stills right (with progress), current episode focused.
  - Audio & subtitles: two vertical lists side by side, OK applies at once.
  - Speed / Quality: small vertical list above the button.
  - Next episode: plays it.
- **Back order:** open menu → seek preview → controls → leave the player.
- **Pause screen:** after 8 s paused without a key, the picture dims and a block shows on the left: "You're watching", logo or title, S/E, 3-line synopsis. Any key returns to the normal controls. Calm mode: no dimming, no block.
- Unchanged: Skip intro / recap big buttons bottom right (take focus once when shown, OK presses), post-play screen, X-ray cast info (blue key while paused on TV).
- The green key opens Audio & subtitles. The popup menus stay for desktop; on TV the row + overlays replace them.

## 5. Visual design (TV only)

Close to current TV streaming apps in layout, feel and motion; brand elements stay FriendFlix's own.

- Background `#000` (`--bg` under `html.tv`), strong black gradients on the left and bottom of every backdrop.
- Focus: 3 px white ring + `scale(1.08)` (replaces the coral ring on TV).
- Buttons: primary (Play) solid white with black text; secondary semi-transparent grey (`rgba(109,109,110,.7)`) with white text; 4 px radius, not pills; ≥ 56 px tall.
- Type: Inter 800 with tight letter spacing for titles; row titles white, bold, ~1.5rem, aligned with the first card's edge.
- Cards: 4 px radius, no shadow, no frame; only the focused card grows.
- Eyebrow above the title logo: "SERIES" / "FILM" in spaced capitals, no brand symbol.
- Card labels ("New episode", "Top 10") as a small block on the bottom edge in coral (`--acc-fill`).
- Progress bars thin, coral.
- Rail: white/grey icons, active page marked with a coral dot; expanded state is a black gradient over the content, not a panel.
- Motion: 200–250 ms ease-out; focus scale and crossfades only; no bounce.
- Stays own: coral accent `#ff4f6d` (not another service's red), FriendFlix logo, no letter-mark above titles, Inter font, no intro sound, no other service's name.


### 5.1 Polish tokens (owner: "more high quality, less AI-designed")

Concrete values at 1080p (scale with the existing `html.tv` root size). These replace looser wording above where they differ.

- **Gutter:** content starts 56 px right of the rail (rail 96 px + 56 px = 152 px from the screen edge). Text, row titles and the first card share this left edge. Vertical rhythm on an 8 px grid: row title → cards 16 px, row → row 48 px.
- **Type scale (Inter):**
  - Display (title when no logo): 64 px / 700 / −0.02 em / line-height 1.05; max 2 lines.
  - Row title: 26 px / 600 / 0 / 88 % white. No all-caps.
  - Meta line: 22 px / 500 / tabular numbers / `--mut` (#b3bac2); separators are thin middle dots in 40 % white with 10 px spacing. The age rating is a 1 px outlined box, not bold text.
  - Synopsis: 24 px / 400 / line-height 1.45 / 78 % white / max 46 ch / 3 lines.
  - Labels on cards and in the tile: 15 px / 600 / letter-spacing .02 em.
  - Eyebrow: only when it says something (e.g. "New season", "Top 10 · #3", "Recently added"); 15 px / 600 / letter-spacing .12 em / uppercase / coral. No generic "FILM"/"SERIES" eyebrow.
- **Title logos:** prefer the title logo image; max 520 × 160 px, left-aligned, bottom-aligned to the meta line.
- **Buttons (TV):** unfocused = translucent `rgba(255,255,255,.14)` with white text and icon; focused = solid white with black text and `scale(1.05)`. Focus on buttons is shown by the fill change, not by a ring. Height 56 px, radius 6 px, 28 px horizontal padding, 22 px / 600 text, 12 px icon gap, 12 px between buttons.
- **Cards:** radius 6 px; no border; image covers fully. Focus = `scale(1.08)` + `box-shadow: 0 0 0 3px #fff, 0 18px 40px rgba(0,0,0,.55)` (ring follows the radius, no outline offset). Burned-in title text under the image only when there is no image; otherwise rely on the artwork. Progress bar: 4 px, coral on `rgba(255,255,255,.22)`, inset 10 px from the card's bottom/left/right, radius 2 px.
- **Backdrop:** 72 vw wide, anchored right/top. Left fade `linear-gradient(90deg, #000 0%, #000 18%, rgba(0,0,0,.82) 34%, rgba(0,0,0,.35) 58%, rgba(0,0,0,0) 78%)`; bottom fade `linear-gradient(0deg, #000 0%, rgba(0,0,0,.6) 22%, rgba(0,0,0,0) 48%)`; a soft top vignette `rgba(0,0,0,.35)` → 0 over the first 20 %. No hard edges anywhere.
- **Rail:** icons 26 px, stroke 1.75, inactive 55 % white, active 100 % white + 6 px coral dot centred 14 px left of the icon. Expanded labels 22 px / 500. Avatar 40 px.
- **Motion:** focus 180 ms `cubic-bezier(.2,.8,.2,1)`; tile crossfade 280 ms; row slide 320 ms ease-out; exits ~70 % of enter. One moving thing at a time; reduced motion = no scaling, instant swaps.
- **Placeholders:** loading cards use a flat `#141414` block with a 1.2 s opacity pulse (no shimmer gradient); missing artwork shows the title in 20 px / 600 on `#1a1a1a`.
- **What reads as "AI-designed" and is not allowed:** wide-tracked generic eyebrows, bold-everything text blocks, thick outlines on buttons, hard gradient seams, uniform heavy weights, emoji, gradient-text, glows.

## Testing

- Recommendation engine: TV home shows the same row keys in the same order as desktop for the same `/api/home` response; reco impressions/clicks are still reported per row and engine; the focus tile shows the focused title's reason.
- Unit tests for the pure parts: rail open/close state machine, focus-tile debounce, row focus position, detail button list builder (which buttons for which item), player seek-preview state machine, player Back order, pause-screen timing.
- Playwright `webos.spec.ts` (TV mode via the LG marker) and a `?tv=1` desktop run: rail open/close with ◀/Back, OK on a rail item navigates, focus tile changes after resting on a card, ▼ moves rows, detail button list order and sub-screen Back, player seek preview (◀ moves the marker, Back cancels, OK commits), button row and overlays, Back order, pause screen after 8 s.
- Visual check screenshots at 1920×1080 for home, detail, episodes, player panel.
- No regressions: existing desktop/phone e2e suites stay green.

## Out of scope

- Vertical video feed (phone-only pattern).
- Tizen/Android-TV-specific shells beyond inheriting `html.tv`.

Both media servers (Jellyfin and Plex) live in this one codebase, so the redesign covers both; nothing is ported separately.
