// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { preloadCode } from '$app/navigation';
import { get } from 'svelte/store';
import { api, getActiveProfile } from '#lib/api';
import { serverCaps } from '#lib/capabilities';
import { prefs } from '#lib/stores';
import { capsPending, warmDeviceCaps } from './devicecaps';
import { loadHls } from './hls';
import { bodyKey, firstPlaybackRequest, type InfoBody, type PlaybackDto } from './infobody';
import { markPlayArt } from './transition';

/** true when this browser plays HLS itself (Safari/iOS): hls.js is never needed there */
const nativeHls = () => typeof document !== 'undefined' && document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';
let codeDone = false, hlsDone = false;

/**
 * Warm up the player before the click (hover/focus/touchstart of a play button): the /watch route code and, where
 * the browser needs it, hls.js. Cheap to call repeatedly; failures are ignored (the real navigation loads it again).
 * Play links use the `playPrefetch` action below, which also starts the playback info.
 */
export function prefetchPlayer(): void {
  if (typeof window === 'undefined') return;
  if (!codeDone) { codeDone = true; preloadCode('/watch/[id]').catch(() => { codeDone = false; }); }
  if (!hlsDone && !nativeHls()) { hlsDone = true; loadHls().catch(() => { hlsDone = false; }); }
  void warmDeviceCaps(); // the decode probe (once per page load, cached per device) answers before the click in most cases
}

// ---- prefetched /api/playback/info: one entry, reused by the player for 30 s when its first request body is identical ----
export const PREFETCH_TTL_MS = 30_000;
/** hover must rest this long on a play control (sweeping the mouse across a row fires nothing) */
export const HOVER_DWELL_MS = 150;
/** `done`: taken by the player, or given back (release) */
interface Entry { itemId: string; key: string; profile: string | null; at: number; promise: Promise<PlaybackDto>; done?: boolean; ttl?: ReturnType<typeof setTimeout> }
const entries = new Map<string, Entry>();

/** the answer converts the picture on the server (backend convertsOf): it holds a slot of the shared conversion budget until it is used */
const converts = (info: PlaybackDto | null | undefined): info is PlaybackDto =>
  Boolean(info && info.playSessionId && !info.directUrl && info.delivery && info.delivery.video !== 'copy');
const stopWarm = (ps: string, keepalive: boolean) =>
  void api('/api/playback/warm/stop', { method: 'POST', body: { playSessionId: ps }, ...(keepalive ? { keepalive: true } : {}) }).catch(() => undefined);

/**
 * An unused prefetch (replaced, expired, the page goes away) whose answer converts gives its budget slot back at once: warm/stop releases
 * the grants of the caller's own play session (it never stops a stream that started playing). A copy or direct-play answer holds nothing.
 */
function release(e: Entry, keepalive = false): void {
  clearTimeout(e.ttl);
  if (e.done) return;
  e.done = true;
  void e.promise.then((info) => { if (converts(info)) stopWarm(info.playSessionId, keepalive); }, () => undefined);
}
function dropEntries(keepalive = false): void {
  for (const e of entries.values()) release(e, keepalive);
  entries.clear();
}
/** the player's stop report while it is on its way: the resume position it writes must be in before a new info is asked for */
let hold: Promise<void> | null = null;
/** a stop that never answers releases the hold after this long (prefetch must not stay off until a reload) */
export const HOLD_TIMEOUT_MS = 4000;

/**
 * Called by the player when it goes away: drops any cached answer and holds new prefetches until `p` (the stop report)
 * settles. Otherwise a prefetch fired by autofocus or a quick hover could read the last progress report (up to 10 s old)
 * and a Play within 30 s would resume too early. Prefetches asked for meanwhile start after it settles, at the latest
 * after HOLD_TIMEOUT_MS.
 */
export function holdPrefetch(p: Promise<unknown>): void {
  dropEntries();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((r) => { timer = setTimeout(r, HOLD_TIMEOUT_MS); });
  const settled = Promise.resolve(p).then(() => undefined, () => undefined);
  const h: Promise<void> = Promise.race([settled, timeout]).then(() => { clearTimeout(timer); if (hold === h) hold = null; });
  hold = h;
}

