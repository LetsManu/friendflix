// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { CAST_LIVE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, native, nativeCast, nativeDownloads, refreshNativeCast, refreshNativeDownloads } from './bridge';

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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); nativeDownloads.set(new Map()); nativeCast.set(null); });

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
    await expect(native.downloads()).resolves.toBeNull();
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
    await expect(native.capabilities()).resolves.toEqual({ api: 1, play: true, download: false, cast: false, castBar: false });
  });
  it('downloads keeps only well-formed entries', async () => {
    const good = { licenseId: 'L', itemId: 'i', state: 'done', progress: 1, bytes: 10, expiresAt: 5 };
    installFake(() => ({ ok: true, result: [good, { licenseId: 5 }, null, 'x'] }));
    await expect(native.downloads()).resolves.toEqual([good]);
  });
  it('keeps the title and a well-formed profile id of an entry', async () => {
    const base = { licenseId: 'L', itemId: 'i', state: 'done', progress: 1, bytes: 1, expiresAt: 1 };
    installFake(() => ({ ok: true, result: [{ ...base, title: 'Alpha', profileId: 'p-1' }, { ...base, licenseId: 'M', title: 5, profileId: '../x' }] }));
    const list = await native.downloads();
    expect(list?.[0]).toMatchObject({ title: 'Alpha', profileId: 'p-1' });
    expect(list?.[1] && ('title' in list[1] || 'profileId' in list[1])).toBe(false);
  });
  it('keeps a known error code of an entry and drops unknown ones', async () => {
    const base = { licenseId: 'L', itemId: 'i', state: 'error', progress: 0, bytes: 0, expiresAt: 0 };
    installFake(() => ({ ok: true, result: [{ ...base, error: 'noSpace' }, { ...base, licenseId: 'M', error: 'boom' }] }));
    const list = await native.downloads();
    expect(list?.[0]?.error).toBe('noSpace');
    expect(list?.[1] && 'error' in list[1]).toBe(false);
  });
  it('downloads() is null (not empty) when the app does not answer, and a refresh then keeps the store', async () => {
    installFake((req) => (req.method === 'downloads' ? { ok: false, error: 'internal' } : { ok: true, result: true }));
    await expect(native.downloads()).resolves.toBeNull();
    nativeDownloads.set(new Map([['L', { licenseId: 'L', itemId: 'i', state: 'done', progress: 1, bytes: 1, expiresAt: 1 }]]));
    await refreshNativeDownloads();
    expect(get(nativeDownloads).has('L')).toBe(true);
  });
  it('times out to the fallback so the UI never hangs', async () => {
    vi.useFakeTimers();
    installFake(() => undefined);
    const p = native.play({ itemId: 'a', profileId: 'p' });
    await vi.advanceTimersByTimeAsync(5001);
    await expect(p).resolves.toBe('timeout'); // distinct from a decline (false)
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

describe('desktop marker', () => {
  it('is available with the Windows app marker and the injected object', () => {
    installFake(() => ({ ok: true, result: true }));
    ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 FriendFlixDesktop/2.3.0');
    expect(native.available).toBe(true);
  });
  it('is unavailable with a near-miss marker', () => {
    installFake(() => ({ ok: true, result: true }));
    ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 FriendFlixDesk/2.3.0');
    expect(native.available).toBe(false);
  });
});

const SNAP = { kind: 'chromecast', device: 'Wohnzimmer-TV', itemId: 'ep4', title: 'Dunmoor', subtitle: 'The Lantern Road', posterId: 'ep4', isEpisode: true, positionMs: 61000, durationMs: 1800000, paused: false, state: 'playing', next: { itemId: 'ep5', label: 'E5 · Wrenfield Pier' } };

describe('the app cast session (API 2)', () => {
  it('capabilities carry castBar', async () => {
    installFake(() => ({ ok: true, result: { api: 2, play: true, download: true, cast: true, castBar: true } }));
    await expect(native.capabilities()).resolves.toMatchObject({ api: 2, castBar: true });
  });
  it('castState parses the snapshot, null = no cast, no answer = undefined', async () => {
    installFake(() => ({ ok: true, result: SNAP }));
    await expect(native.castState()).resolves.toEqual(SNAP);
    installFake(() => ({ ok: true, result: null }));
    await expect(native.castState()).resolves.toBeNull();
    installFake(() => ({ ok: false, error: 'internal' }));
    await expect(native.castState()).resolves.toBeUndefined();
  });
  it('a malformed snapshot counts as no cast', async () => {
    installFake(() => ({ ok: true, result: { ...SNAP, state: 'weird' } }));
    await expect(native.castState()).resolves.toBeNull();
    installFake(() => ({ ok: true, result: { ...SNAP, itemId: '../x' } }));
    await expect(native.castState()).resolves.toBeNull();
  });
  it('an over-long title, TV name, subtitle or label is cut, the snapshot is kept', async () => {
    const long = (n: number) => 'x'.repeat(n);
    installFake(() => ({ ok: true, result: { ...SNAP, title: long(600), device: long(300), subtitle: long(700), next: { itemId: 'ep5', label: long(250) } } }));
    const r = (await native.castState())!;
    expect(r.title).toHaveLength(500);
    expect(r.device).toHaveLength(200);
    expect(r.subtitle).toHaveLength(500);
    expect(r.next!.label).toHaveLength(200);
    expect(r.title.endsWith('\u2026')).toBe(true);
    expect(r.itemId).toBe('ep4');
  });
  it('castControl sends the action and answers the boolean', async () => {
    const { sent } = installFake((req) => ({ ok: true, result: req.args.action !== 'next' }));
    await expect(native.castControl('playPause')).resolves.toBe(true);
    await expect(native.castControl('next')).resolves.toBe(false);
    expect(sent.map((r) => [r.method, r.args])).toEqual([['castControl', { action: 'playPause' }], ['castControl', { action: 'next' }]]);
  });
  it('sessionChanged sends the profile id or null and waits for the answer', async () => {
    const { sent, push, fake } = installFake(() => undefined);
    let done = false;
    const p = native.sessionChanged(null).then((r) => { done = r; });
    await Promise.resolve();
    expect(sent[0]).toMatchObject({ method: 'sessionChanged', args: { profileId: null } });
    expect(done).toBe(false);
    push({ id: sent[0].id, ok: true, result: true });
    await p;
    expect(done).toBe(true);
    expect(fake.postMessage).toHaveBeenCalledTimes(1);
  });
  it('sessionChanged resolves false after the request timeout', async () => {
    vi.useFakeTimers();
    installFake(() => undefined);
    const p = native.sessionChanged('p2');
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBe(false);
  });
  it('the cast event fills the store; null detail empties it', async () => {
    const { push } = installFake(() => ({ ok: true, result: true }));
    await native.capabilities();
    push({ event: 'cast', detail: SNAP });
    expect(get(nativeCast)).toEqual(SNAP);
    push({ event: 'cast', detail: null });
    expect(get(nativeCast)).toBeNull();
  });
  it('refreshNativeCast pulls the running cast once', async () => {
    installFake((req) => ({ ok: true, result: req.method === 'castState' ? SNAP : true }));
    await refreshNativeCast();
    expect(get(nativeCast)).toEqual(SNAP);
  });
  it('refreshNativeCast keeps what it has without an answer, and drops an answer an event overtook', async () => {
    nativeCast.set(SNAP as never);
    installFake(() => ({ ok: false, error: 'internal' }));
    await refreshNativeCast();
    expect(get(nativeCast)).toEqual(SNAP);
    const { push, fake } = installFake(() => undefined);
    const p = refreshNativeCast();
    await Promise.resolve();
    const id = JSON.parse((fake.postMessage as any).mock.calls.at(-1)[0]).id;
    push({ event: 'cast', detail: null }); // newer than the stale answer
    push({ id, ok: true, result: SNAP });
    await p;
    expect(get(nativeCast)).toBeNull();
  });
  it('castLive sends the method and answers the boolean', async () => {
    const { sent } = installFake((req) => ({ ok: true, result: req.args.channelId === 'nordlicht-tv' }));
    await expect(native.castLive('nordlicht-tv')).resolves.toBe(true);
    await expect(native.castLive('hafenkanal')).resolves.toBe(false); // the server refused (live_full, max_streams, …)
    expect(sent.map((r) => [r.method, r.args])).toEqual([['castLive', { channelId: 'nordlicht-tv' }], ['castLive', { channelId: 'hafenkanal' }]]);
    installFake(() => ({ ok: false, error: 'bad_args' }));
    await expect(native.castLive('nordlicht-tv')).resolves.toBe(false);
    installFake(() => ({ ok: true, result: 'yes' }));
    await expect(native.castLive('nordlicht-tv')).resolves.toBe(false);
  });
  it('castLive waits for the TV pick and the first segment, then falls back to false', async () => {
    vi.useFakeTimers();
    const { sent, push } = installFake(() => undefined);
    let r: boolean | undefined;
    const p = native.castLive('nordlicht-tv').then((v) => { r = v; });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1000);
    expect(r).toBeUndefined(); // longer than the ordinary request timeout: the device chooser and the channel start take time
    push({ id: sent[0].id, ok: true, result: true });
    await p;
    expect(r).toBe(true);
    const late = native.castLive('hafenkanal');
    await vi.advanceTimersByTimeAsync(CAST_LIVE_TIMEOUT_MS);
    await expect(late).resolves.toBe(false);
  });
  it('castLive is false outside the app', async () => {
    await expect(native.castLive('nordlicht-tv')).resolves.toBe(false);
  });
  it('a live snapshot carries the live flag', async () => {
    installFake(() => ({ ok: true, result: { ...SNAP, itemId: 'nordlicht-tv', posterId: 'nordlicht-tv', title: 'Nordlicht TV', live: true } }));
    await expect(native.castState()).resolves.toMatchObject({ itemId: 'nordlicht-tv', title: 'Nordlicht TV', live: true });
    installFake(() => ({ ok: true, result: SNAP }));
    expect((await native.castState())!).not.toHaveProperty('live');
  });
  it('refreshNativeCast does nothing outside the app', async () => {
    ua('Mozilla/5.0 Chrome/120');
    await refreshNativeCast();
    expect(get(nativeCast)).toBeNull();
  });
});
