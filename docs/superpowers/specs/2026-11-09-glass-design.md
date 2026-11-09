# Glass redesign (frosted surfaces, artwork tint, hover card fix, search sheet, motion set)

Date: 2026-11-09 · Status: approved by the owner (mockup "FriendFlix Glass" with the screens Home, Hover card, Detail, Menus & toast, Settings, Search; live demo "FriendFlix Glass Motion" with the nine effects in §8)

## Goal

Give the whole web app one material: milky, matte frosted glass with a fine grain, a light edge and soft deep shadows, over the colours of the artwork. Desktop, phone and the admin panel use it. The desktop hover card gets a fixed size and always fits on screen. Desktop search opens a results sheet below the top bar. A small set of effects (§8) gives the glass light, depth and feedback, so it feels better than other streaming apps without getting busy. Calm mode, reduced motion, slow machines and TVs get solid panels with the same shapes.

Owner choices (2026-11-09): the approved look is the mockup's tokens (§1). Play stays solid white as the single primary action. Every other button is a glass pill or circle. Search grows inside the top-bar pill and drops one frosted sheet below it. The admin panel gets the same cards and controls, denser. Effects: exactly the nine in the live demo (§8), each with a clear purpose.

## Constraints

- Animate only `transform` and `opacity`. Two exceptions, both tiny and paint-only: the `stroke-dashoffset` of the toast countdown ring (28 px) and of the drawn save checkmark (20 px), and the text colour of a selected tab or segment label (250 ms). Changing the sliding pill's width is not animated: it is built from three parts moved by transforms (§8.4).
- Use the shared motion system (`#lib/tv/motion`): springs and curves, the frame guard (`DESK_GUARD` on desktop and phones, `TV_GUARD` on TV), `motionLevel()`, calm mode and reduced motion. The new curves live there too.
- **Fallbacks.** Calm mode or reduced motion (`!motionAllowed()`, `html.m-still`): solid dark panels instead of glass (no blur, no grain), no effects, state changes at once. Blur only where `motionLevel() === 'full'` (`html.m-glass`). When the frame guard trips, `html.m-glass` drops and every surface becomes solid for the rest of the session.
- Opening and closing animations always run, in full motion and in the reduced set (the frame guard tripped: opacity only, 160 ms). Nothing is unmounted mid-way. Only calm mode and reduced motion switch at once, because the person asked for that.
- **TV** (`html.tv`): solid panels with the same shapes. No backdrop blur and no grain (the existing `html.tv` rule already removes `backdrop-filter`). No pointer effects.
- **Kids UI** keeps its look. Shared components on a kids profile (toasts, menus) use the solid fallback with the new shapes.
- Own look: coral `#ff4f6d`, FriendFlix logo, Inter. Never another streaming service's name or a look-alike of one.
- **Contrast.** White text on glass meets WCAG AA (4.5:1), also over bright artwork. A dark scrim layer is part of every text-bearing glass surface. Over the dark ambient app background it is light (`.2`), which keeps the milky look and passes AA by far. Where bright content nobody sampled can sit behind (artwork, video) the surface takes the safe scrim `.70` (`.frost-safe`), which passes over pure white. Over sampled artwork the maths picks the scrim (§1.3).
- Touch targets are at least 44×44 px. Every new or changed string exists in all seven locales (en, de, pl, es, fr, it, tr), with `de` as the type source.
- **Owner rules.** Implementers write the tests and CI runs them. Implementers run the root `npm run typecheck`. Web vitest coverage stays at statements 94 % and branches 89 %, and every `web/src/**/*.ts` file counts, so pure helpers live in fully tested `.ts` files. Every commit ends with the two trailer lines (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`).

## 1. Material

### 1.1 Tokens (`app.css`, `:root`)

| Token | Value | Use |
|---|---|---|
| `--fr-milk` | `236, 232, 244` | milk colour (rgb triple); tinted per surface (§1.3) |
| `--fr-milk-a1` / `--fr-milk-a2` | `.13` / `.19` | bottom / top alpha of the milk gradient |
| `--fr-line` | `rgba(255,255,255,.2)` | 1 px border |
| `--fr-hi` | `rgba(255,255,255,.28)` | inner top highlight (`inset 0 1px 0`) |
| `--fr-blur` | `blur(38px) saturate(115%) brightness(1.05)` | backdrop filter |
| `--fr-scrim-rgb` / `--fr-scrim` | `18, 16, 24` / `.2` (`--fr-scrim-light`) | dark scrim under the milk; light over the dark ambient base (owner ruling 2026-11-09) |
| `--fr-scrim-safe` | `.70` | the heavy scrim (`.frost-safe`) over unsampled artwork or video; passes AA over pure white |
| `--fr-grain` | the mockup's 160 px `feTurbulence` SVG data URI | matte grain (`img-src` allows `data:`) |
| `--fr-grain-a` | `.22` | grain opacity (`mix-blend-mode: overlay`) |
| `--fr-shadow` / `--fr-shadow-card` | `0 18px 50px rgba(0,0,0,.35)` / `0 10px 30px rgba(0,0,0,.35)` | surfaces / artwork cards |
| `--fr-solid` | `#1c1a21` | the solid fallback fill |
| `--fr-sel` | `rgba(255,255,255,.13)` | selected row / light pill |
| `--fr-r-card` 12px · `--fr-r-tile` 18px · `--fr-r-menu` 20px · `--fr-r-hover` 22px · `--fr-r-panel` 24px · `--fr-r-sheet` 26px · `--fr-r-pill` 999px | | radii |

Curves (in `#lib/tv/motion` and as CSS tokens): `GLASS_SPRING = cubic-bezier(.34,1.56,.64,1)` (`--fr-spring`), `GLASS_OUT = cubic-bezier(.22,1,.36,1)` (`--fr-out`), `GLASS_IN = cubic-bezier(.4,0,1,1)` (`--fr-in`).

### 1.2 Classes

- `.frost` is a glass surface. It has `position: relative`, `isolation: isolate` and the border. Its background is the milk gradient (`rgba(var(--fr-milk), var(--fr-milk-a2))` → `a1`) over `rgba(var(--fr-scrim-rgb), var(--fr-scrim))`. Its shadows are `inset 0 1px 0 var(--fr-hi), var(--fr-shadow)`. The grain sits on `::before`. With `html.m-glass:not(.tv):not(.kids)`, `backdrop-filter: var(--fr-blur)` applies.
- **Solid fallback** applies to `.frost` when `html` lacks `m-glass`, or has `tv` or `kids`. The background becomes `var(--fr-solid)`, `backdrop-filter` is none, and `::before` is hidden. Border, highlight, radius and shadow stay.
- `.frost-flat` is the glass look without `backdrop-filter`. It is for static cards over the still ambient background (settings, admin), where blur would look the same and cost a lot.
- Shape modifiers: `.frost-pill`, `.frost-card`, `.frost-tile`, `.frost-menu`, `.frost-panel`, `.frost-sheet` (radius tokens).
- `.frost-btn` is a glass pill (min-height 44 px, padding 0 20 px, 800 weight). `.frost-btn.round` is a 44 px circle. `.frost-sel` is the selected light pill.
- `.frost-dim` is the page dim behind a sheet: `rgba(8,7,11,.45)`, faded by opacity.
- `.frost-amb` is the still ambient background for pages without artwork. It is fixed, sits behind the page, and uses three radial gradients (coral, warm orange, violet at the demo's alphas). It is never animated.

### 1.3 Contrast and artwork tint

- `tone.ts` computes the composite a person sees behind white text, in the painted order: backdrop (brightened by the blur's `brightness(1.05)`, clamped) → scrim (`--fr-scrim-rgb` at alpha `s`) → milk (`--fr-milk` at `.19`, the lighter top) → tint wash (tint colour at its peak alpha `.5`, §8.2). `scrimFor(bright, tint)` returns the smallest `s` in `.20….80` (steps of .02) for which white has a contrast of at least 4.5:1, both with the tint and without it (the wash fades out towards the far corner). The input `bright` is the mean of the brightest 10 % of the sampled pixels, so highlights count. A dark backdrop gets the light `.20`, pure white `.70`.
- **Scrim model (owner ruling 2026-11-09).** Surfaces over the dark ambient app background keep the light scrim `.2` (`--fr-scrim` default): white text has 12:1 over the base `#0a090d` and 5.7:1 over the ambient's brightest glow. Surfaces where bright, unsampled content can sit behind them (artwork, the billboard, video) add `.frost-safe` (`.70`). Surfaces over sampled artwork set the computed scrim inline (`toneVars`), which wins over both. Hover states never add milk over the same scrim (that drops white text under AA); glass buttons light their edge instead.
- The tint colour is the sampled artwork colour, kept to the same hue and darkened to a relative luminance of at most .18. With that limit, a solution always exists.
- Tone is applied only to surfaces over known artwork: the hover card, the detail info panel and the phone preview sheet. Every other surface uses the light default over the ambient background, and `.frost-safe` wherever it can sit over artwork or video (the top bar and search sheet over the billboard, menus and toasts on detail pages and over the player, phone sheets).
- Samples are taken from same-origin images on a 24×24 canvas. They are cached per item id (up to 32 entries), so the detail page reuses what the hover card sampled.

## 2. Top bar and search (desktop)

- The bar keeps its structure: the logo on the left, the pill in the middle, bell and avatar as round buttons on the right. The pill's background halves (`.pbg .half i`) and the round buttons become glass (`.frost` look, blur by the `m-glass` rule). The scroll scrim stays. The active tab keeps today's sliding fill, restyled as `--fr-sel`. Pointer sheen (§8.1) is on the pill and the round buttons.
- **Search sheet.** Typing in the pill's field no longer navigates. It opens one `.frost.frost-sheet` (blurred) directly below the pill. It is centred on the pill, `min(940px, 100vw − 2·pad-x)` wide, with a 26 px radius and 22 px padding. The page behind dims (`.frost-dim`). The sheet grows from the pill (§8.3 curves, origin = the field). It has two columns:
  - Left: **Top results**: the first 3 of titles + episodes as rows with a 96×54 thumbnail, the title with the matched letters in coral (`<mark>`), and a meta line. Below them, **People**: up to 4 round avatars.
  - Right: **Titles**: up to 6 poster cards. Below them, **Browse by genre**: up to 8 genre chips (glass pills). Then an **All results** link to `/search?q=`.
  - Before typing (an open field with no text, or fewer than 2 characters), the same sheet and grid show **Recent searches** (chips, with Clear), **Popular here** (posters from `/api/library/trending`, left out on kids profiles) and the genres. Starting to type does not move the layout.
- Results come from `/api/search?q=` (250 ms debounce, aborted when superseded; a late answer is dropped). They cascade in (§8.6) when the result set changes.
- **Keyboard.** The field is a combobox. ↓ and ↑ move through the top results and All results (`aria-activedescendant`). Enter opens the active hit, or `/search?q=` when there is none. Esc with text clears it. Esc on an empty field closes the sheet and the field (today's two steps). A click outside or on the dim closes the sheet. The window losing focus keeps it open.
- On `/search` itself the sheet never opens: the pill drives the page as today. Phones keep their `/search` page; its glass changes are in §6.

## 3. Hover card (desktop)

- **Fixed size.** Width = `min(clamp(round(0.43 × window width), 560, 720), window width − 24)`, whatever card it opened on (16:9, poster-only or Top 10 poster). The picture keeps a 16:9 frame on top (height = width × 9/16). The text part below grows with its content. The synopsis is clamped to 3 lines and the reason line to 1, so the card always fits.
- **Placement.** The picture is centred on the card. The card is clamped horizontally and vertically so the whole box is inside the window with a 12 px margin. If even that does not fit (a short window), the width shrinks so that picture plus text fit, but never below 560 px. Hover cards need a window at least 600 px tall (`HOVER_MIN_HEIGHT`). Below that the card opens the detail page on click, as it does on touch.
- The box is measured before it shows: it renders hidden at its width, the text height is read, then it is placed.
- The whole card is `.frost` with radius `--fr-r-hover` (22 px), blurred, with the sheen (§8.1). The tone comes from the card's own artwork, sampled while the pointer rests (§1.3), and is applied before the card shows. Play is a solid white circle. My list, rating, more and ⌄ are glass circles (44 px). The meta line, episode line, synopsis and reason (coral) sit below.
- **Open and close.** It grows out of the card (today's FLIP, 260 ms `EMPH_OUT`). Closing (Esc, scroll, resize, pointer leaving, window blur) shrinks back towards the card, 180 ms with the `GLASS_IN` curve, with opacity. The card keeps it mounted until that ends. A new open during a close finishes the close at once. Navigating to the detail page keeps today's morph.
- Poster tilt (§8.7) runs during the 500 ms rest and settles back when the card opens.

## 4. Detail page

- **Desktop (`DetailDesk`).** Eyebrow, title, facts, ratings line, synopsis, actions and resume line sit on one `.frost.frost-panel` (radius 26 px, padding 28 px, width as today's column), blurred over the backdrop. The panel uses the tone of the backdrop: the cached tone for the item, or one sampled from the backdrop once it loads. If the panel is already visible when the tone arrives, the tint crossfades in (§8.2) and the scrim stays at the safe default. Play stays a solid white pill. Every round button becomes a 44 px glass circle with the sheen. The auto-start countdown box becomes a glass pill.
- **Tabs.** A glass segmented bar (`.frost.frost-pill`, padding 6 px) replaces the hairline and underline. The active tab has a sliding white pill (§8.4) with dark text. Arrow-key behaviour stays.
- **Episodes.** Each episode row is a `.frost-flat.frost-tile` (radius 18 px, padding 12 px) with its thumbnail (10 px radius) and coral progress.
- **Phone and modal (`DetailView`).** The sticky tab row becomes the same glass segmented bar with the sliding pill, and episodes become glass tiles. The info area keeps its layout.

## 5. Menus, popovers and toasts

- `.frost.frost-menu` (radius 20 px, padding 8 px, rows 44 px with a 12 px radius) applies to: the profile, bell and categories menus in the top bar, `MoreActions` (`.pop`), `ListMenu` (`.lm-pop`), `RatingButton`'s pill and `ui/ActionMenu`. The selected or pressed row is a `--fr-sel` light pill. Separators are 1 px `rgba(255,255,255,.1)`.
- They all open and close with §8.3. The origin is the trigger's centre relative to the popover. On phones the bottom-sheet variants become `.frost.frost-sheet` (top corners 26 px) and slide up with `GLASS_SPRING`.
- **Toasts** become `.frost.frost-pill`, centred at the bottom on every layout (desktop: 36 px from the bottom; phone: above the tab bar, as today). Each has a status dot (10 px with a glow; success `--ok`, error `--err`, info `--info`), the message, the action and ✕. A toast with an action shows the countdown ring (§8.5) next to its action. The default duration for a toast with an action becomes 5 s.

## 6. Settings, /me, secondary pages and phone surfaces

- Pages without artwork that are not the player, TV, kids or full-screen pages get `.frost-amb` behind them. The global `.panel` becomes `.frost-flat` (radius `--fr-r-panel`, padding 22 px 24 px).
- **Settings.** At 1100 px and wider, a sticky `.frost-flat.frost-panel` side navigation (260 px) lists the page's sections by their existing headings: language, app, the main settings form, recommendations, intro, notifications. A sliding light pill (§8.4) marks the section in view (scroll-spy). Clicking scrolls to the section. The checkbox rows become switches (46×28 track, coral when on, knob moved by `translateX`, `GLASS_SPRING` 300 ms; still a real checkbox for forms and tests). Selects get a 12 px radius on the glass fill. Save shows the drawn checkmark (§8.8). The calm-mode hint says that panels turn solid.
- **/me.** The quick tiles, notifications list and grouped lists become `.frost-flat` cards. Rows get a 12 px radius on hover.
- **Phone.** The tab bar (`TabBar`), the phone header background (`.mbg`), the carousel's glass buttons, `MobilePreviewSheet` (a `.frost-sheet` with the poster's tone) and the `MoreActions` sheet use the material. Buttons and cards in these places get the press feedback (§8.9). The phone `/search` page uses glass chips and glass genre tiles; it keeps its own field.

## 7. Admin panel

- `AdminShell`: the sidebar is a `.frost-flat.frost-panel` with a sliding light pill on the current entry, replacing today's coral bar. The phone list (`.plist .lst`) and `.panel`, `StatTile`, `DataTable`, `Toggle`, `StatusPill` and `Field` inputs take the glass look, **denser**: 16 px card radius, padding 16 px 18 px, rows 40 px (44 px on coarse pointers).
- `StatTile` numbers count up the first time they come into view (§8.8). Admin save buttons (`ui/Button` with `done`) draw the checkmark.

## 8. Gimmicks & motion (the approved live demo, exactly)

Every effect is off in calm mode, with reduced motion and on TV. In the reduced set (frame guard tripped), effects that only decorate are off, and opening and closing become opacity crossfades (160 ms). Pointer effects need a fine pointer.

1. **Light sheen.** *Purpose: the glass reads as a physical surface and shows what is under the pointer.* This is a 240 px circle (`radial-gradient(closest-side, rgba(255,255,255,.35), rgba(255,255,255,.08) 55%, transparent)`, `mix-blend-mode: soft-light`). It is translated to the pointer inside the surface and fades in or out with opacity in 300 ms on enter and leave. It is on the hover card, the top-bar pill and its round buttons, the detail panel and glass buttons (`.frost-btn`).
2. **Artwork-tinted glass.** *Purpose: the UI takes the colour of the title it shows.* There are two stacked tint layers inside the surface, each `radial-gradient(120% 120% at 0% 100%, <tint>, transparent 70%)`. On a tint change, the back layer gets the new gradient and fades to opacity .5 while the front fades to 0, over 600 ms with `GLASS_OUT`. It is on the hover card (applied before it shows), the detail panel (when the backdrop's tone is known) and the phone preview sheet.
3. **Menus grow from their button.** *Purpose: a spatial link between the button and what it opened.* On open, scale .4 → 1 and opacity 0 → 1 over 380 ms with `GLASS_SPRING`. On close, the reverse over 200 ms with `GLASS_IN`. `transform-origin` is the trigger. Esc and a click outside close it with the reverse animation. The search sheet uses the same curves.
4. **Sliding selection pill.** *Purpose: shows where the selection came from.* The pill glides to the picked tab or entry over 450 ms with `GLASS_SPRING`, both its position and its width. The width is made of a left cap, a middle part scaled on X and a right cap, all moved by transforms, so it looks like the demo's width change without animating width. It is on the detail tabs, segmented controls, settings side navigation, admin sidebar and the categories `.seg`. The label colour switches in 250 ms (the named exception).
5. **Undo with a countdown.** *Purpose: shows how long Undo stays.* The toast rises in (translateY 140 % → 0 plus opacity, 420 ms `GLASS_SPRING`) and slides out (260 ms `GLASS_IN`). The 28 px SVG ring (r 11, dash 69.1, coral on `rgba(255,255,255,.2)`) runs `stroke-dashoffset` 0 → 69.1 linearly over the toast's duration (5 s). It pauses while the pointer or focus is on the toasts, and continues from the time left.
6. **Search results cascade.** *Purpose: guides the eye down the list as results arrive.* Each result row, person, poster and chip goes translateY 10 px → 0 and opacity 0 → 1 over 320 ms with `GLASS_OUT`, 45 ms apart. This runs when the result set changes, not on every keystroke. Matched letters are coral.
7. **Poster tilt and glint.** *Purpose: makes the rest before the hover card feel alive, and shows which card it will open on.* This applies to desktop row cards (16:9 and posters). Each frame, the card moves toward its target by 0.16 of the distance. The tilt is up to 9°, rotateX/rotateY toward the pointer, with perspective 650 px on the wrapper. It lifts −6 px and scales to 1.06. A separate blurred shadow below shifts opposite to the tilt (`translateX(−tiltY × 1.2 px)`, scale .9 − .12 × lift). A 220 px glare circle follows the pointer (soft-light). A 105° light band shifts with the tilt (`translateX(tiltY / 9 × 22 %)`). The caption or logo floats at `translateZ(28px)`. Sibling cards in the row step back (opacity .62, scale .97, 350 ms `GLASS_OUT`). On leave, everything eases back the same way. The loop stops when it settles (sum of differences < .01) and pulses the frame guard.
8. **Admin count-up and saved.** *Purpose: the overview feels live; a save is confirmed where the eye is.* Numbers count from 0 with an ease-out cubic over 1.1 s, the first time they come into view, in locale number format and tabular figures. This changes text, not CSS. A save button turns into "Saved" with a drawn checkmark (20 px path, dash 24, `stroke-dashoffset` 24 → 0 over 420 ms `GLASS_OUT`, `#1a8f4c` on white; the named exception) and returns to Save after 2.2 s.
9. **Phone press feedback.** *Purpose: a touch feels answered at once.* On press, glass and white buttons and cards scale to .92 over 80 ms and spring back over 350 ms with `GLASS_SPRING`. A ripple from the touch point grows from scale 0 to 1 while fading from .9 to 0 over 550 ms with `GLASS_OUT`. Its size is twice the larger side, `rgba(255,255,255,.35)`.

Other motion: the hover card's open and close (§3), the search sheet's open and close (§2) and the page dim (opacity 200 ms) follow the same rules.

## Testing

- **Unit (vitest).** In `tone.ts`: luminance, contrast, composite, tint limit, `scrimFor` (white backdrop needs ≥ .66; every result passes 4.5:1 or is .80), the sampling statistics, the tone cache and the canvas wrapper with doubles. In `pointer.ts`: sheen position, tilt targets and easing step, tilt styles, gates, and the actions with fake elements and rAF. In `fx.ts`: cubic-bezier, the grow transition config per mode, origin, pill parts, count-up values, ripple geometry. Also the hover-card box, the search marks and sheet model, scroll-spy, and the toast's time left. Coverage thresholds stay.
- **E2E (Playwright, desktop and mobile).**
  - Glass on with full motion. Solid with calm mode, reduced motion, a tripped frame guard and TV.
  - The hover card has the same width and picture height on a 16:9 card, a poster-only card and a Top 10 card. It is fully inside the window at all four edges in a short window. Its text is not clipped.
  - The search sheet's sections, marks, keyboard, Esc and outside click.
  - The detail panel, tabs pill and episode tiles. The contrast fallback over a pure white backdrop.
  - Menus open and close with animation, reversing mid-flight. The toast ring and its pause.
  - Settings side navigation and switches, calm mode turning surfaces solid at once.
  - Phone surfaces and press feedback. The admin shell, count-up and checkmark.
  - Kids and TV unchanged.
- Tests are written with the code; CI runs them (owner rule).

## Out of scope

- The players (desktop, phone, TV, kids): they already have their own glass pills from blocks 2 and 4.
- The TV layout beyond solid shapes. The kids UI.
- A light theme, backend or API changes, new pages.
- Moving the logo into the top-bar pill (the mockup draws it inside; the bar keeps today's three parts so the overlap rules and tests stay).
- Any animated colour, blur or size change beyond the named exceptions.