/**
 * Starts POST /api/playback/info for `itemId` with the body the player will send first (saved quality or the rung for the
 * remembered bandwidth, reason hint, preferred audio). The route starts no stream (no stream slot, no live session, no transcode:
 * that starts with the stream URL), but an answer that converts takes a slot of the shared conversion budget for up to 30 s. So an
 * unused prefetch that converts is given back (release: replaced, expired, page hidden), and the server replaces a device's earlier
 * unused grant with its new one, so a browsing device never holds more than one slot. At most one item is kept: a new one replaces
 * the old entry. Errors (429 max_streams, 503 server_busy, network) drop the entry; the player then asks itself.
 * Servers whose playback info starts the transcode (capability playbackPrefetch=false, e.g. Plex) are never prefetched: every
 * hover would start a stream and take a stream slot.
 */
export function prefetchPlayback(itemId: string, o: { audio?: string; startSec?: number } = {}, waited = false): void {
  if (typeof window === 'undefined' || !itemId || !get(serverCaps).playbackPrefetch) return;
  if (hold) { const h = hold; void h.then(() => { if (!hold) prefetchPlayback(itemId, o, waited); }); return; } // never before the stop settled
  // the decode probe still runs: wait for it (bounded, as the player does) so both bodies carry the same capability block
  // (once, like the player: a probe slower than the bound is not waited for again)
  const w = waited ? null : capsPending();
  if (w) { void w.then(() => prefetchPlayback(itemId, o, true)); return; }
  const { body } = firstPlaybackRequest(itemId, get(prefs), o.audio ?? '', o.startSec);
  const key = bodyKey(body), profile = getActiveProfile(), now = Date.now();
  const cur = entries.get(itemId);
  if (cur && cur.key === key && cur.profile === profile && now - cur.at < PREFETCH_TTL_MS) return; // already on its way
  dropEntries();
  hookHide();
  const e: Entry = { itemId, key, profile, at: now, promise: api<PlaybackDto>('/api/playback/info', { method: 'POST', body }) };
  e.promise.catch(() => { if (entries.get(itemId) === e) entries.delete(itemId); });
  e.ttl = setTimeout(() => { if (entries.get(itemId) === e) entries.delete(itemId); release(e); }, PREFETCH_TTL_MS);
  entries.set(itemId, e);
}

/** the prefetched answer for exactly this request body, once; null when there is none, it is older than 30 s or the body differs */
export function takePrefetched(itemId: string, body: object): Promise<PlaybackDto> | null {
  const e = entries.get(itemId);
  if (!e) return null;
  entries.delete(itemId);
  if (Date.now() - e.at >= PREFETCH_TTL_MS || e.profile !== getActiveProfile() || e.key !== bodyKey(body)) { release(e); return null; }
  clearTimeout(e.ttl);
  e.done = true; // the player plays it: never given back
  return e.promise;
}

// ---- the next episode, prepared during the autoplay countdown (watch page -> Player prop prepNext) ----
/**
 * Once the autoplay countdown runs, the next episode's playback info is asked for (the same body its player sends first) and, where
 * the stream will be converted and starts at the beginning, its transcoder is warmed: master playlist, variant playlist and the headers
 * of the first segment, so Jellyfin has the first segments ready when the player asks for exactly this play session. Rules:
 * - Jellyfin only (serverCaps.playbackPrefetch; Plex starts a transcode with every playback info), one entry at a time;
 * - a 429 at the stream limit simply drops it (the info route counts no stream; the warm takes no stream slot either);
 * - released (countdown stopped, player gone) -> stopped after WARM_GRACE_MS unless the next player took it in time; never taken ->
 *   stopped PREFETCH_TTL_MS after it began. A stop aborts the requests and asks the server to end the warmed transcode
 *   (POST /api/playback/warm/stop), so a second transcode never runs longer than that. An answer that converts was not warmed is
 *   given back the same way (its conversion budget slot, prefetchPlayback).
 */
