#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Installs FriendFlix (or the test app) on an LG TV in Developer Mode, from a GitHub release (docs/webos.md).
#   install.sh <tv-ip> [passphrase] [--probe] [--ipk <file>] [--version vX.Y.Z]
# Needs Node.js 20+ and curl. Installs the pinned ares CLI (@webos-tools/cli) into a cache folder, downloads the .ipk and
# SHA256SUMS-webos.txt (latest release by default), checks the SHA-256, then registers the TV, fetches its key with the
# Developer Mode passphrase (sent on stdin only, never on a command line) and installs and launches the app.
set -euo pipefail

base=https://github.com/LetsManu/friendflix/releases
usage() {
  cat >&2 <<'EOF2'
Usage: install.sh <tv-ip> [passphrase] [--probe] [--ipk <file>] [--version vX.Y.Z]
  <tv-ip>            the TV's IP address (TV: Settings > Network > your connection)
  [passphrase]       the Developer Mode app's passphrase. Better leave it out: it would stay in your shell history,
                     and you are asked for it instead (hidden)
  --probe            install FriendFlix Test (the test app) instead of FriendFlix
  --ipk <file>       install this .ipk instead of downloading a release
  --version vX.Y.Z   a specific release (default: the latest)
EOF2
  exit 2
}

ip='' pass='' probe='' version='' ipk='' ares_dir=''
npos=0
while [ $# -gt 0 ]; do
  case "$1" in
    --probe) probe=1 ;;
    --version) [ $# -ge 2 ] || usage; version=$2; shift ;;
    --ipk) [ $# -ge 2 ] || usage; ipk=$2; shift ;;
    --base-url) [ $# -ge 2 ] || usage; base=${2%/}; shift ;; # hidden: tests
    --ares-dir) [ $# -ge 2 ] || usage; ares_dir=$2; shift ;; # hidden: tests
    -h | --help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *)
      npos=$((npos + 1))
      case $npos in
        1) ip=$1 ;;
        2) pass=$1 ;;
        *) echo "only a TV address and a passphrase" >&2; usage ;;
      esac
      ;;
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
if [ -n "$ipk" ] && [ ! -f "$ipk" ]; then echo "no such file: $ipk" >&2; exit 1; fi

node_major=$(node -p 'process.versions.node.split(".")[0]' 2> /dev/null || true)
if ! [[ $node_major =~ ^[0-9]+$ ]] || [ "$node_major" -lt 20 ]; then
  echo "Node.js 20 or newer is needed: https://nodejs.org/" >&2
  exit 1
fi
command -v curl > /dev/null || { echo "curl is needed" >&2; exit 1; }

if [ -z "$pass" ]; then
  [ -t 0 ] || { echo "no passphrase given and no terminal to ask on" >&2; usage; }
  read -rsp "Developer Mode passphrase (shown in the TV's Developer Mode app): " pass
  echo >&2
fi
[ -n "$pass" ] || { echo "the passphrase is empty" >&2; usage; }

if [ -n "$probe" ]; then app_id=com.friendflix.tv.probe title='FriendFlix Test'; else app_id=com.friendflix.tv title=FriendFlix; fi

# the pinned ares CLI, installed once into a cache folder
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -z "$ares_dir" ]; then
  cache=${XDG_CACHE_HOME:-$HOME/.cache}/friendflix-webos
  want=$(node -p 'require(process.argv[1]).devDependencies["@webos-tools/cli"]' "$here/package.json")
  marker=$cache/.ff-installed-$want
  if [ ! -f "$marker" ]; then
    command -v npm > /dev/null || { echo "npm is needed (it comes with Node.js)" >&2; exit 1; }
    echo "Installing the webOS CLI $want into $cache"
    mkdir -p "$cache"
    cp "$here/package.json" "$here/package-lock.json" "$cache/"
    rm -f "$cache"/.ff-installed-*
    (cd "$cache" && npm ci --ignore-scripts --no-audit --no-fund) || { echo "installing the webOS CLI failed" >&2; exit 1; }
    : > "$marker" # only after a complete install, so an interrupted one is redone
  fi
  ares_dir=$cache/node_modules/.bin
fi
ares() { local tool=$1; shift; "$ares_dir/$tool" "$@"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ -z "$ipk" ]; then
  sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
  if [ -z "${tag:-}" ]; then
    # /releases/latest redirects to /releases/tag/<tag>
    final=$(curl -fsSIL -o /dev/null -w '%{url_effective}' "$base/latest") || { echo "could not reach $base/latest" >&2; exit 1; }
    tag=${final##*/tag/}
    [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "could not find the latest release ($final)" >&2; exit 1; }
  fi
  v=${tag#v}
  if [ -n "$probe" ]; then file="FriendFlix-probe-$v.ipk"; else file="FriendFlix-$v.ipk"; fi
  echo "FriendFlix $tag: $file"
  for f in "$file" SHA256SUMS-webos.txt; do
    curl -fsSL -o "$tmp/$f" "$base/download/$tag/$f" || { echo "could not download $base/download/$tag/$f" >&2; exit 1; }
  done
  expected=$(awk -v f="$file" '$2 == f || $2 == "*" f { print tolower($1); exit }' "$tmp/SHA256SUMS-webos.txt")
  [ -n "$expected" ] || { echo "SHA256SUMS-webos.txt has no SHA-256 for $file" >&2; exit 1; }
  got=$(sha256 "$tmp/$file")
  [ "$got" = "$expected" ] || { echo "SHA-256 mismatch for $file: expected $expected, got $got. Not installing." >&2; exit 1; }
  echo "SHA-256 ok"
  ipk=$tmp/$file
fi

hints() {
  cat >&2 <<EOF2

Installing on the TV at $ip did not work. Check:
  - The Developer Mode app is installed on the TV, Dev Mode Status is ON and Key Server is ON.
  - The passphrase is the one the app shows now (it changes when the key server is switched off and on).
  - The TV and this computer are on the same network, and nothing blocks port 9922.
  - Developer Mode runs out after 50 hours: open the app and press Extend, then try again.
EOF2
}
fail() { echo "$1" >&2; hints; exit 1; }

echo "Registering the TV at $ip"
ares ares-setup-device --remove friendflix-tv > /dev/null 2>&1 || true
ares ares-setup-device --add friendflix-tv -i "host=$ip" -i "port=9922" -i "username=prisoner" || fail "could not register the TV"
# the passphrase goes to ares on stdin only (printf is a shell builtin: nothing shows up in a process list)
printf '%s\n' "$pass" | ares ares-novacom --device friendflix-tv --getkey || fail "could not fetch the TV's key (wrong passphrase, or the key server is off)"
ares ares-install --device friendflix-tv "$ipk" || fail "the install failed"
ares ares-launch --device friendflix-tv "$app_id" || fail "the app was installed but did not start"
echo "Installed $title. Developer Mode expires after 50 hours: press Extend in the Developer Mode app."
