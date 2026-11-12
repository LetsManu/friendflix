// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The web side of the narrow native bridge of the FriendFlix apps: the Android app (android/.../bridge/NativeBridge.kt has that end)
 * and the Windows app (desktop shell).
 *
 * In an app the shell injects `window.FriendFlixNative` (`postMessage(string)` + `message` events) and appends
 * ` FriendFlixAndroid/<version>` (Android) or ` FriendFlixDesktop/<version>` (Windows) to the user agent. Everywhere else `native.available` is false and nothing here runs: the
 * browser keeps using the web player and the OPFS downloader.
 *
 * Protocol (JSON strings, both directions):
 *   web -> app   {id, method, args}                  method: capabilities | play | download | downloads | deleteDownload | openSettings
 *                                                    | castState | castControl | sessionChanged (API 2, the app's own Chromecast session)
 *                                                    | castLive (a live channel on the TV; apps without it answer unknown_method = false)
 *   app -> web   {id, ok:true, result} | {id, ok:false, error}
 *   app -> web   {event, detail}                     unsolicited, no id (download progress ...); re-dispatched as the DOM event
 *                                                    'friendflix-native' with detail = the whole {event, detail} object
 * Every call resolves (never rejects, never hangs): after REQUEST_TIMEOUT_MS or on any error it resolves to its "no" value, which
 * callers treat as "do it the web way".
 */
import { writable } from 'svelte/store';

export const REQUEST_TIMEOUT_MS = 5000;
/** `castLive` waits for the app's device chooser (up to 40 s) and the channel's first segment (up to 15 s) before it gives up */
export const CAST_LIVE_TIMEOUT_MS = 60_000;
export const UA_MARKER = ' FriendFlixAndroid/';
/** every user agent marker that opts a shell into the bridge (the Android app first, then the Windows app) */
export const UA_MARKERS = [UA_MARKER, ' FriendFlixDesktop/'] as const;
export const EVENT_NAME = 'friendflix-native';

/** `castBar` (API 2): the app shows its own cast session through castState / castControl / the 'cast' event */
export interface NativeCapabilities { api: number; play: boolean; download: boolean; cast: boolean; castBar: boolean }
/** the app's running Chromecast session (no token, no URL); `next` = the queued next episode */
export interface NativeCastSnapshot {
  kind: 'chromecast'; device: string; itemId: string; title: string; subtitle?: string; posterId: string; isEpisode: boolean;
  positionMs: number; durationMs: number; paused: boolean; state: 'connecting' | 'playing' | 'ended'; next?: { itemId: string; label: string };
  /** a live channel (`castLive`): itemId / posterId = the channel id, title = its name, subtitle = the programme now; no duration */
  live?: true;
}
export type NativeCastAction = 'playPause' | 'next' | 'stop' | 'open';
export interface NativePlayRequest { itemId: string; profileId: string; startMs?: number; mediaSourceId?: string; audio?: string; subtitle?: string }
export interface NativeDownloadRequest { licenseId: string; itemId: string; profileId: string }
export type NativeDownloadState = 'queued' | 'preparing' | 'downloading' | 'paused' | 'done' | 'error' | 'expired';
/** why an app download stopped with state 'error' (codes of existing `account.downloads.msg.*` texts) */
export type NativeDownloadError = 'noSpace' | 'io' | 'prepFailed';
export interface NativeDownload {
  licenseId: string; itemId: string; state: NativeDownloadState; progress: number; bytes: number; expiresAt: number; error?: NativeDownloadError;
  /** the licence's title as the app stored it ('' until known) and the profile that started it ('' = unknown); both optional in the protocol */
  title?: string; profileId?: string;
}
const ERRORS = new Set<string>(['noSpace', 'io', 'prepFailed']);
export interface NativeEvent { event: string; detail: unknown }

interface Port {
  postMessage(msg: string): void;
  addEventListener?(type: 'message', l: (e: { data: unknown }) => void): void;
}
const port = (): Port | undefined => {
  const p = (globalThis as { window?: { FriendFlixNative?: Port } }).window?.FriendFlixNative;
  return p && typeof p.postMessage === 'function' ? p : undefined;
};
const hasMarker = () => {
  const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent ?? '') : '';
  return UA_MARKERS.some((m) => ua.includes(m));
};

const NO_CAPS: NativeCapabilities = { api: 0, play: false, download: false, cast: false, castBar: false };
const STATES = new Set<string>(['queued', 'preparing', 'downloading', 'paused', 'done', 'error', 'expired']);