export const WARM_GRACE_MS = 8_000;
/** a resume point beyond this (ticks) starts elsewhere: warming segment 0 would be wasted */
export const WARM_MAX_RESUME_TICKS = 10 * 10_000_000;
interface Next {
  itemId: string; key: string; profile: string | null; at: number; promise: Promise<PlaybackDto>; ac: AbortController;
  /** play session of the answer; `sent` = a segment request went out (the transcoder may run) */
  ps?: string; sent: boolean; taken: boolean; ttl?: ReturnType<typeof setTimeout>; grace?: ReturnType<typeof setTimeout>;
  /** the answer converts: it holds a conversion budget slot, given back on a stop even without a warm-up */
  conv?: boolean;
}
let next: Next | null = null;

/** the comparison key of a next-episode body: the bitrate the network picked may move a rung meanwhile and is not compared */
const nextKey = (b: InfoBody) => bodyKey({ ...b, maxBitrate: b.reasonHint === 'network' ? undefined : b.maxBitrate });

/** the first URI line of a playlist, resolved against `base`; null when it leaves this origin */
function firstUri(text: string, base: URL): URL | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!line) return null;
  const u = new URL(line, base);
  return u.origin === base.origin ? u : null;
}

async function warm(n: Next, hlsUrl: string): Promise<void> {
  const get = (u: URL) => fetch(u, { credentials: 'same-origin', signal: n.ac.signal });
  const master = new URL(hlsUrl, location.origin);
  if (master.origin !== location.origin) return;
  const variant = firstUri(await (await get(master)).text(), master);
  if (!variant || n.taken) return;
  const seg = firstUri(await (await get(variant)).text(), variant);
  if (!seg || n.taken) return;
  n.sent = true;
  const res = await get(seg);
  await res.body?.cancel().catch(() => undefined); // the headers mean the segment is there; the bytes are not needed now
}

/** `keepalive`: the page is going away (the request must outlive it; api() sends the csrf header, which sendBeacon cannot) */
function stopNext(n: Next, keepalive = false): void {
  clearTimeout(n.ttl); clearTimeout(n.grace);
  if (next === n) next = null;
  if (n.taken) return;
  n.ac.abort();
  if (n.ps) { if (n.sent || n.conv) stopWarm(n.ps, keepalive); return; }
  // the answer is still on its way: a conversion gives its slot back once it arrives
  void n.promise.then((info) => { if (converts(info)) stopWarm(info.playSessionId, keepalive); }, () => undefined);
}

/** the tab closes or navigates away hard: an unused warm-up is stopped now, not by the media server's idle kill; unused prefetches go too */
export function stopNextOnHide(): void {
  if (next) stopNext(next, true);
  dropEntries(true);
}
let hideHooked = false;
function hookHide(): void {
  if (!hideHooked && typeof window.addEventListener === 'function') { hideHooked = true; window.addEventListener('pagehide', stopNextOnHide); }
}

/** prepares (and with `warm`, pre-starts) the next episode; again for the same item and body only cancels a pending release */
export function prepareNext(itemId: string, body: InfoBody, o: { warm: boolean }): void {
  if (typeof window === 'undefined' || !itemId || !get(serverCaps).playbackPrefetch) return;
  const key = nextKey(body), profile = getActiveProfile();
  if (next && next.itemId === itemId && next.key === key && next.profile === profile) { clearTimeout(next.grace); return; }
  if (next) stopNext(next);
  hookHide();
  const n: Next = { itemId, key, profile, at: Date.now(), ac: new AbortController(), sent: false, taken: false, promise: api<PlaybackDto>('/api/playback/info', { method: 'POST', body }) };
  next = n;
  n.ttl = setTimeout(() => stopNext(n), PREFETCH_TTL_MS);
  n.promise.then((info) => {
    n.ps = info?.playSessionId;
    n.conv = converts(info);
    if (!o.warm || n.taken || next !== n || !info || info.directUrl || (info.resumeTicks ?? 0) > WARM_MAX_RESUME_TICKS || !info.hlsUrl) return;
    return warm(n, info.hlsUrl);
  }).catch(() => { if (!n.sent && next === n) { clearTimeout(n.ttl); next = null; } }); // failed info: nothing runs; a failed warm keeps the info
}

