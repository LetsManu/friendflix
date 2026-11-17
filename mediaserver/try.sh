#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Try FriendFlix's media server image (Ferrofin-based, mediaserver/README.md) next to Jellyfin, on a COPY of Jellyfin's
# config folder. Jellyfin's own folder is only read, never changed: Ferrofin converts its copy one-way (until Ferrofin 1.6.0),
# so it must never get Jellyfin's real folder, and Jellyfin must never get the copy.
#
#   bash try.sh [options]     set up and start the trial container (asks before the step that stops Jellyfin)
#   bash try.sh status        what is running
#   bash try.sh remove        disconnect and remove the trial container (only one this script created; the copy stays)
#
# Options (setup):
#   --attach-network <net>    also connect the container to this Docker network (repeatable). Use FriendFlix's backend/gateway
#                             network (e.g. friendflix_media) so FriendFlix reaches it as http://ferrofin:8096
#   --publish [<ip>:]<port>   publish port 8096 on the host. Without <ip> only on 127.0.0.1 (the trial holds copies of all
#                             Jellyfin accounts and keys); give the host's LAN address when FriendFlix reaches its media server
#                             by host IP:port (e.g. --publish 192.0.2.10:8097 -> http://192.0.2.10:8097)
#   --with-trickplay          also copy Jellyfin's data/trickplay (its size is shown either way)
#   --jellyfin <container>    the Jellyfin container (default: the one running container whose name contains "jellyfin")
#   --name <name>             name of the trial container (default ferrofin; [a-z0-9][a-z0-9_.-]*)
# Env:
#   IMAGE=<image>             default ghcr.io/letsmanu/friendflix-mediaserver:nightly (printed, then pinned to its digest)
#   DOCKER=/path/to/docker    when `docker` is not on PATH (some NAS systems). DOCKER_HOST is honoured: every check on the
#                             host (folders, GPU, groups, inotify) runs in a helper container on the Docker engine's side.
#
# Run it as root or as a user in the docker group. It prints the engine it talks to (and its DockerRootDir) before anything else.
# What it does: reads Jellyfin's folders, devices and networks from Docker; checks the copy target, the mount paths and that
# the container user (uid 1000) can list, read and watch the media; only then asks, stops Jellyfin for the copy and starts it
# again; starts the trial container with the copy at /ferrofin-data, the SAME media folders read-only at the same paths, no
# Docker socket, no capabilities, and a label that tells Watchtower-style auto-updaters to leave it alone (a newer image would
# upgrade the one-way database by itself).
set -euo pipefail

DEFAULT_IMAGE="ghcr.io/letsmanu/friendflix-mediaserver:nightly"
# the release our image is built on (mediaserver/Dockerfile); CI checks that this line matches the Dockerfile
UPSTREAM_IMAGE="ghcr.io/mangoleaf/ferrofin:v1.5.1@sha256:5980a3c29c0bab564793f4fcf786e737b91a9eba26e9fb1d6f1c203ccb56580a"
# helper for copies and checks, pinned like scripts/backup-bootstrap.sh (busybox: ls, cp, du, find, inotifyd, wget, stat)
HELPER="alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"
UID_IN_IMAGE=1000 # the image's user `ferrofin`
# Ferrofin's data folder in the trial (FERROFIN_DATA_DIR): not the image's /data, which media libraries often use
DATA_DIR=/ferrofin-data
# the label that marks a container as created by this script; `remove` touches nothing else
TRIAL_LABEL=friendflix.trial
TRIAL_VALUE=ferrofin

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
[[ "$NAME" =~ ^[a-z0-9][a-z0-9_.-]*$ ]] || die "--name: use lower-case letters, digits, '_', '.', '-' (starting with a letter or digit)"
if [ -n "$PUBLISH" ]; then
  [[ "$PUBLISH" =~ ^([0-9]{1,3}(\.[0-9]{1,3}){3}:)?[0-9]{1,5}$ ]] || die "--publish: use <port> or <ipv4>:<port>"
  [[ "$PUBLISH" == *:* ]] || PUBLISH="127.0.0.1:$PUBLISH"
fi

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

