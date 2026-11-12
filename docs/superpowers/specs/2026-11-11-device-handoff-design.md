# Device hand-off, media controls, AirPlay status and continuous AirPlay (design)

Date: 2026-11-11 · Base: `main` = release 3.3.0 · Status: approved by the owner ("approach 1"); the owner's answers to the two
open questions (owner decisions 6 and 7) are written in

## Goal

Moving between screens should feel like one FriendFlix. Whatever you started on the TV, the PC or the iPhone, the next screen
knows where you stopped and offers to continue there with one action. While something plays from the web UI, the lock screen,
Control Center and the keyboard's media keys show it and control it, also during AirPlay. AirPlay says what it is doing instead
of freezing. And the next episode can keep playing over AirPlay with the iPhone locked, behind an admin switch.

### Owner decisions (fixed, not reopened here)

1. **Who uses what.** The owner mostly watches on the TV apps (Samsung Tizen, LG webOS, Fire TV) and the Windows app, sometimes
   on the iPhone in Safari with AirPlay to an AirPlay-capable TV. There is **no Apple TV**. Android and Chromecast matter less.
2. **A, "Continue here".** The server knows per profile which device last played what, how far and when. Every client shows
   (a) a card at the top of the start page "Zuletzt auf ‹Gerät›: ‹Titel› S1:F4 — hier weiterschauen ab 23:10?" with one action
   that starts playback on this device, and (b) on the title page a hint "Weiter ab 23:10 (zuletzt auf ‹Gerät›)". Only when the
   other playback was on a **different device** within the **last 6 hours** and the title is **not finished**. Dismissible.
   Works with the TV remote. **No live takeover**: the other device is never stopped remotely.
3. **C, media controls.** Media Session API for playback and casting from the web UI: title, series and episode, artwork through
   the existing image proxy (never a tokenised URL), actions play, pause, seek, next, previous, and the position state, so the
   iOS lock screen and Control Center and desktop media keys show and control playback, including during AirPlay. The iPhone's
   volume buttons already drive the AirPlay TV natively.
4. **D, AirPlay status.** "Verbinde mit AirPlay …" while connecting, then "Läuft über AirPlay"; no frozen picture while
   connecting; the TV continues at the same position. Remembering the AirPlay target is impossible (system picker).
5. **E, continuous AirPlay** = Tasks 23–27 of `docs/superpowers/plans/2026-11-10-cast-airplay.md`, informed by the spike
   (findings kept with the spike, outside the repo). New: it ships **behind an admin switch that is off by default** (existing
   admin settings, stored in the database); the **owner's acceptance test on the LG AirPlay TV** replaces the spike's hardware
   test (P1 three episodes with the iPhone locked, P2 boundary gap ≤ 5 s); Apple TV criteria are dropped. Fails → the switch
   stays off.
6. **Device renaming is part of A.** On the existing devices page (*Geräte*) a user renames their own devices ("Wohnzimmer",
   "Schlafzimmer"). The custom name wins over the auto-detected name everywhere: hand-off card, title-page hint, the sender in
   cast labels ("AirPlay (Annas iPhone)"), the device lists. Validation, per-account ownership and i18n in section 2.8.
7. **Continuous AirPlay has no per-profile opt-in.** The admin switch alone turns it on for every profile; there is no
   profile setting (Task 26 of the cast plan loses its profile preference, sheet switch and account row).

## Scope

In: A (server record, API, start-page card, title-page hint on every client, device renaming on *Geräte*), C (Media Session for local web playback, small
additions to the existing cast binding), D (AirPlay connecting state, wording, position guard, timeout), E (Tasks 23–27 with the
changes in section 5).

Out (written down so nobody adds them):

- Android notification / lock-screen cast controls and volume keys for casts.
- Remembering the last Chromecast beyond what 3.3 does (`ff-cast-last`, browser picker).
- Live remote takeover (stopping or pausing the other device), and "send to device" (push a title to a running TV app, in the
  style of a connect feature). The latter is a possible later project; nothing here prepares a protocol for it.
- Content-Security-Policy work.
- A per-profile switch for continuous AirPlay (owner decision 7).
- A hand-off card on the kids home page (`/kids`); kids profiles get the title-page hint only (section 2.6).

## Global constraints (restated project rules)

- **Motion:** animate only `transform` and `opacity`; opening and closing both animate; **nothing jumps**: anything that
  appears reserves its space first or overlays without moving content. Calm mode / reduced motion (`html.m-still`,
  `motionAllowed()` false): durations 0, solid panels (`--fr-solid`), static spinners. TV and kids profiles are always solid.
  `web/src/lib/admin/glass.test.ts` keeps scanning the new stylesheets.
- **Own look:** FriendFlix glass (`.frost`, `.frost-safe`, `.frost-panel`, `.frost-btn`, tokens `--fr-*`), coral accent, Inter.
  No look-alike of a commercial streaming service. "Netflix" and "Seerr" never appear in user-facing text.
- **Fictional titles** in tests, fixtures and screenshots: Dunmoor S1 E4 *The Lantern Road*, S1 E5 *Wrenfield Pier*;
  Saltwater Almanac S2 E1 *Night Market*, E2 *The Toll Keeper*, E3 *Glass Tides*. Profile `Anna`. Docs use placeholder hosts
  only (`friend.example.com`, `192.0.2.x`).
- **Secrets:** the media-server token never reaches a client; cast tokens never in metadata, logs, Diagnose, storage or error
  texts. New: device ids and play session ids never leave the server in the hand-off API.
