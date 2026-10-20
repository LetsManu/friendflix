// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The web side of the FriendFlix Android app's narrow native bridge (android/.../bridge/NativeBridge.kt has the other end).
 *
 * In the app the shell injects `window.FriendFlixNative` (a WebMessageListener object: `postMessage(string)` + `message` events) and
 * appends ` FriendFlixAndroid/<version>` to the user agent. Everywhere else `native.available` is false and nothing here runs: the
 * browser keeps using the web player and the OPFS downloader.
 *
 * Protocol (JSON strings, both directions):
 *   web -> app   {id, method, args}                  method: capabilities | play | download | downloads | deleteDownload | openSettings
 *   app -> web   {id, ok:true, result} | {id, ok:false, error}
 *   app -> web   {event, detail}                     unsolicited, no id (download progress ...); re-dispatched as the DOM event
 *                                                    'friendflix-native' with detail = the whole {event, detail} object
 * Every call resolves (never rejects, never hangs): after REQUEST_TIMEOUT_MS or on any error it resolves to its "no" value, which
 * callers treat as "do it the web way".
 */
import { writable } from 'svelte/store';

export const REQUEST_TIMEOUT_MS = 5000;
export const UA_MARKER = ' FriendFlixAndroid/';
export const EVENT_NAME = 'friendflix-native';

export interface NativeCapabilities { api: number; play: boolean; download: boolean; cast: boolean }
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
const hasMarker = () => (typeof navigator !== 'undefined' ? String(navigator.userAgent ?? '') : '').includes(UA_MARKER);

const NO_CAPS: NativeCapabilities = { api: 0, play: false, download: false, cast: false };
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
function request(method: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const p = native.available ? port() : undefined;
  if (!p) return Promise.resolve({ ok: false });
  wire(p);
  return new Promise((resolve) => {
    const id = `r${++seq}`;
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, timeout: true }); }, REQUEST_TIMEOUT_MS);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    try { p.postMessage(JSON.stringify({ id, method, args })); } catch { clearTimeout(timer); pending.delete(id); resolve({ ok: false }); }
  });
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

function applyEvent(m: { event: string; detail: unknown }) {
  if (m.event === 'download') {
    const e = asEntry(m.detail);
    if (e) nativeDownloads.update((s) => new Map(s).set(e.licenseId, e));
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

export const native = {
  /** running inside the FriendFlix Android app with the bridge present */
  get available(): boolean { return Boolean(port()) && hasMarker(); },

  async capabilities(): Promise<NativeCapabilities> {
    const r = await request('capabilities');
    const o = r.result as Record<string, unknown> | undefined;
    if (!r.ok || !o || typeof o !== 'object') return { ...NO_CAPS };
    return { api: typeof o.api === 'number' ? o.api : 0, play: o.play === true, download: o.download === true, cast: o.cast === true };
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
