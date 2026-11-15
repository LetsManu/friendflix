// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api';
import { consumeAutoplay, noteInteraction } from '#lib/stillwatching';
import { LiveCastError, PROGRESS_MS } from './engine';
import { recCastMedia } from './liveInfo';
import { flush, handoff, idle, playing, settle, setup, T0, type Env } from '../../test-utils/fake-cast-engine';

/** Recordings on the Chromecast (Phase 3 Task 10, spec §15.7): `loadRecording` mints a `chromecast` rec token and loads `/media/r/…` */
const ORIGIN = 'https://friend.example.com';
const meta = { title: 'Die Leuchtturmwärter', subtitle: 'Nordlicht TV', logo: null };
beforeEach(() => { noteInteraction(T0); consumeAutoplay(); });
const connected = (env: Env) => env.state.set({ ...idle });

describe('cast engine: recordings', () => {
  it('cast a recording loads /media/r with the right segment format', async () => {
    const env = setup();
    connected(env);
    await env.engine.loadRecording('r1', { startS: 100, ...meta });
    const play = env.calls.filter((c) => c.path === '/api/livetv/recordings/r1/play');
    expect(play).toHaveLength(1);
    expect(play[0]!.init).toMatchObject({ method: 'POST', body: { via: 'chromecast' } });
    expect(env.liveLoads).toEqual([{
      contentId: `${ORIGIN}/media/r/rtok-r1-1/index.m3u8`, contentType: 'application/x-mpegURL', streamType: 'BUFFERED', hlsSegmentFormat: 'fmp4', startTime: 100,
      metadata: { title: 'Die Leuchtturmwärter', subtitle: 'Nordlicht TV', images: [] }, customData: { ui: { live: false } },
    }]);
    // the bar: not live, a progress line; the recording is named
    expect(get(env.out)).not.toHaveProperty('isLive');
    expect(get(env.out)).toMatchObject({ kind: 'chromecast', itemId: 'rec:r1', title: 'Die Leuchtturmwärter', rec: { recordingId: 'r1', growing: false }, duration: 2700 });
    // a TS recording says so explicitly; a growing one is an EVENT playlist (LIVE on the receiver), from the saved position by default
    const ts = setup();
    connected(ts);
    ts.recAnswers.r2 = async () => ({ token: 'rt2', url: '/media/r/rt2/index.m3u8', growing: true, segments: 'ts', durationS: 600, positionS: 30, expiresAt: T0 + 3_600_000 });
    await ts.engine.loadRecording('r2', meta);
    expect(ts.liveLoads[0]).toMatchObject({ streamType: 'LIVE', hlsSegmentFormat: 'ts', startTime: 30 });
  });

  it('reports the receiver\'s position as progress, and the stop ends the token', async () => {
    const env = setup();
    connected(env);
    await env.engine.loadRecording('r1', meta);
    env.state.set(playing({ contentId: env.liveLoads[0]!.contentId, duration: 2700, currentTime: 120 }));
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'playing', position: 120, duration: 2700 });
    await env.advance(PROGRESS_MS);
    expect(env.recProgress().at(-1)).toEqual({ positionS: 120, via: 'chromecast' });
    env.engine.seek(300);
    expect(env.cast.castSeek).toHaveBeenCalledWith(300);
    await env.engine.stop();
    expect(env.liveStops()).toEqual(['rtok-r1-1']);
    expect(get(env.out)).toBeNull();
    // nothing of the film machinery
    expect(env.reports()).toEqual([]);
    expect(env.tokenPosts()).toEqual([]);
  });

  it('the cast beats its token every 20 s while it holds it, also paused (a BUFFERED receiver fetches nothing), and stops with the cast', async () => {
    const env = setup();
    connected(env);
    await env.engine.loadRecording('r1', meta);
    env.state.set(playing({ contentId: env.liveLoads[0]!.contentId, duration: 2700, currentTime: 120, paused: true }));
    await flush();
    const beats = () => env.calls.filter((c) => c.path === '/api/livetv/beat').map((c) => c.init.body);
    await env.advance(20_000);
    expect(beats()).toEqual([{ token: 'rtok-r1-1' }]);
    await env.advance(40_000);
    expect(beats()).toHaveLength(3);
    // its progress names the TV (the hand-off row then says so, B-M3)
    expect(env.recProgress().at(-1)).toEqual({ positionS: 120, via: 'chromecast' });
    await env.engine.stop();
    await env.advance(60_000);
    expect(beats()).toHaveLength(3);
  });

  it('a live channel cast beats its token too', async () => {
    const env = setup();
    connected(env);
    await env.engine.loadLive('ch-nord');
    env.state.set(playing({ contentId: env.liveLoads[0]!.contentId, duration: 0, currentTime: 0 }));
    await flush();
    await env.advance(20_000);
    expect(env.calls.filter((c) => c.path === '/api/livetv/beat').map((c) => c.init.body)).toEqual([{ token: 'tok-ch-nord-1' }]);
  });

  it('a beat answered 410 ends the cast here (the token was revoked: the recording was deleted)', async () => {
    const env = setup();
    connected(env);
    await env.engine.loadRecording('r1', meta);
    env.state.set(playing({ contentId: env.liveLoads[0]!.contentId, duration: 2700, currentTime: 10 }));
    await flush();
    const orig = env.api.getMockImplementation()!;
    env.api.mockImplementation(async (path: string, init?: Parameters<typeof orig>[1]) => { if (path === '/api/livetv/beat') throw new ApiError(410, { error: 'gone' }); return orig(path, init); });
    await env.advance(20_000);
    await flush();
    expect(get(env.out)).toBeNull();
  });

  it('a recording that is gone or not started yet rejects typed; nothing is loaded', async () => {
    for (const [status, body, code] of [[404, { error: 'not_found' }, 'not_found'], [409, { error: 'not_ready' }, 'not_ready']] as const) {
      const env = setup();
      connected(env);
      env.recAnswers.r9 = () => Promise.reject(new ApiError(status, body));
      const err = await env.engine.loadRecording('r9', meta).then(() => null, (e: unknown) => e);
      expect((err as LiveCastError).code).toBe(code);
      expect(env.liveLoads).toEqual([]);
      expect(get(env.out)).toBeNull();
    }
  });

  it('a title on the TV is stopped first; a receiver that cannot load the recording: its token goes again, the call rejects', async () => {
    const env = setup();
    env.state.set(playing());
    env.engine.adopt(handoff({ started: true }));
    await flush();
    await env.engine.loadRecording('r1', meta);
    await settle();
    expect(env.reports()).toEqual(['stop']);
    expect(env.deletes()).toContain('c1');
    expect(get(env.out)).toMatchObject({ itemId: 'rec:r1' });
    const bad = setup();
    connected(bad);
    bad.setLiveLoad(async () => false);
    await expect(bad.engine.loadRecording('r1', meta)).rejects.toMatchObject({ code: 'load_failed' });
    expect(bad.liveStops()).toEqual(['rtok-r1-1']);
    expect(get(bad.out)).toBeNull();
  });

  it('recCastMedia: the CAF segment format follows the answer', () => {
    expect(recCastMedia({ url: 'u', segments: 'ts', growing: false, startS: 0, title: 't', subtitle: '', logo: 'https://friend.example.com/l.png' }))
      .toMatchObject({ hlsSegmentFormat: 'ts', streamType: 'BUFFERED', metadata: { images: ['https://friend.example.com/l.png'] } });
  });
});
