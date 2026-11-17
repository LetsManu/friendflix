<!--
SPDX-FileCopyrightText: 2026 Manuel Weißböck
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Media server: managed by FriendFlix

FriendFlix can run its media server for you. You pick a kind, a base folder and the folders with your media, and the updater
creates the container from a fixed template, starts it, waits until it is healthy, sets up its administrator, API key,
libraries and hardware encoding, and keeps it running. No compose file to write, no `.env` entry, no dashboard to log in to.
Nothing about it can widen what the server sees on your host: [security.md, Updater](security.md#updater). *Deutsch:
[de/mediaserver.md](de/mediaserver.md)*

Your existing Jellyfin or Plex stays supported by address (*Bestehender Jellyfin/Plex (Adresse)*, what FriendFlix did before).
This page is about the other two choices, then the trial of FriendFlix's own image next to an existing Jellyfin
([further down](#trial-ferrofin-next-to-your-jellyfin)).

## The three choices

*Admin → Einstellungen → Medienserver* (and the media step of the setup wizard) offer:

| Choice | What it is |
|---|---|
| *Ferrofin (eigener)* | `ghcr.io/letsmanu/friendflix-mediaserver`: the pinned release of [Ferrofin](https://github.com/mangoleaf/ferrofin), a Rust re-implementation of the Jellyfin API, plus a few numbered changes ([mediaserver/README.md](../mediaserver/README.md)). Still a **trial** (marked *Test*): its HDR tone mapping on Intel GPUs is untested on real hardware until `probe.sh` and the *HDR-Test* pass on your host. |
| *Jellyfin (offiziell, verwaltet)* | The official Jellyfin image, pinned by FriendFlix. The preselected choice while Ferrofin is a trial. |
| *Bestehender Jellyfin/Plex (Adresse)* | Your own server, reached by address, as before. |

What a managed server is, in short: no published port, no web client, no dashboard credentials (FriendFlix is its only client);
media mounted **read-only**; non-root, no capabilities, read-only root file system; on FriendFlix's internal `media` network
only (plus `egress` for metadata when you leave that on).

FriendFlix's Ferrofin image differs from upstream in a short, numbered list ([mediaserver/README.md](../mediaserver/README.md#changes)).
Three of the changes exist for the managed mode: **0003** a `HEALTHCHECK` (bash `/dev/tcp` on `GET /health`; the base image has no
curl), so the updater can wait for `healthy`; **0004** no web client: the bundled client's files are removed and
`FERROFIN_WEB_DIR=/nonexistent`, so the server serves the API only (this saves memory and serving, not disk: the files stay in the
base image's layer, so the image is as large as before); **0005** `/cache` exists and `/data` and `/cache` are mode 0777, so any
non-root uid can use fresh volumes there (the template sets `FERROFIN_CACHE_DIR=/cache`).

## What you need

- **The updater** (on by default; [setup.md, Updater](setup.md#updater)). Without it the managed choices are shown disabled with
  the reason; a managed server that already exists keeps running but cannot be changed.
- **Docker Engine 26 or newer** (API 1.45): the media folders are mounted as read-only volume subpaths. With an older engine the
  card says `engine_old` and the Systemcheck line *Verwalteter Medienserver* says so.
- **The compose file of this release**, once: [Update the compose files](#update-the-compose-files).
- **A fresh server.** A managed server starts empty, with new user and item ids. *Einrichten* is therefore offered only while no
  profile is linked to a media server user (a new install, or one that never linked one). Otherwise the card says *Umzug von
  deinem Jellyfin: kommt mit Stufe 2* (the move of an existing Jellyfin comes in a later stage). Switching between the two managed
  kinds is a fresh server too (they use different data volumes).
- **No pinned address.** With `JELLYFIN_URL` or `JELLYFIN_ADMIN_API_KEY` set in the environment (also `_FILE`), FriendFlix could
  not save the managed address, so the choices stay disabled (`url_pinned`). With `MEDIA_SERVER=plex` they show *Wechsel von
  Plex: kommt mit Stufe 4*.
- **Admin, and a fresh sign-in** (at most 10 minutes old) for the steps that change which host data the server reads, delete data,
  or reveal a credential: requesting a base folder, *Einrichten*/*Übernehmen*, removing with data, restoring, downloading a backup
  and switching between managed and external.

## Set it up

Choose *Ferrofin (eigener)* or *Jellyfin (offiziell, verwaltet)*, then:

1. **Base folder and code.** Type the absolute path of the folder on the host under which your media lives, for example
   `/srv/media`, and press *Code anfordern*. This is the one folder the media server can ever see. To make sure it is you and
   not someone who only reached the web page, the updater prints a one-time code to its log, with the folder it names:

   ```bash
   docker compose -f compose.prod.yaml logs updater | grep "media folder"
   # FriendFlix media folder: to allow /srv/media as the media base folder, enter the code K7QM-2D9X-HT4R in Admin (valid until 14:32 UTC).
   ```

   With Portainer: Containers → `updater` → *Logs*. Enter the code (*Bestätigen*). It is valid for 30 minutes, the fifth wrong try
   cancels it, a new request replaces the old one, and at most three can be requested per ten minutes. The code appears only on
   the updater's stdout: not in Admin, not in any job log, status or audit entry. Refused as a base folder: `/`, system trees
   (`/etc`, `/usr`, `/var/lib/docker` and the like), `/home`, `/var`, `/opt`, `/mnt`, `/media`, `/srv` and `/volume<N>` themselves
   (a folder *below* them is fine), the Docker root directory and the stack directory (they hold secrets). Path components may
   contain letters, digits, spaces and `._-+()&'`, none starts with a dot. The updater checks that the folder exists and warns
   when the container user cannot list it.
2. **Folders.** Browse below the base (one level at a time, at most three levels deep, names only) and tick the folders to share.
   Each gets a library name and a type: *Filme*, *Serien*, *Musik* or *Gemischt*. Up to 20 folders, none inside another. A symlink
   is shown but not selectable. Each folder is mounted at `/media/<name>` inside the container, read-only. Read, list and watch
   (inotify) checks show next to the folder; a failed watch means new files appear only after a library scan.
3. **User and group.** The container runs as uid and gid `1000:1000` by default (never 0). Set the pair of the host user that owns
   your media if that is not readable for 1000, or add a media group when only a group can list the base (*Gruppe <gid>
   hinzufügen*). Changing the pair later recreates the container; a data volume owned by another uid refuses it (`uid_mismatch`:
   back up and set up again).
4. **Grafikkarte and HDR-Test.** FriendFlix detects `/dev/dri` (Intel, AMD) and NVIDIA and preselects the match: *Aus*,
   *Intel/AMD (VA-API/QSV)* or *NVIDIA*. *HDR-Test* runs the two key tests of `probe.sh` (OpenCL on VA-API, and QSV + OpenCL tone
   mapping of a generated 2-second HDR10 clip) in a throw-away container of the chosen image with the GPU passed in and no
   network, and shows PASS or FAIL for each. Run it on Ferrofin before you rely on HDR; [probe.sh](#1-check-the-gpu-first) does the same by hand.
5. **Metadaten aus dem Internet.** On by default (posters, titles, descriptions). Off means local metadata only, and the container
   never joins the `egress` network.
6. **Einrichten.** Everything else happens on its own, and the card shows each step; a failed step has *Nochmal* and resumes there:
   the server starts and turns healthy, FriendFlix creates its administrator (`friendflix-admin`, a random password stored
   encrypted and never shown) and the API key, saves the address and key as settings, creates one library per folder (no NFO files,
   real-time monitoring on), sets hardware encoding to match the GPU (Intel QSV, AMD VA-API, NVIDIA NVENC, tone mapping on) and
   scans. On Ferrofin the first create carries the administrator's name and password as environment variables; once the setup is
   done the container is recreated without the password. On Jellyfin the startup wizard is completed through its API. If that
   wizard had already been completed by someone else (another container on the `media` network was faster) the setup ends with
   `wizard_taken`: use *Neu anlegen* (remove with data, then set up again).

The wizard's media step offers the same path under the setup session; it ends when the server is ready and the wizard goes on.

### After the first run

- **Adding a folder** mounts it at the next *Übernehmen* and creates its library. **Removing** one unmounts it but keeps its
  library: the items show as missing and come back when you add the folder again. **Deleting a library** is its own confirmation
  that first counts the lists, resume points and recordings that reference it. Renaming or retyping a referenced library is refused
  (`library_referenced`).
- **Changing the base folder** repeats the code step. Chosen folders that also exist below the new base are kept; the others are
  dropped and listed. *Zurücksetzen* (clearing the base) needs no code but only works while no managed container exists.
- **Actions** on the card: *Starten*, *Stoppen*, *Neu starten*, *Aktualisieren*, *Sicherung*, *Wiederherstellen*, *Protokoll*
  (the last 300 lines, secrets replaced by `…`, never stored) and *Entfernen*. A stop is your choice: the updater never restarts a
  container you stopped, in Admin or outside. A container that is *missing* is recreated within a minute.
- **Entfernen** keeps the data, cache and backup volumes; *Daten löschen* (typing the kind's name) removes data and cache, never
  the backups. Afterwards FriendFlix goes back to the saved external server when there is one.
- **Systemcheck:** the line *Verwalteter Medienserver* (`media.managed`) reports a missing or unhealthy container, a base or folder
  that disappeared (for example an unmounted NAS share), a missing GPU, a failed job (`managed_job_failed`), an image that
  differs from its pin for more than 7 days and a backup older than 30 days. A container whose labels are right but whose
  configuration was changed outside FriendFlix (a port or privileges added in Portainer) is `managed_tampered`: it is never
  started or adopted; *Neu anlegen* replaces it from the template.

## Updates

The media server moves **with FriendFlix**, in the same update (manual or automatic); there is no separate window or click.
Every FriendFlix build carries the exact media server image it was tested with, per kind, by digest, in a signed label of its
backend image. Ferrofin's is the image built in the same CI run, cosign-verified like the other images; Jellyfin's is
`docker.io/jellyfin/jellyfin:<tag>@sha256:<digest>`, for 12.x with the build tag (`12.4.<YYYYMMDD-HHMMSS>`, since 12.x has no
`X.Y.Z` tags), the digest being the integrity check.

- **Order:** the update first recreates and health-checks FriendFlix's own services; only then, when the new build's pin differs
  from the running image, the media server phase runs: snapshot, recreate, wait for healthy. FriendFlix's rollback is never held
  up or triggered by it.
- **If the media server phase fails** the old container comes back (the config snapshot is restored when the upstream version
  changed), FriendFlix stays on the new build, and the job ends as *FriendFlix aktualisiert, Medienserver nicht*. This is not
  a failed update, so there is **no push alert**; the Systemcheck line warns (`managed_job_failed`) and the card offers *Erneut
  versuchen*.
- **Updates FriendFlix did not run** (Portainer, `compose pull` by hand): the updater notices that the backend build changed
  since it last looked (`pin.changed`), and the backend starts the same phase on its own.
- **Never down.** Ferrofin and Jellyfin migrate their databases one way. A pin whose upstream version is older than the running
  server's is `downgrade_refused`: the server stays, and a FriendFlix rollback keeps the newer media server (the card says *neuer
  als dieser FriendFlix-Stand*). A restore of a backup from a newer version is refused the same way.
- **Snapshot before an upstream change:** the data volume (without logs, transcodes and trickplay) is saved as an automatic
  backup first; the last 2 are kept.
- A build without a Ferrofin image (its CI job did not publish one) says `image_missing`: an existing container stays on its image,
  a new setup is refused with a hint to choose *Jellyfin (offiziell, verwaltet)*.
- Watchtower-style updaters must leave it alone: the container carries `com.centurylinklabs.watchtower.enable=false`.

## Backups

- *Sicherung* stops the server for a moment and a helper writes `<kind>-<YYYYMMDD-HHMM>-<upstream>.tar.gz` of the data volume
  (without logs and transcodes, trickplay on request) into the volume `<project>_mediaserver-backup`, then starts it again. The
  last 3 manual (and uploaded) and the last 2 automatic backups are kept.
- *Wiederherstellen* works within the same kind and refuses a backup from a newer upstream version.
- **The encrypted download is the copy that leaves the host.** *Herunterladen* asks for a passphrase (at least 12 characters,
  typed twice, never stored) and a fresh sign-in. The updater streams the archive encrypted in the open [age](https://age-encryption.org)
  format (scrypt passphrase), as `<id>.tar.gz.age`; the plain archive never leaves the updater and nothing is written to the
  host. You do not need FriendFlix to open it:

  ```bash
  age -d -o backup.tar.gz <id>.tar.gz.age      # asks for the passphrase
  ```

  The backup holds the server's password hashes and API keys: that is why the passphrase.
- *Aus Datei wiederherstellen* takes such a file back with its passphrase (up to 20 GiB), keeps it as a backup tagged *upload*
  (a wrong passphrase or a damaged file keeps nothing) and restores it like any other.
- **`docker compose down -v` removes the backup volume** (the updater mounts it through compose). Download a backup first; to copy
  the volume to the host without FriendFlix, see [operations.md, Backups](operations.md#backups--wiederherstellung).

## Stopping the stack, Portainer, several instances

- **`docker compose down`** removes FriendFlix's containers but stops at the `media` network with *has active endpoints*: the media
  server is not a compose service and is attached to it (the rest of `down` has happened). A later `up -d` reuses the network. To
  take the network down too, stop the media server first (*Stoppen* in Admin, or `docker stop friendflix-mediaserver`; the name is
  `<project>-mediaserver`), then run `down` again. The same applies to removing a stack in Portainer. `down` never deletes the media
  server's data (its volumes are not compose volumes); `down -v` removes only the backup volume (above).
- **Portainer:** every media server job works on a Portainer stack, none uses compose. The media server shows under *Containers*,
  outside the stack. Changing it with Portainer's *Duplicate/Edit* is caught by the guard (`managed_tampered`). After a
  Portainer-driven FriendFlix update, the pin moves on its own (above).
- **Several FriendFlix instances** on one Docker engine: every name, volume and label carries the compose project, each updater sees
  only its own containers, and each instance confirms its own base folder. Two instances may share a base folder (read-only).

## Update the compose files

The managed media server needs the compose file of this release: the `docker-proxy` service allows reading container logs
(`ALLOW_LOGS: 1`, for the media server's log and the helper containers' output), and the `updater` service mounts the
`mediaserver-backup` volume. With an older file the Systemcheck shows *Verwalteter Medienserver* as a warning (`managed_proxy_outdated`)
and the card does not offer the managed choices (`proxy_outdated`). Download the current
[`compose.prod.yaml`](../compose.prod.yaml) next to your `.env` and run `docker compose -f compose.prod.yaml up -d` once; with
Portainer, update the stack file and redeploy the stack. Nothing else changes, and the media server is not touched.

## Trial: Ferrofin next to your Jellyfin

This is the manual way to try FriendFlix's own image **without** the managed mode: keep Jellyfin as your media server and run
Ferrofin next to it. Ferrofin converts the Jellyfin database it takes over one-way (until Ferrofin 1.6.0), so the trial always runs on
a **copy** of Jellyfin's config folder and Jellyfin stays untouched. (For a fresh managed Ferrofin, use the steps above instead;
moving an existing Jellyfin into managed mode comes in a later stage.)

### 1. Check the GPU first

[`mediaserver/probe.sh`](../mediaserver/probe.sh) checks whether the image can tone-map HDR with OpenCL on this host's GPU. It
only starts throw-away containers with the GPU passed in; Jellyfin and FriendFlix are not touched.

```bash
bash probe.sh                          # as root or as a user in the docker group
DOCKER=/path/to/docker bash probe.sh   # when docker is not on PATH (some NAS systems)
```

It prints `PASS` or `FAIL` for: OpenCL on VA-API, Jellyfin's QSV + OpenCL tone-mapping chain on a generated 10-bit HDR10 clip,
and, for information, the VA-API + OpenCL chain and whether the GPU's VA driver can tone-map by itself (VPP; when it cannot,
use OpenCL tone mapping in Ferrofin's settings, [change 0002](../mediaserver/patches/0002-vaapi-hdr-tonemap-chain.md)). The
one-line check it starts with, if you want to run it by hand:

```bash
docker run --rm --device /dev/dri --group-add "$(stat -c %g /dev/dri/renderD128)" --entrypoint /usr/local/bin/ffmpeg \
  ghcr.io/letsmanu/friendflix-mediaserver:nightly \
  -init_hw_device vaapi=va:/dev/dri/renderD128 -init_hw_device opencl=ocl@va -f lavfi -i nullsrc -frames 1 -f null -
```

### 2. Start the trial next to Jellyfin

[`mediaserver/try.sh`](../mediaserver/try.sh) reads Jellyfin's folders, devices and networks from Docker, checks that the image's
user can list, read and watch your media, and checks the copy target and the mount paths. Only then it asks, stops Jellyfin
for the copy (seconds to minutes, depending on the metadata size), starts it again and then starts the trial container
(`ferrofin`) with the copy (at `/ferrofin-data` inside) and your media read-only. It uses
`ghcr.io/letsmanu/friendflix-mediaserver:nightly` unless you set `IMAGE=`, and pins the container to that image's digest.

```bash
bash try.sh --attach-network friendflix_media      # FriendFlix's media network: it then reaches http://ferrofin:8096
bash try.sh --publish 192.0.2.10:8097              # or: FriendFlix reaches media servers by host IP:port
bash try.sh status                                 # bash try.sh remove only removes a container it created itself
```

Good to know:

- Jellyfin can be its own stack (container `jellyfin` with bind mounts such as `/config`, `/cache`, `/media`, `/media2`);
  the trial uses the same media paths, so library paths match.
- `--publish <port>` without an address publishes on `127.0.0.1` only: the trial holds copies of all Jellyfin accounts and
  keys. Give the host's LAN address only when FriendFlix needs it.
- `--with-trickplay` also copies Jellyfin's trickplay images (the script shows their size).
- If the inotify check fails, new files only appear after a library scan.
- Turn off the **NFO saver** (the media is mounted read-only): the image has no web client (change 0004), so there is no
  dashboard for it. `try.sh` prints the steps at the end: per library, send the library's options back with `SaveLocalMetadata`
  `false` and `MetadataSavers` `[]` (`POST /Library/VirtualFolders/LibraryOptions`, with an administrator's API key from the copy).
  The call answers 204 on success; any other answer means the key, the library `Id` or the body was not accepted, so check those and the address, and send it again.
  A managed server (above) is set up without NFO files from the start.
- The container carries `com.centurylinklabs.watchtower.enable=false`: no auto-updater may upgrade it (a newer image would
  upgrade the copied database by itself). The FriendFlix updater never touches it.

### 3. Point FriendFlix at it and test

*Admin → Einstellungen → Medienserver*: address `http://ferrofin:8096` (or the published `http://192.0.2.10:8097`), save. Then
test sign-in, browsing, direct play and an HDR title, seeking, subtitles, a kids profile, resume points, downloads, Live TV
and a newly added file.

### 4. Go back

Set the address back to your Jellyfin address (e.g. `http://jellyfin:8096` or `http://192.0.2.10:8096`), then
`bash try.sh remove`. The copied folder stays until you delete it. Watch state recorded during the trial stays in the copy.
