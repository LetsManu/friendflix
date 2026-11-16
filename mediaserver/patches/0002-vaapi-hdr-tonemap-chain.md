<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# 0002 – VA-API HDR tone-mapping chain (placeholder)

| | |
|---|---|
| Kind | Probably a source change in Ferrofin's ffmpeg command builder (to be confirmed). |
| Status | **Being investigated separately.** Nothing in the image yet. |
| Upstream issue / PR | – (link here once filed at https://github.com/mangoleaf/ferrofin) |
| Drop it when | a Ferrofin release builds a working VA-API + OpenCL tone-mapping chain. |

## Why

HDR tone mapping over VA-API on Intel is under investigation; the open question is whether the filter chain Ferrofin builds
matches the one Jellyfin uses (`scale_vaapi=…:format=p010` → `hwmap=derive_device=opencl:mode=read` → `tonemap_opencl` → `hwmap=derive_device=vaapi:
mode=write:reverse=1` → `format=vaapi`). Test 3 of `probe.sh` runs Jellyfin's chain directly in the image, so it separates
"the image cannot do it" (0001) from "Ferrofin asks for the wrong chain" (this change).

## To fill in

- the failing command line from Ferrofin's log and the one Jellyfin builds for the same file and client;
- the fix, first as an upstream issue / PR; carried here as a source patch only if upstream cannot take it in time. A source
  patch needs a Rust build stage in `mediaserver/Dockerfile` (today the image has none) – decide that before carrying it.
