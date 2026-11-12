<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { goto, replaceState } from '$app/navigation';
  import type Hls from 'hls.js';
  import type { ErrorData } from 'hls.js';
  import { ApiError, getActiveProfile, getCsrf } from '#lib/api';
  import { castCapableBrowser, castState, initCast, onCastEvent } from '#lib/cast';
  import { readHint } from '#lib/cast/resume';
  import PlayOnSheet from '#lib/cast/PlayOnSheet.svelte';
  import RemoteScreen from '#lib/cast/RemoteScreen.svelte';
  import { castEngine, castSession, LiveCastError, liveErrText, type CastSession } from '#lib/cast/engine';
  import { get } from 'svelte/store';
  import { native } from '#lib/native/bridge';
  import { perms } from '#lib/perms';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { kidsMode } from '#lib/kids';
  import { motionAllowed } from '#lib/preview';
  import { isBackKey } from '#lib/spatial';
  import { toast } from '#lib/ui/toast';
  import { watchFirstFrame } from '#lib/player/firstframe';
  import { BRIGHTNESS_MIN, levelFromDrag, registerTap, TAP_WINDOW, zoneOf, type TapState, type Zone } from '#lib/player/gestures';
  import { liveHlsConfig, loadHls } from '#lib/player/hls';
  import { bindPlayerMediaSession } from '#lib/player/mediasession';
  import { CONTROLS_HIDE_MS, CONTROLS_HIDE_TV_MS, createTiming, deviceClass, sendTiming } from '#lib/player/timing';
  import { parseVolume } from '#lib/player/volume';
  import { beat, channels as fetchChannels, clock, nowLines, setLast, stopWatching, watch, type LiveChannel, type LiveList, type Prog, type RunningChannel, type WatchAnswer } from './api';
  import { BANNER_HOLD_MS, bannerVisible } from './banner';
  import { startsLocally } from './castGate';
  import { atEdge, behind, oldestPoint, restartTarget, resumePoint } from './dvr';
  import { minute } from './fade';
  import { pickHeld, type Held } from './held';
  import ChannelPanel from './ChannelPanel.svelte';
  import FullSheet from './FullSheet.svelte';
  import InfoBanner from './InfoBanner.svelte';
  import InfoPanel from './InfoPanel.svelte';
  import { hintKeys, noteKey, seenKeys, type SeenKey } from './keyhints';
  import { resolveLiveKey, type LiveKeyAction } from './livekeys';
  import { liveRemote, type LiveRemote } from './remotekeys';
  import { createLongOk } from './longok';
  import { fromWatchError, lostDelay, nextLost, STALL_LOST_MS, type LiveUi, type LostUi } from './liveState';
  import NumberCard from './NumberCard.svelte';
  import { commitNumber, NUMBER_TIMEOUT_MS, typeDigit, type NumberState } from './numberEntry';
  import { channelOrder, neighbour, type LiveFilter } from './order';
  import { backStep, openPanel as panelAt, panelFilters, panelKey, type PanelKey, type PanelState } from './panel';
  import { progressAt, timeLeft, timeLeftText, watchPath } from './progress';
  import { createSwitcher } from './switcher';

  /**
   * The live player (spec §12, §21), built from the film player's parts: hls.js with the live tuning (liveHlsConfig), volume,
   * gestures (zones), Media Session, the first-frame watchdog, the same control auto-hide (CONTROLS_HIDE_MS). No seek bar: Play/Pause,
   * Von Anfang an (reserved slot), −30 s / +30 s, the LIVE pill, channel ▲/▼, Senderliste (on phones in the info sheet), Programm,
   * volume, fullscreen. The info banner follows each zap at once; one watch goes out 400 ms after the last press. The watch token
   * lives in this component only (never in storage); it is beaten every 20 s (one beat at a time; a beat that outlives its channel is
   * ignored) and stopped (keepalive) on pagehide and close.
   *
   * While the viewer is deliberately behind the edge (paused, rewound, Von Anfang an) hls.js must not pull them back to live: its
   * latency limit (liveMaxLatencyDurationCount 10) applies only at the edge and is lifted while they are behind.
   *
   * A pause is timed from the viewer's press, not from the media `pause` event (the browser fires that a task later); resuming
   * checks the pause against the buffer before it plays.
   *
   * A refused media request (403 / 410 from the gateway) is not taken as lost rights: a 403 also means "another address than the
   * pinned one" (a phone that moved from Wi-Fi to mobile data, Review Focus 4) and a 410 a stream that is gone. The player beats once
   * at once: an answered beat re-pins the token and loading carries on; a beat 410, or a playlist refused again after that, leads to
   * the one new watch (`rewatched`), and that watch's answer decides through fromWatchError (403 / not_found: forbidden, anything
   * else the lost cycle). hls.js handlers belong to one attach (`attachedGen`), so a switch that is refused and keeps the old channel
   * playing keeps that channel's handlers alive. While a switch's watch is out (`startPending`) nothing of the old channel acts:
   * its beat does not go out, its refusals and fatal errors are held (`held`) and run only if the switch is refused and it stays.
   *
   * The two moving indicators reuse the app's global keyframes instead of their own: the buffering line sweeps like the skeleton
   * shimmer (`ff-shimmer`, transform only) and the starting spinner is the UI kit's `.spinner` (`ff-spin`). Calm mode and reduced
   * motion switch every transition and animation in the player off (the CastBar pattern, both triggers, !important so app.css's
   * reduced-motion rule cannot leave a .001 ms one); TV and kids: no transitions.
   *
   * TV remote (Task 40, spec §12.3): OK goes through `createLongOk` (600 ms). A short OK with the controls hidden shows them with
   * the focus on Play/Pause (and the banner with them), it never pauses; a short OK on a focused control presses it; a long OK opens
   * the *Senderliste* panel (ChannelPanel), like `ChannelList` / `Guide` (Phase 1) and the button. The panel's keys run through
   * `panelKey`; its OK switches through the same switcher / start() path as a zap (one watch at a time). Closing it gives the focus
   * back to the stage (TV: the controls stay hidden) or to its button (desktop). Back follows `backStep`. Every keydown goes
   * through `noteKey` (the list's hints); the TV controls' footer shows the D-pad hint "Lang OK: Senderliste".
   *
   * Casting (Task 41, spec §13), the *Abspielen auf …* button (PlayOnSheet):
   * - Chromecast: the cast engine's `loadLive` (its own `via: 'chromecast'` token; the backend lets this player's token go as it mints
   *   it, so the stream here is held like during a switch until it answered). While the engine's live cast runs, this player is its
   *   remote (RemoteScreen, live variant) and plays nothing itself; opening another channel then plays that one on the TV. When the cast
   *   ends, the channel plays here again.
   * - Inside the Android app: `native.castLive` (ruling R1; up to 90 s; false = not cast, nothing alarming, the channel plays on here);
   *   true: the app's cast bar takes over, the player closes.
   * - AirPlay (Safari): from the tap the `<video>` gets a `via: 'airplay'` token URL (native HLS, no hls.js), then the system picker
   *   (after the await it may need the *AirPlay-Gerät wählen* prompt); a zap while AirPlaying is a new token and a `src` swap. A route
   *   that stays off for AIR_OFF_GRACE_MS brings the stream here (hls.js) back.
   */
  export let channelId: string;
  export let filter: LiveFilter = 'all';

  const BEAT_MS = 20_000;
  const NOT_RECEIVING_POLL_MS = 10_000;
  const LEAVE_AFTER_MS = 2500;
  const START_WATCHDOG_MS = 30_000;
  const NOTE_MS = 2000;
  const SWITCH_DELAY_MS = 400;
  const EDGE_LATENCY_COUNT = 10;
  const SWIPE_PX = 40;
  const RESUME_MARGIN_S = 2;
  const LIST_REFRESH_MS = 60_000;
  const AIR_OFF_GRACE_MS = 3000;
  type Timer = ReturnType<typeof setTimeout>;
  type Refusal = Extract<LiveUi, { k: 'full' } | { k: 'providerLimit' }>;
  type OldestSrc = Parameters<typeof oldestPoint>[0];
  /** a beat's outcome: answered, the token is gone (a new watch was asked for), it failed otherwise, or it outlived its channel */
  type BeatResult = 'ok' | 'gone' | 'failed' | 'stale';
  const ERROR_KINDS: Array<LiveUi['k']> = ['lost', 'unreachable', 'retry', 'forbidden', 'maxStreams', 'off', 'full', 'providerLimit'];

  let root: HTMLDivElement | undefined, stage: HTMLDivElement | undefined, video: HTMLVideoElement | undefined;
  let playBtn: HTMLButtonElement | undefined, backBtn: HTMLButtonElement | undefined, fwdBtn: HTMLButtonElement | undefined, infoBtn: HTMLButtonElement | undefined;
  let list: LiveList | null = null, listTag: string | undefined, recentSnap: string[] | null = null, prevKnown = false;
  let curId = channelId, cardId = channelId, playingId: string | null = null, prevId: string | null = null;
  let answer: WatchAnswer | null = null, token: string | null = null, dvrSeconds = 0;
  let ui: LiveUi = { k: 'starting' };
  let sheet: Refusal | null = null;
  let hls: Hls | null = null, HlsCtor: typeof Hls | null = null;
  let paused = false, pausedWall: number | null = null, ignorePause = false, deliberate = false;
  let nowMs = Date.now(), switchingAt: number | null = nowMs, firstFrameAt: number | null = null, cardHoldUntil = 0;
  let controls = true, panelOpen = false, tv = false, coarse = false, motion = true, fullscreen = false;
  /** the Senderliste panel (listOpen) and its state; `okHeld`: the OK that opened it by a long press is still down (its repeats switch nothing) */
  let listOpen = false, pstate: PanelState | null = null, okHeld = false, okTarget: HTMLElement | null = null;
  let listBtn: HTMLButtonElement | undefined;
  let seen: Set<SeenKey> = new Set();
  let behindSec = 0, restartAt: number | null = null;
  let volume = 1, muted = false, brightness = 1;
  let announce = '';
  let num: NumberState | null = null, numMsg = '';
  /** `gen` counts starts (a newer start makes an older one's answers stale); `attachedGen` is the start whose stream is attached */
  let gen = 0, attachedGen = -1, destroyed = false, rewatched = false;
  /** a watch is on its way: the attached stream (if any) belongs to the channel before and its media events change nothing */
  let startPending = false;
  /**
   * What the attached stream met while a watch was on its way (the backend lets the channel before go as it starts the new one,
   * spec §12.2, so its media is refused or breaks meanwhile): nothing acts on it then. A switch that is refused keeps that stream,
   * and this runs once it does (a fatal error before a refusal); a switch that goes through drops it with the stream.
   */
  let held: Held | null = null;
  /** a refused media request: none, a beat is checking it, or loading carried on after an answered beat */
  let refused: 'none' | 'checking' | 'resumed' = 'none';
  let beatP: Promise<BeatResult> | null = null;
  let lostCycle: { since: number; attempt: number } | null = null;
  let hideT: Timer | undefined, retryT: Timer | undefined, pollT: Timer | undefined, leaveT: Timer | undefined, stallT: Timer | undefined, numT: Timer | undefined, tapT: Timer | undefined;
  let beatT: ReturnType<typeof setInterval> | undefined, tickT: ReturnType<typeof setInterval> | undefined, listT: ReturnType<typeof setInterval> | undefined;
  let stopFrame: (() => void) | null = null;
  const timing = createTiming();
  let session: ReturnType<typeof bindPlayerMediaSession> | null = null;

  // ---- casting (spec §13) ----
  /** the engine's live cast runs: this player is its remote and plays nothing itself */
  let remoteOn = false;
  let playOnOpen = false, playOnTrigger: HTMLElement | null = null, castBtn: HTMLButtonElement | undefined;
  /** a cast is on its way (loadLive, the app's castLive): the stream here is held */
  let castBusy = false, inShell = false;
  /** AirPlay: a target is in reach, the element plays a `via: 'airplay'` token, the route points at the TV */
  let airAvail = false, airMode = false, airWireless = false, airOffT: Timer | undefined, airProbe: HTMLVideoElement | null = null;
  type AirVideo = HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void; webkitCurrentPlaybackTargetIsWireless?: boolean };
  $: tvLive = $castSession && $castSession.live && $castSession.kind === 'chromecast' && $castSession.state !== 'detached' ? $castSession : null;
  $: followCast(tvLive);
  $: castShown = !tv && (inShell || ($perms.cast && ((castCapableBrowser() && ($castState.available || $castState.connected)) || airAvail)));
  $: castWhat = cur ? `${cur.number} ${cur.name}${prog ? ` · ${prog.title}` : ''}` : '';

  // ---- what is shown ----
  function shell(id: string, number: number, name: string, logo: string | null, now?: Prog, next?: Prog): LiveChannel {
    return { id, number, name, logo, groupId: null, running: true, epg: now ? 'ok' : 'none', favourite: false, now, next };
  }
  /** a channel from the list, with the programme of the watch answer when it is the one that plays */
  function chOf(id: string | null, l: LiveList | null, a: WatchAnswer | null): LiveChannel | null {
    if (!id) return null;
    const c = l ? l.channels.find((x) => x.id === id) ?? null : null;
    if (a && a.channel.id === id) {
      const base = c ?? shell(id, a.channel.number, a.channel.name, a.channel.logo);
      return a.now ? { ...base, epg: 'ok', now: a.now, next: a.next ?? base.next } : base;
    }
    return c;
  }
  const fmtBehind = (s: number): string => { const x = Math.max(0, Math.floor(s)); const m = Math.floor(x / 60), r = x % 60; return `${m}:${r < 10 ? '0' : ''}${r}`; };

  $: order = list ? channelOrder(list.channels, filter, list.favourites, recentSnap ?? list.recent) : [];
  $: cur = chOf(curId, list, answer);
  $: card = chOf(cardId, list, answer) ?? cur;
  $: prev = chOf(prevId, list, answer);
  $: up = order.length ? neighbour(order, curId, 1) : null;
  $: down = order.length ? neighbour(order, curId, -1) : null;
  $: errorUi = ERROR_KINDS.includes(ui.k);
  $: starting = ui.k === 'starting';
  $: bannerOn = Boolean(card) && !panelOpen && !listOpen && !errorUi
    && (nowMs < cardHoldUntil || bannerVisible({ starting, switchingAt, firstFrameAt, controlsVisible: controls, error: errorUi }, nowMs));
  $: refusal = sheet ?? (ui.k === 'full' || ui.k === 'providerLimit' ? ui : null);
  $: prog = cur && cur.epg === 'ok' && cur.receiving !== false ? cur.now ?? null : null;
  $: left = prog ? timeLeftText(timeLeft(prog, $minute)) : '';
  $: progress = prog ? progressAt(prog, $minute) : 0;
  $: edgeNow = atEdge(behindSec);
  $: behindText = fmtBehind(behindSec);
  $: phoneUi = coarse && !tv;
  $: still = tv || $kidsMode || !motion;
  $: recheckRestart($minute, cur, dvrSeconds);
  $: session?.update(msItem(cur), msActions);
  $: cardMsg = cardText(ui);
  $: hint = hintKeys('player', seen).map((k) => $t(k)).join(' · ');

  function cardText(u: LiveUi): string {
    switch (u.k) {
      case 'off': return $t('live.player.off');
      case 'forbidden': return $t('live.player.notAvailable');
      case 'maxStreams': return $t('player.error.maxStreams', { n: u.max });
      default: return '';
    }
  }
  function announceText(c: LiveChannel): string {
    const p = c.epg === 'ok' && c.receiving !== false ? c.now : undefined;
    if (!p) return `${c.number} ${c.name}`;
    const l = timeLeftText(timeLeft(p, new Date()));
    return l ? $t('live.player.announceLeft', { number: c.number, name: c.name, title: p.title, left: l }) : $t('live.player.announce', { number: c.number, name: c.name, title: p.title });
  }

  // ---- zapping ----
  const switcher = createSwitcher({
    delayMs: SWITCH_DELAY_MS,
    order: () => order,
    current: () => curId,
    onCard: showCard,
    onCommit: commit,
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as Timer) },
  });
  function showCard(c: LiveChannel): void {
    cardId = c.id;
    announce = announceText(c);
    if (c.id === curId) cardHoldUntil = Date.now() + BANNER_HOLD_MS;
    else switchingAt = Date.now();
  }
  function commit(c: LiveChannel): void {
    const from = curId;
    void start(c.id).then((r) => { if (r === 'moved' && from !== c.id) prevId = from; });
  }
  function jumpLast(): void { if (prev) switcher.jump(prev); }
  function join(c: RunningChannel): void {
    sheet = null;
    switcher.jump(chOf(c.id, list, answer) ?? shell(c.id, c.number, c.name, c.logo, c.now));
  }
  function closeRefusal(): void {
    if (sheet) { sheet = null; wake(); return; }
    leave();
  }

  // ---- the list (zapping order, names, the last channel) ----
  async function loadList(): Promise<void> {
    try {
      const r = await fetchChannels(listTag);
      if (destroyed || r.notModified) return;
      list = r.list;
      listTag = r.etag ?? undefined;
      if (recentSnap === null) recentSnap = [...r.list.recent];
      if (!prevKnown) { prevKnown = true; if (prevId === null) prevId = r.list.recent.filter((x) => x !== curId)[0] ?? null; }
    } catch { /* the player works without the list; zapping waits for it */ }
  }

  // ---- starting a channel ----
  async function start(id: string, cycle = false): Promise<'moved' | 'stay'> {
    const g = ++gen;
    startPending = true;
    clearTimeout(retryT); clearTimeout(pollT); clearTimeout(leaveT);
    if (!cycle) lostCycle = null;
    const from = playingId;
    curId = id; cardId = id; sheet = null;
    ui = { k: 'starting' };
    switchingAt = Date.now(); firstFrameAt = null;
    let r: Awaited<ReturnType<typeof watch>>;
    try { r = await watch(id, airMode ? 'airplay' : undefined); } catch {
      if (g !== gen || destroyed) return 'moved';
      startPending = false;
      dropStream(); onFail({ k: 'lost', attempt: 0 });
      return 'moved';
    }
    if (g !== gen || destroyed) {
      if (r.ok) void stopWatching(r.answer.token, false).catch(() => undefined);
      return 'moved';
    }
    startPending = false;
    if (!r.ok) {
      const u = fromWatchError(r.error.status, r.error);
      if ((u.k === 'full' || u.k === 'providerLimit') && from && token) {
        // a switch into a full budget: the channel before keeps playing (its stream, its attach id and its handlers stay as
        // they are), the sheet offers what already runs (spec §12.2)
        curId = from; cardId = from; sheet = u; ui = { k: 'playing' };
        switchingAt = null; firstFrameAt = Date.now() - BANNER_HOLD_MS;
        const h = held;
        held = null;
        h?.run(); // what the stream met while the watch was out
        // the waiting event was dropped while the watch was out: an old stream that is stuck shows buffering and arms the stall watch
        if (video && !video.paused && video.readyState < 3 && ui.k === 'playing') onWaiting();
        return 'stay';
      }
      dropStream(); onFail(u);
      return 'moved';
    }
    useAnswer(r.answer, id, g);
    return 'moved';
  }
  /** a watch answer becomes what plays: the old token goes, the new one is beaten and attached */
  function useAnswer(a: WatchAnswer, id: string, g: number): void {
    const old = token;
    teardownHls();
    if (old && old !== a.token) void stopWatching(old, false).catch(() => undefined);
    answer = a; token = a.token; dvrSeconds = a.dvrSeconds; playingId = id; deliberate = false;
    void setLast(id).catch(() => undefined);
    startBeat();
    replaceUrl(id);
    void attach(a.url, g);
  }

  function onFail(u: LiveUi): void {
    if (destroyed) return;
    if (u.k === 'lost' || u.k === 'unreachable') {
      const c = lostCycle ?? (lostCycle = { since: Date.now(), attempt: 0 });
      const now: LostUi = { k: u.k, attempt: c.attempt };
      ui = now;
      retryT = setTimeout(() => {
        const nx = nextLost(now, Date.now() - c.since);
        if (nx.k === 'retry') { ui = nx; lostCycle = null; return; }
        c.attempt = nx.attempt;
        void start(curId, true);
      }, lostDelay(c.attempt));
      return;
    }
    ui = u;
    if (u.k === 'notReceiving') pollT = setTimeout(() => void start(curId), NOT_RECEIVING_POLL_MS);
    else if (u.k === 'forbidden') leaveT = setTimeout(() => void goto('/live', { replaceState: true }), LEAVE_AFTER_MS);
  }
  function retryNow(): void { lostCycle = null; void start(curId); }

  /**
   * The token is gone (beat 410) or refused again after a re-pin: one new watch, whose answer decides (403 / not_found: forbidden,
   * anything else the lost cycle). A second time before a beat was answered again: the lost cycle, whose watches decide the same way.
   */
  function rewatchOnce(): void {
    if (rewatched) { dropStream(); onFail({ k: 'lost', attempt: 0 }); return; }
    rewatched = true;
    void start(curId);
  }

  function dropStream(): void {
    teardownHls();
    clearInterval(beatT); beatT = undefined;
    const tk = token;
    token = null; answer = null; playingId = null;
    if (tk) void stopWatching(tk, false).catch(() => undefined);
  }

  function teardownHls(): void {
    stopFrame?.(); stopFrame = null;
    clearTimeout(stallT);
    if (hls) { try { hls.destroy(); } catch { /* already gone */ } hls = null; }
    const v = video;
    if (v) {
      if (!v.paused) ignorePause = true;
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* nothing attached */ }
    }
    pausedWall = null; behindSec = 0; restartAt = null; attachedGen = -1; refused = 'none'; held = null;
  }
  /** keeps what the stream met while a watch is out (pickHeld): the first fatal error wins over refusals, else the latest refusal; a fatal error that is not a media error wins over a media one */
  function hold(run: () => void, fatal: boolean, media = false): void {
    held = pickHeld(held, { run, fatal, media });
  }

  async function attach(url: string, g: number): Promise<void> {
    const v = video;
    if (!v) return;
    attachedGen = g;
    refused = 'none';
    timing.begin(); timing.mode('live');
    const noFrame = () => { if (g === attachedGen) { dropStream(); onFail({ k: 'lost', attempt: 0 }); } };
    stopFrame = watchFirstFrame(v, START_WATCHDOG_MS, () => {
      if (g !== attachedGen) return;
      if (startPending) hold(noFrame, true); // a switch's watch is out: firstFrameAt is the new channel's
      else if (firstFrameAt === null) noFrame();
    });
    // AirPlay: the TV is handed the element's URL, so the token URL goes on the element itself (native HLS, never MSE)
    if (airMode) { v.src = url; void playV(); return; }
    let H: typeof Hls | null = null;
    try { H = await loadHls(); } catch { H = null; }
    if (g !== attachedGen || destroyed) return;
    if (H && H.isSupported()) {
      const h = new H(liveHlsConfig(dvrSeconds, tv));
      hls = h; HlsCtor = H;
      h.on(H.Events.MANIFEST_PARSED, () => { if (g === attachedGen) void playV(); });
      h.on(H.Events.LEVEL_UPDATED, () => { if (g === attachedGen) recheckRestart(); });
      h.on(H.Events.LEVEL_LOADED, () => { if (g === attachedGen && refused === 'resumed') refused = 'none'; });
      h.on(H.Events.FRAG_LOADED, () => { if (g === attachedGen && refused === 'resumed') refused = 'none'; });
      h.on(H.Events.ERROR, (_e: unknown, d: ErrorData) => onHlsError(d, g));
      h.loadSource(url);
      h.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url;
      void playV();
    } else {
      dropStream(); onFail({ k: 'lost', attempt: 0 });
    }
  }

  /**
   * hls.js errors of the attached stream (`g` = its attach id). A 403 / 410 on a network request is a refusal by the gateway and
   * goes to onMediaRefused, fatal or not (hls.js never retries a 4xx). Other non-fatal errors are hls.js' own business; a fatal
   * media error is recovered, any other fatal error is input lost.
   *
   * While a switch's watch is out (`startPending`) the attached stream is the channel before, which the backend lets go as it
   * starts the new one: its refusals and fatal errors act on nothing then (a new watch from here would be a second watch of the
   * new channel, the lost card would end it as it arrives). They are held for a switch that is refused and keeps this stream.
   */
  function onHlsError(d: ErrorData, g: number): void {
    if (g !== attachedGen || !HlsCtor) return;
    const code = (d.response as { code?: number } | undefined)?.code;
    const refusal = d.type === HlsCtor.ErrorTypes.NETWORK_ERROR && (code === 403 || code === 410);
    if (startPending) {
      if (refusal || d.fatal) hold(() => onHlsError(d, g), Boolean(d.fatal) && !refusal, d.type === HlsCtor.ErrorTypes.MEDIA_ERROR);
      return;
    }
    if (refusal) { onMediaRefused(d, g); return; }
    if (!d.fatal) return;
    if (d.type === HlsCtor.ErrorTypes.MEDIA_ERROR && hls) { hls.recoverMediaError(); return; }
    dropStream(); onFail({ k: 'lost', attempt: 0 });
  }

  /**
   * A refused media request. The first one is checked by a beat at once (a moved address re-pins through it, Review Focus 4): an
   * answered beat lets loading carry on from where it stands. A playlist refused again after that (requested after the re-pin, so
   * not one still in flight from before) or a refused first playlist leads to the one new watch. Refusals while the beat is out
   * are the same refusal.
   */
  function onMediaRefused(d: ErrorData, g: number): void {
    const H = HlsCtor!;
    if (d.details === H.ErrorDetails.MANIFEST_LOAD_ERROR) { refused = 'none'; rewatchOnce(); return; }
    if (refused === 'checking') return;
    if (refused === 'resumed') {
      if (d.details !== H.ErrorDetails.LEVEL_LOAD_ERROR) return;
      refused = 'none';
      rewatchOnce();
      return;
    }
    refused = 'checking';
    void beatNow().then((r) => {
      if (g !== attachedGen || destroyed) return;
      if (r === 'ok') {
        refused = 'resumed';
        const v = video;
        hls?.startLoad(v ? v.currentTime : -1);
      } else {
        refused = 'none'; // gone: a new watch is on its way; failed / stale: the stall watch and the next beat take over
        // a refusal replayed after a refused switch met this beat, which a switch had made stale: A is checked for real now
        if (r === 'stale' && g === attachedGen && !startPending && token) void beatNow();
      }
    });
  }

  // ---- heartbeat ----
  function startBeat(): void {
    clearInterval(beatT);
    beatT = setInterval(() => { if (!beatP) void beatNow(); }, BEAT_MS); // a beat still in flight skips this one
  }
  /** one beat at a time: a caller while one is out shares its answer */
  function beatNow(): Promise<BeatResult> {
    if (!beatP) beatP = beatOnce().finally(() => { beatP = null; });
    return beatP;
  }
  /**
   * Beats the current token. Its answer counts only for the start it was sent in (a zap revokes the old token when the new one is
   * minted, ruling 36, so a late 410 for it must neither start a second watch nor end the new channel). 410 (and a 403, which the
   * backend does not send today): the token is gone, one new watch.
   *
   * While a switch's watch is out the token is the channel before's, which the backend lets go as it starts the new one: no beat
   * goes out, and one that was out when the switch began is stale (its 410 would be a second watch of the new channel).
   */
  async function beatOnce(): Promise<BeatResult> {
    const tk = token, g = gen;
    if (!tk || startPending) return 'stale';
    const stale = () => g !== gen || tk !== token || startPending || destroyed;
    try {
      await beat(tk);
      if (stale()) return 'stale';
      rewatched = false;
      return 'ok';
    } catch (e) {
      if (stale()) return 'stale';
      const st = e instanceof ApiError ? e.status : 0;
      if (st === 410 || st === 403) { rewatchOnce(); return 'gone'; }
      return 'failed';
    }
  }

  // ---- playback ----
  function playV(): Promise<void> {
    const v = video;
    if (!v) return Promise.resolve();
    return v.play().catch(() => {
      if (v.muted) return undefined;
      v.muted = true; muted = true; // autoplay with sound was refused: play muted, the viewer turns the sound on
      return v.play().catch(() => undefined);
    });
  }
  /** the viewer pauses: the pause is timed from this press (the media `pause` event comes a task later) */
  function pauseV(): void {
    const v = video;
    if (!v || v.paused) return;
    ignorePause = false;
    pausedWall = Date.now();
    v.pause();
  }
  /**
   * A pause ends: checked against the buffer before playback goes on. Longer than the buffer: on from the oldest point with the
   * toast that names the buffer (spec §12.1); otherwise no earlier than the oldest point. Runs once per pause (it clears the mark).
   */
  function resumeCheck(): void {
    const was = pausedWall;
    pausedWall = null;
    const v = video;
    if (was === null || !v || dvrSeconds <= 0 || firstFrameAt === null) return;
    const r = resumePoint((Date.now() - was) / 1000, dvrSeconds, oldest());
    if (r.tooLong) {
      v.currentTime = r.at + RESUME_MARGIN_S;
      toast.info($t('live.player.pauseTooLong', { n: Math.round(dvrSeconds / 60) }));
    } else if (v.currentTime < r.at) v.currentTime = r.at + RESUME_MARGIN_S;
  }
  function togglePlay(): void {
    const v = video;
    if (!v) return;
    if (v.paused) { resumeCheck(); void playV(); } else pauseV();
  }
  function edge(): number {
    const s = hls ? hls.liveSyncPosition : null;
    if (typeof s === 'number' && Number.isFinite(s)) return s;
    const v = video;
    if (!v) return 0;
    const r = v.seekable;
    return r.length ? r.end(r.length - 1) : v.currentTime;
  }
  function oldestSrc(): OldestSrc | null { return video ? { hls: hls as unknown as OldestSrc['hls'], video } : null; }
  function oldest(): number {
    const src = oldestSrc();
    if (!src) return 0;
    const o = oldestPoint(src);
    if (o) return o.time;
    return src.video.seekable.length ? src.video.seekable.start(0) : 0;
  }
  function applyLatency(): void {
    if (hls) (hls.config as unknown as { liveMaxLatencyDurationCount: number }).liveMaxLatencyDurationCount = deliberate ? Number.POSITIVE_INFINITY : EDGE_LATENCY_COUNT;
  }
  function markDeliberate(): void { deliberate = true; applyLatency(); }
  function seekTo(sec: number): void {
    const v = video;
    if (!v || !playingId) return;
    const hi = edge();
    const target = Math.max(oldest(), Math.min(hi, sec));
    if (!atEdge(hi - target)) markDeliberate();
    v.currentTime = target;
  }
  function seekBy(d: number): void { if (video) seekTo(video.currentTime + d); wake(); }
  function toLive(): void {
    deliberate = false; applyLatency();
    pausedWall = null; // back to live: whatever the pause was, there is nothing to resume from
    seekTo(edge());
    void playV();
    wake();
  }
  function restart(): void {
    const v = video;
    if (!v || restartAt === null) return;
    markDeliberate();
    pausedWall = null;
    v.currentTime = restartAt;
    void playV();
    wake();
  }
  function recheckRestart(..._deps: unknown[]): void {
    const c = chOf(curId, list, answer);
    const p = c && c.epg === 'ok' && c.receiving !== false ? c.now : undefined;
    const src = oldestSrc();
    if (!p || !src || !dvrSeconds || !playingId || firstFrameAt === null) { restartAt = null; return; }
    const st = new Date(p.start).getTime();
    restartAt = Number.isFinite(st) ? restartTarget(st, oldestPoint(src)) : null;
  }
  function onTick(): void {
    nowMs = Date.now();
    const v = video;
    if (!v || !playingId || firstFrameAt === null) { behindSec = 0; return; }
    behindSec = behind(v, edge());
    if (deliberate && !paused && atEdge(behindSec)) { deliberate = false; applyLatency(); }
  }

  function onPlaying(): void {
    if (attachedGen === -1 || startPending) return;
    if (firstFrameAt === null) {
      firstFrameAt = Date.now();
      lostCycle = null;
      timing.playing();
      const r = timing.finish({ device: deviceClass({ coarse, tv }) });
      if (r) sendTiming(r, { csrf: getCsrf(), profile: getActiveProfile() });
      recheckRestart();
    }
    clearTimeout(stallT);
    if (ui.k === 'starting' || ui.k === 'buffering') ui = { k: 'playing' };
  }
  function onWaiting(): void {
    const v = video;
    if (attachedGen === -1 || startPending || firstFrameAt === null || !v || v.paused || v.seeking) return;
    if (ui.k === 'playing') ui = { k: 'buffering' };
    clearTimeout(stallT);
    stallT = setTimeout(() => { if (ui.k === 'buffering') { dropStream(); onFail({ k: 'lost', attempt: 0 }); } }, STALL_LOST_MS);
  }
  function onPause(): void {
    if (ignorePause) { ignorePause = false; return; }
    paused = true;
    if (pausedWall === null) pausedWall = Date.now(); // a pause from outside the player (system, headset): timed from its event
    markDeliberate();
    wake();
  }
  function onPlay(): void {
    ignorePause = false;
    paused = false;
    resumeCheck(); // a resume from outside the player (system, headset); the player's own resume has checked already
    // a TV keeps hidden controls hidden: a switch's new stream starting must not bring them up (▲/▼ would move the focus instead of
    // zapping, spec §12.3); visible ones get their full time again
    if (!tv || controls) wake();
  }
  function onVolume(): void { const v = video; if (v) { volume = v.volume; muted = v.muted; } }
  function setVolume(x: number): void {
    const v = video;
    if (!v) return;
    volume = Math.max(0, Math.min(1, x));
    v.volume = volume;
    if (volume > 0 && v.muted) { v.muted = false; muted = false; }
    try { localStorage.setItem('ff_vol', String(volume)); } catch { /* storage blocked */ }
  }
  function toggleMute(): void { const v = video; if (v) { v.muted = !v.muted; muted = v.muted; } }
  function toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void root?.requestFullscreen?.().catch(() => undefined);
  }

  // ---- controls ----
  function wake(): void {
    controls = true;
    clearTimeout(hideT);
    if (paused || panelOpen || listOpen || refusal || playOnOpen) return;
    hideT = setTimeout(hideControls, tv ? CONTROLS_HIDE_TV_MS : CONTROLS_HIDE_MS);
  }
  function hideControls(): void {
    if (paused || panelOpen || listOpen || playOnOpen) return;
    controls = false;
    const a = document.activeElement;
    if (tv && a instanceof HTMLElement && root && root !== a && root.contains(a)) root.focus({ preventScroll: true });
  }
  function onMouse(): void { if (!coarse) wake(); }
  function openPanel(): void { panelOpen = true; controls = true; clearTimeout(hideT); }
  function closePanel(): void { panelOpen = false; wake(); void tick().then(() => infoBtn?.focus()); }

  // ---- the Senderliste panel (spec §12.2, ruling 51, 59) ----
  const panelCtx = (l: LiveList) => ({ list: l.channels, favourites: l.favourites, recentSnapshot: recentSnap ?? l.recent, playingId: curId });
  /** opens on the player's filter with the focus on the playing channel; on a TV the controls go (they stay hidden when it closes) */
  function openList(): void {
    longOk.cancel(); // a dropped keyup must not leave a press open (Task 35 review)
    const l = list;
    if (!l || listOpen) return;
    const ctx = panelCtx(l);
    panelOpen = false;
    pstate = panelAt({ ...ctx, filter, filters: panelFilters(l.groups, channelOrder(l.channels, 'recent', l.favourites, ctx.recentSnapshot).length > 0) });
    listOpen = true;
    clearTimeout(hideT);
    if (tv) controls = false;
  }
  /** TV: the focus goes back to the stage and the controls stay hidden; desktop: to the Senderliste button; phone: the player */
  function closeList(): void {
    if (!listOpen) return;
    listOpen = false;
    pstate = null;
    if (tv) {
      // wake() may have shown the controls behind the panel without a hide timer: hide them again (paused: they stay, as always)
      if (paused) wake(); else { controls = false; clearTimeout(hideT); }
      void tick().then(() => stage?.focus({ preventScroll: true }));
      return;
    }
    wake();
    void tick().then(() => (phoneUi ? root : listBtn ?? root)?.focus({ preventScroll: true }));
  }
  /**
   * A channel picked in the panel: the panel closes and the switch goes through the switcher like any zap (one start() at a time,
   * the banner at once). A chip chosen in the panel becomes the zapping order. The playing channel itself only shows the banner.
   */
  function pickChannel(id: string): void {
    const s = pstate;
    const c = (s ? s.rows.find((x) => x.id === id) : undefined) ?? chOf(id, list, answer);
    if (s && s.filter !== filter) { filter = s.filter; replaceFilter(s.filter); }
    closeList();
    if (!c) return;
    if (c.id === curId) showCard(c);
    else switcher.jump(c);
  }
  function listFilter(f: LiveFilter): void {
    const s = pstate, l = list;
    if (!s || !l) return;
    pstate = panelAt({ ...panelCtx(l), filter: f, filters: s.filters });
  }
  const PANEL_KEYS: Record<string, PanelKey> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok' };
  /** the keys while the panel is open (Back has gone to goBack before); Tab and the rest stay with the dialog */
  function listKey(e: KeyboardEvent, key: string): void {
    const s = pstate, l = list;
    if (!s || !l || e.ctrlKey || e.metaKey || e.altKey) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (key === 'ChannelList' || key === 'Guide') { stop(); closeList(); return; }
    const k = PANEL_KEYS[key];
    if (!k) return;
    if (k === 'ok') {
      if (e.repeat || okHeld) { stop(); return; } // the OK that opened the panel is still held
      const a = document.activeElement;
      if (!(a instanceof HTMLElement && a.classList.contains('prow'))) return; // a chip, the close button: their own click
    }
    stop();
    const r = panelKey(s, k, panelCtx(l));
    pstate = r.state;
    if (r.act && 'switchTo' in r.act) {
      if (k === 'ok') okHeld = true; // a held OK (repeats without repeat:true) must not reach the long-OK path; keyup / blur clear it
      pickChannel(r.act.switchTo);
    }
    else if (r.act) closeList();
  }

  // ---- OK on a TV remote: short = show the controls (or press the focused control), long = the Senderliste ----
  const longOk = createLongOk({
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as Timer) },
    onShort: () => {
      const el = okTarget;
      okTarget = null;
      if (el && el.isConnected && controls) el.click();
      else act({ type: 'showControls' });
    },
    onLong: () => { okTarget = null; okHeld = true; openList(); },
  });
  function onKeyUp(e: KeyboardEvent): void {
    if (e.key !== 'Enter') return;
    okHeld = false;
    longOk.up();
  }
  function onBlur(): void { longOk.cancel(); okHeld = false; okTarget = null; }

  // ---- keys (one capture listener: the player owns its keys while it is open) ----
  function onBody(): boolean {
    const a = document.activeElement;
    return !a || a === document.body || a === root || a === stage;
  }
  function leave(): void {
    if (history.length > 1) history.back();
    else void goto('/live', { replaceState: true });
  }
  /** Back / Escape (spec §12.3 Close row, backStep): the Senderliste, a sheet, the number card, fullscreen, the TV controls, the player */
  function goBack(): void {
    const step = backStep({ panel: listOpen, sheet: panelOpen || Boolean(refusal), numberOpen: Boolean(num || numMsg), controls: tv && controls });
    if (step === 'closePanel') { closeList(); return; }
    if (step === 'closeSheet') { if (panelOpen) closePanel(); else closeRefusal(); return; }
    if (step === 'closeNumber') { closeNumber(); return; }
    if (document.fullscreenElement) { void document.exitFullscreen().catch(() => undefined); return; }
    if (step === 'hideControls') { controls = false; clearTimeout(hideT); root?.focus({ preventScroll: true }); return; }
    leave();
  }
  let remote: LiveRemote | null = null;
  function onKey(e: KeyboardEvent): void {
    if (destroyed) return;
    // a TV remote sends many keys as 'Unidentified' + keyCode: the Samsung / LG maps give them their standard names first
    const key = remote ? remote.keyName(e) : e.key;
    const s = noteKey(key);
    if (s.size !== seen.size) seen = s;
    const back = e.key === 'Escape' || (tv && isBackKey(e));
    // the Play on sheet: Back closes it (focus back to its button); its own keys stay with it
    if (playOnOpen) { if (back) { e.preventDefault(); e.stopImmediatePropagation(); closePlayOn(); } return; }
    // the remote screen of a live cast: Back leaves the player, every other key belongs to its buttons
    if (remoteOn) { if (back) { e.preventDefault(); e.stopImmediatePropagation(); leave(); } return; }
    if (back) { e.preventDefault(); e.stopImmediatePropagation(); goBack(); return; }
    if (listOpen) { listKey(e, key); return; }
    if (refusal) return; // the sheet's buttons own the keys
    if (!tv) wake(); else if (controls) wake();
    if (tv && e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !panelOpen && num === null) {
      // OK is decided on its keyup (createLongOk): nothing is pressed on keydown, its repeats are ignored
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || okHeld) return;
      const a = document.activeElement;
      okTarget = a instanceof HTMLElement && !onBody() && Boolean(root?.contains(a)) ? a : null;
      longOk.down(e);
      return;
    }
    const a = resolveLiveKey(remote ? remote.input(e) : e, { tv, lg: remote?.lg ?? false, controlsVisible: controls, onBody: onBody(), overlayOpen: panelOpen, numberOpen: num !== null });
    if (!a) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    act(a);
  }
  function act(a: LiveKeyAction): void {
    switch (a.type) {
      case 'chUp': switcher.press(1); break;
      case 'chDown': switcher.press(-1); break;
      case 'showControls': wake(); void tick().then(() => playBtn?.focus()); break;
      case 'controls': wake(); void tick().then(() => (a.focus === 'fwd30' && fwdBtn && !fwdBtn.disabled ? fwdBtn : backBtn ?? playBtn)?.focus()); break;
      case 'toggle': togglePlay(); break;
      case 'seek': seekBy(a.by); break;
      case 'live': toLive(); break;
      case 'info': if (panelOpen) closePanel(); else openPanel(); break;
      case 'last': jumpLast(); break;
      case 'digit': digit(a.d); break;
      case 'enter': commitNum(); break;
      case 'volume': setVolume(volume + a.delta); break;
      case 'mute': toggleMute(); break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'close': goBack(); break;
      case 'channelList': openList(); break;
      default: break;
    }
  }

  // ---- number entry (spec §12.4) ----
  function digit(d: number): void {
    if (!list) return;
    numMsg = '';
    num = typeDigit(num ?? { digits: '', match: null, unique: false, zero: false }, d, list.channels);
    clearTimeout(numT);
    numT = setTimeout(commitNum, NUMBER_TIMEOUT_MS);
  }
  function commitNum(): void {
    clearTimeout(numT);
    const s = num;
    if (!s || !list) return;
    const r = commitNumber(s, list.channels);
    if (r.kind === 'channel') { num = null; switcher.jump(r.channel); return; }
    if (r.kind === 'last') {
      num = null;
      if (prev) switcher.jump(prev);
      else { numMsg = $t('live.number.noLast'); numT = setTimeout(closeNumber, NOTE_MS); }
      return;
    }
    num = null;
    numMsg = r.text;
    numT = setTimeout(closeNumber, NOTE_MS);
  }
  function closeNumber(): void { clearTimeout(numT); num = null; numMsg = ''; }

  // ---- touch: centre swipe zaps, the side zones keep brightness / volume, double taps on the sides seek ±10 s ----
  let gst: { id: number; x: number; y: number; zone: Zone; h: number; axis: 'zap' | 'brightness' | 'volume' | 'none' | null; bri: number; vol: number } | null = null;
  let taps: TapState | null = null;
  function gDown(e: PointerEvent): void {
    if (e.pointerType !== 'touch' || !stage) return;
    const r = stage.getBoundingClientRect();
    gst = { id: e.pointerId, x: e.clientX, y: e.clientY, zone: zoneOf(e.clientX - r.left, r.width), h: r.height, axis: null, bri: brightness, vol: muted ? 0 : volume };
  }
  function gMove(e: PointerEvent): void {
    const g = gst;
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (g.axis === null) {
      if (Math.hypot(dx, dy) < 12) return;
      if (Math.abs(dx) > Math.abs(dy)) g.axis = g.zone === 'center' ? 'zap' : 'none';
      else g.axis = g.zone === 'left' ? 'brightness' : g.zone === 'right' ? 'volume' : 'none';
      try { stage?.setPointerCapture(e.pointerId); } catch { /* a pointer that is already gone */ }
    }
    if (g.axis === 'brightness') brightness = levelFromDrag(g.bri, dy, g.h, BRIGHTNESS_MIN, 1);
    else if (g.axis === 'volume') setVolume(levelFromDrag(g.vol, dy, g.h));
  }
  function gUp(e: PointerEvent): void {
    const g = gst;
    if (!g || e.pointerId !== g.id) return;
    gst = null;
    if (g.axis === 'zap') { const dx = e.clientX - g.x; if (Math.abs(dx) >= SWIPE_PX) switcher.press(dx < 0 ? 1 : -1); return; }
    if (g.axis !== null) return;
    const r = registerTap(taps, Date.now(), g.zone);
    taps = r.state;
    clearTimeout(tapT);
    if (g.zone !== 'center' && r.kind === 'seek') { seekBy(r.by); return; }
    tapT = setTimeout(() => { if (controls) { controls = false; clearTimeout(hideT); } else wake(); }, g.zone === 'center' ? 0 : TAP_WINDOW);
  }
  function gCancel(): void { gst = null; }


  // ---- casting (spec §13) ----
  function openPlayOn(el?: HTMLElement | null): void { playOnTrigger = el ?? castBtn ?? null; playOnOpen = true; controls = true; clearTimeout(hideT); }
  function closePlayOn(): void { playOnOpen = false; const b = playOnTrigger; void tick().then(() => (b?.isConnected ? b : root)?.focus({ preventScroll: true })); wake(); }
  /** the cast button: inside the Android app the app's own cast (castLive), elsewhere the Play on sheet */
  function onCastBtn(e: MouseEvent): void {
    if (inShell) { void castViaApp(); return; }
    openPlayOn(e.currentTarget as HTMLElement);
  }
  /** a cast that did not happen: the held stream here acts again (like a refused switch) */
  function releaseHold(): void {
    if (remoteOn || destroyed) return;
    startPending = false;
    const h = held;
    held = null;
    h?.run();
  }
  /** Chromecast (the browser holds a cast session): the engine plays the channel on the TV, this player becomes its remote */
  async function castViaChromecast(): Promise<void> {
    if (castBusy || remoteOn || destroyed) return;
    castBusy = true;
    startPending = true; // the backend lets this player's token go as it mints the cast token: nothing here acts meanwhile
    try {
      await castEngine.loadLive(curId, { order: order.map((c) => c.id) });
    } catch (e) {
      if (!(e instanceof LiveCastError && e.code === 'superseded')) toast.error(liveErrText(e));
      releaseHold();
    } finally {
      castBusy = false;
    }
  }
  /** inside the Android app (ruling R1): the app casts the channel itself; false (refused, no TV, an older app) changes nothing here */
  async function castViaApp(): Promise<void> {
    if (castBusy || destroyed) return;
    castBusy = true;
    startPending = true;
    const ok = await native.castLive(curId);
    castBusy = false;
    if (destroyed) return;
    if (!ok) { releaseHold(); return; }
    gen++;
    startPending = false;
    dropStream(); // the app's token replaced this one on the server
    leave(); // the app's cast bar shows the channel outside the player
  }
  /** the engine's live cast came or went: remote screen on (nothing plays here), or the channel plays here again */
  function followCast(s: CastSession | null): void {
    if (destroyed) return;
    if (s?.live) {
      const id = s.live.channelId;
      if (!remoteOn) {
        remoteOn = true;
        gen++;
        startPending = false;
        clearTimeout(retryT); clearTimeout(pollT); clearTimeout(leaveT);
        lostCycle = null;
        dropStream(); // the cast token replaced this one on the server
        sheet = null; ui = { k: 'playing' }; switchingAt = null;
        if (listOpen) closeList();
        if (panelOpen) panelOpen = false;
      }
      if (id !== curId) { curId = id; cardId = id; replaceUrl(id); }
      return;
    }
    if (!remoteOn) return;
    remoteOn = false;
    // the cast ended: the channel plays here again. Not while the page unloads (pageshow decides then): the engine's own pagehide
    // listener can run first and end the cast, and this reactive update lands before the player's listener has set `hiding`, so
    // the restart waits one task and looks again
    const id = curId;
    setTimeout(() => { if (!hiding && !destroyed && !remoteOn) void start(id); }, 0);
  }
  /** pagehide until the next pageshow: the engine's cast ends with the page (the TV keeps playing), so nothing starts here meanwhile */
  let hiding = false;
  /**
   * A local watch next to a live cast that this browser left on the TV would start a second stream: with a live hint the engine first
   * gets a bounded chance to re-adopt the cast (the player then follows it as its remote); only without one the channel starts here.
   */
  async function startGuarded(id: string): Promise<void> {
    const hasHint = (): boolean => { try { return readHint(localStorage, Date.now())?.kind === 'live'; } catch { return false; } };
    const g = gen;
    const local = await startsLocally({ hint: hasHint(), inShell, resume: () => castEngine.resume(), hasLive: () => Boolean(get(castSession)?.live) || remoteOn });
    if (!local || destroyed || g !== gen) return;
    void start(id);
  }
  /** AirPlay row (inside the tap): the token URL on the element, then the picker; once it is there the picker alone */
  function airTap(): void {
    if (airMode) { pickAir(); return; }
    void airStart();
  }
  function pickAir(): void {
    try { (video as AirVideo | undefined)?.webkitShowPlaybackTargetPicker?.(); } catch { /* no picker: the prompt stays */ }
  }
  async function airStart(): Promise<void> {
    if (castBusy || destroyed) return;
    castBusy = true;
    const g = ++gen;
    startPending = true;
    let r: Awaited<ReturnType<typeof watch>> | null = null;
    try { r = await watch(curId, 'airplay'); } catch { r = null; }
    castBusy = false;
    if (g !== gen || destroyed) { if (r?.ok) void stopWatching(r.answer.token, false).catch(() => undefined); return; }
    if (!r || !r.ok) {
      toast.error(r ? liveErrText(new LiveCastError(r.error.error, r.error)) : $t('player.airplay.failed'));
      releaseHold();
      return;
    }
    startPending = false;
    airMode = true;
    useAnswer(r.answer, curId, g);
    pickAir(); // WebKit may not open it after the await: the "AirPlay-Gerät wählen" prompt opens it from a fresh tap
  }
  function onAirAvail(e: Event): void { if ((e as Event & { availability?: string }).availability === 'available') airAvail = true; }
  function onWireless(): void {
    const on = Boolean((video as AirVideo | undefined)?.webkitCurrentPlaybackTargetIsWireless);
    clearTimeout(airOffT);
    if (on) { airWireless = airMode; return; }
    if (!airWireless) return;
    // a route that stays off (AirPlay ended in the picker, the TV gone): the stream here again
    airOffT = setTimeout(() => { if (!(video as AirVideo | undefined)?.webkitCurrentPlaybackTargetIsWireless) airEnd(); }, AIR_OFF_GRACE_MS);
  }
  function airEnd(): void {
    if (!airMode) return;
    airMode = false; airWireless = false;
    void start(curId);
  }
  /** "Hier weiterschauen" in the sheet: AirPlay ends here (a Chromecast cast is stopped by the sheet; followCast plays on here) */
  function onContinued(): void { playOnOpen = false; if (airMode) airEnd(); wake(); }

  // ---- Media Session, URL, page life ----
  function msItem(c: LiveChannel | null) {
    return { title: c?.now?.title ?? c?.name ?? '', artist: c ? `${c.number} ${c.name}` : '', artworkIds: [] as string[] };
  }
  const msActions = {
    play: () => { resumeCheck(); void playV(); }, pause: () => pauseV(), seekTo: (s: number) => seekTo(s), seekBy: (d: number) => seekBy(d),
    next: () => switcher.press(1), prev: () => switcher.press(-1),
  };
  function replaceUrl(id: string): void {
    if (location.pathname === watchPath(id)) return;
    try { replaceState(watchPath(id) + location.search, {}); } catch { /* the router is not ready yet: the address keeps the channel it opened with */ }
  }
  /** a chip chosen in the panel is the zapping order now: the address keeps it (shallow, like a zap) */
  function replaceFilter(f: LiveFilter): void {
    try {
      const q = new URLSearchParams(location.search);
      q.set('f', f);
      replaceState(location.pathname + '?' + q.toString(), {});
    } catch { /* the router is not ready yet */ }
  }
  function onPageHide(): void {
    hiding = true;
    if (startPending) { gen++; clearInterval(beatT); beatT = undefined; } // a late answer of the watch out goes through start()'s stop branch
    const tk = token;
    if (!tk) return;
    token = null;
    void stopWatching(tk, true).catch(() => undefined);
  }
  /** back from the back/forward cache: the stream was let go at pagehide, so the channel starts again */
  function onPageShow(e: PageTransitionEvent): void {
    hiding = false;
    if (e.persisted && !destroyed) void startGuarded(curId);
  }
  const onFs = () => { fullscreen = Boolean(document.fullscreenElement); };

  onMount(() => {
    const html = document.documentElement;
    const sync = () => { tv = html.classList.contains('tv'); };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(html, { attributes: true, attributeFilter: ['class'] });
    try { coarse = matchMedia('(pointer: coarse)').matches; } catch { coarse = false; }
    motion = motionAllowed();
    try { const v = parseVolume(localStorage.getItem('ff_vol')); if (v !== null && video) { volume = v; video.volume = v; } } catch { /* storage blocked */ }
    seen = seenKeys();
    remote = liveRemote(); // Samsung: registers the live keys now that the player is open
    inShell = native.available;
    if (!tv && !inShell) void initCast();
    // a TV picked in the browser's cast dialog (Play on, or the browser's own cast menu): the channel goes there
    const offCast = onCastEvent((e) => { if (e === 'session-start' && !remoteOn && !tv && !inShell) void castViaChromecast(); });
    const v0 = video as AirVideo | undefined;
    if (v0 && typeof v0.webkitShowPlaybackTargetPicker === 'function') {
      // hls.js may disable remote playback on the element (ManagedMediaSource): a hidden probe hears the availability too
      airProbe = document.createElement('video');
      airProbe.className = 'airprobe';
      airProbe.setAttribute('aria-hidden', 'true');
      root?.appendChild(airProbe);
      for (const el of [v0, airProbe]) el.addEventListener('webkitplaybacktargetavailabilitychanged', onAirAvail);
      v0.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless);
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('fullscreenchange', onFs);
    tickT = setInterval(onTick, 250);
    listT = setInterval(() => { if (!document.hidden) void loadList(); }, LIST_REFRESH_MS);
    if (video) session = bindPlayerMediaSession(video, msItem(cur), msActions);
    void loadList();
    // a live cast runs: this player is its remote (another channel opened now plays on the TV); otherwise the channel plays here
    const tvNow = tvLive?.live;
    if (!tvNow) void startGuarded(channelId);
    else if (tvNow.channelId !== channelId) void castEngine.loadLive(channelId).catch((e: unknown) => { if (!(e instanceof LiveCastError && e.code === 'superseded')) toast.error(liveErrText(e)); });
    wake();
    root?.focus({ preventScroll: true });
    return () => {
      mo.disconnect();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('fullscreenchange', onFs);
      offCast();
      if (v0) { v0.removeEventListener('webkitplaybacktargetavailabilitychanged', onAirAvail); v0.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless); }
      airProbe?.remove();
    };
  });
  onDestroy(() => {
    destroyed = true;
    gen++;
    for (const h of [hideT, retryT, pollT, leaveT, stallT, numT, tapT, airOffT]) clearTimeout(h);
    clearInterval(beatT); clearInterval(tickT); clearInterval(listT);
    switcher.dispose();
    longOk.cancel(); // route change
    stopFrame?.();
    if (hls) { try { hls.destroy(); } catch { /* already gone */ } hls = null; }
    session?.release();
    timing.drop();
    const tk = token;
    token = null;
    if (tk) void stopWatching(tk, true).catch(() => undefined);
  });
