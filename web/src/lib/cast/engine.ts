// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cast engine: owns a running cast session (Chromecast; AirPlay joins later) so it outlives the watch page.
 *
 * The Player hands a running cast over with `adopt()`; from then on the engine mirrors the receiver into `castSession`,
 * reports `start` / `progress` / `stop` for the cast token (`/api/playback/*`), renews the token, and switches titles
 * on the TV (`playOnTv`: old title stopped and its token revoked, new token loaded). One cast token is live at a time.
 * Nothing (listeners, timers, requests) is touched before the first `adopt()`.
 */
import { get, writable, type Readable, type Writable } from 'svelte/store';
import { api, cachedItem, secToTicks, ticksToSec, type Item, type ItemDetail } from '#lib/api';
import { castPlayPause, castSeek, castSetSubtitle, castState, castStop, loadOnCast, onCastEvent, type CastEvent, type CastInfo, type CastState } from '#lib/cast';
import { tr } from '#lib/i18n';
import { createAirPlay, type AirPlayController, type AirPlayState } from '#lib/player/airplay';
import { barTitles, firstInfoBody } from '#lib/player/bar';
import { prefs, type Prefs } from '#lib/stores';
import { toast } from '#lib/ui/toast';

export type CastKind = 'airplay' | 'chromecast';
export type CastPhase = 'connecting' | 'playing' | 'reconnect' | 'ended' | 'failed';
export interface CastSession {
  kind: CastKind; device: string; itemId: string; seriesId?: string;
  title: string; subtitle: string; posterId: string; isEpisode: boolean;
  position: number; duration: number; paused: boolean; buffering: boolean; state: CastPhase;
  /** set in `ended` when a next episode follows; startsAt = epoch ms of the autoplay (null = button only) */
  next?: { itemId: string; label: string; startsAt: number | null };
}
export interface PlayerHandoff {
  kind: CastKind; itemId: string; seriesId?: string; title: string; subtitle: string; isEpisode: boolean;
  position: number; duration: number; paused: boolean;
  cast: CastInfo; /** the Player already sent `start` for this cast session */ started: boolean;
  audioIndex?: number; subIndex: number; maxBitrate?: number; sleepAfterEpisode: boolean;
  /** AirPlay only: the Player's element, its controller and the availability probe */
  video?: HTMLVideoElement; air?: AirPlayController; probe?: HTMLVideoElement | null;
}
export interface CastEngine {
  adopt(h: PlayerHandoff): void;
  playPause(): void; seek(sec: number): void; skip(delta: number): void;
  /** plays another title on the TV (no `startAt` = the server's resume position) */
  playOnTv(itemId: string, startAt?: number): Promise<void>;
  next(): Promise<void>;
  stop(): Promise<void>;
  /** from a tap on the bar in `reconnect`: Chromecast retries the last token request once */
  reconnect(): void;
  /** new token at the current position (audio track / quality change, renewal) */
  refresh(o?: { audioIndex?: number; maxBitrate?: number }): Promise<void>;
  setSubtitle(index: number): void;
  /** drops a `failed` session without touching the receiver ("Play here") */
  release(): void;
  readonly airState: Readable<AirPlayState | null>;
}
export type CastFns = Pick<typeof import('#lib/cast'), 'castState' | 'onCastEvent' | 'loadOnCast' | 'castPlayPause' | 'castSeek' | 'castStop' | 'castSetSubtitle'>;
export interface EngineDeps {
  api: typeof api; item(id: string): Promise<Item>; cast: CastFns; air: typeof createAirPlay;
  body(): HTMLElement; onPageHide(fn: () => void): () => void; toast(kind: 'info' | 'error', msg: string): void;
  prefs(): Prefs; timers: { set(fn: () => void, ms: number): unknown; clear(t: unknown): void; now(): number };
}

/** progress report cadence while the receiver plays */
export const PROGRESS_MS = 10_000;
/** a cast token is renewed when it expires within this */
export const RENEW_BEFORE_MS = 10 * 60_000;
/** the bar stays this long after the title ended */
export const ENDED_HIDE_MS = 5_000;

