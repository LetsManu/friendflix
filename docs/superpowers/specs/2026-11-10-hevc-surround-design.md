# HEVC & surround sound (design)

Date: 2026-11-10 · Status: goals and constraints agreed with the owner in chat. This spec records them and settles the rest. Two open questions are left for the owner (section 12).

## Goal

Items "5 HEVC" and "6 surround" from the streaming audit, held back from 3.2.0 Churros:

- **HEVC.** A device that decodes HEVC gets HEVC files without a conversion. That means direct play, as today, and also an **HLS remux** where the picture is copied. When a remote stream has to be converted to fit the upload, an HEVC-capable device gets an **HEVC conversion**, because HEVC gives a better picture per Mbit/s. Everyone else gets H.264, as today. The owner's server is a Celeron N5095 with QSV, low-power mode only, and usually serves 1–2 streams. So HEVC conversions run only after FriendFlix has proven they work on that server. They are limited to a set number at once and fall back to H.264 when the encoder is unhealthy, busy or unknown.
- **Surround.** A device with 5.1/7.1 output gets the multichannel track passed through, or converted to Dolby Digital Plus / Dolby Digital / AAC 5.1. Examples are TV apps, Android over HDMI or an AVR, Chromecast in front of an AVR, and browsers on a multichannel output. Every other device gets stereo, and the Health page tells the admin how to make the server's stereo downmix clear and loud enough.
- An admin setting with a sane default for each feature. The existing settings still apply: quality, role caps, `UPLOAD_MBPS`, `DIRECT_PLAY_REQUIRES_DOWNLOAD` and the sound modes. *Diagnose* shows what the device was given and why.

## Non-goals

- **No HEVC on AirPlay or Google's Default Media Receiver.** Neither can be probed, and we never claim a capability before a positive probe. Both stay on H.264 + stereo AAC over TS, byte for byte as today.
- **Windows app: no change.** mpv already direct-plays HEVC, AC3, DTS and TrueHD. Its HLS fallback stays on H.264 stereo.
- **Plex: no HEVC conversion and no surround conversion.** Plex already direct-plays what a device claims, and that does not change. Its converted stream stays H.264 + stereo, so the new plan exists only for Jellyfin.
- **No HEVC-specific quality ladder.** The rungs stay at 8 / 4 / 1.5 Mbit/s, and `UPLOAD_MBPS` works unchanged. HEVC only makes each rung look better.
- **No 7.1 conversion.** Conversions go up to 5.1, which is the most that ffmpeg's AC3/EAC3 encoders write. A 7.1 track survives only through direct play (Android, Windows).
- **FriendFlix never changes the media server's settings.** For HEVC encoding, low-power QSV and the downmix algorithm it only reads them and advises.
- **No gateway pin on `VideoCodec`.** A modified client could already ask Jellyfin for any codec. The HEVC limit governs what FriendFlix hands out, which is the same trust model as every URL parameter except bitrate and height.

## Global constraints (restated project rules)

- The media-server token never reaches a client. Nothing new goes into logs, metric labels, Diagnose output or error messages except the fixed reason codes in this spec.
- We never claim before a positive probe. That applies to device claims (HEVC in streams, surround) and to the server's HEVC conversion. Anything unknown counts as "no".
- **Old clients see no change.** A request without the new `hls` block (older apps, Default Media Receiver, AirPlay, the playback check, previews) gets today's HLS URL unchanged: TS, `VideoCodec=h264`, `AudioCodec=aac,mp3`, 2 channels.
- The Plex path keeps working. Every Jellyfin-only part is guarded: `kind === 'jellyfin'`, the optional `transcodeSessions`, and `encoderSettings`.
- No new dependencies. Migrations can be re-run (`add column if not exists`).
- Every user-facing web string exists in all 7 locales, with `de` as the typed source and `en` second. Android uses its existing `values` / `values-de`. The words "Netflix" and "Seerr" never appear. Animations use only transform and opacity, and calm / reduced motion switches at once. Docs use only friend.example.com and 192.0.2.x. Tests use fictional titles: **Dunmoor** S1 E5 *Wrenfield Pier* (HEVC 8-bit SDR MKV, EAC3 5.1), **Brindlemarsh** (film, HEVC Main 10 HDR10 MKV, TrueHD 7.1) and **Saltwater Almanac** S2 E1 *Night Market* (H.264 MP4, AAC stereo).
- Locally, implementers run only the root `npm run typecheck` and the task's own new or changed test files. CI runs everything else.

