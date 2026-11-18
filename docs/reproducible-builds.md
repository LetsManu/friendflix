<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Reproducible builds

The container images (`ghcr.io/letsmanu/friendflix-{backend,gateway,web,updater}`; `livetv` and `mediaserver` are exempt, see below) are built so that building the same commit
again – on another machine, at another time, with an empty cache – gives **the same bytes**: the same image manifest
digest. Each image is built for its **image commit** (the newest commit that changed its inputs, `.github/images.json`),
not for the commit of the CI run, so a later commit that leaves an image's inputs alone gives that image's bytes again. Anyone can rebuild a release and check that the published image contains exactly what the source says, and
nothing an attacker slipped into the build machine. CI checks it for every pull request and every image it publishes
(job `reproducible` in [ci.yml](../.github/workflows/ci.yml)).

## Check a published image yourself

You need git (a full clone: the image commit is found in the history), jq, Node and Docker with buildx (Linux or macOS; on
Apple silicon the amd64 build runs emulated and is slow).

```bash
git clone https://github.com/LetsManu/friendflix && cd friendflix

IMG=ghcr.io/letsmanu/friendflix-backend:1.4.0       # gateway / web the same way; :latest, :<short sha> work too
scripts/reproduce-image.sh backend --compare "$IMG"   # builds the image's revision (its image commit); --ref v1.4.0 works too
# reproduce-image: OK: rebuilt backend is identical to ghcr.io/letsmanu/friendflix-backend:1.4.0 (sha256:…)
```

What the script does (it is short – read it before you trust it):

1. Takes the build context from `git archive <ref>`: only committed files, every mtime = commit time, modes 644/755.
   Your local changes, untracked files, umask or `core.autocrlf` cannot leak in. With `--compare` the ref defaults to
   the image's `org.opencontainers.image.revision` label – its image commit; any later commit with the same inputs (the
   release tag, say) gives the same bytes.
2. `SOURCE_DATE_EPOCH` = the commit time of the image commit – the only "time" in the build. With `--compare` that is
   the published image's `FF_IMAGE_COMMIT` (images from before it: `GIT_SHA`); without, the image commit that the ref's
   own `scripts/changed-images.mjs image-commit <service> --ref <ref>` names, as CI builds it.
3. Creates a fresh, throw-away BuildKit builder with the BuildKit image pinned in the build action
   (`.github/actions/build-image/action.yml`, the `default:` of input `buildkit-image`; older refs: `BUILDKIT_IMAGE` in
   `ci.yml`; another BuildKit version may legitimately produce different bytes) and builds with `--no-cache --pull`,
   `--provenance=false --sbom=false` and `--output type=oci,…,oci-mediatypes=true,compression=gzip,rewrite-timestamp=true`.
4. With `--compare`, copies the image's labels and the build-arg ENVs (`FF_IMAGE_COMMIT`; backend also `APP_VERSION`,
   `APP_CODENAME`; images from before `FF_IMAGE_COMMIT` carry `GIT_SHA`, `BUILD_TIME`, `APP_VERSION`, `APP_CODENAME`)
   from the published image into the rebuild – they are metadata the release pipeline sets – and compares the rebuilt
   manifest digest with the published **linux/amd64 image manifest** digest. Anything else – every layer, the rest of
   the config, `created`, the history – must come out identical. Only build arguments the Dockerfile at the ref declares
   are passed.

By hand, without the script, the core of it is:

