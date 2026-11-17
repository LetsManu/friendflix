#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Prints the value of the backend image's label io.github.letsmanu.friendflix.mediaserver.pins (the media server pins the
# updater reads with readPins(), updater/src/mediaserver/pins.ts): space-separated entries
#   jellyfin=docker.io/jellyfin/jellyfin:X.Y.Z@sha256:<64 hex>      from mediaserver/pins/jellyfin/Dockerfile
#   ferrofin=ghcr.io/<owner>/<repo>-mediaserver@sha256:<64 hex>     only when a digest is given (the mediaserver-image job's)
# Usage: scripts/mediaserver-pins.sh <owner/repo> [<ferrofin image digest>]
# Exits 1 with an ::error annotation unless the pin file has exactly one non-comment, non-empty line, a FROM line of exactly
# the shape above (the same rule as the updater's strict parse). A digest that is not sha256:<64 lowercase hex> (the
# mediaserver-image job failed or was skipped: empty) leaves the ferrofin entry out.
# PIN_FILE overrides the pin file (tests only).
set -euo pipefail
repository=${1:?usage: mediaserver-pins.sh <owner/repo> [<ferrofin digest>]}
digest=${2:-}
file=${PIN_FILE:-mediaserver/pins/jellyfin/Dockerfile}
err() { echo "::error file=mediaserver/pins/jellyfin/Dockerfile::$1" >&2; exit 1; }

[ -f "$file" ] || err "the pin file is missing"
re='^FROM docker\.io/jellyfin/jellyfin:([0-9]+\.[0-9]+\.[0-9]+)@(sha256:[0-9a-f]{64})$'
lines=()
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac
  lines+=("$line")
done < "$file"
[ "${#lines[@]}" = 1 ] || err "expected exactly one line besides comments: FROM docker.io/jellyfin/jellyfin:X.Y.Z@sha256:<64 hex>"
[[ "${lines[0]}" =~ $re ]] || err "the line is not FROM docker.io/jellyfin/jellyfin:X.Y.Z@sha256:<64 lowercase hex>"

out="jellyfin=docker.io/jellyfin/jellyfin:${BASH_REMATCH[1]}@${BASH_REMATCH[2]}"
if [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  owner=${repository%%/*} repo=${repository#*/}
  out+=" ferrofin=ghcr.io/${owner,,}/${repo,,}-mediaserver@$digest"
fi
printf '%s\n' "$out"
