// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beat, channels, favourite, nowLines, setFavouriteOrder, setLast, stopWatching, watch, type LiveChannel, type Prog } from './api';

const at = (h: number, m: number) => new Date(2026, 10, 12, h, m).toISOString();
const prog = (title: string, h: number, m: number): Prog => ({ title, start: at(h, m), end: at(h + 1, m) });
const base: LiveChannel = {
  id: 'a', number: 4, name: 'Hafenkanal', logo: null, groupId: 'g', running: true, epg: 'ok', favourite: false,
  now: prog('Die Leuchtturmwärter', 20, 15), next: prog('Wetter am Hafen', 21, 0),
};

describe('nowLines', () => {
  it('ok: the programmes with their start time', () => {
    expect(nowLines(base)).toEqual({ now: '20:15 Die Leuchtturmwärter', next: '21:00 Wetter am Hafen' });
  });
  it('ok without a following programme: next is null', () => {
    expect(nowLines({ ...base, next: undefined })).toEqual({ now: '20:15 Die Leuchtturmwärter', next: null });
  });
  it('none: Live / Kein Programm verfügbar', () => {
    expect(nowLines({ ...base, epg: 'none', now: undefined, next: undefined })).toEqual({ now: 'Live', next: 'Kein Programm verfügbar' });
  });
  it('gap: the honest gap line, the second line stays null (reserved by the caller)', () => {
    expect(nowLines({ ...base, epg: 'gap', now: undefined, next: undefined })).toEqual({ now: 'Programm gerade nicht verfügbar', next: null });
  });
  it('a push feed that is not receiving', () => {
    expect(nowLines({ ...base, receiving: false })).toEqual({ now: 'Gerade keine Übertragung', next: null });
    expect(nowLines({ ...base, receiving: true }).next).toBe('21:00 Wetter am Hafen');
  });
  it('ok but no programme in the answer behaves like none', () => {
    expect(nowLines({ ...base, now: undefined })).toEqual({ now: 'Live', next: 'Kein Programm verfügbar' });
  });
});

