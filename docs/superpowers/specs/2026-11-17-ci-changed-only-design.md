# Build and redeploy only what changed

Status: requested by the owner on 2026-11-17 ("only build containers and redeploy them if they have had changes … to save CI
times as well as redeploy time"); the owner chose approach A and the rules listed under *Owner decisions* (binding). Everything
else is marked **Controller's call** with its reason. Related: `2026-11-17-managed-mediaserver-design.md` (owner decisions 9 and 12
there), which this spec amends in *Media server* below.

## Why

Every green commit on `main` today costs the same, whatever it touched:

- The `docker` matrix builds all five images (`backend gateway web updater livetv`, `ci.yml:356`) without cache (`ci.yml:440`),
  `mediaserver-image` builds the sixth, `reproducible` rebuilds four of them from scratch, and `test (22|26)`, `e2e` and `dast` run in
  full. Measured on the last three green `main` runs (2026-11-16/17): `e2e` 27–33 min, `test (22)` 17–20 min, `test (26)` 13–20 min,
  each image build 1.4–4.4 min, each reproducible rebuild under 1 min, each publish leg about 45 s. Wall clock is about 34 min,
  set by `e2e`; about 90 runner minutes per run.
- Every image differs on every commit, even when its code did not change: the build arguments `GIT_SHA`, `BUILD_TIME`,
  `APP_VERSION`, `APP_CODENAME` become `ENV` in every image (`backend/Dockerfile:28-33`, the same in the other four), `metadata-action`
  stamps `org.opencontainers.image.revision` (= the run's commit) and `.version` into every config (`ci.yml:411-419`), `backend` and
  `web` copy `version.json` (`backend/Dockerfile:48`, `web/Dockerfile:14`), and the web build names itself after `GIT_SHA`
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
3. **Version number and commit id move out of the images**, so an unchanged image stays byte-identical across commits.
4. **A release re-tags the images of the commit before it**; the release commit only bumps version files and `CHANGELOG.md`. No rebuild.
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

## Goals

1. Each image is built, scanned for the gate, rebuilt for `reproducible`, signed and attested only when its inputs changed.
2. An unchanged image is the same digest on `nightly`, `sha-<7>`, `X.Y.Z`/`X.Y`/`X`/`latest`, and in the running stack.
3. A release is a re-tag of a published, green `main` commit: minutes, not half an hour, and never a build nobody tested on `nightly`.
4. An update pulls, verifies and restarts only what changed; rollback does the same backwards.
5. One version (`3.6.0`, `3.6.0-nightly · abc1234`) in the footer, `/api/version`, *Admin → Update* and the updater, for updater,
   manual and Portainer installs alike.
6. The required checks keep their names and never stay pending; a broken plan fails closed.

## Non-goals

- Splitting `test (22|26)` per workspace (lint and typecheck are global; a per-workspace split is a later lever).
- Sharding `e2e` (it sets the wall clock whenever `web` changed; separate work).
- Gating `desktop-*`, `tizen-check`, `webos-check`, `compose` or `android.yml` by path. They are not required, so a job-level `if:` is
  safe there, but `*-release` jobs `need` them on tags; a follow-up can do it with that in mind (`desktop-app` alone is 5–6 runner min).
- Per-service version numbers or per-service releases (owner decision 9; approach C).
- A preview of "what this update will change" before *Jetzt aktualisieren* (the job reports it; a preview is a later route).

## Anti-goals

- **A stale image shipped:** an input the change map does not know, so a real change is carried instead of built.
- **A digest published that this repository never signed**, or a signature chain the updater's `cosign verify` rejects after tags moved.
- **A required check that stays pending or is "skipped" into green** because the plan job failed.
- **A release image nobody ran on `nightly`:** a tag run that builds instead of re-tagging (one documented exception: a tag whose
  parent was never published, *Release flow*).
- **Two versions on screen** (the backend's baked one and the stack's).
- **New unpinned third-party actions.** Nothing like a path-filter action; the plan is our own script.
- **Moving `latest` or a `sha-<7>` tag to bytes from another source commit** (the weekly rebuild check is the one case where
  `nightly`/`sha-<HEAD7>` may move to a rebuilt image of the *same* commit; *Periodic rebuild*).

## Constraints

- **Image inputs** (Dockerfiles, `.dockerignore`): all five Node images copy `package.json`, `package-lock.json`, `tsconfig.base.json`
  and the five workspace `package.json` files, then their own workspace (`COPY backend backend` etc.). `backend` also copies
  `version.json` and `deploy/authentik/*.yaml`; `web` copies `version.json` and `codenames.json`; `livetv` builds `livetv/native`;
  `mediaserver` copies only `mediaserver/NOTICE` and downloads checksum-pinned debs (`mediaserver/Dockerfile:28-41`). `.dockerignore`
  drops `docs`, `e2e`, `android`, `desktop`, `tizen`, `webos`, `tv-shared`, `.github`, `backend/test`, coverage; it does not drop `*.md`.
- **Unpinned OS packages** reach images without a Dockerfile change: `apk add ffmpeg` (backend), `docker-cli docker-cli-compose cosign`
  (updater), `zlib/musl` as minimum versions, `jellyfin-ffmpeg7` and the Jellyfin key from live repositories (livetv). Dependabot's
  docker ecosystem runs monthly with a 7-day cooldown (`.github/dependabot.yml`).
- **Index vs image digest:** the published digest is the index (image manifest + BuildKit SBOM/provenance manifests that carry build
  times); only the linux/amd64 image manifest reproduces (`ci.yml:442-445`, `docs/reproducible-builds.md`).
- **Concurrency** (`ci.yml:36-38`): runs on `main` never cancel a running publish and keep only the newest pending run, so `main`
  runs publish one after another. Tags have their own group.
- **Publish** (`publish.yml:94-137`) re-tags `ci-<sha>`, then `cosign sign` (keyless; identity `publish.yml@refs/heads/main` or
  `@refs/tags/vX.Y.Z`) and two GitHub attestations; its `services` input is an allow-list (`publish.yml:43-48`).
- **Updater** verifies with `cosignIdentity()` (`policy.ts:103-108`: main or a plain `vX.Y.Z` tag), records `previous` as `sha-<7>` of the
  backend's baked `GIT_SHA` (`job.ts:319-321`), judges health by `/health` `version === GIT_SHA[0:7]` (`server.ts:139`, `app.ts:278`),
  recreates with `compose up -d --no-deps --pull never` (`docker.ts:308-309`); self-update already compares `RepoDigests`
  (`job.ts:446-447`). Compose itself recreates a named service only when its image id or config changed.
- **Backend** derives the installed version from baked `APP_VERSION` else `version.json` (`version.ts:51-56`), the build kind from "tag
  `v<version>` points at `GIT_SHA`" (`channel.ts:27-31`), the nightly distance from `GIT_SHA` (`updates.ts:101`), the Portainer
  redeploy result from "`GIT_SHA` changed" (`redeploy.ts:218`). The web footer imports `version.json` at build time
  (`web/src/lib/version/codenames.ts:8-9`) and then asks `/api/version` (`build.ts`).
- **Tests that read docs:** `updater/test/livetv.test.ts:660-667`, `backend/test/syscheck-core-media.test.ts:326-335`,
  `scripts/proxy-config.test.mjs:51`. `npm run test:scripts` runs every `scripts/*.test.mjs`.
- **Required checks** (`docs/operations.md:284-293`): `test (22)`, `test (26)`, `e2e`, `dast`, `secrets`, `docker (backend|gateway|web)`,
  `reproducible (backend|gateway|web)`. A job skipped because a `needs` failed counts as passed for a required check.
- `scripts/reproduce-image.sh` reads `BUILDKIT_IMAGE` from `ci.yml` and the build-arg `ENV`s of the image it compares with.

## Approaches

- **A. Per-image change detection, content-addressed images, a signed stack manifest (chosen, owner decision 1).** Saves image
  builds, reproducible rebuilds, `e2e`/`dast` when `web` is untouched, the whole test run on releases and docs, and restarts on update.
- **B. Docs-only shortcut alone (rejected by the owner).** 4 of 140 commits were docs-only; it saves almost nothing and leaves every
  update restarting everything.
- **C. A version per service (rejected by the owner).** Several numbers to explain, release notes per service, and Android, desktop
  and TV apps would have to name which server parts they need.

Within A, two sub-choices:

- **Change detection: our own script (chosen, Controller's call)** over a third-party path-filter action: the map must also feed
  the build arguments, the guard test and the test selection, needs exclusions from `.dockerignore`, and every new action is one more
  pinned dependency with write-adjacent access.
- **Where the version lives once it leaves the images (Controller's call): a stack manifest in a tiny signed carrier image** that the
  stack runs as a one-shot init service. Rejected: the updater as the only source (manual and Portainer installs would lose their
  version), `FF_TAG` in the backend's environment (`latest` names no version and moves before the user pulls), OCI index annotations
  (change the digest the updater compares), and an image volume mount (needs a newer Docker Engine than FriendFlix requires).

## Decisions

### The change map

- **One checked-in map** (`.github/images.json`, Controller's call: next to the workflows that read it, invisible to every image build)
  lists per image: its Dockerfile, its input globs, whether it is required, and whether `reproducible` covers it. Shared groups:
  - **node-common** (all five Node images): `package.json`, `package-lock.json`, `tsconfig.base.json`, the five workspace `package.json`.
  - **all images**: `.dockerignore`, the composite build action (next point) and the BuildKit pin.
  - **backend**: `backend/**` minus `backend/test/**`, `deploy/authentik/*.yaml`. **gateway**: `gateway/**`. **web**: `web/**`,
    `codenames.json`. **updater**: `updater/**`. **livetv**: `livetv/**`. **mediaserver**: `mediaserver/Dockerfile`, `mediaserver/NOTICE`
    (not node-common; `try.sh`, `probe.sh` and `patches/*.md` are not image inputs).
  - Excluded everywhere: `**/*.md` (and `.dockerignore` gains `**/*.md`, so it is true), and whatever `.dockerignore` drops. PR 1
    adds the other workspaces' test folders to `.dockerignore` where their build does not read them (fewer needless rebuilds).
- **Image-affecting CI settings move out of `ci.yml`** into a local composite action `.github/actions/build-image` (build args,
  labels, outputs, SBOM/provenance flags) plus the BuildKit pin (Controller's call: `ci.yml` changed in 16 of 140 commits, mostly
  test or TV jobs; a composite action keeps the check names, a reusable workflow would rename them). `reproduce-image.sh` reads the
  pin from its new place, falling back to `ci.yml` for old refs.
- **`scripts/changed-images.mjs`** (Node, no dependencies, like `release.mjs`) computes the plan; **`scripts/changed-images.test.mjs`**
  runs in `npm run test:scripts`. It covers globs, exclusions, merge commits, the change classes below, and two guards:
  - **COPY guard:** every `COPY`/`ADD` source (not `--from`) in each Dockerfile must be covered by that image's inputs, and every
    file the build context keeps must be either an input or excluded on purpose. Over-inclusion costs a rebuild; under-inclusion fails.
  - **Docs-reader guard:** a test file that reads `docs/` must be in `test:docs` (below).
- Changing the map or the script makes the run **full** (everything built and tested), so a map mistake shows in the PR that makes it.

### Image identity: the image commit

- Each image's identity is its **image commit**: the newest commit that changed its inputs (`git log -1` over the input pathspecs at
  the run's commit; full history, `fetch-depth: 0`). Equal image commits mean equal inputs; a revert costs one rebuild, never a miss.
- Builds take `FF_IMAGE_COMMIT` = image commit and `SOURCE_DATE_EPOCH` = its commit time (Controller's call, instead of the run's commit):
  then a rebuild of unchanged inputs at any later commit reproduces the carried image manifest bit for bit, which the weekly check
  and the burn-in (*Testing*) use as proof. The image carries `ENV FF_IMAGE_COMMIT`, `org.opencontainers.image.revision` = image commit,
  `created` = its time, and nothing else per run: `GIT_SHA`, `BUILD_TIME`, `APP_VERSION`, `APP_CODENAME` and the `.version` label go;
  `version.json` is no longer copied into `backend` or `web`. The web build names itself after `FF_IMAGE_COMMIT`, so the service worker
  cache only turns over when `web` changed. Rename instead of reusing `GIT_SHA` (Controller's call): the meaning changed, and readers
  fall back to `GIT_SHA` only to recognise images from before the change ("legacy").
- **`release.mjs` stops writing versions into `package.json`/`package-lock.json`**; they are set once to `0.0.0` (Controller's call:
  nothing reads them, checked; otherwise every release would rebuild everything). `version.json` is the only version file.

### The stack manifest

- **What:** `release.json`, one per published commit: schema, `version` and `codename` (from `version.json` at that commit), `commit`
  (the stack commit), its date, `images` (service → digest and image commit, all six), and `pins` (media server, *Media server*). Its
  content depends only on the commit, never on whether a `main` or a tag run wrote it, so both runs of a release commit agree.
- **Carrier:** image `friendflix-release` (same `node:26-alpine` digest as the others, so the host already has its layers; one small
  layer with `release.json`, the same JSON also as one config label so CI and the updater can read it without extracting files). Built in
  `publish.yml` after every image is resolved, tagged with exactly the same tags, cosign-signed with the same identity, no SBOM.
- **In the stack:** a one-shot service `release` in `compose.prod.yaml` (like `bootstrap`) copies the file into a read-only volume
  the backend mounts. Every `compose up` after a pull runs it, whoever pulled: updater, `docker compose pull`, or Portainer. For the
  self-built `compose.yaml` the same service builds the carrier locally from `version.json` with commit `dev`.

### Where version and commit come from now

| Consumer | Today | After |
|---|---|---|
| `/api/version`, footer, *Admin → Update* "installiert" | baked `APP_VERSION`/`GIT_SHA` | the manifest in the `release` volume, read per request (mtime-cached); else the updater's reported stack; else legacy env; else "unbekannt · <image commit7>" |
| build kind / nightly label (`channel.ts`) | tag commit == `GIT_SHA` | tag commit == manifest `commit` (same rule) |
| commits behind (`updates.ts`) | compare `GIT_SHA…main` | compare manifest `commit…main` |
| backend `/health` | `GIT_SHA[0:7]` | `FF_IMAGE_COMMIT[0:7]` (field name kept) |
| Portainer result (`redeploy.ts`) | `GIT_SHA` changed | manifest `commit` changed (the file changes even when the backend is not recreated) |
| error log release, setup `appVersion` | `APP_VERSION` | manifest version, else image commit7 |
| web `APP_VERSION` (footer fallback, device caps) | `version.json` at build | `/api/version` only; nothing shown until it answers |
| updater `previous`, rollback tag | `sha-<backend GIT_SHA7>` | stack commit and per-service digests from the manifest |
| OCI labels, SBOM, provenance | per run | per image commit (they describe the build that made the bytes) |
| reproducible check, `reproduce-image.sh --compare` | rebuild at the run's commit | rebuild at the image's `revision` label (the script reads it; `--ref` optional) |

### Comparison base

- **Push and publishable dispatch:** the manifest at `friendflix-release:sha-<first parent7>`; if that does not exist (the parent's
  run failed or never published), `:nightly`; if neither exists, everything builds. The manifest must pass `cosign verify` with the
  updater's identity rule, else it is ignored (everything builds). An image is **carried** when its image commit equals the manifest's
  and the manifest's digest still resolves and verifies; otherwise it is **built**. Because the comparison is by image commit, a failed
  or dropped run is harmless: the next run compares with what was really published.
- **Pull requests:** image commits at the PR head vs at `pull_request.base.sha` (what this PR changes; no registry read, works for forks).
- **Other dispatches** (not `main`, not a tag): full.
- **Manual full rebuild:** `workflow_dispatch` input `full` (main only). **Weekly** (below). There is no force-push, so no history
  rewrite to handle; a rewritten parent would only fall back to `nightly`.

### Change classes and which jobs do real work

The plan job (`changes`, first in `ci.yml`, ~30 s) outputs per image `build | carry` with the reason, and these classes:

| Changed files | `test (22)`, `test (26)` | `e2e` | `dast` | `docker (x)` / `reproducible (x)` |
|---|---|---|---|---|
| only docs (`docs/**`, `**/*.md`) or `version.json` | `test:docs` + `test:scripts` | unverändert | unverändert | unverändert |
| anything else | full | full if `web` builds, `e2e/**` changed or a workflow/action changed | full if `web` builds, `.zap/**` or a workflow/action changed | build where the map says so |
| map/script, `full` input, weekly schedule | full | full | full | build all |

- `version.json` sits with docs (Controller's call): only the release commit changes it, and it is no longer an image input; the TV,
  Android and desktop release jobs still read it on the tag as today. `codenames.json` stays a `web` input.
- `test:docs` (new npm script) runs exactly the tests that read docs (*Constraints*); the docs-reader guard keeps it complete.
- `secrets` always runs in full (docs can leak too). `compose`, `tizen-check`, `webos-check`, `desktop-*` are unchanged (*Non-goals*).

### CI job shape

- **No `paths`/`paths-ignore` on the workflow, no job-level `if:` on a required job.** Every required leg starts, reads the plan, and
  either does the work or prints `unverändert (wie <image commit7>, <digest>)` to its log and step summary and exits green.
- **Fail closed:** required jobs `need: changes` with `if: ${{ !cancelled() }}`; their first step fails when `changes` did not succeed or
  its output does not parse. So a broken plan turns checks red, never "skipped" (which would pass).
- **`docker (x)`**, matrix `backend gateway web updater livetv mediaserver` (Controller's call: `mediaserver-image` and
  `publish-mediaserver` fold into the matrix and the single publish; the leg keeps its base-pin consistency step and report-only Trivy):
  - *build:* as today via the composite action; on push the candidate is `ci-<sha>`.
  - *carry, push:* point `ci-<sha>` at the carried digest (`imagetools create`, no new bytes), run the Trivy gate on it (a CVE published
    since its build still blocks, as today). If the gate fails and a fix is available, rebuild once in the same leg and gate the new
    image (Controller's call: a rebuild picks up fixed Alpine/Debian packages; a vulnerable npm dependency still fails, as today).
  - *carry, PR:* nothing to build or scan; "unverändert".
  - Smoke tests run on built images only.
- **`reproducible (x)`**: built images as today; carried ones "unverändert" (they were proven when built).
- **`publish`** needs everything as today plus `docker (mediaserver)`; `publish-mediaserver` and `mediaserver-image` disappear.
  `docs/operations.md` adds `docker (mediaserver)` to the required checks (owner decision 10) and drops the two old names.

### Publishing, tags and signatures

- `publish.yml` keeps reading `ci-<sha>` for every image, built or carried, so its re-tag step and the tag rules are unchanged:
  `nightly` + `sha-<7>` on `main`, `X.Y.Z`/`X.Y`/`X` (+ `latest` for the highest plain version) + `sha-<7>` on a tag. The allow-list
  gains `release`; the default list gains `mediaserver`.
- **Signing (Controller's call):** on `main`, sign and attest only built digests (carried ones already carry a `main` signature from
  their build; re-signing every commit would grow each digest's signature list without bound). On a **tag**, sign and attest every
  digest once: the documented check `cosign verify --certificate-identity …@refs/tags/vX.Y.Z` (`docs/operations.md`, *Images prüfen*) must
  pass for every image of a release, and it is bounded (one signature per release). The updater's rule (`main` or a release tag)
  already accepts both, so it does not change.
- **Order:** sign new digests → `cosign verify` every image of the set with the updater's exact rule → only then move tags → carrier
  last (built, signed, verified, tagged). A verify failure moves no tag. The updater resolves a stack through its carrier and installs
  by `sha-<stack7>`, so a reader never sees half a set.
- **`ci-<sha>` pruning** keeps working: a carried digest stays reachable through `nightly`, `sha-<7>` and release tags.

### Release flow

- **Precondition** (`release.yml`, Controller's call): `main`'s head must have a published, verified manifest (`sha-<head7>`). While its
  CI run is still going the workflow waits (up to 60 min, the e2e budget plus publish), on failure it refuses with "erst main grün
  machen". Then it commits only `version.json` + `CHANGELOG.md` and tags.
- **Tag run:** base = `sha-<parent7>`; every image is carried (the release commit touches no input); tests run in docs mode; `publish`
  re-tags and signs. **Guard:** a tag run whose parent has a manifest but whose plan wants to build anything fails ("release commit changes
  image inputs"); the auto-rebuild on a failed scan is off for tags (fix on `main`, release again).
- **Exception:** a tag whose first parent has no manifest (a hand-made backport tag on a side branch) builds what differs from
  `nightly`'s manifest, as today's full run would; it is logged as such. The `main` run of the release commit carries too and moves
  `nightly` to the release commit; both runs write identical carriers for `sha-<rel7>`.
- **Release candidates** (`vX.Y.Z-rc.N`, by hand): same as a release (carry from the parent, `X.Y.Z-rc.N` tag only, never `latest`).
  The updater still cannot select them (`TAG_RE` unchanged).
- Android, desktop, Tizen and webOS release jobs on the tag are unchanged; with tests in docs mode a release is about the length of
  those jobs instead of 35 min.

### Updater

- **Target first:** pull `friendflix-release:<channel tag>` (kilobytes), `cosign verify`, read the manifest. A missing carrier (a tag
  from before this change) → the **legacy path**: today's behaviour unchanged (pull and verify all, health by `GIT_SHA`).
- **Per service** (`bootstrap` follows `backend`; `livetv` while enabled; `updater` only on self-update): running `RepoDigests` contains
  the manifest digest → **unverändert**: tag the local image as `sha-<stack7>` (`docker image tag`, no registry call, no verify:
  it is the image that was verified when it was installed) → else **changed**: pull, check the pulled digest equals the manifest's,
  `cosign verify`. Any verify failure aborts before anything restarts.
- **Restart:** `compose up -d --no-deps --pull never` with `FF_TAG=sha-<stack7>` for all FriendFlix services plus `release`; compose
  recreates only services whose image or config changed (Controller's call: a `.env` edit still applies on the next update, as today).
  The job records per service `aktualisiert | unverändert` by container id before/after; nothing changed → still `up release`, so the
  backend learns the new stack, and the job ends "alles unverändert".
- **Health:** every FriendFlix service running and healthy (compose), each recreated container on its manifest digest, backend
  `/health` answering with the manifest's backend image commit7 (equal to before when the backend did not change). Same 3-minute budget.
- **State and rollback:** `installed` and `previous` become `{commit, version, digests}` (the old `sha-<7>` string is still read).
  Rollback and auto-rollback go to `sha-<previous7>` the same way, so only the services the update changed are touched; a legacy
  `previous` uses the legacy path. `sha-<7>` exists for every image at every published commit, because carried images are re-tagged.
- **livetv:** same rule; enabling follows the installed stack (`sha-<stack7>`) instead of the backend's commit; it stays optional and
  never fails a core update. **Self-update** keeps its digest check, now against the manifest before pulling.
- *Admin → Update* shows the per-service result ("aktualisiert" / "unverändert") from the job state the backend already relays.

### Manual installs and Portainer

`docker compose pull && up -d` and Portainer's redeploy with pull get the same benefit without code: unchanged images keep their image
id, so compose leaves those containers running; `release` reruns and the backend shows the new version. `redeploy.ts` judges
progress by the manifest commit and, where the updater lists services, by digests instead of `sha-<7>` of `GIT_SHA`.

### Media server (amends the managed media server spec)

- `mediaserver` is a normal leg: built only when its inputs change, else carried; its digest is in every manifest, so "a build without
  it carries no `ferrofin` pin" no longer happens, and its publish is required (owner decision 10). Trivy stays report-only and it
  stays exempt from `reproducible`.
- **Pins move from the backend label to the manifest** (Controller's call): `pins.ferrofin` = the manifest's mediaserver digest,
  `pins.jellyfin` from `mediaserver/pins/jellyfin/Dockerfile` (a manifest input, not a backend input). Otherwise every media server or
  Jellyfin bump would rebuild and restart the backend. The updater reads pins from the verified carrier; the "not run by the
  updater" trigger becomes "the stack commit changed since last seen". The media server phase itself (after FriendFlix's health,
  never down, snapshot first) is unchanged. Whichever of the two projects lands second does this move.

### Periodic rebuild (Controller's call)

Weekly scheduled run on `main` (Sunday night, plus the `full` dispatch): rebuild every image at `main`'s head with its image commit,
compare the new **image manifest** digest with the carried one, and publish only images whose bytes differ (OS package fixes for the
unpinned packages above). Equal → the carried index digest stays (no restart anywhere). A build failure of an unchanged image is a
warning (the carried digest stays valid) so build rot (a vanished download, a rotated key) shows within a week. Reason: Dependabot is
monthly and does not see apk/apt drift; today every commit rebuilt, so this keeps the fix latency at about a week for one extra run.

### Expected savings

On last month's 157 commits: Node image builds and reproducible rebuilds drop to about a third (226 of 700); `e2e` (27–33 min, the wall
clock) is skipped on the ~38 % of commits that leave `web` and `e2e/` alone; release and docs commits drop from ~90 runner min each to a
few. Wall clock stays ~34 min whenever `web` changed. On update, a typical nightly restarts one or two services instead of four or
five, and a web-only update no longer drops the gateway's streams or restarts the backend.

## Risks and how each is prevented

| Risk | Prevention |
|---|---|
| Stale image (input missing from the map) | COPY guard test; image commit includes `.dockerignore`, build action, BuildKit pin; burn-in proof; weekly rebuild flags any byte change of a "carried" reproducible image |
| Carrying a digest the repo never signed | base manifest and every carried digest must pass the updater's `cosign verify` rule, else build |
| Broken signature chain after tags moved | verify-all before any tag moves; tags signed per release |
| Required checks pending | no workflow path filters, no job-level skip on required jobs |
| Required checks "skipped" into green | `!cancelled()` + explicit plan check; red on a broken plan |
| Release ships untested bytes | release precondition + tag-run build guard |
| Half-updated set read by a client | install by `sha-<stack7>` via the carrier; carrier tagged last |
| Version shown wrongly | one manifest source; legacy fallback only for pre-change images |
| A new CVE in a long-carried image | Trivy gate on carried digests every publish; one automatic rebuild; weekly rebuild |

## Testing

- `scripts/changed-images.test.mjs` with a throwaway git repository in a temp dir: image commits across merges, reverts and exclusions;
  each change class; the COPY and docs-reader guards against the real Dockerfiles and tests.
- **Burn-in before skipping (Controller's call):** PR 2 still builds everything, but the plan already runs in report mode; for every
  image it calls "carry", the rebuilt image manifest digest must equal the carried one. PR 3 is merged only after 20 consecutive `main`
  runs without a mismatch for `backend gateway web updater` (livetv and mediaserver are not reproducible; the map's guard covers them).
- Updater (fake `Ops`, `job.ts` tests): nothing changed, one changed, verify failure of one, partial rollback, legacy target and legacy
  previous, livetv on/off, self-update. Backend: version from the file and each fallback, `redeploy.ts` by stack commit, `channel.ts`
  with the manifest commit. Web: footer without baked version.
- `release.yml`: the precondition and guard as tested functions in `release.mjs`; one dry run on a fork before the first real release.

## Order of work

Each PR is mergeable alone and leaves `main` releasable.

1. **Map and plan, report only:** `.github/images.json`, `changed-images.mjs` + tests, `.dockerignore` (`**/*.md`, test folders),
   `test:docs`, the composite build action, the `changes` job printing its plan. Nothing is skipped yet.
2. **Identity out of the images:** `FF_IMAGE_COMMIT` + its time as build inputs, labels fixed, `version.json` out of `backend`/`web`,
   `release.mjs` stops touching `package.json`; the stack manifest, carrier, `release` service in both compose files, backend and web
   reading it, `/health`, `redeploy.ts`, `channel.ts`; the updater reading the manifest (still restarting everything);
   `reproduce-image.sh`. A one-off dispatch backfills carriers for the existing `vX.Y.Z`, `X.Y`, `X`, `latest` and `nightly` tags from
   the images' baked values, so pinned old versions keep working with the new compose file. Burn-in starts.
3. **CI carries (after the burn-in):** build-or-carry legs, `ci-<sha>` on carried digests, Trivy auto-rebuild, test classes, docs-only
   shortcut, `mediaserver` into the matrix, publish signing order and verify gate, `full` input, weekly rebuild, release precondition
   and tag guard, `docs/operations.md` (required checks, release, channels, updater flow, verification), `docs/reproducible-builds.md`.
4. **Updater changed-only:** digest compare, local tagging, per-service report, partial rollback, health rule; *Admin → Update*
   "unverändert". Independent of 3 (with everything rebuilt it simply finds nothing unchanged).
5. **Media server pins in the manifest** — in whichever of this project or media server stage 1 lands second.

## Left to the builder

- The exact JSON shapes of `images.json`, the plan output and `release.json` (schema number, field names), and the label key.
- How `changes` reads a carrier without pulling (`imagetools inspect` of the config) and how the init service copies the file (user,
  volume ownership, read-only root).
- Which test folders can join `.dockerignore` per workspace (check each `tsconfig` and build).
- The poll interval of the release precondition; the schedule minute of the weekly run.
- The German texts ("unverändert", "aktualisiert", "alles unverändert", the release refusal), then the other six languages.
- The backfill dispatch's mechanics and where its one-off code lives (removed after use).

## Questions only the owner can answer

1. **A new one-shot `release` container in every stack** (exits after copying the version file, like `bootstrap`; a new GHCR package
   `friendflix-release` beside the six images). It is what lets manual and Portainer installs show the right version without a
   version inside any image. *Recommended: yes, as specified.* Without it, only updater installs would know their version; the
   others would show "unbekannt · <commit>".
