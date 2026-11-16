#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# Can a media server image tone-map HDR on this host's Intel GPU? (change 0001 in mediaserver/README.md)
# Touches nothing: only throw-away containers (--rm, no network) with the GPU passed in. Jellyfin, FriendFlix and their data
# are not used, stopped or read.
#
#   bash probe.sh                         the default image, ghcr.io/letsmanu/friendflix-mediaserver:nightly (printed)
#   IMAGE=<image> bash probe.sh           any other image, e.g. the upstream Ferrofin digest (UPSTREAM_IMAGE below), which
#                                         is expected to FAIL test 1
#   DOCKER=/path/to/docker bash probe.sh  when `docker` is not on PATH (some NAS systems). DOCKER_HOST is honoured: the GPU
#                                         is looked up on the Docker engine's host, inside a container
#   RENDER_NODE=/dev/dri/renderD129 …     another GPU (default /dev/dri/renderD128, a path on the Docker host)
#
# Run it as root or as a user in the docker group.
# Tests (inside the container, as the image's own user plus the render group, like the real server):
#   1 OpenCL on VA-API   ffmpeg -init_hw_device vaapi=va:<node> -init_hw_device opencl=ocl@va -f lavfi -i nullsrc …
#                        (the call that failed with "-1001 … No such device" on the upstream image)
#   2 QSV + OpenCL       a 2 s 10-bit HDR10 (PQ, BT.2020) clip made with ffmpeg's lavfi in the container, then Jellyfin's
#                        QSV chain: scale_qsv -> hwmap to OpenCL -> tonemap_opencl (bt2390) -> hwmap back -> h264_qsv;
#                        the result must have frames and must no longer be tagged PQ
#   3 VA-API + OpenCL    the same with Jellyfin's VA-API chain (information only; does not change the exit code)
#   4 VPP tone mapper    does the VA driver tone-map HDR itself (tonemap_vaapi on one P010 frame)? On GPUs whose iHD
#                        driver lacks FtrHDR it says "VAAPI driver doesn't support HDR": then VPP tone mapping cannot work
#                        and OpenCL (test 2) is the way (change 0002; information only)
# Exit 0 when tests 1 and 2 pass, 1 otherwise.
set -euo pipefail

DEFAULT_IMAGE="ghcr.io/letsmanu/friendflix-mediaserver:nightly"
# the release our image is built on (mediaserver/Dockerfile); CI checks that this line matches the Dockerfile
UPSTREAM_IMAGE="ghcr.io/mangoleaf/ferrofin:v1.5.1@sha256:5980a3c29c0bab564793f4fcf786e737b91a9eba26e9fb1d6f1c203ccb56580a"
RENDER_NODE="${RENDER_NODE:-/dev/dri/renderD128}"

die() { echo "ERROR: $*" >&2; exit 1; }

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
if ! info=$("$DOCKER" info --format 'engine {{.ServerVersion}}, DockerRootDir {{.DockerRootDir}}' 2>&1); then
  echo "$info" | tail -n 3 >&2
  die "cannot use the Docker engine as uid $(id -u) ($DOCKER${DOCKER_HOST:+, DOCKER_HOST=$DOCKER_HOST}). Run as root or as a user in the docker group."
fi
echo "Docker: $DOCKER, $info${DOCKER_HOST:+, DOCKER_HOST=$DOCKER_HOST}"

# --- the image: IMAGE= or the default, printed with its digest ---
pull() { "$DOCKER" pull -q "$1" >/dev/null 2>&1; }
IMAGE=${IMAGE:-$DEFAULT_IMAGE}
if ! pull "$IMAGE" && ! "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1; then
  [ "$IMAGE" = "$DEFAULT_IMAGE" ] && echo "If FriendFlix's image is not published yet, probe the upstream one to see the failure: IMAGE=$UPSTREAM_IMAGE" >&2
  die "cannot pull $IMAGE (and it is not a local image)"
fi
if [ "$IMAGE" = "$DEFAULT_IMAGE" ]; then note="the default; IMAGE=<image> to override"; else note="from IMAGE="; fi
echo "Image: $IMAGE ($note), $("$DOCKER" image inspect --format '{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || echo 'local image, no registry digest')"

# --- the GPU, looked up on the Docker host (in a container from the same image; --mount fails instead of creating a path) ---
[[ "$RENDER_NODE" =~ ^/dev/dri/renderD[0-9]+$ ]] || die "RENDER_NODE must look like /dev/dri/renderD128"
# shellcheck disable=SC2016 # expanded by the container's sh
RENDER_GID=$("$DOCKER" run --rm --network none --mount type=bind,source=/dev/dri,target=/dri,readonly --entrypoint /bin/sh "$IMAGE" \
  -c '[ -c "/dri/$1" ] && stat -c %g "/dri/$1"' probe "${RENDER_NODE##*/}" 2>/dev/null || true)
[ -n "$RENDER_GID" ] || die "$RENDER_NODE not found on the Docker host: no GPU render node there (set RENDER_NODE= for another one)"
echo "GPU: $RENDER_NODE (group id $RENDER_GID)"
echo

RUN=("$DOCKER" run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true
     --device /dev/dri --group-add "$RENDER_GID")

# --- test 1: the one-liner ---
rc1=0
out1=$("${RUN[@]}" --entrypoint /usr/local/bin/ffmpeg "$IMAGE" -hide_banner \
  -init_hw_device "vaapi=va:$RENDER_NODE" -init_hw_device opencl=ocl@va -f lavfi -i nullsrc -frames 1 -f null - 2>&1) || rc1=$?
