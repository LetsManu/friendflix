#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# The burn-in before CI carries images (docs/superpowers/specs/2026-11-17-ci-changed-only-design.md, Testing): reads the
# `burn-in` annotations of the `reproducible (x)` legs of the last N push runs of CI on main and prints per finished run
#   <sha7> zählt          every leg the plan would have carried was equal to its base or differed only in OS-package files
#   <sha7> setzt zurück   a leg found a difference under app/ or in the config (a missing map input), or could not compare;
#                         the legs' messages follow, indented
#   <sha7> kein Burn-in   no leg would have carried (nothing compared): neither counts nor resets
# and, as the last line, the streak: counting runs since the newest reset. Stage D (CI carries) merges at 20.
#
#   scripts/burnin-status.sh [N]   N = how many runs to read (default 30)
#
# Needs gh (logged in, run inside the repository's checkout) and jq. Only reads.
set -euo pipefail

N=${1:-30}
[[ "$N" =~ ^[1-9][0-9]*$ ]] || { echo "usage: scripts/burnin-status.sh [N=30]" >&2; exit 2; }

runs=$(gh run list --workflow ci.yml --branch main --event push --limit "$N" --json databaseId,headSha,status)
streak=0
reset_seen=
while IFS=$'\t' read -r id sha; do
  # the burn-in annotations of the run's reproducible (x) legs, one message per line
  legs=$(gh api "repos/{owner}/{repo}/actions/runs/$id/jobs?per_page=100" --paginate \
    | jq -rs '[.[].jobs[]] | .[] | select(.name | startswith("reproducible (")) | .id')
  messages=
  for job in $legs; do
    m=$(gh api "repos/{owner}/{repo}/check-runs/$job/annotations?per_page=100" --paginate \
      | jq -rs 'add // [] | .[] | select(.title == "burn-in") | .message | gsub("[\r\n]+"; " ")')
    [ -z "$m" ] || messages+="$m"$'\n'
  done
  counts= resets=
  while IFS= read -r msg; do
    [ -n "$msg" ] || continue
    if [[ "$msg" =~ ^[^\ ]+\ (gleich|zählt)(\ |$) ]]; then counts=1; else resets+="  $msg"$'\n'; fi
  done <<< "$messages"
  if [ -n "$resets" ]; then
    echo "${sha:0:7} setzt zurück"
    printf '%s' "$resets"
    reset_seen=1
  elif [ -n "$counts" ]; then
    echo "${sha:0:7} zählt"
    [ -n "$reset_seen" ] || streak=$((streak + 1))
  else
    echo "${sha:0:7} kein Burn-in"
  fi
done < <(jq -r '.[] | select(.status == "completed") | "\(.databaseId)\t\(.headSha)"' <<< "$runs")
echo "Serie: $streak zählende main-Läufe in Folge (Stage D ab 20)"
