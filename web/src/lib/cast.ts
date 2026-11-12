// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Chromecast sender (Google Cast Web Sender SDK, Default Media Receiver).
 * With CAST_RECEIVER_APP_ID set (Admin -> Settings, /api/cast/config `receiverAppId`) the sender starts FriendFlix's own receiver
 * (/cast-receiver/) instead and talks to it on a private channel (CAST_NS): the receiver's report token and its TV UI data. Without it
 * nothing below that differs from the Default Media Receiver flow runs.
 *
 * The SDK is lazy-loaded from gstatic only when it can be useful: Chromium browsers (not iOS), not in TV mode,
 * and only when the server offers casting (/api/cast/config). Nothing is loaded for everyone else.
 * The Cast globals are declared minimally below (no extra npm dependency).
 */
import { get, writable } from 'svelte/store';
import { api } from '#lib/api';
import { perms } from '#lib/perms';
import { castLog, noteCastDevice } from '#lib/cast/castLog';
import { applyAvoid, avoidedOf, castCapsBody, noteAvoid, parseReceiverCaps, usedFeatures, type CastDelivery, type CastFeature, type ReceiverCaps } from '#lib/cast/caps';
import type { Store } from '#lib/cast/resume';

declare global {
  interface Window {
    __onGCastApiAvailable?: (available: boolean) => void;
    cast?: { framework: CastFramework };
    chrome?: { cast: ChromeCast } & Record<string, unknown>;
  }
}
interface CastFramework {
  CastContext: { getInstance(): CastContextT };
  CastContextEventType: { CAST_STATE_CHANGED: string; SESSION_STATE_CHANGED: string };
  SessionState: { SESSION_STARTED: string; SESSION_RESUMED: string; SESSION_ENDED: string };
  RemotePlayer: new () => RemotePlayerT;
  RemotePlayerController: new (p: RemotePlayerT) => RemotePlayerControllerT;
  RemotePlayerEventType: { ANY_CHANGE: string };
}
interface CastContextT {
  setOptions(o: Record<string, unknown>): void;
  addEventListener(t: string, fn: (e: { castState?: string; sessionState?: string }) => void): void;
  requestSession(): Promise<string | undefined>;
  getCurrentSession(): CastSessionT | null;
  endCurrentSession(stopCasting: boolean): void;
}
interface CastSessionT {
  getCastDevice(): { friendlyName: string };
  loadMedia(r: unknown): Promise<string | undefined>;
  getMediaSession(): MediaT | null;
  /** custom receiver channel (not used with the Default Media Receiver) */
  sendMessage?(ns: string, msg: unknown): Promise<unknown>;
  addMessageListener?(ns: string, fn: (ns: string, msg: string) => void): void;
}
/** chrome.cast.media.Media: the receiver's media session (updated in place by the SDK) */
interface MediaT {
  idleReason?: string | null;
  /** queue item id of the item that plays now (queue items after it are the queued ones) */
  currentItemId?: number;
  /** the tracks the receiver shows (cast track ids) */
  activeTrackIds?: number[] | null;
  items?: Array<{ itemId: number; media?: { contentId?: string; customData?: unknown } | null }> | null;
  editTracksInfo(r: unknown, ok: () => void, err: (e: unknown) => void): void;
  queueInsertItems(r: unknown, ok: () => void, err: (e: unknown) => void): void;
  queueRemoveItems(r: unknown, ok: () => void, err: (e: unknown) => void): void;
  queueNext(ok: () => void, err: (e: unknown) => void): void;
}
interface RemotePlayerT {
  isConnected: boolean; isPaused: boolean; isMediaLoaded: boolean; currentTime: number; duration: number; volumeLevel: number; isMuted: boolean;
  playerState: string | null; mediaInfo: { contentId?: string; customData?: unknown } | null;
}
interface RemotePlayerControllerT {
  addEventListener(t: string, fn: () => void): void;
  playOrPause(): void; stop(): void; seek(): void; setVolumeLevel(): void; muteOrUnmute(): void;
}
interface ChromeCast {
  AutoJoinPolicy: { ORIGIN_SCOPED: string };
  Image: new (url: string) => unknown;
  media: {
    DEFAULT_MEDIA_RECEIVER_APP_ID: string;
    MediaInfo: new (url: string, type: string) => Record<string, unknown>;
    LoadRequest: new (m: unknown) => Record<string, unknown>;
    MovieMediaMetadata: new () => Record<string, unknown>;
    TvShowMediaMetadata: new () => Record<string, unknown>;
    Track: new (id: number, type: string) => Record<string, unknown>;
    EditTracksInfoRequest: new (ids: number[]) => unknown;
    QueueItem: new (m: unknown) => Record<string, unknown>;
    QueueInsertItemsRequest: new (items: unknown[]) => Record<string, unknown>;
    QueueRemoveItemsRequest: new (ids: number[]) => unknown;
    StreamType: { BUFFERED: string };
    HlsSegmentFormat: { TS: string; FMP4?: string };
    HlsVideoSegmentFormat?: { FMP4?: string };
    MetadataType: { MOVIE: number; TV_SHOW: number };
    TrackType: { TEXT: string };
    TextTrackType: { SUBTITLES: string };
  };
}

