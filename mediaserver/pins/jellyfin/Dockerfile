# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# The official Jellyfin image the managed media server may run (docs/mediaserver.md). Never built: this file only carries the
# pin, so Dependabot (docker ecosystem, /mediaserver/pins/jellyfin) proposes new releases. scripts/mediaserver-pins.sh reads it
# at CI time and writes it into the backend image's pin label; the updater creates the container from that exact reference.
# Exactly one FROM line: docker.io/jellyfin/jellyfin:X.Y.Z@sha256:<digest of the multi-arch index>.
FROM docker.io/jellyfin/jellyfin:10.11.11@sha256:aefb67e6a7ff1debdd154a78a7bbb780fd0c873d8639210a7f6a2016ad2b35db
