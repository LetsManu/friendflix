#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Rebuilds one FriendFlix image from git, bit for bit, and prints its image manifest digest. With --compare it checks the
# result against a published image (ghcr.io/…:tag or …@sha256:…). Used by the CI job `reproducible` and by anyone who
# wants to check a release: docs/reproducible-builds.md.
#
#   scripts/reproduce-image.sh SERVICE [--ref REF] [--compare IMAGE] [--out FILE]
#   scripts/reproduce-image.sh --diff A.oci.tar B.oci.tar   (explains a mismatch: config + per-layer file listings)
#   scripts/reproduce-image.sh --buildkit-image [--ref REF]  (prints the BuildKit image pinned at REF and exits)
#     SERVICE    backend | gateway | web | updater
#     --ref      commit / tag to build (default HEAD; with --compare the image's revision label, i.e. its image commit).
#                The build context is `git archive REF`, so local changes, untracked files, file mtimes and the umask
#                of your checkout cannot leak into the image.
#     --compare  published image to compare with. Its labels and the build-arg ENVs (FF_IMAGE_COMMIT, APP_VERSION,
#                APP_CODENAME; GIT_SHA, BUILD_TIME on images from before FF_IMAGE_COMMIT) are copied into the rebuild:
#                they are metadata the release pipeline added; everything else (layers, rest of the config) must come
#                out identical. SOURCE_DATE_EPOCH = the commit time of the image's FF_IMAGE_COMMIT (else GIT_SHA).
#                Exit 1 on a digest mismatch.
#     --out      where to write the OCI tarball (default: a temp file, deleted at the end)
#   Without --compare the image is built for its image commit, as CI builds it: FF_IMAGE_COMMIT = what REF's own
#   scripts/changed-images.mjs answers to `image-commit SERVICE --ref REF` (REF itself when REF has no such script),
#   SOURCE_DATE_EPOCH = that commit's time. A REF whose Dockerfile still takes GIT_SHA (from before FF_IMAGE_COMMIT) is
#   built as CI built it then: GIT_SHA = REF, BUILD_TIME and SOURCE_DATE_EPOCH = REF's commit time. Only the build
#   arguments the Dockerfile at REF declares are passed.
#
# Needs: git with full history (an image commit is found in it), jq, docker with buildx, node (for REF's
# scripts/changed-images.mjs). Builds in a fresh, throw-away docker-container builder running the BuildKit image
# pinned at REF: the `default:` of input `buildkit-image` in .github/actions/build-image/action.yml (older refs: the
# BUILDKIT_IMAGE line of .github/workflows/ci.yml), with --no-cache, rewrite-timestamp=true and without SBOM/provenance
# (those attestations carry build times; they are separate manifests and never part of the compared image manifest).
# BUILDER=<name> uses an existing builder instead (it must run the same BuildKit version, or the result may
# legitimately differ).
set -euo pipefail

usage() { awk 'NR >= 5 && /^#/ { sub(/^# ?/, ""); print } /^set -euo/ { exit }' "$0" >&2; exit 2; }
log() { echo "reproduce-image: $*" >&2; }