/** the countdown stopped or the player went away: stop the warm-up unless the next player takes it within WARM_GRACE_MS */
export function releaseNext(): void {
  const n = next;
  if (!n || n.taken) return;
  clearTimeout(n.grace);
  n.grace = setTimeout(() => stopNext(n), WARM_GRACE_MS);
}

/** the next episode's prepared answer for this item and body, once (the player then plays exactly the warmed play session); null otherwise */
export function takeNext(itemId: string, body: InfoBody): Promise<PlaybackDto> | null {
  const n = next;
  if (!n || n.itemId !== itemId || n.key !== nextKey(body) || n.profile !== getActiveProfile() || Date.now() - n.at >= PREFETCH_TTL_MS) return null;
  n.taken = true;
  clearTimeout(n.ttl); clearTimeout(n.grace);
  next = null;
  return n.promise;
}

/** `/watch/<id>?audio=..&t=..` -> what the player will ask for (null = not a player link) */
export function watchTarget(href: string | null | undefined): { id: string; audio?: string; startSec?: number } | null {
  if (!href || typeof location === 'undefined') return null;
  let u: URL;
  try { u = new URL(href, location.origin); } catch { return null; }
  const m = /^\/watch\/([^/]+)$/.exec(u.pathname);
  if (!m || u.origin !== location.origin) return null;
  return { id: decodeURIComponent(m[1]!), audio: u.searchParams.get('audio') ?? undefined, startSec: startSecond(u.searchParams.get('t')) };
}

/** the `t` of a player link in whole seconds: 0 = from the start (Restart), undefined = none / invalid (the player resumes) */
export function startSecond(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const t = Number(raw);
  return Number.isFinite(t) && t >= 0 && t < 86_400 ? Math.floor(t) : undefined;
}

/** the artwork that grows into the player poster: `[data-play-art]` inside the play control's `[data-play-scope]` */
const artFor = (node: HTMLElement) => node.closest('[data-play-scope]')?.querySelector<HTMLElement>('[data-play-art]') ?? null;

/**
 * Svelte action for play links (`<a href="/watch/..." use:playPrefetch>`): hover (after a 150 ms dwell), focus, touchstart
 * and pointerdown warm the player code and prefetch the playback info; the click marks the artwork for the view transition.
 */
export function playPrefetch(node: HTMLElement): { destroy(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const now = () => {
    clearTimeout(timer); prefetchPlayer();
    const t = watchTarget(node.getAttribute('href'));
    if (t) prefetchPlayback(t.id, t);
  };
  const enter = () => { prefetchPlayer(); clearTimeout(timer); timer = setTimeout(now, HOVER_DWELL_MS); };
  const leave = () => clearTimeout(timer);
  // a modified / middle click opens a tab or window: no navigation here, so no artwork for a transition
  const click = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 || e.defaultPrevented) return;
    if (watchTarget(node.getAttribute('href'))) markPlayArt(artFor(node));
  };
  const opts = { passive: true };
  node.addEventListener('pointerenter', enter);
  node.addEventListener('pointerleave', leave);
  node.addEventListener('focus', now);
  node.addEventListener('touchstart', now, opts);
  node.addEventListener('pointerdown', now);
  node.addEventListener('click', click);
  return {
    destroy() {
      clearTimeout(timer);
      node.removeEventListener('pointerenter', enter); node.removeEventListener('pointerleave', leave); node.removeEventListener('focus', now);
      node.removeEventListener('touchstart', now); node.removeEventListener('pointerdown', now); node.removeEventListener('click', click);
    },
  };
}

/** tests only */
export function _resetPrefetch(): void { for (const e of entries.values()) clearTimeout(e.ttl); entries.clear(); hold = null; if (next) { clearTimeout(next.ttl); clearTimeout(next.grace); } next = null; }
