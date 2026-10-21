// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

// the in-app sign-in's config (lib/auth/flow.ts): which mode the backend runs, or a failure
const flow = vi.hoisted(() => ({ config: vi.fn(async (): Promise<{ mode: 'app' | 'authentik'; recovery: boolean; enroll: boolean }> => ({ mode: 'app', recovery: false, enroll: false })) }));
vi.mock('#lib/auth/flow', () => ({ flowConfig: flow.config }));

import { api, ApiError } from '#lib/api';
import { finishReauth, inAppReauth, isReauthError, reauthenticate, reauthHref, reauthRequest, registerReauthHost, startReauth } from './reauth';

const loc = (pathname: string) => ({ pathname, href: '' });
const answer = (status: number, body: string) => vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => vi.unstubAllGlobals());

describe('reauth helpers', () => {
  it('builds the /auth/reauth URL with an encoded next', () => {
    expect(reauthHref('/me/account?delete=1')).toBe('/auth/reauth?next=%2Fme%2Faccount%3Fdelete%3D1');
    const l = loc('/me/account');
    vi.stubGlobal('location', l);
    startReauth('/me/account');
    expect(l.href).toBe('/auth/reauth?next=%2Fme%2Faccount');
  });

  it('recognises only the 401 reauth_required answer', () => {
    expect(isReauthError(new ApiError(401, { error: 'reauth_required' }))).toBe(true);
    expect(isReauthError(new ApiError(401, { error: 'unauthenticated' }))).toBe(false);
    expect(isReauthError(new ApiError(403, { error: 'reauth_required' }))).toBe(false);
    expect(isReauthError(new ApiError(401, null))).toBe(false);
    expect(isReauthError(new Error('reauth_required'))).toBe(false);
  });
});

describe('api() and 401', () => {
  it('reauth_required rejects with an ApiError and stays on the page (F4)', async () => {
    const l = loc('/me/account');
    vi.stubGlobal('location', l);
    vi.stubGlobal('fetch', answer(401, '{"error":"reauth_required"}'));
    const e = await api('/api/account/delete', { method: 'POST', body: { confirm: true } }).catch((x: unknown) => x);
    expect(isReauthError(e)).toBe(true);
    expect(l.href).toBe('');
  });

  it('any other 401 still goes to the sign-in, also with a body that is not JSON', async () => {
    for (const body of ['{"error":"unauthenticated"}', '<html>proxy</html>', '']) {
      const l = loc('/me/account');
      vi.stubGlobal('location', l);
      vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => undefined });
      vi.stubGlobal('sessionStorage', { getItem: () => null, removeItem: () => undefined });
      vi.stubGlobal('fetch', answer(401, body));
      const settled = await Promise.race([api('/api/account').then(() => 'resolved', () => 'rejected'), new Promise((r) => setTimeout(() => r('pending'), 20))]);
      expect(settled).toBe('pending'); // the redirect never resolves
      expect(l.href).toBe('/auth/login');
    }
  });
});

describe('api() and 401 on public pages (preflight D8)', () => {
  it('the e-mail confirmation page /confirm-email works without a session: a 401 is not sent to /auth/login', async () => {
    const l = loc('/confirm-email');
    vi.stubGlobal('location', l);
    vi.stubGlobal('fetch', answer(401, '{"error":"unauthenticated"}'));
    const e = await api('/api/me').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(l.href).toBe('');
  });

  it('the in-app sign-in /login keeps a 401 to itself: no redirect to /auth/login (which would come back to /login)', async () => {
    const l = loc('/login');
    vi.stubGlobal('location', l);
    vi.stubGlobal('fetch', answer(401, '{"error":"unauthenticated"}'));
    const e = await api('/api/me').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(401);
    expect(l.href).toBe('');
  });

  it('the reset-link page /reset keeps a 401 to itself too', async () => {
    const l = loc('/reset');
    vi.stubGlobal('location', l);
    vi.stubGlobal('fetch', answer(401, '{"error":"unauthenticated"}'));
    const e = await api('/api/me').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(l.href).toBe('');
  });
});

describe('reauthenticate(): the in-app dialog first, the classic redirect only without it', () => {
  const settled = (p: Promise<unknown>) => Promise.race([p.then((v) => ({ v })), new Promise((r) => setTimeout(() => r('pending'), 20))]);
  let off: (() => void) | undefined;
  afterEach(() => { off?.(); off = undefined; flow.config.mockClear(); });

  it('in-app sign-in available: opens the dialog (no navigation) and resolves true once signed in again', async () => {
    const l = loc('/admin/settings');
    vi.stubGlobal('location', l);
    off = registerReauthHost();
    flow.config.mockResolvedValueOnce({ mode: 'app', recovery: false, enroll: false });
    const p = reauthenticate('/admin/settings?resume=1');
    await vi.waitFor(() => expect(get(reauthRequest)).toMatchObject({ next: '/admin/settings?resume=1' }));
    expect(l.href).toBe('');
    finishReauth(true);
    expect(await p).toBe(true);
    expect(get(reauthRequest)).toBeNull();
  });

  it('closing the dialog resolves false; a second request while one is open shares it', async () => {
    vi.stubGlobal('location', loc('/me/account'));
    off = registerReauthHost();
    const a = reauthenticate('/me/account?delete=1');
    await vi.waitFor(() => expect(get(reauthRequest)).not.toBeNull());
    const b = reauthenticate('/me/account?delete=1');
    finishReauth(false);
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    finishReauth(true); // nothing open: ignored
  });

  it('two requests started together (before the config answered) open one dialog', async () => {
    vi.stubGlobal('location', loc('/admin/settings'));
    off = registerReauthHost();
    const a = reauthenticate('/admin/settings'), b = reauthenticate('/admin/settings');
    await vi.waitFor(() => expect(get(reauthRequest)).not.toBeNull());
    const id = get(reauthRequest)!.id;
    finishReauth(true);
    expect([await a, await b]).toEqual([true, true]);
    expect(get(reauthRequest)?.id ?? id).toBe(id);
  });

  it('classic sign-in mode: the redirect to /auth/reauth with next, the promise never settles (the page leaves)', async () => {
    const l = loc('/setup/extras');
    vi.stubGlobal('location', l);
    off = registerReauthHost();
    flow.config.mockResolvedValueOnce({ mode: 'authentik', recovery: false, enroll: false });
    expect(await settled(reauthenticate('/setup/extras'))).toBe('pending');
    expect(l.href).toBe('/auth/reauth?next=%2Fsetup%2Fextras');
    expect(get(reauthRequest)).toBeNull();
  });

  it('the config cannot be read, or no host is mounted: the classic redirect', async () => {
    const l = loc('/admin/settings');
    vi.stubGlobal('location', l);
    off = registerReauthHost();
    flow.config.mockRejectedValueOnce(new Error('flow_config_502'));
    expect(await inAppReauth()).toBe(false);
    off();
    off = undefined;
    flow.config.mockClear();
    expect(await settled(reauthenticate('/admin/settings'))).toBe('pending');
    expect(flow.config).not.toHaveBeenCalled();
    expect(l.href).toBe('/auth/reauth?next=%2Fadmin%2Fsettings');
  });

  it('the host going away answers an open request with false', async () => {
    vi.stubGlobal('location', loc('/me/account'));
    const unregister = registerReauthHost();
    const p = reauthenticate('/me/account');
    await vi.waitFor(() => expect(get(reauthRequest)).not.toBeNull());
    unregister();
    expect(await p).toBe(false);
  });
});
