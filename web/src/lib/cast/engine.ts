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
 */
import { get, writable, type Readable, type Writable } from 'svelte/store';
import { api, cachedItem, secToTicks, ticksToSec, type Item, type ItemDetail } from '#lib/api';
import { castPlayPause, castSeek, castSetSubtitle, castState, castStop, loadOnCast, onCastEvent, type CastEvent, type CastInfo, type CastState } from '#lib/cast';
import { tr } from '#lib/i18n';
import { createAirPlay, type AirPlayController, type AirPlayDeps, type AirPlayState } from '#lib/player/airplay';
import { airLog } from '#lib/player/airplayLog';
import { barTitles, firstInfoBody } from '#lib/player/bar';
import { prefs, type Prefs } from '#lib/stores';
import { toast } from '#lib/ui/toast';

export type CastKind = 'airplay' | 'chromecast';
export type CastPhase = 'connecting' | 'playing' | 'reconnect' | 'ended' | 'failed';
/** an audio or subtitle track the remote (an attached Player) offers */
export interface CastTrack { index: number; title: string; language?: string; isDefault?: boolean }
export interface CastSession {
  kind: CastKind; device: string; itemId: string; seriesId?: string;
  title: string; subtitle: string; posterId: string; isEpisode: boolean;
  position: number; duration: number; paused: boolean; buffering: boolean; state: CastPhase;
  /** the title's tracks for the remote's tracks menu (another title: no audio list, its token's subtitles) and the current choice */
  audioTracks: CastTrack[]; subtitles: CastTrack[]; audioIndex?: number; subIndex: number;
  /** set in `ended` when a next episode follows; startsAt = epoch ms of the autoplay (null = button only) */
  next?: { itemId: string; label: string; startsAt: number | null };
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
  next(): Promise<void>;
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
  audioIndex?: number; subIndex: number; maxBitrate?: number; sleepAfterEpisode: boolean;
  /** what `reconnect()` repeats after a failed token request */
  retry: (() => Promise<void>) | null;
  offs: Array<() => void>;
  loop?: unknown; hide?: unknown;
  air?: AirLive;
}

/** a cast token's subtitles as remote tracks (without their URLs) */
const subsOf = (ci: CastInfo): CastTrack[] => ci.subtitles.map(({ index, title, language }) => ({ index, title, language }));

