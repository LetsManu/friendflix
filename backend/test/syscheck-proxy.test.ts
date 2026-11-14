// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { encrypt } from '../src/crypto.js';
import { guideDir, PROBE_SOURCE_ID } from '../src/livetv/guidefiles.js';
import { resetChecksForTests } from '../src/syscheck/engine.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

// Systemcheck Stage 3, Task 8: the proxy lines the backend sees on the request, the websocket probe and the upload-limit probe.
type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
let admin: Sess, fritz: Sess;
let port: number;
const ORIGIN = 'https://portal.example.com';
const MiB = 1024 * 1024;

const check = (o: { headers?: Record<string, string>; remoteAddress?: string } = {}) =>
  env.app.inject({ method: 'GET', url: '/api/admin/systemcheck', cookies: admin.cookies, headers: o.headers, ...(o.remoteAddress ? { remoteAddress: o.remoteAddress } : {}) });
const lineOf = async (id: string, o: Parameters<typeof check>[0] = {}) => {
  const r = await check(o);
  expect(r.statusCode).toBe(200);
  return (r.json().lines as Array<{ id: string }>).find((l) => l.id === id);
};
const probe = (s: Sess | null, bytes: number, o: { csrf?: boolean; id?: string } = {}) =>
  env.app.inject({
    method: 'PUT', url: `/api/admin/livetv/sources/${o.id ?? PROBE_SOURCE_ID}/file`, payload: Buffer.alloc(bytes),
    cookies: s?.cookies, headers: { 'content-type': 'application/octet-stream', ...(s && o.csrf !== false ? { 'x-csrf-token': s.csrf } : {}) },
  });

beforeAll(async () => {
  env = await makeEnv();
  resetChecksForTests(); // only the request lines here: the group checks are tested elsewhere
  admin = await env.login(ADMIN);
  await env.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(),'sub-f','f@example.com','Fritz','friend','jffritz','Fritz',$1)", [encrypt(env.ctx.encKey, 'pw')]);
  fritz = await env.login({ sub: 'sub-f', email: 'f@example.com', name: 'Fritz', groups: [] });
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  port = (env.app.server.address() as { port: number }).port;
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...cfg };
  for (const p of ['syscheck:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
});

describe('request lines', () => {
  it('request arriving as http while PUBLIC_URL is https → proxy.forwardedProto warning proxy_no_proto', async () => {
    expect(await lineOf('proxy.forwardedProto')).toEqual({
      id: 'proxy.forwardedProto', group: 'proxy', status: 'warning', cause: 'proxy_no_proto', fix: 'proxy_no_proto',
      docs: 'setup.md#6-nginx-proxy-manager-portal-proxy-host', runs: 'server',
    });
  });

  it('x-forwarded-proto https from a trusted peer → ok; from an untrusted peer it is not believed', async () => {
    expect(await lineOf('proxy.forwardedProto', { headers: { 'x-forwarded-proto': 'https' } })).toMatchObject({ status: 'ok' });
    expect(await lineOf('proxy.forwardedProto', { headers: { 'x-forwarded-proto': 'https' }, remoteAddress: '203.0.113.9' })).toMatchObject({ status: 'warning' });
  });

  it('a local PUBLIC_URL has no proxy to ask about → ok', async () => {
    env.ctx.cfg = { ...cfg, PUBLIC_URL: 'https://localhost:3080' };
    expect(await lineOf('proxy.forwardedProto')).toMatchObject({ status: 'ok' });
  });

  it('x-forwarded-for from a public peer (203.0.113.9 via injected socket address) → proxy.peer warning proxy_untrusted_peer', async () => {
    const l = await lineOf('proxy.peer', { headers: { 'x-forwarded-for': '198.51.100.7' }, remoteAddress: '203.0.113.9' });
    expect(l).toMatchObject({ status: 'warning', cause: 'proxy_untrusted_peer', docs: 'setup.md#6-nginx-proxy-manager-portal-proxy-host' });
    // the addresses never leave the backend
    expect(JSON.stringify(l)).not.toMatch(/203\.0\.113|198\.51\.100/);
    expect(await lineOf('proxy.peer', { headers: { 'x-forwarded-for': '198.51.100.7' } })).toMatchObject({ status: 'ok' }); // from 127.0.0.1
    expect(await lineOf('proxy.peer', { remoteAddress: '203.0.113.9' })).toMatchObject({ status: 'ok' }); // no proxy in front
  });

  it('the request lines are counted, never cached', async () => {
    const a = (await check()).json();
    expect(a.counts.warning).toBe(1);
    const b = (await check({ headers: { 'x-forwarded-proto': 'https' } })).json();
    expect(b.counts.warning).toBe(0);
    expect(JSON.parse((await env.kv.get('syscheck:result')) ?? '{"lines":[]}').lines.some((l: { group: string }) => l.group === 'proxy')).toBe(false);
  });
});

