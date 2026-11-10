// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { consumeAutoplay, noteInteraction } from '#lib/stillwatching';
import { DETACHED_AFTER_MS, PROGRESS_MS, RESUME_WAIT_MS } from './engine';
import { writeHint } from './resume';
import { castIdOf, ci, contentOf, flush, settle, handoff, idle, lookup, playing, setup, T0, token, type Env } from '../../test-utils/fake-cast-engine';

const tA = token('Aaaa'), tB = token('Bbbb'), tZ = token('Zzzz');
let A = '', B = '', Z = '';
beforeEach(async () => {
  noteInteraction(T0); consumeAutoplay();
  A = await castIdOf(tA); B = await castIdOf(tB); Z = await castIdOf(tZ);
});
/** the hint an earlier page left (fresh) */
const leaveHint = (env: Env, castId = A) => writeHint(env.store, { castId, itemId: 'dun4', device: 'Wohnzimmer-TV', exp: T0 + 60 * 60_000, at: T0 - 60_000 });
/** the TV plays Dunmoor S1 E4 (token A) with S1 E5 (token B) in its queue */
const tvPlaysA = (env: Env, over = {}) => env.state.set(playing({ currentTime: 600, duration: 3000, contentId: contentOf(tA), queue: [{ itemId: 12, contentId: contentOf(tB), castId: '' }], ...over }));

