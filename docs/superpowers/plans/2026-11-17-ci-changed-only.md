# Build and update only what changed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CI builds, scans, signs and publishes only the images whose inputs changed (every other image keeps its last digest under the new tags), a release rebuilds only the backend, and the updater pulls, verifies and restarts only the services whose digest changed.

**Architecture:**
- **Change map + plan script** (`.github/images.json`, `scripts/changed-images.mjs`): per image its **image commit**, the base, `build | carry`, and the change classes for `test`/`e2e`/`dast`; guards tie the map to the Dockerfiles and the docs-reading tests.
- **Images carry their image commit** (`FF_IMAGE_COMMIT`, `revision`, `SOURCE_DATE_EPOCH` = its time), so unchanged inputs give the same bytes later; only the backend carries the version; the backend derives the **installed build** from the services.
- **CI legs build or carry** (carry = `ci-<sha>` pointed at the verified last digest, gate-scanned); publish signs new digests (all on a tag), verifies the set, moves all tags at once.
- **The updater compares digests first**, pulls changed images by digest, verifies, re-tags locally, `compose up` recreates only those; rollback re-tags the previous digests.

**Tech Stack:** GitHub Actions (pinned actions already in use), Node 26 `.mjs` (`node:test`, no dependencies), bash, BuildKit, cosign, GHCR API; TypeScript + vitest; SvelteKit.

**Spec:** `docs/superpowers/specs/2026-11-17-ci-changed-only-design.md` (commit `d012428f`, owner-approved, binding). Parallel work: `docs/superpowers/plans/2026-11-17-managed-mediaserver-stage1.md` on `claude/managed-mediaserver` (Tasks 10–11 touch the same CI regions, see *Coordination*).

## Stages and merge order

| Stage | Spec PR | Merges | Ends with |
|---|---|---|---|
| A | 1 Map and plan, report only | first | `changes` prints the plan; nothing skipped |
| B | 4 Updater changed-only | after A (independent) | updates restart only changed services |
| C | 2 Commit out of the images | after B | images carry their image commit; burn-in starts |
| D | 3 CI carries | after 20 counting burn-in runs | only changed images built, tested, published |

**Ruling (order):** PR 2 removes `GIT_SHA`, which today's updater needs for `previous` (`sha-<backend GIT_SHA7>`, `job.ts:319-321`); an image commit has no `sha-<7>` tag of its own, so rollback would break. Stage B (spec PR 4, "independent") therefore merges before Stage C; it reads `FF_IMAGE_COMMIT` with a `GIT_SHA` fallback and works with today's images.

## Controller's calls