/** the Player's texts for a failed token request */
function castErr(e: unknown, kind: CastKind = 'chromecast'): string {
  const b = (e as { body?: { error?: string; max?: unknown } } | null)?.body;
  const k = kind === 'airplay' ? 'airplay' : 'cast';
  return b?.error === 'max_streams' ? tr('player.error.maxStreams', { n: Number(b.max) })
    : b?.error === 'transcoding_disabled' ? tr(`player.${k}.needsTranscode`) : tr(`player.${k}.failed`);
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
    s.stopping = report(s, 'stop', s.ci, keepalive);
    return s.stopping;
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
    // the receiver went idle well before the end (playback error, stopped by another sender): not finished
    const finished = e === 'media-end' && s.view.duration > 0 && s.view.position >= s.view.duration - 20;
    if (e === 'session-end' || (e === 'media-end' && s.ci && !s.busy && !finished)) {
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
    if (s.air) {
      s.air.leaving = true;
      airNote(s, 'stop', 'pagehide');
      s.ci = null;
      end(s);
      dropAir(s.air); // the controller revokes its token (keepalive)
      return;
    }
    revoke(s.ci, true);
    s.ci = null;
    end(s);
    cast.castStop();
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
      revoke(ci) { if (a.leaving) revoke(ci, true); else void s.stopping.then(() => revoke(ci)); },
      detach() { void stopReport(s); return s.stopping.then(() => undefined); },
      started(ci) {
        if (cur !== s) return;
        const w = a.want;
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
    if (type === 'ended') {
      patch(s, { state: 'ended', position: s.view.duration || s.view.position, paused: true, buffering: false });
      void stopReport(s);
      s.ci = null;
      s.hide = timers.set(() => { airNote(s, 'stop', 'ended'); end(s); dropAir(a); }, ENDED_HIDE_MS);
      return;
    }
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
  async function airSwap(s: Live, a: AirLive, my: number, itemId: string, startAt: number | undefined, fresh: boolean, it: Item | null) {
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
    const old = s.ci;
    void stopReport(s);
    const stopped = s.stopping; // also a stop an earlier, superseded switch still waits for
    s.ci = null; s.busy = true; s.retry = null; s.lastPaused = null;
    if (fresh) { s.audioIndex = undefined; s.subIndex = -1; }
    patch(s, { itemId, state: 'connecting', position: startAt ?? 0, paused: false, buffering: true, next: undefined,
      ...(fresh ? { audioTracks: [], subtitles: [], audioIndex: undefined, subIndex: -1 } : {}) });
    const meta = fresh ? deps.item(itemId).catch(() => null) : Promise.resolve(null);
    const a = s.air;
    const [, it] = await Promise.all([stopped, meta, a?.op]);
    if (!a) revoke(old); // AirPlay: the controller revokes the old token once the new one is on the element
    if (my !== seq) return;
    if (it) { const { title, sub } = barTitles(it); patch(s, { title, subtitle: sub, seriesId: it.seriesId, posterId: it.id, isEpisode: it.type === 'Episode' }); }
    if (a) { await airSwap(s, a, my, itemId, startAt, fresh, it); return; }
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
    if (fresh) patch(s, { subtitles: subsOf(ci) });
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
    if (s.air) s.air.video.currentTime = t;
    else cast.castSeek(t);
    patch(s, { position: t });
    if (s.started) void report(s, 'progress', s.ci);
  }

  return {
    airState: { subscribe: airState.subscribe },
    adopt(h) {
      if (h.kind === 'airplay' && (!h.video || !h.air)) return;
      const prev = cur;
      if (prev) {
        // the same token again (the Player re-hands its session): nothing to stop; another token: stop and revoke it
        const ci = prev.ci, same = ci?.castId === h.cast.castId, stopped = same ? Promise.resolve() : stopReport(prev);
        end(prev);
        if (prev.air) { if (prev.air.ctl !== h.air) dropAir(prev.air); } // its controller revokes its token
        else if (ci && !same) void stopped.then(() => revoke(ci));
      }
      const s: Live = {
        view: { kind: h.kind, device: h.kind === 'airplay' ? tr('player.castBar.airplayDevice') : 'Chromecast', itemId: h.itemId, seriesId: h.seriesId, title: h.title, subtitle: h.subtitle, posterId: h.itemId, isEpisode: h.isEpisode,
          position: h.position, duration: h.duration, paused: h.paused, buffering: false, state: h.started ? 'playing' : 'connecting',
          audioTracks: h.audioTracks ?? [], subtitles: h.subtitles ?? [], audioIndex: h.audioIndex, subIndex: h.subIndex },
        ci: h.cast, started: h.started, busy: false, stopping: Promise.resolve(), lastPaused: null,
        audioIndex: h.audioIndex, subIndex: h.subIndex, maxBitrate: h.maxBitrate, sleepAfterEpisode: h.sleepAfterEpisode,
        retry: null, offs: [],
      };
      cur = s;
      out.set(s.view);
      if (h.video && h.air) {
        s.air = { video: h.video, ctl: h.air, probe: h.probe ?? null, want: null, op: Promise.resolve(), opSeq: null, resume: false, leaving: false };
        adoptAir(s, s.air);
      } else s.offs.push(cast.castState.subscribe((st) => tick(s, st)), cast.onCastEvent((e) => onEvent(s, e)));
      s.offs.push(deps.onPageHide(() => onPageHide(s)));
      arm(s);
    },
    playPause() {
      const s = cur;
      if (!s?.ci) return;
      if (!s.air) { cast.castPlayPause(); return; }
      if (s.air.video.paused) void s.air.video.play().catch(() => undefined);
      else s.air.video.pause();
    },
    seek,
    skip(delta) { if (cur) seek(cur.view.position + delta); },
    async playOnTv(itemId, startAt) { if (cur) await swap(cur, itemId, startAt, true); },
    next: async () => undefined,
    async stop() {
      const s = cur;
      if (!s) return;
      const ci = s.ci, stopped = stopReport(s);
      s.ci = null;
      if (s.air) {
        airNote(s, 'stop');
        end(s);
        dropAir(s.air); // the controller revokes its token once the stop report is through
        await stopped;
        return;
      }
      end(s);
      cast.castStop();
      await stopped;
      revoke(ci);
    },
    reconnect() {
      const s = cur;
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
      end(s);
      if (s.air) dropAir(s.air);
    },
    pick() { cur?.air?.ctl.pick(); },
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
