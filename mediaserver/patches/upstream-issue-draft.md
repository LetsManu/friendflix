<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later

DRAFT of an upstream issue for https://github.com/mangoleaf/ferrofin/issues: not filed yet. Before filing, run the checks under
"Can only be verified on hardware" and put the results in (no host names, addresses or paths). Post everything from the
title line down, without this comment. Once filed, link it in mediaserver/README.md and patches/0001 and 0002.
-->
# Intel QSV HDR→SDR transcode fails both ways: the image has no OpenCL runtime, and VPP tonemapping can emit `tonemap_vaapi` on a GPU whose driver has no HDR tone mapper

## Environment

- Ferrofin v1.5.1, official container image (`debian:trixie-slim` + `jellyfin-ffmpeg8` 8.1.3)
- Linux host, Intel iGPU, render node passed through to the container
- VA-API driver: Intel iHD (the one bundled with jellyfin-ffmpeg)
- Hardware acceleration: Intel QuickSync (QSV), H.264 encode (`h264_qsv`, low-power on)
- Source: a 4K Dolby Vision profile 8.1 HEVC film (HEVC Main10, 3840x2160, BT.2020 / SMPTE 2084, HDR10-compatible base layer)
- Client asked for H.264 SDR, so the server must tonemap

There are two separate problems. Either one alone stops the transcode.

## Problem A: OpenCL tonemapping fails because the image has no Intel OpenCL runtime

Setting: tonemapping (OpenCL) on, VPP tonemapping off. This is the setting most Jellyfin users run on Intel.

Ferrofin builds the same chain Jellyfin builds:

```
…,scale_vaapi=w=1280:h=720,hwmap=derive_device=opencl:mode=read,tonemap_opencl=…,hwmap=derive_device=qsv:mode=write:reverse=1,format=qsv
```

ffmpeg fails while deriving the OpenCL device. It reports error `-1001` (`CL_PLATFORM_NOT_FOUND_KHR`, which means the ICD loader found no OpenCL platform), then "No such device".

**Root cause:** the runtime image installs only `jellyfin-ffmpeg8`, so it has no Intel OpenCL ICD. Jellyfin's official image (`jellyfin-packaging/docker/Dockerfile`, the "Intel OpenCL Tone mapping dependencies" step) installs Intel compute-runtime from the upstream releases on amd64:

- `intel-opencl-icd` with `intel-igc-core-2` / `intel-igc-opencl-2` and `libigdgmm12`, for Gen12 and newer
- `intel-opencl-icd-legacy1` with the legacy IGC 1.x packages, for Gen8 to Gen11 (Broadwell to Ice Lake). Without these, older iGPUs get no OpenCL at all.

**Proposed fix:** install the same packages in the runtime stage of `Dockerfile` and in `ci/runtime.Dockerfile` (amd64 only), pinned like the jellyfin-ffmpeg8 package. A startup log line that says when `-init_hw_device opencl` fails on a QSV/VAAPI setup would make this easier to diagnose.

## Problem B: VPP tonemapping fails with "Failed to configure output pad on Parsed_tonemap_vaapi_3"

Setting: VPP tonemapping on, OpenCL tonemapping off. Generated filter chain (VAAPI decode into `h264_qsv`):

```
-vf setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,scale_vaapi=w=1920:h=1080:extra_hw_frames=24,procamp_vaapi=b=16,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709:extra_hw_frames=32,hwmap=derive_device=qsv,format=qsv -c:v h264_qsv -low_power 1
```

```
[Parsed_tonemap_vaapi_3] Failed to configure output pad on Parsed_tonemap_vaapi_3
Error reinitializing filters!
…
Conversion failed!
```

### What it is not

The chain matches Jellyfin's exactly. I compared `intel_qsv_vaapi_vid_filters_prefered` (`crates/ferrofin-mediaencoding/src/encoding_helper/hw/qsv.rs`) and `hw_tonemap_filter` (`hw/tonemap.rs`) with `GetIntelQsvVaapiVidFiltersPrefered` and `GetHwTonemapFilter` in Jellyfin's `EncodingHelper.cs`. For this input and these settings, Jellyfin emits the same string filter for filter.

