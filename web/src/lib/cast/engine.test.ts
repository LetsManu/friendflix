// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, clearItemCache, primeItem, secToTicks, type Item } from '#lib/api';
import type { CastInfo } from '#lib/cast';
import { COUNTDOWN_SECONDS } from '#lib/player/nextup';
import { consumeAutoplay, noteAutoplay, noteInteraction, shouldAsk } from '#lib/stillwatching';
import { DEFAULT_PREFS } from '#lib/stores';
import { ADVANCE_WAIT_MS, ENDED_HIDE_MS, ENDED_IDLE_MS, PROGRESS_MS, RENEW_BEFORE_MS, UNPINNED_RETRY_MS, type PlayerHandoff } from './engine';
import { ci, deferred, flush, handoff, hex, items, playing, playingSession, setup, T0, type Env } from '../../test-utils/fake-cast-engine';

describe('cast engine: adopt (Chromecast)', () => {
  it('adopt mirrors the receiver and reports start once, progress every 10 s and on pause', async () => {
    const env = setup();
    env.engine.adopt(handoff());
    expect(get(env.out)).toMatchObject({ kind: 'chromecast', device: 'Wohnzimmer-TV', itemId: 'film', title: 'Film', posterId: 'film', state: 'connecting', buffering: true });
    env.state.set(playing({ state: 'buffering' }));
    expect(env.reports()).toEqual([]);
    expect(get(env.out)).toMatchObject({ position: 60, duration: 1800, paused: false, buffering: true });
    env.state.set(playing({ currentTime: 61 }));
    expect(get(env.out)).toMatchObject({ position: 61, buffering: false, state: 'playing' });
    env.state.set(playing({ currentTime: 62 }));
    expect(env.reports()).toEqual(['start']);
    expect(env.calls[0]!.init.body).toEqual({ itemId: 'film', playSessionId: 'ps-c1', mediaSourceId: 'ms-c1', positionTicks: secToTicks(61), isPaused: false, audioIndex: 1, playMethod: 'Transcode' });
    await env.advance(PROGRESS_MS);
    expect(env.reports()).toEqual(['start', 'progress']);
    env.state.set(playing({ currentTime: 75, paused: true }));
    expect(env.reports()).toEqual(['start', 'progress', 'progress']);
    expect(env.calls[2]!.init.body).toMatchObject({ isPaused: true, positionTicks: secToTicks(75) });
    expect(get(env.out)?.paused).toBe(true);
  });

  it('adopt with started=true sends no second start', async () => {
    const env = setup();
    env.state.set({ ...playing(), deviceName: '' });
    env.engine.adopt(handoff({ started: true }));
    env.state.set({ ...playing({ currentTime: 70 }), deviceName: '' });
    expect(env.reports()).toEqual([]);
    expect(get(env.out)).toMatchObject({ state: 'playing', device: 'Chromecast', position: 70 });
  });

  it('a second adopt replaces the first without leaking listeners', async () => {
    const env = setup();
    env.engine.adopt(handoff());
    env.engine.adopt(handoff({ itemId: 'other', cast: ci('c2') }));
    expect(env.subs()).toBe(1);
    expect(env.events.size).toBe(1);
    expect(env.hides.size).toBe(1);
    expect(get(env.out)?.itemId).toBe('other');
  });

  it('an AirPlay hand-off without its element and controller is not adopted', () => {
    const env = setup();
    env.engine.adopt(handoff({ kind: 'airplay' }));
    expect(get(env.out)).toBeNull();
    expect(get(env.engine.airState)).toBeNull();
  });

  it('playPause, seek, skip and subtitles drive the receiver; seek reports progress', async () => {
    const env = setup();
    await playingSession(env);
    env.engine.playPause();
    expect(env.cast.castPlayPause).toHaveBeenCalledTimes(1);
    env.engine.seek(300);
    expect(env.cast.castSeek).toHaveBeenLastCalledWith(300);
    expect(get(env.out)?.position).toBe(300);
    expect(env.reports()).toEqual(['progress']);
    expect(env.calls.at(-1)!.init.body.positionTicks).toBe(secToTicks(300));
    env.engine.skip(-10);
    expect(env.cast.castSeek).toHaveBeenLastCalledWith(290);
    env.engine.skip(5000);
    expect(env.cast.castSeek).toHaveBeenLastCalledWith(1800);
    env.engine.seek(-5);
    expect(env.cast.castSeek).toHaveBeenLastCalledWith(0);
    env.engine.setSubtitle(2);
    expect(env.cast.castSetSubtitle).toHaveBeenLastCalledWith(2);
  });

  it('controls without a session do nothing', async () => {
    const env = setup();
    env.engine.playPause(); env.engine.seek(10); env.engine.skip(10); env.engine.setSubtitle(1); env.engine.reconnect(); env.engine.release();
    await env.engine.playOnTv('film');
    await env.engine.refresh();
    await env.engine.stop();
    await env.engine.next();
    expect(env.calls).toEqual([]);
    expect(env.cast.castPlayPause).not.toHaveBeenCalled();
    expect(env.cast.castSeek).not.toHaveBeenCalled();
    expect(env.cast.castStop).not.toHaveBeenCalled();
  });

  it('nothing is touched before adopt (no listeners, no timers)', () => {
    const env = setup();
    expect(env.subs()).toBe(0);
    expect(env.cast.onCastEvent).not.toHaveBeenCalled();
    expect(env.deps.onPageHide).not.toHaveBeenCalled();
    expect(env.timers.set).not.toHaveBeenCalled();
    expect(env.api).not.toHaveBeenCalled();
    expect(get(env.out)).toBeNull();
  });
});

