// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasKey } from '#lib/i18n';
import { lineText } from './syscheck';
import { classifyDrip, classifyHeaders, classifyUpload, PROBE_UPLOAD_PATH, runBrowserChecks, runUploadCheck, type BrowserDeps } from './syscheckBrowser';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const ORIGIN = 'https://friend.example.com';
const DOCS = 'setup.md#6-nginx-proxy-manager-portal-proxy-host';
const goodHeaders = (o: Record<string, string> = {}) => new Headers({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'strict-transport-security': 'max-age=63072000', ...o });

describe('classifiers', () => {
  it('drip: first bytes early → ok; only at the end → warning proxy_buffers_media; 404 → unknown probe_missing', () => {
    expect(classifyDrip(150, 1600, 200)).toMatchObject({ id: 'proxy.buffering', group: 'proxy', status: 'ok', runs: 'browser' });
    expect(classifyDrip(1580, 1600, 200)).toMatchObject({ status: 'warning', cause: 'proxy_buffers_media', fix: 'proxy_buffers_media', docs: DOCS });
    expect(classifyDrip(0, 0, 404)).toMatchObject({ status: 'unknown', cause: 'probe_missing' });
  });

  it('drip on a slow link: a late first byte that still came well before the last is no buffering; 429 is busy, a 5xx failed', () => {
    // the first KiB after 2.5 s (latency, a parallel upload), the second 1.5 s later: streamed
    expect(classifyDrip(2500, 4000, 200)).toMatchObject({ status: 'ok' });
    // the first byte with the last after a long wait: buffered
    expect(classifyDrip(3900, 4000, 200)).toMatchObject({ status: 'warning', cause: 'proxy_buffers_media' });
    // the gateway's fifth drip at once (another admin tab): try again later, not "probe missing"
    expect(classifyDrip(-1, 5, 429)).toMatchObject({ status: 'unknown', cause: 'probe_busy', fix: 'probe_busy' });
    expect(classifyDrip(-1, 5, 502)).toMatchObject({ status: 'unknown', cause: 'probe_failed' });
  });

  it('upload: probe ok → ok; 413 from the proxy → warning upload_limit_low; a network error → unknown', () => {
    expect(classifyUpload(200, { probe: 'ok', bytes: 2097152 }, false)).toMatchObject({ id: 'proxy.upload', status: 'ok', runs: 'browser' });
    expect(classifyUpload(413, null, false)).toMatchObject({ status: 'warning', cause: 'upload_limit_low', fix: 'upload_limit_low', docs: DOCS });
    expect(classifyUpload(0, null, true)).toMatchObject({ status: 'unknown', cause: 'probe_failed' });
    // an answer that is not the probe's (an older backend that has no probe: 404 not_found) is not a pass
    expect(classifyUpload(404, { error: 'not_found' }, false)).toMatchObject({ status: 'unknown', cause: 'probe_missing' });
    expect(classifyUpload(200, { started: true }, false)).toMatchObject({ status: 'unknown', cause: 'probe_missing' });
    expect(classifyUpload(429, { error: 'rate_limited' }, false)).toMatchObject({ status: 'unknown', cause: 'probe_busy' });
    expect(classifyUpload(500, null, false)).toMatchObject({ status: 'unknown', cause: 'probe_failed' });
  });

  it('headers: without HSTS on https → warning hsts_missing; without nosniff → warning headers_stripped; http needs no HSTS', () => {
    expect(classifyHeaders(goodHeaders(), true)).toMatchObject({ id: 'proxy.headers', status: 'ok' });
    const noHsts = goodHeaders(); noHsts.delete('strict-transport-security');
    expect(classifyHeaders(noHsts, true)).toMatchObject({ status: 'warning', cause: 'hsts_missing', fix: 'hsts_missing', docs: DOCS });
    expect(classifyHeaders(noHsts, false)).toMatchObject({ status: 'ok' });
    const stripped = goodHeaders(); stripped.delete('x-content-type-options');
    expect(classifyHeaders(stripped, true)).toMatchObject({ status: 'warning', cause: 'headers_stripped' });
  });

  it('every cause and fix the browser lines can show has a text', () => {
    const lines = [classifyDrip(1580, 1600, 200), classifyDrip(0, 0, 404), classifyDrip(-1, 0, 429), classifyUpload(413, null, false), classifyUpload(0, null, true), classifyUpload(404, null, false),
      classifyHeaders(new Headers(), true), classifyHeaders(goodHeaders({ 'strict-transport-security': '' }), true)];
    for (const l of lines) {
      expect(hasKey(`syscheck.cause.${l.cause}`), l.cause).toBe(true);
      expect(hasKey(`syscheck.fix.${l.fix}`), l.fix).toBe(true);
      expect(lineText(l).cause).not.toBe('');
    }
    expect(hasKey('syscheck.cause.ws_blocked') && hasKey('syscheck.fix.ws_blocked')).toBe(true);
  });

  it('the upload line names what it tests (2 MB, not the full limit) in its label, so a pass never reads as more', () => {
    expect(lineText(classifyUpload(200, { probe: 'ok', bytes: 2097152 }, false)).label).toMatch(/2 MB/);
  });
});

