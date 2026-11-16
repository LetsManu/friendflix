<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Own media server image (Ferrofin-based, trial)

FriendFlix has its own media server image, `ghcr.io/letsmanu/friendflix-mediaserver`: the pinned release of
[Ferrofin](https://github.com/mangoleaf/ferrofin), a Rust re-implementation of the Jellyfin API, plus a few numbered changes
(the first one adds Intel's OpenCL runtime, so HDR → SDR tone mapping can work on Intel GPUs; **untested on real hardware until
`probe.sh` passes on your host**). FriendFlix talks to it like to Jellyfin. How the image is made and kept up to date:
[mediaserver/README.md](../mediaserver/README.md). *Deutsch: [de/mediaserver.md](de/mediaserver.md)*

**It is a trial.** Keep Jellyfin as your media server. Ferrofin converts the Jellyfin database it takes over one-way (until
Ferrofin 1.6.0), so the trial always runs on a **copy** of Jellyfin's config folder and Jellyfin stays untouched.

## 1. Check the GPU first

[`mediaserver/probe.sh`](../mediaserver/probe.sh) checks whether the image can tone-map HDR with OpenCL on this host's GPU. It
only starts throw-away containers with the GPU passed in; Jellyfin and FriendFlix are not touched.

```bash
bash probe.sh                          # as root or as a user in the docker group
DOCKER=/path/to/docker bash probe.sh   # when docker is not on PATH (some NAS systems)
```

It prints `PASS` or `FAIL` for: OpenCL on VA-API, Jellyfin's QSV + OpenCL tone-mapping chain on a generated 10-bit HDR10 clip,
and, for information, the VA-API + OpenCL chain and whether the GPU's VA driver can tone-map by itself (VPP; when it cannot,
use OpenCL tone mapping in Ferrofin's settings, [change 0002](../mediaserver/patches/0002-vaapi-hdr-tonemap-chain.md)). The
one-line check it starts with, if you want to run it by hand:

```bash
docker run --rm --device /dev/dri --group-add "$(stat -c %g /dev/dri/renderD128)" --entrypoint /usr/local/bin/ffmpeg \
  ghcr.io/letsmanu/friendflix-mediaserver:nightly \
  -init_hw_device vaapi=va:/dev/dri/renderD128 -init_hw_device opencl=ocl@va -f lavfi -i nullsrc -frames 1 -f null -
```

## 2. Start the trial next to Jellyfin

[`mediaserver/try.sh`](../mediaserver/try.sh) reads Jellyfin's folders, devices and networks from Docker, checks that the image's
user can list, read and watch your media, and checks the copy target and the mount paths. Only then it asks, stops Jellyfin
for the copy (seconds to minutes, depending on the metadata size), starts it again and then starts the trial container
(`ferrofin`) with the copy (at `/ferrofin-data` inside) and your media read-only. It uses
`ghcr.io/letsmanu/friendflix-mediaserver:nightly` unless you set `IMAGE=`, and pins the container to that image's digest.

```bash
bash try.sh --attach-network friendflix_media      # FriendFlix's media network: it then reaches http://ferrofin:8096
bash try.sh --publish 192.0.2.10:8097              # or: FriendFlix reaches media servers by host IP:port
bash try.sh status                                 # bash try.sh remove only removes a container it created itself
```

Good to know:

- Jellyfin can be its own stack (container `jellyfin` with bind mounts such as `/config`, `/cache`, `/media`, `/media2`);
  the trial uses the same media paths, so library paths match.
- `--publish <port>` without an address publishes on `127.0.0.1` only: the trial holds copies of all Jellyfin accounts and
  keys. Give the host's LAN address only when FriendFlix needs it.
- `--with-trickplay` also copies Jellyfin's trickplay images (the script shows their size).
- If the inotify check fails, new files only appear after a library scan.
- Turn off the **NFO saver** in Ferrofin's dashboard (*Dashboard → Libraries → each library → Metadata savers → Nfo*): the media
  is mounted read-only.
- The container carries `com.centurylinklabs.watchtower.enable=false`: no auto-updater may upgrade it (a newer image would
  upgrade the copied database by itself). The FriendFlix updater never touches it.

## 3. Point FriendFlix at it and test

*Admin → Einstellungen → Medienserver*: address `http://ferrofin:8096` (or the published `http://192.0.2.10:8097`), save. Then
test sign-in, browsing, direct play and an HDR title, seeking, subtitles, a kids profile, resume points, downloads, Live TV
and a newly added file.

## 4. Go back

Set the address back to your Jellyfin address (e.g. `http://jellyfin:8096` or `http://192.0.2.10:8096`), then
`bash try.sh remove`. The copied folder stays until you delete it. Watch state recorded during the trial stays in the copy.
