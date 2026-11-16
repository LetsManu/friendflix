#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Try FriendFlix's media server image (Ferrofin-based, mediaserver/README.md) next to Jellyfin, on a COPY of Jellyfin's
# config folder. Jellyfin's own folder is only read, never changed: Ferrofin converts its copy one-way (until Ferrofin 1.6.0),
# so it must never get Jellyfin's real folder, and Jellyfin must never get the copy.
#
#   bash try.sh [options]     set up and start the trial container (asks before the step that stops Jellyfin)
#   bash try.sh status        what is running
#   bash try.sh remove        disconnect and remove the trial container (the copied folder stays)
#
# Options (setup):
#   --attach-network <net>    also connect the container to this Docker network (repeatable). Use FriendFlix's backend/gateway
#                             network (e.g. friendflix_media) so FriendFlix reaches it as http://ferrofin:8096
#   --publish [<ip>:]<port>   publish port 8096 on the host, for a FriendFlix that reaches its media server by host IP:port
#                             (e.g. --publish 192.0.2.10:8097 -> http://192.0.2.10:8097)
#   --with-trickplay          also copy Jellyfin's data/trickplay (its size is shown either way)
#   --jellyfin <container>    the Jellyfin container (default: the one running container whose name contains "jellyfin")
#   --name <name>             name of the trial container (default ferrofin)
# Env:
#   IMAGE=<image>             default: ghcr.io/letsmanu/friendflix-mediaserver (latest, else nightly); while that is not
#                             published, the upstream Ferrofin release (pinned digest), which cannot tone-map HDR on Intel
#   DOCKER=/path/to/docker    when `docker` is not on PATH (some NAS systems); DOCKER_HOST is honoured
#
# Run it as root or as a user in the docker group. It prints the engine it talks to (and its DockerRootDir) before anything else.
# What it does: reads Jellyfin's folders, devices and networks from Docker; checks that the container user (uid 1000) can list,
# read and watch the media; stops Jellyfin for the copy and starts it again; starts the trial container with the copy, the
# SAME media folders read-only at the same paths, no Docker socket, no capabilities, and a label that tells Watchtower-style
# auto-updaters to leave it alone (a newer image would upgrade the one-way database by itself).
set -euo pipefail

OUR_IMAGE="ghcr.io/letsmanu/friendflix-mediaserver"
UPSTREAM_IMAGE="ghcr.io/mangoleaf/ferrofin:v1.5.1@sha256:5980a3c29c0bab564793f4fcf786e737b91a9eba26e9fb1d6f1c203ccb56580a"
# helper for copies and checks, pinned like scripts/backup-bootstrap.sh (busybox: ls, cp, du, find, inotifyd, wget)
HELPER="alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"
UID_IN_IMAGE=1000 # the image's user `ferrofin`

die() { echo "ERROR: $*" >&2; exit 1; }
ask() { local a; read -r -p "$1 [y/N] " a; [[ "$a" == y || "$a" == Y ]]; }

# --- arguments ---
CMD=setup NAME=ferrofin JF='' PUBLISH='' TRICKPLAY=0
ATTACH=()
while [ $# -gt 0 ]; do
  case "$1" in
    setup|status|remove) CMD=$1; shift ;;
    --attach-network) [ -n "${2:-}" ] || die "--attach-network needs a network name"; ATTACH+=("$2"); shift 2 ;;
    --publish) [ -n "${2:-}" ] || die "--publish needs [<ip>:]<port>"; PUBLISH=$2; shift 2 ;;
    --with-trickplay) TRICKPLAY=1; shift ;;
    --jellyfin) [ -n "${2:-}" ] || die "--jellyfin needs a container name"; JF=$2; shift 2 ;;
    --name) [ -n "${2:-}" ] || die "--name needs a name"; NAME=$2; shift 2 ;;
    -h|--help) awk 'NR >= 4 && /^#/ { sub(/^# ?/, ""); print } /^set -euo/ { exit }' "$0"; exit 0 ;;
    *) die "unknown argument $1 (bash $0 --help)" ;;
  esac
