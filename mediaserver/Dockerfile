# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# FriendFlix's own media server image (trial; mediaserver/README.md, docs/mediaserver.md). A "light fork": the pinned Ferrofin
# release image (GPL-3.0-only, https://github.com/mangoleaf/ferrofin) plus the numbered changes in mediaserver/patches/, each
# also offered upstream. No Rust build: every change so far is image-level. Bump: mediaserver/README.md "New Ferrofin release".
#
# 0001 Intel OpenCL runtime. Ferrofin's image (debian:trixie-slim + jellyfin-ffmpeg8) has the OpenCL ICD loader but no Intel
#      driver for it, so the HDR/Dolby Vision -> SDR tone mapping that Jellyfin runs on Intel GPUs (QSV/VA-API + OpenCL) fails
#      with "Failed to get number of OpenCL platforms: -1001". Installed the way the official Jellyfin image does it
#      (jellyfin/jellyfin-packaging, docker/Dockerfile, "Intel OpenCL Tone mapping dependencies", master as of 2026-11-16):
#      the GitHub release debs of intel/compute-runtime (NEO), intel/intel-graphics-compiler (IGC) and gmmlib, current
#      (Gen12+) and legacy (Gen11 and older) side by side, amd64 only. Same versions as Jellyfin; here every file is also
#      checked against a pinned sha256 (the compute-runtime ones match Intel's published ww35.sum files).
# 0003 HEALTHCHECK on Ferrofin's GET /health (the base image has none; the managed media server's update waits for "healthy").
# 0004 No web client: the bundled jellyfin-web goes and FERROFIN_WEB_DIR names a directory that does not exist, so the server
#      serves the API only (FriendFlix is the only client; no dashboard at all).
# 0005 /data and /cache writable for any non-root container user (Docker copies their mode onto fresh named volumes).

# --- 0001: the Intel debs, downloaded by BuildKit and checked (a changed file fails the build); only mounted, never in a layer
ARG GMMLIB_VER=22.10.0
# >= Gen12 graphics (current)
ARG IGC2_VER=2.41.5
ARG IGC2_BUILD=22716
ARG NEO_VER=26.35.39758.10
# <= Gen11 graphics (legacy)
ARG IGC1_LEGACY_VER=1.0.17537.24
ARG NEO_LEGACY_VER=24.35.30872.36

FROM scratch AS intel-opencl-amd64
ARG GMMLIB_VER IGC2_VER IGC2_BUILD NEO_VER IGC1_LEGACY_VER NEO_LEGACY_VER
ADD --checksum=sha256:6031a63d6e8a12ce61c14efc15f2c8e727061286e3820b8594e6d00615e04d54 \
  https://github.com/intel/compute-runtime/releases/download/${NEO_VER}/libigdgmm12_${GMMLIB_VER}_amd64.deb /
ADD --checksum=sha256:0a6e64a663ae65a0fa02d6912ae3b6b37cf85b90c21cc423fd9fef70aaf4f628 \
  https://github.com/intel/intel-graphics-compiler/releases/download/v${IGC2_VER}/intel-igc-core-2_${IGC2_VER}+${IGC2_BUILD}_amd64.deb /
ADD --checksum=sha256:779e1b9e88098eb25711e9a8f67c2752665bad22f134aa40ed5649f6e1b87058 \
  https://github.com/intel/intel-graphics-compiler/releases/download/v${IGC2_VER}/intel-igc-opencl-2_${IGC2_VER}+${IGC2_BUILD}_amd64.deb /
ADD --checksum=sha256:61712caaddeba3d38e4f79e2a0fb23fea25596ca2d72c3144c6eea2331ec4301 \
  https://github.com/intel/compute-runtime/releases/download/${NEO_VER}/intel-opencl-icd_${NEO_VER}-0_amd64.deb /
ADD --checksum=sha256:c1e1ecdfe2064c047c552651cfdcdafc504f2033afafba65654338b880048b67 \
  https://github.com/intel/intel-graphics-compiler/releases/download/igc-${IGC1_LEGACY_VER}/intel-igc-core_${IGC1_LEGACY_VER}_amd64.deb /
ADD --checksum=sha256:dd016400f87fa2b6a9fa9fbcca7eb4a2629174a29de679709f9bec5cede88b0e \
  https://github.com/intel/intel-graphics-compiler/releases/download/igc-${IGC1_LEGACY_VER}/intel-igc-opencl_${IGC1_LEGACY_VER}_amd64.deb /
ADD --checksum=sha256:bbe71e4f414259e06a10cde72c29a2bd78d41b2bb2f6f8463b1806797fe66e85 \
  https://github.com/intel/compute-runtime/releases/download/${NEO_LEGACY_VER}/intel-opencl-icd-legacy1_${NEO_LEGACY_VER}_amd64.deb /

# arm64: Jellyfin installs no Intel runtime there (it adds Rockchip's libmali instead, not taken over here). Nothing to mount.
# (Ferrofin v1.5.2 publishes amd64 only, so today this stage is never used.)
FROM scratch AS intel-opencl-arm64

# hadolint ignore=DL3006
FROM intel-opencl-${TARGETARCH} AS intel-opencl

