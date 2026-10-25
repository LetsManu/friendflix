#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Packages one Samsung TV shell into a .wgt (spec §8).
#   package.sh <app|probe> <outdir> [--sign]
# Builds in a temp copy of tizen/<app> (the tracked dirs stay untouched): adds tizen/shared/setup-core.js (and, for the
# probe, tizen/app/setup.js), stamps version.json's version into config.xml, runs `tizen package -t wgt` and writes
# <outdir>/FriendFlix-<version>.wgt or <outdir>/FriendFlix-probe-<version>.wgt.
# --sign signs with the security profile `friendflix` (the owner's Samsung certificates, tizen-release.yml); without it
# with the profile `friendflix-dev` (in the PR check a throwaway author certificate plus the SDK's public distributor,
# see add-profile.sh; such a package installs on no TV). A profile is always named: without -s the CLI asks for the
# password on the terminal.
# Needs `tizen` on PATH (install-cli.sh).
set -euo pipefail

usage() { echo "Usage: package.sh <app|probe> <outdir> [--sign]" >&2; exit 2; }

if [ $# -lt 2 ] || [ $# -gt 3 ]; then usage; fi
app=$1 outdir=$2 profile=friendflix-dev
case "$app" in app | probe) ;; *) usage ;; esac
if [ $# -eq 3 ]; then
  [ "$3" = --sign ] || usage
  profile=friendflix
fi

tizen_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
version=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$tizen_dir/../version.json")
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "version.json has no X.Y.Z version ($version)" >&2; exit 1; }
if [ "$app" = app ]; then name="FriendFlix-$version.wgt"; else name="FriendFlix-probe-$version.wgt"; fi

build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
src="$build/$app"
cp -R "$tizen_dir/$app" "$src"
# leftovers of an earlier in-place build never go into the package
rm -f "$src"/author-signature.xml "$src"/signature*.xml "$src"/.manifest.tmp "$src"/*.wgt
cp "$tizen_dir/shared/setup-core.js" "$src/setup-core.js"
[ "$app" = probe ] && cp "$tizen_dir/app/setup.js" "$src/setup.js"
sed -i.bak "/<widget /s/ version=\"[^\"]*\"/ version=\"$version\"/" "$src/config.xml" && rm -f "$src/config.xml.bak"
grep -q "<widget [^>]*version=\"$version\"" "$src/config.xml" || { echo "could not stamp the version into config.xml" >&2; exit 1; }

tizen package -t wgt -s "$profile" -o "$build/out" -- "$src"

shopt -s nullglob
wgts=("$build"/out/*.wgt)
[ ${#wgts[@]} -eq 1 ] || { echo "expected one .wgt from tizen package, got ${#wgts[@]}" >&2; exit 1; }
mkdir -p "$outdir"
mv "${wgts[0]}" "$outdir/$name"
echo "$outdir/$name"