# --diff: which part of two OCI tarballs (from --out) differs - config, and for each differing layer the file listing
# (mode, owner, size, mtime, name), which is where non-determinism shows up
if [ "${1:-}" = --diff ]; then
  [ $# -eq 3 ] || usage
  A=$2 B=$3
  blob() { tar -xOf "$1" "blobs/${2%%:*}/${2#*:}"; }
  manifest() { local d; d=$(tar -xOf "$1" index.json | jq -r '.manifests[0].digest'); blob "$1" "$d"; }
  ma=$(manifest "$A"); mb=$(manifest "$B")
  ca=$(blob "$A" "$(jq -r .config.digest <<< "$ma")"); cb=$(blob "$B" "$(jq -r .config.digest <<< "$mb")")
  echo "== config (A vs B)"; diff <(jq -S . <<< "$ca") <(jq -S . <<< "$cb") || true
  n=$(jq '.layers | length' <<< "$ma")
  for i in $(seq 0 $((n - 1))); do
    la=$(jq -r ".layers[$i].digest" <<< "$ma"); lb=$(jq -r ".layers[$i].digest // empty" <<< "$mb")
    [ "$la" = "$lb" ] && continue
    echo "== layer $i differs: $la vs ${lb:-<missing>} ($(jq -r ".history | map(select(.empty_layer != true))[$i].created_by // \"?\"" <<< "$ca"))"
    [ -n "$lb" ] || continue
    diff <(blob "$A" "$la" | tar -tvzf - --full-time | sort -k6) <(blob "$B" "$lb" | tar -tvzf - --full-time | sort -k6) | head -n 60 || true
  done
  exit 0
fi
# the BuildKit image pinned at a commit: the build action's `buildkit-image` default, else (refs before the action existed)
# the BUILDKIT_IMAGE line of ci.yml
buildkit_pin() {
  local root sha pin
  root=$(git rev-parse --show-toplevel); sha=$1
  pin=$(git -C "$root" show "$sha:.github/actions/build-image/action.yml" 2>/dev/null \
    | awk '/^  buildkit-image:/ { f = 1; next } f && /^  [^ ]/ { exit } f && /^    default:/ { print $2; exit }' || true)
  [ -n "$pin" ] || pin=$(git -C "$root" show "$sha:.github/workflows/ci.yml" 2>/dev/null \
    | sed -n 's/^ *BUILDKIT_IMAGE: *\([^ #]*\).*/\1/p' | head -n1 || true)
  [ -n "$pin" ] || { log "BuildKit pin not found at $sha (.github/actions/build-image/action.yml buildkit-image, .github/workflows/ci.yml BUILDKIT_IMAGE)"; return 1; }
  echo "$pin"
}
if [ "${1:-}" = --buildkit-image ]; then
  REF=HEAD
  case "$#:${2:-}" in
    1:) ;;
    3:--ref) REF=$3 ;;
    *) usage ;;
  esac
  SHA=$(git rev-parse --verify -q "$REF^{commit}") || { log "unknown ref $REF"; exit 1; }
  buildkit_pin "$SHA"
  exit
fi
SERVICE="${1:-}"; [ -n "$SERVICE" ] || usage; shift
case "$SERVICE" in
  backend|gateway|web|updater) ;;
  # exempt on purpose: its runtime stage installs jellyfin-ffmpeg7 with apt from the live Jellyfin repository (no snapshot
  # archive, only current versions), so a rebuild is not promised to be bit for bit. docs/livetv.md, docs/reproducible-builds.md
  livetv) log "livetv is exempt from the reproducible-build check (apt packages from the Jellyfin repository), see docs/livetv.md"; exit 2 ;;
  # exempt as well: the trial image on top of the third-party Ferrofin release (docs/reproducible-builds.md, mediaserver/README.md)
  mediaserver) log "mediaserver is exempt from the reproducible-build check (third-party base image), see docs/reproducible-builds.md"; exit 2 ;;
  *) usage ;;
esac
REF='' COMPARE='' OUT=''
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --compare) COMPARE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) usage ;;
  esac
done

ROOT=$(git rev-parse --show-toplevel)
commit_time() { git -C "$ROOT" log -1 --format=%ct "$1"; }
iso_time() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
LABELS=()
EXPECTED=

# --compare: the published image's linux/amd64 manifest digest, its config (labels, ENV) and its revision (= the commit to build)
if [ -n "$COMPARE" ]; then
  raw=$(docker buildx imagetools inspect --raw "$COMPARE")
  case "$(jq -r '.mediaType // empty' <<< "$raw")" in
    application/vnd.oci.image.index.v1+json|application/vnd.docker.distribution.manifest.list.v2+json)
      EXPECTED=$(jq -er '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest' <<< "$raw") ;;
    *)
      EXPECTED=$(docker buildx imagetools inspect "$COMPARE" --format '{{.Manifest.Digest}}') ;;
  esac
  cfg=$(docker buildx imagetools inspect "$COMPARE" --format '{{json .Image}}')
  jq -e 'has("rootfs")' <<< "$cfg" >/dev/null || cfg=$(jq -e '."linux/amd64"' <<< "$cfg")
  envval() { jq -r --arg k "$1" '(.config.Env // [])[] | select(startswith($k + "=")) | sub("^[^=]*="; "")' <<< "$cfg"; }
  if [ -z "$REF" ]; then
    REF=$(jq -r '.config.Labels["org.opencontainers.image.revision"] // empty' <<< "$cfg")
    [ -n "$REF" ] || { log "$COMPARE has no org.opencontainers.image.revision label: pass --ref"; exit 1; }
  fi
  while IFS= read -r l; do [ -n "$l" ] && LABELS+=(--label "$l"); done < <(jq -r '(.config.Labels // {}) | to_entries[] | "\(.key)=\(.value)"' <<< "$cfg")
  log "comparing with $COMPARE -> linux/amd64 manifest $EXPECTED"
