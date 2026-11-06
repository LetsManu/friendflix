#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Adds a Tizen security profile and makes it the active one.
#   AUTHOR_PW=... [DIST_PW=...] add-profile.sh <name> <author.p12> [<distributor.p12>]
# Passwords come from the environment only (never arguments of this script). Without a distributor certificate the CLI
# uses the SDK's public Tizen distributor (enough for the PR check's throwaway build, not for a TV).
# Why the patch below: on Linux the CLI keeps certificate passwords in the desktop keyring (secret-tool) and writes a
# `.pwd` path into profiles.xml. A CI runner has no keyring, so `tizen package` then fails ("Invaild password") or asks
# for the password on the terminal. A password attribute that does not end in `.pwd` is read as a value encrypted with
# the CLI's own org.tizen.common.util.CipherUtil, so the passwords are encrypted with that class (a tiny Java helper
# against the installed CLI's jars) and written into the profile. profiles.xml is mode 600; tizen-release.yml deletes it
# (and the p12 files) afterwards.
set -euo pipefail

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  echo "Usage: AUTHOR_PW=... [DIST_PW=...] add-profile.sh <name> <author.p12> [<distributor.p12>]" >&2; exit 2
fi
name=$1 author=$2 dist=${3:-}
: "${AUTHOR_PW:?AUTHOR_PW is not set}"

# The CLI's wrapper (tools/ide/bin/tizen.sh) re-joins its arguments inside single quotes, unquoted, and evals them, and its
# Java 8 reads p12 passwords as ASCII: a password with a single quote, * ? [, a tab or newline, two spaces in a row, a
# leading or trailing space or a non-ASCII character does not reach it intact. Refuse those up front with a clear message.
cli_safe() {
  local LC_ALL=C
  [[ $1 =~ ^[!-~]+(\ [!-~]+)*$ ]] && [[ $1 != *[\'*?[]* ]]
}
check_pw() {
  cli_safe "$2" || { echo "::error title=Tizen signing::the $1 password has characters the Tizen CLI cannot take (single quote, * ? [, tabs, double, leading or trailing spaces, non-ASCII). Give the p12 a new password (docs/tizen.md) and update the secret." >&2; exit 1; }
}
check_pw author "$AUTHOR_PW"

# -f creates profiles.xml when there is none yet; -A makes the profile the active one. The CLI masks passwords in its output.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
log=$tmp/log
if [ -n "$dist" ]; then
  : "${DIST_PW:?DIST_PW is not set}"
  check_pw distributor "$DIST_PW"
  tizen security-profiles add -f -A -n "$name" -a "$author" -p "$AUTHOR_PW" -d "$dist" -dp "$DIST_PW" > "$log" 2>&1 || { cat "$log" >&2; exit 1; }
else
  # the password of the SDK's public distributor certificate (tools/certificate-generator/certificates/distributor)
  DIST_PW=tizenpkcs12passfordsigner
  tizen security-profiles add -f -A -n "$name" -a "$author" -p "$AUTHOR_PW" > "$log" 2>&1 || { cat "$log" >&2; exit 1; }
fi

profiles=$(tizen cli-config -l | sed -n 's/^default\.profiles\.path=//p' | tr -d '\r')
[ -f "$profiles" ] || { echo "no profiles.xml at '$profiles'" >&2; exit 1; }
chmod 600 "$profiles"

studio=$(cd "$(dirname "$(command -v tizen)")/../../.." && pwd)
jdk=$studio/jdk/bin
[ -x "$jdk/javac" ] || jdk=$(dirname "$(command -v javac)")
cat > "$tmp/TizenPw.java" <<'JAVA'
public class TizenPw {
  public static void main(String[] a) throws Exception {
    StringBuilder out = new StringBuilder();
    for (int i = 1; i < a.length; i++) out.append(org.tizen.common.util.CipherUtil.getEncryptedString(System.getenv(a[i]))).append('\n');
    java.nio.file.Files.write(java.nio.file.Paths.get(a[0]), out.toString().getBytes("UTF-8"));
  }
}
JAVA
classpath="$studio/tools/ide/lib-ncli/*"
"$jdk/javac" -nowarn -cp "$classpath" -d "$tmp" "$tmp/TizenPw.java" > "$log" 2>&1 || { cat "$log" >&2; exit 1; }
# the CLI's logging set-up chatters on the console, so the values go to a file
DIST_PW="$DIST_PW" "$jdk/java" -cp "$classpath:$tmp" TizenPw "$tmp/enc" AUTHOR_PW DIST_PW > "$log" 2>&1 || { cat "$log" >&2; exit 1; }
[ "$(grep -c . "$tmp/enc")" -eq 2 ] || { echo "could not encrypt the passwords" >&2; exit 1; }

PROFILE="$name" AUTHOR_ENC=$(sed -n 1p "$tmp/enc") DIST_ENC=$(sed -n 2p "$tmp/enc") \
  python3 -I - "$profiles" <<'PY'
import os, sys
import xml.etree.ElementTree as ET
path = sys.argv[1]
tree = ET.parse(path)
done = set()
for profile in tree.getroot().iter('profile'):
    if profile.get('name') != os.environ['PROFILE']:
        continue
    for item in profile.iter('profileitem'):
        if item.get('distributor') == '0':
            item.set('password', os.environ['AUTHOR_ENC']); done.add('author')
        elif item.get('distributor') == '1' and item.get('key'):
            item.set('password', os.environ['DIST_ENC']); done.add('distributor')
if done != {'author', 'distributor'}:
    sys.exit('profile %s: author or distributor entry missing in %s' % (os.environ['PROFILE'], path))
tree.write(path, encoding='UTF-8', xml_declaration=True)
PY
echo "security profile '$name' added and active"