/** answer of POST /api/cast/session */
export interface CastInfo {
  castId: string;
  expiresAt: number;
  playSessionId: string;
  mediaSourceId: string;
  runtimeTicks?: number;
  startTime: number;
  contentUrl: string;
  contentType: string;
  hlsSegmentFormat: string;
  title: string;
  seriesName?: string;
  imageUrl?: string;
  subtitles: Array<{ index: number; language?: string; title: string; url: string }>;
  /** FriendFlix's own receiver only: the token it reports this play session with (sent to it on CAST_NS, never in media metadata) */
  report?: string;
  /** 'fmp4' for a HEVC / surround stream (the answer then also carries `hlsVideoSegmentFormat`); absent otherwise */
  hlsVideoSegmentFormat?: string;
  /** AirPlay only: the stream carries the one WebVTT rendition that was asked for (`subtitleIndex`); absent otherwise */
  hlsSub?: boolean;
  /** what the stream carries (fixed codes, see caps.ts); only in the answer to a cast that sent receiver caps */
  delivery?: CastDelivery;
}

export interface CastState {
  available: boolean;
  connected: boolean;
  deviceName: string;
  state: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  /** a media is loaded on the receiver */
  loaded: boolean;
  /** the receiver's media (its content URL, '' = unknown): a queued next title shows up here once the receiver moved on */
  contentId: string;
  /** why the receiver went idle (FINISHED / CANCELLED / INTERRUPTED / ERROR; null = unknown or not idle) */
  idleReason: string | null;
  /** the public handle of the loaded media when the own receiver reports it (`customData.ff.castId`, 32 hex), else '' */
  castId: string;
  /** the receiver's queue after the playing item (`castId` is '' when the receiver did not carry it: derive it from the content URL) */
  queue: Array<{ itemId: number; contentId: string; castId: string }>;
}
const initial: CastState = { available: false, connected: false, deviceName: '', state: 'idle', currentTime: 0, duration: 0, paused: true, volume: 1, muted: false, loaded: false, contentId: '', idleReason: null, castId: '', queue: [] };
export const castState = writable<CastState>(initial);

