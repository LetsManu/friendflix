<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# 0001 – Intel OpenCL runtime in the image

| | |
|---|---|
| Kind | Image-level (`mediaserver/Dockerfile`, the `intel-opencl-*` stages and the first `RUN`). No source change. |
| Status | **Done in our image.** Upstream: not filed yet. |
| Upstream issue / PR | – (link here once filed at https://github.com/mangoleaf/ferrofin) |
| Drop it when | a Ferrofin release image ships an Intel OpenCL runtime (check: `bash mediaserver/probe.sh` with `IMAGE=` the new upstream image passes test 1). |

## Why

A trial on an Intel iGPU (iHD driver, QSV) could not tone-map HDR10 / Dolby Vision to SDR. Ferrofin's image
(`debian:trixie-slim` + `jellyfin-ffmpeg8`) has the OpenCL ICD loader (`ocl-icd-libopencl1`, a dependency of jellyfin-ffmpeg8)
but no Intel driver for it, so ffmpeg finds no OpenCL platform:

```
[OpenCL] Failed to get number of OpenCL platforms: -1001
Failed to set value 'opencl=ocl@va' for option 'init_hw_device': No such device
```

Jellyfin's tone mapping on Intel (QSV or VA-API decode, `tonemap_opencl`, QSV or VA-API encode) needs that runtime. The
official Jellyfin image ships it; Ferrofin's does not.

## What

Exactly what the official Jellyfin image installs (jellyfin/jellyfin-packaging, `docker/Dockerfile`, block "Intel OpenCL Tone
mapping dependencies", master as of 2026-11-16): the GitHub release debs, amd64 only, current and legacy side by side.

| Package | Version | From | Covers |
|---|---|---|---|
| `libigdgmm12` (gmmlib) | 22.10.0 | intel/compute-runtime release 26.35.39758.10 | both |
| `intel-igc-core-2`, `intel-igc-opencl-2` | 2.41.5+22716 | intel/intel-graphics-compiler release v2.41.5 | Gen12 and newer |
| `intel-opencl-icd` | 26.35.39758.10-0 | intel/compute-runtime release 26.35.39758.10 | Gen12 and newer |
| `intel-igc-core`, `intel-igc-opencl` | 1.0.17537.24 | intel/intel-graphics-compiler release igc-1.0.17537.24 | Gen11 and older |
| `intel-opencl-icd-legacy1` | 24.35.30872.36 | intel/compute-runtime release 24.35.30872.36 | Gen11 and older |

Differences to Jellyfin's way, all for pinning:

- Every deb is fetched by BuildKit (`ADD --checksum=sha256:…`) and checked; a changed file fails the build. The
  compute-runtime hashes match Intel's published `ww35.sum` of both releases; the IGC releases publish no sum file, so their
  hashes are those of the files downloaded on 2026-11-16.
- `dpkg -i` instead of `apt-get install ./*.deb`: every dependency is already in the pinned base image, so no package comes
  from a live repository. The build fails if a dependency is missing, and again if any installed library has an unresolved
  shared library (`ldd`).
- The debs are only mounted into the `RUN`, never stored in a layer.

The image grows by the size of the installed runtime (the debs are about 260 MB, mostly the two compilers).

## Bumping

Take the versions from Jellyfin's Dockerfile when it moves (`GMMLIB_VER`, `IGC2_VER`, `IGC2_BUILD`, `NEO_VER`,
`IGC1_LEGACY_VER`, `NEO_LEGACY_VER`), download the seven debs, compare the compute-runtime ones with the release's `ww*.sum`,
put the new hashes into the `ADD --checksum` lines, rebuild and run `probe.sh` on the Intel host.