</script>

<div class="lplayer" class:solid={still} class:phone={phoneUi} data-live-state={ui.k} bind:this={root} tabindex="-1" role="region" aria-label={$t('live.title')} on:mousemove={onMouse}>
  <div class="lstage" bind:this={stage} tabindex="-1" role="presentation" on:pointerdown={gDown} on:pointermove={gMove} on:pointerup={gUp} on:pointercancel={gCancel} on:dblclick={() => { if (!coarse) toggleFullscreen(); }}>
    <video bind:this={video} playsinline crossorigin="use-credentials" style:filter={brightness < 1 ? `brightness(${brightness})` : null}
      on:playing={onPlaying} on:waiting={onWaiting} on:pause={onPause} on:play={onPlay} on:volumechange={onVolume}></video>
  </div>

  {#if ui.k === 'buffering'}<div class="lbuf" aria-hidden="true"><i></i></div>{/if}

  <div class="ltop" class:hide={!controls} data-nav>
    <button type="button" class="ib" aria-label={$t('player.error.back')} on:click={leave}><Icon name="arrow-left" size={24} /></button>
    {#if cur}
      <span class="tlogo" aria-hidden="true">{#if cur.logo}<img src={cur.logo} alt="" width="40" height="40" decoding="async" />{/if}</span>
      <button type="button" class="tinfo" on:click={openPanel}>
        <span class="tname">{cur.number} {cur.name}</span>
        <span class="ttitle">{prog ? prog.title : nowLines(cur).now}</span>
        <span class="ttime">{prog ? `${clock(prog.start)}–${clock(prog.end)}` : ''}</span>
      </button>
      <span class="left">{left}</span>
    {/if}
    <span class="tprog" class:off={!prog} aria-hidden="true"><i style="transform:scaleX({progress})"></i></span>
  </div>

  {#if card}
    <InfoBanner channel={card} visible={bannerOn} {starting} notReceiving={ui.k === 'notReceiving' && card.id === curId} now={$minute} {still} />
  {/if}

  {#if ui.k === 'lost' || ui.k === 'unreachable' || ui.k === 'retry'}
    <div class="lcard" class:frost={!still} class:frost-safe={!still} class:solid={still} role="alert">
      <p class="ct">{$t('live.player.unreachable')}</p>
      <p class="cs">{ui.k === 'retry' ? '' : $t('live.player.reconnecting')}</p>
      <div class="cbtn">{#if ui.k === 'retry'}<button type="button" class="frost-btn" on:click={retryNow}>{$t('live.player.retry')}</button>{/if}</div>
    </div>
  {:else if cardMsg}
    <div class="lcard" class:frost={!still} class:frost-safe={!still} class:solid={still} role="alert">
      <p class="ct">{cardMsg}</p>
    </div>
  {/if}

  <div class="ctl" class:hide={!controls} class:frost={!still} class:frost-safe={!still} class:solid={still} role="group" aria-label={$t('player.controls.toolbar')} data-nav>
    <button type="button" class="pp" bind:this={playBtn} aria-busy={starting} aria-label={paused ? $t('player.controls.play') : $t('player.controls.pause')} on:click={togglePlay}>
      {#if starting}<span class="spinner" aria-hidden="true"></span>{:else}<Icon name={paused ? 'play' : 'pause'} size={26} />{/if}
    </button>
    {#if !phoneUi}
    <span class="restartslot">
      {#if restartAt !== null}<button type="button" class="ib" aria-label={$t('live.player.restart')} title={$t('live.player.restart')} on:click={restart}><Icon name="skip-prev" size={24} /></button>{/if}
    </span>
    {/if}
    {#if !phoneUi}
      <button type="button" class="ib" bind:this={backBtn} aria-label={$t('live.player.back30')} title={$t('live.player.back30')} on:click={() => seekBy(-30)}><span class="n" aria-hidden="true">−30</span></button>
      <button type="button" class="ib" bind:this={fwdBtn} aria-label={$t('live.player.fwd30')} title={$t('live.player.fwd30')} disabled={edgeNow} on:click={() => seekBy(30)}><span class="n" aria-hidden="true">+30</span></button>
    {/if}
    <button type="button" class="pill" class:edge={edgeNow} aria-label={edgeNow ? $t('live.player.liveAria') : $t('live.player.behindAria', { time: behindText })} title={$t('live.player.toLive')} on:click={toLive}>{edgeNow ? $t('live.player.live') : $t('live.player.behind', { time: behindText })}</button>
    <span class="sp"></span>
    <!-- after the spacer: when it appears only the spacer gives way, nothing else moves -->
    {#if castShown}
      <button type="button" class="ib" bind:this={castBtn} class:on={airMode} aria-haspopup={inShell ? undefined : 'dialog'} aria-expanded={inShell ? undefined : playOnOpen} aria-busy={castBusy}
        aria-label={$t('player.castPicker.open')} title={$t('player.castPicker.open')} on:click={onCastBtn}><Icon name={airMode ? 'airplay' : 'cast'} size={24} /></button>
    {/if}
    <button type="button" class="ib" aria-label={$t('live.player.chUp')} title={up ? `${up.number} ${up.name}` : undefined} disabled={!up} on:click={() => switcher.press(1)}><Icon name="chevron-up" size={24} /></button>
    <button type="button" class="ib" aria-label={$t('live.player.chDown')} title={down ? `${down.number} ${down.name}` : undefined} disabled={!down} on:click={() => switcher.press(-1)}><Icon name="chevron-down" size={24} /></button>
    {#if !phoneUi}
      <button type="button" class="ib" bind:this={listBtn} aria-label={$t('live.player.channelList')} title={$t('live.player.channelList')} aria-haspopup="dialog" aria-expanded={listOpen} on:click={openList}><Icon name="list" size={24} /></button>
    {/if}
    <button type="button" class="ib" bind:this={infoBtn} aria-label={$t('live.player.info')} title={$t('live.player.info')} aria-expanded={panelOpen} on:click={openPanel}><Icon name="info" size={24} /></button>
    {#if !phoneUi}
      <button type="button" class="ib" aria-label={muted ? $t('player.unmute') : $t('player.mute')} on:click={toggleMute}><Icon name={muted || volume === 0 ? 'volume-off' : volume < 0.5 ? 'volume-low' : 'volume'} size={24} /></button>
      <input class="vol" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} aria-label={$t('player.volume.label')} on:input={(e) => setVolume(Number(e.currentTarget.value))} />
      <button type="button" class="ib" aria-label={fullscreen ? $t('player.controls.exitFullscreen') : $t('player.controls.fullscreen')} on:click={toggleFullscreen}><Icon name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} size={24} /></button>
    {/if}
  </div>
  {#if tv}<p class="ctlhint" class:hide={!controls}>{hint}</p>{/if}

  {#if panelOpen}
    <InfoPanel channel={cur} now={$minute} canRestart={restartAt !== null} last={prev} phone={phoneUi} {still} listButton={phoneUi}
      on:close={closePanel} on:restart={() => { closePanel(); restart(); }} on:last={() => { panelOpen = false; jumpLast(); wake(); }} on:list={openList} />
  {/if}
  {#if listOpen && pstate}
    <ChannelPanel state={pstate} groups={list?.groups ?? []} playingId={curId} now={$minute} phone={phoneUi} {still} {tv} trigger={listBtn ?? null}
      on:pick={(e) => pickChannel(e.detail.id)} on:filter={(e) => listFilter(e.detail)} on:focusrow={(e) => { if (pstate) pstate = { ...pstate, focus: e.detail }; }} on:close={closeList} />
  {/if}
  {#if refusal}
    <FullSheet ui={refusal} phone={phoneUi} {still} on:join={(e) => join(e.detail)} on:close={closeRefusal} />
  {/if}
  {#if airMode && !airWireless}
    <!-- the token URL is on the element; WebKit opens its picker only from a fresh tap -->
    <button type="button" class="frost-btn airask" on:click={pickAir}><Icon name="airplay" size={20} />{$t('player.airplay.choose')}</button>
  {/if}
  {#if remoteOn}
    <div class="lremote"><RemoteScreen on:close={leave} on:pick={(e) => openPlayOn(e.detail)} /></div>
  {/if}
  {#if !tv && !inShell}
    <PlayOnSheet open={playOnOpen} trigger={playOnTrigger} whatText={castWhat} title={cur?.name ?? ''} airplay={airAvail} airplayActive={airMode && airWireless} sheet={phoneUi}
      onAirPlay={airTap} onConnected={() => void castViaChromecast()} on:close={closePlayOn} on:continued={onContinued} />
  {/if}
  {#if num || numMsg}
    <NumberCard digits={num?.digits ?? ''} match={num?.match ?? null} zero={num?.zero ?? false} last={prev} message={numMsg} />
  {/if}
  <div class="sr-only" aria-live="polite">{announce}</div>
</div>

<style>
  .lplayer { position: fixed; left: 0; top: 0; right: 0; bottom: 0; z-index: 100; background: #000; color: #fff; overflow: hidden; outline: none; }
  .lstage { position: absolute; left: 0; top: 0; right: 0; bottom: 0; touch-action: none; user-select: none; -webkit-user-select: none; outline: none; }
  /* the stage takes the focus back from a closed panel: no ring around the whole picture (beats app.css html.tv :focus-visible) */
  .lstage:focus-visible { outline: none; }
  video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000; }

  /* buffering: the skeleton's sweep (app.css ff-shimmer, transform only) on a thin line */
  .lbuf { position: absolute; z-index: 3; left: 0; right: 0; top: 0; height: 3px; overflow: hidden; pointer-events: none; }
  .lbuf i { display: block; width: 100%; height: 100%; background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .85), transparent);
    transform: translateX(-100%); animation: ff-shimmer 1.2s ease-in-out infinite; }

  .ltop { position: absolute; z-index: 4; left: 0; right: 0; top: 0; display: flex; align-items: center; gap: 12px; box-sizing: border-box;
    padding: calc(12px + var(--safe-top, 0px)) max(20px, var(--safe-right, 0px)) 26px max(20px, var(--safe-left, 0px));
    background: linear-gradient(rgba(0, 0, 0, .72), rgba(0, 0, 0, 0)); transition: opacity 200ms var(--fr-out), transform 200ms var(--fr-out); }
  .ltop.hide { opacity: 0; transform: translateY(-8px); pointer-events: none; }
  .tlogo { flex: none; width: 40px; height: 40px; border-radius: 8px; overflow: hidden; background: rgba(255, 255, 255, .08); }
  .tlogo img { display: block; width: 100%; height: 100%; object-fit: contain; }
  .tinfo { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 12px; justify-content: flex-start; padding: 0 8px; background: transparent; color: #fff; text-align: left; }
  .tname { flex: none; font-weight: 800; }
  .ttitle { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ttime { flex: none; width: 7.5em; color: rgba(255, 255, 255, .78); font-variant-numeric: tabular-nums; }
  .left { flex: none; display: inline-block; width: 10.5em; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, .85); }
  .tprog { position: absolute; left: max(20px, var(--safe-left, 0px)); right: max(20px, var(--safe-right, 0px)); bottom: 12px; height: 2px; background: rgba(255, 255, 255, .2); overflow: hidden; }
  .tprog.off { opacity: 0; }
  .tprog i { display: block; height: 100%; background: #fff; transform-origin: left center; }

  .lcard { position: absolute; z-index: 6; left: 50%; top: 50%; width: min(460px, calc(100% - 40px)); box-sizing: border-box; padding: 20px 24px; border-radius: var(--fr-r-panel);
    text-align: center; transform: translate(-50%, -50%); }
  .lcard.solid { background: var(--fr-solid); }
  .ct { margin: 0; font-size: 1.15rem; font-weight: 700; }
  .cs { margin: 6px 0 0; min-height: 1.4em; color: rgba(255, 255, 255, .78); }
  .cbtn { min-height: 44px; margin-top: 12px; }

  .ctl { position: absolute; z-index: 7; left: max(16px, var(--safe-left, 0px)); right: max(16px, var(--safe-right, 0px)); bottom: calc(16px + var(--safe-bottom, 0px));
    display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: var(--fr-r-pill); transition: opacity 200ms var(--fr-out), transform 200ms var(--fr-out); }
  .ctl.hide { opacity: 0; transform: translateY(8px); pointer-events: none; }
  .ctl.solid { background: var(--fr-solid); }
  .ib { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; border-radius: 50%; background: transparent; color: #fff; }
  .ib:disabled { opacity: .4; cursor: default; }
  .ib .n { font-weight: 800; font-size: .9rem; font-variant-numeric: tabular-nums; }
  .pp { flex: none; width: 52px; height: 52px; padding: 0; border-radius: 50%; background: #fff; color: #000; }
  /* starting: the UI kit's spinner (app.css .spinner, ff-spin) in the play slot */
  .pp .spinner { font-size: 24px; }
  .restartslot { flex: none; display: inline-flex; width: 44px; height: 44px; }
  .pill { flex: none; position: relative; width: 7.5em; height: 44px; min-height: 44px; padding: 0 12px; border-radius: var(--fr-r-pill); background: transparent; color: #fff;
    box-shadow: inset 0 0 0 2px var(--acc-light); font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: .02em; }
  .pill.edge { background: var(--acc-fill); box-shadow: none; padding-left: 26px; }
  .pill.edge::before { content: ''; position: absolute; left: 14px; top: 50%; width: 8px; height: 8px; margin-top: -4px; border-radius: 50%; background: #fff; }
  .sp { flex: 1 1 auto; }
  .ib.on { background: var(--fr-sel); }
  /* the remote screen of a live cast covers the player (its controls, banner and cards stay underneath, nothing plays there) */
  .lremote { position: absolute; z-index: 40; left: 0; top: 0; right: 0; bottom: 0; }
  .airask { position: absolute; z-index: 8; right: max(20px, var(--safe-right, 0px)); top: calc(76px + var(--safe-top, 0px)); gap: 8px; padding: 0 16px; }
  .lplayer :global(.airprobe) { position: absolute; left: 0; bottom: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .vol { flex: none; width: 96px; accent-color: #fff; }

  .lplayer.phone .ctl { left: 8px; right: 8px; gap: 4px; padding: 6px 8px; bottom: calc(8px + var(--safe-bottom, 0px)); }
  .lplayer.phone .pill { width: 4.4em; padding: 0 4px; }
  .lplayer.phone .pill.edge { padding-left: 16px; }
  .lplayer.phone .pill.edge::before { left: 6px; }
  .lplayer.phone .ttime { display: none; }
  .lplayer.phone .left { width: 8.5em; }

  /* calm mode and reduced motion (both triggers, the CastBar pattern): nothing in the player moves, !important so app.css's
     reduced-motion rule (.001 ms on every element) cannot leave a hair of a transition; the buffering line stands still and the
     spinner is a still ring. TV and kids: no transitions. */
  :global(html.m-still) .lplayer, :global(html.m-still) .lplayer :global(*), :global(html.m-still) .lplayer :global(*::before) { transition: none !important; animation: none !important; }
  :global(html.m-still) .lbuf i { transform: none; opacity: .5; }
  @media (prefers-reduced-motion: reduce) {
    .lplayer, .lplayer :global(*), .lplayer :global(*::before) { transition: none !important; animation: none !important; }
    .lbuf i { transform: none; opacity: .5; }
  }
  :global(html.tv) .ctl, :global(html.tv) .ltop, :global(html.kids) .ctl, :global(html.kids) .ltop { transition: none; }

  :global(html.tv) .lplayer .ib, :global(html.tv) .lplayer .restartslot { width: 54px; height: 54px; }
  /* the TV controls' footer: the D-pad hint under the bar, its line reserved (the bar sits above it), hidden with the controls */
  :global(html.tv) .lplayer .ctl { bottom: calc(100vw / 1920 * 84); }
  .ctlhint { position: absolute; z-index: 7; left: 0; right: 0; bottom: calc(100vw / 1920 * 20); height: calc(100vw / 1920 * 48); margin: 0; text-align: center;
    color: rgba(255, 255, 255, .86); font-size: calc(100vw / 1920 * 28); line-height: calc(100vw / 1920 * 48); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    text-shadow: 0 1px 4px rgba(0, 0, 0, .8); pointer-events: none; }
  .ctlhint.hide { opacity: 0; }
  :global(html.tv) .lplayer .pp { width: 64px; height: 64px; }
  :global(html.tv) .lplayer .pill { height: 54px; font-size: calc(100vw / 1920 * 26); }
  :global(html.tv) .lplayer .ltop { font-size: calc(100vw / 1920 * 30); }
  :global(html.tv) .lplayer .cbtn { min-height: 54px; }
</style>