/** a fake browser: the drip answers 1 KiB, waits, 1 KiB; `/` its headers; the upload probe its JSON; the socket as told */
function fakeBrowser(o: { ws?: 'ok' | 'never' | 'refused' | 'app_close'; wsGet?: number; upload?: number; dripPauseMs?: number } = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  let clock = 0;
  const now = () => clock;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/media/probe/drip')) {
      const pause = o.dripPauseMs ?? 1500;
      return new Response(new ReadableStream({
        start(c) { clock += 20; c.enqueue(new Uint8Array(1024)); },
        async pull(c) { clock += pause; c.enqueue(new Uint8Array(1024)); c.close(); },
      }, { highWaterMark: 0 }), { status: 200 }); // pulled only when read: the pause is between the two reads
    }
    if (url.endsWith(PROBE_UPLOAD_PATH)) {
      const status = o.upload ?? 200;
      return status === 413
        ? new Response('<html><body>413 Request Entity Too Large</body></html>', { status, headers: { 'content-type': 'text/html' } })
        : Response.json({ probe: 'ok', bytes: 2 * 1024 * 1024 }, { status });
    }
    if (url === `${ORIGIN}/`) return new Response('<!doctype html>', { status: 200, headers: goodHeaders() });
    // a plain GET of the websocket path: the backend's 404 (no upgrade), or the rate limit's 429 that refused the upgrade too
    if (url === `${ORIGIN}/ws/syscheck`) return new Response(null, { status: o.wsGet ?? 404 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      calls.push({ url, method: 'WS' });
      const mode = o.ws ?? 'ok';
      if (mode === 'never') return;
      queueMicrotask(() => {
        if (mode === 'refused') { this.onerror?.(); this.onclose?.({ code: 1006 }); return; }
        this.onopen?.();
        if (mode === 'app_close') { this.onclose?.({ code: 4401 }); return; }
        this.onmessage?.({ data: '{"ok":true}' });
        this.onclose?.({ code: 1000 });
      });
    }
    close() { /* nothing to release */ }
  }
  const deps: BrowserDeps = { fetch: fetchFn, WebSocket: FakeSocket as unknown as typeof WebSocket, now };
  vi.stubGlobal('fetch', fetchFn); // the upload goes through api(), which uses the global fetch
  return { deps, calls };
}