if [ "$rc1" -eq 0 ]; then
  echo "PASS  1 OpenCL on VA-API"
else
  echo "FAIL  1 OpenCL on VA-API (exit $rc1):"
  tail -n 8 <<< "$out1" | sed 's/^/        /'
fi

# --- tests 2 and 3: HDR10 clip -> Jellyfin's tone-mapping chains, in one container ---
# shellcheck disable=SC2016 # expanded by the container's sh
INNER='
set -u
FF=/usr/local/bin/ffmpeg FP=/usr/local/bin/ffprobe DEV=$1
TM="tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=bt2390:peak=100:desat=0"
cd /tmp || exit 1
if $FF -hide_banner -loglevel error -init_hw_device "vaapi=va:$DEV,driver=iHD" -filter_hw_device va \
    -f lavfi -i "color=c=black:s=1280x720:r=1:d=1,format=p010le" \
    -vf "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,hwupload,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709" \
    -frames:v 1 -f null - > vpp.log 2>&1; then
  echo "RESULT vpp PASS the VA driver has an HDR tone mapper (VPP tone mapping can work)"
elif grep -qE "support HDR|query HDR caps" vpp.log; then
  echo "RESULT vpp FAIL the VA driver has no HDR tone mapper: use OpenCL tone mapping, not VPP (change 0002)"
else
  echo "RESULT vpp FAIL ffmpeg exit, see below"; tail -n 5 vpp.log
fi
if ! $FF -hide_banner -loglevel error -f lavfi -i testsrc2=size=1920x1080:rate=24:duration=2 \
    -vf "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc" \
    -c:v libx265 -preset ultrafast -x265-params log-level=error -pix_fmt yuv420p10le \
    -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -y hdr10.mkv > clip.log 2>&1; then
  echo "RESULT clip FAIL could not make the HDR10 test clip"; tail -n 5 clip.log; exit 0
fi
check() { # name, log, output file
  info=$($FP -v error -select_streams v:0 -count_packets \
    -show_entries stream=codec_name,pix_fmt,color_transfer,nb_read_packets -of default=nw=1:nk=0 "$3" 2>&1 | tr "\n" " ")
  case "$info" in
    *nb_read_packets=0*|"") echo "RESULT $1 FAIL no frames: $info" ;;
    *color_transfer=smpte2084*) echo "RESULT $1 FAIL still tagged PQ (no tone mapping): $info" ;;
    *) echo "RESULT $1 PASS $info" ;;
  esac
}
if $FF -hide_banner -loglevel error \
    -init_hw_device "vaapi=va:$DEV,driver=iHD" -init_hw_device qsv=qs@va -init_hw_device opencl=ocl@va -filter_hw_device qs \
    -hwaccel qsv -hwaccel_output_format qsv -i hdr10.mkv \
    -vf "scale_qsv=w=1280:h=720:format=p010,hwmap=derive_device=opencl:mode=read,$TM,hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv" \
    -c:v h264_qsv -preset veryfast -an -y sdr-qsv.mp4 > qsv.log 2>&1; then
  check qsv qsv.log sdr-qsv.mp4
else
  echo "RESULT qsv FAIL ffmpeg exit $?"; tail -n 8 qsv.log
fi
if $FF -hide_banner -loglevel error \
    -init_hw_device "vaapi=va:$DEV,driver=iHD" -init_hw_device opencl=ocl@va -filter_hw_device va \
    -hwaccel vaapi -hwaccel_output_format vaapi -i hdr10.mkv \
    -vf "scale_vaapi=w=1280:h=720:format=p010,hwmap=derive_device=opencl:mode=read,$TM,hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi" \
    -c:v h264_vaapi -an -y sdr-vaapi.mp4 > vaapi.log 2>&1; then
  check vaapi vaapi.log sdr-vaapi.mp4
else
  echo "RESULT vaapi FAIL ffmpeg exit $?"; tail -n 8 vaapi.log
fi
'
out2=$("${RUN[@]}" --entrypoint /bin/sh "$IMAGE" -c "$INNER" probe "$RENDER_NODE" 2>&1) || true
result() { # name(s) -> "PASS …" / "FAIL …" from the container's output (a failed test clip fails 2 and 3)
  local line
  line=$(grep -E "^RESULT ($1) " <<< "$out2" | tail -n 1 || true)
  if [ -n "$line" ]; then echo "${line#RESULT * }"; else echo "FAIL no result (container output below)"; fi
}
r2=$(result 'qsv|clip') r3=$(result 'vaapi|clip') r4=$(result vpp)
echo "${r2%% *}  2 QSV + OpenCL HDR tone map: ${r2#* }"
echo "${r3%% *}  3 VA-API + OpenCL HDR tone map (information only): ${r3#* }"
echo "${r4%% *}  4 VPP tone mapper of the VA driver (change 0002, information only): ${r4#* }"
if [ "${r2%% *}" != PASS ] || [ "${r3%% *}" != PASS ] || [ "${r4%% *}" != PASS ]; then
  grep -vE '^RESULT ' <<< "$out2" | tail -n 20 | sed 's/^/        /' || true
fi

echo
if [ "$rc1" -eq 0 ] && [ "${r2%% *}" = PASS ]; then
  echo "PASS: this image can tone-map HDR with OpenCL on $RENDER_NODE."
  exit 0
fi
echo "FAIL: no HDR tone mapping with OpenCL on $RENDER_NODE with $IMAGE (details above)."
exit 1
