// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import http from 'node:http';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayCache, sign } from '../src/protocol.js';
import { fileRoutes } from '../src/routes/files.js';
import { streamRoutes } from '../src/routes/streams.js';
import { createApp, start } from '../src/server.js';
import { IDLE_STOP_MS, Streams, type Driver, type StartBody } from '../src/streams.js';
import type { SystemView } from '../src/system.js';
import { deriveKey, flush, keyFile, memoryStore } from './streams-helpers.js';

const key = deriveKey('streams-api-test-secret-0123');
const NOW = Date.parse('2026-11-11T19:20:00.000Z');
const TS = Buffer.alloc(376, 0x47);

/** a driver that writes one segment and then waits for its stop */
let runs = 0;
const oneSegment: Driver = async (ctx) => {
  runs++;
  ctx.window({ ext: 'ts' });
  const bytes = await ctx.store.write(join(ctx.dir, 'a.ts'), TS);
  await ctx.segment({ file: 'a.ts', duration: 4, bytes });
  await ctx.sleep(Number.MAX_SAFE_INTEGER);
};

const startBody = (over: Partial<StartBody> = {}): StartBody => ({
  channelId: 'ch-nordlicht', input: { url: 'http://iptv.example.com/live/anna/geheim/101.m3u8', kind: 'hls', allowLan: false },
  mode: 'passthrough', encoder: 'libx264', dvrSeconds: 1800, maxBitrate: 10_000_000, ...over,
});