1. **Image commit = first-parent**, matched in JS (one matcher, no pathspec translation): `git log --first-parent --diff-merges=first-parent --no-renames --name-only`. A merged branch counts as its merge commit; `--no-renames` makes a file moved out of an input folder count.
2. **Map shape:** `exclude`, `groups`, `full`, `images.<name>.{dockerfile, groups, inputs, argsFrom, required, reproducible}`; `!glob` excludes, `@<image>` includes that image's `inputs`; `.dockerignore` drops apply only to an image's own `inputs`, never to `groups.*`, `full` or `argsFrom` (`.dockerignore` drops `.github`, yet the build action is an input of every image).
3. **BuildKit pin** = `default:` of input `buildkit-image` in `.github/actions/build-image/action.yml` (in the *all images* group); `reproduce-image.sh` falls back to `ci.yml`'s `BUILDKIT_IMAGE:` for old refs.
4. **Labels written by the build action** from git only (title, source, url, licenses, revision, created); `metadata-action` leaves `ci.yml` (it read the repository description and stamped `.version`).
5. **Updater registry digests by `fetch`** (anonymous pull token, `HEAD …/manifests/<tag>`): no new program; the token is never logged or returned.
6. **Installed build ordering** by commit time from GitHub (`/repos/{repo}/commits/{sha}`, cached 7 days); any unknown time → the backend's own image commit.
7. **Service identity fields:** gateway `/health` and livetv `/healthz` gain `image`; livetv `version` = its image commit (spec table); web's `/_app/version.json` `version` = its image commit.
8. **Keep if equal:** a push build whose base has the same image commit (`full`, weekly, Trivy rebuild) compares linux/amd64 manifests and, when equal, points `ci-<sha>` back at the carried index.
9. **Publish knows "built" by digest:** on `main` a leg signs only when `ci-<sha>` ≠ the plan's base digest.
10. **Burn-in** annotates from the `reproducible (x)` legs and never fails them (a red non-required job would hide the run from `updates.ts`, which reads `status=success` runs); `scripts/burnin-status.sh` prints the streak.
11. **`docker` keeps waiting for `docker (mediaserver)`** (the backend pins its digest); the media plan's comment "the ci-changed-only project removes this wait" is corrected at the merge.
12. **Image-affecting settings live only in `build-image`** (preflight F8): label keys and formats, including the media server pin label, are composed there; `ci.yml` and `image-leg` pass values only (a digest, the pin script's output). This keeps `groups.all` at `.dockerignore` + `build-image/**`.
13. **Report mode never blocks:** a registry or cosign error while planning gives `base: null` (`keine Basis` → build) and a `::warning`; the plan fails only on git, map or parse errors.
14. **Release refusal text** (German, spec): `Release abgebrochen: main (<sha7>) ist nicht veröffentlicht (<Grund>). Erst main grün machen, dann den Release neu starten.`; Grund `CI-Lauf fehlgeschlagen` / `nach 60 Minuten noch nicht fertig`.

## Global Constraints

- **Checks agents run:** typecheck, the specific tests, build, lint; CI runs the rest. Scripts `node --test scripts/<file>.test.mjs`; workspaces `cd <ws> && npx vitest run <file>`; backend tests with `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/ff_test_ci` (own database; "`TEST_DATABASE_URL=…`" below means this); typecheck `npm run typecheck -w <ws>` (web: `cd web && npx svelte-kit sync && npx svelte-check --threshold error`); `npm run build -w <ws>`; `npx eslint <touched files>`; workflows `actionlint` if installed, else `python3 -c 'import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]' <files>` (the "workflow lint"); `bash -n` on touched scripts. No `node_modules`: `npm ci` once; never `npm install`; `package-lock.json` changes only in Task C5.
- **Required check names stay:** `test (22)`, `test (26)`, `e2e`, `dast`, `secrets`, `docker (backend)`, `docker (gateway)`, `docker (web)`, `reproducible (backend)`, `reproducible (gateway)`, `reproducible (web)`; Stage D adds `docker (mediaserver)`. No `paths`/`paths-ignore` on the workflow; no job-level `if:` on a required job other than `${{ !cancelled() }}`.
- **Actions:** only those already in `.github/workflows/*.yml`, at their full SHAs; anything new needs a full-SHA pin (none planned).
- **Fail closed:** a plan that is missing, failed or does not parse turns required checks red, never "skipped" or green.
- **Secrets never logged:** `GITHUB_TOKEN`, `RELEASE_TOKEN`, GHCR pull tokens, `INTERNAL_SECRET`. Updater job log and state carry fixed codes and digests only.
- **Temp git repos in tests** (A1's helper, reused by A3, C6, D1): git runs with `-c user.name=ci -c user.email=ci@example.com -c commit.gpgsign=false -c tag.gpgsign=false -c init.defaultBranch=main` (CI runners have no identity, local config signs). Scripts use only Node ≥ 22 APIs (`test:scripts` also runs in `test (22)`).
- **Fixtures:** hosts under `example.com`, repository `example/friendflix`, digests `sha256:` + 64 × one hex digit, commits 40 × one digit; code keeps the fixed registry `ghcr.io`.
- **Texts:** German first ("du"), then en, es, fr, it, pl, tr, identical key order (`web/src/lib/i18n/locales/<lang>/admin.ts`); "…" not "..."; never "Netflix" or "Seerr".
- **Git:** merge only (no rebase, no force-push, never `git stash`, never `git add -f .superpowers`); stage only the task's files. Every commit ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_016uMXgkH3UD9V4XN9PEeaKN`
- **Exact values:**

  | What | Value |
  |---|---|
  | Images | `backend gateway web updater livetv mediaserver` (map order) |
  | Plan JSON (`changes` output `plan`, one line) | `{ v: 1, event, mode: 'compare'\|'full'\|'weekly'\|'tag'\|'report', sha, base: { commit } \| null, classes: { tests: 'full'\|'docs', e2e: boolean, dast: boolean, full: boolean, reason: string }, images: { <name>: { action: 'build'\|'carry', reason: string, commit: string, time: number, required: boolean, reproducible: boolean, base: { digest: string, revision: string \| null, verified: boolean } \| null } } }` |
  | Docs class | `docs/**`, `**/*.md`; version class adds `version.json` |
  | Full files | `.github/images.json`, `scripts/changed-images.mjs` |
  | Waits | base walk ≤ 50 first-parent commits (run commit first); tag run ≤ 45 min; release precondition ≤ 60 min, release job `timeout-minutes: 75`; poll every 30 s |
  | Weekly run | `schedule: - cron: "43 1 * * 0"` (Sunday 01:43 UTC) |
  | Caches | updater registry digest 600 s (error 60 s); backend installed build 600 s; commit time 604 800 s (error 60 s) |
  | Image identity | `ENV FF_IMAGE_COMMIT` (40 hex, `dev` locally); labels `org.opencontainers.image.revision` = image commit, `.created` = its time (ISO, `Z`) |
  | cosign rule | identity `^https://github\.com/<repo>/\.github/workflows/publish\.yml@refs/(heads/main\|tags/v[0-9]+\.[0-9]+\.[0-9]+)$`, issuer `https://token.actions.githubusercontent.com` (= `updater/src/policy.ts` `cosignIdentity`) |
  | Leg log line | `unverändert (wie <commit7>, <digest first 19 chars>)` in the log and `$GITHUB_STEP_SUMMARY` |
  | Updater codes | `StepError` `registry_failed`, `tag_failed`; job report values `updated`, `unchanged` |
  | UI texts (de / en) | `Update verfügbar` / `Update available`; `unverändert` / `unchanged`; `aktualisiert` / `updated`; `alles unverändert` / `all unchanged` |

## Review Focus

1. **A file moved out of an image's folder, a merge, a revert** must change the image commit (`git log` hides a rename's source by default). Task A1: `a rename out of backend …`, `a merge counts as the merge commit …`, `a revert gives a new image commit`.
2. **A docs-only commit right after a failed or dropped run** must test the unpublished code in full. Task D1: `a docs commit after an unpublished code commit runs full`.
3. **`changes` failed or cancelled** must turn required jobs red, never "skipped" (= passed). Task D2: `every required job needs changes, …`.
4. **A base digest this repository never signed** (a fork, a hand-pushed tag) is never carried. Task C6: `an unverified base is built …`.
5. **One image fails verification, the registry is down, or the state holds an old `sha-<7>`:** nothing re-tagged or restarted; the old previous rolls back as today. Task B2: `one verify failure …`, `registry_failed before any pull`, `legacy sha previous …`.

## Coordination with `claude/managed-mediaserver`

The branch merging second merges the other in (no rebase). Shared regions:

| This plan | Media plan | Region | How the merge resolves it |
|---|---|---|---|
| A3 | Task 10 | `docker` build steps → composite action; backend *OCI labels* step | `build-image` composes the pin label (input `mediaserver-pins` = the script's output); `ci.yml` passes the value only; `docker` keeps `needs: mediaserver-image` until D3 |
| A3, D3 | Task 10, 11 | `mediaserver-image` job (outputs `digest`, smoke step) | D3 renames it `docker-mediaserver` / `docker (mediaserver)`; `outputs.digest` is the built or carried digest; the smoke step runs only when built |
| C4 | Task 11 | `mediaserver/Dockerfile` labels (`:85-93`), `ARG GIT_SHA` | keep 0003/0004 and the `changes` label; revision becomes `${FF_IMAGE_COMMIT}` |
| D4 | Task 10 | `publish-mediaserver` | removed; `publish` covers six images |
| A1 | Task 10 | map | backend `inputs` already list `mediaserver/pins/**` and `scripts/mediaserver-pins.sh` (match nothing until media lands); after the merge both go into backend `argsFrom` (Task D6) |

---

## Stage A — Map and plan, report only (spec PR 1)

Ends green: every job as today, plus a `changes` job printing its plan.

### Task A1: The change map, image commits and change classes

**Files:**
- Create: `.github/images.json`, `scripts/changed-images.mjs`, `scripts/changed-images.test.mjs`

**Interfaces:**
- Produces (`.github/images.json`, stage A values): `exclude: ["**/*.md"]`; `full: [".github/images.json", "scripts/changed-images.mjs"]`; `groups.all: [".dockerignore", ".github/actions/build-image/**"]`; `groups.node-common: ["package.json", "package-lock.json", "tsconfig.base.json", "backend/package.json", "gateway/package.json", "web/package.json", "updater/package.json", "livetv/package.json"]`; images (groups `all` + `node-common` for the five Node images, `all` for mediaserver):
  - backend `inputs ["backend/**", "!backend/test/**", "deploy/authentik/*.yaml", "version.json", "mediaserver/pins/**", "scripts/mediaserver-pins.sh", "@mediaserver"]`, `argsFrom ["version.json"]`, required, reproducible
  - gateway `["gateway/**", "version.json"]`, `argsFrom ["version.json"]`, required, reproducible; web `["web/**", "codenames.json", "version.json"]`, `argsFrom ["version.json"]`, required, reproducible; updater `["updater/**", "version.json"]`, `argsFrom ["version.json"]`, reproducible, not required; livetv `["livetv/**", "version.json"]`, `argsFrom ["version.json"]`, neither
  - mediaserver `["mediaserver/Dockerfile", "mediaserver/NOTICE"]`, `argsFrom []`, neither (Stage D: required)
  - `version.json` is in every Node image until Task C4 (today all bake `APP_VERSION`); a `$comment` says so and that, until Stage C, every image also bakes the run commit (stage A's carry calls are a report).
- Produces (`scripts/changed-images.mjs`, ESM, Node built-ins only, exports):
  - `loadMap(root = ROOT): ImageMap`; `IMAGES` (names in map order)
  - `isInput(map, image, path, root = ROOT): boolean` — globs (`**` any depth, `*` one segment), `!`, `@image`, minus `map.exclude`; `.dockerignore` drops (a pattern drops a path it or a parent folder matches; a later `!pattern` re-includes; leading `/` ignored) are subtracted from the image's own `inputs` only, never from `groups.*`, `full` or `argsFrom` (Controller's call 2)
  - `imageCommits(root, map, rev): Record<image, { commit: string, time: number }>` — one `git log --first-parent --diff-merges=first-parent --no-renames --name-only --format=%x00%H %ct <rev>` pass, stops when every image has its commit; throws `no commit touches the inputs of <image>`
  - `changedFiles(root, from, to): string[]` — `git diff --name-only --no-renames <from> <to>`
  - `classify(map, files, built: Set<string>): Classes` (spec table): a `full` file → all full; only docs (or docs + `version.json`) → tests `docs`, no e2e/dast; else tests `full`, e2e = web built or a file under `e2e/`, `.github/workflows/`, `.github/actions/`; dast likewise with `.zap/`
  - `plan({ root, map, event, sha, prBase?, full? }): Plan` (D1 adds `ref`) — `pull_request`: carry iff the image commits at `sha` and `prBase` are equal (reasons `unverändert seit <c7>` / `Eingaben geändert`), classes from `changedFiles(prBase, sha)`; other events: mode `report`, all `build` (`kein Vergleich (nur Bericht)`), classes full
  - CLI `plan --event <e> --sha <s> [--pr-base <s>] [--full] [--summary <file>]` (JSON on one line; summary table `| Image | Aktion | Image-Commit | Grund |`); `image-commit <image> [--ref <r>]` prints `<sha> <epoch>`. An empty `--pr-base` counts as absent; `pull_request` without one exits 1 (`--pr-base fehlt`).

- [ ] **Step 1: Write the failing tests** (exported helper `tmpRepo()`: throwaway repo in `mkdtempSync`, git with the Global Constraints `-c` identity and no signing; commit, branch, `merge --no-ff`, `git mv`; a two-image test map):
  - `isInput: globs, ! excludes, @image, **/*.md, .dockerignore drop and re-include`
  - `image commit: the newest first-parent commit touching the inputs`
  - `a merge counts as the merge commit; the side branch's own commits do not`
  - `a rename out of backend changes the backend image commit` (Review Focus 1)
  - `a revert gives a new image commit`
  - `classify: docs, version.json, code; e2e and dast triggers; map change → full`
  - `plan (pull_request): carry when the image commits at base and head are equal, build otherwise`
  - `real map: every image has a commit at HEAD; node-common reaches all five Node images and not mediaserver`
  - `real map: .dockerignore and .github/actions/build-image/action.yml are inputs of all six images` (preflight F1)
  - `CLI: an empty --pr-base on push is absent; pull_request without one fails`
- [ ] **Step 2: Run** `node --test scripts/changed-images.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the map and the module.
- [ ] **Step 4: Run** the tests, `node scripts/changed-images.mjs plan --event pull_request --sha HEAD --pr-base HEAD~1` and `… plan --event push --sha HEAD --pr-base ""`. Expected: PASS; one JSON line with six images each.
- [ ] **Step 5: Commit** `ci: change map, image commits and change classes (report only)`.

### Task A2: COPY and docs-reader guards, `.dockerignore`, `test:docs`

**Files:**
- Modify: `scripts/changed-images.mjs`, `scripts/changed-images.test.mjs`, `.dockerignore` (add `**/*.md`, `gateway/test`, `updater/test`, `livetv/test`, `**/tsconfig.test.json`, `**/vitest.config.ts`, `web/src/**/*.test.ts`), `package.json` (`"test:docs": "npm run test:docs --workspaces --if-present"`), the `package.json` of each workspace that has docs readers (`"test:docs": "vitest run <files>"`)

**Interfaces:**
- Consumes: `loadMap`, `isInput` (A1).
- Produces: `copyGuard(root, map): string[]` (problems as `<dockerfile>: <source> → <file> is not an input`, empty = ok): each `COPY`/`ADD` (continuation lines joined; `--from=` skipped; URL sources skipped; `--flags` dropped; last argument = destination), each source expanded over `git ls-files` (a folder = everything under it, a glob by `isInput`'s rules) minus `.dockerignore` drops, every file must satisfy `isInput`; every `argsFrom` file must be an input of its image; every tracked repository file the build action **reads** must be in some image's `argsFrom` — reads = operands of non-comment `run:` lines and `with:` file/context values in `.github/actions/build-image/action.yml`; YAML comments and label strings are out of scope (preflight F2).
- Produces: `docsReaders(root): string[]` — `*.test.ts` under `backend/test`, `gateway/test`, `updater/test`, `livetv/test`, `web/src` whose source has a string literal containing `docs/` or a file name ending `.md`; `docsGuard(root): string[]` — readers missing from their workspace's `test:docs` file list. `scripts/*.test.mjs` all run in docs mode through `test:scripts`.

- [ ] **Step 1: Write the failing tests:** `COPY guard: the real Dockerfiles are covered` (`[]`); `COPY guard: an uncovered COPY source fails` (map copy without `codenames.json` in web → names `web/Dockerfile`); `COPY guard: a file the build action reads must be in argsFrom` (fixture `action.yml` in a `tmpRepo()`, since A3 creates the real one; a comment or label naming a file does not count); `docs-reader guard: every docs-reading test is in test:docs` (`[]`); `docs/operations.md lists docker (x) for every required image and reproducible (x) for every required reproducible one`.
- [ ] **Step 2: Run** `node --test scripts/changed-images.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the guards; add the `.dockerignore` lines (keep every existing line); write the `test:docs` lists exactly as `docsReaders` reports them.
- [ ] **Step 4: Run** the tests and `TEST_DATABASE_URL=… npm run test:docs`. Expected: PASS. Local `npm run build` never reads `.dockerignore`: the proof for the leaner contexts is `docker build -f <ws>/Dockerfile .` for web and gateway when Docker is available, else the PR's `docker (x)` and `reproducible (x)` legs (say which).
- [ ] **Step 5: Commit** `ci: COPY and docs-reader guards, test:docs, leaner build contexts`.

### Task A3: Composite build action and the `changes` job

**Files:**
- Create: `.github/actions/build-image/action.yml`
- Modify: `.github/workflows/ci.yml` (drop `env.BUILDKIT_IMAGE`; new first job `changes`; `docker` and `mediaserver-image` build via the action; header comment), `scripts/reproduce-image.sh` (pin lookup, `--buildkit-image`), `scripts/changed-images.test.mjs`, `.github/dependabot.yml` (`github-actions` entry: `directories: ["/", "/.github/actions/*"]`, so the pins moved into the action keep their updates), `docs/reproducible-builds.md:31,43` (the pin now lives in the action)

**Interfaces:**
- Produces (action): inputs `service`, `publish` (`'true'|'false'`), `image` (no tag), `tag` (`ci-<sha>`), `mediaserver-pins` (value only, default empty; when set for backend the action adds the label `io.github.letsmanu.friendflix.mediaserver.pins=<value>`; unused until D6), `buildkit-image` (`default:` = the pin, moved with its comment); outputs `digest`, `ref` (`<image>@<digest>` or `friendflix-<service>:ci`). Today's work, byte-identical: setup-buildx with the pin; build args per service (mediaserver `SOURCE_DATE_EPOCH`, `GIT_SHA`; others also `BUILD_TIME`, `APP_VERSION`, `APP_CODENAME`); labels via `metadata-action` (mediaserver's title/description/licence lines move in byte-identical, even where they name a file); PR `load` + `gha` cache; publish: today's outputs, `no-cache`, `cache-to`, `sbom`, `provenance: mode=max`.
- Produces (job `changes`): `permissions: { contents: read }`, `timeout-minutes: 5`, checkout `fetch-depth: 0`, `persist-credentials: false`, setup-node 26, step `plan`: the CLI with `--event "$GITHUB_EVENT_NAME" --sha "$GITHUB_SHA" --pr-base "$PR_BASE"` (env from `github.event.pull_request.base.sha`, empty outside PRs = absent), `--summary "$GITHUB_STEP_SUMMARY"`; job output `plan`. Nothing needs it yet.
- Produces (`reproduce-image.sh`): pin = the `default:` value under `buildkit-image:` in `.github/actions/build-image/action.yml` at the ref, else the `BUILDKIT_IMAGE:` line of `ci.yml`; `scripts/reproduce-image.sh --buildkit-image [--ref R]` prints it and exits.

- [ ] **Step 1: Write the failing tests:** `reproduce-image.sh --buildkit-image reads the action's pin` (real repo; equals the `default:` in `action.yml`, starts `moby/buildkit:v`) and `… falls back to ci.yml on an old ref` (A1's `tmpRepo()` holding only `.github/workflows/ci.yml` with a `BUILDKIT_IMAGE:` line).
- [ ] **Step 2: Run** `node --test scripts/changed-images.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the action, the job, the script change; rewrite the `ci.yml` header lines on BuildKit and the build.
- [ ] **Step 4: Run** the tests, the workflow lint, `bash -n scripts/reproduce-image.sh`, and assert `copyGuard()` on the real action is `[]` (it reads only `version.json`). Expected: PASS.
- [ ] **Step 5: Commit** `ci: composite build action and the changes job (report only)`.

---

## Stage B — The updater changes only what changed (spec PR 4)

Works with today's images (every image changes every commit, so it finds everything changed until Stage D).

### Task B1: Registry digests, pull by digest, local re-tag

**Files:**
- Create: `updater/src/registry.ts`, `updater/test/registry.test.ts`
- Modify: `updater/src/policy.ts`, `updater/src/docker.ts`, `updater/src/job.ts` + `updater/src/server.ts` (only the mechanical `gitSha` → `commit` rename at `job.ts:222,320,377`, `server.ts:156`; behaviour is B2's), `updater/test/docker.test.ts`, `updater/test/policy.test.ts`

**Interfaces:**
- Produces (`policy.ts`): `isDigest(v): v is string` (`/^sha256:[0-9a-f]{64}$/`); `digestRef(repo, service, digest): string` → `ghcr.io/<owner lc>/<name lc>-<IMAGE_OF[service]>@<digest>` (throws on a bad digest); `isOwnDigestRef(repo, service, ref): boolean`.
- Produces (`registry.ts`): `registryDigest(repo, service, tag, fetchImpl = fetch): Promise<string>` — `isTag(tag)` first; `GET https://ghcr.io/token?scope=repository:<owner>/<name>-<image>:pull&service=ghcr.io` → `{ token }`; `HEAD https://ghcr.io/v2/<owner>/<name>-<image>/manifests/<tag>`, `authorization: Bearer <token>`, `accept:` OCI index, Docker manifest list, OCI manifest, Docker manifest v2 media types; `redirect: 'error'`, 15 s; returns `docker-content-digest` when `isDigest`, else `StepError('registry_failed')` (never the token or a body). `cachedRegistry(repo, ttlMs = 600_000, errTtlMs = 60_000, now = Date.now, fetchImpl?)` → `(service, tag) => Promise<string | null>`.
- Produces (`docker.ts`): `ImageInfo = { repoDigests: string[]; commit: string | null; version: string | null }` (`commit` = env `FF_IMAGE_COMMIT`, else `GIT_SHA`, 40 hex only; `ImageInfo.gitSha` renamed in every reader; `UpdaterConfig.gitSha` stays, C1 owns it); `Running = ImageInfo & { container: string }` (`running(service)` adds the container id from `docker container inspect --format '{{.Id}}\t{{.Image}}'`); `pullDigest(ref)` → `docker pull --quiet <ref>` (`isOwnDigestRef` for some service, else `Error('invalid image')`; exit ≠ 0 → `pull_failed`); `tag(ref, image)` → `docker image tag <ref> <image>` (image = `expectedImage(repo, svc, tag)` of the same service as `ref`; exit ≠ 0 → `tag_failed`); `verify(ref)` takes the digest ref directly (anything not `isOwnDigestRef` → `false`, no cosign call), cosign arguments as today.

- [ ] **Step 1: Write the failing tests:** `registry: pull token, then HEAD with the accept list; returns the digest`; `401, 404, redirect, non-digest header → registry_failed; no token in the error`; `a bad tag never reaches fetch`; `cache: one HEAD per 10 min, errors retried after 60 s`; docker (fake `Runner`) `pullDigest and tag run exactly these argv`; `another repository, a tag ref, a backend digest tagged as web are refused before any command`; `imageInfo reads FF_IMAGE_COMMIT, else GIT_SHA`; `verify takes only own digest refs`.
- [ ] **Step 2: Run** `cd updater && npx vitest run test/registry.test.ts test/docker.test.ts test/policy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the updater typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(updater): registry digests, pull by digest, local re-tag`.

### Task B2: Update, rollback, self-update and livetv by digest

**Files:**
- Modify: `updater/src/job.ts`, `updater/src/state.ts`, `updater/src/server.ts` (`dockerOps`, `healthProbe` parameter rename), `updater/test/job.test.ts`, `updater/test/livetv.test.ts`, `updater/test/config-state.test.ts`

**Interfaces:**
- Consumes: B1.
- Produces (`Ops`): `images(tag, services)` unchanged (pre-checks + names); `registryDigest(service, tag): Promise<string>` (uncached; the cache is for `/v1/status`); `pullDigest(ref)`; `tag(ref, image)`; `verify(ref)`; `running(service): Promise<Running | null>`; `healthy(commit7: string | null)`; `pull` removed (and `Docker.pull` when unused).
- Produces (`state.ts`): `previousDigests: Record<string, string> | null` (keys `backend gateway web livetv`, values match `^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$`, a bad entry dropped on load); `previous` stays for a legacy `sha-<7>`; `Job.services: Record<string, 'updated' | 'unchanged'> | null`.
- Behaviour of `update` (one target tag = the channel tag; `bootstrap` follows `backend`; `livetv` while enabled):
  1. *pull:* `images()`; per service `target = registryDigest`; changed = its `digestRef` not in `running(svc).repoDigests` (or not running); `pullDigest` those. Nothing changed → verify/restart/health `skipped`, all `unchanged`, log `all services unchanged`, `succeeded`, state untouched.
  2. *verify:* each changed ref; any failure → `verify_failed`, nothing tagged or restarted.
  3. record `previousDigests` = every service's running own-repository digest ref (and `previous = null`), persisted before restarting.
  4. *restart:* `tag` each changed ref to `expectedImage(repo, svc, tag)`, `up(tag, FF_SERVICES)`; livetv as today but with the same compare.
  5. *health:* `healthy(backend changed ? new backend commit7 : null)` and each changed service runs its target; report per service by container id before/after (not `bootstrap`).
  6. failure after restart: re-tag every `previousDigests` entry (`pullDigest` + `verify` first when `imageInfo(ref)` is null), `up`, health with the previous backend commit; `rolled_back`.
- `start('rollback')`: `previousDigests` → restore them under the channel tag (`job.to` = channel tag) and record the digests it left; else a legacy `previous` sha tag → today's path; else `no_previous`.
- livetv enable: `registryDigest('livetv', channelTag)` → pull, verify, tag, `up livetv` (drops "follows the running backend sha").
- self-update: running updater's `repoDigests` holds the registry digest → `succeeded`, restart `skipped` (before any pull); else pull by digest, verify, tag, `spawnSelfUpdate(tag)`.

- [ ] **Step 1: Write the failing tests** (rewrite `world()` with a registry map and per-service running `{ digest, commit, container }`):
  - `nothing changed: no pull, verify or restart; every service unchanged`
  - `only web changed: web pulled and verified by digest, re-tagged, up; web updated, the rest unchanged; health without a commit check`
  - `backend changed: health waits for the new backend commit7 (FF_IMAGE_COMMIT; GIT_SHA for an old image)`
  - `one verify failure re-tags and restarts nothing` and `registry_failed before any pull` (Review Focus 5)
  - `unhealthy: previous digests re-tagged, only changed services recreated, rolled_back`
  - `manual rollback by digests; a pruned previous image is pulled by digest and verified first`
  - `legacy sha previous rolls back with that tag` (Review Focus 5)
  - `after a channel switch the update compares and tags under the new channel tag`
  - `livetv enabled: compared like the others; its verify failure drops livetv, the core update goes on`; `livetv enable takes the channel tag's digest`
  - `self-update: same digest → no pull, no restart; new digest → pull, verify, tag, helper`
  - `state: previousDigests survives a reload; a malformed entry is dropped`
- [ ] **Step 2: Run** `cd updater && npx vitest run test/job.test.ts test/livetv.test.ts test/config-state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three files plus `test/server.test.ts` and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(updater): update and roll back only the services whose digest changed`.

### Task B3: Per-service status, backend, *Admin → Update*

**Files:**
- Modify: `updater/src/server.ts` (`ServiceView`, `servicesView`, `status`; `start` wires `cachedRegistry`); `backend/src/updater.ts` (`parseStatus`), `backend/src/channel.ts`, `backend/src/updates.ts`; `web/src/lib/admin/updater.ts`, `web/src/lib/admin/UpdaterCard.svelte`, `web/src/lib/i18n/locales/*/admin.ts`; `docs/operations.md` (*Updater*), `CHANGELOG.md`
- Test: `updater/test/server.test.ts`, `backend/test/{updater,channel,update}.test.ts`, `web/src/lib/admin/updater.test.ts`

**Interfaces:**
- Produces (`ServiceView`): `{ service, state, health, sha, version, commit, digest, registry, changed }` — `sha` = `sha-<commit7>` (older backends), `version` backend only, `digest` = own digest of the running image, `registry` = channel tag's digest (cached, `null` on error), `changed` = both known ? differ : null; services `FF_SERVICES`, `updater`, `livetv` while enabled; `job.services` passes through.
- Produces (backend `UpdaterStatus.services[]`): `commit` (40 hex), `digest`/`registry` (`isDigest` shape), `changed` (boolean or null); `job.services` (`updated|unchanged` per known service).
- Produces: `channelUpdate(channel, { releaseNewer, behind, pinnedDiffers?, digestsDiffer? })` — nightly: `digestsDiffer ?? (behind > 0)`; `updateInfo` sets `digestsDiffer` from `updaterView(ctx)` (any `changed === true` → true, all `false` → false, else null) when `UPDATER_URL` is set.
- Web: under *Installiert:* one row per service: name, `commit7`, then `Update verfügbar` (`changed`) or `unverändert`; after a job its report (`aktualisiert`/`unverändert`), or `alles unverändert` when every entry is unchanged. Keys `admin.update.updater.svcChanged`, `svcUnchanged`, `svcUpdated`, `allUnchanged` (texts in Global Constraints). The rows have fixed height (no jump while values load).
- Docs *Updater*: compare, pull by digest, cosign, local tag, only changed services recreated, rollback per service. `CHANGELOG.md` `### Admin`: **Updates restart only what changed** (*Update verfügbar* / *unverändert*; a web-only update leaves gateway and backend running; rollback restores the previous images).

- [ ] **Step 1: Write the failing tests:** updater `status lists digest, commit, registry digest and changed per service; registry errors give null`; backend `parseStatus keeps commit, digest, registry, changed only in their shapes`, `nightly with the updater: available iff a service's digest differs; unknown falls back to commits behind`; web `per-service text: available, unchanged, updated, all unchanged`.
- [ ] **Step 2: Run** the three test sets (backend with `TEST_DATABASE_URL=…`). Expected: FAIL.
- [ ] **Step 3: Implement** the code, the texts in seven languages, the docs and the CHANGELOG bullet.
- [ ] **Step 4: Run** the tests, backend and web typecheck, `npm run build -w web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(update): per-service status, "unverändert" in Admin → Update`.

---

## Stage C — The commit moves out of the images (spec PR 2)

Still builds everything; each image now carries its image commit. Readers first (C1–C3), then the images (C4).

### Task C1: Services report their image commit

**Files:**
- Modify: `backend/src/config.ts` (`FF_IMAGE_COMMIT`, `WEB_INTERNAL_URL` default `http://web:3000`), `app.ts` (`/health`), `errorlog.ts`, `settings/registry.ts` (`BUILD_KEYS`), `livetv/client.ts` + `detect.ts`; `gateway/src/env.ts`, `gateway.ts:631`; `livetv/src/config.ts:63`, `server.ts:175`; `updater/src/config.ts:64-68`; each workspace's existing health/config tests

**Interfaces:**
- Produces: `imageCommit(cfg): string` in `backend/src/version.ts` — `FF_IMAGE_COMMIT` if 40 hex, else `GIT_SHA`, else `'dev'`; `/health` → `{ status: 'ok', version: imageCommit(cfg).slice(0, 7) }`; error log release `APP_VERSION ?? imageCommit7`.
- Produces: gateway `/health` → `{"status":"ok","image":<40 hex or null>}`; livetv `/healthz` → `version` and `image` both = its image commit (40 hex or null; spec table); `backend/src/livetv/client.ts` accepts `version` as SemVer (older livetv) or 40 hex; backend `LivetvState.image`; `web/src/lib/admin/livetv/StatusTab.svelte:233` shows a 40-hex version as its first 7 characters (one-line web change folded in here).
- Produces: updater `UpdaterConfig` → `version: null`, `gitSha` = `FF_IMAGE_COMMIT` else `GIT_SHA` (40 hex), so `/v1/status` `updater.sha` is its image commit.

- [ ] **Step 1: Write the failing tests:** `/health answers FF_IMAGE_COMMIT[0:7], else GIT_SHA[0:7]`; `gateway /health names its image commit`; `livetv healthz: version and image are the image commit`; `backend livetv client keeps a 40-hex version`; `backend livetv detect keeps image`; `updater config: no version, sha from FF_IMAGE_COMMIT`.
- [ ] **Step 2: Run** each workspace's file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the four typechecks. Expected: PASS.
- [ ] **Step 5: Commit** `feat: every service reports its image commit`.

### Task C2: The installed build

**Files:**
- Create: `backend/src/installed.ts`, `backend/test/installed.test.ts`
- Modify: `backend/src/channel.ts` (`buildInfo`), `backend/src/updates.ts` (`infoKey`, `fetchMain`, `current`), `backend/src/redeploy.ts` (`Rec`, `beginRedeploy`, `judge`, `ServiceSeen`), `backend/test/channel.test.ts`, `backend/test/update.test.ts`, `backend/test/redeploy.test.ts`

**Interfaces:**
- Consumes: B3 status fields, C1 reporters.
- Produces: `installedBuild(ctx, opts?: { fresh?: boolean }): Promise<InstalledBuild>`, `InstalledBuild = { commit: string; time: string | null; source: 'updater' | 'probes' | 'self'; services: Array<{ service: string; commit: string | null; digest: string | null }> }`. Services from `updaterView` (`backend gateway web`, `livetv` when listed), else probes (3 s): `${WEB_INTERNAL_URL}/_app/version.json` `version`, `${GATEWAY_URL}/health` `image`, livetv detect `image`; backend = `imageCommit(cfg)`. Newest = latest `commitTime`; an unknown time or dev commit → own commit, `source 'self'`. kv `update:installed:<repo>` 600 s (`fresh` bypasses).
- Produces: `commitTime(ctx, sha): Promise<string | null>` — GitHub `GET /repos/{UPDATE_REPO}/commits/{sha}` `commit.committer.date`, kv `update:commit:<repo>:<sha>` 604 800 s, error 60 s.
- `buildInfo`: `sha` = installed commit, `buildKind(installed, tagSha)`, label `<version>-nightly · <installed7>`; `updateInfo`: `current.sha`/`builtAt` = installed commit/time, compare `installed…latest`, `infoKey` uses the installed commit.
- `redeploy.ts`: `Rec.from` = installed commit, new `fromServices: Record<service, string>` (commit, or digest when listed); `newBuild` = fresh installed commit ≠ `r.from`; `onNew(s)` = its commit (or digest) ≠ `fromServices[s.service]`; a record without `fromServices` is ignored like any older shape.

- [ ] **Step 1: Write the failing tests:** `installed build from the updater: the newest service commit`; `from the probes without an updater`; `own commit when a time is unknown`; `nightly label and kind use the installed build`; `behind and builtAt come from the installed build`; `a web-only redeploy is done when web runs its new commit, judged without GIT_SHA`.
- [ ] **Step 2: Run** those four backend files (`TEST_DATABASE_URL=…`). Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the backend typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): the installed build replaces the baked commit`.

### Task C3: The web shows the backend's version

**Files:**
- Modify: `web/src/lib/version/codenames.ts` (drop the `version.json` import and `APP_VERSION`/`APP_CODENAME`), `web/src/lib/version/build.ts`, `web/src/lib/Footer.svelte`, `web/src/lib/player/devicecaps.ts`, `web/src/lib/webos/caps.ts`, tests `web/src/lib/version/version.test.ts`, `web/src/lib/player/devicecaps.test.ts`, `web/src/lib/webos/caps.test.ts`

**Interfaces:**
- Produces (`build.ts`): `BuildInfo` gains `version`, `codename`; `loadBuild(fetchImpl?): Promise<BuildInfo | null>` (one request per page load, resolves to the stored value later); `appVersion(): Promise<string>` → the answer's version, `'0.0.0'` when it failed (the backend's caps schema requires SemVer).
- Footer: the version span keeps its width (`visibility: hidden`) until `/api/version` answers; then `versionText(b)`; VersionEgg gets the answer's version and codename.
- Device caps (`devicecaps.ts:276,294`, `caps.ts:169-170`) await `appVersion()` before sending.

- [ ] **Step 1: Write the failing tests:** `footer text comes from /api/version, nothing before`; `caps send the backend's version, 0.0.0 when it is unknown`; `codenames.ts no longer imports version.json` (source text check).
- [ ] **Step 2: Run** `cd web && npx vitest run src/lib/version src/lib/player/devicecaps.test.ts src/lib/webos/caps.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, svelte-check, `npm run build -w web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): version from the backend, not baked into the web image`.

### Task C4: Images carry their image commit

**Files:**
- Modify: the six Dockerfiles (`mediaserver/Dockerfile:53,93`), `.github/actions/build-image/action.yml`, `ci.yml` (`docker`, `mediaserver-image`, `reproducible`), `.github/images.json` (`version.json` only in backend), `web/src/lib/version/kit-version.ts` + test, `scripts/reproduce-image.sh`, `docs/reproducible-builds.md` (*Check a published image yourself*, *What is compared*, *How the build is made deterministic*), `CHANGELOG.md`

**Interfaces:**
- Consumes: plan `images[x].commit`/`time` (A1).
- Produces (Dockerfiles): final stage `ARG FF_IMAGE_COMMIT=dev` + `ENV FF_IMAGE_COMMIT=$FF_IMAGE_COMMIT`; backend also `ARG APP_VERSION=`, `ARG APP_CODENAME=` → `ENV`; no `GIT_SHA`, `BUILD_TIME` anywhere; web build stage `ARG FF_IMAGE_COMMIT=dev` + `ARG SOURCE_DATE_EPOCH`, `COPY codenames.json ./` only; mediaserver `ARG FF_IMAGE_COMMIT=dev`, revision label `${FF_IMAGE_COMMIT}`.
- Produces: `kitVersionName(env)` → `FF_IMAGE_COMMIT` (not `dev`), else `SOURCE_DATE_EPOCH`, else the clock.
- Produces (action): new required inputs `commit`, `time`; build args `SOURCE_DATE_EPOCH=<time>`, `FF_IMAGE_COMMIT=<commit>`, backend also `APP_VERSION`/`APP_CODENAME` from `version.json`; labels written directly (no `metadata-action`): `title=friendflix-<service>`, `source`/`url=https://github.com/<repository>`, `licenses=AGPL-3.0-or-later`, `revision=<commit>`, `created=<time as ISO Z>`, mediaserver's title/description/`GPL-3.0-only` as today; no `.version`.
- Produces (`ci.yml`): `docker`, `mediaserver-image`, `reproducible` add `changes` to `needs`, `if: ${{ !cancelled() }}`, first step `Plan` failing with `::error::kein gültiger Plan (changes: <result>)` unless the result is `success` and `jq -e '.images'` parses; legs pass `commit`/`time`. The `Plan` step stays inline (it runs before checkout) and byte-identical in every job; D2's test enforces that.
- Produces (`reproduce-image.sh`): build args `FF_IMAGE_COMMIT`, `APP_VERSION`, `APP_CODENAME` (+ `GIT_SHA`, `BUILD_TIME` for old refs); `--compare`: `--ref` defaults to the image's `revision` label, env and labels copied as today (old images via `GIT_SHA`); otherwise `FF_IMAGE_COMMIT` = `image-commit` from the ref's own script if present, else REF; `SOURCE_DATE_EPOCH` = its commit time.
- `CHANGELOG.md` `### Upgrade notes`: **Update the updater first** (*Admin → Update → Updater aktualisieren*; an older updater cannot roll back the next update). `### Admin`: **One version, per-service images** (the version lives in the backend; the nightly label names the newest service).