## What we found (facts the design rests on)

Code (main after 3.2.0):

- FriendFlix builds the HLS URL itself (`backend/src/jellyfin/dto.ts` `toPlaybackDto`). It always sets `VideoCodec=h264`, `AudioCodec=aac,mp3`, `SegmentContainer=ts`, `TranscodingMaxAudioChannels=2`, `AudioChannels=2` and `AudioBitrate=192k`. The PlaybackInfo device profile (`service.ts`) only decides direct play and supplies Jellyfin's `TranscodeReasons`.
- Because of those fixed values, an HEVC MKV in a browser that decodes HEVC is **re-encoded to H.264**. The device can play the picture, but browsers are not credited with Matroska as a container. That is the biggest waste this block removes.
- `devicecaps.ts` already probes HEVC (Main / Main 10, `hvc1` / `hev1`, height via `decodingInfo`). It also probes AC3/EAC3 with a **6-channel decode** query. That proves the device can decode the format, not that its output has 6 channels.
- Two things are not probed today: whether hls.js on Media Source Extensions (MSE) can take HEVC or Dolby audio, and how many channels the output has.
- The gateway already passes fMP4 segment paths (`hls1/<id>/-1.mp4`, `…/0.mp4`) on the cookie path and on the cast path. `sanitizePlaylist` checks `#EXT-X-MAP` URIs like any other URI.
- `web/src/lib/cast.ts` hard-codes `HlsSegmentFormat.TS`.
- Health has an `encoder` row that reads `/System/Configuration/encoding` (advice only). The playback check (`healthcheck.ts`) already runs test conversions through `clipTranscode`.

Jellyfin (read in the upstream source, 10.10 / master):

- `EncodingOptions` defaults:
  - `AllowHevcEncoding = false`, `EnableHardwareEncoding = true`, `EnableIntelLowPowerHevcHwEncoder = false`.
  - `DownMixStereoAlgorithm = None`, `DownMixAudioBoost = 2`.
- `EncodingHelper.ShiftVideoCodecsIfNeeded`: when `AllowHevcEncoding` is false, `hevc` moves behind the other codecs in the request's `VideoCodec` list. So `VideoCodec=hevc,h264` encodes H.264 on such a server, and copying HEVC stays allowed because the copy check uses the whole list.
- `StreamingHelpers.GetStreamingState`:
  - The encoder video codec is the first entry of the (shifted) list.
  - The audio codec is the first entry Jellyfin can encode, while copying accepts any listed codec.