export type CastEvent = 'session-start' | 'session-resume' | 'session-end' | 'media-end';
const listeners = new Set<(e: CastEvent) => void>();
/** subscribes to session start/resume/end and "media finished on the receiver"; returns the unsubscribe function */
export function onCastEvent(fn: (e: CastEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (e: CastEvent) => listeners.forEach((fn) => fn(e));

const SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
let initStarted = false;
let ctxT: CastContextT | null = null;
let player: RemotePlayerT | null = null;
let controller: RemotePlayerControllerT | null = null;
/** subtitle index -> cast track id, per content URL (the loaded title and a queued one) */
const trackMaps = new Map<string, Map<number, number>>();
let trackIds = new Map<number, number>();
let lastLoaded = false;
/** the receiver's media session as last seen: the SDK may drop it before the idle update reaches the RemotePlayer */
let lastMedia: MediaT | null = null;
/** the idle-ERROR already logged for the current media (one entry per error, not one per status update) */
let errorLogged = false;

const CAST_ID = /^[0-9a-f]{32}$/;
/** `customData.ff.castId` of a MediaInfo (the own receiver's handle), '' when absent or not 32 hex */
function castIdOf(info: { customData?: unknown } | null | undefined): string {
  const id = (info?.customData as { ff?: { castId?: unknown } } | null | undefined)?.ff?.castId;
  return typeof id === 'string' && CAST_ID.test(id) ? id : '';
}
/** the receiver's queue after the playing item (the first item counts as playing when the SDK reports no current item id) */
function queueOf(ms: MediaT | null): CastState['queue'] {
  const items = ms?.items ?? [];
  const id = ms?.currentItemId;
  const cur = id === undefined ? 0 : items.findIndex((q) => q.itemId === id);
  if (cur < 0) return []; // the playing item is not in the list: do not mistake it for a queued one
  return items.slice(cur + 1).map((q) => ({ itemId: q.itemId, contentId: q.media?.contentId ?? '', castId: castIdOf(q.media) }));
}

/** the acting profile may cast (me.perms.cast): the server answers 403 cast_forbidden otherwise, so nothing casting-related starts */
export const castAllowed = (): boolean => get(perms).cast;

/** Chromium only (Chrome, Edge, Opera, Samsung ...), never iOS (all iOS browsers are WebKit), never a paired TV. */
export function castCapableBrowser(): boolean {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return false;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios || !/Chrome\/|Chromium\/|CriOS/.test(ua) || /CriOS/.test(ua)) return false;
  return !document.documentElement.classList.contains('tv');
}

/** GET /api/cast/config once per page (Chromecast SDK and the AirPlay button share it); a failure is asked again next time. */
let cfgP: Promise<boolean> | null = null;
/** the app ID of FriendFlix's own receiver ('' = Default Media Receiver), from the same config answer */
let receiverId = '';
export function castConfigEnabled(): Promise<boolean> {
  cfgP ??= api<{ enabled: boolean; receiverAppId?: string }>('/api/cast/config').then((c) => {
    receiverId = typeof c?.receiverAppId === 'string' && /^[0-9A-F]{8}$/.test(c.receiverAppId) ? c.receiverAppId : '';
    return Boolean(c?.enabled);
  }).catch((e) => { cfgP = null; throw e; });
  return cfgP;
}

/** the private message channel between this sender and FriendFlix's own receiver (cast-receiver/receiver.js uses the same name) */
export const CAST_NS = 'urn:x-cast:com.friendflix.cast';
/** the sender casts to FriendFlix's own receiver */
export const castCustomReceiver = () => receiverId !== '';
/**
 * a POST /api/cast/session body for the Chromecast: with the own receiver it asks for the receiver's report token too, and carries
 * what that receiver confirmed it plays (`caps`: HEVC, Dolby; see caps.ts) minus what failed on this TV before. Nothing is claimed
 * before the receiver stated it (an old receiver, a slow one, the Default Media Receiver and AirPlay never carry caps).
 */
export function castBody<T extends Record<string, unknown>>(b: T): T {
  if (!receiverId || b.via === 'airplay') return b;
  const caps = castCapsBody(rxCaps ? applyAvoid(rxCaps, { ...avoidedOf(store(), deviceNameNow(), Date.now()), ...sessionAvoid }) : null);
  return { ...b, receiver: true, ...(caps ? { caps } : {}) };
}

/** localStorage (null: blocked) for the per-device avoid memory */
function store(): Store {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
const deviceNameNow = () => ctxT?.getCurrentSession()?.getCastDevice().friendlyName ?? '';

/** how long a token request waits for the receiver's caps (it states them when a sender connects and answers `caps?` at once) */
export const CAPS_WAIT_MS = 2000;
/** what the own receiver confirmed for the current session (null: not yet, or it never answers); reset with every session */
let rxCaps: ReceiverCaps | null = null;
/** the receiver did not answer in time this session: later requests do not wait again (a late answer still counts) */
let capsGaveUp = false;
/** features that failed on the current session's TV (also without a usable device name): dropped from the caps at once */
let sessionAvoid: Partial<Record<CastFeature, boolean>> = {};
const capsWaiters: Array<() => void> = [];
const capsFlush = () => capsWaiters.splice(0).forEach((fn) => fn());
function capsReset() { rxCaps = null; capsGaveUp = false; sessionAvoid = {}; capsFlush(); }
/**
 * Resolves once a token request can be built: at once for the Default Media Receiver, without a session or when the receiver already
 * answered (or did not, this session); otherwise when its caps arrive, at the latest after CAPS_WAIT_MS.
 */
export function castCapsReady(): Promise<void> {
  if (!receiverId || rxCaps || capsGaveUp || !ctxT?.getCurrentSession()) return Promise.resolve();
  return new Promise((done) => {
    const t = setTimeout(() => { capsGaveUp = true; capsFlush(); }, CAPS_WAIT_MS);
    capsWaiters.push(() => { clearTimeout(t); done(); });
  });
}
/**
 * The own receiver failed a stream (the load was refused, or it went idle with an error right at the start): which of HEVC / surround it
 * carried (the answer's fixed `delivery` codes) is remembered for this TV's name for 30 days and dropped from the caps of this session,
 * so the next request is the same title without them. null: not the own receiver, or the stream carried neither (then it is no codec problem).
 */
export function castFellBack(info: CastInfo): 'hevc' | 'surround' | 'both' | null {
  const used = receiverId ? usedFeatures(info.delivery) : [];
  if (!used.length) return null;
  for (const f of used) sessionAvoid[f] = true;
  noteAvoid(store(), deviceNameNow(), used, Date.now());
  castLog({ level: 'warn', tag: 'receiver', text: `the TV could not play ${used.join(' and ')} · remembered for this device` });
  return used.length === 2 ? 'both' : used[0]!;
}
const rxListeners = new Set<(m: Record<string, unknown>) => void>();
/** messages from the own receiver (TV remote input, "still watching" answered on the TV); returns the unsubscribe function */
export function onReceiverMessage(fn: (m: Record<string, unknown>) => void): () => void {
  rxListeners.add(fn);
  return () => rxListeners.delete(fn);
}
/** to the own receiver (no-op with the Default Media Receiver or without a session); never throws */
export function castSendMessage(msg: Record<string, unknown>) {
  if (!receiverId) return;
  try { void ctxT?.getCurrentSession()?.sendMessage?.(CAST_NS, msg)?.catch?.(() => undefined); } catch { /* gone with its session */ }
}
/** listens on the receiver channel of a (new or resumed) session, once per session object */
const listened = new WeakSet<object>();
function listen() {
  const sess = ctxT?.getCurrentSession();
  if (!receiverId || !sess?.addMessageListener || listened.has(sess)) return;
  listened.add(sess);
  capsReset(); // a new session: what the last TV confirmed says nothing about this one
  sess.addMessageListener(CAST_NS, (_ns, raw) => {
    let m: unknown;
    try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    if (m && typeof m === 'object' && (m as { t?: unknown }).t === 'caps') {
      const c = parseReceiverCaps(m);
      if (c) { rxCaps = c; capsFlush(); }
      return;
    }
    if (m && typeof m === 'object' && typeof (m as { t?: unknown }).t === 'string') rxListeners.forEach((fn) => fn(m as Record<string, unknown>));
  });
  castSendMessage({ t: 'caps?' }); // the receiver also states them by itself when a sender connects: whichever comes first
}
/** the receiver's report token of a just loaded / queued token goes over the private channel */
const sendReport = (info: CastInfo) => { if (info.report) castSendMessage({ t: 'tok', castId: info.castId, rt: info.report }); };

/** Loads the SDK once if casting makes sense here. Safe to call repeatedly. Never throws. */
export async function initCast(): Promise<void> {
  if (initStarted || !castAllowed() || !castCapableBrowser()) return;
  initStarted = true;
  try {
    if (!(await castConfigEnabled())) return;
    window.__onGCastApiAvailable = (ok) => { if (ok) setup(); };
    const s = document.createElement('script');
    s.src = SDK;
    s.async = true;
    document.head.appendChild(s);
  } catch {
    initStarted = false; // e.g. not logged in yet: try again on the next call
  }
}

function sync() {
  const p = player, c = ctxT;
  if (!p || !c) return;
  const sess = c.getCurrentSession();
  const loaded = p.isConnected && p.isMediaLoaded;
  const ms = sess?.getMediaSession() ?? null;
  if (ms) lastMedia = ms;
  const contentId = p.mediaInfo?.contentId ?? '';
  if (contentId && trackMaps.has(contentId)) trackIds = trackMaps.get(contentId)!;
  castState.update((s) => ({
    ...s,
    connected: p.isConnected,
    deviceName: sess?.getCastDevice().friendlyName ?? (p.isConnected ? s.deviceName : ''),
    state: p.isConnected ? (p.playerState ?? 'IDLE').toLowerCase() : 'idle',
    currentTime: p.currentTime,
    duration: p.duration,
    paused: p.isPaused,
    volume: p.volumeLevel,
    muted: p.isMuted,
    loaded,
    contentId,
    idleReason: lastMedia?.idleReason ?? null,
    castId: loaded ? castIdOf(p.mediaInfo) : '',
    queue: loaded ? queueOf(ms) : [],
  }));
  if (lastMedia?.idleReason === 'ERROR') {
    if (!errorLogged) { errorLogged = true; castLog({ level: 'error', tag: 'receiver', text: 'receiver went idle: ERROR' }); }
  } else errorLogged = false;
  // media ended on the receiver: it was loaded, and now IDLE (the Default Media Receiver reports IDLE + FINISHED)
  if (lastLoaded && !loaded && p.isConnected && (p.playerState === 'IDLE' || p.playerState === null)) emit('media-end');
  lastLoaded = loaded;
}

/** callbacks waiting for the SDK's setup (`whenCastReady`) */
const readyFns: Array<() => void> = [];
let ready = false;
/** runs `fn` once the Cast SDK is set up (at once when it is; never when the SDK is not loaded or unavailable) */
export function whenCastReady(fn: () => void) {
  if (ready) fn();
  else readyFns.push(fn);
}

function setup() {
  const fw = window.cast?.framework, ch = window.chrome?.cast;
  if (!fw || !ch) return;
  ctxT = fw.CastContext.getInstance();
  ctxT.setOptions({ receiverApplicationId: receiverId || ch.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: ch.AutoJoinPolicy.ORIGIN_SCOPED });
  player = new fw.RemotePlayer();
  controller = new fw.RemotePlayerController(player);
  controller.addEventListener(fw.RemotePlayerEventType.ANY_CHANGE, sync);
  ctxT.addEventListener(fw.CastContextEventType.CAST_STATE_CHANGED, (e) => {
    castState.update((s) => ({ ...s, available: e.castState !== 'NO_DEVICES_AVAILABLE' }));
  });
  ctxT.addEventListener(fw.CastContextEventType.SESSION_STATE_CHANGED, (e) => {
    if (e.sessionState === fw.SessionState.SESSION_STARTED) {
      sync();
      listen();
      castLog({ level: 'info', tag: 'session', text: `session started · ${deviceName()}` });
      emit('session-start'); // the user just picked a device
    } else if (e.sessionState === fw.SessionState.SESSION_RESUMED) {
      sync(); // auto-joined an earlier session of this origin: no playback is started on its own
      listen();
      castLog({ level: 'info', tag: 'session', text: `session resumed · ${deviceName()}` });
      emit('session-resume');
    } else if (e.sessionState === fw.SessionState.SESSION_ENDED) {
      lastLoaded = false;
      capsReset();
      castLog({ level: 'info', tag: 'session', text: 'session ended' });
      castState.update((s) => ({ ...s, connected: false, deviceName: '', state: 'idle', loaded: false }));
      emit('session-end');
    }
  });
  // the SDK may already hold a session (auto-joined before this page's script ran): same as a resume
  if (ctxT.getCurrentSession()) {
    sync();
    listen();
    castLog({ level: 'info', tag: 'session', text: `session found at start · ${deviceName()}` });
    emit('session-resume');
  }
  ready = true;
  for (const fn of readyFns.splice(0)) { try { fn(); } catch { /* one waiter never breaks the others */ } }
}
/** the TV's name for a log line; remembered so the copied report can anonymise it later */
const deviceName = () => {
  const n = ctxT?.getCurrentSession()?.getCastDevice().friendlyName;
  if (!n) return 'unknown device'; // only a real receiver name is remembered, never the fallback
  noteCastDevice(n);
  return n;
};

/** Opens the browser's device picker (must run from a click). Resolves when a session started or the picker was dismissed. */
export async function requestCastSession(): Promise<boolean> {
  if (!ctxT) return false;
  try {
    return (await ctxT.requestSession()) === undefined; // undefined = success, otherwise an error code ('cancel' ...)
  } catch {
    return false;
  }
}
export const castConnected = () => get(castState).connected;

/** the receiver's MediaInfo for a cast token (metadata, subtitle tracks); its track map is kept by content URL */
function mediaOf(info: CastInfo, ch: ChromeCast): Record<string, unknown> {
  const m = ch.media;
  const media = new m.MediaInfo(info.contentUrl, info.contentType);
  media.streamType = m.StreamType.BUFFERED;
  // a HEVC / surround stream (the server's answer says so) is fMP4: the receiver must not expect MPEG-TS segments; every other stream stays as it was
  if (info.hlsSegmentFormat === 'fmp4') {
    media.hlsSegmentFormat = m.HlsSegmentFormat.FMP4 ?? 'fmp4';
    media.hlsVideoSegmentFormat = m.HlsVideoSegmentFormat?.FMP4 ?? 'fmp4';
  } else media.hlsSegmentFormat = m.HlsSegmentFormat.TS;
  if (info.runtimeTicks) media.duration = info.runtimeTicks / 10_000_000;
  const meta = info.seriesName ? new m.TvShowMediaMetadata() : new m.MovieMediaMetadata();
  meta.metadataType = info.seriesName ? m.MetadataType.TV_SHOW : m.MetadataType.MOVIE;
  meta.title = info.title;
  if (info.seriesName) meta.seriesTitle = info.seriesName;
  if (info.imageUrl) meta.images = [new ch.Image(info.imageUrl)];
  media.metadata = meta;
  // the own receiver matches its report token (CAST_NS) by the token's public handle; nothing secret goes into the metadata
  if (receiverId) media.customData = { ff: { castId: info.castId } };
  const ids = new Map<number, number>();
  media.tracks = info.subtitles.map((s, i) => {
    const t = new m.Track(i + 1, m.TrackType.TEXT);
    ids.set(s.index, i + 1);
    t.trackContentId = s.url;
    t.trackContentType = 'text/vtt';
    t.subtype = m.TextTrackType.SUBTITLES;
    t.name = s.title;
    t.language = s.language?.slice(0, 2) || 'und';
    return t;
  });
  if (trackMaps.size > 8) trackMaps.clear();
  trackMaps.set(info.contentUrl, ids);
  return media;
}

/** loads the token on the receiver; `autoplay` false: it stays paused at the start (a renewal while the TV is paused); false on failure */
export async function loadOnCast(info: CastInfo, activeSubtitle = -1, autoplay = true): Promise<boolean> {
  const sess = ctxT?.getCurrentSession(), ch = window.chrome?.cast;
  if (!sess || !ch) return false;
  const media = mediaOf(info, ch);
  trackIds = trackMaps.get(info.contentUrl)!;
  lastMedia = null; // a new media session: the previous one's idle reason is not this one's
  const req = new ch.media.LoadRequest(media);
  req.currentTime = info.startTime;
  req.autoplay = autoplay;
  const active = trackIds.get(activeSubtitle);
  if (active) req.activeTrackIds = [active];
  try {
    const ok = (await sess.loadMedia(req)) === undefined;
    if (ok) sendReport(info);
    return ok;
  } catch {
    return false;
  }
}

/** a queued title starts loading this many seconds before the playing one ends (seamless move on, also without the sender) */
export const QUEUE_PRELOAD_S = 30;
/**
 * Puts the next title into the receiver's queue after the playing one (autoplay, its resume position): the receiver moves on
 * by itself at the end, even when the phone sleeps. Resolves the queue item id, or null (no media session, refused).
 */
export async function queueOnCast(info: CastInfo, autoplay = true): Promise<number | null> {
  const ms = ctxT?.getCurrentSession()?.getMediaSession(), ch = window.chrome?.cast;
  if (!ms || !ch) return null;
  const m = ch.media;
  // an SDK / receiver without the queue API: null (the engine's countdown loads the next episode instead)
  const ok = await new Promise<boolean>((done) => {
    try {
      const item = new m.QueueItem(mediaOf(info, ch));
      item.autoplay = autoplay; // false: the own receiver asks "still watching?" before it plays (engine prequeue)
      item.startTime = info.startTime;
      item.preloadTime = QUEUE_PRELOAD_S;
      ms.queueInsertItems(new m.QueueInsertItemsRequest([item]), () => done(true), () => done(false));
    } catch { done(false); }
  });
  if (!ok) return null;
  sendReport(info);
  return ms.items?.find((q) => q.media?.contentId === info.contentUrl)?.itemId ?? null;
}
/** drops a queued title (its countdown was cancelled, another title plays) */
export function castQueueRemove(itemId: number) {
  const ms = ctxT?.getCurrentSession()?.getMediaSession(), ch = window.chrome?.cast;
  if (!ms || !ch) return;
  try { ms.queueRemoveItems(new ch.media.QueueRemoveItemsRequest([itemId]), () => undefined, () => undefined); } catch { /* gone with its session */ }
}
/** the receiver jumps to the queued title now (end of the countdown) */
export function castQueueNext() {
  const ms = ctxT?.getCurrentSession()?.getMediaSession();
  try { ms?.queueNext(() => undefined, () => undefined); } catch { /* gone with its session */ }
}

export const castPlayPause = () => controller?.playOrPause();
export function castPlay() { if (player?.isPaused) controller?.playOrPause(); }
export function castPause() { if (player && !player.isPaused) controller?.playOrPause(); }
export function castSeek(sec: number) { if (!player) return; player.currentTime = Math.max(0, sec); controller?.seek(); }
export function castSetVolume(v: number) { if (!player) return; player.volumeLevel = Math.max(0, Math.min(1, v)); controller?.setVolumeLevel(); }
export function castToggleMute() { controller?.muteOrUnmute(); }
/**
 * Rebuilds the subtitle track map of a re-adopted title (track id = position + 1, as `mediaOf` assigned them when it was loaded).
 * Becomes the active map unless the receiver is known to play something else.
 */
export function castAdoptTracks(contentUrl: string, subs: Array<{ index: number }>) {
  const ids = new Map<number, number>();
  subs.forEach((s, i) => ids.set(s.index, i + 1));
  if (trackMaps.size > 8) trackMaps.clear();
  trackMaps.set(contentUrl, ids);
  const cur = get(castState).contentId;
  if (!cur || cur === contentUrl) trackIds = ids;
}
/** the subtitle index the receiver shows now, from the current track map (-1: none, unknown, or no session) */
export function castActiveSubtitle(): number {
  const ids = ctxT?.getCurrentSession()?.getMediaSession()?.activeTrackIds ?? [];
  for (const [index, id] of trackIds) if (ids.includes(id)) return index;
  return -1;
}
/** subtitle index of the cast session info (-1 = off) */
export function castSetSubtitle(index: number) {
  const ch = window.chrome?.cast, ms = ctxT?.getCurrentSession()?.getMediaSession();
  if (!ch || !ms) return;
  const id = trackIds.get(index);
  ms.editTracksInfo(new ch.media.EditTracksInfoRequest(id ? [id] : []), () => undefined, () => undefined);
}
/** ends the cast session (the receiver stops) */
export function castStop() { ctxT?.endCurrentSession(true); }
/** this sender disconnects and the receiver keeps playing (the tab closes, a Chromecast cast carries on) */
export function castLeave() {
  castLog({ level: 'info', tag: 'sender', text: 'sender left · TV keeps playing' });
  ctxT?.endCurrentSession(false);
}

/** a failed test clip is given up after this long */
const TEST_CLIP_TIMEOUT_MS = 20_000;
/** after the first frame the clip is watched this long for its end (the clip is 6 s) */
const TEST_CLIP_WATCH_MS = 60_000;
/**
 * Diagnose: loads a short MP4 (no tracks, no token) on the current session and measures LOAD -> first PLAYING.
 * `endAfter`: the caller opened the session for the test; it ends (the receiver app stops) when the clip is finished.
 * Resolves `{ ok: false }` after 20 s, on a load error or when the session ends.
 */
export function castTestClip(url: string, title: string, opts: { endAfter?: boolean } = {}): Promise<{ ok: boolean; firstFrameMs: number | null }> {
  const sess = ctxT?.getCurrentSession(), ch = window.chrome?.cast;
  if (!sess || !ch) return Promise.resolve({ ok: false, firstFrameMs: null });
  const m = ch.media;
  const abs = new URL(url, location.href).href; // the TV cannot resolve a relative path
  const media = new m.MediaInfo(abs, 'video/mp4');
  media.streamType = m.StreamType.BUFFERED;
  const meta = new m.MovieMediaMetadata();
  meta.metadataType = m.MetadataType.MOVIE;
  meta.title = title;
  media.metadata = meta;
  const req = new m.LoadRequest(media);
  req.autoplay = true;
  req.currentTime = 0;
  lastMedia = null;
  return new Promise((resolve) => {
    let settled = false, playing = false, first = true;
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const t0 = Date.now();
    const offStore = castState.subscribe((s) => {
      if (first) { first = false; return; } // the value at subscription time is not an update of this clip
      if (s.contentId && s.contentId !== abs) { if (playing) cleanup(); return; } // something else took over
      if (!playing && s.state === 'playing') { playing = true; finish(true); if (opts.endAfter) capTimer = setTimeout(cleanup, TEST_CLIP_WATCH_MS); }
      else if (playing && s.state === 'idle') { cleanup(); if (opts.endAfter && s.idleReason === 'FINISHED') ctxT?.endCurrentSession(true); }
      else if (!playing && s.idleReason === 'ERROR') finish(false);
    });
    const offEvents = onCastEvent((e) => { if (e === 'session-end') { if (!playing) finish(false); cleanup(); } });
    const timer = setTimeout(() => finish(false), TEST_CLIP_TIMEOUT_MS);
    function cleanup() { clearTimeout(timer); clearTimeout(capTimer); offStore(); offEvents(); }
    function finish(ok: boolean) {
      if (settled) return;
      settled = true;
      const ms = ok ? Date.now() - t0 : null;
      castLog({ level: ok ? 'info' : 'error', tag: 'test', text: ok ? `test clip playing after ${ms} ms` : 'test clip did not play' });
      if (!ok || !opts.endAfter) cleanup(); // with endAfter a played clip stays watched until it is finished
      resolve({ ok, firstFrameMs: ms });
    }
    sess.loadMedia(req).then((r) => { if (r !== undefined) finish(false); }, () => finish(false));
  });
}
