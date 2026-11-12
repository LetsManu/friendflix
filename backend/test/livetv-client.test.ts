// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/ctx.js';
import { LivetvError, livetvCall, livetvHealth, livetvKey, livetvStream, signLivetv } from '../src/livetv/client.js';

// The backend side of the signed livetv API (livetv/src/protocol.ts): shared vectors, error codes, timeouts. No database: the
// client only needs the config and the fetch of the context.
const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/livetv-hmac.json', import.meta.url), 'utf8')) as {
  secret: string; key: string; cases: Array<{ method: string; path: string; body: string; ts: string; nonce: string; signature: string }>;
};
const SECRET = 'livetv-client-secret-0123456789';
const BASE = 'http://livetv:8090';

type Seen = { url: string; method: string; headers: Record<string, string>; body: string; redirect?: string };
function ctxWith(answer: (s: Seen, init: RequestInit) => Response | Promise<Response>): Ctx & { seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const s: Seen = { url: String(input), method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) }, body: typeof init.body === 'string' ? init.body : '', redirect: init.redirect };
    seen.push(s);
    return answer(s, init);
  }) as typeof fetch;
  return { cfg: { LIVETV_URL: BASE, INTERNAL_SECRET: SECRET }, fetchImpl, seen } as unknown as Ctx & { seen: Seen[] };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
/** what livetv/src/protocol.ts verify() recomputes */
function sigOk(s: Seen): boolean {
  const key = createHmac('sha256', SECRET).update('friendflix-livetv/v1').digest();
  const target = new URL(s.url);
  const canon = [s.method, target.pathname + target.search, s.headers['x-ff-livetv-ts'], s.headers['x-ff-livetv-nonce'], createHash('sha256').update(s.body).digest('hex')].join('\n');
  return s.headers['x-ff-livetv-signature'] === `v1=${createHmac('sha256', key).update(canon).digest('hex')}`
    && Math.abs(Date.now() - Number(s.headers['x-ff-livetv-ts'])) < 60_000 && /^[0-9a-f]{32}$/.test(s.headers['x-ff-livetv-nonce'] ?? '');
}
async function caught(p: Promise<unknown>): Promise<LivetvError> {
  try { await p; } catch (e) { return e as LivetvError; }
  throw new Error('expected a LivetvError');
}

describe('livetv signing', () => {
  it('matches the shared vectors (livetv/test/protocol.test.ts and server.test.ts use the same file)', () => {
    const k = livetvKey(vectors.secret);
    expect(k.toString('hex')).toBe(vectors.key);
    for (const c of vectors.cases) {
      expect(signLivetv(k, c.method, c.path, c.body, c.ts, c.nonce)).toEqual({ 'x-ff-livetv-ts': c.ts, 'x-ff-livetv-nonce': c.nonce, 'x-ff-livetv-signature': c.signature });
    }
  });

  it('a fresh nonce and the current time by default', () => {
    const k = livetvKey(SECRET);
    const a = signLivetv(k, 'GET', '/v1/system'), b = signLivetv(k, 'GET', '/v1/system');
    expect(a['x-ff-livetv-nonce']).toMatch(/^[0-9a-f]{32}$/);
    expect(a['x-ff-livetv-nonce']).not.toBe(b['x-ff-livetv-nonce']);
    expect(Math.abs(Number(a['x-ff-livetv-ts']) - Date.now())).toBeLessThan(5_000);
  });
});