describe('cast engine: playOnTv (Chromecast)', () => {
  it('playOnTv: stop for the old title, old token revoked, new token loaded, metadata from the item', async () => {
    const env = setup();
    await playingSession(env);
    const p = env.engine.playOnTv('ep2', 0);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'connecting' });
    await p;
    expect(env.order).toEqual(['POST /api/playback/stop', 'DELETE /api/cast/session/c1', 'POST /api/cast/session']);
    expect(env.calls[0]!.init.body).toMatchObject({ itemId: 'film', playSessionId: 'ps-c1' });
    expect(env.calls[2]!.init.body).toEqual({ itemId: 'ep2', startTicks: 0, maxBitrate: 8_000_000 });
    expect(env.loads).toEqual([{ info: expect.objectContaining({ castId: 'n1' }), sub: -1 }]);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', seriesId: 's1', posterId: 'ep2', isEpisode: true, title: 'Bright Valley', subtitle: 'S1:F2 Second', state: 'connecting', position: 0, duration: 1800 });
    // the receiver still reports the old title until it is loaded: no start yet, then start for the new token
    env.state.set(playing({ currentTime: 1 }));
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.lastReport()!.init.body).toEqual({ itemId: 'ep2', playSessionId: 'ps-n1', mediaSourceId: 'ms-n1', positionTicks: secToTicks(1), isPaused: false, audioIndex: undefined, playMethod: 'Transcode' });
    expect(get(env.out)?.state).toBe('playing');
  });

  it('playOnTv without startAt sends no startTicks (server resume position)', async () => {
    const env = setup({ prefs: { quality: 4_000_000 } });
    await playingSession(env, { maxBitrate: undefined });
    await env.engine.playOnTv('film');
    const body = env.tokenPosts()[0]!.init.body;
    expect('startTicks' in body ? body.startTicks : undefined).toBeUndefined();
    expect(body.maxBitrate).toBe(4_000_000); // no quality chosen in the player: the saved default
  });

  it('a receiver that keeps reporting the old title during the switch changes nothing', async () => {
    const env = setup();
    await playingSession(env);
    const load = deferred<boolean>();
    env.setLoad(() => load.promise);
    const p = env.engine.playOnTv('other', 0);
    await flush();
    env.state.set(playing({ currentTime: 900 }));
    expect(get(env.out)?.position).toBe(0);
    expect(env.reports()).toEqual(['stop']);
    load.resolve(true);
    await p;
    expect(env.reports()).toEqual(['stop']);
    env.state.set(playing({ currentTime: 1 })); // the receiver reports the loaded title
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(get(env.out)?.position).toBe(1);
  });

  it('last playOnTv wins', async () => {
    const env = setup();
    await playingSession(env);
    const a = deferred<CastInfo>(), b = deferred<CastInfo>();
    env.posts.push(() => a.promise, () => b.promise);
    const p1 = env.engine.playOnTv('film', 0);
    await flush(); // the first token request is in flight
    const p2 = env.engine.playOnTv('ep2', 0);
    await flush();
    b.resolve(ci('cB'));
    await flush();
    a.resolve(ci('cA'));
    await Promise.all([p1, p2]);
    env.state.set(playing({ currentTime: 2 }));
    expect(env.deletes()).toEqual(['c1', 'cA']);
    expect(env.loads.map((l) => l.info.castId)).toEqual(['cB']);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', title: 'Bright Valley' });
    expect(env.reports().filter((r) => r === 'start')).toHaveLength(1);
    expect(env.calls.find((c) => c.path === '/api/playback/start')!.init.body.playSessionId).toBe('ps-cB');
  });

  it('a newer playOnTv while the older one loads on the receiver revokes the older token', async () => {
    const env = setup();
    await playingSession(env);
    const load = deferred<boolean>();
    env.setLoad(() => load.promise);
    const p1 = env.engine.playOnTv('film', 0);
    await flush();
    env.setLoad(async () => true);
    const p2 = env.engine.playOnTv('ep2', 0);
    load.resolve(true);
    await Promise.all([p1, p2]);
    expect(env.deletes()).toEqual(['c1', 'n1']);
    expect(env.loads.map((l) => l.info.castId)).toEqual(['n1', 'n2']);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'connecting' });
  });

  it('a failed switch does not retry', async () => {
    const env = setup();
    await playingSession(env);
    env.posts.push(() => Promise.reject(new ApiError(429, { error: 'max_streams', max: 2 })));
    await env.engine.playOnTv('ep2', 0);
    await env.advance(60_000);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.toast.mock.calls).toEqual([['error', 'Maximal 2 gleichzeitige Streams erlaubt.']]);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', title: 'Bright Valley', state: 'reconnect' });
    expect(env.loads).toEqual([]);
  });

  it('token errors use the player texts (transcoding not allowed, other)', async () => {
    const env = setup();
    await playingSession(env);
    env.posts.push(() => Promise.reject(new ApiError(403, { error: 'transcoding_disabled' })), () => Promise.reject(new Error('net')));
    await env.engine.playOnTv('ep2', 0);
    env.engine.reconnect();
    await flush();
    expect(env.toast.mock.calls.map((c) => c[1])).toEqual(['Chromecast braucht Transcoding – mit deiner Rolle nicht erlaubt.', 'Übertragung auf Chromecast fehlgeschlagen.']);
  });

  it('receiver load failure -> failed with toast', async () => {
    const env = setup();
    await playingSession(env);
    env.setLoad(async () => false);
    await env.engine.playOnTv('film', 0);
    expect(env.toast).toHaveBeenCalledWith('error', '„Film“ kann auf Wohnzimmer-TV nicht abgespielt werden.');
    expect(get(env.out)).toMatchObject({ itemId: 'film', state: 'failed' });
    expect(env.deletes()).toEqual(['c1', 'n1']); // the unusable token does not stay live
    env.state.set(playing({ currentTime: 5 }));
    expect(env.reports()).toEqual(['stop']);
  });

  it('reconnect() after a failed token retries exactly once', async () => {
    const env = setup();
    await playingSession(env);
    env.posts.push(() => Promise.reject(new ApiError(429, { error: 'rate_limited' })));
    await env.engine.playOnTv('ep2', 30);
    env.engine.reconnect();
    env.engine.reconnect(); // a double tap while connecting does not ask twice
    await flush();
    expect(env.tokenPosts()).toHaveLength(2);
    expect(env.tokenPosts()[1]!.init.body).toEqual({ itemId: 'ep2', startTicks: secToTicks(30), maxBitrate: 8_000_000 });
    expect(get(env.out)?.state).toBe('connecting');
    env.engine.reconnect();
    await flush();
    expect(env.tokenPosts()).toHaveLength(2);
  });

  it('item metadata that cannot be loaded falls back to the cast info', async () => {
    const env = setup();
    await playingSession(env);
    env.posts.push(async () => ci('cx', { title: 'Pilot', seriesName: 'Unknown Show' }));
    await env.engine.playOnTv('missing', 0);
    expect(get(env.out)).toMatchObject({ itemId: 'missing', title: 'Unknown Show', subtitle: 'Pilot', isEpisode: true });
    env.posts.push(async () => ci('cy', { title: 'Movie X' }));
    await env.engine.playOnTv('missing2', 0);
    expect(get(env.out)).toMatchObject({ title: 'Movie X', subtitle: '', isEpisode: false });
  });

  it('session-end during playOnTv revokes the new token', async () => {
    const env = setup();
    await playingSession(env);
    const post = deferred<CastInfo>();
    env.posts.push(() => post.promise);
    const p = env.engine.playOnTv('ep2', 0);
    await flush();
    post.resolve(ci('cNew'));
    env.emit('session-end');
    await p;
    expect(env.deletes()).toEqual(['c1', 'cNew']);
    expect(get(env.out)).toBeNull();
    expect(env.loads).toEqual([]);
    expect(env.reports()).toEqual(['stop']);
  });

  it('session-end while the receiver loads: token revoked, no start, no toast', async () => {
    const env = setup();
    await playingSession(env);
    const load = deferred<boolean>();
    env.setLoad(() => load.promise);
    const p = env.engine.playOnTv('ep2', 0);
    await flush();
    env.emit('session-end');
    load.resolve(false);
    await p;
    expect(env.deletes()).toEqual(['c1', 'n1']);
    expect(get(env.out)).toBeNull();
    expect(env.toast).not.toHaveBeenCalled();
    expect(env.reports()).toEqual(['stop']);
  });

  it('a token failure after the session ended stays silent', async () => {
    const env = setup();
    await playingSession(env);
    const post = deferred<CastInfo>();
    env.posts.push(() => post.promise);
    const p = env.engine.playOnTv('ep2', 0);
    await flush();
    env.emit('session-end');
    post.reject(new ApiError(429, {}));
    await p;
    expect(env.toast).not.toHaveBeenCalled();
    expect(get(env.out)).toBeNull();
  });

  it('media-end while a switch loads is ignored', async () => {
    const env = setup();
    await playingSession(env);
    const load = deferred<boolean>();
    env.setLoad(() => load.promise);
    const p = env.engine.playOnTv('ep2', 0);
    await flush();
    env.emit('media-end');
    load.resolve(true);
    await p;
    expect(get(env.out)?.state).not.toBe('ended');
  });
});

