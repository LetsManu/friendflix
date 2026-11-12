# Final review 1d+1e: web, e2e, shells (a54c081c..d7b43619)

Scope: web/ (live list, live player, Senderliste, casting, admin Task 42 parts, hls, i18n), the Android / Fire TV Kotlin shells.
The package (review-1de-web-pkg.md, 11 132 lines) was read in passes with offset/limit, section by section: stat, Android bridge + cast + Fire TV keys, admin livetv, api/capabilities/cast UI, engine, layout/routes, bridge, hls/timing/tizen/webos/TvRail, cast receiver. The large files (LivePlayer.svelte, TvLiveList.svelte, the live part of engine.ts, spatial.ts, +layout.svelte key handling) were read in full from the worktree at d7b43619, so the line numbers below are real file lines. No tests were run. tizen/, webos/ and desktop/ shell directories have no changes in this range (their web-side key maps are in lib/tizen and lib/webos).

### Verdict
**Ready after fixes.** 0 Critical, 2 Important (both small), 7 Minor.

### Critical
None.

### Important

**I1. TV live player: ▲ from the control bar strands the focus in the top bar (D-pad dead end).**
`web/src/lib/live/LivePlayer.svelte:1124` (`.ltop`, no `data-nav`) with `web/src/routes/+layout.svelte:792` (`startSpatial(() => !watchPage || …closest('[data-nav]'))`) and `web/src/lib/live/livekeys.ts` (`if (c.tv && c.controlsVisible) return null`).
What: with the TV controls visible and the focus on a `.ctl` button (the only `data-nav` area), ▲ makes spatial navigation search the whole body (no `data-scope`), so the focus moves to the top bar's Back button or `.tinfo`. Those are outside `[data-nav]`, so spatial navigation switches off, and the player's resolver returns null for every arrow while the controls are visible. ◀ ▶ ▼ then do nothing. Only OK (Back button: leaves the player; title: info panel), Back (hides the controls) or the hide timer get out.
Why: spec §12.3 makes "OK on the title in the controls" a D-pad path and the global constraint says D-pad + OK + Back must work. A viewer who presses ▲ out of habit (▲ zaps while the controls are hidden) lands in a dead zone where ▼ does not bring them back. No e2e covers ▲ on visible controls (live-player-tv.spec.ts presses only ▼ / ▶ / Enter / Escape).
Fix: add `data-nav` to `.ltop`, so ◀ ▶ ▼ keep moving the focus (▼ from `.tinfo` lands back on the bar). Add one TV e2e: controls visible, ▲ reaches the title, ▼ returns to Play/Pause, OK on the title opens the info panel.
Size: small.

**I2. Phone live player: the control bar is wider than a 360–412 px phone once the cast button shows.**
`web/src/lib/live/LivePlayer.svelte:1271-1272` (phone `.ctl` / `.pill`) with `:1252` (`.ib` 44 px), `:1255` (`.pp` 52 px), `:1258` (`.restartslot` 44 px, always reserved), `:1168-1177`.
What (computed from the CSS, not measured): on a phone the bar holds Play 52 + restart slot 44 + LIVE pill 5.6em (about 90 px at 16 px) + cast 44 + ▲ 44 + ▼ 44 + Info 44. Every item is `flex: none`, and with 7 gaps of 4 px and 16 px of padding that comes to about 406 px. The bar is viewport − 16 px wide, so the content needs a viewport of about 422 px. Without the cast button it needs about 378 px.
- Inside the Android app `castShown` is always true (`inShell`), and in Chrome it is true whenever a Chromecast is around. On 360 / 384 / 393 / 412 px phones the last buttons run out of the bar, and `.lplayer { overflow: hidden }` clips them. At 360 px Info is fully off-screen, and on phones Info is the only path to *Senderliste* and *Programm*. Without the cast button, 360 px phones still lose about 18 px of the Info button.
- The mobile e2e runs at 390 px with `cast/config enabled: false`, so it never sees this.
Why: in portrait on the main phone platform (Android app) the phone's only route to the Senderliste is clipped. That breaks the owner rules "nothing jumps" and "44 px targets".
Fix: make the phone bar fit 360 px with the cast button shown. For example, on phones drop the reserved restart slot (restart is in the info sheet there), set the pill to about 4.4em, and let `.sp` take the leftover space; or move the cast button into the phone info sheet. Add a mobile e2e at 360 px with cast enabled that asserts every `.ctl` button's box lies inside the viewport.
Size: small. Confirm with one screenshot first, since the overflow is computed rather than measured.

### Minor