const pending = new Map<string, (m: Reply) => void>();
const wired = new WeakSet<object>();
let seq = 0;

function wire(p: Port) {
  if (wired.has(p) || !p.addEventListener) return;
  wired.add(p);
  p.addEventListener('message', (e) => {
    let m: any;
    try { m = typeof e.data === 'string' ? JSON.parse(e.data) : null; } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (typeof m.id === 'string') {
      const done = pending.get(m.id);
      if (done) { pending.delete(m.id); done({ ok: m.ok === true, result: m.result }); }
    } else if (typeof m.event === 'string') {
      applyEvent(m);
      try { window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { event: m.event, detail: m.detail } })); } catch { /* ignore */ }
    }
  });
}

type Reply = { ok: boolean; result?: unknown; timeout?: boolean };
function request(method: string, args: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Reply> {
  const p = native.available ? port() : undefined;
  if (!p) return Promise.resolve({ ok: false });
  wire(p);
  return new Promise((resolve) => {
    const id = `r${++seq}`;
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, timeout: true }); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    try { p.postMessage(JSON.stringify({ id, method, args })); } catch { clearTimeout(timer); pending.delete(id); resolve({ ok: false }); }
  });
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CAST_STATES = new Set<string>(['connecting', 'playing', 'ended']);
/** the app's snapshot, checked field by field (a malformed one counts as "no cast") */
export function asCastSnapshot(x: unknown): NativeCastSnapshot | null {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || o.kind !== 'chromecast') return null;
  /** an over-long text is cut (with an ellipsis), not a reason to drop the whole snapshot */
  const cut = (v: unknown, max: number): string | null => (typeof v !== 'string' ? null : v.length <= max ? v : v.slice(0, max - 1) + '\u2026');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const device = cut(o.device, 200), title = cut(o.title, 500);
  if (device === null || title === null || typeof o.itemId !== 'string' || !ID.test(o.itemId) || typeof o.posterId !== 'string' || !ID.test(o.posterId)) return null;
  if (typeof o.state !== 'string' || !CAST_STATES.has(o.state)) return null;
  const n = o.next as Record<string, unknown> | undefined;
  const next = n && typeof n === 'object' && typeof n.itemId === 'string' && ID.test(n.itemId) && cut(n.label, 200) !== null ? { next: { itemId: n.itemId, label: cut(n.label, 200)! } } : {};
  const sub = cut(o.subtitle, 500), subtitle = sub ? { subtitle: sub } : {};
  const live = o.live === true ? { live: true as const } : {};
  return {
    kind: 'chromecast', device, itemId: o.itemId, title, posterId: o.posterId, isEpisode: o.isEpisode === true,
    positionMs: num(o.positionMs), durationMs: num(o.durationMs), paused: o.paused === true, state: o.state as NativeCastSnapshot['state'], ...subtitle, ...next, ...live,
  };
}

const asEntry = (x: unknown): NativeDownload | null => {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  if (typeof o.licenseId !== 'string' || typeof o.itemId !== 'string' || typeof o.state !== 'string' || !STATES.has(o.state)) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const error = typeof o.error === 'string' && ERRORS.has(o.error) ? { error: o.error as NativeDownloadError } : {};
  const title = typeof o.title === 'string' && o.title.length <= 500 ? { title: o.title } : {};
  const profileId = typeof o.profileId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(o.profileId) ? { profileId: o.profileId } : {};
  return { licenseId: o.licenseId, itemId: o.itemId, state: o.state as NativeDownloadState, progress: n(o.progress), bytes: n(o.bytes), expiresAt: n(o.expiresAt), ...error, ...title, ...profileId };
};

/** downloads the app holds, by licence id (kept current by `refreshNativeDownloads` and the app's events) */
export const nativeDownloads = writable<Map<string, NativeDownload>>(new Map());

/** the app's own cast session (null = none); kept current by `refreshNativeCast` (once on load) and the app's 'cast' events */
export const nativeCast = writable<NativeCastSnapshot | null>(null);
/** counts the app's cast events: a castState answer that was overtaken by an event is stale and dropped */
let castEvents = 0;

