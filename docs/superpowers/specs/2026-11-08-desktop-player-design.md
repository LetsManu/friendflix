# Desktop player redesign (cinema bar with glass pills, panels, pause screen, credits sequence)

Date: 2026-11-08 · Status: draft for owner review

## Goal

Give the desktop player the same finish as the redesigned desktop browse pages (block 1): a cinematic control bar in FriendFlix's own look, panels that grow out of their buttons, a pause screen, a credits sequence that flows instead of cutting, and a morph from the detail page into the player and back. The credits sequence also comes to the TV player.

This is block 2 of 4 (desktop browse, **desktop player**, phone browse, phone player). It merges to main on its own; v3.0.0 is released after all four blocks.

Owner choices (mockup reviewed 2026-11-08): bar direction "B+C" (cinema split with glass pills); all five parts (bar, pause screen, panels, credits, start/exit); credits as an animated sequence, not a cut; the credits sequence on TV too.

## Constraints

- Applies to the desktop player (desktop width, `deskUi` true): not the phone layout (`$mobile`), not the kids UI. On TV (`html.tv`) only the credits sequence changes; the TV control layer, seek preview, tracks sheet, episodes overlay and pause screen stay as they are.
- Own look: coral `#ff4f6d`, FriendFlix logo (`Logo.svelte`), Inter. No other service's names, logos or marks; never another streaming service's name in user-facing text.
- Content and logic stay: the next episode, `COUNTDOWN_SECONDS` (10), `creditsStart` (outro/credits segment, else the last 25 s), the post-play data (`GET /api/items/:id/postplay`, the recommendation engine's rows and states) and every player feature (tracks, speed, quality, sound modes, subtitle search, scenes and bookmarks, cast & info, PiP, AirPlay, Chromecast, watch party, error recovery, ABR, telemetry). No backend change.
- Motion through the shared motion system (`#lib/tv/motion`: springs, `animateTo`, `stagger`, `motionLevel`, `frameGuard` with `DESK_GUARD` on desktop and `TV_GUARD` on TV, `--m-*` tokens). Animate only `transform` and `opacity`. Reduced motion and calm mode switch states instantly. Blur only where `motionLevel` is full.
- Keyboard: every control reachable with Tab, visible focus ring; all current shortcuts (`SHORTCUTS` in `lib/player/keymap.ts`) keep working.
- i18n: every new string in all seven locales (en, de, pl, es, fr, it, tr).
- `Player.svelte` is about 1,900 lines: new desktop parts live in their own files under `web/src/lib/player/desk/`; `Player.svelte` only wires state into them.

## 1. Control bar

- **Top left:** ‹ back (to where the player was opened from). Top right: the watch-party guest strip when a party runs (as today).
- **Bottom left:** the current chapter as a coral uppercase eyebrow (when chapters exist), the series or film title large (2.1em, 800), then `S2 E5 · Episode title` (episodes) or year · length (films).
- **Timeline** under the title: elapsed time left, remaining time (−mm:ss) right, tabular figures. Coral progress, buffered range, chapter ticks. On hover the track grows from 3 px to 6 px (scaleY) and the thumbnail tip rises above it (trick-play frame, chapter name, time). Dragging moves the tip with the pointer; the seek commits on release.
- **Left glass pill (playback):** play/pause (large), back 10 s, forward 10 s, volume. Hovering volume slides its slider out of the pill (transform), keyboard focus does the same.
- **Right glass pill (tools):** next episode, episodes, audio & subtitles, speed, scenes, more (quality, sound mode, find subtitles, cast & info, picture-in-picture, keyboard shortcuts), AirPlay / Chromecast where the browser offers it, full screen. A label rises above an icon on hover or focus (white chip, 150 ms).
- Pills: `rgba` dark fill, 1 px light border, blur where `motionLevel` is full, radius 99 px, the same treatment as the top-bar pill.
- **Hiding:** bar, title, scrims and cursor fade out (opacity, 250 ms) after 3 s without pointer movement or key press, and return on either. The bar stays while the pointer is over it, while a panel is open, while paused (until the pause screen takes over) and while a menu has focus.
- **Skip intro / recap:** a white button at the bottom right above the tools pill, rising in (spring) when the segment starts and leaving when it ends; `S` as today.

## 2. Panels

- Episodes, audio & subtitles, speed, scenes and more open as one glass card anchored above its button, growing out of it (scale from the button's corner, spring ~300 ms). One card at a time; switching between cards crossfades (120 ms out, 200 ms in).
- Esc, a click outside or the button again closes the card; focus returns to the button. Playback continues.
- **Episodes:** season switcher, episode rows with thumbnail, progress bar and one-line synopsis; the current episode highlighted and scrolled into view; a click plays it.
- **Audio & subtitles:** two columns (audio, subtitles) with the current choice marked; subtitle search stays in more.
- **Speed:** the `SPEEDS` list; **scenes:** chapters and bookmarks as today; **more:** today's settings items.

## 3. Pause screen (desktop)

- After 5 s paused (not in a watch party, not while casting, not with an error or reconnect on screen): the picture darkens (brightness .35) and zooms to 103 %, the bar fades out, and at the left "You're watching", the title, the episode line and the synopsis (4 lines) rise in 40 ms apart; the FriendFlix logo with "Paused" sits bottom right, and a "Cast & info" button opens the existing cast & info panel.
- Pointer movement or a key brings the bar back and fades the pause screen out (200 ms); Space resumes at once.
- It replaces the automatic cast & info panel that opens while paused on desktop today; cast & info stays in more and on the pause screen.

## 4. Credits sequence (desktop and TV)

Replaces the desktop "next episode" card and the TV next-up card; content and timing logic stay (`creditsStart`, `nextKind`, `COUNTDOWN_SECONDS`, post-play data).

- **Beat 1** at `creditsStart`: "Watch credits" and "Next episode" rise in at the bottom right; "Next episode" fills over 2 s (a click plays it at once).
- **Beat 2** after those 2 s: the picture glides on a spring into the top-left corner (scale .42), gaining rounded corners and a shadow; it keeps playing with sound. The bar hides.
- **Beat 3:** the next episode (title, synopsis) rises in at the right with a ring around Play counting down `COUNTDOWN_SECONDS`; below it, "More like this" from the post-play rows (first row, five titles) staggers in 40 ms apart.
- **Film or last episode:** no countdown; the post-play state takes the next episode's place (`movie_end`, `series_finished`, `caught_up`, `gap` with today's headlines), the suggestions stay.
- **Back out:** "Watch credits", Esc, a click on the small picture, or Back on TV plays the sequence in reverse to full screen and stops the countdown; it does not return for this episode (today's `dismissed`).
- **TV:** OK plays the next episode, arrows move between it and the suggestions (spatial navigation, TV focus ring), Back backs out. Under `TV_GUARD` a tripped frame guard turns the glide into a crossfade into the corner.
- Not in a watch party and not while casting (as the card today).

## 5. Start and exit

- **Start from the detail page:** Play morphs the detail backdrop (`data-vt-art`, View Transition) into the full-screen player poster; when the first frame is there (`firstframe`), the video crossfades over the poster (300 ms, as today) and title and bar fade in.
- **Exit:** ‹ back or browser Back morphs the picture back into the detail backdrop and the detail content rises back in (the block 1 entry stagger).
- Deep links and reloads of `/watch/[id]` show today's loading poster without the morph; without View Transitions a crossfade.

## Testing

- Unit (vitest): credits sequence state machine (beats, timers, back out, film / last episode, party and casting off), pause-screen due logic, panel stack (one open, toggle, Esc), bar idle timer, timeline hover geometry.
- E2E (Playwright, desktop): bar fades after idle and returns on movement; tooltip labels; panel grows from its button, Esc closes and returns focus; pause screen after 5 s and back on movement; credits: beat 1 → 2 → 3, Watch credits reverses, the countdown plays the next episode, a film shows suggestions without countdown; start morph from the detail page and Back to it; phone and kids players unchanged.
- E2E (TV): credits sequence with OK (next episode) and Back (watch credits).
- Tests are written with the code; CI runs them (owner rule). Coverage thresholds stay (statements 94 %, branches 89 %).

## Out of scope

- Phone player (block 4), phone browse (block 3), kids player, the TV control layer apart from the credits sequence.
- Backend or API changes, new recommendation logic, new shortcuts.
