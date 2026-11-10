# Cast & AirPlay block (design)

Date: 2026-11-10 · Status: mockups and three owner decisions approved in chat; this spec writes them down and resolves the rest

## Goal

Casting from FriendFlix should feel finished on every surface it touches: the remote screen on desktop and phone, the cast
bar while browsing, the "Play on" device sheet, the TV itself (FriendFlix's own Chromecast receiver), the Diagnose page and the
Android app. A Chromecast cast keeps playing when the tab closes and comes back when the app reopens. AirPlay gets subtitles,
and, if a spike proves it works, continuous play of several episodes as one stream.

Owner decisions (fixed, not reopened here):

1. **Continuous AirPlay: yes**, as an **experimental, switchable** feature that is **off by default** and is **tested first** (a
   go/no-go spike decides whether it ships at all).
2. **AirPlay subtitles go inside the stream** (one WebVTT rendition in the HLS master). No burned-in subtitles.
3. **A Chromecast cast survives closing or reloading the tab**; reopening the app picks it back up.

Sources this spec is built from:

- Approved mockups (source of truth for layout, copy and states): boards *1 Desktop cast screen*, *2 Phone cast screen*,
  *3 AirPlay (continuous)*, *4 Play on…*, *5 Cast bar collapsed / expanded*, *5b Bar states*, *6 TV up next*, *6b TV paused*,
  *6c TV loading*, *7 Diagnose*, *8 Android cast bar*. Board numbers are used below.
- The fact check of what exists today and the review of the mockups (both kept with the mockups, outside the repo).
- Code as of `main` after v3.1.0: `web/src/lib/cast.ts`, `web/src/lib/cast/*`, `web/src/lib/player/airplay.ts`,
  `web/static/cast-receiver/*`, `backend/src/cast.ts`, `backend/src/routes/cast.ts`, `gateway/src/gateway.ts`,
  `android/.../cast/*`, `android/.../player/PlayerActivity.kt`.

## Non-goals

- **No tvOS app.** AirPlay stays Safari's video-URL mode; nothing FriendFlix draws reaches an Apple TV.
- **The Default Media Receiver cannot be restyled.** Up-next card, pause and loading screens exist only with FriendFlix's own
  receiver (`CAST_RECEIVER_APP_ID`). With the Default Media Receiver the TV keeps Google's own overlay.
- No burned-in subtitles (decision 2). No subtitle styling on AirPlay TVs (the TV decides).
- The TV never asks the server for another title by itself. The receiver only plays what a sender loaded or queued; the
  next-episode token gate (`backend/src/cast.ts` `nextOverlap`, `castPredecessor`) stays the boundary.
- AirPlay does not survive closing the tab: the route belongs to the page's `<video>` (fact check E5). Only Chromecast does.
- Re-adoption only by the **device that started the cast** (same account, profile and approved device). Another phone of the
  same household does not pick up somebody else's cast.
- No quality control on the remote screen (it is not on the approved boards). Casts use the profile's quality setting; an
  audio or subtitle change still re-requests the stream at the current position.
- No local mini player, no picture-in-picture changes, no change to watch-party behaviour (a cast still ends on party join).
- Plex: AirPlay subtitles in the stream need the media server to emit an HLS subtitle rendition; only Jellyfin is in scope.
  The media-server seam gets a capability flag, Plex reports `false` until someone verifies it (see "AirPlay subtitles").
- Continuous AirPlay is limited to one series, up to three episodes, within one token lifetime (6 h cap).

## Global constraints (restated project rules)

- **Motion:** animate only `transform` and `opacity` (the stylesheet scan in `web/src/lib/admin/glass.test.ts` already refuses
  colour, background, border and filter transitions; this block extends it to forbid `width`/`height`/`left`/`top`
  transitions in the files it touches, and to scan `web/static/cast-receiver/*.css`). Opening **and** closing both animate.
  Nothing jumps: anything that appears reserves its space first or overlays without moving content.
- **Calm mode / reduced motion** (`html.m-still`, `motionAllowed()` false, `fxMode() === 'still'`): solid panels
  (`--fr-solid #1c1a21`, no blur) and no motion; state changes switch at once. TV and kids profiles are always solid.
- **Own look:** FriendFlix glass (`.frost`, `.frost-safe`, `.frost-btn`, `.frost-sheet`, `.frost-dim`), coral accent, Inter, the
  FriendFlix logo. No look-alike of any commercial streaming brand (no billboard title over a full-bleed left scrim, no red
  "N"-style marks). The words "Netflix" and "Seerr" never appear in user-facing text.
- **Fictional titles** in tests, fixtures and screenshots. The mockups' "Harbour Lights" (a real TV series) and "Paper Moons"
  (too close to a real film) are not used: fixtures use **Dunmoor** S1 E4 *The Lantern Road*, S1 E5 *Wrenfield Pier*, and
  **Saltwater Almanac** S2 E1 *Night Market*, E2 *The Toll Keeper*, E3 *Glass Tides*. Existing fixtures keep their names.
- **Secrets:** the media-server token never reaches a client. Cast tokens stay IP-pinned, are stored hashed, and are never
  logged, never put into the browser's storage, never into Diagnose output, metric labels or error messages.
- No Docker socket for web or backend. Docs use placeholder hosts only (`friend.example.com`, `192.0.2.x`).
- **Accessibility at the 3.1 level:** text contrast ≥ 4.5:1 (also over real artwork), targets ≥ 44 px, everything reachable and
  operable by keyboard with a visible focus ring, menus use `web/src/lib/ui/menuKeys.ts`, dialogs trap focus and return it,
  screen-reader names for every control, state changes announced politely, colour never the only carrier of meaning.
- **i18n:** every user-facing string through `#lib/i18n`, added in **all seven** locales (`de` is the typed source, `en` second;
  the per-language tests in `web/src/lib/i18n/*.test.ts` fail on a missing key). The copy table below gives EN and DE; the other
  five are translated by the implementer.
- Tests: implementers write unit (Vitest) and e2e (Playwright) tests in the existing style; locally they run only the root
  `npm run typecheck` and at most the new spec / unit files; CI runs the rest.

---

## 1. The remote screen (boards 1, 2, 3)

The watch page while its title plays on a TV. Today this is the `.remote.castov` overlay inside `Player.svelte`. It becomes its
own component, **`web/src/lib/cast/RemoteScreen.svelte`**, driven only by `castSession` and `castEngine` (the Player renders it
instead of `.remote.castov` and hides its own bar while `remote` is true). It owns no media.

### Common parts

- **Backdrop:** the existing remote backdrop treatment (`castBackdrops()` candidates, `blur(16px) brightness(.5)` plus the
  bottom shade). Every text block sits on a `.frost-safe` panel, never straight on artwork, so contrast holds over bright art.
- **Top row:** *Close remote* (chevron left on desktop, chevron down on phone; goes back like today's Back), the **device chip**
  (cast icon, device name, chevron; opens the *Play on* sheet, section 3), **Stop casting** (`player.cast.stop`, stop-square
  icon, 44 px pill; asks the existing confirm "Stop playback on {device}?" and calls `castEngine.stop()`).
- **Scrubber:** 44 px hit area, 5 px track at `.28` white, coral fill drawn with `transform: scaleX()`, 16 px coral knob with a
  white ring. Intro / recap segments are drawn on the track in the app's segment style (white `.38` with a white left edge) with
  a small label above ("Intro", "Recap"). `role="slider"`, `aria-valuetext` "{elapsed} of {duration}"; ←/→ ±10 s,
  PageUp/PageDown ±60 s, Home/End. Elapsed on the left, `−remaining` on the right (tabular figures). While dragging, the time
  bubble shows above the panel, never across its edge.
- **Transport:** back 10 s, Play/Pause (white disc, black icon, the one primary control), forward 10 s; Next episode (round, only
  for episodes). Labels reuse `player.controls.*`.
- **Skip intro / recap:** a `.frost-btn` pill above the control panel's right end, shown only while the TV is inside the
  segment (`castSession.skip`), calls `castEngine.skipSegment()`.
- **Audio / Subtitles chips:** open a glass menu (`role="menu"`, `menuitemradio`, `menuKeys`) listing
  `castSession.audioTracks` / `castSession.subtitles`. Audio → `castEngine.refresh({ audioIndex })`; subtitles →
  `castEngine.setSubtitle(index)`.
- **Live region:** one polite status line announces phase changes (connecting, connection lost, could not play, up next with
  its start time once, not every second).

### Desktop, Chromecast (board 1)

- Grid: now-playing panel left (max 660 px), up-next card right (380 px), both top-aligned on one line; the control panel spans
  the bottom. Below 1100 px the up-next card stacks under the now-playing panel; below 1200 px the Audio and Subtitles chips
  keep their values but drop the icon. ≤ 720 px uses the phone layout.
- **Now-playing panel:** 16:9 thumbnail (`castThumbs()`), coral eyebrow "Playing on {device}" (`player.cast.playingOn`
  restyled as eyebrow), title (max 48 px, 800), line "Season 1 · Episode 4 · The Lantern Road" (films: year · runtime).
- **First-use hint** inside the panel: "This is your remote. You can close this tab; the TV keeps playing." with a 44 px
  dismiss button. Chromecast only (AirPlay cannot survive the tab). Dismissal is remembered per browser
  (`localStorage` `ff-cast-hint-seen`, try/catch). On dismiss the row fades out (opacity) and keeps its height until the
  screen closes, so nothing below jumps.
- **Up-next card** (episodes with a next episode only): eyebrow "Up next", thumbnail, "E5 · Wrenfield Pier", a status line,
  *Play now* (glass pill, not white: one primary per screen), and the switch **Autoplay next episode**.
  - Status line: autoplay on → "Starts by itself on the TV."; countdown running (credits) → "Starts in {n} s";
    autoplay off → "Plays when you choose.".
  - The switch is **session-scoped** (`castEngine.setAutoplay(on)`): it starts at `prefs.autoplayNext && !sleepAfterEpisode`,
    does not change the account preference, and off cancels a running countdown and removes a queued episode from the
    receiver (the existing `cancelNext` path, plus `noAuto` for every following episode of this session).
  - *Play now* = `castEngine.next()`. The control panel's Next button does the same.
- **Volume** (Chromecast only): mute button (44 px, "Mute TV" / "Sound on TV"), slider "TV volume" (`castSetVolume`,
  ←/→ ±5), value "TV volume 62".

### Phone, Chromecast (board 2)

Same parts stacked: top row (chip truncates with an ellipsis, Stop keeps its label down to 360 px, below that icon only),
eyebrow + title (34 px) + "S1 · E4 · The Lantern Road", scrubber with times below, five-slot transport grid (mute, back,
Pause 76 px centred, forward, next), "TV volume" row, two chips with label over value ("Audio / English 5.1"), and the up-next
card docked above the home indicator with *Play now* (never wraps: `nowrap`, title ellipsis) and the autoplay switch. One 16 px
gutter, `--safe-top` / `--safe-bottom` respected.

### AirPlay (board 3)

- Eyebrow "Playing via AirPlay", chip "AirPlay" (Safari does not tell the device name) opening the *Play on* sheet.
- No volume control: a line "Volume: {device} buttons or TV remote" ({device} = iPhone, iPad or Mac from the platform).
- Subtitles chip: from Phase 3 (section 7). Before that the AirPlay screen shows only the Audio chip.
- Hint under the chips while subtitles are on: "Subtitles on AirPlay are new; some TVs may not show them."
- Up-next card: as for Chromecast; its status line adds the honest limit "If your iPhone locks, it starts when you unlock
  it." (this is what ships today and stays true whenever continuous play is off).
- **Continuous mode** (Phase 3, only if the spike passes and the setting is on): info card "Continuous play" with the
  *Experimental* badge and "Episodes 1–3 play back to back and keep playing when you lock your iPhone. Then playback stops.";
  the scrubber covers the **current episode only** with "9:51 played · Episode 1 of 3 · 34:40 left"; the transport's left slot
  is *Previous episode* (disabled on the first: "Previous episode (none: this is the first)"); Next / Previous are seeks to the
  episode boundaries (Next disabled on the last); a list "Playing in a row" (plain text rows, not buttons: E1 *Now*, E2 44 min,
  E3 47 min), scrollable above the safe area. No up-next card (the list replaces it).

### States on the remote screen

| Phase (`castSession.state`) | Remote screen |
|---|---|
| `connecting` | spinner in the Play/Pause slot, status "Connecting to {device}…", scrubber inert |
| `playing`, paused | Play icon in the white disc; everything else live |
| `playing`, buffering | Play/Pause stays, a thin indeterminate line under the scrubber (opacity/transform only) |
| `reconnect` | status "Connection lost" (amber icon + text), *Reconnect* pill (Chromecast: retries once; AirPlay: opens the picker inside the tap) |
| `failed` | status "Could not play on the TV" (error icon + text), white *Play here* pill (`castEngine.release()`, local playback at the TV's position) |
| `ended` with next | up-next card shows the countdown or "Plays when you choose."; scrubber full |
| `detached` (new, section 4) | as `reconnect`, text "Connection lost", *Reconnect* asks the browser for the device |

## 2. The cast bar (boards 5, 5b, 8)

`web/src/lib/cast/CastBar.svelte` is restyled from the flat docked strip into the floating glass bar of the boards.
`barVisible()` keeps its rule (not on `/watch/*`, `/party/*`, not in TV mode).

### Desktop, collapsed (board 5 left)

- `.frost .frost-safe`, radius 24, 76 px high, width `min(660px, 100vw - 2 × --pad-x)`, centred, `bottom: 16px + --safe-bottom`;
  the layout reserves `--castbar-h: 92px` so the last row of content ends above it (nothing hides behind it, nothing jumps
  when it appears: the reserve is set before the bar animates in).
- Content: 80×45 thumbnail; line 1 "Dunmoor · S1 E4"; line 2 "On {device} · {n} min left" in `.72` white (green is reserved
  for change, not for the normal case); Pause (coral fill `--acc-fill`, white icon, 44 px); Next episode (episodes only);
  *Stop casting* pill (confirm as today); *More controls* (expand). Thumbnail and text form one button: "Open remote".
- Progress line: 3 px, inset 24 px from both ends and 6 px from the bottom (never cut by the corner radius), track `.38`
  white, coral fill by `scaleX`, `role="progressbar"`. It is not draggable (seek lives in the expanded bar).

### Desktop, expanded (board 5 right)

- Opens from *More controls* (a button: click, Enter or Space), grows out of the bar (`growBoth` from
  `#lib/glass/fx`, transform-origin bottom centre), replaces the collapsed bar in place, width `min(640px, …)`, height by
  content (no fixed height). Escape, the *Collapse* button or a click outside collapses it, focus returns to *More controls*.
- Content: thumbnail 112×63, "Dunmoor · S1 E4 · The Lantern Road", "On {device} · Up next: E5 · Wrenfield Pier", Collapse;
  scrubber row (as on the remote screen); mute + volume slider (Chromecast); back / Pause / forward; Next; a divider; chips
  "Audio: …", "Subtitles: …"; *Open remote* (glass pill) and *Stop casting*.
- Skip intro shows in the transport row while it applies.

### Phone (board 8, and the web phone bar)

- `.frost .frost-safe`, radius 24, 68 px, inset 14 px left/right (the tab bar's inset), docked 8 px above the tab bar
  (`bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 8px)`; kids profiles without a tab bar: `10px + --safe-bottom`);
  `--castbar-h: 76px` is reserved. No thumbnail; the text area is the "Open remote" button; Pause (coral) and *Stop casting*.
  No Next and no expand on phones (the board's set). Progress line as on desktop.
- The tab bar itself is unchanged (Home, New, My list, Downloads).
- **Phone header indicator** (board 8, top right): while a cast runs, the phone header shows a 44 px cast icon in the app's
  active coral (`--acc-light #ff8aa0`, the `.ic.on` convention) labelled "Casting to {device}"; a tap opens the remote. It is
  an icon on a transparent button (never the browser's default button face). Not shown when no cast runs.

### Bar states (board 5b)

| State | Left slot | Line 2 | Actions |
|---|---|---|---|
| `connecting` | coral/grey spinner (24 px, rotates; still in calm mode) | "Connecting to {device}…" | *Stop casting* |
| `reconnect` / `detached` | amber warning icon | "Connection lost" (amber, plus icon: never colour alone) | *Reconnect*, *Stop casting* |
| `failed` | error icon | "Could not play on the TV" | white *Play here*, *Stop casting* |
| paused | thumbnail | as playing | Play instead of Pause |
| `ended` / credits with next | thumbnail | "Up next: {label} · in {n} s" | Cancel (×) while counting, Next, *Stop casting* |
| AirPlay waiting for the picker | thumbnail | "Now pick the TV from the list." | *Choose TV* |

### Motion

Bar in: `translateY(16px)` + opacity 0→1, 240 ms (`outEase`); out: the reverse, 180 ms; state text swaps crossfade (opacity
120 ms). Progress fills move by `scaleX` with a 1 s linear transition. Expanded: `growBoth`. Calm / reduced: all durations 0,
spinner static, panels solid.

## 3. The "Play on" sheet (board 4)

`web/src/lib/cast/PlayOnSheet.svelte`. One entry point for choosing where a title plays, replacing the separate Chromecast item
in the player's More menu and the separate AirPlay button: the player shows one **Play on** button (cast icon) whenever at least
one target type is available; the remote screen's device chip opens the same sheet.

- **Phone:** bottom sheet (`.frost .frost-sheet`, `sheetSlide` in and out, `.frost-dim` behind, `--safe-bottom` padding), visible
  grabber (`.45` white, decorative) **and** a 44 px *Close* button. **Desktop:** the same content as a glass popover growing out
  of the button (`growBoth`). `role="dialog"`, `aria-modal`, focus trap, Escape closes, focus returns to the trigger.
- Header: "Play on" and what will happen: "Dunmoor · S1 E4 from 18:42" (films: "{title} from {time}").
- Rows (64 px, radius 12, current row filled `--fr-sel`):
  1. **Last used TV** ("Living room TV", "Chromecast · used last time"): only when a Chromecast was used before in this browser
     (`localStorage` `ff-cast-last`, name only) and Cast devices are available. **Platform limit, written down:** a web page
     cannot connect to a named Chromecast; tapping the row opens the browser's own device list (`requestCastSession()`, inside
     the tap). The row exists so the usual target is one obvious tap; the browser still asks.
  2. **Another TV…** ("Chromecast", plus icon): Chromium browsers with Cast devices available; same call.
  3. **AirPlay…** ("Apple TV and AirPlay TVs"): Safari with an AirPlay target available; runs the existing token-then-picker
     flow from the tap (`createAirPlay` `pick`, "Choose TV" fallback stays).
  4. **Play episodes back to back** (switch, *Experimental* badge, "No taps in between"), indented under AirPlay: only on Apple
     devices, only when continuous AirPlay shipped and the admin enabled it (section 8), only for episodes. Off by default.
  5. Divider, then **This phone / This tablet / This computer**: "Playing here now" with a coral tick when playing locally;
     while casting it reads "Continue here": the cast stops (stop report, token revoked, receiver stopped) and the title
     continues locally at the TV's last position.
- Rows that do not apply are not rendered (no AirPlay row on Android or Windows Chrome; no Chromecast rows in Safari).
- The device name of a running Chromecast session is remembered on `session-start` (`ff-cast-last`).

## 4. Chromecast survives the tab (decision 3)

### What changes

| Today (`engine.ts` `onPageHide`, `docs/cast.md` step 4) | After |
|---|---|
| `pagehide` removes the queued item, sends `stop`, revokes the token (keepalive) and stops the receiver app | Chromecast: `pagehide` sends **nothing**, revokes **nothing**, leaves the queue, and only disconnects the sender (`castLeave()` = `endCurrentSession(false)`). The TV keeps playing and moves on to a queued episode |
| `SESSION_RESUMED` only syncs state | `SESSION_RESUMED` (and a session already present when the SDK starts) re-adopts FriendFlix media on the receiver |
| No trace of a cast in the browser | A non-secret hint `ff-cast-hint` = `{ castId, itemId, device, exp, at }` in `localStorage` (no token, no URL) |
| SDK loaded only when a player opens | The root layout loads the SDK at start when a fresh hint exists (Chromium only); otherwise as today |
| AirPlay: `pagehide` ends it | unchanged |

### Re-adoption

1. The SDK auto-joins (`autoJoinPolicy: ORIGIN_SCOPED`) and fires `SESSION_RESUMED`, or a session is already there when `setup()`
   runs. `cast.ts` emits a new event `session-resume`.
2. The engine (only when it owns nothing) waits up to 10 s for the receiver's media status (`castState.loaded` and
   `contentId`). It derives the token's public handle: the own receiver's `customData.ff.castId`, else
   **`castId = sha256(token)[0..32]`** of the token segment in `contentId` (`/media/c/<token>/…`), computed in the browser with
   `crypto.subtle`. The token itself is never sent anywhere and never stored.
3. It asks **`GET /api/cast/session/:castId`** (new, section 4.4). 404 → not ours (another device, profile, expired): nothing is
   shown and the hint is cleared. 200 → the engine adopts with a rebuilt `CastInfo` (`contentUrl` = the receiver's
   `contentId`, track ids rebuilt from the subtitle list in order, `started = reported`), fetches item metadata, restores a
   queued next episode the same way (second queue item whose handle resolves with `next: true`), and resumes progress
   reports, renewal and the bar. Log: `session resumed · TV kept playing`.
4. **Reload of the same tab may not auto-join on every Chrome** (fact check E, unverified). Fallback: when a fresh hint exists and
   no resume happened 5 s after the SDK is ready, the bar shows the **`detached`** state with the hint's title and device:
   "Connection lost" and *Reconnect*. *Reconnect* calls `requestCastSession()` inside the tap; the user picks the TV, the SDK
   joins the running receiver app and step 2 follows. If the picked TV plays nothing of ours: toast "Nothing from FriendFlix is
   playing on {device}.", hint cleared. *Stop casting* on a detached bar revokes by the hint's `castId`
   (`DELETE /api/cast/session/:castId`) without a stop report (position unknown) and clears the hint.
5. The hint is written on adopt and on every token change (switch, renewal, queue advance) and removed on stop, session end
   and the end of the session; it is ignored after its `exp`.

### Security model change

- **What stops revoking on `pagehide`:** only Chromecast media tokens and the queued next token of that device. AirPlay
  tokens, poster tokens of stopped casts, and everything else are revoked as today.
- **Still revoking:** explicit *Stop casting* (bar, remote, detached bar, Android), session end from the TV or another sender,
  logout (`routes/auth.ts` already revokes the device's casts), **profile switch** (new: `POST /api/profiles/:id/select`
  revokes this device's cast tokens server-side, so it holds with no page open), party join (client), device removal or block,
  "Sign out other sessions", account disable, the account's third media token (oldest revoked).
- **Idle expiry:** unchanged: 45 min sliding, refreshed by the TV's own fetches (at most every 20 s), so an unattended stream
  lives while the TV plays and dies 45 min after it stops fetching (a long pause on the TV included).
- **Absolute cap:** unchanged: remaining runtime + 1 h, between 1 h and 6 h. Renewal needs a page; without one a title still
  plays to its end; a pause that crosses the cap ends it (documented).
- **Max tokens:** unchanged: 2 media tokens per account plus 1 queued per device. A new cast elsewhere that mints a third
  revokes the oldest, which may be the unattended one: this bounds how many unattended streams can exist.
- **Re-adoption endpoint** `GET /api/cast/session/:castId` (session cookie + CSRF rules of GET, rate limit 30/min): answers only
  when the token belongs to the caller's account **and** profile **and** approved device and is a media token; the answer has
  no token and no URL: `{ castId, itemId, mediaSourceId, playSessionId, expiresAt, runtimeTicks, via, next, reported, title,
  seriesName, subtitles: [{ index, language, title }], pins, refused: { count, families } }`. `pins` and `refused` are
  counts and address families (`v4`/`v6`) for Diagnose, never addresses. A wrong guess of a castId (128 bits) is useless.
- **What a stolen token could do:** stream that one title (and its poster) from the pinned address only (the TV's; behind one
  NAT, the household), until 45 min idle or the cap (≤ 6 h). It cannot mint tokens, read other items, report progress (report
  tokens are separate, own receiver only and pin-bound) or touch the account. New exposure: the stream may run with no page
  open, and on the Default Media Receiver the token URL stays readable in the media status by any Cast sender on the LAN for
  longer. Bounded by the IP pin, the single-title scope, idle expiry, the cap, the token limit and every revoke path above.
  The kill switch when the tab is gone: reopen FriendFlix (the bar comes back) and *Stop casting*, or sign out other sessions.
- **Queued token hardening (new):** a queued next token is **pinned at mint** to the address its predecessor is pinned to
  (copy of `castpin:`), so a sender on the LAN that reads the queue cannot take the pin first. A predecessor without a pin
  (never fetched) refuses the queue request with `409 cast_unpinned`; the sender tries once more 60 s later.
- **Reporting without a page:** the own receiver reports start / progress / stop itself (unchanged). With the Default Media
  Receiver, progress and "watched" stay where the page left them until a page re-adopts (it then reports the receiver's
  position, and `advanced()` closes the ended episode at its end). Documented; the own receiver is the recommendation.
- **Never stored:** the token, the content URL, the report token. The hint holds the public handle only.

## 5. The TV: FriendFlix's own receiver (boards 6, 6b, 6c)

All receiver screens are **solid panels** (`#1c1a21`, border `rgba(255,255,255,.2)`, top highlight, shadow; no
`backdrop-filter`), inside **safe margins of 5vw on all sides** (64 px at 1280×720), sized for 3 m: nothing below 20 px at a
1280×720 viewport (scaled with the viewport: `--u: calc(100vw / 1280)`), titles 30 px (card), 56 px (pause), 44 px (loading);
dim text `.78` white. Radii: cards 24, thumbnails 12, pills 999.

- **Sender pill** "Cast from Anna's phone" (top left; computer / tablet variants from the sender's form factor; the name is the
  FriendFlix **profile** name, sent in the `ui` message, never the device): shown for 5 s after a load and whenever a card,
  the pause or the loading screen is visible.
- **Up next (board 6):** card bottom right (width 660 at 720p): 200×112 thumbnail, "Up next in 12 s" (coral `#ffa7b6`, the
  countdown number from `COUNTDOWN_SECONDS`, unchanged), "E5 · Wrenfield Pier", key hint, and a 6 px countdown bar along the
  card's bottom edge (`scaleX`, linear). The card has **no on-screen buttons** on remote-driven TVs:
  - key hint "OK plays now · Back stops here" only after a remote key has been seen in this receiver session; before that
    "Cancel on your phone";
  - touch devices (Nest Hub: a touch event seen) show two buttons instead: *Play now* and *Stop here*;
  - OK / Enter / Space / MediaPlayPause = play now; Back / Escape / Backspace / GoBack / BrowserBack = stop here (today's
    `cancel`: no autoplay, the card stays as "Up next" without the countdown until the end, then the TV idles).
  - *Still there?* keeps its function in the same card style ("Still there?", "Autoplay is paused. Up next: …", hint
    "OK keeps watching"), and the full-screen variant while the queued episode waits paused becomes the same solid card centred.
- **Paused (board 6b, new):** 1.5 s after the TV pauses (a quick pause/resume never flashes it): picture dimmed with a plain
  gradient (no blur), bottom-left block inside the margins: pause icon + "Paused", title (series or film), line
  "Season 1 · Episode 4 · The Lantern Road", progress bar with elapsed and **total** time. Hides at once on play. OK / Play
  resumes; ←/→ seek ±10 s while it shows.
- **Loading (board 6c, new):** from a LOAD until the first frame of each item: centred artwork (the poster token image of the
  media metadata; a solid placeholder if none), title, line, an indeterminate 4 px bar (a coral segment moving by
  `translateX`), "Getting ready…". A stall longer than 3 s mid-playback shows the paused layout with "Loading…" instead of
  "Paused".
- **Texts and metadata** come from the sender (the TV has no language and no session): `ui` gains `who` (sender pill text) and
  `motion` (false in calm mode), `item` gains `meta: { title, line }`; `receiverStrings()` gains the new strings.
- **Motion on the TV:** cards and screens in: opacity + `translateY(24px)` 260 ms; out: opacity 200 ms; the countdown bar and
  loading bar by transform only. `prefers-reduced-motion` or `motion: false` from the sender: no motion, static loading bar.
- **Remote keys summary:** OK/Enter/Space/MediaPlayPause, Back family as above, ←/→ seek ±10 s (pause screen) or move focus
  between the two touch buttons (Nest Hub). Whether Back reaches the page or closes the app on Google TV stays an on-device
  check; if Back closes the app, the hint shows "Cancel on your phone" on that device class (decided by the first key seen).

## 6. Diagnose: casting section (board 7)

A new first section on `/diagnose`, heading "Casting", above the existing viewport table, AirPlay log and start times. Panels use
`.panel` values (frost, radius 24, padding 22/24) on the ambient background.

- Header actions: **Send test video to TV** (`.frost-btn`) and **Copy report** (`button.light`). Result line under the heading:
  "Test video played on {device} · first frame after 1.9 s" (ok icon + text) or "Test video did not play on {device}." (error).
  - The test loads a bundled 6-second clip (`web/static/cast-test/clip.mp4`, H.264 baseline + AAC, < 400 KB, a FriendFlix card
    and a tone; no token, no media server) on the current Chromecast session, asking for one from the tap if none exists.
    Disabled with "Stop casting first." while a FriendFlix cast plays. Measures LOAD → first `PLAYING`. Ends the receiver
    session it opened when the clip ends. Chromecast only (AirPlay needs the player's element).
- **Chromecast card:** Cast support (Ready · FriendFlix receiver / Ready · Google's standard receiver / Not available in this
  browser (needs Chrome or Edge) / Off on this server), Session (Connected to {device} / Not connected), Playing (title and
  S·E; the sender cannot tell direct stream from transcode, so no method is shown), Access pass ("Valid 4 h 12 min, renews 10
  min before it ends", from `expiresAt`), Next episode ("E5 loaded on the TV" / "Not queued"), Receiver errors ("1 in this
  session (see events)").
- **AirPlay card:** In this browser (Available / Not available here (AirPlay needs Safari)), Continuous play ("On (setting)" /
  "Off (setting)" + *Experimental*; the row exists only if the feature shipped), Subtitles ("Sent with the stream (new)", from
  Phase 3), Last session ("Yesterday 21:14 · 3 episodes, 0 reconnects", from the cast log), Network (only when the lookup's
  `refused.families` differs from the pinned family: "The TV used 2 addresses (IPv4 and IPv6). Fine unless playback stops; then
  turn off IPv6 on the TV.", warn icon + text).
- **Events:** "Kept on this device, last 200 · included in Copy report", *Copy*, *Clear*; rows: time, level (icon **and**
  word: info / warn / error; the tag colour never changes with the level), tag (`session`, `load`, `receiver`, `queue`,
  `network`, `renew`, `sender`, `test`), text. Event texts are fixed technical English (they go into bug reports); the section's
  chrome is translated.
- **What is recorded** (`web/src/lib/cast/castLog.ts`, `localStorage` `ff-castlog`, ring buffer of 200, try/catch): session
  connect / resume / end with device name; load (episode label "S1 E4" or "film", start position, never the title name);
  receiver playing with first-frame time; queue (pass issued, loaded, started, removed, refused with HTTP status); network
  (receiver buffering > 2 s, recovered); renew (new pass validity); receiver idle reasons and errors; sender (tab hidden /
  visible / closed, remote attached again); test results. Every entry goes through `scrub()`: no URLs, no `/media/c/` paths,
  no 32-hex ids or castIds, no IP literals, no long base64url runs.
- **Kept only on the device.** Nothing is uploaded. **Copy report** builds text from the two cards, the events and the
  existing AirPlay log, and replaces device names with "TV 1", "TV 2" (by first appearance). No tokens, URLs, addresses or ids.

## 7. AirPlay subtitles in the stream (decision 2)

- **Request:** the AirPlay token request carries `subtitleIndex` (the chosen track; omitted = off). The backend asks the
  media server for an HLS stream with that one subtitle as a WebVTT rendition (Jellyfin: `SubtitleStreamIndex=<i>` and
  `SubtitleMethod=Hls` on the HLS URL, so Jellyfin writes the subtitle playlist and segments with the correct
  `X-TIMESTAMP-MAP`). The media-server seam gets `capabilities.castHlsSubtitles` (Jellyfin `true`, Plex `false`); without it
  the AirPlay Subtitles chip shows "Off" and is disabled with the hint "This server can't send subtitles to AirPlay yet."
- **Gateway:** `compatPlaylist` keeps exactly **one** `#EXT-X-MEDIA:TYPE=SUBTITLES` rendition, only for AirPlay tokens whose
  authz scope says `hlsSub: true`, reduced to `TYPE, GROUP-ID, NAME, LANGUAGE, DEFAULT=YES, AUTOSELECT=YES, FORCED=NO, URI`, and
  the matching `SUBTITLES=` attribute on `#EXT-X-STREAM-INF`. The URI check (inside `/media/c/<token>/`) applies as before;
  `CLOSED-CAPTIONS` and every other subtitle group stay dropped. Chromecast tokens are unchanged (side-loaded WebVTT).
- **Switching:** a subtitle change on AirPlay is a new token at the current position (like an audio change today).
- **Risky receivers:** Apple TV is the reference (expected to work). LG webOS (has failed on unknown playlist lines before),
  Samsung (field reports of missing AirPlay subtitles), LG after some firmware updates (misplaced), Roku, Vizio and Sony AirPlay
  TVs are untested and risky. The page cannot tell which TV it talks to.
- **Fallback:** (a) a TV that refuses the stream (`MEDIA_ERR_SRC_NOT_SUPPORTED`, code 4, while wireless, on a token with
  subtitles) gets **one** automatic retry with a new token **without** subtitles, then the existing variant fallback applies as
  today; toast "This TV can't show the subtitles; playing without them."; the browser remembers it
  (`localStorage` `ff-air-subs-refused`, 30 days) and later AirPlay sessions start without subtitles, chip "Off (TV refused)",
  until the person picks subtitles again on the remote. (b) A TV that plays but does not show them: the user-facing hint
  "Subtitles on AirPlay are new; some TVs may not show them." is shown whenever subtitles are on during AirPlay, so turning them
  off is the obvious fix.
- Docs: `docs/cast.md` drops "eingebrannte Untertitel bietet der Cast-Ablauf nicht an" as the only route and the compatibility
  table row "Untertitel" gets the AirPlay exception.

## 8. Continuous AirPlay (decision 1): spike first, experimental setting

### The spike (go / no-go)

A throwaway prototype on its own branch (never merged): the gateway serves one VOD media playlist that joins the current
episode and the next two of the same series with `#EXT-X-DISCONTINUITY`, segment URIs rewritten to each episode's own
`Videos/<id>/…` path under one dev-only multi-item token; one WebVTT rendition joined the same way. The owner runs it on
an iPhone with an Apple TV and with the LG webOS AirPlay TV.

Pass criteria (each one written down with what was seen):

- **P1** Three episodes (two boundaries) play to the end of the third with the iPhone locked from minute 1 of episode 1 and no
  touch.
- **P2** At each boundary the picture is back within 5 s (stopwatch); no AirPlay placeholder; the route never falls back to
  the iPhone.
- **P3** After unlocking during episode 2, a seek of +10 min and a seek to 1 min before the second boundary land within 2 s of
  the target and play on.
- **P4** The server never counts more than one stream for the user during the run, and the token sees no 401, 403 or 502.
- **P5** The server-inferred position of episode 2 (from segment fetches) is within ±30 s of what the TV shows at a random check.
- **P6** In-manifest subtitles show in episodes 1 and 2 on the Apple TV, in sync within ±0.5 s.

**GO** = P1–P6 on the Apple TV **and** P1–P2 on the LG TV. Anything else is **NO-GO**.

- **NO-GO ships nothing but the honest note:** the up-next line on the AirPlay remote ("If your iPhone locks, it starts when
  you unlock it.", already in Phase 1) and a short paragraph in `docs/cast.md` saying continuous AirPlay was tried and why it
  did not ship; the roadmap item moves to a "tried, not shipped" note. No setting, no sheet toggle, no Diagnose row.
- **GO** ships the feature below, off by default.

### The feature (only after GO)

- **Switches:** an admin setting `CAST_AIRPLAY_CONTINUOUS` (*Admin → Settings → Playback*, "Continuous AirPlay
  (experimental)", default off) makes the feature available; the profile preference `airplayContinuous` (default false) turns it
  on, from the *Play on* sheet's switch or *Account → Playback*. Both show the *Experimental* badge.
- **Which episodes:** the current episode plus up to two following (by `/api/items/:id/next`, crossing a season boundary is
  allowed), fewer when "Still there?" would be due earlier (`stillWatchingEpisodes`), when the total would pass the 6 h cap, or
  when autoplay is off or "sleep after this episode" is set (then no joined stream at all). After the last one, playback stops.
- **Token:** a new multi-item AirPlay token (`CastRecord.items[]`: item, media source, play session, runtime, HLS path per
  episode). The gateway's scope check accepts any listed item; everything else (pin, two-address window, idle, cap, revoke) as
  for AirPlay tokens. It counts as **one** stream: a fetch of episode *k* makes *k* the live play session and clears *k−1*.
- **Playlist:** `/media/c/<token>/joined/main.m3u8` built by the gateway from each episode's variant playlist, plus
  `joined/subs.m3u8` when subtitles are on; audio language and subtitle language are resolved per episode at mint.
- **Progress without the page:** the gateway passes the segment's item and index to `/internal/authz`; the backend infers the
  position (index × segment length) and reports `start` / `progress` (every 30 s) / `stop` per episode for the token's
  account, profile and device, `stop` at the runtime when fetches move on (marks it watched).
- **Page:** maps the element's time to (episode, offset) with the timeline from the token answer; scrubber, skip intro and
  credits work per episode; Next / Previous seek to boundaries; the remote screen shows continuous mode (section 1).
- **Limits written down:** autoplay cannot be cancelled mid-stream except by *Stop casting*; "Still there?" is decided at
  creation; an audio or subtitle change re-mints the whole joined stream at the current position; a pause past the 6 h cap
  ends it.

## 9. Android: cast bar while browsing (board 8)

- **Survives the player screen:** the `CastController` and its `MediaThreeReceiver` move from `PlayerActivity` into an
  app-scoped `CastHub` (in `Players`). Closing the player no longer stops the cast (`PlayerActivity.releaseAll` detaches).
  Stop paths: *Stop casting*, receiver / other sender ends it, logout, profile switch.
- **Bar in the shell:** the shell's web UI draws the bar (board 8 is the web phone bar). The native bridge gains a `cast`
  capability version: method `castState` (snapshot or null), events `cast` (snapshot on every change, throttled to 1/s for
  position), and method `castControl { action: 'playPause' | 'next' | 'stop' | 'open' }`. The web `CastBar` reads a
  `CastBarSource` (the engine in browsers, the bridge in the Android shell). *Open remote* opens `PlayerActivity` as the remote
  for the casting title; *Stop casting* asks the web confirm, then `castControl stop` (stop report, revoke, receiver end).
- **Play while casting:** a play request from the shell while the hub casts opens the player as the remote and switches the
  TV to that title (`CastController.switchTo(itemId, startMs?)`, the engine's `playOnTv` semantics: old stop reported and
  revoked, one live token).
- **Survives the app:** the Cast framework resumes its session after the process restarts; `CastHub` re-adopts with the same
  lookup as the web (castId from `customData` or `sha256` of the token segment, `GET /api/cast/session/:castId`).
- **Queueing parity:** `QUEUE_WITHIN_MS` goes (queue from the start, section 10), as on the web.

## 10. Next-episode queueing: the known gaps

| Gap (fact check D) | Decision |
|---|---|
| Titles over 40 min: phone asleep before the 40-min mark → nothing queued | **Queue from the start.** The sender queues the next episode as soon as an episode plays and its duration is known (`QUEUE_WITHIN_S` / `QUEUE_WITHIN_MS` removed). The token's lifetime problems this creates are solved below. |
| Queued token expires after a long pause (idle 45 min from mint, first fetch only 30 s before the end) | **Its life follows the predecessor.** A queued token's idle TTL is refreshed whenever its predecessor is touched (index `castnext:<user>:<playSession>`), and its absolute cap at mint is `min(6 h, own TTL + predecessor's remaining)` (`castNextTtlSeconds`). Belt and braces on the sender: when the receiver should have moved on and the queued token does not load, the fallback requests a **fresh** token for that episode instead of reloading the old one (`engine.ts` `onEvent` / `ADVANCE_WAIT_MS` path). |
| Only one episode ahead with the phone asleep | Kept. The receiver never asks the server for titles; the next one queues when a sender is awake (or re-adopts). |
| Autoplay off, sleep after episode, "Still there?" due on the Default Media Receiver: nothing queued | Kept, by design. The session autoplay switch (section 1) now makes it visible. |
| Default Media Receiver with no page: no progress / stop reports | Accepted and documented; re-adoption repairs it; the own receiver reports by itself. |
| Tab closed: queued token revoked | Fixed by section 4 (the queue stays). |
| Queued token readable on the LAN for longer | Pinned at mint to the predecessor's address (section 4). |

## 11. Copy (EN / DE; the other five locales translated)

New keys only; existing keys reused where named. `{device}` = receiver name, `{n}` numbers, `{time}` clock values.

| Key | EN | DE |
|---|---|---|
| `player.castRemote.close` | Close remote | Fernbedienung schließen |
| `player.castRemote.chip` | Playing on {device}, change TV | Läuft auf {device}, Fernseher wechseln |
| `player.castRemote.chipAirplay` | Playing via AirPlay, change TV | Läuft über AirPlay, Fernseher wechseln |
| `player.castRemote.hint` | This is your remote. You can close this tab; the TV keeps playing. | Das ist deine Fernbedienung. Du kannst diesen Tab schließen, der Fernseher spielt weiter. |
| `player.castRemote.hintDismiss` | Dismiss hint | Hinweis ausblenden |
| `player.castRemote.upNext` | Up next | Als Nächstes |
| `player.castRemote.startsBySelf` | Starts by itself on the TV. | Startet von selbst auf dem Fernseher. |
| `player.castRemote.startsIn` | Starts in {n} s | Startet in {n} s |
| `player.castRemote.waits` | Plays when you choose. | Startet, wenn du es willst. |
| `player.castRemote.onUnlock` | If your iPhone locks, it starts when you unlock it. | Ist das iPhone gesperrt, startet sie beim Entsperren. |
| `player.castRemote.autoplay` | Autoplay next episode | Nächste Folge automatisch abspielen |
| `player.castRemote.position` | Position on the TV | Position auf dem Fernseher |
| `player.castRemote.positionEpisode` | Position in this episode | Position in dieser Folge |
| `player.castRemote.mute` / `unmute` | Mute TV / Sound on TV | Fernseher stumm / Ton am Fernseher an |
| `player.castRemote.volume` / `volumeValue` | TV volume / TV volume {n} | Fernseher-Lautstärke / Fernseher-Lautstärke {n} |
| `player.castRemote.volumeAirplay` | Volume: {device} buttons or TV remote | Lautstärke: Tasten am {device} oder TV-Fernbedienung |
| `player.castRemote.audioChip` / `subsChip` | Audio: {value} / Subtitles: {value} | Audio: {value} / Untertitel: {value} |
| `player.castRemote.off` / `offRefused` | Off / Off (TV refused) | Aus / Aus (vom Fernseher abgelehnt) |
| `player.castRemote.subsHint` | Subtitles on AirPlay are new; some TVs may not show them. | Untertitel über AirPlay sind neu; manche Fernseher zeigen sie nicht. |
| `player.castRemote.subsRefused` | This TV can't show the subtitles; playing without them. | Dieser Fernseher kann die Untertitel nicht zeigen; es geht ohne weiter. |
| `player.castRemote.subsNoServer` | This server can't send subtitles to AirPlay yet. | Dieser Server kann noch keine Untertitel an AirPlay senden. |
| `player.castRemote.connecting` | Connecting to {device}… | Verbinde mit {device} … |
| `player.castRemote.lost` / `reconnectBtn` | Connection lost / Reconnect | Verbindung verloren / Neu verbinden |
| `player.castRemote.cannotPlay` | Could not play on the TV | Konnte auf dem Fernseher nicht abspielen |
| `player.castRemote.continuous` | Continuous play | Durchgehende Wiedergabe |
| `player.castRemote.continuousInfo` | Episodes {a}–{b} play back to back and keep playing when you lock your iPhone. Then playback stops. | Folgen {a}–{b} laufen am Stück und spielen weiter, wenn du das iPhone sperrst. Danach endet die Wiedergabe. |
| `player.castRemote.inARow` | Playing in a row | Am Stück |
| `player.castRemote.now` | Now | Jetzt |
| `player.castRemote.minutes` | {n} min | {n} Min. |
| `player.castRemote.episodeOf` | Episode {n} of {m} | Folge {n} von {m} |
| `player.castRemote.played` / `left` | {time} played / {time} left | {time} gesehen / noch {time} |
| `player.castRemote.prev` / `prevNone` | Previous episode / Previous episode (none: this is the first) | Vorherige Folge / Vorherige Folge (keine: das ist die erste) |
| `player.castBar.onLeft` | On {device} · {n} min left | Auf {device} · noch {n} Min. |
| `player.castBar.upNextLine` | On {device} · Up next: {label} | Auf {device} · Als Nächstes: {label} |
| `player.castBar.castingTo` | Casting to {device} | Überträgt auf {device} |
| `player.castBar.more` / `collapse` | More controls / Collapse | Weitere Steuerung / Einklappen |
| `player.castBar.regionExpanded` | Now on TV, expanded | Jetzt auf dem Fernseher, ausgeklappt |
| `player.castBar.nothingThere` | Nothing from FriendFlix is playing on {device}. | Auf {device} läuft nichts von FriendFlix. |
| `player.castPicker.title` | Play on | Abspielen auf |
| `player.castPicker.what` / `whatFilm` | {title} · {episode} from {time} / {title} from {time} | {title} · {episode} ab {time} / {title} ab {time} |
| `player.castPicker.lastUsed` | Chromecast · used last time | Chromecast · zuletzt verwendet |
| `player.castPicker.another` / `chromecast` | Another TV… / Chromecast | Anderer Fernseher … / Chromecast |
| `player.castPicker.airplay` / `airplayHint` | AirPlay… / Apple TV and AirPlay TVs | AirPlay … / Apple TV und AirPlay-Fernseher |
| `player.castPicker.continuous` / `continuousHint` | Play episodes back to back / No taps in between | Folgen am Stück abspielen / Ohne Tippen dazwischen |
| `player.castPicker.thisPhone` / `thisTablet` / `thisComputer` | This phone / This tablet / This computer | Dieses Handy / Dieses Tablet / Dieser Computer |
| `player.castPicker.playingHere` / `continueHere` | Playing here now / Continue here | Läuft gerade hier / Hier weiterschauen |
| `player.castPicker.open` | Play on… | Abspielen auf … |
| `player.castTv.fromPhone` / `fromTablet` / `fromComputer` | Cast from {name}'s phone / tablet / computer | Vom Handy / Tablet / Computer von {name} |
| `player.castTv.upNextIn` | Up next in {n} s | Als Nächstes in {n} s |
| `player.castTv.keys` | OK plays now · Back stops here | OK spielt sofort · Zurück stoppt hier |
| `player.castTv.phoneCancel` | Cancel on your phone | Abbrechen am Handy |
| `player.castTv.stopHere` | Stop here | Hier stoppen |
| `player.castTv.stillKeys` | OK keeps watching | OK schaut weiter |
| `player.castTv.loading` / `stall` | Getting ready… / Loading… | Wird vorbereitet … / Lädt … |
| `player.castTv.line` | Season {s} · Episode {e} · {name} | Staffel {s} · Folge {e} · {name} |
| `common.experimental` | Experimental | Experimentell |
| `diagnose.cast.title` | Casting | Übertragung |
| `diagnose.cast.sendTest` | Send test video to TV | Testvideo an den Fernseher senden |
| `diagnose.cast.testOk` / `testFail` / `testBusy` | Test video played on {device} · first frame after {s} s / Test video did not play on {device}. / Stop casting first. | Testvideo lief auf {device} · erstes Bild nach {s} s / Das Testvideo lief auf {device} nicht. / Beende zuerst die Übertragung. |
| `diagnose.cast.copyReport` | Copy report | Bericht kopieren |
| `diagnose.cast.support` + values | Cast support: Ready · FriendFlix receiver / Ready · Google's standard receiver / Not available in this browser (needs Chrome or Edge) / Off on this server | Cast-Unterstützung: Bereit · FriendFlix-Empfänger / Bereit · Standard-Empfänger von Google / In diesem Browser nicht verfügbar (Chrome oder Edge nötig) / Auf diesem Server aus |
| `diagnose.cast.session` / `notConnected` / `playing` | Session / Not connected / Playing | Sitzung / Nicht verbunden / Läuft |
| `diagnose.cast.pass` / `passValid` | Access pass / Valid {time}, renews 10 min before it ends | Zugangspass / Gültig {time}, wird 10 Min. vor Ablauf erneuert |
| `diagnose.cast.next` / `nextLoaded` / `nextNone` | Next episode / {label} loaded on the TV / Not queued | Nächste Folge / {label} auf dem Fernseher vorgemerkt / Nicht vorgemerkt |
| `diagnose.cast.rxErrors` (plural) | Receiver errors / {n} in this session (see events) | Empfängerfehler / {n} in dieser Sitzung (siehe Ereignisse) |
| `diagnose.cast.inBrowser` / `airOk` / `airNo` | In this browser / Available / Not available here (AirPlay needs Safari) | In diesem Browser / Verfügbar / Hier nicht verfügbar (AirPlay braucht Safari) |
| `diagnose.cast.continuousOn` / `continuousOff` | On (setting) / Off (setting) | An (Einstellung) / Aus (Einstellung) |
| `diagnose.cast.subtitles` / `subsInStream` | Subtitles / Sent with the stream (new) | Untertitel / Werden mit dem Stream gesendet (neu) |
| `diagnose.cast.lastSession` / `lastSessionVal` | Last session / {when} · {n} episodes, {r} reconnects | Letzte Sitzung / {when} · {n} Folgen, {r} Neuverbindungen |
| `diagnose.cast.network` / `twoAddresses` | Network / The TV used 2 addresses (IPv4 and IPv6). Fine unless playback stops; then turn off IPv6 on the TV. | Netzwerk / Der Fernseher nutzte 2 Adressen (IPv4 und IPv6). Unproblematisch, solange die Wiedergabe läuft; stoppt sie, IPv6 am Fernseher abschalten. |
| `diagnose.cast.events` / `eventsHint` / `eventsEmpty` | Events / Kept on this device, last 200 · included in Copy report / No events yet. | Ereignisse / Nur auf diesem Gerät, letzte 200 · im Bericht enthalten / Noch keine Ereignisse. |
| `diagnose.cast.info` / `warn` / `error` | info / warn / error | Info / Warnung / Fehler |
| `settings` (admin, Phase 3 GO) `CAST_AIRPLAY_CONTINUOUS` | Continuous AirPlay (experimental) | Durchgehendes AirPlay (experimentell) |
| `account.playback.airplayContinuous` (Phase 3 GO) | Continuous AirPlay · Play episodes back to back | Durchgehendes AirPlay · Folgen am Stück abspielen |

Reused: `player.cast.stop` (Stop casting / Übertragung beenden), `player.cast.playingOn`, `player.airplay.playing`,
`player.airplay.choose`, `player.airplay.chooseHint`, `player.castBar.*` (existing), `player.controls.*`,
`player.skip.intro` / `recap`, `player.pause.paused`, `player.watch.stillTitle` / `stillText`, `diagnose.airplayCopy` /
`airplayClear`.

## 12. Accessibility details

- Remote screen: one `h1` (title); the control panel is `role="group"` "Playback controls"; sliders and switch as described;
  chips are menu buttons (`aria-haspopup="menu"`, `aria-expanded`); the hint's dismiss is a named button.
- Bar: `role="region"` (`player.castBar.region`; expanded: `regionExpanded`), every button named, the state line is part of
  the open-remote button's description, the progress is a `progressbar`; focus is kept when a button swaps (existing
  `keepFocus`), expanded ↔ collapsed moves focus to the counterpart button.
- Sheet: dialog semantics, focus trap, Escape, focus return; switch row label is the `<label>`.
- Diagnose: definition lists for the cards, a table with headers for events, level as text + icon.
- Contrast is checked by the existing contrast helpers (`web/src/lib/a11y/contrast.test.ts` pattern) for the new pairs:
  `.72` white on `.frost-safe`, amber and error text on the bar, coral eyebrow `#ff8aa0` on the ambient, `#ffa7b6` on the TV
  solid panel, `.78` white on the TV panel.

## 13. Docs and roadmap

- `ROADMAP.md` line 1: the "token gate for 'next episode' on the receiver" already shipped (`backend/src/cast.ts`
  `nextOverlap`); the line is rewritten to what this block delivers (redesigned cast screen and bar, casts that survive the tab,
  TV pause and loading screens, AirPlay subtitles, experimental continuous AirPlay if it passes its test, casting diagnostics).
- `docs/cast.md` (German): step 4 of "Ablauf" (tab close no longer ends a Chromecast cast), new sections "Übertragung überlebt
  den Tab", "Abspielen auf …", "Fernbedienung", "/diagnose → Übertragung", AirPlay subtitles, the queueing changes, the
  continuous-AirPlay outcome. The "Fortschritt am Fernseher" wording is corrected to "Fortschritt melden".
- `docs/cast-receiver.md` and `docs/de/cast-receiver.md`: pause and loading screens, restyled card, key hints, the hardware
  checks list.
- `docs/security.md` "Cast receiver" / cast token section: the security model change of section 4.
- `docs/android.md`: the bar while browsing; "Closing the player stops the cast" is replaced.
- `README.md` / `README.de.md` feature lines, `CHANGELOG.md` one line per phase under *Unreleased*.

## 14. Testing

- Unit (Vitest, Node, fakes as in `engine.test.ts`, `cast.test.ts`, `receiver.test.ts`): resume helpers (castId derivation,
  hint parse/expiry), engine pagehide keeps Chromecast / ends AirPlay, re-adoption (ours, not ours, queued restore, detached),
  session autoplay switch, queue from the start and the fresh-token fallback, cast log scrub and report anonymisation,
  receiver logic (pause timing, loading, key-seen hint, sender pill timing), backend lookup scoping (account, profile, device,
  kind), refused counter (families only), queued token pin copy and TTL linkage, profile switch revoke, gateway subtitle
  rendition keep/drop, AirPlay subtitle fallback.
- e2e (Playwright with the existing Cast SDK and AirPlay fakes in `e2e/mocks/cast.ts`, receiver fake in
  `e2e/mocks/castReceiver.ts`): remote screen desktop / phone / AirPlay, bar collapsed / expanded / states, sheet rows per
  browser, reload keeps the cast and the bar returns, detached bar reconnect, Diagnose section and copy report content,
  receiver screens, Android shell bar via the native bridge fake (`e2e/mocks/native.ts`). German UI as in the existing specs.
- On-device checks for the owner are listed per phase in the plan.

## 15. Phases (each its own pull request; the app works after each)

1. **Web sender:** backend lookup and queue changes, tab survival and re-adoption, remote screen, bar collapsed / expanded /
   states, *Play on* sheet, Diagnose casting section, strings, docs.
2. **Chromecast receiver:** up-next restyle, pause screen, loading screen, sender pill, keys, solid panels and margins, docs.
3. **AirPlay:** subtitles in the stream with fallback; the continuous-play spike; the feature behind its settings only on GO;
   docs either way.
4. **Android:** app-scoped cast hub, bar while browsing in the shell, play while casting, re-adoption, docs.

## 16. Decisions made here (owner may overrule)

1. Remote quality control dropped (not on the boards).
2. The autoplay switch on the remote is per cast session, not the account preference.
3. The *Play on* sheet's "last used TV" row opens the browser's device list (the web cannot connect to a named Chromecast).
4. Re-adoption only on the device that started the cast; the hint stores the public castId only.
5. Profile switch now revokes the device's casts server-side.
6. Queue from the start, queued token pinned at mint and living as long as its predecessor.
7. Test video is a bundled 6-second clip (no media server, Chromecast only).
8. TV up-next card has no buttons on remote-driven TVs; key hints appear only after a key was seen.
9. Sender pill uses the profile name.
10. Continuous AirPlay: admin switch plus profile preference; max three episodes; NO-GO if the LG TV fails P1–P2 even when the
    Apple TV passes.
11. AirPlay subtitles: Jellyfin only; one rendition; failure remembered per browser for 30 days.
12. Fixture titles replace "Harbour Lights" and "Paper Moons".
13. Phone bar keeps the board's set (Pause, Stop; no Next, no expand).
14. Event texts in the Diagnose log stay technical English; device names are anonymised in the copied report.
