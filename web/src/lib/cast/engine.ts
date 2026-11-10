// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cast engine: owns a running cast session (Chromecast or AirPlay) so it outlives the watch page.
 *
 * The Player hands a running cast over with `adopt()`; from then on the engine mirrors the receiver into `castSession`,
 * reports `start` / `progress` / `stop` for the cast token (`/api/playback/*`), renews the token, and switches titles
 * on the TV (`playOnTv`: old title stopped and its token revoked, new token loaded). One cast token is live at a time.
 * Nothing (listeners, timers, requests) is touched before the first `adopt()`.
 *
 * AirPlay: the route belongs to the Player's `<video>`, so `adopt()` MOVES that element (and the availability probe) into
 * `document.body`, hidden but rendered, and rebinds its AirPlay controller to the engine. A title switch is a new token URL
 * on the same element (`switchItem`); the controller keeps its grace / settle / breaker logic. A sustained route loss
 * leaves the session in `reconnect`: a tap on the bar (`reconnect()`) opens the picker inside the gesture.
 *
 * End of an episode on the TV, like the player's own "next up": from the credits (Outro segment, else the last 25 s) the bar /
 * remote shows the next episode (`next`); with autoplay allowed it starts after the countdown (`playOnTv`, resume position),
 * cancelable. At the very end (no credits countdown ran) the same offer follows the end. Without a next episode the session ends
 * `ENDED_HIDE_MS` later; an offered episode nobody starts ends it after `ENDED_IDLE_MS`.
 * The countdown runs in page JS, which a locked phone / backgrounded browser suspends. So the TV moves on by itself where it can:
 * Chromecast gets the next episode (own token, `next: true`) in the receiver's queue as soon as the title plays and its length is
 * known (autoplay allowed for the expected end time); the receiver advances at the end and the engine follows (`advanced`). When
 * it should have and did not, the engine loads that episode with a FRESH token (the queued one may have lapsed).
 * The session's autoplay switch (`setAutoplay`) turns all of that off (or on) for the rest of the session.
 * AirPlay has no receiver queue: an `ended` while the page is hidden, or found on wake (`onWake`), starts the next one at once.
 * Intro / recap segments offer `skip` (seek past it).
 * FriendFlix's own receiver (CAST_RECEIVER_APP_ID; `cast.castCustomReceiver()`): the engine also tells the TV what it needs for its own
 * UI (`tvSync`: segments, the queued next episode, still-watching) and the TV runs the next-up countdown and moves on to the queued
 * episode itself; "still watching?" no longer blocks the queue there (the queued item waits paused until it is answered on the TV,
 * the remote or the phone's play button). With the Default Media Receiver none of this runs.
 *
 * A Chromecast cast survives the tab: `pagehide` only disconnects this sender (`deps.leave()`), reports nothing, revokes nothing
 * and leaves the receiver's queue alone; the non-secret hint `ff-cast-hint` (public castId, item, device) stays. A later page
 * re-adopts with `resume()` (the SDK auto-joined: `session-resume`): the receiver's media is matched to a token of this account,
 * profile and device by the token-free lookup `GET /api/cast/session/:castId`; anything else is left alone and the hint dropped.
 * Without an auto-join the bar shows `detached` from the hint (Reconnect: device picker, then `resume()`; Stop: revoke by castId).
 * AirPlay still ends on `pagehide` (the route belongs to this page's `<video>`).
 *
 * One owner per browser: a re-adopting engine holds the Web Lock `CAST_LOCK` (`deps.lock`). Another tab of the origin auto-joins
 * the same receiver session but does not re-adopt while the lock is held: it shows no bar (no second set of reports, renewals,
 * queue tokens or revokes) and waits for the lock; when the owner tab goes (pagehide, Stop) it picks the cast up itself.
 */
import { get, writable, type Readable, type Writable } from 'svelte/store';
import { api, cachedItem, secToTicks, ticksToSec, type Item, type ItemDetail } from '#lib/api';
import { castAdoptTracks, castBody, castCustomReceiver, castLeave, castPlayPause, castQueueNext, castQueueRemove, castSeek, castSendMessage, castSetSubtitle, castState, castStop, loadOnCast, onCastEvent, onReceiverMessage, queueOnCast, requestCastSession, whenCastReady, type CastEvent, type CastInfo, type CastState } from '#lib/cast';
import { segmentShown, serverCaps } from '#lib/capabilities';
import { tr } from '#lib/i18n';
import { createAirPlay, type AirPlayController, type AirPlayDeps, type AirPlayState } from '#lib/player/airplay';
import { airLog } from '#lib/player/airplayLog';
import { castLog, type CastLogEntry } from './castLog';
import { castIdOfContentUrl, clearHint, lookupToCastInfo, readHint, sha256Hex, writeHint, type CastHint, type CastLookup, type Store } from './resume';
import { barTitles, firstInfoBody } from '#lib/player/bar';
import { episodeLabel } from './remoteview';
import { COUNTDOWN_SECONDS, creditsStart, mayAutoplay, type Segment } from '#lib/player/nextup';
import { consumeAutoplay, noteAutoplay, noteInteraction, shouldAsk } from '#lib/stillwatching';
import { prefs, type Prefs } from '#lib/stores';
import { toast } from '#lib/ui/toast';

export type CastKind = 'airplay' | 'chromecast';
/** `detached`: a Chromecast cast an earlier page left running, known only from the hint (Reconnect / Stop) */
export type CastPhase = 'connecting' | 'playing' | 'reconnect' | 'ended' | 'failed' | 'detached';
/** an audio or subtitle track the remote (an attached Player) offers */
export interface CastTrack { index: number; title: string; language?: string; isDefault?: boolean }
export interface CastSession {
  kind: CastKind; device: string; itemId: string; seriesId?: string;
  title: string; subtitle: string; posterId: string; isEpisode: boolean;
  position: number; duration: number; paused: boolean; buffering: boolean; state: CastPhase;
  /** the title's tracks for the remote's tracks menu (another title: no audio list, its token's subtitles) and the current choice */
  audioTracks: CastTrack[]; subtitles: CastTrack[]; audioIndex?: number; subIndex: number;
  /** from the credits (playing) or in `ended` when a next episode follows; startsAt = epoch ms of the autoplay (null = button only) */
  next?: { itemId: string; label: string; startsAt: number | null };
  /** the intro / recap segment the TV is in (`skipSegment()` seeks to its end) */
  skip?: { type: string; end: number };
  /** the session's autoplay switch: the next episode follows by itself (initially the profile's autoplay and no "sleep after") */
  autoplay: boolean;
  /** the live token's public handle (Diagnose); absent while switching, after the end and for AirPlay before a token plays */
  castId?: string;
}
export interface PlayerHandoff {
  kind: CastKind; itemId: string; seriesId?: string; title: string; subtitle: string; isEpisode: boolean;
  position: number; duration: number; paused: boolean;
  cast: CastInfo; /** the Player already sent `start` for this cast session */ started: boolean;
  audioIndex?: number; subIndex: number; maxBitrate?: number; sleepAfterEpisode: boolean;
  /** the title's tracks (from the playback info), so a Player that attaches later can offer them */
  audioTracks?: CastTrack[]; subtitles?: CastTrack[];
  /** AirPlay only: the Player's element, its controller and the availability probe */
  video?: HTMLVideoElement; air?: AirPlayController; probe?: HTMLVideoElement | null;
}
export interface CastEngine {
  adopt(h: PlayerHandoff): void;
  playPause(): void; seek(sec: number): void; skip(delta: number): void;
  /** plays another title on the TV (no `startAt` = the server's resume position) */
  playOnTv(itemId: string, startAt?: number): Promise<void>;
  /** plays the next episode now (from a tap): the known one in `ended`, else the episode after the playing one */
  next(): Promise<void>;
  /** from a tap: the next episode's autoplay countdown stops, the episode stays offered (and leaves the receiver's queue) */
  cancelNext(): void;
  /** from a tap: past the intro / recap the TV is in */
  skipSegment(): void;
  stop(): Promise<void>;
  /** from a tap on the bar in `reconnect`: Chromecast retries the last token request once */
  reconnect(): void;
  /** new token at the current position (audio track / quality change, renewal) */
  refresh(o?: { audioIndex?: number; maxBitrate?: number }): Promise<void>;
  setSubtitle(index: number): void;
  /** drops a `failed` session without touching the receiver ("Play here") */
  release(): void;
  /** "change device" (from a tap): AirPlay opens the system picker of the engine's controller synchronously; Chromecast: no-op */
  pick(): void;
  /**
   * Re-adopts FriendFlix media the receiver plays (the SDK joined a running session). Only when the engine owns nothing; single
   * flight. Resolves true when the cast is the engine's again; false: nothing loaded within `RESUME_WAIT_MS`, not ours (hint
   * dropped), lookup failed, or a hand-off came first.
   */
  resume(): Promise<boolean>;
  /** the session's autoplay switch (from a tap): off cancels a running countdown and the queued episode, for every later episode too */
  setAutoplay(on: boolean): void;
  readonly airState: Readable<AirPlayState | null>;
}
export type CastFns = Pick<typeof import('#lib/cast'), 'castState' | 'onCastEvent' | 'loadOnCast' | 'castPlayPause' | 'castSeek' | 'castStop' | 'castSetSubtitle' | 'queueOnCast' | 'castQueueRemove' | 'castQueueNext' | 'castAdoptTracks'>
  /** FriendFlix's own receiver (absent = Default Media Receiver behaviour) */
  & Partial<Pick<typeof import('#lib/cast'), 'castCustomReceiver' | 'castBody' | 'castSendMessage' | 'onReceiverMessage'>>;
export interface EngineDeps {
  api: typeof api; item(id: string): Promise<Item>; cast: CastFns; air: typeof createAirPlay;
  /** the title's skip / credits segments the server offers ([] = none or unknown) */
  segments(itemId: string): Promise<Segment[]>;
  /** the page is hidden (locked phone, other app): timers may not run */
  hidden(): boolean;
  /** the page is shown again (visibilitychange / pageshow) */
  onWake(fn: () => void): () => void;
  body(): HTMLElement; onPageHide(fn: () => void): () => void; toast(kind: 'info' | 'error', msg: string): void;
  prefs(): Prefs; timers: { set(fn: () => void, ms: number): unknown; clear(t: unknown): void; now(): number };
  /** the page was hidden (visibilitychange): only logged */
  onHidden(fn: () => void): () => void;
  /** localStorage (null: blocked): the resume hint `ff-cast-hint` */
  readonly store: Store;
  /** sha256 hex of a string (the castId of a token on the receiver; the token never leaves this call) */
  digest(s: string): Promise<string>;
  /** the on-device cast log (text is scrubbed there) */
  log(e: Omit<CastLogEntry, 'at'>): void;
  /** the browser's device picker (from a tap): true once a session runs */
  requestSession(): Promise<boolean>;
  /** this sender disconnects, the receiver plays on (Chromecast pagehide) */
  leave(): void;
  /** runs `fn` once the Cast SDK is set up (at once when it already is; never without the SDK) */
  whenReady(fn: () => void): void;
  /**
   * The one-owner-per-browser lock (navigator.locks): resolves its release function, or null when another tab holds it and
   * `ifAvailable` is set (without it: waits until granted). Without the Locks API every tab owns (resolves a no-op release).
   */
  lock(ifAvailable: boolean): Promise<(() => void) | null>;
  /** the page came back from the back/forward cache (pageshow, persisted); registered once */
  onRestore(fn: () => void): void;
}

/** progress report cadence while the receiver plays */
export const PROGRESS_MS = 10_000;
/** a cast token is renewed when it expires within this */
export const RENEW_BEFORE_MS = 10 * 60_000;
/** the bar stays this long after the title ended */
export const ENDED_HIDE_MS = 5_000;
/** an offered next episode nobody starts (no autoplay, or its countdown cancelled): the session ends after this */
export const ENDED_IDLE_MS = 30 * 60_000;
/** the receiver was told to move on to the queued episode (or reported the end with one queued): load it ourselves after this */
export const ADVANCE_WAIT_MS = 20_000;
/** `resume()` waits this long for the receiver's media status */
export const RESUME_WAIT_MS = 10_000;
/** a fresh hint and no resume this long after the SDK is ready: the bar shows `detached` */
export const DETACHED_AFTER_MS = 5_000;
/** the queue request found the playing token not yet fetched by the TV (409 cast_unpinned): asked once more after this */
export const UNPINNED_RETRY_MS = 60_000;
/** a stall on the TV longer than this is logged (and its recovery) */
export const STALL_LOG_MS = 2_000;

/** the Web Lock of the tab that owns the Chromecast cast (one owner per browser) */
export const CAST_LOCK = 'ff-cast-engine';
/** marks the AirPlay `<video>` the engine owns (in `document.body`) */
export const CAST_VIDEO_ATTR = 'data-cast-engine';
/** rendered but invisible and inert: WebKit may skip `display:none` media elements for AirPlay */
const HIDDEN_STYLE = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none';
/** element events the engine mirrors (and `error`, which goes to the controller) */
const AIR_EVENTS = ['timeupdate', 'play', 'pause', 'waiting', 'playing', 'ended', 'durationchange', 'error'] as const;

/** the AirPlay part of a session: the moved element, its controller and the probe */
interface AirLive {
  video: HTMLVideoElement; ctl: AirPlayController; probe: HTMLVideoElement | null;
  /** the title a switch asked for, until a token for it plays (`at` undefined = the server's resume position) */
  want: { itemId: string; at: number | undefined } | null;
  /** the controller call of the latest switch: the next switch waits for it (the controller runs one request at a time) */
  op: Promise<void>;
  /** the switch (`seq`) whose controller call runs */
  opSeq: number | null;
  /** `reconnect()` was tapped: play as soon as the TV is the target again */
  resume: boolean;
  /** pagehide: revoke at once, with keepalive */
  leaving: boolean;
  /** tokens the engine revoked itself (the ended one): the controller's own revoke of them is skipped */
  revoked: Set<string>;
}

/** the engine's bookkeeping for the session in `castSession` */
interface Live {
  view: CastSession;
  /** the live cast token (null while switching, after a failure and after the end) */
  ci: CastInfo | null;
  /** `start` was reported for `ci` (a `stop` is owed) */
  started: boolean;
  /** a token switch is in flight: the receiver still reports the previous media */
  busy: boolean;
  /** the latest `stop` report: the next token request waits for it (the server counts the stream until then) */
  stopping: Promise<unknown>;
  lastPaused: boolean | null;
  /** a renewal of a paused TV: the token loads without autoplay and `start` follows once it is loaded (paused) */
  hold: boolean;
  audioIndex?: number; subIndex: number; maxBitrate?: number; sleepAfterEpisode: boolean;
  /** what `reconnect()` repeats after a failed token request */
  retry: (() => Promise<void>) | null;
  offs: Array<() => void>;
  loop?: unknown;
  /** after the end: the session end after `ENDED_HIDE_MS` / `ENDED_IDLE_MS`, or the next episode's autoplay */
  hide?: unknown;
  /** after the end: ends the session (its stop is reported, its token revoked) */
  close?: () => void;
  air?: AirLive;
  /** the title's intro / recap / credits segments */
  segs: Segment[];
  /** the credits of this title were reached: its next episode is offered (once) */
  credits: boolean;
  /** the offered next episode (`next`) */
  offered?: Item;
  /** the next episode whose countdown was cancelled: nothing autoplays into it */
  noAuto?: string;
  /** Chromecast: the next episode in the receiver's queue (its own token) and whether it was asked for this title */
  queued?: { ci: CastInfo; it: Item; qid: number; /** own receiver: it waits paused for a "still watching?" answer */ ask?: boolean };
  queueAsked: boolean;
  /** the countdown (not the receiver alone) moved on: the autoplay is already counted */
  going: boolean;
  /** fallback timer while the receiver should move on to the queued episode */
  wait?: unknown;
  /** the session's autoplay switch (null: the profile's autoplay and this episode's "sleep after" decide) */
  autoSet: boolean | null;
  /** a queue request runs */
  queueing: boolean;
  /** the one retry after `409 cast_unpinned` (per title): its timer, and whether it was used */
  requeue?: unknown;
  unpinRetried: boolean;
  /** the cast log's name of the title ("S1 E4", "episode", "film"; never its name) */
  label: string;
  /** when the live token was loaded on the receiver (its first `playing` is logged with the time since) */
  loadAt?: number;
  /** a stall on the TV: since when, and whether it was logged */
  stallAt?: number;
  stallLogged: boolean;
  /** the running swap is a renewal (logged with the new token's validity) */
  renewing: boolean;
}

/** a cast token's subtitles as remote tracks (without their URLs) */
const subsOf = (ci: CastInfo): CastTrack[] => ci.subtitles.map(({ index, title, language }) => ({ index, title, language }));

/** the bar's label of the next episode: "S1:E2 · Name", the name alone without season / episode numbers (the header's format) */
const nextLabel = (it: Item): string => episodeLabel(it);

/** the cast log's name of a title: "S1 E4", "episode" without numbers, "film" (never a name or id) */
function labelOf(it: Pick<Item, 'type' | 'indexNumber' | 'parentIndexNumber'> | null, episode = false): string {
  if (it ? it.type !== 'Episode' : !episode) return 'film';
  return it?.parentIndexNumber != null && it.indexNumber != null ? `S${it.parentIndexNumber} E${it.indexNumber}` : 'episode';
}
/** a position for the cast log: m:ss or h:mm:ss */
function clock(sec: number): string {
  const t = Math.max(0, Math.floor(sec)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
}
/** an api error for the cast log: "409 cast_unpinned", "network" */
function errText(e: unknown): string {
  const x = e as { status?: unknown; body?: { error?: unknown } } | null;
  return typeof x?.status === 'number' ? `${x.status}${typeof x.body?.error === 'string' ? ` ${x.body.error}` : ''}` : 'network';
}
/** a queued title the item lookup could not load: what the bar needs, from the token lookup */
const itemOfLookup = (l: CastLookup): Item => ({ id: l.itemId, name: l.title, type: l.seriesName ? 'Episode' : 'Movie', ...(l.seriesName ? { seriesName: l.seriesName } : {}),
  genres: [], image: true, backdrop: false, logo: false, played: false, favorite: false, positionTicks: 0 });

/** the Player's texts for a failed token request */
function castErr(e: unknown, kind: CastKind = 'chromecast'): string {
  const b = (e as { body?: { error?: string; max?: unknown } } | null)?.body;
  const k = kind === 'airplay' ? 'airplay' : 'cast';
  return b?.error === 'max_streams' ? tr('player.error.maxStreams', { n: Number(b.max) })
    : b?.error === 'transcoding_disabled' ? tr(`player.${k}.needsTranscode`) : tr(`player.${k}.failed`);
}

/** the texts FriendFlix's own receiver shows (in the sender's language; the TV has no language of its own) */
export function receiverStrings() {
  return {
    next: tr('player.watch.next'), upNext: tr('player.castBar.next', { label: '{label}' }), watchCredits: tr('player.watch.watchCredits'),
    startsIn: Array.from({ length: COUNTDOWN_SECONDS }, (_, i) => tr('player.watch.startsIn', { n: i + 1 })),
    stillTitle: tr('player.watch.stillTitle'), stillText: tr('player.watch.stillText', { ep: '{ep}' }), keepWatching: tr('player.watch.keepWatching'),
    skip: { intro: tr('player.skip.intro'), recap: tr('player.skip.recap') },
  };
}

export function createCastEngine(deps: EngineDeps, out: Writable<CastSession | null> = writable(null)): CastEngine {
  const { api: call, cast, timers } = deps;
  /** FriendFlix's own receiver is the Chromecast app (never AirPlay) */
  const custom = (s: Live) => !s.air && Boolean(cast.castCustomReceiver?.());
  /** a Chromecast token request body (the own receiver also gets its report token) */
  const castReq = (b: Record<string, unknown>) => (cast.castBody ? cast.castBody(b) : b);
  /** own receiver: what its TV UI needs for the playing token (segments, the queued next episode and how it may start) */
  const tvSync = (s: Live) => {
    if (cur !== s || !s.ci || !custom(s)) return;
    const q = s.queued;
    cast.castSendMessage?.({ t: 'item', castId: s.ci.castId, episode: s.view.isEpisode, segs: s.segs,
      next: q ? { castId: q.ci.castId, label: nextLabel(q.it), auto: s.noAuto !== q.it.id && s.autoSet !== false, ask: Boolean(q.ask) } : null });
  };
  /** own receiver: texts, subtitle style and countdown length, once per session (and again after a new token load) */
  const tvUi = (s: Live) => {
    if (cur !== s || !custom(s)) return;
    cast.castSendMessage?.({ t: 'ui', strings: receiverStrings(), sub: deps.prefs().subtitleStyle, countdown: COUNTDOWN_SECONDS });
  };
  /** own receiver: input on the TV (its remote) */
  function fromTv(s: Live, m: Record<string, unknown>) {
    if (cur !== s) return;
    if (m.t === 'interaction') noteInteraction(); // a viewer is there: the unattended-autoplay chain starts over
    else if (m.t === 'cancel' && s.queued) {
      // the countdown was cancelled on the TV: like cancelNext from the phone
      noteInteraction();
      s.noAuto = s.queued.it.id;
      if (s.hide !== undefined) { timers.clear(s.hide); s.hide = s.close ? timers.set(s.close, ENDED_IDLE_MS) : undefined; }
      dequeue(s);
      if (s.view.next) patch(s, { next: { ...s.view.next, startsAt: null } });
      tvSync(s);
    }
  }
  const airState = writable<AirPlayState | null>(null);
  let cur: Live | null = null;
  /** bumped by every switch and by the end of a session: an older async step that sees another value gives up */
  let seq = 0;
  /** this page left a Chromecast cast running (pagehide): the SDK's session end that follows is no stop */
  let leaving = false;
  /** the running `resume()` (single flight) */
  let resuming: Promise<boolean> | null = null;
  /** the `detached` bar: a cast known only from the hint */
  let detached: { hint: CastHint; view: CastSession } | null = null;
  /** the boot timer of the `detached` bar; set when it ran out while a resume was still waiting */
  let detachTimer: unknown;
  let detachDue = false;
  /** bumped by every Stop, hand-off and release: a resume or reconnect started before gives up (it must not bring a stopped cast back) */
  let gen = 0;
  /** the owner lock's release while this tab owns the Chromecast cast; `follower`: another tab owns it (no detached bar here) */
  let lockRelease: (() => void) | null = null;
  let follower = false;
  let lockWaiting = false;
  /** a Stop is still reporting / revoking: the lock stays (a waiting tab must not re-adopt the cast before the revoke is through) */
  let holdLock = false;

  const log = (level: CastLogEntry['level'], tag: CastLogEntry['tag'], text: string) => { try { deps.log({ level, tag, text }); } catch { /* never breaks a cast */ } };
  /** the session's autoplay (the switch, else the profile's autoplay and this episode's "sleep after") */
  const autoOf = (s: Live) => s.autoSet ?? (deps.prefs().autoplayNext && !s.sleepAfterEpisode);
  /** mayAutoplay's input for this session (the switch overrides the profile's autoplay) */
  const autoArgs = (s: Live, askStill: boolean) => ({ kind: 'episode' as const, autoplayNext: s.autoSet ?? deps.prefs().autoplayNext, sleepAfterEpisode: s.sleepAfterEpisode, askStill });

  const patch = (s: Live, p: Partial<CastSession>) => {
    if (cur !== s) return;
    s.view = { ...s.view, ...p, autoplay: autoOf(s), castId: s.ci?.castId };
    out.set(s.view);
  };
  /** Chromecast: the hint names the live token (the next page finds the cast by it); AirPlay never leaves one */
  const hint = (s: Live) => {
    if (s.air || !s.ci) return;
    writeHint(deps.store, { castId: s.ci.castId, next: s.queued?.ci.castId, itemId: s.view.itemId, device: s.view.device, exp: s.ci.expiresAt, at: timers.now() });
  };
  const dropHint = (s: Live) => { if (!s.air) clearHint(deps.store); };
  const report = (s: Live, kind: 'start' | 'progress' | 'stop', ci: CastInfo, keepalive = false): Promise<unknown> => call(`/api/playback/${kind}`, {
    method: 'POST',
    body: { itemId: s.view.itemId, playSessionId: ci.playSessionId, mediaSourceId: ci.mediaSourceId, positionTicks: secToTicks(s.view.position), isPaused: s.view.paused, audioIndex: s.audioIndex, playMethod: 'Transcode' },
    ...(keepalive ? { keepalive } : {}),
  }).catch(() => undefined);
  /** the owed `stop` for the live token (resolves at once when none is owed) */
  const stopReport = (s: Live, keepalive = false): Promise<unknown> => {
    if (!s.started || !s.ci) return Promise.resolve();
    s.started = false;
    s.stopping = report(s, 'stop', s.ci, keepalive);
    return s.stopping;
  };
  const revokeId = (castId: string, keepalive = false) =>
    call(`/api/cast/session/${castId}`, { method: 'DELETE', ...(keepalive ? { keepalive } : {}) }).catch(() => undefined);
  const revoke = (ci: CastInfo | null, keepalive = false) => { if (ci) void revokeId(ci.castId, keepalive); };
  /** forgets the session: listeners and timers off, `castSession` null (the token is the caller's business) */
  const end = (s: Live, why: string) => {
    if (cur !== s) return;
    cur = null;
    seq++;
    for (const off of s.offs) off();
    s.offs = [];
    timers.clear(s.loop);
    if (s.hide !== undefined) timers.clear(s.hide);
    if (s.wait !== undefined) timers.clear(s.wait);
    if (s.requeue !== undefined) timers.clear(s.requeue);
    dequeue(s);
    out.set(null);
    log('info', 'session', `cast ended · ${why}`);
    queueMicrotask(freeLock); // unless a hand-off took over at once
  };
  /** the owner lock goes when this tab owns nothing (another tab waiting for it picks the cast up) */
  function freeLock() {
    if (cur || holdLock || !lockRelease) return;
    const r = lockRelease;
    lockRelease = null;
    r();
  }
  /** this tab owns the Chromecast cast (true), or another tab does (false: this one follows and waits for the lock) */
  async function ownLock(ifAvailable: boolean): Promise<boolean> {
    if (lockRelease) return true;
    const r = await deps.lock(ifAvailable).catch(() => () => undefined);
    if (!r) return false;
    if (lockRelease) { r(); return true; }
    lockRelease = r;
    follower = false;
    return true;
  }
  /** another tab owns the cast: wait for its lock, then re-adopt here */
  function follow() {
    follower = true;
    if (lockWaiting) return;
    lockWaiting = true;
    void ownLock(false).then((ok) => {
      lockWaiting = false;
      if (!ok || cur) return;
      // Stop and a session end clear the hint before the owner lets the lock go; a pagehide keeps it
      if (!readHint(deps.store, timers.now())) { freeLock(); return; }
      log('info', 'session', 'the owner tab left · taking the cast over');
      // not joined here (no auto-join): the bar comes back as `detached` (Reconnect / Stop), as on a fresh page
      void resume().then((ok) => { if (!ok && !cur && !follower) boot(); });
    });
  }
  /** the queued next episode leaves the receiver's queue; its token (never reported, never started) is revoked */
  const dequeue = (s: Live, keepalive = false) => {
    const q = s.queued;
    if (!q) return;
    s.queued = undefined;
    cast.castQueueRemove(q.qid);
    revoke(q.ci, keepalive);
    log('info', 'queue', 'queued episode removed');
    if (cur === s) hint(s); // the hint no longer names it
    tvSync(s);
  };
  /** the title's segments (intro / recap skip, credits) */
  const loadSegs = (s: Live) => {
    const id = s.view.itemId;
    void deps.segments(id).then((x) => { if (cur === s && s.view.itemId === id) { s.segs = x; tvSync(s); } }, () => undefined);
  };

  function tick(s: Live, st: CastState) {
    if (cur !== s) return;
    const device = st.connected ? st.deviceName || 'Chromecast' : s.view.device;
    if (device !== s.view.device && s.ci && !s.busy) { patch(s, { device }); hint(s); } // the hint shows the TV's real name
    if (!s.ci || s.busy) { patch(s, { device }); return; }
    // the receiver moved on to the queued next episode (its end, or the countdown's castQueueNext): that token is the live one now
    if (st.loaded && s.queued && st.contentId === s.queued.ci.contentUrl && st.contentId !== s.ci.contentUrl) advanced(s);
    else if (st.loaded && st.contentId && st.contentId !== s.ci.contentUrl) { patch(s, { device }); return; } // other media: not ours
    const p: Partial<CastSession> = { device, buffering: !st.loaded || st.state === 'buffering' };
    const begins = st.loaded && !s.started && (st.state === 'playing' || (s.hold && st.state === 'paused'));
    // an idle receiver's time is no position (the SDK resets it to 0 around the end): the end check needs the last real one
    if (st.loaded && st.state !== 'idle') {
      p.position = st.currentTime;
      if (st.duration) p.duration = st.duration;
      p.paused = st.paused;
      if (begins) p.state = 'playing';
    }
    patch(s, p);
    stall(s, st.loaded && st.state === 'buffering' && s.started);
    if (!st.loaded) return;
    if (begins) {
      s.started = true; s.hold = false;
      void report(s, 'start', s.ci);
      log('info', 'receiver', s.loadAt === undefined ? `${s.label} playing` : `${s.label} playing after ${timers.now() - s.loadAt} ms`);
      s.loadAt = undefined;
    }
    else if (s.started && s.lastPaused !== null && s.lastPaused !== st.paused) void report(s, 'progress', s.ci);
    s.lastPaused = st.paused;
    atPosition(s);
  }

  /** a stall of the TV (buffering while it played): one entry once it is longer than STALL_LOG_MS, one for the recovery */
  function stall(s: Live, on: boolean) {
    const now = timers.now();
    if (on) {
      s.stallAt ??= now;
      if (!s.stallLogged && now - s.stallAt > STALL_LOG_MS) { s.stallLogged = true; log('warn', 'network', 'TV buffering for more than 2 s'); }
      return;
    }
    if (s.stallAt === undefined) return;
    const d = now - s.stallAt;
    if (d > STALL_LOG_MS) {
      if (!s.stallLogged) log('warn', 'network', 'TV buffering for more than 2 s');
      log('info', 'network', `TV playing again after ${(d / 1000).toFixed(1)} s`);
    }
    s.stallAt = undefined; s.stallLogged = false;
  }

  /** a position update while the TV plays: skip offer, credits (next episode offered), Chromecast queue */
  function atPosition(s: Live) {
    const v = s.view;
    if (cur !== s || !s.ci || s.busy || v.state !== 'playing') return;
    const seg = s.segs.find((x) => (x.type === 'intro' || x.type === 'recap') && v.position >= x.start && v.position < x.end - 1);
    if (seg?.end !== v.skip?.end) patch(s, { skip: seg ? { type: seg.type, end: seg.end } : undefined });
    if (!v.isEpisode || !(v.duration > 0)) return;
    const at = creditsStart(s.segs, v.duration);
    if (!s.credits && v.position >= at) { s.credits = true; void credits(s); }
    else if (s.credits && v.position < at - 2) {
      // seeked back out of the credits: the offer (and its countdown) goes, it comes again at the credits
      s.credits = false; s.offered = undefined;
      if (s.hide !== undefined) { timers.clear(s.hide); s.hide = undefined; }
      if (v.next) patch(s, { next: undefined });
    }
    // queue from the start: once per title, as soon as it plays and its length is known (not with the autoplay switch off)
    if (!s.air && !s.queueAsked && s.autoSet !== false) { s.queueAsked = true; void prequeue(s); }
  }

  /** the credits began: the next episode is offered, with the countdown when autoplay is allowed */
  async function credits(s: Live) {
    const my = seq;
    const it = s.queued?.it ?? (await nextOf(s.view.itemId));
    if (!it || cur !== s || my !== seq || !s.credits || s.view.state !== 'playing') return;
    offerNext(s, it, false);
  }

  /** `next` for `it`: autoplay (countdown, or at once when the end passed unseen) when allowed, else button only */
  function offerNext(s: Live, it: Item, now0: boolean) {
    const now = timers.now(), p = deps.prefs();
    const auto = s.noAuto !== it.id && mayAutoplay(autoArgs(s, shouldAsk(now, p)));
    if (s.hide !== undefined) timers.clear(s.hide);
    s.offered = it;
    const wait = now0 ? 0 : COUNTDOWN_SECONDS * 1000;
    s.hide = auto ? timers.set(() => goNext(s, it), wait) : s.close ? timers.set(s.close, ENDED_IDLE_MS) : undefined;
    patch(s, { next: { itemId: it.id, label: nextLabel(it), startsAt: auto ? now + wait : null } });
  }

  /** the countdown ran out: the receiver plays its queued episode, else the next token is loaded */
  function goNext(s: Live, it: Item) {
    if (cur !== s) return;
    s.hide = undefined;
    noteAutoplay();
    consumeAutoplay(); // the chain counts; the watch page's one-shot flag is for its own countdown only
    const q = s.queued;
    if (q && q.it.id === it.id && s.ci && !s.busy && custom(s)) { s.going = true; return; } // the TV's own countdown moves on (or the end)
    if (q && q.it.id === it.id && s.ci && !s.busy) {
      s.going = true;
      cast.castQueueNext();
      s.wait = timers.set(() => {
        if (cur !== s || s.queued !== q) return;
        log('warn', 'queue', 'queued episode did not start · fresh token');
        void swap(s, it.id, undefined, true);
      }, ADVANCE_WAIT_MS);
      return;
    }
    void swap(s, it.id, undefined, true);
  }

  /**
   * Chromecast: the next episode into the receiver's queue (own token, `next: true` after the playing token: it may fill the
   * stream limit the playing one holds; the server serves it only as that one's successor), when autoplay is allowed for the expected end time. The receiver then moves on by itself, also with the phone asleep.
   * Any failure leaves the countdown path; `409 cast_unpinned` (the TV has not fetched the playing token yet) is asked once more
   * after `UNPINNED_RETRY_MS`.
   */
  async function prequeue(s: Live) {
    const v = s.view, my = seq, p = deps.prefs();
    const endAt = timers.now() + Math.max(0, v.duration - v.position) * 1000;
    // the own receiver asks "still watching?" itself (the queued episode waits paused for the answer): only that does not block it
    const ask = shouldAsk(endAt, p), tv = custom(s);
    if (!mayAutoplay(autoArgs(s, ask && !tv))) return;
    const stale = () => cur !== s || my !== seq || s.busy || !s.ci;
    const unwanted = (id: string) => s.noAuto === id || s.autoSet === false;
    s.queueing = true;
    try {
      const it = await nextOf(v.itemId);
      if (!it || stale() || unwanted(it.id)) return;
      let ci: CastInfo;
      try {
        ci = await call<CastInfo>('/api/cast/session', { method: 'POST', body: castReq({ itemId: it.id, maxBitrate: s.maxBitrate ?? firstInfoBody(deps.prefs()).maxBitrate, next: true, after: s.ci!.castId }) });
      } catch (e) {
        const why = errText(e);
        log('warn', 'queue', `queue refused · ${why}`);
        if (why === '409 cast_unpinned' && !s.unpinRetried && !stale()) {
          s.unpinRetried = true;
          s.requeue = timers.set(() => { s.requeue = undefined; if (cur === s && my === seq) void prequeue(s); }, UNPINNED_RETRY_MS);
        }
        return;
      }
      log('info', 'queue', `queued token issued · ${labelOf(it)}`);
      if (stale() || unwanted(it.id)) { revoke(ci); return; }
      const qid = tv ? await cast.queueOnCast(ci, !ask) : await cast.queueOnCast(ci);
      // the page went (pagehide) while the receiver took it: it stays queued there, its token lives with the cast
      if (qid !== null && leaving) return;
      if (qid === null || stale() || unwanted(it.id)) {
        if (qid === null) log('warn', 'queue', 'queue refused by the receiver');
        else cast.castQueueRemove(qid);
        revoke(ci);
        return;
      }
      s.queued = tv ? { ci, it, qid, ask } : { ci, it, qid };
      log('info', 'queue', 'queued episode loaded on the receiver');
      hint(s); // a detached Stop revokes it too
      tvSync(s);
    } finally {
      s.queueing = false;
    }
  }

  /** the receiver plays the queued episode: the ended one's stop is reported (at its end) and its token revoked */
  function advanced(s: Live) {
    const q = s.queued!, old = s.ci;
    s.queued = undefined;
    if (s.hide !== undefined) { timers.clear(s.hide); s.hide = undefined; }
    if (s.wait !== undefined) { timers.clear(s.wait); s.wait = undefined; }
    if (s.requeue !== undefined) { timers.clear(s.requeue); s.requeue = undefined; }
    s.close = undefined;
    if (s.view.duration > 0) s.view = { ...s.view, position: s.view.duration };
    const stopped = stopReport(s);
    void stopped.then(() => revoke(old));
    if (!s.going) { noteAutoplay(); consumeAutoplay(); } // the receiver moved on alone (no countdown here): an autoplay all the same
    seq++; // an older async step (credits, queue) of the ended title gives up
    // a queued episode that waits for "still watching?" (own receiver) is loaded paused: that counts as its start
    s.ci = q.ci; s.started = false; s.lastPaused = null; s.going = false; s.hold = Boolean(q.ask);
    s.audioIndex = undefined; s.subIndex = -1; s.sleepAfterEpisode = false; s.noAuto = undefined;
    s.segs = []; s.credits = false; s.queueAsked = false; s.offered = undefined; s.unpinRetried = false;
    s.label = labelOf(q.it); s.loadAt = timers.now();
    log('info', 'queue', `queued episode started · ${s.label}`);
    const { title, sub } = barTitles(q.it);
    patch(s, { itemId: q.it.id, title, subtitle: sub, seriesId: q.it.seriesId, posterId: q.it.id, isEpisode: q.it.type === 'Episode', state: 'connecting',
      position: q.ci.startTime, ...(q.ci.runtimeTicks ? { duration: ticksToSec(q.ci.runtimeTicks) } : {}), paused: false, buffering: true,
      next: undefined, skip: undefined, audioTracks: [], subtitles: subsOf(q.ci), audioIndex: undefined, subIndex: -1 });
    hint(s);
    loadSegs(s);
    tvSync(s);
  }

  function onEvent(s: Live, e: CastEvent) {
    // (after a pagehide the SDK's session end never arrives here: end() removed this listener before deps.leave())
    if (cur !== s) return;
    // FINISHED is the end; CANCELLED / INTERRUPTED (stopped by another sender, other media) never is; otherwise (unknown, ERROR on
    // the last segment) the position decides: idle well before the end (playback error) is not finished
    const why = get(cast.castState).idleReason;
    const finished = e === 'media-end' && (why === 'FINISHED' || (why !== 'CANCELLED' && why !== 'INTERRUPTED' && s.view.duration > 0 && s.view.position >= s.view.duration - 20));
    if (finished && s.ci && !s.busy && s.queued) {
      // the receiver moves on to the queued episode by itself; it is loaded from here if it did not after ADVANCE_WAIT_MS
      const q = s.queued;
      advanced(s);
      const ci = s.ci;
      // it did not: a FRESH token for that episode (the queued one may have lapsed meanwhile), never the old one again
      s.wait = timers.set(() => {
        if (cur !== s || s.ci !== ci || s.started) return;
        log('warn', 'queue', 'queued episode did not start · fresh token');
        void swap(s, q.it.id, undefined, true, Boolean(q.ask));
      }, ADVANCE_WAIT_MS);
      return;
    }
    if (e === 'session-end' || (e === 'media-end' && s.ci && !s.busy && !finished)) {
      const ci = s.ci, stopped = stopReport(s);
      s.ci = null;
      end(s, e === 'session-end' ? 'session ended' : 'stopped on the TV');
      dropHint(s);
      void stopped.then(() => revoke(ci));
    } else if (e === 'media-end' && s.ci && !s.busy) {
      patch(s, { state: 'ended', position: s.view.duration || s.view.position, paused: true, buffering: false });
      const ci = s.ci, stopped = stopReport(s);
      s.ci = null;
      void stopped.then(() => revoke(ci));
      afterEnd(s, () => { end(s, 'title ended'); dropHint(s); cast.castStop(); }, deps.hidden());
    }
  }

  /** the episode after `itemId` (null: none, a film, or the request failed) */
  const nextOf = (itemId: string): Promise<Item | null> =>
    call<{ item: Item | null } | null>(`/api/items/${itemId}/next`).then((r) => r?.item ?? null).catch(() => null);

  /**
   * The title ended on the TV (its stop is reported, its token gone): `close` ends the session after `ENDED_HIDE_MS`
   * unless a next episode follows; that one is shown in the bar and, when autoplay is allowed, starts after the countdown.
   * Without autoplay (or after `cancelNext`) the session ends after `ENDED_IDLE_MS`.
   */
  function afterEnd(s: Live, close: () => void, late = false) {
    s.close = close;
    if (s.hide !== undefined) timers.clear(s.hide);
    patch(s, { skip: undefined });
    const shown = s.view.next, it0 = s.offered;
    if (shown && it0) {
      // the credits already offered it: a running countdown goes on (at once when the end passed unseen), a cancelled one idles
      s.hide = shown.startsAt === null ? timers.set(close, ENDED_IDLE_MS) : timers.set(() => goNext(s, it0), late ? 0 : Math.max(0, shown.startsAt - timers.now()));
      return;
    }
    s.hide = timers.set(close, ENDED_HIDE_MS);
    if (!s.view.isEpisode) return;
    const my = seq;
    void nextOf(s.view.itemId).then((it) => {
      if (!it || cur !== s || my !== seq) return; // none, or the session moved on (switch, stop, end) meanwhile
      offerNext(s, it, late);
    });
  }

  /**
   * The page goes. AirPlay ends (the route belongs to this page's element). Chromecast plays on: nothing is reported or revoked,
   * the receiver's queue stays, this sender only disconnects; the hint stays while a token is live on the TV.
   * Accepted exceptions (only work still in flight, if the page's JS still runs): a token minted after this point never reaches
   * the TV and is revoked — a queue token whose POST returns late, and a switch's new token (the switch already revoked the old
   * one, so that cast ends and the hint is cleared).
   */
  function onPageHide(s: Live) {
    if (cur !== s) return;
    if (s.air) {
      dequeue(s, true);
      void stopReport(s, true);
      s.air.leaving = true;
      airNote(s, 'stop', 'pagehide');
      s.ci = null;
      end(s, 'pagehide');
      dropAir(s.air); // the controller revokes its token (keepalive)
      return;
    }
    log('info', 'sender', 'pagehide · TV keeps playing');
    leaving = true; // before anything the SDK reports after the leave
    if (s.ci) hint(s); else clearHint(deps.store); // nothing live (ended, failed, switching): nothing to come back to
    s.queued = undefined; // stays on the receiver with its token: end() must not remove it
    s.ci = null; s.started = false; // no stop is owed by this page any more: the receiver (or a later page) reports
    end(s, 'sender left');
    deps.leave();
  }

  // ---- AirPlay ----
  const airNote = (s: Live, ev: 'adopt' | 'switch' | 'reconnect' | 'stop', why?: string) => {
    if (s.air) airLog('engine', { src: s.air.video.src, state: s.view.state, note: why ? `${ev}: ${why}` : ev });
  };
  /** AirPlay over for good: controller gone (revokes its token), element emptied and removed */
  function dropAir(a: AirLive) {
    a.ctl.destroy();
    a.video.removeAttribute('src');
    a.video.load();
    a.video.remove();
    a.probe?.remove();
    airState.set(null);
  }

  /** the controller's callbacks while the engine owns it */
  function airDeps(s: Live, a: AirLive): AirPlayDeps {
    return {
      request(pos) {
        const w = a.want, at = w ? w.at : pos;
        return call<CastInfo>('/api/cast/session', {
          method: 'POST',
          body: { itemId: w?.itemId ?? s.view.itemId, startTicks: at === undefined ? undefined : secToTicks(at), audioIndex: s.audioIndex, maxBitrate: s.maxBitrate ?? firstInfoBody(deps.prefs()).maxBitrate, via: 'airplay' },
        });
      },
      // the server counts the stream until its `stop` arrived: revoke after it (pagehide: now, with keepalive)
      revoke(ci) { if (a.revoked.has(ci.castId)) return; if (a.leaving) revoke(ci, true); else void s.stopping.then(() => revoke(ci)); },
      detach() { void stopReport(s); return s.stopping.then(() => undefined); },
      started(ci) {
        if (cur !== s) return;
        const w = a.want; // set only by a switch to another title: its subtitles replace the list (a renewal keeps it)
        a.want = null;
        s.ci = ci; s.started = false; s.lastPaused = null;
        // the server chose the start (resume position): the stream's timeline is absolute, seek there once it loaded
        if (w && w.at === undefined && ci.startTime > 1) a.video.addEventListener('loadedmetadata', () => { if (a.ctl.info === ci) a.video.currentTime = ci.startTime; }, { once: true });
        patch(s, { position: w ? w.at ?? ci.startTime : s.view.position, ...(ci.runtimeTicks ? { duration: ticksToSec(ci.runtimeTicks) } : {}), ...(w ? { subtitles: subsOf(ci) } : {}) });
      },
      restore(pos) {
        // sustained route loss (or no TV chosen after a reconnect tap): never the cookie stream, wait for a tap
        if (cur !== s || s.view.state === 'ended') return;
        patch(s, { position: pos });
        void stopReport(s);
        s.ci = null;
        a.video.pause();
        patch(s, { state: 'reconnect', paused: true, buffering: false });
        airNote(s, 'reconnect', 'route lost');
      },
      fail(e) {
        if (cur !== s || (a.opSeq !== null && a.opSeq !== seq)) return; // a newer switch waits: its outcome counts
        void stopReport(s);
        s.ci = null;
        if (e instanceof Error && e.message === 'airplay_media' && a.ctl.state.active) {
          deps.toast('error', tr('player.castBar.failed', { title: s.view.title, device: s.view.device }));
          patch(s, { state: 'failed', buffering: false });
          return;
        }
        deps.toast('error', castErr(e, 'airplay'));
        // the TV still has the previous token, whose stop is reported: it must not keep playing unreported
        a.video.pause();
        patch(s, { state: 'reconnect', paused: true, buffering: false });
      },
      change(st) {
        if (cur !== s) return;
        airState.set(st);
        if (a.resume && st.active && !st.error && !st.busy) {
          a.resume = false;
          // a title remembered meanwhile (Play while `ready`): the TV gets that one, not the token it was picked with
          if (a.want) void a.ctl.switchItem(a.want.at ?? 0);
          else void a.video.play().catch(() => undefined);
          patch(s, { state: 'connecting', buffering: true });
        }
      },
    };
  }

  /** the element's media events: mirrored into the session; `start` on the first `playing` of each token */
  function airEvent(s: Live, a: AirLive, type: (typeof AIR_EVENTS)[number]) {
    const v = a.video;
    if (type === 'error') { if (v.error && v.error.code !== 1) a.ctl.videoError(v.error.code, v.error.message); return; }
    if (!s.ci || s.busy) return;
    if (type === 'ended') { airEnded(s, a, deps.hidden()); return; }
    const start = type === 'playing' && !s.started && a.ctl.state.active;
    const p: Partial<CastSession> = { paused: v.paused };
    if (s.started || start) p.position = v.currentTime; // before that the element may still be at 0 (the switch's start counts)
    if (Number.isFinite(v.duration) && v.duration > 0) p.duration = v.duration;
    if (type === 'waiting') p.buffering = true;
    if (type === 'playing') p.buffering = false;
    if (start) p.state = 'playing';
    patch(s, p);
    if (start) { s.started = true; void report(s, 'start', s.ci); }
    else if ((type === 'play' || type === 'pause') && s.started) void report(s, 'progress', s.ci);
    if (type === 'timeupdate' && s.started) atPosition(s);
  }

  /**
   * The TV played the title to its end. `late`: that happened while the page was hidden (its JS asleep, e.g. a locked phone):
   * an allowed next episode starts at once instead of after a countdown nobody saw.
   */
  function airEnded(s: Live, a: AirLive, late: boolean) {
    if (!s.ci) return;
    airNote(s, 'switch', late ? 'ended while hidden' : 'ended');
    patch(s, { state: 'ended', position: s.view.duration || s.view.position, paused: true, buffering: false });
    // the ended token goes now (after its stop), not only when the controller replaces or drops it
    const ci = s.ci, stopped = stopReport(s);
    s.ci = null;
    a.revoked.add(ci.castId);
    void stopped.then(() => revoke(ci));
    afterEnd(s, () => { airNote(s, 'stop', 'ended'); end(s, 'title ended'); dropAir(a); }, late);
  }

  /** the page is shown again: an AirPlay end the hidden page missed (no `ended` delivered) is handled now, as a late one */
  function onWake(s: Live) {
    const a = s.air;
    if (cur !== s || !a || !s.ci || s.busy) return;
    if (a.video.ended) airEnded(s, a, true);
  }

  function adoptAir(s: Live, a: AirLive) {
    for (const el of a.probe ? [a.video, a.probe] : [a.video]) {
      deps.body().appendChild(el); // a DOM move: the element (and its AirPlay route) stays the same
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('style', HIDDEN_STYLE);
    }
    a.video.setAttribute(CAST_VIDEO_ATTR, '');
    a.ctl.rebind(airDeps(s, a));
    airState.set(a.ctl.state);
    for (const t of AIR_EVENTS) {
      const fn = () => airEvent(s, a, t);
      a.video.addEventListener(t, fn);
      s.offs.push(() => a.video.removeEventListener(t, fn));
    }
    airNote(s, 'adopt');
  }

  /** the AirPlay part of `swap`: the controller loads the new token on the same element */
  async function airSwap(s: Live, a: AirLive, my: number, itemId: string, startAt: number | undefined, fresh: boolean, it: Item | null, hold: boolean) {
    airNote(s, 'switch', fresh ? undefined : 'same title');
    if (fresh) {
      a.want = { itemId, at: startAt };
      if (!a.ctl.state.active) { s.busy = false; patch(s, { state: 'reconnect', buffering: false }); return; } // the tap on the bar loads it
    }
    a.opSeq = my;
    const op = fresh ? a.ctl.switchItem(startAt ?? 0) : a.ctl.refresh();
    a.op = op;
    await op;
    a.opSeq = null; // a newer switch waits for `op` before it sets its own
    if (my !== seq) return; // a newer switch takes over (the controller revokes this token when it replaces it)
    s.busy = false;
    if (s.ci && hold && !s.started) {
      // the element stays paused (the controller plays only what played): no `playing` will come, the paused token counts now
      s.started = true;
      patch(s, { state: 'playing', buffering: false });
      void report(s, 'start', s.ci);
    }
    if (s.ci) { if (fresh && !it) patch(s, { title: s.ci.seriesName ?? s.ci.title, subtitle: s.ci.seriesName ? s.ci.title : '', seriesId: undefined, posterId: itemId, isEpisode: Boolean(s.ci.seriesName) }); return; }
    if (s.view.state !== 'connecting') return;
    // the controller was busy: nothing loaded; the old title's stop is reported, so it must not keep playing on the TV
    a.video.pause();
    patch(s, { state: 'reconnect', paused: true, buffering: false });
  }

  function arm(s: Live) {
    s.loop = timers.set(() => {
      if (cur !== s) return;
      if (s.ci && !s.busy) {
        if (s.started) void report(s, 'progress', s.ci);
        if (s.stallAt !== undefined && !s.air) stall(s, true); // a stall the receiver reports no update for
        if (s.ci.expiresAt - timers.now() < RENEW_BEFORE_MS) { s.renewing = true; void swap(s, s.view.itemId, s.view.position, false); }
      }
      arm(s);
    }, PROGRESS_MS);
  }

  /**
   * Replaces the live token: `stop` for the old one, old token revoked, new token requested and loaded on the receiver.
   * `fresh` = another title (metadata from the item, default audio, no subtitle); otherwise the same title (renewal, tracks).
   * `hold`: the same title on a paused TV stays paused.
   */
  async function swap(s: Live, itemId: string, startAt: number | undefined, fresh: boolean, hold = !fresh && s.view.paused): Promise<void> {
    const my = ++seq, renew = s.renewing;
    s.renewing = false;
    if (s.hide !== undefined) { timers.clear(s.hide); s.hide = undefined; }
    if (s.wait !== undefined) { timers.clear(s.wait); s.wait = undefined; }
    if (s.requeue !== undefined) { timers.clear(s.requeue); s.requeue = undefined; }
    s.close = undefined;
    dequeue(s); // a new load replaces the receiver's queue; asked again for the new token
    s.credits = false; s.queueAsked = false; s.offered = undefined; s.going = false; s.unpinRetried = false;
    s.stallAt = undefined; s.stallLogged = false; s.loadAt = undefined;
    if (fresh) { s.segs = []; s.noAuto = undefined; }
    const old = s.ci;
    void stopReport(s);
    const stopped = s.stopping; // also a stop an earlier, superseded switch still waits for
    s.ci = null; s.busy = true; s.retry = null; s.lastPaused = null; s.hold = hold;
    if (fresh) { s.audioIndex = undefined; s.subIndex = -1; s.sleepAfterEpisode = false; } // "sleep after" meant the ended episode
    patch(s, { itemId, state: 'connecting', position: startAt ?? 0, paused: hold, buffering: true, next: undefined, skip: undefined,
      ...(fresh ? { audioTracks: [], subtitles: [], audioIndex: undefined, subIndex: -1 } : {}) });
    const meta = fresh ? deps.item(itemId).catch(() => null) : Promise.resolve(null);
    const a = s.air;
    const [, it] = await Promise.all([stopped, meta, a?.op]);
    if (!a) revoke(old); // AirPlay: the controller revokes the old token once the new one is on the element
    if (my !== seq) return;
    if (it) { const { title, sub } = barTitles(it); patch(s, { title, subtitle: sub, seriesId: it.seriesId, posterId: it.id, isEpisode: it.type === 'Episode' }); }
    if (fresh) { s.label = labelOf(it, s.view.isEpisode); loadSegs(s); }
    if (a) { log('info', 'load', `${s.label} · from ${startAt === undefined ? 'resume position' : clock(startAt)}`); await airSwap(s, a, my, itemId, startAt, fresh, it, hold); return; }
    let ci: CastInfo;
    try {
      ci = await call<CastInfo>('/api/cast/session', {
        method: 'POST',
        body: castReq({ itemId, startTicks: startAt === undefined ? undefined : secToTicks(startAt), audioIndex: s.audioIndex, maxBitrate: s.maxBitrate ?? firstInfoBody(deps.prefs()).maxBitrate }),
      });
    } catch (e) {
      if (my !== seq) return;
      s.busy = false;
      s.retry = () => swap(s, itemId, startAt, fresh, hold);
      log('error', renew ? 'renew' : 'load', `token request refused · ${errText(e)}`);
      dropHint(s); // the TV's token was revoked with the switch
      deps.toast('error', castErr(e));
      patch(s, { state: 'reconnect', buffering: false });
      return;
    }
    if (my !== seq) { revoke(ci); return; }
    s.ci = ci;
    if (fresh) patch(s, { subtitles: subsOf(ci) });
    if (fresh && !it) patch(s, { title: ci.seriesName ?? ci.title, subtitle: ci.seriesName ? ci.title : '', seriesId: undefined, posterId: itemId, isEpisode: Boolean(ci.seriesName) });
    patch(s, { position: startAt ?? ci.startTime, ...(ci.runtimeTicks ? { duration: ticksToSec(ci.runtimeTicks) } : {}) });
    if (fresh && !it) s.label = labelOf(null, Boolean(ci.seriesName));
    log('info', 'load', `${s.label} · from ${clock(startAt ?? ci.startTime)}`);
    s.loadAt = timers.now();
    const ok = await cast.loadOnCast(ci, s.subIndex, !hold);
    if (my !== seq) return; // a newer switch revokes `ci`, a session end already did
    s.busy = false;
    if (!ok) {
      s.ci = null;
      revoke(ci);
      dropHint(s);
      log('error', 'load', 'the receiver could not load the title');
      deps.toast('error', tr('player.castBar.failed', { title: s.view.title, device: s.view.device }));
      patch(s, { state: 'failed', buffering: false });
    } else {
      hint(s);
      if (renew) log('info', 'renew', `token renewed · valid for ${Math.round((ci.expiresAt - timers.now()) / 60_000)} min`);
      tvUi(s); tvSync(s);
    }
    // the next receiver update (it reports the loaded media) sends `start`
  }

  function seek(sec: number) {
    const s = cur;
    if (!s?.ci || s.busy) return;
    const t = Math.max(0, s.view.duration ? Math.min(s.view.duration, sec) : sec);
    if (s.air) s.air.video.currentTime = t;
    else cast.castSeek(t);
    patch(s, { position: t });
    if (s.started) void report(s, 'progress', s.ci);
  }

  /** takes a cast over: a hand-off from the Player, or a cast `resume()` found on the receiver */
  function adoptLive(h: PlayerHandoff, how: 'adopt' | 'resume', hold = false): Live {
    gen++;
    const prev = cur;
    if (prev) {
      // the same token again (the Player re-hands its session): nothing to stop; another token: stop and revoke it
      const ci = prev.ci, same = ci?.castId === h.cast.castId, stopped = same ? Promise.resolve() : stopReport(prev);
      end(prev, 'replaced');
      if (prev.air) { if (prev.air.ctl !== h.air) dropAir(prev.air); } // its controller revokes its token
      else if (ci && !same) void stopped.then(() => revoke(ci));
    }
    leaving = false;
    // a hand-off: the cast was started in this tab, it is this tab's (the lock is taken if free; resume() holds it already)
    if (h.kind === 'chromecast' && how === 'adopt') void ownLock(true).then(() => { if (!cur) freeLock(); });
    const s: Live = {
      view: { kind: h.kind, device: h.kind === 'airplay' ? tr('player.castBar.airplayDevice') : 'Chromecast', itemId: h.itemId, seriesId: h.seriesId, title: h.title, subtitle: h.subtitle, posterId: h.itemId, isEpisode: h.isEpisode,
        position: h.position, duration: h.duration, paused: h.paused, buffering: false, state: h.started ? 'playing' : 'connecting',
        audioTracks: h.audioTracks ?? [], subtitles: h.subtitles ?? [], audioIndex: h.audioIndex, subIndex: h.subIndex,
        autoplay: deps.prefs().autoplayNext && !h.sleepAfterEpisode, castId: h.cast.castId },
      // hold: a resumed, never reported cast on a paused TV counts as started once it is seen paused (as a paused renewal)
      ci: h.cast, started: h.started, busy: false, stopping: Promise.resolve(), lastPaused: null, hold,
      audioIndex: h.audioIndex, subIndex: h.subIndex, maxBitrate: h.maxBitrate, sleepAfterEpisode: h.sleepAfterEpisode,
      // a resumed cast first looks at the receiver's own queue (restoreQueue): nothing is queued before that
      retry: null, offs: [], segs: [], credits: false, queueAsked: how === 'resume', going: false,
      autoSet: null, queueing: false, unpinRetried: false, label: labelOf(null, h.isEpisode), stallLogged: false, renewing: false,
    };
    cur = s;
    dropDetached(); // the bar shows this session now
    out.set(s.view);
    if (h.video && h.air) {
      s.air = { video: h.video, ctl: h.air, probe: h.probe ?? null, want: null, op: Promise.resolve(), opSeq: null, resume: false, leaving: false, revoked: new Set() };
      adoptAir(s, s.air);
    } else {
      s.offs.push(cast.castState.subscribe((st) => tick(s, st)), cast.onCastEvent((e) => onEvent(s, e)));
      if (custom(s) && cast.onReceiverMessage) s.offs.push(cast.onReceiverMessage((m) => fromTv(s, m)));
    }
    s.offs.push(deps.onPageHide(() => onPageHide(s)), deps.onWake(() => { if (cur === s) log('info', 'sender', 'page visible'); onWake(s); }),
      deps.onHidden(() => { if (cur === s) log('info', 'sender', 'page hidden'); }));
    hint(s);
    log('info', 'session', how === 'resume' ? 'session resumed · TV kept playing' : `session adopted · ${s.view.kind} · ${s.label}`);
    loadSegs(s);
    arm(s);
    tvUi(s);
    tvSync(s);
    return s;
  }

  // ---- re-adoption (resume) and the detached bar ----
  /** the receiver's media once its status is there (loaded, with a content URL); null after RESUME_WAIT_MS */
  function waitMedia(): Promise<CastState | null> {
    return new Promise((done) => {
      let fin = false, off: (() => void) | undefined;
      const finish = (v: CastState | null) => { if (fin) return; fin = true; timers.clear(t); off?.(); done(v); };
      const t = timers.set(() => finish(null), RESUME_WAIT_MS);
      off = cast.castState.subscribe((st) => { if (st.loaded && st.contentId) finish(st); });
      if (fin) off();
    });
  }
  /** the public handle of a receiver item: the own receiver's castId, else derived from the token in its URL (null: no token) */
  const handleOf = async (castId: string, contentId: string): Promise<string | null> => castId || (await castIdOfContentUrl(contentId, deps.digest));
  /** GET /api/cast/session/:castId: the answer; null = not ours (404, not a Chromecast token); undefined = unknown (network, server) */
  async function lookupOf(castId: string): Promise<CastLookup | null | undefined> {
    try {
      const l = await call<CastLookup | null>(`/api/cast/session/${castId}`);
      return l && l.via !== 'airplay' ? l : null;
    } catch (e) {
      const st = (e as { status?: unknown } | null)?.status;
      return st === 404 || st === 400 ? null : undefined;
    }
  }
  /** nothing of ours plays there: the hint and a detached bar go, nothing is reported or revoked */
  function notOurs(why: string) {
    clearHint(deps.store);
    dropDetached();
    log('info', 'session', why);
  }

  async function doResume(): Promise<boolean> {
    const g = gen;
    /** a Stop / hand-off / release came meanwhile: this resume must not bring anything back */
    const stale = () => g !== gen || Boolean(cur);
    if (!(await ownLock(true))) { follow(); return false; } // another tab owns the cast: nothing here, the hint stays
    if (stale()) return false;
    const st = await waitMedia();
    if (stale()) return false;
    if (!st) {
      // joined, but nothing loaded within the wait: our cast is over on that TV; not joined: the hint stays (detached bar)
      if (get(cast.castState).connected) notOurs('nothing plays on the TV');
      return false;
    }
    const id = await handleOf(st.castId, st.contentId);
    const l = id ? await lookupOf(id) : null;
    if (stale()) return false;
    if (l === undefined) { log('warn', 'session', 'cast lookup failed'); return false; }
    if (!l) { notOurs('the TV plays something else'); return false; }
    const it = await deps.item(l.itemId).catch(() => null);
    const now = get(cast.castState);
    if (stale() || now.contentId !== st.contentId) return false; // a hand-off / Stop came first, or the TV moved on (the next event resumes again)
    cast.castAdoptTracks(st.contentId, l.subtitles);
    const ci = lookupToCastInfo(l, st.contentId);
    const { title, sub } = it ? barTitles(it) : { title: l.seriesName ?? l.title, sub: l.seriesName ? l.title : '' };
    const s = adoptLive({
      kind: 'chromecast', itemId: l.itemId, seriesId: it?.seriesId, title, subtitle: sub, isEpisode: it ? it.type === 'Episode' : Boolean(l.seriesName),
      position: now.currentTime, duration: now.duration || (l.runtimeTicks ? ticksToSec(l.runtimeTicks) : 0), paused: now.paused,
      cast: ci, started: l.reported, subIndex: -1, sleepAfterEpisode: false, subtitles: subsOf(ci),
    }, 'resume', !l.reported && now.paused);
    if (it) s.label = labelOf(it);
    await restoreQueue(s, now);
    return true;
  }
  /** the receiver's first queued item, when it is this title's queued next episode (`next: true`), becomes `s.queued` again */
  async function restoreQueue(s: Live, st: CastState) {
    const my = seq, q0 = st.queue[0];
    const gone = () => cur !== s || my !== seq || Boolean(s.queued) || !s.ci;
    /** ours, but the session went meanwhile (Stop, switch, TV ended): its token goes too, unless the page just left (pagehide) */
    const orphan = (l: CastLookup) => { if (!leaving) void revokeId(l.castId); };
    let unknown = false;
    try {
      if (!q0?.contentId || q0.contentId === st.contentId) return;
      const id = await handleOf(q0.castId, q0.contentId);
      const l = id ? await lookupOf(id) : null;
      if (l === undefined) { unknown = true; return; } // probably ours: never a second queue token next to it
      if (!l?.next) return;
      if (gone()) { orphan(l); return; }
      const it = await deps.item(l.itemId).catch(() => itemOfLookup(l));
      if (gone()) { orphan(l); return; }
      cast.castAdoptTracks(q0.contentId, l.subtitles);
      s.queued = { ci: lookupToCastInfo(l, q0.contentId), it, qid: q0.itemId };
      log('info', 'queue', `queued episode found on the receiver · ${labelOf(it)}`);
      hint(s);
      tvSync(s);
    } finally {
      // none of ours queued there (for sure): this title queues its own (from the start)
      if (cur === s && my === seq && !s.queued && !unknown) { s.queueAsked = false; atPosition(s); }
    }
  }

  /** the detached bar goes (a session took over, the cast is gone or stopped) */
  function dropDetached() {
    if (detachTimer !== undefined) { timers.clear(detachTimer); detachTimer = undefined; }
    detachDue = false;
    if (!detached) return;
    detached = null;
    if (!cur) out.set(null);
  }
  /** the bar from the hint: "Connection lost" with Reconnect and Stop */
  function showDetached() {
    const h = readHint(deps.store, timers.now());
    if (cur || !h || follower) return; // another tab owns the cast: nothing is lost
    const d = { hint: h, view: { kind: 'chromecast', device: h.device, itemId: h.itemId, title: '', subtitle: '', posterId: h.itemId, isEpisode: false,
      position: 0, duration: 0, paused: true, buffering: false, state: 'detached', audioTracks: [], subtitles: [], subIndex: -1,
      autoplay: deps.prefs().autoplayNext, castId: h.castId } as CastSession };
    detached = d;
    out.set(d.view);
    log('warn', 'session', 'connection lost · cast of an earlier page');
    void deps.item(h.itemId).then((it) => {
      if (detached !== d || cur) return;
      const { title, sub } = barTitles(it);
      d.view = { ...d.view, title, subtitle: sub, seriesId: it.seriesId, isEpisode: it.type === 'Episode' };
      out.set(d.view);
    }, () => undefined);
  }
  /** the SDK is ready: a fresh hint and no resume within DETACHED_AFTER_MS shows the detached bar (after a resume that still waits) */
  function boot() {
    if (cur || detached || follower || detachTimer !== undefined || !readHint(deps.store, timers.now())) return;
    detachTimer = timers.set(() => {
      detachTimer = undefined;
      if (cur) return;
      if (resuming) { detachDue = true; return; } // shown once that resume gives up (it follows when another tab owns)
      // another tab may own the cast (this one did not auto-join): then nothing is lost here, this tab follows
      void ownLock(true).then((ok) => {
        if (!ok) { follow(); return; }
        if (cur || resuming) return;
        freeLock(); // only a probe
        showDetached();
      });
    }, DETACHED_AFTER_MS);
  }
  deps.whenReady(boot);
  // back from the back/forward cache after a pagehide (the engine let the cast go): look again, as on a fresh page
  deps.onRestore(() => {
    leaving = false;
    if (cur || !readHint(deps.store, timers.now())) return;
    if (get(cast.castState).connected) void resume();
    else boot();
  });

  function resume(): Promise<boolean> {
    if (cur) return Promise.resolve(false);
    resuming ??= doResume().catch(() => false).finally(() => {
      resuming = null;
      if (!cur) freeLock();
      if (detachDue && !cur) { detachDue = false; showDetached(); }
    });
    return resuming;
  }
  /** Reconnect on the detached bar (inside the tap): the device picker, then the resume; nothing of ours there: toast, bar gone */
  function reconnectDetached(d: NonNullable<typeof detached>) {
    log('info', 'session', 'reconnect tapped');
    const g = gen;
    const asked = deps.requestSession(); // synchronously: the browser's picker needs the gesture
    void asked.then(async (ok) => {
      if (!ok || detached !== d || g !== gen) return; // picker dismissed (the bar stays), or stopped meanwhile
      if (await resume()) return;
      if (cur || g !== gen) return; // stopped meanwhile: no toast
      if (follower) { log('info', 'session', 'another tab controls the cast'); dropDetached(); return; } // no toast, the hint is the owner's
      deps.toast('info', tr('player.castBar.nothingThere', { device: get(cast.castState).deviceName || d.hint.device }));
      clearHint(deps.store);
      dropDetached();
    }, () => undefined);
  }

  return {
    airState: { subscribe: airState.subscribe },
    adopt(h) {
      if (h.kind === 'airplay' && (!h.video || !h.air)) return;
      adoptLive(h, 'adopt');
    },
    playPause() {
      const s = cur;
      if (!s?.ci) return;
      noteInteraction();
      if (!s.air) { cast.castPlayPause(); return; }
      if (s.air.video.paused) void s.air.video.play().catch(() => undefined);
      else s.air.video.pause();
    },
    seek,
    skip(delta) { if (!cur) return; noteInteraction(); seek(cur.view.position + delta); },
    async playOnTv(itemId, startAt) { if (cur) await swap(cur, itemId, startAt, true); },
    async next() {
      const s = cur;
      // a second tap while the next episode is on its way must not skip one more
      if (!s || s.busy || (s.view.state !== 'ended' && s.view.state !== 'playing')) return;
      noteInteraction();
      const my = seq;
      const id = s.view.next?.itemId ?? s.queued?.it.id ?? (s.view.isEpisode ? (await nextOf(s.view.itemId))?.id : undefined);
      if (!id) { if (cur === s && my === seq) deps.toast('info', tr('player.noNext')); return; }
      if (cur === s && my === seq) await swap(s, id, undefined, true);
    },
    cancelNext() {
      const s = cur;
      if (!s?.view.next || s.view.next.startsAt === null) return;
      noteInteraction();
      timers.clear(s.hide);
      s.hide = s.close ? timers.set(s.close, ENDED_IDLE_MS) : undefined;
      s.noAuto = s.view.next.itemId;
      dequeue(s); // the receiver must not move on by itself either
      patch(s, { next: { ...s.view.next, startsAt: null } });
      if (s.ci) tvSync(s);
    },
    skipSegment() {
      const s = cur;
      if (!s?.view.skip) return;
      noteInteraction();
      seek(s.view.skip.end);
    },
    async stop() {
      const s = cur;
      if (!s) {
        // detached: the TV's token is revoked by its handle; the position is unknown, so no stop report
        const d = detached;
        if (!d) return;
        gen++; // a resume / reconnect on its way gives up
        dropDetached();
        clearHint(deps.store);
        log('info', 'session', 'cast ended · stopped from the detached bar');
        holdLock = true;
        try {
          // the playing token and its queued successor (the server's revoke does not cascade: the TV may already play the successor)
          await Promise.all([revokeId(d.hint.castId), d.hint.next ? revokeId(d.hint.next) : undefined]);
        } finally { holdLock = false; freeLock(); }
        return;
      }
      gen++;
      const ci = s.ci, stopped = stopReport(s);
      s.ci = null;
      if (s.air) {
        airNote(s, 'stop');
        end(s, 'stopped');
        dropAir(s.air); // the controller revokes its token once the stop report is through
        await stopped;
        return;
      }
      // the owner lock stays until the stop report and the revoke are through: a waiting tab then finds nothing to re-adopt
      holdLock = true;
      try {
        end(s, 'stopped');
        dropHint(s);
        cast.castStop();
        await stopped;
        if (ci) await revokeId(ci.castId);
      } finally { holdLock = false; freeLock(); }
    },
    reconnect() {
      const s = cur;
      if (!s && detached) { reconnectDetached(detached); return; }
      if (!s || s.view.state !== 'reconnect') return;
      const a = s.air;
      if (a) {
        // runs inside the tap: the picker (pick) must open synchronously; a failed request is retried once
        airNote(s, 'reconnect', 'tap');
        const st = a.ctl.state;
        if (a.want && !st.ready) a.video.currentTime = a.want.at ?? 0; // the controller loads the token at the element's time
        a.resume = true;
        if (st.active && st.error) void a.ctl.retry();
        else if (a.want && st.active && !st.busy) void a.ctl.switchItem(a.want.at ?? 0); // the TV is there: load the remembered title
        else a.ctl.pick();
        return;
      }
      if (!s.retry) return;
      const again = s.retry;
      s.retry = null;
      void again();
    },
    async refresh(o) {
      const s = cur;
      if (!s?.ci) return;
      if (o?.audioIndex !== undefined) { s.audioIndex = o.audioIndex; patch(s, { audioIndex: o.audioIndex }); }
      if (o?.maxBitrate !== undefined) s.maxBitrate = o.maxBitrate;
      await swap(s, s.view.itemId, s.view.position, false);
    },
    setSubtitle(index) {
      const s = cur;
      if (!s) return;
      s.subIndex = index;
      patch(s, { subIndex: index });
      if (s.ci && !s.air) cast.castSetSubtitle(index); // AirPlay: the receiver only shows tracks inside the stream
    },
    release() {
      const s = cur;
      if (s?.view.state !== 'failed') return;
      gen++;
      end(s, 'released');
      dropHint(s);
      if (s.air) dropAir(s.air);
    },
    pick() { cur?.air?.ctl.pick(); },
    resume,
    setAutoplay(on) {
      // Off after the receiver finished with a queued episode: the advance has already begun (the receiver moves on by itself);
      // its fallback (a fresh token when the TV does not) still runs.
      const s = cur;
      if (!s) return;
      noteInteraction();
      s.autoSet = on;
      log('info', 'queue', on ? 'autoplay switched on' : 'autoplay switched off');
      if (!on) {
        // like cancelNext, and for every later episode of this session: no countdown, nothing in the receiver's queue
        const n = s.view.next;
        if (n && n.startsAt !== null) {
          if (s.hide !== undefined) timers.clear(s.hide);
          s.hide = s.close ? timers.set(s.close, ENDED_IDLE_MS) : undefined;
          patch(s, { next: { ...n, startsAt: null } });
        }
        if (s.requeue !== undefined) { timers.clear(s.requeue); s.requeue = undefined; }
        dequeue(s);
        patch(s, {});
        if (s.ci) tvSync(s);
        return;
      }
      s.sleepAfterEpisode = false; s.noAuto = undefined;
      patch(s, {});
      if (s.offered && s.view.next?.startsAt === null) offerNext(s, s.offered, false); // the offered episode counts down again
      if (!s.air && !s.queued && !s.queueing) s.queueAsked = false; // queued again (atPosition)
      atPosition(s);
      if (s.ci) tvSync(s);
    },
  };
}

const session = writable<CastSession | null>(null);
/** the session the cast engine owns (null = nothing is cast) */
export const castSession: Readable<CastSession | null> = { subscribe: session.subscribe };

/**
 * `EngineDeps.lock` over navigator.locks: the release function while held, null when `ifAvailable` and another tab holds it.
 * Without the Locks API (or when it refuses, e.g. an opaque origin) every tab owns, as before the lock.
 */
export function castLock(locks: Pick<LockManager, 'request'> | undefined, ifAvailable: boolean): Promise<(() => void) | null> {
  if (!locks?.request) return Promise.resolve(() => undefined);
  return new Promise((resolve) => {
    locks.request(CAST_LOCK, { ifAvailable }, (l) => {
      if (!l) { resolve(null); return undefined; }
      return new Promise<void>((done) => resolve(() => done())); // held until released
    }).catch(() => resolve(() => undefined));
  });
}

/** browser wiring: `window` / `document` / `localStorage` are only touched when a dep is called (first adopt, the SDK ready) */
const browserDeps: EngineDeps = {
  api,
  item: async (id) => cachedItem(id) ?? (await api<ItemDetail>(`/api/items/${id}`)).item,
  cast: { castState, onCastEvent, loadOnCast, castPlayPause, castSeek, castStop, castSetSubtitle, queueOnCast, castQueueRemove, castQueueNext, castAdoptTracks, castCustomReceiver, castBody, castSendMessage, onReceiverMessage },
  async segments(id) {
    const caps = get(serverCaps);
    if (!caps.segments.length) return [];
    const r = await api<{ segments: Segment[] } | null>(`/api/items/${id}/segments`);
    return (r?.segments ?? []).map((x) => ({ ...x, type: String(x.type).toLowerCase() })).filter((x) => segmentShown(caps, x.type));
  },
  hidden: () => document.visibilityState === 'hidden',
  onWake(fn) {
    const vis = () => { if (document.visibilityState === 'visible') fn(); };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pageshow', fn);
    return () => { document.removeEventListener('visibilitychange', vis); window.removeEventListener('pageshow', fn); };
  },
  air: createAirPlay,
  body: () => document.body,
  onPageHide: (fn) => { window.addEventListener('pagehide', fn); return () => window.removeEventListener('pagehide', fn); },
  toast: (kind, msg) => { toast[kind](msg); },
  prefs: () => get(prefs),
  timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>), now: () => Date.now() },
  onHidden(fn) {
    const vis = () => { if (document.visibilityState === 'hidden') fn(); };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  },
  get store() {
    try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
  },
  digest: sha256Hex,
  log: (e) => castLog(e),
  requestSession: requestCastSession,
  leave: castLeave,
  whenReady: whenCastReady,
  lock: (ifAvailable) => castLock(typeof navigator === 'undefined' ? undefined : navigator.locks, ifAvailable),
  onRestore(fn) {
    if (typeof window === 'undefined') return;
    window.addEventListener('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) fn(); });
  },
};
export const castEngine: CastEngine = createCastEngine(browserDeps, session);
