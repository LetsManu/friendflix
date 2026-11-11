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
- FriendFlix's look (coral accent, dark), readable from 3 m, reduced motion respected (no card animation).

Nothing changes for AirPlay, and nothing changes for Chromecast as long as `CAST_RECEIVER_APP_ID` is empty.

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
- Which keys the remote delivers to the page (OK / Back / arrows on Chromecast with Google TV; touch on a Nest Hub).
- Reports reach the backend from the same client address as the media (the report token is bound to the address that streams the
  token; an IPv4/IPv6 split between media and API requests would refuse the reports, and the phone's reports still apply).
