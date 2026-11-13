<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Live TV

Live TV is optional. It runs as its own container, `livetv`, in the compose profile `livetv`: until you turn it on, nothing is
pulled or started and FriendFlix looks as before. This page covers the container itself (turning it on, GPU, ports) and the
features: [sources](#sources), [rights](#rights), [watching](#watching), [casting](#casting), [pushed streams](#pushed-streams-srt)
and [troubleshooting](#troubleshooting). *Deutsch: [de/livetv.md](de/livetv.md)*

## Turning it on

- **Through the updater (default stack):** *Admin → Live-TV* → enable. The updater pulls the signed image and starts it.
- **By hand:** put `COMPOSE_PROFILES=livetv` into `.env` and run `docker compose -f compose.prod.yaml up -d` (or
  `docker compose -f compose.prod.yaml --profile livetv up -d`). Check first: `docker compose -f compose.prod.yaml --profile livetv config -q`.
- **Portainer stack:** the updater does not change a stack that Portainer manages, so the button cannot turn Live TV on there.
  In Portainer open the stack, add the environment variable `COMPOSE_PROFILES` = `livetv` and *Update the stack* with
  *Re-pull image* on. If no `livetv` container appears (some Portainer versions do not pass `COMPOSE_PROFILES` on to compose),
  delete the line `profiles: [livetv]` under the `livetv` service in the stack editor and update again. To turn it off later,
  remove the variable (or put the line back) and update the stack.

**On an install from before Live TV** do these once, in this order (the page names the step that is missing):

1. *Admin → Update → Update the updater* (an older updater does not know Live TV: "update the updater first").
2. Replace `compose.prod.yaml` in the stack folder with the one from the current release and run
   `docker compose -f compose.prod.yaml up -d` once. This puts backend and gateway on the internal `livetv` network and lets the
   `bootstrap` service write livetv's key (missing: "your compose.prod.yaml is from before Live TV" or "backend and gateway are
   not on the livetv network yet"). An update through the updater in between is fine: it recreates backend and gateway on the
   new network.
3. *Admin → Live-TV* → enable.

The service has no Docker socket, a read-only root file system and no capabilities; backend and gateway reach it on the
internal `livetv` network at `LIVETV_URL` (default `http://livetv:8090`, needs no setting). Details: [security.md](security.md#the-livetv-container).
The updater keeps the overlay files you started the stack with, so an overlay in `COMPOSE_FILE` stays on updates.

**Reverse proxy:** the watch token is part of every stream address (`/media/l/<token>/…`). Add the `location /media/l/` block from
`deploy/npm/portal.advanced.conf` to the portal proxy host (it turns off the access and error log for these paths, like `/media/c/`),
and never paste a `/media/l/…` address into an issue or a chat.

## GPU

Without an overlay livetv encodes in software (libx264). For hardware encoding add one overlay.

**Intel / AMD (QSV, VA-API):** `compose.livetv-gpu.yaml` maps `/dev/dri` and adds the render group. Find its id and set it:

```bash
getent group render | cut -d: -f3        # e.g. 109 -> RENDER_GID=109 in .env
docker compose -f compose.prod.yaml -f compose.livetv-gpu.yaml --profile livetv up -d
# or: COMPOSE_FILE=compose.prod.yaml:compose.livetv-gpu.yaml in .env
```

With the GPU overlay in `COMPOSE_FILE`, every compose command needs `RENDER_GID` set, even while the profile is off. Without it compose stops with *set RENDER_GID*. **NVIDIA (NVENC):** install the NVIDIA Container Toolkit on the host,
then add `-f compose.livetv-nvidia.yaml` (it reserves one GPU with the `gpu` and `video` capabilities).

## Ports

livetv publishes **UDP only**: the range `LIVETV_SRT_PORTS` (default `9000-9009`, 1–100 ports) for SRT feeds that you push in,
on the host address `LIVETV_SRT_BIND`. The default `127.0.0.1` keeps push off from outside. Set `LIVETV_SRT_BIND=0.0.0.0` (or
the server's LAN address) in `.env` **only when you push feeds**. Docker publishes ports past ufw and firewalld on most hosts,
so a host firewall rule alone does not close the range; `LIVETV_SRT_BIND` does. Pulling lists and streams needs no inbound port. Its API
(port 8090) is never published. A different range: `LIVETV_SRT_PORTS=9100-9104` in `.env`.

Other settings: `LIVETV_CACHE_MAX_GB` (default 6, the disposable segment cache), `LIVETV_URL` (only if you move the service), `RECORDINGS_PATH` (host folder for recordings, Phase 3; default the named volume `recordings`; absolute path, writable by uid 10001).

## Sources

*Admin → Live-TV → Quellen.* A source is either a provider list (*Anbieterliste*: an M3U URL, optionally an XMLTV URL for the programme guide) or your own streams (*Eigene Streams*, created on first use). Provider URLs and passwords are stored encrypted and never shown again; when you edit a source the field stays empty ("unverändert lassen").

*Quelle hinzufügen* takes a name, the M3U URL (for example `https://iptv.example.com/list.m3u`), an optional XMLTV URL, a user agent (advanced), *Heimnetz erlauben* (only then may the address be in a private range such as 192.0.2.x; loopback and link-local addresses never work), the refresh interval, an optional *Max. gleichzeitige Sender* and the **Import** options:

- **Nummern:** *Aus der Liste (tvg-chno)* (default) or *Nach Reihenfolge ab* a number you pick (1 to 99 999). Numbers you set yourself under *Kanäle* are kept.
- **Senderlogos:** *Aus der Senderliste zuerst* (default) or *Aus dem Programmführer zuerst*. A logo you upload yourself always wins.
- **Programm-Zeit verschieben:** moves the programme times of the source by −12 to +14 hours in steps of 0.5 (default 0), for guides that are hours off. A `tvg-shift` from the list and a value set on a single channel (row menu *Programm-Zeit verschieben…*) take precedence.
- **Max. gleichzeitige Sender** is for providers that allow only one or two connections: FriendFlix then refuses a start early, with the list of channels that are already running, instead of letting the extra one fail (see [Release on switch](#release-on-switch)).

**Prüfen and the group picker.** *Prüfen* downloads the list through `livetv` and shows how many channels and groups it holds, how many have a guide, and five sample names, before you save. The sheet then lists the provider groups ("18 Gruppen gefunden – welche übernehmen?") with their channel counts, all ticked on first use; a search field appears from 12 groups, *Alle* / *Keine* tick everything or nothing, and a counter says how many channels the selection keeps. Unticked groups are stored in `skip_groups` and never imported. Channels of a group you untick later become *missing* (hidden at once, deleted after 30 days, back with their settings if you tick the group again). The source card shows "Ohne 6 Gruppen · Auswahl ändern".

Provider groups that appear in a later refresh are **imported but not released**: nobody sees them until you release them (see [Rights](#rights)). Provider data is read with hard limits (list ≤ 50 MB, at most 20 000 live entries per source, movie and series entries skipped); details in [security.md](security.md#the-livetv-container).

**Programme guide matching.** Channels are matched to the XMLTV guide automatically, in four exact steps, first within the channel's own source, then across sources: `tvg-id` = XMLTV channel id; `tvg-name` = a display name; the channel's name = a display name; the normalised name (case, diacritics, punctuation and a trailing HD/FHD/UHD/4K ignored). A step with exactly one hit wins, a step with none or several hands over to the next, and nothing is ever matched by similarity on its own. The guide tab shows how many channels have a programme.

**Per channel** (*Kanäle*): rename, regroup, renumber, hide, drag into a new order (*Reihenfolge*), upload a logo (PNG, JPEG or WebP up to 512 KB) and *Testen*. The test sheet shows what `livetv` found (codec, size, whether the stream is passed through, repackaged or converted) and, when the channel can start right now, plays a 10-second muted preview, then stops watching again (with no free conversion slot or at the provider's limit you get the facts only). The preview counts as one of your live views (at most 4 per account), so it can end your oldest real view when you already have four. The preview also works for channels of groups you have not released yet, so you can check new channels before anyone sees them.

## Rights

Who sees which channels is decided per group (*Admin → Live-TV → Gruppen & Rechte*), on top of the account right *Live-TV* in the role matrix.

- A person sees a channel when their account may use Live TV, the channel's group is **released** and allowed to them (by role, or by an exception under their *Rechte* tab), the channel is not hidden or *missing*, and its source is enabled. Admins see every released group.
- **Kids profiles** see only groups marked *Kinderfreundlich*. With no such group there is no Live-TV tab for them.
- **Releasing new groups.** A group created by an import starts as *Nicht freigegeben*: listed first, "Für niemanden sichtbar", granted to no role and not kid-friendly. Its channels are imported so you can test and sort them. *Freigeben…* (row menu, or the bulk bar for several groups) asks which roles get it and whether it is *Kinderfreundlich* (nothing is preselected). *Freigabe zurücknehmen* hides it again from everyone and keeps the roles. Groups you create by hand start released. A provider group that maps onto an existing group (same name, or mapped earlier) takes that group's state.
- *Sicht prüfen* on a person shows their groups and channel count with the reason for each missing group.
- Favourites and *Zuletzt gesehen* are per profile. A channel a profile can no longer see disappears from them (it is not deleted and comes back with the right).

## Watching

Live TV is the *Live-TV* entry in the menu (phone: *Live* in the tab bar), shown only while Live TV is on and the account may use it.

- **The list.** *Läuft gerade bei dir* (your favourites in your own order, with *Ordnen*), group chips (*Alle*, *Favoriten*, *Zuletzt gesehen*, then the groups) and the channels with *Jetzt* and *Danach* from the guide. Without a guide a row says "Live" and "Kein Programm verfügbar".
- **Zuletzt gesehen** lists the last 10 channels you opened, newest first ([privacy.md](privacy.md#live-tv)).
- **Rewind buffer.** A running channel keeps its last minutes on the server, so you can pause, go back and jump forward inside them; the LIVE pill returns to the live edge. The length is the setting `LIVETV_DVR_MINUTES` (*Admin → Einstellungen → Live-TV*): **0 to 120 minutes, default 30**. The buffer lives in the `livetv-cache` volume, limited by `LIVETV_CACHE_MAX_GB` (default 6). 120 minutes of a 6 Mbit/s channel take about 5.4 GB, so with the default cap two channels with long buffers already shorten each other: when the cache is full the oldest segments of the channel with the longest buffer go first, and the live edge is never touched. The cache is disposable; deleting it only loses the buffer. A pause longer than the buffer resumes at the oldest saved point, with a note.
- **Von Anfang an** restarts the programme that is on now. The button appears only while the programme's start lies inside the buffer (so it also works for a person who joined a channel that was already running: the buffer is shared). It needs a guide and a buffer above 0, and jumps to 30 seconds before the start.
- **Senderliste.** A panel over the player with the same filters and rows as the list, opened on the playing channel. On phones it is a button in the info sheet.
- **Time left** ("noch 23 Min.") shows next to the title and on the *Läuft gerade bei dir* tiles. On every channel change an info banner shows logo, number, name, *Jetzt* and *Danach*.
- **Remote keys.** Everything works with ▲/▼, OK and Back. ▲/▼ switch the channel while the controls are hidden; OK shows the controls (focus on Play/Pause), which hold *Von Anfang an*, −30 s / +30 s, LIVE, channel ▲/▼, *Programm* and *Senderliste*; Back closes a panel, then hides the controls, then leaves the player. A long OK (about 0.6 s) opens the *Senderliste*, digits type a channel number and a lone 0 returns to the previous channel. Those are shortcuts that work only where the remote sends them (CH+/CH−, Info, colour keys); on LG webOS the CH keys are not relied on. Per platform: [tv-mode.md](tv-mode.md#live-tv-am-fernseher), [tizen.md](tizen.md#live-tv-keys), [webos.md](webos.md#live-tv-keys), [firetv.md](firetv.md). Desktop: ↑/↓ or PageUp/PageDown switch channels, Space or K pause, ←/→ ±10 s, J/L ±30 s, End = live, I = info, Q = previous channel.
- **Shared streams.** All viewers of a channel watch one stream; joining a running channel costs nothing. A channel stops 60 seconds after its last viewer left, so switching back within a minute is instant.
- **Limits.** A live view counts against the account's maximum number of streams like a film. A channel that needs a conversion slot (HEVC or MPEG-2 sources; H.264 is passed through or repackaged and costs no slot) can be refused with "Gerade sind alle Live-Plätze belegt" plus a list of channels that are already running and start at once. The budget is described in [operations.md](operations.md#umwandlungen-ein-gemeinsames-limit).

### Release on switch

Some providers allow only one connection per account. When you switch from channel A to channel B and B's start would be refused, FriendFlix stops A **at once** (instead of after the usual 60 seconds) if all of this holds: you were A's only viewer (casts and admin test previews count as viewers) and no recording uses A; B is not running yet; and B would be refused only because B's source is at its *Max. gleichzeitige Sender* with A on the same source, or because A holds a conversion slot that B needs. Otherwise A lingers for 60 seconds as usual. Each release is an event in *Live-Status*. A channel switch on a Chromecast never releases the old channel early: a cast counts as its own view, so on a one-connection provider the switch is refused and A stays for 60 seconds.

## Casting

Chromecast and AirPlay play a live channel like a film. The Chromecast bar and remote screen show a live variant: no scrubber, the LIVE pill, channel ▲/▼ and the now/next line; the logo reaches the TV through a short-lived image token because the receiver sends no cookies. A Chromecast live cast keeps running when the tab closes and is picked up again when you open FriendFlix. AirPlay (Safari) gets the stream address directly and ends with the tab. The Android app casts through its bridge. Every cast has its own token (kept to one address, two for AirPlay) and counts as a live view. Background: [cast.md](cast.md), [cast-receiver.md](cast-receiver.md).

## Pushed streams (SRT)

*Eigene Streams* come in two kinds: FriendFlix **pulls** a URL (HLS, MPEG-TS, or `srt://` in caller mode), or your encoder **pushes** into FriendFlix over SRT (*Encoder sendet an FriendFlix*, for example a channel Nordlicht TV from OBS). Push needs one inbound port per feed.

Supported pulled formats: HLS with MPEG-TS, fMP4 (CMAF) or ADTS `.aac` / `.mp3` segments (radio; the first segment decides, everything else is read as MPEG-TS), and direct URLs by their file extension: `.ts` and anything unknown as MPEG-TS, `.aac`, `.mp3`, `.mp4`/`.m4a`/`.mov`, `.mkv`/`.webm` and `.flv`. The format is never guessed from the stream's bytes, so a direct URL with a misleading extension fails. Pushed feeds are MPEG-TS.

- **Ports.** UDP `LIVETV_SRT_PORTS`, default **9000–9009**: one port per feed, so ten push feeds at most (1 to 100 ports are allowed). **UDP only, no TCP.** `livetv` publishes the range itself; it does **not** go through the reverse proxy, which handles HTTP only. The range is published on `LIVETV_SRT_BIND`, by default `127.0.0.1`, so push works from outside only after you set `0.0.0.0` (or the LAN address) **and** only if you use push feeds; then open or forward the range on the router too (Docker bypasses ufw and firewalld, so a host firewall rule alone does not close it). If the range is full, *Stream hinzufügen* says so: enlarge `LIVETV_SRT_PORTS` in `.env` and run `docker compose … up -d`. A feed whose port left the range after such a change is flagged and can be given a new port.
- **Host in the hint.** The setup hint names `LIVETV_SRT_HOST` (*Admin → Einstellungen → Live-TV*), by default the host of `PUBLIC_URL`. If that name sits behind a CDN that passes no UDP (an orange-cloud Cloudflare record, say), enter a DNS-only name or the public IP there.
- **Adding a feed.** *Stream hinzufügen* → *Encoder sendet an FriendFlix* → name, number, group → *Anlegen*. The result sheet shows **once**: server, port, stream ID (`ff-` plus 16 characters), passphrase and the complete SRT address, each with a copy button. The passphrase is never shown again; the feed's card keeps only the port and the first characters of the stream ID. Lost it? *Zugangsdaten neu erzeugen*: the old data stops working at once, a running push is dropped and the encoder needs the new data.
- **OBS / encoder setup.** OBS: *Einstellungen → Stream → Dienst Benutzerdefiniert*, *Server* = the SRT address from the sheet, stream key empty. Other encoders: mode **caller**, encryption **AES-256** (`pbkeylen=32`), latency 200 ms, with the stream ID and passphrase from the sheet. H.264 video with AAC audio avoids a conversion. The address has this shape (placeholders): `srt://friend.example.com:9000?streamid=ff-EXAMPLEEXAMPLE23&passphrase=<passphrase>&pbkeylen=32&mode=caller&latency=200000`
- **What a connection needs.** The right stream ID **and** passphrase on the feed's own port; anything else is refused in the handshake. One sender per feed: a second caller with valid credentials is refused while the first one sends. An address that fails 20 times within a minute is ignored for ten minutes. Refusals appear in *Live-Status* (at most one event per feed per 10 minutes, never with credentials or addresses).
- **Live only while sending.** Without a sender the channel stays in the list with "Gerade keine Übertragung". Opening it waits and starts by itself when the encoder begins (checked every 10 seconds). Otherwise a pushed channel behaves like any other: rights, buffer, casting. It uses no CPU while nobody watches.

## Troubleshooting

*Admin → Live-TV → Live-Status* shows the running channels (mode, viewers, since, bitrate, input state, *Stoppen* and *Neu starten*; *Stoppen* ends the channel for its viewers, whose players show "Vom Admin gestoppt" instead of reconnecting, and a new watch is refused for 5 minutes unless an admin starts it again with *Neu starten*), the budget, the cache use and the last 200 events; pushed feeds have their own table (state, bitrate, refusals in the last hour). *Stoppen* on a live row in *Betrieb → Wiedergabe-Check* ends that one viewer's stream; that device cannot watch the channel again for 5 minutes.

| What you see | Cause and fix |
|---|---|
| Source "Nicht erreichbar" or "Zeitüberschreitung" | The provider did not answer in time (list 60 s, guide 10 min). Check the address from the server, then *Jetzt aktualisieren*. After three failures in a row the admins are notified. |
| "Zugang abgelehnt (Benutzername oder Passwort?)" | The provider answered 401/403: wrong credentials in the URL, or the subscription ended. |
| "Liste zu groß (über 50 MB)" or "Keine gültige Senderliste" | The URL is not an M3U list of live channels. Use the live list of your provider, not a movie list. |
| The list shrank to under 20 % | Treated as a provider error: nothing is marked missing, the old channels stay. |
| Channels are listed but nobody sees them | The group is *Nicht freigegeben* (see [Rights](#rights)), or the profile is a kids profile and the group is not *Kinderfreundlich*. |
| A channel has no programme, or the times are off | Check the source's XMLTV URL (matching is exact, see [Sources](#sources)); for hours of difference use *Programm-Zeit verschieben*. |
| "Sender gerade nicht erreichbar" | The input stalled or the first start took longer than 15 s. The player retries with growing pauses. With a provider that allows one connection set *Max. gleichzeitige Sender*. *Live-Status* lists *Eingang verloren* and *Eingang wieder da*. |
| "Gerade sind alle Live-Plätze belegt" or "Dein Anbieter erlaubt nur n Sender gleichzeitig" | The conversion budget or the source's limit is reached; the sheet lists channels that start at once ([operations.md](operations.md#umwandlungen-ein-gemeinsames-limit)). |
| The Live-TV tab is gone | `livetv` is down or off; the tab returns on the next navigation once the container answers. Detection checks every minute and counts Live TV as off only after two missed checks in a row, so a quick `livetv` restart does not hide it. After a `livetv` restart a running player asks for a new token by itself and keeps reconnecting ("Verbinde neu …") for up to two minutes. |
| A pushed feed never connects | UDP range not open on firewall and router, the host in the hint resolves to a CDN, wrong stream ID or passphrase (event *Verbindung abgelehnt*), or the encoder is not in caller mode with AES-256. Opening TCP ports does not help. |
| Playback stutters or the CPU is busy | The channel is converted (HEVC or MPEG-2 source). Add a GPU overlay (see [GPU](#gpu)). |

Logs: `docker compose -f compose.prod.yaml logs livetv`. They name channels by id only and never contain provider URLs, stream keys, tokens or ffmpeg arguments.

## Image and reproducible builds (exemption)

The `livetv` image is built, scanned, SBOM'd and cosign-signed like the others, with digest-pinned base images, but it is
**exempt from the `reproducible` check** ([reproducible-builds.md](reproducible-builds.md)). Its runtime stage installs
`jellyfin-ffmpeg7` with `apt` from the Jellyfin repository; that repository keeps only current versions (no snapshot archive,
so no pin that stays buildable) and apt/dpkg state is not shown here to be byte-stable, so a rebuild is not promised to give the same
digest. `scripts/reproduce-image.sh livetv` therefore refuses with a note, and the CI matrix of that job omits it. The signature
and SBOM of the published image still prove where it came from; its package versions are in the SBOM.
To lift the exemption: pin or vendor the Jellyfin `.deb` in the build, then show two identical builds with `scripts/reproduce-image.sh livetv`.
