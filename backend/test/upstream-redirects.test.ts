// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { JellyfinClient } from '../src/jellyfin/client.js';
import { SeerrClient } from '../src/seerr/client.js';

// Security audit note: the runtime clients of the media server and the request service never follow a redirect. A followed redirect
// would carry the admin key or a user token (and the request body) to whatever host the Location names; the probes and the gateway
// already use `redirect: 'manual'`, these clients now do too and treat a redirect answer as an error.
const EVIL = 'http://evil.example.com/steal';
function fake(status: number) {
  const seen: RequestInit[] = [];
  const f = (async (_u: RequestInfo | URL, init: RequestInit = {}) => {
    seen.push(init);
    // a real fetch only returns the 3xx itself with redirect 'manual'; with 'follow' it would go to EVIL
    if (status >= 300 && status < 400 && init.redirect !== 'manual') return new Response('{"stolen":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(status >= 300 ? null : '{"ok":true}', { status, headers: status >= 300 && status < 400 ? { location: EVIL } : { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, seen };
}

describe('Jellyfin client', () => {
  it('sends every request with redirect: manual', async () => {
    const { f, seen } = fake(200);
    const jf = new JellyfinClient('http://jellyfin:8096', 'adminkey', f);
    await jf.adminJson('/System/Info');
    await jf.userFetch('tok', 'dev', '/Users/Me');
    await jf.ping();
    await jf.authenticateByName('ada', 'pw', 'dev').catch(() => undefined);
    expect(seen.length).toBe(4);
    for (const i of seen) expect(i.redirect).toBe('manual');
  });
  it.each([301, 302, 303, 307, 308])('a %i answer is an error, never followed', async (code) => {
    const { f } = fake(code);
    const jf = new JellyfinClient('http://jellyfin:8096', 'adminkey', f);
    await expect(jf.adminJson('/System/Info')).rejects.toMatchObject({ status: 502 });
    await expect(jf.userFetch('tok', 'dev', '/Users/Me')).rejects.toMatchObject({ status: 502 });
    await expect(jf.authenticateByName('ada', 'pw', 'dev')).rejects.toMatchObject({ status: 502 });
    expect(await jf.ping()).toBe(false);
  });
  it('a 304 (not modified) is passed through', async () => {
    const { f } = fake(304);
    const res = await new JellyfinClient('http://jellyfin:8096', 'adminkey', f).userFetch('tok', 'dev', '/Items/x/Images/Primary');
    expect(res.status).toBe(304);
  });
});

describe('request service client', () => {
  it('sends with redirect: manual and treats a redirect as an error', async () => {
    const ok = fake(200);
    await new SeerrClient('http://requests:5055', 'key', ok.f).json('/status');
    expect(ok.seen[0]!.redirect).toBe('manual');
    for (const code of [301, 302, 307, 308]) {
      const r = fake(code);
      await expect(new SeerrClient('http://requests:5055', 'key', r.f).json('/status')).rejects.toMatchObject({ status: code });
    }
  });
});
