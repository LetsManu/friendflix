// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ available: true, api: 2, sent: [] as Array<string | null> }));
vi.mock('#lib/gate', () => ({ clearHint: vi.fn() }));
vi.mock('#lib/native/bridge', () => ({
  native: { get available() { return h.available; }, sessionChanged: async (id: string | null) => { h.sent.push(id); return true; } },
}));
vi.mock('#lib/native/play', () => ({ nativeCaps: async () => ({ api: h.api, play: true, download: true, cast: true, castBar: true }) }));

import { api, setCsrf } from './api';

let loc: { pathname: string; href: string };
const respond = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
beforeEach(() => {
  h.available = true; h.api = 2; h.sent = []; setCsrf(''); // setCsrf re-arms the once-per-burst sign-out message
  loc = { pathname: '/', href: '/' };
  vi.stubGlobal('location', loc);
  vi.stubGlobal('localStorage', { getItem: () => null });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a 401 (the session is gone)', () => {
  it('tells the app the sign-out before the redirect, without waiting for it', async () => {
    respond(401, { error: 'unauthorized' });
    void api('/api/me');
    await vi.waitFor(() => expect(loc.href).toBe('/auth/login'));
    await vi.waitFor(() => expect(h.sent).toEqual([null]));
  });
  it('sends nothing outside the app', async () => {
    h.available = false;
    respond(401, { error: 'unauthorized' });
    void api('/api/me');
    await vi.waitFor(() => expect(loc.href).toBe('/auth/login'));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sent).toEqual([]);
  });
  it('sends nothing to an API 1 app', async () => {
    h.api = 1;
    respond(401, { error: 'unauthorized' });
    void api('/api/me');
    await vi.waitFor(() => expect(loc.href).toBe('/auth/login'));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sent).toEqual([]);
  });
  it('a reauth_required 401 keeps the session: nothing is sent', async () => {
    respond(401, { error: 'reauth_required' });
    await expect(api('/api/x')).rejects.toMatchObject({ status: 401 });
    expect(h.sent).toEqual([]);
  });
  it('a burst of parallel 401s tells the app once; the next sign-in arms it again', async () => {
    respond(401, { error: 'unauthorized' });
    void Promise.all([api('/api/a'), api('/api/b'), api('/api/c')]);
    await vi.waitFor(() => expect(h.sent).toEqual([null]));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sent).toEqual([null]);
    setCsrf('t'); // a successful /api/me after signing in again
    void api('/api/d');
    await vi.waitFor(() => expect(h.sent).toEqual([null, null]));
  });
});
