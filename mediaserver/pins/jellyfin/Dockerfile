# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# The official Jellyfin image the managed media server may run (docs/mediaserver.md). Never built: this file only carries the
# pin, so Dependabot (docker ecosystem, /mediaserver/pins/jellyfin) proposes new releases. scripts/mediaserver-pins.sh reads it
# at CI time and writes it into the backend image's pin label; the updater creates the container from that exact reference.
# Exactly one FROM line: docker.io/jellyfin/jellyfin:<tag>@sha256:<digest of the multi-arch index>, the tag X.Y.Z or, for 12.x,
# the immutable build tag X.Y.<YYYYMMDD>-<HHMMSS> (no plain patch tag exists there; the moving tags 12 and 12.4 are never pinned).
FROM docker.io/jellyfin/jellyfin:12.4.20261026-211555@sha256:fea863d0cd9ec445985d9c75fc6ed64e38a1d2766cf0c250a33d553f4fc1b771