/** the engine's bookkeeping for the session in `castSession` */
interface Live {
  view: CastSession;
  /** the live cast token (null while switching, after a failure and after the end) */
  ci: CastInfo | null;
  /** `start` was reported for `ci` (a `stop` is owed) */
  started: boolean;
  /** a token switch is in flight: the receiver still reports the previous media */
  busy: boolean;
  lastPaused: boolean | null;
  audioIndex?: number; subIndex: number; maxBitrate?: number; sleepAfterEpisode: boolean;
  /** what `reconnect()` repeats after a failed token request */
  retry: (() => Promise<void>) | null;
  offs: Array<() => void>;
  loop?: unknown; hide?: unknown;
}

/** the Player's texts for a failed token request */
function castErr(e: unknown): string {
  const b = (e as { body?: { error?: string; max?: unknown } } | null)?.body;
  return b?.error === 'max_streams' ? tr('player.error.maxStreams', { n: Number(b.max) })
    : b?.error === 'transcoding_disabled' ? tr('player.cast.needsTranscode') : tr('player.cast.failed');
}

export function createCastEngine(deps: EngineDeps, out: Writable<CastSession | null> = writable(null)): CastEngine {
  const { api: call, cast, timers } = deps;
  const airState = writable<AirPlayState | null>(null);
  let cur: Live | null = null;
  /** bumped by every switch and by the end of a session: an older async step that sees another value gives up */
  let seq = 0;

  const patch = (s: Live, p: Partial<CastSession>) => {
    if (cur !== s) return;
    s.view = { ...s.view, ...p };
    out.set(s.view);
  };
  const report = (s: Live, kind: 'start' | 'progress' | 'stop', ci: CastInfo, keepalive = false): Promise<unknown> => call(`/api/playback/${kind}`, {
    method: 'POST',
    body: { itemId: s.view.itemId, playSessionId: ci.playSessionId, mediaSourceId: ci.mediaSourceId, positionTicks: secToTicks(s.view.position), isPaused: s.view.paused, audioIndex: s.audioIndex, playMethod: 'Transcode' },
    ...(keepalive ? { keepalive } : {}),
  }).catch(() => undefined);
  /** the owed `stop` for the live token (resolves at once when none is owed) */
  const stopReport = (s: Live, keepalive = false): Promise<unknown> => {
    if (!s.started || !s.ci) return Promise.resolve();
    s.started = false;
    return report(s, 'stop', s.ci, keepalive);
  };
  const revoke = (ci: CastInfo | null, keepalive = false) => {
    if (ci) void call(`/api/cast/session/${ci.castId}`, { method: 'DELETE', ...(keepalive ? { keepalive } : {}) }).catch(() => undefined);
  };
  /** forgets the session: listeners and timers off, `castSession` null (the token is the caller's business) */
  const end = (s: Live) => {
    if (cur !== s) return;
    cur = null;
    seq++;
    for (const off of s.offs) off();
    s.offs = [];
    timers.clear(s.loop);
    if (s.hide !== undefined) timers.clear(s.hide);
    out.set(null);
  };

  function tick(s: Live, st: CastState) {
    if (cur !== s) return;
    const device = st.connected ? st.deviceName || 'Chromecast' : s.view.device;
    if (!s.ci || s.busy) { patch(s, { device }); return; }
    const p: Partial<CastSession> = { device, buffering: !st.loaded || st.state === 'buffering' };
    if (st.loaded) {
      p.position = st.currentTime;
      if (st.duration) p.duration = st.duration;
      p.paused = st.paused;
      if (st.state === 'playing' && !s.started) p.state = 'playing';
    }
    patch(s, p);
    if (!st.loaded) return;
    if (st.state === 'playing' && !s.started) { s.started = true; void report(s, 'start', s.ci); }
    else if (s.started && s.lastPaused !== null && s.lastPaused !== st.paused) void report(s, 'progress', s.ci);
    s.lastPaused = st.paused;
  }

  function onEvent(s: Live, e: CastEvent) {
    if (cur !== s) return;
    if (e === 'session-end') {
      const ci = s.ci, stopped = stopReport(s);
      s.ci = null;
      end(s);
      void stopped.then(() => revoke(ci));
    } else if (e === 'media-end' && s.ci && !s.busy) {
      patch(s, { state: 'ended', position: s.view.duration || s.view.position, buffering: false });
      const ci = s.ci, stopped = stopReport(s);
      s.ci = null;
      void stopped.then(() => revoke(ci));
      s.hide = timers.set(() => { end(s); cast.castStop(); }, ENDED_HIDE_MS);
    }
  }

  function onPageHide(s: Live) {
    if (cur !== s) return;
    void stopReport(s, true);
    revoke(s.ci, true);
    s.ci = null;
    end(s);
    cast.castStop();
  }

  function arm(s: Live) {
    s.loop = timers.set(() => {
      if (cur !== s) return;
      if (s.ci && !s.busy) {
        if (s.started) void report(s, 'progress', s.ci);
        if (s.ci.expiresAt - timers.now() < RENEW_BEFORE_MS) void swap(s, s.view.itemId, s.view.position, false);
      }
      arm(s);
    }, PROGRESS_MS);
  }

  /**
   * Replaces the live token: `stop` for the old one, old token revoked, new token requested and loaded on the receiver.
   * `fresh` = another title (metadata from the item, default audio, no subtitle); otherwise the same title (renewal, tracks).
   */
  async function swap(s: Live, itemId: string, startAt: number | undefined, fresh: boolean): Promise<void> {
    const my = ++seq;
    if (s.hide !== undefined) { timers.clear(s.hide); s.hide = undefined; }
    const old = s.ci, stopped = stopReport(s);
    s.ci = null; s.busy = true; s.retry = null; s.lastPaused = null;
    if (fresh) { s.audioIndex = undefined; s.subIndex = -1; }
    patch(s, { itemId, state: 'connecting', position: startAt ?? 0, paused: false, buffering: true, next: undefined });
    const meta = fresh ? deps.item(itemId).catch(() => null) : Promise.resolve(null);
    const [, it] = await Promise.all([stopped, meta]);
    revoke(old);
    if (my !== seq) return;
    if (it) { const { title, sub } = barTitles(it); patch(s, { title, subtitle: sub, seriesId: it.seriesId, posterId: it.id, isEpisode: it.type === 'Episode' }); }
    let ci: CastInfo;
    try {
      ci = await call<CastInfo>('/api/cast/session', {
        method: 'POST',
        body: { itemId, startTicks: startAt === undefined ? undefined : secToTicks(startAt), audioIndex: s.audioIndex, maxBitrate: s.maxBitrate ?? firstInfoBody(deps.prefs()).maxBitrate },
      });
    } catch (e) {
      if (my !== seq) return;
      s.busy = false;
      s.retry = () => swap(s, itemId, startAt, fresh);
      deps.toast('error', castErr(e));
      patch(s, { state: 'reconnect', buffering: false });
      return;
    }
    if (my !== seq) { revoke(ci); return; }
    s.ci = ci;
    if (fresh && !it) patch(s, { title: ci.seriesName ?? ci.title, subtitle: ci.seriesName ? ci.title : '', seriesId: undefined, posterId: itemId, isEpisode: Boolean(ci.seriesName) });
    patch(s, { position: startAt ?? ci.startTime, ...(ci.runtimeTicks ? { duration: ticksToSec(ci.runtimeTicks) } : {}) });
    const ok = await cast.loadOnCast(ci, s.subIndex);
    if (my !== seq) return; // a newer switch revokes `ci`, a session end already did
    s.busy = false;
    if (!ok) {
      s.ci = null;
      revoke(ci);
      deps.toast('error', tr('player.castBar.failed', { title: s.view.title, device: s.view.device }));
      patch(s, { state: 'failed', buffering: false });
    }
    // the next receiver update (it reports the loaded media) sends `start`
  }

  function seek(sec: number) {
    const s = cur;
    if (!s?.ci || s.busy) return;
    const t = Math.max(0, s.view.duration ? Math.min(s.view.duration, sec) : sec);
    cast.castSeek(t);
    patch(s, { position: t });
    if (s.started) void report(s, 'progress', s.ci);
  }

  return {
    airState: { subscribe: airState.subscribe },
    adopt(h) {
      if (h.kind !== 'chromecast') return;
      const prev = cur;
      if (prev) {
        // the same token again (the Player re-hands its session): nothing to stop; another token: stop and revoke it
        const ci = prev.ci, same = ci?.castId === h.cast.castId, stopped = same ? Promise.resolve() : stopReport(prev);
        end(prev);
        if (ci && !same) void stopped.then(() => revoke(ci));
      }
      const s: Live = {
        view: { kind: h.kind, device: 'Chromecast', itemId: h.itemId, seriesId: h.seriesId, title: h.title, subtitle: h.subtitle, posterId: h.itemId, isEpisode: h.isEpisode,
          position: h.position, duration: h.duration, paused: h.paused, buffering: false, state: h.started ? 'playing' : 'connecting' },
        ci: h.cast, started: h.started, busy: false, lastPaused: null,
        audioIndex: h.audioIndex, subIndex: h.subIndex, maxBitrate: h.maxBitrate, sleepAfterEpisode: h.sleepAfterEpisode,
        retry: null, offs: [],
      };
      cur = s;
      out.set(s.view);
      s.offs.push(cast.castState.subscribe((st) => tick(s, st)), cast.onCastEvent((e) => onEvent(s, e)), deps.onPageHide(() => onPageHide(s)));
      arm(s);
    },
    playPause() { if (cur?.ci) cast.castPlayPause(); },
    seek,
    skip(delta) { if (cur) seek(cur.view.position + delta); },
    async playOnTv(itemId, startAt) { if (cur) await swap(cur, itemId, startAt, true); },
    next: async () => undefined,
    async stop() {
      const s = cur;
      if (!s) return;
      const ci = s.ci, stopped = stopReport(s);
      s.ci = null;
      end(s);
      cast.castStop();
      await stopped;
      revoke(ci);
    },
    reconnect() {
      const s = cur;
      if (!s?.retry || s.view.state !== 'reconnect') return;
      const again = s.retry;
      s.retry = null;
      void again();
    },
    async refresh(o) {
      const s = cur;
      if (!s?.ci) return;
      if (o?.audioIndex !== undefined) s.audioIndex = o.audioIndex;
      if (o?.maxBitrate !== undefined) s.maxBitrate = o.maxBitrate;
      await swap(s, s.view.itemId, s.view.position, false);
    },
    setSubtitle(index) {
      const s = cur;
      if (!s) return;
      s.subIndex = index;
      if (s.ci) cast.castSetSubtitle(index);
    },
    release() { if (cur?.view.state === 'failed') end(cur); },
  };
}

const session = writable<CastSession | null>(null);
/** the session the cast engine owns (null = nothing is cast) */
export const castSession: Readable<CastSession | null> = { subscribe: session.subscribe };

/** browser wiring: `window` / `document` are only touched when a dep is called (first adopt) */
const browserDeps: EngineDeps = {
  api,
  item: async (id) => cachedItem(id) ?? (await api<ItemDetail>(`/api/items/${id}`)).item,
  cast: { castState, onCastEvent, loadOnCast, castPlayPause, castSeek, castStop, castSetSubtitle },
  air: createAirPlay,
  body: () => document.body,
  onPageHide: (fn) => { window.addEventListener('pagehide', fn); return () => window.removeEventListener('pagehide', fn); },
  toast: (kind, msg) => { toast[kind](msg); },
  prefs: () => get(prefs),
  timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>), now: () => Date.now() },
};
export const castEngine: CastEngine = createCastEngine(browserDeps, session);
