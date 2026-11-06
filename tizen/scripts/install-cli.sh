#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Installs the pinned Tizen CLI (tizen/tizen-cli.lock: url + sha256) into <dir> (default: ~/tizen-studio).
#   install-cli.sh [<dir>]
# The installer is downloaded to a temp dir, refused unless its SHA-256 matches the pin, run non-interactively
# (`--accept-license <dir>`) and deleted. The result is checked with `tizen version`. On GitHub Actions the CLI's bin dir
# and sdb's dir go to GITHUB_PATH, and TIZEN_STUDIO / TIZEN_STUDIO_DATA to GITHUB_ENV.
# The Samsung installer refuses to run as root. TIZEN_CLI_LOCK overrides the lock file (tests).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
lock=${TIZEN_CLI_LOCK:-$here/../tizen-cli.lock}
dest=${1:-$HOME/tizen-studio}

fail() { echo "::error title=Tizen CLI::$*" >&2; exit 1; }

url=$(sed -n 's/^url=//p' "$lock")
sha=$(sed -n 's/^sha256=//p' "$lock")
[ -n "$url" ] || fail "$lock has no url="
if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{64}$'; then
  fail "Tizen CLI not pinned: $lock has no SHA-256 (sha256=$sha). Download its url, put the file's SHA-256 into the lock and commit it."
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $url"
curl -fsSL --retry 3 -o "$tmp/installer.bin" "$url"
got=$(sha256sum "$tmp/installer.bin" | cut -d' ' -f1)
if [ "$got" != "$sha" ]; then
  fail "SHA-256 mismatch for $url: expected $sha, got $got"
fi

[ "$(id -u)" != 0 ] || fail "the Tizen installer refuses to run as root; run this as a normal user"
mkdir -p "$(dirname "$dest")"
dest=$(cd "$(dirname "$dest")" && pwd)/$(basename "$dest")
# the installer unpacks to ~/.package-manager/run/tizensdk_<time>; it exits 0 even on failure, so the result is checked below
(cd "$tmp" && bash ./installer.bin --accept-license "$dest") > "$tmp/install.log" 2>&1 || true
rm -f "$tmp/installer.bin"
rm -rf "$HOME"/.package-manager/run/tizensdk_*

tizen="$dest/tools/ide/bin/tizen"
if [ ! -x "$tizen" ] || ! "$tizen" version > "$tmp/version.txt" 2>&1; then
  tail -n 40 "$tmp/install.log" >&2 || true
  fail "the Tizen CLI did not install into $dest"
fi
grep -m1 'Tizen CLI' "$tmp/version.txt" || cat "$tmp/version.txt"
"$dest/tools/sdb" version

data=$(sed -n 's/^TIZEN_SDK_DATA_PATH=//p' "$dest/sdk.info")
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$dest/tools/ide/bin" >> "$GITHUB_PATH"
  echo "$dest/tools" >> "$GITHUB_PATH"
fi
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "TIZEN_STUDIO=$dest" >> "$GITHUB_ENV"
  echo "TIZEN_STUDIO_DATA=$data" >> "$GITHUB_ENV"
fi
echo "Tizen CLI installed in $dest (data: $data)"
