// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { StepError } from '../src/docker.js';
import { cachedRegistry, registryDigest } from '../src/registry.js';

const D = 'sha256:' + 'd'.repeat(64);
const TOKEN = 'secret-pull-token-must-never-leak';
type Call = { url: string; init: RequestInit };

/** a fake ghcr.io: the token endpoint answers `token`, the manifest HEAD `head` (both overridable) */
function registry(o: { token?: () => Response; head?: () => Response } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://ghcr.io/token?')) return o.token?.() ?? new Response(JSON.stringify({ token: TOKEN }), { status: 200 });
    return o.head?.() ?? new Response(null, { status: 200, headers: { 'docker-content-digest': D } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** the rejection of `p`, which must be StepError('registry_failed') and must not carry the token or a body */
async function failed(p: Promise<unknown>): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(StepError);
  expect(err).toMatchObject({ code: 'registry_failed' });
  const all = JSON.stringify({ message: (err as Error).message, detail: (err as StepError).detail, stack: (err as Error).stack, cause: (err as Error).cause ?? null });
  expect(all).not.toContain(TOKEN);
  expect(all).not.toContain('body-text');
}

describe('registry digests', () => {
  it('registry: pull token, then HEAD with the accept list; returns the digest', async () => {
    const { calls, fetchImpl } = registry();
    expect(await registryDigest('Example/FriendFlix', 'bootstrap', 'nightly', fetchImpl)).toBe(D);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://ghcr.io/token?scope=repository:example/friendflix-backend:pull&service=ghcr.io');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1]!.url).toBe('https://ghcr.io/v2/example/friendflix-backend/manifests/nightly');
    expect(calls[1]!.init.method).toBe('HEAD');
    expect(calls[1]!.init.redirect).toBe('error');
    expect(calls[1]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1]!.init.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, '
        + 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
    });
    // every image of the stack, by the image its service runs
    expect(await registryDigest('example/friendflix', 'livetv', 'sha-abc1234', fetchImpl)).toBe(D);
    expect(calls[3]!.url).toBe('https://ghcr.io/v2/example/friendflix-livetv/manifests/sha-abc1234');
  });

  it('401, 404, redirect, non-digest header → registry_failed; no token in the error', async () => {
    const body = () => 'body-text ' + TOKEN;
    for (const head of [
      () => new Response(body(), { status: 401 }),
      () => new Response(body(), { status: 404 }),
      () => { throw new TypeError(`fetch failed: redirect ${TOKEN}`); },
      () => new Response(null, { status: 200 }),
      () => new Response(null, { status: 200, headers: { 'docker-content-digest': 'sha256:short' } }),
      () => new Response(null, { status: 200, headers: { 'docker-content-digest': `${D}, ${D}` } }),
      () => new Response(null, { status: 200, headers: { 'docker-content-digest': 'sha256:' + 'D'.repeat(64) } }),
    ]) await failed(registryDigest('example/friendflix', 'web', 'latest', registry({ head }).fetchImpl));
    for (const token of [
      () => new Response(body(), { status: 401 }),
      () => new Response('body-text not json', { status: 200 }),
      () => new Response(JSON.stringify({ token: '' }), { status: 200 }),
      () => new Response(JSON.stringify({ access_token: TOKEN }), { status: 200 }),
      () => new Response(JSON.stringify({ token: `${TOKEN}\r\nx-evil: 1` }), { status: 200 }),
      () => { throw new Error(`aborted ${TOKEN}`); },
    ]) {
      const r = registry({ token });
      await failed(registryDigest('example/friendflix', 'web', 'latest', r.fetchImpl));
      expect(r.calls).toHaveLength(1); // no HEAD without a token
    }
  });

  it('a bad tag never reaches fetch', async () => {
    const { calls, fetchImpl } = registry();
    for (const tag of ['', 'edge', 'latest;id', '../latest', '1.2.3\n', 'sha-ABC1234', `latest@${D}`]) await expect(registryDigest('example/friendflix', 'web', tag, fetchImpl), tag).rejects.toThrow();
    for (const svc of ['postgres', 'mediaserver', 'constructor', '__proto__']) await expect(registryDigest('example/friendflix', svc, 'latest', fetchImpl), svc).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('cache: one HEAD per 10 min, errors retried after 60 s', async () => {
    let t = 0;
    let down = false;
    const { calls, fetchImpl } = registry({ head: () => (down ? new Response(null, { status: 503 }) : new Response(null, { status: 200, headers: { 'docker-content-digest': D } })) });
    const heads = () => calls.filter((c) => c.init.method === 'HEAD').length;
    const digest = cachedRegistry('example/friendflix', undefined, undefined, () => t, fetchImpl);
    expect(await digest('web', 'latest')).toBe(D);
    t = 599_999;
    expect(await digest('web', 'latest')).toBe(D);
    expect(heads()).toBe(1);
    // bootstrap and backend are one image: one lookup
    expect(await digest('backend', 'latest')).toBe(D);
    expect(await digest('bootstrap', 'latest')).toBe(D);
    expect(heads()).toBe(2);
    // another tag is another entry
    expect(await digest('web', 'nightly')).toBe(D);
    expect(heads()).toBe(3);
    t = 600_000;
    down = true;
    expect(await digest('web', 'latest')).toBeNull();
    expect(heads()).toBe(4);
    t = 659_999;
    expect(await digest('web', 'latest')).toBeNull();
    expect(heads()).toBe(4);
    down = false;
    t = 660_000;
    expect(await digest('web', 'latest')).toBe(D);
    expect(heads()).toBe(5);
    // concurrent callers share one lookup; a bad tag or service is null without a request
    t = 2_000_000;
    expect(await Promise.all([digest('gateway', 'latest'), digest('gateway', 'latest')])).toEqual([D, D]);
    expect(heads()).toBe(6);
    expect(await digest('web', 'edge')).toBeNull();
    expect(await digest('postgres', 'latest')).toBeNull();
    expect(heads()).toBe(6);
  });

  it('cache: expired entries are dropped, so the map cannot grow without bound', async () => {
    let t = 0;
    const digest = cachedRegistry('example/friendflix', undefined, undefined, () => t, registry().fetchImpl);
    for (let i = 0; i < 50; i++) await digest('web', `1.0.${i}`);
    expect(digest.size()).toBe(50);
    t = 600_000; // all expired: the next miss sweeps them
    await digest('web', 'latest');
    expect(digest.size()).toBe(1);
    // a failure is kept only for its 60 s
    const down = cachedRegistry('example/friendflix', undefined, undefined, () => t, registry({ head: () => new Response(null, { status: 503 }) }).fetchImpl);
    for (let i = 0; i < 10; i++) expect(await down('web', `2.0.${i}`)).toBeNull();
    expect(down.size()).toBe(10);
    t += 60_000;
    await down('gateway', 'latest');
    expect(down.size()).toBe(1);
  });

  it('a refused token or manifest answer has its body cancelled, never read into the error', async () => {
    const answers: Response[] = [];
    const keep = (r: Response) => { answers.push(r); return r; };
    await failed(registryDigest('example/friendflix', 'web', 'latest', registry({ token: () => keep(new Response('body-text ' + TOKEN, { status: 401 })) }).fetchImpl));
    await failed(registryDigest('example/friendflix', 'web', 'latest', registry({ head: () => keep(new Response('body-text', { status: 404 })) }).fetchImpl));
    expect(answers).toHaveLength(2);
    for (const r of answers) expect(r.bodyUsed).toBe(true);
  });
});