fi
[ -n "$REF" ] || REF=HEAD
SHA=$(git -C "$ROOT" rev-parse --verify -q "$REF^{commit}") || { log "unknown commit $REF (a shallow clone lacks older commits: git fetch --unshallow)"; exit 1; }
WORK=$(mktemp -d)
BUILDER_CREATED=
cleanup() {
  if [ -n "$BUILDER_CREATED" ]; then docker buildx rm "$BUILDER_CREATED" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# build context = the committed tree only; git archive stamps every entry with the commit time (= SOURCE_DATE_EPOCH)
umask 022
mkdir "$WORK/ctx"
git -C "$ROOT" -c tar.umask=0022 archive --format=tar "$SHA" | tar -x -C "$WORK/ctx"

DOCKERFILE="$WORK/ctx/$SERVICE/Dockerfile"
# the build arguments the Dockerfile at REF declares (`ARG NAME`, `ARG NAME=…`, `ARG A NAME`); only those are passed
declares() { grep -qE "^[[:space:]]*ARG[[:space:]]+(.*[[:space:]])?$1([=[:space:]]|\$)" "$DOCKERFILE"; }
BUILD_ARGS=()
arg() { BUILD_ARGS+=(--build-arg "$1=$2"); }
if [ -n "$COMPARE" ]; then
  # metadata of the published image, copied as it is; old images carry GIT_SHA (+ BUILD_TIME) instead of FF_IMAGE_COMMIT
  for name in FF_IMAGE_COMMIT GIT_SHA BUILD_TIME APP_VERSION APP_CODENAME; do
    if declares "$name"; then v=$(envval "$name"); arg "$name" "$v"; fi
  done
  BUILT_FROM=$(envval FF_IMAGE_COMMIT)
  if [ -n "$BUILT_FROM" ]; then
    [ "$BUILT_FROM" = "$SHA" ] || log "note: $COMPARE is image commit $BUILT_FROM; building the tree of $SHA (equal inputs give equal bytes)"
  else
    BUILT_FROM=$(envval GIT_SHA)
    [ "$BUILT_FROM" = "$SHA" ] || log "warning: $COMPARE was built from GIT_SHA=$BUILT_FROM, you are rebuilding $SHA (use --ref $BUILT_FROM)"
  fi
  git -C "$ROOT" rev-parse --verify -q "$BUILT_FROM^{commit}" >/dev/null \
    || { log "$COMPARE was built for commit '$BUILT_FROM', which this clone does not have (git fetch --unshallow)"; exit 1; }
  SOURCE_DATE_EPOCH=$(commit_time "$BUILT_FROM")
elif declares FF_IMAGE_COMMIT; then
  # as CI builds it: for the image commit (REF's own change map and script decide it) and that commit's time
  if [ -f "$WORK/ctx/scripts/changed-images.mjs" ]; then
    command -v node >/dev/null || { log "node is needed to find the image commit (REF's scripts/changed-images.mjs)"; exit 1; }
    [ "$(git -C "$ROOT" rev-parse --is-shallow-repository)" = false ] || { log "a shallow clone cannot find the image commit: git fetch --unshallow"; exit 1; }
    # REF's script on REF's tree, against this clone's history (its git calls run in the archive, which has no .git)
    ic=$(GIT_DIR=$(git -C "$ROOT" rev-parse --absolute-git-dir) node "$WORK/ctx/scripts/changed-images.mjs" image-commit "$SERVICE" --ref "$SHA") \
      || { log "image-commit $SERVICE failed at $SHA"; exit 1; }
    [[ "$ic" =~ ^([0-9a-f]{40})\ ([0-9]+)$ ]] || { log "image-commit $SERVICE printed '$ic', not '<sha> <epoch>'"; exit 1; }
    arg FF_IMAGE_COMMIT "${BASH_REMATCH[1]}"; SOURCE_DATE_EPOCH=${BASH_REMATCH[2]}
  else
    arg FF_IMAGE_COMMIT "$SHA"; SOURCE_DATE_EPOCH=$(commit_time "$SHA")
  fi
else
  # a REF from before FF_IMAGE_COMMIT: CI built it for the run commit, BUILD_TIME and SOURCE_DATE_EPOCH = its time
  SOURCE_DATE_EPOCH=$(commit_time "$SHA")
  if declares GIT_SHA; then arg GIT_SHA "$SHA"; fi
  if declares BUILD_TIME; then v=$(iso_time "$SOURCE_DATE_EPOCH"); arg BUILD_TIME "$v"; fi
fi
if [ -z "$COMPARE" ]; then
  if declares APP_VERSION; then v=$(jq -er .version "$WORK/ctx/version.json"); arg APP_VERSION "$v"; fi
  if declares APP_CODENAME; then v=$(jq -er .codename "$WORK/ctx/version.json"); arg APP_CODENAME "$v"; fi
fi
export SOURCE_DATE_EPOCH
BUILD_ARGS=(--build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH" ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"})

