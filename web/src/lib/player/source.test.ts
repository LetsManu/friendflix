// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { playbackInfoBody } from './infobody';
import { jellyfinSource, recordingSource } from './source';

type Init = { method?: string; body?: string; keepalive?: boolean };
afterEach(() => vi.unstubAllGlobals());
/** fetch that answers `answer(url, init)` as JSON (status 200 unless given) and records every call */
function stub(answer: (u: string, i: Init) => { status?: number; body?: unknown } = () => ({ body: { ok: true } })) {
  const f = vi.fn(async (u: string, i: Init) => {
    const a = answer(u, i);
    const status = a.status ?? 200;
    return { status, ok: status < 400, headers: { get: () => null }, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) };
  });
  vi.stubGlobal('fetch', f);
  return f;
}
const calls = (f: ReturnType<typeof stub>) => f.mock.calls.map(([u, i]) => `${i.method ?? 'GET'} ${u}${i.body ? ` ${i.body}` : ''}`);

describe('jellyfinSource', () => {
  it('jellyfinSource sends the same /api/playback/info body as before', async () => {
    const f = stub(() => ({ body: { playSessionId: 'ps1' } }));
    const s = jellyfinSource('film-1');
    expect(s.kind).toBe('item');
    expect(Object.values(s.caps).every(Boolean)).toBe(true);
    const body = playbackInfoBody({ itemId: 'film-1', startSec: 12.5, audioIndex: 2, bps: 4_000_000, hint: 'manual', audioLang: 'de', caps: null });
    await s.request(body);
    const [u, i] = f.mock.calls[0]!;
    expect(u).toBe('/api/playback/info');
    expect(i.method).toBe('POST');
    expect(i.body).toBe(JSON.stringify(body)); // byte for byte what Player.svelte sent before the seam
  });
  it('reports go to /api/playback/<kind> with the player\'s body, keepalive kept', async () => {
    const f = stub();
    const body = { itemId: 'film-1', playSessionId: 'ps1', positionTicks: 10, isPaused: false };
    await jellyfinSource('film-1').report('stop', body, true);
    expect(f.mock.calls[0]![0]).toBe('/api/playback/stop');
    expect(f.mock.calls[0]![1].body).toBe(JSON.stringify(body));
    expect(f.mock.calls[0]![1].keepalive).toBe(true);
  });
});

describe('recordingSource', () => {
  function clock() {
    let now = 0;
    const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
    return {
      deps: {
        now: () => now,
        setInterval: (fn: () => void, ms: number) => { const id = timers.length + 1; timers.push({ fn, ms, id }); return id as unknown as ReturnType<typeof setInterval>; },
        clearInterval: (id: ReturnType<typeof setInterval>) => { const i = timers.findIndex((x) => x.id === (id as unknown as number)); if (i >= 0) timers.splice(i, 1); },
      },
      at: (ms: number) => { now = ms; },
      timers,
    };
  }
  const PLAY = { token: 'rtok-1', url: '/media/r/rtok-1/index.m3u8', growing: true, segments: 'fmp4', durationS: 600, positionS: 42, expiresAt: 0 };

  it('recordingSource reports progress at 10 s and on stop', async () => {
    const f = stub((u) => ({ body: u.endsWith('/play') ? PLAY : { ok: true } }));
    const c = clock();
    const s = recordingSource('r-1', c.deps);
    expect(s.kind).toBe('recording');
    expect(Object.values(s.caps).some(Boolean)).toBe(false);
    expect(await s.info(0)).toEqual({ url: PLAY.url, kind: 'hls', growing: true, durationS: 600, positionS: 42 });
    await s.progress(43, 'playing'); // the first report goes at once
    c.at(5_000); await s.progress(48, 'playing'); // within 10 s: held
    c.at(10_000); await s.progress(53, 'playing');
    c.at(11_000); await s.progress(54, 'paused'); // a pause always reports
    c.at(12_000); await s.progress(55, 'stopped');
    await s.stop();
    expect(calls(f)).toEqual([
      'POST /api/livetv/recordings/r-1/play {}',
      'POST /api/livetv/recordings/r-1/progress {"positionS":43}',
      'POST /api/livetv/recordings/r-1/progress {"positionS":53}',
      'POST /api/livetv/recordings/r-1/progress {"positionS":54}',
      'POST /api/livetv/recordings/r-1/progress {"positionS":55}',
      'DELETE /api/livetv/watch {"token":"rtok-1"}',
    ]);
  });

  it('beats every 20 s while it plays and stops beating on stop; a 410 beat is the gone state', async () => {
    let beat = 200;
    const f = stub((u) => (u.endsWith('/play') ? { body: PLAY } : u === '/api/livetv/beat' ? { status: beat, body: beat === 200 ? { ok: true, expiresAt: 0 } : { error: 'gone' } } : { body: { ok: true } }));
    const c = clock();
    const s = recordingSource('r-1', c.deps);
    const gone = vi.fn();
    s.onGone = gone;
    await s.info(0);
    expect(c.timers.map((x) => x.ms)).toEqual([20_000]);
    c.timers[0]!.fn();
    await vi.waitFor(() => expect(calls(f)).toContain('POST /api/livetv/beat {"token":"rtok-1"}'));
    beat = 410;
    c.timers[0]!.fn();
    await vi.waitFor(() => expect(gone).toHaveBeenCalledTimes(1));
    await s.stop();
    expect(c.timers).toEqual([]);
  });

  it('an AirPlay mint asks for via airplay and ends the token it replaces', async () => {
    let n = 0;
    const f = stub((u) => (u.endsWith('/play') ? { body: { ...PLAY, token: `rtok-${++n}`, url: `/media/r/rtok-${n}/index.m3u8` } } : { body: { ok: true } }));
    const c = clock();
    const s = recordingSource('r-1', c.deps);
    await s.info(0);
    expect((await s.info(30, { via: 'airplay' })).url).toBe('/media/r/rtok-2/index.m3u8');
    expect(c.timers.map((x) => x.ms)).toEqual([20_000]); // one heartbeat, for the new token
    c.timers[0]!.fn();
    await s.stop();
    expect(calls(f)).toEqual([
      'POST /api/livetv/recordings/r-1/play {}',
      'POST /api/livetv/recordings/r-1/play {"via":"airplay"}',
      'DELETE /api/livetv/watch {"token":"rtok-1"}',
      'POST /api/livetv/beat {"token":"rtok-2"}',
      'DELETE /api/livetv/watch {"token":"rtok-2"}',
    ]);
  });

  it('a recording that is gone answers the gone state from /play', async () => {
    stub(() => ({ status: 404, body: { error: 'not_found' } }));
    const s = recordingSource('r-x', clock().deps);
    await expect(s.info(0)).rejects.toMatchObject({ gone: true });
  });
});
