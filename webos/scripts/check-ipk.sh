#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Checks every .ipk in a directory: an .ipk is an ar archive whose data.tar.gz must list the files the app needs.
#   check-ipk.sh <dir>
# Used by the PR check (ci.yml webos-check) and the release (webos-release.yml) so both gate on the same list.
set -euo pipefail
[ $# -eq 1 ] || { echo "Usage: check-ipk.sh <dir>" >&2; exit 2; }
shopt -s nullglob
ipks=("$1"/*.ipk)
[ ${#ipks[@]} -gt 0 ] || { echo "::error::no .ipk in $1"; exit 1; }
for f in "${ipks[@]}"; do
  work=$(mktemp -d)
  (cd "$work" && ar x "$f")
  listing=$(tar tzf "$work/data.tar.gz")
  rm -rf "$work"
  echo "$(basename "$f")"; echo "$listing"
  for need in appinfo.json index.html setup.js setup-core.js icon.png; do
    grep -q "/$need\$" <<< "$listing" || { echo "::error::$need missing in $(basename "$f")"; exit 1; }
  done
done
