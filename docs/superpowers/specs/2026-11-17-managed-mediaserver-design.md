# Managed media server

Status: the owner decided direction, approach, choices, security rule and staging on 2026-11-17 (listed under *Owner
decisions*; binding). Everything the owner did not decide is marked **Controller's call** with its reason. Stage 1 is specified
to build; stages 2–4 are outlines with their key decisions and open questions.

## Why

Today FriendFlix only *connects* to a media server somebody else runs:

- `MEDIA_SERVER` (env only, `settings/registry.ts` `ENV_ONLY_KEYS`) picks Jellyfin or Plex; `compose.plex.yaml` switches backend and
  gateway to Plex. The address and key (`JELLYFIN_URL` / `JELLYFIN_ADMIN_API_KEY`, `PLEX_URL` / `PLEX_TOKEN`) are settings
  (`media/index.ts` `mediaSettings()`), entered in the wizard's step 3 or *Admin → Einstellungen → Medienserver*.
- The bundled `jellyfin` service (profile `bundled`, `jellyfin/jellyfin:latest`, root, writable root file system, `MEDIA_PATH`
  from `.env`) is an unpinned extra that nobody supervises, and the updater explicitly never touches it (`updater/src/policy.ts`
  `FF_SERVICES`).
- FriendFlix's own image `ghcr.io/letsmanu/friendflix-mediaserver` (Ferrofin + numbered changes, `mediaserver/README.md`) can only be
  tried with `mediaserver/try.sh` on the host's shell.

So a new owner has to install, secure, update and back up a media server by hand before FriendFlix is useful, choose host folders
in `.env`, and look up the render group for the GPU. The owner's direction is a FriendFlix that runs on its own and can change
everything itself, while people who already run Jellyfin or Plex keep doing so.

## Owner decisions (binding)

