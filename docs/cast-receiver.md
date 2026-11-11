# FriendFlix's own Cast receiver

By default FriendFlix casts with Google's **Default Media Receiver** ([cast.md](cast.md)): no registration, but the TV shows only the
picture and a progress bar. With FriendFlix's own Web Receiver (CAF v3), served by the web app at `/cast-receiver/`, the TV gets the
streaming-app features:

- **Next episode** card with a countdown in the credits (credits marker / outro, else the last 25 s), *Next episode* and *Watch
  credits* on the TV; *Next* and the cancel button in the phone's cast bar still work.
- **Still there?** after the same number of autoplayed episodes as in the web player (*Account → Playback*), on the TV. The queued
  episode waits paused until someone answers: OK on the TV, the play button on the remote, or the play button on the phone.
- **Progress and "watched" while the phone sleeps:** the TV reports start, progress and stop itself.
- **Your subtitle style** (size, colour, background, font from *Account → Playback → Subtitles*) on the TV.
- **Skip intro / Skip recap** on the TV as well as on the phone.
- **HEVC and Dolby surround** when the TV (and the AV receiver behind it) confirms them: the receiver asks the TV what it plays and the
  stream is planned for exactly that (see below). Other TVs, the Default Media Receiver and AirPlay keep getting H.264 stereo.
- **Pause and loading screens**, a **sender pill** that says who is casting, and **key hints** (see "What the TV shows"). FriendFlix's
  look (coral accent, dark), readable from 3 m, solid panels, calm mode and reduced motion respected.

Nothing changes for AirPlay, and nothing changes for Chromecast as long as `CAST_RECEIVER_APP_ID` is empty.

## What the TV shows

All screens are **solid panels** (`#1c1a21`, a thin light border, no blur: a blur is too heavy for a TV's graphics chip), inside
safe margins of 5 % of the screen width on every side, sized to be read from 3 m (nothing below 20 px at 1280×720; sizes scale with
the screen).

- **Sender pill** (top left): "Cast from Anna's phone" (or tablet / computer). It shows only the **profile's display name** (at
  most 80 characters), never the device name, an e-mail address, a token or a URL. It appears for 5 s after a load and whenever a
  card, the pause screen or the loading screen is visible.
- **Up next card** (bottom right): thumbnail, "Up next in 12 s" (the number counts down), "E5 · Wrenfield Pier", a key hint and a
  thin countdown bar. The card title stays "Up next" without the number once the countdown was cancelled.
  - On a TV with a remote the card has **no buttons**. The hint says "OK plays now · Back stops here" once a remote key was seen in
    this session, and "Cancel on your phone" before that.
  - On a touch screen (Nest Hub) the card shows two buttons instead: *Play now* and *Stop here*.
  - OK / Enter / Space / the remote's play-pause key play the next episode now (with the pause screen showing as well, OK plays it and
    the play-pause key resumes the paused episode); Back, Escape or Backspace stop here (no autoplay,
    the card stays as "Up next" until the episode ends).
  - **Still there?** uses the same card ("Autoplay is paused. Up next: ...", hint "OK keeps watching"); while the queued episode
    waits paused, the same solid card is shown in the middle of the screen.
- **Pause screen:** 1.5 s after the TV pauses (a quick pause and resume shows nothing) the picture dims a little and a block at the
  bottom left shows "Paused", the title, the line ("Season 1 · Episode 4 · The Lantern Road") and a progress bar with elapsed
  and total time. It hides at once on play. OK or the play-pause key resumes; left and right seek 10 s while it shows. If a card is
  showing at the same time, the card sits on the right and the pause block on the left; OK then plays the next episode now, and
  the play-pause key resumes the current one.
- **Loading screen:** from the start of a load until the first picture of each item, including the next episode: the poster, the
  title and the line, a moving bar and "Getting ready...". A stall of more than 3 s in the middle of playback shows the pause
  layout with "Loading..." instead of "Paused".
- **Calm mode / reduced motion:** when the viewer's phone or browser has calm mode on (or reduced motion), the sender tells the TV
  (`motion: false`), and the TV page's own *reduce motion* setting counts as well. Then nothing moves: panels appear and disappear
  without a transition, the countdown and progress bars still show their value, and the loading bar stands still.
- **Remote keys:** OK / Enter / Space = play now (card), keep watching (*Still there?*) or resume (pause screen); the play-pause
  key resumes whenever the TV is paused (also with a card showing) and plays now when only the card shows;
  Back / Escape / Backspace / GoBack = stop here; left / right = seek 10 s on the pause screen, or move between the two buttons on
  a touch screen.

### What the receiver receives, and how it is shown

The sender (the phone or browser) tells the TV what to show on the private channel; the TV has no language and no FriendFlix session:

- `ui`: the texts in the viewer's language, the subtitle style, the countdown length, `who` (the profile name for the pill) and
  `motion` (`false` in calm mode).
