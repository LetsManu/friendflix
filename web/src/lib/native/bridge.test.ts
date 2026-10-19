// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { native, nativeDownloads, refreshNativeDownloads } from './bridge';

type Listener = (e: { data: string }) => void;
/** a fake of what the app injects: postMessage(string) in, 'message' events (data = JSON string) out */
function installFake(respond: (req: any) => unknown | undefined) {
  const listeners = new Set<Listener>();
  const sent: any[] = [];
  const fake = {
    postMessage: vi.fn((s: string) => {
      const req = JSON.parse(s);
      sent.push(req);
      const out = respond(req);
      if (out !== undefined) queueMicrotask(() => listeners.forEach((l) => l({ data: JSON.stringify({ id: req.id, ...(out as object) }) })));
    }),
    addEventListener: (_t: string, l: Listener) => listeners.add(l),
    removeEventListener: (_t: string, l: Listener) => listeners.delete(l),
  };
  win.FriendFlixNative = fake;
  return { sent, push: (o: unknown) => listeners.forEach((l) => l({ data: JSON.stringify(o) })), fake };
}
// vitest runs in node here: window is a plain EventTarget (it carries the injected object and receives the re-dispatched events)
let win: EventTarget & Record<string, any>;
const ua = (s: string) => vi.stubGlobal('navigator', { userAgent: s });
const APP_UA = 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36 FriendFlixAndroid/2.0.0';

beforeEach(() => { win = new EventTarget() as typeof win; vi.stubGlobal('window', win); ua(APP_UA); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); nativeDownloads.set(new Map()); });

describe('native bridge', () => {
  it('is unavailable without the injected object', () => {
    expect(native.available).toBe(false);
  });
  it('is unavailable with the object but a foreign user agent', () => {
    installFake(() => ({ ok: true, result: true }));
    ua('Mozilla/5.0 Chrome/120');
    expect(native.available).toBe(false);
  });
  it('is unavailable when the UA fits but postMessage is missing', () => {
    win.FriendFlixNative = {};
    expect(native.available).toBe(false);
  });
  it('is available with object and UA suffix', () => {
    installFake(() => ({ ok: true, result: true }));
    expect(native.available).toBe(true);
  });

  it('play sends the request message and resolves with the boolean result', async () => {
    const { sent } = installFake(() => ({ ok: true, result: true }));
    await expect(native.play({ itemId: 'a-1', profileId: 'p-1', startMs: 5000 })).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'play', args: { itemId: 'a-1', profileId: 'p-1', startMs: 5000 } });
    expect(typeof sent[0].id).toBe('string');
    expect(Object.keys(sent[0]).sort()).toEqual(['args', 'id', 'method']);
  });
  it('play resolves false for ok:false and for a false result', async () => {
    installFake(() => ({ ok: false, error: 'bad_args' }));
    await expect(native.play({ itemId: 'a', profileId: 'p' })).resolves.toBe(false);
    delete win.FriendFlixNative;
    installFake(() => ({ ok: true, result: false }));
    await expect(native.play({ itemId: 'a', profileId: 'p' })).resolves.toBe(false);
  });
  it('without the bridge every call resolves to its fallback', async () => {
    await expect(native.play({ itemId: 'a', profileId: 'p' })).resolves.toBe(false);
    await expect(native.download({ licenseId: 'l', itemId: 'a', profileId: 'p' })).resolves.toBe(false);
    await expect(native.downloads()).resolves.toEqual([]);
    await expect(native.deleteDownload('l')).resolves.toBe(false);
    await expect(native.capabilities()).resolves.toMatchObject({ play: false, download: false });
    expect(() => native.openSettings()).not.toThrow();
  });
  it('download and deleteDownload message shapes', async () => {
    const { sent } = installFake(() => ({ ok: true, result: true }));
    await native.download({ licenseId: 'L-1', itemId: 'i-1', profileId: 'p-1' });
    await native.deleteDownload('L-1');
    expect(sent[0]).toMatchObject({ method: 'download', args: { licenseId: 'L-1', itemId: 'i-1', profileId: 'p-1' } });
    expect(sent[1]).toMatchObject({ method: 'deleteDownload', args: { licenseId: 'L-1' } });
  });
  it('openSettings fires and forgets', () => {
    const { sent } = installFake(() => undefined);
    native.openSettings();
    expect(sent[0]).toMatchObject({ method: 'openSettings', args: {} });
  });
  it('capabilities are parsed leniently', async () => {
    installFake(() => ({ ok: true, result: { api: 1, play: true, download: 'yes', cast: false } }));
    await expect(native.capabilities()).resolves.toEqual({ api: 1, play: true, download: false, cast: false });
  });
  it('downloads keeps only well-formed entries', async () => {
    const good = { licenseId: 'L', itemId: 'i', state: 'done', progress: 1, bytes: 10, expiresAt: 5 };
    installFake(() => ({ ok: true, result: [good, { licenseId: 5 }, null, 'x'] }));
    await expect(native.downloads()).resolves.toEqual([good]);
  });
  it('times out to the fallback so the UI never hangs', async () => {
    vi.useFakeTimers();
    installFake(() => undefined);
    const p = native.play({ itemId: 'a', profileId: 'p' });
    await vi.advanceTimersByTimeAsync(5001);
    await expect(p).resolves.toBe(false);
  });
  it('concurrent requests are matched by id', async () => {
    const fn = (req: any) => ({ ok: true, result: req.method === 'download' });
    installFake(fn);
    const [a, b] = await Promise.all([native.play({ itemId: 'a', profileId: 'p' }), native.download({ licenseId: 'l', itemId: 'a', profileId: 'p' })]);
    expect([a, b]).toEqual([false, true]);
  });
  it('ignores malformed messages', async () => {
    const { push } = installFake(() => ({ ok: true, result: true }));
    await native.capabilities();
    expect(() => { push('nonsense'); push(null); push({ id: 42 }); }).not.toThrow();
  });

  it('events: re-dispatched as friendflix-native and delivered to onEvent', async () => {
    const { push } = installFake(() => ({ ok: true, result: true }));
    await native.capabilities(); // wires the listener
    const got: unknown[] = [];
    const off = native.onEvent((d) => got.push(d));
    const dom = vi.fn();
    win.addEventListener('friendflix-native', dom);
    push({ event: 'download', detail: { licenseId: 'L', state: 'done' } });
    expect(got).toEqual([{ event: 'download', detail: { licenseId: 'L', state: 'done' } }]);
    expect((dom.mock.calls[0][0] as CustomEvent).detail).toEqual({ event: 'download', detail: { licenseId: 'L', state: 'done' } });
    off();
    push({ event: 'download', detail: {} });
    expect(got).toHaveLength(1);
    win.removeEventListener('friendflix-native', dom);
  });

  it('the downloads store follows refresh and events', async () => {
    const entry = { licenseId: 'L', itemId: 'i', state: 'downloading', progress: 0.5, bytes: 5, expiresAt: 9 };
    const { push } = installFake((req) => (req.method === 'downloads' ? { ok: true, result: [entry] } : { ok: true, result: true }));
    await refreshNativeDownloads();
    expect(get(nativeDownloads).get('L')).toEqual(entry);
    push({ event: 'download', detail: { ...entry, state: 'done', progress: 1 } });
    expect(get(nativeDownloads).get('L')?.state).toBe('done');
    push({ event: 'downloadRemoved', detail: { licenseId: 'L' } });
    expect(get(nativeDownloads).has('L')).toBe(false);
  });
});
