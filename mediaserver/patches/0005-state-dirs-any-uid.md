<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# 0005 – /data and /cache writable for any container user

| | |
|---|---|
| Kind | Image-level (`mediaserver/Dockerfile`, one `RUN` before `USER ferrofin`). No source change. |
| Status | **In our image.** Checked by CI's smoke test on every build. |
| Upstream issue / PR | not filed yet (offer: the same two directories in Ferrofin's own image; link here once filed) |
| Drop it when | a Ferrofin release image has a `/cache` and both directories are mode 0777 (check: `docker run --rm --entrypoint stat ghcr.io/mangoleaf/ferrofin:<tag> -c '%a' /data /cache`). |

## Why

The managed media server runs as the user and group the owner picks (often the owner of the media files), not as the image's
`ferrofin` (uid 1000). Its state lives in two fresh named volumes, `/data` and `/cache` (the template sets
`FERROFIN_CACHE_DIR=/cache`, Ferrofin's default is `/data/cache`). In Ferrofin's image `/data` is `ferrofin`'s with mode 0755,
and there is no `/cache` at all: a fresh volume there would be root's. Any other uid could not write either.

The official Jellyfin image solves the same thing with `mkdir -p /config /cache && chmod 777 /config /cache`.

## What

```dockerfile
RUN install -d -o ferrofin -g ferrofin -m 0777 /cache && chmod 0777 /data
```

Docker copies the owner and mode of an image directory onto a still-empty named volume mounted there (at every create that
mounts it without `NoCopy`), so both volumes start out writable for every uid. Nothing runs as root at run time and no seed is
needed. `/cache` is not declared a `VOLUME`: an unmounted `/cache` must not become an anonymous volume. What the server creates
inside belongs to the uid it runs as.

## How it is checked

CI's `mediaserver-image` job runs `scripts/mediaserver-smoke.sh` with `--user 1234:1234` and fresh named volumes: the server
must start and write its database to `/data` as that uid, and the container user must write a marker into `/cache` that is then
found in the cache volume.
