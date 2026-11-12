# 1d+1e final review: livetv container + gateway (base a54c081c → head d7b43619)

### Verdict
**Not ready.** One Critical: the livetv image does not build. Once that one-character fix is in, the area is **Ready**. I found no Important findings in the code. The security boundaries (SSRF guard, signed API, `/s/` and `/media/l/` path checks, SRT handshake, ffmpeg argument handling, log scrubbing) hold across tasks.

### Critical

**C1. `livetv/Dockerfile:61`: a literal `\n` breaks the runtime-stage `apt-get install`, so the image never builds.**
- **What:** the line reads `… libatomic1 libsrt1.5-openssl \n  && echo 'deb [arch=…' > /etc/apt/sources.list.d/jellyfin.list \`. The backslash and `n` are two literal characters, not a line break. `/bin/sh` reads the unquoted `\n` as `n`, so the command becomes `apt-get install … libsrt1.5-openssl n && echo …`. apt fails with "Unable to locate package n" (exit 100) and the build stops.
- **Where it came from:** the merge commit 8ded8b2f ("Merge PR 1c … into the local lane"). Neither of its parents has it: 856e8b86 and 3828c3f1 still have a real line break there. CI only runs `docker compose … config -q` (ci.yml:292-296), which never builds the image, so nothing caught it.
- **Why it matters:** the livetv service, `srtgate` and every other part of Phase 1 Live TV cannot ship. The image tag never gets built.
- **Fix:** replace the `\n` with a real backslash-newline continuation, so the line ends in `libsrt1.5-openssl \` and the next line starts with `  && echo 'deb …`. Then run `docker build -f livetv/Dockerfile .` once; both `srtgate --selftest` runs must pass. Optionally, add a livetv `docker build` (or `hadolint`) step to CI so a mangled Dockerfile fails the PR.
- **Size:** small.

### Important
None.

The carried issue (provider `max_streams` checked outside `conv:gate`) lives in the backend. livetv neither makes it worse nor protects against it: `Streams.start` (streams.ts:163) is idempotent per channel and synchronous, so two starts of one channel always share one stream. Two different channels on one source each get their own stream, as the carry already describes. It is not worse than described.

### Minor

**M1. `gateway/src/gateway.ts:145,148`: the gateway regexes accept more than R16 (`livetv/src/routes/files.ts:16`).**
- **What:** `LIVE_ROUTE` and `LIVE_FILE` also accept `init.mp4` and segment names with leading zeros (`007.ts`). The Task 34 carry said the two must be equal. Today livetv answers these names with 404, so nothing leaks, but the two allowlists can drift apart.
- **Fix:** use `init-[0-9]{1,10}\.mp4|(?:0|[1-9][0-9]{0,9})\.(?:ts|m4s)` in both gateway regexes, and adjust the gateway test that expects `init.mp4` to reach livetv.
- **Size:** small.

**M2. `livetv/native/srtgate.c:685`: `ok = s->has_feed && (!found || gen == s->gen)` accepts a connection whose pending entry is already gone.**
- **What:** a pending entry disappears in two ways: it timed out after 3 s (and was then counted as a passphrase rejection and a ban hit), or it was pushed out because more than 256 handshakes were pending. In both cases the connection is accepted without the generation check. A credential change that happens in that gap is not enforced, and a slow but correct handshake counts toward the ban.
- **Fix:** treat `!found` as refused: `ok = s->has_feed && found && gen == s->gen`. Alternatively, keep the gen check by leaving timed-out entries in a short "expired" list.
- **Size:** small.

**M3. `livetv/src/srtingest.ts:169` and `:332`: when a port is handed to another feed, the old sender's in-flight data can land in the new feed's ring.**
- **What:** `setFeeds` builds the new slot for the port at once. srtgate drops the old sender only on its next loop pass. Data frames already in the pipe are filed by port, so they go to the new slot. That slot then counts as `receiving` for up to 5 s, and a viewer who starts the new channel in that window can see a few seconds of the other feed.
- **Why it can happen:** the backend hands out the lowest free port, so deleting one push feed and creating another reuses the same port right away.
- **Fix:** when a port's channel changes, ignore data on that port until srtgate has sent `closed` for it, or until srtgate confirms the new set. A per-port "awaiting close" flag in the hub is enough.
- **Size:** small.