```bash
read -r COMMIT SOURCE_DATE_EPOCH < <(node scripts/changed-images.mjs image-commit backend)   # "<sha> <epoch>"
export SOURCE_DATE_EPOCH
docker buildx create --name repro --driver docker-container --driver-opt image=$(scripts/reproduce-image.sh --buildkit-image)
docker buildx build --builder repro --no-cache --pull --platform linux/amd64 --provenance=false --sbom=false \
  --build-arg SOURCE_DATE_EPOCH --build-arg FF_IMAGE_COMMIT=$COMMIT \
  --build-arg APP_VERSION=$(jq -r .version version.json) --build-arg APP_CODENAME=$(jq -r .codename version.json) \
  --label org.opencontainers.image.revision=$COMMIT --label org.opencontainers.image.created=… \
  -f backend/Dockerfile --output type=oci,dest=backend.tar,oci-mediatypes=true,compression=gzip,rewrite-timestamp=true .
tar -xOf backend.tar index.json | jq -r '.manifests[0].digest'
docker buildx imagetools inspect --raw "$IMG" | jq -r '.manifests[] | select(.platform.architecture=="amd64") | .digest'
```
`APP_VERSION` / `APP_CODENAME` only for the backend: the other images do not carry the version. Pass every label of the
published image as `--label` (`docker buildx imagetools inspect "$IMG" --format '{{json .Image}}' | jq .config.Labels`).
Build from a fresh clone (`git archive` in the script): files whose mtime is older than the commit are not clamped.

## What is compared, and what is not

| Part | Reproducible? | Why |
|---|---|---|
| Image manifest (linux/amd64): config + all layers | **yes – this is the digest that is compared** | see below |
| Image index digest (what `:tag` points to) | no | also lists the attestation manifests |
| BuildKit SBOM + SLSA provenance (in the index), cosign signature, GitHub attestations | no | contain build times, run IDs, signatures; separate manifests that *point to* the image manifest |
| Labels `org.opencontainers.image.*` | yes, with the release's values | written by the build action from git only: `revision` = the image commit, `created` = its commit time, `title`, `source`, `url`, `licenses`; no `version` (the release lives in the backend's `APP_VERSION`). `--compare` copies them; images from before the image commit also carry docker/metadata-action's `version` and `description` |

## How the build is made deterministic

- **The image commit, not the run commit:** every image carries `FF_IMAGE_COMMIT` = its image commit (from the change
  plan) and the `revision` label with the same value, and nothing else about the run: no `GIT_SHA`, no `BUILD_TIME`, no
  `version` label. The release version (`APP_VERSION` / `APP_CODENAME` from `version.json`) is baked into the backend
  only; the other images take it from the backend. So an image whose inputs did not change comes out bit for bit the
  same at a later commit.
- **Timestamps:** `SOURCE_DATE_EPOCH` = the image commit's time is passed to every build. BuildKit uses it for the
  config's `created` and history entries, and `rewrite-timestamp=true` clamps every file mtime in every layer to it. The
  `org.opencontainers.image.created` label is derived from it, not from the clock.
- **No cache for what is published:** `rewrite-timestamp` only clamps mtimes *newer* than `SOURCE_DATE_EPOCH`. A layer
  reused from an older commit's cache keeps that build's older mtimes, so the candidate that CI pushes is built with
  `no-cache` (it still exports its layers as cache for PR builds).
- **Pinned toolchain:** base image by digest (`node:26-alpine@sha256:…`, Dependabot), BuildKit by digest
  (`buildkit-image` in `.github/actions/build-image/action.yml`, bumped by hand), npm dependencies by `package-lock.json`
  (`npm ci`). Two clean `npm ci` runs produce byte-identical `node_modules` (mtimes are clamped).
- **App build output:** `tsc` (backend, gateway) is deterministic. The web app's SvelteKit `version.name` defaulted to
  `Date.now()` and ended up in `_app/version.json`, the service worker, the prerendered `/offline` page and the server
  chunks; it is now the web image's image commit (`FF_IMAGE_COMMIT`, else `SOURCE_DATE_EPOCH`) –
  [kit-version.ts](../web/src/lib/version/kit-version.ts), so the service worker cache only turns over when the web
  image changed. Two `vite build`s of the same inputs are byte-identical.
- **Nothing build-time-dependent in the runtime stage:** only `dist`/`build` output, production `node_modules`,
  `package.json` and (backend only) `version.json` are copied; npm caches stay in the build stages.

## Alpine packages: the one limit (ruling)