Several suspects can be ruled out:

- `scale_vaapi` without `format=` keeps the decoder's P010 surfaces. `vaapi_vpp.c` inherits the input `sw_format` when no output format is given, so `tonemap_vaapi` does get 10-bit input.
- `procamp_vaapi` in front of the tonemap is also upstream's layout, and it keeps P010.
- Dolby Vision RPU and missing HDR10 side data: `tonemap_vaapi` ignores the RPU and reads static metadata only in `filter_frame`, not while configuring the graph. jellyfin-ffmpeg patch 0070 also makes missing mastering metadata non-fatal.

### Root cause (by elimination; please confirm with the error line just before "Failed to configure output pad")

`tonemap_vaapi`'s output-pad configuration (`ff_vaapi_vpp_config_output`) runs the same steps that `scale_vaapi` and `procamp_vaapi` have just completed on the same device at the same size: create the VPP config, check constraints, create the frame pool and the context. The one step unique to it is `tonemap_vaapi_build_filter_params`, which calls `vaQueryVideoProcFilterCaps(VAProcFilterHighDynamicRangeToneMapping)` and fails with "VAAPI driver doesn't support HDR" when the driver returns no caps.

In intel/media-driver, the HDR tone-mapping caps are returned only when the SKU has `FtrHDR` (`DdiVpFunctions::QueryVideoProcFilterCaps`). `FtrHDR` is **not** set for Skylake, Broxton/Apollo Lake, or the **GT1** Kaby Lake / Coffee Lake / Comet Lake parts (HD/UHD 610: Celeron, Pentium Gold). It is set for GT2 and above, for Gemini Lake, and for Gen11, Gen12 and newer. On those older GPUs, enabling VPP tonemapping produces a graph ffmpeg cannot configure, so the transcode never starts.

Jellyfin has the same gap: `IsIntelVppTonemapAvailable` only checks the setting, the stream and that `tonemap_vaapi` is compiled in. Ferrofin can do better without breaking parity on hardware that works.

### Proposed fix

1. Add a capability flag `vaapi_hdr_tonemap_missing` to `FfmpegCapabilities`. It defaults to `false`, which keeps current and upstream behaviour.
2. Make `is_intel_vpp_tonemap_available` return `false` on Linux when the flag is set. The QSV and VAAPI chains then fall through to the OpenCL tonemap if it is enabled (working once A is fixed), or to an untonemapped output, instead of failing.
3. In `apps/ferrofin-server/src/vaapi_probe.rs`, run a one-frame probe once per device: `-init_hw_device vaapi=va:<device> -filter_hw_device va -f lavfi -i color=…,format=p010le -vf hwupload,tonemap_vaapi=format=nv12:… -frames:v 1 -f null -`. Run it only for QSV/VAAPI jobs on Linux, with VPP tonemapping enabled and `tonemap_vaapi` compiled in. Set the flag **only** when stderr contains the filter's own refusal ("VAAPI driver doesn't support HDR" / "Failed to query HDR caps"). For QSV, the probe opens the VAAPI half of the job's own `qsv_device_args`.

A patch with unit tests (capability gate, a QSV chain golden that reproduces the failing chain, the fallback chains, the stderr parser and the prober with a stub ffmpeg) is available. `cargo test -p ferrofin-mediaencoding --lib` (1387 tests) and `cargo test -p ferrofin-server --lib` (646 tests) pass.

### Can only be verified on hardware

- The exact error line before "Failed to configure output pad" in the failing job's ffmpeg log. If it is not "VAAPI driver doesn't support HDR" / "Failed to query HDR caps", the root cause above is wrong.
- The iGPU generation and GT level. `vainfo` (or `ffmpeg -v verbose -init_hw_device vaapi=va:/dev/dri/renderD128`) on the affected host shows whether `VAProcFilterHighDynamicRangeToneMapping` is advertised.
- That the probe command reproduces the refusal on that GPU and succeeds on a GT2+ / Gen11+ part.