describe('cast engine: session end, stop, pagehide (Chromecast)', () => {
  it('session-end: stop report, token revoked, session null', async () => {
    const env = setup();
    await playingSession(env);
    env.emit('session-start'); // unrelated events change nothing
    env.emit('session-end');
    await flush();
    expect(env.reports()).toEqual(['stop']);
    expect(env.deletes()).toEqual(['c1']);
    expect(get(env.out)).toBeNull();
    expect(env.subs()).toBe(0);
    expect(env.hides.size).toBe(0);
    expect(env.pending()).toBe(0);
    expect(env.cast.castStop).not.toHaveBeenCalled();
  });

  it('session-end before the receiver played sends no stop', async () => {
    const env = setup();
    env.engine.adopt(handoff());
    env.emit('session-end');
    await flush();
    expect(env.reports()).toEqual([]);
    expect(env.deletes()).toEqual(['c1']);
  });

  it('media-end: stop report at the end, ended, receiver stopped and bar gone after 5 s', async () => {
    const env = setup();
    await playingSession(env);
    env.state.set(playing({ currentTime: 1790 })); // the last seconds
    env.emit('media-end');
    await flush();
    expect(env.reports()).toEqual(['stop']);
    expect(env.calls[0]!.init.body.positionTicks).toBe(secToTicks(1800));
    expect(env.deletes()).toEqual(['c1']);
    expect(get(env.out)).toMatchObject({ state: 'ended', position: 1800, paused: true });
    env.state.set(playing({ currentTime: 3 }));
    expect(env.reports()).toEqual(['stop']);
    await env.advance(ENDED_HIDE_MS - 1);
    expect(get(env.out)).not.toBeNull();
    await env.advance(1);
    expect(env.cast.castStop).toHaveBeenCalledTimes(1);
    expect(get(env.out)).toBeNull();
    expect(env.pending()).toBe(0);
  });

  it('playOnTv after the end cancels the hide timer', async () => {
    const env = setup();
    await playingSession(env);
    env.state.set(playing({ currentTime: 1790 })); // the last seconds
    env.emit('media-end');
    await flush();
    await env.engine.playOnTv('ep2', 0);
    await env.advance(ENDED_HIDE_MS);
    expect(env.cast.castStop).not.toHaveBeenCalled();
    expect(get(env.out)?.itemId).toBe('ep2');
    expect(env.reports()).toEqual(['stop']); // no second stop for the finished title
  });

  it('stop(): stop report, revoke, castStop, null', async () => {
    const env = setup();
    await playingSession(env);
    await env.engine.stop();
    expect(env.order).toEqual(['POST /api/playback/stop', 'DELETE /api/cast/session/c1']);
    expect(env.cast.castStop).toHaveBeenCalledTimes(1);
    expect(get(env.out)).toBeNull();
    env.emit('session-end'); // the receiver's own end event after castStop
    await flush();
    expect(env.reports()).toEqual(['stop']);
    expect(env.pending()).toBe(0);
  });

  it('pagehide keeps a Chromecast cast', async () => {
    const env = setup();
    env.setQueue(() => 7);
    await playingSession(env, { itemId: 'ep1', isEpisode: true, cast: ci(hex('c1')) });
    await flush();
    expect(env.queuePosts()).toHaveLength(1); // a queued next episode lives on the receiver as well
    expect(env.hint()).toMatchObject({ castId: hex('c1'), itemId: 'ep1', device: 'Wohnzimmer-TV' });
    const before = env.calls.length;
    env.pagehide();
    env.emit('session-end'); // castLeave makes the SDK end the sender's session: no stop, no revoke
    env.emit('media-end');
    await flush();
    await env.advance(ENDED_IDLE_MS);
    const after = env.calls.slice(before);
    expect(after.filter((c) => c.path === '/api/playback/stop')).toEqual([]);
    expect(after.filter((c) => c.init.method === 'DELETE')).toEqual([]);
    expect(env.cast.castQueueRemove).not.toHaveBeenCalled();
    expect(env.cast.castStop).not.toHaveBeenCalled();
    expect(env.deps.leave).toHaveBeenCalledTimes(1);
    expect(get(env.out)).toBeNull();
    expect(env.subs()).toBe(0);
    expect(env.hides.size).toBe(0);
    expect(env.pending()).toBe(0);
    expect(env.hint()).toMatchObject({ castId: hex('c1'), itemId: 'ep1' });
    expect(env.logs.some((l) => l.tag === 'sender' && /pagehide/.test(l.text))).toBe(true);
  });

  it('pagehide with nothing live on the TV (title ended) drops the hint, still without a stop or revoke', async () => {
    const env = setup();
    await playingSession(env, { cast: ci(hex('c1')) });
    env.state.set(playing({ currentTime: 1795 }));
    env.emit('media-end');
    await flush();
    expect(get(env.out)?.state).toBe('ended');
    const before = env.calls.length;
    env.pagehide();
    await flush();
    expect(env.calls.slice(before)).toEqual([]);
    expect(env.cast.castStop).not.toHaveBeenCalled();
    expect(env.deps.leave).toHaveBeenCalledTimes(1);
    expect(env.hint()).toBeNull();
  });

  it('stop still revokes the queued token', async () => {
    const env = setup();
    env.setQueue(() => 7);
    await playingSession(env, { itemId: 'ep1', isEpisode: true, cast: ci(hex('c1')) });
    await flush();
    await env.engine.stop();
    expect(env.reports()).toEqual(['stop']);
    expect(env.deletes().sort()).toEqual([hex('c1'), 'q1']);
    expect(env.cast.castQueueRemove).toHaveBeenCalledWith(7);
    expect(env.cast.castStop).toHaveBeenCalledTimes(1);
    expect(env.deps.leave).not.toHaveBeenCalled();
    expect(env.hint()).toBeNull();
  });

  it('hint follows the live token', async () => {
    const env = setup();
    await playingSession(env, { cast: ci(hex('c1')) });
    expect(env.hint()?.castId).toBe(hex('c1'));
    env.posts.push(async () => ci(hex('c2')));
    await env.engine.playOnTv('ep2', 0);
    expect(env.hint()).toMatchObject({ castId: hex('c2'), itemId: 'ep2', device: 'Wohnzimmer-TV', exp: T0 + 60 * 60_000 });
    expect(get(env.out)?.castId).toBe(hex('c2'));
    await env.engine.stop();
    expect(env.hint()).toBeNull();
  });

  it('the hint goes with a session the TV ended', async () => {
    const env = setup();
    await playingSession(env, { cast: ci(hex('c1')) });
    env.emit('session-end');
    await flush();
    expect(env.hint()).toBeNull();
  });

  it('renews the token 10 min before expiry', async () => {
    const env = setup();
    await playingSession(env, { cast: ci('c1', { expiresAt: T0 + RENEW_BEFORE_MS + 15_000 }) });
    await env.advance(PROGRESS_MS);
    expect(env.tokenPosts()).toHaveLength(0);
    await env.advance(PROGRESS_MS);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.tokenPosts()[0]!.init.body).toEqual({ itemId: 'film', startTicks: secToTicks(60), audioIndex: 1, maxBitrate: 8_000_000 });
    expect(env.deletes()).toEqual(['c1']);
    expect(env.loads).toEqual([{ info: expect.objectContaining({ castId: 'n1' }), sub: -1 }]);
    expect(get(env.out)).toMatchObject({ itemId: 'film', title: 'Film' });
    expect(env.item).not.toHaveBeenCalled();
  });

  it('a renewal keeps a paused TV paused (no autoplay on load, start reported as paused)', async () => {
    const env = setup();
    await playingSession(env, { cast: ci('c1', { expiresAt: T0 + RENEW_BEFORE_MS + 5_000 }) });
    env.state.set(playing({ state: 'paused', paused: true }));
    await env.advance(PROGRESS_MS);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.cast.loadOnCast).toHaveBeenCalledWith(expect.objectContaining({ castId: 'n1' }), -1, false);
    expect(get(env.out)).toMatchObject({ paused: true });
    env.state.set(playing({ state: 'paused', paused: true }));
    expect(get(env.out)).toMatchObject({ state: 'playing', paused: true, buffering: false });
    const starts = env.calls.filter((c) => c.path === '/api/playback/start');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.init.body).toMatchObject({ playSessionId: 'ps-n1', isPaused: true });
    expect(env.cast.castPlayPause).not.toHaveBeenCalled();
  });

  it('a renewal of a playing TV loads with autoplay', async () => {
    const env = setup();
    await playingSession(env, { cast: ci('c1', { expiresAt: T0 + RENEW_BEFORE_MS + 5_000 }) });
    await env.advance(PROGRESS_MS);
    expect(env.cast.loadOnCast).toHaveBeenCalledWith(expect.objectContaining({ castId: 'n1' }), -1, true);
    env.state.set(playing({ state: 'paused', paused: true })); // not the receiver's answer to an autoplay load: no start yet
    expect(env.reports()).not.toContain('start');
  });

  it('refresh() takes a new audio track / quality and keeps the subtitle', async () => {
    const env = setup();
    await playingSession(env, { subIndex: 3 });
    await env.engine.refresh({ audioIndex: 2, maxBitrate: 2_000_000 });
    expect(env.tokenPosts()[0]!.init.body).toEqual({ itemId: 'film', startTicks: secToTicks(60), audioIndex: 2, maxBitrate: 2_000_000 });
    expect(env.loads[0]!.sub).toBe(3);
    env.state.set(playing({ currentTime: 61 }));
    expect(env.calls.find((c) => c.path === '/api/playback/start')!.init.body.audioIndex).toBe(2);
  });

  it('a failed refresh can be retried with reconnect()', async () => {
    const env = setup();
    await playingSession(env);
    env.posts.push(() => Promise.reject(new Error('net')));
    await env.engine.refresh();
    expect(get(env.out)).toMatchObject({ state: 'reconnect', title: 'Film' });
    env.engine.reconnect();
    await flush();
    expect(env.tokenPosts()).toHaveLength(2);
    expect(env.tokenPosts()[1]!.init.body.startTicks).toBe(secToTicks(60));
  });

  it('release() clears a failed session without castStop', async () => {
    const env = setup();
    await playingSession(env);
    env.engine.release(); // not failed: nothing happens
    expect(get(env.out)).not.toBeNull();
    env.setLoad(async () => false);
    await env.engine.playOnTv('film', 0);
    env.engine.release();
    expect(get(env.out)).toBeNull();
    expect(env.cast.castStop).not.toHaveBeenCalled();
    expect(env.subs()).toBe(0);
    expect(env.pending()).toBe(0);
  });
});