The runtime stages install Alpine packages from the network: `ffmpeg` (backend) and security fixes that are newer than
the base image. Alpine keeps **only the newest version** of each package on its mirrors (there is no snapshot archive),
so this decides how long a commit stays reproducible:

- **No blanket `apk upgrade`** (used before): it pulls whatever is newest *today*, so any Alpine update in between makes a
  rebuild differ.
- **No exact pins** (`zlib=1.3.2-r1`): the pinned version disappears from the mirrors with the next Alpine bump, and from
  then on the build – and every rebuild of an older tag – **fails**. A build that stays buildable was preferred.
- **Ruling:** packages come from the **digest-pinned base image** (Dependabot bumps it). A security fix the base image
  does not have yet is pulled in as a **minimum version** (`apk add 'zlib>=1.3.2-r1'`, CVE-2026-85091; the pinned base
  has 1.3.2-r0): no-op once the base image ships it, and then removed from the Dockerfile. `ffmpeg` is installed
  unpinned.
- **`/var/log/apk.log` is deleted in the same `RUN`:** apk 3 appends a timestamped line per install there, the only
  file `apk add` writes that differs between two runs (the package database and `scripts.tar.gz` are deterministic).
- **Consequence:** an image reproduces bit for bit as long as Alpine has not published a newer version of those packages
  (`zlib` while the base still lacks the fix; for the backend `ffmpeg` and its ~100 dependencies) since it was built. CI
  checks within minutes, so this always holds there; a rebuild weeks later may differ *only in that `apk` layer*. To check
  an older release anyway, compare layer by layer: every other layer (application code, `node_modules`, base image) must
  still be identical – `docker buildx imagetools inspect "$IMG" --format '{{json .Image}}' | jq .rootfs.diff_ids` against
  the rebuild (`--out image.tar`; `scripts/reproduce-image.sh --diff a.tar b.tar` lists the files of differing layers),
  and the package versions in the published image are in its SBOM.

## Exemption: `livetv`

The optional `livetv` image (`ghcr.io/letsmanu/friendflix-livetv`) is **not** part of the `reproducible` job and
`scripts/reproduce-image.sh livetv` refuses. It is Debian-based and installs `jellyfin-ffmpeg7` with `apt` from the Jellyfin
repository, which keeps only current versions (no snapshot archive, so an exact pin would stop building) and whose apt/dpkg
state is not shown to be byte-stable, so the Alpine ruling above cannot be extended to it. Its base images are digest-pinned
and the image is built, scanned, SBOM'd and cosign-signed like the others; see [livetv.md](livetv.md#image-and-reproducible-builds-exemption). To lift the exemption, pin or vendor the Jellyfin `.deb`, then show two identical builds with `scripts/reproduce-image.sh livetv`.

## Exemption: `mediaserver`

The trial media server image (`ghcr.io/letsmanu/friendflix-mediaserver`, [mediaserver/README.md](../mediaserver/README.md)) is
not part of the `reproducible` job either, and `scripts/reproduce-image.sh mediaserver` refuses. It is the third-party Ferrofin
release image, pinned by digest, plus Intel's OpenCL runtime installed with `dpkg` from release debs that are pinned by version
and sha256 (nothing comes from a live repository). Whether two clean builds give the same digest has not been shown yet. It is
built, scanned, SBOM'd and cosign-signed like the others, in its own jobs (`mediaserver-image`, `publish-mediaserver`) that
the other images never wait for; its Trivy findings are reported, not a gate (see the top of `ci.yml`). To lift the exemption, show two identical builds with `scripts/reproduce-image.sh` and add it to the job's matrix.

## When the `reproducible` check fails

The failing job prints which layer differs and the file listing (mode, owner, size, mtime, name) of that layer in both
builds. Typical causes: a build step that writes the current time, a random value or a machine-specific path into a file
(look at `Date.now()`/`new Date()` in build tooling and config; log files such as `/var/log/apk.log`), a cache layer from another commit, or an Alpine package
published in the minutes between the two builds (re-run the job).
