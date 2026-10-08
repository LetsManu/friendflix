import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizePath, upstreamUri } from '../src/mediapath.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/media-paths.json', import.meta.url), 'utf8')) as { allow: string[]; deny: string[] };
const ID = 'a'.repeat(32);

describe('shared allowlist vectors (same file as the gateway tests)', () => {
  it.each(vectors.allow)('allows %s', (p) => expect(normalizePath(p)).toBeTruthy());
  it.each(vectors.deny)('denies %s', (p) => expect(normalizePath(p)).toBeNull());
});

describe('upstreamUri', () => {
  it('strips token params, clamps bitrate, keeps benign params, re-encodes', () => {
    const u = upstreamUri(`/media/Videos/${ID}/master.m3u8?api_key=LEAK&ApiKey=X&MaxStreamingBitrate=999999999&MediaSourceId=a%20b&Token=t`, 5_000_000)!;
    expect(u).toBe(`/Videos/${ID}/master.m3u8?MaxStreamingBitrate=5000000&MediaSourceId=a+b`);
    expect(u).not.toMatch(/LEAK|ApiKey|Token/i);
  });
  it('adds a bitrate cap even when the client sends none? no: only clamps what is sent', () => {
    expect(upstreamUri(`/media/Videos/${ID}/master.m3u8`, 1)).toBe(`/Videos/${ID}/master.m3u8`);
    expect(upstreamUri(`/media/Videos/${ID}/master.m3u8?VideoBitRate=abc`, 7)).toContain('VideoBitRate=7');
  });
  it('rejects bad input: wrong prefix, control chars, long/many params, traversal', () => {
    expect(upstreamUri(`/api/me`, 1)).toBeNull();
    expect(upstreamUri(`/media/Videos/${ID}/master.m3u8\r\nX-Evil: 1`, 1)).toBeNull();
    expect(upstreamUri(`/media/Videos/${ID}/master.m3u8?x=${'a'.repeat(2100)}`, 1)).toBeNull();
    expect(upstreamUri(`/media/Videos/${ID}/master.m3u8?${Array.from({ length: 41 }, (_, i) => `p${i}=1`).join('&')}`, 1)).toBeNull();
    expect(upstreamUri(`/media/Videos/${ID}/hls1/main/..%2f..%2fx`, 1)).toBeNull();
    expect(upstreamUri(`/media//evil.example/x`, 1)).toBeNull();
  });
});

describe('GET /internal/authz-nginx', () => {
  let env: TestEnv;
  let sid: string;
  const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };
  const call = (headers: Record<string, string>, cookies: Record<string, string> | undefined, uri = `/media/Videos/${ID}/master.m3u8?MaxStreamingBitrate=999999999`) =>
    env.app.inject({ method: 'GET', url: '/internal/authz-nginx', headers: { ...headers, 'x-original-uri': uri }, cookies });

  beforeAll(async () => {
    env = await makeEnv();
    sid = (await env.login()).cookies.ff_sid!;
  });
  afterAll(() => env.close());

  it('requires the internal secret', async () => {
    expect((await call({}, { ff_sid: sid })).statusCode).toBe(403);
    expect((await call({ 'x-internal-secret': 'wrong-secret-wrong' }, { ff_sid: sid })).statusCode).toBe(403);
  });
  it('401 without or with an invalid session', async () => {
    expect((await call(H, undefined)).statusCode).toBe(401);
    expect((await call(H, { ff_sid: 'x'.repeat(30) })).statusCode).toBe(401);
    expect((await call(H, { ff_sid: '../etc' })).statusCode).toBe(401);
  });
  it('returns sanitized uri and the user token header only in response headers', async () => {
    const r = await call(H, { ff_sid: sid });
    expect(r.statusCode).toBe(204);
    expect(r.headers['x-jellyfin-uri']).toBe(`/Videos/${ID}/master.m3u8?MaxStreamingBitrate=60000000`);
    expect(String(r.headers['x-jellyfin-auth'])).toMatch(/^MediaBrowser Client="FriendFlix".*Token="tok-/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toBe('');
  });
  it('403 for paths outside the allowlist, even with a valid session', async () => {
    expect((await call(H, { ff_sid: sid }, '/media/System/Info')).statusCode).toBe(403);
    expect((await call(H, { ff_sid: sid }, `/media/Videos/${ID}/hls1/main/..%2f..%2f..%2fSystem`)).statusCode).toBe(403);
    expect((await call(H, { ff_sid: sid }, '')).statusCode).toBe(403);
  });
  it('a disabled user or removed session loses access within the memo window (<= 5 s)', async () => {
    await env.pool.query('update users set disabled = true');
    await new Promise((r) => setTimeout(r, 5200));
    expect((await call(H, { ff_sid: sid })).statusCode).toBe(401);
    await env.pool.query('update users set disabled = false');
  }, 15_000);
  it('counts decisions for monitoring', async () => {
    const m = (await env.app.inject('/metrics')).body;
    expect(m).toMatch(/friendflix_authz_nginx_total\{result="ok"\} \d+/);
    expect(m).toMatch(/friendflix_authz_nginx_total\{result="path_denied"\} \d+/);
  });
});
