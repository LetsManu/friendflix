<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Live TV

Live TV is optional. It runs as its own container, `livetv`, in the compose profile `livetv`: until you turn it on, nothing is
pulled or started and FriendFlix looks as before. This page covers the container itself (turning it on, GPU, ports); later
sections follow with the features.

## Turning it on

- **Through the updater (default stack):** *Admin → Live-TV* → enable. The updater pulls the signed image and starts it.
- **By hand:** put `COMPOSE_PROFILES=livetv` into `.env` and run `docker compose -f compose.prod.yaml up -d` (or
  `docker compose -f compose.prod.yaml --profile livetv up -d`). Check first: `docker compose -f compose.prod.yaml --profile livetv config -q`.

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
on the host address `LIVETV_SRT_BIND` (default `0.0.0.0`; `127.0.0.1` switches push off from outside without removing the
service). Open the range on the firewall **only if you push feeds**; pulling lists and streams needs no inbound port. Its API
(port 8090) is never published. A different range: `LIVETV_SRT_PORTS=9100-9104` in `.env`.

Other settings: `LIVETV_CACHE_MAX_GB` (default 6, the disposable segment cache), `LIVETV_URL` (only if you move the service), `RECORDINGS_PATH` (host folder for recordings, Phase 3; default the named volume `recordings`; absolute path, writable by uid 10001).

## Image and reproducible builds (exemption)

The `livetv` image is built, scanned, SBOM'd and cosign-signed like the others, with digest-pinned base images, but it is
**exempt from the `reproducible` check** ([reproducible-builds.md](reproducible-builds.md)). Its runtime stage installs
`jellyfin-ffmpeg7` with `apt` from the Jellyfin repository; that repository keeps only current versions (no snapshot archive,
so no pin that stays buildable) and apt/dpkg state is not shown here to be byte-stable, so a rebuild is not promised to give the same
digest. `scripts/reproduce-image.sh livetv` therefore refuses with a note, and the CI matrix of that job omits it. The signature
and SBOM of the published image still prove where it came from; its package versions are in the SBOM.
To lift the exemption: pin or vendor the Jellyfin `.deb` in the build, then show two identical builds with `scripts/reproduce-image.sh livetv`.