describe('cast engine: tracks and device picker for an attached Player', () => {
  const audio = [{ index: 1, title: 'Deutsch', language: 'deu', isDefault: true }, { index: 2, title: 'English', language: 'eng', isDefault: false }];
  const subs = [{ index: 3, title: 'Deutsch (SDH)', language: 'deu' }];

  it('the session keeps the hand-off\'s tracks; refresh and setSubtitle move the current indexes', async () => {
    const env = setup();
    await playingSession(env, { audioTracks: audio, subtitles: subs, audioIndex: 1, subIndex: -1 });
    expect(get(env.out)).toMatchObject({ audioTracks: audio, subtitles: subs, audioIndex: 1, subIndex: -1 });
    await env.engine.refresh({ audioIndex: 2 });
    expect(get(env.out)).toMatchObject({ audioTracks: audio, audioIndex: 2 });
    env.engine.setSubtitle(3);
    expect(get(env.out)?.subIndex).toBe(3);
  });

  it('a hand-off without track lists has empty lists', async () => {
    const env = setup();
    await playingSession(env);
    expect(get(env.out)).toMatchObject({ audioTracks: [], subtitles: [], audioIndex: 1, subIndex: -1 });
  });

  it('another title: no audio list (the default track), subtitles from its cast token, subtitle off', async () => {
    const env = setup();
    await playingSession(env, { audioTracks: audio, subtitles: subs, subIndex: 3 });
    env.posts.push(async () => ci('n1', { subtitles: [{ index: 5, title: 'Français', language: 'fra', url: '/media/c/n1/sub5.vtt' }] }));
    await env.engine.playOnTv('other', 0);
    expect(get(env.out)).toMatchObject({ itemId: 'other', audioTracks: [], subtitles: [{ index: 5, title: 'Français', language: 'fra' }], audioIndex: undefined, subIndex: -1 });
    expect(get(env.out)!.subtitles[0]).not.toHaveProperty('url');
  });

  it('pick() is a no-op for Chromecast and without a session', async () => {
    const env = setup();
    env.engine.pick();
    await playingSession(env);
    env.engine.pick();
    expect(env.calls).toEqual([]);
    expect(get(env.out)?.state).toBe('playing');
  });
});

describe('cast engine: failures of fire-and-forget requests', () => {
  it('a rejected report or revoke is swallowed', async () => {
    const env = setup();
    const record = env.api.getMockImplementation()!;
    env.api.mockImplementation(async (path, init) => { await record(path, init); throw new Error('offline'); });
    await playingSession(env);
    await env.engine.stop();
    await flush();
    expect(env.reports()).toEqual(['stop']);
    expect(env.deletes()).toEqual(['c1']);
  });

  it('adopting the same token again sends no stop and keeps it live', async () => {
    const env = setup();
    await playingSession(env);
    env.engine.adopt(handoff({ started: true }));
    await flush();
    expect(env.calls).toEqual([]);
    expect(env.subs()).toBe(1);
  });

  it('adopting another token stops and revokes the previous one', async () => {
    const env = setup();
    await playingSession(env);
    env.engine.adopt(handoff({ cast: ci('c2'), started: true }));
    await flush();
    expect(env.order).toEqual(['POST /api/playback/stop', 'DELETE /api/cast/session/c1']);
  });
});

describe('cast engine: the cast log', () => {
  beforeEach(() => { noteInteraction(T0); consumeAutoplay(); });
  const texts = (env: Env, tag: string) => env.logs.filter((l) => l.tag === tag).map((l) => `${l.level} ${l.text}`);

  it('adopt, load (label and start position), first playing with the time since load, renewal with its validity, end', async () => {
    const env = setup();
    await playingSession(env, { cast: ci('c1', { expiresAt: T0 + RENEW_BEFORE_MS + 5_000 }) });
    expect(texts(env, 'session')).toEqual(['info session adopted · chromecast · film']);
    env.posts.push(async () => ci('c2', { expiresAt: T0 + 3 * 60 * 60_000 }));
    await env.advance(PROGRESS_MS);
    expect(texts(env, 'load')).toEqual(['info film · from 1:00']);
    expect(texts(env, 'renew')).toEqual(['info token renewed · valid for 180 min']);
    await env.advance(1_900);
    env.state.set(playing({ currentTime: 61, contentId: '/media/c/c2/master.m3u8' }));
    expect(texts(env, 'receiver')).toEqual(['info film playing after 1900 ms']);
    await env.engine.playOnTv('ep2', 4000);
    expect(texts(env, 'load').at(-1)).toBe('info S1 E2 · from 1:06:40');
    await env.engine.stop();
    expect(texts(env, 'session').at(-1)).toBe('info cast ended · stopped');
    expect(env.logs.every((l) => !/c1|c2|ep2|Wohnzimmer|media\/c/.test(l.text))).toBe(true);
  });

  it('a stall over 2 s and its recovery; a stall the receiver reports nothing more for is logged by the loop', async () => {
    const env = setup();
    await playingSession(env);
    env.state.set(playing({ state: 'buffering' }));
    await env.advance(1_000);
    env.state.set(playing({ currentTime: 61 }));
    expect(texts(env, 'network')).toEqual([]); // a short one is no entry
    env.state.set(playing({ state: 'buffering' }));
    await env.advance(3_000);
    env.state.set(playing({ state: 'buffering', currentTime: 61.1 }));
    env.state.set(playing({ currentTime: 62 }));
    expect(texts(env, 'network')).toEqual(['warn TV buffering for more than 2 s', 'info TV playing again after 3.0 s']);
    env.state.set(playing({ state: 'buffering' }));
    await env.advance(PROGRESS_MS);
    expect(texts(env, 'network').at(-1)).toBe('warn TV buffering for more than 2 s');
    await env.advance(500);
    env.state.set(playing({ currentTime: 70 }));
    expect(texts(env, 'network').slice(2)).toEqual(['warn TV buffering for more than 2 s', expect.stringMatching(/^info TV playing again after \d+\.\d s$/)]);
  });

  it('page hidden / visible and failed token requests', async () => {
    const env = setup();
    await playingSession(env);
    (env.deps.onHidden as unknown as { mock: { calls: Array<[() => void]> } }).mock.calls[0]![0]();
    env.wake();
    expect(texts(env, 'sender')).toEqual(['info page hidden', 'info page visible']);
    env.posts.push(() => Promise.reject(new Error('net')));
    await env.engine.playOnTv('ep2', 0);
    expect(texts(env, 'load').at(-1)).toBe('error token request refused · network');
    env.setLoad(async () => false);
    env.engine.reconnect();
    await flush();
    expect(texts(env, 'load').at(-1)).toBe('error the receiver could not load the title');
  });

  it('a refused queue: receiver refusal and a queue switched off meanwhile; a pending cast_unpinned retry goes with the switch', async () => {
    const env = setup();
    await playingSession(env, { itemId: 'ep1', isEpisode: true });
    expect(texts(env, 'queue')).toEqual(['info queued token issued · S1 E2', 'warn queue refused by the receiver']);
    const env2 = setup();
    env2.queuePostAnswers.push(() => Promise.reject(new ApiError(409, { error: 'cast_unpinned' })));
    await playingSession(env2, { itemId: 'ep1', isEpisode: true });
    env2.engine.setAutoplay(false);
    await env2.advance(UNPINNED_RETRY_MS * 2);
    expect(env2.queuePosts()).toHaveLength(1);
    // the switch goes off while the queue token is on its way: it is revoked, nothing is queued
    const env3 = setup();
    env3.setQueue(() => 7);
    const post = deferred<CastInfo>();
    env3.queuePostAnswers.push(() => post.promise);
    await playingSession(env3, { itemId: 'ep1', isEpisode: true });
    env3.engine.setAutoplay(false);
    post.resolve(ci('qx'));
    await flush();
    expect(env3.deletes()).toEqual(['qx']);
    expect(env3.queued).toEqual([]);
  });

  it('pagehide while the receiver takes the queue item: it stays queued with its token', async () => {
    const env = setup();
    const qd = deferred<number | null>();
    env.cast.queueOnCast.mockImplementationOnce(async () => qd.promise);
    await playingSession(env, { itemId: 'ep1', isEpisode: true });
    env.pagehide();
    qd.resolve(7);
    await flush();
    expect(env.cast.castQueueRemove).not.toHaveBeenCalled();
    expect(env.deletes()).toEqual([]);
  });
});

describe('castEngine (browser wiring)', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); clearItemCache(); });

  it('uses the item cache, window pagehide, the app toast and real timers', async () => {
    vi.useFakeTimers();
    const added: Array<() => void> = [];
    const removed: Array<() => void> = [];
    vi.stubGlobal('window', { addEventListener: (_t: string, fn: () => void) => added.push(fn), removeEventListener: (_t: string, fn: () => void) => removed.push(fn) });
    vi.stubGlobal('location', { pathname: '/', href: '/' });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      paths.push(path);
      if (path === '/api/items/ep9') return new Response(JSON.stringify({ item: { ...items.other, id: 'ep9', name: 'Fetched' } }));
      return new Response(path === '/api/cast/session' ? JSON.stringify(ci('b1')) : '');
    }));
    const { castEngine, castSession } = await import('./engine');
    const { toasts } = await import('#lib/ui/toast');
    primeItem({ ...items.film, id: 'film' } as Item);
    castEngine.adopt(handoff());
    expect(added).toHaveLength(2); // pagehide, pageshow (wake)
    expect(get(castSession)?.itemId).toBe('film');
    await castEngine.playOnTv('film', 0); // no Cast SDK here: the receiver cannot load it
    expect(get(castSession)).toMatchObject({ title: 'Film', state: 'failed' });
    expect(get(toasts).at(-1)).toMatchObject({ kind: 'error', message: '„Film“ kann auf Chromecast nicht abgespielt werden.' });
    await castEngine.refresh(); // no live token: nothing
    await vi.advanceTimersByTimeAsync(PROGRESS_MS);
    await castEngine.playOnTv('ep9', 0);
    expect(get(castSession)?.title).toBe('Fetched');
    added[0]!(); // pagehide: the Chromecast cast plays on (no Cast SDK here: the leave is a no-op)
    expect(removed).toEqual(added);
    expect(get(castSession)).toBeNull();
    expect(paths).toContain('/api/items/ep9');
  });
});