- [ ] **Step 1: Write the failing tests:** `kitVersionName uses FF_IMAGE_COMMIT`; COPY guard with the new map; `no Dockerfile mentions GIT_SHA or BUILD_TIME; every final stage sets FF_IMAGE_COMMIT; only backend sets APP_VERSION` (text test).
- [ ] **Step 2: Run** `node --test scripts/changed-images.test.mjs` and `cd web && npx vitest run src/lib/version/kit-version.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, then the docs and CHANGELOG.
- [ ] **Step 4: Run** the tests, the workflow lint, `bash -n scripts/reproduce-image.sh`; with Docker, `scripts/reproduce-image.sh gateway` twice prints one digest (else say CI checks it). Expected: PASS.
- [ ] **Step 5: Commit** `ci: images carry their image commit, the version only in the backend`.

### Task C5: Releases stop touching `package.json`

**Files:**
- Modify: `scripts/release.mjs`, `scripts/release.test.mjs`, `.github/workflows/release.yml` (header comment and step name only), `package.json`, `backend/package.json`, `gateway/package.json`, `web/package.json`, `updater/package.json`, `livetv/package.json`, `package-lock.json` (root and workspace `version` fields)

**Interfaces:**
- Produces: `release()` writes `version.json` and `CHANGELOG.md` only (`summary.files` = those two); `PACKAGES`, `setPackageVersion`, `setLockVersions` and their tests go; every `package.json` and the lockfile's root and workspace entries say `0.0.0` once.

- [ ] **Step 1: Write the failing tests:** `release writes only version.json and CHANGELOG.md`; `every package.json and the lockfile say 0.0.0`.
- [ ] **Step 2: Run** `node --test scripts/release.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** (set the versions with a one-off `node -e`, never `npm install`).
- [ ] **Step 4: Run** the test and `npm ci --dry-run --ignore-scripts` (lockfile still consistent). Expected: PASS.
- [ ] **Step 5: Commit** `chore(release): version.json is the only version file`.

