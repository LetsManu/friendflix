#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Installs FriendFlix (or the probe) on a Samsung TV in developer mode, from a GitHub release (docs/tizen.md).
#   install.sh <tv-ip> [--probe] [--version vX.Y.Z]
# Downloads the .wgt and SHA256SUMS-tizen.txt (latest release by default), checks the SHA-256, then runs
# `sdb connect <ip>:26101` and `tizen install` on that TV. Needs curl and Tizen Studio's `sdb` and `tizen` (on PATH, in
# $TIZEN_STUDIO or in ~/tizen-studio).
set -euo pipefail

base=https://github.com/LetsManu/friendflix/releases
usage() {
  cat >&2 <<'EOF'
Usage: install.sh <tv-ip> [--probe] [--version vX.Y.Z]
  <tv-ip>            the TV's IP address (TV: Settings > General > Network > Network status > IP settings)
  --probe            install the FriendFlix Probe (the test app) instead of FriendFlix
  --version vX.Y.Z   a specific release (default: the latest)
EOF
  exit 2
}

ip='' probe='' version=''
while [ $# -gt 0 ]; do
  case "$1" in
    --probe) probe=1 ;;
    --version) [ $# -ge 2 ] || usage; version=$2; shift ;;
    --base-url) [ $# -ge 2 ] || usage; base=${2%/}; shift ;; # hidden: tests
    -h | --help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) [ -z "$ip" ] || { echo "only one TV address" >&2; usage; }; ip=$1 ;;
  esac
  shift
done
[ -n "$ip" ] || usage
valid_ip() {
  local IFS=. part
  [[ $1 =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  for part in $1; do [ "$part" -le 255 ] || return 1; done
}
valid_ip "$ip" || { echo "not an IPv4 address: $ip" >&2; usage; }
if [ -n "$version" ]; then
  [[ $version =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "the version looks like v1.2.3, not $version" >&2; usage; }
  tag=v${version#v}
fi

hints() {
  cat >&2 <<EOF

Installing on the TV at $ip did not work. Check:
  - Developer mode is on and its Host PC IP is this computer's address (TV: Apps, then 1-2-3-4-5 on the remote; set
    Developer mode On, enter the Host PC IP, then restart the TV). Some TVs turn developer mode off after a reboot.
  - The TV and this computer are on the same network, and nothing blocks port 26101.
  - The app is signed with a Samsung certificate that lists this TV's DUID. "install failed ... author certificate" or
    "Check certificate error" means the DUID is missing: add it to the certificate and re-sign (docs/tizen.md).
EOF
}

find_tool() {
  local name=$1 dir
  if command -v "$name" > /dev/null 2>&1; then command -v "$name"; return; fi
  for dir in "${TIZEN_STUDIO:-}" "$HOME/tizen-studio"; do
    [ -n "$dir" ] || continue
    for f in "$dir/tools/$name" "$dir/tools/ide/bin/$name"; do
      [ -x "$f" ] && { echo "$f"; return; }
    done
  done
  echo "Tizen Studio's '$name' was not found (PATH, \$TIZEN_STUDIO, ~/tizen-studio). Install Tizen Studio (docs/tizen.md)." >&2
  exit 1
}
command -v curl > /dev/null || { echo "curl is needed" >&2; exit 1; }
sdb=$(find_tool sdb)
tizen=$(find_tool tizen)
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

if [ -z "${tag:-}" ]; then
  # /releases/latest redirects to /releases/tag/<tag>
  final=$(curl -fsSIL -o /dev/null -w '%{url_effective}' "$base/latest") || { echo "could not reach $base/latest" >&2; exit 1; }
  tag=${final##*/tag/}
  [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "could not find the latest release ($final)" >&2; exit 1; }
fi
v=${tag#v}
if [ -n "$probe" ]; then file="FriendFlix-probe-$v.wgt"; else file="FriendFlix-$v.wgt"; fi
echo "FriendFlix $tag: $file"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for f in "$file" SHA256SUMS-tizen.txt; do
  curl -fsSL -o "$tmp/$f" "$base/download/$tag/$f" || { echo "could not download $base/download/$tag/$f" >&2; exit 1; }
done
expected=$(awk -v f="$file" '$2 == f || $2 == "*" f { print tolower($1); exit }' "$tmp/SHA256SUMS-tizen.txt")
[ -n "$expected" ] || { echo "SHA256SUMS-tizen.txt has no SHA-256 for $file" >&2; exit 1; }
got=$(sha256 "$tmp/$file")
[ "$got" = "$expected" ] || { echo "SHA-256 mismatch for $file: expected $expected, got $got. Not installing." >&2; exit 1; }
echo "SHA-256 ok"

serial="$ip:26101"
"$sdb" connect "$serial" || true
device=$("$sdb" devices | tr -d '\r' | awk -v s="$serial" '$1 == s && $2 == "device" { print $NF; exit }')
if [ -z "$device" ]; then
  echo "The TV did not connect (sdb devices does not list $serial as a device)." >&2
  hints; exit 1
fi
echo "Installing on $device ($serial)"
set +e
# a bare file name from inside the temp dir: on Windows tizen.bat breaks on paths with spaces (parity with install.ps1)
out=$(cd "$tmp" && "$tizen" install -n "$file" -t "$device" 2>&1)
rc=$?
set -e
printf '%s\n' "$out"
# the Tizen CLI can exit 0 after a failed install; its output decides
if [ $rc -ne 0 ] || printf '%s' "$out" | grep -qiE 'install failed|error'; then
  hints; exit 1
fi
echo "Installed. Open it from the TV's Apps."
