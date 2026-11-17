#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Smoke test of FriendFlix's media server image (mediaserver/README.md), run by CI's `mediaserver-image` job on the image it built:
#   bash scripts/mediaserver-smoke.sh <image>
#   bash scripts/mediaserver-smoke.sh --compare <inspect.json> [<fixture.json>]   (only the inspect comparison, for local runs)
# Runs the image the way the updater's container template does (updater/src/mediaserver/template.ts: read-only root, /tmp tmpfs,
# no capabilities, no-new-privileges, pids limit, init, stop timeout, log limits, TZ and FERROFIN_CACHE_DIR=/cache, fresh named
# volumes at /data and /cache as `--mount`, the template's labels), with these differences: user 1234:1234 instead of the owner's
# pick (any uid other than the image's 1000 proves change 0005), the API port published on 127.0.0.1 for the checks, the default
# bridge network, no restart policy (a crash must show), no GPU and no media folders. Within 180 s it needs:
#   GET /System/Info/Public 200, GET /web/ and /web/index.html 404 (change 0004), health `healthy` (change 0003);
# then the container user writes a marker into /cache and /data and the marker is found in the cache volume, and the server's
# log has no "Read-only file system" (a write outside /data, /cache and /tmp). Last, `docker inspect` of the container is
# compared with the updater's inspect fixture (updater/test/fixtures/mediaserver-inspect.json, the input of the guard's inspect
# tests): the image's own facts must match (else the fixture or the guard needs updating), other key differences are reported
# as warnings. Prints the log tail; removes the container and both volumes. Exit 1 on any failure.
set -euo pipefail

FIXTURE_DEFAULT=updater/test/fixtures/mediaserver-inspect.json
# run options that differ from the template on purpose (see above): never reported
EXPECTED_DIFF='["HostConfig.PortBindings","HostConfig.RestartPolicy","HostConfig.GroupAdd","HostConfig.Devices"]'

