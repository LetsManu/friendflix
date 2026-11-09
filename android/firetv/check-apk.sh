#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Checks a built Fire TV APK (signed or unsigned): package com.friendflix.firetv, a leanback launcher activity, a banner on
# <application>, touchscreen not required, no permission besides INTERNET and the package's own (androidx.core's
# DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION), and no Google Play services (com.google.android.gms) in the manifest or the dex.
# Fire OS has no Play services. Uses aapt2 from the newest $ANDROID_HOME/build-tools/*. Prints each failed check as a GitHub
# ::error:: line and exits 1; prints nothing when all checks pass.
# Usage: bash firetv/check-apk.sh <apk>   (android.yml, android-release.yml)
set -euo pipefail

apk=${1:?usage: check-apk.sh <apk>}
[ -f "$apk" ] || { echo "::error::check-apk: no such file: $apk"; exit 1; }

sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
[ -n "$sdk" ] || { echo "::error::check-apk: ANDROID_HOME is not set"; exit 1; }
tools=$(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n 1)
aapt2="$tools/aapt2"
[ -x "$aapt2" ] || { echo "::error::check-apk: no aapt2 in $sdk/build-tools"; exit 1; }

badging=$("$aapt2" dump badging "$apk")
xmltree=$("$aapt2" dump xmltree --file AndroidManifest.xml "$apk")

failed=0
fail() { echo "::error::Fire TV APK ($apk): $*"; failed=1; }

grep -q "^package: name='com.friendflix.firetv'" <<<"$badging" || fail "package is not com.friendflix.firetv"
grep -q '^leanback-launchable-activity:' <<<"$badging" || fail "no leanback launcher activity (LEANBACK_LAUNCHER)"

grep -q "^uses-permission: name='android.permission.INTERNET'" <<<"$badging" || fail "android.permission.INTERNET is missing"
while IFS= read -r perm; do
  case "$perm" in
    android.permission.INTERNET | com.friendflix.firetv.*) ;;
    *) fail "unexpected permission $perm" ;;
  esac
done < <(sed -n "s/^uses-permission: name='\([^']*\)'.*/\1/p" <<<"$badging")

# Attributes per element of the manifest tree: "<element>\t<attribute line>" for each A: line.
attrs=$(awk '/^ *E: /{ el=$2 } /^ *A: /{ print el "\t" $0 }' <<<"$xmltree")
grep -q "^application"$'\t'".*:banner(" <<<"$attrs" || fail "no android:banner on <application>"

# uses-feature android.hardware.touchscreen with android:required=false
touch_ok=$(awk '
  /^ *E: /{ if (el == "uses-feature" && name && req) ok = 1; el = $2; name = 0; req = 0; next }
  el == "uses-feature" && /:name\(/ && /"android.hardware.touchscreen"/ { name = 1 }
  el == "uses-feature" && /:required\(/ && /=false/ { req = 1 }
  END { if (el == "uses-feature" && name && req) ok = 1; print ok ? "yes" : "no" }
' <<<"$xmltree")
[ "$touch_ok" = yes ] || fail "android.hardware.touchscreen is not marked required=false"

grep -q 'com.google.android.gms' <<<"$xmltree" && fail "the manifest references Google Play services (com.google.android.gms)"
# grep without -q reads all of unzip's output (no SIGPIPE under pipefail)
if unzip -p "$apk" 'classes*.dex' | grep -a 'com/google/android/gms/' >/dev/null; then
  fail "the dex contains Google Play services classes (com.google.android.gms)"
fi

exit "$failed"