# --- the image: Ferrofin v1.5.2, pinned by digest (the multi-arch index; bump tag + digest together) ---
FROM ghcr.io/mangoleaf/ferrofin:v1.5.2@sha256:c00fe34634d7f886888c027cd0552d990a4c9cd918b45c2fce96d5963aca26d5
ARG TARGETARCH
# the image commit (CI: the newest commit that changed this image's inputs, .github/images.json; `dev` locally): only in the
# revision label below, not as an ENV (the managed media server's env stays as Ferrofin sets it)
ARG FF_IMAGE_COMMIT=dev
# hadolint ignore=DL3066
USER root
# 0001: dpkg -i, not apt: every dependency (libc6, libstdc++6, libgcc-s1, zlib1g, libzstd1 and the OpenCL ICD loader
# ocl-icd-libopencl1, which jellyfin-ffmpeg8 already pulls in) is in the pinned base image, so nothing comes from a live
# repository and nothing is unpinned; a missing dependency fails dpkg and the build. Then (after an explicit ldconfig: the IGC
# libraries live in /usr/local/lib, and the cache must not depend on a package's trigger) every installed library must
# resolve its shared libraries (fails the build, not the first HDR transcode). Package lists, apt caches and dpkg's logs go.
RUN --mount=type=bind,from=intel-opencl,target=/tmp/intel-opencl \
  set -eu; \
  if [ "$TARGETARCH" = amd64 ]; then \
    dpkg -i /tmp/intel-opencl/*.deb; \
    test -s /etc/OpenCL/vendors/intel.icd; \
    test -s /etc/OpenCL/vendors/intel_legacy1.icd; \
    ldconfig; \
    dpkg -L libigdgmm12 intel-igc-core-2 intel-igc-opencl-2 intel-opencl-icd intel-igc-core intel-igc-opencl intel-opencl-icd-legacy1 \
      > /tmp/intel-opencl.files; \
    grep -E '\.so(\.[0-9]+)*$' /tmp/intel-opencl.files > /tmp/intel-opencl.libs; \
    test -s /tmp/intel-opencl.libs; \
    while IFS= read -r lib; do \
      deps=$(ldd "$lib"); \
      case "$deps" in *"not found"*) printf '%s: missing shared library\n%s\n' "$lib" "$deps" >&2; exit 1 ;; esac; \
    done < /tmp/intel-opencl.libs; \
    rm /tmp/intel-opencl.files /tmp/intel-opencl.libs; \
  else \
    echo "no Intel OpenCL runtime for $TARGETARCH (amd64 only, as in Jellyfin's image)"; \
  fi; \
  rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log /var/log/alternatives.log /var/lib/dpkg/*-old
# 0004: no web client. Ferrofin serves FERROFIN_WEB_DIR at /web/ when it holds an index.html, else it logs "no web client bundle
# (index.html) found" and serves the API only. An ENV cannot be unset, so it names /nonexistent (root's /, read-only in the
# managed container: nothing can create it). The bundled client goes too (the build fails if a base bump moved it: check this
# change again then). The files stay in the base image's layer, so this saves no download; see patches/0004-no-web-client.md.
RUN test -f /usr/share/ferrofin/web/index.html \
  && rm -rf /usr/share/ferrofin \
  && test ! -e /nonexistent
ENV FERROFIN_WEB_DIR=/nonexistent
# 0005: the state directories writable for any non-root container user (as the official Jellyfin image does for /config and
#       /cache). Docker copies an image directory's owner and mode onto a fresh named volume mounted there, so the managed media
#       server's data and cache volumes are writable for the uid the owner picks. /cache is the cache root the template sets
#       (FERROFIN_CACHE_DIR=/cache); the base image has no /cache at all. Not a VOLUME: an unmounted /cache must not become an
#       anonymous volume.
RUN install -d -o ferrofin -g ferrofin -m 0777 /cache && chmod 0777 /data
COPY mediaserver/NOTICE /usr/share/doc/friendflix-mediaserver/NOTICE
# back to the base image's own user (uid 1000) and entrypoint; /data, ports and the rest of the env stay as Ferrofin sets them
# hadolint ignore=DL3066
USER ferrofin
# 0003: the base image has no curl (it purges it after installing jellyfin-ffmpeg), so bash (Debian's, in the base) sends the
# request over /dev/tcp. Healthy = Ferrofin's GET /health answers 200 ("Every check passed"; 503 while a check fails); anything
# else, no answer within 4 s included, exits 1 (Docker: unhealthy).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8096 && printf 'GET /health HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n' >&3 && IFS= read -r -t 4 status <&3 && [[ $status == 'HTTP/1.'[01]' 200 '* ]] || exit 1"]
# CI's build action (.github/actions/build-image) writes title/description/licenses/source/url/revision/created too (this
# image's own title, description and licence, not the AGPL of the other images; revision = the image commit, created = its
# commit time). GPL-3.0-only is the licence of the Ferrofin server; the other parts keep theirs (NOTICE).
LABEL org.opencontainers.image.title="FriendFlix media server (Ferrofin)" \
  org.opencontainers.image.description="Ferrofin v1.5.2 with FriendFlix's numbered changes (0001: Intel OpenCL runtime; 0003: healthcheck; 0004: no web client, API only; 0005: state directories for any user). Trial." \
  org.opencontainers.image.source="https://github.com/LetsManu/friendflix" \
  org.opencontainers.image.documentation="https://github.com/LetsManu/friendflix/blob/main/mediaserver/README.md" \
  org.opencontainers.image.licenses="GPL-3.0-only" \
  org.opencontainers.image.revision="${FF_IMAGE_COMMIT}" \
  org.opencontainers.image.base.name="ghcr.io/mangoleaf/ferrofin:v1.5.2" \
  org.opencontainers.image.base.digest="sha256:c00fe34634d7f886888c027cd0552d990a4c9cd918b45c2fce96d5963aca26d5" \
  io.github.letsmanu.friendflix.mediaserver.ferrofin="v1.5.2" \
  io.github.letsmanu.friendflix.mediaserver.changes="0001,0003,0004,0005"
ENTRYPOINT ["ferrofin-server"]
