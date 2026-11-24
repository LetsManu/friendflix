# Managed media server, stage 2: moving an existing Jellyfin to Ferrofin

Status: owner approved the approach on 2026-11-24 ("go ahead"). Builds on
[the stage 1 design](2026-11-17-managed-mediaserver-design.md) (its *Owner decisions*, template, guard, helpers, lifecycle and
backend storage stay in force unless this document changes them).

## Why

An install whose profiles are linked to a Jellyfin user cannot use the managed media server today: *Admin → Medienserver* greys
out *Ferrofin* with "Umzug von deinem Jellyfin: kommt mit Stufe 2". A fresh server would give every user and every title a new id,
and every profile link, resume point, list, favourite and recording reference in FriendFlix would break without a word. The owner
runs exactly such an install and wants to move it to Ferrofin, and to test Ferrofin for real that way.

Ferrofin can adopt a Jellyfin database and keeps its user and item ids. Stage 2 makes that move a guided action in FriendFlix's
UI: copy Jellyfin's data, check it, switch, and go back with one click if needed.

## Owner decisions (binding)

1. **Approach 1 (2026-11-24):** the updater copies Jellyfin's data with helper containers, FriendFlix checks the copy, then switches
   its media server address; all from *Admin → Medienserver*, no shell. Rejected: a guided script (needs a shell, cannot check
   FriendFlix's own data); Ferrofin adopting Jellyfin's data in place (one-way database migration, the way back and the old Jellyfin
   would be gone).
2. **The way back stays** for installs that moved: one click returns to the old Jellyfin, which was never changed.
3. **After the owner's stage 2 test, new installs get Ferrofin as the only managed server** (reading **B**): the wizard offers
   *Ferrofin* (default) and *Bestehender Jellyfin/Plex (Adresse)*; *Jellyfin (offiziell, verwaltet)* and the *Test* label go. This
   is a separate small change after the test (*Follow-up* below), not part of stage 2's PR.
4. Stage 1's binding decisions stay: no shell for the user, Jellyfin's real config is never written, no *Neuanfang*, backups as an
   encrypted download.

## Goals

- From *Admin → Medienserver*, an install connected to a Jellyfin on the same Docker host moves to managed Ferrofin with all user
  and item ids kept: profiles, watch history, resume points, lists, favourites, requests and recordings keep working.
- The admin sees before starting: which Jellyfin container was found, its media folders and how they will appear, the size of the
  copy, the downtime, what is not taken over (plugins), and that watch progress made on Ferrofin stays there on the way back.
- The old Jellyfin is never modified. It is stopped after a successful switch (owner, 2026-11-24) and started again by the way back.
- The request service follows the switch: it is pointed at Ferrofin, and back at Jellyfin on the way back (owner, 2026-11-24:
  only FriendFlix and the request service use the owner's Jellyfin).
- *Zurück zu Jellyfin* switches back in one click while the old container (or its data) exists.
- Every step is a job with fixed codes, audited, visible in the step list like stage 1's jobs.

## Non-goals

- Jellyfin on another host or NAS (copy over the network). The UI says "nur Jellyfin auf diesem Docker-Host".
- Managed Jellyfin → managed Ferrofin (Controller's call: nobody can be on managed Jellyfin yet with linked profiles, and owner
  decision 3 drops it; the flow could take it later, source = our own volume).
- Rewriting library paths inside the copied database.
- Copying Jellyfin plugins (listed only; Ferrofin does not run them).
- Plex → Ferrofin (stage 4).
- Making Ferrofin mandatory for new installs (owner decision 3: after the test).

## Anti-goals (a failure even if it works)

- Any write to the old Jellyfin's config, data or media.
- A switch that leaves FriendFlix pointing at a server where linked users or titles do not resolve.
- Lost watch progress for the time between copy and switch.
- Any widening of the media server's or the helpers' access beyond what stage 1 allows, except the one named below (original media
  paths), and that only for folders inside the confirmed base.
- A failure that leaves the old Jellyfin stopped.

## Constraints

- Stage 1's security model: the base folder confirmed with a code; the guard checks every create body; helpers only with fixed
  mounts; the Docker socket only on `docker-proxy`; no published port; read-only root; non-root.
- UI: nothing jumps, 44 px targets, transform/opacity motion only; 7 locales with identical key order; "…" not "..."; never
  "Netflix" or "Seerr".
- The updater stops and starts exactly one foreign container in its whole life: the source Jellyfin recorded for this migration.

## Approaches

See owner decision 1. Approach 1 is the only one that keeps the way back and works without a shell.

## Decisions

### Finding the source (Controller's call)

- The updater lists containers on its engine (running or stopped) whose image repository is `jellyfin/jellyfin`,
  `docker.io/jellyfin/jellyfin`, `linuxserver/jellyfin` or `lscr.io/linuxserver/jellyfin` (any tag or digest).
- **Identity by server id, not by address** (Controller's call, builder check 6: a reverse-proxy or LAN-IP `JELLYFIN_URL` matches no
  container name): the backend reads the server id of the Jellyfin FriendFlix uses now (`GET <JELLYFIN_URL>/System/Info/Public`,
  `Id`); the scan helper reads each candidate's server id from its read-only `/config` (the builder names the file per layout).
  Only a candidate whose id equals FriendFlix's server's id can be scanned or moved (`source_mismatch` otherwise). One match:
  proposed. Several (copies of one server): the admin picks by container name. None: "Kein Jellyfin auf diesem Docker-Host
  gefunden, das zu deiner Adresse passt".
- The owner may run Jellyfin as the bundled `jellyfin` service of the FriendFlix stack or as its own stack; both are found.
- `JELLYFIN_URL` or the key pinned in `.env` → stage 1's `url_pinned` reason (stage 3 removes it).

- **A recreated source** (Controller's call, builder check 4: Watchtower, `compose pull && up -d` or a Portainer redeploy give it a
  new id): the recorded source is `{name, config mount source, image repository, server id}`, not only the container id. A
  container with the same `/config` mount source and the same server id is the same source; its new id replaces the recorded one
  (audited). Every other container stays untouchable. The one-foreign-container rule reads "exactly one recorded source", not "one
  container id".

### Reading the source (helper `migrate-scan`)

- The source's `/config` mount (bind or volume, as Docker records it in the container's inspect, never typed by anyone) is mounted
  **read-only** into a helper. Two layouts are recognised (Controller's call):
  - official image: `/config/data/jellyfin.db`, `/config/root/default`, `/config/config/*.xml`, metadata under `/config/metadata`;
  - linuxserver image: `/config/data/data/jellyfin.db`, `/config/data/root/default`, `/config/*.xml`, metadata under
    `/config/data/metadata`.

  The builder confirms both against the real images. Anything else is `source_layout`.
- **Media mounts:** every mount of the source container except `/config`, `/cache`, transcodes, devices and the Docker socket is a
  media mount, and must be a bind (or a volume whose `device` option is a host path) **inside the confirmed base folder**; otherwise
  `source_outside_base` naming the container path (never the host path) and "Basisordner ändern" in the UI.
- The scan answers: the layout, the size of what will be copied (with and without trickplay), the list of media mounts as
  `{rel, target}` (the path below the base and the container path Jellyfin uses), installed plugins (names only), the Jellyfin
  version from the database, and whether the NFO saver is on.
- **Jellyfin versions:** Ferrofin adopts what its upstream supports; an older or newer database than the pinned Ferrofin accepts is
  `source_version` with both versions shown.

### Media paths (Controller's call, owner agreed to the direction)

The migrated Ferrofin sees each media folder at **exactly the container path Jellyfin uses** (for example `/movies`, `/data/tv`),
so the item paths stored in the copied database stay valid and nothing is rewritten.

- This widens stage 1's rule "media targets only below `/media/`" for a migrated server only: the template and the guard accept a
  target outside `/media/` when it is one of the targets recorded at migration (`desired.migratedTargets`). Each target must be an
  absolute normalised path, at most 3 levels, and not one of `/`, `/data`, `/cache`, `/config`, `/tmp`, `/proc`, `/sys`, `/dev`,
  `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/var`, `/run`, `/root`, `/home`, `/ferrofin-data`, or below one of them,
  except below `/data` (Jellyfin users often use `/data/movies`; see the next point).
- Because media can sit below `/data`, a migrated Ferrofin keeps its own data in **`/ferrofin-data`** (`FERROFIN_DATA_DIR`, as
  `try.sh` does) instead of the image's `/data`. The guard knows the per-kind data target for a migrated server. The copy helper
  owns the fresh volume's files as the container user, so no copy-up from the image is needed.
- The media are still mounted as subpaths of the base volume, read-only. No bind mount appears on the managed container.
- **A source mount that is the whole base folder** (the bundled `jellyfin` service mounts all of `MEDIA_PATH` at `/media`)
  (Controller's call, builder check 3): for a migrated target only, the subpath may be empty, i.e. the whole confirmed base mounted
  read-only. The base was confirmed with a code, so this shows the media server nothing the admin has not confirmed; a fresh
  (stage 1) folder still needs 1–3 levels.
- **Migrated folders are fixed** in Admin: shown with their container path, no remove, rename or retype (they carry Jellyfin's own
  libraries, which do not map one to one onto mounts). The libraries stay Jellyfin's, as copied; the backend does not rebuild them
  from `media_managed.libraries` for a migrated server.
- **New folders after the move** mount at `/ffmedia/<slug>` (Controller's call), never inside a migrated target (Docker cannot
  create mountpoints inside a read-only mount; `/media` is often a migrated target). The guard allows `/ffmedia/` like `/media/`.

### The move: one job `mediaserver-migrate`

Admin flow, one confirmation:

```
Umzug von „jellyfin“ (gefunden) zu Ferrofin
  Medienordner:   /movies, /tv  → gleich in Ferrofin
  Kopie:          38 GB (ohne Trickplay)   ☐ Trickplay mitnehmen (+12 GB)
  Nicht übernommen: Plugins „Open Subtitles“, „Fanart“
  Ausfallzeit:    etwa 4 Minuten. Laufende Wiedergaben brechen ab.
  Anfrage-Dienst: wird auf Ferrofin umgestellt.
  Altes Jellyfin: wird danach gestoppt, bleibt für den Rückweg erhalten.
  Zurück:         jederzeit mit einem Klick. Was auf Ferrofin geschaut wird, bleibt dort.
  [Abbrechen]                                        [Umziehen]
```

Steps (fixed codes on failure; the step list like stage 1):

1. `check`: base confirmed, scan current (same container id, same mounts), free space on the Docker data root ≥ copy size × 1.2
   (`no_space`), pin for Ferrofin present (`image_missing`), FriendFlix's own checks (no running FriendFlix job).
2. `pull` and `verify` the pinned Ferrofin image (stage 1).
3. `copy-bulk` (Controller's call, builder check 7: metadata on a NAS takes far longer than the database): while Jellyfin keeps
   running, the helper copies everything except the database files; still read-only on the source.
4. `stop-source`: stop the recorded source container. From here on, any failure or abort starts it again before the job ends
   (`finally`), and the job log says so. Then `copy` (helper `migrate-copy`) copies the database files and what changed since
   step 3 (by size and mtime); the downtime shown in the summary is measured on this second pass's estimate.
   The copy (helper `migrate-copy`, source `/config` read-only, target the new volume `<project>_mediaserver-ferrofin-data`
   read-write): database files, `device.txt`, playlists, collections, `root/default`, metadata, `config/*.xml`, trickplay when
   chosen; owner set to the container user; the layout mapped to Ferrofin's data layout. A target volume that already has data (an
   earlier move) is replaced only after a snapshot into the backup volume (stage 1's `snapshot`).
   The copy, never the source, gets these settings adjusted (Controller's call, builder check 2; the builder confirms each key
   against the real files): `network.xml`: `BaseUrl` empty, HTTP on 8096, HTTPS off, the Docker networks counted as local (no
   remote refusal); `encoding.xml`: the ffmpeg path of our image, the transcode folder below `/cache`, hardware acceleration
   from the GPU detection (stage 1's `hwaccel` step runs after the move); `system.xml`: custom absolute `MetadataPath` and
   `CachePath` back to the defaults inside the data and cache volumes (the metadata is copied there). Every adjustment is listed in
   the job log by key, never by value.
5. `create` and `start` the managed Ferrofin from the template with `migratedTargets`, the copied data in `/ferrofin-data`, media at
   the recorded targets, GPU as detected (stage 1), egress on.
6. `health` (stage 1) and adoption: Ferrofin's adoption backup `jellyfin.db.pre-ferrofin` exists in the data volume
   (`adopt_failed` otherwise).
7. `nfo`: the NFO saver is switched off through the API (media are read-only; the recipe from `try.sh`).
8. `verify-ids` (backend, through the updater's job phases like stage 1's first run): with the **copied API key** (FriendFlix's
   current key, which is in the copied database):
   - every `jellyfin_user_id` on `users` and `profiles` resolves on Ferrofin;
   - a sample of item ids FriendFlix references (up to 200, from watch history, lists, favourites, requests and recordings, newest
     first) resolves, at least 98 % (`ids_mismatch` with the numbers otherwise; Controller's call: deleted titles may be missing);
   - the library count matches Jellyfin's scan.
9. `switch` (backend): save the current address and key as the way back (`media_managed.external_url` / `external_key_enc`, stage
   1's columns), set the media server to managed Ferrofin at `http://mediaserver:8096` with the same key, record
   `media_managed.migrated_from` (container name and id, image, Jellyfin version, time).
10. `requests` (when a request service is set up in FriendFlix): its Jellyfin connection is pointed at the managed server
    (`http://mediaserver:8096`, the same API key; the request service sits on the `media` network) through the request service's
    own settings API with FriendFlix's request-service key, and its Jellyfin library sync is started. The previous values are
    saved for the way back. The builder confirms the API against the pinned request service image. When the request service
    refuses or its API differs, the move still succeeds and Admin shows a warning with the manual step (its own settings page,
    server `mediaserver`, port 8096); requests then fail until done, and the Systemcheck says so.
11. The old Jellyfin **stays stopped** (owner, 2026-11-24: nothing but FriendFlix and the request service uses it, so nothing may keep
    writing to it). It is never removed.

Downtime for users: from the stop in step 4 to step 9. Watch progress cannot be lost in between because Jellyfin is stopped and Ferrofin is
not yet used. After step 9, playback goes to Ferrofin.

Abort (a button while the job runs, or any failure before step 9): the new container is stopped and removed, the data volume is
kept for a retry (removed with *Entfernen*), the source is started, nothing in FriendFlix changes.

### After the move

- *Admin → Medienserver* shows "Umgezogen von „jellyfin“ am …" with:
  - *Zurück zu Jellyfin*: one click (re-auth). Starts the old container if stopped, checks it answers with the saved key, restores
    the saved address and key, points the request service back, stops the managed Ferrofin (not removed). A warning before: "Was seit dem Umzug auf Ferrofin
    geschaut wurde, ist in Jellyfin nicht drin." (Ferrofin's adoption is one-way until Ferrofin 1.6.0.)
  - **Users on the way back** (Controller's call, builder check 1): FriendFlix creates media server users for new profiles and
    sets their passwords. After switching back, the backend runs the same user check as `verify-ids` against Jellyfin: a profile
    whose user is missing there (created after the move) gets a new Jellyfin user through the existing create path, and every
    linked profile's password is set again from FriendFlix's stored one. Those profiles' Ferrofin-only watch progress is covered by
    the warning above. *Erneut umziehen* runs the same repair in the other direction after its copy (users created on Jellyfin since
    the way back), so no switch ever leaves a linked profile without a user (anti-goal).
  - The old Jellyfin is already stopped (step 11); FriendFlix never removes it. While it is stopped, Admin says "Altes Jellyfin
    ist gestoppt und bleibt für den Rückweg erhalten".
  - *Erneut umziehen*: after a way back, the move can run again (the earlier Ferrofin data is snapshotted first, then replaced).
- When the source container no longer exists, *Zurück zu Jellyfin* turns into the stage 1 behaviour (enter an address).
- Systemcheck: `media.managed` gains "umgezogen von „<name>“; altes Jellyfin gestoppt, für den Rückweg erhalten" as an info line, and a
  warning while the request service still points at the old Jellyfin.

### Updater API

`POST /v1/mediaserver` gains:

| Body | What |
|---|---|
| `{op: "migrate-scan"}` | find candidates, scan the chosen one; answer `{candidates: [{id, name, image}], scan?}` |
| `{op: "migrate-scan", source: <container id>}` | scan this candidate |
| `{op: "migrate", source: <container id>, trickplay: boolean, gpu, uid, gid}` | the move (job) |
| `{op: "migrate-abort"}` | abort the running move |
| `{op: "source-start"}` | only the recorded source (the way back) |

The source container id is checked against the scan and against the recorded `migratedFrom` on every op. Job actions:
`mediaserver-migrate`, `mediaserver-source`.

### Backend

- `media_managed` gains `migrated_from jsonb` (`{name, id, image, version, at}`) and the existing `external_*` columns hold the way
  back.
- `ids_in_use` stays the gate for a *fresh* managed server. The move is offered exactly where `ids_in_use` holds and the current
  server is an external Jellyfin (not Plex: stage 4).
- Routes: `POST /api/admin/mediaserver/migrate/scan`, `/migrate`, `/migrate/abort`, `/back`; re-auth on `/migrate` and `/back`; rate limits like stage 1; code-only answers.
- Audit: `system.mediaserver_migrate`, `…_back`, `…_requests_repointed`.

### Web

*Admin → Medienserver*: when the move is possible, the reason line "Umzug von deinem Jellyfin: kommt mit Stufe 2" becomes the
button *Von Jellyfin umziehen* next to the disabled choices. It opens a sheet with the scan (candidate picker when several), the
summary above, then the job's steps. All strings in the 7 locales. Nothing jumps (space reserved for the scan result, sizes and
progress).

### Docs

- `docs/mediaserver.md` (EN and DE): *Umzug von Jellyfin*: requirements, what is copied, downtime, the way back, troubleshooting codes.
- `docs/security.md`: the one foreign container the updater may stop or start; the read-only source mount; the original media paths.
- CHANGELOG.

## Follow-up after the owner's test (owner decision 3)

A separate small PR when the owner says the stage 2 test passed: the wizard and *Admin → Medienserver* offer *Ferrofin* (default)
and *Bestehender Jellyfin/Plex (Adresse)* only; *Jellyfin (offiziell, verwaltet)* disappears for new setups (an existing managed
Jellyfin keeps running and can be removed); the *Test* label and the trial note go; docs and CHANGELOG say so.

## Testing

- Unit:
  - scan of both layouts;
  - mount classification inside and outside the base;
  - the guard's migrated-target rules (every forbidden path, depth, `/data/...` allowed, `/ferrofin-data` refused);
  - the copy helper on fixture trees;
  - step order and the `finally` restart of the source on every failure point;
  - the abort;
  - the id check thresholds;
  - the way back;
  - the source op only for the recorded id.
- e2e: the sheet on desktop and phone with a mocked API: one candidate, several, outside the base, the job steps, the way back.
- Manual on the owner's NAS (cannot run in CI): the real move of the owner's install; play a title with resume position; a list
  and a favourite; a recording; the way back and forward again; the GPU.

## Left to the builder

- The exact copy list per layout, confirmed against the real official and linuxserver images.
- How free space is measured (helper `df` on the data volume target) and the safety factor if 1.2 proves wrong.
- The verify sample's queries (which FriendFlix tables hold item ids today).
- The exact German texts, then the other six languages.