# a throw-away helper container on the engine's side (no network): host paths are the Docker host's, not this shell's
h() { d run --rm --network none "$@"; }
exists() { d container inspect "$NAME" >/dev/null 2>&1; }
is_trial() { [ "$(d inspect -f "{{index .Config.Labels \"$TRIAL_LABEL\"}}" "$NAME" 2>/dev/null)" = "$TRIAL_VALUE" ]; }
find_jellyfin() {
  [ -n "$JF" ] && { echo "$JF"; return; }
  d ps --format '{{.Names}}' | grep -i jellyfin | grep -Fvix "$NAME" || true
}
# shellcheck disable=SC2016 # Go template, not shell
networks_of() { d inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$1" | grep -v '^$' || true; }
data_of() { d inspect -f "{{range .Mounts}}{{if eq .Destination \"$DATA_DIR\"}}{{if .Name}}volume {{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}" "$NAME"; }

case "$CMD" in
  status)
    if ! exists; then
      echo "Trial: no container named $NAME"
    elif ! is_trial; then
      echo "Container $NAME exists but was not created by this script (no label $TRIAL_LABEL=$TRIAL_VALUE)."
    else
      d inspect -f "Trial: {{.Name}} {{.State.Status}} since {{.State.StartedAt}}, image {{.Config.Image}}" "$NAME"
      echo "  networks: $(networks_of "$NAME" | tr '\n' ' ')"
      echo "  data: $(data_of)"
    fi
    while IFS= read -r j; do [ -n "$j" ] && d ps -a --filter "name=^${j}$" --format 'Jellyfin: {{.Names}} {{.Status}}'; done <<< "$(find_jellyfin)"
    exit 0 ;;
  remove)
    exists || { echo "No container named $NAME."; exit 0; }
    is_trial || die "container $NAME was not created by this script (no label $TRIAL_LABEL=$TRIAL_VALUE); not touching it"
    data=$(data_of)
    while IFS= read -r n; do [ -n "$n" ] && d network disconnect "$n" "$NAME" >/dev/null 2>&1 && echo "disconnected from $n"; done <<< "$(networks_of "$NAME")"
    # -v: also the anonymous volume of the image's VOLUME /data (never named volumes or bind-mounted folders)
    d rm -f -v "$NAME" >/dev/null
    echo "Container $NAME removed. The copy is kept ($data); delete it by hand when you are done."
    echo "FriendFlix: set Admin → Einstellungen → Medienserver back to your Jellyfin address (e.g. http://jellyfin:8096 or http://192.0.2.10:8096)."
    exit 0 ;;
esac

# ============================================================ setup (nothing changes before the question further down)
exists && die "a container named $NAME already exists (bash $0 status; --name <other>)"

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
while [ "${#CONFIG_SRC}" -gt 1 ] && [ "${CONFIG_SRC%/}" != "$CONFIG_SRC" ]; do CONFIG_SRC=${CONFIG_SRC%/}; done
SRC_MOUNT=$CONFIG_SRC
[ "$CONFIG_TYPE" = volume ] && SRC_MOUNT=$(mnt Name)
echo "Jellyfin config: $SRC_MOUNT ($CONFIG_TYPE)"

# every other mount except config, cache, transcodes, the Docker socket and devices: passed through read-only at the same path
mapfile -t MEDIA < <(d inspect -f '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' "$J" \
  | grep -v '^$' | grep -vE '\|/(config|cache)(/|$)|\|/transcodes?(/|$)|docker\.sock|\|/dev(/|$)' || true)
[ ${#MEDIA[@]} -gt 0 ] || die "Jellyfin has no media mount besides /config and /cache"
echo "Mounts passed through read-only, at the same paths so the library paths match:"
for m in "${MEDIA[@]}"; do echo "  ${m%%|*} -> ${m##*|}"; done
# none of them may land on or around the trial's data folder (checked now, before anything changes)
for m in "${MEDIA[@]}"; do
  dest=${m##*|}
  case "$dest/" in "$DATA_DIR/"*) die "Jellyfin mounts ${m%%|*} at $dest, which collides with the trial's data folder $DATA_DIR" ;; esac
  case "$DATA_DIR/" in "${dest%/}/"*) die "Jellyfin mounts ${m%%|*} at $dest, which would contain the trial's data folder $DATA_DIR" ;; esac
done

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
case "$PUBLISH" in 127.0.0.1:*) echo "NOTE: published on 127.0.0.1 only; containers and other machines cannot reach it there." ;; esac

# --- helper image (pinned), needed for every check on the Docker host from here on ---
pull() { d pull -q "$1" >/dev/null 2>&1; }
pull "$HELPER" || d image inspect "$HELPER" >/dev/null 2>&1 || die "cannot pull the helper image $HELPER"

# --- GPU: Jellyfin's devices and groups; /dev/dri with its render group when Jellyfin passes none (e.g. a privileged one) ---
mapfile -t DEVS < <(d inspect -f '{{range .HostConfig.Devices}}{{.PathOnHost}}:{{.PathInContainer}}{{"\n"}}{{end}}' "$J" | grep -v '^$' || true)
mapfile -t GROUPS_ADD < <(d inspect -f '{{range .HostConfig.GroupAdd}}{{.}}{{"\n"}}{{end}}' "$J" | grep -v '^$' || true)
# --mount (not -v): fails instead of creating /dev/dri on a host that has none
RENDER_GID=$(h --mount type=bind,source=/dev/dri,target=/dri,readonly "$HELPER" sh -c '[ -c /dri/renderD128 ] && stat -c %g /dri/renderD128' 2>/dev/null || true)
if [ ${#DEVS[@]} -eq 0 ] && [ -n "$RENDER_GID" ]; then DEVS=(/dev/dri:/dev/dri); fi
if [ -n "$RENDER_GID" ]; then [[ " ${GROUPS_ADD[*]:-} " == *" $RENDER_GID "* ]] || GROUPS_ADD+=("$RENDER_GID"); fi
for i in ${GROUPS_ADD[@]+"${!GROUPS_ADD[@]}"}; do # names resolve in the image's /etc/group, not the host's: use the host's number
  g=${GROUPS_ADD[$i]}
  if ! [[ "$g" =~ ^[0-9]+$ ]]; then
    # shellcheck disable=SC2016 # expanded by awk / the helper's sh
    gid=$(h --mount type=bind,source=/etc/group,target=/hostgroup,readonly "$HELPER" awk -F: -v g="$g" '$1 == g { print $3 }' /hostgroup 2>/dev/null || true)
    if [ -n "$gid" ]; then GROUPS_ADD[i]=$gid; else echo "WARNING: group '$g' has no number on the Docker host; passed by name"; fi
  fi
done
[ ${#DEVS[@]} -gt 0 ] && echo "GPU devices: ${DEVS[*]}${GROUPS_ADD[*]:+ (groups ${GROUPS_ADD[*]})}"
GA=()
for g in ${GROUPS_ADD[@]+"${GROUPS_ADD[@]}"}; do GA+=(--group-add "$g"); done

# --- image: IMAGE= or the default, printed, then pinned to its digest ---
IMAGE=${IMAGE:-$DEFAULT_IMAGE}
if ! pull "$IMAGE" && ! d image inspect "$IMAGE" >/dev/null 2>&1; then
  [ "$IMAGE" = "$DEFAULT_IMAGE" ] && echo "If FriendFlix's image is not published yet: IMAGE=$UPSTREAM_IMAGE (upstream Ferrofin, no HDR tone mapping on Intel GPUs)." >&2
  die "cannot pull $IMAGE (and it is not a local image)"
fi
DIGEST=$(d image inspect --format '{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || true)
# a local build (no registry digest) is pinned by its image id
[ -n "$DIGEST" ] || DIGEST=$(d image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)
[ -n "$DIGEST" ] || die "could not read the digest of $IMAGE"
if [ "$IMAGE" = "$DEFAULT_IMAGE" ]; then SRC_NOTE="the default; IMAGE=<image> to override"; else SRC_NOTE="from IMAGE="; fi
echo "Image: $IMAGE ($SRC_NOTE), pinned as $DIGEST"

# --- the copy target: new, on the Docker host, and never Jellyfin's real folder ---
if [ "$CONFIG_TYPE" = bind ]; then
  PARENT=$(dirname "$CONFIG_SRC")
  DST="${PARENT%/}/${NAME}-config"
  [ "$DST" != "$CONFIG_SRC" ] || die "the copy target $DST is Jellyfin's own config folder"
  case "$DST/" in "$CONFIG_SRC/"*) die "the copy target $DST is inside Jellyfin's config folder" ;; esac
  case "$CONFIG_SRC/" in "$DST/"*) die "the copy target $DST contains Jellyfin's config folder" ;; esac
  # checked by the engine's side, as root: also right with DOCKER_HOST, and for folders this shell's user cannot search
  # shellcheck disable=SC2016 # expanded by awk / the helper's sh
  h --mount "type=bind,source=$PARENT,target=/p,readonly" "$HELPER" sh -c '[ ! -e "/p/$1" ] && [ ! -L "/p/$1" ]' sh "${NAME}-config" \
    || die "$DST already exists on the Docker host (an earlier trial's copy?); move it away or delete it first"
else
  DST="${NAME}-config"
  [ "$DST" != "$SRC_MOUNT" ] || die "the copy target $DST is Jellyfin's own config volume"
  d volume inspect "$DST" >/dev/null 2>&1 && die "volume $DST already exists (an earlier trial's copy?); remove it first"
fi
echo "The copy will be: $DST (mounted at $DATA_DIR in the trial)"

# --- Jellyfin's layout and what will be copied ---
h -v "$SRC_MOUNT":/src:ro "$HELPER" sh -c 'test -f /src/data/jellyfin.db && test -d /src/root/default && test -d /src/config' \
  || die "unexpected layout under Jellyfin's /config (need data/jellyfin.db, root/default, config/); found: $(h -v "$SRC_MOUNT":/src:ro "$HELPER" ls /src | tr '\n' ' ')"
# shellcheck disable=SC2016 # expanded by the helper's sh
SIZE=$(h -v "$SRC_MOUNT":/src:ro "$HELPER" sh -c \
  'for p in data root/default metadata config; do if [ -e "/src/$p" ]; then printf "%s %s, " "$p" "$(du -sh "/src/$p" | cut -f1)"; fi; done' || true)
TP_SIZE=$(h -v "$SRC_MOUNT":/src:ro "$HELPER" sh -c '[ -d /src/data/trickplay ] && du -sh /src/data/trickplay | cut -f1 || echo none' || echo '?')
echo "Jellyfin's folders: ${SIZE%, } (data/ includes trickplay)"
if [ "$TRICKPLAY" = 1 ]; then
  echo "Trickplay (data/trickplay): $TP_SIZE, copied (--with-trickplay)"
else
  echo "Trickplay (data/trickplay): $TP_SIZE, not copied (add --with-trickplay to copy it; otherwise the trial regenerates it)"
fi

# --- can the image's user list, read and watch the media? ---
echo
echo "Media check as uid $UID_IN_IMAGE${GROUPS_ADD[*]:+ with groups ${GROUPS_ADD[*]}}:"
WATCHES=$(h "$HELPER" cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo '?')
for m in "${MEDIA[@]}"; do
  # shellcheck disable=SC2016 # expanded by the helper's sh
  r=$(h --user "$UID_IN_IMAGE:$UID_IN_IMAGE" ${GA[@]+"${GA[@]}"} -v "${m%%|*}":/m:ro "$HELPER" sh -c '
    [ -d /m ] || { echo "kind=file"; exit 0; }
    ls /m >/dev/null 2>&1 || { echo "list=FAIL"; exit 0; }; echo "list=ok"
    f=$(find /m -type f -size +0 2>/dev/null | head -n 1)
    if [ -z "$f" ]; then echo "read=nofile"; elif head -c 65536 "$f" >/dev/null 2>&1; then echo "read=ok"; else echo "read=FAIL ${f#/m/}"; fi
    s=$(find /m -mindepth 1 -maxdepth 2 -type d 2>/dev/null | head -n 1); s=${s:-/m}
    command -v inotifyd >/dev/null 2>&1 || { echo "watch=untested"; exit 0; }
    inotifyd - "$s" >/dev/null 2>/tmp/w & p=$!; sleep 1
    if kill -0 "$p" 2>/dev/null; then kill "$p"; echo "watch=ok"; else echo "watch=FAIL $(head -c 120 /tmp/w)"; fi' 2>&1 || echo "list=FAIL")
  src=${m%%|*}
  case "$r" in
    *kind=file*) echo "  $src: a file, not a media folder (passed through, not checked)"; continue ;;
    *list=ok*) echo "  $src: can list" ;;
    *) echo "  WARNING $src: uid $UID_IN_IMAGE cannot list it; the trial will not see those files." ; continue ;;
  esac
  case "$r" in
    *read=ok*) echo "  $src: can read a file" ;;
    *read=nofile*) echo "  $src: no file found to test reading" ;;
    *) echo "  WARNING $src: cannot read a file (${r##*read=FAIL }): playback of such files will fail. Check owner/mode (uid $UID_IN_IMAGE)." ;;
  esac
  case "$r" in
    *watch=ok*) echo "  $src: can watch a subfolder (inotify)" ;;
    *watch=untested*) echo "  $src: inotify not tested (the helper image has no inotifyd)" ;;
    *) echo "  WARNING $src: cannot watch a subfolder (inotify): new files appear only after a library scan."
       echo "          max_user_watches on the Docker host: $WATCHES (raise fs.inotify.max_user_watches; network shares never notify)" ;;
  esac
