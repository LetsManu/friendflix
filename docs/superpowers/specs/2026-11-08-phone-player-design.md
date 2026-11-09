# Phone player redesign (cinema dock, glass pills, panels above the timeline, pause screen, credits sequence)

Date: 2026-11-08 · Status: approved by the owner (mockup "Phone Player", direction A "Kino", with rotation and no-overlap rules)

## Goal

Give the phone player the look of the redesigned desktop player (block 2): a cinema layout with the title bottom left, a timeline with both times and two glass pills, in landscape (either way round) and portrait, with nothing overlapping. Block 4 of 4 (desktop browse, desktop player, phone browse, **phone player**); after it merges, v3.0.0 is released.

Owner choices (2026-11-08): direction A "Kino"; Play and ±10 s stay in the left pill (no extra centre controls); the phone can be turned either way and the UI and the timeline must never collide.

## Constraints

- Phone player only: the player's existing `phone` layout (coarse pointer, not TV), not the kids UI. Desktop, TV and kids players render exactly as today.
- Own look: coral `#ff4f6d`, FriendFlix logo, Inter. Never another streaming service's name in user-facing text.
- Every player feature stays (tracks, speed, quality, sound modes, subtitle search, scenes and bookmarks, cast & info, PiP, AirPlay, Chromecast, watch party, sleep timer, lock, error recovery, telemetry, the phone remote). No backend change.
- Gestures stay as today: double tap left/right third seeks with the cumulative ripple, vertical swipe brightness (left) / volume (right, not on iOS), horizontal swipe scrubs, lock with hold to unlock.
- Safe areas: all four `env(safe-area-inset-*)` sides; landscape with the camera cut-out left or right and portrait. Rotation re-lays out without a reload; nothing sits under the cut-out or the home indicator.
- Animate only `transform` and `opacity`; shared motion system (`#lib/tv/motion`), frame guard with `DESK_GUARD` budget; reduced motion and calm mode switch instantly; blur only where `motionLevel()` is full.
- Touch targets at least 44×44 px; i18n in all seven locales (en, de, pl, es, fr, it, tr) for every new string.
- New phone parts live in their own files under `web/src/lib/player/phone/`; `Player.svelte` only wires state into them.

## 1. Layout

- **Top bar:** ‹ back (glass circle) at the start; at the end the quality chip (as today), Cast/AirPlay where available, lock (glass circles).
- **Bottom dock:** one column with fixed gaps, top to bottom:
  1. Title block: current chapter as a coral uppercase eyebrow (when chapters exist), the series or film title (landscape 28 px / portrait 24 px, 900), then `S2 · F5 · Episode title` (episodes) or year · length (films). Landscape: at most 58 % of the width; a long title wraps upward, never over the timeline. The skip intro / recap button sits at the end of this row (landscape) or on its own row above the timeline (portrait).
  2. Timeline row: elapsed left, remaining (−mm:ss) right, tabular figures; coral progress, buffered range, chapter ticks; dragging shows today's thumbnail tip above the track and commits on release.
  3. Pill row: left glass pill −10 s, play/pause (large), +10 s; right glass pill tools. Landscape: next episode, episodes, audio & subtitles, speed, more. Portrait: episodes, audio & subtitles, more (speed and next episode move into more). Missing features drop their button (no next episode for films).
- The dock is laid out with flex column and `gap`, so title, skip, timeline and pills can never overlap whatever the title length, language or rotation. Its bottom padding is the home indicator inset plus 12 px; its sides are the side insets plus 16 px.
- **Portrait:** the picture is letterboxed in the middle of the screen; the top bar sits below the status bar inset, the dock at the bottom as above.
- **Hiding:** top bar, dock and scrims fade (opacity, 250 ms) after 3 s without a touch and return on a tap; they stay while paused (until the pause screen), while a panel is open and while scrubbing. Hidden: a 3 px progress line at the bottom edge (inside the safe area).

## 2. Panels

- Episodes, audio & subtitles, speed, scenes and more open as one glass card directly above the timeline row (its bottom edge = top of the timeline row + 8 px); the title block fades out while a card is open, so the card never covers the timeline or the pills. Landscape: the card is anchored to the side of its button's pill (right pill: end side, max 380 px wide, max height up to the top bar). Portrait: full width minus the side insets.
- A card grows out of its button (scale from the button's corner, spring); one at a time, switching crossfades; a tap outside, the button again or Back closes it. Playback continues.
- Episodes: season switcher, episode rows with thumbnail, progress and one-line synopsis, current one highlighted and scrolled into view. Audio & subtitles: two columns (landscape) or two sections (portrait). Speed, scenes, more: today's items.

## 3. Pause screen

- After 5 s paused (not in a watch party, not while casting, not with an error, reconnect or lock): the picture dims (brightness .38) and scales to 103 %, the controls fade, and "You're watching", title, episode line and synopsis (3 lines portrait, 4 landscape) rise in 40 ms apart on the start side within the safe area; the FriendFlix logo with "Paused" sits at the end-side bottom. A tap brings the controls back; the play button resumes.
- Same rules and component family as the desktop pause screen (`deskPauseDue`, `DESK_PAUSE_MS`); no Cast & info button on phones (it stays in more).

## 4. Credits sequence

- The desktop/TV credits sequence (`CreditsSequence`, `creditsBeat`, `creditPicks`) also runs on phones (not kids, not in a party, not casting), replacing the phone's next-up card: beat 1 chip ("Watch credits", "Next episode" filling 2 s), beat 2 the picture glides into the top-start corner (landscape scale .42, portrait: the letterboxed picture moves to the top), beat 3 up next with the countdown ring and "More like this" (only other titles).
- Landscape: up next and suggestions in the end-side column. Portrait: below the small picture. All within the safe areas; the small picture keeps its light edge.
- Back out ("Watch credits", a tap on the small picture, Esc / TV Back) reverses the glide; never a cut. A phone's system Back is not intercepted during the credits sequence: it leaves the player, as browser Back does on desktop (an entry pushed without a user gesture, as the corner beat would need, may be skipped by the browser).

## Motion

- Panels and the credits glide use springs; dock and top bar fade 250 ms; pause screen parts 40 ms stagger. Frame guard on (desktop budget); a tripped guard crossfades instead of gliding. Reduced motion and calm: instant.

## Testing

- Unit (vitest): tool list per orientation and features (`phoneTools`), panel anchor side, any new pure helper; coverage thresholds stay (statements 94 %, branches 89 %).
- E2E (Playwright, mobile project, landscape and portrait viewports): dock order and no overlap (bounding boxes of title, skip, timeline and pills do not intersect; all inside the viewport minus insets) in landscape and portrait, with a long title; tools per orientation; a panel opens above the timeline without covering it and closes on outside tap; controls hide after idle and return on tap; pause screen after 5 s; credits sequence on a phone; gestures and lock still work; desktop, TV and kids players unchanged.
- Tests are written with the code; CI runs them (owner rule).

## Out of scope

- A portrait "watch page" with the episode list under the picture (the mockup's shared "Hochformat" screen): the phone player stays full screen in both orientations.
- Backend or API changes, new gestures, desktop/TV/kids players.