describe('cast engine: review fixes', () => {
  it('quick Play taps: the next token request waits for the owed stop (stream slot freed), last tap wins', async () => {
    const env = setup();
    await playingSession(env);
    const stop = deferred<null>();
    const record = env.api.getMockImplementation()!;
    env.api.mockImplementation(async (path, init) => {
      if (path === '/api/playback/stop') { await record(path, init); return stop.promise; }
      return record(path, init);
    });
    const p1 = env.engine.playOnTv('film', 0);
    await flush();
    const p2 = env.engine.playOnTv('ep2', 0);
    await flush();
    expect(env.tokenPosts()).toHaveLength(0);
    stop.resolve(null);
    await Promise.all([p1, p2]);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.tokenPosts()[0]!.init.body.itemId).toBe('ep2');
    expect(env.order.indexOf('POST /api/playback/stop')).toBeLessThan(env.order.indexOf('POST /api/cast/session'));
    expect(get(env.out)?.itemId).toBe('ep2');
  });

  it('media-end well before the end (receiver error, other sender): stop at the real position, session gone, not ended', async () => {
    const env = setup();
    env.state.set(playing({ currentTime: 600 }));
    env.engine.adopt(handoff({ started: true }));
    await flush();
    env.emit('media-end');
    await flush();
    expect(env.reports()).toEqual(['stop']);
    expect(env.calls[0]!.init.body.positionTicks).toBe(secToTicks(600));
    expect(env.deletes()).toEqual(['c1']);
    expect(get(env.out)).toBeNull();
    expect(env.pending()).toBe(0);
    expect(env.cast.castStop).not.toHaveBeenCalled();
  });

  it('media-end within the last 20 s counts as the end', async () => {
    const env = setup();
    env.state.set(playing({ currentTime: 1785 }));
    env.engine.adopt(handoff({ started: true }));
    await flush();
    env.emit('media-end');
    await flush();
    expect(env.calls[0]!.init.body.positionTicks).toBe(secToTicks(1800));
    expect(get(env.out)?.state).toBe('ended');
  });
});

describe('cast engine: next episode on the TV', () => {
  // the still-watching chain is module state: every test starts with a fresh interaction and no pending autoplay flag
  beforeEach(() => { noteInteraction(T0); consumeAutoplay(); });
  const COUNTDOWN_MS = COUNTDOWN_SECONDS * 1000;
  /** episode 1 plays on the TV and reaches its end */
  async function episodeEnds(env: Env, over: Partial<PlayerHandoff> = {}) {
    await playingSession(env, { itemId: 'ep1', seriesId: 's1', title: 'Bright Valley', subtitle: 'S1:E1 First', isEpisode: true, ...over });
    env.state.set(playing({ currentTime: 1795 }));
    env.emit('media-end');
    await flush();
  }

  it('ended episode with autoplay: countdown 10 s then the next episode starts at its resume position', async () => {
    const env = setup();
    await episodeEnds(env);
    // queue refused by the receiver (q1 revoked), the credits' lookup, then the end
    expect(env.order).toEqual(['GET /api/items/ep1/next', 'POST /api/cast/session', 'DELETE /api/cast/session/q1', 'GET /api/items/ep1/next', 'POST /api/playback/stop', 'GET /api/items/ep1/next', 'DELETE /api/cast/session/c1']);
    expect(get(env.out)).toMatchObject({ state: 'ended', next: { itemId: 'ep2', label: 'S1:E2 · Second', startsAt: T0 + COUNTDOWN_MS } });
    await env.advance(COUNTDOWN_MS - 1);
    expect(env.tokenPosts()).toHaveLength(0);
    expect(env.cast.castStop).not.toHaveBeenCalled();
    expect(get(env.out)?.state).toBe('ended');
    await env.advance(1);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.tokenPosts()[0]!.init.body).toMatchObject({ itemId: 'ep2', startTicks: undefined });
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', title: 'Bright Valley', state: 'connecting' });
    expect(get(env.out)?.next).toBeUndefined();
    // counted for "still watching?" (one more makes two in a row), without the watch page's one-shot flag left set
    expect(consumeAutoplay()).toBe(false);
    noteAutoplay(); consumeAutoplay();
    expect(shouldAsk(T0 + COUNTDOWN_MS, { stillWatching: true, stillWatchingEpisodes: 2 })).toBe(true);
    env.state.set(playing({ currentTime: 0 }));
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.cast.castStop).not.toHaveBeenCalled();
  });

  it('autoplay off: next shown without countdown, nothing starts', async () => {
    const env = setup({ prefs: { autoplayNext: false } });
    await episodeEnds(env);
    expect(get(env.out)).toMatchObject({ state: 'ended', next: { itemId: 'ep2', startsAt: null } });
    await env.advance(60_000);
    expect(env.tokenPosts()).toHaveLength(0);
    expect(env.cast.castStop).not.toHaveBeenCalled();
    expect(get(env.out)?.state).toBe('ended');
    expect(consumeAutoplay()).toBe(false);
  });

  it('an offered next episode nobody starts: the session closes after ENDED_IDLE_MS without a second report', async () => {
    const env = setup({ prefs: { autoplayNext: false } });
    await episodeEnds(env);
    await env.advance(ENDED_IDLE_MS - 1);
    expect(get(env.out)?.state).toBe('ended');
    expect(env.cast.castStop).not.toHaveBeenCalled();
    await env.advance(1);
    expect(get(env.out)).toBeNull();
    expect(env.cast.castStop).toHaveBeenCalledTimes(1);
    expect(env.reports()).toEqual(['stop']);
    expect(env.deletes()).toEqual(['c1']);
    expect(env.pending()).toBe(0);
  });

  it('cancelNext(): the session closes after ENDED_IDLE_MS', async () => {
    const env = setup();
    await episodeEnds(env);
    env.engine.cancelNext();
    await env.advance(ENDED_IDLE_MS - 1);
    expect(get(env.out)?.state).toBe('ended');
    await env.advance(1);
    expect(get(env.out)).toBeNull();
    expect(env.cast.castStop).toHaveBeenCalledTimes(1);
    expect(env.reports()).toEqual(['stop']);
    expect(env.tokenPosts()).toHaveLength(0);
  });

  it('still-watching due: no autoplay', async () => {
    noteInteraction(T0 - 90 * 60_000); // nobody touched anything for 90 min
    const env = setup();
    await episodeEnds(env);
    expect(get(env.out)?.next).toMatchObject({ itemId: 'ep2', startsAt: null });
    await env.advance(60_000);
    expect(env.tokenPosts()).toHaveLength(0);
  });

  it('a next episode without season / episode numbers is labelled by its name only', async () => {
    const env = setup();
    await episodeEnds(env, { itemId: 'ep5' });
    expect(get(env.out)?.next).toMatchObject({ itemId: 'sp1', label: 'Christmas Special' });
  });

  it('sleepAfterEpisode from the handoff: no autoplay', async () => {
    const env = setup();
    await episodeEnds(env, { sleepAfterEpisode: true });
    expect(get(env.out)?.next).toMatchObject({ itemId: 'ep2', startsAt: null });
    await env.advance(60_000);
    expect(env.tokenPosts()).toHaveLength(0);
  });

  it('film end: bar gone after 5 s, castStop called', async () => {
    const env = setup();
    await playingSession(env);
    env.state.set(playing({ currentTime: 1795 }));
    env.emit('media-end');
    await flush();
    expect(env.order).toEqual(['POST /api/playback/stop', 'DELETE /api/cast/session/c1']); // a film asks for no next episode
    expect(get(env.out)?.next).toBeUndefined();
    await env.advance(ENDED_HIDE_MS);
    expect(env.cast.castStop).toHaveBeenCalledTimes(1);
    expect(get(env.out)).toBeNull();
    expect(env.reports()).toEqual(['stop']);
  });

  it('last episode (no next) or a failed next request: bar gone after 5 s', async () => {
    for (const fail of [false, true]) {
      const env = setup();
      if (fail) { const record = env.api.getMockImplementation()!; env.api.mockImplementation(async (path, init) => (path.endsWith('/next') ? Promise.reject(new Error('net')) : record(path, init))); }
      await episodeEnds(env, { itemId: fail ? 'ep1' : 'ep9' });
      expect(get(env.out)).toMatchObject({ state: 'ended' });
      expect(get(env.out)?.next).toBeUndefined();
      await env.advance(ENDED_HIDE_MS);
      expect(env.cast.castStop).toHaveBeenCalledTimes(1);
      expect(get(env.out)).toBeNull();
    }
  });

  it('next() during the countdown starts at once and cancels the timer', async () => {
    const env = setup();
    await episodeEnds(env);
    await env.advance(3_000);
    await env.engine.next();
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.tokenPosts()[0]!.init.body).toMatchObject({ itemId: 'ep2', startTicks: undefined });
    expect(get(env.out)).toMatchObject({ itemId: 'ep2' });
    await env.advance(COUNTDOWN_MS + ENDED_HIDE_MS);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.cast.castStop).not.toHaveBeenCalled();
    expect(consumeAutoplay()).toBe(false); // a tap, not an autoplay
  });

  it('next() while the episode plays fetches the next one; without one (or a session) nothing happens', async () => {
    const none = setup();
    await none.engine.next();
    expect(none.calls).toEqual([]);
    const film = setup();
    await playingSession(film);
    await film.engine.next();
    expect(film.calls).toEqual([]);
    expect(film.toast).toHaveBeenCalledWith('info', 'Keine weitere Folge');
    const env = setup();
    await playingSession(env, { itemId: 'ep1', isEpisode: true });
    await env.engine.next();
    // the first lookup and the refused queue token come from the receiver queue (queued from the start)
    expect(env.order).toEqual(['GET /api/items/ep1/next', 'POST /api/cast/session', 'DELETE /api/cast/session/q1', 'GET /api/items/ep1/next', 'POST /api/playback/stop', 'DELETE /api/cast/session/c1', 'POST /api/cast/session']);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2' });
  });

  /** the episode now on the TV plays and reaches its end */
  async function currentEnds(env: Env) {
    env.state.set(playing({ currentTime: 10 }));
    env.state.set(playing({ currentTime: 1795 }));
    env.emit('media-end');
    await flush();
  }

  it('still-watching due -> next() -> the following episode end autoplays again', async () => {
    noteInteraction(T0 - 90 * 60_000);
    const env = setup();
    await episodeEnds(env);
    expect(get(env.out)?.next?.startsAt).toBeNull();
    await env.engine.next(); // the viewer is there
    await currentEnds(env);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'ended', next: { itemId: 'ep3', startsAt: T0 + COUNTDOWN_MS } });
    await env.advance(COUNTDOWN_MS);
    expect(env.tokenPosts().at(-1)!.init.body.itemId).toBe('ep3');
  });

  it('playPause and skip on the bar count as the viewer being there', async () => {
    for (const act of ['playPause', 'skip'] as const) {
      noteInteraction(T0 - 90 * 60_000);
      const env = setup();
      await playingSession(env);
      expect(shouldAsk(T0, DEFAULT_PREFS)).toBe(true);
      if (act === 'skip') env.engine.skip(10); else env.engine.playPause();
      expect(shouldAsk(T0, DEFAULT_PREFS)).toBe(false);
    }
  });

  it('sleepAfterEpisode applies to the ended episode only', async () => {
    const env = setup();
    await episodeEnds(env, { sleepAfterEpisode: true });
    expect(get(env.out)?.next?.startsAt).toBeNull();
    await env.engine.next();
    await currentEnds(env);
    expect(get(env.out)?.next).toMatchObject({ itemId: 'ep3', startsAt: T0 + COUNTDOWN_MS });
  });

  it('next() twice, or while the next episode loads, starts one episode only', async () => {
    const env = setup();
    await episodeEnds(env);
    await Promise.all([env.engine.next(), env.engine.next()]);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'connecting' });
    await env.engine.next(); // ep2 not yet playing
    await flush();
    expect(env.tokenPosts()).toHaveLength(1);
    expect(get(env.out)?.itemId).toBe('ep2');
  });

  it('cancelNext() stops the countdown; the next episode stays offered', async () => {
    const env = setup();
    env.engine.cancelNext(); // no session: nothing
    await episodeEnds(env);
    env.engine.cancelNext();
    expect(get(env.out)).toMatchObject({ state: 'ended', next: { itemId: 'ep2', startsAt: null } });
    await env.advance(60_000);
    expect(env.tokenPosts()).toHaveLength(0);
    expect(get(env.out)?.state).toBe('ended');
    await env.engine.next();
    expect(env.tokenPosts()).toHaveLength(1);
  });

  it('a next answer after the session moved on changes nothing', async () => {
    const env = setup();
    const answer = deferred<unknown>();
    const record = env.api.getMockImplementation()!;
    env.api.mockImplementation(async (path, init) => { const r = await record(path, init); return path.endsWith('/next') ? answer.promise.then(() => r) : r; });
    await episodeEnds(env);
    await env.engine.playOnTv('other', 0);
    answer.resolve(null);
    await flush();
    expect(get(env.out)).toMatchObject({ itemId: 'other' });
    expect(get(env.out)?.next).toBeUndefined();
    await env.advance(COUNTDOWN_MS);
    expect(env.tokenPosts()).toHaveLength(1);
  });
});

