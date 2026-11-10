# Roadmap

What the maintainer plans for FriendFlix over roughly the next 12 months. This is a **plan, not a promise**: FriendFlix has a single maintainer, priorities shift with bug reports and free time, and items may move, shrink or be dropped. Day-to-day work is tracked in [GitHub issues](https://github.com/LetsManu/friendflix/issues); finished work is listed in the [CHANGELOG](CHANGELOG.md).

## Done recently

Shipped since the last roadmap (details in the [CHANGELOG](CHANGELOG.md)): admin care (health, disk, errors, hygiene), **Plex support built in** since 2.0 (`MEDIA_SERVER=plex`, [docs/plex.md](docs/plex.md); the separate friendflix-plex project is archived), coverage reporting with high thresholds, tagged releases with codenames and signed images, SPDX license headers, the 3.0 redesign (desktop, phone, TV, glass look), apps for Android, Fire TV, LG webOS, Samsung Tizen and Windows, and the 3.1 reliability and accessibility pass. Next up: **HEVC and surround sound** (HEVC files without a conversion, a proven and limited HEVC conversion for viewers away from home, 5.1 for devices that output it, and a *Picture and sound* section in Diagnose; see [docs/operations.md](docs/operations.md#hevc-umwandlung-und-surround-ton)).

## Planned

1. **Cast and AirPlay.** Fixes across Chromecast and AirPlay receivers, a redesigned cast screen, a token gate for "next episode" on the receiver, and continuous AirPlay streaming where receivers allow it; better diagnostics on the Diagnose page. Surround sound and HEVC streams on FriendFlix's own Cast receiver follow in a later update; the receiver keeps its current H.264 stereo streams until then.
2. **Downloads on desktop and TV.** Offline downloads in the desktop app like on Android, and on TVs where the platform allows enough storage (Fire TV first; LG webOS and Samsung Tizen after a storage check).
3. **Profiles and household.** A PIN to leave the kids profile, "who's watching" on the TV apps, viewing-time limits for kids.
4. **Watch party 2.0.** Reactions on the timeline, a shared queue, smoother sync.
5. **Smarter home.** "Because you watched …" rows that say why, an optional weekly "new for you" notice, and "resume on TV" from the phone.
6. **Admin media insights.** Which titles force a conversion and why, with suggestions that make them play directly. The first part has shipped: the Diagnose page now shows, per device, what it plays and was given last time and why, and Admin → Status shows the HEVC conversion state.
7. **Security hygiene.** A CI check of the Gradle wrapper, fuzz tests for the security-relevant parsers (invite codes, cast tokens), and the desktop app's move to a GTK 4 based toolkit once it is stable.

## Out of scope

- **Public multi-tenant hosting.** FriendFlix is for one household or friend group on a server you run yourself, not a service for strangers.
- **DRM.** There is no copy protection; downloads are for trusted people (see the README, "Privacy and safety").
- **A transcoding engine of its own.** Transcoding stays the job of the media server (Jellyfin or Plex); FriendFlix only chooses and caps what it asks for.

## Influence the plan

Open an issue with the feature request template, or comment on an existing one. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.