describe('cast engine: resume (re-adoption)', () => {
  it('resume adopts our media and restores the queue', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'dun4', { reported: true });
    env.lookups[B] = lookup(B, 'dun5', { next: true, reported: false, title: 'Wrenfield Pier', subtitles: [] });
    tvPlaysA(env);
    expect(await env.engine.resume()).toBe(true);
    await flush();
    expect(env.lookupsAsked()).toEqual([A, B]);
    expect(get(env.out)).toMatchObject({ kind: 'chromecast', itemId: 'dun4', title: 'Dunmoor', subtitle: expect.stringContaining('The Lantern Road'), isEpisode: true,
      state: 'playing', position: 600, duration: 3000, device: 'Wohnzimmer-TV', castId: A, subtitles: [{ index: 3, language: 'de', title: 'Deutsch' }], autoplay: true });
    expect(env.reports()).toEqual([]); // `start` was reported before the tab went
    expect(env.queuePosts()).toEqual([]); // the receiver's queued episode is ours: nothing queued twice
    expect(env.cast.castAdoptTracks).toHaveBeenCalledWith(contentOf(tA), [{ index: 3, language: 'de', title: 'Deutsch' }]);
    expect(env.hint()).toMatchObject({ castId: A, itemId: 'dun4', device: 'Wohnzimmer-TV' });
    expect(env.logs).toContainEqual({ level: 'info', tag: 'session', text: 'session resumed · TV kept playing' });
    // progress reports go on; Stop ends both tokens (the restored queued one included)
    await env.advance(PROGRESS_MS);
    expect(env.reports()).toEqual(['progress']);
    expect(env.lastReport()!.init.body).toMatchObject({ itemId: 'dun4', playSessionId: 'ps-dun4', mediaSourceId: 'ms-dun4' });
    await env.engine.stop();
    expect(env.reports()).toEqual(['progress', 'stop']);
    expect(env.deletes().sort()).toEqual([A, B].sort());
    expect(env.cast.castQueueRemove).toHaveBeenCalledWith(12);
  });

  it('the restored queued episode is followed when the TV moves on', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'dun4');
    env.lookups[B] = lookup(B, 'dun5', { next: true, reported: false, title: 'Wrenfield Pier' });
    tvPlaysA(env);
    await env.engine.resume();
    await flush();
    env.state.set(playing({ currentTime: 3, duration: 3000, contentId: contentOf(tB) }));
    await flush();
    expect(get(env.out)).toMatchObject({ itemId: 'dun5', state: 'playing', castId: B });
    expect(env.reports()).toEqual(['stop', 'start']);
    expect(env.deletes()).toEqual([A]);
    expect(env.hint()).toMatchObject({ castId: B, itemId: 'dun5' });
  });

  it('an unreported cast gets its start; the own receiver\'s castId is used as is; a queue item that is not a queued token is left alone', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'dun4', { reported: false });
    env.lookups[B] = lookup(B, 'dun5', { next: false });
    tvPlaysA(env, { castId: A, contentId: contentOf(token('own-receiver-url')) });
    expect(await env.engine.resume()).toBe(true);
    await flush();
    expect(env.lookupsAsked()).toEqual([A, B]);
    expect(env.reports()).toEqual(['start']);
    // no queued episode restored: this title queues its own (from the start)
    expect(env.queuePosts()).toHaveLength(1);
    await env.engine.stop();
    expect(env.deletes()).not.toContain(B);
  });

  it('resume ignores media that is not ours', async () => {
    const env = setup();
    leaveHint(env);
    env.state.set(playing({ contentId: contentOf(tZ) })); // another profile's or device's cast: the lookup answers 404
    expect(await env.engine.resume()).toBe(false);
    await flush();
    expect(env.lookupsAsked()).toEqual([Z]);
    expect(get(env.out)).toBeNull();
    expect(env.reports()).toEqual([]);
    expect(env.deletes()).toEqual([]);
    expect(env.hint()).toBeNull();
    expect(env.cast.castAdoptTracks).not.toHaveBeenCalled();
    expect(env.subs()).toBe(0);
    expect(env.pending()).toBe(0);
    await env.advance(PROGRESS_MS * 3);
    expect(env.calls).toHaveLength(1);
  });

  it('media without a cast token (test clip, another app) is not looked up', async () => {
    const env = setup();
    leaveHint(env);
    env.state.set(playing({ contentId: 'https://friend.example.com/cast-test/clip.mp4' }));
    expect(await env.engine.resume()).toBe(false);
    expect(env.calls).toEqual([]);
    expect(env.hint()).toBeNull();
    expect(get(env.out)).toBeNull();
  });

  it('a lookup that fails (network) keeps the hint', async () => {
    const env = setup();
    leaveHint(env);
    const record = env.api.getMockImplementation()!;
    env.api.mockImplementation(async (path, init) => (path.startsWith('/api/cast/session/') ? Promise.reject(new Error('net')) : record(path, init)));
    tvPlaysA(env);
    expect(await env.engine.resume()).toBe(false);
    expect(env.hint()?.castId).toBe(A);
    expect(get(env.out)).toBeNull();
  });

  it('resume is single-flight and only runs when nothing is owned', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'dun4');
    tvPlaysA(env, { queue: [] });
    const [a, b] = await Promise.all([env.engine.resume(), env.engine.resume()]); // setup's synthetic resume and SESSION_RESUMED
    expect([a, b]).toEqual([true, true]);
    expect(env.lookupsAsked()).toEqual([A]);
    expect(await env.engine.resume()).toBe(false); // owned now
    expect(env.lookupsAsked()).toEqual([A]);
    const other = setup();
    other.engine.adopt(handoff());
    expect(await other.engine.resume()).toBe(false);
    expect(other.lookupsAsked()).toEqual([]);
  });

  it('resume waits up to 10 s for the receiver\'s media', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'dun4');
    env.state.set({ ...idle }); // joined, media status not there yet
    const p = env.engine.resume();
    await env.advance(4_000);
    tvPlaysA(env, { queue: [] });
    expect(await p).toBe(true);
    expect(env.pending()).toBeGreaterThan(0); // the session's own loop; the wait timer is gone
    // nothing loaded within 10 s on a joined TV: nothing of ours plays there, the hint goes
    const idleTv = setup();
    leaveHint(idleTv);
    idleTv.state.set({ ...idle });
    const q = idleTv.engine.resume();
    await idleTv.advance(RESUME_WAIT_MS);
    expect(await q).toBe(false);
    expect(idleTv.hint()).toBeNull();
    expect(idleTv.pending()).toBe(0);
    // not joined at all: the hint stays (the detached bar offers Reconnect)
    const away = setup();
    leaveHint(away);
    away.state.set({ ...idle, connected: false, deviceName: '' });
    const r = away.engine.resume();
    await away.advance(RESUME_WAIT_MS);
    expect(await r).toBe(false);
    expect(away.hint()?.castId).toBe(A);
  });

  it('titles come from the lookup when the item cannot be loaded (also for the queued episode)', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'gone1', { title: 'Night Market', seriesName: 'Saltwater Almanac' });
    env.lookups[B] = lookup(B, 'gone2', { next: true, title: 'The Toll Keeper', seriesName: 'Saltwater Almanac' });
    tvPlaysA(env);
    expect(await env.engine.resume()).toBe(true);
    await flush();
    expect(get(env.out)).toMatchObject({ itemId: 'gone1', title: 'Saltwater Almanac', subtitle: 'Night Market', isEpisode: true });
    env.state.set(playing({ currentTime: 1, duration: 3000, contentId: contentOf(tB) }));
    await flush();
    expect(get(env.out)).toMatchObject({ itemId: 'gone2', title: 'Saltwater Almanac', isEpisode: true });
  });

  it('the TV moved on during the lookup: the resume gives up (the next event resumes again)', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'dun4');
    tvPlaysA(env, { queue: [] });
    env.item.mockImplementationOnce(async () => { env.state.set(playing({ contentId: contentOf(tZ) })); throw new Error('slow'); });
    expect(await env.engine.resume()).toBe(false);
    expect(get(env.out)).toBeNull();
  });

  it('a Player hand-off during the lookup wins; the resume gives up', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'dun4');
    tvPlaysA(env, { queue: [] });
    const p = env.engine.resume();
    env.engine.adopt(handoff({ cast: ci('c9') }));
    expect(await p).toBe(false);
    expect(get(env.out)?.itemId).toBe('film');
  });
});