describe('runBrowserChecks', () => {
  it('a healthy proxy: four browser lines, all ok, in catalogue order; the upload is a 2 MiB PUT of the probe id', async () => {
    const { deps, calls } = fakeBrowser();
    const lines = await runBrowserChecks({ livetvInstalled: true, origin: ORIGIN, deps });
    expect(lines.map((l) => [l.id, l.status, l.runs])).toEqual([
      ['proxy.websocket', 'ok', 'browser'], ['proxy.buffering', 'ok', 'browser'], ['proxy.upload', 'ok', 'browser'], ['proxy.headers', 'ok', 'browser'],
    ]);
    expect(calls).toContainEqual({ url: 'wss://friend.example.com/ws/syscheck', method: 'WS' });
    expect(calls).toContainEqual({ url: PROBE_UPLOAD_PATH, method: 'PUT' });
  });

  it('livetv not installed → proxy.upload not_set_up and no PUT sent', async () => {
    const { deps, calls } = fakeBrowser();
    const lines = await runBrowserChecks({ livetvInstalled: false, origin: ORIGIN, deps });
    expect(lines.find((l) => l.id === 'proxy.upload')).toMatchObject({ status: 'not_set_up', cause: 'upload_livetv_off' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('a proxy that buffers /media/ and answers 413 to the upload → two warnings', async () => {
    const { deps } = fakeBrowser({ upload: 413, dripPauseMs: 1500 });
    // a buffering proxy: the first bytes only come with the last
    const buffered: BrowserDeps = { ...deps, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = await deps.fetch(input, init);
      if (!String(input).endsWith('/media/probe/drip')) return r;
      const all = new Uint8Array(await r.arrayBuffer());
      return new Response(all, { status: 200 });
    }) as typeof fetch };
    const lines = await runBrowserChecks({ livetvInstalled: true, origin: ORIGIN, deps: buffered });
    expect(lines.find((l) => l.id === 'proxy.buffering')).toMatchObject({ status: 'warning', cause: 'proxy_buffers_media' });
    expect(lines.find((l) => l.id === 'proxy.upload')).toMatchObject({ status: 'warning', cause: 'upload_limit_low' });
  });

  it('a websocket the backend closes with its own code still reached it → ok; a refused upgrade → problem ws_blocked', async () => {
    expect((await runBrowserChecks({ livetvInstalled: false, origin: ORIGIN, deps: fakeBrowser({ ws: 'app_close' }).deps }))[0]).toMatchObject({ status: 'ok' });
    expect((await runBrowserChecks({ livetvInstalled: false, origin: ORIGIN, deps: fakeBrowser({ ws: 'refused' }).deps }))[0])
      .toMatchObject({ status: 'problem', cause: 'ws_blocked', fix: 'ws_blocked', docs: DOCS });
  });

  it('an upgrade refused by the probe\'s rate limit (429 on a plain GET) is "later", never a red ws_blocked', async () => {
    const { deps, calls } = fakeBrowser({ ws: 'refused', wsGet: 429 });
    expect((await runBrowserChecks({ livetvInstalled: false, origin: ORIGIN, deps }))[0])
      .toMatchObject({ id: 'proxy.websocket', status: 'unknown', cause: 'probe_busy', fix: 'probe_busy' });
    expect(calls).toContainEqual({ url: `${ORIGIN}/ws/syscheck`, method: 'GET' });
    // a healthy upgrade asks nothing more
    const ok = fakeBrowser();
    await runBrowserChecks({ livetvInstalled: false, origin: ORIGIN, deps: ok.deps });
    expect(ok.calls.filter((c) => c.url.endsWith('/ws/syscheck') && c.method === 'GET')).toEqual([]);
  });

  it('runUploadCheck alone: Live TV installed → the probe; not installed → not_set_up without a PUT; not known → nothing', async () => {
    const { calls } = fakeBrowser();
    expect(await runUploadCheck(true)).toMatchObject({ id: 'proxy.upload', status: 'ok' });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(await runUploadCheck(false)).toMatchObject({ status: 'not_set_up', cause: 'upload_livetv_off' });
    expect(await runUploadCheck(null)).toBeNull();
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('ws that never opens → problem ws_blocked within 6 s (fake timers)', async () => {
    vi.useFakeTimers();
    const { deps } = fakeBrowser({ ws: 'never' });
    let done: Awaited<ReturnType<typeof runBrowserChecks>> | null = null;
    void runBrowserChecks({ livetvInstalled: false, origin: ORIGIN, deps }).then((l) => { done = l; });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(done).not.toBeNull();
    expect(done!.find((l) => l.id === 'proxy.websocket')).toMatchObject({ status: 'problem', cause: 'ws_blocked' });
  });

  it('a check that hangs past its own 6 s limit is unknown check_timeout; the others are filled', async () => {
    vi.useFakeTimers();
    const { deps } = fakeBrowser();
    const hung: BrowserDeps = { ...deps, fetch: ((input: RequestInfo | URL, init?: RequestInit) => (String(input).endsWith('/') ? new Promise<Response>(() => undefined) : deps.fetch(input, init))) as typeof fetch };
    let done: Awaited<ReturnType<typeof runBrowserChecks>> | null = null;
    void runBrowserChecks({ livetvInstalled: false, origin: ORIGIN, deps: hung }).then((l) => { done = l; });
    await vi.advanceTimersByTimeAsync(6_100);
    expect(done!.find((l) => l.id === 'proxy.headers')).toMatchObject({ status: 'unknown', cause: 'check_timeout' });
    expect(done!.find((l) => l.id === 'proxy.websocket')).toMatchObject({ status: 'ok' });
  });
});