- `EncodingHelper.GetH26xOrAv1Encoder` uses the hardware encoder only when hardware acceleration is set, `EnableHardwareEncoding` is on and ffmpeg has that encoder. **Otherwise it silently uses the software encoder (libx265).** On an N5095 that runs far below real time. Reading the settings is therefore not enough; FriendFlix needs a timed probe.
- `GetAudioFilterParam`: when converting more than 2 channels to 2, it applies the `DownMixStereoAlgorithm` filter (`None` means ffmpeg's default normalised matrix), then `volume=DownMixAudioBoost` when that is not 1.
- `DynamicHlsHelper`: when it **copies HDR** video, the master playlist gets extra SDR variants (an HEVC one if HEVC encoding is allowed, an H.264 one, and a Level 5.0 compatibility one) at the same bandwidth. A player that switches variants by itself would start a new conversion.

To confirm in Task 1, Step 0, by reading Jellyfin 10.10's `EncodingJobInfo` / `EncodingHelper.CanStreamCopyVideo` / `CanStreamCopyAudio`:

- The names and format of the codec-specific URL parameters (`hevc-codectag`, `hevc-profile`, `hevc-rangetype` comma lists, `h264-level`, `h264-videobitdepth`).
- That an `hvc1` tag is written for HEVC in fMP4.
- Whether audio copying compares the source bitrate with `AudioBitrate`.

The plan already sends the safe values either way.

---

## 1. Decisions

1. **The `hls` claim is separate from the direct-play lists.** A device states what it plays *inside an HLS stream* (hls.js on MSE, ExoPlayer, the Cast receiver). This is a separate, stricter claim, and it counts only when the matching direct-play decode claim is also present.
2. **HEVC copy (remux) needs no admin switch.** It removes a conversion, so the server does less work. It is guarded by the device probe, the first-frame watchdog and a remembered fallback.
3. **HEVC conversion only for remote viewers whose stream is converted to fit the bitrate cap, on SDR sources.**
   - At home there is no upload to save, and the single HEVC slot stays free for friends.
   - HDR sources are tone-mapped to H.264 as today, because QSV low-power 10-bit HEVC is not a risk worth taking on this box.
   - Codec or container reasons (VC-1, MPEG-2) stay H.264.
   - Open question Q1 asks whether HEVC conversions should also run at home.
4. **The server's HEVC conversion is "ready" only after a probe.**
   - It needs `AllowHevcEncoding` on, hardware acceleration set, hardware encoding on, and a passing **test conversion**.
   - The test needs an `hvcC` box in the init segment, so HEVC really came out. It also needs at least **1.5× real time** over 12 s of 1080p, so it was not libx265.
   - The result is tied to a fingerprint of those settings. When they change, the state goes back to "unproven".
5. **Limit:** at most `HEVC_STREAMS` HEVC conversions at once, counted from the media server's own session list. Conversions handed out in the last 30 s that do not show there yet also count. If the server list cannot be read within 800 ms, the server counts as busy and the stream is H.264. The requesting device's own running stream is not counted, because a quality switch replaces it.
6. **Surround applies when all of these are true:**
   - `SURROUND_AUDIO` is on;
   - the device states `audioChannels ≥ 6`;
   - its `hls.surround` list is not empty;
   - the stream's bitrate cap is at least **4 Mbit/s**;
   - the playing track has more than 2 channels.

   Below 4 Mbit/s, about 450 kbit/s more for sound costs too much picture on a remote line.
7. **Surround codec order:** eac3, ac3, then aac (6 channels), each only if the device claimed it. A listed source codec is copied, anything else (DTS, TrueHD, FLAC) is converted to the first one. The audio budget is 640 kbit/s for eac3/ac3 and 384 kbit/s for aac. It comes out of the granted cap (`VideoBitrate = cap − audio budget`), so the upload rule is unchanged.
8. **"Surround output" means:**
   - **Browsers:** `AudioContext.destination.maxChannelCount ≥ 6`, plus a 6-channel MSE decode probe of the codec.
   - **TV apps (Tizen, webOS, Fire TV):** an MSE Dolby probe that passes. The TV decodes Dolby itself and either passes it to the soundbar or AVR, or downmixes it for its speakers using the track's own downmix data, which beats any server downmix.
   - **Android:** Media3 `AudioCapabilities` for the current output (passthrough encodings, `maxChannelCount`).
   - **FriendFlix's Cast receiver:** `canDisplayType` for Dolby on the HDMI sink.
9. **Stereo stays as it is technically** (server downmix, AAC 192 kbit/s, TS). It gets better through advice: Health advises a downmix algorithm other than `None` (recommended: `Dave750`, which keeps voices forward without crushing dynamics). Direct-played multichannel files on stereo devices are downmixed by the device, as before. *Klare Stimmen* stays the user's own remedy there.
10. **Stereo is forced while a sound mode is on.** The Web Audio chain works on two channels, and a stereo stream saves upload. The toggle does not reload the stream; the next start uses it.
11. **"Surround sound" switch per device.** It sits in the player's *Klang* section (all web surfaces, TV included) and in the Android track sheet, and is stored on the device. It exists because a TV or AVR that accepts Dolby but stays silent cannot be detected.
12. **fMP4 segments only when HEVC or surround is in the plan.** H.264 + stereo stays on TS, which every device has proven. In fMP4 plans the master URL carries `EnableAdaptiveBitrateStreaming=false`. When Jellyfin lists more than one variant (HDR copy), the player locks to the variant whose codec matches the plan.
13. **Failure is remembered per device.** If a stream with HEVC or surround fails, the player reloads **once** without that feature at the same position and the device leaves the feature out for 30 days or until its user agent changes.
    - A failure means: hls.js `manifestIncompatibleCodecsError` or `bufferAddCodecError`, a fatal media error after one `recoverMediaError`, or no first frame in time.
    - If hls.js names the failing track (audio or video), only that feature is dropped; otherwise both.
    - If an **HEVC conversion** fails on two different devices within 60 minutes, the server marks its HEVC conversion unhealthy for 6 hours.
14. **The PlaybackDto carries a `delivery` block.** It holds the server's plan for the HLS stream: video `copy | h264 | hevc` plus the codec, audio `copy | stereo | surround` plus codec and channels, and reason codes. The player adds `direct` when it used `directUrl`. The existing `videoDirect` check confirms copy or conversion later. Plex sends no block.

## 2. Per-client behaviour

| Client | HEVC file, direct play | HEVC in streams (remux) | HEVC conversion (remote, server ready, free slot) | Surround |
|---|---|---|---|---|
| Chrome / Edge / Firefox (desktop) | as probed today | when the MSE + media-source decode probe passes | yes | Edge: EAC3/AC3 when output ≥ 6 ch. Chrome / Firefox: AAC 5.1 when output ≥ 6 ch. Otherwise stereo. |
| Safari macOS | as probed | yes (`hvc1`) | yes | EAC3/AC3 when output ≥ 6 ch (HDMI, AVR); otherwise stereo |
| Safari iPhone / iPad | as probed | iOS 17.1+ (ManagedMediaSource) | yes | stereo (2-ch output) |
| Samsung Tizen app | as probed | when MSE confirms | yes | EAC3/AC3 5.1 when the TV's Dolby probe passes |
| LG webOS app | `buildTvCaps` as today | when MSE confirms | yes | as Tizen |
| Fire TV app | `buildTvCaps` as today | when MSE confirms | yes | as Tizen |
| Android app (new version) | hardware decoder (today) | with hardware HEVC decoder | yes | HDMI/AVR: passthrough EAC3/AC3 or multichannel PCM when the route has ≥ 6 ch; speaker, headphones, Bluetooth: stereo |
| Android app (older version) | today | no | no | stereo (no `hls` block) |
| Windows app | mpv direct play (today) | no change | no | direct play only |
| Chromecast + FriendFlix receiver | never direct (today) | when the receiver confirms HEVC (SDR only) | yes (remote cast) | EAC3/AC3 when the HDMI sink confirms Dolby |
| Chromecast, Default Media Receiver | — | no | no | stereo AAC (unchanged) |
| AirPlay | — | no | no | stereo AAC (unchanged) |
| Any client on Plex | from caps (today) | no | no | direct play only; converted stream is stereo |

## 3. The device claim (caps block)

Shape: `backend/src/media/clientCaps.ts`. Only new optional fields are added, and a block without them means exactly what it means today.

- `hls?: { video: ('h264'|'hevc')[]; audio: ('aac'|'mp3'|'ac3'|'eac3')[]; surround: ('eac3'|'ac3'|'aac')[] }`
  - Unknown values are dropped.
  - `hevc` counts only if `video[]` claims hevc.
  - `ac3` / `eac3` count only if `audio[]` claims them.
  - `surround` must be a subset of `hls.audio`, with `aac` always allowed.
- `audioChannels?: number`: an integer from 1 to 16 for the current output. Absent counts as 2.
- **Web (`devicecaps.ts`, probe version 2):**
  - The `hls` claim requires MSE `isTypeSupported` and, where the API exists, `decodingInfo({ type: 'media-source' })` (1080p for HEVC; 6 channels for each surround codec).
  - `audioChannels` is measured once per page load and again on `devicechange`. It is not cached for 7 days like the rest. It is **2** while the device's "Surround sound" switch is off or a sound mode is on.
  - The avoid memory is `localStorage['ff_devcaps_avoid'] = { ua, hevc?: at, surround?: at }` (30 days).
- **TV apps:** the same strict MSE checks. `audioChannels = 6` when `hls.surround` is not empty (decision 8).
- **Android:** see Task 5. **Cast receiver:** see section 7.

## 4. The server's plan (Jellyfin)

`backend/src/media/streamplan.ts` is a pure function from (caps, cast, remote, cap, height box, source facts, settings) to a plan:

- the segment container (`ts` or `mp4`);
- the `VideoCodec` list (`h264` | `h264,hevc` | `hevc,h264`);
- the codec parameters (`hevc-codectag` from the device's tags, `hevc-profile` from its profiles, `hevc-rangetype` from its ranges, mapped like `jellyfinRanges`);
- the `AudioCodec` list, channels (2 or 6) and audio budget;
- the predicted `delivery` with reasons;
- `wantsHevcEncode`.

Only when `wantsHevcEncode` is true does the route ask the **HEVC gate** (section 5). A refusal swaps the list to `h264,hevc`, so copying still works, and adds the refusal reason.

Reason codes (`delivery.why`, fixed list):

- Video:
  - HEVC: `hevc_device`, `hevc_upload`.
  - H.264: `h264_device`, `h264_home`, `h264_hdr`, `h264_off`, `h264_unproven`, `h264_unhealthy`, `h264_busy`.
- Audio: `surround_device`, `stereo_device`, `stereo_bitrate`, `stereo_off`, `stereo_source`.

The client adds three of its own: `stereo_choice`, `stereo_mode` and `avoided`.

## 5. The server's HEVC conversion: state, probe, limit

- **Settings read:** `EncoderSettings` gains:
  - `hevcEncode` (`AllowHevcEncoding`), `hwEncode` (`EnableHardwareEncoding !== false`), `lowPowerHevc`;
  - `downmix` (`none | dave750 | nightmodedialogue | rfc7845 | ac4 | other | unknown`) and `downmixBoost`.
- **State:** `off | server_off | no_hw | unproven | failed | slow | runtime_failed | ready`.
  - `off`: `HEVC_STREAMS = 0`, or Plex.
  - `server_off`: `AllowHevcEncoding` is false.
  - `no_hw`: no hardware acceleration, or hardware encoding is off.
  - `unproven`: no probe yet, or the settings fingerprint changed.
  - `failed`: the probe got an HTTP error, or an init segment without `hvcC`.
  - `slow`: the probe ran below 1.5× real time.
  - `runtime_failed`: decision 13.
  - `ready`: everything passed.
- **Probe:**
  - It runs with the service user on the first suitable library title, as the playback check does.
  - It uses `clipTranscode` with `videoCodec: 'hevc'` and fMP4 at 1920 px / 6 Mbit/s with `SegmentLength=3`.
  - It fetches master, variant and init, then segments 0–3 (12 s of media). Speed = 12 s divided by the wall time from the first segment request to the end of the fourth.
  - The encoding is always stopped afterwards.
  - It stores only `{ ok, reason, speed, fingerprint, at }` in KV for 48 h.
- **When the probe runs:**
  - nightly after the playback check (`PLAYBACK_CHECK_HOUR`);
  - on the admin button *Check HEVC now* (409 while a stream plays);
  - from the 10-minute timer when the state is `unproven`, nobody is watching and previews are idle (at most once per 30 min).
- **The probe never runs while someone watches.**
- **Health `encoder` row:** new advice codes `hevc_server_off`, `hevc_no_hw`, `hevc_failed` (its text names Jellyfin's *Intel low-power HEVC encoder* switch and the GuC/HuC firmware that Jasper Lake chips such as the N5095 need), `hevc_slow` and `downmix_plain`. A line reads "HEVC conversion: ready · 2.4× real time · checked 03:10". There are no HEVC advice codes while `HEVC_STREAMS = 0`. The row remains advice only and never raises a banner.

## 6. Settings (*Admin → Settings → Playback*, live)

| Key | Kind | Default | Meaning |
|---|---|---|---|
| `HEVC_STREAMS` | int 0–4 | **2** | HEVC conversions at once; 0 = off. While the probe measures less than 3× real time, at most 1 runs regardless of this value. HEVC remux and direct play do not depend on it. |
| `SURROUND_AUDIO` | bool | **true** | Surround for devices with 5.1 output; off = stereo for everyone (direct play unchanged). |

Per-device switch (not stored on the server): **Surround sound** in the player's *Klang* section, shown only when the device states surround and the server has `features.surround` (Jellyfin with `SURROUND_AUDIO` on). Default: on.

## 7. Chromecast with FriendFlix's receiver

- **Receiver:** `web/static/cast-receiver` probes `canDisplayType` for HEVC (`hvc1`/`hev1` Main at 1920×1080, Main 10) and for Dolby (`ec-3`, `ac-3`). It sends `{ t: 'caps', v: 1, hevc, hevc10, surround }` on the private namespace when a sender connects or asks with `{ t: 'caps?' }`.
- **Sender:** the engine keeps these caps per receiver session and sends them as `caps` with `POST /api/cast/session`, but only for FriendFlix's own receiver.
- **Backend, cast plan with caps:**
  - H.264 limits move to codec-specific parameters (`h264-level=41`, `h264-videobitdepth=8`), and `RequireAvc` is dropped.
  - HEVC is SDR only (the gateway strips `VIDEO-RANGE`).
  - fMP4 is used when HEVC or surround is in the plan, and the answer then carries `hlsSegmentFormat: 'fmp4'` and `hlsVideoSegmentFormat: 'fmp4'`.
  - The remote / gate / limit rules are the same as for the player.
- **Without caps** (Default Media Receiver, older receiver), the cast URL and answer are byte-identical to today.
- A failure on the TV ends in the existing cast error path. The sender remembers "no HEVC / no surround" for that device name for 30 days (`ff-cast-avoid`) and asks again without them.

## 8. Diagnose: "Picture and sound"

This is a new section on `/diagnose`. It goes below the *Casting* section when that exists, otherwise first. Its look is the existing table, and the *Copy values* report includes it. Rows:

| Row | Values (EN) |
|---|---|
| HEVC on this device | Plays HEVC files and streams · Plays HEVC files only · No HEVC confirmed · HEVC streams paused after a failed start (until {date}) |
| Sound output | 5.1 ({codecs}) · Stereo · Stereo (your choice) · Stereo (sound mode on) · Stereo after a failed start (until {date}) |
| Server | HEVC conversion ready / off / not confirmed yet / failed its check · Surround sound on / off |
| Last playback | Picture: {video} · Sound: {audio} |
| Why | the reason texts of the last playback, joined with " · " |

- Data comes from three places:
  - `devicecaps` summary helpers;
  - `GET /api/playback/abilities` → `{ hevc: 'ready'|'off'|'unproven'|'unhealthy', surround: boolean }`, coarse on purpose;
  - the last stored timing entry, which gains `videoOut`, `audioOut` and `why`.
- No URLs, ids or titles are shown.

## 9. Failure and fallback (summary)

| What fails | What happens | Remembered |
|---|---|---|
| hls.js refuses the manifest's codecs, or a codec error on appending | at once: reload without that feature at the same position, toast "Switching to a stream this device plays" | device, 30 days or until the user agent changes |
| Fatal media error in a HEVC/surround stream | `recoverMediaError` once, then as above, then the existing lower-quality step | as above |
| No first frame in an HEVC stream (watchdog, now also for HLS) | as above | as above |
| HEVC conversion fails on 2 devices within 60 min | server HEVC state `runtime_failed` for 6 h; everyone gets H.264 | server (KV) |
| Probe fails, too slow, or settings changed | H.264 for everyone; Health advice | until the next passing probe |
| Server session list unreadable within 800 ms, or the limit is reached | that stream is H.264 (`h264_busy`) | no |
| Silent surround (TV or AVR accepts but plays nothing) | the person turns off *Surround sound* on the device | device |
| Cast receiver fails | existing error path; sender asks again without the feature | sender, per device name, 30 days |

There are never two automatic fallbacks in one session (`rec.avoided`), and a quality switch keeps the avoided state.

## 10. Privacy and security

- The caps block holds device facts only. `audioChannels` is a number, not a device name.
- The anonymous playback timing gains `video_out` and `audio_out` from fixed lists (no user, profile, item, address or user agent; pruned after 14 days as today).
- The probe stores only state, speed and time.
- Diagnose data stays on the device apart from the coarse `/api/playback/abilities` answer.
- The Cast caps message carries no token. No new secrets are introduced, and the media-server token stays on the server.

## 11. Copy (EN / DE; the other five locales are translated by the implementer)

| Key | EN | DE |
|---|---|---|
| settings `HEVC_STREAMS` label | HEVC conversions at once | HEVC-Umwandlungen gleichzeitig |
| help | Converted streams for devices that play HEVC use HEVC instead of H.264: a better picture for the same upload. Only for viewers outside your home network, and only after FriendFlix has confirmed that the server's hardware converts HEVC fast enough (Status → Encoder). 0 = off. HEVC files still reach devices that play HEVC unconverted. | Umgewandelte Streams für Geräte, die HEVC abspielen, nutzen HEVC statt H.264: besseres Bild beim gleichen Upload. Nur für Zuschauer außerhalb deines Heimnetzes und erst, wenn FriendFlix bestätigt hat, dass die Hardware des Servers HEVC schnell genug umwandelt (Status → Encoder). 0 = aus. HEVC-Dateien erreichen Geräte, die HEVC abspielen, weiterhin ohne Umwandlung. |
| settings `SURROUND_AUDIO` label | Surround sound | Raumklang |
| help | Devices with 5.1 output (TV apps, Android on a sound system, browsers on a 5.1 output) get the film's surround track, or a 5.1 conversion of it. All other devices get stereo. Off = stereo for everyone. | Geräte mit 5.1-Ausgabe (TV-Apps, Android an einer Anlage, Browser an einem 5.1-Ausgang) bekommen die Raumklang-Spur des Films oder eine 5.1-Umwandlung davon. Alle anderen bekommen Stereo. Aus = Stereo für alle. |
| scenes.audio.surround | Surround sound | Raumklang |
| scenes.audio.surroundHint | 5.1 on this device | 5.1 auf diesem Gerät |
| player.switchingCompatible | Switching to a stream this device plays | Wechsle zu einem Stream, den dieses Gerät abspielt |
| diagnose.avTitle | Picture and sound | Bild und Ton |
| diagnose.avHint | What this device plays and what it was given last time, and why. | Was dieses Gerät abspielt und was es zuletzt bekommen hat, und warum. |
| advice hevc_server_off | HEVC conversions are off in Jellyfin, so FriendFlix converts to H.264. To use them: Dashboard → Playback → Transcoding → "Allow encoding in HEVC format". | HEVC-Umwandlungen sind in Jellyfin aus, FriendFlix wandelt deshalb in H.264 um. Zum Einschalten: Dashboard → Wiedergabe → Transkodierung → „Kodierung im HEVC-Format erlauben“. |
| advice hevc_failed | The HEVC test conversion failed. On Intel Celeron / Pentium chips (for example N5095), turn on "Intel low-power HEVC encoder" in Jellyfin and check that the GuC/HuC firmware is loaded. Until then FriendFlix uses H.264. | Die HEVC-Testumwandlung ist gescheitert. Bei Intel-Celeron-/Pentium-Chips (z. B. N5095) in Jellyfin den „Intel Low-Power-HEVC-Encoder“ einschalten und prüfen, ob die GuC/HuC-Firmware geladen ist. Bis dahin nutzt FriendFlix H.264. |
| advice hevc_slow | HEVC conversion is too slow on this server (software instead of hardware?), so FriendFlix uses H.264. | Die HEVC-Umwandlung ist auf diesem Server zu langsam (Software statt Hardware?), FriendFlix nutzt H.264. |
| advice hevc_no_hw | HEVC conversions need hardware acceleration with hardware encoding on in Jellyfin. | HEVC-Umwandlungen brauchen in Jellyfin Hardware-Beschleunigung mit eingeschalteter Hardware-Kodierung. |
| advice downmix_plain | Stereo from 5.1 uses Jellyfin's plain downmix, where voices can get lost. Choose "Dave750" under Dashboard → Playback → Transcoding → Stereo downmix algorithm. | Stereo aus 5.1 nutzt Jellyfins einfachen Downmix, Stimmen gehen dabei unter. Unter Dashboard → Wiedergabe → Transkodierung → Stereo-Downmix-Algorithmus „Dave750“ wählen. |
| encoder.hevcLine | HEVC conversion: {state} · {speed}× real time · checked {when} | HEVC-Umwandlung: {state} · {speed}× Echtzeit · geprüft {when} |
| encoder.check | Check HEVC now | HEVC jetzt prüfen |
| encoder.checkBusy | Someone is watching. Try again when nobody is. | Gerade schaut jemand. Versuch es, wenn niemand schaut. |

Reason texts (`diagnose.why.*`):

| Code | EN | DE |
|---|---|---|
| hevc_device | this device plays HEVC | dieses Gerät spielt HEVC |
| hevc_upload | HEVC: better picture on the server's upload | HEVC: besseres Bild beim Upload des Servers |
| h264_device | this device plays no HEVC streams | dieses Gerät spielt keine HEVC-Streams |
| h264_home | H.264 in the home network | im Heimnetz H.264 |
| h264_hdr | HDR film: H.264 with tone mapping | HDR-Film: H.264 mit Tone-Mapping |
| h264_off | HEVC conversion is off on the server | HEVC-Umwandlung am Server aus |
| h264_unproven | the server's HEVC conversion is not confirmed yet | HEVC-Umwandlung des Servers noch nicht bestätigt |
| h264_unhealthy | the server's HEVC conversion failed its check | HEVC-Umwandlung des Servers hat die Prüfung nicht bestanden |
| h264_busy | the HEVC converter is busy | HEVC-Umwandlung ausgelastet |
| surround_device | 5.1 output on this device | 5.1-Ausgabe auf diesem Gerät |
| stereo_device | stereo output | Stereo-Ausgabe |
| stereo_choice | stereo chosen on this device | Stereo auf diesem Gerät gewählt |
| stereo_mode | a sound mode is on (stereo) | ein Klangmodus ist an (Stereo) |
| stereo_bitrate | below 4 Mbit/s: stereo saves upload | unter 4 Mbit/s: Stereo spart Upload |
| stereo_off | surround sound is off on the server | Raumklang am Server aus |
| stereo_source | the track is stereo | die Tonspur ist Stereo |
| avoided | after a failed start on this device | nach einem gescheiterten Start auf diesem Gerät |

Codec names shown: "HEVC (H.265)", "H.264", "Dolby Digital Plus", "Dolby Digital", "AAC". Channel names: "5.1", "Stereo".

## 12. Open questions for the owner

- **Q1 (answered 2026-11-10): no.** HEVC conversions never run at home; at home there is no upload to save.
- **Q2 (answered 2026-11-10): 2.** `HEVC_STREAMS` defaults to 2 (the owner's usual load is 1–2 remote streams). Safety rule: while the probe measures less than 3× real time, the effective limit is 1; Health says so.

## 13. Decisions made here (owner may overrule)

1. HEVC conversion only for remote viewers, only for bitrate reasons, only for SDR sources.
2. The server's HEVC conversion needs a timed probe (≥ 1.5× real time and `hvcC` present). Anything unknown counts as busy or unproven, and the stream is H.264.
3. Surround from 4 Mbit/s up, 5.1 at most, in the order eac3 > ac3 > aac.
4. TVs count as surround-capable when their Dolby decode probe passes.
5. Sound modes force stereo, and each device has its own *Surround sound* switch.
6. fMP4 only for HEVC or surround plans; H.264 stereo stays on TS.
7. One automatic fallback per session, remembered for 30 days per device.
8. Stereo downmix advice recommends `Dave750` (to be checked by ear on a device).
9. AirPlay, Default Media Receiver, Windows app and Plex conversions are unchanged.
10. The 30-second overlap of a next-episode warm-up on the same device may briefly exceed `HEVC_STREAMS` (the same as H.264 today).

