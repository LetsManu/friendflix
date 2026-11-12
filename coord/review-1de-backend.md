# 1d+1e final review: backend, migrations, compose, CI, docs (head d7b43619)

### Verdict
**Ready after fixes.** 0 Critical, 1 Important, 7 Minor. The carried items (provider max_streams check not under conv:gate, favourites DELETE skipping livetv_off, now/next worked out per list request) are unchanged and no worse.

### Critical
None.

### Important

**I1. Admin *Stoppen* does not stop a channel that someone is watching: the viewers' players start it again within seconds.**
- Where: `backend/src/livetv/status.ts:152-161` (stopStream) together with `backend/src/livetv/streams.ts:355` (startOrJoin). The client side is `web/src/lib/live/LivePlayer.svelte:343-347,492` (rewatchOnce on 403/410).
- What happens: stopStream deletes the stream in livetv and drops its grant. It does not revoke the channel's tokens and leaves no mark behind. The next gateway authz for a viewer's token finds no stream (streamKeyFor is null) and answers 410. The web player treats 410 as "livetv restarted" and calls `POST /watch` once (rewatchOnce). startOrJoin then finds the channel not running and starts it again.
- Why it matters: Spec §7.4 says "Admin *Stoppen* stops it at once (viewers see the error state)". In practice *Stoppen* acts like *Neu starten* whenever a web viewer is present. An admin cannot stop a stream that is misbehaving or holding a budget slot, short of hiding the channel. It also leaves a misleading `stopped_by_admin` event.
- Fix:
  - stopStream sets a short KV marker `ltv:adminstop:<channelId>` (setnx, about 60 s) and revokes the live tokens on that channel.
  - startOrJoin refuses a channel that carries the marker with an existing error. `502 channel_unreachable` already has web copy and puts the player into its error state.
  - The *Neu starten* path (stop, then the admin's test start) clears the marker before it starts again.
  - Add a test: admin stop, then a viewer's watch is refused while the marker lives.
- Size: small to medium (Sonnet fix). Backend only, no web change needed.

### Minor

**M1. Privacy docs leave out the `home` flag of live timings.**
- Where: `docs/privacy.md:51`, `docs/de/privacy.md:51`, against `backend/src/playtiming.ts:67-74`.
- What: the docs say the live timing holds only the first-frame time and the device kind. `recordTiming` still inserts `home` (whether the start came from the home network) for `mode: 'live'`.
- Fix: add "and whether it came from your home network" in both languages, or store `home` as false for live rows. Size: small.

**M2. security.md calls refusals "revocations".**
- Where: `docs/security.md:347`.
- What: "Revoked on: … the channel being hidden, the profile losing the group". Nothing revokes tokens in those two cases. The authz refuses them with 403, using the 2-s memo and a rights cache that writes invalidate.
- Fix: move the two cases into their own sentence: "refused (403) within seconds when the channel is hidden or the profile loses the group". Size: small.

**M3. Release on switch never applies to a Chromecast channel switch, and the docs do not say so.**
- Where: `backend/src/livetv/tokens.ts:165` (deviceLiveView, local slot only per R14) and `backend/src/livetv/streams.ts:576` (releasableOld). Docs: `docs/livetv.md:100` and `docs/android.md` (Live channels on the TV).
- What: a cast ▲/▼ on a one-connection provider gets `provider_limit`, and A stays for 60 s. This follows R14 by design, but the docs describe release on switch without that limit.
- Fix: one sentence in livetv.md and de/livetv.md ("a switch on a Chromecast does not release the old channel early"). The alternative is to let releasableOld use the via class of the new watch, which needs an Opus decision. Size: small (docs).

**M4. A new live view does not count against `maxStreams` until its first fetch, and the check is not atomic.**
- Where: `backend/src/livetv/routes.ts:107-112`, `backend/src/livetv/tokens.ts:109`.
- What: the `play:` live record is written only by the first gateway authz (`touch`), never at mint. Watches from several devices in the same second therefore all pass the check before any of them is counted. The docs (`docs/livetv.md:98`) say a live view counts "like a film". The cap of 4 tokens per account bounds the overshoot.
- Fix: seed the live record with `setLive` in mintLiveToken, the same way the viewer key is seeded (F9). Size: small.

**M5. The livetv-only benchmark reports success when livetv's measurement failed.**
- Where: `backend/src/convbench.ts:112-153,163`.
- What: with `livetvOnly`, measureLivetv swallows its failure and the outcome noted is still `ok`. The card says the measurement succeeded while livetv's record stays missing or stale. The tick then repeats every 30 min, each time pausing previews for up to 130 s.
- Fix: measureLivetv returns a boolean, and the livetvOnly path notes `failed` (job error `conv-bench`) when it is false. Size: small.

**M6. The admin test preview skips the profile-switch check the watch route makes.**
- Where: `backend/src/livetv/adminRoutes.ts:488-503`.
- What: the watch route reloads the session after minting and answers 409 `profile_changed` if the profile changed (`routes.ts:129`). testPreview does not, so a test token minted while the admin switches profile can outlive the switch's revocation until it idles out (90 s). It is admin-only and short-lived.
- Fix: the same `loadSession` check after `mintLiveToken`. Size: small.

**M7. The signed logo signature lands in request logs.**
- Where: `backend/src/livetv/routes.ts:76` (logoAuth). Fastify's default request log in `backend/src/app.ts:111` includes the full `req.url`.
- What: the `?exp=…&sig=…` of the cast logo URL is logged. It grants only a logo image for 12 h, so the impact is low, but it is the one credential-bearing query on the backend.
- Fix: a request serializer that strips the query string, or accept it and note it in security.md. Size: small.

### Checked and fine
- **Live tokens, mint:** 32 random bytes, only the SHA-256 is stored, the viewer key is seeded (F9). Earlier tokens are replaced per slot of (test, via class) (R8, R14), and the cap of 4 per account includes test tokens (R32). `tokens.ts:109-124`.
- **Live tokens, revocation:** a marker first, then the keys and the live record, so nothing is resurrected (`replace`). It runs on logout, profile switch, device removal and account lock through revokeSessions: `devices.ts:77`, `auth.ts:374`, `profiles.ts:278`, `users.ts:171`.
- **Token authz:** `rightsOf` re-checks the account, role, profile, device approval and channel right with a 2-s memo. A test token needs the current role admin plus channelPresent (F10). Pins follow the cast rules (AirPlay 2 addresses within 120 s), and only a beat from the minting session re-pins. `tokens.ts:227-262`.
- **`/internal/authz/live`:** checks the secret before parsing, uses a strict zod schema, has rate limiting off like `/internal/authz`, answers `no-store` and returns fixed codes only. `routes/internal.ts:155`.
- **Watch, list, preview, favourites, last:** all filter by the asking profile's own `channelSet`. Unreleased groups are excluded for admins too, and kids profiles get only kid-friendly groups (`rights.ts:44-70`). Groups are named only when they hold a visible channel. The ETag is `Vary: cookie, x-ff-profile`. `routes.ts:92-300`.
- **Conversion budget:** the live source is read under the lock and bounded to 800 ms. The grant is bound to `live:<id>` so a start counts once (F8). The `exceptLive` / `onlyWithout` decision is made under one lock. Admission never asks livetv and reads only the memoised `livetvStale`. A stale livetv record counts as absent (R35, `convbudget.ts:171`). `CONV_DEFAULT_SLOTS` is unchanged. `convbudget.ts:147-198,298`.
- **Release on switch (Task 32):** the old stream is chosen from the local slot only, viewers are counted without the switching token, and join markers are checked against the stopping marker in that order. The grant is given back on every failed exit, and the tick skips channels that are starting or being released. `streams.ts:424-660`.
- **livetvTick:** a single runner under a renewed lock. Before an idle stop it re-checks viewers and join markers under the start lock. The boot check re-sends the ingest set after a livetv restart. Wired in at `server.ts` (15 s, op-gated, guarded against overlap). `streams.ts:689`.
- **Migrations:**
  - 48–50 are unchanged from 1c (50 holds the indexes).
  - 51 is appended at the end, drops the constraint by its auto-generated name (`playback_timings_mode_check` from migration 36's inline check, db.ts:648), and can be run again. `db.ts:1066-1074`.
  - favourites and recent cascade on the profile and the channel, and `devices.start_live` is created in 48 (`db.ts:1032-1045`).
- **Data export (priv-B, R33):** per profile, channel id and name only, newest first for recent. No URL, provider or credential columns are selected, and the queries are parameterised. `export.ts:139`.
- **Live playback timings (Task 39, R34):** the server drops every field except device and first-frame time, and live rows are left out of the film start statistics. `playtiming.ts:67-74,~131`.
- **SQL:** every new query is parameterised, including the uuid arrays (`any($1::uuid[])`) and the unnest update in `userdata.ts`. Profile writes are serialised by an advisory transaction lock.
- **Logging:** no token, stream key, URL or body appears in backend logs. testPreview logs the error class only, and profile-switch failures log the userId only. Fastify does not log bodies, which matches the claim in security.md (except M7). Checked by grepping `backend/src` for log calls.
- **Rate limits:** watch 30/min, beat 60/min, stop 60/min, list 120/min, writes 120/min, preview 300/min, authz off as designed. `routes.ts`.
- **Admin routes:**
  - `PATCH /api/admin/devices/:userId/:deviceId` accepts TV devices only (`not_tv`, which has web copy). It is audited as `device.start_live` without the device id.
  - `/api/me.startLive` requires a `tv-` device, `start_live` and `features.livetv`. `adminRoutes.ts:581`, `auth.ts`.
- **Error codes against web copy:** live_full, provider_limit, channel_unreachable, not_receiving, max_streams, livetv_off, profile_changed and not_tv are all handled in `web/src/lib/live/*` and `lib/api.ts`. `device_pending` on the watch route is practically unreachable, because requireUser refuses pending devices first.
- **Compose:**
  - The livetv service exists only under the `livetv` profile. It is on networks `[livetv, livetv-egress]` only and publishes the UDP range `${LIVETV_SRT_BIND:-127.0.0.1}:${LIVETV_SRT_PORTS}`/udp.
  - The container has a read-only root, `cap_drop ALL` and `no-new-privileges`.
  - The Docker socket is mounted only by docker-proxy (`compose.prod.yaml:449`).
  - The new `LIVETV_DVR_MINUTES` / `LIVETV_MAX_BITRATE` are passed through in both compose files, are in the settings registry and are bounded in config.ts (0–120 and 1–40 Mbit/s).
- **CI:** no CI config changes in this branch. The `.gitleaksignore` entries are commit-pinned test fixtures.
- **Docs and CHANGELOG:**
  - CHANGELOG has a "Live TV (optional)" entry. README (EN and DE) and ROADMAP are updated.
  - Spot checks against the code match: 90 s idle and 20 s touch, the 12 h cap, 4 tokens, the 45 s viewer window, the AirPlay 120 s window, the 15 s tick and 60 s stop, the event codes table, the DVR range 0–120 / 30, and the provider limit writing no event.
  - Docs use only placeholder hosts (`friend.example.com`, `iptv.example.com`, `192.0.2.x`) and the fictional name "Nordlicht TV". "Netflix" and "Seerr" appear nowhere.
