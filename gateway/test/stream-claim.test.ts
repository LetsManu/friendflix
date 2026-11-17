// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGateway } from '../src/gateway.js';
import { jellyfinUpstream } from '../src/upstream/jellyfin.js';
import { createPlexUpstream } from '../src/upstream/plex.js';

// Security audit G1: the stream limit is enforced where streams are served. Before a playlist, segment or stream of a play session is
// forwarded, the gateway asks the backend (/internal/stream, memoised briefly); a refusal answers 429 with the body the player knows.
const ID = 'd'.repeat(32);
const ID2 = 'e'.repeat(32);
const SECRET = 's3cret-s3cret-s3cret';

type Mode = 'ok' | 'max' | '404' | 'throw';
let mode: Mode = 'ok';
let claims: Array<{ sid: string; itemId: string; ps?: string }> = [];
let upstreamCalls = 0;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
  if (url.pathname === '/internal/authz') return json({ userId: 'u1', token: 'JF', deviceId: 'ff-u1', maxBitrate: 5_000_000, canDownload: true });
  if (url.pathname === '/internal/stream') {
    claims.push(JSON.parse(String(init?.body)));
    if (mode === 'throw') throw new TypeError('fetch failed');
    if (mode === '404') return json({ message: 'Route POST:/internal/stream not found' }, 404); // an older backend during an update
    return mode === 'max' ? json({ error: 'max_streams', max: 1 }, 429) : json({ ok: true });
  }
  upstreamCalls++;
  if (url.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXTINF:3,\nhls1/main/0.ts\n', { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  return new Response('seg', { status: 200, headers: { 'content-type': 'video/mp2t' } });
}) as typeof fetch;

let server: Server;
let base = '';
beforeAll(async () => {
  const g = createGateway({ upstream: jellyfinUpstream, upstreamUrl: 'http://jf.invalid:8096', backendUrl: 'http://be.invalid:3000', internalSecret: SECRET, fetchImpl: fakeFetch });
  server = g.server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { mode = 'ok'; claims = []; upstreamCalls = 0; });

let n = 0;
/** a fresh session per test: the gateway's memos are per session */
const session = () => `stream-claim-session-${String(++n).padStart(4, '0')}`;
const get = (path: string, sid: string) => fetch(`${base}${path}`, { headers: { cookie: `ff_sid=${sid}` } });

describe('gateway stream claims', () => {
  it('asks the backend before serving a stream request, once per play session and memo window', async () => {
    const sid = session();
    expect((await get(`/media/Videos/${ID}/master.m3u8?PlaySessionId=ps-g-0001&MediaSourceId=${ID}`, sid)).status).toBe(200);
    expect(claims).toEqual([{ sid, itemId: ID, ps: 'ps-g-0001' }]);
    for (const p of [`/media/Videos/${ID}/main.m3u8?playsessionid=ps-g-0001`, `/media/Videos/${ID}/hls1/main/0.ts?PlaySessionId=ps-g-0001`, `/media/Videos/${ID}/hls1/main/1.ts?PlaySessionId=ps-g-0001`]) {
      expect((await get(p, sid)).status).toBe(200);
    }
    expect(claims).toHaveLength(1); // memoised: seeking and the next segments cost no backend call
    // another play session or item is another claim; a request without a play session is claimed by its item
    await get(`/media/Videos/${ID2}/stream?static=true`, sid);
    expect(claims.at(-1)).toEqual({ sid, itemId: ID2 });
  });

  it('images, subtitles and trickplay are no stream', async () => {
    const sid = session();
    for (const p of [`/media/Items/${ID}/Images/Primary`, `/media/Videos/${ID}/${ID2}/Subtitles/2/0/Stream.vtt`, `/media/Videos/${ID}/Trickplay/320/0.jpg`]) {
      expect((await get(p, sid)).status).toBe(200);
    }
    expect(claims).toEqual([]);
  });

  it('a refused stream answers 429 with the max_streams body and never reaches the media server', async () => {
    mode = 'max';
    const r = await get(`/media/Videos/${ID}/master.m3u8?PlaySessionId=ps-g-0002`, session());
    expect(r.status).toBe(429);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ error: 'max_streams', max: 1 });
    expect(upstreamCalls).toBe(0);
  });

  it('a refusal is memoised only briefly; backend trouble answers 503 and is not memoised; an older backend (404) serves', async () => {
    const sid = session();
    mode = 'throw';
    expect((await get(`/media/Videos/${ID}/master.m3u8?PlaySessionId=ps-g-0003`, sid)).status).toBe(503);
    mode = 'ok';
    expect((await get(`/media/Videos/${ID}/master.m3u8?PlaySessionId=ps-g-0003`, sid)).status).toBe(200);
    expect(claims).toHaveLength(2);
    mode = '404';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await get(`/media/Videos/${ID}/master.m3u8?PlaySessionId=ps-g-0004`, sid)).status).toBe(200);
      expect((await get(`/media/Videos/${ID2}/master.m3u8?PlaySessionId=ps-g-0005`, sid)).status).toBe(200);
      // fail-open for an older backend, but said once (review 9), without any session or play session
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/\/internal\/stream/);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/stream-claim-session|ps-g-/);
    } finally {
      warn.mockRestore();
    }
    expect(upstreamCalls).toBe(3);
  });

  it('an unusable play session id is claimed by its item', async () => {
    const sid = session();
    await get(`/media/Videos/${ID}/master.m3u8?PlaySessionId=${'x'.repeat(80)}`, sid);
    await get(`/media/Videos/${ID}/master.m3u8?PlaySessionId=a%2Fb`, sid);
    expect(claims).toEqual([{ sid, itemId: ID }]);
  });
});

describe('Upstream.streamOf', () => {
  it('Jellyfin: playlists, segments and streams with their PlaySessionId', () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(jellyfinUpstream.streamOf!(`/Videos/${ID}/master.m3u8`, q('PlaySessionId=ps-1'))).toEqual({ itemId: ID, ps: 'ps-1' });
    expect(jellyfinUpstream.streamOf!(`/Videos/${ID.toUpperCase()}/hls1/main/7.mp4`, q('playSessionId=ps-2'))).toEqual({ itemId: ID, ps: 'ps-2' });
    expect(jellyfinUpstream.streamOf!(`/Videos/${ID}/stream.mkv`, q('static=true'))).toEqual({ itemId: ID, ps: null });
    expect(jellyfinUpstream.streamOf!(`/Items/${ID}/Images/Primary`, q(''))).toBeNull();
    expect(jellyfinUpstream.streamOf!(`/Videos/${ID}/Trickplay/320/0.jpg`, q(''))).toBeNull();
  });
  it('Plex: the HLS session of the path, direct streams by item', () => {
    const plex = createPlexUpstream({ token: () => 'plex-token-placeholder', secret: () => SECRET });
    const item = '9f1e0000000000000000000000000001';
    const sess = `${'1'.repeat(16)}-${'2'.repeat(24)}`;
    expect(plex.streamOf!(`/Videos/${item}/hls/${sess}/index.m3u8`, new URLSearchParams())).toEqual({ itemId: item, ps: sess });
    expect(plex.streamOf!(`/Videos/${item}/hls/${sess}/00001.ts`, new URLSearchParams())).toEqual({ itemId: item, ps: sess });
    expect(plex.streamOf!(`/Videos/${item}/stream`, new URLSearchParams('MediaSourceId=x'))).toEqual({ itemId: item, ps: null });
    expect(plex.streamOf!(`/Items/${item}/Images/Primary`, new URLSearchParams())).toBeNull();
  });
});
