<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type Hls from 'hls.js';
  import { createEventDispatcher, onDestroy, onMount, tick as tickDom } from 'svelte';
  import { api, ApiError, backdrop, fmtClock, getActiveProfile, getCsrf, HERO_WIDTHS, img, secToTicks, srcset, ticksToSec } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { get } from 'svelte/store';
  import { prefs, prefsLoaded, saveAudioFx } from '#lib/stores';
  import { features, segmentShown, serverCaps } from '#lib/capabilities';
  import { subClasses } from '#lib/substyle';
  import { episodesBeforeAsk, noteInteraction } from '#lib/stillwatching';
  import { nowPlaying } from '#lib/remote';
  import { bindPlayerMediaSession } from '#lib/player/mediasession';
  import { isBackKey } from '#lib/spatial';
  import { isLgApp } from '#lib/webos/detect';
  import { isTvApp } from '#lib/tvapp';
  import { pauseWhenHidden, postFireTv } from '#lib/firetv/detect';
  import { normaliseLgKey } from '#lib/webos/keys';
  import { isTypingTarget, nextSubtitle, resolveKey, SHORTCUTS, toggleSubtitle, type KeyAction } from '#lib/player/keymap';
  import { BRIGHTNESS_MIN, brightnessPct, classifyMove, levelFromDrag, registerTap, scrubTarget, TAP_WINDOW, volumeSettable, zoneOf, type Axis, type TapState, type Zone } from '#lib/player/gestures';
  import { creditsStart } from '#lib/player/nextup';
  import { postplayStart } from '#lib/postplay';
  import { reportPlayback } from '#lib/telemetry';
  import { avoidTarget, COOLDOWN_RETRY_MS, decideRecovery, freshRecovery, isCodecError, isNativeCodecFailure, kindOfMediaError, lowerQuality, MAX_NETWORK_TRIES, networkStep, pickLockedLevel, type AvoidWhat, type ErrorKind } from '#lib/player/retry';
  import { TvWheelStepper, WheelAccumulator } from '#lib/player/wheel';
  import { parseVolume, stepVolume } from '#lib/player/volume';
  import { hlsConfig, loadHls } from '#lib/player/hls';
  import { airPhase, airPlaySupported, createAirPlay, type AirPlayController, type AirPlayState } from '#lib/player/airplay';
  import { castBackdrops } from '#lib/cast/remoteview';
  import { airLog } from '#lib/player/airplayLog';
  import RemoteScreen from '#lib/cast/RemoteScreen.svelte';
  import AirPlayConnecting from '#lib/player/AirPlayConnecting.svelte';
  import PlayOnSheet from '#lib/cast/PlayOnSheet.svelte';
  import { episodeCode } from '#lib/cast/bar';
  import { airSubBody, rememberSubsRefused } from '#lib/cast/airsubs';
  import { AbrController, LADDER, autoBps, isOriginalBps, rungKey, type Decision } from '#lib/player/abr';
  import { BandwidthEstimator, loadStoredEstimate, storeEstimate } from '#lib/player/bandwidth';
  import QualityChip from '#lib/player/QualityChip.svelte';
  import { speedLabel, SPEEDS } from '#lib/player/bar';
  import { appCaps, playerCapsSummary } from '#lib/webos/caps';
  import { avoidedUntil, capsPending, clientWhy, isFormatFailure, isProbedBlock, noteDirectFailure, noteHlsFailure, remeasureOutput, setStereoOnly, stereoOnly } from '#lib/player/devicecaps';
  import { firstFrameMs, watchFirstFrame } from '#lib/player/firstframe';
  import { firstPlaybackRequest, noEstimateStart, playbackInfoBody, type InfoBody, type PlaybackDto } from '#lib/player/infobody';
  import { playerReportBody } from '#lib/player/reportbody';
  import { holdPrefetch, prepareNext, releaseNext, takeNext, takePrefetched } from '#lib/player/prefetch';
  import { CONTROLS_HIDE_MS, CONTROLS_HIDE_TV_MS, createTiming, deviceClass, effectiveType, sendTiming } from '#lib/player/timing';
  import EpisodesPanel from '#lib/player/EpisodesPanel.svelte';
  import CastInfoPanel from '#lib/player/CastInfoPanel.svelte';
  import CastPeek from '#lib/player/CastPeek.svelte';
  import ScenesPanel from '#lib/player/ScenesPanel.svelte';
  import { hasPeople, loadCastInfo, type CastInfoData } from '#lib/player/castinfo';
  import { chapterIndexAt, chapterLabel, chapterMarks, normalizeChapters, trickFrame, usefulChapters, type Chapter } from '#lib/player/chapters';
  import { applyRate, reapplyRate } from '#lib/player/rate';
  import { AudioFxEngine, fxActive, fxBlocked, fxFromPref, fxToPref, loadFx, plainPathDue, saveFx, type AudioFx } from '#lib/player/audiofx';
  import { frameShown, snapshotFrame, swapAllowed } from '#lib/player/freshvideo';
  import { fmtDuration, getLocale, t, tr, type TFn, type TKey } from '#lib/i18n';
  import { animeAudio, animeDefaultApplies, animeSubtitle } from '#lib/player/anime';
  import { castBody, castCapsReady, castConfigEnabled, castFellBack, continuousFields, postAirPlayToken, castSetVolume, castState, castToggleMute, initCast, loadOnCast, onCastEvent, requestCastSession, type CastEvent, type CastInfo } from '#lib/cast';
  import { CAST_VIDEO_ATTR, castEngine, castSession, type CastSession } from '#lib/cast/engine';
  import { episodeOf, joinedAsk, joinedAt, type JoinedItem } from '#lib/cast/joined';
  import type { Item } from '#lib/api';
  import { SEEK_COMMIT_MS, seekCancel, seekCommit, seekStep, type SeekPreview } from '#lib/player/tvSeek';
  import { pauseScreenDue, playerBack, tvPlayerButtons, type TvButton, type TvLayer } from '#lib/player/tvLayer';
  import TvControls from '#lib/player/TvControls.svelte';
  import TvTracks from '#lib/player/TvTracks.svelte';
  import TvEpisodesOverlay from '#lib/player/TvEpisodesOverlay.svelte';
  import TvPauseScreen from '#lib/player/TvPauseScreen.svelte';
  import { fade, fly } from 'svelte/transition';
  import { deskActive } from '#lib/desk/bar';
  import { deskPauseDue, deskPlayer } from '#lib/player/desk/logic';
  import DeskPauseScreen from '#lib/player/desk/DeskPauseScreen.svelte';
  import { SCRIM_MENU } from '#lib/glass/tone';
  import PhonePauseScreen from '#lib/player/phone/PhonePauseScreen.svelte';
  import { grow, springAt } from '#lib/player/desk/grow';
  import { motionAllowed } from '#lib/preview';
  import { motionLevel, motionTripped } from '#lib/tv/motion';
  import { kidsMode } from '#lib/kids';
  import { perms } from '#lib/perms';
  import { growOrigin, moreExtras, panelAnchor, panelBox, phoneOrient, phonePlayer, phoneSub, phoneTools, type PhoneOrient } from '#lib/player/phone/logic';
  import BackLayer from '#lib/player/phone/BackLayer.svelte';
  import PhoneTitle from '#lib/player/phone/PhoneTitle.svelte';
  import PhoneTopBar from '#lib/player/phone/PhoneTopBar.svelte';
  import ProgressLine from '#lib/player/phone/ProgressLine.svelte';

  export let itemId: string;
  /** shown on the phone's remote while this plays */
  export let title = '';
  /** centred in the control bar: series / film name and, for episodes, "F3 Folgentitel" */
  export let barTitle = '';
  export let barSub = '';
  /** series of the playing episode: shows the episodes panel button */
  export let seriesId = '';
  export let seasonId = '';
  /** known to be a film (no per-series audio / subtitle preference to look up) */
  export let isMovie = false;
  /** language picked on the detail page: audio language code, subtitles code or 'off' (empty = my defaults) */
  export let wantAudio = '';
  export let wantSub = '';
  export let video: HTMLVideoElement | null = null;
  /** the element that goes fullscreen (so overlays/chat stay visible) */
  export let stage: HTMLDivElement | null = null;
  export let report = true;
  /** false = viewer may not play/pause/seek (watch party guest): controls are shown disabled and a hint appears */
  export let canControl = true;
  export let denyHint = tr('player.denyHint');
  /** watch party: no speed control (it would fight the drift correction) */
  export let partyMode = false;
  export let hasNext = false;
  /** px reserved on the right (e.g. open chat panel) so the control bar is not covered */
  export let inset = 0;
  /** true when the viewer chose "sleep after this episode" (the page then must not autoplay the next one) */
  export let sleepAfterEpisode = false;
  /** start position in seconds (shared scene link); overrides the resume position */
  export let startAt: number | undefined = undefined;
  /** second at which the end credits begin (outro segment or the last 25 s); Infinity while unknown. Read by the page for its "next episode" card. */
  export let creditsAt = Infinity;
  /** 1.1 post-play: second from which the "Done? See what's next" card may show (outro segment, else last chapter, else 95 %); bind:postplayAt */
  export let postplayAt = Infinity;
  /**
   * Loading poster (watch page): the item's backdrop (else its primary image), dimmed, with the title and a thin progress bar
   * from the first frame of the route until the video has its first frame; then it crossfades out (300 ms). backdrop/image
   * false = the item has none; undefined = unknown yet (tried in that order). null = no poster (watch party).
   */
  export let poster: { id: string; backdrop?: boolean; image?: boolean } | null = null;
  /** true while the cast engine owns this title's cast session (the Player is a remote for it) */
  export let remote = false;
  /** the playing item (watch page): the TV pause screen's logo, episode line and synopsis */
  export let item: Item | null = null;
  /**
   * credits sequence beat (desktop, TV and phones, spec 2026-11-08 §4; the watch page computes it): 'corner' glides the picture
   * into the top-start corner (stage `.cred`) and hides the bar; a click or tap on the small picture, Esc or TV Back dispatch `credits`
   */
  export let credits: 'off' | 'chip' | 'corner' = 'off';
  /** bind: the viewer is busy in the player (menu, scrubbing, a dialog, cast & info, paused before the end): the page holds the chip */
  export let credHold = false;
  /** bind: the phone's orientation (from the window size; 'landscape' elsewhere) */
  export let orient: PhoneOrient = 'landscape';
  /** the page shows a card in the default slot (next up, "still watching?", post-play, more like this): the phone pause screen waits */
  export let cardOn = false;
  /** a panel of the page's own in the dock is open (the party host's settings): the title fades, Back and an outside tap close it */
  export let extPanel = false;
  /** the next episode's id while the page's autoplay countdown runs: its playback info is prepared and its transcoder warmed (prefetch.ts) */
  export let prepNext: string | null = null;
  /** the episode before this one (lock screen / media keys "previous"); null = none, a film or not known yet */
  export let prevEpisodeId: string | null = null;
  const dispatch = createEventDispatcher();

  type Info = PlaybackDto;
  let info: Info | null = null, hls: Hls | null = null, error = '', mode = '', audioIndex: number | undefined, subIndex = -1;
  let segments: Array<{ type: string; start: number; end: number }> = [];
  let progressTimer: ReturnType<typeof setInterval>, started = false, stopped = false;

  // ---- casting: once the receiver plays, the session is handed to the cast engine (lib/cast/engine.ts), which keeps it
  //      running after this page; from then on (`handedOff`) this Player never reports, revokes or stops anything itself,
  //      and while it stays mounted (`remote`) it is a remote for `castSession` ----
  /**
   * set at the hand-off (for good once this Player unmounts): the AirPlay <video> now plays the engine's session while this
   * component's `on:*` handlers are still on it (as long as the watch page stays open), so every media handler, timer and
   * report returns early on it; only the engine reports
   */
  let handedOff = false;
  $: tvSession = remote ? $castSession : null;
  /** the tracks menu: the playback info's tracks, or (attached to a running cast, no info) the cast session's */
  $: audioOpts = info?.audioTracks ?? tvSession?.audioTracks ?? [];
  $: subOpts = info?.subtitles ?? tvSession?.subtitles ?? [];
  /** Chromecast: while casting the local <video> stays paused and every control drives the receiver */
  $: casting = remote && $castSession?.kind === 'chromecast';
  let castBusy = false, castOff: (() => void) | null = null;
  // ---- AirPlay (Safari): the <video> itself plays on the receiver, from a cast token URL (lib/player/airplay.ts) ----
  const AIR_IDLE: AirPlayState = { available: false, active: false, busy: false, ready: false, error: false, connecting: false };
  let air: AirPlayController | null = null, airState: AirPlayState = AIR_IDLE, airInfo: CastInfo | null = null, airProbe: HTMLVideoElement | null = null;
  $: airPh = airPhase(airState);
  /** the connecting layout is up: it alone acts (only Back stays), like the remote screen */
  $: aconn = airPh === 'connecting' && !tvSession && !handedOff;
  /** its picture: the remote screen's candidates (an episode's still, the series backdrop); no backdrop (`poster.backdrop === false`) goes straight to the primary image */
  $: airArt = castBackdrops({ itemId, isEpisode: item?.type === 'Episode', seriesId: item?.seriesId }).filter((_, i, a) => !(i === 0 && poster?.backdrop === false && !(item?.type === 'Episode') && a.length > 1));
  $: airOn = remote ? $castSession?.kind === 'airplay' : airState.active;
  let destroyed = false;

  // ---- Media Session (lock screen, Control Center, media keys): bound once this page plays locally; a hand-over the player starts
  // itself (AirPlay, cast) keeps the binding, so the lock screen never goes blank in between (the cast's own binding takes the session over) ----
  let mediaBind: ReturnType<typeof bindPlayerMediaSession> | null = null, mediaEl: HTMLVideoElement | null = null;
  $: mediaItem = item && item.id === itemId ? {
    title: item.name,
    artist: item.type === 'Episode' && item.seriesName ? [item.seriesName, episodeCode({ subtitle: '' }, item, tr)].filter(Boolean).join(' · ') : item.year ? String(item.year) : '',
    artworkIds: item.type === 'Episode' && item.seriesId ? [item.id, item.seriesId] : [item.id],
  } : null;
  /** lock-screen play: never while the title is on its way to the TV (local playback would start a second stream) */
  function mediaPlay() { if (!castBusy && video?.paused) togglePlay(); }
  $: mediaActions = {
    play: mediaPlay,
    pause: () => { if (video && !video.paused) togglePlay(); },
    seekTo: (t: number) => seekTo(t),
    seekBy: (d: number) => seekBy(d, true),
    next: hasNext ? () => { if (allowed()) void goNext(); } : null,
    prev: prevEpisodeId ? () => { if (allowed() && prevEpisodeId) dispatch('episode', { id: prevEpisodeId }); } : null,
  };
  $: if (!mediaBind && !destroyed && video && mediaItem && started && !remote && !handedOff && !airOn) { mediaEl = video; mediaBind = bindPlayerMediaSession(video, mediaItem, mediaActions); }
  // a fresh element (sound modes off, restorePlain): the listeners move to it
  $: if (mediaBind && !destroyed && !handedOff && video && mediaEl && video !== mediaEl && mediaItem) { const old = mediaBind; mediaEl = video; mediaBind = bindPlayerMediaSession(video, mediaItem, mediaActions); old.release(); } // bind first: the session never goes blank in between
  $: if (mediaBind && mediaItem) mediaBind.update(mediaItem, mediaActions);

  // ---- UI state ----
  let paused = true, current = 0, duration = 0, buffered = 0, volume = 1, muted = false, rate = 1, waiting = true, fullscreen = false;
  let menu: '' | 'tracks' | 'settings' | 'scenes' | 'more' | 'speed' | 'episodes' | 'chapters' | 'quality' = '', toast = '', toastTimer: ReturnType<typeof setTimeout>;
  let lastActive = Date.now(), tick = Date.now(), activityTimer: ReturnType<typeof setInterval>;
  type Bookmark = { id: string; position: number; note: string | null };
  let bookmarks: Bookmark[] = [], noteText = '', xray = false, pausedLong = false, pauseT: ReturnType<typeof setTimeout>;
  const SUB_LANGS = ['ger', 'eng', 'fre', 'spa', 'ita'] as const;
  let subDlg = false, subLang = 'ger', subResults: Array<{ id: string; name: string; provider: string; downloads?: number }> | null = null, subMsg = '', subBusy = false;
  let quality = 0, sleepMin = 0, sleepAt = 0, sleepLeft = '', prefsApplied = false, autoSkipped = new Set<number>(), pipOk = false, inPip = false;
  let scrubbing = false, scrubTime = 0, hoverX = -1, hoverTime = 0, trackEl: HTMLDivElement;
  // ---- robustness: stall spinner (only after 500 ms), reconnect overlay, recovery bookkeeping ----
  let spin = false, spinT: ReturnType<typeof setTimeout>, reconnecting = 0, retryT: ReturnType<typeof setTimeout>, rec = freshRecovery(), lastPos = 0, posKnown = false, errPos = 0, errTitle = '', errNote = '';
  function setSpin(on: boolean) { clearTimeout(spinT); if (!on) { spin = false; return; } spinT = setTimeout(() => (spin = true), 500); }
  $: setSpin(waiting && !error && !remote && !reconnecting);
  // ---- loading poster: shown until the first frame (loadeddata / playing), then a 300 ms crossfade; the control bar waits for it ----
  let posterOn = Boolean(poster), posterOut = false, posterFail = 0, posterT: ReturnType<typeof setTimeout>;
  $: posterKinds = poster ? ([poster.backdrop !== false && 'Backdrop', poster.image !== false && 'Primary'].filter(Boolean) as Array<'Backdrop' | 'Primary'>) : [];
  $: posterKind = posterKinds[posterFail] ?? null;
  function firstFrame() {
    timing.frame();
    if (!posterOn || posterOut) return;
    posterOut = true;
    clearTimeout(posterT); posterT = setTimeout(() => (posterOn = false), 320);
  }
  $: if (remote) posterOn = false;
  // ---- adaptive quality (quality 0 = Auto): bandwidth estimate -> rung; stalls and network errors step down, a good link steps up ----
  const est = new BandwidthEstimator();
  let abr: AbrController | null = null, reqHint: 'network' | 'manual' = 'network', switching = false, queuedPick: number | null = null, sessionPlaying = false, shownQ = 0, chipOpen = false, waitSince = 0, stallHandled = false, stallT: ReturnType<typeof setTimeout>, abrTimer: ReturnType<typeof setInterval>, bwTimer: ReturnType<typeof setInterval>, directSeen = 0;
  const STALL_NOW_MS = 2100; // a wait this long counts as a stall at once (the controller steps down on > 2 s), not only when playback resumes
  const rungLabel = (bps: number): string => rungKey(bps); // by threshold, like the server's rung height (a 20 Mbit/s transcode is 1080p)
  const makeAbr = (start: number, pinned?: number) => new AbrController({ now: () => performance.now(), cap: info?.roleMaxBitrate ?? Infinity, start, pinned });
  /** bit/s asked from the server: the pinned pick, the running controller's rung, or (first load) Auto's value for the remembered estimate (above 8 Mbit/s = original). */
  const wantBps = () => (abr ? abr.current : quality || autoBps(loadStoredEstimate()));
  const persistEstimate = () => { if (est.estimate !== null) storeEstimate(est.estimate); };
  $: chipDirect = mode === 'direct';
  // ---- touch gestures ----
  let locked = false, lockHint = false, lockT: ReturnType<typeof setTimeout>, lockHold = false, coarse = false, volOk = true, brightness = 1;
  /**
   * Phone layout (touch, not the TV): top bar with title + quality chip, play / ±10 in the centre, one bottom bar
   * (time · seek bar · time, then a row of icons), everything inside the safe areas (--safe-* tokens). Desktop and TV keep their bar.
   */
  let phone = false, ctlH = 0;
  /**
   * Phone player (spec 2026-11-08, block 4): touch, not the TV, not a kids profile (kids phones keep the layout above). Top bar with
   * glass circles, one bottom dock (title, timeline, two glass pills); everything follows `orient` and CSS, rotation needs no reload.
   */
  let winW = 0, winH = 0;
  /** the stage's own size (phones: the credits corner measures from it, not from the window) */
  let stW = 0, stH = 0;
  $: phoneUi = phonePlayer({ coarse, tv: tvUi, kids: $kidsMode });
  $: orient = phoneOrient(winW, winH);
  $: toolF = { next: hasNext, episodes: Boolean(seriesId), tracks: Boolean(info || tvSession), speed: !partyMode };
  $: tools = phoneTools(orient, toolF);
  /** what More lists on top on the phone player (portrait: speed and next episode) */
  $: extras = phoneUi ? moreExtras(orient, toolF) : [];
  /** the speed button sits in the bar (desktop, phone player in landscape); otherwise speed is a sub-view of More */
  $: speedBtn = phoneUi ? tools.includes('speed') : !coarse;
  /** desktop: heights of the timeline row and the pill row (the skip button sits just above the timeline, not above the title) */
  let tlH = 0, rowH = 0, ttlH = 0;
  $: ccOn = phone && !phoneUi && showUi && !locked && !error && !reconnecting && !(posterOn && !posterOut);
  $: phoneChip = phone && Boolean(info && mode && !remote);
  /** height of the bottom bar: panels, the skip button and the page's cards sit above it (phones only; elsewhere the old fixed offsets apply) */
  $: barVar = (phone && ctlH ? `;--bar-h:${ctlH}px` : '') + (ctlH ? `;--ctl-h:${ctlH}px` : '')
    + ((desk || phoneUi) && tlH && rowH ? `;--tl-h:${tlH}px;--row-h:${rowH}px` : '') + (desk && ttlH ? `;--ttl-h:${ttlH}px` : '');
  // ---- desktop layout (spec 2026-11-08 §1–2): title block, timeline row with both times, two glass pills; never TV, phone or kids ----
  $: desk = deskPlayer({ desk: $deskActive, tv: tvUi, phone });
  /** desktop cards (not the bare episodes / scenes panels) are glass over video nobody sampled: the menu scrim (glass spec §5) */
  $: deskGlass = desk ? ' frost frost-menu frost-safe' : '';
  $: deskScrim = desk ? `--fr-scrim-safe:${SCRIM_MENU}` : undefined;
  /** glass blur only with full motion (calm mode, reduced motion or a tripped frame guard: plain fill) */
  const fullMotion = (_calm: unknown, _tripped: boolean) => motionLevel() === 'full'; // re-read when the prefs (calm mode) arrive or the frame guard trips
  $: blur = (desk || phoneUi) && fullMotion($prefs, $motionTripped);
  /** the card shown before the current one ('' = none was open): opening grows out of the button, switching crossfades */
  let menuWas = '', menuFrom = '';
  $: if (menu !== menuWas) { menuFrom = menuWas; menuWas = menu; }
  /** desktop and the phone player: cards grow in and fade out (never a cut); elsewhere they appear as before */
  $: cardMo = desk || phoneUi;
  function cardIn(node: Element, o: { origin: string }) {
    return cardMo && menuFrom !== '' ? fade(node, { duration: motionAllowed() ? 200 : 0 }) : grow(node, { origin: phoneUi ? panelOrigin(node) : o.origin, on: cardMo });
  }
  /** phone panels grow out of their button: the end corner (landscape) or the opener's x along the full-width card (portrait) */
  function panelOrigin(node: Element): string {
    const btn = stage?.querySelector<HTMLElement>('.ctl .pill [aria-expanded="true"]')?.getBoundingClientRect();
    const card = node.getBoundingClientRect();
    return growOrigin({ anchor: panelAnchor(orient, 'end'), btnX: btn ? btn.left + btn.width / 2 : card.right, left: card.left, width: card.width });
  }
  /**
   * Phone panels (spec 2026-11-08 §2) sit directly above the timeline row and below the top bar (`panelBox`). Measured on the stage
   * whenever the dock or the stage changes size (rotation, a wrapping pill row, the party's tools) and when a panel opens:
   * --pnl-b / --pnl-h (stage-relative), --pill-b / --pill-l / --pill-r (the tools pill is the menus' containing block).
   */
  let pnlVar = '', pnlObs: ResizeObserver | null = null;
  function measurePanel() {
    if (!phoneUi || !stage) { pnlVar = ''; return; }
    const s = stage.getBoundingClientRect();
    const tl = stage.querySelector('.ctl.dock .tlrow')?.getBoundingClientRect();
    if (!tl || !s.height) return;
    const top = stage.querySelector('.ovl')?.getBoundingClientRect();
    // the containing block is the pill's padding box (inside its 1 px border)
    const pillEl = stage.querySelector<HTMLElement>('.ctl.dock .pill.tp'), pr = pillEl?.getBoundingClientRect();
    const pill = pillEl && pr ? { left: pr.left + pillEl.clientLeft, right: pr.left + pillEl.clientLeft + pillEl.clientWidth, bottom: pr.top + pillEl.clientTop + pillEl.clientHeight } : null;
    const box = panelBox({ stageH: s.height, tlTop: tl.top - s.top, topBottom: top ? Math.max(0, top.bottom - s.top) : 0 });
    const r = (n: number) => Math.round(n * 10) / 10;
    pnlVar = `;--pnl-b:${r(box.bottom)}px;--pnl-h:${r(box.maxH)}px`
      + (pill ? `;--pill-b:${r(s.bottom - pill.bottom)}px;--pill-l:${r(pill.left - s.left)}px;--pill-r:${r(s.right - pill.right)}px` : '');
  }
  $: if (typeof window !== 'undefined') watchPanel(phoneUi, stage);
  function watchPanel(on: boolean, st: HTMLElement | null) {
    pnlObs?.disconnect(); pnlObs = null;
    if (!on || !st || typeof ResizeObserver === 'undefined') { pnlVar = ''; return; }
    pnlObs = new ResizeObserver(() => measurePanel());
    pnlObs.observe(st);
    void tickDom().then(() => { for (const el of st.querySelectorAll('.ctl.dock, .ctl.dock .row, .ovl')) pnlObs?.observe(el); measurePanel(); });
  }
  $: if (phoneUi && (menu !== '' || showXray || extPanel) && typeof window !== 'undefined') void tickDom().then(measurePanel);
  $: if (phoneUi && winW && winH) void tickDom().then(measurePanel);
  /** the open panel's history entry (phone player): Back closes it */
  let menuLayer: BackLayer | undefined;
  /** every panel closes (Back popped the panel's entry, or a tap outside on a phone) */
  function closePanels() { menu = ''; extPanel = false; if (xray) closeCastInfo(); }
  /** closes the panel and takes its history entry off first (before a navigation that replaces this entry: one Back still leaves) */
  async function leaveMenu(): Promise<void> {
    await menuLayer?.drop();
    menu = '';
  }
  const cardOut = (node: Element) => fade(node, { duration: cardMo && motionAllowed() ? 120 : 0 });
  let hud: { icon: string; text: string; pct: number } | null = null, hudT: ReturnType<typeof setTimeout>;
  let ripple: { zone: Zone; total: number; n: number } | null = null, rippleT: ReturnType<typeof setTimeout>;
  let help = false, live = '', liveN = 0;
  /** the bar hides after this long without input; the TV gets longer (moving along the bar with the D-pad takes time) */
  let hideMs = CONTROLS_HIDE_MS;
  // ---- TV (spec 4): own control layer, seek preview, overlays, pause screen. `tvUi` follows html.tv (set once /api/me answered) ----
  let tvUi = false, sp: SeekPreview = seekCancel(), spT: ReturnType<typeof setTimeout>, pausedAt = 0, wasPaused = true, skipFocused = -1;
  $: hideMs = tvUi ? CONTROLS_HIDE_TV_MS : CONTROLS_HIDE_MS; // the D-pad needs longer to reach a button than a mouse
  $: if (paused !== wasPaused) { wasPaused = paused; if (paused) pausedAt = Date.now(); }
  /** after 8 s paused without a key (TV, not in calm mode): dimmed picture + "You're watching" */
  $: pauseOn = tvUi && paused && started && !error && !remote && !locked && !reconnecting && menu === '' && !sp.active && !xray && !peek && !subDlg && !help && credits === 'off'
    && pauseScreenDue(pausedAt, lastActive, tick, $prefs.calm === true);
  $: tvButtons = tvPlayerButtons({ isEpisode: Boolean(seriesId), hasNext });
  $: tvSub = item?.seriesName && item.indexNumber !== undefined && item.indexNumber !== null
    ? $t('tv.player.episode', { s: item.parentIndexNumber ?? 1, e: item.indexNumber, name: item.name }) : barSub;
  /** desktop and phone pause screens (spec 2026-11-08 §3): 5 s after the pause or the last input, unless something else is on screen */
  $: pauseBlocked = ctlFocus || menu !== '' || playOnOpen || scrubbing || partyMode || remote || Boolean(error) || reconnecting > 0 || locked || help || subDlg || showXray || peek || credits !== 'off';
  $: deskPause = desk && paused && started && deskPauseDue({ pausedAt, lastActive, now: tick, blocked: pauseBlocked });
  $: phonePause = phoneUi && paused && started && deskPauseDue({ pausedAt, lastActive, now: tick, blocked: pauseBlocked || cardOn });
  $: phoneMotion = phoneUi && motionAllowed();
  $: deskMotion = desk && motionAllowed();
  /** credits glide: spring transform (desk / TV / phone with motion); a tripped frame guard (html.tv-motion-reduced) crossfades in CSS */
  $: credMotion = (desk || tvUi || phoneUi) && motionAllowed();
  /**
   * leaving the corner: for 300 ms `.credout` lets a tripped frame guard crossfade the picture back to full screen (CSS). Phones keep
   * it until the 750 ms spring has landed: in portrait the picture's box is cut to the picture while `.cred` / `.credout` holds.
   */
  let credOut = false, credWas: typeof credits = 'off', credOutT: ReturnType<typeof setTimeout> | undefined;
  /** the picture's aspect ratio (phones, portrait corner: the video box is cut to it, so the light edge frames the picture) */
  let picAspect = 16 / 9;
  /** a short landscape phone (under 360 px) during the credits chip: the chip rides above the dock where the title block sits - it fades */
  $: chipCrowds = credits === 'chip' && orient === 'landscape' && winH < 360;
  /**
   * phones, credits corner: --va the picture's aspect, --sw2 / --sh2 half the stage, --pw / --ph the letterboxed picture's box
   * (object-fit: contain) - the video box is cut to it, so the light edge frames the picture, not the black bars
   */
  $: picVar = phoneUi ? picVars(picAspect, stW || winW, stH || winH) : '';
  function picVars(va: number, w: number, h: number): string {
    const pw = Math.min(w, h * va), r = (n: number) => Math.round(n * 10) / 10;
    return `;--va:${va.toFixed(4)};--sw2:${r(w / 2)}px;--sh2:${r(h / 2)}px;--pw:${r(pw)}px;--ph:${r(pw / va)}px`;
  }
  $: credHold = menu !== '' || scrubbing || sp.active || subDlg || help || showXray || (paused && !stopped);
  $: onCreditsBeat(credits);
  function onCreditsBeat(c: typeof credits) {
    if (c === credWas) return;
    if (c === 'corner' && menu) menu = ''; // the bar hides: a menu still open (it held the chip until a moment ago) closes
    const left = credWas === 'corner';
    credWas = c;
    clearTimeout(credOutT);
    if (c === 'corner' && video?.videoWidth && video.videoHeight) picAspect = video.videoWidth / video.videoHeight;
    credOut = left;
    if (left) credOutT = setTimeout(() => (credOut = false), phoneUi ? 800 : 300);
  }
  // phones: an open panel (a menu, Cast & info, the party host's settings) keeps the controls up (spec 2026-11-08 §1)
  $: showUi = !locked && !pauseOn && !deskPause && !phonePause && credits !== 'corner' && (paused || aconn || ctlFocus || menu !== '' || playOnOpen || (phoneUi && (showXray || extPanel)) || scrubbing || sp.active || tick - lastActive < hideMs);
  // TV: a hidden bar keeps no focus - otherwise the next OK would press the last used button (subtitles ...) instead of play/pause
  $: if (!showUi && typeof document !== 'undefined' && tvMode() && stage?.querySelector('.ctl')?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  $: creditsAt = creditsStart(segments, duration);
  $: postplayAt = postplayStart(segments, chapters, duration);
  $: skip = segments.find((x) => x.type !== 'recap' && current >= x.start && current < x.end - 1) ?? null;
  $: shown = scrubbing ? scrubTime : current;
  $: pct = duration ? Math.min(100, (shown / duration) * 100) : 0;
  $: bufPct = duration ? Math.min(100, (buffered / duration) * 100) : 0;
  $: nowPlaying.set({ itemId, title, position: current, duration, paused, audio: info?.audioTracks.map((a) => ({ i: a.index, t: a.title })), audioSel: audioIndex ?? info?.audioTracks.find((a) => a.isDefault)?.index, subs: info?.subtitles.map((x) => ({ i: x.index, t: x.title })), subSel: subIndex }); // what the phone remote shows
  $: if (skip && skip.type === 'intro' && !partyMode && canControl && get(prefs).autoSkipIntro && !autoSkipped.has(skip.start)) { autoSkipped.add(skip.start); doSkip(); flash(tr('player.skipped.intro'), 1500); }
  type Seg = 'intro' | 'outro' | 'recap' | 'preview';
  const isSeg = (k: string): k is Seg => k === 'intro' || k === 'outro' || k === 'recap' || k === 'preview';
  const segKey = (k: string, kind: 'segment' | 'skip' | 'skipped'): TKey | null => (isSeg(k) ? `player.${kind}.${k}` : null);
  const segText = (tf: TFn, k: string, kind: 'segment' | 'skip' | 'skipped'): string => { const key = segKey(k, kind); return key ? tf(key) : k; };

  // lib/player/reportbody.ts: the armed AirPlay token's play session, `via: 'airplay'` only while the TV plays it (airOn)
  // (a single token a joined re-mint got for another episode is reported as that episode)
  const body = () => playerReportBody({
    itemId: airInfo && airEp ? airEp.itemId : itemId, local: info!, air: airInfo, airOn, position: !airInfo && swapping ? lastPos : video?.currentTime ?? 0, paused: video?.paused ?? false,
    audioIndex, direct: mode === 'direct',
  });
  let lastSent = 0;
  /** the latest stop report (also one sent earlier, e.g. at the end of the film): leaving the player holds prefetches on it */
  let lastStop: unknown;
  const send = (kind: 'start' | 'progress' | 'stop', keepalive = false) => {
    if (kind === 'stop') reportTiming();
    if (handedOff) return undefined; // the cast engine reports for the handed-over session
    if (airInfo?.joined) return undefined; // a joined AirPlay token: the server reports per episode (a page report would stop episode 1 at the wrong position)
    if (swapping && kind === 'progress') return undefined; // the fresh element is still on its way to the position
    lastSent = Date.now();
    const r = report && info && api(`/api/playback/${kind}`, { method: 'POST', body: body(), keepalive }).catch(() => undefined);
    if (kind === 'stop') lastStop = r;
    return r;
  };

  // ---- start-time measurement per playback session (lib/player/timing.ts): sent once on stop / pagehide / end; never in a
  //      watch party, while casting / AirPlay or for a stream handed to the cast engine (offline playback has its own player) ----
  const timing = createTiming();
  /** dropped / total frames of the element right now (the timing keeps them across element / stream restarts) */
  function sampleFrames() {
    try { const q = video?.getVideoPlaybackQuality?.(); if (q) timing.frames(q.droppedVideoFrames, q.totalVideoFrames); } catch { /* not supported */ }
  }
  function reportTiming() {
    try {
      sampleFrames();
      timing.sound(fxToPref(fx), Boolean(fxEngine?.routed));
      const r = timing.finish({ device: deviceClass({ coarse, tv: tvMode() }), effectiveType: effectiveType(navigator) });
      if (r && !partyMode && !remote && !handedOff && !airInfo && !airOn) sendTiming(r, { csrf: getCsrf(), profile: getActiveProfile() });
    } catch { /* measuring must never break playback */ }
  }

  /**
   * A/V-sync telemetry: a few seconds into an HLS session, ask the server once whether it copies the video of this play session
   * (remux) or converts it; the answer only goes into this session's anonymous timing report.
   */
  const STREAM_PROBE_MS = 4000;
  let probeT: ReturnType<typeof setTimeout> | undefined, probedPs = '', trackSwitching = false;
  function probeStream() {
    const ps = info?.playSessionId;
    if (!ps || probedPs === ps || mode !== 'hls' || !timing.active || partyMode || remote || airOn || airInfo || handedOff) return;
    probedPs = ps;
    clearTimeout(probeT);
    probeT = setTimeout(() => {
      if (info?.playSessionId !== ps || !timing.active) return;
      api<{ videoDirect?: boolean | null } | null>(`/api/playback/stream?ps=${encodeURIComponent(ps)}`)
        .then((r) => { if (info?.playSessionId === ps && typeof r?.videoDirect === 'boolean') timing.stream({ videoCopy: r.videoDirect }); })
        .catch(() => undefined);
    }, STREAM_PROBE_MS);
  }

  // ---- per-series audio / subtitle choice ("anime pack"): remembered per profile, applied before the global defaults ----
  let serPref: { audio: string | null; subtitle: string | null } = { audio: null, subtitle: null }, serPrefDone = false;
  /** "Anime: Originalton mit Untertiteln": this anime series has no own choice yet -> Japanese audio + subtitles in the UI language */
  let animeDefault = false;
  /** first start of an episode: look the saved choice up (an episode id resolves to its series server-side); never delays playback for long */
  async function loadSerPref() {
    if (serPrefDone || partyMode || isMovie) return;
    serPrefDone = true;
    try {
      const want = get(prefs).animeOriginal;
      const r = await Promise.race([api<typeof serPref & { anime?: boolean }>(`/api/series/${seriesId || itemId}/langpref${want ? '?anime=1' : ''}`), new Promise<never>((_, no) => setTimeout(no, 800))]);
      serPref = { audio: r.audio, subtitle: r.subtitle };
      animeDefault = animeDefaultApplies(want, r.anime, serPref);
    } catch { /* no saved choice */ }
  }
  function rememberLang(p: { audio?: string; subtitle?: string }) {
    if (!seriesId || partyMode) return;
    serPref = { ...serPref, ...p };
    api(`/api/series/${seriesId}/langpref`, { method: 'PUT', body: p }).then(() => flash(tr('player.langSaved'), 1400)).catch(() => undefined);
  }

  /** the fields every later step relies on (a 204 parses to null) */
  const validInfo = (x: unknown): x is Info => {
    const i = x as Partial<Info> | null;
    return Boolean(i && typeof i.playSessionId === 'string' && typeof i.resumeTicks === 'number' && Array.isArray(i.audioTracks) && Array.isArray(i.subtitles) && (i.directUrl || i.hlsUrl));
  };
  let cancelFirstFrame = () => {};
  // ---- next episode (autoplay countdown): the body its player will send first; same series, so the same audio choice applies ----
  let preparedFor: string | null = null;
  $: syncNext(prepNext);
  function syncNext(id: string | null) {
    if (id && id !== preparedFor && !partyMode && !remote) {
      preparedFor = id;
      prepareNext(id, firstPlaybackRequest(id, get(prefs), wantAudio || serPref.audio || animeAudio(animeDefault)).body, { warm: true });
    } else if (!id && preparedFor) { preparedFor = null; releaseNext(); }
  }
  /** the last request carried a block this browser / Samsung TV probed itself: its direct plays are watched and a failure is remembered */
  let probedCaps = false;
  /** set by the one automatic fallback: the next request says what was given up and which play session failed (consumed by that request) */
  let pendingFallback: { what: AvoidWhat; prevPs: string } | null = null;
  /** the fallback's reload re-starts the timing session like a quality switch (flagged, never a second start: "avoided < 2 % of starts" stays honest) */
  let fallbackRestart = false;
  const isBusy = (e: unknown) => e instanceof ApiError && e.status === 503 && (e.body as { error?: unknown } | null)?.error === 'server_busy';
  /**
   * `restore`: a switch (a quality pick, a track, surround) stopped the old session before asking; when the server is busy the previous
   * choice is put back and that stream is asked for again at the same position (its slot was just freed); the toast says so once that
   * stream is given. A second refusal shows the busy state alone. An ABR step-down passes none (its old rung stalled).
   */
  async function load(startSec?: number, restore?: { undo: () => void; toast: string }): Promise<'busy' | undefined> {
    cancelFirstFrame();
    error = ''; errNote = '';
    // a retry / track reload continues the running session (its clock keeps going); a quality switch starts a new one, flagged
    if (!timing.active && !partyMode && !remote) timing.begin(switching || fallbackRestart, trackSwitching);
    fallbackRestart = false;
    if (startSec !== undefined) { lastPos = startSec; posKnown = true; }
    // first start: the saved quality + audio language go into this same request (no second round trip)
    const first = !prefsApplied && !partyMode;
    if (first) await loadSerPref();
    // the first body is built like the play buttons' prefetch builds it (lib/player/infobody.ts), so that answer can be reused
    if (first) remeasureOutput(); // the output may have changed since the last film (devicechange is not reliable without media permissions)
    const fr = first ? firstPlaybackRequest(itemId, get(prefs), wantAudio || serPref.audio || animeAudio(animeDefault), startSec) : null;
    if (fr?.quality && !quality) quality = fr.quality;
    const audioLang = fr?.body.audioLang;
    if (first) reqHint = quality ? 'manual' : 'network'; // a saved quality is a pick, otherwise the network chooses
    const sentBps = wantBps();
    // first start: the device's decode probe (bounded) answers first, so this body equals the play button's prefetch body
    if (first) { const w = capsPending(); if (w) await w; }
    const fell = pendingFallback; pendingFallback = null;
    // no ABR yet, no saved quality and nothing measured: the 720p start is a guess (the server keeps the copy fallback for it)
    const startRung = !abr && reqHint === 'network' && noEstimateStart(quality, loadStoredEstimate());
    const body: InfoBody = playbackInfoBody({ itemId, startSec, audioIndex, bps: sentBps, hint: reqHint, audioLang, caps: appCaps(), fellBack: fell?.what, prevPs: fell?.prevPs, startRung });
    probedCaps = isProbedBlock(body.caps);
    const ask = () => api<Info | null>('/api/playback/info', { method: 'POST', body });
    // the next episode prepared during the countdown, else a hovered/focused play button: its request is (usually) already answered;
    // a failed prefetch is simply asked again
    const fromNext = first ? takeNext(itemId, body) : null;
    if (fromNext) timing.next();
    const pre = fromNext ?? (first ? takePrefetched(itemId, body) : null);
    try {
      const got = await (pre ? pre.catch((e) => (isBusy(e) ? Promise.reject(e) : ask())) : ask()); // a busy prefetch is not asked again at once
      // an empty/foreign answer (204, proxy page ...) has no playback session: show the error instead of crashing on it
      if (!validInfo(got)) throw new ApiError(502, null);
      info = got;
      timing.info(sentBps);
    } catch (e: any) {
      // the conversion budget is full and this title needs a conversion (spec §5.5): no backoff (a spinner or a retry loop would only add
      // load); the viewer retries when they like. The old stream (a switch stopped its session) is quiet: it can never start a silent retry.
      if (isBusy(e)) {
        clearTimeout(retryT); reconnecting = 0; hls?.stopLoad();
        pendingFallback = fell; // a retry after a codec fallback still names what failed
        if (restore) {
          restore.undo();
          // the toast only when the old choice really plays again: a second refusal shows the busy state alone (no toast, then a dialog)
          const again = await load(startSec);
          if (again !== 'busy') flash(restore.toast, 3000);
          return again;
        }
        waiting = false; video?.pause(); errNote = '';
        errTitle = tr('player.error.title'); error = tr('player.error.serverBusy');
        return 'busy';
      }
      if (!(e instanceof ApiError) || e.status >= 500) { recover('network', true); return; } // server/network hiccup: retry with backoff
      reconnecting = 0;
      errNote = e?.body?.error === 'max_streams' ? tr('player.error.maxStreams', { n: Number(e.body.max) }) : '';
      errTitle = tr('player.error.title'); error = tr('player.error.generic');
      return;
    }
    if (startSec === undefined) { lastPos = info.resumeTicks / 10_000_000; posKnown = true; } // a retry must not restart at 0 before playback ran
    if (info.audioIndex !== undefined) audioIndex = info.audioIndex;
    if (first && quality && info.roleMaxBitrate && quality >= info.roleMaxBitrate) quality = 0; // saved quality above the role limit = "Automatisch"
    if (!abr) { abr = makeAbr(sentBps, quality || undefined); shownQ = quality; }
    // first start only: an older server ignores audioLang -> pick the track here (one extra request, as before)
    if (first) {
      prefsApplied = true;
      const wantTrack = audioLang ? info.audioTracks.find((a) => a.language === audioLang) : undefined;
      if (wantTrack && !wantTrack.isDefault && audioIndex === undefined) { audioIndex = wantTrack.index; return load(startSec); }
    }
    void attach(startSec ?? info.resumeTicks / 10_000_000);
  }

  let attachSeq = 0;
  /** `swap`: the same stream again on a fresh element (restorePlain): no new start, no reports, the viewer's tracks stay */
  async function attach(startSec: number, swap = false) {
    if (!video || destroyed || !info || airInfo || handedOff) return; // AirPlay plays its own token stream
    const my = ++attachSeq, cur = info;
    sampleFrames(); // the counters restart with the new stream
    if (!swap) { sessionPlaying = false; resetStall(); } // the first buffering of each stream is a start, not a stall
    hls?.destroy(); hls = null;
    cancelFirstFrame();
    // sound modes off but the sound still runs through Web Audio (extra latency): the new stream starts on a fresh element
    if (plainPathDue(Boolean(fxEngine?.routed), fx) && !air) {
      await freshVideo();
      if (my !== attachSeq || info !== cur || !video) return;
    }
    const useDirect = info.directUrl && audioIndex === undefined && !rec.forcedHls && video.canPlayType('video/mp4');
    mode = useDirect ? 'direct' : 'hls';
    if (!swap) {
      timing.mode(useDirect ? 'direct' : 'hls');
      const dl = info.delivery;
      timing.stream({ reason: info.transcodeReason ?? null, ...(dl && !useDirect ? { videoCopy: dl.video === 'copy', out: { video: dl.video, videoCodec: dl.videoCodec, audio: dl.audio, audioCodec: dl.audioCodec, channels: dl.channels, why: clientWhy(dl.why, playerCapsSummary()) } } : {}) });
    }
    const el = video;
    const seek = () => { if (startSec > 1 && !destroyed && video === el) el.currentTime = startSec; }; // the page may be gone (Back before the first frame) or the element swapped
    // hls.js is loaded lazily, only on this path (and usually already prefetched by the play button)
    let H: typeof Hls | null = null;
    if (!useDirect) {
      try { H = await loadHls(); } catch { H = null; }
      if (my !== attachSeq || info !== cur || !video) return; // superseded while loading
    }
    if (useDirect) {
      video.src = info.directUrl!;
      video.addEventListener('loadedmetadata', seek, { once: true });
      // LG: an original the TV cannot decode may stay black without an error; no picture in time -> the converted stream, once
      if ((isTvApp() || probedCaps) && !rec.forcedHls && !swap) cancelFirstFrame = watchFirstFrame(video, firstFrameMs(), () => { if (my === attachSeq && !rec.forcedHls && !error && !reconnecting && !handedOff && !remote && !airOn) forceHls(resumePos(), true); }, { running: wantAutoplay });
    } else if (H?.isSupported()) {
      const HC = H;
      hls = new HC(hlsConfig(startSec));
      hls.loadSource(info.hlsUrl);
      hls.attachMedia(video);
      hls.on(HC.Events.LEVEL_LOADED, (_e, d) => timing.manifest(d.details.targetduration)); // the variant playlist: the last step before the first fragment
      hls.on(HC.Events.FRAG_LOADED, (_e, d) => {
        const st = d.frag.stats, dl = st.loading.end - st.loading.start;
        est.add(st.loaded, dl);
        if (d.frag.type === 'main' && d.frag.sn !== 'initSegment') timing.frag(st.loaded, dl);
      });
      // Jellyfin adds SDR variants at the same bandwidth when it copies HDR video: with a plan, the player pins the variant it was promised
      if (cur.delivery) hls.on(HC.Events.MANIFEST_PARSED, (_e, d) => {
        const i = pickLockedLevel(d.levels, cur.delivery?.videoCodec === 'hevc');
        if (i >= 0 && hls) hls.currentLevel = i;
      });
      hls.on(HC.Events.ERROR, (_e, d) => {
        // a codec the device cannot append (bufferAddCodecError is not fatal in hls.js) in an HEVC / surround stream: give that up at once
        const codec = isCodecError(d.details) && mode === 'hls' && (activeFeatures().hevc || activeFeatures().surround);
        if (!d.fatal && !codec) return;
        lastErrCode = String(d.details || d.type || 'hls');
        const kind: ErrorKind = d.type === HC.ErrorTypes.NETWORK_ERROR ? 'network' : d.type === HC.ErrorTypes.MEDIA_ERROR ? 'media' : 'other';
        recover(kind, false, codec ? { what: avoidTarget(d as { sourceBufferName?: string; mimeType?: string }, activeFeatures()) } : undefined);
      });
    } else if (!H && !video.canPlayType('application/vnd.apple.mpegurl')) {
      recover('network', true); // hls.js could not be loaded (offline): retry like a network error
      return;
    } else {
      if (video.disableRemotePlayback) video.disableRemotePlayback = false; // set by an earlier hls.js ManagedMediaSource attach; it would block AirPlay
      video.src = info.hlsUrl; // Safari: native HLS
      video.addEventListener('loadedmetadata', seek, { once: true });
      video.addEventListener('loadedmetadata', () => timing.manifest(), { once: true }); // native: no playlist events, the metadata is the closest
    }
    // an HEVC stream that shows no picture in time (the decoder accepted it, then nothing): the same one-time fallback as a codec error
    // The clock starts at the metadata (the init segment and first data arrived), so a slow server, a conversion that is still starting
    // or a slow line is never taken for an undecodable picture (that is the network path's job). Also after the fallback of the other feature.
    if (!useDirect && !swap && cur.delivery?.videoCodec === 'hevc') {
      const v = video;
      const arm = () => {
        if (my !== attachSeq || !video || v.readyState >= 2) return; // already showing a frame
        cancelFirstFrame = watchFirstFrame(v, firstFrameMs(), () => {
          if (my === attachSeq && !error && !reconnecting && !handedOff && !remote && !airOn && v.readyState >= 1 && mode === 'hls') recover('media', false, { what: 'hevc' });
        }, { running: wantAutoplay });
      };
      if (v.readyState >= 1) arm();
      else { v.addEventListener('loadedmetadata', arm, { once: true }); cancelFirstFrame = () => v.removeEventListener('loadedmetadata', arm); }
    }
    if (swap) { const keep = subIndex; tickDom().then(() => { if (my === attachSeq) setSubtitle(keep, false); }); return; }
    stopped = false; started = false;
    dispatch('ready', { info });
    // detail-page pick > this series' saved choice (when the episode has that language) > my global default
    const sp = serPref.subtitle;
    // anime default: subtitles in the UI language, but only while the Japanese track plays (a dub-only release keeps my defaults)
    const playingAudio = info.audioTracks.find((a) => a.index === audioIndex) ?? info.audioTracks.find((a) => a.isDefault);
    const anime = animeDefault && !wantAudio ? animeSubtitle(getLocale(), playingAudio?.language, info.subtitles) : null;
    const want = wantSub === 'off' ? '' : wantSub || (sp === 'off' ? '' : sp && info.subtitles.some((x) => x.language === sp) ? sp : anime || get(prefs).subtitleLang);
    if (want && !partyMode) tickDom().then(() => { const sub = info?.subtitles.find((x) => (x as { language?: string }).language === want); if (sub) setSubtitle(sub.index, false); });
  }

  // ---- error recovery: network = 3 retries with backoff at the last position; decode error = recoverMediaError once, then transcode / lower quality ----
  const resumePos = () => Math.max(lastPos, video && video.currentTime > 0 ? video.currentTime : 0);
  const lowerStep = () => lowerQuality(QUALITIES.map(([, b]) => b).filter((b) => b < (info?.roleMaxBitrate ?? Infinity)), quality, info?.maxBitrate ?? 0);
  let retryViaLoad = false;
  /** keepIntent: the first-frame watcher fires before `canplay` ever came (the element is still paused), so a pending play intent survives the switch */
  function forceHls(pos: number, keepIntent = false) {
    // a probed claim did not hold (devicecaps.ts isFormatFailure: a decode error, or metadata but no picture; an HTTP error or a slow
    // line before any metadata is not the format): this retry is HLS (H.264), later starts of this device send no block for 7 days
    if (mode === 'direct' && probedCaps && isFormatFailure({ watchdog: keepIntent, code: video?.error?.code, readyState: video?.readyState ?? 0 })) noteDirectFailure();
    rec.forcedHls = true; errPos = pos; flash(tr('player.switchingTranscode'), 2500); wantAutoplay = keepIntent ? wantAutoplay || !paused : !paused; void load(pos); }
  /** what the current HLS stream carries that can still be given up: an HEVC picture, 5.1 sound */
  const activeFeatures = () => ({ hevc: info?.delivery?.videoCodec === 'hevc', surround: (info?.delivery?.channels ?? 2) > 2 });
  const avoidable = () => mode === 'hls' && !rec.avoided && (activeFeatures().hevc || activeFeatures().surround);
  /** the one automatic fallback of a session: ask again without HEVC / surround at the same position (remembered per device for 30 days) */
  async function avoidStream(pos: number, what: AvoidWhat) {
    rec.avoided = true; errPos = pos;
    noteHlsFailure(what);
    pendingFallback = { what, prevPs: info?.playSessionId ?? '' };
    hls?.destroy(); hls = null; // late errors of the old stream must not start a second recovery
    flash(tr('player.switchingCompatible'), 2500);
    wantAutoplay = !paused || wantAutoplay;
    fallbackRestart = true; // the stop below ends the failed session's timing; the reload continues it as a flagged re-start
    if (started && !stopped) { stopped = true; await send('stop'); } // frees the failed stream's slot and its conversion job
    void load(pos);
  }
  function recover(kind: ErrorKind, viaLoad = false, codec?: { what: AvoidWhat }) {
    if (handedOff || airOn || airInfo || airState.busy) return;
    timing.reconnect();
    retryViaLoad = viaLoad;
    cancelFirstFrame();
    // the first retry already failed: the line is the problem, not a hiccup -> a lower rung (none = cooldown or 360p: the usual retries go on and end in giveUp)
    if (kind === 'network' && !viaLoad && abr && !switching && rec.networkTries >= 1) {
      const nd = abr.onNetworkError(), step = networkStep(nd);
      if (step === 'switch') { applyAbr(nd); return; }
      if (step === 'giveup') { giveUp(); return; }
      // cooldown: the same rung again after a pause; this does not use up the retry budget
      const p = resumePos(); errPos = p; waiting = true; reconnecting = Math.max(1, reconnecting);
      clearTimeout(retryT); retryT = setTimeout(() => retryNow(p), COOLDOWN_RETRY_MS);
      return;
    }
    const pos = resumePos();
    const d = decideRecovery(kind, rec, { isHls: Boolean(hls), canLowerQuality: lowerStep() !== null, avoidable: avoidable(), codecError: Boolean(codec) });
    if (d.do === 'retry') {
      rec.networkTries = d.attempt; reconnecting = d.attempt; errPos = pos; waiting = true;
      clearTimeout(retryT); retryT = setTimeout(() => retryNow(pos), d.delay);
    } else if (d.do === 'recover-media') { rec.mediaRecovered = true; errPos = pos; hls?.recoverMediaError(); }
    else if (d.do === 'avoid') void avoidStream(pos, codec?.what ?? avoidTarget({}, activeFeatures()));
    else if (d.do === 'force-hls') forceHls(pos);
    else if (d.do === 'lower-quality') { rec.loweredQuality = true; errPos = pos; const q = lowerStep(); if (q) { wantAutoplay = !paused; abr = makeAbr(q, quality ? q : undefined); void changeQuality(q, 'abr', 3000, tr('player.quality.stepDown', { q: rungLabel(q) })); } else giveUp(); }
    else giveUp();
  }
  function giveUp() { cancelFirstFrame(); clearTimeout(retryT); reconnecting = 0; waiting = false; errTitle = tr('player.error.title'); error = errNote || tr('player.error.connection'); hls?.stopLoad(); reportFatal(); }
  // Block 22: a playback that ends in an error is reported once per play session (admin health page, grouped by title)
  let lastErrCode = '', reportedFor = '';
  function reportFatal() {
    const ps = info?.playSessionId ?? '';
    if (!ps || reportedFor === ps) return;
    reportedFor = ps;
    reportPlayback(itemId, lastErrCode || 'unknown');
  }
  function retryNow(pos: number) {
    clearTimeout(retryT);
    if (!reconnecting) return;
    wantAutoplay = !paused || wantAutoplay;
    if (hls && !retryViaLoad && reconnecting < MAX_NETWORK_TRIES) { if (hls.levels.length) hls.startLoad(pos); else if (info) hls.loadSource(info.hlsUrl); } // 1st/2nd retry: restart loading (or the manifest request)
    else void load(posKnown ? pos : undefined); // last retry (or direct play): new playback session, the old token may be dead
  }
  function retryManually() { rec = { ...freshRecovery(), avoided: rec.avoided }; reconnecting = 0; error = ''; errNote = ''; waiting = true; wantAutoplay = true; void load(posKnown ? resumePos() : undefined); }
  function leave() { if (history.length > 1) history.back(); else location.href = '/'; }
  function onVideoError() {
    postFireTv('keepAwake:0');
    if (handedOff) return; // the engine's element: its controller handles errors
    if (airState.ready && !airOn) { if (video?.error && video.error.code !== 1) air?.videoError(video.error.code, video.error.message); return; } // the phone plays the AirPlay token stream: back to normal
    if (airOn) { if (video?.error && video.error.code !== 1) air?.videoError(video.error.code, video.error.message); return; } // the TV's token stream failed: Retry, never the cookie URL
    if (hls || !video?.error || !info) return; // hls.js reports its own errors
    const kind = kindOfMediaError(video.error.code);
    if (video.error.code === 1) return; // aborted by us
    lastErrCode = `media_err_${video.error.code}`;
    recover(kind, false, kind === 'media' && avoidable() && isNativeCodecFailure({ code: video.error.code, readyState: video.readyState }) ? { what: avoidTarget({}, activeFeatures()) } : undefined); // native HLS (Safari): no codec details, a media error in an HEVC / surround stream
  }
  /** waiting -> start timing; playing -> the stall is over. Seeks and the first buffering after a (re)start are no stalls. */
  function onWaiting() {
    if (handedOff || swapping) return;
    waiting = true;
    timing.waiting(video?.seeking ?? false);
    if (!video || airOn || !started || stopped || !sessionPlaying || video.seeking || waitSince) return;
    waitSince = performance.now(); stallHandled = false;
    clearTimeout(stallT); stallT = setTimeout(() => { if (waitSince) { stallHandled = true; onStall(performance.now() - waitSince); } }, STALL_NOW_MS);
  }
  function resetStall() { clearTimeout(stallT); waitSince = 0; stallHandled = false; }
  function onStall(ms: number) {
    if (!abr || handedOff || airOn || airInfo || switching || reconnecting || error) return;
    applyAbr(abr.onStall(ms)); // 'fail' needs nothing here: a stall at the lowest rung just keeps buffering
  }
  /** Fire TV keep-awake: `playing` turns it on; pause, end, a media error, an error screen and unmount turn it off (no-op elsewhere) */
  $: if (error) postFireTv('keepAwake:0');
  /** the next pause event comes from pauseWhenHidden (no second progress report) */
  let hiddenPause = false;
  function onPlaying() {
    if (handedOff) return;
    postFireTv('keepAwake:1'); // the Fire TV app keeps the screen on while a picture plays (no-op elsewhere)
    waiting = false; sessionPlaying = true; firstFrame(); timing.playing(); probeStream();
    if (waitSince) { const ms = performance.now() - waitSince, done = stallHandled; resetStall(); if (!done && ms > 0) onStall(ms); }
    if (reconnecting) { reconnecting = 0; flash(tr('player.reconnected'), 1500); }
  }

  // ---- Chromecast session lifecycle ----
  const castErr = (e: any) => e?.body?.error === 'max_streams' ? tr('player.error.maxStreams', { n: Number(e.body.max) })
    : e?.body?.error === 'server_busy' ? tr('player.error.serverBusy')
    : e?.body?.error === 'cast_forbidden' ? tr('ui.error.castForbidden') // the right was switched off meanwhile: said once, no retry
    : e?.body?.error === 'transcoding_disabled' ? tr('player.cast.needsTranscode') : tr('player.cast.failed');
  // (FriendFlix's own receiver is given a moment to state what it plays first: castCapsReady; `again` names the stream the TV just refused)
  // `joined`: a new token for the joined AirPlay stream on the element starts with that episode (`pos` = the offset in it), §5.4 f
  const castRequest = async (pos: number, via?: 'airplay', again?: { fellBack: 'hevc' | 'surround' | 'both'; prevPs: string }, extra: { subtitleIndex?: number } = {}, joined?: { itemId: string; left: number }) => {
    if (via !== 'airplay') await castCapsReady();
    // another episode than this page's: the track indices are this page's, the server maps them to that episode's tracks by language
    const other = joined && joined.itemId !== itemId ? { tracksOf: itemId } : {};
    const body = castBody({ itemId: joined?.itemId ?? itemId, startTicks: secToTicks(pos), audioIndex, maxBitrate: quality || undefined, via, ...(again ?? {}), ...extra, ...other });
    if (via !== 'airplay') return api<CastInfo>('/api/cast/session', { method: 'POST', body });
    // AirPlay: one joined stream for this and the next episodes while the admin switch is on (no sheet row; the profile's autoplay decides);
    // a re-mint of a joined stream never asks for more episodes than that stream had left (one left: a plain token)
    if (joined && joined.left < 2) return postAirPlayToken(body);
    const pf = get(prefs), most = episodesBeforeAsk(pf);
    return postAirPlayToken({ ...body, ...continuousFields({ episode: Boolean(seriesId), autoplay: pf.autoplayNext, sleepAfter: sleepAfterEpisode, maxEpisodes: joined ? Math.min(joined.left, most) : most }) });
  };
  const castRevoke = (ci: CastInfo | null) => { if (ci) api(`/api/cast/session/${ci.castId}`, { method: 'DELETE' }).catch(() => undefined); };

  /** what the cast engine needs to own this title's cast session */
  const handoff = (pos: number, dur: number, isPaused: boolean) => ({
    itemId, seriesId: seriesId || undefined, title: barTitle || title, subtitle: barSub, isEpisode: Boolean(seriesId),
    position: pos, duration: dur, paused: isPaused, audioIndex, subIndex, maxBitrate: quality || undefined, sleepAfterEpisode,
    audioTracks: info?.audioTracks.map(({ index, title, language, isDefault }) => ({ index, title, language, isDefault })),
    subtitles: info?.subtitles.map(({ index, title, language }) => ({ index, title, language })),
  });
  /** from now on the engine owns the session: nothing is reported, revoked or stopped from here (also not after unmount) */
  function handedOver() {
    handedOff = true; remote = true;
    started = true; stopped = true; // the Player's own session already reported its stop
    clearTimeout(retryT); reconnecting = 0; resetStall();
  }

  /** local playback -> receiver: reports the local stop, frees the stream slot, asks for a cast token, loads it, hands it to the engine */
  async function startCast() {
    if (partyMode || remote || castBusy || !$castState.connected) return;
    castBusy = true;
    const pos = video?.currentTime ?? 0;
    if (started && !stopped) { stopped = true; await send('stop'); }
    video?.pause(); hls?.destroy(); hls = null; waiting = true;
    let ci: CastInfo | null = null;
    try {
      ci = await castRequest(pos);
      if (!(await loadOnCast(ci, subIndex))) {
        // FriendFlix's own receiver refused a HEVC / surround stream: remembered for this TV, and one more cast without it
        const fb = castFellBack(ci);
        if (!fb) throw new Error('load');
        castRevoke(ci);
        flash(tr('player.switchingCompatible'), 2500);
        const prev = ci;
        ci = null;
        ci = await castRequest(pos, undefined, { fellBack: fb, prevPs: prev.playSessionId });
        if (!(await loadOnCast(ci, subIndex))) throw new Error('load');
      }
    } catch (e) {
      castRevoke(ci);
      castBusy = false;
      if (destroyed) return;
      // the receiver did not take it: local playback at the position
      flash(castErr(e), 4000);
      started = false; stopped = false; wantAutoplay = true;
      await load(pos);
      return;
    }
    castBusy = false;
    // the Player never reported `start` for a Chromecast token: the engine does once the receiver plays
    castEngine.adopt({ kind: 'chromecast', ...handoff(pos, ci.runtimeTicks ? ticksToSec(ci.runtimeTicks) : duration, false), cast: ci, started: false });
    handedOver();
  }
  /** the engine owns Chromecast session end / media end; a picked device starts a cast unless one is already handed over */
  function handleCast(e: CastEvent) {
    if (e === 'session-start' && !remote) void startCast();
  }

  /** the AirPlay route plays our token on the TV: element, controller and probe go to the engine */
  function handOverAirPlay() {
    const v = video, ctl = air, ci = airInfo, ep = airEp;
    if (!v || !ctl || !ci || partyMode) return;
    // a re-mint of a joined stream gave a single token for a later episode (switch off meanwhile): the engine is told that episode
    const other = !ci.joined && ep && ep.itemId !== itemId ? { itemId: ep.itemId, subtitle: episodeOf(barTitle || title, ep).sub } : {};
    // `start` was reported for this token exactly when the element played it here (the phone's token stream / the TV); a joined
    // token never (the server reports it per episode); its position is on the stream, the engine maps it and takes its length
    // (the track indices are this page's item's: the engine maps them when the token is another episode's)
    castEngine.adopt({ kind: 'airplay', ...handoff(v.currentTime, duration, v.paused), ...other, tracksOf: itemId, cast: ci, subIndex: ci.hlsSub ? airSubAsked : -1, started: started && !stopped && !ci.joined, video: v, air: ctl, probe: airProbe });
    handedOver();
    air = null; airProbe = null; airInfo = null; airState = AIR_IDLE;
  }

  /**
   * Opening a title while a cast runs: this Player becomes the remote of the engine's session instead of playing itself
   * (no playback info, no AirPlay controller, no own token; a local stream would be a second one). The same title is only
   * moved to `startAt`; another title plays on the TV (`playOnTv`). Party mode never attaches. Without playback info the tracks
   * menu lists the session's tracks (`castSession`); "change device" opens the engine's AirPlay picker (`castEngine.pick`).
   */
  function attachToCast(): boolean {
    const s = get(castSession);
    // a detached cast (known only from the hint) has no remote: this page plays by itself, the bar offers Reconnect
    if (partyMode || !s || s.state === 'detached') return false;
    handedOver();
    if (s.itemId !== itemId) void castEngine.playOnTv(itemId, startAt);
    else if (startAt !== undefined) castEngine.seek(startAt);
    followTv(get(castSession));
    return true;
  }

  /** "change device": the system picker of the controller the engine owns (from the tap); a lost route: the engine reconnects */
  function changeAirPlay() { if ($castSession?.state === 'reconnect') castEngine.reconnect(); else castEngine.pick(); }
  // ---- "Play on" (lib/cast/PlayOnSheet.svelte): the one entry for Chromecast, AirPlay and this device; the remote screen's device chip opens it too ----
  let playOnOpen = false, playOnTrigger: HTMLElement | null = null;
  function openPlayOn(el?: HTMLElement | null) { menu = ''; playOnTrigger = el ?? (document.activeElement as HTMLElement | null); playOnOpen = true; wake(); }
  /** "Continue here": the cast stopped and the page plays on; the focus goes to the player instead of the body */
  function onContinued() {
    playOnOpen = false; wake();
    let tries = 0;
    const land = () => {
      const el = stage?.querySelector<HTMLElement>('[data-testid="playon"], .ctl button, .ovl button');
      if (el) { el.focus({ preventScroll: true }); return; }
      if (++tries < 30 && !destroyed) setTimeout(land, 50); else if (stage) { stage.tabIndex = -1; stage.focus({ preventScroll: true }); }
    };
    void tickDom().then(land);
  }
  /** the AirPlay row: the token-then-picker flow of the controller (the engine's picker while AirPlay already casts) */
  function airRow() { if (tvSession?.kind === 'airplay') changeAirPlay(); else air?.pick(); }
  $: airAvail = Boolean(air && (airState.available || airOn || airState.ready || airState.busy)) || tvSession?.kind === 'airplay';
  /** something to choose from: Cast devices in reach or an AirPlay target (the remote screen has its own chip) */
  $: playOnShown = $perms.cast && !partyMode && !remote && (Boolean($castState.available || $castState.connected) || airAvail);
  $: playOnLabel = $t('player.castPicker.open');
  $: playOnEp = item?.type === 'Episode' || item?.seriesId ? episodeCode({ subtitle: '' }, item, $t) : '';

  // ---- the cast screen (remote): lib/cast/RemoteScreen.svelte (it reads the engine's session; the Player keeps the page's side of it) ----

  /** while this Player is still mounted: mirror the engine's session; a lost / failed one plays on locally */
  let lastTv: CastSession | null = null;
  /** the AirPlay route still pointed at the TV when the engine's session was last seen (nobody ended it in the picker) */
  let lastRouteOn = false;
  function followTv(s: CastSession | null) {
    if (!remote || destroyed) return;
    if (!s) { void resumeLocal(); return; }
    current = s.position; if (s.duration) duration = s.duration;
    paused = s.paused; waiting = s.buffering || s.state === 'connecting';
    audioIndex = s.audioIndex; subIndex = s.subIndex;
    lastRouteOn = s.kind === 'airplay' && Boolean(get(castEngine.airState)?.active);
    // reconnect / failed: this page stays the TV's remote, which shows "Connection lost" / "Could not play" with its own Reconnect /
    // Play here (the latter drops the session; the title then plays on here, from the TV's position)
    if (s.state === 'reconnect' && s.kind === 'airplay' && !lastRouteOn) {
      // the route is off (this device picked in Safari's picker, or the TV gone for good): AirPlay ends, the page plays on
      queueMicrotask(() => void castEngine.stop()); return;
    }
    lastTv = s;
  }
  $: followTv($castSession);
  $: if (casting) { volume = $castState.volume; muted = $castState.muted; }
  /** the engine's session ended while this page is open: the element comes back (AirPlay) and local playback resumes */
  async function resumeLocal() {
    const was = lastTv;
    remote = false; handedOff = false; lastTv = null;
    started = false; stopped = false;
    if (video && stage && video.parentElement !== stage) {
      for (const a of [CAST_VIDEO_ATTR, 'aria-hidden', 'style']) video.removeAttribute(a);
      video.setAttribute('crossorigin', 'use-credentials');
      stage.insertBefore(video, stage.firstChild);
    }
    if (!air) void initAirPlay();
    // finished on the TV: the page offers what comes next (another episode ended there, e.g. a joined stream's last: that one's page, at its end)
    if (was?.state === 'ended') { if (was.itemId !== itemId) dispatch('episode', { id: was.itemId, t: was.position }); else { paused = true; dispatch('ended'); } return; }
    if (was?.kind === 'airplay' && lastRouteOn) {
      // the system route may still be the TV: the local stream (MSE) would play its sound there, the picture here
      airLog('engine', { src: video?.src, state: was.state, note: 'local playback, route was still wireless' });
      flash(tr('player.airplay.endHint'), 5000);
    }
    lastRouteOn = false;
    // the TV had moved on to another episode (a joined stream, or the engine's next episode): that one plays on here, at its position
    if (was && was.itemId !== itemId) { dispatch('episode', { id: was.itemId, t: was.position }); return; }
    wantAutoplay = !(was?.paused ?? true);
    await load(was?.position);
  }
  // ---- AirPlay session lifecycle (the controller tells when Safari's playback target becomes / stops being wireless) ----
  /** the last token refusal was 403 cast_forbidden: the error box says so and offers no Retry (the next refusal would be the same) */
  let airForbidden = false;
  $: if (!airState.error) airForbidden = false;
  const airErr = (e: any) => e?.body?.error === 'max_streams' ? tr('player.error.maxStreams', { n: Number(e.body.max) })
    : e?.body?.error === 'server_busy' ? tr('player.error.serverBusy')
    : e?.body?.error === 'cast_forbidden' ? tr('ui.error.castForbidden')
    : e?.body?.error === 'transcoding_disabled' ? tr('player.airplay.needsTranscode') : tr('player.airplay.failed');
  /** the subtitle index the current AirPlay token was requested with (-1 = none): the hand-off tells the engine this, not the menu's later choice */
  let airSubAsked = -1;
  /**
   * the episode a re-mint of a joined stream asked for (null: this page's item): `airEp` belongs to the token on the element,
   * `airEpAsked` to the request on its way
   */
  let airEp: JoinedItem | null = null, airEpAsked: JoinedItem | null = null;
  function startAirPlay(v: HTMLVideoElement) {
    air = createAirPlay(v, {
      // the chosen text track rides inside the AirPlay stream (the TV shows only what the stream carries); never in the retry after a refusal
      request: (pos, o) => {
        const body = airSubBody(subIndex, Boolean(o?.noSubs), typeof localStorage === 'undefined' ? null : localStorage, Date.now(), get(serverCaps).castHlsSubtitles);
        airSubAsked = body.subtitleIndex ?? -1; // what the token carries: a later change in this menu does not change the TV's stream
        // a single token for another episode (a joined re-mint the server answered plainly) stays that episode's
        const keep = !o?.joined && airInfo && !airInfo.joined && airEp ? airEp : null;
        airEpAsked = o?.joined ? airInfo?.joined?.items.find((x) => x.itemId === o.joined!.itemId) ?? null : keep;
        return castRequest(pos, 'airplay', undefined, body, o?.joined ?? (keep ? { itemId: keep.itemId, left: 1 } : undefined));
      },
      // the phone plays a joined token (before a TV is picked): a new token (audio, quality, renewal) starts at the episode and offset
      joined: (pos) => (airInfo?.joined ? joinedAsk(airInfo.joined.items, pos) : null),
      subsRefused() { rememberSubsRefused(typeof localStorage === 'undefined' ? null : localStorage, Date.now()); setSubtitle(-1, false); flash(tr('player.castRemote.subsRefused'), 4000); },
      revoke: (ci) => castRevoke(ci),
      async detach() {
        // before the token stream (tap on the button, or a new token): the TV must never get the MSE / cookie URL
        const my = ++attachSeq; clearTimeout(retryT); reconnecting = 0; error = '';
        if (started && !stopped) { stopped = true; await send('stop'); } // frees the stream slot (maxStreams) for the token's session
        // the stop report outlasted the controller's DETACH_WAIT_MS and it restored the normal stream meanwhile (no token loading any
        // more, a newer attach): that stream is not ours to drop
        if (my !== attachSeq && !air?.state.busy) return;
        hls?.destroy(); hls = null;
        if (video?.disableRemotePlayback) video.disableRemotePlayback = false; // hls.js sets it for ManagedMediaSource; it would block AirPlay
        started = false; stopped = false;
      },
      started(ci) { airInfo = ci; airEp = airEpAsked; started = false; stopped = false; mode = 'hls'; },
      async restore(pos, play, ci) {
        if (ci && started && !stopped) { stopped = true; await send('stop'); }
        // a joined token's position is on its stream: the episode there, at its offset (another episode: that one's page plays it)
        const j = ci?.joined ? joinedAt(ci.joined.items, pos) : null, ep = j ? ci!.joined!.items[j.index]! : ci ? airEp : null;
        airInfo = null; airEp = null; started = false; stopped = false;
        if (destroyed) return;
        if (ep && ep.itemId !== itemId) { dispatch('episode', { id: ep.itemId, t: j ? j.offset : pos }); return; }
        wantAutoplay = play;
        await load(j ? j.offset : pos);
      },
      fail: (e) => { airForbidden = (e as { body?: { error?: unknown } } | null)?.body?.error === 'cast_forbidden'; flash(airErr(e), 4000); },
      change: (st) => {
        airState = st;
        if (st.active && !st.error && !st.busy && airInfo && !handedOff) handOverAirPlay(); // the TV plays our token
      },
    }, airProbe);
  }
  /** the player's AirPlay button: same gate as Chromecast (/api/cast/config); a hidden non-MSE probe <video> reports receivers */
  async function initAirPlay() {
    if (partyMode || !get(perms).cast || !video || !airPlaySupported(video) || !(await castConfigEnabled().catch(() => false)) || destroyed || !video) return;
    airProbe = document.createElement('video');
    airProbe.setAttribute('x-webkit-airplay', 'allow');
    airProbe.setAttribute('playsinline', '');
    airProbe.muted = true; airProbe.preload = 'none'; airProbe.className = 'airprobe';
    airProbe.setAttribute('aria-hidden', 'true');
    stage?.appendChild(airProbe);
    startAirPlay(video);
  }

  // the cast right arrives after the player mounted (a stale boot hint denied it): start what onMount skipped
  let castWasDenied = !$perms.cast;
  $: if ($perms.cast && castWasDenied) {
    castWasDenied = false;
    if (!partyMode) void initCast();
    if (!air && !airProbe && !remote) void initAirPlay();
  }

  const doPause = () => { if (remote) { if (!paused) castEngine.playPause(); } else video?.pause(); };

  async function changeAudio(i: number) {
    const lang = audioOpts.find((a) => a.index === i)?.language;
    if (lang && lang !== 'und') rememberLang({ audio: lang });
    if (remote) { audioIndex = i; await castEngine.refresh({ audioIndex: i }); return; } // a new token with that track on the TV
    if (airInfo) { audioIndex = i; await air?.refresh(); return; } // AirPlay: a new token stream with that track
    const pos = video?.currentTime ?? 0, prevAudio = audioIndex;
    await send('stop');
    audioIndex = i;
    trackSwitching = true; // the next timing session exists because of this switch
    let r; try { r = await load(pos, { undo: () => { audioIndex = prevAudio; }, toast: tr('player.error.serverBusyTrack') }); } finally { trackSwitching = false; }
    if (r !== 'busy') video?.play().catch(() => undefined);
  }
  /** the last subtitle track that was on (-1 = none yet): the LG red key turns this one back on */
  let lastSubIndex = -1;
  function setSubtitle(i: number, remember = true) {
    subIndex = i;
    if (i !== -1) lastSubIndex = i;
    if (remember) { const lang = i === -1 ? 'off' : subOpts.find((x) => x.index === i)?.language; if (lang && lang !== 'und') rememberLang({ subtitle: lang }); }
    if (remote) castEngine.setSubtitle(i);
    [...(video?.textTracks ?? [])].forEach((t) => (t.mode = t.id === `sub-${i}` ? 'showing' : 'disabled'));
  }

  // ---- start playback: browsers may refuse sound without a prior key press (a TV that was only cast to) -> start muted, first key unmutes ----
  let wantAutoplay = !partyMode, needsSound = false;
  async function playSafe() {
    if (remote) { if (paused) castEngine.playPause(); return; }
    if (!video) return;
    try { await video.play(); return; } catch { /* blocked: try muted */ }
    try { video.muted = true; muted = true; await video.play(); needsSound = true; flash(tr('player.soundOff'), 7000); }
    catch { video.muted = false; muted = false; } // still blocked: the big play button stays
  }
  function unmuteOnGesture(e: Event) {
    if (!needsSound || !video) return;
    needsSound = false; video.muted = false; muted = false; toast = '';
    e.stopPropagation(); e.preventDefault(); // this first key/tap only switches the sound on
  }
  const tvMode = () => document.documentElement.classList.contains('tv');
  /** TV: the controls with the focus on the progress bar (spec 4); elsewhere the first bar button */
  const focusControls = () => { wake(); tickDom().then(() => stage?.querySelector<HTMLElement>(tvUi ? '.ctl [data-tvtrack]' : '.ctl .ic')?.focus()); };
  // ---- TV seek preview: the marker moves, OK or 1 s without a key seeks, Back cancels; the video keeps playing ----
  function previewStep(dir: -1 | 1, heldMs: number) {
    if (!allowed() || !(duration > 0)) return;
    sp = seekStep(sp, dir, remote ? current : video?.currentTime ?? current, duration, heldMs);
    clearTimeout(spT); spT = setTimeout(commitPreview, SEEK_COMMIT_MS);
    wake();
  }
  function commitPreview() {
    clearTimeout(spT);
    const r = seekCommit(sp);
    sp = r.next;
    if (r.seekTo !== null) { seekTo(r.seekTo); announce(tr('player.position', { t: fmtClock(r.seekTo) })); }
    wake();
  }
  // Skip intro / recap (TV): the big button takes the focus once when it appears (not out of an open overlay or a preview)
  $: if (tvUi && skip && !locked && skip.start !== skipFocused) { skipFocused = skip.start; focusSkip(); }
  function focusSkip() {
    void tickDom().then(() => {
      const a = document.activeElement;
      if (menu || sp.active || overlayOpen() || credits !== 'off') return; // the credits sequence focuses its own buttons (TV)
      if (a && a !== document.body && a !== stage && !stage?.querySelector('.ctl')?.contains(a)) return;
      stage?.querySelector<HTMLElement>('.skipbtn')?.focus({ preventScroll: true });
    });
  }
  function cancelPreview() { clearTimeout(spT); sp = seekCancel(); wake(); }
  /** the TV button row */
  function tvButton(b: TvButton) {
    wake();
    if (b === 'next') { if (hasNext && allowed()) void goNext(); return; }
    menu = menu === b ? '' : b;
  }
  /** what Back peels next (overlay -> seek preview -> controls -> leave) */
  function tvLayer(): TvLayer {
    if (menu) return 'overlay';
    if (sp.active) return 'seek';
    return stage?.querySelector('.ctl')?.contains(document.activeElement) ? 'controls' : 'none';
  }
  /** commands from the phone remote (dispatched by the layout on a paired TV) */
  function onRemote(e: Event) {
    const m = (e as CustomEvent<{ action: string; value?: number }>).detail;
    wake();
    if (m.action === 'play') { if (allowed()) playSafe(); }
    else if (m.action === 'pause') { if (allowed()) doPause(); }
    else if (m.action === 'toggle') { if (paused) { if (allowed()) playSafe(); } else if (allowed()) doPause(); }
    else if (m.action === 'audio' && typeof m.value === 'number') { if (info?.audioTracks.some((a) => a.index === m.value)) changeAudio(m.value); }
    else if (m.action === 'sub' && typeof m.value === 'number') { if (m.value === -1 || info?.subtitles.some((x) => x.index === m.value)) setSubtitle(m.value); }
    else if (m.action === 'next') { if (hasNext && allowed()) void goNext(); else flash(tr('player.noNext')); }
    else if (m.action === 'seekBy' && typeof m.value === 'number') seekBy(m.value);
  }

  // ---- gated controls (party guests are not allowed to change playback) ----
  function announce(t: string) { live = t + (liveN++ % 2 ? '\u200b' : ''); }
  function flash(t: string, ms = 1100) { toast = t; announce(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => (toast = ''), ms); }
  function allowed(): boolean { if (canControl) return true; flash(denyHint, 1800); return false; }
  function togglePlay() { if (remote) { if (allowed()) castEngine.playPause(); return; } if (!video || !allowed()) return; if (video.paused) video.play().catch(() => undefined); else video.pause(); }
  function seekTo(t: number) {
    if (sp.active) { clearTimeout(spT); sp = seekCancel(); } // a direct seek (±10 s, wheel, FF/REW, phone) replaces a pending preview
    if (remote) { if (!allowed()) return; castEngine.seek(t); return; } // the engine clamps, reports and mirrors the position
    if (!video || !allowed()) return; video.currentTime = Math.max(0, Math.min(duration || t, t)); }
  function seekBy(d: number, quiet = false) { if (!video || !allowed()) return; seekTo((remote ? current : video.currentTime) + d); if (quiet) announce(d > 0 ? tr('player.secondsForward', { n: d }) : tr('player.secondsBack', { n: -d })); else flash(d > 0 ? `+${d} s` : `−${-d} s`, 700); }
  /** next episode: as a remote the engine moves the TV on (its next(); the watch page follows the TV), else the page navigates */
  /** the panel's history entry comes off first: the page replaces this entry with the next episode (one Back still leaves) */
  async function goNext() { await leaveMenu(); if (remote) void castEngine.next(); else dispatch('next'); }
  function doSkip() {
    if (!skip) return;
    const key = segKey(skip.type, 'skipped');
    // a preview at the very end is the teaser of the next episode: go there instead of seeking into nothing
    if (skip.type === 'preview' && duration && skip.end >= duration - 3 && hasNext) { if (allowed()) void goNext(); return; }
    seekTo(skip.end);
    if (key) announce(tr(key));
  }
  const QUALITIES: Array<[string, number]> = LADDER.filter((r) => Number.isFinite(r.bps)).map((r) => [r.key, r.bps]);
  $: qualityOptions = QUALITIES.filter(([, b]) => b < (info?.roleMaxBitrate ?? Infinity));
  const qualityToast = (bps: number) => bps ? tr('player.quality.pinned', { q: rungLabel(bps) }) : tr('player.quality.changed', { q: tr('player.quality.auto') });
  /** the controller picked a new rung (stall, network error, step-up): reload the stream there and tell the viewer */
  function applyAbr(d: Decision): boolean {
    if (d.do !== 'switch') return false;
    wantAutoplay = false;
    void changeQuality(d.bps, 'abr', 3000, tr(d.reason === 'up' ? 'player.quality.stepUp' : 'player.quality.stepDown', { q: isOriginalBps(d.bps) ? tr('player.quality.chipOriginal') : rungLabel(d.bps) }));
    return true;
  }
  /** 'manual' = the viewer's pick (0 = Auto; a rung is pinned: no step-up); 'abr' = the controller already moved to `bps` */
  async function changeQuality(bps: number, how: 'manual' | 'abr' = 'manual', ms = 1100, msg = '') {
    menu = '';
    if (how === 'manual' && bps === shownQ) return;
    if (remote) { quality = bps; shownQ = bps; await castEngine.refresh({ maxBitrate: bps || undefined }); flash(qualityToast(bps)); return; }
    if (airInfo) { quality = bps; shownQ = bps; await air?.refresh(); flash(qualityToast(bps)); return; }
    if (switching) { if (how === 'manual') queuedPick = bps; return; } // a pick during a running switch is applied right after it
    switching = true;
    const prev = { quality, reqHint, abr, shownQ, bps: info?.maxBitrate ?? 0 };
    if (how === 'manual') {
      quality = bps; reqHint = bps ? 'manual' : 'network';
      abr = makeAbr(bps || autoBps(est.estimate ?? loadStoredEstimate()), bps || undefined);
      rec.networkTries = 0; reconnecting = 0; clearTimeout(retryT); // a pick replaces a pending cooldown retry
    } else {
      reqHint = 'network'; rec.networkTries = 0; reconnecting = 0; clearTimeout(retryT);
    }
    shownQ = quality ? (abr?.current ?? quality) : 0;
    resetStall();
    const pos = video?.currentTime ?? 0, wasPlaying = !(video?.paused ?? true);
    try {
      await send('stop');
      let kept = false;
      // only the viewer's own pick puts the old rung back on a refusal: an ABR step-down left a rung that stalled, so a refusal there
      // shows the honest busy state instead of reloading the stalling stream
      const r = await load(pos, how === 'manual' ? { undo: () => { kept = true; quality = prev.quality; reqHint = prev.reqHint; abr = prev.abr; shownQ = prev.shownQ; }, toast: tr('player.error.serverBusyQuality', { q: rungLabel(prev.bps) }) } : undefined);
      if (r !== 'busy') {
        if (wasPlaying) video?.play().catch(() => undefined);
        if (!kept) flash(msg || qualityToast(bps), ms); // a refused switch already said that the quality stays
      }
    } finally { switching = false; }
    const next = queuedPick; queuedPick = null;
    if (next !== null) void changeQuality(next);
  }
  function setSleep(min: number | 'end') {
    menu = '';
    sleepAfterEpisode = min === 'end';
    sleepMin = typeof min === 'number' ? min : 0;
    sleepAt = typeof min === 'number' && min > 0 ? Date.now() + min * 60_000 : 0;
    flash(min === 0 ? tr('player.sleep.off') : min === 'end' ? tr('player.sleep.afterEpisode') : tr('player.sleep.set', { d: fmtDuration(min * 60) }));
  }
  async function pip() { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video?.requestPictureInPicture(); } catch { flash(tr('player.pipUnavailable')); } }
  // ---- scenes: bookmarks + share link ----
  const loadBookmarks = () => api(`/api/bookmarks?itemId=${itemId}`).then((r) => (bookmarks = r.bookmarks)).catch(() => undefined);
  async function addBookmark() {
    try { await api('/api/bookmarks', { method: 'POST', body: { itemId, position: Math.floor(video?.currentTime ?? 0), note: noteText || undefined } }); noteText = ''; await loadBookmarks(); flash(tr('player.bookmark.set')); }
    catch { flash(tr('player.bookmark.failed')); }
  }
  async function removeBookmark(id: string) { await api(`/api/bookmarks/${id}`, { method: 'DELETE' }).catch(() => undefined); loadBookmarks(); }
  async function shareScene() {
    const url = `${location.origin}/watch/${itemId}?t=${Math.floor(video?.currentTime ?? 0)}`;
    try { await navigator.clipboard.writeText(url); flash(tr('player.bookmark.linkCopied', { t: fmtClock(video?.currentTime ?? 0) }), 1800); } catch { flash(url, 4000); }
  }

  // ---- "Besetzung & Infos": side panel while paused (as before) or opened explicitly; quick peek while playing ----
  let castData: CastInfoData | null = null, castFailed = false, infoDismissed = false, infoFocus = false, peek = false, peekT: ReturnType<typeof setTimeout>;
  function ensureInfo() {
    if (castData) return;
    castFailed = false;
    loadCastInfo(itemId).then((d) => (castData = d)).catch(() => (castFailed = true));
  }
  $: if (paused && started) { clearTimeout(pauseT); pauseT = setTimeout(() => { pausedLong = true; ensureInfo(); }, 1200); } else { clearTimeout(pauseT); pausedLong = false; infoDismissed = false; }
  // automatic (pause): only with something to show; explicit: also while loading / after an error
  $: showXray = (xray || (pausedLong && !tvUi && !desk && !phoneUi && !infoDismissed && Boolean(castData && (hasPeople(castData) || castData.studios.length || castData.genres.length)))) && menu === '' && !subDlg && !help && !error && !locked;
  $: if (showXray) peek = false;
  /** quick peek: does not pause, hides by itself after a few seconds */
  function openPeek() {
    if (showXray || locked) return;
    ensureInfo(); wake(); peek = true;
    clearTimeout(peekT); peekT = setTimeout(() => (peek = false), 6000);
    announce(tr('scenes.peek.label'));
  }
  function openCastInfo(focus: boolean) { clearTimeout(peekT); peek = false; menu = ''; ensureInfo(); infoFocus = focus; xray = true; wake(); }
  function closeCastInfo() {
    const had = stage?.querySelector('.ci')?.contains(document.activeElement);
    xray = false; infoDismissed = true; infoFocus = false; wake(); // the pause-screen timer starts over (Esc's capture handler skips onKey's wake)
    if (had) tickDom().then(() => castBtn?.focus());
  }
  /** the cast button in the bar: panel open -> close; paused -> panel; playing -> peek (a second press opens the panel) */
  function castButton() { if (showXray) closeCastInfo(); else if (paused || peek) openCastInfo(tvMode()); else openPeek(); }
  let castBtn: HTMLButtonElement | undefined;

  // ---- chapters ("Szenen"): marks on the seek bar, names while hovering / scrubbing, the scenes panel ----
  let chapters: Chapter[] = [], scBtn: HTMLButtonElement | undefined;
  $: marks = chapterMarks(chapters, duration);
  $: showScenes = usefulChapters(chapters, duration);
  const chapterAt = (sec: number) => { const i = chapterIndexAt(chapters, sec); return chapters.length > 1 && i >= 0 ? chapterLabel(chapters[i]!, i) : ''; };
  /** the chapter playing now (desktop title block eyebrow; '' without chapters) */
  $: nowChapter = chapterAt(shown);
  function closeScenes() { menu = ''; void tickDom().then(() => (scBtn ?? moreBtn)?.focus()); }

  // ---- sound: "Klare Stimmen" / "Nachtmodus" (Web Audio on the local <video>; the profile's server pref `audioFx`, with a
  //      localStorage copy so the player starts with the right mode before /api/prefs answered) ----
  let fx: AudioFx = loadFx(getActiveProfile()), fxEngine: AudioFxEngine | null = null, fxNote: '' | 'unsupported' | 'suspended' = '';
  const fxBlockFor = (isCasting: boolean, m: string, h: Hls | null) => video ? fxBlocked({
    casting: isCasting, nativeHls: m === 'hls' && !h, src: video.currentSrc || video.src || '', crossOrigin: video.crossOrigin, origin: location.origin,
    hasWebAudio: typeof window !== 'undefined' && ('AudioContext' in window || 'webkitAudioContext' in window),
  }) : 'unsupported';
  $: fxDisabled = menu === 'tracks' ? (remote || airOn ? 'casting' : fxNote === 'unsupported' ? 'unsupported' : fxBlockFor(casting, mode, hls)) : null;
  async function applyFx(quiet = false) {
    if (!video || (!fxActive(fx) && !fxEngine)) return;
    const b = fxBlockFor(remote, mode, hls);
    if (b) { if (b === 'unsupported') fxNote = 'unsupported'; return; }
    fxEngine ??= new AudioFxEngine(video);
    const r = await fxEngine.apply(fx);
    fxNote = r === 'unsupported' ? 'unsupported' : r === 'suspended' ? 'suspended' : '';
    timing.sound(fxToPref(fx), Boolean(fxEngine?.routed));
    if (r === 'unsupported' && !quiet) flash(tr('scenes.audio.unsupported'), 2500);
  }
  const FX_OPTS = [
    { k: 'voice', label: 'scenes.audio.voice', hint: 'scenes.audio.voiceHint' },
    { k: 'night', label: 'scenes.audio.night', hint: 'scenes.audio.nightHint' },
  ] as const;
  /** the server pref wins once it is known (another device may have changed it); never after a toggle made here */
  let fxTouched = false;
  $: if ($prefsLoaded && !fxTouched) adoptFxPref($prefs.audioFx);
  function adoptFxPref(p: unknown) {
    const n = fxFromPref(p);
    if (n.voice === fx.voice && n.night === fx.night) return;
    fx = n;
    saveFx(getActiveProfile(), fx);
    void applyFx(true);
  }
  function toggleFx(k: keyof AudioFx) {
    fxTouched = true;
    fx = { ...fx, [k]: !fx[k] };
    saveFx(getActiveProfile(), fx);
    saveAudioFx(fxToPref(fx)).catch(() => undefined); // offline / failed: still remembered in this browser
    const name = tr(k === 'voice' ? 'scenes.audio.voice' : 'scenes.audio.night');
    flash(tr(fx[k] ? 'scenes.audio.on' : 'scenes.audio.off', { name }), 1400);
    void applyFx().then(() => { if (paused) restorePlainSoon(); });
  }
  // ---- "Raumklang" (Surround sound): per device, stored in this browser (devicecaps.ts); off = the next stream is stereo ----
  let stereo = stereoOnly(), surroundShown = false;
  /** offered when the server offers surround and the device states 5.1 output (before the stereo choice applies); not while casting */
  $: surroundShown = menu === 'tracks' && $features.surround && !remote && !airOn && !airInfo && ((s) => s.channels >= 6 && s.surround.length > 0)(playerCapsSummary());
  /** a sound mode keeps the output stereo whatever the switch says */
  $: surroundOn = !stereo && !fxActive(fx);
  async function toggleSurround() {
    stereo = !stereo; setStereoOnly(stereo);
    flash(tr(stereo ? 'scenes.audio.off' : 'scenes.audio.on', { name: tr('scenes.audio.surround') }), 1400);
    if (remote || airInfo || !info || fxActive(fx) || mode === 'direct') return;
    if (stereo && (info.delivery?.channels ?? 2) <= 2) return; // the stream is stereo anyway
    // turning on cannot change a stream whose track is stereo, or when this device gave surround up after a failed start
    if (!stereo && (info.delivery?.why.includes('stereo_source') || avoidedUntil().surround)) return;
    // like an audio track change: a new stream at the current position
    const pos = video?.currentTime ?? 0;
    await send('stop');
    trackSwitching = true;
    // refused: the switch goes back (turning surround on keeps it off, turning it off keeps it on) and says so in its own words
    const kept = tr(stereo ? 'player.error.serverBusySurroundOn' : 'player.error.serverBusySurroundOff');
    let r; try { r = await load(pos, { undo: () => { stereo = !stereo; setStereoOnly(stereo); }, toast: kept }); } finally { trackSwitching = false; }
    if (r !== 'busy') video?.play().catch(() => undefined);
  }
  /** a remembered mode needs a running AudioContext: the first key / tap after an autoplayed start switches it on */
  function fxGesture() { if (fxNote === 'suspended' && fxActive(fx)) void applyFx(true); }

  // ---- the plain sound path back (lib/player/freshvideo.ts): Web Audio cannot be taken off an element, so with both modes off
  //      the film moves to a fresh <video>: while paused (seamless: the current frame is its poster) or at the next stream start ----
  let videoGen = 0, swapShot = '', swapping = false, swapT: ReturnType<typeof setTimeout> | undefined;
  /** replaces the element (the caller already detached the stream); volume, mute and speed carry over */
  async function freshVideo() {
    const old = video;
    if (!old) return;
    sampleFrames();
    fxEngine?.destroy(); fxEngine = null;
    // emptied BEFORE it leaves the page: the load algorithm pauses it silently (removing a playing element would fire `pause`)
    try { old.removeAttribute('src'); old.load(); } catch { /* already empty */ }
    videoGen++;
    await tickDom();
    if (!video || video === old) return;
    if (volOk) video.volume = volume;
    video.muted = muted;
    if (!partyMode) applyRate(video, rate);
    if (video) pipOk = Boolean(document.pictureInPictureEnabled) && !video.disablePictureInPicture;
  }
  /** while paused: the same position on a fresh element, the current frame held as its poster until the new one is there */
  async function restorePlain() {
    clearTimeout(swapT);
    if (!video || !info || !plainPathDue(Boolean(fxEngine?.routed), fx)) return;
    if (!swapAllowed({ paused: video.paused, party: partyMode, remote: remote || casting || airOn || Boolean(airInfo) || handedOff, airplay: Boolean(air), busy: swapping || switching || Boolean(reconnecting) || Boolean(error) || waiting || !started, creditsCorner: credits === 'corner' || credOut })) return;
    const shot = snapshotFrame(video);
    if (!shot) return; // no picture to hold: the next stream start brings the plain path back
    const pos = video.currentTime;
    swapping = true;
    try {
      // decoded before the swap, so the new element paints the poster at once (never a black frame in between)
      try { const img = new Image(); img.src = shot; await img.decode(); } catch { /* shown when ready */ }
      if (!video?.paused || !plainPathDue(Boolean(fxEngine?.routed), fx)) return; // played on / modes back on meanwhile
      swapShot = shot;
      await attach(pos, true);
      if (video) await frameShown(video, pos);
    } finally {
      swapping = false; swapShot = '';
      syncTime();
    }
  }
  /** after a pause: swap once the pause has settled (a quick pause / play does not reload anything) */
  function restorePlainSoon() { clearTimeout(swapT); if (plainPathDue(Boolean(fxEngine?.routed), fx)) swapT = setTimeout(() => void restorePlain(), 800); }

  // ---- find subtitles (Jellyfin remote providers) ----
  async function searchSubs() {
    subBusy = true; subMsg = ''; subResults = null;
    try { subResults = (await api(`/api/items/${itemId}/subtitles/search?lang=${subLang}`)).results; if (!subResults?.length) subMsg = tr('player.subs.notFound'); }
    catch (e: any) { subMsg = e?.status === 403 ? tr('player.subs.notAllowed') : tr('player.subs.providerDown'); }
    subBusy = false;
  }
  async function pickSub(id: string) {
    subBusy = true;
    try {
      await api(`/api/items/${itemId}/subtitles/download`, { method: 'POST', body: { subtitleId: id } });
      if (remote) { subDlg = false; await castEngine.refresh(); flash(tr('player.subs.added'), 2500); subBusy = false; return; }
      const pos = video?.currentTime ?? 0, was = !(video?.paused ?? true);
      subDlg = false; await send('stop'); await load(pos); if (was) video?.play().catch(() => undefined);
      flash(tr('player.subs.added'), 2500);
    } catch { subMsg = tr('player.subs.downloadFailed'); }
    subBusy = false;
  }
  function setRate(r: number, keepMenu = false) { if (!video) return; rate = r; applyRate(video, r); if (!keepMenu) menu = ''; flash(r === 1 ? tr('player.speed.normalToast') : tr('player.speed.rate', { r })); }
  /** < / > : one step along the speed list, clamped at both ends (no wrap); not in a watch party (the drift correction owns the rate) */
  function speedBy(delta: 1 | -1) {
    if (partyMode || !video) return;
    let i = SPEEDS.findIndex((r) => r === rate);
    if (i < 0) i = SPEEDS.reduce((best, r, k) => (Math.abs(r - rate) < Math.abs(SPEEDS[best]! - rate) ? k : best), 0);
    setRate(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + delta))]!, true);
  }
  $: modeLabel = casting ? 'Chromecast' : airOn ? 'AirPlay' : mode === 'direct' ? $t('player.mode.direct') : mode ? $t('player.mode.hls') : '';
  const toggleMenu = (m: typeof menu) => (menu = menu === m ? '' : m);
  /** a sub-view reached through More is open (phones: speed when it has no own button, chapters) */
  $: moreSub = coarse && ((menu === 'speed' && !speedBtn) || menu === 'chapters');
  /** Large control icons (~40px); smaller on phones */
  let ICON = 36;
  async function pickEpisode(e: CustomEvent<{ id: string }>) { await leaveMenu(); dispatch('episode', e.detail); }
  /** "Folgen" panel closed (✕ or the playing episode): focus goes back to its trigger */
  let epBtn: HTMLButtonElement | undefined, moreBtn: HTMLButtonElement | undefined;
  function closeEpisodes() { menu = ''; void tickDom().then(() => epBtn?.focus()); }
  function setVolume(v: number) { if (casting) { volume = v; muted = v === 0; castSetVolume(v); return; } if (!video) return; volume = v; video.volume = v; video.muted = v === 0; muted = v === 0; try { localStorage.setItem('ff_vol', String(v)); } catch { /* ignore */ } }
  function volumeBy(delta: number) { const v = stepVolume(muted ? 0 : volume, delta); setVolume(v); flash(tr('player.volume.level', { n: Math.round(v * 100) }), 600); }
  function toggleMute() { if (casting) { castToggleMute(); return; } if (!video) return; video.muted = !video.muted; muted = video.muted; if (!muted && volume === 0) setVolume(0.5); }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else (stage ?? video?.parentElement)?.requestFullscreen?.().catch(() => undefined);
  }

  // ---- timeline (pointer + keyboard) ----
  function fracAt(e: PointerEvent | MouseEvent) { const r = trackEl.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); }
  let trackW = 600;
  function onTrackMove(e: PointerEvent) { const f = fracAt(e); hoverX = f * 100; hoverTime = f * duration; trackW = trackEl.clientWidth; if (scrubbing) scrubTime = hoverTime; }
  /** keep the preview inside the timeline at both ends */
  $: previewW = info?.trickplay ? 168 : 0;
  $: tipLeft = Math.max(previewW / 2, Math.min(trackW - previewW / 2, (hoverX / 100) * trackW));
  $: thumb = hoverX < 0 || !duration ? null : trickFrame(info?.trickplay, scrubbing ? scrubTime : hoverTime, 168);
  $: tipChapter = hoverX >= 0 && duration ? chapterAt(scrubbing ? scrubTime : hoverTime) : '';
  function onTrackDown(e: PointerEvent) {
    if (!allowed()) return;
    scrubbing = true; scrubTime = fracAt(e) * duration; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onTrackUp() { if (scrubbing) { scrubbing = false; seekTo(scrubTime); } }
  function onTrackKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); seekBy(-5); }
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); seekBy(5); }
  }

  // ---- activity / keyboard / touch ----
  function wake() { lastActive = Date.now(); tick = lastActive; }
  /**
   * desktop: keyboard focus (focus-visible) inside the controls keeps them up (WCAG 2.4.7 / 2.4.11) - the bar never fades
   * from under the focused button. A mouse click focuses without focus-visible, so pointer users keep the idle hide; phones
   * and TV keep their own rules (TV drops the focus when the bar hides).
   */
  let ctlFocus = false;
  function syncCtlFocus() {
    if (tvUi || phoneUi || tvMode() || typeof document === 'undefined') { ctlFocus = false; return; }
    const a = document.activeElement;
    ctlFocus = Boolean(a && stage?.querySelector('.ctl')?.contains(a) && a.matches(':focus-visible'));
  }
  const onStageFocus = (e: FocusEvent) => {
    if (e.type === 'focusout') popFocusOut(e);
    setTimeout(syncCtlFocus, 0);
  };
  /**
   * desktop popovers (audio & subtitles, speed, more, scenes; role=dialog): the keyboard leaving one (Tab past its last item or
   * onto another control) closes it, it never stays open behind the focus (WCAG 2.4.3). A pointer press elsewhere (no new focus
   * target) has its own close.
   */
  function popFocusOut(e: FocusEvent) {
    const to = e.relatedTarget as Node | null;
    if (!to || !menu || tvUi || phoneUi || tvMode()) return;
    const pop = stage?.querySelector('.menu[role="dialog"]');
    const opener = stage?.querySelector('.ctl [aria-expanded="true"]');
    if (!pop || pop.contains(to) || opener?.contains(to)) return;
    menu = '';
  }
  const overlayOpen = () => Boolean(menu || subDlg || help || playOnOpen || (xray && showXray));
  function act(a: KeyAction) {
    // credits corner (TV): the bar is hidden and inert; a key that would bring it (an arrow at the edge of the sequence) only wakes
    if (credits === 'corner' && a.type === 'tvControls') { wake(); return; }
    switch (a.type) {
      case 'toggle': togglePlay(); break;
      case 'play': if (allowed()) playSafe(); break;
      case 'pause': if (allowed()) doPause(); break;
      case 'seek': seekBy(a.by); break;
      case 'seekPct': if (duration > 0 && allowed()) { seekTo((duration * a.pct) / 100); flash(tr('player.percent', { n: a.pct }), 700); } break;
      case 'volume': volumeBy(a.delta); break;
      case 'mute': toggleMute(); flash(muted ? tr('player.mute') : tr('player.unmute'), 700); break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'subtitles': cycleSubtitles(); break;
      case 'subtitleToggle': toggleSubtitles(); break;
      case 'skip': if (skip && allowed()) doSkip(); break;
      case 'next': if (hasNext && allowed()) void goNext(); else flash(tr('player.noNext')); break;
      case 'help': help = !help; break;
      case 'speed': speedBy(a.delta); break;
      case 'pip': if (pipOk && !remote) void pip(); break;
      case 'tvControls': if (!overlayOpen() && !peek) focusControls(); else wake(); break;
      case 'seekPreview': previewStep(a.dir, 0); break;
      case 'seekCommit': commitPreview(); break;
      case 'escape': menu = ''; subDlg = false; help = false; if (showXray) closeCastInfo(); peek = false; break;
      case 'peek': if (peek) openCastInfo(true); else openPeek(); break;
      case 'castInfo': openCastInfo(true); break;
      case 'audioMenu': menu = 'tracks'; wake(); break;
      case 'stop': dispatch('back'); break; // the watch page leaves like its Back key; onDestroy sends the stop report
    }
  }
  function cycleSubtitles() {
    if (!info?.subtitles.length) { flash(tr('player.subs.none')); return; }
    const i = nextSubtitle(subIndex, info.subtitles.map((x) => x.index));
    setSubtitle(i);
    flash(i === -1 ? tr('player.subs.off') : tr('player.subs.on', { name: info.subtitles.find((x) => x.index === i)?.title ?? '' }), 1500);
  }
  /** LG red key: subtitles on (the last used track, else the first) / off */
  function toggleSubtitles() {
    if (!info?.subtitles.length) { flash(tr('player.subs.none')); return; }
    const i = toggleSubtitle(subIndex, lastSubIndex, info.subtitles.map((x) => x.index));
    setSubtitle(i);
    flash(i === -1 ? tr('player.subs.off') : tr('player.subs.on', { name: info.subtitles.find((x) => x.index === i)?.title ?? '' }), 1500);
  }
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (!video || isTypingTarget(t)) return;
    if (aconn && !(e.key === 'Escape' || isBackKey(e))) return; // the AirPlay connecting layout: only Back / Escape (and its own buttons) act
    if ((t.tagName === 'BUTTON' || t.tagName === 'A') && (e.key === ' ' || e.key === 'Enter')) return; // the focused control keeps Space/Enter
    const lg = isLgApp();
    const a = resolveKey(lg ? { key: normaliseLgKey(e), ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey } : e, { tv: tvMode(), onBody: t === document.body || t === stage, hasSkip: Boolean(skip), hasNext, overlayOpen: overlayOpen(), peekOpen: peek, lg });
    wake();
    if (!a) return;
    e.preventDefault();
    act(a);
  }
  let holdStart = 0; // TV progress bar: when the left / right key went down (held keys preview faster steps)
  /** Back / Escape (capture phase: the control bar swallows key events): close the shortcut overlay / open menu, then leave the control bar */
  function onBackCapture(e: KeyboardEvent) {
    // TV pause screen: arrows, OK and Back only take it away and bring the controls (play / media keys still act)
    if (pauseOn && (e.key.startsWith('Arrow') || e.key === 'Enter' || isBackKey(e) || e.key === 'Escape')) {
      e.preventDefault(); e.stopImmediatePropagation(); focusControls(); return;
    }
    if (!(e.key === 'Escape' || (tvMode() && isBackKey(e)))) return;
    if (playOnOpen) { // the "Play on" dialog closes alone; the focus goes back to what opened it
      e.preventDefault(); e.stopImmediatePropagation(); playOnOpen = false;
      void tickDom().then(() => playOnTrigger?.isConnected && playOnTrigger.focus({ preventScroll: true }));
      return;
    }
    if (tvUi && !chipOpen && !subDlg && !help) {
      const layer = tvLayer();
      if (layer === 'overlay' || layer === 'seek') {
        e.preventDefault(); e.stopImmediatePropagation();
        const opener = stage?.querySelector<HTMLElement>('.ctl [aria-expanded="true"]');
        if (playerBack(layer).next === 'controls') {
          if (layer === 'seek') { cancelPreview(); return; }
          menu = ''; wake();
          tickDom().then(() => (opener ?? stage?.querySelector<HTMLElement>('.ctl [data-tvtrack]'))?.focus());
        }
        return;
      }
    }
    const opener = stage?.querySelector<HTMLElement>('.ctl [aria-expanded="true"]');
    if (chipOpen) { e.preventDefault(); e.stopImmediatePropagation(); chipOpen = false; return; } // the quality bubble closes alone
    if (menu || subDlg || help) {
      e.preventDefault(); e.stopImmediatePropagation();
      const panelBtn = menu === 'episodes' ? epBtn : menu === 'chapters' ? (scBtn ?? moreBtn) : undefined;
      const hadMenu = menu !== '';
      menu = ''; subDlg = false; help = false;
      if (hadMenu || tvMode() || panelBtn) tickDom().then(() => (panelBtn ?? opener)?.focus()); // focus goes back to the button that opened it
    } else if (showXray && (xray || stage?.querySelector('.ci')?.contains(document.activeElement))) {
      e.preventDefault(); e.stopImmediatePropagation();
      const sheetBack = stage?.querySelector<HTMLButtonElement>('.ci [data-back]');
      if (sheetBack) sheetBack.click(); else closeCastInfo(); // person sheet open: back to the cast list first
    } else if (peek) {
      e.preventDefault(); e.stopImmediatePropagation();
      clearTimeout(peekT); peek = false;
    } else if (credits !== 'off') {
      // credits sequence: Esc / TV Back back out to full screen (the page's "Watch credits") instead of leaving the player
      e.preventDefault(); e.stopImmediatePropagation();
      wake(); dispatch('credits');
    } else if (tvMode() && stage?.querySelector('.ctl')?.contains(document.activeElement)) {
      e.preventDefault(); e.stopImmediatePropagation();
      (document.activeElement as HTMLElement).blur(); lastActive = 0; // hide the bar, the next Back leaves the player
    }
  }
  /** keys typed on a control belong to the control (Space/Enter = click, arrows = slider) - everything else (F, M, C, digits ...) still reaches the player; Escape leaves */
  const ctlKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') return;
    const t = e.target as HTMLElement;
    if (tvMode()) {
      wake();
      if (t.hasAttribute('data-tvtrack')) {
        // the progress bar: left / right preview a seek (held keys step faster), OK commits it or plays / pauses
        if (!e.repeat) holdStart = Date.now();
        const a = resolveKey(e, { tv: true, onBody: false, onTrack: true, previewActive: sp.active, hasSkip: false, hasNext, overlayOpen: false });
        if (a?.type === 'seekPreview') { e.preventDefault(); e.stopPropagation(); previewStep(a.dir, e.repeat ? Date.now() - holdStart : 0); return; }
        if (a?.type === 'seekCommit') { e.preventDefault(); e.stopPropagation(); commitPreview(); return; }
        if (a?.type === 'toggle') { e.preventDefault(); e.stopPropagation(); togglePlay(); return; }
      }
      // D-pad: the focus belongs to the controls (spatial navigation moved it); media, colour and channel keys still reach the player
      if (e.key.startsWith('Arrow')) e.stopPropagation();
      return;
    }
    wake(); // any key brings the controls back (the bar may swallow the event before the window handler sees it)
    const native = (t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'range' && e.key.startsWith('Arrow'));
    if (native) e.stopPropagation();
  };
  $: if (help || error) tickDom().then(() => stage?.querySelector<HTMLElement>('.help [data-autofocus], .errbox [data-autofocus]')?.focus());
  // an opened popover takes the focus (its chosen item, else the first): on TV always, on desktop when the keyboard opened it
  // (the button had focus-visible; a mouse click leaves the focus where it was, WCAG 2.4.3)
  $: if (menu && typeof document !== 'undefined' && (tvMode() || keyOpened())) tickDom().then(() => stage?.querySelector<HTMLElement>('.menu .mi.on, .menu .mi')?.focus());
  function keyOpened() {
    const a = document.activeElement;
    return !phoneUi && Boolean(a && stage?.querySelector('.ctl')?.contains(a) && a.matches(':focus-visible'));
  }
  // long lists scroll inside the menu: open each column at the current choice, not at the top
  $: if (menu && typeof document !== 'undefined') tickDom().then(() => stage?.querySelectorAll<HTMLElement>('.menu .mi.on').forEach((el) => el.scrollIntoView?.({ block: 'nearest' })));

  // ---- mouse: click = play/pause (deferred to tell a double click = fullscreen); touch is handled by the pointer gestures below ----
  let lastTap = 0, lastTouch = 0;
  const NO_GESTURE = '.ui, .skipbtn, .ovl, .dlg, .help, .lockbtn, .rs, .ac, [data-nav], button, a, input, select';
  function onSurfaceClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest(NO_GESTURE)) return;
    if (Date.now() - lastTouch < 800) return; // the click that follows a touch was already handled
    const now = Date.now();
    if (menu) { menu = ''; return; }
    if (credits === 'corner') { if (e.target === video) dispatch('credits'); return; } // the small picture backs out to full screen
    if (now - lastTap < 280) { toggleFullscreen(); lastTap = 0; } else { lastTap = now; setTimeout(() => { if (lastTap === now) { togglePlay(); lastTap = 0; } }, 285); }
  }
  /** a click outside the open menu (and not on its opener, which toggles itself) closes it; focus returns to the opener. A click on the picture only closes. */
  function onOutsideClick(e: MouseEvent) {
    // phones: the party host's settings and Cast & info close on a tap outside them too (desktop keeps its own toggles)
    if (phoneUi && extPanel && !(e.target as HTMLElement | null)?.closest?.('.menu, [aria-expanded="true"]')) extPanel = false;
    if (phoneUi && xray && !(e.target as HTMLElement | null)?.closest?.('.cihost')) {
      const onPicture = Boolean(stage?.contains(e.target as Node)) && !(e.target as HTMLElement).closest(NO_GESTURE);
      closeCastInfo();
      if (onPicture) { e.stopPropagation(); return; } // a tap on the picture only closes
    }
    if (!menu || !stage) return;
    const t = e.target as HTMLElement | null;
    if (!t || t.closest('.menu, .tvov, .ctl .list, [aria-expanded="true"]')) return;
    const opener = stage.querySelector<HTMLElement>('.ctl [aria-expanded="true"]');
    const onPicture = stage.contains(t) && !t.closest(NO_GESTURE);
    menu = '';
    if (onPicture) { e.stopPropagation(); void tickDom().then(() => opener?.focus()); }
  }
  /** mouse wheel over the picture = volume (desktop; a menu open keeps its own scrolling) */
  const wheelAcc = new WheelAccumulator();
  const tvWheel = new TvWheelStepper();
  function onWheel(e: WheelEvent) {
    // TV (LG Magic Remote wheel): one notch = 10 s forward/back over the picture; menus and dialogs keep their own scrolling
    if (tvMode()) {
      if (locked || menu || subDlg || help || !video || !e.deltaY) return;
      if (e.target !== video && e.target !== stage) return;
      e.preventDefault(); wake();
      const n = tvWheel.add(e.deltaY, e.timeStamp || Date.now());
      if (n) seekBy(n * 10);
      return;
    }
    if (coarse || locked || menu || subDlg || help || !video || e.ctrlKey || !e.deltaY) return;
    if (e.target !== video && e.target !== stage) return; // slot content (party chat), menus, dialogs keep their own scrolling
    e.preventDefault(); wake();
    const n = wheelAcc.add(e.deltaY, e.deltaMode, e.timeStamp || Date.now(), window.innerHeight);
    if (n) volumeBy(-n * 0.05);
  }
  function toggleControls() { if (tick - lastActive < hideMs && !paused) lastActive = 0; else wake(); }

  // ---- touch gestures: double-tap thirds = seek, swipe = volume / brightness / scrub, lock ----
  type G = { id: number; x: number; y: number; t: number; w: number; h: number; left: number; axis: Axis; moved: boolean; startTime: number; startVol: number; startBri: number; target: number };
  let g: G | null = null, tapState: TapState | null = null, pendingTap: ReturnType<typeof setTimeout>;
  function showHud(h: { icon: string; text: string; pct: number } | null, hideAfter = 0) { hud = h; clearTimeout(hudT); if (h && hideAfter) hudT = setTimeout(() => (hud = null), hideAfter); }
  function showRipple(zone: Zone, total: number) { ripple = { zone, total, n: (ripple?.n ?? 0) + 1 }; clearTimeout(rippleT); rippleT = setTimeout(() => (ripple = null), 750); }
  function gDown(e: PointerEvent) {
    if (e.pointerType !== 'touch' || tvMode()) return;
    lastTouch = Date.now();
    if (g) { g = null; showHud(null); return; } // second finger: not ours (pinch)
    if ((e.target as HTMLElement).closest(NO_GESTURE)) return;
    const r = (stage ?? (e.currentTarget as HTMLElement)).getBoundingClientRect();
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), w: r.width - inset, h: r.height, left: r.left, axis: null, moved: false, startTime: remote ? current : video?.currentTime ?? 0, startVol: muted ? 0 : volume, startBri: brightness, target: 0 };
  }
  function gMove(e: PointerEvent) {
    if (!g || e.pointerId !== g.id || locked) return;
    if (credits === 'corner') return; // the corner beat: no scrub / volume / brightness (a tap on the small picture still backs out)
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.axis) {
      g.axis = classifyMove(dx, dy, g.x - g.left, g.w, { volumeOk: volOk });
      if (!g.axis) return;
      if (g.axis === 'scrub' && (!duration || !canControl)) { if (!canControl) allowed(); g.axis = null; g.moved = true; return; }
      if (g.axis === 'brightness' && remote) { g.axis = null; g.moved = true; return; }
      g.moved = true; clearTimeout(pendingTap); tapState = null;
    }
    if (g.axis === 'scrub') {
      g.target = scrubTarget(g.startTime, dx, g.w, duration);
      const d = g.target - g.startTime;
      const ch = chapterAt(g.target);
      showHud({ icon: d < 0 ? 'rewind10' : 'forward10', text: `${ch ? ch + ' · ' : ''}${fmtClock(g.target)}  (${d < 0 ? '−' : '+'}${fmtClock(Math.abs(d))})`, pct: duration ? (g.target / duration) * 100 : 0 });
    } else if (g.axis === 'volume') {
      const v = Math.round(levelFromDrag(g.startVol, dy, g.h) * 20) / 20;
      setVolume(v); showHud({ icon: v === 0 ? 'volume-off' : v < 0.5 ? 'volume-low' : 'volume', text: tr('player.volume.level', { n: Math.round(v * 100) }), pct: v * 100 });
    } else if (g.axis === 'brightness') {
      brightness = levelFromDrag(g.startBri, dy, g.h, BRIGHTNESS_MIN, 1);
      showHud({ icon: 'sun', text: tr('player.brightness', { n: brightnessPct(brightness) }), pct: ((brightness - BRIGHTNESS_MIN) / (1 - BRIGHTNESS_MIN)) * 100 });
    }
  }
  function gUp(e: PointerEvent) {
    if (!g || e.pointerId !== g.id) return;
    const cur = g; g = null; lastTouch = Date.now();
    if (cur.axis === 'scrub') { seekTo(cur.target); announce(tr('player.position', { t: fmtClock(cur.target) })); showHud(hud, 500); return; }
    if (cur.axis) { announce(hud?.text ?? ''); showHud(hud, 700); return; }
    if (cur.moved || Math.hypot(e.clientX - cur.x, e.clientY - cur.y) > 12) { showHud(null); return; }
    // credits corner (phones): a tap on the small picture backs out to full screen (the click after a touch never reaches onSurfaceClick)
    if (credits === 'corner' && !locked) { if (e.target === video) dispatch('credits'); return; }
    handleTap(e.clientX - cur.left, cur.w);
  }
  function gCancel(e: PointerEvent) { if (g && e.pointerId === g.id) { g = null; showHud(null); } }
  function handleTap(x: number, w: number) {
    if (locked) { showLockBtn(); return; }
    if (menu || help || extPanel) { menu = ''; help = false; extPanel = false; return; }
    if (phoneUi && showXray) { closeCastInfo(); return; } // phones: a tap outside Cast & info closes it, like any panel
    const zone = zoneOf(x, w), r = registerTap(tapState, Date.now(), zone);
    tapState = r.state;
    clearTimeout(pendingTap);
    if (r.kind === 'seek') { seekBy(r.by, true); showRipple(zone, r.total); wake(); }
    else if (zone === 'center') toggleControls();
    else pendingTap = setTimeout(toggleControls, TAP_WINDOW + 20); // maybe the first half of a double tap
  }
  // lock: hides all controls and turns gestures off until the lock icon is held for 0.6 s
  function showLockBtn() { lockHint = true; clearTimeout(lockT); lockT = setTimeout(() => (lockHint = false), 3000); }
  // phones: every panel closes (its Back entry comes off with it)
  function lockNow() { locked = true; menu = ''; if (phoneUi) { extPanel = false; if (xray) closeCastInfo(); } flash(tr('player.lock.locked'), 2500); showLockBtn(); }
  let unlockT: ReturnType<typeof setTimeout>, unlockedAt = 0;
  function unlockDown() { lockHold = true; clearTimeout(unlockT); unlockT = setTimeout(() => { lockHold = false; locked = false; lockHint = false; unlockedAt = Date.now(); wake(); flash(tr('player.lock.unlocked'), 900); }, 600); }
  function unlockUp() { if (lockHold) { lockHold = false; clearTimeout(unlockT); flash(tr('player.lock.hold'), 1500); showLockBtn(); } }
  function lockKey(e: KeyboardEvent) { if (locked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); locked = false; lockHint = false; unlockedAt = Date.now(); wake(); flash(tr('player.lock.unlocked'), 900); } }

  const syncTime = () => {
    if (!video || handedOff || swapping) return; // remote: the position comes from the engine's session; a swap holds the old position
    current = video.currentTime; duration = Number.isFinite(video.duration) ? video.duration : duration;
    if (current > 0 && !reconnecting && !error) lastPos = current;
    if ((rec.networkTries || rec.mediaRecovered) && current > errPos + 8) rec = { ...freshRecovery(), avoided: rec.avoided }; // stable again: new error budget
    const b = video.buffered; buffered = b.length ? b.end(b.length - 1) : 0;
  };
  /** progress report that does not depend on timers (those are throttled in background tabs / Picture-in-Picture) */
  const reportTick = () => { if (!handedOff && started && !stopped && Date.now() - lastSent >= 10_000) send('progress'); };
  const onPlay = () => {
    if (handedOff) return; // the engine's element (also after this Player unmounted)
    fxEngine?.resume(); if (fxActive(fx) && !fxEngine?.routed) void applyFx(true); paused = false; if (stopped) { stopped = false; started = false; } if (!started) { started = true; send('start'); } else send('progress'); };

  /**
   * Direct play has no fragments: the bandwidth sample is the file's own transfers from the Resource Timing buffer
   * (bytes of the response body over the time from first to last byte; transfers the browser throttled by itself make it a lower bound).
   */
  function sampleDirect() {
    if (mode !== 'direct' || !info?.directUrl) return;
    for (const e of performance.getEntriesByName(new URL(info.directUrl, location.href).href, 'resource') as PerformanceResourceTiming[]) {
      if (e.startTime <= directSeen) continue;
      directSeen = Math.max(directSeen, e.startTime);
      est.add(e.encodedBodySize || e.transferSize, e.responseEnd - e.responseStart);
    }
  }

  onMount(() => {
    // iOS / iPadOS ignore a volume set from script (only the hardware buttons change it): no volume swipe and no volume button there
    if (video) volOk = volumeSettable(video);
    coarse = matchMedia('(pointer: coarse)').matches;
    tvUi = tvMode();
    const tvObs = new MutationObserver(() => { tvUi = tvMode(); });
    tvObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    phone = coarse && !tvMode();
    const narrow = matchMedia('(max-width: 720px)'), setIcon = () => (ICON = narrow.matches ? 28 : 36);
    setIcon(); narrow.addEventListener?.('change', setIcon);
    try { const v = parseVolume(localStorage.getItem('ff_vol')); if (video && v !== null) { volume = v; video.volume = v; } } catch { /* ignore */ }
    // a party plays here, in sync: a cast still running from an earlier title would be a second live stream
    if (partyMode && get(castSession)) void castEngine.stop();
    const attached = attachToCast();
    if (!attached) load(startAt);
    castOff = onCastEvent(handleCast);
    if (!partyMode) void initCast();
    if (!attached) void initAirPlay();
    loadBookmarks();
    if ($serverCaps.chapters) api(`/api/items/${itemId}/chapters`).then((r) => (chapters = r?.supported ? normalizeChapters(r.chapters) : [])).catch(() => undefined);
    if ($serverCaps.segments.length) api(`/api/items/${itemId}/segments`).then((r) => (segments = (r.segments as typeof segments).map((x) => ({ ...x, type: String(x.type).toLowerCase() })).filter((x) => segmentShown($serverCaps, x.type)))).catch(() => undefined);
    progressTimer = setInterval(() => { if (started && !stopped) send('progress'); }, 10_000);
    pipOk = Boolean(document.pictureInPictureEnabled) && !video?.disablePictureInPicture;
    // every 5 s: direct-play bandwidth sample + step-up check; every 30 s the estimate is remembered
    abrTimer = setInterval(() => {
      sampleDirect();
      sampleFrames();
      if (!abr || handedOff || airOn || airInfo || switching || !started || stopped || paused || waiting || reconnecting || error) return;
      applyAbr(abr.onTick({ estimate: est.estimate, bufferSec: Math.max(0, buffered - current) }));
    }, 5000);
    bwTimer = setInterval(persistEstimate, 30_000);
    activityTimer = setInterval(() => {
      tick = Date.now();
      // renew the token before it expires (the AirPlay token stream before the hand-off; afterwards the engine renews)
      if (airInfo && !airState.busy && airInfo.expiresAt - tick < 10 * 60_000) void air?.refresh();
      if (sleepAt) {
        if (tick >= sleepAt) { sleepAt = 0; sleepMin = 0; doPause(); flash(tr('player.sleep.paused'), 3000); }
        else sleepLeft = fmtClock((sleepAt - tick) / 1000);
      }
    }, 500);
    // after the hand-off the engine has its own pagehide (keepalive stop + revoke): nothing of that session is touched here
    const bye = () => { persistEstimate(); reportTiming(); if (handedOff) return; if (!stopped) { stopped = true; send('stop', true); } if (airInfo) castRevoke(airInfo); };
    // keep the resume position safe when the tab is hidden / the phone locks (Picture-in-Picture keeps playing: only a progress report, no stop)
    const vis = () => { if (document.visibilityState === 'hidden' && started && !stopped && !handedOff) send('progress', true); };
    const online = () => { if (reconnecting) retryNow(resumePos()); };
    const pipOn = () => { inPip = true; }, pipOff = () => { inPip = false; };
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', vis);
    // Fire TV: Home hides the page; pause so no sound keeps playing behind the launcher (no-op elsewhere)
    // the visibility handler above already sent the (keepalive) progress report: the pause it causes sends none
    const stopHidden = pauseWhenHidden(() => { if (handedOff || !video) return; wantAutoplay = false; if (!video.paused) { hiddenPause = true; video.pause(); } });
    video?.addEventListener('enterpictureinpicture', pipOn); video?.addEventListener('leavepictureinpicture', pipOff);
    const fs = () => {
      fullscreen = Boolean(document.fullscreenElement);
      // phones: fullscreen = landscape (refused on desktop / iOS / without a gesture: ignore)
      if (!coarse || tvMode()) return;
      const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      try { if (fullscreen) void so.lock?.('landscape')?.catch(() => undefined); else so.unlock?.(); } catch { /* ignore */ }
    };
    window.addEventListener('pagehide', bye);
    document.addEventListener('fullscreenchange', fs);
    window.addEventListener('click', onOutsideClick, true);
    window.addEventListener('ff-remote', onRemote);
    const touched = () => { noteInteraction(); fxGesture(); };
    window.addEventListener('pointerdown', touched, true); window.addEventListener('keydown', touched, true); window.addEventListener('ff-remote', touched);
    window.addEventListener('keydown', unmuteOnGesture, true);
    window.addEventListener('pointerdown', unmuteOnGesture, true);
    return () => {
      tvObs.disconnect();
      window.removeEventListener('pointerdown', touched, true); window.removeEventListener('keydown', touched, true); window.removeEventListener('ff-remote', touched);
      window.removeEventListener('pagehide', bye); document.removeEventListener('fullscreenchange', fs); window.removeEventListener('click', onOutsideClick, true);
      window.removeEventListener('online', online); document.removeEventListener('visibilitychange', vis);
      stopHidden();
      video?.removeEventListener('enterpictureinpicture', pipOn); video?.removeEventListener('leavepictureinpicture', pipOff);
      narrow.removeEventListener?.('change', setIcon);
      window.removeEventListener('ff-remote', onRemote); window.removeEventListener('keydown', unmuteOnGesture, true); window.removeEventListener('pointerdown', unmuteOnGesture, true);
    };
  });
  onDestroy(() => {
    postFireTv('keepAwake:0');
    pnlObs?.disconnect();
    cancelFirstFrame();
    clearTimeout(peekT); clearTimeout(posterT); clearTimeout(spT); clearTimeout(probeT); clearTimeout(swapT); fxEngine?.destroy();
    persistEstimate(); clearInterval(abrTimer); clearInterval(bwTimer); clearTimeout(stallT);
    clearInterval(progressTimer); clearInterval(activityTimer); clearTimeout(toastTimer); clearTimeout(retryT); clearTimeout(spinT); clearTimeout(pendingTap); clearTimeout(hudT); clearTimeout(rippleT); clearTimeout(lockT); clearTimeout(unlockT); nowPlaying.set(null);
    if (!handedOff && started && !stopped) { stopped = true; send('stop'); }
    reportTiming(); // also a start the viewer gave up on (no first frame yet)
    holdPrefetch(Promise.resolve(lastStop)); // no cached info survives the player; the next prefetch waits for this stop (resume position)
    if (preparedFor) releaseNext(); // the next episode's warm-up: taken by its player within the grace, else stopped
    destroyed = true;
    mediaBind?.release(); mediaBind = null;
    clearTimeout(credOutT);
    // a handed-over cast keeps running (the engine owns token, element, controller and probe); otherwise AirPlay ends here
    if (!handedOff) { air?.destroy(); airProbe?.remove(); } // revokes a live AirPlay token
    airInfo = null;
    castOff?.();
    hls?.destroy();
  });
