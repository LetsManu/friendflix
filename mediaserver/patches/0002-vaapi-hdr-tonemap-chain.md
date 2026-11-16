<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# 0002 – VA-API HDR tone mapping on GPUs without a VPP tone mapper

| | |
|---|---|
| Kind | Source change in Ferrofin (capability probe + filter-chain choice): [`0002-vaapi-hdr-tonemap.patch`](0002-vaapi-hdr-tonemap.patch), against v1.5.1. |
| Status | **Proposed – not applied to the image; needs a source build and hardware confirmation.** |
| Upstream issue / PR | not filed yet; draft: [upstream-issue-draft.md](upstream-issue-draft.md) (covers 0001 and 0002) |
| Drop it when | a Ferrofin release stops emitting `tonemap_vaapi` on GPUs whose driver cannot tone-map, or the hardware check below shows it is not needed. |

## Root cause (by elimination, to be confirmed on the hardware)

With *VPP tone mapping* on, Ferrofin builds the same chain as Jellyfin for Intel QSV / VA-API, ending in `tonemap_vaapi`. The
trial on an Intel iGPU failed with:

```
[Parsed_tonemap_vaapi_3] Failed to configure output pad on Parsed_tonemap_vaapi_3
Error reinitializing filters!
```

- The chain is byte-identical to Jellyfin's for the same input and settings, so this is not a Ferrofin chain bug.
- The only step of `tonemap_vaapi`'s output-pad setup that `scale_vaapi` and `procamp_vaapi` (which configured fine just before)
  do not run is the query for the HDR tone-mapping filter caps. When the driver returns none, ffmpeg logs
  **"VAAPI driver doesn't support HDR"** and the output pad cannot be configured.
- Intel's iHD media driver advertises HDR tone mapping only on SKUs with **`FtrHDR`**. Skylake, Apollo Lake and the **GT1**
  Kaby Lake / Coffee Lake / Comet Lake parts (HD/UHD 610: Celeron, Pentium Gold) do not have it; GT2 and above, Gemini Lake,
  Gen11, Gen12 and newer do.
- **Jellyfin has the same gap:** it only checks the setting, the stream and that `tonemap_vaapi` is compiled in.

So on such a GPU, VPP tone mapping can never work. The **OpenCL route** (`tonemap_opencl`), which 0001 makes possible, very
likely is enough: turn VPP tone mapping off and OpenCL tone mapping on in Ferrofin's encoding settings, and check with
`probe.sh` test 2.

## What the patch does

It keeps upstream behaviour where VPP tone mapping works, and falls back where it cannot:

- a capability flag `vaapi_hdr_tonemap_missing` (default off = upstream behaviour);
- with the flag set, `is_intel_vpp_tonemap_available` is false on Linux, so the QSV / VA-API chains fall through to the OpenCL
  tone map (or to none) instead of failing;
- a one-frame probe per device (`hwupload,tonemap_vaapi` on a P010 colour source) that sets the flag only on the filter's own
  refusal;
- unit tests: the capability gate, a golden of the failing QSV chain, the fallback chains, the stderr parser and the prober
  with a stub ffmpeg. `cargo test` of `ferrofin-mediaencoding` and `ferrofin-server` passed against v1.5.1; it has not run on
  a GPU.

Carrying it would need a Rust build stage in `mediaserver/Dockerfile` (today the image has none). Decide that only if upstream
cannot take it and OpenCL alone (0001) is not enough.

## What the owner must check on the NAS

1. **The log line just before** `Failed to configure output pad` in the failing transcode's ffmpeg log. If it is not
   "VAAPI driver doesn't support HDR" (or "Failed to query HDR caps"), the root cause above is wrong.
2. **The CPU model** (`grep -m1 'model name' /proc/cpuinfo`): which generation and GT level the iGPU is.
3. **`vainfo`** on the host, or in the image: does the driver list `VAProcFilterHighDynamicRangeToneMapping`?
   `docker run --rm --device /dev/dri --entrypoint /usr/local/bin/ffmpeg <image> -v verbose -init_hw_device vaapi=va:/dev/dri/renderD128 -f lavfi -i nullsrc -frames 1 -f null -`
   prints the driver in use.
4. **`probe.sh`** with the image that has 0001: test 4 says whether the VA driver has a VPP tone mapper (it runs a one-frame
   `tonemap_vaapi` like the patch's probe and recognises the refusal); test 2 (QSV + OpenCL) passing means the OpenCL route
   works on this GPU.

Put the answers (no host names, addresses or paths) into the upstream issue draft before filing it.