describe('the streams API', () => {
  let root = '';
  let streams: Streams;
  let api: http.Server, base = '';
  const logs: string[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ltv-streams-'));
    streams = new Streams({ root, maxBytes: 1024 ** 3, drivers: { passthrough: oneSegment }, log: (m) => logs.push(m) });
    const app = createApp({
      verifier: { key, cache: new ReplayCache(), notBefore: Date.now() - 1000 }, version: null, bootId: '0123456789abcdef',
      system: async () => ({}) as SystemView, routes: [...streamRoutes(streams), ...fileRoutes(streams)], warn: (m) => logs.push(m),
    });
    api = http.createServer((req, res) => { void app(req, res); });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await streams.close();
    await new Promise<void>((r) => { api.closeAllConnections(); api.close(() => r()); });
    await rm(root, { recursive: true, force: true });
  });
  afterEach(async () => {
    for (const v of streams.list()) await streams.stop(v.channelId);
    runs = 0;
  });

  const call = (method: string, path: string, body?: unknown) => {
    const s = body === undefined ? '' : JSON.stringify(body);
    return fetch(base + path, { method, ...(s ? { body: s } : {}), headers: { ...sign(key, method, path, s), ...(s ? { 'content-type': 'application/json' } : {}) } });
  };
  const started = async (over: Partial<StartBody> = {}) => {
    const r = await call('POST', '/v1/streams', startBody(over));
    expect(r.status).toBe(200);
    const b = await r.json() as { streamKey: string; state: string };
    await vi.waitFor(() => expect(streams.list().find((v) => v.streamKey === b.streamKey)?.state).toBe('running'));
    return b;
  };

  it('start is idempotent per channel', async () => {
    const a = await call('POST', '/v1/streams', startBody());
    const first = await a.json() as { streamKey: string; state: string };
    expect(first.streamKey).toMatch(/^[0-9a-f]{32}$/);
    expect(first.state).toBe('starting');
    await vi.waitFor(() => expect(streams.list()[0]!.state).toBe('running'));
    const b = await call('POST', '/v1/streams', startBody({ dvrSeconds: 60 }));
    expect(await b.json()).toEqual({ streamKey: first.streamKey, state: 'running' });
    expect(runs).toBe(1);
    const list = await call('GET', '/v1/streams');
    const views = await list.json() as Array<Record<string, unknown>>;
    expect(views).toHaveLength(1);
    expect(Object.keys(views[0]!).sort()).toEqual(['bitrate', 'channelId', 'errors', 'lastSegmentAt', 'mode', 'segments', 'since', 'state', 'streamKey']);
    expect(views[0]).toMatchObject({ channelId: 'ch-nordlicht', streamKey: first.streamKey, mode: 'passthrough', state: 'running', errors: [], segments: 'ts' });
  });

  it('the stream view names the segment format: ts, fmp4 for an fMP4 window, null before the window (bughunt M2)', async () => {
    let open!: () => void;
    const opened = new Promise<void>((r) => { open = r; });
    const fmp4: Driver = async (ctx) => {
      await opened;
      ctx.window({ ext: 'm4s', init: true });
      await ctx.sleep(Number.MAX_SAFE_INTEGER);
    };
    const own = new Streams({ root, maxBytes: 1024 ** 3, drivers: { passthrough: fmp4 }, store: memoryStore().store });
    try {
      own.start(startBody({ channelId: 'ch-cmaf' }));
      expect(own.list()[0]!.segments).toBeNull();
      open();
      await vi.waitFor(() => expect(own.list()[0]!.segments).toBe('fmp4'));
    } finally { await own.close(); }
  });

  it('a body outside the schema is 400 invalid with the field (dvrSeconds 0–7200)', async () => {
    const cases: Array<[unknown, string]> = [
      [startBody({ dvrSeconds: 7201 }), 'dvrSeconds'], [startBody({ dvrSeconds: -1 }), 'dvrSeconds'], [startBody({ dvrSeconds: 1.5 }), 'dvrSeconds'],
      [{ ...startBody(), dvrSeconds: undefined }, 'dvrSeconds'], [{ ...startBody(), channelId: '' }, 'channelId'], [{ ...startBody(), channelId: 'a/b' }, 'channelId'],
      [{ ...startBody(), mode: 'copy' }, 'mode'], [{ ...startBody(), encoder: 'h265_magic' }, 'encoder'], [{ ...startBody(), maxBitrate: 0 }, 'maxBitrate'],
      [{ ...startBody(), input: { url: 'http://iptv.example.com/a.m3u8', kind: 'rtmp', allowLan: false } }, 'input'], [null, 'body'],
    ];
    for (const [body, field] of cases) {
      const r = await call('POST', '/v1/streams', body);
      expect([r.status, await r.json()]).toEqual([400, { error: 'invalid', field }]);
    }
    for (const dvrSeconds of [0, 7200]) {
      const r = await call('POST', '/v1/streams', startBody({ channelId: `ch-${dvrSeconds}`, dvrSeconds }));
      expect(r.status).toBe(200);
    }
    await vi.waitFor(() => expect(runs).toBe(2));
  });

  it('a mode without a driver yet is 422 unsupported_mode', async () => {
    const r = await call('POST', '/v1/streams', startBody({ mode: 'transcode' }));
    expect([r.status, await r.json()]).toEqual([422, { error: 'unsupported_mode' }]);
    expect(streams.list()).toEqual([]);
  });

  it('/s/ serves the playlist and segments with their types; every hit touches', async () => {
    const { streamKey } = await started();
    const touch = vi.spyOn(streams, 'touch');
    const pl = await fetch(`${base}/s/${streamKey}/index.m3u8`);
    expect(pl.status).toBe(200);
    expect(pl.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    const text = await pl.text();
    expect(text).toMatch(/^#EXTM3U\n/);
    expect(text).toContain('\n0.ts');
    const seg = await fetch(`${base}/s/${streamKey}/0.ts`);
    expect(seg.status).toBe(200);
    expect(seg.headers.get('content-type')).toBe('video/mp2t');
    expect(Buffer.from(await seg.arrayBuffer())).toEqual(TS);
    expect((await fetch(`${base}/s/${streamKey}/1.ts`)).status).toBe(404);
    expect(touch).toHaveBeenCalledTimes(3);
    expect(touch).toHaveBeenCalledWith(streamKey);
    touch.mockRestore();
    // no per-request log line for /s/ and never a stream key
    expect(logs.join('\n')).not.toContain(streamKey);
    expect(logs.join('\n')).not.toMatch(/\/s\/|iptv\.example|geheim/);
  });

  it('/s/ with an unknown key or a bad name → 404', async () => {
    const { streamKey } = await started();
    const bad = [
      '/s/0123456789abcdef0123456789abcdef/index.m3u8', `/s/${streamKey.toUpperCase()}/index.m3u8`, `/s/${streamKey.slice(1)}/index.m3u8`,
      `/s/${streamKey}/index.m3u`, `/s/${streamKey}/00000000000.ts`, `/s/${streamKey}/0.mp4`, `/s/${streamKey}/..%2F..%2Fetc%2Fpasswd`,
      `/s/${streamKey}/init.mp4`, `/s/${streamKey}/0.m4s`, `/s/${streamKey}/a.ts`, `/s/${streamKey}`, `/s/${streamKey}/0.ts/x`,
      `/s/${streamKey}/00.ts`, `/s/${streamKey}/01.ts`, `/s/${streamKey}/init-0.mp4`, `/s/${streamKey}/init-.mp4`, `/s/${streamKey}/init-00000000000.mp4`,
    ];
    for (const path of bad) {
      const r = await fetch(base + path);
      expect([path, r.status]).toEqual([path, 404]);
    }
    expect((await fetch(`${base}/s/${streamKey}/0.ts`, { method: 'POST' })).status).toBe(405);
  });

  it('DELETE stops and deletes files', async () => {
    const { streamKey } = await started();
    const dir = join(root, streamKey);
    expect((await stat(join(dir, 'index.m3u8'))).isFile()).toBe(true);
    const r = await call('DELETE', '/v1/streams/ch-nordlicht');
    expect(r.status).toBe(204);
    await expect(stat(dir)).rejects.toThrow();
    expect(streams.list()).toEqual([]);
    expect((await fetch(`${base}/s/${streamKey}/index.m3u8`)).status).toBe(404);
    // stopping again (or a channel that never ran) is the same answer
    expect((await call('DELETE', '/v1/streams/ch-nordlicht')).status).toBe(204);
    expect((await call('DELETE', '/v1/streams/a%2Fb')).status).toBe(404);
    expect(logs.join('\n')).toContain('stream ch-nordlicht stopped');
  });

  it('a segment removed from the disk meanwhile answers 404', async () => {
    const { streamKey } = await started();
    await rm(join(root, streamKey, 'a.ts'));
    expect((await fetch(`${base}/s/${streamKey}/0.ts`)).status).toBe(404);
  });
});

describe('the safety net', () => {
  let streams: Streams;
  let mem: ReturnType<typeof memoryStore>;
  const logs: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    mem = memoryStore();
    streams = new Streams({ root: '/cache', maxBytes: 1024 ** 3, drivers: { passthrough: oneSegment }, store: mem.store, log: (m) => logs.push(m) });
  });
  afterEach(async () => {
    await streams.close();
    vi.useRealTimers();
  });

  it('stops by itself after 180 s without a fetch', async () => {
    expect(IDLE_STOP_MS).toBe(180_000);
    const { streamKey } = streams.start(startBody());
    await flush();
    expect(mem.files.has(`/cache/${streamKey}/a.ts`)).toBe(true);
    await vi.advanceTimersByTimeAsync(179_000);
    expect(streams.list()).toHaveLength(1);
    streams.touch(streamKey);
    await vi.advanceTimersByTimeAsync(179_000);
    expect(streams.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(streams.list()).toEqual([]);
    expect([...mem.files.keys()]).toEqual([]);
    expect(logs.join('\n')).toContain('stream ch-nordlicht stopped (idle)');
    streams.touch(streamKey);
    expect(streams.file(streamKey, 'index.m3u8')).toBeNull();
  });

  it('the cache cap drops the oldest segments of the longest window and keeps the newest 3', async () => {
    let n = 0;
    const many: Driver = async (ctx) => {
      ctx.window({ ext: 'ts' });
      for (let i = 0; i < 8; i++) {
        const file = `${ctx.channelId}-${n++}.ts`;
        await ctx.store.write(join(ctx.dir, file), Buffer.alloc(100));
        await ctx.segment({ file, duration: 4, bytes: 100 });
      }
      await ctx.sleep(Number.MAX_SAFE_INTEGER);
    };
    streams = new Streams({ root: '/cache', maxBytes: 1000, drivers: { passthrough: many }, store: mem.store, log: () => {} });
    const a = streams.start(startBody({ channelId: 'a' }));
    await flush();
    const b = streams.start(startBody({ channelId: 'b' }));
    await flush();
    const segs = (k: string) => [...mem.files.keys()].filter((f) => f.startsWith(`/cache/${k}/`) && f.endsWith('.ts')).length;
    expect(segs(a.streamKey) + segs(b.streamKey)).toBe(10);
    expect(Math.min(segs(a.streamKey), segs(b.streamKey))).toBeGreaterThanOrEqual(3);
    // the evicted window's playlist was rewritten
    const pl = mem.files.get(`/cache/${a.streamKey}/index.m3u8`)!.toString();
    expect(pl.split('\n').filter((l) => l.endsWith('.ts'))).toHaveLength(segs(a.streamKey));
  });

  it('an old init version is removed once the cache cap evicted its segments', async () => {
    const fmp4: Driver = async (ctx) => {
      ctx.window({ ext: 'm4s', init: true });
      for (let i = 0; i < 8; i++) {
        const init = i < 4 ? 0 : 1;
        if (i % 4 === 0) await ctx.store.write(join(ctx.dir, `init-${init}.mp4`), 'init');
        await ctx.store.write(join(ctx.dir, `${i}.m4s`), Buffer.alloc(100));
        await ctx.segment({ file: `${i}.m4s`, duration: 4, bytes: 100, init });
      }
      await ctx.sleep(Number.MAX_SAFE_INTEGER);
    };
    streams = new Streams({ root: '/cache', maxBytes: 400, drivers: { passthrough: fmp4 }, store: mem.store, log: () => {} });
    const { streamKey } = streams.start(startBody());
    await flush();
    const files = [...mem.files.keys()].filter((f) => f.startsWith(`/cache/${streamKey}/`)).map((f) => f.slice(`/cache/${streamKey}/`.length)).sort();
    expect(files).toEqual(['4.m4s', '5.m4s', '6.m4s', '7.m4s', 'index.m3u8', 'init-1.mp4']);
    expect(streams.file(streamKey, 'init-0.mp4')).toBeNull();
    expect(streams.file(streamKey, 'init-1.mp4')).toEqual({ path: `/cache/${streamKey}/init-1.mp4`, type: 'video/mp4' });
    const pl = mem.files.get(`/cache/${streamKey}/index.m3u8`)!.toString();
    expect(pl).not.toContain('init-0.mp4');
    expect(pl).toContain('#EXT-X-MAP:URI="init-1.mp4"');
  });

  const pdtsOf = (key: string) => mem.files.get(`/cache/${key}/index.m3u8`)!.toString().split('\n')
    .filter((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')).map((l) => Date.parse(l.slice(25)));

  it('a chained date-time re-anchors once it drifts past max(30 s, 3 target durations), without a discontinuity', async () => {
    // EXTINF says 3.92 s (2 % short), a segment really arrives every 4 s: 80 ms of drift per segment
    const short: Driver = async (ctx) => {
      ctx.window({ ext: 'ts' });
      for (let i = 0; ; i++) {
        await ctx.segment({ file: `${i}.ts`, duration: 3.92, bytes: 10 });
        if (!(await ctx.sleep(4000))) return;
      }
    };
    streams = new Streams({ root: '/cache', maxBytes: 1024 ** 3, drivers: { passthrough: short }, store: mem.store, log: () => {} });
    const { streamKey } = streams.start(startBody({ dvrSeconds: 7200 }));
    await flush();
    for (let t = 0; t < 400 * 4000; t += 100_000) { streams.touch(streamKey); await vi.advanceTimersByTimeAsync(100_000); }
    const pdts = pdtsOf(streamKey);
    expect(pdts.length).toBeGreaterThan(390);
    const gaps = pdts.slice(1).map((p, i) => p - pdts[i]!);
    // chained 3 920 ms apart until the error passes 30 s (segment 376: 376 × 80 ms = 30.08 s), then one re-anchor
    // (date-times are whole milliseconds in the playlist: ±1 ms)
    const jumps = gaps.map((g, i) => [i + 1, g] as const).filter(([, g]) => Math.abs(g - 3920) > 1);
    expect(jumps.map(([i]) => i)).toEqual([376]);
    expect(Math.abs(jumps[0]![1] - (4000 + 375 * 80))).toBeLessThanOrEqual(1);
    expect(Math.abs(pdts[376]! - (NOW + 376 * 4000 - 3920))).toBeLessThanOrEqual(1);
    // the segment before still chained: 375 × 80 ms = 30 s is not past the tolerance
    expect(Math.abs(pdts[375]! - (NOW - 3920 + 375 * 3920))).toBeLessThanOrEqual(1);
    expect(mem.files.get(`/cache/${streamKey}/index.m3u8`)!.toString()).not.toContain('#EXT-X-DISCONTINUITY\n');
  });

  it('a burst of 3 segments keeps its exact spacing; an init change starts a new run even without a discontinuity flag', async () => {
    const burst: Driver = async (ctx) => {
      ctx.window({ ext: 'm4s', init: true });
      for (let i = 0; i < 3; i++) await ctx.segment({ file: `${i}.m4s`, duration: 4, bytes: 10, init: 0 });
      // a driver restart with a new init that forgot to say discontinuity: no chaining across it
      await ctx.segment({ file: '3.m4s', duration: 4, bytes: 10, init: 1 });
      await ctx.sleep(Number.MAX_SAFE_INTEGER);
    };
    streams = new Streams({ root: '/cache', maxBytes: 1024 ** 3, drivers: { passthrough: burst }, store: mem.store, log: () => {} });
    const { streamKey } = streams.start(startBody());
    await flush();
    expect(pdtsOf(streamKey)).toEqual([NOW - 4000, NOW, NOW + 4000, NOW - 4000]);
  });

  it('a driver that throws fails the stream with a fixed code', async () => {
    const broken: Driver = async () => { throw new Error('http://iptv.example.com/geheim'); };
    streams = new Streams({ root: '/cache', maxBytes: 1000, drivers: { passthrough: broken }, store: mem.store, log: (m) => logs.push(m) });
    streams.start(startBody());
    await flush();
    expect(streams.list()[0]!.state).toBe('failed');
    expect(logs.join('\n')).toContain('stream ch-nordlicht failed (internal)');
    expect(logs.join('\n')).not.toMatch(/iptv|geheim/);
  });
});

describe('start', () => {
  it('registers the stream and file routes in production', async () => {
    const free = await new Promise<number>((r) => { const s = netServer().listen(0, '127.0.0.1', () => { const n = (s.address() as AddressInfo).port; s.close(() => r(n)); }); });
    const s = await start({ PORT: String(free), LIVETV_KEY_FILE: keyFile('start-streams-secret-0123456789'), LIVETV_SRT_PORTS: '9000' }, { log: () => {}, host: '127.0.0.1' });
    try {
      const k = deriveKey('start-streams-secret-0123456789');
      const r = await fetch(`http://127.0.0.1:${free}/v1/streams`, { headers: sign(k, 'GET', '/v1/streams', '') });
      expect([r.status, await r.json()]).toEqual([200, []]);
      expect((await fetch(`http://127.0.0.1:${free}/s/0123456789abcdef0123456789abcdef/index.m3u8`)).status).toBe(404);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