</script>

<svelte:window bind:innerWidth={winW} bind:innerHeight={winH} on:keydown={onKey} on:keydown|capture={onBackCapture} />
<div class="stage {subClasses($prefs.subtitleStyle)}" class:idle={!showUi && credits !== 'corner'} class:locked class:pre={posterOn} class:phone={phone && !phoneUi} class:pui={phoneUi} class:port={phoneUi && orient === 'portrait'} class:desk class:dpause={deskPause} class:dmo={deskMotion} class:ppause={phonePause} class:pmo={phoneMotion} class:cred={credits === 'corner'} class:credout={credOut} class:cmo={credMotion} class:rmt={Boolean(tvSession)} class:aconn style="--inset:{inset}px{barVar}{pnlVar}{picVar}" bind:this={stage} bind:clientWidth={stW} bind:clientHeight={stH} on:mousemove={(e) => { if (Date.now() - lastTouch > 800 && !(e.target as Element).closest?.('.dps')) wake(); }} on:click={onSurfaceClick} on:wheel|nonpassive={onWheel} on:focusin={onStageFocus} on:focusout={onStageFocus} on:keydown={() => {}}
  on:pointerdown={gDown} on:pointermove={gMove} on:pointerup={gUp} on:pointercancel={gCancel} role="presentation">
  <!-- the page heading (WCAG 1.3.1 / 2.4.6): the title, for heading navigation; the visible title block is styled text -->
  {#if !tvSession}<h1 class="sr-only">{barTitle || title}</h1>{/if} <!-- the remote screen has the page's one h1 -->
  <!-- svelte-ignore a11y_media_has_caption -->
  {#key videoGen}
  <video bind:this={video} playsinline crossorigin="use-credentials" poster={swapShot || undefined} style:filter={brightness < 1 ? `brightness(${brightness})` : null}
    on:error={onVideoError}
    on:play={onPlay} on:pause={() => { postFireTv('keepAwake:0'); if (handedOff || swapping) return; paused = true; resetStall(); restorePlainSoon(); const quiet = hiddenPause; hiddenPause = false; if (!castBusy && !stopped && !quiet) send('progress'); }} on:seeked={() => { if (swapping) return; timing.seeked(video?.paused ?? true); if (!handedOff && started) send('progress'); }}
    on:ended={() => { postFireTv('keepAwake:0'); if (handedOff) return; stopped = true; paused = true; send('stop'); }}
    on:timeupdate={() => { syncTime(); reportTick(); }} on:progress={syncTime} on:loadedmetadata={() => { reapplyRate(video, rate, partyMode); syncTime(); }}
    on:waiting={onWaiting} on:seeking={() => { if (swapping) return; resetStall(); timing.seeking(); }} on:playing={onPlaying} on:loadeddata={firstFrame} on:canplay={() => { if (handedOff) return; waiting = false; if (wantAutoplay) { wantAutoplay = false; playSafe(); } }}
    on:volumechange={() => { if (video) { muted = video.muted; } }}
    on:play on:pause on:seeked on:seeking on:waiting on:playing on:canplay on:timeupdate on:ended>
    {#if info}{#each info.subtitles as s}<track id="sub-{s.index}" kind="subtitles" src={s.url} srclang={s.language?.slice(0, 2) ?? 'xx'} label={s.title} />{/each}{/if}
  </video>
  {/key}
  {#if posterOn && poster}
    <!-- pointer-events: none -> clicks, double clicks, wheel and gestures reach the stage as over the video -->
    <div class="poster ff-poster" class:out={posterOut} aria-hidden="true">
      {#if posterKind === 'Backdrop'}<img src={backdrop(poster.id, 1280)} srcset={srcset('Backdrop', poster.id, HERO_WIDTHS)} sizes="100vw" alt="" fetchpriority="high" on:error={() => posterFail++} />
      {:else if posterKind === 'Primary'}<img src={img(poster.id, 1280)} alt="" fetchpriority="high" on:error={() => posterFail++} />{/if}
      <div class="pshade"></div>
      <div class="pcap">{#if barTitle || title}<b>{barTitle || title}</b>{/if}{#if barSub}<span>{barSub}</span>{/if}<i class="pbar"><i></i></i></div>
    </div>
  {/if}

  <div class="sr" aria-live="polite" aria-atomic="true">{live}</div>
  {#if error}
    <div class="center errov" role="alertdialog" aria-labelledby="perr-t" aria-describedby="perr-d">
      <div class="errbox ui" on:click|stopPropagation on:keydown|stopPropagation role="presentation">
        <b id="perr-t">{errTitle}</b><p id="perr-d">{error}</p>
        <div class="flex"><button class="btn light go" data-autofocus on:click={retryManually}>{$t('player.error.retry')}</button><button class="sec" on:click={leave}>{$t('player.error.back')}</button></div>
      </div>
    </div>
  {:else if reconnecting}
    <div class="center" role="status"><div class="reco ui"><div class="spin sm"></div><span>{$t('player.reconnecting')}</span><small>{$t('player.attempt', { n: reconnecting, max: MAX_NETWORK_TRIES })}</small></div></div>
  {:else if spin && waiting && !remote && !posterOn && !ccOn}<div class="center" role="status" aria-label={$t('player.loading')}><div class="spin"></div></div>
  {:else if (posterOn && !posterOut && !remote) || (spin && waiting && !remote && !posterOn)}<div class="sr" role="status">{$t('player.loading')}</div>{/if}
  {#if tvSession}
    <!-- the cast engine plays this title on the TV (also after this page): the player is its remote (lib/cast/RemoteScreen.svelte) -->
    <RemoteScreen on:close={() => dispatch('back')} on:pick={(e) => openPlayOn(e.detail)} />
  {:else if airPh === 'connecting'}
    <!-- the tap's token is on its way, or a TV was picked and has not played yet: the layout overlays (see AirPlayConnecting) -->
  {:else if airOn || airState.error}
    <!-- Safari does not tell which receiver was picked; ending AirPlay happens in its picker (choose this device).
         Also while `ready` (no TV yet) when a token request failed: Retry, the src stays as it is (no restore loop) -->
    <div class="center castov" role="status" data-testid="airplay-active"><div class="castbox">
      <Icon name="airplay" size={56} />
      {#if airState.error}
        {#if airForbidden}<b>{$t('ui.error.castForbidden')}</b><span class="airhint">{$t('player.airplay.endHint')}</span>
        {:else}<b>{$t('player.airplay.failed')}</b><span class="airhint">{$t('player.airplay.endHint')}</span>
        <button class="btn light ui" on:click|stopPropagation={() => air?.retry()}>{$t('player.error.retry')}</button>{/if}
      {:else}<b>{$t('player.airplay.playing')}</b>{/if}
      <button class="btn light ui" on:click|stopPropagation={() => air?.pick()}>{$t('player.airplay.change')}</button>
    </div></div>
  {:else if airState.ready}
    <!-- the token stream is on the element; the picker may not have opened (no gesture after the await): open it from this tap -->
    <div class="center airready" role="status" data-testid="airplay-ready"><div class="castbox">
      <Icon name="airplay" size={40} />
      <span class="airhint">{$t('player.airplay.chooseHint')}</span>
      <button class="btn light ui" on:click|stopPropagation={() => air?.pick()}>{$t('player.airplay.choose')}</button>
    </div></div>
  {/if}
  {#if aconn}<AirPlayConnecting art={airArt} onCancel={() => air?.cancel()} />{/if}
  {#if !phone && !tvUi && paused && !deskPause && credits !== 'corner' && !waiting && !error && !remote && !locked && !reconnecting}
    <button class="bigplay ui" aria-label={$t('player.controls.play')} on:click|stopPropagation={togglePlay}><Icon name="play" size={44} /></button>
  {/if}
  {#if toast}<div class="toast" aria-hidden="true">{toast}</div>{/if}
  {#if ripple}
    {#key ripple.n}<div class="rip {ripple.zone}" aria-hidden="true"></div>{/key}
    <div class="riplbl {ripple.zone}" aria-hidden="true"><Icon name={ripple.zone === 'left' ? 'rewind10' : 'forward10'} size={34} /><b>{$t('common.duration.s', { s: ripple.total })}</b></div>
  {/if}
  {#if hud}
    <div class="hud" aria-hidden="true"><Icon name={hud.icon} size={26} /><span>{hud.text}</span><i style="--p:{Math.max(0, Math.min(100, hud.pct))}%"></i></div>
  {/if}
  {#if coarse && !tvMode() && !remote && (locked ? lockHint : showUi && !phone)}
    <button class="lockbtn ic" class:holding={lockHold} aria-label={locked ? $t('player.lock.unlockAria') : $t('player.lock.lockAria')}
      on:pointerdown|stopPropagation={() => (locked ? unlockDown() : undefined)} on:pointerup|stopPropagation={unlockUp} on:pointercancel={unlockUp} on:pointerleave={unlockUp}
      on:keydown={lockKey} on:click|stopPropagation={() => { if (!locked && Date.now() - unlockedAt > 1000) lockNow(); }} on:contextmenu|preventDefault>
      <Icon name={locked ? 'lock' : 'unlock'} size={26} />
    </button>
  {/if}
  {#if help}
    <div class="help ui" role="dialog" aria-modal="true" aria-label={$t('player.shortcuts.title')} tabindex="-1" on:click|stopPropagation={() => (help = false)} on:keydown|stopPropagation>
      <div class="hbox" on:click|stopPropagation on:keydown|stopPropagation role="presentation">
        <header><b>{$t('player.shortcuts.title')}</b><button class="icx" data-autofocus aria-label={$t('common.close')} on:click={() => (help = false)}><Icon name="x" size={20} /></button></header>
        <dl>{#each SHORTCUTS as s}<dt><kbd>{s.kKey ? $t(s.kKey) : s.k}</kbd></dt><dd>{$t(s.d)}</dd>{/each}</dl>
      </div>
    </div>
  {/if}

  <!-- overlays from the page (back button, next episode card, party chat/reactions) -->
  <div class="ovl" class:hide={!showUi} class:withchip={phoneChip && !phoneUi} class:blur={blur && phoneUi}>
    {#if !tvUi}<slot name="top" />{/if}
    {#if phoneUi && !aconn}
      <!-- phone player: quality chip, Cast, AirPlay and lock at the end of the top bar (they leave the pill and More) -->
      <PhoneTopBar {blur} lock={!remote}
        playon={playOnShown ? { on: casting || airOn, busy: airState.busy, open: playOnOpen, label: playOnLabel } : null}
        on:playon={(e) => openPlayOn(e.detail)} on:lock={lockNow}>
        {#if phoneChip && info}<QualityChip bind:open={chipOpen} compact direct={chipDirect} label={rungLabel(info.maxBitrate)} reason={info.transcodeReason ?? 'other'} />{/if}
      </PhoneTopBar>
    {:else if phoneChip && info && !aconn}<div class="qtop"><QualityChip bind:open={chipOpen} compact direct={chipDirect} label={rungLabel(info.maxBitrate)} reason={info.transcodeReason ?? 'other'} /></div>{/if}
  </div>
  {#if phone && !phoneUi && !locked && !error && !reconnecting}
    <!-- phones: play / pause between -10 and +10 in the middle of the picture (shown and hidden with the bar) -->
    <div class="cc" class:hide={!ccOn}>
      <button class="ic ccs" class:locked={!canControl} aria-label={$t('player.controls.back10')} on:click|stopPropagation={() => seekBy(-10)}><Icon name="rewind10" size={34} /></button>
      <button class="ic ccp" class:locked={!canControl} class:busy={spin && waiting && !remote} aria-label={paused ? $t('player.controls.play') : $t('player.controls.pause')} on:click|stopPropagation={togglePlay}><Icon name={paused ? 'play' : 'pause'} size={44} /></button>
      <button class="ic ccs" class:locked={!canControl} aria-label={$t('player.controls.forward10')} on:click|stopPropagation={() => seekBy(10)}><Icon name="forward10" size={34} /></button>
    </div>
  {/if}
  <slot />

  {#if skip && !locked && credits !== 'corner' && !phoneUi}<button class="skipbtn light" class:tv-btn={tvUi} aria-keyshortcuts="S" on:click|stopPropagation={doSkip} in:fly={{ y: 12, duration: desk && motionAllowed() ? 250 : 0, easing: springAt }}>{segText($t, skip.type, 'skip')}{tvMode() ? $t('player.skipOk') : ''}</button>{/if}

  {#if showXray}
    <div class="cihost" class:hide={!showUi && !xray} out:fade={{ duration: phoneUi && motionAllowed() ? 120 : 0 }}><CastInfoPanel data={castData} failed={castFailed} autofocus={infoFocus} on:close={closeCastInfo} /></div>
  {:else if peek && !locked && menu === '' && !remote}
    <CastPeek data={castData} hint={tvMode() ? 'tv' : coarse ? 'none' : 'key'} on:more={() => openCastInfo(false)} />
  {/if}
  <PlayOnSheet open={playOnOpen} trigger={playOnTrigger} at={tvSession ? tvSession.position : current} title={tvSession ? tvSession.title : barTitle || title} episode={tvSession ? (tvSession.isEpisode ? episodeCode(tvSession, item, $t) : '') : playOnEp}
    airplay={airAvail} airplayActive={airOn && !tvSession} sheet={phone} onAirPlay={airRow} onConnected={() => void startCast()} on:close={() => (playOnOpen = false)} on:continued={onContinued} />
  {#if subDlg}
    <div class="dlg ui" data-nav data-scope role="dialog" tabindex="-1" aria-modal="true" aria-label={$t('player.subs.search')} on:click|stopPropagation on:keydown|stopPropagation>
      <header><b>{$t('player.subs.search')}</b><button class="icx" aria-label={$t('common.close')} on:click={() => (subDlg = false)}><Icon name="x" size={20} /></button></header>
      <div class="flex"><select bind:value={subLang} aria-label={$t('player.subs.language')}>{#each SUB_LANGS as l}<option value={l}>{$t(`player.subs.langs.${l}`)}</option>{/each}</select><button disabled={subBusy} on:click={searchSubs}>{$t('player.subs.searchButton')}</button></div>
      {#if subMsg}<p class="muted">{subMsg}</p>{/if}
      {#if subResults?.length}<ul>{#each subResults as r}<li><button class="mi" disabled={subBusy} on:click={() => pickSub(r.id)}><Icon name="download" size={16} /><span class="grow">{r.name}</span><span class="muted">{r.provider}{r.downloads ? ` · ${r.downloads}×` : ''}</span></button></li>{/each}</ul>{/if}
    </div>
  {/if}

  {#if pauseOn}
    <TvPauseScreen title={barTitle || title} sub={tvSub} overview={item?.overview ?? ''} logoId={item ? (item.seriesId ? item.seriesId : item.logo ? item.id : '') : ''} />
  {/if}
  {#if deskPause}
    <DeskPauseScreen title={barTitle || title} sub={tvSub} overview={item?.overview ?? ''} on:castinfo={() => openCastInfo(true)} />
  {/if}
  {#if phonePause}
    <PhonePauseScreen title={barTitle || title} sub={phoneSub(item, $t)} overview={item?.overview ?? ''} {orient} />
  {/if}
  {#if tvUi}
    {#if menu === 'tracks' && (info || tvSession)}
      <TvTracks audio={audioOpts} subs={subOpts} {audioIndex} {subIndex} {fx} fxDisabled={fxDisabled} {surroundShown} {surroundOn} surroundLocked={fxActive(fx)}
        on:surround={() => { wake(); void toggleSurround(); }} on:audio={(e) => { wake(); if (e.detail !== audioIndex) void changeAudio(e.detail); }} on:sub={(e) => { wake(); setSubtitle(e.detail); }} on:fx={(e) => { wake(); toggleFx(e.detail); }} />
    {:else if menu === 'episodes' && seriesId}
      <TvEpisodesOverlay {seriesId} {seasonId} currentId={itemId} seriesName={barTitle} on:pick={pickEpisode} on:close={() => { menu = ''; focusControls(); }} />
    {/if}
    <TvControls shown={showUi && !(posterOn && !posterOut) && menu !== 'tracks' && menu !== 'episodes'} title={barTitle || title} sub={tvSub} {paused} {current} {duration} {buffered} preview={sp} trickplay={info?.trickplay} {chapters}
      buttons={tvButtons} airplay={air && (airState.available || airOn || airState.ready || airState.busy) ? { on: airOn, label: $t(airOn ? 'player.airplay.playing' : 'player.airplay.play') } : null} {menu} {rate} qualities={qualityOptions} quality={shownQ} {canControl} inert={credits === 'corner'} bind:height={ctlH}
      on:keydown={ctlKey} on:back={() => dispatch('back')} on:button={(e) => tvButton(e.detail)} on:speed={(e) => setRate(e.detail)} on:quality={(e) => void changeQuality(e.detail)} on:airplay={() => air?.pick()} />
  {:else}
  <div class="ui ctl" data-nav inert={credits === 'corner'} bind:offsetHeight={ctlH} class:hide={!showUi || (posterOn && !posterOut)} class:blur class:dock={phoneUi} on:click|stopPropagation on:keydown={ctlKey} role="toolbar" tabindex="-1" aria-label={$t('player.controls.toolbar')}>
    {#if desk}
      <!-- desktop: chapter eyebrow, title, episode line above the timeline -->
      <div class="ttlblock" class:off={menu !== ''} bind:offsetHeight={ttlH}>
        {#if nowChapter}<em>{nowChapter}</em>{/if}
        <b title={barTitle || title}>{barTitle || title}</b>
        {#if barSub}<span>{barSub}</span>{/if}
      </div>
    {:else if phoneUi}
      <!-- phone: chapter, title and episode line; the skip button at the row's end (landscape) or below (portrait) -->
      <PhoneTitle chapter={nowChapter} title={barTitle || title} sub={phoneSub(item, $t)} {orient} hidden={menu !== '' || showXray || extPanel || chipCrowds}>
        <svelte:fragment slot="skip">
          {#if skip && !locked && credits !== 'corner'}<button class="skipbtn light" aria-keyshortcuts="S" on:click|stopPropagation={doSkip} in:fly={{ y: 12, duration: motionAllowed() ? 250 : 0, easing: springAt }} out:fade={{ duration: motionAllowed() ? 150 : 0 }}>{segText($t, skip.type, 'skip')}</button>{/if}
        </svelte:fragment>
      </PhoneTitle>
    {/if}
    <div class="timeline" class:tlrow={desk || phoneUi} bind:offsetHeight={tlH}>
      {#if phone && !phoneUi}<span class="cur" aria-hidden="true">{fmtClock(shown)}</span>{/if}
      {#if desk || phoneUi}<span class="el" aria-hidden="true">{fmtClock(shown)}</span>{/if}
      <div class="track" bind:this={trackEl} class:locked={!canControl} class:scrub={scrubbing} role="slider" tabindex="0" aria-label={$t('player.positionLabel')} aria-valuemin="0" aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(shown)}
        aria-valuetext={$t('player.valueText', { a: fmtClock(shown), b: fmtClock(duration) })}
        on:pointermove={onTrackMove} on:pointerleave={() => (hoverX = -1)} on:pointerdown={onTrackDown} on:pointerup={onTrackUp} on:pointercancel={onTrackUp} on:keydown={onTrackKey}>
        <!-- desktop: .bars is the rail; it and the bars on it grow 3 → 6 px by scaleY (transform only), knob, bookmarks and tip stay unscaled -->
        {#if desk || phoneUi}<div class="bars"></div>{/if}
        <div class="buf" style="width:{bufPct}%"></div>
        {#each segments as sg}{#if duration && sg.end > sg.start}<span class="seg {sg.type}" style="left:{(sg.start / duration) * 100}%;width:{((sg.end - sg.start) / duration) * 100}%" title={segText($t, sg.type, 'segment')} aria-hidden="true"></span>{/if}{/each}
        <div class="played" style="width:{pct}%"></div>
        {#each marks as m (m.i)}<span class="chap" style="left:{m.pct}%" aria-hidden="true"></span>{/each}
        {#each bookmarks as bm}{#if duration}<span class="mark" style="left:{(bm.position / duration) * 100}%" title="{fmtClock(bm.position)}{bm.note ? ' – ' + bm.note : ''}"></span>{/if}{/each}
        <div class="knob" style="left:{pct}%"></div>
        {#if hoverX >= 0}
          <div class="tip" style="left:{tipLeft}px">
            {#if tipChapter}<span class="chn">{tipChapter}</span>{/if}
            {#if thumb}<div class="thumb" style="width:{thumb.w}px;height:{thumb.h}px"><div style="width:{thumb.sw}px;height:{thumb.sh}px;background-image:url({thumb.url});background-size:{thumb.bw}px {thumb.bh}px;background-position:-{thumb.x}px -{thumb.y}px;transform:scale({thumb.k});transform-origin:0 0"></div></div>{/if}
            {fmtClock(scrubbing ? scrubTime : hoverTime)}
          </div>
        {/if}
      </div>
      {#if desk || phoneUi}
        <span class="rem" role="timer" aria-label={duration ? $t('player.controls.remaining', { time: fmtClock(Math.max(0, duration - shown)) }) : undefined}>{duration ? `−${fmtClock(Math.max(0, duration - shown))}` : '–'}</span>
      {:else}
        <span class="rem" aria-hidden="true">{duration ? `${phone ? '−' : ''}${fmtClock(Math.max(0, duration - shown))}` : '–'}</span>
      {/if}
    </div>
    <div class="row" bind:offsetHeight={rowH}>
      <div class="grp" class:pill={desk || phoneUi} class:lp={phoneUi} role={phoneUi ? 'group' : undefined} aria-label={phoneUi ? $t('player.phone.playback') : undefined}>
        {#if phoneUi}
          <button class="ic" class:locked={!canControl} aria-label={$t('player.controls.back10')} on:click={() => seekBy(-10)}><Icon name="rewind10" size={28} /></button>
          <button class="ic big" class:locked={!canControl} class:busy={spin && waiting && !remote} aria-label={paused ? $t('player.controls.play') : $t('player.controls.pause')} on:click={togglePlay}><Icon name={paused ? 'play' : 'pause'} size={34} /></button>
          <button class="ic" class:locked={!canControl} aria-label={$t('player.controls.forward10')} on:click={() => seekBy(10)}><Icon name="forward10" size={28} /></button>
        {/if}
        {#if !phone}
          <button class="ic" class:big={desk} class:locked={!canControl} aria-label={paused ? $t('player.controls.play') : $t('player.controls.pause')} data-label={desk ? (paused ? $t('player.controls.play') : $t('player.controls.pause')) : undefined} on:click={togglePlay}><Icon name={paused ? 'play' : 'pause'} size={ICON} /></button>
          <button class="ic" class:locked={!canControl} aria-label={$t('player.controls.back10')} data-label={desk ? $t('player.controls.back10') : undefined} on:click={() => seekBy(-10)}><Icon name="rewind10" size={ICON} /></button>
          <button class="ic" class:locked={!canControl} aria-label={$t('player.controls.forward10')} data-label={desk ? $t('player.controls.forward10') : undefined} on:click={() => seekBy(10)}><Icon name="forward10" size={ICON} /></button>
        {/if}
        {#if desk && info && mode && !remote}<QualityChip bind:open={chipOpen} direct={chipDirect} label={rungLabel(info.maxBitrate)} reason={info.transcodeReason ?? 'other'} />{/if}
        {#if !phoneUi && (!phone || volOk) && tvSession?.kind !== 'airplay'}<div class="vol">
          <button class="ic" aria-label={muted ? $t('player.unmute') : $t('player.mute')} data-label={desk ? (muted ? $t('player.unmute') : $t('player.mute')) : undefined} on:click={toggleMute}><Icon name={muted || volume === 0 ? 'volume-off' : volume < 0.5 ? 'volume-low' : 'volume'} size={ICON} /></button>
          {#if !phone}<input class="vslider" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} aria-label={$t('player.volume.label')} on:input={(e) => setVolume(Number(e.currentTarget.value))} />{/if}
        </div>{/if}
        {#if !phone && !desk}<span class="clock">{fmtClock(shown)} / {fmtClock(duration)}</span>{/if}
        {#if info && mode && !remote && !phone && !desk}<QualityChip bind:open={chipOpen} direct={chipDirect} label={rungLabel(info.maxBitrate)} reason={info.transcodeReason ?? 'other'} />{/if}
      </div>
      {#if !phone && !desk}<div class="mid" title={barSub ? `${barTitle} · ${barSub}` : barTitle}>{#if barTitle}<b>{barTitle}</b>{#if barSub}<span>{barSub}</span>{/if}{/if}</div>{/if}
      <div class="grp right" class:pill={desk || phoneUi} class:tp={phoneUi} role={phoneUi ? 'group' : undefined} aria-label={phoneUi ? $t('player.phone.tools') : undefined}>
        <slot name="extra" />
        {#if hasNext && (!phoneUi || tools.includes('next'))}<button class="ic" aria-label={$t('player.controls.next')} data-label={desk ? $t('player.controls.next') : undefined} title={$t('player.controls.nextKey')} on:click={goNext}><Icon name="skip-next" size={ICON} /></button>{/if}
        {#if seriesId}
          <div class="mwrap">
            <button class="ic" bind:this={epBtn} aria-label={$t('player.controls.episodes')} data-label={desk ? $t('player.controls.episodes') : undefined} title={$t('player.controls.episodes')} aria-expanded={menu === 'episodes'} on:click={() => toggleMenu('episodes')}><Icon name="list" size={ICON} /></button>
            {#if menu === 'episodes'}<div class="menu bare" in:cardIn={{ origin: 'bottom right' }} out:cardOut><EpisodesPanel {seriesId} {seasonId} currentId={itemId} synopsis={phoneUi} glass={desk} on:pick={pickEpisode} on:close={closeEpisodes} /></div>{/if}
          </div>
        {/if}
        {#if showScenes}
          <div class="mwrap">
            {#if !coarse}<button class="ic" bind:this={scBtn} aria-label={$t('scenes.chapters.open')} data-label={desk ? $t('scenes.chapters.open') : undefined} title={$t('scenes.chapters.open')} aria-expanded={menu === 'chapters'} on:click={() => toggleMenu('chapters')}><Icon name="film" size={ICON} /></button>{/if}
            {#if menu === 'chapters'}<div class="menu bare" in:cardIn={{ origin: 'bottom right' }} out:cardOut><ScenesPanel {chapters} current={shown} {duration} trickplay={info?.trickplay} on:seek={(e) => { seekTo(e.detail.time); closeScenes(); }} on:close={closeScenes} /></div>{/if}
          </div>
        {/if}
        {#if !phoneUi && playOnShown}<button class="ic" class:on={casting || airOn} class:airbusy={airState.busy} aria-haspopup="dialog" aria-expanded={playOnOpen} aria-busy={airState.busy} data-testid="playon" aria-label={playOnLabel} data-label={desk ? playOnLabel : undefined} title={playOnLabel} on:click={(e) => openPlayOn(e.currentTarget)}><Icon name="cast" size={ICON} /></button>{/if}
        {#if !phoneUi}<button class="ic" class:on={showXray || peek} bind:this={castBtn} aria-label={$t('scenes.info.open')} data-label={desk ? $t('scenes.info.open') : undefined} title={$t(coarse ? 'scenes.info.open' : 'scenes.info.openKey')} aria-pressed={showXray} on:click={castButton}><Icon name="users" size={ICON} /></button>{/if}
        {#if info || tvSession}
          <div class="mwrap">
            <button class="ic" aria-label={$t('player.controls.tracks')} data-label={desk ? $t('player.controls.tracks') : undefined} title={$t('player.controls.tracksKey')} aria-expanded={menu === 'tracks'} on:click={() => toggleMenu('tracks')}><Icon name="subtitles" size={ICON} /></button>
            {#if menu === 'tracks'}
              <div class="menu tracks{deskGlass}" style={deskScrim} data-nav data-scope role="dialog" aria-label={$t('player.controls.tracks')} in:cardIn={{ origin: 'bottom right' }} out:cardOut>
                {#if audioOpts.length > 1}
                  <div><h3>{$t('player.controls.audio')}</h3><div class="opts">
                    {#each audioOpts as a}<button class="mi" class:on={audioIndex === a.index || (audioIndex === undefined && a.isDefault)} on:click={() => { menu = ''; changeAudio(a.index); }}>{#if audioIndex === a.index || (audioIndex === undefined && a.isDefault)}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{a.title}</button>{/each}
                  </div></div>
                {/if}
                <div><h3>{$t('player.subs.title')}</h3><div class="opts">
                  <button class="mi" class:on={subIndex === -1} on:click={() => { setSubtitle(-1); menu = ''; }}>{#if subIndex === -1}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{$t('common.off')}</button>
                  {#if $serverCaps.subtitleSearch && info}<button class="mi" on:click={() => { menu = ''; subDlg = true; subResults = null; subMsg = ''; }}><Icon name="search" size={16} />{$t('player.subs.searchMenu')}</button>{/if}
                  {#each subOpts as s}<button class="mi" class:on={subIndex === s.index} on:click={() => { setSubtitle(s.index); menu = ''; }}>{#if subIndex === s.index}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{s.title}</button>{/each}
                </div></div>
                <div class="fxcol"><h3>{$t('scenes.audio.title')}</h3><div class="opts">
                  {#each FX_OPTS as o (o.k)}<button class="mi fx" class:on={fx[o.k] && !fxDisabled} role="switch" aria-checked={fx[o.k]} disabled={Boolean(fxDisabled)} on:click={() => toggleFx(o.k)}>{#if fx[o.k] && !fxDisabled}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}<span class="fxl">{$t(o.label)}<small>{$t(o.hint)}</small></span></button>{/each}
                  {#if surroundShown}<button class="mi fx" class:on={surroundOn} role="switch" aria-checked={surroundOn} aria-disabled={fxActive(fx) ? 'true' : undefined} class:locked={fxActive(fx)} data-testid="surround-switch" on:click={() => { if (!fxActive(fx)) void toggleSurround(); }}>{#if surroundOn}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}<span class="fxl">{$t('scenes.audio.surround')}<small>{$t(fxActive(fx) ? 'scenes.audio.surroundMode' : 'scenes.audio.surroundHint')}</small></span></button>{/if}
                  {#if fxDisabled}<p class="fxnote">{$t(fxDisabled === 'casting' ? 'scenes.audio.casting' : 'scenes.audio.unsupported')}</p>
                  {:else if fxNote === 'suspended' && fxActive(fx)}<p class="fxnote">{$t('scenes.audio.needsTap', { name: $t(fx.voice ? 'scenes.audio.voice' : 'scenes.audio.night') })}</p>{/if}
                </div></div>
              </div>
            {/if}
          </div>
        {/if}
        {#if !partyMode}
          <div class="mwrap">
            {#if speedBtn}<button class="ic" aria-label={$t('player.speed.aria', { r: speedLabel(rate, $t) })} data-label={desk ? $t('player.speed.aria', { r: speedLabel(rate, $t) }) : undefined} title={$t('player.speed.short')} aria-expanded={menu === 'speed'} on:click={() => toggleMenu('speed')}><Icon name="gauge" size={ICON} />{#if rate !== 1}<span class="ratebadge" aria-hidden="true">{$t('player.speed.rate', { r: rate })}</span>{/if}</button>{/if}
            {#if menu === 'speed'}
              <div class="menu speed{deskGlass}" style={deskScrim} data-nav data-scope role="dialog" aria-label={$t('player.speed.title')} in:cardIn={{ origin: 'bottom right' }} out:cardOut>
                <h3>{#if !speedBtn}<button class="back" aria-label={$t('player.controls.backToMore')} on:click={() => (menu = 'more')}>‹</button>{/if}{$t('player.speed.title')}</h3>
                <div class="speeds" role="group" aria-label={$t('player.speed.short')}>
                  {#each SPEEDS as r}<button class="sp-opt" class:on={rate === r} aria-pressed={rate === r} on:click={() => setRate(r)}><span class="dot" aria-hidden="true"></span>{speedLabel(r, $t)}</button>{/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}
        <div class="mwrap">
          <button class="ic" aria-label={$t('player.controls.more')} data-label={desk ? $t('player.controls.more') : undefined} title={$t('player.controls.more')} bind:this={moreBtn} aria-expanded={menu === 'more' || menu === 'scenes' || menu === 'settings' || moreSub} on:click={() => (menu = menu === '' || (menu !== 'more' && menu !== 'scenes' && menu !== 'settings' && !moreSub) ? 'more' : '')}>
            <svg width={ICON} height={ICON} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
            {#if sleepAt}<span class="sleepdot" title={$t('player.sleep.left', { t: sleepLeft })}></span>{/if}
          </button>
          {#if menu === 'more'}
            <div class="menu more{deskGlass}" style={deskScrim} data-nav data-scope role="dialog" aria-label={$t('player.controls.more')} in:cardIn={{ origin: 'bottom right' }} out:cardOut>
              {#if coarse && !partyMode && (!phoneUi || extras.includes('speed'))}<button class="mi" on:click={() => (menu = 'speed')}><Icon name="gauge" size={20} />{$t('player.speed.title')}{#if rate !== 1}<span class="muted"> · {$t('player.speed.rate', { r: rate })}</span>{/if}<span class="chev" aria-hidden="true">›</span></button>{/if}
              {#if extras.includes('next')}<button class="mi" on:click={goNext}><Icon name="skip-next" size={20} />{$t('player.controls.next')}</button>{/if}
              {#if coarse && showScenes}<button class="mi" on:click={() => (menu = 'chapters')}><Icon name="film" size={20} />{$t('scenes.chapters.open')}<span class="chev" aria-hidden="true">›</span></button>{/if}
              <button class="mi" on:click={() => (menu = 'scenes')}><Icon name="bookmark" size={20} />{$t('player.bookmark.menu')}<span class="chev" aria-hidden="true">›</span></button>
              <button class="mi" class:on={showXray} aria-pressed={showXray} on:click={() => { if (showXray) { menu = ''; closeCastInfo(); } else openCastInfo(tvMode()); }}><Icon name="users" size={20} />{$t('scenes.info.open')}</button>
              {#if phone && !phoneUi && !remote}<button class="mi" on:click={lockNow}><Icon name="lock" size={20} />{$t('player.lock.lockAria')}</button>{/if}
              {#if pipOk && !remote}<button class="mi" class:on={inPip} aria-pressed={inPip} aria-keyshortcuts="P" on:click={() => { menu = ''; void pip(); }}><Icon name="pip" size={20} />{$t('player.controls.pip')}</button>{/if}
              {#if phoneUi && volOk && tvSession?.kind !== 'airplay'}<button class="mi" on:click={toggleMute}><Icon name={muted || volume === 0 ? 'volume-off' : 'volume'} size={20} />{muted ? $t('player.unmute') : $t('player.mute')}</button>{/if}
              {#if phoneUi && !tvSession}<button class="mi" on:click={() => { menu = ''; toggleFullscreen(); }}><Icon name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} size={20} />{fullscreen ? $t('player.controls.exitFullscreen') : $t('player.controls.fullscreen')}</button>{/if}
              <button class="mi" on:click={() => (menu = 'settings')}><Icon name="settings" size={20} />{$t('player.controls.settings')}{#if sleepAt}<span class="muted"> · {$t('player.sleep.left', { t: sleepLeft })}</span>{/if}<span class="chev" aria-hidden="true">›</span></button>
              {#if coarse && !tvMode() && !remote && !airOn && !airState.available && !$castState.available}<p class="modeinfo tvhint" data-testid="tv-hint"><Icon name="tv" size={16} /><span>{$t('player.airplay.tvHint', { url: `${location.host}/tv` })}</span></p>{/if}
              {#if modeLabel}<p class="modeinfo"><Icon name="info" size={16} /><span>{$t('player.mode.label', { mode: modeLabel })}</span></p>{/if}
            </div>
          {:else if menu === 'scenes'}
            <div class="menu scenes{deskGlass}" style={deskScrim} data-nav data-scope role="dialog" aria-label={$t('player.bookmark.scenesAria')} in:cardIn={{ origin: 'bottom right' }} out:cardOut>
              <h3><button class="back" aria-label={$t('player.controls.backToMore')} on:click={() => (menu = 'more')}>‹</button>{$t('player.bookmark.scenes')}</h3>
              <button class="mi" on:click={shareScene}><Icon name="share" size={18} />{$t('player.bookmark.share', { t: fmtClock(shown) })}</button>
              <form class="addnote" on:submit|preventDefault={addBookmark}><input bind:value={noteText} maxlength="140" placeholder={$t('player.bookmark.note')} aria-label={$t('player.bookmark.noteAria')} /><button aria-label={$t('player.bookmark.add')}><Icon name="bookmark" size={18} /></button></form>
              {#each bookmarks as bm (bm.id)}
                <div class="bm"><button class="mi" on:click={() => { seekTo(bm.position); menu = ''; }}><span class="muted">{fmtClock(bm.position)}</span>{bm.note || $t('player.bookmark.title')}</button><button class="icx" aria-label={$t('player.bookmark.remove')} on:click={() => removeBookmark(bm.id)}><Icon name="x" size={16} /></button></div>
              {:else}<p class="muted pad">{$t('player.bookmark.none')}</p>{/each}
            </div>
          {:else if menu === 'settings'}
            <div class="menu tracks{deskGlass}" style={deskScrim} data-nav data-scope role="dialog" aria-label={$t('player.controls.settings')} in:cardIn={{ origin: 'bottom right' }} out:cardOut>
              <div><h3><button class="back" aria-label={$t('player.controls.backToMore')} on:click={() => (menu = 'more')}>‹</button>{$t('player.quality.title')}</h3><div class="opts">
                <button class="mi" class:on={shownQ === 0} on:click={() => changeQuality(0)}>{#if shownQ === 0}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{$t('player.quality.auto')}</button>
                {#each qualityOptions as [label, bps]}<button class="mi" class:on={shownQ === bps} on:click={() => changeQuality(bps)}>{#if shownQ === bps}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{label}</button>{/each}
              </div></div>
              {#if !partyMode}
                <div><h3>{$t('player.sleep.title')}</h3><div class="opts">
                  <button class="mi" class:on={!sleepAt && !sleepAfterEpisode} on:click={() => setSleep(0)}>{#if !sleepAt && !sleepAfterEpisode}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{$t('common.off')}</button>
                  {#each [15, 30, 45, 60] as m}<button class="mi" class:on={sleepMin === m && sleepAt > 0} on:click={() => setSleep(m)}>{#if sleepMin === m && sleepAt > 0}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{$t('common.duration.m', { m })}{#if sleepMin === m && sleepAt > 0}<span class="muted"> ({sleepLeft})</span>{/if}</button>{/each}
                  <button class="mi" class:on={sleepAfterEpisode} on:click={() => setSleep('end')}>{#if sleepAfterEpisode}<Icon name="check" size={16} />{:else}<span class="sp"></span>{/if}{$t('player.sleep.afterEpisodeOption')}</button>
                </div></div>
              {/if}
              {#if !coarse}<div><h3>{$t('player.controls.help')}</h3><div class="opts"><button class="mi" on:click={() => { menu = ''; help = true; }}><Icon name="keyboard" size={16} />{$t('player.shortcuts.menu')}</button></div></div>{/if}
            </div>
          {/if}
        </div>
        {#if !tvSession && !phoneUi}<button class="ic" aria-label={fullscreen ? $t('player.controls.exitFullscreen') : $t('player.controls.fullscreen')} data-label={desk ? (fullscreen ? $t('player.controls.exitFullscreen') : $t('player.controls.fullscreen')) : undefined} title={$t('player.controls.fullscreenKey')} on:click={toggleFullscreen}><Icon name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} size={ICON} /></button>{/if}
      </div>
    </div>
  </div>
  {#if phoneUi}<ProgressLine {pct} shown={!showUi && !locked && credits !== 'corner'} />{/if}
  <!-- one entry for whatever panel is open (a menu, Cast & info opened by the viewer, the page's own): Back closes it -->
  <BackLayer open={phoneUi && (menu !== '' || xray || extPanel)} key="panel" on:back={closePanels} bind:this={menuLayer} />
  {/if}
</div>

<style>
  .stage { position: relative; width: 100%; background: #000; color: #fff; overflow: hidden; user-select: none; -webkit-user-select: none; touch-action: none; -webkit-touch-callout: none; }
  .sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  /* loading poster: the stage takes the page colour while it shows (never a white or black flash), then fades to the video */
  .stage { transition: background-color 300ms ease; }
  .stage.pre { background: var(--bg); }
  .poster { position: absolute; inset: 0; z-index: 1; pointer-events: none; background: var(--bg); opacity: 1; transition: opacity 300ms ease; }
  .poster.out { opacity: 0; }
  .poster img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  .pshade { position: absolute; inset: 0; background: linear-gradient(rgba(0,0,0,.35), rgba(0,0,0,.55) 60%, rgba(0,0,0,.8)); }
  .pcap { position: absolute; left: clamp(1rem, 4vw, 3.5rem); right: clamp(1rem, 4vw, 3.5rem); bottom: clamp(1.5rem, 8vh, 4.5rem); display: flex; flex-direction: column; gap: .35rem; max-width: 60ch; text-shadow: 0 1px 8px rgba(0,0,0,.6); }
  .pcap b { font-size: clamp(1.3rem, 3vw, 2.2rem); line-height: 1.15; }
  .pcap span { color: var(--mut); font-size: clamp(.95rem, 1.6vw, 1.15rem); }
  .pbar { position: relative; display: block; height: 3px; width: min(320px, 70vw); margin-top: .7rem; border-radius: 2px; background: rgba(255,255,255,.22); overflow: hidden; }
  .pbar i { position: absolute; inset: 0 auto 0 0; width: 35%; border-radius: 2px; background: #fff; animation: ff-pbar 1.2s ease-in-out infinite; }
  @keyframes ff-pbar { from { transform: translateX(-100%); } to { transform: translateX(290%); } }
  @media (prefers-reduced-motion: reduce) {
    .poster { transition-duration: 120ms; }
    .pbar i { animation: ff-pbar-calm 1.6s ease-in-out infinite alternate; transform: none; width: 100%; }
    @keyframes ff-pbar-calm { from { opacity: .25; } to { opacity: .7; } }
  }
  .stage :global(button:focus-visible), .stage :global(a:focus-visible), .stage :global([role=slider]:focus-visible) { outline: 3px solid #fff; outline-offset: 2px; --ring-o: 2px; }
  .stage.idle { cursor: none; }
  .stage :global(video) { display: block; width: 100%; height: 100%; max-height: 100%; object-fit: contain; background: #000; }
  /* AirPlay availability probe: rendered (WebKit may skip hidden elements) but invisible and inert */
  .stage :global(video.airprobe) { position: absolute; left: 0; top: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .stage :global(video::cue) { background: rgba(0,0,0,.65); font-size: 1.15em; color: #fff; font-family: sans-serif; }
  .stage.sub-size-s :global(video::cue) { font-size: .9em; }
  .stage.sub-size-m :global(video::cue) { font-size: 1.15em; }
  .stage.sub-size-l :global(video::cue) { font-size: 1.5em; }
  .stage.sub-size-xl :global(video::cue) { font-size: 1.9em; }
  .stage.sub-color-white :global(video::cue) { color: #fff; }
  .stage.sub-color-yellow :global(video::cue) { color: #ffe14d; }
  .stage.sub-color-cyan :global(video::cue) { color: #4de8ff; }
  .stage.sub-color-green :global(video::cue) { color: #6dff7a; }
  .stage.sub-bg-none :global(video::cue) { background: transparent; text-shadow: none; }
  .stage.sub-bg-shadow :global(video::cue) { background: transparent; text-shadow: 0 0 4px #000, 0 0 4px #000, 1px 1px 3px #000; }
  .stage.sub-bg-semi :global(video::cue) { background: rgba(0,0,0,.65); text-shadow: none; }
  .stage.sub-bg-solid :global(video::cue) { background: #000; text-shadow: none; }
  .stage.sub-font-sans :global(video::cue) { font-family: system-ui, sans-serif; }
  .stage.sub-font-serif :global(video::cue) { font-family: Georgia, 'Times New Roman', serif; }
  .stage.sub-font-mono :global(video::cue) { font-family: ui-monospace, Menlo, Consolas, monospace; }
  .center { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; z-index: 3; }
  .spin { width: 62px; height: 62px; border: 5px solid rgba(255,255,255,.25); border-top-color: var(--acc); border-radius: 50%; animation: sp .9s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .spin.sm { width: 34px; height: 34px; border-width: 4px; }
  .errov { background: rgba(0,0,0,.82); pointer-events: auto; z-index: 11; }
  .errbox, .reco { display: grid; justify-items: center; gap: .8rem; text-align: center; max-width: min(460px, 90%); padding: 1.4rem 1.6rem; background: rgba(16,20,24,.92); border: 1px solid #323a43; border-radius: 10px; }
  .errbox b { font-size: 1.3rem; } .errbox p { margin: 0; color: #cfcfcf; } .errbox .flex { display: flex; gap: .6rem; flex-wrap: wrap; justify-content: center; }
  .reco { pointer-events: none; font-weight: 600; } .reco small { color: var(--mut); font-weight: 400; }
  .rip { position: absolute; top: 0; bottom: 0; width: 38%; z-index: 5; pointer-events: none; background: rgba(255,255,255,.2); animation: rip .7s ease-out forwards; }
  .rip.left { left: 0; border-radius: 0 100% 100% 0 / 0 50% 50% 0; } .rip.right { right: 0; border-radius: 100% 0 0 100% / 50% 0 0 50%; }
  @keyframes rip { from { opacity: 1; transform: scale(.7); } to { opacity: 0; transform: scale(1); } }
  .riplbl { position: absolute; top: 50%; transform: translateY(-50%); z-index: 6; pointer-events: none; display: grid; justify-items: center; gap: .1rem; text-shadow: 0 1px 6px #000; }
  .riplbl.left { left: 12%; } .riplbl.right { right: 12%; }
  .hud { position: absolute; top: 12%; left: 50%; transform: translateX(-50%); z-index: 10; display: flex; align-items: center; gap: .6rem; padding: .55rem 1.1rem; border-radius: 999px; background: rgba(0,0,0,.72); font-weight: 600; pointer-events: none; font-variant-numeric: tabular-nums; position: absolute; overflow: hidden; }
  .hud i { position: absolute; left: 0; bottom: 0; height: 3px; width: var(--p); background: var(--acc); }
  /* .ic.lockbtn: .ic (position: relative) comes later in this sheet and would win over a plain .lockbtn */
  .ic.lockbtn { position: absolute; left: max(.8rem, var(--safe-left)); bottom: 8rem; z-index: 10; width: 48px; min-height: 48px; background: rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,.5); }
  .lockbtn.holding { background: var(--acc); }
  .stage.locked { cursor: none; }
  .help { position: absolute; inset: 0; z-index: 13; display: grid; place-items: center; background: rgba(0,0,0,.7); }
  .hbox { width: min(520px, 92vw); max-height: 86%; overflow: auto; background: rgba(16,20,24,.98); border: 1px solid #323a43; border-radius: 10px; padding: 1rem 1.2rem; }
  .hbox header { display: flex; justify-content: space-between; align-items: center; margin-bottom: .6rem; }
  .hbox dl { display: grid; grid-template-columns: max-content 1fr; gap: .45rem 1.2rem; margin: 0; align-items: center; } .hbox dt, .hbox dd { margin: 0; }
  kbd { font: inherit; font-size: .85rem; background: #2b333c; border: 1px solid #4a5560; border-bottom-width: 2px; border-radius: 4px; padding: .1rem .5rem; white-space: nowrap; }
  .seg { position: absolute; top: 0; bottom: 0; background: rgba(255,255,255,.38); pointer-events: none; border-left: 2px solid rgba(255,255,255,.9); border-radius: 2px; }
  .seg.preview { background: rgba(190,120,255,.4); border-left-color: #be78ff; }
  .seg.outro { background: rgba(245,197,24,.45); border-left-color: #f5c518; } .seg.recap { background: rgba(120,170,255,.4); border-left-color: #78aaff; }
  .bigplay { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 96px; height: 96px; border-radius: 50%; background: rgba(0,0,0,.55); border: 3px solid #fff; z-index: 4; }
  .bigplay:hover:not(:disabled) { background: rgba(0,0,0,.75); }
  .castov { background: #000; pointer-events: none; z-index: 2; }
  /* while the cast screen (RemoteScreen) is up it brings its own controls: the player's go away (display, so they leave the tab order too) */
  .stage.rmt :is(.ctl, .ovl, .cc, .skipbtn, .lockbtn, .bigplay, .qtop) { display: none !important; }
  /* the AirPlay connecting layout: only Back (the top slot) stays */
  .stage.aconn :is(.ctl, .cc, .skipbtn, .lockbtn, .bigplay, .qtop) { display: none !important; }
  .castbox { display: grid; justify-items: center; gap: .9rem; text-align: center; color: #fff; }
  .airhint { font-size: .85rem; opacity: .8; max-width: 22rem; }
  .ic.airbusy { opacity: .55; }
  .airready .castbox { background: rgba(0,0,0,.72); padding: 1rem 1.4rem; border-radius: 14px; }
  .airready .airhint { opacity: .95; }
  .castbox button { pointer-events: auto; border: 1px solid #fff; padding: .6rem 1.4rem; }
  .toast { position: absolute; left: 50%; top: 18%; transform: translateX(-50%); background: rgba(0,0,0,.75); padding: .55rem 1.2rem; border-radius: 999px; z-index: 10; font-weight: 600; max-width: 90%; text-align: center; }
  /* sits above the whole control bar box (its transparent gradient padding included, --ctl-h is its measured height) and on top of it in z-order, so no part of the button is covered by the bar */
  .skipbtn { position: absolute; right: calc(var(--pad-x) + var(--inset, 0px)); bottom: calc(var(--ctl-h, 7rem) + .5rem); z-index: 10; /* above the cast info panel (9), which may overlap it in a narrow window */ border: 1px solid #fff; padding: .7rem 1.5rem; }
  .ovl { position: absolute; inset: 0 var(--inset, 0px) auto 0; z-index: 7; pointer-events: none; transition: opacity var(--t-med); }
  .ovl :global(*) { pointer-events: auto; }
  .ovl.hide { opacity: 0; } .ovl.hide :global(*) { pointer-events: none; }

  .ctl { position: absolute; left: 0; right: var(--inset, 0px); bottom: 0; z-index: 8; padding: 3.5rem max(clamp(.6rem, 2.4vw, 2.4rem), var(--safe-right)) .9rem max(clamp(.6rem, 2.4vw, 2.4rem), var(--safe-left)); background: linear-gradient(transparent, rgba(0,0,0,.85)); transition: opacity var(--t-med); }
  .ctl.hide { opacity: 0; pointer-events: none; }
  .timeline { display: flex; align-items: center; gap: 1rem; }
  .track { position: relative; flex: 1; height: 5px; background: rgba(255,255,255,.28); border-radius: 3px; cursor: pointer; touch-action: none; transition: height var(--t-fast); margin: 10px 0; }
  .track::before { content: ''; position: absolute; left: 0; right: 0; top: -20px; bottom: -20px; } /* bigger hit area */
  .track:hover, .track:focus-visible { height: 9px; }
  .track.locked { cursor: not-allowed; }
  .buf { position: absolute; inset: 0 auto 0 0; background: rgba(255,255,255,.35); border-radius: 3px; }
  .played { position: absolute; inset: 0 auto 0 0; background: var(--acc); border-radius: 3px; }
  .knob { z-index: 2; position: absolute; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; background: var(--acc); border-radius: 50%; transform: scale(0); transition: transform var(--t-fast); }
  .track:hover .knob, .track:focus-visible .knob { transform: scale(1); }
  .tip { position: absolute; bottom: 22px; transform: translateX(-50%); background: rgba(16,20,24,.95); padding: .15rem .35rem .2rem; border-radius: 4px; font-size: .85rem; pointer-events: none; text-align: center; }
  .thumb { overflow: hidden; border-radius: 3px; margin: .2rem 0 .25rem; background: #0c1014; }
  .mark { position: absolute; top: -3px; width: 4px; height: 11px; margin-left: -2px; background: #f5c518; border-radius: 2px; pointer-events: none; }
  .ic.on { color: var(--acc); }
  .menu.scenes { min-width: 280px; max-width: 92vw; } .menu.scenes .addnote { display: flex; gap: .4rem; padding: .3rem .6rem .6rem; } .menu.scenes .addnote input { flex: 1; min-width: 0; min-height: 38px; }
  .bm { display: flex; align-items: center; } .bm .mi { flex: 1; } .bm .mi .muted { min-width: 3rem; }
  .icx { background: transparent; padding: 0; width: 44px; min-height: 44px; color: var(--mut); } .icx:hover:not(:disabled) { background: rgba(255,255,255,.12); color: #fff; }
  .pad { padding: .3rem .8rem; }
  .cihost { transition: opacity var(--t-med); } .cihost.hide { opacity: 0; pointer-events: none; } .cihost.hide :global(*) { pointer-events: none; }
  /* chapter starts: small gaps in the seek bar (above buffer/played, below the knob) */
  .chap { position: absolute; top: 0; bottom: 0; width: 3px; margin-left: -1.5px; background: rgba(0,0,0,.85); pointer-events: none; z-index: 1; }
  .chn { display: block; max-width: 220px; margin: .1rem auto .15rem; font-weight: 700; font-size: .82rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fxcol { min-width: 170px; } .mi.fx { white-space: normal; align-items: flex-start; } .mi.fx :global(svg), .mi.fx .sp { margin-top: .2rem; }
  .fxl { display: grid; line-height: 1.25; } .fxl small { color: var(--mut); font-weight: 400; font-size: .78rem; }
  .mi.locked { opacity: .55; cursor: default; }
  .fxnote { margin: .3rem .6rem 0; font-size: .78rem; color: var(--mut); max-width: 220px; }
  .dlg { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 12; background: rgba(16,20,24,.98); border: 1px solid #323a43; border-radius: 10px; padding: 1rem 1.2rem; width: min(520px, 92vw); max-height: 70%; overflow: auto; display: grid; gap: .8rem; }
  .dlg header { display: flex; justify-content: space-between; align-items: center; } .dlg ul { list-style: none; padding: 0; margin: 0; } .grow { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; }
  .sleepdot { position: absolute; top: 10px; right: 10px; width: 9px; height: 9px; border-radius: 50%; background: var(--acc); }
  .rem { min-width: 3.4rem; text-align: right; font-variant-numeric: tabular-nums; }
  /* Control bar: controls left, title centred, extras right */
  .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, auto) minmax(0, 1fr); align-items: center; gap: .6rem; }
  .grp { display: flex; align-items: center; gap: .3rem; flex-wrap: wrap; }
  .grp.right { justify-content: flex-end; }
  .mid { min-width: 0; max-width: 40vw; display: flex; align-items: baseline; justify-content: center; gap: .6rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 1.05rem; }
  .mid b { font-weight: 700; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
  .mid span { color: #d8d8d8; font-weight: 400; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
  .ic { position: relative; background: transparent; padding: 0; width: 56px; min-height: 56px; border-radius: 50%; color: #fff; display: inline-grid; place-items: center; }
  .ic:hover:not(:disabled) { background: rgba(255,255,255,.14); transform: scale(1.08); }
  .ic.locked { opacity: .4; }
  .vol { display: flex; align-items: center; }
  .vslider { width: 0; opacity: 0; transition: width var(--t-med) var(--ease), opacity var(--t-med); padding: 0; min-height: 0; accent-color: var(--acc); background: transparent; border: 0; }
  .vol:hover .vslider, .vol:focus-within .vslider { width: 92px; opacity: 1; margin-right: .6rem; }
  .clock { margin-left: .8rem; font-size: .9rem; color: #e0e0e0; font-variant-numeric: tabular-nums; }
  .ratebadge { position: absolute; right: 2px; bottom: 4px; font-size: .62rem; font-weight: 700; background: var(--acc-fill); color: #fff; border-radius: 3px; padding: 0 .2rem; line-height: 1.3; }
  .menu.bare { padding: 0; background: none; border: 0; box-shadow: none; min-width: 0; }
  .menu.more { min-width: 270px; padding: .4rem .3rem; }
  .menu.more .mi { min-height: 48px; font-size: .98rem; gap: .8rem; }
  .chev { margin-left: auto; font-size: 1.3rem; color: var(--mut); padding-left: .8rem; }
  .modeinfo { display: flex; gap: .5rem; align-items: center; margin: .3rem .6rem .2rem; padding-top: .5rem; border-top: 1px solid #2b333c; color: var(--mut); font-size: .82rem; }
  .modeinfo.tvhint ~ .modeinfo { border-top: 0; padding-top: .2rem; }
  .menu h3 .back { background: transparent; padding: 0; width: 32px; min-height: 32px; margin-right: .3rem; font-size: 1.4rem; line-height: 1; color: #fff; border-radius: 50%; }
  .menu h3 .back:hover:not(:disabled) { background: rgba(255,255,255,.12); }
  .menu.speed { padding: 1rem 1.2rem 1.1rem; min-width: 0; }
  .menu.speed h3 { margin: 0 0 .9rem; }
  .speeds { display: flex; gap: .2rem; position: relative; }
  .speeds::before { content: ''; position: absolute; left: 2.2rem; right: 2.2rem; top: 21px; height: 2px; background: #4f5964; }
  .sp-opt { position: relative; display: grid; justify-items: center; gap: .45rem; min-width: 72px; min-height: 64px; padding: .2rem .3rem; background: transparent; color: #bdbdbd; font-weight: 400; font-size: .85rem; white-space: nowrap; border-radius: 4px; }
  .sp-opt .dot { width: 14px; height: 14px; margin-top: 8px; border-radius: 50%; background: #8a8a8a; }
  .sp-opt.on { color: #fff; font-weight: 700; }
  .sp-opt.on .dot { width: 24px; height: 24px; margin-top: 3px; background: #fff; box-shadow: 0 0 0 4px rgba(255,255,255,.25); }
  .sp-opt:hover:not(:disabled) { background: rgba(255,255,255,.08); color: #fff; }
  .mwrap { position: relative; }
  .menu { position: absolute; right: 0; bottom: 64px; padding: .6rem .3rem; min-width: 190px; z-index: 20; }
  /* the plain card (phones and the older layouts); the desktop's cards are glass (.frost, below) and take its fill and edge */
  .menu:where(:not(.frost)) { background: rgba(16,20,24,.97); border: 1px solid #323a43; border-radius: 6px; box-shadow: 0 12px 30px #000; }
  .menu.tracks { display: flex; gap: 1rem; padding: .8rem; min-width: 360px; max-width: min(94vw, 720px); }
  .menu.tracks > div { flex: 1; min-width: 118px; }
  /* long track lists (many audio / subtitle languages) never grow past the top of the window: the menu is capped to the
     space above the control bar and each column scrolls on its own, its heading staying in view */
  .menu:not(.bare) { max-height: calc(100dvh - var(--menu-gap, 10rem)); overflow-y: auto; overscroll-behavior: contain; }
  .menu.tracks { overflow: hidden; }
  .menu.tracks > div { max-height: calc(100dvh - var(--menu-gap, 10rem) - 1.6rem); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
  .menu.tracks h3 { position: sticky; top: 0; z-index: 1; background: rgba(16,20,24,.97); padding: .2rem 0; }
  .mi { white-space: nowrap; }
  .menu h3 { font-size: 1rem; margin: 0 .6rem .4rem; }
  .mi { display: flex; width: 100%; justify-content: flex-start; align-items: center; gap: .5rem; background: transparent; color: #d2d2d2; font-weight: 400; padding: .35rem .6rem; min-height: 44px; text-align: left; border-radius: 4px; }
  .mi:hover:not(:disabled) { background: rgba(255,255,255,.1); color: #fff; } .mi.on { color: #fff; font-weight: 700; }
  .sp { width: 16px; flex: none; }
  /* TV: bigger targets, strong focus, no volume slider (the TV has its own volume) */
  :global(html.tv) .ic { width: 64px; min-height: 64px; }
  :global(html.tv) .ic:focus-visible { background: rgba(255, 255, 255, .22); transform: scale(1.12); }
  :global(html.tv) .vol { display: none; }
  :global(html.tv) .clock { font-size: 1.1rem; }
  :global(html.tv) .track:focus-visible { height: 12px; outline: none; box-shadow: 0 0 0 4px #fff; }
  :global(html.tv) .mi { min-height: 56px; font-size: 1.05rem; }
  :global(html.tv) .skipbtn { font-size: 1.15rem; }
  /* TV (spec 4): Skip intro / recap is a large .tv-btn bottom right, inside the safe area, above the controls */
  :global(html.tv) .skipbtn.tv-btn { right: var(--tv-safe-x, 5vw); bottom: calc(var(--ctl-h, 7rem) + var(--tv-safe-y, 5vh) + 1rem); border: 0; min-height: 3.5rem; padding: 0 2rem; font-size: 1.375rem; animation: tv-skip-in var(--tv-d-m) var(--tv-emph-out) backwards; }
  @keyframes tv-skip-in { from { opacity: 0; transform: translate3d(0, 16px, 0); } to { opacity: 1; transform: translate3d(0, 0, 0); } }
  @media (max-width: 720px) {
    .clock, .vol .vslider, .mid { display: none; }
    .row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0; }
    .grp { gap: 0; }
    .menu.tracks { flex-direction: column; }
    .menu.tracks > div { max-height: none; overflow: visible; }
    .ic { width: 44px; min-height: 44px; }
    .bigplay { width: 76px; height: 76px; }
    /* phones: panels sit above the control bar across the full width instead of hanging off a button */
    .menu, .menu.tracks, .menu.more, .menu.scenes, .menu.speed, .menu.bare { position: fixed; left: .5rem; right: .5rem; bottom: 8.6rem; min-width: 0; max-width: none; max-height: 60vh; overflow-y: auto; }
    .menu.bare { overflow: visible; }
    .menu.bare :global(.eps), .menu.bare :global(.scn) { width: 100%; max-height: 60vh; }
    .ic.lockbtn { bottom: auto; top: calc(5.5rem + var(--safe-top)); } /* the two-row bar is taller on phones: keep the lock clear of the timeline */
    .speeds { display: grid; grid-template-columns: repeat(3, 1fr); justify-items: center; row-gap: .4rem; } .speeds::before { display: none; } .sp-opt { min-width: 64px; }
  }
  /* touch: every main-bar target is at least 48 px */
  @media (pointer: coarse) { .ic { min-width: 48px; min-height: 48px; } }

  /* ---- phone layout (touch, not TV): the stage fills the screen incl. the safe areas, every control stays inside them ---- */
  .stage.phone { --menu-gap: calc(var(--bar-h, 8.6rem) + var(--safe-top) + 1rem); }
  /* top bar: the page's back button + title, the quality chip on the right */
  .ovl.withchip { display: flex; align-items: stretch; }
  .ovl.withchip > :global(:first-child) { flex: 1; min-width: 0; }
  .qtop { flex: none; display: flex; align-items: center; padding: var(--safe-top) max(.75rem, var(--safe-right)) 0 0; background: linear-gradient(rgba(0,0,0,.8), transparent); }
  /* centre: -10 · play / pause · +10 */
  .cc { position: absolute; left: var(--safe-left); right: calc(var(--safe-right) + var(--inset, 0px)); top: 50%; transform: translateY(-50%); z-index: 8; display: flex; justify-content: center; align-items: center; gap: clamp(1.5rem, 9vw, 3.5rem); pointer-events: none; transition: opacity var(--t-med); }
  .cc .ic { pointer-events: auto; background: rgba(0,0,0,.4); }
  .stage.phone .cc .ccs { width: 60px; min-width: 60px; min-height: 60px; }
  .stage.phone .cc .ccp { width: 76px; min-width: 76px; min-height: 76px; }
  .stage.phone .cc .ic:hover:not(:disabled) { transform: none; background: rgba(0,0,0,.55); }
  .cc.hide { opacity: 0; pointer-events: none; } .cc.hide .ic { pointer-events: none; }
  .ccp.busy::after, .pill .ic.big.busy::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 4px solid rgba(255,255,255,.2); border-top-color: var(--acc); animation: sp .9s linear infinite; pointer-events: none; }
  /* bottom: time · seek bar · time, then one row of evenly spaced icons; reaches the screen edge, padded by the home indicator */
  .stage.phone .ctl { padding: 2rem max(.75rem, var(--safe-right)) calc(.2rem + var(--safe-bottom)) max(.75rem, var(--safe-left)); }
  .stage.phone .timeline { gap: .75rem; min-height: 44px; }
  .stage.phone .cur, .stage.phone .rem { min-width: 3.2rem; font-size: .85rem; font-variant-numeric: tabular-nums; color: #e8e8e8; }
  .stage.phone .rem { text-align: right; }
  .stage.phone .track { margin: 0; }
  .stage.phone .row { display: flex; flex-wrap: nowrap; justify-content: space-evenly; align-items: center; gap: 0; }
  .stage.phone .grp, .stage.phone .vol, .stage.phone .mwrap { display: contents; }
  .stage.phone .ic { width: 48px; min-width: 48px; min-height: 48px; }
  .stage.phone .row .ic:hover:not(:disabled) { transform: none; }
  /* menus and panels: above the bottom bar, inside the safe area */
  .stage.phone .menu, .stage.phone .menu.tracks, .stage.phone .menu.more, .stage.phone .menu.scenes, .stage.phone .menu.speed, .stage.phone .menu.bare {
    position: fixed; left: max(.5rem, var(--safe-left)); right: calc(max(.5rem, var(--safe-right)) + var(--inset, 0px)); bottom: calc(var(--bar-h, 8.6rem) + .25rem);
    min-width: 0; max-width: none; max-height: calc(100dvh - var(--menu-gap)); overflow-y: auto;
  }
  .stage.phone .menu.tracks { flex-direction: column; }
  .stage.phone .menu.tracks > div { max-height: none; overflow: visible; }
  .stage.phone .menu.bare { overflow: visible; }
  .stage.phone .menu.bare :global(.eps), .stage.phone .menu.bare :global(.scn) { width: 100%; max-height: calc(100dvh - var(--menu-gap)); }
  .stage.phone .skipbtn { right: calc(max(.8rem, var(--safe-right)) + var(--inset, 0px)); bottom: calc(var(--bar-h, 7rem) + .5rem); }
  /* locked: the unlock button alone, centred above the home indicator */
  :is(.stage.phone, .stage.pui) .lockbtn { top: auto; left: 50%; transform: translateX(-50%); bottom: calc(1.5rem + var(--safe-bottom)); width: 56px; min-height: 56px; }
  /* casting: the device line moves up, the centre keeps play / ±10 for the receiver */
  :is(.stage.phone, .stage.pui) .castov.center { place-items: start center; padding-top: calc(4.6rem + var(--safe-top)); }
  :is(.stage.phone, .stage.pui) .castbox { grid-auto-flow: column; align-items: center; gap: .7rem; font-size: .9rem; }
  :is(.stage.phone, .stage.pui) .castbox button { padding: .4rem .9rem; min-height: 44px; }
  /* landscape phone: seek row and icons on one line when they fit (else the icons wrap below), tighter spacing = more picture */
  @media (orientation: landscape) and (max-height: 540px) {
    .stage.phone .ctl { display: flex; flex-wrap: wrap; align-items: center; column-gap: .75rem; padding-top: 1.4rem; }
    .stage.phone .timeline { flex: 1 1 20rem; min-width: 0; }
    .stage.phone .row { flex: 0 1 auto; margin-left: auto; justify-content: flex-end; }
    .stage.phone .menu, .stage.phone .menu.tracks, .stage.phone .menu.more, .stage.phone .menu.scenes, .stage.phone .menu.speed, .stage.phone .menu.bare { left: auto; width: min(34rem, calc(100vw - 1rem - var(--safe-left) - var(--safe-right) - var(--inset, 0px))); }
    .stage.phone .menu.tracks { flex-direction: row; overflow: hidden; }
    .stage.phone .menu.tracks > div { max-height: calc(100dvh - var(--menu-gap) - 1.6rem); overflow-y: auto; }
    :is(.stage.phone, .stage.pui) .castov.center { padding-top: calc(3.6rem + var(--safe-top)); }
    .stage.phone .cc .ccs { width: 56px; min-width: 56px; min-height: 56px; }
    .stage.phone .cc .ccp { width: 68px; min-width: 68px; min-height: 68px; }
  }

  /* ---- phone player (pui: touch, not TV, not kids; spec 2026-11-08 block 4 §1): top bar of glass circles, one bottom dock
     (title, timeline, two glass pills) laid out with flex column + gap, so nothing can overlap whatever the title, language or
     rotation. Every side follows its safe-area inset; hiding fades opacity (250 ms), never a cut. ---- */
  .stage.pui { --dock-w: calc(100vw - var(--safe-left) - var(--safe-right) - 32px - var(--inset, 0px)); }
  /* the page's top slot (watch, party): .ovl already holds the safe-area padding and the scrim, so the slot brings neither */
  .stage.pui .ovl > :global(.top) { padding: 0; background: none; flex: 1 1 auto; min-width: 0; }
  /* scrubbing on touch: the 3 px rail keeps a hit area of at least 44 px (3 + 2 × 21) */
  .stage.pui .track::before { top: -21px; bottom: -21px; }
  .stage.pui .ovl { right: 0; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; transition: opacity 250ms ease;
    padding: calc(var(--safe-top) + 8px) calc(var(--safe-right) + 16px + var(--inset, 0px)) 0 calc(var(--safe-left) + 16px); }
  .stage.pui .ovl::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: calc(100% + 72px); z-index: -1; pointer-events: none; background: linear-gradient(rgba(0,0,0,.62), rgba(0,0,0,.25) 60%, transparent); }
  .ctl.dock { right: 0; display: flex; flex-direction: column; gap: 10px; background: none; transition: none;
    padding: 0 calc(var(--safe-right) + 16px + var(--inset, 0px)) calc(var(--safe-bottom) + 12px) calc(var(--safe-left) + 16px); }
  .ctl.dock::before { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: calc(100% + 72px); z-index: -1; pointer-events: none;
    background: linear-gradient(transparent, rgba(0,0,0,.62) 64px, rgba(0,0,0,.72) 60%, rgba(0,0,0,.88)); transition: opacity 250ms ease; }
  /* hidden: the dock box stays (pointer-events off), its parts fade; the skip button stays visible and tappable */
  .ctl.dock.hide { opacity: 1; }
  .ctl.dock > :global(*) { transition: opacity 250ms ease; }
  .ctl.dock.hide::before, .ctl.dock.hide > :global(*:not(.ptitle)), .ctl.dock.hide :global(.ptx) { opacity: 0; }
  .ctl.dock.hide .skipbtn { pointer-events: auto; }
  .ctl.dock .skipbtn { position: static; z-index: auto; min-height: 44px; padding: .6rem 1.1rem; border-radius: 10px; font-weight: 800; white-space: nowrap; }
  .ctl.dock .skipbtn:active:not(:disabled) { transform: none; } /* no press shrink: a tap at its rounded corner must not slip off before the release */
  .ctl.dock .tlrow { gap: 12px; }
  .ctl.dock .tlrow .el, .ctl.dock .tlrow .rem { min-width: 2.9rem; font-size: 12px; font-weight: 600; color: rgba(255,255,255,.85); }
  .stage.pui .knob { transform: scale(1); }
  /* both pills share the row's height (stretch); with many tools (a party adds its own) the buttons give up to 4 px each and,
     when even that does not fit (320 px), the tools pill moves to its own line, end-aligned: never off screen */
  .ctl.dock .row { display: flex; flex-wrap: wrap; align-items: stretch; justify-content: space-between; gap: 8px; }
  .ctl.dock .grp { gap: .15rem; flex-wrap: nowrap; flex: 0 1 auto; min-width: 0; }
  .ctl.dock .pill.tp { margin-left: auto; }
  /* menus hang off the tools pill (position: relative; a blurred pill is their containing block either way) */
  .ctl.dock .pill { position: relative; }
  .ctl.dock .mwrap { display: contents; } /* its button is a flex item of the pill (shrinks with the others) */
  .ctl.dock .pill .ic { flex: 0 1 48px; width: 48px; min-width: 44px; min-height: 48px; }
  .ctl.dock .pill .ic.big { flex: 0 1 56px; width: 56px; min-width: 48px; min-height: 56px; }
  .ctl.dock .ic:hover:not(:disabled) { transform: none; }
  .ctl.dock .pill button.ic::after { display: none; } /* no hover label chips on touch */
  /* panels (spec §2): one glass card directly above the timeline row (its top − 8 px) and below the top bar, scrolling inside
     (--pnl-b / --pnl-h from panelBox, measured on the stage). The tools pill is the cards' containing block (it is positioned, and
     its blur would make it one anyway), so its distance from the stage edges (--pill-*) is taken off. Landscape: the end side,
     at most 380 px wide; portrait: full width minus the side insets. */
  .ctl.dock .menu, .ctl.dock .menu.tracks, .ctl.dock .menu.more, .ctl.dock .menu.scenes, .ctl.dock .menu.speed, .ctl.dock .menu.bare {
    position: absolute; bottom: calc(var(--pnl-b, 0px) - var(--pill-b, 0px)); max-height: var(--pnl-h, 50vh); overflow-y: auto; overscroll-behavior: contain;
    left: auto; right: calc(var(--safe-right) + 16px + var(--inset, 0px) - var(--pill-r, 0px));
    width: min(380px, var(--dock-w)); min-width: 0; max-width: none; }
  .stage.pui.port .ctl.dock :is(.menu, .menu.tracks, .menu.more, .menu.scenes, .menu.speed, .menu.bare) {
    left: calc(var(--safe-left) + 16px - var(--pill-l, 0px)); right: calc(var(--safe-right) + 16px - var(--pill-r, 0px)); width: auto; }
  /* glass card like the desk menus (hairline, 14 px radius; the blur rule is .ctl.blur's). Denser fill than the desk's .62: the
     card sits inside the blurred pill (its backdrop root), so over sharp video the fill carries the contrast */
  .ctl.dock .menu:not(.bare) { background: rgba(20,20,24,.78); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; box-shadow: 0 18px 40px rgba(0,0,0,.55); }
  /* plain section captions: a filled band read as a selected row */
  .ctl.dock .menu.tracks h3 { position: static; background: none; font-size: .85rem; color: var(--mut); }
  /* audio & subtitles: two columns in landscape (the effects below them), sections in portrait; the card scrolls as one */
  .ctl.dock .menu.tracks { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .4rem 1rem; }
  .stage.pui.port .ctl.dock .menu.tracks { grid-template-columns: 1fr; }
  .ctl.dock .menu.tracks > div { min-width: 0; max-height: none; overflow: visible; }
  .ctl.dock .menu.tracks .mi { white-space: normal; overflow-wrap: anywhere; }
  .ctl.dock .menu.bare { overflow: visible; }
  .ctl.dock .menu.bare :global(.eps), .ctl.dock .menu.bare :global(.scn) { width: 100%; max-height: var(--pnl-h, 50vh); border-radius: 14px; border-color: rgba(255,255,255,.12); }
  /* Cast & info (opened from More, or by itself after a pause): the same panel box, never over the top bar, scrolling inside */
  .stage.pui .cihost :global(.ci) { top: auto; bottom: var(--pnl-b, 50%); max-height: var(--pnl-h, 50%); height: auto;
    left: auto; right: calc(var(--safe-right) + 16px + var(--inset, 0px)); width: min(380px, var(--dock-w)); border-radius: 14px; }
  .stage.pui.port .cihost :global(.ci) { left: calc(var(--safe-left) + 16px); right: calc(var(--safe-right) + 16px); width: auto; }
  /* it enters from its own side: from the end side in landscape, rising in portrait; instant without motion (calm, reduced) */
  .stage.pui .cihost :global(.ci) { animation-name: ff-pnl-ci-end; }
  .stage.pui.port .cihost :global(.ci) { animation-name: ff-pnl-ci-up; }
  .stage.pui:not(.pmo) .cihost :global(.ci) { animation: none; }
  @keyframes -global-ff-pnl-ci-end { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: none; } }
  @keyframes -global-ff-pnl-ci-up { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  /* the page's top slot spans the bar's free middle: only its own controls take taps, the rest goes to the picture (double-tap seek) */
  .stage.pui .ovl > :global(.top) { pointer-events: none; }
  .ctl.dock .speeds { display: grid; grid-template-columns: repeat(3, 1fr); justify-items: center; row-gap: .4rem; } .ctl.dock .speeds::before { display: none; } .ctl.dock .sp-opt { min-width: 64px; }
  /* narrow phones (320 px): three tools and the playback pill still fit side by side, every target stays ≥ 44 px */
  @media (max-width: 359px) {
    .ctl.dock .pill { padding: .2rem .1rem; gap: 0; }
    .ctl.dock .pill .ic { flex-basis: 44px; width: 44px; min-width: 44px; min-height: 44px; }
    .ctl.dock .pill .ic.big { flex-basis: 48px; width: 48px; min-width: 48px; min-height: 48px; }
  }
  @media (prefers-reduced-motion: reduce) { .stage.pui .ovl, .ctl.dock::before, .ctl.dock > :global(*) { transition: none; } }

  /* ---- desktop layout (desk: desktop width, not TV / phone / kids; spec 2026-11-08 §1–2) ----
     title block bottom left, the timeline row with both times, then two glass pills (playback left, tools right).
     Motion is transform / opacity only; blur only with full motion (.ctl.blur). */
  /* desktop pause screen: the picture darkens and zooms a little (transform / filter only, no motion in calm mode) */
  .stage.dpause > video { filter: brightness(.35); transform: scale(1.03); }
  .stage.desk.dmo > video { transition: filter 500ms var(--m-emph-out, ease-out), transform 500ms var(--m-emph-out, ease-out); }
  /* phone pause screen: the zoom only; the dimming is the screen's own opacity layer (the brightness gesture owns the inline filter) */
  .stage.ppause > video { transform: scale(1.03); }
  .stage.pui.pmo:not(.cred):not(.credout) > video { transition: transform 500ms var(--m-emph-out, ease-out); }
  /* the skip button that stays with hidden controls fades too: it would sit in the pause screen's text */
  .stage.ppause .ctl.dock.hide > :global(.ptitle) { opacity: 0; }
  .stage.ppause .ctl.dock.hide .skipbtn { pointer-events: none; }
  /* credits sequence (spec 2026-11-08 §4): the picture glides into the top-left corner on a spring and gains rounded corners and a
     shadow; transform / opacity only. Calm mode / reduced motion: no transition; a tripped frame guard: an opacity crossfade instead */
  .stage.cred > video { transform: translate(-27%, -24%) scale(.42); border-radius: 14px; box-shadow: 0 0 0 2.5px rgba(255, 255, 255, .2), 0 24px 64px rgba(0, 0, 0, .6); }
  .stage.cmo > video, .stage.desk.cmo > video { transition: transform 750ms var(--m-spring), border-radius 750ms var(--m-emph-out, ease-out), box-shadow 750ms var(--m-emph-out, ease-out), filter 500ms var(--m-emph-out, ease-out); }
  :global(html.tv-motion-reduced) .stage.cmo > video { transition: none; }
  :global(html.tv-motion-reduced) .stage.cmo.cred > video { animation: ff-cred-fade 300ms ease-out both; }
  :global(html.tv-motion-reduced) .stage.cmo.credout > video { animation: ff-cred-fade-out 300ms ease-out both; }
  @keyframes ff-cred-fade { from { opacity: 0; } to { opacity: 1; } }
  /* same frames under another name: the class swap cred -> credout restarts the animation */
  @keyframes ff-cred-fade-out { from { opacity: 0; } to { opacity: 1; } }
  /* phones (spec 2026-11-08 §4): the picture glides into the top-start corner inside the safe area, its light edge clear of the
     cut-out. Landscape: while `.cred` / `.credout` holds, the video box is cut to the letterboxed picture (same place, same size: the
     swap is invisible), so the light edge frames the picture, not the pillarbox; at scale .42 it sits 12 px past safe-left and
     below safe-top (21% = half the scaled box). --pw / --ph: the picture's box, --sw2 / --sh2: half the stage (set by the script) */
  .stage.pui:not(.port):is(.cred, .credout) > video:not(.airprobe) { position: absolute; width: var(--pw, 100%); height: var(--ph, 100%);
    max-height: none; left: calc(50% - var(--pw, 100%) / 2); top: calc(50% - var(--ph, 100%) / 2); }
  .stage.pui.cred > video { transform: translate(calc(var(--safe-left) + 12px + 21% - var(--sw2, 50vw)), calc(var(--safe-top) + 12px + 21% - var(--sh2, 50vh))) scale(.42); }
  /* portrait: while `.cred` / `.credout` holds, the video box is cut to the letterboxed picture (same place, same size: the swap is
     invisible), so the box - and its light edge - frame the picture; it rises to just below the status bar at scale .92.
     --va: the picture's aspect, --sh2: half the stage height (both set by the script) */
  .stage.pui.port:is(.cred, .credout) > video:not(.airprobe) { position: absolute; left: 0; top: 50%; height: auto; max-height: none;
    aspect-ratio: var(--va, 1.7778); margin-top: calc(-50% / var(--va, 1.7778)); }
  .stage.pui.port.cred > video { transform: translateY(calc(var(--safe-top) + 12px + 46% - var(--sh2, 50vh))) scale(.92); }
  .stage.desk .ctl { display: grid; gap: .7rem; padding: 4.5rem max(clamp(1.5rem, 3vw, 3rem), var(--safe-right)) 1.4rem max(clamp(1.5rem, 3vw, 3rem), var(--safe-left));
    background: linear-gradient(transparent, rgba(0,0,0,.62) 4.5rem, rgba(0,0,0,.72) 60%, rgba(0,0,0,.88)); transition: opacity 250ms ease; }
  .ttlblock { display: grid; gap: .15rem; min-width: 0; max-width: min(60%, 46rem); text-shadow: 0 1px 10px rgba(0,0,0,.5); }
  /* white with a coral bar: coral text sank to 1:1 over a bright frame (WCAG 1.4.3) */
  .ttlblock em { font-style: normal; color: #fff; border-left: 3px solid var(--acc, #ff4f6d); padding-left: .45rem; justify-self: start; font-weight: 700; font-size: .8rem; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ttlblock b { font-size: 2.1em; font-weight: 800; line-height: 1.05; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ttlblock span { color: #e8e8ec; font-size: 1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tlrow { gap: .9rem; }
  .tlrow .el, .tlrow .rem { min-width: 3.4rem; font-size: .9rem; color: #e8e8ec; font-variant-numeric: tabular-nums; }
  .tlrow .el { text-align: left; }
  :is(.stage.desk, .stage.pui) .track, :is(.stage.desk, .stage.pui) .track:hover, :is(.stage.desk, .stage.pui) .track:focus-visible { height: 3px; margin: 14px 0; background: transparent; transition: none; }
  .bars { position: absolute; inset: 0; border-radius: 99px; background: rgba(255,255,255,.22); transform-origin: center; transition: transform 150ms var(--m-emph-out, ease-out); }
  :is(.stage.desk, .stage.pui) .track :is(.buf, .seg, .played, .chap) { transition: transform 150ms var(--m-emph-out, ease-out); }
  :is(.stage.desk, .stage.pui) .track:is(:hover, :focus-visible, .scrub) :is(.bars, .buf, .seg, .played, .chap) { transform: scaleY(2); }
  :is(.stage.desk, .stage.pui) .mark { top: -4px; }
  :is(.stage.desk, .stage.pui) .knob { width: 14px; height: 14px; margin: -7px 0 0 -7px; background: #fff; box-shadow: 0 0 0 3px rgba(255,79,109,.35); }
  .stage.desk .row { display: flex; align-items: center; justify-content: space-between; gap: .8rem; }
  .pill { flex-wrap: nowrap; gap: .15rem; padding: .25rem .4rem; border-radius: 99px; background: rgba(20,20,24,.62); border: 1px solid rgba(255,255,255,.12); }
  .ctl.blur .pill, .ctl.blur.dock .menu:not(.bare) { -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); }
  .pill .ic { width: 48px; min-height: 48px; }
  .pill .ic.big { width: 56px; min-height: 56px; }
  .pill :global(.chipwrap) { margin: 0 .3rem; }
  /* label chip: rises 4 px above the icon on hover / keyboard focus (white, 150 ms) */
  .pill button.ic::after { content: attr(data-label); position: absolute; left: 50%; bottom: calc(100% + 10px); transform: translate(-50%, 4px); padding: .15rem .5rem; border-radius: 5px;
    background: #fff; color: #111; font-size: .75rem; font-weight: 600; line-height: 1.35; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 150ms ease, transform 150ms var(--m-emph-out, ease-out); }
  .pill button.ic:hover::after, .pill button.ic:focus-visible::after { opacity: 1; transform: translate(-50%, 0); }
  .pill:not(.right) > button.ic:first-child::after { left: 0; transform: translate(0, 4px); }
  .pill:not(.right) > button.ic:first-child:hover::after, .pill:not(.right) > button.ic:first-child:focus-visible::after { transform: translate(0, 0); }
  /* the last tool's chip right-aligns: fullscreen, or without it (casting) the last wrapped tool ('Mehr') */
  .pill.right > button.ic:last-child::after, .pill.right > :last-child button.ic::after { left: auto; right: 0; transform: translate(0, 4px); }
  .pill.right > button.ic:last-child:is(:hover, :focus-visible)::after, .pill.right > :last-child button.ic:is(:hover, :focus-visible)::after { transform: translate(0, 0); }
  /* the chip would cover the open menu and the remaining time: hide it while its menu is open (opacity only) */
  .pill button.ic[aria-expanded='true']::after { opacity: 0; }
  /* hover: the icon grows, not the button (its label chip would scale with it) */
  .pill .ic:hover:not(:disabled) { transform: none; }
  .pill .ic > :global(svg) { transition: transform var(--t-fast); }
  .pill .ic:hover:not(:disabled) > :global(svg) { transform: scale(1.08); }
  /* volume: the slider slides out of the pill (transform / opacity), on hover or keyboard focus */
  .pill .vol { position: relative; }
  .pill .vslider, .pill .vol:hover .vslider, .pill .vol:focus-within .vslider { position: absolute; left: calc(100% + .9rem); top: 50%; width: 104px; height: 36px; margin: 0; padding: 0 .7rem;
    border-radius: 99px; background: rgba(20,20,24,.62); border: 1px solid rgba(255,255,255,.12); transition: opacity 150ms ease, transform 200ms var(--m-emph-out, ease-out); }
  .pill .vslider { opacity: 0; transform: translate(-10px, -50%); pointer-events: none; }
  .pill .vol:hover .vslider, .pill .vol:focus-within .vslider { opacity: 1; transform: translate(0, -50%); pointer-events: auto; }
  .pill .vol:hover::after { content: ''; position: absolute; left: 100%; top: 0; bottom: 0; width: 1.2rem; } /* hover bridge to the slider */
  /* panels never cover the title block or the timeline. The tools' cards: glass above their button and above the timeline row;
     the title block fades out while one is open (a wide card can reach it), as on phones. --dpnl-b: from the stage's bottom to
     8 px above the timeline (bottom padding + pill row + gap + timeline + 8 px); a card's bottom is that point measured from its
     button's box (centred in the row). Cast & info, on the title's side: above the title block (--ttl-h, measured), which stays.
     The cards are .frost .frost-menu .frost-safe with the menu scrim (SCRIM_MENU): video nobody sampled sits behind them, so
     rows are white (also on the light pill) and the dimmest text white .9 (lib/glass/tone.ts menuScrim) */
  .stage.desk { --dpnl-b: calc(1.4rem + var(--row-h, 3.5rem) + .7rem + var(--tl-h, 2rem) + 8px); --menu-gap: calc(var(--dpnl-b) + 4.8rem + 8px + var(--safe-top)); }
  .stage.desk .menu { bottom: calc((var(--row-h, 3.5rem) + 100%) / 2 + .7rem + var(--tl-h, 2rem) + 8px); }
  .stage.desk .menu.bare :global(:is(.eps, .scn)) { max-height: min(640px, calc(100dvh - var(--menu-gap))); }
  .stage.desk .cihost :global(.ci) { bottom: calc(var(--dpnl-b) + var(--ttl-h, 5.2rem) + .7rem); }
  .ttlblock { transition: opacity 200ms ease, visibility 0s linear 0s; }
  .ttlblock.off { opacity: 0; visibility: hidden; transition: opacity 200ms ease, visibility 0s linear 200ms; }
  :global(html.m-still) .ttlblock { transition: none; }
  .stage.desk .menu.frost { --mut: rgba(255,255,255,.9); }
  .stage.desk .menu.frost .mi { color: #fff; border-radius: 12px; }
  .stage.desk .menu.frost .mi:is(:hover, :focus-visible):not(:disabled), .stage.desk .menu.frost .sp-opt:is(:hover, :focus-visible):not(:disabled) { background: var(--fr-sel); color: #fff; --mut: #fff; }
  .stage.desk .menu.frost .sp-opt { color: rgba(255,255,255,.9); border-radius: 12px; }
  .stage.desk .menu.frost .sp-opt.on { color: #fff; }
  .stage.desk .menu.frost .modeinfo { border-top-color: rgba(255,255,255,.16); }
  /* the column headings sit on the card (no box of their own): the heading stays, the list under it scrolls */
  .stage.desk .menu.tracks { width: max-content; } /* the columns take their entries' width (up to the card's max-width), no cut labels */
  .stage.desk .menu.tracks > div { flex: 1 1 auto; display: flex; flex-direction: column; overflow: hidden; }
  .stage.desk .menu.tracks h3 { position: static; flex: none; background: none; }
  .stage.desk .menu.tracks .opts { min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
  .stage.desk .skipbtn { right: max(clamp(1.5rem, 3vw, 3rem), var(--safe-right)); bottom: calc(var(--row-h, 3.5rem) + var(--tl-h, 2rem) + .7rem + 1.4rem + 12px); } /* bottom padding + row + gap + timeline + 12 px */
  /* narrow desktop windows (721–960 px): smaller tools, and the tools pill wraps onto its own line (right-aligned) instead of being clipped */
  @media (max-width: 960px) {
    .stage.desk .row { flex-wrap: wrap; row-gap: .5rem; }
    .stage.desk .pill.right { margin-left: auto; }
    .stage.desk .pill .ic { width: 40px; min-width: 40px; min-height: 40px; }
    .stage.desk .pill .ic.big { width: 48px; min-width: 48px; min-height: 48px; }
  }
  @media (prefers-reduced-motion: reduce) { .stage.desk .ctl, .ttlblock, .bars, .stage.desk .track :is(.buf, .seg, .played, .chap), .pill button.ic::after, .pill .vslider { transition: none; } }
</style>
