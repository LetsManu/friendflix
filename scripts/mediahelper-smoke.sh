#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Smoke test of the media server helper in the updater image (updater/src/mediaHelper.ts), run by CI's `docker` job on the
# updater image it built:
#   bash scripts/mediahelper-smoke.sh <updater image>
# The unit tests run the helper with the test machine's tar; this runs it where it really runs: in the updater's own image
# (Alpine, busybox tar), as a helper container is created (updater/src/mediaserver/template.ts helperSpec: uid other than the
# image's, no network, read-only root, no capabilities, no-new-privileges, /tmp tmpfs, the data volume without copy-up, the
# backup volume at /backups), on fresh named volumes:
#   1. backup, then restore into another volume: byte-equal round trip, nested folders included, `log` left out;
#   2. the same archive with 1 MiB of zeros after the end of the tar stream: busybox tar stops at the end-of-archive block and
#      the restore still succeeds (the helper reads the gzip stream to its end itself);
#   3. hostile archives: entries `../backups/…` and `/backups/…`; the header desyncs where tar reads no content although the
#      size says so (a directory or symlink with a size hiding the next header, a nameless header with a size, which busybox
#      takes for an empty block); a symlink to /backups and a file through it; a pax link path with a NUL (busybox ends it at
#      the NUL). Each restore answers backup_invalid and nothing is written, neither in the data volume nor in the backup volume
#      (mounted writable here to make an escape visible);
#   4. the helper started through a symlinked path still runs (its main-module check resolves the path).
# Removes its volumes. Exit 1 on any failure.
set -euo pipefail

IMAGE=${1:?usage: bash scripts/mediahelper-smoke.sh <updater image>}
RUN_AS=1234:1234
TAG=ff-mediahelper-smoke-$$
DATA=$TAG-data RESTORED=$TAG-restored BACKUPS=$TAG-backups
TMP=$(mktemp -d)
ID=ferrofin-20261117-1200-v1.5.1
PADDED=ferrofin-20261117-1201-v1.5.1
# the hostile archives, as written by the python block below
HOSTILE=(escape dir-size symlink-size nameless symlink-through pax-nul)
hostile_id() { echo "ferrofin-20261117-13$(printf '%02d' "$1")-v1.5.1"; }

