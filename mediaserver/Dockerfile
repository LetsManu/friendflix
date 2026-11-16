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
# (Ferrofin v1.5.1 publishes amd64 only, so today this stage is never used.)
FROM scratch AS intel-opencl-arm64

# hadolint ignore=DL3006
FROM intel-opencl-${TARGETARCH} AS intel-opencl

# --- the image: Ferrofin v1.5.1, pinned by digest (the multi-arch index; bump tag + digest together) ---
FROM ghcr.io/mangoleaf/ferrofin:v1.5.1@sha256:5980a3c29c0bab564793f4fcf786e737b91a9eba26e9fb1d6f1c203ccb56580a
ARG TARGETARCH
ARG GIT_SHA=dev
# hadolint ignore=DL3066
USER root
# 0001: dpkg -i, not apt: every dependency (libc6, libstdc++6, libgcc-s1, zlib1g, libzstd1 and the OpenCL ICD loader
# ocl-icd-libopencl1, which jellyfin-ffmpeg8 already pulls in) is in the pinned base image, so nothing comes from a live
# repository and nothing is unpinned; a missing dependency fails dpkg and the build. Then every installed library must
# resolve its shared libraries (fails the build, not the first HDR transcode). Package lists, apt caches and dpkg's logs go.
RUN --mount=type=bind,from=intel-opencl,target=/tmp/intel-opencl \
  set -eu; \
  if [ "$TARGETARCH" = amd64 ]; then \
    dpkg -i /tmp/intel-opencl/*.deb; \
    test -s /etc/OpenCL/vendors/intel.icd; \
    test -s /etc/OpenCL/vendors/intel_legacy1.icd; \
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
COPY mediaserver/NOTICE /usr/share/doc/friendflix-mediaserver/NOTICE
# back to the base image's own user (uid 1000) and entrypoint; /data, ports and env stay as Ferrofin sets them
# hadolint ignore=DL3066
USER ferrofin
# CI's docker/metadata-action sets title/description/licenses/source/revision/version/created too (ci.yml passes this image's
# values for title, description and licenses, so the repository's AGPL default does not land on it). GPL-3.0-only is the
# licence of the Ferrofin server; the other parts keep theirs (NOTICE).
LABEL org.opencontainers.image.title="FriendFlix media server (Ferrofin)" \
  org.opencontainers.image.description="Ferrofin v1.5.1 with FriendFlix's numbered changes (0001: Intel OpenCL runtime). Trial." \
  org.opencontainers.image.source="https://github.com/LetsManu/friendflix" \
  org.opencontainers.image.documentation="https://github.com/LetsManu/friendflix/blob/main/mediaserver/README.md" \
  org.opencontainers.image.licenses="GPL-3.0-only" \
  org.opencontainers.image.revision="${GIT_SHA}" \
  org.opencontainers.image.base.name="ghcr.io/mangoleaf/ferrofin:v1.5.1" \
  org.opencontainers.image.base.digest="sha256:5980a3c29c0bab564793f4fcf786e737b91a9eba26e9fb1d6f1c203ccb56580a" \
  io.github.letsmanu.friendflix.mediaserver.ferrofin="v1.5.1" \
  io.github.letsmanu.friendflix.mediaserver.changes="0001"
ENTRYPOINT ["ferrofin-server"]
