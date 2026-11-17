<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# 0003 – a HEALTHCHECK in the image

| | |
|---|---|
| Kind | Image-level (`mediaserver/Dockerfile`, the `HEALTHCHECK` line). No source change. |
| Status | **In our image.** Checked by CI's smoke test on every build. |
| Upstream issue / PR | not filed yet (offer: the same `HEALTHCHECK` in Ferrofin's own image; link here once filed) |
| Drop it when | a Ferrofin release image has its own `HEALTHCHECK` on `/health` (check: `docker inspect -f '{{json .Config.Healthcheck}}' ghcr.io/mangoleaf/ferrofin:<tag>`). |

## Why

Ferrofin's image declares no healthcheck, so Docker only knows "running". The managed media server
(docs/superpowers/specs/2026-11-17-managed-mediaserver-design.md) waits for `healthy` after every create, update and restore,
and rolls back otherwise. Without a healthcheck it can only wait 60 s of "running", which says nothing about the server answering.

Ferrofin already has the endpoint: `GET /health` answers `200` ("Every check passed") when all its readiness checks pass and
`503` when one fails (there are also `/health/live` and `/health/ready`, Jellyfin has the same `/health`).

## What

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8096 && printf 'GET /health HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n' >&3 && IFS= read -r -t 4 status <&3 && [[ $status == 'HTTP/1.'[01]' 200 '* ]] || exit 1"]
```

- **Not curl:** the plan was `curl -fsS -o /dev/null http://127.0.0.1:8096/health`, but the base image has no curl: its
  Dockerfile installs curl only to fetch Jellyfin's repository key and purges it again (`apt-get purge … curl gnupg`). Adding
  curl back would mean an apt install from a live repository (unpinned) for one request. So the check uses bash, which the
  Debian base always has, and its `/dev/tcp`: one HTTP/1.0 request, and only the status line is read.
- **Healthy** = the status line is `HTTP/1.0 200 …` or `HTTP/1.1 200 …`. A refused connection, any other status (`503`) or no
  answer within 4 s (`read -t 4`, under Docker's 5 s timeout) exits 1, which Docker counts as a failed check.
- Port 8096 is fixed: the template never sets `FERROFIN_PORT`.
- Works with the template's hardening: a read-only root, no capabilities, any uid (it writes nothing and needs no privileges).
- Timing: first check 30 s after the start, unhealthy after 3 failed checks in a row; failures in the first 60 s (database
  creation or migration) do not count.

## How it is checked

CI's `mediaserver-image` job runs `scripts/mediaserver-smoke.sh` on the image it built: the container must report `healthy`
within 180 s, and its `Config.Healthcheck` must equal the one in the updater's inspect fixture
(`updater/test/fixtures/mediaserver-inspect.json`). The command was also tried against a local HTTP server answering 200 (exit
0), 503 (exit 1), a refused port (exit 1) and a port that accepts but never answers (exit 1 after 4 s).
