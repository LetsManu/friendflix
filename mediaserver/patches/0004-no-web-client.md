<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# 0004 – no web client (API only)

| | |
|---|---|
| Kind | Image-level (`mediaserver/Dockerfile`: one `RUN` and `ENV FERROFIN_WEB_DIR=/nonexistent`). No source change. |
| Status | **In our image.** Checked by CI's smoke test on every build. |
| Upstream issue / PR | not filed yet (offer: an optional "API only" image variant or build argument without jellyfin-web; link here once filed) |
| Drop it when | never as such: FriendFlix has no dashboard. Replace it with Ferrofin's own API-only image or setting once a release has one. |

## Why

Owner decision 10 of the managed media server (docs/superpowers/specs/2026-11-17-managed-mediaserver-design.md): no dashboard
at all. FriendFlix is the only client of its media server; the generated administrator is never shown, nothing publishes the
port, and the server needs no web client. Ferrofin's image bundles jellyfin-web anyway and serves it at `/web/`. Without it the
server has one surface fewer and does not serve (or keep in memory) the client's files.

## What

Found in Ferrofin v1.5.1 (the pinned image's config and its `ferrofin-server` binary; its docs/CONFIG.md):

- The client is jellyfin-web's built `dist/`, copied to **`/usr/share/ferrofin/web`** (2366 files, about 60 MB unpacked; the
  only content of `/usr/share/ferrofin`).
- The setting is **`FERROFIN_WEB_DIR`** (config file: `web_dir`); the image sets `ENV FERROFIN_WEB_DIR=/usr/share/ferrofin/web`.
  At start Ferrofin looks for `index.html` there: found, it logs "serving static web client at /web/"; not found, it logs "no
  web client bundle (index.html) found" and serves the API only. docs/CONFIG.md documents an absent variable as API-only.

The change:

```dockerfile
RUN test -f /usr/share/ferrofin/web/index.html \
  && rm -rf /usr/share/ferrofin \
  && test ! -e /nonexistent
ENV FERROFIN_WEB_DIR=/nonexistent
```

- A Dockerfile cannot unset an `ENV` of its base image, so the setting names `/nonexistent`, a directory that does not exist
  (Debian's usual name for that). It cannot appear: `/` is root's, and the managed container's root file system is read-only.
  Not an empty value: what Ferrofin makes of an empty value is not documented, and an absent one may fall back to a folder
  below the writable `/data`.
- The bundled client is deleted. The `test -f` fails the build when a base bump has moved it: then check this change again.
- **Saves no download or disk yet.** The files stay in the base image's layer (an image built `FROM` another keeps every lower
  layer; `rm` only hides them), so the image is as large as before. What it saves now is the serving: the server has no
  client to serve. The disk saving needs Ferrofin's own API-only image, which is the upstream offer.

## How it is checked

CI's `mediaserver-image` job runs `scripts/mediaserver-smoke.sh` on the image it built, configured as the managed media server:
`GET /System/Info/Public` must answer 200 and `GET /web/` and `GET /web/index.html` must answer 404. The updater's inspect
fixture (`updater/test/fixtures/mediaserver-inspect.json`) carries `FERROFIN_WEB_DIR=/nonexistent` as the image's environment,
and the smoke test fails when the image's environment differs from it.

`mediaserver/try.sh` and docs/mediaserver.md still describe turning off the NFO saver in the dashboard at `/web/`; with this
image there is none (the managed media server sets the library options over the API).