1. **A + B.** FriendFlix manages the media server itself ("A"); an existing, self-run Jellyfin or Plex stays supported by address
   ("B", today's behaviour); there is a way to migrate to FriendFlix's own Ferrofin.
2. **Approach 1.** The updater creates and supervises the media server container directly through the Docker API from a **fixed
   template**; the backend and the admin only send choices (server kind, media subfolders, GPU on/off). Works for Compose and
   Portainer installs alike. Rejected: approach 2 (the updater writes a generated compose file: Portainer cannot see it, two sources
   of truth) and approach 3 (a fixed compose service toggled by settings: the folders would still need `.env`).
3. **Three choices** in *Admin → Einstellungen → Medienserver*:
   - *Ferrofin (eigener)*: `ghcr.io/letsmanu/friendflix-mediaserver`;
   - *Jellyfin (offiziell, verwaltet)*: kept while Ferrofin's HDR tone mapping is not proven on the owner's Intel GPU;
   - *Bestehender Jellyfin/Plex (Adresse)*: today's behaviour.
4. **Security.** The media **base folder** is set once and confirmed with a one-time code shown in the server log (like the setup
   code). In the settings, admins only pick read-only subfolders below it. Reason: choosing arbitrary host folders from the web is
   reading the whole host.
5. **Staged delivery, one PR each:**
   1. managed media server (this spec's main subject);
   2. migration from an existing Jellyfin to managed Ferrofin, **entirely inside FriendFlix's UI** (no CLI task for the user): a
      copy of the config like `try.sh`, switch over, one-click back; Jellyfin's real config is never touched; Ferrofin's adoption is
      one-way until Ferrofin 1.6.0;
   3. `.env` clean-up: everything left goes into settings, one `compose.yaml` for normal setups, `.env` still honoured;
   4. Plex → Ferrofin migration: a fresh scan plus watch history from FriendFlix's Plex mirror, with a FriendFlix id remap.

## Goals (stage 1)

1. **Choose.** The wizard's media step and *Admin → Einstellungen → Medienserver* offer the three choices. Choosing a managed kind
   runs: base folder (once, with the code) → subfolders with a library type each → GPU → metadata download on/off → *Einrichten*.
2. **Create and supervise.** The updater pulls (and for Ferrofin cosign-verifies) the pinned image, creates the container from the
   fixed template, starts it, waits for health, and recreates it when it disappears. Admin can start, stop, restart, update, back up,
   restore and remove it, and read its log.
3. **First run without a person.** FriendFlix creates the server's administrator, its API key (the existing automatic key flow), the
   libraries (one per chosen subfolder, no NFO writing) and the hardware acceleration settings, then saves `JELLYFIN_URL` and
   `JELLYFIN_ADMIN_API_KEY` itself.
4. **Least privilege.** No published port, read-only media, no capabilities, non-root, read-only root file system, internal network
   (plus optional egress for metadata), no Docker socket anywhere but `docker-proxy`.
5. **Updates.** Each FriendFlix build pins the media server image; the updater moves the container to it when nobody is watching,
   never downgrades the server's database, and snapshots the config before an upstream version change.
6. **Visibility.** Systemcheck line *Verwalteter Medienserver*, status card, log view, audit entries.
7. **Docs:** `docs/mediaserver.md` (rewritten: managed first, trial second), `docs/security.md`, `docs/setup.md`,
   `docs/operations.md`, German copies, CHANGELOG.

## Non-goals (stage 1)

- Migrating an existing server's users, ids or watch state (stages 2 and 4). Stage 1 sets up a **fresh** managed server.
- A managed Plex. Plex stays "existing, by address".
- Publishing the media server's port or its dashboard (see the owner questions).
- Several base folders (one base; see the owner questions).
- Moving `MEDIA_SERVER`, paths or ports out of `.env` (stage 3).
- Installing plugins (the Jellyfin webhook plugin stays optional; the session poll is the fallback, as today).
- Managing the request service or any other container besides the media server.

## Anti-goals

- **A web request that widens host access.** No route, from any role, can make the media server (or any helper container) see a host
  path outside the confirmed base folder, write to it, or see it outside the folders the admin picked.
- **A container option the template does not name.** The backend cannot send an image, a path outside the base, a device, a
  capability, a port, a network or an environment variable. A body with an unknown key is refused.
- **The Docker socket in any container but `docker-proxy`.** Backend, web, gateway, livetv and the media server never get it
  (`docs/security.md`, *No socket in the app*).
- **A one-way database step without a way back.** No upstream version change of the managed server without a snapshot first; never
  a downgrade onto a newer database.
- **Fighting the owner.** The updater never restarts a container that was stopped on purpose (in Admin or outside), never touches a
  container it did not create, and never removes data without an explicit choice.
- **A code or secret in a log the web can read.** The base-folder code goes only to the updater's stdout, never into its job log,
  `/v1/status`, an audit row or an answer.

## Constraints

- **Updater protocol** (`updater/src/protocol.ts`): HMAC-signed requests from the backend only, 60 s window, nonces once, fixed
  routes, bodies parsed exactly (`policy.ts` `parseLivetvBody` is the pattern). Today `MAX_BODY` is 1 KB and there are six routes.
- **One job at a time** (`job.ts` `Updater.busy`): media server jobs share the lock with update, rollback, self-update and livetv.
- **docker-proxy** (`compose.prod.yaml`, linuxserver/socket-proxy 3.4.7 by digest): `CONTAINERS`, `IMAGES`, `NETWORKS`, `VOLUMES`,
  `INFO`, `PING`, `VERSION`, `POST`, `ALLOW_START`, `ALLOW_STOP` are on; `ALLOW_LOGS`, `EXEC` and the rest are off. It filters by path
  and method, never by body: `POST /containers/create` with any body already passes. The updater already holds root-equivalent
  power (`docs/security.md`, *What an attacker with code execution in the updater can do*).
- **Stack origin** (`updater/src/stack.ts`): a Portainer or otherwise foreign stack is never recreated through compose. The media
  server does not go through compose at all, so this guard does not apply to it; it uses only the compose project name and the
  stack's networks.
- **The updater container** has no host file system, only the stack directory read-only, and runs as uid 1000 on the internal
  networks `updater`, `updater-docker` and `updater-egress`. It is not on `media`.
- **Media server seam** (`media/index.ts`, `media/setup.ts`): both managed kinds are `MEDIA_SERVER=jellyfin` to the backend and the
  gateway; Ferrofin speaks the Jellyfin API. `jellyfin/setup.ts` `createApiKey` needs a finished startup wizard and an admin's name
  and password.
- **FriendFlix data is keyed by the media server's ids**: profiles carry `jellyfin_user_id` / `jellyfin_pw_enc` (`db.ts`), and
  items, resume points, lists and recordings use the server's item ids. A different server means different ids.
- **Settings:** `MEDIA_SERVER` is env only; `JELLYFIN_URL` and `JELLYFIN_ADMIN_API_KEY` are settings that an env value (or
  `*_FILE`) locks. Saving a credential or a destination it goes to needs a sign-in at most 10 minutes old (`routes/adminSettings.ts`
  `needsReauth`).
- **Ferrofin image**: linux/amd64 only, about 1.1 GiB larger than upstream (Intel runtime), user `ferrofin` (uid 1000), data in
  `FERROFIN_DATA_DIR`. Its publish job is separate and not required for a release (`mediaserver/README.md`).
- Repo rules: 7 locales with identical key order, fictional names and placeholder hosts only, web coverage ≥ 94 %, glass and motion
  rules; probes and Systemcheck lines carry codes only.

## Approaches

Owner decision 2 settles the shape (approach 1). Within it:

### How the updater talks to Docker for the media server

- **A. The Engine HTTP API with JSON bodies built by pure functions (chosen, Controller's call).** `fetch` to `DOCKER_HOST`
  (`http://docker-proxy:2375/v1.41/...`, the version negotiated from `GET /version`). The create body is one object that a test can
  compare byte for byte, and that a second, independent function (the guard) checks before it leaves the process. Inspect answers
  are JSON, not Go templates.
- B. The `docker` CLI (`docker run` with an argument list), as the compose jobs do. Argument order and flag parsing sit between the
  template and the engine; `docker run` adds defaults of its own; the guard would have to parse arguments back.

### How the base folder reaches the container

- **A. A local volume that binds the base folder, mounted per subfolder with `VolumeOptions.Subpath` (chosen, Controller's call).**
  `POST /volumes/create` with driver `local`, `{type: none, o: "bind,ro", device: <base>}`; each subfolder is a `volume` mount of it
  with `Subpath: <relative path>`, read-only. The engine resolves the subpath inside the volume and refuses a path that escapes it
  through a symlink, at mount time (Engine 26.0, API 1.45), which also closes the race between our check and the mount.
- B. A bind mount of `<base>/<sub>` per folder. Docker follows a symlink in the source when it mounts, so a folder swapped for a
  link to `/` between check and create would be mounted. Used only as the **fallback for engines older than API 1.45**, with the
  helper's no-symlink check repeated right before every create; Systemcheck warns (`managed_engine_old`).
- C. Mount the whole base and only *configure* libraries for the chosen folders. The server could read everything below the base;
  the owner's rule is that only the picked subfolders are visible.

### Permission at the proxy

- **A. Keep the one proxy; add only `ALLOW_LOGS=1`; enforce the template in the updater (chosen, Controller's call).** Everything
  else the media server needs (create, start, stop, remove, pull, volumes, network connect, info) is already allowed. Because the
  proxy never sees bodies, a "narrower" proxy cannot limit what a create does; the narrowing has to live where the body is built.
  `ALLOW_LOGS` gives the updater nothing it could not already get (it can create any container) and is needed for the log view and
  for reading helper output.
- B. A second proxy instance for media server calls only. Same body blindness, one more privileged container.
- C. An own body-filtering proxy holding the socket. Would protect against an updater bug, but is a new privileged component with
  its own attack surface; kept as a later hardening idea, not stage 1.

### Where the choices live

- **A. The updater's state file holds the container's desired spec and the base folder; the backend holds the connection and the
  first-run progress (chosen, Controller's call).** The base folder must be something the backend cannot change (owner decision 4),
  so it lives on the updater's side. The backend needs nothing of the spec beyond what `/v1/status` reports.
- B. Settings in the database, sent to the updater on every action. Then backend code execution could set any base folder.

## Decisions (stage 1)

### Who may do what

- Every route is admin-only (the guard of *Admin → Update*). **Re-authentication** (sign-in at most 10 minutes old, the
  `needsReauth` rule) for: requesting a base folder, applying a spec, removing with data, restoring a backup, showing the dashboard
  credentials, switching between managed and external (Controller's call: each one changes which host data a container reads, deletes
  data, or reveals a credential).
- The wizard's media step offers the same flow under the setup session (`requireSetupSession`, CSRF header).
- Without an updater (`compose.no-updater.yaml`, `UPDATER_URL` unset or not answering) the managed choices are shown disabled with
  the reason; an existing managed container keeps running on its restart policy but cannot be changed.
- With `MEDIA_SERVER=plex` the managed choices are disabled ("Wechsel von Plex: kommt mit Stufe 4").
- With `JELLYFIN_URL` or `JELLYFIN_ADMIN_API_KEY` set in the environment (also `_FILE`) the managed choices are disabled
  (`url_pinned`): FriendFlix could not save the managed address.

### Fresh server only where nothing depends on ids (Controller's call)

A managed server starts empty: new user ids, new item ids. Stage 1 therefore offers *Einrichten* only while **no profile carries a
`jellyfin_user_id`** (a new install, or one that never linked a media server user). Otherwise the managed choices show "Umzug von
deinem Jellyfin: kommt mit Stufe 2" and stay disabled. Reason: a fresh server would orphan every profile link, resume point, list
and recording reference without a word; the migration (stage 2) keeps the ids. Whether an explicit "Neuanfang" should be allowed
earlier is an owner question.

The same rule applies to switching between the two managed kinds: they use different data volumes (a Jellyfin database adopted by
Ferrofin cannot go back), so switching kind is a fresh server too; managed Jellyfin → managed Ferrofin with ids kept is stage 2.

### The base folder and its code

Flow:

1. The admin types an absolute host path (wizard or Admin) and presses *Code anfordern*. Backend → updater:
   `{op: "base-request", path}`.
2. The updater checks the path **syntactically** (below), then with a helper container that the folder exists and is a directory,
   and that uid 1000 can list it (a warning, not a refusal, when it cannot: the media group can be added later).
3. It generates a code exactly like the setup code (`setup/code.ts` `newSetupCode`: 12 Crockford base32 characters, shown as
   `XXXX-XXXX-XXXX`), stores only its sha256 with the path, an expiry of **30 minutes** and a failure counter, and prints **one line
   to its stdout**:
   `FriendFlix media folder: to allow /srv/media as the media base folder, enter the code K7QM-2D9X-HT4R in Admin (valid until 14:32 UTC).`
   The line names the path, so whoever reads the log sees what they confirm. Nothing of it goes to the job log, `/v1/status`, the
   backend, an audit row or an error. The answer to the backend is `{pending: true, expiresAt}`.
4. Admin and wizard say where to find it: `docker compose logs updater | grep "media folder"`, or Portainer → Container `updater` →
   *Logs*.
5. The admin types the code: `{op: "base-confirm", code}` (normalised like `normalizeCode`). Right: the base is stored, the pending
   request cleared. Wrong: counted; the 5th wrong attempt clears the pending request. Expired: `expired`.

Rules (Controller's call, reasons in brackets):

- **Path syntax:** absolute, normalised, at most 200 characters, components of letters (any script), digits, space and `._-+()&'`,
  no `..`, no empty component, no component starting with `.` [no hidden or relative tricks].
- **Refused bases:** `/` and the system trees `/bin`, `/boot`, `/dev`, `/etc`, `/lib*`, `/proc`, `/root`, `/run`, `/sbin`, `/sys`,
  `/usr`, `/var/run`, `/var/lib/docker` (and anything below them); `/home`, `/var`, `/opt`, `/mnt`, `/media`, `/srv`, `/volume[0-9]+`
  themselves (a folder below them is fine) [a top-level tree holds more than media]; any path that **contains or equals** the Docker
  root directory (`GET /info` `DockerRootDir`) or the stack directory (the backend container's `working_dir` label) [they hold
  `.env`, the bootstrap secrets and every volume].
- **One pending request at a time;** a new request replaces the old one. `base-request` at most 3 per 10 minutes (updater, in memory)
  and the backend's own route limit [each request writes a log line].
- **Stored in the updater state** (`/state`, re-validated field by field on load like the rest of `state.ts`):
  `media.base = {path, volume, confirmedAt}` and `media.pending = {path, codeHash, expiresAt, failures}`.
- **Changing it later** runs the same flow with the new path. On confirm, chosen subfolders that also exist below the new base are
  kept (by their path relative to the old base), the others are dropped and listed; the container is recreated on the new base
  volume, then the old base volume is removed (it only binds; removing it deletes no files). **Clearing** the base needs no code
  (it only narrows), but only while no managed container exists.
- Base volume name: `<project>_mediaserver-base-<first 8 hex of sha256(path)>`, labels `friendflix.managed=mediaserver-base` and
  `friendflix.project=<project>`.

### Subfolders

- **Browse:** `{op: "browse", rel}` lists the directories directly below `<base>/<rel>` through a helper container: names only, no
  files, no sizes; hidden entries skipped; at most 300 entries (then `truncated`); each entry flagged `symlink` (shown, not
  selectable) or `unreadable` (uid 1000 cannot list it). Depth: a chosen folder is at most 3 levels below the base.
- **Per folder the admin sets** a library name (1–60 characters, shown in FriendFlix) and a type: *Filme*, *Serien*, *Musik*,
  *Gemischt* (Jellyfin collection types `movies`, `tvshows`, `music`, `mixed`).
- **Validation** (updater, before anything runs): at most 20 folders; each `rel` normalised, relative, no `..`, no hidden component,
  at most 3 levels and 200 characters; no folder inside another chosen one; each exists as a directory and no component below the
  base is a symlink (helper `lstat`, also on the subpath route, for a clear error); uid 1000 (plus the configured groups) can list
  it. Codes: `folder_missing`, `folder_symlink`, `folder_nested`, `folder_unreadable`, `too_many_folders`.
- **Read check** like `try.sh`: list, read one file, watch one subfolder (inotify); read and watch failures are warnings shown next
  to the folder (with `max_user_watches` when the watch fails), not refusals.
- **Container path:** `/media/<slug>`, the slug from the library name (`[a-z0-9-]{1,40}`, unique, numbered on a clash). The template
  accepts any absolute target that is normalised, not `/` and not inside a reserved path (`/config`, `/cache`, `/ferrofin-data`,
  `/tmp`, `/dev`, `/proc`, `/sys`, `/etc`, `/usr`, `/bin`, `/lib*`): stage 2 needs Jellyfin's own target paths and must not need a
  template change.
- **Media group:** when uid 1000 cannot list the base but its group can, the UI offers *Gruppe <gid> hinzufügen*; the gid (a number
  1–65535, never 0) goes into the spec as `mediaGid`.
- A Live TV recordings folder in library mode (`compose.livetv-library.yaml`) is an ordinary subfolder; when the admin picks the folder
  that `LIVETV_RECORD_LIBRARY_JF_PATH` names, the UI offers to set that setting to the new target path.

### GPU

- **Detection** (helper, on request and before every apply): `/dev/dri` bound read-only, the render nodes (`renderD*`) with their
  group ids and the vendor from `/sys/class/drm/renderD*/device/vendor` (`0x8086` Intel, `0x1002` AMD; `/sys/class/drm` bound
  read-only); NVIDIA from `GET /info` `Runtimes` containing `nvidia`.
- **Choices:** *Aus*, *Intel/AMD (VA-API/QSV)*, *NVIDIA* (only offered when detected). Preselected from detection.
- **Intel/AMD:** device `/dev/dri:/dev/dri` (`rwm`), `GroupAdd` = every distinct render node gid (at most 4, numbers, never 0). The
  gids are re-read before every create (a host update can change them); a change recreates the container at the next media update.
- **NVIDIA:** `DeviceRequests: [{Driver: "nvidia", Count: 1, Capabilities: [["gpu"]]}]` and
  `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`; nothing else (Controller's call: the livetv overlay's shape, one GPU).
- **The server's own settings** are written by the backend after the first run and after a GPU change, through the encoding
  configuration API: Intel → QSV, AMD → VA-API (`/dev/dri/renderD128` or the detected node), NVIDIA → NVENC; tone mapping on
  (`bt2390`), hardware decoding for the codecs the vendor supports. Off → software.
- **HDR test** (Controller's call: it is the owner's open question about Ferrofin): *HDR-Test* runs `mediaserver/probe.sh` tests 1
  and 2 (OpenCL on VA-API; QSV + OpenCL tone mapping of a generated 2 s HDR10 clip) in a throw-away container of the chosen image with
  the GPU passed in, no network, and shows PASS/FAIL per test. The ffmpeg arguments are constants copied from `probe.sh`; a CI check
  keeps both in step.

### The container template

Built only by `updater/src/mediaserver/template.ts` `containerSpec(desired, facts)` from the validated desired spec and facts the
updater read from Docker itself (project, network ids, render gids, image digest). The request can only name the kind, the folders
(`rel`, `target`), the GPU choice, `mediaGid`, metadata on/off and the time zone.

| Field | Ferrofin | Jellyfin (managed) |
|---|---|---|
| `Image` | `ghcr.io/<owner>/<repo>-mediaserver@sha256:<digest>`: the digest of the tag `sha-<7>` of the FriendFlix build that runs (state `current`, else the backend's sha tag), pulled and cosign-verified like FriendFlix's own images (`policy.ts` `cosignIdentity`, `pinnedRef`) | `docker.io/jellyfin/jellyfin@sha256:<digest>` from the pin file (below); the digest is the integrity check (no cosign signature of ours) |
| name / `Hostname` | `<project>-mediaserver` / `mediaserver` | same |
| `User` | `1000:1000` (the image's `ferrofin`) | `1000:1000` |
| `GroupAdd` | render gids (GPU on), `mediaGid` (when set) | same |
| `Env` | `TZ`, `FERROFIN_DATA_DIR=/ferrofin-data`, Ferrofin's cache directory variable `=/cache`, `FERROFIN_ADMIN_PASSWORD` on the first-run create only; NVIDIA variable when chosen | `TZ`, `XDG_CACHE_HOME=/cache/xdg`; the image's own `JELLYFIN_*` directories (`/config`, `/cache`); NVIDIA variable when chosen |
| data | volume `<project>_mediaserver-ferrofin-data` → `/ferrofin-data` | volume `<project>_mediaserver-jellyfin-config` → `/config` |
| cache | volume `<project>_mediaserver-ferrofin-cache` → `/cache` | volume `<project>_mediaserver-jellyfin-cache` → `/cache` |
| media | per folder: volume `<base volume>`, `Subpath: <rel>`, target `/media/<slug>`, `ReadOnly: true` (fallback: bind `<base>/<rel>`, read-only, `rprivate`) | same |
| `Tmpfs` | `/tmp`: `size=512m,mode=1777` | same |
| `ReadonlyRootfs` | `true` | `true` |
| `CapDrop` / `CapAdd` | `["ALL"]` / none | same |
| `SecurityOpt` | `["no-new-privileges:true"]` | same |
| `Privileged`, `PidMode`, `IpcMode`, `UsernsMode`, `CgroupnsMode` | unset (defaults) | same |
| `Devices` / `DeviceRequests` | as in *GPU* | same |
| network | `<project>_media` with alias `mediaserver`; `<project>_egress` connected after create when metadata download is on | same |
| `PortBindings` / `ExposedPorts` | none | none |
| `RestartPolicy` | `unless-stopped` | same |
| `Init` | `true` (reaps orphaned ffmpeg processes) | same |
| `StopTimeout` | 30 s (the database is flushed on stop) | same |
| `PidsLimit` | 4096 | same |
| `LogConfig` | `json-file`, `max-size=10m`, `max-file=3` | same |
| `Healthcheck` | the image's own: our image gains a `HEALTHCHECK` (change 0003 in `mediaserver/README.md`) | the image's own (`curl /health`) |

Labels on the container: `friendflix.managed=mediaserver`, `friendflix.project=<project>`, `friendflix.kind=ferrofin|jellyfin`,
`friendflix.template=1`, `friendflix.spec=<sha256 of the canonical create body without this label>`,
`com.centurylinklabs.watchtower.enable=false` (Watchtower-style updaters must never upgrade it: a newer image migrates the database
one-way), `org.opencontainers.image.title` stays the image's. Volumes carry `friendflix.managed=mediaserver-data|-cache|-base|-backup`
and `friendflix.project`. **No compose labels** (Controller's call): the container is not a service of the stack, so `docker compose
up` never recreates or orphans it, and `down -v` never deletes its data.

Controller's calls with reasons:

- **uid 1000 for Jellyfin too:** the official image runs as root by default; it supports any uid, and root inside buys nothing here.
- **Read-only root file system** for both. The builder boots each image read-only, plays and transcodes a title, and adds a `tmpfs`
  (or an environment variable pointing into `/cache`) for any further path either server writes; read-only is never dropped.
- **Ferrofin data in `/ferrofin-data`,** not the image's `/data` (as in `try.sh`): libraries often live under `/data`, and stage 2 keeps
  Jellyfin's own media paths.
- **Metadata download (egress) on by default:** without it neither server fetches posters, titles or descriptions; the switch is
  there for owners who only use local metadata.
- **No published port:** backend and gateway reach `http://mediaserver:8096` over `media`; the dashboard is not reachable from
  outside in stage 1 (FriendFlix configures what it needs through the API).

### The guard (independent check)

`updater/src/mediaserver/guard.ts` `assertManaged(body)` and `assertHelper(body)` check every create body before it is sent, as a
second implementation that does not call the template: refuses `Privileged`, any `CapAdd`, `CapDrop` other than `["ALL"]`, any
`SecurityOpt` but `no-new-privileges:true`, host or container `NetworkMode`/`PidMode`/`IpcMode`/`UsernsMode`, any port binding or
`PublishAllPorts`, any bind source other than the base folder's subfolders (fallback mode) or the helper's fixed sources, any
volume not named `<project>_mediaserver-*`, any mount of a path containing `docker.sock` or `containerd`, devices other than
`/dev/dri`, device requests other than the one NVIDIA entry, `ReadonlyRootfs` false, `User` other than `1000:1000`, an image not
pinned by digest or not one of the two allowed repositories, environment keys outside the per-kind list, labels without the
managed set. A refusal is `template_violation` and is never retried. Tests feed it every field of the Docker create schema that
can widen access.

The same guard runs on **inspect** of an existing container before the updater adopts or acts on it (`managed_tampered` when a
container with our labels has, for example, been given a port or privileges in Portainer: shown in Admin and Systemcheck, never
started or adopted; *Neu anlegen* replaces it from the template).

### Helper containers

Short-lived containers for checks, listings, GPU detection, the HDR test, backups and restores. Fixed template:

- image: the **updater's own image** (its container's image id; for the HDR test: the chosen media server image with ffmpeg as entry
  point). Reason (Controller's call): already local and signed, our own tested code (`updater/dist/mediaHelper.js` with fixed verbs
  `check`, `browse`, `gpu`, `backup`, `restore`), no third image to pin;
- `NetworkMode: none`, `ReadonlyRootfs`, `CapDrop ALL`, `no-new-privileges`, `User 1000:1000` plus the spec's groups, `AutoRemove`,
  labels `friendflix.managed=helper` and `friendflix.project`, a 2-minute limit (backup/restore: 2 hours);
- mounts only from this list, each read-only unless stated: the base volume (or, for `base-request`, a read-only bind of the
  requested path itself), `/dev/dri`, `/sys/class/drm`, the data volume (read-write for `restore` only), the backup volume (read-write
  for `backup` and `restore`);
- output: one JSON line on stdout, read through the logs endpoint after `wait` (codes, names, numbers; parsed field by field).

### Proxy change

`compose.prod.yaml` `docker-proxy`: `ALLOW_LOGS: 1`, with the comment updated (used for the media server's log and helper output; the
updater asks for the logs of containers carrying our labels only). Everything else stays. Existing installs get it when they refresh
their compose files and run `docker compose up -d` once (Portainer: update the stack file); until then the updater reports
`proxy_outdated` (a `GET /containers/<own id>/logs?tail=0` answers 403), Admin and Systemcheck say what to do, and managed mode is
not offered. `docs/security.md` gains the logs endpoint in *Proxy allowlist* and loses it from *What the proxy blocks*.

### Updater API

One new route **`POST /v1/mediaserver`** (seven in total), signed like the others, `MAX_BODY` **8 KB for this route** (20 folders),
body exactly one of:

| Body | What |
|---|---|
| `{op: "base-request", path}` | check the path, issue and log a code |
| `{op: "base-confirm", code}` | confirm the pending base |
| `{op: "base-clear"}` | only without a managed container |
| `{op: "browse", rel}` | directories below `<base>/<rel>` |
| `{op: "gpu"}` | detection result |
| `{op: "apply", spec: {kind, folders: [{rel, target}], gpu, mediaGid, egress, tz}, firstRun?: {password}}` | create or recreate (job) |
| `{op: "finish-setup"}` | recreate without `FERROFIN_ADMIN_PASSWORD` (job) |
| `{op: "start" \| "stop" \| "restart"}` | (job) |
| `{op: "update"}` | move to the image of the running FriendFlix build (job) |
| `{op: "hdr-test", kind}` | probe tests 1 and 2 (job) |
| `{op: "backup", trickplay: boolean}` / `{op: "restore", id}` | (jobs) |
| `{op: "remove", data: boolean}` | (job) |
| `{op: "logs", tail}` | `tail` 50–500; answer `{lines}` |

Unknown keys, extra keys or wrong types: 400 `invalid_body`. `password` must match `^[A-Za-z0-9_-]{43}$`; `tz` an IANA name
(`^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$`); `mediaGid` 1–65535; `kind` `ferrofin` | `jellyfin`; `gpu` `off` | `dri` | `nvidia`. Job ops
answer 202 with the job like `/v1/livetv`; `busy` 409.

`GET /v1/status` gains `mediaserver` (parsed field by field by `backend/src/updater.ts`):
`{available, reason, base: {set, path, pending, expiresAt}, desired: {kind, folders, gpu, mediaGid, egress, run} | null,
container: {state, health, kind, image: {digest, tag, upstream}, template, tampered} | null, pin: {tag, upstream} | null,
engine: {subpath, logs, arch, nvidia}, error}`. `available` is false with `reason` `no_logs` (`proxy_outdated`), `no_project`,
`no_network` (no `<project>_media`, or backend and gateway not attached to it).

Job actions extend `state.ts` `JobAction`: `mediaserver-apply`, `-finish`, `-start`, `-stop`, `-restart`, `-update`, `-hdr-test`,
`-backup`, `-restore`, `-remove`, `-recover`. Job log lines are fixed messages and codes (never a path below the base, never a
code, never server output).

### Lifecycle

Steps of `apply` (each a fixed code on failure): `check` (base present, folders valid and readable, GPU present when chosen,
networks found, name free or ours) → `pull` → `verify` (Ferrofin: cosign) → `snapshot` (only when an existing data volume moves to
another upstream version) → `create` → `start` → `health` (Docker health `healthy`, or running for 60 s when the image has none;
3 minutes limit) → done. Error codes: `no_base`, `base_missing` (the base folder disappeared, for example an unmounted NAS share),
`folder_*`, `gpu_missing`, `nvidia_missing`, `no_network`, `name_taken` (a container named `<project>-mediaserver` without our labels:
never touched), `pull_failed`, `image_missing` (no media server image for this build), `arch_unsupported` (Ferrofin on a non-amd64
engine), `verify_failed`, `snapshot_failed`, `downgrade_refused`, `template_violation`, `create_failed`, `start_failed`, `unhealthy`.

- **Recreate** = create the new container under a temporary name, stop and remove the old one, rename the new one, start it (the
  old one is started again when any step fails). Media server downtime is the restart only.
- **Ownership:** the updater acts only on containers with `friendflix.managed=mediaserver` **and** `friendflix.project=<own project>`
  that pass the guard. The container id is recorded in state; after a lost state volume a labelled, guard-clean container is
  adopted.
- **Supervision** (Controller's call: minimal, never fighting the owner): every 60 s while no job runs, a desired-running container
  that is **missing** is recreated (`mediaserver-recover`, reported to the backend, audited); a **stopped** container is left alone
  (Docker's `unless-stopped` restarts crashes; a stop from Admin or Portainer is a choice). A spec hash that differs from what the
  current template would build (an updater update changed the template, render gids changed) is `update_pending`, applied with the
  next media update, never on its own.
- **Stop / start / restart** by the admin set `desired.run`.
- **Remove:** stops and removes the container; keeps the data, cache and backup volumes unless `data: true` (then removes the data
  and cache volumes; the backup volume stays until removed on its own, Controller's call: the last way back). The base volume stays
  until the base is cleared. The backend then switches to *Bestehender Jellyfin/Plex* with empty fields, or back to the saved
  external server when there is one.
- **`docker compose down`**: removes FriendFlix's containers but cannot remove the `media` network while the media server is attached
  ("has active endpoints"; the rest of `down` has happened). A later `up -d` reuses the network. `docs/mediaserver.md` says so and
  how to stop the media server first. (Controller's call: the alternative, compose labels on the container, would make it a service
  compose recreates or orphans.)

### Images and updates

- **Ferrofin pin:** the image of the same FriendFlix build (`friendflix-mediaserver:sha-<7>`; `publish.yml` already tags it). Its
  upstream version is the label `io.github.letsmanu.friendflix.mediaserver.ferrofin`.
- **Jellyfin pin:** `updater/pins/jellyfin/Dockerfile`, one line `FROM docker.io/jellyfin/jellyfin:X.Y.Z@sha256:<64 hex>`, copied into
  the updater image and parsed at start with exactly that pattern (refused otherwise: managed Jellyfin unavailable,
  `pin_invalid`). `.github/dependabot.yml` adds the directory to the docker ecosystem (its own group, one PR), so a Jellyfin release
  arrives as a PR like Ferrofin's.
- **When it moves** (Controller's call): never inside an update or rollback job of FriendFlix (a media server restart must not hold
  back or roll back FriendFlix). After a successful FriendFlix update, when the media server's image differs from the new pin, the
  backend starts `mediaserver-update` when no playback session is active (checked every 5 minutes), at the latest at the next
  `AUTO_UPDATE_TIME`; *Jetzt aktualisieren* runs it at once. With automatic updates off, only the button.
- **Never down** (Controller's call: Ferrofin and Jellyfin migrate their databases one-way): a pin whose upstream version is older
  than the running container's is `downgrade_refused`; the container stays (a FriendFlix rollback keeps the newer media server; Admin
  shows "neuer als dieser FriendFlix-Stand").
- **Snapshot before an upstream change:** the data volume (without logs, transcodes and trickplay) as a backup tagged `auto`, kept:
  the last 2 automatic ones.
- **Missing image** (the media server's publish job is not required for a release): `image_missing`; an existing container stays on
  its image; a new setup is refused with a hint to choose managed Jellyfin.
- The **trial** wording in `mediaserver/README.md` ("The FriendFlix updater never pulls or recreates it") changes to "only the managed
  media server, from its pin".

### First run

Backend background task `mediaManagedTick` (where `BACKGROUND_JOBS=true`, every 10 s while a setup is unfinished, idempotent at each
step, Controller's call: survives a backend restart in the middle):

1. **Generate** the administrator: name `friendflix-admin` (Ferrofin: where its first-run variables allow a name; otherwise its
   default, which the builder confirms) and a password of 32 random bytes, base64url (43 characters), stored encrypted.
2. **Apply** with `firstRun.password` (Ferrofin only; Jellyfin gets no password in its environment).
3. **Ferrofin:** wait for `/System/Info/Public`; **Jellyfin:** the startup wizard through its API: configuration (UI culture and
   metadata language from the instance's default language, country from `TZ`), the first user with the generated name and password,
   remote access `EnableRemoteAccess: false` and no port mapping (the container is reachable only on internal networks; the builder
   confirms that the gateway's requests count as local, and uses `true` otherwise, which changes nothing without a published port),
   complete. A wizard already complete when FriendFlix arrives is `wizard_taken` (something else on the `media` network was faster):
   the setup stops, Admin offers *Neu anlegen* (remove with data, apply again).
4. **API key** through `jellyfinSetup.auto.run` (unchanged): save `JELLYFIN_URL=http://mediaserver:8096` and the key through the
   settings store (source `db`, audited as a settings change).
5. **Libraries:** one per folder (`POST /Library/VirtualFolders`, name, collection type, path `/media/<slug>`), options: real-time
   monitoring on, local metadata saving off, no metadata savers (no NFO: the media is read-only), metadata language from the
   instance. Then a library scan.
6. **Hardware acceleration** settings as in *GPU*.
7. **Ferrofin:** `finish-setup` (recreate without the password variable, so the password does not stay in the container's
   configuration).
8. Done: `setup = done`; the wizard's media step continues.

Progress is shown as these steps; each failure is a code with a *Nochmal* that resumes at that step.

**Dashboard credentials:** *Zugang anzeigen* (re-authentication, audited) shows the name and password once in a dialog, for the
rare case an owner needs the server's own dashboard (reachable only once a port is published: see the owner question on
that).

### Backend storage

Migration (the next free number): one row, the backend's half of managed mode.

```sql
create table if not exists media_managed (
  id int primary key default 1 check (id = 1),
  kind text check (kind in ('ferrofin','jellyfin')),
  setup text not null default 'none'
    check (setup in ('none','applying','first_run','api_key','libraries','hwaccel','finishing','done','failed')),
  setup_error text check (setup_error ~ '^[a-z][a-z0-9_]{0,39}$'),
  admin_user text,
  admin_password_enc text,        -- crypto.encrypt(APP_ENC_KEY, …)
  libraries jsonb not null default '[]',   -- [{slug, name, type}] until created in the server
  external_url text,              -- the external server before switching to managed (address only, media/address.ts addressOnly)
  external_key_enc text,
  updated_at timestamptz not null default now()
);
```

No new registry keys (Controller's call): `JELLYFIN_URL` and `JELLYFIN_ADMIN_API_KEY` stay the connection, `MEDIA_SERVER` stays env
only until stage 3. The desired container spec and the base folder live only in the updater state.

### Switching

- **External → managed** (allowed by the id rule above): the current `JELLYFIN_URL` and key are kept in `external_url` /
  `external_key_enc`; managed setup replaces the settings.
- **Managed → external:** the admin enters an address (manual or *API-Schlüssel automatisch anlegen*); the managed container is
  stopped, not removed. *Zurück zu <address>* uses the saved external values in one click when they exist.
- Both directions warn that the other server has other ids, as changing the address does today; with stage 2 the warning knows
  when the ids are the same (a copy).

### Backup and restore

- *Sicherung erstellen*: stop the container, a helper writes `<kind>-<YYYYMMDD-HHMM>-<upstream>.tar.gz` of the data volume (without
  logs, transcodes, and trickplay unless chosen) into `<project>_mediaserver-backup`, start again. Kept: the last 3 manual and 2
  automatic backups (Controller's call: a NAS disk is not filled by forgotten backups).
- *Wiederherstellen*: same kind only; refused when the backup's upstream version is newer than the image (`downgrade_refused`); stop,
  replace the volume's contents, start, health.
- `docs/operations.md` *Backups & Wiederherstellung* gains the media server: what the backup volume holds and the one command that
  copies it to the host, next to `scripts/backup-bootstrap.sh`.

### Portainer and several instances

- On a **Portainer** stack the updater cannot recreate FriendFlix's services, but it can run every media server job: none of them
  uses compose. The project comes from the updater's own `com.docker.compose.project` label, the networks from Docker
  (`com.docker.compose.project` + `com.docker.compose.network` labels: `media`, `egress`). Portainer lists the media server under
  *Containers*, outside the stack. A Portainer *Duplicate/Edit* that changes the container is caught by the guard on inspect
  (`managed_tampered`). Removing the stack in Portainer stops at the `media` network like `compose down`.
- **Several FriendFlix instances** on one engine: every name, volume and label carries the compose project; the updater only sees its
  own project's containers; each instance confirms its own base. Two instances may use the same base folder (read-only). Two stacks
  with the same project name already collide today.

### Admin and wizard

- **Admin → Einstellungen → Medienserver**, card *Medienserver* first on the tab: the three choices as a segmented control.
  *Bestehender Jellyfin/Plex*: today's fields. A managed kind:
  - **Basisordner:** the confirmed path, or the path field with *Code anfordern*, then the code field with the countdown and where to
    find the line;
  - **Ordner:** the folder browser (breadcrumb, one level at a time) with name and type per chosen folder, read-check results;
  - **Grafikkarte:** detection result, choice, *HDR-Test*;
  - **Metadaten aus dem Internet** switch;
  - **Status:** state, health, kind and upstream version, image age vs. pin, last job with its steps;
  - **Actions:** *Einrichten* / *Übernehmen*, *Starten*, *Stoppen*, *Neu starten*, *Aktualisieren*, *Sicherung*, *Wiederherstellen*,
    *Protokoll*, *Zugang anzeigen*, *Entfernen* (with "Daten löschen" as an extra confirmation typing the kind's name);
  - while Ferrofin is a trial, its choice carries *Test* and links `docs/mediaserver.md`.
- **Protokoll:** the last 300 lines (`tail` up to 500), fetched on demand, never stored: ANSI codes stripped, lines cut at 500
  characters, and values after `api_key=`, `apikey=`, `token=`, `X-Emby-Token`, `X-MediaBrowser-Token`, `Authorization`, `Pw` and
  `password` replaced with `…` (Controller's call: the server logs request URLs). Copy button.
- **Wizard step 3** gains the same choice; the managed path runs base → folders → GPU → *Einrichten* with progress, then continues.
  The default selection while Ferrofin is a trial: *Jellyfin (offiziell, verwaltet)* (Controller's call, owner decision 3's reason;
  see the owner questions).
- Texts in all 7 languages; glass and motion rules.

### Backend routes

`routes/adminMediaserver.ts` (admin) and the matching setup routes (setup session): `GET /api/admin/mediaserver` (updater status
`mediaserver` + `media_managed` + the id rule's verdict), `POST …/base`, `…/base/confirm`, `…/browse`, `…/gpu`, `…/apply`,
`…/action` (`start|stop|restart|update|backup|restore|remove|hdr-test`), `…/logs`, `…/credentials`, `…/mode`. Rate limits: base
request 3 per 10 minutes, confirm 10 per 10 minutes, logs 20 per minute, everything else the `/v1/livetv` route's limit. Answers
carry codes, never Docker or server text.

### Audit (Controller's call: the `system.updater_*` pattern)

`mediaserver.base_request` {path}, `mediaserver.base_confirm` {result: ok | wrong | expired | locked, path on ok},
`mediaserver.base_clear`, `mediaserver.apply` {kind, folders: n, gpu, egress}, `mediaserver.action` {op},
`mediaserver.result` {action, result, error} (written when the backend sees a job end, like `reconcileAudit`), `mediaserver.recover`,
`mediaserver.credentials_view`, `mediaserver.mode` {from, to}. Never a code, a password or a key.

### Systemcheck

New line **`media.managed`** (*Verwalteter Medienserver*), after `media.server` (group `media`):

| Condition | Status / cause |
|---|---|
| external server in use | `not_set_up` / `managed_off` (neutral) |
| updater missing | `warning` / `managed_no_updater` (when a managed container exists), else `not_set_up` |
| proxy without logs | `warning` / `managed_proxy_outdated` (docs link) |
| container missing or stopped while desired running | `problem` / `managed_down` |
| unhealthy | `problem` / `managed_unhealthy` |
| tampered | `problem` / `managed_tampered` |
| base folder or a chosen folder missing | `problem` / `managed_base_missing`, `warning` / `managed_folder_missing` |
| GPU chosen but absent | `warning` / `managed_gpu_missing` |
| last job failed | `warning` / `managed_job_failed` (params `code`) |
| image differs from the pin for more than 7 days | `warning` / `managed_update_pending` |
| engine older than API 1.45 | `warning` / `managed_engine_old` |
| no backup in 30 days | `warning` / `managed_backup_old` |
| else | `ok` (params `kind`, `upstream`) |

`media.server`, `media.playback` and `media.encoder` keep reading the server through its API as today.

### Security notes (docs/security.md)

- *Updater* section: the seventh route, its bodies, the template and the guard, the helper containers, the base-folder code (only on
  the updater's stdout), `ALLOW_LOGS`.
- *What an attacker with code execution in the backend can do* gains: create, change, stop and remove the managed media server
  **from the template only**; choose subfolders **below the confirmed base**; read the media server's log (redacted); start backups
  and restores; reveal the media server's admin password (also readable from the database with the encryption key). Cannot: set a
  base folder (needs the code from the updater's log), mount anything else, add a port, a device or privileges, run another image.
- New residual risks: on engines older than API 1.45, someone who can write inside the base folder can race a symlink swap between
  the check and the mount (the server then reads, as uid 1000 without capabilities, what that uid can read); the media server sees
  the internal `media` network like the bundled Jellyfin today.

### Testing (stage 1)

- Updater: golden create bodies per kind and GPU choice; the guard against every widening field; path rules (each refused base,
  `..`, hidden, symlink flags); the code flow (hash only, 30 minutes, 5 failures, one pending, never in job log or status); state
  load re-validation; ownership and adoption; supervision (missing → recreate, stopped → left); recreate rollback; downgrade
  refusal; pin file parsing; body parsing per op.
- Backend: routes (admin, setup session, re-auth, limits), the id rule, the first-run steps against a fake Jellyfin API (wizard,
  wizard_taken, key, libraries, encoding), status parsing, audit, Systemcheck causes.
- Web: the card's states, the code step, the browser, the wizard path, i18n key order.
- Manual on a real host (builder's checklist in the PR): both kinds read-only boot, a transcode with the GPU, Portainer stack, an
  engine below 26.

## Stage 2: migration from an existing Jellyfin (outline)

Goal: from *Admin → Einstellungen → Medienserver*, move from the Jellyfin FriendFlix uses now (external, or managed Jellyfin) to
managed Ferrofin, keeping user and item ids, with a one-click way back, and no shell.

Key decisions:

- **Find the source container** on the same engine: the updater lists running containers whose image is a Jellyfin image and that
  match `JELLYFIN_URL` (a network alias or name on a shared network, or a published port); several candidates → the admin picks by
  name. Jellyfin on another host is not migrated (see questions).
- **Copy like `try.sh`, done by helper containers:** Jellyfin's `/config` source (bind or volume, as Docker records it, never typed by
  anyone) mounted read-only; required layout `data/jellyfin.db`, `root/default`, `config/`; copied: the database files,
  `device.txt`, playlists, collections, `root/default`, `metadata`, `config/*.xml`, trickplay on request; into the managed Ferrofin
  data volume; owner set to uid 1000. Jellyfin's real config is never written.
- **Media paths stay identical:** each of Jellyfin's media mounts becomes a managed folder with Jellyfin's own target path (the
  template already allows it). A mount outside the confirmed base needs a new base (code) first; the UI says which.
- **Stopping Jellyfin for the copy** (seconds to minutes, size shown before): one confirmation; the updater stops exactly that
  container, copies, and starts it again whatever happens (as `try.sh`'s trap). This is the only foreign container the updater ever
  stops or starts; it records its id for the job and refuses any other.
- **Verify before switching:** Ferrofin answers, its adoption backup (`jellyfin.db.pre-ferrofin`) exists, the API key from the copy
  works, the user ids of every linked profile and a sample of item ids resolve on Ferrofin. Then `JELLYFIN_URL` points at the managed
  server and the old address and key are saved for the way back.
- **One-click back:** switch the address back; the old Jellyfin was never changed. Watch state recorded on Ferrofin since the switch
  stays in Ferrofin's copy (one-way until Ferrofin 1.6.0); the UI says so before both the switch and the way back.
- **The old Jellyfin keeps running** until the admin presses *Altes Jellyfin stoppen* (stop only; never removed by FriendFlix).
- The same flow migrates **managed Jellyfin → managed Ferrofin** (source = our own container and volume).
- `try.sh` stays for testing by hand; `docs/mediaserver.md` points to the UI.

Open questions: Jellyfin on another host or NAS (copy over the network, or not supported); the linuxserver image's different
`/config` layout; installed Jellyfin plugins (copied, ignored by Ferrofin, or listed); whether to copy trickplay by default; what
happens to FriendFlix data created between copy and switch (a short write freeze in FriendFlix during the copy?).

## Stage 3: `.env` clean-up (outline)

Goal: a normal install has one `compose.yaml` and no `.env`; every remaining value is a setting; `.env` keeps working and still
locks a value.

Key decisions:

- `MEDIA_SERVER` becomes a setting; the gateway gets it with its config from the backend (`/internal/gateway-config`), so
  `compose.plex.yaml` is no longer needed (kept as a harmless file for existing stacks; the updater's file detection keeps working).
- `compose.yaml` becomes the production file (images from GHCR, updater on); the development build moves to `compose.dev.yaml`;
  `compose.prod.yaml` stays as a file that includes `compose.yaml`, so stacks recorded with it keep updating.
- Into settings: `DIGEST_DAY`, `DIGEST_HOUR`, `METRICS_TOKEN` (secret). Stay in the environment, by nature: per-container values
  (`PORT`, `BACKGROUND_JOBS`, service URLs), the bootstrap secrets, `UPDATE_REPO` (the signature anchor), compose interpolation
  (`BIND_ADDR`, ports, `FF_TAG` without the updater), the database pool limits, the expert `RECO_*` weights.
- The bundled `jellyfin` service and `MEDIA_PATH` are replaced by the managed media server (the profile kept, deprecated, one
  release).
- Host paths for downloads, previews and recordings (`DOWNLOADS_PATH`, `PREVIEWS_PATH`, `RECORDINGS_PATH`) move to managed volumes or
  folders below the confirmed base (same code rule).

Open questions: the request service's bundled profile; whether `compose.prod.yaml` may eventually go; how Portainer users move
their stack file.

## Stage 4: Plex → Ferrofin (outline)

Goal: an install on Plex moves to managed Ferrofin without losing what people watched, from the UI.

Key decisions:

- Needs stage 3 (`MEDIA_SERVER` as a setting) and stage 1. The Plex server is not changed at all.
- **Fresh scan:** managed Ferrofin on the same media folders (below the confirmed base; Plex's own paths are read from the Plex
  container when it runs on this engine, otherwise the admin picks the folders).
- **Matching:** Plex items (`plex_items`, FriendFlix's mirror) to Ferrofin items by provider ids (TMDB, TVDB, IMDb), then by
  title + year (+ season/episode); a report of unmatched items before anything changes.
- **Accounts:** a Ferrofin user per FriendFlix profile, created by FriendFlix as today's provisioning does.
- **Watch history:** from FriendFlix's Plex mirror (`plex_userdata`: played, position) into Ferrofin's user data through its API.
- **FriendFlix id remap:** every table that holds an item id (the `9f1e…` Plex ids, `plex/ids.ts`) is rewritten to the Ferrofin
  ids in one transaction through a mapping table; a test asserts the list of tables is complete; the mapping is kept for the way back.
- **Way back:** `MEDIA_SERVER=plex` with the reverse mapping, while the Plex server still exists.

Open questions: what to do with unmatched items (drop their FriendFlix data, keep it hidden); Plex-only features FriendFlix shows
today (`plex/features.ts`); several Plex libraries with the same media.

## Order of work

1. **Stage 1 (one PR):** updater (template, guard, helpers, the route, state, jobs, pins, supervision), `docker-proxy` `ALLOW_LOGS`,
   our image's `HEALTHCHECK` (change 0003), backend (table, routes, first run, update scheduling, audit, Systemcheck), web (Admin card,
   wizard), Dependabot, docs, CHANGELOG. Reason for one PR: the template, the guard and the routes are one security boundary and are
   reviewed together.
2. **Stage 2**, 3, 4 as above, one PR each; stage 4 needs stage 3.

## Left to the builder

- File split inside `updater/src/mediaserver/` beyond `template.ts` and `guard.ts`; the helper's JSON shapes.
- Ferrofin's names for its cache-directory and first-run administrator variables (from Ferrofin v1.5.x's documentation), and any
  write path either server needs on a read-only root (as a `tmpfs` or an environment variable into `/cache`).
- The exact Jellyfin startup-wizard requests and encoding-configuration fields for the pinned version.
- The Jellyfin version and digest of the first pin (the current release when the PR lands).
- The Engine API version negotiation details and the pull progress shown in Admin.
- The exact German texts (then the other six languages).

## Questions only the owner can answer

1. **Where does your media live?** Stage 1 takes **one** base folder. If your media sits in several roots (for example `/media` and
   `/media2`, as `try.sh` expects), their common parent is often refused (`/`, `/mnt`, `/srv`). Should stage 1 support several base
   folders, each confirmed with its own code?
2. **Fresh start on your install before stage 2?** Stage 1 offers a managed server only while no profile is linked to a media server
   user, so on your install it stays disabled until the migration. Do you want an explicit *Neuanfang* (new server, profiles relinked,
   watch states and FriendFlix references to old items lost) already in stage 1?
3. **Which Docker Engine version runs on your host** (`docker version`), and is your Jellyfin on the same engine as FriendFlix, with
   the official image's `/config` layout? Below Engine 26 the folders use the fallback with a known race; stage 2 needs Jellyfin on
   the same engine.
4. **When is Ferrofin "proven"?** Until then the wizard preselects managed Jellyfin and Ferrofin carries *Test*. Is `probe.sh` passing
   tests 1 and 2 plus one real HDR title on your Intel GPU enough to make Ferrofin the default?
5. **Dashboard access:** stage 1 publishes no port, so the server's own web dashboard is not reachable. Do you want an optional
   publish of port 8096 on `127.0.0.1` (SSH tunnel), on a LAN address you choose (for example `192.0.2.10`), or not at all?
6. **Should the media server image become a required part of every release?** Today its publish job may fail without stopping a
   release; a release without it leaves managed Ferrofin installs on their previous image and refuses new Ferrofin setups.
7. **Media server updates:** automatically when nobody is watching (at the latest at the automatic-update time), or only on a click?
8. **Stage 2:** may FriendFlix stop your Jellyfin container for the copy (minutes) after one confirmation in the UI?
9. **Metadata from the internet** (posters, descriptions through the media server): on by default, as planned?
