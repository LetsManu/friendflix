# Phone browse redesign (glass tab bar, swipe carousel, preview sheet, phone detail, search)

Date: 2026-11-08 · Status: approved by the owner (mockup "Phone browse", direction C)

## Goal

Give the phone layout the same finish as the redesigned desktop (blocks 1 and 2) and TV: an app-like home with a swipe carousel of recommended titles, a floating glass tab bar, a preview sheet, a reworked phone detail page and search. Block 3 of 4 (desktop browse, desktop player, **phone browse**, phone player); merges to main on its own, released with v3.0.0 after all four blocks.

Owner choices (2026-11-08): home direction C (swipe carousel); tab bar Home / New / My list / Downloads with the profile as the avatar top right; carousel moves only when swiped (no auto-advance); no automatic trailer on the phone home.

## Constraints

- Phone layout only (`$mobile`). Desktop, TV, kids UI and admin render exactly as today.
- Own look: coral `#ff4f6d`, FriendFlix logo, Inter. Never another streaming service's name in user-facing text.
- The recommendation engine stays in charge: carousel picks, row order, reco tags, reason lines and match score come from today's data. No backend change.
- Animate only `transform` and `opacity`; springs and the frame guard from the shared motion system (`#lib/tv/motion`); reduced motion and calm mode switch instantly; blur only where `motionLevel()` is full.
- Touch targets at least 44×44 px; safe areas respected (notch, home indicator); no horizontal page scroll.
- Accessibility: tab bar is a `nav` with `aria-current`; carousel is a labelled region whose cards are reachable by screen reader and keyboard (arrow keys), with a live "n of 5" announcement; the sheet is a modal dialog with focus trap, Esc and a close button.
- i18n: every new string in all seven locales (en, de, pl, es, fr, it, tr).

## 1. Top bar, chips and tab bar

- **Top bar:** logo (links Home), Cast (where available, as today), Search, profile avatar with the unread dot (opens `/me`, as the "Me" tab did). Transparent over the hero, glass (dark fill + blur) after 30 px of scroll.
- **Chips** under the top bar: Series, Movies, Categories (today's category sheet, restyled as a bottom sheet). They slide up and fade out while scrolling down (after 90 px) and return on any scroll up.
- **Tab bar:** floating glass pill 14 px from the sides and above the home indicator: Home, New, My list, Downloads (icon + label). A highlight springs to the active tab. Downloads only where downloads are allowed for the user/device; otherwise three tabs. Pages that today show the tab bar keep it; the player and the profile picker do not.

## 2. Home: swipe carousel

- Five poster cards (2:3, rounded 18 px, shadow) picked by the recommendation engine: today's hero/billboard title first, then new seasons and recently added titles from today's fresh labels that the engine ranks for this profile; fewer than five when fewer qualify (minimum one; one card shows without dots).
- The centred card is large (≈70% of the width), its neighbours peek at both sides smaller (scale .86) and dimmer. Swiping or dragging follows the finger; release past 50 px or with a flick moves one card on a spring; otherwise it springs back. No auto-advance.
- Behind the carousel a soft glow in the centred poster's colours (taken from the poster image, crossfading on change); without a usable colour a neutral dark glow.
- Each card shows eyebrow (fresh label), title logo or name, and genres. Under the carousel: dots, then Play/Continue and My list for the centred card. A tap on the centred card opens the preview sheet; a tap on a side card centres it.
- No automatic trailer on the phone home.
- **Rows** below: same rows and order as today (Continue watching with progress and next episode, Top 10 with large outlined numbers, reco rows with their reason line, hubs, themed lists), styled per the mockup (poster rows 2:3, Continue watching 16:9 with progress bar).

## 3. Preview sheet

- A tap on a poster opens a bottom sheet that springs up over a dimmed page: reason line ("Because you watched …") when present, poster, title, year · age · seasons/length, three-line synopsis, close button; Play/Continue and Download (where allowed); My list, Rate, Share, Details.
- Drag down past 90 px or tap the dim to close; drag up or Details opens the detail page (View Transition from the sheet poster where supported, else crossfade).
- Replaces today's `MobilePreviewSheet` look; same data and actions.

## 4. Detail page (phone)

- Backdrop at the top (16:9-ish, ~300 px) with back and Cast buttons on glass circles; below it: eyebrow, title logo or name, meta line (match score, year, age, seasons/length, quality), a full-width Play/Continue S·E button and Download S·E (where allowed), synopsis (3 lines, "More" expands), cast line, then My list / Rate / Share.
- Tabs: Episodes (season picker, episode rows with thumbnail, progress, synopsis), More like this, Extras, Details; tabs only when they have content; coral underline slides between tabs, panel crossfades.
- A trailer may play in the backdrop only under today's rules (`autoplayAllowed`, Wi-Fi/no Save-Data, not calm, not reduced motion), muted.

## 5. Search (phone)

- Rounded search field at the top (focus on open); before typing: "Popular here" rows (16:9 thumb, title, play button) and genre tiles coloured from their artwork; typing searches live as today.

## Motion

- Carousel and sheet use springs (`--m-spring` / spring helpers); chips and top bar 250–300 ms ease-out; tab highlight spring. Frame guard on (desktop budget). Reduced motion and calm: no springs, instant changes.

## Testing

- Unit (vitest): carousel pick selection (order, dedupe, cap 5, minimum 1), swipe decision (threshold, flick, bounds), chips tuck/untuck state, tab list with/without downloads.
- E2E (Playwright, mobile project): tab bar items and active state, Downloads hidden when not allowed; chips tuck on scroll down and return on scroll up; carousel swipe moves one card and updates dots and buttons; a tap opens the sheet, drag/close closes it, Details opens the detail page; detail tabs; search before typing and live results; desktop, TV and kids unchanged.
- Tests are written with the code; CI runs them (owner rule). Coverage thresholds stay.

## Out of scope

- Phone player (block 4), desktop, TV, kids, admin.
- Backend or API changes, new recommendation logic, auto-advancing carousel, phone home trailers.