# one line per finding: "error <text>", "warning <text>" or "info <text>"
compare() { # <inspect.json> <fixture.json>
  jq -r -n --slurpfile a "$1" --slurpfile f "$2" --argjson expected "$EXPECTED_DIFF" '
    def unset: . == null or . == "" or . == 0 or . == false or . == [] or . == {};
    def setkeys: [to_entries[] | select(.value | unset | not) | .key];
    def image_env: [(.Config.Env // [])[] | select((startswith("TZ=") or startswith("FERROFIN_CACHE_DIR=")) | not)] | sort;
    def image_labels: (.Config.Labels // {}) | with_entries(select(.key | startswith("io.github.letsmanu.friendflix.mediaserver.")));
    def hc: (.Config.Healthcheck // {}) | {Test, Interval, Timeout, StartPeriod, Retries};
    ($a[0]) as $a | ($f[0]) as $f |
    # the image facts the guard and the template rely on: must equal the fixture
    ( [ ["Config.Entrypoint", $a.Config.Entrypoint, $f.Config.Entrypoint],
        ["Config.Cmd", $a.Config.Cmd, $f.Config.Cmd],
        ["Config.Volumes", ($a.Config.Volumes // {} | keys), ($f.Config.Volumes // {} | keys)],
        ["Config.ExposedPorts", ($a.Config.ExposedPorts // {} | keys), ($f.Config.ExposedPorts // {} | keys)],
        ["Config.Healthcheck", ($a | hc), ($f | hc)],
        ["Config.Env (the image part)", ($a | image_env), ($f | image_env)],
        ["Config.Labels (io.github.letsmanu.friendflix.mediaserver.*)", ($a | image_labels), ($f | image_labels)] ]
      | .[] | select(.[1] != .[2])
      | "error \(.[0]) differs from the fixture: image \(.[1] | tojson), fixture \(.[2] | tojson)" ),
    ( ["MaskedPaths", "ReadonlyPaths"][] as $k | select(($a.HostConfig[$k] // []) | length == 0)
      | "error HostConfig.\($k) is empty: the engine did not apply its default masked and read-only paths" ),
    # every other key: set (not null, empty, 0 or false) on one side only, reported, never fatal
    ( ["Config", "HostConfig"][] as $s
      | ($a[$s] | setkeys) as $ka | ($f[$s] | setkeys) as $kf
      | ( ($ka - $kf)[] | "\($s).\(.)" | select(IN($expected[]) | not) | "warning \(.) is set on this engine but not in the fixture" ),
        ( ($kf - $ka)[] | "\($s).\(.)" | select(IN($expected[]) | not) | "warning \(.) is set in the fixture but not on this engine" ) ),
    ( (($a | keys) - ($f | keys))[] | "warning top-level key \(.) is new on this engine (not in the fixture)" ),
    ( (($f | keys) - ($a | keys))[] | "warning top-level key \(.) of the fixture is missing on this engine" ),
    ( (($a.Mounts // []) | map(keys) | add // []) as $ma | (($f.Mounts // []) | map(keys) | add // []) as $mf
      | ( (($ma | unique) - ($mf | unique))[] | "warning Mounts entries carry \(.) (not in the fixture)" ),
        ( (($mf | unique) - ($ma | unique))[] | "warning Mounts entries lack \(.) (the fixture has it)" ) ),
    ( ["CgroupnsMode", "IpcMode", "Runtime", "ShmSize"][] as $k | select($a.HostConfig[$k] != $f.HostConfig[$k])
      | "warning HostConfig.\($k) is \($a.HostConfig[$k] | tojson) on this engine, \($f.HostConfig[$k] | tojson) in the fixture" ),
    "info compared with the fixture; on purpose different here: \($expected | join(", "))"
  '
}

# the findings as CI annotations; 1 when there is an error
annotate() { # <fixture.json>, findings on stdin
  local rc=0 kind text
  while IFS= read -r line; do
    kind=${line%% *} text=${line#* }
    case "$kind" in
      error) echo "::error file=$1,title=media server inspect::$text"; rc=1 ;;
      warning) echo "::warning file=$1,title=media server inspect::$text" ;;
      *) echo "$text" ;;
    esac
  done
  return "$rc"
}

if [ "${1:-}" = --compare ]; then
  [ $# -ge 2 ] || { echo "usage: $0 --compare <inspect.json> [<fixture.json>]" >&2; exit 2; }
  fixture=${3:-$FIXTURE_DEFAULT}
  compare "$2" "$fixture" | annotate "$fixture"
  exit
fi

IMAGE=${1:?usage: bash scripts/mediaserver-smoke.sh <image>}
FIXTURE=${FIXTURE:-$FIXTURE_DEFAULT}
PORT=${MEDIASERVER_SMOKE_PORT:-18096}
RUN_AS=1234:1234
TAG=ff-mediaserver-smoke-$$
NAME=$TAG DATA=$TAG-data CACHE=$TAG-cache
BASE=http://127.0.0.1:$PORT
TMP=$(mktemp -d)

cleanup() {
  docker rm -f "$NAME" > /dev/null 2>&1 || true
  docker volume rm "$DATA" "$CACHE" > /dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
fail=0
err() { echo "::error title=media server smoke::$*"; fail=1; }

docker volume create "$DATA" > /dev/null
docker volume create "$CACHE" > /dev/null
docker run -d --name "$NAME" --hostname mediaserver --user "$RUN_AS" \
  --read-only --tmpfs /tmp:size=512m,mode=1777 --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 4096 --init \
  --stop-timeout 30 --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  -e TZ=Europe/Berlin -e FERROFIN_CACHE_DIR=/cache \
  --label friendflix.managed=mediaserver --label friendflix.project=ffsmoke --label friendflix.kind=ferrofin \
  --label friendflix.template=1 --label "friendflix.spec=$(printf '0%.0s' {1..64})" --label com.centurylinklabs.watchtower.enable=false \
  --mount "type=volume,src=$DATA,dst=/data" --mount "type=volume,src=$CACHE,dst=/cache" \
  -p "127.0.0.1:$PORT:8096" "$IMAGE" > /dev/null

info='' web='' web_index='' health='' state=''
for i in $(seq 1 60); do
  state=$(docker inspect -f '{{.State.Status}}' "$NAME")
  [ "$state" = running ] || break
  info=$(curl -fsS -m 5 "$BASE/System/Info/Public" 2> /dev/null || true)
  web=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/web/" || true)
  web_index=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/web/index.html" || true)
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME")
  [ -n "$info" ] && [ "$web" = 404 ] && [ "$web_index" = 404 ] && [ "$health" = healthy ] && break
  [ "$i" -lt 60 ] && sleep 3
done
echo "after about $((i * 3)) s: state $state, /System/Info/Public ${info:+answers}${info:-no answer}, /web/ $web, /web/index.html $web_index, health $health"
[ "$state" = running ] || err "the container is $state, not running"
[ -n "$info" ] || err "GET /System/Info/Public did not answer 200 within 180 s"
[ -z "$info" ] || echo "System/Info/Public: $(head -c 300 <<< "$info")"
[ "$web" = 404 ] || err "GET /web/ answered $web, not 404: the image still serves a web client (change 0004)"
[ "$web_index" = 404 ] || err "GET /web/index.html answered $web_index, not 404 (change 0004)"
[ "$health" = healthy ] || err "health is '$health', not healthy (change 0003)"

if [ "$state" = running ]; then
  # change 0005: the state volumes are writable for a uid that is not the image's owner
  echo "state directories (mode owner): $(docker exec "$NAME" stat -c '%n %a %u:%g' /data /cache | tr '\n' ' ')"
  docker exec "$NAME" bash -c 'echo smoke > /cache/.friendflix-smoke && echo smoke > /data/.friendflix-smoke' \
    || err "uid $RUN_AS cannot write /cache or /data (change 0005)"
  docker run --rm --network none --user "$RUN_AS" --mount "type=volume,src=$CACHE,dst=/c,readonly" --entrypoint test "$IMAGE" -s /c/.friendflix-smoke \
    || err "the marker written to /cache is not in the cache volume"
  written=$(docker exec "$NAME" find /data -mindepth 1 -maxdepth 1 -user "${RUN_AS%%:*}" ! -name .friendflix-smoke 2> /dev/null | head -n 5 | tr '\n' ' ' || true)
  [ -n "$written" ] && echo "the server wrote to /data as uid ${RUN_AS%%:*}: $written" || err "the server wrote nothing to /data as uid ${RUN_AS%%:*}"
fi

# a write outside the volumes and /tmp fails on the read-only root: the server reports it in its log
logs=$(docker logs "$NAME" 2>&1 || true)
erofs=$(grep -iE 'read-only file system|os error 30' <<< "$logs" | head -n 5 || true)
[ -z "$erofs" ] || err "the server tried to write outside /data, /cache and /tmp: $(tr '\n' ' ' <<< "$erofs")"

docker inspect "$NAME" | jq '.[0]' > "$TMP/inspect.json"
echo "--- docker inspect (the keys the updater's guard reads)"
jq -c '{Config: (.Config | {Hostname, User, Image, Env, Labels, StopTimeout, Entrypoint, Cmd, Volumes, ExposedPorts, Healthcheck, WorkingDir, StopSignal}),
  HostConfig: (.HostConfig | with_entries(select(.value | (. == null or . == "" or . == 0 or . == false or . == [] or . == {}) | not))),
  Mounts}' "$TMP/inspect.json"
compare "$TMP/inspect.json" "$FIXTURE" | annotate "$FIXTURE" || fail=1

echo "--- server log (last 40 lines)"
tail -n 40 <<< "$logs"
[ "$fail" = 0 ] && echo "media server image smoke test passed: $IMAGE"
exit "$fail"
