# Build and redeploy only what changed

Status: requested by the owner on 2026-11-17 ("only build containers and redeploy them if they have had changes … to save CI
times as well as redeploy time"); the owner chose approach A and the rules under *Owner decisions* (binding), and answered the open
questions the same day (decisions 11–12: no extra release container, the version stays in the backend image, `RELEASE_TOKEN` is set).
Everything else is marked **Controller's call** with its reason. Revised twice the same day: after the builder check, then after the
owner's answers. Related: `docs/superpowers/specs/2026-11-17-managed-mediaserver-design.md` on branch `claude/managed-mediaserver`
(not on this branch; its owner decisions 9 and 12 and *Images and updates*), which this spec builds on in *Media server* below.

## Why

Every green commit on `main` today costs the same, whatever it touched:

- The `docker` matrix builds all five images (`backend gateway web updater livetv`, `ci.yml:356`) without cache (`ci.yml:440`),
  `mediaserver-image` builds the sixth, `reproducible` rebuilds four of them from scratch, and `test (22|26)`, `e2e` and `dast` run in
  full. Measured on the last three green `main` runs (2026-11-16/17): `e2e` 27–33 min, `test (22)` 17–20 min, `test (26)` 13–20 min,
  each image build 1.4–4.4 min, each reproducible rebuild under 1 min, each publish leg about 45 s. Wall clock is about 34 min,
  set by `e2e`; about 90 runner minutes per run.
- Every image differs on every commit, even when its code did not change: `GIT_SHA`, `BUILD_TIME`, `APP_VERSION`, `APP_CODENAME`
  become `ENV` in every image (`backend/Dockerfile:28-33`, the same in the other four), `metadata-action` stamps
  `org.opencontainers.image.revision` (= the run's commit) and `.version` into every config (`ci.yml:411-419`), `backend` and `web`
  copy `version.json` (`backend/Dockerfile:48`, `web/Dockerfile:14`), and the web build names itself after `GIT_SHA`
  (`web/src/lib/version/kit-version.ts`).
- A release rebuilds everything once more: `scripts/release.mjs` writes the new version into every `package.json` and
  `package-lock.json` (`release.mjs:25`), which every Node image copies (`backend/Dockerfile:6-11`), and CI then runs in full for the tag.
- The updater pulls, cosign-verifies and recreates `bootstrap backend gateway web` (+ `livetv`) on every update (`updater/src/job.ts:317-353`,
  `policy.ts:11`), so a web-only nightly restarts the gateway (open streams drop) and the backend (sessions, warm caches).

Over the last 30 days `main` got 157 first-parent commits: 17 release commits, and of the other 140 only 16 touched the shared Node
inputs (lockfile or a `package.json`); `backend` inputs changed in 71 (including those 16), `web` 87, `gateway` 25, `livetv` 23,
`updater` 20, `mediaserver` 1; 35 touched no image at all, 4 only docs. So about 226 of 700 Node image builds were needed (32 %).

## Owner decisions (binding)

1. **Approach A**, as below. Rejected: B (only a docs-only shortcut) and C (a version number per service).
2. **CI works out per commit which images the changed files affect** and builds only those. Unchanged images get the new tags
   pointed at their last published digest, without a rebuild.
3. **The commit id moves out of the images**, so an unchanged image stays byte-identical across commits; the version number moves
   out of every image but the backend (decision 11).
4. **A release re-tags the images of the commit before it**; the release commit only bumps `version.json` and `CHANGELOG.md`. The only
   rebuild is the backend's, because it carries the version (decision 11).
5. **The updater compares digests first** and pulls, cosign-verifies and restarts only changed services; *Admin → Update* shows
   "unverändert" for the rest.
6. **Safety:** a change to the lockfile, root build files or shared code rebuilds every affected image; base-image security fixes
   arrive as Dependabot Dockerfile bumps, which count as a change.
7. **Docs-only shortcut:** a commit that touches only docs skips tests, `e2e` and image builds.
8. **Required check names stay** (`docker (backend|gateway|web)`, `reproducible (…)`, `test (22|26)`, `e2e`, `dast`, `secrets`).
   Unchanged legs still run and finish fast with "unverändert"; no workflow-level path filter (it leaves required checks pending).
9. **FriendFlix keeps one user-visible version number.**
10. **The media server image follows the same rule** (built only when `mediaserver/` changes, else its last digest is carried) and
    then becomes a required part of releases.
11. **No extra release container, no `friendflix-release` package, no stack manifest image** ("just makes it bigger; we already have
    version numbering"). `APP_VERSION`/`APP_CODENAME` from `version.json` stay baked into the **backend image only**; `version.json`
    is a backend input. Other images carry only their image commit. Whether something is new is decided per service by digest.
    Media server pins stay a label on the backend image, as the media server spec says. Manual and Portainer installs need no edit.
12. **`RELEASE_TOKEN` is configured**: release pushes start CI for `main` and the tag themselves.

## Goals

1. Each image is built, gate-scanned, rebuilt for `reproducible`, signed and attested only when its inputs changed.
2. An unchanged image is the same digest on `nightly`, `sha-<7>`, `X.Y.Z`/`X.Y`/`X`/`latest`, and in the running stack.
3. A release costs one backend build plus re-tags, and is exactly the `nightly` build of its commit.
4. An update pulls, verifies and restarts only what changed; rollback does the same backwards.
5. One version in the footer, `/api/version`, *Admin → Update* and the updater: the backend's, for every kind of install.
6. The required checks keep their names and never stay pending; a broken plan fails closed.

## Non-goals

- Splitting `test (22|26)` per workspace (lint and typecheck are global) and sharding `e2e` (separate work).
- Gating `desktop-*`, `tizen-check`, `webos-check`, `compose` or `android.yml` by path. They are not required, so a job-level `if:` is
  safe there, but `*-release` jobs `need` them on tags; a follow-up can do it with that in mind (`desktop-app` alone is 5–6 runner min).
- Per-service version numbers or releases (approach C); a stack manifest of any kind (decision 11).
- A preview of "what this update will change" beyond the per-service "Update verfügbar / unverändert" list.

## Anti-goals

- **A stale image shipped:** an input the change map does not know, so a real change is carried instead of built.
- **A digest published that this repository never signed**, or a signature the updater's `cosign verify` rejects after tags moved.
- **A required check that stays pending or is "skipped" into green** because the plan job failed.
- **A release image nobody ran on `nightly`:** a tag run that builds (one documented exception: a tag whose commit was never
  published from `main`, *Release flow*).
- **Two versions on screen**, or a version shown by an image that does not carry it.
- **New unpinned third-party actions.** Nothing like a path-filter action; the plan is our own script.
- **Moving `latest` or a `sha-<7>` tag to bytes from another source commit** (the weekly rebuild check may move `nightly`/`sha-<HEAD7>`
  to a rebuilt image of the *same* inputs; *Periodic rebuild*).

## Constraints

- **Image inputs** (Dockerfiles, `.dockerignore`): all five Node images copy `package.json`, `package-lock.json`, `tsconfig.base.json`
  and the five workspace `package.json` files, then their own workspace (`COPY backend backend` etc.). `backend` also copies
  `version.json` and `deploy/authentik/*.yaml`; `web` copies `version.json` and `codenames.json`; `livetv` builds `livetv/native`;
  `mediaserver` copies only `mediaserver/NOTICE`, downloads checksum-pinned debs (`mediaserver/Dockerfile:28-41`) and puts its
  `ARG GIT_SHA` into `org.opencontainers.image.revision` (`:53,93`). `.dockerignore` drops `docs`, `e2e`, `android`, `desktop`, `tizen`,
  `webos`, `tv-shared`, `.github`, `backend/test`, coverage; it does not drop `*.md`.
- **Unpinned OS packages** reach images without a Dockerfile change: `apk add ffmpeg` (backend), `docker-cli docker-cli-compose cosign`
  (updater), `zlib/musl` as minimum versions, `jellyfin-ffmpeg7` and the Jellyfin key from live repositories (livetv). Dependabot's
  docker ecosystem runs monthly with a 7-day cooldown (`.github/dependabot.yml`).
- **Index vs image digest:** the published digest is the index (image manifest + BuildKit SBOM/provenance manifests that carry build
  times); only the linux/amd64 image manifest reproduces (`ci.yml:442-445`, `docs/reproducible-builds.md`).
- **Concurrency** (`ci.yml:36-38`): runs on `main` publish one after another; tags have their own group, so a release commit's `main`
  run and tag run start together.
- **Publish** (`publish.yml:94-137`) re-tags `ci-<sha>` per image in parallel legs, then `cosign sign` (keyless; identity
  `publish.yml@refs/heads/main` or `@refs/tags/vX.Y.Z`) and two GitHub attestations; `services` is an allow-list (`publish.yml:43-48`).
- **Updater:** verifies with `cosignIdentity()` (`policy.ts:103-108`: `main` or a plain `vX.Y.Z` tag), records `previous` as `sha-<7>` of
  the backend's baked `GIT_SHA` (`job.ts:319-321`), judges health by `/health` `version === GIT_SHA[0:7]` (`server.ts:139`, `app.ts:278`),
  recreates with `compose up -d --no-deps --pull never` (`docker.ts:308-309`); self-update already compares `RepoDigests`
  (`job.ts:446-447`). Compose recreates a named service when its image id **or its config hash** changed, and the image string
  (`…:${FF_TAG}`) is part of that hash: a new `FF_TAG` recreates every named service even when the image id is the same.
- **Baked consumers:** backend version (`version.ts:51-56`), build kind "tag `v<version>` points at `GIT_SHA`" (`channel.ts:27-31`),
  nightly distance from `GIT_SHA` (`updates.ts:101`), `builtAt` from `BUILD_TIME` (`updates.ts:136`), Portainer result from "`GIT_SHA`
  changed" and `onNew` (`redeploy.ts:211,218`), error log release (`errorlog.ts:69`); updater's own `version`/`gitSha`
  (`updater/src/config.ts:64-68`); livetv `version` on its health route (`livetv/src/config.ts:63`); per-service `sha`/`version` in the
  updater's `/v1/status` (`docker.ts:465`, `server.ts:150-156`); web footer from `version.json` at build (`web/src/lib/version/codenames.ts:8-9`),
  then `/api/version` (`build.ts`). The gateway's `/health` reports nothing but `ok` (`gateway/src/gateway.ts:631`).
- **Networks:** the backend shares `front` with `web` and `gateway` and `livetv` with livetv (`compose.prod.yaml`), so it can ask them.
- **Tests that read docs:** `updater/test/livetv.test.ts:660-667`, `backend/test/syscheck-core-media.test.ts:326-335`,
  `scripts/proxy-config.test.mjs:51`. `npm run test:scripts` runs every `scripts/*.test.mjs`.
- **Required checks** (`docs/operations.md:284-293`): `test (22)`, `test (26)`, `e2e`, `dast`, `secrets`, `docker (backend|gateway|web)`,
  `reproducible (backend|gateway|web)`. A job skipped because a `needs` failed counts as passed for a required check.
- `scripts/reproduce-image.sh` reads `BUILDKIT_IMAGE` from `ci.yml` and the build-arg `ENV`s of the image it compares with.

## Approaches

- **A. Per-image change detection and content-addressed images (chosen, decision 1).** Saves image builds, reproducible rebuilds,
  `e2e`/`dast` when `web` is untouched, most of a release, docs commits, and restarts on update.
- **B. Docs-only shortcut alone (rejected by the owner).** 4 of 140 commits were docs-only; it leaves every update restarting everything.
- **C. A version per service (rejected by the owner).** Several numbers to explain, release notes per service, and the apps would
  have to name which server parts they need.
- **A stack manifest in a carrier image (rejected by the owner, decision 11).** It would have spared the backend its release rebuild
  but added a container and a package to every install.
- **Change detection: our own script (Controller's call)** over a third-party path-filter action: the map also feeds build arguments,
  the guard tests and the test selection, needs `.dockerignore` exclusions, and every new action is one more pinned dependency.

## Decisions

### The change map

- **One checked-in map** (`.github/images.json`, Controller's call: next to the workflows that read it, outside every build context)
  lists per image: its Dockerfile, its input globs, whether it is required, and whether `reproducible` covers it. Shared groups:
  - **node-common** (all five Node images): `package.json`, `package-lock.json`, `tsconfig.base.json`, the five workspace `package.json`.
  - **all images**: `.dockerignore`, the composite build action (next point) and the BuildKit pin.
  - **backend**: `backend/**` minus `backend/test/**`, `deploy/authentik/*.yaml`, `version.json` (decision 11), the media server pin
    sources (`mediaserver/pins/jellyfin/Dockerfile` from the media server spec) and, through the Ferrofin pin, the **mediaserver** inputs.
    **gateway**: `gateway/**`. **web**: `web/**`, `codenames.json`. **updater**: `updater/**`. **livetv**: `livetv/**`.
    **mediaserver**: `mediaserver/Dockerfile`, `mediaserver/NOTICE` (not node-common; `try.sh`, `probe.sh`, `patches/*.md` are not inputs).
  - Excluded everywhere: `**/*.md` (and `.dockerignore` gains `**/*.md`, so it is true), and whatever `.dockerignore` drops. PR 1 adds
    the other workspaces' test folders to `.dockerignore` where their build does not read them (fewer needless rebuilds).
- **Image-affecting CI settings move out of `ci.yml`** into a local composite action `.github/actions/build-image` (build args,
  labels, outputs, SBOM/provenance flags) plus the BuildKit pin (Controller's call: `ci.yml` changed in 16 of 140 commits, mostly
  test or TV jobs; a composite action keeps the check names, a reusable workflow would rename them). `reproduce-image.sh` reads the
  pin from its new place, falling back to `ci.yml` for old refs.
- **`scripts/changed-images.mjs`** (Node, no dependencies, like `release.mjs`) computes the plan; **`scripts/changed-images.test.mjs`**
  runs in `npm run test:scripts`. It covers globs, exclusions, merge commits, the change classes, and two guards:
  - **COPY guard:** every `COPY`/`ADD` source (not `--from`) and every build argument fed from a repository file must be covered by
    that image's inputs. Over-inclusion costs a rebuild; under-inclusion fails the test.
  - **Docs-reader guard:** a test file that reads `docs/` must be in `test:docs` (below).
- Changing the map or the script makes the run **full** (everything rebuilt and tested), so a map mistake shows in the PR that makes it.

### Image identity

- Each image's identity is its **image commit**: the newest commit that changed its inputs (`git log -1` over the input pathspecs at
  the run's commit; `fetch-depth: 0`). Equal image commits mean equal inputs; a revert costs one rebuild, never a miss.
- Builds take `FF_IMAGE_COMMIT` = image commit and `SOURCE_DATE_EPOCH` = its commit time (Controller's call, instead of the run's
  commit): a rebuild of unchanged inputs at any later commit then reproduces the carried image manifest bit for bit, which the
  weekly check and the burn-in use as proof. Every image carries `ENV FF_IMAGE_COMMIT`, `org.opencontainers.image.revision` = image
  commit and `created` = its time; `GIT_SHA`, `BUILD_TIME` and the `.version` label go from all images, including `mediaserver`'s
  `ARG GIT_SHA` (`:53,93`). Rename instead of reusing `GIT_SHA` (Controller's call): the meaning changed; readers fall back to
  `GIT_SHA` only for images from before the change.
- **Backend only** also carries `APP_VERSION`/`APP_CODENAME` (build args from `version.json`), `version.json` and the media server pin
  label (decision 11). `web` no longer copies `version.json` and names its SvelteKit build after `FF_IMAGE_COMMIT`, so its service
  worker cache only turns over when `web` changed.
- **`release.mjs` stops writing versions into `package.json`/`package-lock.json`**; they are set once to `0.0.0` (Controller's call:
  nothing reads them; otherwise every release would rebuild all five Node images). `version.json` is the only version file.

### The installed build

The backend's own image commit says nothing about a newer `web` or `gateway`, so "which build runs" is the **installed build**: the
newest image commit among the running FriendFlix services (Controller's call; any commit after it that touched an image input would
have produced a newer image). The backend learns the services' image commits from the updater's `/v1/status` when there is one,
else by asking them directly (`web`'s `/_app/version.json`, `gateway`'s `/health` gaining an `image` field, livetv's health), else
it uses its own. Cached like the update check (10 min).

### Where version and commit come from now

| Consumer | Today | After |
|---|---|---|
| version and codename: `/api/version`, footer, *Admin → Update*, error log, setup | baked `APP_VERSION` (all images) | baked `APP_VERSION` in the backend only (unchanged code path) |
| web footer, device caps (`APP_VERSION` in web) | `version.json` at build | `/api/version`; nothing shown until it answers |
| build kind and nightly label (`channel.ts`) | tag commit == `GIT_SHA` | tag commit == installed build (`3.6.0-nightly · <installed build7>`) |
| commits behind (`updates.ts:101`) | `GIT_SHA…main` | installed build `…` latest green `main` run |
| update available, nightly | behind > 0 | with the updater: a service's installed digest ≠ the registry digest of the channel tag; without: behind > 0 |
| `builtAt` (`updates.ts:136`) | `BUILD_TIME` | the installed build's commit time |
| backend `/health` | `GIT_SHA[0:7]` | backend image commit7 (field name kept) |
| updater health (`waitHealthy`) | `/health` == new `GIT_SHA7` | that check only when the backend changed; otherwise container health |
| updater `previous`, rollback | `sha-<backend GIT_SHA7>` | each service's digest before the update (an old `sha-<7>` state rolls back as today) |
| updater's own `version`/`gitSha` (`config.ts:64-68`) | baked env | no version; its image commit |
| livetv `version` (`livetv/src/config.ts:63`) | `APP_VERSION` | its image commit |
| per-service `sha`/`version` in `/v1/status` (`docker.ts:465`, `server.ts:150-156`) | baked env | digest, image commit, registry digest of the channel tag; version only for the backend |
| Portainer judge `newBuild`/`onNew` (`redeploy.ts:211,218`) | `GIT_SHA` changed / `sha` ≠ `sha-<from7>` | installed build changed / a service's digest or image commit differs from the value recorded at the start |
| media server pins | label on the backend (media server spec) | unchanged: backend label; a pin change is a backend input change |
| OCI labels, SBOM, provenance | per run | per image commit (they describe the build that made the bytes) |
| `reproduce-image.sh --compare` | rebuild at the run's commit | rebuild at the image's `revision` label (`--ref` optional) |

### Comparison base

- **Push and publishable dispatch:** the **base commit** is the newest first-parent ancestor C of the run's commit for which every
  image has a `sha-<C7>` tag (for a tag run: the tagged commit itself, *Release flow*); at most 50 steps back, else everything builds.
  For each image the base is that tag's digest and its `revision` label; both must pass `cosign verify` with the updater's identity
  rule. An image is **carried** when its image commit equals that label, else **built**. A failed or dropped run never published its
  `sha-<7>`, so the next run compares with what was really published.
- **Change classes on push** (docs mode, `e2e`, `dast`, the tag guard) use the files changed between the base commit and the run's
  commit (Controller's call), so a dropped or failed run's changes are tested in full by the next run, never only in docs mode.
- **Pull requests:** image commits at the PR head vs at `pull_request.base.sha` (no registry read; works for forks).
- **Other dispatches** (not `main`, not a tag): full. **Manual:** `workflow_dispatch` input `full` (main only). **Weekly:** below.

### Change classes and which jobs do real work

The plan job (`changes`, first in `ci.yml`, ~30 s) outputs per image `build | carry` with the reason, and these classes:

| Changed files (since the base) | `test (22)`, `test (26)` | `e2e` | `dast` | images |
|---|---|---|---|---|
| only docs (`docs/**`, `**/*.md`) | `test:docs` + `test:scripts` | unverändert | unverändert | all carried |
| only `version.json` (+ docs) | `test:docs` + `test:scripts` | unverändert | unverändert | backend built, rest carried |
| anything else | full | full if `web` builds, `e2e/**` or a workflow/action changed | full if `web` builds, `.zap/**` or a workflow/action changed | as the map says |
| map/script, `full`, weekly | full | full | full | rebuild (weekly: not `livetv`/`mediaserver`); publish only differing bytes |

- `version.json` alone gets docs-mode tests (Controller's call): its only effect is the backend's baked version string, which the
  backend leg's smoke test, scan and `reproducible` check cover; the TV, Android and desktop release jobs read it on the tag as today.
- `test:docs` (new npm script) runs exactly the tests that read docs; the docs-reader guard keeps it complete.
- `secrets` always runs in full. `compose`, `tizen-check`, `webos-check`, `desktop-*` are unchanged (*Non-goals*).

### CI job shape

- **No `paths`/`paths-ignore` on the workflow, no job-level `if:` on a required job.** Every required leg starts, reads the plan, and
  either does the work or prints `unverändert (wie <image commit7>, <digest>)` to its log and step summary and exits green.
- **Fail closed:** required jobs `need: changes` with `if: ${{ !cancelled() }}`; their first step fails when `changes` did not succeed or
  its output does not parse. A broken plan turns checks red, never "skipped" (which would pass).
- **`docker (mediaserver)`** (Controller's call) is its own job with that name (replacing `mediaserver-image`), because the backend pins
  its digest: the `docker` matrix (`backend gateway web updater livetv`) needs it and the backend leg reads its digest, built or
  carried. It keeps its base-pin step and report-only Trivy and stays out of `reproducible`. The backend also builds when the
  Ferrofin digest it would pin differs from the carried backend's pin label.
- **Each `docker (x)` leg:**
  - *build:* as today via the composite action; on push the candidate is `ci-<sha>`; smoke tests as today.
  - *carry, push:* point `ci-<sha>` at the carried digest (`imagetools create`, no new bytes) and run the Trivy gate on it (a CVE
    published since its build still blocks, as today). If the gate fails, rebuild once in the leg and gate the new image
    (Controller's call: picks up fixed Alpine/Debian packages; a vulnerable npm dependency still fails). Not on tag runs.
  - *carry, PR:* nothing to build or scan; "unverändert".
- **`reproducible (x)`**: built images as today; carried ones "unverändert" (they were proven when built).
- **`publish`** needs everything as today plus `docker (mediaserver)`; `publish-mediaserver` disappears. `docs/operations.md` adds
  `docker (mediaserver)` to the required checks (decision 10) and drops `mediaserver-image` and `publish-mediaserver / …`.

### Publishing, tags and signatures

- `publish.yml` keeps reading `ci-<sha>` for every image, built or carried, and the tag rules stay: `nightly` + `sha-<7>` on `main`,
  `X.Y.Z`/`X.Y`/`X` (+ `latest` for the highest plain version) + `sha-<7>` on a tag. The default list gains `mediaserver`.
- **Signing (Controller's call):** on `main`, sign and attest only built digests (carried ones already have a `main` signature from
  their build; re-signing every commit would grow each digest's signature list without bound). On a **tag**, sign and attest every
  image's digest once from the tag ref, so the documented `cosign verify --certificate-identity …@refs/tags/vX.Y.Z`
  (`docs/operations.md`, *Images prüfen*) passes for every image of a release. The updater verifies per image as today.
- **Order (Controller's call):** the per-image legs sign and attest but move no tag; a final job verifies every image of the set with
  the updater's exact rule and then moves all tags in one step. A verify failure moves no tag, and the window in which `nightly`
  points at a mixed set shrinks from the length of the publish matrix to seconds.
- **`ci-<sha>` pruning** keeps working: a carried digest stays reachable through `nightly`, `sha-<7>` and release tags.

### Release flow

- **Precondition** (`release.yml`, Controller's call): `main`'s head must be published (`sha-<head7>` on every image, verified). While
  its CI run is still going the workflow waits up to 60 min (the e2e budget plus publish), on failure it refuses ("erst `main` grün
  machen"). Its `timeout-minutes` rises from 10 to 75 for that wait. Then it commits only `version.json` + `CHANGELOG.md` and tags;
  the `RELEASE_TOKEN` push starts both runs (decision 12).
- **`main` run of the release commit:** only `version.json` changed, so the backend is built (with the new `APP_VERSION`), the rest is
  carried, tests run in docs mode; `nightly` and `sha-<rel7>` move. About 8 min instead of 35.
- **Tag run:** carries **everything** from `sha-<rel7>`, so a release is exactly the `nightly` build of its commit and there is one
  backend digest per commit (Controller's call). Its `changes` job waits for the `main` run to publish `sha-<rel7>` (up to 45 min) and
  fails, telling to re-run, if that run failed. **Guard:** a tag run never builds when its commit was published from `main`.
- **Exception:** a tag on a commit never published from `main` (a hand-made backport on a side branch) compares with its nearest
  published ancestor and builds what differs; it is logged as such.
- **Release candidates** (`vX.Y.Z-rc.N`, by hand; unchanged from today): carried like a release, published with the `X.Y.Z-rc.N` tag;
  the updater never installs them (its signer rule names only plain `vX.Y.Z`, `policy.ts:105`; `TAG_RE` has no rc). `parseVersion`
  in `release.mjs` stays as it is.
- Android, desktop, Tizen and webOS release jobs on the tag are unchanged.

### Updater

- **`FF_TAG` stays the channel tag** (`latest`, `nightly`, `X.Y.Z`), as today (Controller's call: a per-build tag would change every
  service's image string and so compose's config hash, recreating all of them).
- **Compare first:** for each FriendFlix service (`bootstrap` follows `backend`; `livetv` while enabled; `updater` only on self-update)
  read the registry digest of `<repo>:<channel tag>` (manifest only, no layers) and compare it with the running container's
  `RepoDigests`. Equal → **unverändert**, no pull, no verify. Different → **changed**: pull `<repo>@sha256:<that digest>`,
  `cosign verify`. Any verify failure aborts before any tag moves or anything restarts. Pulling by digest means a tag that moves
  during the update cannot slip a different image in.
- **Move the local tags:** after every changed image is pulled and verified, point each service's local channel tag at its digest
  (`docker tag <repo>@sha256:… <repo>:<channel tag>`, through the socket proxy's image routes). An unchanged service keeps its image id.
- **Restart:** `compose up -d --no-deps --pull never` for all FriendFlix services; compose recreates only those whose image id or config
  changed (a `.env` edit still applies, as today; a channel switch changes the image string and recreates everything once). The job
  records per service "aktualisiert" or "unverändert" by container id; nothing changed → "alles unverändert", nothing restarted.
- **Health:** every FriendFlix service running and healthy (compose), each recreated container on its target digest; when the backend
  changed, `/health` must also answer with the new backend image commit7 (read from the pulled image's `FF_IMAGE_COMMIT`, falling back
  to `GIT_SHA` for old images). Same 3-minute budget.
- **State and rollback:** before restarting, the state records each service's running digest (`previous`). Rollback and auto-rollback
  move the local channel tags back to those digests (pulling by digest if an image was pruned) and run `up` again, so only the services
  the update changed are recreated. A `previous` from before the change (`sha-<7>`) rolls back as today.
- **`/v1/status`** reports per service: digest, image commit, registry digest of the channel tag (cached 10 min), and the backend's
  version; *Admin → Update* shows "Update verfügbar" per changed service and "unverändert" for the rest, before and after a job.
- **livetv:** same rule; enabling takes the channel tag's digest; it stays optional and never fails a core update. **Self-update** keeps
  its `RepoDigests` check, now before pulling, and moves the updater's local tag the same way before its helper recreates it.

### Manual installs and Portainer

No compose edit. `docker compose pull && up -d` and Portainer's redeploy with pull already benefit: an unchanged image keeps its image
id and `FF_TAG` is unchanged, so compose leaves that container running. The version is the backend's, as today. `redeploy.ts` records
the installed build and each service's image commit (and digest where the updater lists services) at the start and judges progress
by those instead of `GIT_SHA`.

### Media server (builds on the managed media server spec)

- `mediaserver` is a normal, required image: built only when its inputs change (Dependabot base bumps included), else carried. Its
  digest is always available, so "a build without it carries no `ferrofin` pin" no longer happens.
- The pins stay the backend label the media server spec defines (decision 11); the backend build reads the Ferrofin digest from
  `docker (mediaserver)` and the Jellyfin pin from its file, both backend inputs. A pin change therefore rebuilds the backend and moves
  with the normal update (that spec's decision 9). Its "not run by the updater" trigger ("the backend build changed since last seen")
  still works, since every pin change changes the backend.

### Periodic rebuild (Controller's call)

Weekly scheduled run on `main` (Sunday night): rebuild `backend gateway web updater` at `main`'s head with their image commits,
compare the new **image manifest** digest with the carried one, and publish only images whose bytes differ (fixes for the unpinned
Alpine packages). Equal → the carried index digest stays (no restart anywhere). A build failure of an unchanged image is a warning
(the carried digest stays valid), so build rot shows within a week. Reason: Dependabot is monthly and does not see apk drift; today
every commit rebuilt, so this keeps the fix latency at about a week for one extra run.

- **`livetv` and `mediaserver` are not in the weekly comparison:** they are not reproducible, so every weekly rebuild would publish new
  bytes and restart them (and, through the pin, the backend) for nothing. They rebuild when their inputs change; a fixable CVE still
  triggers the one automatic rebuild in their leg.
- **A forced "build all"** (`full`, map or script change) follows the same rule: an equal image manifest keeps the carried index digest.

### Expected savings

On last month's 157 commits: Node image builds and reproducible rebuilds drop to about a third (226 of 700); `e2e` (27–33 min, the wall
clock) is skipped on the ~38 % of commits that leave `web` and `e2e/` alone; docs commits and the 17 release commits drop from ~90
runner min each to a few (a release: one backend build). Wall clock stays ~34 min whenever `web` changed. On update, a typical nightly
restarts one or two services instead of four or five, and a web-only update no longer drops the gateway's streams or restarts the backend.

## Risks and how each is prevented

| Risk | Prevention |
|---|---|
| Stale image (input missing from the map) | COPY guard test; image commit covers `.dockerignore`, build action, BuildKit pin; burn-in; weekly rebuild flags any byte change |
| Carrying a digest the repo never signed | every base digest must pass the updater's `cosign verify` rule, else build |
| Broken signature chain after tags moved | verify-all in one final job before any tag moves; every image signed once per release tag |
| Required checks pending or "skipped" into green | no workflow path filters, no job-level skip on required jobs; `!cancelled()` + explicit plan check |
| Release ships untested bytes | release precondition; tag run carries `sha-<rel7>` and never builds |
| Compose recreates every service | `FF_TAG` stays the channel tag; the local tag moves per service |
| Updater installs a mixed set | pull by digest; tags move together in seconds at publish; a later update completes the set |
| Wrong nightly label or "behind" | the installed build is the newest image commit of all running services, not the backend's alone |
| A new CVE in a long-carried image | Trivy gate on carried digests every publish; one automatic rebuild; weekly rebuild |

## Testing

- `scripts/changed-images.test.mjs` with a throwaway git repository in a temp dir: image commits across merges, reverts and exclusions;
  each change class; the base-commit walk; the COPY and docs-reader guards against the real Dockerfiles and tests.
- **Burn-in before skipping (Controller's call):** PR 2 still builds everything, but the plan already runs in report mode; for every
  image of `backend gateway web updater` it calls "carry", the rebuilt image manifest digest is compared with the carried one, and
  every mismatch is diagnosed with `reproduce-image.sh --diff`. **Counter rule:** a run counts when there is no mismatch or each one
  differs only in files owned by OS packages (paths outside `/app`, e.g. from `ffmpeg`, `docker-cli`, `cosign`, `zlib`/`musl`: expected
  drift). A mismatch in anything else (a file under `/app`, the config's env or labels) is a missing map input: the input is added and
  the counter resets to 0. PR 3 merges after 20 consecutive counting `main` runs. livetv and mediaserver: the COPY guard.
- Updater (fake `Ops`, `job.ts` tests): nothing changed, one changed, backend unchanged (container health only), verify failure of
  one, local tag moves and rollback re-tag, old `sha-<7>` previous, channel switch, livetv on/off, self-update. Backend: installed
  build from the updater, from the probes and alone; `channel.ts`, `updates.ts`, `redeploy.ts`. Web: footer without baked version.
- `release.yml`: precondition and tag-run wait as tested functions in `release.mjs`/`changed-images.mjs`; one dry run on a fork.

## Order of work

Each PR is mergeable alone and leaves `main` releasable.

1. **Map and plan, report only:** `.github/images.json`, `changed-images.mjs` + tests, `.dockerignore` (`**/*.md`, test folders),
   `test:docs`, the composite build action, the `changes` job printing its plan. Nothing is skipped yet.
2. **Commit out of the images:** `FF_IMAGE_COMMIT` + its time as build inputs, labels fixed, `version.json` out of `web`, version only in
   the backend, `release.mjs` stops touching `package.json`; the installed build (gateway `/health` field, probes), every consumer in
   the table, `reproduce-image.sh`. Still builds everything; the burn-in starts.
3. **CI carries (after the burn-in):** build-or-carry legs, `ci-<sha>` on carried digests, Trivy auto-rebuild, base-commit walk and
   test classes, docs-only shortcut, `docker (mediaserver)` job, publish signing order and final tag job, `full` input, weekly
   rebuild, release precondition and tag-run wait, `docs/operations.md` (required checks, release, channels, updater flow,
   verification) and `docs/reproducible-builds.md`.
4. **Updater changed-only:** registry digest compare, pull by digest, local tag moves, per-service status and report, rollback by
   re-tag, health rule; *Admin → Update* "unverändert". Independent of 3 (with everything rebuilt it simply finds everything changed).

The media server pin wiring (backend build reading the `docker (mediaserver)` digest) lands with media server stage 1 or PR 3, whichever
comes second.

## Left to the builder

- The exact shapes of `images.json` and the plan output; the field name on the gateway's `/health`.
- How the updater reads a tag's registry digest (registry API with a pull token, or `docker manifest inspect`), within its egress.
- Which test folders can join `.dockerignore` per workspace (check each `tsconfig` and build).
- Poll intervals of the release precondition and the tag-run wait; the schedule minute of the weekly run.
- The German texts ("unverändert", "aktualisiert", "alles unverändert", "Update verfügbar", the release refusal), then the other six languages.

## Questions only the owner can answer

None open. Answered on 2026-11-17: no extra release container (decision 11), `RELEASE_TOKEN` is configured (decision 12); the compose
edit question fell away with the container.
