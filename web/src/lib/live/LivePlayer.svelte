<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { goto, replaceState } from '$app/navigation';
  import type Hls from 'hls.js';
  import type { ErrorData } from 'hls.js';
  import { ApiError, getActiveProfile, getCsrf } from '#lib/api';
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
  import { atEdge, behind, oldestPoint, restartTarget, resumePoint } from './dvr';
  import { minute } from './fade';
  import FullSheet from './FullSheet.svelte';
  import InfoBanner from './InfoBanner.svelte';
  import InfoPanel from './InfoPanel.svelte';
  import { resolveLiveKey, type LiveKeyAction } from './livekeys';
  import { fromWatchError, lostDelay, nextLost, STALL_LOST_MS, type LiveUi, type LostUi } from './liveState';
  import NumberCard from './NumberCard.svelte';
  import { commitNumber, NUMBER_TIMEOUT_MS, typeDigit, type NumberState } from './numberEntry';
  import { channelOrder, neighbour, type LiveFilter } from './order';
  import { progressAt, timeLeft, timeLeftText, watchPath } from './progress';
  import { createSwitcher } from './switcher';

  /**
   * The live player (spec §12, §21), built from the film player's parts: hls.js with the live tuning (liveHlsConfig), volume,
   * gestures (zones), Media Session, the first-frame watchdog, the same control auto-hide (CONTROLS_HIDE_MS). No seek bar: Play/Pause,
   * Von Anfang an (reserved slot), −30 s / +30 s, the LIVE pill, channel ▲/▼, a reserved slot for Task 40's Senderliste, Programm,
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
   * playing keeps that channel's handlers alive.
   *
   * The two moving indicators reuse the app's global keyframes instead of their own: the buffering line sweeps like the skeleton
   * shimmer (`ff-shimmer`, transform only) and the starting spinner is the UI kit's `.spinner` (`ff-spin`). Calm mode and reduced
   * motion switch every transition and animation in the player off (the CastBar pattern, both triggers, !important so app.css's
   * reduced-motion rule cannot leave a .001 ms one); TV and kids: no transitions.
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
  let behindSec = 0, restartAt: number | null = null;
  let volume = 1, muted = false, brightness = 1;
  let announce = '';
  let num: NumberState | null = null, numMsg = '';
  /** `gen` counts starts (a newer start makes an older one's answers stale); `attachedGen` is the start whose stream is attached */
  let gen = 0, attachedGen = -1, destroyed = false, rewatched = false;
  /** a watch is on its way: the attached stream (if any) belongs to the channel before and its media events change nothing */
  let startPending = false;
  /** a refused media request: none, a beat is checking it, or loading carried on after an answered beat */
  let refused: 'none' | 'checking' | 'resumed' = 'none';
  let beatP: Promise<BeatResult> | null = null;
  let lostCycle: { since: number; attempt: number } | null = null;
  let hideT: Timer | undefined, retryT: Timer | undefined, pollT: Timer | undefined, leaveT: Timer | undefined, stallT: Timer | undefined, numT: Timer | undefined, tapT: Timer | undefined;
  let beatT: ReturnType<typeof setInterval> | undefined, tickT: ReturnType<typeof setInterval> | undefined, listT: ReturnType<typeof setInterval> | undefined;
  let stopFrame: (() => void) | null = null;
  const timing = createTiming();
  let session: ReturnType<typeof bindPlayerMediaSession> | null = null;

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
  $: bannerOn = Boolean(card) && !panelOpen && !errorUi
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
    try { r = await watch(id); } catch {
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
        return 'stay';
      }
      dropStream(); onFail(u);
      return 'moved';
    }
    const a = r.answer;
    const old = token;
    teardownHls();
    if (old && old !== a.token) void stopWatching(old, false).catch(() => undefined);
    answer = a; token = a.token; dvrSeconds = a.dvrSeconds; playingId = id; deliberate = false;
    void setLast(id).catch(() => undefined);
    startBeat();
    replaceUrl(id);
    void attach(a.url, g);
    return 'moved';
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
    pausedWall = null; behindSec = 0; restartAt = null; attachedGen = -1; refused = 'none';
  }

  async function attach(url: string, g: number): Promise<void> {
    const v = video;
    if (!v) return;
    attachedGen = g;
    refused = 'none';
    timing.begin(); timing.mode('live');
    stopFrame = watchFirstFrame(v, START_WATCHDOG_MS, () => {
      if (g === attachedGen && firstFrameAt === null) { dropStream(); onFail({ k: 'lost', attempt: 0 }); }
    });
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
   */
  function onHlsError(d: ErrorData, g: number): void {
    if (g !== attachedGen || !HlsCtor) return;
    const code = (d.response as { code?: number } | undefined)?.code;
    if (d.type === HlsCtor.ErrorTypes.NETWORK_ERROR && (code === 403 || code === 410)) { onMediaRefused(d, g); return; }
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
      } else refused = 'none'; // gone: a new watch is on its way; failed / stale: the stall watch and the next beat take over
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
   */
  async function beatOnce(): Promise<BeatResult> {
    const tk = token, g = gen;
    if (!tk) return 'stale';
    try {
      await beat(tk);
      if (g !== gen || tk !== token || destroyed) return 'stale';
      rewatched = false;
      return 'ok';
    } catch (e) {
      if (g !== gen || tk !== token || destroyed) return 'stale';
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
    wake();
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
    if (paused || panelOpen || refusal) return;
    hideT = setTimeout(hideControls, tv ? CONTROLS_HIDE_TV_MS : CONTROLS_HIDE_MS);
  }
  function hideControls(): void {
    if (paused || panelOpen) return;
    controls = false;
    const a = document.activeElement;
    if (tv && a instanceof HTMLElement && root && root !== a && root.contains(a)) root.focus({ preventScroll: true });
  }
  function onMouse(): void { if (!coarse) wake(); }
  function openPanel(): void { panelOpen = true; controls = true; clearTimeout(hideT); }
  function closePanel(): void { panelOpen = false; wake(); void tick().then(() => infoBtn?.focus()); }

  // ---- keys (one capture listener: the player owns its keys while it is open) ----
  function onBody(): boolean {
    const a = document.activeElement;
    return !a || a === document.body || a === root || a === stage;
  }
  function leave(): void {
    if (history.length > 1) history.back();
    else void goto('/live', { replaceState: true });
  }
  function goBack(): void {
    if (num || numMsg) { closeNumber(); return; }
    if (panelOpen) { closePanel(); return; }
    if (refusal) { closeRefusal(); return; }
    if (document.fullscreenElement) { void document.exitFullscreen().catch(() => undefined); return; }
    if (tv && controls) { controls = false; clearTimeout(hideT); root?.focus({ preventScroll: true }); return; }
    leave();
  }
  function onKey(e: KeyboardEvent): void {
    if (destroyed) return;
    const back = e.key === 'Escape' || (tv && isBackKey(e));
    if (back) { e.preventDefault(); e.stopImmediatePropagation(); goBack(); return; }
    if (refusal) return; // the sheet's buttons own the keys
    if (!tv) wake(); else if (controls) wake();
    const a = resolveLiveKey(e, { tv, lg: false, controlsVisible: controls, onBody: onBody(), overlayOpen: panelOpen, numberOpen: num !== null });
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
      default: break; // channelList: the panel of Task 40
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
  function onPageHide(): void {
    const tk = token;
    if (!tk) return;
    token = null;
    void stopWatching(tk, true).catch(() => undefined);
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
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('fullscreenchange', onFs);
    tickT = setInterval(onTick, 250);
    listT = setInterval(() => { if (!document.hidden) void loadList(); }, LIST_REFRESH_MS);
    if (video) session = bindPlayerMediaSession(video, msItem(cur), msActions);
    void loadList();
    void start(channelId);
    wake();
    root?.focus({ preventScroll: true });
    return () => {
      mo.disconnect();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('fullscreenchange', onFs);
    };
  });
  onDestroy(() => {
    destroyed = true;
    gen++;
    for (const h of [hideT, retryT, pollT, leaveT, stallT, numT, tapT]) clearTimeout(h);
    clearInterval(beatT); clearInterval(tickT); clearInterval(listT);
    switcher.dispose();
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
  <div class="lstage" bind:this={stage} role="presentation" on:pointerdown={gDown} on:pointermove={gMove} on:pointerup={gUp} on:pointercancel={gCancel} on:dblclick={() => { if (!coarse) toggleFullscreen(); }}>
    <video bind:this={video} playsinline crossorigin="use-credentials" style:filter={brightness < 1 ? `brightness(${brightness})` : null}
      on:playing={onPlaying} on:waiting={onWaiting} on:pause={onPause} on:play={onPlay} on:volumechange={onVolume}></video>
  </div>

  {#if ui.k === 'buffering'}<div class="lbuf" aria-hidden="true"><i></i></div>{/if}

  <div class="ltop" class:hide={!controls}>
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
    <span class="restartslot">
      {#if restartAt !== null}<button type="button" class="ib" aria-label={$t('live.player.restart')} title={$t('live.player.restart')} on:click={restart}><Icon name="skip-prev" size={24} /></button>{/if}
    </span>
    {#if !phoneUi}
      <button type="button" class="ib" bind:this={backBtn} aria-label={$t('live.player.back30')} title={$t('live.player.back30')} on:click={() => seekBy(-30)}><span class="n" aria-hidden="true">−30</span></button>
      <button type="button" class="ib" bind:this={fwdBtn} aria-label={$t('live.player.fwd30')} title={$t('live.player.fwd30')} disabled={edgeNow} on:click={() => seekBy(30)}><span class="n" aria-hidden="true">+30</span></button>
    {/if}
    <button type="button" class="pill" class:edge={edgeNow} aria-label={edgeNow ? $t('live.player.liveAria') : $t('live.player.behindAria', { time: behindText })} title={$t('live.player.toLive')} on:click={toLive}>{edgeNow ? $t('live.player.live') : $t('live.player.behind', { time: behindText })}</button>
    <span class="sp"></span>
    <button type="button" class="ib" aria-label={$t('live.player.chUp')} title={up ? `${up.number} ${up.name}` : undefined} disabled={!up} on:click={() => switcher.press(1)}><Icon name="chevron-up" size={24} /></button>
    <button type="button" class="ib" aria-label={$t('live.player.chDown')} title={down ? `${down.number} ${down.name}` : undefined} disabled={!down} on:click={() => switcher.press(-1)}><Icon name="chevron-down" size={24} /></button>
    {#if !phoneUi}<span class="listslot" aria-hidden="true"></span>{/if}
    <button type="button" class="ib" bind:this={infoBtn} aria-label={$t('live.player.info')} title={$t('live.player.info')} aria-expanded={panelOpen} on:click={openPanel}><Icon name="info" size={24} /></button>
    {#if !phoneUi}
      <button type="button" class="ib" aria-label={muted ? $t('player.unmute') : $t('player.mute')} on:click={toggleMute}><Icon name={muted || volume === 0 ? 'volume-off' : volume < 0.5 ? 'volume-low' : 'volume'} size={24} /></button>
      <input class="vol" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} aria-label={$t('player.volume.label')} on:input={(e) => setVolume(Number(e.currentTarget.value))} />
      <button type="button" class="ib" aria-label={fullscreen ? $t('player.controls.exitFullscreen') : $t('player.controls.fullscreen')} on:click={toggleFullscreen}><Icon name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} size={24} /></button>
    {/if}
  </div>

  {#if panelOpen}
    <InfoPanel channel={cur} now={$minute} canRestart={restartAt !== null} last={prev} phone={phoneUi} {still}
      on:close={closePanel} on:restart={() => { closePanel(); restart(); }} on:last={() => { panelOpen = false; jumpLast(); wake(); }} />
  {/if}
  {#if refusal}
    <FullSheet ui={refusal} phone={phoneUi} {still} on:join={(e) => join(e.detail)} on:close={closeRefusal} />
  {/if}
  {#if num || numMsg}
    <NumberCard digits={num?.digits ?? ''} match={num?.match ?? null} zero={num?.zero ?? false} last={prev} message={numMsg} />
  {/if}
  <div class="sr-only" aria-live="polite">{announce}</div>
</div>

<style>
  .lplayer { position: fixed; left: 0; top: 0; right: 0; bottom: 0; z-index: 100; background: #000; color: #fff; overflow: hidden; outline: none; }
  .lstage { position: absolute; left: 0; top: 0; right: 0; bottom: 0; touch-action: none; user-select: none; -webkit-user-select: none; }
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
  .restartslot, .listslot { flex: none; display: inline-flex; width: 44px; height: 44px; }
  .pill { flex: none; position: relative; width: 7.5em; height: 44px; min-height: 44px; padding: 0 12px; border-radius: var(--fr-r-pill); background: transparent; color: #fff;
    box-shadow: inset 0 0 0 2px var(--acc-light); font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: .02em; }
  .pill.edge { background: var(--acc-fill); box-shadow: none; padding-left: 26px; }
  .pill.edge::before { content: ''; position: absolute; left: 14px; top: 50%; width: 8px; height: 8px; margin-top: -4px; border-radius: 50%; background: #fff; }
  .sp { flex: 1 1 auto; }
  .vol { flex: none; width: 96px; accent-color: #fff; }

  .lplayer.phone .ctl { left: 8px; right: 8px; gap: 4px; padding: 6px 8px; bottom: calc(8px + var(--safe-bottom, 0px)); }
  .lplayer.phone .pill { width: 5.6em; padding: 0 8px; }
  .lplayer.phone .pill.edge { padding-left: 20px; }
  .lplayer.phone .pill.edge::before { left: 9px; }
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

  :global(html.tv) .lplayer .ib, :global(html.tv) .lplayer .restartslot, :global(html.tv) .lplayer .listslot { width: 54px; height: 54px; }
  :global(html.tv) .lplayer .pp { width: 64px; height: 64px; }
  :global(html.tv) .lplayer .pill { height: 54px; font-size: calc(100vw / 1920 * 26); }
  :global(html.tv) .lplayer .ltop { font-size: calc(100vw / 1920 * 30); }
  :global(html.tv) .lplayer .cbtn { min-height: 54px; }
</style>