cleanup() {
  docker volume rm "$DATA" "$RESTORED" "$BACKUPS" > /dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
fail=0
err() { echo "::error title=media helper smoke::$*"; fail=1; }
for v in "$DATA" "$RESTORED" "$BACKUPS"; do docker volume create "$v" > /dev/null; done

# as root, for setting up and reading the volumes only (the helper itself never runs as root)
as_root() { # <docker run options…> -- <sh script>
  local opts=()
  while [ "$1" != -- ]; do opts+=("$1"); shift; done
  shift
  docker run --rm --user 0:0 --network none "${opts[@]}" --entrypoint sh "$IMAGE" -c "$1"
}
# helper <data volume> <data ro|rw> <backups ro|rw> <verb> <args…>: prints the helper's answer, returns its exit code
helper() {
  local data=$1 data_mode=$2 backups_mode=$3
  shift 3
  local ro_data='' ro_backups=''
  [ "$data_mode" = rw ] || ro_data=,readonly
  [ "$backups_mode" = rw ] || ro_backups=,readonly
  docker run --rm --user "$RUN_AS" --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=64m --mount "type=volume,src=$data,dst=/data,volume-nocopy$ro_data" \
    --mount "type=volume,src=$BACKUPS,dst=/backups$ro_backups" "$IMAGE" node updater/dist/mediaHelper.js "$@"
}
# every file with its sha256 and every folder, relative to the volume root (without the volume root itself)
listing() { # <volume>
  as_root --mount "type=volume,src=$1,dst=/v,readonly" -- \
    'cd /v && find . -mindepth 1 -type d | sort | sed "s/^/dir /" && find . -type f | sort | while IFS= read -r f; do sha256sum "$f"; done
     find . -type l | sort | while IFS= read -r f; do echo "link $f -> $(readlink "$f")"; done'
}

# the data a media server leaves in its volume (owned by its uid): files at three depths, a binary, an empty folder, a log
as_root --mount "type=volume,src=$DATA,dst=/data,volume-nocopy" -- '
  set -e
  mkdir -p /data/data /data/metadata/library/ab/cd /data/plugins/configurations /data/log /data/root/default/Filme
  printf "library" > /data/data/library.db
  head -c 300000 /dev/urandom > /data/metadata/library/ab/cd/poster.jpg
  printf "<x/>" > /data/plugins/configurations/a.xml
  printf "secret log" > /data/log/log_1.txt
  chown -R '"$RUN_AS"' /data'
as_root --mount "type=volume,src=$RESTORED,dst=/data,volume-nocopy" -- 'printf stale > /data/stale.txt && chown -R '"$RUN_AS"' /data'

# 1. backup and restore
out=$(helper "$DATA" ro rw backup "$ID" 0 ferrofin v1.5.1) || err "backup failed: $out"
echo "backup: $out"
[[ "$out" == '{"size":'* ]] || err "backup did not answer its size: $out"
out=$(helper "$RESTORED" rw ro restore "$ID" ferrofin) || err "restore failed: $out"
echo "restore: $out"
[ "$out" = '{"ok":true}' ] || err "restore did not answer ok: $out"
want=$(listing "$DATA" | grep -vE '(^dir \./log$|\./log/)')
got=$(listing "$RESTORED")
if [ "$want" = "$got" ]; then echo "round trip: $(grep -c . <<< "$got") entries equal (log left out)"; else
  err "the restored data differs from the backed-up data"; diff <(echo "$want") <(echo "$got") || true
fi
owners=$(as_root --mount "type=volume,src=$RESTORED,dst=/v,readonly" -- 'find /v -mindepth 1 ! -user '"${RUN_AS%%:*}"' | head -n 3')
[ -z "$owners" ] || err "restored entries not owned by uid ${RUN_AS%%:*}: $owners"

# the archive itself, for the next two cases
as_root --mount "type=volume,src=$BACKUPS,dst=/backups,readonly" -- "cat /backups/$ID.tar.gz" > "$TMP/backup.tar.gz"
mkdir "$TMP/in"
{ gzip -dc "$TMP/backup.tar.gz"; head -c 1048576 /dev/zero; } | gzip > "$TMP/in/$PADDED.tar.gz"

# 3. the hostile archives: each a valid metadata entry, then the entries below, then the end of the archive. Headers are written
# by hand: tarfile would not write a size on a directory or a NUL in a pax value.
for n in "${!HOSTILE[@]}"; do python3 - "${HOSTILE[$n]}" "$TMP/in/$(hostile_id "$n").tar.gz" << 'PY'
import gzip, json, sys

def header(name, typ="0", size=0, link=""):
    h = bytearray(512)
    h[0:100] = name.encode().ljust(100, b"\0")[:100]
    h[100:108] = b"0000644\0"
    h[108:116] = h[116:124] = b"0001750\0"
    h[124:136] = b"%011o\0" % size
    h[136:148] = b"00000000000\0"
    h[156:157] = typ.encode()
    h[157:257] = link.encode().ljust(100, b"\0")[:100]
    h[257:265] = b"ustar\x0000"
    h[148:156] = b" " * 8
    h[148:156] = b"%06o\0 " % sum(h)
    return bytes(h)

def entry(name, data=b"", typ="0", link=""):
    return header(name, typ, len(data), link) + data + b"\0" * (-len(data) % 512)

def pax(**kv):
    out = b""
    for k, v in kv.items():
        rec = b" %s=%s\n" % (k.encode(), v.encode())
        n = len(rec) + 1
        while len(b"%d" % n + rec) != n:
            n += 1
        out += b"%d" % n + rec
    return out

meta = json.dumps({"v": 1, "kind": "ferrofin", "upstream": "v1.5.1", "createdAt": "2026-11-17T13:00:00.000Z"}).encode()
cases = {
    "escape": entry("data/harmless.txt", b"ok") + entry("../backups/escaped-relative", b"x") + entry("/backups/escaped-absolute", b"x"),
    # tar reads no content for a directory or symlink: their "content" is the next header
    "dir-size": header("d/", "5", 512) + entry("data", typ="2", link="/backups"),
    "symlink-size": header("s", "2", 512, link="x") + header("../backups/escaped-symlink-size"),
    # busybox takes a nameless header for an empty block whatever its size
    "nameless": header("", "0", 512) + entry("data", typ="2", link="/backups"),
    "symlink-through": entry("lnk", typ="2", link="/backups") + entry("lnk/escaped-through-link", b"x"),
    # busybox ends a pax value at a NUL: the link is ".." to it
    "pax-nul": entry("PaxHeaders/l", pax(linkpath="..\0x"), typ="x") + entry("l", typ="2", link="y")
               + entry("l/backups/escaped-pax-nul", b"x"),
}
with gzip.open(sys.argv[2], "wb") as f:
    f.write(entry("friendflix-backup.json", meta) + cases[sys.argv[1]] + b"\0" * 1024)
PY
done
as_root --mount "type=volume,src=$BACKUPS,dst=/backups" -v "$TMP/in:/in:ro" -- 'cp /in/*.tar.gz /backups/ && chmod 0644 /backups/*.tar.gz'

# 2. trailing data after the end of the archive
as_root --mount "type=volume,src=$RESTORED,dst=/data,volume-nocopy" -- 'printf stale > /data/stale.txt && chown '"$RUN_AS"' /data/stale.txt'
out=$(helper "$RESTORED" rw ro restore "$PADDED" ferrofin) || err "restore of the archive with trailing zeros failed: $out"
echo "restore with 1 MiB after the end of the archive: $out"
[ "$out" = '{"ok":true}' ] || err "restore with trailing zeros did not answer ok: $out"
[ "$(listing "$RESTORED")" = "$want" ] || err "restore with trailing zeros: the data differs"

# 3. each refused, and nothing written anywhere (backups mounted writable on purpose)
for n in "${!HOSTILE[@]}"; do
  what=${HOSTILE[$n]}
  backups_before=$(listing "$BACKUPS")
  data_before=$(listing "$RESTORED")
  rc=0
  out=$(helper "$RESTORED" rw rw restore "$(hostile_id "$n")" ferrofin) || rc=$?
  echo "restore of the hostile archive '$what': exit $rc, $out"
  [ "$rc" = 2 ] && [ "$out" = '{"error":"backup_invalid"}' ] || err "hostile archive '$what': not refused as backup_invalid (exit $rc: $out)"
  [ "$(listing "$BACKUPS")" = "$backups_before" ] || err "hostile archive '$what': the backup volume changed: $(listing "$BACKUPS" | grep -E 'escaped|^link' || true)"
  [ "$(listing "$RESTORED")" = "$data_before" ] || err "hostile archive '$what': the data volume changed: $(diff <(echo "$data_before") <(listing "$RESTORED") || true)"
done

# 4. started through a symlink (in /tmp, the only writable place)
out=$(docker run --rm --user "$RUN_AS" --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:size=64m \
  --entrypoint sh "$IMAGE" -c 'ln -s /app/updater/dist/mediaHelper.js /tmp/helper.js && exec node /tmp/helper.js gpu') || err "the helper via a symlink failed: $out"
echo "helper via a symlink: $out"
[[ "$out" == '{"nodes":'* ]] || err "the helper started through a symlink did not answer (main-module check)"

[ "$fail" = 0 ] && echo "media helper smoke test passed: $IMAGE"
exit "$fail"