- **Accessibility at the 3.1 level:** contrast ≥ 4.5:1 (also over artwork), targets ≥ 44 px, keyboard and remote operable with
  a visible focus ring, every control named, polite announcements, colour never the only carrier of meaning.
- **i18n:** every string through `#lib/i18n` in all seven locales (`de` typed source, `en`, plus `es`, `fr`, `it`, `pl`, `tr`
  translated by the implementer); the copy table gives DE and EN.
- **Tests:** Vitest and Playwright in the existing style (German UI in e2e); locally only root `npm run typecheck` and the new
  test files; CI runs the rest. No new dependencies.

---

## 1. Architecture overview

| Part | Server | Web UI (all clients) | Native shells |
|---|---|---|---|
| A | `devices.client` and `devices.name` columns; new table `handoff`; logic in `backend/src/handoff.ts`; write in `playbackReport` and route `GET /api/handoff` (`backend/src/routes/media.ts`); `PATCH /api/devices/:id` (rename) | `web/src/lib/handoff/` (`handoff.ts` pure logic, `HandoffCard.svelte`); start page; `DetailView` hint; rename on *Geräte* | none (the card's action uses the existing native `play` bridge call) |
| C | none | `web/src/lib/player/mediasession.ts` (local playback); small changes in `web/src/lib/cast/mediasession.ts` | none (mpv in the Windows app and Media3 on Android keep their own) |
| D | none | `web/src/lib/player/airplay.ts`, `Player.svelte`, `RemoteScreen.svelte`, one string | none |
| E | Tasks 23–25 (backend, gateway) + the admin switch | Tasks 26–27 | none |

What exists and is reused (3.3.0):

- Every playback report (web player, Android player, Windows app's mpv, the cast engine for AirPlay and the Default Media
  Receiver, FriendFlix's own receiver via `/api/cast/report`) goes through `playbackReport()` with the account, the **profile**
  and the **device id** of the session (for casts: the sending device). Jellyfin keeps one resume position per profile (each
  profile has its own Jellyfin user); `Live` records in Redis expire after 45 s; `play_daily` / `play_seconds` are aggregates.
  None of them answers "which device, how far, when", so A needs one small table.
- `devices(user_id, device_id, label, approved, created_at, last_seen, kids_profile_id)`; `label` is set once from the user
  agent ("Safari auf iPhone") or "Fernseher (TV-Modus)" for a paired TV. All TV apps pair through `/tv`, so their labels are
  identical today.
- Clients identify themselves in the user agent: ` FriendFlixAndroid/`, ` FriendFlixDesktop/`, ` FriendFlixFireTV/`,
  ` FriendFlixTizen/` (when Tizen allows it; otherwise `Tizen` + `SMART-TV`), `Web0S` (LG app and LG browser alike).
- `bindCastMediaSession` (`web/src/lib/cast/mediasession.ts`, bound in the root layout) already covers casts, AirPlay included
  once the engine adopted it. Local web playback has **no** Media Session today.
- AirPlay: `createAirPlay` states `available / busy / ready / active / error`, the engine's `connecting` phase after the
  hand-over, the remote screen's backdrop and status line.

## 2. Part A: "Continue here"

### 2.1 Data model (migration 46)

```
alter table devices add column client text
  check (client in ('web','tizen','webos','firetv','desktop','android'));
alter table devices add column name text                       -- the user's own name for the device (section 2.8); null = none
  check (name is null or char_length(name) between 1 and 40);

create table handoff (
  profile_id     uuid not null references profiles(id) on delete cascade,
  user_id        uuid not null,
  device_id      text not null,
  item_id        text not null,              -- the movie or the episode
  series_id      text,                       -- episodes only
  position_ticks bigint not null,
  runtime_ticks  bigint,
  via            text check (via in ('airplay','chromecast')),   -- null = played on the device itself
  started_at     timestamptz not null default now(),             -- this device began this item
  updated_at     timestamptz not null default now(),             -- server clock of the last report
  primary key (profile_id, device_id),
  foreign key (user_id, device_id) references devices(user_id, device_id) on delete cascade
);
create index handoff_recent on handoff (profile_id, updated_at desc);
```

- One row per **profile and device**: the latest thing that device played for that profile. The table stays tiny (profiles ×
  devices) and needs no job.
- Removing a device, a profile or the account deletes its rows (foreign keys). Rows older than 24 h are deleted lazily on each
  read and write of the profile (one `delete … where updated_at < now() - interval '24 hours'`).
- `devices.client` is a property of the device, not of a playback: set at registration (`registerDevice`) and at TV claim
  (`routes/tv.ts`) from the request's user agent, and corrected by `GET /api/me` when the user agent's kind differs from the
  stored one (one conditional update). Existing rows start `null` and are filled at their next `/api/me`. The Windows app's mpv
  and the Android player report with their own HTTP clients; that does not matter, because the kind is read from the device row.
  `GET /api/me` never downgrades a stored kind to `web` (the native players call it with their own HTTP client and the WebView's
  cookie); it fills an empty kind and may replace one specific kind or `web` by another specific kind.
- `clientKind(ua)` (backend, pure): ` FriendFlixFireTV/` → `firetv`; ` FriendFlixTizen/` or (`Tizen` and `SMART-TV`) →
  `tizen`; `Web0S` → `webos`; ` FriendFlixDesktop/` → `desktop`; ` FriendFlixAndroid/` → `android`; anything else → `web`.
  The kind is a display hint for the account's own devices; a forged user agent can only mislabel the forger's own device.

### 2.2 Writing (server)

`playbackReport()` upserts the row after the media-server report, for every `start`, `progress` and `stop`, when it has a
profile and a device id (all current reporters have both; a report without either is skipped). Best effort: a failed write is
logged without ids and never fails the report.

- `position_ticks`, `updated_at = now()` always; `started_at = now()` when `item_id` changes or on `start`.
- `series_id` and `runtime_ticks` from the item that `playbackReport` already loads when it builds a live record (kept when the
  item did not change).
- `via`: `/api/cast/report` passes `chromecast` (own receiver, token claims); `/api/playback/*` accepts an optional body field
  `via: 'airplay' | 'chromecast'`, which the cast engine sends for the reports it makes; continuous AirPlay's server-side
  reports (Task 25) pass `airplay`. Anything else: `null`.
- Cost: one primary-key upsert per report (every 10 s per playing device). No throttle needed.

### 2.3 API

`GET /api/handoff` and `GET /api/handoff?item=<id>` (`requireUser`, profile header as usual, `Cache-Control: no-store`,
rate limit 60/min). Never cached in `/api/home` (that answer is cached per profile; the card depends on the device).

Selection, all in server time (no client clock involved):

1. Lazy cleanup (24 h).
2. Without `item`: the profile's **newest row overall**. With `item` (a movie, episode or series id): the profile's newest row
   whose `item_id` or `series_id` equals it.
3. `null` when that row belongs to **this** device, is older than **6 h**, has `position < 60 s`, or has `position ≥ 90 %` of
   `runtime_ticks` (Jellyfin's own "played" threshold).
4. `null` when the title is hidden from *Weiterschauen* (`resume_hidden` for the item or its series with `hidden_at ≥
   updated_at`) or dropped (`dropped`).
5. The item is loaded as the profile's Jellyfin user. Not found or not allowed (deleted, library or role change, kids cap) →
   the row is deleted, `null`. Marked played → `null`.

Answer:

```
{ handoff: null | {
    id: string,                      // opaque, stable while that device plays that title (sha256 of device, item, started_at; 16 hex)
    itemId: string, type: 'Movie' | 'Episode', title: string,
    seriesName?: string, season?: number, episode?: number, imageId: string,
    positionTicks: number, runtimeTicks?: number,
    ageSec: number,                  // now() - updated_at, from the server
    device: { kind: 'web'|'tizen'|'webos'|'firetv'|'desktop'|'android', name?: string, via?: 'airplay'|'chromecast' }
} }
```

`device.name` is the device's custom name when it has one (section 2.8, any kind), otherwise the stored label for `kind: 'web'`
(e.g. "Safari auf iPhone"), otherwise absent. No device id, no play session id, no address, no URL.

### 2.4 Start page card

`HandoffCard.svelte`, used by `web/src/routes/+page.svelte` on every layout. It loads `GET /api/handoff` after mount and again
whenever the page's existing `refreshProgress()` runs (visibility change, back/forward restore; at most every 5 s).

- **Content** (one sentence when read aloud, owner's wording): eyebrow "Zuletzt auf LG-Fernseher · vor 12 Min.", title line
  "Dunmoor S1:F4 · The Lantern Road" (films: title · year), primary button **"Hier weiterschauen ab 23:10"**, secondary icon
  button **Ausblenden** (×). Small 16:9 thumbnail on desktop and TV only. Time = position in the player's format (m:ss,
  h:mm:ss from one hour); age via `fmtRelative` from `ageSec` ("gerade eben" under 2 min).
- **Never moves the page:** the card is an **overlay** on the page's top area, never part of the flow. It enters with opacity
  and `translateY(-8px)` (240 ms, `outEase`) and leaves with opacity (180 ms); the rows below never move. Placement:
  - desktop (`DeskBillboard`, `Hero`): top right of the billboard, inside `--pad-x`, below the top bar, width 380 px,
    `.frost .frost-safe .frost-panel` (radius 24);
  - phone (carousel or hero): under the header and the category chips, 16 px gutters, full width, same glass; it scrolls away
    with the page (absolute, not fixed);
  - TV mode (`TvFocusTile`, all three TV apps and `?tv=1`): top right of the tile inside `--tv-gutter`, **solid** panel, TV
    type scale of the tile; visible only while the tile shows the billboard (focus in the tile); moving into the rows fades it
    out (not dismissed), coming back shows it again.
- **Action:** behaves like any play button on that client (`playOrCast`): web player → `/watch/<itemId>?t=<seconds>`; Windows
  and Android apps → native `play` with `startMs` (an explicit position, because the card promises one); while a cast runs →
  plays on the TV at that position. The other device keeps whatever it does.
- **Dismiss:** per device, in `localStorage` `ff-handoff-dismissed` (list of the last 20 `id`s, try/catch; without storage the
  dismissal lasts until the page is left). A newer playback on the other device (new `id`) brings a new card. The title-page
  hint is not affected.
- **TV remote:** if the answer arrives within 2 s of mount and no key was pressed yet, the primary button takes focus (OK
  continues); otherwise focus is never stolen and Up from the tile's buttons reaches the card (spatial navigation). Right
  moves to *Ausblenden*. Back on the card returns focus to the tile's first button without dismissing. After *Ausblenden* focus
  goes to the tile's first button.
- Not shown in the kids home (`/kids`), on `/tv` pairing, in setup, or while offline (a failed request shows nothing).

### 2.5 Title page hint

`DetailView` (page, desk and TV variants) loads `GET /api/handoff?item=<id>` with the page. When it answers and its `itemId` is
the page's play target (`playTarget`; on a series page the episode the button would play, otherwise nothing is shown):

- the button keeps its label (*Fortsetzen* / *Weiter*), so its width never changes;
- the existing resume line under it (`resumeLine`, which exists whenever there is a position) is replaced in place by
  "S1:F4 · Weiter ab 23:10 (zuletzt auf LG-Fernseher)", one line with ellipsis: a text swap in a reserved line, no jump;
- the play action starts at the hand-off position (`?t=` / `startMs`), the same rule as the card;
- the button's accessible name gains the hint ("Fortsetzen, weiter ab 23:10, zuletzt auf LG-Fernseher").

### 2.6 Per platform

| Client | Card | Action | Notes |
|---|---|---|---|
| Browser (desktop, phone, iPhone Safari) | desktop / phone placement | web player `?t=` | the Safari PWA counts as its own device (own cookie) |
| Windows app | desktop placement | native `play` → mpv with `startMs` | mpv's reports carry the app's session, so its playback is a hand-off source too |
| Samsung / LG / Fire TV apps | TV placement, remote rules | web player in TV mode `?t=` | device names "Samsung-Fernseher", "LG-Fernseher", "Fire TV" |
| Android app | phone placement in the shell | native `play` with `startMs`; casting via the app's hub: TV | |
| Kids profiles | no card on `/kids` | title-page hint only | own rows only; the Jellyfin lookup applies the kids cap |

Device name shown: the custom name when the device has one (section 2.8); otherwise `tizen` "Samsung-Fernseher", `webos`
"LG-Fernseher", `firetv` "Fire TV", `desktop` "Windows-App", `android` "Android-App", `web` the stored label; with `via`:
"AirPlay ({sender})" or "Chromecast ({sender})" where `{sender}` is the sending device's name by the same rule (Safari on the
iPhone casting to the LG TV reads "AirPlay (Safari auf iPhone)", or "AirPlay (Annas iPhone)" once renamed).

### 2.7 Edge cases

- **Same device:** no card (newest row is this device). Two browsers on one PC are two devices.
- **Several profiles:** rows, reads and dismissals are per profile; switching profile shows that profile's state only.
- **Finished:** ≥ 90 % or played → nothing. The next episode is *Als Nächstes*'s job, not the card's.
- **Two devices playing at once:** allowed, as today (stream limit unchanged). The newest report wins; nothing is stopped.
- **Casts:** the row belongs to the sending device with `via`; on the sending device itself no card. With the Default Media
  Receiver and no page open, no reports arrive (3.3 behaviour), so the row keeps the last page-side position.
- **Continuous AirPlay:** its server-side per-episode reports (Task 25) move the row from episode to episode; the position
  leads the picture by the TV's buffer (section 5).
- **Clock skew:** every time is the database's `now()`; the client only formats `ageSec`.
- **Offline / server unreachable:** no card, no error. Downloads played offline are not a source.
- **Title deleted or no longer visible:** row deleted at read, nothing shown.
- **Device removed or account deleted:** rows go with it (foreign key).
- **Watch party:** its reports count like any playback (a film started in a party can be continued alone).

### 2.8 Device renaming (owner decision 6)

Two TVs of the same make read the same name; the owner wants "Wohnzimmer" and "Schlafzimmer".

- **Where:** the existing devices page (*Geräte*, `/devices`), in the list of approved devices (this device included). Each row
  gets an icon button *Umbenennen* (named "‹Name› umbenennen"). It turns the name cell into an inline form in the same row: a
  text field (label "Gerätename", placeholder = the auto-detected name, at most 40 characters), *Speichern*, *Abbrechen*, and,
  when the device has a custom name, *Automatischen Namen verwenden*. Enter saves, Escape cancels; focus returns to the rename
  button. Every row reserves the field's height, so opening the form moves nothing. Works with the TV remote (field and buttons
  are focusable in reading order).
- **API:** `PATCH /api/devices/:id` with `{ name: string | null }` (`requireGrownUp`; CSRF as every write; rate limit 30/min).
  Only a device of the caller's own account (`where user_id = <account> and device_id = :id`; anything else 404, the same answer
  for a foreign and a missing id). `null` or a name with no visible character (see Validation) resets the custom name. Audited as
  `device.rename` without the name.
