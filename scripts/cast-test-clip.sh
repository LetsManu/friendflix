#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Makes web/static/cast-test/clip.mp4, the clip behind "Send test video to TV" on /diagnose:
# 6 s, 640x360, H.264 baseline + AAC stereo, a dark card with the FriendFlix logo and a 440 Hz tone, under 400 KB.
# No token, no media server: any Chromecast can play it from the app's own address.
# ffmpeg is NOT a build dependency; the result is committed. Run from the repository root:
#   scripts/cast-test-clip.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/web/static/cast-test/clip.mp4"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# the logo: the app icon, scaled to 140 px (ffmpeg does it; no SVG renderer needed)
cp "$root/web/static/icon-192.png" "$tmp/logo.png"

ffmpeg -y -loglevel error \
  -f lavfi -i "color=c=0x12101a:s=640x360:r=25:d=6" \
  -loop 1 -framerate 25 -t 6 -i "$tmp/logo.png" \
  -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=6" \
  -filter_complex "[1:v]scale=140:140[l];[0:v][l]overlay=(W-w)/2:(H-h)/2-10,format=yuv420p[v];[2:a]volume=0.25,aformat=channel_layouts=stereo[a]" \
  -map "[v]" -map "[a]" \
  -c:v libx264 -profile:v baseline -level 3.0 -preset veryslow -crf 28 -pix_fmt yuv420p \
  -c:a aac -b:a 64k -ac 2 \
  -movflags +faststart -t 6 "$out"

ls -l "$out"