BUILDER_ARGS=()
if [ -n "${BUILDER:-}" ]; then
  BUILDER_ARGS=(--builder "$BUILDER")
else
  BK_IMAGE=$(buildkit_pin "$SHA")
  BUILDER_CREATED="ff-repro-$$-$RANDOM"
  docker buildx create --name "$BUILDER_CREATED" --driver docker-container --driver-opt "image=$BK_IMAGE" >/dev/null
  BUILDER_ARGS=(--builder "$BUILDER_CREATED")
  log "fresh builder $BUILDER_CREATED ($BK_IMAGE)"
fi

[ -n "$OUT" ] || OUT="$WORK/image.oci.tar"
log "building $SERVICE at $SHA ($(printf '%s\n' "${BUILD_ARGS[@]}" | grep -vx -- --build-arg | paste -sd ' ' -))"
docker buildx build "${BUILDER_ARGS[@]}" \
  --no-cache --pull --platform linux/amd64 \
  --provenance=false --sbom=false \
  "${BUILD_ARGS[@]}" \
  ${LABELS[@]+"${LABELS[@]}"} \
  --file "$DOCKERFILE" \
  --output "type=oci,dest=$OUT,oci-mediatypes=true,compression=gzip,rewrite-timestamp=true" \
  "$WORK/ctx" >&2

blob() { tar -xOf "$OUT" "blobs/${1%%:*}/${1#*:}"; }
# index.json -> the image manifest (descend through a nested index, should the exporter write one)
desc=$(tar -xOf "$OUT" index.json | jq -ec '.manifests[0]')
while [ "$(jq -r .mediaType <<< "$desc")" = application/vnd.oci.image.index.v1+json ]; do
  desc=$(blob "$(jq -r .digest <<< "$desc")" | jq -ec '[.manifests[] | select(.platform.architecture == "amd64")][0]')
done
DIGEST=$(jq -er .digest <<< "$desc")
echo "$DIGEST"

if [ -n "$EXPECTED" ]; then
  if [ "$DIGEST" = "$EXPECTED" ]; then
    log "OK: rebuilt $SERVICE is identical to $COMPARE ($DIGEST)"
  else
    log "MISMATCH: rebuilt $DIGEST, published $EXPECTED"
    mine=$(blob "$(blob "$DIGEST" | jq -r .config.digest)")
    diff <(jq -S '{config: .config, rootfs: .rootfs, created: .created}' <<< "$cfg") \
         <(jq -S '{config: .config, rootfs: .rootfs, created: .created}' <<< "$mine") >&2 || true
    exit 1
  fi
fi