- **Validation (server is the authority, the form mirrors it):** Unicode NFC, trimmed, inner whitespace runs collapsed to one
  space; 1 to 40 characters (code points) after that; control characters (`\p{Cc}`), lone surrogates, the bidirectional controls
  U+202A–U+202E and U+2066–U+2069 and the direction marks U+200E, U+200F, U+061C are refused with `400 invalid_name` (emoji,
  including joiners, are fine). A name with no visible character (only spaces, zero-width characters, joiners, variation
  selectors, default-ignorable code points such as the Hangul fillers, or the braille blank U+2800) counts as blank and resets the name. Two devices may share a name.
- **Display rule, everywhere:** custom name → otherwise the client kind's name (section 2.6; not for `web`) → otherwise the
  stored label. Used by *Geräte*, the account page's sessions card, the hand-off card and title hint (including the sender in
  "AirPlay ({sender})"), and the admin device views (`coalesce(name, label)`). The notification sent when a new device
  registers keeps the auto-detected label (it has no custom name yet). The cast receiver's sender pill stays the profile name
  only (cast spec: no device name on the TV).
- **Privacy:** the name is the account's own text, stored with the device and deleted with it; it appears in the data export
  next to the label; never in logs or audit metadata.

## 3. Part C: media controls (Media Session)