done

echo
ask "Stop Jellyfin ($J) for the copy (seconds to minutes, depending on the metadata size), then start it again?" || die "stopped by you, nothing changed"

[ "$CONFIG_TYPE" = volume ] && d volume create "$DST" >/dev/null
# the restart trap is armed before the stop: whatever fails from here on (also Ctrl-C), Jellyfin is started again
trap 'd start "$J" >/dev/null 2>&1 || true' EXIT
d stop "$J" >/dev/null || die "could not stop $J (it is started again)"
# shellcheck disable=SC2016 # expanded by the helper's sh
h -e TRICKPLAY="$TRICKPLAY" -e OWNER="$UID_IN_IMAGE:$UID_IN_IMAGE" -v "$SRC_MOUNT":/src:ro -v "$DST":/dst "$HELPER" sh -c '
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
      --label com.centurylinklabs.watchtower.enable=false --label "$TRIAL_LABEL=$TRIAL_VALUE"
      -e "FERROFIN_DATA_DIR=$DATA_DIR" -v "$DST:$DATA_DIR")
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
LS=$(d exec "$NAME" ls "$DATA_DIR/data" 2>/dev/null || true)
if [[ "$LS" == *pre-ferrofin* ]]; then
  echo "Backup of the copied database: present (jellyfin.db.pre-ferrofin)."