**M4. `livetv/src/preview.ts:19`: the preview run lets ffmpeg guess the format of a provider-supplied `.ts` file while reading it with `-protocol_whitelist file`.**
- **What:** in passthrough mode the segment bytes come straight from the provider. Current ffmpeg already blocks the dangerous cases: it will not detect HLS behind a `.ts` name, and the concat demuxer's default safe mode refuses absolute paths and `..`. So I found no concrete leak, for example of `/run/friendflix-livetv/livetv_key`.
- **Fix (hardening):** add `-f mpegts` before `-i` so only the MPEG-TS demuxer is ever used.
- **Size:** small.

### Checked and fine
- **Signed API:** `/v1/*` is signed over the whole request target, and the HMAC is compared with `timingSafeEqual` (`livetv/src/protocol.ts:85`, `server.ts:138`). The key comes from the key file only (`config.ts:20-30`); there is no INTERNAL_SECRET fallback, and a set INTERNAL_SECRET only triggers a warning (`server.ts:182`). Only `/s/` and `/healthz` are unsigned.
- **`/s/` route** (`routes/files.ts:15-16`): the stream key matches `^[0-9a-f]{32}$` and the file name matches R16 exactly. Both are checked on the raw path, so nothing is decoded and traversal is impossible. Names are looked up in the window, never joined from user input. The file is opened before the answer, so a dropped segment is a clean 404.
- **Gateway `/media/l`** (`gateway.ts:145-990`):
  - Routing and paths: it dispatches on the raw path too, so a normalised `..` gets 403. Any query gets 403. The stream key from the backend must match livetv's shape, and the target's origin is checked again.
  - Requests to livetv: `redirect: 'manual'`, no client headers forwarded, 15-s header timeout.
  - Playlists: capped at 2 MB, and every URI must be a bare file name.
  - Answers: content type checked per extension, `nosniff`, CORS as on the cast path.
  - Authz: answers memoised 2 s under sha256(token)|ip with single-flight; backend errors are not memoised.
  - Brute force: 401s feed the cast failure limiter; 403/410 do not.
- **Backend contract:** `/internal/authz/live` answers 401/403/410 or `{streamKey, kind:'live', maxAgeS}` (`backend/src/routes/internal.ts:155-165`), which matches the gateway's expectations. The test-token rule (F10) is enforced in the backend's `resolveLiveToken`, so the gateway needs nothing extra.
- **SSRF:** everything goes through `netguard.ts`/`guardedFetch` (pinned lookup, at most 3 redirects, each re-checked, scheme changes refused, own subnets refused). Every new fetch site uses it: passthrough, `inputs.ts:138`, the probe. ffmpeg never opens a provider URL. It reads `pipe:0` with `-protocol_whitelist pipe`; an SRT input gets an IP-literal URL with `srt,udp` only (`ffmpeg.ts:71`, `inputs.ts:138-145`).
- **Process spawning:** spawn is called without a shell, with a fixed binary and a minimal environment (`run.ts`, `srtingest.ts`). Arguments come from enums, a hex directory or an IP-literal `srt://` URL, so none can start with `-`. The benchmark and preview arguments are fixed.
- **Logging:** ffmpeg stderr goes through `stderrLine` (data arguments, URLs, userinfo, credential-like values, absolute paths and 32-hex runs are all replaced) and is capped at 50 lines per run (`run.ts:56`, `ffmpeg.ts:94`). Drivers and the hub log channel ids and fixed texts only; srtgate's stderr is ignored; the gateway logs nothing on the live path.
- **SRT push** (`srtgate.c:144`, `:313`, `:636`):
  - The stream id is compared in constant time per port. The passphrase is set per socket together with `ENFORCEDENCRYPTION` and `PBKEYLEN 32`, and is wiped after use.
  - The ban (20 hits in 1 min → 10 min) only counts refusals that judged a credential. Conflicts and ports without a feed are not counted, so an encoder cannot lock itself out.
  - A credential change kicks the running sender.
  - The input is hardened: line cap, JSON parser with depth and size limits, printable ASCII only; the hub caps frames at 1 MB for data and 4 KB for events.
  - Inside the container srtgate binds 0.0.0.0, but compose publishes the range on `127.0.0.1` by default.
- **Ingest routes** (`routes/ingest.ts`): the body is validated, the error answer never echoes the body (it holds passphrases), and feeds outside the port range are ignored.
- **Resource limits:**
  - Reconnects back off 2 → 30 s; the stall watchdog fires after 32 s (`remux.ts:44`); an idle stream body ends after 20 s; polling runs every 1–15 s.
  - Size caps: playlists ≤ 2 MB, segments ≤ 50 MB; rings ≤ 32 MB, each reader ≤ 64 MB; at most 50 events.
  - Disk: the DVR cache cap (`cache.ts:15`, `streams.ts:326`) shrinks the longest window first and always keeps the newest 3 segments. Leftover directories are cleared at start.