### 3.1 Local playback in the web player (new)

`bindPlayerMediaSession(player)` in `web/src/lib/player/mediasession.ts`, bound by `Player.svelte` while it plays **locally**
(not as remote, not handed off, not in the offline player):

- **Metadata:** `title` = episode title or film title; `artist` = "Dunmoor · S1:F4" (episodes) or the year (films); artwork =
  `img(id, 512)` of the episode (16:9) and of the series poster, films their poster: the cookie-authenticated
  `/media/Items/<id>/Images/Primary` path through the existing gateway. **Never** a `/media/c/<token>/` URL, never a query with
  credentials. No `sizes` claim (the proxy keeps the aspect ratio).
- **Actions** call the same functions as the on-screen controls, so watch party sync, *Noch da?*, progress reports and
  analytics behave exactly as after a tap: `play`, `pause`, `seekto`, `seekbackward` / `seekforward` (default 10 s),
  `nexttrack` (next episode; only when one exists), `previoustrack` (previous episode of the same series; only when the player
  knows one from the episode list it already loads; never for films or the first episode). Unsupported actions are caught.
- **Position state** from the element (duration, position clamped to it, playbackRate) on `loadedmetadata`, seek, rate change
  and at most once per second on `timeupdate`. `playbackState` mirrors play / pause.