describe('cast engine: Netflix-like next episode (credits, receiver queue, skip)', () => {
  beforeEach(() => { noteInteraction(T0); consumeAutoplay(); });
  const COUNTDOWN_MS = COUNTDOWN_SECONDS * 1000;
  const ep1 = { itemId: 'ep1', seriesId: 's1', title: 'Bright Valley', subtitle: 'S1:E1 First', isEpisode: true };
  /** the receiver accepts the queue item (id 7) */
  const accepting = (env: Env) => env.setQueue(() => 7);

  it('FINISHED from the receiver is the end even when the SDK reset the time to 0 first (root cause: no next episode)', async () => {
    const env = setup();
    await playingSession(env, ep1);
    env.state.set(playing({ currentTime: 1790 }));
    env.state.set(playing({ currentTime: 0 })); // the SDK's reset around the end, while the media still counts as loaded
    env.state.set({ ...playing({ currentTime: 0, duration: 0 }), loaded: false, state: 'idle', idleReason: 'FINISHED' });
    env.emit('media-end');
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'ended', next: { itemId: 'ep2' } });
  });

  it('an idle receiver\'s time is no position; CANCELLED near the end is no finish', async () => {
    const env = setup();
    await playingSession(env, ep1);
    env.state.set(playing({ currentTime: 1795 }));
    env.state.set(playing({ currentTime: 0, state: 'idle' }));
    expect(get(env.out)?.position).toBe(1795);
    env.state.set({ ...playing({ currentTime: 0 }), loaded: false, state: 'idle', idleReason: 'CANCELLED' });
    env.emit('media-end');
    await flush();
    expect(get(env.out)).toBeNull();
  });

  it('credits: the next episode is offered while the TV plays, the countdown starts it (no receiver queue)', async () => {
    const env = setup();
    env.segs.ep1 = [{ type: 'outro', start: 1700, end: 1800 }];
    await playingSession(env, ep1);
    env.state.set(playing({ currentTime: 1699 }));
    await flush();
    expect(get(env.out)?.next).toBeUndefined();
    env.state.set(playing({ currentTime: 1701 }));
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'playing', next: { itemId: 'ep2', label: 'S1:E2 · Second', startsAt: T0 + COUNTDOWN_MS } });
    await env.advance(COUNTDOWN_MS);
    expect(env.tokenPosts().at(-1)!.init.body).toMatchObject({ itemId: 'ep2', startTicks: undefined });
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'connecting' });
    expect(get(env.out)?.next).toBeUndefined();
  });

  it('credits: seeking back out of them withdraws the offer and its countdown', async () => {
    const env = setup();
    await playingSession(env, ep1);
    env.state.set(playing({ currentTime: 1780 })); // no segments: the last 25 s
    await flush();
    expect(get(env.out)?.next?.itemId).toBe('ep2');
    env.state.set(playing({ currentTime: 1500 }));
    expect(get(env.out)?.next).toBeUndefined();
    await env.advance(COUNTDOWN_MS * 2);
    expect(env.tokenPosts()).toHaveLength(0);
  });

  it('receiver queue: the next episode gets its own token (`next: true`) and the receiver moves on by itself (phone asleep)', async () => {
    const env = setup();
    accepting(env);
    await playingSession(env, ep1);
    await flush();
    expect(env.queuePosts()).toHaveLength(1);
    expect(env.queuePosts()[0]!.init.body).toEqual({ itemId: 'ep2', maxBitrate: 8_000_000, next: true, after: 'c1' });
    expect(env.queued.map((q) => q.castId)).toEqual(['q1']);
    // no countdown ran (the page slept): the receiver reports the queued title
    env.state.set(playing({ currentTime: 30, contentId: '/media/c/q1/master.m3u8' }));
    await flush();
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.calls.find((c) => c.path === '/api/playback/stop')!.init.body).toMatchObject({ itemId: 'ep1', playSessionId: 'ps-c1', positionTicks: secToTicks(1800) });
    expect(env.lastReport()!.init.body).toMatchObject({ itemId: 'ep2', playSessionId: 'ps-q1' });
    expect(env.deletes()).toEqual(['c1']);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', title: 'Bright Valley', state: 'playing', position: 30 });
    expect(env.tokenPosts()).toHaveLength(0); // nothing loaded from the phone
    // an autoplay all the same (still-watching chain)
    noteAutoplay(); // one more makes two in a row
    expect(shouldAsk(T0, { stillWatching: true, stillWatchingEpisodes: 2 })).toBe(true);
  });

  it('receiver queue: the countdown makes the receiver jump to the queued episode; it is loaded from here if it does not', async () => {
    const env = setup();
    accepting(env);
    await playingSession(env, ep1);
    env.state.set(playing({ currentTime: 1780 }));
    await flush();
    await env.advance(COUNTDOWN_MS);
    expect(env.cast.castQueueNext).toHaveBeenCalledTimes(1);
    expect(env.tokenPosts()).toHaveLength(0);
    await env.advance(ADVANCE_WAIT_MS);
    expect(env.tokenPosts().at(-1)!.init.body).toMatchObject({ itemId: 'ep2' });
    expect(env.deletes()).toContain('q1'); // the queued token went with the queue
  });

  it('receiver queue: FINISHED with an episode queued follows the receiver; it is loaded if the receiver idles', async () => {
    const env = setup();
    accepting(env);
    await playingSession(env, ep1);
    env.state.set({ ...playing({ currentTime: 0 }), loaded: false, state: 'idle', idleReason: 'FINISHED' });
    env.emit('media-end');
    await flush();
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'connecting' });
    expect(env.reports()).toEqual(['stop']);
    await env.advance(ADVANCE_WAIT_MS);
    // a fresh token for the queued episode (the queued one may have lapsed), never the old one again
    expect(env.loads.map((l) => l.info.castId)).toEqual(['n1']);
    expect(env.tokenPosts().map((c) => c.init.body)).toEqual([expect.objectContaining({ itemId: 'ep2', startTicks: undefined })]);
    expect(env.tokenPosts()[0]!.init.body.next).toBeUndefined();
    expect(env.deletes()).toContain('q1');
  });

  it('fallback requests a fresh token for the queued episode', async () => {
    const env = setup();
    accepting(env);
    await playingSession(env, ep1);
    env.state.set(playing({ currentTime: 1795 }));
    env.emit('media-end'); // finished; the receiver should move on to q1 but never does
    await flush();
    await env.advance(ADVANCE_WAIT_MS - 1);
    expect(env.tokenPosts()).toHaveLength(0);
    await env.advance(1);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.tokenPosts()[0]!.init.body).toMatchObject({ itemId: 'ep2' });
    expect(env.tokenPosts()[0]!.init.body.next).toBeUndefined();
    expect(env.loads.map((l) => l.info.castId)).toEqual(['n1']);
    expect(env.loads.some((l) => l.info.castId === 'q1')).toBe(false);
    expect(env.logs.some((l) => l.tag === 'queue' && /fresh token/.test(l.text))).toBe(true);
  });

  it('queue from the start', async () => {
    const env = setup();
    accepting(env);
    env.state.set(playing({ currentTime: 0, duration: 3000, state: 'buffering' }));
    env.engine.adopt(handoff({ ...ep1, position: 0, duration: 3000, cast: ci('c1', { runtimeTicks: secToTicks(3000) }) }));
    await flush();
    expect(env.queuePosts()).toHaveLength(0);
    env.state.set(playing({ currentTime: 0.5, duration: 3000 }));
    await flush();
    expect(env.queuePosts()).toHaveLength(1);
    expect(env.queuePosts()[0]!.init.body).toEqual({ itemId: 'ep2', maxBitrate: 8_000_000, next: true, after: 'c1' });
    env.state.set(playing({ currentTime: 30, duration: 3000 }));
    await flush();
    expect(env.queuePosts()).toHaveLength(1); // once per title
    expect(env.logs.filter((l) => l.tag === 'queue').map((l) => l.text)).toEqual([expect.stringMatching(/issued/), expect.stringMatching(/loaded/)]);
  });

  it('cast_unpinned retries once after 60 s', async () => {
    const env = setup();
    accepting(env);
    const unpinned = () => Promise.reject(new ApiError(409, { error: 'cast_unpinned' }));
    env.queuePostAnswers.push(unpinned, unpinned);
    await playingSession(env, ep1);
    await flush();
    expect(env.queuePosts()).toHaveLength(1);
    expect(env.logs.find((l) => l.tag === 'queue')).toMatchObject({ level: 'warn', text: expect.stringContaining('409 cast_unpinned') });
    await env.advance(UNPINNED_RETRY_MS - 1);
    expect(env.queuePosts()).toHaveLength(1);
    await env.advance(1);
    expect(env.queuePosts()).toHaveLength(2);
    await env.advance(UNPINNED_RETRY_MS * 3);
    expect(env.queuePosts()).toHaveLength(2);
    expect(env.queued).toHaveLength(0);
  });

  it('cast_unpinned: a switch meanwhile clears the retry; other refusals are not retried', async () => {
    const env = setup();
    env.queuePostAnswers.push(() => Promise.reject(new ApiError(409, { error: 'cast_unpinned' })));
    await playingSession(env, ep1);
    await flush();
    await env.engine.playOnTv('film', 0);
    await env.advance(UNPINNED_RETRY_MS);
    expect(env.queuePosts()).toHaveLength(1);
    for (const e of [new ApiError(409, { error: 'profile_changed' }), new ApiError(400, { error: 'bad_request' }), new ApiError(429, { error: 'max_streams', max: 2 })]) {
      const env2 = setup();
      env2.queuePostAnswers.push(() => Promise.reject(e));
      await playingSession(env2, ep1);
      await flush();
      await env2.advance(UNPINNED_RETRY_MS * 2);
      expect(env2.queuePosts()).toHaveLength(1);
    }
  });

  it('setAutoplay(false) cancels the countdown, dequeues and stops further queueing', async () => {
    const env = setup();
    accepting(env);
    await playingSession(env, ep1);
    await flush();
    expect(get(env.out)?.autoplay).toBe(true);
    env.state.set(playing({ currentTime: 1780 }));
    await flush();
    expect(get(env.out)?.next?.startsAt).toBe(T0 + COUNTDOWN_MS);
    env.engine.setAutoplay(false);
    expect(get(env.out)).toMatchObject({ autoplay: false, next: { itemId: 'ep2', startsAt: null } });
    expect(env.cast.castQueueRemove).toHaveBeenCalledWith(7);
    expect(env.deletes()).toEqual(['q1']);
    await env.advance(COUNTDOWN_MS * 2);
    expect(env.tokenPosts()).toHaveLength(0);
    // the viewer moves on by hand: the next title is not queued, its end offers the following one without a countdown
    await env.engine.next();
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', autoplay: false });
    env.state.set(playing({ currentTime: 10, contentId: '/media/c/n1/master.m3u8' }));
    env.state.set(playing({ currentTime: 1795, contentId: '/media/c/n1/master.m3u8' }));
    await flush();
    expect(env.queuePosts()).toHaveLength(1);
    env.emit('media-end');
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'ended', next: { itemId: 'ep3', startsAt: null } });
    await env.advance(COUNTDOWN_MS * 2);
    expect(env.tokenPosts()).toHaveLength(1);
    expect(env.queuePosts()).toHaveLength(1);
  });

  it('setAutoplay(true) queues again and brings the countdown back; it overrides sleep after the episode', async () => {
    const env = setup();
    accepting(env);
    await playingSession(env, { ...ep1, sleepAfterEpisode: true });
    await flush();
    expect(get(env.out)?.autoplay).toBe(false);
    expect(env.queuePosts()).toHaveLength(0);
    env.engine.setAutoplay(true);
    await flush();
    expect(get(env.out)?.autoplay).toBe(true);
    expect(env.queuePosts()).toHaveLength(1);
    env.engine.setAutoplay(false);
    env.state.set(playing({ currentTime: 1780 }));
    await flush();
    expect(get(env.out)?.next?.startsAt).toBeNull();
    env.engine.setAutoplay(true);
    await flush();
    expect(get(env.out)?.next?.startsAt).toBe(T0 + COUNTDOWN_MS);
    expect(env.queuePosts()).toHaveLength(2);
    env.engine.setAutoplay(true); // no change: nothing queued twice
    await flush();
    expect(env.queuePosts()).toHaveLength(2);
  });

  it('cancelNext() during the credits: the queued episode leaves the receiver and its token is revoked; the end only offers it', async () => {
    const env = setup();
    accepting(env);
    await playingSession(env, ep1);
    env.state.set(playing({ currentTime: 1780 }));
    await flush();
    env.engine.cancelNext();
    expect(env.cast.castQueueRemove).toHaveBeenCalledWith(7);
    expect(env.deletes()).toEqual(['q1']);
    expect(get(env.out)?.next?.startsAt).toBeNull();
    await env.advance(COUNTDOWN_MS);
    env.emit('media-end');
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'ended', next: { itemId: 'ep2', startsAt: null } });
    await env.advance(COUNTDOWN_MS);
    expect(env.tokenPosts()).toHaveLength(0);
    expect(env.cast.castQueueNext).not.toHaveBeenCalled();
  });

  it('the queue keeps the profile rules: autoplay off, sleep after the episode, still-watching due at the end time', async () => {
    for (const [o, h] of [[{ prefs: { autoplayNext: false } }, {}], [{}, { sleepAfterEpisode: true }]] as const) {
      const env = setup(o);
      accepting(env);
      await playingSession(env, { ...ep1, ...h });
      await flush();
      expect(env.queuePosts()).toHaveLength(0);
    }
    // nobody touched anything for 80 min: by the end (29 min later) the still-watching ask is due
    noteInteraction(T0 - 80 * 60_000);
    const env = setup();
    accepting(env);
    await playingSession(env, ep1);
    await flush();
    expect(env.queuePosts()).toHaveLength(0);
  });

  it('stop() and another title drop the queued episode (token revoked)', async () => {
    const env = setup();
    accepting(env);
    await playingSession(env, ep1);
    await flush();
    await env.engine.playOnTv('film', 0);
    expect(env.deletes()).toEqual(['q1', 'c1']);
    const env2 = setup();
    accepting(env2);
    await playingSession(env2, ep1);
    await flush();
    await env2.engine.stop();
    expect(env2.deletes().sort()).toEqual(['c1', 'q1']);
  });

  it('skip: inside an intro / recap the session offers it; skipSegment() seeks past it', async () => {
    const env = setup();
    env.segs.ep1 = [{ type: 'recap', start: 0, end: 40 }, { type: 'intro', start: 60, end: 150 }];
    await playingSession(env, ep1);
    env.state.set(playing({ currentTime: 10 }));
    expect(get(env.out)?.skip).toEqual({ type: 'recap', end: 40 });
    env.state.set(playing({ currentTime: 61 }));
    expect(get(env.out)?.skip).toEqual({ type: 'intro', end: 150 });
    env.engine.skipSegment();
    expect(env.cast.castSeek).toHaveBeenCalledWith(150);
    env.state.set(playing({ currentTime: 150 }));
    expect(get(env.out)?.skip).toBeUndefined();
  });
});