describe('GET /ws/syscheck', () => {
  const connect = (s: Sess | null, origin = ORIGIN) => new Promise<{ msgs: string[]; code: number }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/syscheck`, { headers: { origin, ...(s ? { cookie: `ff_sid=${s.cookies.ff_sid}` } : {}) } });
    const msgs: string[] = [];
    ws.on('message', (d) => msgs.push(d.toString()));
    ws.on('close', (code) => resolve({ msgs, code }));
    ws.on('error', () => undefined);
  });

  it('as admin receives {"ok":true} and close 1000; as a user → 4403; without a session or from another origin → 4401', async () => {
    expect(await connect(admin)).toEqual({ msgs: ['{"ok":true}'], code: 1000 });
    expect(await connect(fritz)).toEqual({ msgs: [], code: 4403 });
    expect(await connect(null)).toEqual({ msgs: [], code: 4401 });
    expect(await connect(admin, 'https://evil.example.com')).toEqual({ msgs: [], code: 4401 });
  });
});

describe('upload-limit probe', () => {
  const partFiles = () => (existsSync(guideDir(env.ctx)) ? readdirSync(guideDir(env.ctx)).filter((f) => f.startsWith(PROBE_SOURCE_ID)) : []);
  const audits = async () => (await env.pool.query("select count(*)::int as n from audit_log where action like 'livetv.%'")).rows[0].n as number;

  it('probe upload of 2 MiB → 200 {probe:"ok", bytes: 2097152}, no file in guideDir, no audit row', async () => {
    const before = await audits();
    const r = await probe(admin, 2 * MiB);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ probe: 'ok', bytes: 2 * MiB });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(partFiles()).toEqual([]);
    expect(await audits()).toBe(before);
  });

  it('5 MiB → 413; non-admin → 403; missing CSRF → 403', async () => {
    expect((await probe(admin, 5 * MiB)).statusCode).toBe(413);
    expect((await probe(admin, 5 * MiB)).json()).toEqual({ error: 'too_large' });
    expect((await probe(fritz, 2 * MiB)).statusCode).toBe(403);
    const noCsrf = await probe(admin, 2 * MiB, { csrf: false });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toEqual({ error: 'csrf' });
    expect((await probe(null, 1024)).statusCode).toBe(401);
    expect(partFiles()).toEqual([]);
  });

  it('a body over the limit without a length (chunked) is cut at 4 MiB → 413', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/livetv/sources/${PROBE_SOURCE_ID}/file`, {
      method: 'PUT', duplex: 'half',
      headers: { cookie: `ff_sid=${admin.cookies.ff_sid}`, 'x-csrf-token': admin.csrf, 'content-type': 'application/octet-stream' },
      body: new ReadableStream({ start(c) { for (let i = 0; i < 6; i++) c.enqueue(new Uint8Array(MiB)); c.close(); } }),
    } as RequestInit).catch(() => null);
    // the server may answer 413 and close before the client finished sending: either way nothing is accepted
    if (res) expect(res.status).toBe(413);
    expect(partFiles()).toEqual([]);
  });

  it('at most 10 probes a minute per session → 429 rate_limited', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await probe(admin, 1024)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