- **One owner at a time:** the cast binding (layout) owns the session while `liveCast(castSession)`; the player's binding owns
  it otherwise. A small owner token in `web/src/lib/cast/mediasession.ts` makes "release" a no-op for a binding that no longer
  owns it (no flicker when the player hands over to AirPlay or Chromecast and back).

### 3.2 Casts (existing binding, small changes)

- Keeps today's behaviour (metadata, play / pause / seek / ±10 s / next episode, position state).
- Adds `previoustrack` only in continuous AirPlay mode (Task 27's boundary seek), disabled on the first episode.
- Continuous AirPlay: while the joined stream plays, metadata is the series ("Saltwater Almanac", artist "S2:F1–F3") and the
  position state covers the whole joined stream, because a locked iPhone's page cannot update it per episode (spike risk). When
  the page wakes it switches to the current episode's metadata and position.

### 3.3 Per platform

- **iPhone Safari:** lock screen and Control Center show title, artwork and the buttons Safari maps (±seek or track buttons,
  Safari decides); during AirPlay the same session controls the TV. **The volume buttons change the AirPlay TV's volume
  natively**; FriendFlix adds nothing for volume.
- **Chrome / Edge on Windows and macOS:** media keys and the system media overlay (Windows SMTC) follow the Media Session.
- **Windows app:** its player is mpv, which already drives the media keys and the Windows media overlay (`docs/windows.md`,
  owner check 17); nothing changes there. Only the app's fallback *Play in the web player* (WebView2) uses this binding; whether
  WebView2 forwards it to SMTC is recorded in the owner check, not required.
- **TV apps:** binding runs harmlessly (no lock screen); the remotes keep their existing key maps.
- **Android app:** its native player has its own session; out of scope (see Scope).

## 4. Part D: AirPlay status

### 4.1 States the viewer sees

| Phase (signals) | Player / remote screen | Cast bar |
|---|---|---|
| Tap on AirPlay until the token stream is on the element (`busy`) | **connecting layout**: the title's backdrop with the remote screen's dim treatment (never the video's frozen frame), spinner in the play slot, status "Verbinde mit AirPlay …", *Abbrechen* | — |
| Picker open, phone plays the token stream (`ready`) | unchanged: video plays here, prompt "Jetzt den Fernseher in der Liste auswählen." + *Fernseher auswählen* | — |
| TV picked: `video.remote.state === 'connecting'` (Remote Playback API, Safari 13+) or wireless reported but `active` not yet (settle window) | connecting layout again | — |
| `active`, engine adopted, TV not yet playing (engine `connecting`) | remote screen in `connecting` ("Verbinde mit AirPlay …") | "Verbinde mit AirPlay …" |
| first `playing` on the route | remote screen playing, eyebrow "Läuft über AirPlay" | "Auf AirPlay · noch 32 Min." |
| no `playing` within **30 s** of the TV being picked | remote screen `reconnect` ("Verbindung verloren", *Neu verbinden* opens the picker from the tap) | as today |

- The device word for AirPlay becomes **"AirPlay"** (`player.castBar.airplayDevice`, today "AirPlay-Gerät"), so every existing
  template reads naturally: "Verbinde mit AirPlay …", "Auf AirPlay · noch 32 Min.". The playing label stays the shipped
  "Läuft über AirPlay" (the owner's "Läuft auf AirPlay", same meaning, already in seven locales; decision 6).
- *Abbrechen* in the connecting layout = the existing restore (token revoked, local stream back at the position).
- The connecting layout is an overlay over the video area, so nothing moves; it crossfades (opacity 120 ms) between phases.

### 4.2 Same position on the TV

The controller already puts the token URL on the element at the position of the tap. New guard: on the first `playing` while
wireless, if the element's time differs from the hand-over position by more than 5 s, **one** seek to that position (logged in
the AirPlay log as `position corrected`, no URL). Never a second correction.

### 4.3 Platform limits written down

- Safari never tells which AirPlay device was picked, and a page cannot open AirPlay to a named device: the *Play on* sheet's
  AirPlay row always opens the system picker. No "last AirPlay TV" is stored.
- AirPlay still ends when the page closes (3.3 behaviour).
- Everything here is feature detection (`webkitShowPlaybackTargetPicker`, `webkitplaybacktargetavailabilitychanged`,
  `webkitcurrentplaybacktargetiswirelesschanged`, `video.remote`), no user-agent sniffing.

## 5. Part E: continuous AirPlay behind an admin switch

Tasks 23–27 of `docs/superpowers/plans/2026-11-10-cast-airplay.md` and spec `2026-11-10-cast-airplay-design.md` §1
(continuous mode on the remote screen) and §8 "The feature" stay the design. **This section supersedes §8 "The spike" (the GO
rule) and decision 10 of that spec.** Only the changes:

1. **No GO gate before merging.** Tasks 23–27 are implemented and merged; the feature is dormant until the admin turns it on.
   Task 22's hardware run on the spike branch is replaced by the acceptance test below. The spike branch is never merged;
   its code (`joinPlaylists`, tuple scope, tests) may be ported where it exists.
2. **Admin switch:** `CAST_AIRPLAY_CONTINUOUS` in the config schema and `backend/src/settings/registry.ts` (kind bool, group
   playback, default **false**, applies live, stored in the `settings` table like the other playback settings), shown in
   *Admin → Einstellungen → Wiedergabe* with the *Experimentell* badge and a help line (copy table). Off: `POST
   /api/cast/session` with `continuous: true` answers `400 continuous_off` and the web silently asks for a single-episode
   token; `/api/cast/config` reports `airplayContinuous: false`, so the Diagnose row does not render. Switching it off does not
   cut a joined stream that already plays (it ends after its last episode or on *Stop casting*); new requests get single tokens.
3. **No profile opt-in** (owner decision 7): with the switch on, every profile's AirPlay cast of an episode asks for a joined
   stream (when autoplay is on and "sleep after this episode" is not set). Task 26 loses its profile preference
   `airplayContinuous`, the *Play on* sheet's switch row (the existing `continuous` row and its two strings are removed) and the
   *Konto → Wiedergabe* row; the Diagnose row shows "An (Einstellung)" while the switch is on.
4. **Spike conditions adopted as requirements** (spike findings §4): (a) `contentUrl` is `joined/master.m3u8` (one variant plus
   the subtitle rendition); Task 24 adds the master route; (b) tuple scope: each listed item only with its own media source and
   play session; subtitle paths and the no-burn-in guard use that item's subtitle index; (c) Task 25 takes the position from
   the segment's `runtimeTicks` (not index × segment length) and gets it by a separate, throttled, fire-and-forget gateway →
   backend call (at once on a part change, else at most every 15 s), not inside the memoised authz call; **no lead
   correction** in this round (observation O2 below decides a later one); (d) **short segment URIs** in the joined playlist
   (`../s/<part>/<n>.ts`, expanded by the gateway from the token's stored per-item query) are **required**, because the LG is
   the target and the joined playlist would otherwise be ~1.9 MB; (e) subtitle warm-up of E2 / E3 at mint, subtitle languages
   from the items' streams instead of a second PlaybackInfo; (f) page: no page reports and no per-title credits / up-next for
   joined tokens; every re-mint restarts at (episode, offset); (g) joined playlists built once per token after authz, cached by
   token hash, the whole stream refused when any part fails the URI check.
5. **Acceptance test (owner, LG webOS AirPlay TV only)** on the merged build with the admin switch on, three consecutive
   episodes of one series (text subtitles optional):
   - **P1:** the three episodes play to the end of the third with the iPhone locked from minute 1 of episode 1 and no touch.
   - **P2:** at each of the two boundaries the picture is back within **5 s** (stopwatch), no AirPlay placeholder, the route
     never falls back to the iPhone.
   - Pass both → the switch stays on. Either fails → the switch goes off, the feature stays dormant, `docs/cast.md` says so.
   - Recorded but **not gating**: O1 the admin view shows one stream and `cast_requests_total` gains no 401 / 403 / 502;
     O2 the server position's lead over the TV's picture in episode 2 (three samples); O3 CPU / transcodes on the server at a
     boundary. Apple TV criteria (old P3–P6) are dropped. Another AirPlay TV (e.g. Samsung), if at hand, is an observation
     only; because the switch applies to every profile, a TV that fails it later is a reason to turn the switch off again.
6. **Task 28 (docs)** is written after the acceptance with its outcome; the CHANGELOG line of the implementing release says
   "Continuous AirPlay (experimental, off by default)" and replaces 3.3's "whether it ships depends on a hardware test on an
   Apple TV and an LG TV".

## 6. Privacy and security

- **Hand-off data** is per profile, readable only by that profile, never shown to friends (unlike *Gerade läuft* with shared
  history), never in `/api/nowplaying`, admin views or statistics. It holds item ids, positions and the server time; no
  address, no title text, no token. Kept ≤ 24 h, one row per device, deleted with the device, profile or account.
  `docs/privacy.md` gets one paragraph.
- **The API answer** carries no device id, play session id, address or URL; the opaque `id` cannot be turned back into a
  device id. Device names are the account's own custom names (section 2.8), client kinds, or the label the account's own
  device got at registration.
- **Kids profiles:** only their own rows; the item lookup runs as the kids profile's Jellyfin user, so a title above its cap
  never appears; no card on `/kids`.
- **Media Session:** metadata is title, series line and the cookie image path only; lock screens show titles to whoever holds
  the phone (as every media app does). No cast token, no `/media/c/` URL, no media-server token in artwork.
- **Logs:** hand-off writes log nothing on success and only an error class on failure (no ids, no titles). New AirPlay log
  lines (`connecting`, `position corrected`, `connect timeout`) go through the existing scrubbing (no URLs, tokens, castIds).
- **Continuous AirPlay** keeps the spike's security review (findings §5): up to three items per token, same profile, tuple
  check, IP pin, idle expiry, cap, revoke paths, hashed and never logged.

## 7. Copy (DE / EN; es, fr, it, pl, tr translated)

| Key | DE | EN |
|---|---|---|
| `home.handoff.region` | Auf einem anderen Gerät angefangen | Started on another device |
| `home.handoff.last` | Zuletzt auf {device} · {ago} | Last on {device} · {ago} |
| `home.handoff.play` | Hier weiterschauen ab {time} | Continue here from {time} |
| `home.handoff.playAria` | Hier weiterschauen: {title} ab {time}, zuletzt auf {device} | Continue here: {title} from {time}, last on {device} |
| `home.handoff.dismiss` | Ausblenden | Dismiss |
| `home.handoff.justNow` | gerade eben | just now |
| `detail.view.handoffLine` | Weiter ab {time} (zuletzt auf {device}) | Continue from {time} (last on {device}) |
| `common.deviceKind.tizen` / `webos` / `firetv` | Samsung-Fernseher / LG-Fernseher / Fire TV | Samsung TV / LG TV / Fire TV |
| `common.deviceKind.desktop` / `android` | Windows-App / Android-App | Windows app / Android app |
| `common.deviceKind.airplay` / `chromecast` | AirPlay ({sender}) / Chromecast ({sender}) | AirPlay ({sender}) / Chromecast ({sender}) |
| `player.castBar.airplayDevice` (changed) | AirPlay | AirPlay |
| `player.airplay.cancel` | Abbrechen | Cancel |
| `settings.keys.CAST_AIRPLAY_CONTINUOUS` label (cast spec §11) and `help` | Durchgehendes AirPlay (experimentell) · Experimentell. Erst einschalten, wenn der Test mit deinem AirPlay-Fernseher bestanden ist; danach gilt es für alle Profile. | Continuous AirPlay (experimental) · Experimental. Turn on only after the test with your AirPlay TV passed; it then applies to every profile. |
| `account.devices.rename` | Umbenennen | Rename |
| `account.devices.renameAria` | {name} umbenennen | Rename {name} |
| `account.devices.nameLabel` | Gerätename | Device name |
| `account.devices.useAuto` | Automatischen Namen verwenden | Use the detected name |
| `account.devices.renamed` | Das Gerät heißt jetzt „{name}“. | The device is now called “{name}”. |
| `account.devices.nameInvalid` | Bitte 1 bis 40 Zeichen ohne Steuerzeichen. | Use 1 to 40 characters, no control characters. |
| `account.devices.renameFailed` | Umbenennen hat nicht geklappt. Bitte noch einmal versuchen. | Could not rename the device. Please try again. |

Reused: `detail.view.episodeCode` (S{s}:F{e} / S{s}:E{e}), `player.castRemote.connecting` ("Verbinde mit {device} …"),
`player.airplay.playing` ("Läuft über AirPlay"), `player.airplay.chooseHint` / `choose`, `player.castRemote.lost` /
`reconnectBtn`, `player.castBar.onLeft`, `common.experimental`, `common.save` / `common.cancel`, `diagnose.cast.continuous*`,
and the continuous-AirPlay keys of the cast spec §11 that already ship (`player.castRemote.continuous*`, `inARow`,
`episodeOf`, `prevNone`). Removed (owner decision 7): `player.castPicker.continuous` / `continuousHint`;
`account.playback.airplayContinuous` is never added.

## 8. Accessibility

- Card: `role="region"` named `home.handoff.region`, placed in the DOM right after the page heading (first stop for keyboard
  and screen reader, whatever its visual overlay position); not announced on arrival (it is not a reaction to the user);
  buttons ≥ 44 px (TV: the tile's button size), visible focus ring, *Ausblenden* named. Contrast over artwork via `.frost-safe`
  (browsers) or the solid panel (TV, kids, calm), checked with the existing contrast helpers.
- Title hint: part of the play button's accessible name; the visible line is plain text.
- AirPlay connecting layout: `role="status"`, phase changes announced politely once ("Verbinde mit AirPlay …", "Läuft über
  AirPlay"); the spinner is decorative; *Abbrechen* reachable by keyboard.
- Media Session needs no UI; nothing on screen changes.
- Rename form: the field has its visible label, an invalid name is announced (`role="alert"` next to the field, the field gets
  `aria-invalid`), success is announced politely ("Das Gerät heißt jetzt …"); buttons ≥ 44 px with names.

## 9. Testing

**Unit (Vitest)**

- Backend: `clientKind` table; `devices.client` set at registration, at TV claim and corrected by `/api/me`; hand-off upsert
  from `playbackReport` (start resets `started_at`, progress keeps it, `via` from `/api/cast/report` and the body field, no row
  without profile or device); selection rules (other device only, 6 h, 60 s, 90 %, played, `resume_hidden`, `dropped`,
  series match, lookup 404 deletes the row, kids lookup as the kids user); answer carries no device id or play session id;
  profile isolation; 24 h cleanup; rename (own device only, 404 for a foreign id, trimming, length, control and bidi
  characters refused, null resets, the custom name in the device lists and the hand-off answer); `continuous_off` with the
  switch off; Task 23–25 tests as in the cast plan, plus tuple scope, `runtimeTicks` positions, short segment URIs, master
  route.
- Web: `handoff.ts` (device name per kind, custom name and `via`, dismissal list of 20 with storage throwing, visibility rules,
  time and age formatting); `player/mediasession.ts` (actions call the player's functions, no next / previous without a target,
  position clamping, owner hand-over to the cast binding and back, artwork never contains `/media/c/`); `airplay.ts` (phases
  busy → ready → remote connecting → active → playing, 30 s timeout to `reconnect`, one position correction only).

**e2e (Playwright, German UI, existing fakes for Cast / AirPlay / native bridge, a `navigator.mediaSession` stub)**

- Start page card on desktop, phone and TV mode: appears as an overlay (the first row's position is unchanged before and
  after), action goes to `/watch/<id>?t=1390`, *Ausblenden* hides it and it stays hidden after a reload, TV: Up from the tile
  reaches the card, OK plays, Back returns focus to the tile.
- Title page line "S1:F4 · Weiter ab 23:10 (zuletzt auf LG-Fernseher)" on a series and a film; nothing for this device's own
  playback.
- Android shell: the card's action calls the native `play` with `startMs`.
- *Geräte*: rename a device to "Wohnzimmer" (the row does not move, the list shows the new name after a reload), Escape
  cancels, an invalid name shows the error, *Automatischen Namen verwenden* restores the detected name.
- AirPlay: connecting layout during `busy`, "Verbinde mit AirPlay …" on the remote screen, then "Läuft über AirPlay".
- Media Session stub receives metadata and handlers for local playback and loses them when the player closes.

**Owner checks (by hand, recorded in the pull requests)**

- A1: LG app, Dunmoor S1 E4 to about 23 min, Back; Windows app start page shows "Zuletzt auf LG-Fernseher", *Hier
  weiterschauen* opens mpv at that position.
- A2: Samsung app with the remote: card gets focus at start, OK plays; another start: Up reaches it, Back returns, *Ausblenden*.
- A3: iPhone Safari after the Fire TV app; the title page line on a series.
- A4: no card on the device that played last, after 6 h, or for a finished episode.
- A5: rename the LG TV to "Wohnzimmer" on *Geräte*; the Windows app's card then reads "Zuletzt auf Wohnzimmer".
- C1: iPhone lock screen and Control Center during local playback and during AirPlay: title, artwork, play / pause, seek,
  next episode; volume buttons change the TV's volume.
- C2: Chrome or Edge on Windows: media keys and the media overlay control the web player; observation only: the Windows app's
  web-player fallback.
- D1: iPhone → LG via AirPlay: "Verbinde mit AirPlay …" without a frozen picture, the TV starts within 5 s of the iPhone's
  position, then "Läuft über AirPlay".
- E: the acceptance test of section 5 (P1, P2, observations O1–O3).

## 10. Rollout

- **Migration 46** (rerunnable: `if not exists`): `devices.client`, `devices.name`, table `handoff`, index. No backfill; kinds
  fill in at the next `/api/me`, rows with the next report, names when a user renames a device.
- **Old clients** need no update: the server writes rows from any report; old web bundles simply do not show the card.
- **Admin switch** `CAST_AIRPLAY_CONTINUOUS` default off; nothing changes for anybody until an admin turns it on (then for
  every profile).
- **Docs:** `docs/cast.md` (AirPlay states, continuous AirPlay switch and acceptance, outcome), `docs/tv-mode.md` (the card with
  the remote), `docs/privacy.md` (hand-off data), `docs/windows.md` (the card's action opens mpv at the position),
  `CHANGELOG.md` under *Unreleased*, `README.md` / `README.de.md` one feature line each.

## 11. Plans

Two plans:

1. **Plan `2026-11-11-device-handoff`** covers A, C, D **and E** (Tasks 15–23), in three pull requests: PR 1 = A (migration,
   server, card, title hint, device renaming, docs); PR 2 = C and D (web player only); PR 3 = E (continuous AirPlay behind
   the admin switch, Tasks 15–22, docs and the owner's acceptance checklist in Task 22, Task 23 after the acceptance).
   E is folded into this plan; the amendment of `2026-11-10-cast-airplay.md` is no longer used.
2. E is backend and gateway heavy and needs the owner's TV, so it is its own pull request and does not hold back A / C / D.

Order: A first (most value for the owner's daily use), then C + D, then E. E's Task 25 writes hand-off rows through
`playbackReport`, so it benefits from A being merged first but does not depend on it.

## 12. Decisions made here (owner may overrule)

1. One new table `handoff` (one row per profile and device) plus `devices.client`; nothing existing holds "which device, how
   far, when", and Jellyfin keeps only one position per profile.
2. Device names from the client kind (Samsung-Fernseher, LG-Fernseher, Fire TV, Windows-App, Android-App, browser label);
   casts read "AirPlay (Safari auf iPhone)". A custom name from *Geräte* wins over all of them (owner decision 6).
3. "Different device" = the profile's newest playback overall was elsewhere; the title page uses the newest playback of that
   title. Less than 60 s played or ≥ 90 % → no offer; hidden or dropped titles are respected.
4. The card is an overlay at the top of the start page (never pushes the rows), fetched separately from the cached `/api/home`.
5. The action starts at the shown position (`?t=` / `startMs`), also in the native apps.
6. AirPlay's device word becomes "AirPlay"; the playing label stays the shipped "Läuft über AirPlay".
7. Continuous AirPlay: the admin switch alone turns it on for every profile; no per-profile opt-in (owner decision 7).
8. Dismissal is per device in local storage; the title-page hint stays.
9. Kids profiles: title-page hint, no card on `/kids`.
10. No lead correction for continuous AirPlay positions until the owner's observation O2 shows one is needed.
11. AirPlay connect timeout 30 s after the TV was picked; one position correction if the TV starts more than 5 s off.
