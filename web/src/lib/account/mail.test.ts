// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMailPrefs, MAIL_TYPES, postUnsubscribe, saveMailPref, unsubscribeType } from './mail';

const ID = '0b6f2c1e-5d4a-4c3b-9a8f-7e6d5c4b3a21';
const MAC = 'A'.repeat(21) + '_-' + 'z9'.repeat(10);
const token = (type = 'licence', mac = MAC, v = 'v1') => `${v}.${ID}.${type}.${mac}`;

type Call = { url: string; init: RequestInit };
function answer(status: number, body: unknown) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('unsubscribe token', () => {
  it('the three switchable types', () => {
    expect(MAIL_TYPES).toEqual(['available', 'recording', 'licence']);
  });

  it('reads the type from a well-formed token', () => {
    expect(MAC).toHaveLength(43);
    expect(unsubscribeType(token())).toBe('licence');
    expect(unsubscribeType(token('available'))).toBe('available');
    expect(unsubscribeType(token('recording'))).toBe('recording');
  });

  it('null for another version, an unknown type, a short mac or nothing', () => {
    expect(unsubscribeType(token('licence', MAC, 'v2'))).toBeNull();
    expect(unsubscribeType(token('digest'))).toBeNull();
    expect(unsubscribeType(token('licence', MAC.slice(1)))).toBeNull();
    expect(unsubscribeType('')).toBeNull();
    expect(unsubscribeType(`${token()}x`)).toBeNull();
  });
});

describe('postUnsubscribe', () => {
  it('sends the token in the JSON body, never in the URL', async () => {
    const calls = answer(200, { ok: true, type: 'licence', on: false });
    expect(await postUnsubscribe(token(), false)).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/public/mail/unsubscribe');
    expect(calls[0]!.url).not.toContain(MAC);
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ t: token(), on: false });
  });

  it('switching back on sends on: true', async () => {
    const calls = answer(200, { ok: true, type: 'licence', on: true });
    expect(await postUnsubscribe(token(), true)).toBe('ok');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ t: token(), on: true });
  });

  it('maps 400 → invalid, 429 → limited, 500 → failed', async () => {
    answer(400, { error: 'invalid_token' });
    expect(await postUnsubscribe(token(), false)).toBe('invalid');
    answer(429, { error: 'rate_limited' });
    expect(await postUnsubscribe(token(), false)).toBe('limited');
    answer(500, { error: 'internal' });
    expect(await postUnsubscribe(token(), false)).toBe('failed');
  });

  it('a 401 (a sign-in proxy in front) stays on the public page: failed, no redirect to the sign-in', async () => {
    const l = { pathname: '/mail/unsubscribe', href: '' };
    vi.stubGlobal('location', l);
    vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => undefined });
    vi.stubGlobal('sessionStorage', { getItem: () => null, removeItem: () => undefined });
    answer(401, { error: 'unauthenticated' });
    const settled = await Promise.race([postUnsubscribe(token(), false), new Promise((r) => setTimeout(() => r('pending'), 20))]);
    expect(settled).toBe('failed');
    expect(l.href).toBe('');
  });

  it('a network error → failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await postUnsubscribe(token(), false)).toBe('failed');
  });
});

describe('account mail switches', () => {
  const prefs = { available: true, recording: false, licence: true };

  it('loadMailPrefs reads GET /api/account/mail', async () => {
    const calls = answer(200, { configured: true, hasAddress: true, prefs });
    expect(await loadMailPrefs()).toEqual({ configured: true, hasAddress: true, prefs });
    expect(calls[0]!.url).toBe('/api/account/mail');
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('saveMailPref sends PUT /api/account/mail { type, on } and answers the prefs', async () => {
    const calls = answer(200, { prefs });
    expect(await saveMailPref('recording', false)).toEqual(prefs);
    expect(calls[0]!.url).toBe('/api/account/mail');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ type: 'recording', on: false });
  });

  it('saveMailPref rejects when saving fails', async () => {
    answer(500, { error: 'internal' });
    await expect(saveMailPref('licence', false)).rejects.toThrow();
  });
});
