// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PREVIEW_INTERVAL_MS, Previews, previewArgs } from '../src/preview.js';
import { ReplayCache, sign } from '../src/protocol.js';
import { streamRoutes } from '../src/routes/streams.js';
import { TIMEOUT_CODE, type Run, type RunOptions, type RunResult } from '../src/run.js';
import { createApp } from '../src/server.js';
import { Streams, type Driver, type StartBody } from '../src/streams.js';
import type { SystemView } from '../src/system.js';
import { deriveKey, memoryStore } from './streams-helpers.js';

const NOW = Date.parse('2026-11-11T20:15:00.000Z');
const DIR = '/cache/0123456789abcdef0123456789abcdef';
const ID = 'ch-nordlicht';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const TS = Buffer.alloc(376, 0x47);

const has = (args: readonly string[], part: readonly string[]): boolean =>
  part.length > 0 && args.some((_, i) => part.every((p, j) => args[i + j] === p));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r)); };

type Call = { cmd: string; args: string[]; o: RunOptions };
/** a fake ffmpeg for previews: records each call; answers a JPEG unless `answer` says otherwise */
function fakeRun(answer: () => RunResult | Promise<RunResult> = () => ({ code: 0, stdout: JPEG, stderr: '' })): Run & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (cmd, args, o) => {
    calls.push({ cmd, args, o });
    return answer();
  }) as Run & { calls: Call[] };
  run.calls = calls;
  return run;
}

