// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer as netServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { videoArgs } from '../src/ffmpeg.js';
import { deriveKey, sign } from '../src/protocol.js';
import { benchmarkRoutes } from '../src/routes/benchmark.js';
import { TIMEOUT_CODE, type Run, type RunOptions, type RunResult } from '../src/run.js';
import { start, type Answer, type RouteCall } from '../src/server.js';
import type { Encoder } from '../src/system.js';

const has = (args: readonly string[], part: readonly string[]): boolean =>
  part.length > 0 && args.some((_, i) => part.every((p, j) => args[i + j] === p));
const tick = () => new Promise<void>((r) => setImmediate(r));

/** the benchmark route over a fake ffmpeg that takes `ms` on a fake clock; `hold` keeps runs open until `release()` */
function bench(o: { ms?: number; answer?: RunResult; encoders?: Encoder[] } = {}) {
  let clock = 1_000_000;
  let hold = false;
  const gates: Array<() => void> = [];
  const calls: Array<{ cmd: string; args: string[]; o: RunOptions }> = [];
  const run: Run = async (cmd, args, ro) => {
    calls.push({ cmd, args, o: ro });
    if (hold) await new Promise<void>((r) => gates.push(r));
    clock += o.ms ?? 5_000;
    return o.answer ?? { code: 0, stdout: Buffer.alloc(0), stderr: '' };
  };
  const encoders = o.encoders;
  const routes = benchmarkRoutes({ run, now: () => clock, ...(encoders ? { encoders: async () => encoders } : {}) });
  const route = routes.find((r) => r.method === 'POST' && r.path === '/v1/benchmark')!;
  const post = (json: unknown) => route.handle({ json, params: [] } as unknown as RouteCall) as Promise<Answer>;
  return { calls, post, hold: (v: boolean) => { hold = v; }, release: () => { for (const g of gates.splice(0)) g(); } };
}

describe('POST /v1/benchmark', () => {
  it('benchmark speed', async () => {
    const b = bench();
    // 20 s of 1080p25 test picture in 5 s of wall time
    expect(await b.post({ encoder: 'libx264' })).toEqual({ status: 200, json: { speed: 4, encoder: 'libx264', seconds: 5 } });
    const c = b.calls[0]!;
    expect(c.cmd).toBe('ffmpeg');
    expect(c.o.timeoutMs).toBe(120_000);
    expect(has(c.args, ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25', '-t', '20'])).toBe(true);
    expect(has(c.args, videoArgs('libx264', 1080))).toBe(true);
    expect(c.args.slice(-3)).toEqual(['-f', 'null', '-']);
    expect(c.args).not.toContain('pipe:0');
    expect(c.args).not.toContain('segment');
    // rounded to two decimals
    const slow = bench({ ms: 6_000 });
    expect(await slow.post({ encoder: 'h264_qsv' })).toEqual({ status: 200, json: { speed: 3.33, encoder: 'h264_qsv', seconds: 6 } });
    expect(has(slow.calls[0]!.args, videoArgs('h264_qsv', 1080))).toBe(true);
  });

  it('one at a time: a parallel call is 409 busy', async () => {
    const b = bench();
    b.hold(true);
    const first = b.post({ encoder: 'libx264' });
    await tick();
    await tick();
    expect(b.calls).toHaveLength(1);
    expect(await b.post({ encoder: 'h264_vaapi' })).toEqual({ status: 409, json: { error: 'busy' } });
    expect(b.calls).toHaveLength(1);
    b.hold(false);
    b.release();
    expect((await first).status).toBe(200);
    // the slot is free again
    expect((await b.post({ encoder: 'libx264' })).status).toBe(200);
    expect(b.calls).toHaveLength(2);
  });

  it('the encoder must be one livetv knows and /v1/system lists', async () => {
    const b = bench({ encoders: ['libx264'] });
    for (const json of [{}, { encoder: 'h265_magic' }, { encoder: 42 }]) {
      expect(await b.post(json)).toEqual({ status: 400, json: { error: 'invalid', field: 'encoder' } });
    }
    expect(await b.post(null)).toMatchObject({ status: 400, json: { error: 'invalid' } });
    expect(await b.post({ encoder: 'h264_nvenc' })).toEqual({ status: 400, json: { error: 'encoder_unavailable' } });
    expect(b.calls).toHaveLength(0);
    expect((await b.post({ encoder: 'libx264' })).status).toBe(200);
  });

  it('a failed or timed-out run answers a fixed code and frees the slot', async () => {
    const failed = bench({ answer: { code: 1, stdout: Buffer.alloc(0), stderr: 'Error opening input http://iptv.example.com/a password=geheim\n/dev/dri/renderD128: Permission denied' } });
    const r = await failed.post({ encoder: 'h264_vaapi' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.json)).toMatch(/^\{"error":"[a-z_]{1,40}"\}$/);
    expect(JSON.stringify(r.json)).not.toMatch(/iptv|geheim|dri|Permission/);
    expect((await failed.post({ encoder: 'h264_vaapi' })).status).not.toBe(409);

    const slow = bench({ ms: 120_000, answer: { code: TIMEOUT_CODE, stdout: Buffer.alloc(0), stderr: '' } });
    const t = await slow.post({ encoder: 'libx264' });
    expect(t.status).toBeGreaterThanOrEqual(400);
    expect(t.json).toEqual({ error: 'timeout' });
    expect((await slow.post({ encoder: 'libx264' })).status).not.toBe(409);
  });
});

describe('start', () => {
  it('registers POST /v1/benchmark; without ffmpeg no encoder is listed', async () => {
    const free = await new Promise<number>((r) => { const s = netServer().listen(0, '127.0.0.1', () => { const n = (s.address() as AddressInfo).port; s.close(() => r(n)); }); });
    const secret = 'start-bench-secret-0123456789ab';
    const s = await start({ PORT: String(free), INTERNAL_SECRET: secret, LIVETV_SRT_PORTS: '9000' }, { log: () => {}, host: '127.0.0.1' });
    try {
      const body = JSON.stringify({ encoder: 'libx264' });
      const r = await fetch(`http://127.0.0.1:${free}/v1/benchmark`, {
        method: 'POST', body, headers: { ...sign(deriveKey(secret), 'POST', '/v1/benchmark', body), 'content-type': 'application/json' },
      });
      expect([r.status, await r.json()]).toEqual([400, { error: 'encoder_unavailable' }]);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
