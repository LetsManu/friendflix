# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# The opt-in updater (compose profile `updater`, docs/operations.md "Updater"): a small Node service with the docker CLI +
# compose plugin and cosign. It never mounts the Docker socket: it talks to the socket proxy (DOCKER_HOST=tcp://docker-proxy:2375).
FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/package.json backend/
COPY gateway/package.json gateway/
COPY web/package.json web/
COPY updater/package.json updater/
COPY livetv/package.json livetv/
RUN npm ci
COPY updater updater
RUN npm run build -w updater

# production dependencies only (age-encryption for the encrypted media server backups)
FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY gateway/package.json gateway/
COPY web/package.json web/
COPY updater/package.json updater/
COPY livetv/package.json livetv/
# npm may keep a dependency inside updater/node_modules (a version that cannot be hoisted to the root): both trees go into the image
RUN npm ci --omit=dev -w updater && mkdir -p updater/node_modules

FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216
# the image commit: the newest commit that changed this image's inputs (CI passes it with SOURCE_DATE_EPOCH = its commit time,
# .github/images.json); `dev` locally
ARG FF_IMAGE_COMMIT=dev
ENV FF_IMAGE_COMMIT=$FF_IMAGE_COMMIT
# read-only root fs: every tool writes below /tmp (tmpfs in compose); the state volume is /state
ENV NODE_ENV=production HOME=/tmp DOCKER_CONFIG=/tmp/.docker
WORKDIR /app
# Alpine packages: same ruling as the other images (no blanket `apk upgrade`, minimum versions only for fixes the base lacks;
# docs/reproducible-builds.md). docker-cli + docker-cli-compose run `compose pull/up` against the proxy, cosign verifies
# the signatures. Not version-pinned (pins vanish from the Alpine mirrors): reproducible while Alpine has not shipped newer ones.
RUN apk add --no-cache 'zlib>=1.3.2-r1' 'musl>=1.2.6-r3' 'musl-utils>=1.2.6-r3' docker-cli docker-cli-compose cosign \
  && rm -rf /var/log/apk.log /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && mkdir -p /state && chown node:node /state \
  && mkdir -p /backups && chmod 0777 /backups
# /backups: the media server backup volume (compose mounts it here). A fresh volume copies this mode, so the helper containers
# (this image, run as the media server's user) can write backups and the updater (node) can read and prune them.
COPY --from=deps --chown=node:node /app/node_modules node_modules
COPY --from=deps --chown=node:node /app/updater/node_modules updater/node_modules
COPY --from=build --chown=node:node /app/updater/dist updater/dist
COPY --chown=node:node updater/package.json updater/
USER node
EXPOSE 7070
VOLUME ["/state"]
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:7070/healthz || exit 1
CMD ["node", "updater/dist/server.js"]