done

# --- the docker CLI and the engine (not always on PATH on a NAS) ---
if [ -n "${DOCKER:-}" ]; then
  [ -x "$DOCKER" ] || die "DOCKER=$DOCKER is not an executable file"
elif command -v docker >/dev/null 2>&1; then
  DOCKER=$(command -v docker)
else
  for c in /usr/local/bin/docker /usr/bin/docker /var/packages/ContainerManager/target/usr/bin/docker /var/packages/Docker/target/usr/bin/docker; do
    [ -x "$c" ] && { DOCKER=$c; break; }
  done
  [ -n "${DOCKER:-}" ] || die "docker not found on PATH. Run again with DOCKER=/path/to/docker"
fi
d() { "$DOCKER" "$@"; }
if ! info=$(d info --format 'engine {{.ServerVersion}}, DockerRootDir {{.DockerRootDir}}' 2>&1); then
  echo "$info" | tail -n 3 >&2
  die "cannot use the Docker engine as uid $(id -u) ($DOCKER${DOCKER_HOST:+, DOCKER_HOST=$DOCKER_HOST}). Run as root or as a user in the docker group."
fi
echo "Docker: $DOCKER, $info${DOCKER_HOST:+, DOCKER_HOST=$DOCKER_HOST}"

exists() { d container inspect "$NAME" >/dev/null 2>&1; }
find_jellyfin() {
  [ -n "$JF" ] && { echo "$JF"; return; }
  d ps --format '{{.Names}}' | grep -i jellyfin | grep -vix "$NAME" || true
}
# shellcheck disable=SC2016 # Go template, not shell
networks_of() { d inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$1" | grep -v '^$' || true; }

case "$CMD" in
  status)
    if exists; then
      d inspect -f "Trial: {{.Name}} {{.State.Status}} since {{.State.StartedAt}}, image {{.Config.Image}}" "$NAME"
      echo "  networks: $(networks_of "$NAME" | tr '\n' ' ')"
      echo "  data: $(d inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{if .Name}}volume {{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$NAME")"
    else
      echo "Trial: no container named $NAME"
    fi
    while IFS= read -r j; do [ -n "$j" ] && d ps -a --filter "name=^${j}$" --format 'Jellyfin: {{.Names}} {{.Status}}'; done <<< "$(find_jellyfin)"
    exit 0 ;;
  remove)
    exists || { echo "No container named $NAME."; exit 0; }
    data=$(d inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{if .Name}}volume {{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$NAME")
    while IFS= read -r n; do [ -n "$n" ] && d network disconnect "$n" "$NAME" >/dev/null 2>&1 && echo "disconnected from $n"; done <<< "$(networks_of "$NAME")"
    d rm -f "$NAME" >/dev/null
    echo "Container $NAME removed. The copy is kept ($data); delete it by hand when you are done."
    echo "FriendFlix: set Admin → Einstellungen → Medienserver back to your Jellyfin address (e.g. http://jellyfin:8096 or http://192.0.2.10:8096)."
    exit 0 ;;
esac

# ============================================================ setup
exists && die "a container named $NAME already exists (bash $0 remove, or --name <other>)"

mapfile -t CANDS < <(find_jellyfin)
[ ${#CANDS[@]} -gt 0 ] || die "no running Jellyfin container found (pass --jellyfin <container>)"
[ ${#CANDS[@]} -eq 1 ] || die "several containers look like Jellyfin: ${CANDS[*]} (pass --jellyfin <container>)"
J=${CANDS[0]}
[ "$(d inspect -f '{{.State.Running}}' "$J" 2>/dev/null)" = true ] || die "container $J is not running"
echo "Jellyfin container: $J"

# --- Jellyfin's mounts (Jellyfin may be its own stack with bind mounts such as /config, /cache, /media, /media2) ---
mnt() { d inspect -f "{{range .Mounts}}{{if eq .Destination \"/config\"}}{{.$1}}{{end}}{{end}}" "$J"; }
CONFIG_TYPE=$(mnt Type) CONFIG_SRC=$(mnt Source)
[ -n "$CONFIG_SRC" ] || die "Jellyfin has no /config mount; this script expects the official image's layout"
SRC_MOUNT=$CONFIG_SRC
[ "$CONFIG_TYPE" = volume ] && SRC_MOUNT=$(mnt Name)
echo "Jellyfin config: $SRC_MOUNT ($CONFIG_TYPE)"

# media = every other mount except config, cache, transcodes, the Docker socket and devices
mapfile -t MEDIA < <(d inspect -f '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' "$J" \
  | grep -v '^$' | grep -vE '\|/(config|cache)(/|$)|\|/transcodes?(/|$)|docker\.sock|\|/dev(/|$)' || true)
[ ${#MEDIA[@]} -gt 0 ] || die "Jellyfin has no media mount besides /config and /cache"
echo "Media folders (read-only in the trial, at the same paths so the library paths match):"
for m in "${MEDIA[@]}"; do echo "  ${m%%|*} -> ${m##*|}"; done

# --- networks: Jellyfin's bridge networks plus --attach-network ---
NETS=()
while IFS= read -r n; do
  [ -n "$n" ] || continue
  case "$n" in host|none) echo "NOTE: Jellyfin uses network '$n'; the trial does not (port 8096 would clash)."; continue ;; esac
  drv=$(d network inspect -f '{{.Driver}}' "$n" 2>/dev/null || echo '?')
  if [ "$drv" != bridge ] && [ "$drv" != overlay ]; then
    echo "NOTE: skipping Jellyfin's network $n (driver $drv: it would need its own address)"; continue
  fi
  NETS+=("$n")
done <<< "$(networks_of "$J")"
for n in ${ATTACH[@]+"${ATTACH[@]}"}; do
  d network inspect "$n" >/dev/null 2>&1 || die "network $n not found (docker network ls)"
  [[ " ${NETS[*]:-} " == *" $n "* ]] || NETS+=("$n")
done
echo "Networks: ${NETS[*]:-(default bridge)}"
if [ ${#ATTACH[@]} -eq 0 ] && [ -z "$PUBLISH" ]; then
  echo "NOTE: no --attach-network and no --publish: FriendFlix reaches the trial only if it shares one of the networks above."
  echo "      If FriendFlix reaches Jellyfin by host IP:port, or Jellyfin is its own stack, use --attach-network friendflix_media"
  echo "      (FriendFlix's media network: docker network ls) or --publish 192.0.2.10:8097."
fi

# --- GPU: Jellyfin's devices and groups; /dev/dri with its render group when Jellyfin passes none (e.g. a privileged one) ---
mapfile -t DEVS < <(d inspect -f '{{range .HostConfig.Devices}}{{.PathOnHost}}:{{.PathInContainer}}{{"\n"}}{{end}}' "$J" | grep -v '^$' || true)
mapfile -t GROUPS_ADD < <(d inspect -f '{{range .HostConfig.GroupAdd}}{{.}}{{"\n"}}{{end}}' "$J" | grep -v '^$' || true)
if [ ${#DEVS[@]} -eq 0 ] && [ -d /dev/dri ]; then DEVS=(/dev/dri:/dev/dri); fi
if [ -c /dev/dri/renderD128 ]; then
  rg=$(stat -c %g /dev/dri/renderD128)
  [[ " ${GROUPS_ADD[*]:-} " == *" $rg "* ]] || GROUPS_ADD+=("$rg")
fi
for i in ${GROUPS_ADD[@]+"${!GROUPS_ADD[@]}"}; do # names resolve in the image's /etc/group, not the host's: use the host's number
  g=${GROUPS_ADD[$i]}
  if ! [[ "$g" =~ ^[0-9]+$ ]]; then
    gid=$(getent group "$g" 2>/dev/null | cut -d: -f3 || true)
    if [ -n "$gid" ]; then GROUPS_ADD[i]=$gid; else echo "WARNING: group '$g' has no number on this host; passed by name"; fi
  fi
done
[ ${#DEVS[@]} -gt 0 ] && echo "GPU devices: ${DEVS[*]}${GROUPS_ADD[*]:+ (groups ${GROUPS_ADD[*]})}"
GA=()
for g in ${GROUPS_ADD[@]+"${GROUPS_ADD[@]}"}; do GA+=(--group-add "$g"); done

# --- image: IMAGE=, else ours, else the upstream release; then pinned to its digest ---
pull() { d pull -q "$1" >/dev/null 2>&1; }
if [ -n "${IMAGE:-}" ]; then
  pull "$IMAGE" || d image inspect "$IMAGE" >/dev/null 2>&1 || die "cannot pull $IMAGE (and it is not a local image)"
else
  for t in latest nightly; do
    if pull "$OUR_IMAGE:$t"; then IMAGE="$OUR_IMAGE:$t"; break; fi
  done
  if [ -z "${IMAGE:-}" ]; then
    IMAGE=$UPSTREAM_IMAGE
    echo "NOTE: $OUR_IMAGE is not published yet; using the upstream Ferrofin release (no HDR tone mapping on Intel GPUs)."
    pull "$IMAGE" || die "cannot pull $IMAGE"
  fi
fi
DIGEST=$(d image inspect --format '{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || true)
# a local build (no registry digest) is pinned by its image id
[ -n "$DIGEST" ] || DIGEST=$(d image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)
[ -n "$DIGEST" ] || die "could not read the digest of $IMAGE"
echo "Image: $IMAGE, pinned as $DIGEST"
pull "$HELPER" || d image inspect "$HELPER" >/dev/null 2>&1 || die "cannot pull the helper image $HELPER"

# --- target: a sibling folder of Jellyfin's config folder (bind mount), or a new named volume ---
if [ "$CONFIG_TYPE" = bind ]; then
  DST="$(dirname "$CONFIG_SRC")/${NAME}-config"
  [ -e "$DST" ] && die "$DST already exists; move it away or delete it first"
else
  DST="${NAME}-config"
  d volume inspect "$DST" >/dev/null 2>&1 && die "volume $DST already exists; remove it first"
fi
echo "The copy will be: $DST"

# --- Jellyfin's layout and what will be copied ---
d run --rm --network none -v "$SRC_MOUNT":/src:ro "$HELPER" sh -c 'test -f /src/data/jellyfin.db && test -d /src/root/default && test -d /src/config' \
  || die "unexpected layout under Jellyfin's /config (need data/jellyfin.db, root/default, config/); found: $(d run --rm --network none -v "$SRC_MOUNT":/src:ro "$HELPER" ls /src | tr '\n' ' ')"
# shellcheck disable=SC2016 # expanded by the helper's sh
SIZE=$(d run --rm --network none -v "$SRC_MOUNT":/src:ro "$HELPER" sh -c \
  'for p in data root/default metadata config; do if [ -e "/src/$p" ]; then printf "%s %s, " "$p" "$(du -sh "/src/$p" | cut -f1)"; fi; done' || true)
TP_SIZE=$(d run --rm --network none -v "$SRC_MOUNT":/src:ro "$HELPER" sh -c '[ -d /src/data/trickplay ] && du -sh /src/data/trickplay | cut -f1 || echo none' || echo '?')
echo "Jellyfin's folders: ${SIZE%, } (data/ includes trickplay)"
if [ "$TRICKPLAY" = 1 ]; then
  echo "Trickplay (data/trickplay): $TP_SIZE, copied (--with-trickplay)"
else
  echo "Trickplay (data/trickplay): $TP_SIZE, not copied (add --with-trickplay to copy it; otherwise the trial regenerates it)"
fi

# --- can the image's user list, read and watch the media? ---
echo
echo "Media check as uid $UID_IN_IMAGE${GROUPS_ADD[*]:+ with groups ${GROUPS_ADD[*]}}:"
WATCHES=$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo '?')
for m in "${MEDIA[@]}"; do
  # shellcheck disable=SC2016 # expanded by the helper's sh
  r=$(d run --rm --network none --user "$UID_IN_IMAGE:$UID_IN_IMAGE" ${GA[@]+"${GA[@]}"} -v "${m%%|*}":/m:ro "$HELPER" sh -c '
    ls /m >/dev/null 2>&1 || { echo "list=FAIL"; exit 0; }; echo "list=ok"
    f=$(find /m -type f -size +0 2>/dev/null | head -n 1)
    if [ -z "$f" ]; then echo "read=nofile"; elif head -c 65536 "$f" >/dev/null 2>&1; then echo "read=ok"; else echo "read=FAIL ${f#/m/}"; fi
    s=$(find /m -mindepth 1 -maxdepth 2 -type d 2>/dev/null | head -n 1); s=${s:-/m}
    command -v inotifyd >/dev/null 2>&1 || { echo "watch=untested"; exit 0; }
    inotifyd - "$s" >/dev/null 2>/tmp/w & p=$!; sleep 1
    if kill -0 "$p" 2>/dev/null; then kill "$p"; echo "watch=ok"; else echo "watch=FAIL $(head -c 120 /tmp/w)"; fi' 2>&1 || echo "list=FAIL")
  src=${m%%|*}
  case "$r" in *list=ok*) echo "  $src: can list" ;; *) echo "  WARNING $src: uid $UID_IN_IMAGE cannot list it; the trial will not see those files." ; continue ;; esac
  case "$r" in
    *read=ok*) echo "  $src: can read a file" ;;
    *read=nofile*) echo "  $src: no file found to test reading" ;;
    *) echo "  WARNING $src: cannot read a file (${r##*read=FAIL }): playback of such files will fail. Check owner/mode (uid $UID_IN_IMAGE)." ;;
  esac
  case "$r" in
    *watch=ok*) echo "  $src: can watch a subfolder (inotify)" ;;
    *watch=untested*) echo "  $src: inotify not tested (the helper image has no inotifyd)" ;;
    *) echo "  WARNING $src: cannot watch a subfolder (inotify): new files appear only after a library scan."
       echo "          max_user_watches on this host: $WATCHES (raise fs.inotify.max_user_watches; network shares never notify)" ;;
  esac
done

echo
ask "Stop Jellyfin ($J) for the copy (seconds to minutes, depending on the metadata size), then start it again?" || die "stopped by you, nothing changed"

[ "$CONFIG_TYPE" = volume ] && d volume create "$DST" >/dev/null
d stop "$J" >/dev/null
trap 'd start "$J" >/dev/null 2>&1 || true' EXIT
# shellcheck disable=SC2016 # expanded by the helper's sh
d run --rm --network none -e TRICKPLAY="$TRICKPLAY" -e OWNER="$UID_IN_IMAGE:$UID_IN_IMAGE" -v "$SRC_MOUNT":/src:ro -v "$DST":/dst "$HELPER" sh -c '
  set -e
  mkdir -p /dst/data /dst/root /dst/config
  cp -a /src/data/jellyfin.db* /dst/data/
  if [ -f /src/data/device.txt ]; then cp -a /src/data/device.txt /dst/data/; fi   # keeps the server id
  for p in playlists collections; do if [ -d "/src/data/$p" ]; then cp -a "/src/data/$p" /dst/data/; fi; done
  if [ "$TRICKPLAY" = 1 ] && [ -d /src/data/trickplay ]; then cp -a /src/data/trickplay /dst/data/; fi
  cp -a /src/root/default /dst/root/
  if [ -d /src/metadata ]; then cp -a /src/metadata /dst/; fi
  for f in /src/config/*.xml; do if [ -f "$f" ]; then cp -a "$f" /dst/config/; fi; done
  chown -R "$OWNER" /dst'
d start "$J" >/dev/null
trap - EXIT
echo "Copy done, Jellyfin is running again."

# --- start the trial ---
ARGS=(-d --name "$NAME" --restart unless-stopped --cap-drop ALL --security-opt no-new-privileges:true
      --label com.centurylinklabs.watchtower.enable=false --label io.github.letsmanu.friendflix.trial=mediaserver
      -v "$DST":/data)
[ ${#NETS[@]} -gt 0 ] && ARGS+=(--network "${NETS[0]}")
[ -n "$PUBLISH" ] && ARGS+=(-p "$PUBLISH:8096")
for m in "${MEDIA[@]}"; do ARGS+=(-v "${m%%|*}:${m##*|}:ro"); done
for dv in ${DEVS[@]+"${DEVS[@]}"}; do ARGS+=(--device "$dv"); done
d run "${ARGS[@]}" ${GA[@]+"${GA[@]}"} "$DIGEST" >/dev/null
for n in ${NETS[@]+"${NETS[@]:1}"}; do d network connect "$n" "$NAME"; done
echo "Started $NAME. Waiting for it to answer …"

INFO=''
for _ in $(seq 1 60); do
  INFO=$(d run --rm --network "container:$NAME" "$HELPER" wget -qO- http://127.0.0.1:8096/System/Info/Public 2>/dev/null || true)
  [ -n "$INFO" ] && break
  sleep 2
done
[ -n "$INFO" ] || { d logs --tail 50 "$NAME"; die "no answer within 2 minutes (log above)"; }
echo "Answers: $(head -c 300 <<< "$INFO")"
LS=$(d exec "$NAME" ls /data/data 2>/dev/null || true)
if [[ "$LS" == *pre-ferrofin* ]]; then
  echo "Backup of the copied database: present (jellyfin.db.pre-ferrofin)."
else
  echo "NOTE: no jellyfin.db.pre-ferrofin found; check the log: $DOCKER logs $NAME"
fi

ADDR="http://$NAME:8096"
if [ ${#ATTACH[@]} -eq 0 ] && [ -n "$PUBLISH" ]; then ADDR="http://<this host>:${PUBLISH##*:} (e.g. http://192.0.2.10:${PUBLISH##*:})"; fi
cat <<EOF

Next:
  1. Turn off the NFO saver: the media is mounted read-only, and Ferrofin's NFO saver would try to write .nfo files next
     to it. In Ferrofin's dashboard (the Jellyfin web UI, at /web/): Dashboard → Libraries → each library → Metadata
     savers → untick "Nfo". (Reaching /web/ needs --publish, or a browser on one of the networks above.)
  2. FriendFlix: Admin → Einstellungen → Medienserver → address $ADDR, save.
     Saving works = the API key carried over. If the key is refused, use "API-Schlüssel automatisch anlegen"
     with a Jellyfin admin's name and password. If the address is pinned in .env (JELLYFIN_URL), change it there and
     recreate backend + gateway instead.
  3. Test: sign-in, browse, play (direct + HDR), seek, subtitles, kids profile, resume, downloads, Live TV, a new file.
     HDR on an Intel GPU: bash probe.sh (next to this script) first.
  4. Going back: set the address back to your Jellyfin address (e.g. http://jellyfin:8096 or http://192.0.2.10:8096),
     then: bash $0 remove
Never let an auto-updater upgrade $NAME: it carries com.centurylinklabs.watchtower.enable=false; exclude it by name
in any other updater.
EOF
