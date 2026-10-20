#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Renders the Google Play listing graphics (android/play-listing/*) from the HTML templates here, using the README
# phone screenshots (docs/images/en, fictional titles only) and the logo. Needs Chromium and Python with Pillow.
#   CHROME=/path/to/chrome android/play-listing/src/render.sh
set -euo pipefail
cd "$(dirname "$0")"
chrome=${CHROME:-chromium}
shot() { "$chrome" --headless --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size="$2" --screenshot="$PWD/../$3" "file://$PWD/$1" 2>/dev/null; }
shot icon.html 512,512 icon-512.png
shot feature.html 1024,500 feature.tmp.png
for i in 1 2 3; do shot "shot$i.html" 1080,1920 "phone-$i.tmp.png"; done
cd .. && python3 - <<'PY'
import os
from PIL import Image
# Play wants the feature graphic without alpha; screenshots as JPEG keep the files small
Image.open('feature.tmp.png').convert('RGB').save('feature-1024x500.png')
for i in (1, 2, 3):
    Image.open(f'phone-{i}.tmp.png').convert('RGB').save(f'phone-{i}.jpg', quality=92)
for f in ['feature.tmp.png'] + [f'phone-{i}.tmp.png' for i in (1, 2, 3)]:
    os.remove(f)
PY