describe('calls', () => {
  afterEach(() => vi.unstubAllGlobals());
  type Init = { method?: string; body?: string; headers: Record<string, string>; keepalive?: boolean };
  const stub = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const f = vi.fn(async (_u: string, _i: Init) => ({
      status, ok: status < 400, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, text: async () => (body === undefined ? '' : JSON.stringify(body)),
    }));
    vi.stubGlobal('fetch', f);
    vi.stubGlobal('location', { pathname: '/live', href: '' });
    return f;
  };
  const call = (f: ReturnType<typeof stub>) => ({ url: f.mock.calls[0][0], init: f.mock.calls[0][1] });

  it('channels: sends If-None-Match, returns the list and the ETag; 304 is notModified', async () => {
    const list = { groups: [], channels: [], favourites: [], recent: [], last: null, dvrSeconds: 1800 };
    let f = stub(200, list, { etag: '"x1"' });
    expect(await channels('"old"')).toEqual({ notModified: false, list, etag: '"x1"' });
    expect(call(f).url).toBe('/api/livetv/channels');
    expect(call(f).init.headers['if-none-match']).toBe('"old"');
    stub(304, undefined);
    expect(await channels('"x1"')).toEqual({ notModified: true });
    f = stub(200, list);
    expect(await channels()).toEqual({ notModified: false, list, etag: null });
    expect(call(f).init.headers['if-none-match']).toBeUndefined();
  });
  it('channels: an error status throws', async () => {
    stub(500, { error: 'boom' });
    await expect(channels()).rejects.toMatchObject({ status: 500 });
  });
  it('channels: a 401 ends the session the way api() does (same redirect, never resolves), a reauth 401 does not', async () => {
    const loc = { pathname: '/live', href: '' };
    stub(401, { error: 'unauthorized' });
    vi.stubGlobal('location', loc);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    let settled = false;
    void channels().then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(loc.href).toBe('/auth/login'));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    stub(401, { error: 'reauth_required' });
    await expect(channels()).rejects.toMatchObject({ status: 401 });
  });
  it('watch: the answer, or the typed refusal', async () => {
    const answer = { token: 't', url: '/media/l/t/index.m3u8', expiresAt: 1, dvrSeconds: 1800, mode: 'remux', channel: { id: 'a', number: 4, name: 'Hafenkanal', logo: null } };
    const f = stub(200, answer);
    expect(await watch('a', 'chromecast')).toEqual({ ok: true, answer });
    expect(call(f).url).toBe('/api/livetv/channels/a/watch');
    expect(JSON.parse(call(f).init.body!)).toEqual({ via: 'chromecast' });
    const running = [{ id: 'b', number: 2, name: 'Bergblick Sport', logo: null }];
    stub(503, { error: 'live_full', running });
    expect(await watch('a')).toEqual({ ok: false, error: { status: 503, error: 'live_full', running } });
    stub(503, { error: 'provider_limit', max: 2, running });
    expect(await watch('a')).toEqual({ ok: false, error: { status: 503, error: 'provider_limit', max: 2, running } });
    stub(502, { error: 'channel_unreachable' });
    expect(await watch('a')).toEqual({ ok: false, error: { status: 502, error: 'channel_unreachable' } });
    stub(409, { error: 'not_receiving' });
    expect(await watch('a')).toEqual({ ok: false, error: { status: 409, error: 'not_receiving' } });
    stub(409, { error: 'stopped_by_admin' });
    expect(await watch('a')).toEqual({ ok: false, error: { status: 409, error: 'stopped_by_admin' } });
    stub(429, { error: 'max_streams', max: 3 });
    expect(await watch('a')).toEqual({ ok: false, error: { status: 429, error: 'max_streams', max: 3 } });
    stub(403, { error: 'forbidden' });
    expect(await watch('a')).toEqual({ ok: false, error: { status: 403, error: 'forbidden' } });
    stub(404, { error: 'livetv_off' });
    expect(await watch('a')).toEqual({ ok: false, error: { status: 404, error: 'livetv_off' } });
    stub(404, { error: 'not_found' });
    expect(await watch('a')).toEqual({ ok: false, error: { status: 404, error: 'not_found' } });
  });
  it('watch rethrows what it does not know', async () => {
    stub(500, { error: 'boom' });
    await expect(watch('a')).rejects.toMatchObject({ status: 500 });
  });
  it('beat, stopWatching, setLast, favourite, setFavouriteOrder', async () => {
    let f = stub(200, { ok: true, expiresAt: 5 });
    expect(await beat('t')).toEqual({ ok: true, expiresAt: 5 });
    expect(call(f).init.method).toBe('POST');
    expect(call(f).url).toBe('/api/livetv/beat');
    expect(JSON.parse(call(f).init.body!)).toEqual({ token: 't' });
    f = stub(200, { ok: true });
    await stopWatching('t', true);
    expect(call(f).init.method).toBe('DELETE');
    expect(call(f).url).toBe('/api/livetv/watch');
    expect(call(f).init.keepalive).toBe(true);
    f = stub(200, { ok: true });
    await setLast('a');
    expect(call(f).init.method).toBe('PUT');
    expect(call(f).url).toBe('/api/livetv/last');
    expect(JSON.parse(call(f).init.body!)).toEqual({ id: 'a' });
    f = stub(200, { ok: true });
    await favourite('a', true);
    expect(call(f).init.method).toBe('POST');
    expect(call(f).url).toBe('/api/livetv/favourites/a');
    f = stub(200, { ok: true });
    await favourite('a b', false);
    expect(call(f).init.method).toBe('DELETE');
    expect(call(f).url).toBe('/api/livetv/favourites/a%20b');
    f = stub(200, { ok: true });
    await setFavouriteOrder(['c', 'a']);
    expect(call(f).init.method).toBe('PUT');
    expect(call(f).url).toBe('/api/livetv/favourites');
    expect(JSON.parse(call(f).init.body!)).toEqual({ ids: ['c', 'a'] });
  });
});