describe('cast engine: detached', () => {
  it('detached bar after 5 s without a resume; Reconnect resumes', async () => {
    const env = setup();
    leaveHint(env);
    env.lookups[A] = lookup(A, 'dun4');
    env.state.set({ ...idle, connected: false, deviceName: '' }); // this reload did not auto-join
    env.ready();
    await env.advance(DETACHED_AFTER_MS - 1);
    expect(get(env.out)).toBeNull();
    await env.advance(1);
    await flush();
    expect(get(env.out)).toMatchObject({ kind: 'chromecast', state: 'detached', device: 'Wohnzimmer-TV', itemId: 'dun4', title: 'Dunmoor', castId: A });
    // controls of a live session do nothing here
    env.engine.playPause(); env.engine.seek(5); await env.engine.next();
    expect(env.calls).toEqual([]);
    env.setRequest(async () => { tvPlaysA(env, { queue: [], currentTime: 900 }); return true; });
    env.engine.reconnect();
    expect(env.deps.requestSession).toHaveBeenCalledTimes(1); // inside the tap
    await settle();
    expect(get(env.out)).toMatchObject({ state: 'playing', itemId: 'dun4', position: 900, castId: A });
    expect(env.lookupsAsked()).toEqual([A]);
    expect(env.toast).not.toHaveBeenCalled();
  });

  it('Reconnect to a TV that plays nothing of ours: toast, hint cleared, bar gone; a dismissed picker keeps the bar', async () => {
    const env = setup();
    leaveHint(env);
    env.state.set({ ...idle, connected: false, deviceName: '' });
    env.ready();
    await env.advance(DETACHED_AFTER_MS);
    await flush();
    env.setRequest(async () => false);
    env.engine.reconnect();
    await flush();
    expect(get(env.out)?.state).toBe('detached');
    expect(env.toast).not.toHaveBeenCalled();
    env.setRequest(async () => { env.state.set({ ...idle, deviceName: 'Küche' }); return true; });
    env.engine.reconnect();
    await flush();
    await env.advance(RESUME_WAIT_MS);
    expect(env.toast).toHaveBeenCalledWith('info', 'Auf Küche läuft nichts von FriendFlix.');
    expect(env.hint()).toBeNull();
    expect(get(env.out)).toBeNull();
  });

  it('a detached bar without item metadata keeps the device; a failed revoke stays silent', async () => {
    const env = setup();
    writeHint(env.store, { castId: A, itemId: 'gone', device: 'Wohnzimmer-TV', exp: T0 + 60 * 60_000, at: T0 });
    env.state.set({ ...idle, connected: false, deviceName: '' });
    env.ready();
    env.ready(); // a second ready changes nothing
    await env.advance(DETACHED_AFTER_MS);
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'detached', title: '', device: 'Wohnzimmer-TV' });
    const record = env.api.getMockImplementation()!;
    env.api.mockImplementation(async (path, init) => (init?.method === 'DELETE' ? Promise.reject(new Error('net')) : record(path, init)));
    await env.engine.stop();
    expect(get(env.out)).toBeNull();
    expect(env.hint()).toBeNull();
  });

  it('detached stop revokes by the hint\'s castId only', async () => {
    const env = setup();
    leaveHint(env);
    env.state.set({ ...idle, connected: false, deviceName: '' });
    env.ready();
    await env.advance(DETACHED_AFTER_MS);
    await flush();
    expect(get(env.out)?.state).toBe('detached');
    await env.engine.stop();
    expect(env.order).toEqual([`DELETE /api/cast/session/${A}`]);
    expect(env.reports()).toEqual([]);
    expect(env.cast.castStop).not.toHaveBeenCalled();
    expect(env.hint()).toBeNull();
    expect(get(env.out)).toBeNull();
  });

  it('no detached bar: without a hint, after a successful resume, or while a resume is still waiting (shown after it gave up)', async () => {
    const none = setup();
    none.ready();
    await none.advance(DETACHED_AFTER_MS * 2);
    expect(get(none.out)).toBeNull();
    expect(none.calls).toEqual([]);

    const ok = setup();
    leaveHint(ok);
    ok.lookups[A] = lookup(A, 'dun4');
    tvPlaysA(ok, { queue: [] });
    const resumed = ok.engine.resume();
    ok.ready();
    expect(await resumed).toBe(true);
    await ok.advance(DETACHED_AFTER_MS);
    expect(get(ok.out)?.state).toBe('playing');

    const waiting = setup();
    leaveHint(waiting);
    waiting.state.set({ ...idle, connected: false, deviceName: '' });
    const p = waiting.engine.resume();
    waiting.ready();
    await waiting.advance(DETACHED_AFTER_MS);
    expect(get(waiting.out)).toBeNull();
    await waiting.advance(RESUME_WAIT_MS - DETACHED_AFTER_MS);
    expect(await p).toBe(false);
    await flush();
    expect(get(waiting.out)?.state).toBe('detached');
  });

  it('a Player hand-off replaces the detached bar; a resume that finds foreign media drops it', async () => {
    const env = setup();
    leaveHint(env);
    env.state.set({ ...idle, connected: false, deviceName: '' });
    env.ready();
    await env.advance(DETACHED_AFTER_MS);
    await flush();
    env.engine.adopt(handoff());
    expect(get(env.out)).toMatchObject({ itemId: 'film', state: 'connecting' });
    await env.engine.stop();

    const foreign = setup();
    leaveHint(foreign);
    foreign.state.set({ ...idle, connected: false, deviceName: '' });
    foreign.ready();
    await foreign.advance(DETACHED_AFTER_MS);
    await flush();
    foreign.state.set(playing({ contentId: contentOf(tZ) }));
    expect(await foreign.engine.resume()).toBe(false);
    expect(get(foreign.out)).toBeNull();
    expect(foreign.hint()).toBeNull();
  });
});
