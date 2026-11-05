// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fetchProbeTarget } from './target';

const json = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body });
function setup(over: Record<string, () => unknown> = {}, info: Record<string, unknown> = {}) {
  const calls: { path: string; init: any }[] = [];
  const answers: Record<string, () => unknown> = {
    '/api/me': () => json(200, { tv: true, csrfToken: 'tok-1' }),
    '/api/library/resume': () => json(200, { items: [{ id: 'i1' }] }),
    '/api/library/items?types=Movie,Episode&sort=DateCreated&desc=true&limit=1': () => json(200, { items: [{ id: 'new1' }] }),
    '/api/playback/info': () => json(200, { playSessionId: 'ps', mediaSourceId: 'ms', directUrl: '/media/x.mp4', hlsUrl: '/h.m3u8', ...info }),
    '/api/playback/stop': () => json(204, null),
    ...over,
  };
  const fetchImpl = (async (path: string, init: any) => { calls.push({ path, init }); return answers[path]!(); }) as unknown as typeof fetch;
  const win = { location: { origin: 'https://friend.example.com' } };
  return { calls, win, fetchImpl, body: (path: string) => JSON.parse(calls.find((c) => c.path === path)!.init.body) };
}

describe('fetchProbeTarget', () => {
  it('takes the CSRF token from its own /api/me answer and sends the title\'s resume point in the stop report', async () => {
    const s = setup({}, { resumeTicks: 4_200_000_000 });
    const t = await fetchProbeTarget(s.win, s.fetchImpl);
    expect(t.url).toBe('https://friend.example.com/media/x.mp4');
    expect(t.hlsUrl).toBe('https://friend.example.com/h.m3u8');
    expect(s.calls.find((c) => c.path === '/api/playback/info')!.init.headers['x-csrf-token']).toBe('tok-1');
    await t.report();
    const stop = s.calls.find((c) => c.path === '/api/playback/stop')!;
    expect(stop.init.headers['x-csrf-token']).toBe('tok-1');
    expect(s.body('/api/playback/stop')).toMatchObject({ itemId: 'i1', playSessionId: 'ps', positionTicks: 4_200_000_000, playMethod: 'DirectPlay' });
  });
  it('sends 0 when the info has no resume point', async () => {
    const s = setup();
    await (await fetchProbeTarget(s.win, s.fetchImpl)).report();
    expect(s.body('/api/playback/stop').positionTicks).toBe(0);
  });
  it('without a direct URL plays the converted stream and reports Transcode', async () => {
    const s = setup({}, { directUrl: undefined });
    const t = await fetchProbeTarget(s.win, s.fetchImpl);
    expect(t.url).toBe('https://friend.example.com/h.m3u8');
    await t.report();
    expect(s.body('/api/playback/stop').playMethod).toBe('Transcode');
  });
  it('an empty Continue watching list falls back to the newest film or episode', async () => {
    const s = setup({ '/api/library/resume': () => json(200, { items: [] }) });
    await fetchProbeTarget(s.win, s.fetchImpl);
    expect(s.body('/api/playback/info').itemId).toBe('new1');
  });
  it('sends the caps block with the info request only when given', async () => {
    const a = setup();
    await fetchProbeTarget(a.win, a.fetchImpl);
    expect(a.body('/api/playback/info')).toEqual({ itemId: 'i1', reasonHint: 'network' });
    const b = setup();
    await fetchProbeTarget(b.win, b.fetchImpl, { caps: { client: 'webos' } });
    expect(b.body('/api/playback/info')).toEqual({ itemId: 'i1', reasonHint: 'network', caps: { client: 'webos' } });
  });
  it('maps 409 profile_required / profile_changed to code profile without any redirect', async () => {
    for (const [path, error] of [['/api/library/resume', 'profile_required'], ['/api/playback/info', 'profile_changed']] as const) {
      const s = setup({ [path]: () => json(409, { error }) });
      await expect(fetchProbeTarget(s.win, s.fetchImpl)).rejects.toMatchObject({ code: 'profile' });
    }
  });
  it('an unpaired TV rejects with code unpaired', async () => {
    const s = setup({ '/api/me': () => json(200, { tv: false }) });
    await expect(fetchProbeTarget(s.win, s.fetchImpl)).rejects.toMatchObject({ code: 'unpaired' });
  });
  it('an empty library rejects without a code', async () => {
    const s = setup({ '/api/library/resume': () => json(200, { items: [] }), '/api/library/items?types=Movie,Episode&sort=DateCreated&desc=true&limit=1': () => json(200, { items: [] }) });
    const e = await fetchProbeTarget(s.win, s.fetchImpl).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as { code?: string }).code).toBeUndefined();
  });
});
