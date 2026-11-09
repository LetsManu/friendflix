#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Renders the Amazon Appstore listing graphics (android/firetv/store-listing/*) from the HTML templates here
# (fictional titles only, logo from docs/images). Needs Chromium and Python with Pillow.
#   CHROME=/path/to/chrome android/firetv/store-listing/src/render.sh
set -euo pipefail
cd "$(dirname "$0")"
chrome=${CHROME:-chromium}
shot() { "$chrome" --headless --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size="$2" --screenshot="$PWD/../$3" "file://$PWD/$1" 2>/dev/null; }
shot icon.html 512,512 icon-512.png
shot banner.html 1280,720 banner.tmp.png
for i in 1 2 3; do shot "tv$i.html" 1920,1080 "tv-$i.tmp.png"; done
cd .. && python3 - <<'PY'
import os
from PIL import Image
Image.open('icon-512.png').convert('RGB').resize((114, 114), Image.LANCZOS).save('icon-114.png')
Image.open('banner.tmp.png').convert('RGB').save('banner-1280x720.png')
for i in (1, 2, 3):
    Image.open(f'tv-{i}.tmp.png').convert('RGB').save(f'tv-{i}.png')
for f in ['banner.tmp.png'] + [f'tv-{i}.tmp.png' for i in (1, 2, 3)]:
    os.remove(f)
PY