- **Concurrency** (`streams.ts:163`, `:199`):
  - Two starts of one channel get the same key.
  - Replacing a failed stream unregisters it synchronously before the new entry exists.
  - A stop while starting aborts the probe or ffmpeg and waits for the driver and the playlist writes before removing the directory.
  - The idle timer is cleared on stop; preview results of a dropped stream are discarded.
- **Wire types:** `StreamView`, `IngestState`, `StartBody`, `BenchAnswer` and the error codes (`invalid` + field, `unsupported_mode`, `encoder_unavailable`, `busy`) match `backend/src/livetv/wire.ts` field for field.
- **Dockerfile** (apart from C1): every base image is pinned by digest, the Jellyfin key fingerprint is checked, the image runs as `USER 10001`, `srtgate --selftest` runs in both stages, and there is no Docker socket. Compose runs the service with `read_only`, `cap_drop: ALL` and `no-new-privileges`, on an internal network plus an egress network.

## Re-review (fix commit c6d417c9, in claude/lt-final-fixes head c0a50e35; livetv/ and gateway/ only)

### Verdict
**Ready.** All five findings are fixed. No Critical or Important finding is left, and I found no regression. The diff from d7b43619 touches 8 files in livetv/ and gateway/: the Dockerfile, gateway.ts, srtgate.c, preview.ts, srtingest.ts and three test files.

- **C1, resolved.** `livetv/Dockerfile:61` now ends in `libsrt1.5-openssl \`, and `&& echo 'deb …'` starts the next line. The file has no other literal `\n` (grep). No continuation runs into a blank or comment line; a script flagged line 52, but that was a false positive (the line has no trailing backslash). I take the fixer's report of a green `docker build` with both `srtgate --selftest` runs as given; I did not rebuild.
- **M1, resolved.** `LIVE_ROUTE` is now `…/(index\.m3u8|init-[0-9]{1,10}\.mp4|(?:0|[1-9][0-9]{0,9})\.(?:ts|m4s))$`. Both it and `LIVE_FILE` are character for character the R16 alternation, apart from the non-capturing groups. The test refuses `init.mp4`, `007.ts` and `00.m4s`. The playlist URI check (`liveUrisOk`) uses the same `LIVE_FILE`, and livetv's own playlist only writes `init-<n>.mp4` and `<seq>.<ext>` with seq starting at 0 and no leading zeros, so valid playlists still pass.
- **M2, resolved.** `ok = s->has_feed && found && gen == s->gen` (`srtgate.c:~686`).
  - Valid handshakes still go through: the callback adds every handshake it lets through to the pending table, and libsrt queues the socket for accept as soon as its conclusion answer is sent. The main loop accepts within its 100-ms poll.
  - Residual (not blocking): if livetv stops reading srtgate's stdout for more than 3 s, `write_all` blocks the main thread. When it wakes, `check_pending` runs before `accept_on`, so a valid pending sender can now be refused and counted. Before the fix it was accepted but still counted. The encoder just retries, and the ban needs 20 such refusals within 1 min. Optional hardening: call `accept_on` for ready listeners before `check_pending`, or measure the timeout from the last loop pass.
- **M3, resolved.** `awaitClose` is set only when the port's previous slot is connected. srtgate always kicks that sender (new credentials), so a `closed` event always follows and clears the flag.
  - The new sender's frames cannot be dropped: srtgate writes the `closed` frame of the old sender before the new sender's `accepted` frame, and `accepted` also clears the flag.
  - The port cannot get stuck: if srtgate dies, `onGone` disconnects every slot, the restarted helper has no old sender, and the next `accepted` clears the flag. No data can arrive before that `accepted`.
  - Residual edge: if the port is handed over a second time before `closed` arrives, the newest slot sees `connected=false` and gets no flag. That takes two set changes within one srtgate loop pass. Ignorable.
- **M4, resolved.** `-f mpegts` sits right before `-i`, so it applies to the input. The output keeps its own `-f image2` after `-i`. The test pins the order.
- **Regressions:** none found. The gateway changes only narrow what it accepts. `onEvent` keeps its order (the flag is cleared before the `accepted`/`closed` handling). `newSlot` sets the new field. No other caller depends on the old regexes.