else
  echo "NOTE: no jellyfin.db.pre-ferrofin found; check the log: $DOCKER logs $NAME"
fi

ADDR="http://$NAME:8096"
if [ ${#ATTACH[@]} -eq 0 ] && [ -n "$PUBLISH" ]; then ADDR="http://${PUBLISH%:*}:${PUBLISH##*:}"; fi
cat <<EOF

Next:
  1. Turn off the NFO saver: the media is mounted read-only, and Ferrofin's NFO saver would try to write .nfo files next
     to it. The image has no web client (so no dashboard), so use the API, once per library: GET /Library/VirtualFolders
     lists the libraries (ItemId, LibraryOptions); POST /Library/VirtualFolders/LibraryOptions with the body
     {"Id": "<ItemId>", "LibraryOptions": <that library's options with "SaveLocalMetadata": false and "MetadataSavers": []>}
     and the header X-Emby-Token: <an administrator's API key, they came along with the copy>. Reaching the API needs --publish,
     or a container on one of the networks above.
  2. FriendFlix: Admin → Einstellungen → Medienserver → address $ADDR, save.
     Saving works = the API key carried over. If the key is refused, use "API-Schlüssel automatisch anlegen"
     with a Jellyfin admin's name and password. If the address is pinned in .env (JELLYFIN_URL), change it there and
     recreate backend + gateway instead.
  3. Test: sign-in, browse, play (direct + HDR), seek, subtitles, kids profile, resume, downloads, Live TV, a new file.
     HDR on an Intel GPU is untested until bash probe.sh (next to this script) passes on this host.
  4. Going back: set the address back to your Jellyfin address (e.g. http://jellyfin:8096 or http://192.0.2.10:8096),
     then: bash $0 remove
Never let an auto-updater upgrade $NAME: it carries com.centurylinklabs.watchtower.enable=false; exclude it by name
in any other updater.
EOF