describe('previews', () => {
  it('one frame of the newest segment, 320 px wide, as JPEG on stdout', () => {
    const a = previewArgs(`${DIR}/7.ts`);
    expect(has(a, ['-i', `${DIR}/7.ts`, '-frames:v', '1', '-vf', 'scale=320:-2', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'])).toBe(true);
    expect(a.at(-1)).toBe('pipe:1');
    expect(a.filter((x) => x === '-i')).toHaveLength(1);
  });

  it('renders at most every 60 s, kept in memory', async () => {
    expect(PREVIEW_INTERVAL_MS).toBe(60_000);
    let clock = NOW;
    const run = fakeRun();
    const p = new Previews({ run, now: () => clock });
    expect(p.get(ID)).toBeNull();
    p.segment(ID, `${DIR}/0.ts`);
    await vi.waitFor(() => expect(p.get(ID)).toEqual(JPEG));
    expect(run.calls.map((c) => [c.cmd, c.args])).toEqual([['ffmpeg', previewArgs(`${DIR}/0.ts`)]]);
    clock += 59_000;
    p.segment(ID, `${DIR}/14.ts`);
    await settle();
    expect(run.calls).toHaveLength(1);
    clock += 1_000;
    p.segment(ID, `${DIR}/15.ts`);
    await vi.waitFor(() => expect(run.calls).toHaveLength(2));
    expect(run.calls[1]!.args).toEqual(previewArgs(`${DIR}/15.ts`));
    // channels are independent
    p.segment('ch-hafenkanal', '/cache/fedcba9876543210fedcba9876543210/3.ts');
    await vi.waitFor(() => expect(p.get('ch-hafenkanal')).toEqual(JPEG));
    // dropped with its stream; a restarted stream renders at once
    p.drop(ID);
    expect(p.get(ID)).toBeNull();
    p.segment(ID, `${DIR}/0.ts`);
    await vi.waitFor(() => expect(p.get(ID)).toEqual(JPEG));
    expect(run.calls).toHaveLength(4);
  });

  it('only MPEG-TS segments are rendered: an fMP4 segment needs its init and is skipped', async () => {
    const run = fakeRun();
    const p = new Previews({ run, now: () => NOW });
    p.segment(ID, `${DIR}/0.m4s`);
    await settle();
    expect(run.calls).toHaveLength(0);
    expect(p.get(ID)).toBeNull();
    // a skipped segment does not use up the 60-s interval
    p.segment(ID, `${DIR}/1.ts`);
    await vi.waitFor(() => expect(p.get(ID)).toEqual(JPEG));
    expect(run.calls.map((c) => c.args)).toEqual([previewArgs(`${DIR}/1.ts`)]);
  });

  it('one render at a time; a failed, timed-out or non-JPEG render keeps what was there', async () => {
    let clock = NOW;
    const answers: Array<(r: RunResult) => void> = [];
    const run: Run = () => new Promise<RunResult>((r) => answers.push(r));
    const p = new Previews({ run, now: () => clock });
    p.segment(ID, `${DIR}/0.ts`);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    clock += 61_000;
    p.segment(ID, `${DIR}/15.ts`);
    await settle();
    expect(answers).toHaveLength(1);
    answers[0]!({ code: 1, stdout: Buffer.from('http://iptv.example.com/geheim'), stderr: 'Conversion failed!' });
    await settle();
    expect(p.get(ID)).toBeNull();
    clock += 61_000;
    p.segment(ID, `${DIR}/30.ts`);
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!({ code: 0, stdout: Buffer.from('not a jpeg'), stderr: '' });
    await settle();
    expect(p.get(ID)).toBeNull();
    clock += 61_000;
    p.segment(ID, `${DIR}/45.ts`);
    await vi.waitFor(() => expect(answers).toHaveLength(3));
    answers[2]!({ code: 0, stdout: JPEG, stderr: '' });
    await vi.waitFor(() => expect(p.get(ID)).toEqual(JPEG));
    clock += 61_000;
    p.segment(ID, `${DIR}/60.ts`);
    await vi.waitFor(() => expect(answers).toHaveLength(4));
    answers[3]!({ code: TIMEOUT_CODE, stdout: Buffer.alloc(0), stderr: '' });
    await settle();
    expect(p.get(ID)).toEqual(JPEG);
  });
});

describe('GET /v1/streams/:channelId/preview.jpg', () => {
  const key = deriveKey('preview-test-secret-0123456789');
  const mem = memoryStore();
  const logs: string[] = [];
  const run = fakeRun();
  let streams: Streams;
  let api: http.Server;
  let base = '';
  /** the test's driver writes one segment per `emit()`; `fail()` fails the stream */
  let emit: (() => Promise<void>) | null = null;
  let fail: (() => void) | null = null;
  const manual: Driver = async (ctx) => {
    ctx.window({ ext: 'ts' });
    let n = 0;
    emit = async () => {
      const file = `${n++}.ts`;
      const bytes = await ctx.store.write(join(ctx.dir, file), TS);
      await ctx.segment({ file, duration: 4, bytes });
    };
    fail = () => ctx.fail('unreachable');
    await ctx.sleep(Number.MAX_SAFE_INTEGER);
  };
  const startBody: StartBody = {
    channelId: ID, input: { url: 'http://iptv.example.com/live/anna/geheim/101.ts', kind: 'ts', allowLan: false }, mode: 'remux', encoder: 'libx264', dvrSeconds: 1800, maxBitrate: 10_000_000,
  };

  beforeAll(async () => {
    const previews = new Previews({ run });
    streams = new Streams({
      root: '/cache', maxBytes: 1024 ** 3, drivers: { remux: manual }, store: mem.store, log: (m) => logs.push(m),
      onSegment: (id, path) => previews.segment(id, path), onStop: (id) => previews.drop(id),
    });
    const app = createApp({
      verifier: { key, cache: new ReplayCache(), notBefore: Date.now() - 1000 }, version: null, bootId: '0123456789abcdef',
      system: async () => ({}) as SystemView, routes: streamRoutes(streams, { previews }), warn: (m) => logs.push(m),
    });
    api = http.createServer((req, res) => { void app(req, res); });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await streams.close();
    await new Promise<void>((r) => { api.closeAllConnections(); api.close(() => r()); });
  });

  const get = async (id: string) => {
    const path = `/v1/streams/${id}/preview.jpg`;
    const r = await fetch(base + path, { headers: sign(key, 'GET', path, '') });
    return { status: r.status, type: r.headers.get('content-type'), body: Buffer.from(await r.arrayBuffer()) };
  };

  it('preview 404 before the first segment, JPEG after', async () => {
    // a channel that is not running: 404, and nothing starts
    const none = await get(ID);
    expect([none.status, JSON.parse(none.body.toString())]).toEqual([404, { error: 'not_found' }]);
    expect(streams.list()).toEqual([]);
    expect(run.calls).toHaveLength(0);

    const { streamKey } = streams.start(startBody);
    await vi.waitFor(() => expect(emit).not.toBeNull());
    expect((await get(ID)).status).toBe(404);

    await emit!();
    await vi.waitFor(async () => expect((await get(ID)).status).toBe(200));
    const r = await get(ID);
    expect(r.type).toBe('image/jpeg');
    expect(r.body).toEqual(JPEG);
    expect(run.calls.map((c) => c.args)).toEqual([previewArgs(`/cache/${streamKey}/0.ts`)]);

    // a failed stream stays listed until it is stopped, but it is not running: no preview
    fail!();
    expect(streams.list()[0]!.state).toBe('failed');
    const failed = await get(ID);
    expect([failed.status, JSON.parse(failed.body.toString())]).toEqual([404, { error: 'not_found' }]);

    // gone with the stream
    await streams.stop(ID);
    expect((await get(ID)).status).toBe(404);
    expect(streams.list()).toEqual([]);
    expect(logs.join('\n')).not.toContain(streamKey);
    expect(logs.join('\n')).not.toMatch(/iptv\.example|geheim/);
  });
});