**M1. Carried Low (1), confirmed: a late `overtaken()` can stop the newer live cast.** `web/src/lib/cast/engine.ts:1668-1671` with `stop()` at `:1838-1841`.
Sequence: loadLive(A) is waiting on the receiver's `load` (stops = 0). Stop raises `stopCount` and `liveSeq`. loadLive(B) starts and B's `load` reaches the receiver quickly. A's `load` then resolves, `my !== liveSeq` and `stopCount !== stops`, so `cast.castStop()` runs and stops B's media. B then ends through `media-end` / `endLive`, and the viewer sees the cast vanish.
Fix: keep `let loadSinceStop = 0` (set to 0 in `stop()`, raised in `liveLoad`). In `overtaken`, call `castStop()` only when `onTv && stopCount !== stops && loadSinceStop === 0`. If a newer load has started, its own `load` replaces A's media anyway. Add an engine.live.test case for "Stop, new loadLive, old load resolves late".
Size: small.

**M2. Carried Low (2), confirmed: `liveLoad` gives up an in-flight resume before its watch is answered.** `web/src/lib/cast/engine.ts:1663`.
`gen++` runs before the watch request. When the watch is then refused (`live_full`, `provider_limit`, …), a `doResume()` that was re-adopting a title cast has already turned stale (`:1419`) and returns false. The title keeps playing on the TV without a bar (detached at best). The refused loadLive itself leaves the title running.
Fix: move `gen++` into `liveLoadRun` right after `if (my !== liveSeq) overtaken(a.token, false);` (`:1689`). If a resume finished first, `cur` is ended there anyway (`:1691-1698`).
Size: small.

**M3. A stray local watch can go out during pagehide while the player is the remote of a live cast.** `web/src/lib/live/LivePlayer.svelte:949-951` with `:1030-1032` and engine `livePageHide` (`engine.ts:1627-1633`).
When the engine's pagehide listener was added before the player's (the cast started on another page, then the player was opened from the cast bar), the engine's listener runs first. It calls `endLive(keepHint)` and `out.set(null)`. In the microtask checkpoint after that listener, `followCast(null)` runs with `hiding` still false and calls `start(curId)`, which sends `POST /watch` while the page unloads. The player's own pagehide then bumps `gen`, so the answer's token is never used or deleted. It idles out after 90 s, counts toward the per-account cap of 4 (the oldest token is evicted), and may start or hold a stream. The TV's `chromecast` token is safe: R14 keeps the slot classes apart.
Fix: in `followCast`, defer the restart past the event, e.g. `setTimeout(() => { if (!hiding && !destroyed && !remoteOn) void start(curId); }, 0)`, or set `hiding` from a `visibilitychange` → hidden check.
Size: small.

**M4. Android `startLive` ends a running title cast before the watch is answered; a refusal then ends the TV session.** `android/app/src/main/kotlin/app/friendflix/android/cast/CastController.kt:655` (`cur?.let(::endTitle)`) and `endIfIdle()` in `liveAnswered`.
The web engine does the opposite: the title ends only after the watch went through (`engine.ts:1690`), and a refusal leaves it playing. The KDoc states the Android order deliberately, but the two clients behave differently on `live_full` / `provider_limit`.
Fix: move `endTitle` into `liveAnswered` after `info != null`, or record the difference as a ruling. If the reason is that the title's stream must be freed for `max_streams`, say so in the KDoc.
Size: small.