### Task C6: Base walk (report) and the burn-in

**Files:**
- Create: `scripts/burnin-status.sh`
- Modify: `scripts/changed-images.mjs`, `scripts/changed-images.test.mjs`, `scripts/reproduce-image.sh` (`--diff`), `.github/workflows/ci.yml` (`changes` registry access; `reproducible` burn-in step)

**Interfaces:**
- Produces: `findBase({ ancestors: string[], published: (sha) => Promise<boolean>, max = 50 }): Promise<string | null>` (`ancestors` = run commit first, then `git rev-list --first-parent`); `identityRegexp(repo): string` (Global Constraints rule); `plan(opts)` gains `registry = { digest(image, tag): Promise<string | null>, revision(ref): Promise<string | null>, verify(ref): Promise<boolean> }` and replaces A1's push branch: `published(c)` = every image has `sha-<c7>`; per image `base = { digest, revision, verified }`; `carry` iff verified and `revision === commit` (reason `unverändert seit <c7>`), else `build` (`Eingaben geändert` / `Basis nicht signiert` / `keine Basis`). Mode stays `report`: nothing acts on it yet. A registry or cosign error gives `base: null` (`keine Basis`) plus `::warning`, never a failed plan (Controller's call 13).
- CLI: `--registry ghcr.io/<owner lc>/<repo lc>` (digests and the `revision` label via `docker buildx imagetools inspect`, `cosign verify` with `identityRegexp` and the issuer); `identity --repo <owner/repo>` prints the regexp.
- `changes` job on publishable runs: `permissions: { contents: read, packages: read }`, GHCR login, `sigstore/cosign-installer` at publish.yml's SHA.
- `reproduce-image.sh --diff A B`: accepts `docker save` archives (descends a nested index to linux/amd64; layers with or without gzip by magic bytes); last line `verdict: equal|os-only|app` — `app` when `config` (Env, Labels, Cmd, Entrypoint, WorkingDir, User) differs or a differing path starts with `app/`.
- Burn-in step in `reproducible (x)` (publishable runs, `continue-on-error: true`, plan says `carry`): the compare step adds `--out "$RUNNER_TEMP/rebuilt.tar"`; equal amd64 manifests of `ci-<sha>` and base → `::notice title=burn-in::<x> gleich <digest>`; else `docker pull` + `docker save` the base and `--diff`: `os-only` → `::notice title=burn-in::<x> zählt (nur OS-Pakete)`, `app` → `::warning title=burn-in::<x> setzt zurück: <first path or config>`.
- `scripts/burnin-status.sh [N=30]`: last N push runs on `main` (`gh run list`), their `reproducible (…)` annotations (`gh api …/check-runs/<job id>/annotations`); prints `<sha7> zählt|setzt zurück|kein Burn-in` and the streak (Stage D merges at 20).

