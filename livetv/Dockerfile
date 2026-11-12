# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# The optional Live TV service (compose profile `livetv`, docs/superpowers/specs/2026-11-11-live-tv-design.md §3.1): a small Node
# service with jellyfin-ffmpeg 7 (the same QSV / VA-API / NVENC support as Jellyfin). Debian, not Alpine: jellyfin-ffmpeg ships
# for Debian only. Node is the binary of the pinned node:26 Debian image (plan ruling 1). No Docker socket, no npm at runtime.
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/package.json backend/
COPY gateway/package.json gateway/
COPY web/package.json web/
COPY updater/package.json updater/
COPY livetv/package.json livetv/
RUN npm ci
COPY livetv livetv
RUN npm run build -w livetv

# The Jellyfin repository key, checked before apt may trust it: the file must hold exactly one primary key, with the pinned
# fingerprint (a swapped key or an extra appended one fails the build), and only that key is exported for apt's signed-by.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS jellyfin-key
ARG JELLYFIN_KEY_FPR=4918AABC486CA052358D778D49023CD01DE21A7B
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl gpg \
  && curl -fsSL --proto '=https' --tlsv1.2 https://repo.jellyfin.org/jellyfin_team.gpg.key -o /tmp/jellyfin.asc \
  && export GNUPGHOME="$(mktemp -d)" \
  && test "$(gpg --batch --show-keys --with-colons /tmp/jellyfin.asc | awk -F: '$1 == "pub"' | wc -l)" = 1 \
  && test "$(gpg --batch --show-keys --with-colons /tmp/jellyfin.asc | awk -F: '$1 == "fpr" { print $10; exit }')" = "$JELLYFIN_KEY_FPR" \
  && gpg --batch --quiet --import /tmp/jellyfin.asc \
  && gpg --batch --export "$JELLYFIN_KEY_FPR" > /jellyfin.gpg \
  && test -s /jellyfin.gpg

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
ARG GIT_SHA=dev
ARG BUILD_TIME=
# release version + codename from version.json (CI passes them as build args)
ARG APP_VERSION=
ARG APP_CODENAME=
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME APP_VERSION=$APP_VERSION APP_CODENAME=$APP_CODENAME
# read-only root fs: only /tmp (tmpfs in compose), /cache and /recordings (volumes) are written
ENV NODE_ENV=production HOME=/tmp
WORKDIR /app
COPY --from=jellyfin-key /jellyfin.gpg /etc/apt/keyrings/jellyfin.gpg
# jellyfin-ffmpeg7 from the Jellyfin repository (signed-by the checked key only; installs to /usr/lib/jellyfin-ffmpeg). Not
# version-pinned: old versions vanish from the repository, same ruling as the Alpine packages of the other images.
# libstdc++6: the node binary links it. Package lists and caches are dropped.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
  && echo 'deb [arch=amd64,arm64 signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main' > /etc/apt/sources.list.d/jellyfin.list \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jellyfin-ffmpeg7 \
  && test -x /usr/lib/jellyfin-ffmpeg/ffmpeg && test -x /usr/lib/jellyfin-ffmpeg/ffprobe \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log \
  && groupadd -g 10001 livetv && useradd -u 10001 -g 10001 -M -d /tmp -s /usr/sbin/nologin livetv \
  && mkdir -p /cache /recordings && chown 10001:10001 /cache /recordings
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=10001:10001 /app/livetv/dist livetv/dist
COPY --chown=10001:10001 livetv/package.json livetv/
USER 10001:10001
EXPOSE 8090
VOLUME ["/cache"]
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8090/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "livetv/dist/server.js"]