**M5. `:focus-visible` on Chromium 85 (pre-existing, app-wide; verify on a device).**
Every TV focus ring, including the new ones at `TvLiveList.svelte:344, 359`, uses `:focus-visible`, which Chromium enabled by default only in version 86. The F12 scan list (`lib/live/compat.test.ts:18`) does not check it. If 2021 Tizen sets (Chromium 85) are a target, the live list shows no focus ring there; selector lists that contain `:focus-visible` are dropped whole.
Fix: check on a Tizen 6.5 set. If the ring is missing, add a `html.tv :focus` fallback in app.css (outside this PR's scope).
Size: small.

**M6. Channel-id patterns disagree across the Android layers.** `CastServerApi.kt:88` uses `^[A-Za-z0-9-]{1,64}$` (no underscore), while its comment calls it "the bridge's id shape (`ID_PATTERN`)". The bridge's `id()` and `LiveCastInfo.CHANNEL` both allow `_`. This is harmless today: the backend checks channel ids with `z.guid()` (`backend/src/livetv/routes.ts:55`).
Fix: align the regex or the comment.
Size: small.

**M7. Placeholder host nit.** A Kotlin test uses `https://ff.example`, but the owner list names `friend.example.com`. The `.example` TLD is reserved, so nothing leaks; only the convention differs. Fix optional.

### Checked and fine
- One keydown path in the player: a single capture listener (`LivePlayer.svelte:1070`). The `stopImmediatePropagation` on Back keeps the layout's bubble handler out (`+layout.svelte:305-333`, which also skips `watchPage`). Spatial navigation acts only inside `[data-nav]` on watch pages (`+layout.svelte:792`), so there is no double handling with the shell's spatial nav. The Enter long-OK path is skipped while a panel, number card or sheet is open (`:786`), and `refusal` returns early (`:784`).
- Long OK: keyup / blur / route all cancel it (`LivePlayer.svelte:744-749, 1105`; `TvLiveList.svelte:262, 269, 278`; `KidsLive.svelte:95, 61-63`). A held OK after a pick stays inert (`okHeld`, `:719, 727`).
- TV list Back / Info / digits / CH ± (`TvLiveList.svelte:232-261`): the rail and modals are respected (`overShell`); `ff-nav` row steps are cleaned up on destroy (`:270-276`).
- Tizen normalisation (`lib/tizen/livekeys.ts`): it registers each key in its own try/catch, prefers `getKey` codes, registers ChannelList / Guide only when supported, and never overrides a real `e.key`. LG keeps a real `e.key` too and maps 33/34 only when the key is Unidentified (`lib/webos/keys.ts`). `remotekeys.ts` feeds both the hint seen-set and the resolver.
- Fire TV keys (`FireTvKeys.kt`): OK stays native (long OK works); the new keys fire on the first keydown only; digits type into editable fields via `insertText`; only names from `KEYS.values` reach the script.
- Timers / listeners on destroy: LivePlayer clears every timeout and interval, the switcher, long OK, hls, the media session and the AirPlay listeners (`:1086-1113`). TvLiveList, ChannelsTab sync poll (`ChannelsTab.svelte` onDestroy) and TestSheet (`endPreview` on unmount and pagehide) do the same.
- Client token lifecycle: one beat in flight, stale after a switch (`LivePlayer.svelte:463-495`); old token DELETEd on switch (`:311`), on drop (`:354`), on late answers (`:283, 982`) and on destroy / pagehide with keepalive (`:1030-1037, 1110-1112`). The token is never stored or logged; `timing.ts` sends `{device, mode, firstFrameMs}` only for live.
- Admin test preview: the token is released on its 10-s end, re-test, close and pagehide (keepalive), and also when the answer arrives late (`TestSheet.svelte` `run`/`endPreview`). `startChannel` releases the test token at once (`status.ts`).
- Cast hint stores `sha256(token)[:32]`, never the token (`engine.ts:1579-1585`, `resume.ts`). The receiver gets the token only inside the content URL. Android `LiveCastInfo.toString()` hides token and URL, and `handle` is a hash.
- Android castLive: the bridge accepts only `channelId` (`only(args, …)` + `id()` pattern), answers once (`AtomicBoolean`), keeps its 25-s watch / 40-s + 15-s pick bounds inside the web's 90 s (`bridge.ts` `CAST_LIVE_TIMEOUT_MS`), and accepts answers only with a `/media/l/` relative URL and http(s) logos (`CastModel.kt` `parse`).
- Error codes ↔ copy: `fromWatchError` (`liveState.ts:46-67`) and `liveErrText` (`engine.ts:118-131`) cover every `WatchError` (`api.ts:69-77`) with existing keys.
- i18n: live, adminLive, kids, adminPeople and index have the same key order in all 7 locales; settings and shell differ only by plural forms. No "Netflix" / "Seerr" in the diff; no hosts other than placeholders; no `console.*` added.
- Animation: only transform / opacity in lib/live (grep of `transition:` / `animation:`); calm and reduced-motion overrides in place (`LivePlayer.svelte:1281-1287`); TV and kids still.
- Old-TV compat: lib/live, routes/live, hls.ts, tizen/webos key files are free of the F12 tokens (scan at `lib/live/compat.test.ts`). `??=` in hls.ts is fine on Chromium 85.
- Accessibility: polite live region for zaps (`LivePlayer.svelte:1211`); `role="alert"` cards; labelled controls and `aria-expanded` / `aria-haspopup`; Senderliste focus trap and roving tabindex (`ChannelPanel.svelte`); LIVE pill as shape plus text in the cast bars.
- Routing and gating: `/live` and `/live/watch` redirect when livetv is off; kids gate allows `/live` (`gate.ts`); `?play=last` replaces the history entry before opening the player; the player route re-creates only on real navigation (`{#key id}` + `afterNavigate`).
- R30 (chip picked in the panel becomes the zapping filter, `LivePlayer.svelte:698, 1023-1029`): implemented as ruled.