describe('livetvCall', () => {
  it('signs method, path and the JSON body; answers the parsed JSON', async () => {
    const ctx = ctxWith(() => json({ streamKey: 'k', state: 'starting' }));
    const body = { channelId: 'ch-nordlicht-tv', input: { url: 'http://iptv.example.com/live/101.ts', kind: 'ts', allowLan: false } };
    expect(await livetvCall(ctx, 'POST', '/v1/streams', body)).toEqual({ streamKey: 'k', state: 'starting' });
    const s = ctx.seen[0]!;
    expect(s).toMatchObject({ url: `${BASE}/v1/streams`, method: 'POST', body: JSON.stringify(body), redirect: 'error' });
    expect(s.headers['content-type']).toBe('application/json');
    expect(sigOk(s)).toBe(true);
  });

  it('a GET carries no body and no content type; an empty answer (204) is undefined', async () => {
    const ctx = ctxWith((s) => (s.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ ok: true })));
    expect(await livetvCall(ctx, 'GET', '/v1/system')).toEqual({ ok: true });
    expect(ctx.seen[0]!.body).toBe('');
    expect(ctx.seen[0]!.headers['content-type']).toBeUndefined();
    expect(sigOk(ctx.seen[0]!)).toBe(true);
    expect(await livetvCall(ctx, 'DELETE', '/v1/streams/ch-1')).toBeUndefined();
    expect(sigOk(ctx.seen[1]!)).toBe(true);
  });

  it('409 { error: srt_ports_full } -> LivetvError(409, srt_ports_full)', async () => {
    const e = await caught(livetvCall(ctxWith(() => json({ error: 'srt_ports_full' }, 409)), 'PUT', '/v1/ingest', { feeds: [] }));
    expect(e).toBeInstanceOf(LivetvError);
    expect(e).toBeInstanceOf(Error);
    expect([e.status, e.code]).toEqual([409, 'srt_ports_full']);
    expect(e.message).toBe('livetv 409 srt_ports_full');
  });

  it('an error text that is not a code (a URL, too long, missing, not JSON) becomes livetv_error: nothing from livetv is echoed', async () => {
    for (const answer of [json({ error: 'http://iptv.example.com/x' }, 422), json({ error: 'a'.repeat(41) }, 400), json({}, 500), new Response('<html>', { status: 502 }), json({ error: 42 }, 400)]) {
      const e = await caught(livetvCall(ctxWith(() => answer), 'POST', '/v1/probe', { input: {} }));
      expect(e.code).toBe('livetv_error');
      expect(e.message).not.toContain('iptv.example.com');
    }
  });

  it('a 200 that is not JSON is invalid_answer', async () => {
    const e = await caught(livetvCall(ctxWith(() => new Response('nope', { status: 200 })), 'GET', '/v1/system'));
    expect([e.status, e.code]).toEqual([200, 'invalid_answer']);
  });

  it('network error and timeout -> LivetvError(null, unreachable)', async () => {
    const down = await caught(livetvCall(ctxWith(() => { throw new TypeError('fetch failed'); }), 'GET', '/v1/system'));
    expect([down.status, down.code]).toEqual([null, 'unreachable']);
    const slow = ctxWith((_s, init) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    const t = Date.now();
    const e = await caught(livetvCall(slow, 'GET', '/v1/system', undefined, { timeoutMs: 50 }));
    expect([e.status, e.code]).toEqual([null, 'unreachable']);
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  it('the default timeout is 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const ctx = ctxWith((_s, init) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
      let settled = false;
      const p = caught(livetvCall(ctx, 'GET', '/v1/system')).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const e = await p;
      expect([e.status, e.code]).toEqual([null, 'unreachable']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('signs the request target exactly as fetch sends it: encoded, dot segments resolved', async () => {
    const ctx = ctxWith(() => json({}));
    const cases: Array<[string, string]> = [
      ['/v1/streams/ch 1', '/v1/streams/ch%201'],
      ['/v1/streams/känal?q=a b', '/v1/streams/k%C3%A4nal?q=a%20b'],
      ['/v1/a/../system', '/v1/system'],
    ];
    for (const [given, sent] of cases) {
      await livetvCall(ctx, 'GET', given);
      const s = ctx.seen.at(-1)!;
      expect(s.url).toBe(`${BASE}${sent}`);
      expect(s.headers['x-ff-livetv-signature']).toBe(signLivetv(livetvKey(SECRET), 'GET', sent, '', s.headers['x-ff-livetv-ts'], s.headers['x-ff-livetv-nonce'])['x-ff-livetv-signature']);
      expect(sigOk(s)).toBe(true);
    }
  });

  it('a path that would leave livetv is refused before anything is sent', async () => {
    const ctx = ctxWith(() => json({}));
    for (const bad of ['//iptv.example.com/v1/system', 'http://iptv.example.com/v1/system', 'v1/system']) {
      const e = await caught(livetvCall(ctx, 'GET', bad));
      expect([e.status, e.code], bad).toEqual([null, 'invalid_path']);
    }
    expect(ctx.seen).toEqual([]);
  });

  it('a body that stops arriving counts as unreachable', async () => {
    const stalled = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a"')); c.error(new Error('reset')); } });
    const e = await caught(livetvCall(ctxWith(() => new Response(stalled, { status: 200 })), 'GET', '/v1/system'));
    expect(e.code).toBe('unreachable');
  });
});

describe('livetvStream', () => {
  it('a signed POST whose response is handed back unread (NDJSON, image bytes)', async () => {
    const ctx = ctxWith(() => new Response('{"t":"channel"}\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
    const r = await livetvStream(ctx, '/v1/fetch/xmltv', { url: 'http://iptv.example.com/guide.xml', allowLan: false }, { timeoutMs: 60_000 });
    expect(await r.text()).toBe('{"t":"channel"}\n');
    expect(ctx.seen[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/fetch/xmltv` });
    expect(sigOk(ctx.seen[0]!)).toBe(true);
  });

  it('errors and timeouts like livetvCall', async () => {
    const e = await caught(livetvStream(ctxWith(() => json({ error: 'address_refused' }, 422)), '/v1/fetch/logo', { url: 'x' }, { timeoutMs: 1_000 }));
    expect([e.status, e.code]).toEqual([422, 'address_refused']);
    const down = await caught(livetvStream(ctxWith(() => { throw new TypeError('fetch failed'); }), '/v1/fetch/logo', {}, { timeoutMs: 1_000 }));
    expect(down.code).toBe('unreachable');
  });
});

describe('livetvHealth', () => {
  it('unsigned GET /healthz: api, version, bootId', async () => {
    const ctx = ctxWith(() => json({ ok: true, api: 1, version: '3.4.0', bootId: '0123456789abcdef' }));
    expect(await livetvHealth(ctx)).toEqual({ api: 1, version: '3.4.0', bootId: '0123456789abcdef' });
    expect(ctx.seen[0]!.url).toBe(`${BASE}/healthz`);
    expect(ctx.seen[0]!.headers['x-ff-livetv-signature']).toBeUndefined();
  });

  it('a version that is not X.Y.Z is null; anything malformed or unreachable is null', async () => {
    expect(await livetvHealth(ctxWith(() => json({ ok: true, api: 2, version: '<b>', bootId: 'fedcba9876543210' })))).toEqual({ api: 2, version: null, bootId: 'fedcba9876543210' });
    for (const bad of [{ ok: false, api: 1, version: null, bootId: '0123456789abcdef' }, { ok: true, api: '1', bootId: '0123456789abcdef' }, { ok: true, api: 1, bootId: 'nope' }, { ok: true, api: 1.5, bootId: '0123456789abcdef' }, null]) {
      expect(await livetvHealth(ctxWith(() => json(bad))), JSON.stringify(bad)).toBeNull();
    }
    expect(await livetvHealth(ctxWith(() => json({ error: 'x' }, 503)))).toBeNull();
    expect(await livetvHealth(ctxWith(() => new Response('nope')))).toBeNull();
    expect(await livetvHealth(ctxWith(() => { throw new TypeError('fetch failed'); }))).toBeNull();
  });
});