- [ ] **Step 1: Write the failing tests:** `findBase: the run commit itself first, then the newest published ancestor, null after 50`; `an unverified base is built, reason "Basis nicht signiert"` (Review Focus 4); `push plan: carry only when the verified revision equals the image commit`; `identityRegexp("example/friendflix") equals the updater rule`; `a registry error gives base null and build, the plan still succeeds`; `--diff verdicts: a changed file under app/ is "app", under usr/ "os-only", an Env change "app"` (two tiny OCI layouts built in a temp dir with `tar -czf`; any git use through A1's `tmpRepo()`).
- [ ] **Step 2: Run** `node --test scripts/changed-images.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, workflow lint, `bash -n` on both scripts. Expected: PASS.
- [ ] **Step 5: Commit** `ci: base walk and burn-in report`.

---

## Stage D — CI carries (spec PR 3)

Starts once `scripts/burnin-status.sh` shows 20 consecutive counting `main` runs; a found input joins the map and resets the count.

### Task D1: Plan modes, tag runs, `full`, weekly, waits

**Files:**
- Modify: `scripts/changed-images.mjs`, `scripts/changed-images.test.mjs`

**Interfaces:**
- Consumes: C6.
- Produces (`plan`): opts gain `ref` (`GITHUB_REF`; CLI `--ref <ref>`, which D2 passes) and every mode below keys on it; push mode `compare` (was `report`), classes from `changedFiles(base.commit, sha)` (no base → full); mode `full` for `--full` (honoured only on `refs/heads/main`) or a `full` file changed → every image `build`, reason `alles bauen`; mode `weekly` (event `schedule`) → backend gateway web updater `build`, reason `wöchentliche Prüfung`, livetv/mediaserver compared, classes full; mode `tag` (`refs/tags/v*`): tagged commit an ancestor of `origin/main` → `waitPublished` (45 min), base = the tagged commit, every image `carry`; any `build` there throws `ein Tag-Lauf baut nie einen Commit, den main veröffentlicht hat`; not an ancestor → backport: `findBase`, compare, reason `Backport`, logged. A dispatch on any other ref → `full`. Empty change set → docs class.
- Produces: `waitPublished({ published: () => Promise<boolean>, runState: () => Promise<'running' | 'failed' | 'none'>, timeoutMs, intervalMs = 30_000, sleep, now }): Promise<'published' | 'failed' | 'timeout'>`; CLI `wait-published --sha <s> --timeout-min <n>` (`runState` via `gh api repos/<repo>/actions/runs?head_sha=<s>&branch=main&event=push`), exit 0 only for `published`; the tag-run message on `failed`: `der main-Lauf für <sha7> ist fehlgeschlagen: dort neu starten, dann diesen Lauf`.
- Produces: `publishTags({ ref, sha, tags }): string[]` — main → `nightly`, `sha-<7>`; `vX.Y.Z` → `X.Y.Z`, `X.Y`, `X`, `sha-<7>`, plus `latest` when it is the highest plain `vX.Y.Z` in `tags`; `vX.Y.Z-rc.N` → `X.Y.Z-rc.N`, `sha-<7>`.

- [ ] **Step 1: Write the failing tests:** `a docs commit after an unpublished code commit runs full` (Review Focus 2); `map or script change → full`; `--full is ignored on a refs/tags/v* ref and on a pull_request`; `weekly rebuilds the four reproducible images and compares livetv and mediaserver`; `tag run waits for sha-<7> and carries everything; a build throws`; `a tag outside main compares with the nearest published ancestor`; `waitPublished: published, failed, timeout (fake clock)`; `publishTags: main, highest release, backport without latest, rc` (git through A1's `tmpRepo()`).
- [ ] **Step 2: Run** `node --test scripts/changed-images.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `ci: plan modes for tags, full and weekly runs`.

### Task D2: `test`, `e2e`, `dast` follow the plan

**Files:**
- Modify: `.github/workflows/ci.yml` (`on`, `test`, `e2e`, `dast`), `scripts/changed-images.test.mjs`

**Interfaces:**
- Produces (`on`): `workflow_dispatch.inputs.full` (boolean, default false), `schedule` (Global Constraints); every `PUBLISHABLE` copy and the `publish` `if` cover `schedule`.
- Produces (`changes` job, preflight F7): CLI gets `--ref "$GITHUB_REF"` and `--full` from the dispatch input; `timeout-minutes: ${{ startsWith(github.ref, 'refs/tags/v') && 50 || 5 }}`; permissions `{ contents: read, packages: read, actions: read }`; `env: { GH_TOKEN: ${{ github.token }} }` for `runState`.
- Produces: `test`, `e2e`, `dast` get `needs: changes`, `if: ${{ !cancelled() }}`, first step `Plan` (fail closed as C4, exports `TESTS`, `RUN_E2E`, `RUN_DAST`). `test` docs mode: checkout, setup-node, `npm ci`, `npm run spdx:check`, `npm run test:docs`, `npm run test:scripts`; full mode as today. `e2e`/`dast` off: the leg log line naming the web image commit, then every other step `if: env.RUN_E2E == 'true'` (resp. `RUN_DAST`). `secrets` unchanged.

- [ ] **Step 1: Write the failing test** `every required job needs changes, runs if !cancelled() and checks the plan first` (`ci.yml` as text; jobs `test e2e dast docker reproducible`, from D3 `docker-mediaserver`: `needs:` names `changes`, `if: ${{ !cancelled() }}`, first step `Plan`) (Review Focus 3); same file: `every Plan step is byte-identical` and `every PUBLISHABLE expression covers schedule`.
- [ ] **Step 2: Run** `node --test scripts/changed-images.test.mjs`. Expected: FAIL (test/e2e/dast lack it).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and the workflow lint. Expected: PASS.
- [ ] **Step 5: Commit** `ci: tests, e2e and dast do only what the change needs`.

### Task D3: Image legs build or carry; `docker (mediaserver)`

**Files:**
- Create: `.github/actions/image-leg/action.yml`
- Modify: `.github/workflows/ci.yml` (`docker`, `mediaserver-image` → `docker-mediaserver`, `reproducible`)

**Interfaces:**
- Consumes: plan, `build-image` action.
- Produces (`image-leg`): inputs `service`, `plan`, `publish`, `gate` (`'true'` blocks on CRITICAL/HIGH, `'false'` reports), `mediaserver-pins` (value only, passed through to `build-image`, which composes the label; Controller's call 12); outputs `digest`, `built`. Behaviour:

  | Plan | Event | Leg |
  |---|---|---|
  | carry | PR | leg log line (digest `—`), done |
  | carry | push/dispatch/schedule/tag | `imagetools create -t <img>:ci-<sha> <img>@<base digest>`; SARIF scan + upload; gate; gate failure, not a tag run, `gate == 'true'` → `build-image` once, gate the new digest (hard); tag run → fail |
  | build | PR | as today (load, scan) |
  | build | publishable | `build-image`; when `base.revision == commit` and the linux/amd64 manifests are equal → `imagetools create -t …:ci-<sha> <base>`, log `gleiche Bytes, behalten`, `built=false`; weekly build failure of backend/gateway/web/updater → `::warning`, carry |

- `docker`: `needs: [changes, docker-mediaserver]`, `if: ${{ !cancelled() }}`, Plan step, `image-leg`; smoke tests only `if: steps.leg.outputs.built == 'true'`.
- `docker-mediaserver`: `name: docker (mediaserver)`, Plan step, the base-pin step, `image-leg` with `gate: 'false'`, job output `digest`.
- `reproducible`: decides by digest, not by plan action (preflight F9): `ci-<sha>`'s digest = `plan.images[x].base.digest` → the leg log line; otherwise (built, Trivy rebuild, keep-if-equal miss) → today's compare. The C6 burn-in step goes.

- [ ] **Step 1: Extend the D2 structure test** to `docker-mediaserver`; add `no leg pushes on pull_request` (`publish: 'true'` only under `PUBLISHABLE`) and `reproducible compares whenever ci-<sha> differs from the base digest`.
- [ ] **Step 2: Run** `node --test scripts/changed-images.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the workflow lint. Expected: PASS.
- [ ] **Step 5: Commit** `ci: image legs build or carry; docker (mediaserver) joins the matrix`.

### Task D4: Publish signs new digests and moves all tags together

**Files:**
- Modify: `.github/workflows/publish.yml`, `.github/workflows/ci.yml` (`publish`; `publish-mediaserver` removed)

**Interfaces:**
- Consumes: `publishTags`, `identityRegexp` (CLI `identity` prints it).
- Produces (`publish.yml`): inputs `services` (default all six), `plan` (optional; empty = sign everything, the manual escape hatch). Job `sign` (matrix, name check as today): digest of `ci-<sha>`; on a tag ref or when it ≠ `plan.images[svc].base.digest`: cosign sign + both attestations; else log `bereits signiert (main, <commit7>)`; no tag moves. Job `promote` (`needs: sign`): `cosign verify` every digest with the rule (any failure → exit 1, no tag moved), then one step moves every image's `publishTags` (`imagetools create`). `metadata-action` leaves `publish.yml`.
- `ci.yml` `publish`: `needs: [changes, test, e2e, dast, secrets, docker, docker-mediaserver, reproducible]`, `if` also for `schedule`, `with: { plan: ${{ needs.changes.outputs.plan }} }`.

- [ ] **Step 1: Write the failing test** `publish.yml: sign never moves a tag; promote verifies before it tags` (text test on job blocks).
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and the workflow lint. Expected: PASS.
- [ ] **Step 5: Commit** `ci: sign new digests, verify the set, move all tags at once`.

### Task D5: Release precondition

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `wait-published` (D1).
- Produces: `timeout-minutes: 75`; permissions + `packages: read`, `actions: read`; before *Bump version* (not on resume): GHCR login, cosign-installer, `node scripts/changed-images.mjs wait-published --sha "$(git rev-parse HEAD)" --timeout-min 60` (`GH_TOKEN: github.token`); non-zero → refusal text (call 14), nothing committed. Header and summary: two files change; the `main` run builds the backend, the tag run carries everything.

- [ ] **Step 1: Run** the workflow lint on the current file (baseline). Expected: PASS.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** the workflow lint and `node --test scripts/release.test.mjs scripts/changed-images.test.mjs`. Expected: PASS. The spec's one dry run on a fork is the controller's, before the PR merges (report it as open).
- [ ] **Step 4: Commit** `ci(release): release only a published main`.

### Task D6: Media server pin wiring (once media stage 1 is merged in)

**Files:**
- Modify: `.github/workflows/ci.yml` (backend leg runs the pin script), `.github/images.json` (backend `argsFrom` + `mediaserver/pins/jellyfin/Dockerfile`, `scripts/mediaserver-pins.sh`), `.github/actions/image-leg/action.yml` (pin compare)

**Interfaces:**
- Consumes: media Task 10 `scripts/mediaserver-pins.sh <repository> [<ferrofin digest>]`, `needs.docker-mediaserver.outputs.digest`.
- Produces: the backend leg passes the script output as `mediaserver-pins` (value only; `build-image` from A3 composes `io.github.letsmanu.friendflix.mediaserver.pins=<value>`, Controller's call 12); a publishable backend build without a mediaserver digest fails (`::error::kein Medienserver-Digest für den Pin`); a carried backend whose pin label's `ferrofin=` digest ≠ the current one is built.

- [ ] **Step 1: Write the failing test** `COPY guard: the pin file and script are backend argsFrom` (A2 guard with the real files present). Expected: FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `node --test scripts/changed-images.test.mjs`, `bash scripts/mediaserver-pins.test.sh`, the workflow lint. Expected: PASS.
- [ ] **Step 4: Commit** `ci: backend pins the built or carried media server digest`.

### Task D7: Docs and CHANGELOG

**Files:**
- Modify: `docs/operations.md` (*Empfohlener Branch-Schutz*: + `docker (mediaserver)`, − `mediaserver-image`, `publish-mediaserver / …`, what `unverändert` means; *Release erstellen*: precondition, two files, backend-only build; *Release-Kanäle*: per-image digests, one version; *Images prüfen*: carried digests keep their `main` signature, release images are signed from the tag), `docs/reproducible-builds.md` (weekly check, carried legs), `ci.yml` header, `.github/dependabot.yml` first comment, `.github/images.json` (mediaserver `required: true`), `mediaserver/README.md` (part of releases), `CHANGELOG.md`

- [ ] **Step 1: Run** `node --test scripts/changed-images.test.mjs` after flipping `required`. Expected: FAIL (the operations.md check from A2).
- [ ] **Step 2: Write** the docs; `CHANGELOG.md` `### Admin`: **CI builds and publishes only changed images** (unchanged images keep their digest under `nightly`, `sha-<7>` and release tags; a release builds only the backend; docs-only commits skip tests and builds; weekly rebuild check).
- [ ] **Step 3: Run** the tests, `npm run test:docs`, `node --test scripts/proxy-config.test.mjs`. Expected: PASS.
- [ ] **Step 4: Commit** `docs: changed-only builds, releases and required checks`.
