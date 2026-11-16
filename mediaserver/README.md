<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# FriendFlix media server image (trial)

`ghcr.io/letsmanu/friendflix-mediaserver` is FriendFlix's own media server image: the pinned release image of
[Ferrofin](https://github.com/mangoleaf/ferrofin) (a GPL-3.0 Rust re-implementation of the Jellyfin server API) plus a short,
numbered list of our changes. FriendFlix talks to it exactly as to Jellyfin.

**Status: trial.** Jellyfin stays the production media server until both hold:

1. HDR / Dolby Vision → SDR tone mapping works with this image on the production Intel GPU (`probe.sh`, then a real title).
   Until `probe.sh` passes there, HDR tone mapping with this image is untested on real hardware. And
2. Ferrofin 1.6.0 is out: adopting a Jellyfin database is one-way until then, so there is no way back with the watch state
   made in between.

User-facing steps: [docs/mediaserver.md](../docs/mediaserver.md).

## The light-fork model

- **Our image = the developer's pinned release + our numbered changes.** `Dockerfile` starts `FROM` one Ferrofin release,
  pinned by tag and digest, and adds the changes listed below. Nothing else.
- **Every change is also offered upstream** (issue or PR at https://github.com/mangoleaf/ferrofin), and dropped here once a
  release contains it. The goal is an empty list.
- **Follow releases, not commits.** We never build Ferrofin from a branch. A new Ferrofin release is taken as a whole, after
  the checks below.
- **Image-level first.** A change that can live in the Dockerfile (packages, configuration) stays there. A source patch
  would need a Rust build stage, which the image does not have; that is decided per change, and only when upstream cannot
  take the fix in time.
- **What stays upstream:** Ferrofin's source code, its Jellyfin API compatibility, database adoption and migrations, the
  bundled jellyfin-web and jellyfin-ffmpeg, its release cadence and signing. Bugs we find go to Ferrofin first.

## Changes

| # | Change | Kind | Why | Upstream | Status |
|---|---|---|---|---|---|
| 0001 | [Intel OpenCL runtime](patches/0001-intel-opencl-runtime.md) | Dockerfile | Ferrofin's image has no Intel OpenCL driver, so HDR → SDR tone mapping on Intel GPUs fails (`OpenCL platforms: -1001`). Installed the way Jellyfin's image does, pinned by version and sha256. | [draft](patches/upstream-issue-draft.md), not filed yet | in the image; untested on hardware until `probe.sh` passes |
| 0002 | [VA-API HDR tone mapping on GPUs without a VPP tone mapper](patches/0002-vaapi-hdr-tonemap-chain.md) | source ([patch](patches/0002-vaapi-hdr-tonemap.patch)) | On Intel GPUs whose iHD driver lacks `FtrHDR`, VPP tone mapping (`tonemap_vaapi`) cannot be configured and the transcode never starts; the patch falls back to OpenCL (0001). | [draft](patches/upstream-issue-draft.md), not filed yet | proposed – not applied to the image; needs a source build and hardware confirmation |

Each entry in `patches/` says why, the upstream link once filed, the status and when to drop it. New entries take the next
number; numbers are never reused.

## Files

| File | What |
|---|---|
| `Dockerfile` | the image: `FROM ghcr.io/mangoleaf/ferrofin:v1.5.1@sha256:5980…`, change 0001, labels, back to the image's user `ferrofin`, Ferrofin's entrypoint |
| `NOTICE` | licences of what is in the image (copied to `/usr/share/doc/friendflix-mediaserver/NOTICE`) |
| `patches/` | one file per change (`NNNN-*.md`), source patches next to it (`NNNN-*.patch`), and the upstream issue draft |
| `probe.sh` | does HDR tone mapping with OpenCL work on this host's GPU? Throw-away containers only, Jellyfin is not touched |
| `try.sh` | runs the image next to Jellyfin on a **copy** of Jellyfin's config folder, for testing behind FriendFlix; `remove` only touches a container it labelled `friendflix.trial=ferrofin` |

Both scripts use `ghcr.io/letsmanu/friendflix-mediaserver:nightly` unless `IMAGE=` says otherwise, and print the image and its
digest (try.sh pins the trial container to that digest). Every check on the host (folders, GPU, groups, inotify) runs in a
container on the Docker engine's side, so they also work with `DOCKER_HOST`.

Both scripts are self-contained (copy one file to the host and run it with `bash`). They need LF line endings: if bash
says `$'\r': command not found`, the file was saved with Windows line endings; `sed -i 's/\r$//' try.sh` fixes it
(`.gitattributes` keeps them LF in git).

## Build and publish

Locally, from the repository root (the build copies `mediaserver/NOTICE`):

```bash
docker buildx build --platform linux/amd64 -f mediaserver/Dockerfile -t friendflix-mediaserver:dev .
IMAGE=friendflix-mediaserver:dev bash mediaserver/probe.sh     # on a host with an Intel GPU
```

CI builds it in its own job `mediaserver-image` of `.github/workflows/ci.yml`, with the same steps as the other images (no
Rust or Node build: only the base image, the Intel debs and the NOTICE): SPDX SBOM and SLSA provenance, a Trivy scan, and
its own `publish-mediaserver` job, which calls `publish.yml` with `services: ["mediaserver"]` to re-tag, cosign-sign and
attest it as `ghcr.io/letsmanu/friendflix-mediaserver` (`nightly` from main, `X.Y.Z` / `latest` from FriendFlix releases,
short sha). Nothing else needs those two jobs: when this image fails to build or publish, the other images are still built
and published, and neither job is a required status check.

The FriendFlix updater never pulls or recreates it (it only manages FriendFlix's own services).

## Known limits

- **Trivy only reports.** Findings go to the job log and (on push) to code scanning, but never fail the build or stop the
  publish. CVEs in the third-party base can only be fixed by a Ferrofin release; we take releases, not package upgrades of
  our own. Check the `trivy-mediaserver` code-scanning category when bumping.
- **Not reproducible-checked:** exempt from the `reproducible` job
  ([docs/reproducible-builds.md](../docs/reproducible-builds.md#exemption-mediaserver)).
- **linux/amd64 only:** Ferrofin v1.5.1 publishes no other platform (the Intel runtime is amd64-only anyway).
- **Larger image:** the Intel runtime adds about 1.1 GiB installed (the seven debs are about 250 MB to download).
- **The IGC hashes are trust-on-first-download:** Intel publishes no checksum file for those releases (the compute-runtime
  ones match Intel's `ww*.sum`).

## New Ferrofin release

1. **Read the release notes**, especially database migrations: an upgraded copy cannot go back.
2. **Update tag and digest together** in `Dockerfile` (`FROM`, the `base.name` / `base.digest` labels and the
   `io.github.letsmanu.friendflix.mediaserver.ferrofin` label), `NOTICE`, and `UPSTREAM_IMAGE` in `try.sh` and `probe.sh`.
   The digest of the multi-arch index:
   `docker buildx imagetools inspect ghcr.io/mangoleaf/ferrofin:vX.Y.Z --format '{{.Manifest.Digest}}'`.
   (Dependabot opens a PR for the `FROM` line; it is only the reminder for the rest. CI's `mediaserver-image` job fails
   until the labels, NOTICE and both scripts name the same tag and digest as `FROM`.)
3. **Go through the changes:** for each one, is it still needed? Upstream took it → drop it, mark it *upstream* in the table.
   Still needed → check it still applies (for 0001: does the new base still lack the runtime, is it still Debian trixie
   with `ocl-icd-libopencl1`?).
4. **Rebuild** (`docker buildx build …` above, or let CI build the PR).
5. **Run the probe** on the Intel host: `IMAGE=<the new image> bash probe.sh` – tests 1 and 2 must pass.
6. **Run the FriendFlix test:** `try.sh` on a fresh copy, then the checklist in [docs/mediaserver.md](../docs/mediaserver.md).
7. Merge; the next nightly or release publishes it.

Intel runtime updates (change 0001) follow Jellyfin's Dockerfile, not our own choice of versions: see
[patches/0001](patches/0001-intel-opencl-runtime.md#bumping).

## Licence

The Ferrofin server in the image is GPL-3.0-only (its source: the upstream tag). The Intel runtime is MIT; the other
components keep their licences ([NOTICE](NOTICE)). The image is labelled `org.opencontainers.image.licenses=GPL-3.0-only`.
The files in this folder are FriendFlix's own, AGPL-3.0-or-later like the rest of the repository.