- `item`: as before, plus `meta` with `title` and `line` (at most 200 characters each) for the pause and loading screens. The
  poster is the image of the media metadata and is used only when it comes from the receiver's own origin; otherwise a plain
  placeholder is shown.

**Everything a sender sends is shown as text only** (`textContent`, never HTML), is length-capped, and nothing in it is a link the
TV follows. The pill and the screens never show a token, a URL or an e-mail address.

## Set it up

You need a Google account and a **one-time Google Cast developer registration** (a small fee to Google, paid by you; FriendFlix has
nothing to do with it).

1. Make sure casting works with the Default Media Receiver first ([cast.md](cast.md): `https://` `PUBLIC_URL` with a valid
   certificate, the `/media/c/` location, the TV reaches the address).
2. Open `https://friend.example.com/cast-receiver/` (your own address) in a browser: you see the FriendFlix logo on black.
3. In the [Google Cast SDK Developer Console](https://cast.google.com/publish) register as a developer, then **Add new application →
   Custom Receiver**:
   - Name: e.g. `FriendFlix`
   - Receiver Application URL: `https://friend.example.com/cast-receiver/` (with the trailing slash)
   - Save. The console shows an **Application ID** of 8 characters (e.g. `A1B2C3D4`).
4. While the app is *unpublished*, Google only lets **registered test devices** start it: under *Cast Receiver Devices → Add new
   device* enter the serial number of each Chromecast / Google TV (on the device: *Settings → System → About*, or on the back / the
   box), then restart the device (unplug it for a minute). It can take up to 15 minutes until the device accepts the app.
   *Publish* the app in the console to use it on any device (Google reviews nothing for a published custom receiver, but it then
   counts as public).
5. In FriendFlix: *Admin → Settings → Playback → Cast receiver app ID*, enter the ID and save (or `CAST_RECEIVER_APP_ID=A1B2C3D4`
   in `.env`, which locks the field). It applies at once; open pages pick it up on their next reload.

To go back, empty the field: the next cast uses the Default Media Receiver again.

## What changes on the TV

| | Default Media Receiver | Own receiver |
|---|---|---|
| Picture, sound, subtitles, audio track, quality | yes | yes |
| Next episode countdown in the credits | only on the phone | on the TV and on the phone |
| Next episode when the phone is locked | the queued episode starts at the end | the same, but after the TV's countdown (or the end) |
| Still there? | the next episode is just not queued | asked on the TV; the episode waits paused |
| Progress / watched with the phone asleep | lost until the phone wakes | reported by the TV |
| Subtitle style | the TV's default | your style |
| Skip intro / recap | phone only | TV and phone |
| Pause screen, loading screen, who is casting | no | yes |
| HEVC and Dolby surround | no (H.264, AAC stereo) | when the TV / AV receiver confirms them (fMP4) |

Limits: the TV only plays what the phone queued. With the phone asleep the TV moves on by **one** episode (the one queued while
the phone was awake); the one after that is queued once the phone wakes again. An answer to *Still there?* given more than about
45 minutes after the end may find the queued episode's token expired; then start it from the phone.

## How it works

- `GET /api/cast/config` answers `receiverAppId` only when casting is on and the ID is set; the sender then starts that app and
  asks `POST /api/cast/session` with `receiver: true`. The answer carries a **report token** (`report`) besides the usual token URL.
- The sender sends the report token and the TV data on a private channel (`urn:x-cast:com.friendflix.cast`): `tok` (castId +
  report token), `item` (segments, the queued episode, whether it may start by itself, whether to ask *Still there?*), `ui` (texts in
  the viewer's language, subtitle style, countdown length). Media metadata only carries the token's public handle (`castId`).
- The receiver posts `start` / `progress` (every 15 s and on pause) / `stop` to `POST /api/cast/report` with the report token. The
  backend runs the same report logic as `/api/playback/*` for the token's account, profile and device.
- Security: see [security.md, "Cast receiver"](security.md#cast-receiver).

## HEVC and Dolby surround

- **The receiver states only what the TV confirmed.** `context.canDisplayType` is asked for `hvc1` Main and Main 10 (Level 4.1, 1920×1080)
  and for Dolby Digital Plus (`ec-3`) and Dolby Digital (`ac-3`); the framework answers for the display and the HDMI sink (the AV
  receiver). Only a plain `true` counts: unknown, an error or a framework without `canDisplayType` is "no". Main 10 counts only
  together with Main. It sends `{ t: 'caps', v: 1, hevc, hevc10, surround: ['eac3', 'ac3'] }` on the private channel when a sender
  connects and whenever the sender asks with `{ t: 'caps?' }` (asked again every time: the HDMI sink can change).
- **The sender adds it to the cast request** (`caps`), for the own receiver only, after waiting up to 2 s for the answer of a new
  session; without an answer it claims nothing. The server plans the stream like for the player (HEVC SDR remux, Dolby passthrough or
  conversion to Dolby Digital Plus / Dolby Digital, fMP4 segments, `hlsSegmentFormat` and `hlsVideoSegmentFormat` `fmp4`; the HEVC
  conversion for viewers away from home only with the server's proven encoder and a free slot). Details and the table: [cast.md](cast.md#hevc-und-raumklang-mit-dem-eigenen-empfänger) (German).
- **Jellyfin only:** with Plex the cast stays H.264 stereo.
- **Nothing confirmed, nothing changes:** the cast URL and answer are exactly the Default Media Receiver's.
- **If the TV refuses such a stream** (the load fails, or it reports an error right at the start) the phone starts the same title
  once more without HEVC / surround and remembers it for this TV's name for 30 days (`ff-cast-avoid`, in the browser).

## Check on real hardware

CI runs the sender against a fake Cast SDK and the receiver page against a fake receiver framework. Only a real device shows:

- The receiver starts (registered test device, app ID), the page's CSP allows everything Google's framework loads (the player
  libraries under `https://www.gstatic.com/cast/sdk/libs/`; if a device loads one from another Google path, add only that path in
  `web/src/lib/cast/receiverPage.ts`).
- What `canDisplayType` answers on a Chromecast with Google TV and on the AV receiver behind it (`hvc1.1.6.L123.B0` and `hvc1.2.4.L123.B0`
  at 1920×1080, `ec-3`, `ac-3`), with the AV receiver on and off, and whether the framework plays fMP4 HLS with HEVC and Dolby Digital
  Plus: *Wrenfield Pier* (HEVC with a Dolby Digital Plus 5.1 track) should show Dolby Digital Plus on the AV receiver, the picture
  without a re-encode; a TV that refuses HEVC leads to one new cast without it.
- HLS/TS playback through the framework with the page's own `<video>` element; subtitles render with the chosen style.
- *Next episode* at the end of the countdown moves the queue on (`QUEUE_UPDATE` jump); otherwise the fallback plays to the end.
- A queued item with `autoplay: false` waits paused; *Still there?* is answered by OK, the remote's play button and the phone.
- Which keys the remote delivers to the page (OK / Back / arrows on Chromecast with Google TV; touch on a Nest Hub). The checklist
  for the screens is below.
- Reports reach the backend from the same client address as the media (the report token is bound to the address that streams the
  token; an IPv4/IPv6 split between media and API requests would refuse the reports, and the phone's reports still apply).

### Owner checklist: the screens on a real TV

On a Chromecast with Google TV, a plain Chromecast and, if you have one, a Nest Hub, each with the own receiver. Record the result
of each point in the pull request (write down what you saw, also when it is different from the expectation).

- [ ] **Back and focus keys.** Does Back reach the page during the up-next card (the card stays as "Up next", no countdown) or does
  Google TV close the app? Write down which. If Back closes the app, the hint should read "Cancel on your phone" on this device.
  Arrows move the focus between the buttons only on a touch screen.
- [ ] **Up next card** sits inside the overscan on every TV, the countdown bar is smooth, text is readable from 3 m. OK plays now.
- [ ] **Loading screen on `isBuffering`.** It shows on the start of a cast and ends with the first picture; a stall in the middle of
  playback shows "Loading..." in the pause layout after 3 s and not before. Check that the first-picture moment is not early (the
  receiver treats the first PLAYING or time update as "first picture").
- [ ] **LOAD interceptor on queue loads.** Cast *Dunmoor* S1 E4 and let *Wrenfield Pier* (S1 E5) follow: the loading screen shows
  with the title and line of *Wrenfield Pier* (not the previous episode), then the picture.
- [ ] **Poster metadata.** The loading screen shows the poster of the title; a title without one shows the solid placeholder and
  no broken image.
- [ ] **Play-pause key handled once.** While the pause screen and the up-next card are both showing, one press of the remote's
  play-pause key resumes the paused episode (it does not toggle twice and does not skip), and OK plays the next episode.
- [ ] **Pause screen** appears about 1.5 s after a pause (not on a quick pause), hides at once on play, shows the right elapsed and
  total time, and left / right seek 10 s.
- [ ] **Nest Hub touch.** A tap shows the two buttons; *Play now* jumps to the next episode, *Stop here* keeps watching without
  autoplay.
- [ ] **Calm mode on the TV.** Switch calm mode on in the phone's FriendFlix, cast again: panels appear and disappear without
  movement and the loading bar stands still.
- [ ] **Sender pill** shows only the profile name ("Cast from Anna's phone"), never the device name, an e-mail address or a
  token; it shows for about 5 s after the start and while a card or screen is up.
- [ ] **Solid panels** look right on the TV (no see-through areas), and the animation stays smooth on the plain Chromecast.

The HEVC and surround checks for the receiver stay in [operations.md](operations.md#hevc-umwandlung-und-surround-ton) (point 6).
