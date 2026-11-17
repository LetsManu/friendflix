#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Test of scripts/mediaserver-pins.sh (run by the `compose` job in .github/workflows/ci.yml): bash scripts/mediaserver-pins.test.sh
set -uo pipefail
cd "$(dirname "$0")/.."
script=scripts/mediaserver-pins.sh
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
d64=$(printf 'a%.0s' $(seq 64))
jf=docker.io/jellyfin/jellyfin:10.11.11@sha256:$d64
mk() { printf '%b' "$1" > "$tmp/pin"; }          # pin file with the given content
run() { PIN_FILE="$tmp/pin" bash "$script" "$@" 2> "$tmp/err"; }
expect_out() { # name expected-output args...
  local name=$1 want=$2; shift 2
  local got; got=$(run "$@"); local rc=$?
  if [ "$rc" = 0 ] && [ "$got" = "$want" ]; then ok "$name"; else bad "$name (rc=$rc, got: $got)"; fi
}
expect_fail() { # name args...
  local name=$1; shift
  local got; got=$(run "$@"); local rc=$?
  if [ "$rc" = 1 ] && [ -z "$got" ] && grep -q '^::error file=mediaserver/pins/jellyfin/Dockerfile::' "$tmp/err"; then ok "$name"; else bad "$name (rc=$rc, out: $got)"; fi
}

# the committed pin file
out=$(bash "$script" LetsManu/friendflix); rc=$?
if [ "$rc" = 0 ] && [[ "$out" =~ ^jellyfin=docker\.io/jellyfin/jellyfin:[0-9]+\.[0-9]+\.([0-9]+|[0-9]{8}-[0-9]{6})@sha256:[0-9a-f]{64}$ ]]; then ok "real pin file"; else bad "real pin file (rc=$rc, out: $out)"; fi

mk "FROM $jf\n"
expect_out "jellyfin only" "jellyfin=$jf" LetsManu/friendflix
expect_out "with ferrofin digest, owner and repo lowercased" "jellyfin=$jf ferrofin=ghcr.io/letsmanu/friendflix-mediaserver@sha256:$d64" LetsManu/friendflix "sha256:$d64"
expect_out "invalid digest: no ferrofin entry" "jellyfin=$jf" LetsManu/friendflix "sha256:abc"
expect_out "uppercase digest: no ferrofin entry" "jellyfin=$jf" LetsManu/friendflix "sha256:${d64^^}"
expect_out "empty digest: no ferrofin entry" "jellyfin=$jf" LetsManu/friendflix ""
stamp=docker.io/jellyfin/jellyfin:12.4.20261026-211555@sha256:$d64
mk "FROM $stamp\n"
expect_out "build-stamp tag (12.x)" "jellyfin=$stamp" LetsManu/friendflix
mk "# SPDX\n\n# comment\nFROM $jf\n\n# trailer\n"
expect_out "comments and blank lines ignored" "jellyfin=$jf" LetsManu/friendflix

mk "FROM docker.io/jellyfin/jellyfin:12.4@sha256:$d64\n";          expect_fail "minor tag only" LetsManu/friendflix
mk "FROM docker.io/jellyfin/jellyfin:12.4.20261026-2115@sha256:$d64\n"; expect_fail "short time" LetsManu/friendflix
mk "FROM $jf\nRUN true\n";                                       expect_fail "second instruction" LetsManu/friendflix
mk "FROM $jf\nFROM $jf\n";                                       expect_fail "two FROM lines" LetsManu/friendflix
mk "FROM docker.io/jellyfin/jellyfin:10.11.11\n";                expect_fail "tag without digest" LetsManu/friendflix
mk "FROM docker.io/jellyfin/jellyfin:latest@sha256:$d64\n";      expect_fail "latest tag" LetsManu/friendflix
mk "FROM docker.io/jellyfin/jellyfin:10.11@sha256:$d64\n";       expect_fail "two-part version" LetsManu/friendflix
mk "FROM docker.io/jellyfin/jellyfin@sha256:$d64\n";             expect_fail "digest without tag" LetsManu/friendflix
mk "FROM ghcr.io/other/jellyfin:10.11.11@sha256:$d64\n";         expect_fail "other repository" LetsManu/friendflix
mk "FROM docker.io/jellyfin/jellyfin:10.11.11@sha256:${d64^^}\n"; expect_fail "uppercase digest in file" LetsManu/friendflix
mk "FROM $jf AS x\n";                                            expect_fail "trailing text" LetsManu/friendflix
mk "FROM $jf \n";                                                expect_fail "trailing space" LetsManu/friendflix
mk "# only a comment\n";                                         expect_fail "no instruction" LetsManu/friendflix
: > "$tmp/pin";                                                  expect_fail "empty file" LetsManu/friendflix
rm -f "$tmp/pin";                                                expect_fail "missing file" LetsManu/friendflix

exit "$fail"