describe('cast engine: FriendFlix\'s own receiver (CAST_RECEIVER_APP_ID)', () => {
  beforeEach(() => { noteInteraction(T0); consumeAutoplay(); });
  const ep1 = { itemId: 'ep1', seriesId: 's1', title: 'Bright Valley', subtitle: 'S1:E1 First', isEpisode: true };
  /** the custom receiver functions of #lib/cast (the default setup() has none: Default Media Receiver behaviour) */
  function custom(env: Env) {
    const sent: Array<Record<string, any>> = [];
    let rx: ((m: Record<string, unknown>) => void) | null = null;
    Object.assign(env.cast, {
      castCustomReceiver: () => true,
      castBody: (b: Record<string, unknown>) => (b.via === 'airplay' ? b : { ...b, receiver: true }),
      castSendMessage: vi.fn((m: Record<string, any>) => { sent.push(m); }),
      onReceiverMessage: vi.fn((fn: (m: Record<string, unknown>) => void) => { rx = fn; return () => { rx = null; }; }),
    });
    env.setQueue(() => 7);
    return { sent, rx: (m: Record<string, unknown>) => rx?.(m), items: () => sent.filter((m) => m.t === 'item') };
  }

  it('tells the TV its texts, subtitle style, segments and the queued episode; token requests ask for the report token', async () => {
    const env = setup({ prefs: { subtitleStyle: { size: 'l', color: 'yellow', background: 'solid', font: 'serif' } } });
    const tv = custom(env);
    env.segs.ep1 = [{ type: 'intro', start: 10, end: 80 }];
    await playingSession(env, ep1);
    await flush();
    const ui = tv.sent.find((m) => m.t === 'ui')!;
    expect(ui).toMatchObject({ sub: { size: 'l', color: 'yellow', background: 'solid', font: 'serif' }, countdown: COUNTDOWN_SECONDS });
    expect(ui.strings.startsIn).toHaveLength(COUNTDOWN_SECONDS);
    expect(ui.strings.upNext).toContain('{label}');
    expect(env.queuePosts()[0]!.init.body).toEqual({ itemId: 'ep2', maxBitrate: 8_000_000, next: true, after: 'c1', receiver: true });
    expect(tv.items().at(-1)).toEqual({ t: 'item', castId: 'c1', episode: true, segs: [{ type: 'intro', start: 10, end: 80 }],
      next: { castId: 'q1', label: expect.stringContaining('Second'), auto: true, ask: false } });
    await env.engine.playOnTv('film', 0);
    expect(env.tokenPosts().at(-1)!.init.body).toMatchObject({ itemId: 'film', receiver: true });
  });

  it('the TV runs the countdown: the phone does not make the receiver jump as well', async () => {
    const env = setup();
    custom(env);
    await playingSession(env, ep1);
    env.state.set(playing({ currentTime: 1780 }));
    await flush();
    await env.advance(COUNTDOWN_SECONDS * 1000 + ADVANCE_WAIT_MS);
    expect(env.cast.castQueueNext).not.toHaveBeenCalled();
    expect(env.tokenPosts()).toHaveLength(0);
    env.state.set(playing({ currentTime: 3, contentId: '/media/c/q1/master.m3u8' }));
    await flush();
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'playing' });
  });

  it('still watching due: the episode is still queued, paused (autoplay false, ask), and counts once it is there paused', async () => {
    noteInteraction(T0 - 80 * 60_000); // nobody touched anything for 80 min: by the end the ask is due
    const env = setup();
    const tv = custom(env);
    await playingSession(env, ep1);
    await flush();
    expect(env.cast.queueOnCast).toHaveBeenCalledWith(expect.objectContaining({ castId: 'q1' }), false);
    expect(tv.items().at(-1)!.next).toMatchObject({ castId: 'q1', auto: true, ask: true });
    env.state.set(playing({ currentTime: 0, paused: true, state: 'paused', contentId: '/media/c/q1/master.m3u8' }));
    await flush();
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(get(env.out)).toMatchObject({ itemId: 'ep2', state: 'playing', paused: true });
    // answered on the TV: the chain of unattended autoplays starts over
    tv.rx({ t: 'interaction' });
    expect(shouldAsk(T0, { stillWatching: true, stillWatchingEpisodes: 3 })).toBe(false);
  });

  it('cancel on the TV: like cancelNext (queue item dropped, token revoked, TV told)', async () => {
    const env = setup();
    const tv = custom(env);
    await playingSession(env, ep1);
    env.state.set(playing({ currentTime: 1780 }));
    await flush();
    tv.rx({ t: 'cancel' });
    expect(env.cast.castQueueRemove).toHaveBeenCalledWith(7);
    expect(env.deletes()).toEqual(['q1']);
    expect(get(env.out)?.next?.startsAt).toBeNull();
    expect(tv.items().at(-1)!.next).toBeNull();
    await env.advance(COUNTDOWN_SECONDS * 1000);
    expect(env.tokenPosts()).toHaveLength(0);
  });

  it('without the custom functions nothing is sent and still watching blocks the queue as before', async () => {
    noteInteraction(T0 - 80 * 60_000);
    const env = setup();
    env.setQueue(() => 7);
    await playingSession(env, ep1);
    await flush();
    expect(env.queuePosts()).toHaveLength(0);
    expect(env.cast.queueOnCast).not.toHaveBeenCalled();
  });
});