function applyEvent(m: { event: string; detail: unknown }) {
  if (m.event === 'download') {
    const e = asEntry(m.detail);
    if (e) nativeDownloads.update((s) => new Map(s).set(e.licenseId, e));
  } else if (m.event === 'cast') {
    castEvents++;
    nativeCast.set(asCastSnapshot(m.detail));
  } else if (m.event === 'downloadRemoved') {
    const id = (m.detail as { licenseId?: unknown } | null)?.licenseId;
    if (typeof id === 'string') nativeDownloads.update((s) => { const n = new Map(s); n.delete(id); return n; });
  }
}

export async function refreshNativeDownloads(): Promise<void> {
  if (!native.available) return;
  const list = await native.downloads();
  if (!list) return; // no answer: keep what we know
  nativeDownloads.set(new Map(list.map((d) => [d.licenseId, d])));
}

/** the app does not replay events to a loaded page: ask for the running cast once (when the bridge is ready) and follow the events after */
export async function refreshNativeCast(): Promise<void> {
  if (!native.available) return;
  const seen = castEvents;
  const r = await native.castState();
  if (r === undefined || seen !== castEvents) return; // no answer, or an event already told something newer
  nativeCast.set(r);
}

export const native = {
  /** running inside the FriendFlix Android app with the bridge present */
  get available(): boolean { return Boolean(port()) && hasMarker(); },

  async capabilities(): Promise<NativeCapabilities> {
    const r = await request('capabilities');
    const o = r.result as Record<string, unknown> | undefined;
    if (!r.ok || !o || typeof o !== 'object') return { ...NO_CAPS };
    return { api: typeof o.api === 'number' ? o.api : 0, play: o.play === true, download: o.download === true, cast: o.cast === true, castBar: o.castBar === true };
  },
  /** true = the native player took over; false = declined (play it in the page); 'timeout' = no answer in time (the app may still start it) */
  async play(req: NativePlayRequest): Promise<boolean | 'timeout'> {
    const r = await request('play', { ...req });
    return r.timeout ? 'timeout' : r.ok && r.result === true;
  },
  /** true = the app took over the (already created) licence; false = declined; 'timeout' = no answer (ask `downloads()` before deciding) */
  async download(req: NativeDownloadRequest): Promise<boolean | 'timeout'> {
    const r = await request('download', { ...req });
    return r.timeout ? 'timeout' : r.ok && r.result === true;
  },
  /** the app's downloads; null when the app did not answer (timeout / error), which is not the same as "holds nothing" */
  async downloads(): Promise<NativeDownload[] | null> {
    const r = await request('downloads');
    return r.ok && Array.isArray(r.result) ? r.result.map(asEntry).filter((e): e is NativeDownload => e !== null) : null;
  },
  async deleteDownload(licenseId: string): Promise<boolean> {
    const r = await request('deleteDownload', { licenseId });
    return r.ok && r.result === true;
  },
  /** the app's cast session; null = none runs; undefined = no answer (keep what is known) */
  async castState(): Promise<NativeCastSnapshot | null | undefined> {
    const r = await request('castState');
    return r.ok ? asCastSnapshot(r.result) : undefined;
  },
  /** false = refused (`next`: nothing queued; `open`: the cast has ended) or no answer */
  async castControl(action: NativeCastAction): Promise<boolean> {
    const r = await request('castControl', { action });
    return r.ok && r.result === true;
  },
  /** API 2: tells the app which profile is active now (null = signed out). Resolves when the app has answered (it replies after its stop report
   *  and token revoke went out, at most about 3 s) or after the request timeout; true = answered */
  async sessionChanged(profileId: string | null): Promise<boolean> {
    const r = await request('sessionChanged', { profileId });
    return r.ok && r.result === true;
  },
  /** a live channel on the TV through the app's own cast: the app asks the server for the stream itself (no token crosses the bridge)
   *  and opens its device chooser when no TV is connected. true = the channel plays on the TV; false = refused by the server, no TV
   *  picked, an app without castLive, or no answer within CAST_LIVE_TIMEOUT_MS */
  async castLive(channelId: string): Promise<boolean> {
    const r = await request('castLive', { channelId }, CAST_LIVE_TIMEOUT_MS);
    return r.ok && r.result === true;
  },
  openSettings(): void { void request('openSettings'); },
  /** subscribe to the app's events; returns the unsubscribe function */
  onEvent(cb: (e: NativeEvent) => void): () => void {
    const p = port();
    if (p) wire(p);
    const h = (ev: Event) => cb((ev as CustomEvent<NativeEvent>).detail);
    window.addEventListener(EVENT_NAME, h);
    return () => window.removeEventListener(EVENT_NAME, h);
  },
};
