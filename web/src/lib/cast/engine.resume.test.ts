// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { consumeAutoplay, noteInteraction } from '#lib/stillwatching';
import { CAST_LOCK, castLock, DETACHED_AFTER_MS, PROGRESS_MS, RENEW_BEFORE_MS, RESUME_WAIT_MS } from './engine';
import type { CastLookup } from './resume';
import { writeHint } from './resume';
import { castIdOf, ci, contentOf, deferred, fakeLock, flush, memStore, settle, handoff, idle, lookup, playing, setup, T0, token, type Env } from '../../test-utils/fake-cast-engine';

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
    await flush(); // the owner lock first
    await env.advance(4_000);
    tvPlaysA(env, { queue: [] });
    expect(await p).toBe(true);
    expect(env.pending()).toBeGreaterThan(0); // the session's own loop; the wait timer is gone
    // nothing loaded within 10 s on a joined TV: nothing of ours plays there, the hint goes
    const idleTv = setup();
    leaveHint(idleTv);
    idleTv.state.set({ ...idle });
    const q = idleTv.engine.resume();
    await flush(); // the owner lock first
    await idleTv.advance(RESUME_WAIT_MS);
    expect(await q).toBe(false);
    expect(idleTv.hint()).toBeNull();
    expect(idleTv.pending()).toBe(0);
    // not joined at all: the hint stays (the detached bar offers Reconnect)
    const away = setup();
    leaveHint(away);
    away.state.set({ ...idle, connected: false, deviceName: '' });
    const r = away.engine.resume();
    await flush(); // the owner lock first
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

  it('resume of an unreported paused cast reports start (paused) and shows playing', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'dun5', { reported: false, next: true });
    tvPlaysA(env, { queue: [], paused: true, state: 'paused', currentTime: 42 });
    expect(await env.engine.resume()).toBe(true);
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'playing', paused: true, position: 42 });
    expect(env.reports()).toEqual(['start']);
    expect(env.lastReport()!.init.body).toMatchObject({ isPaused: true });
  });

  it('a network failure on the queue lookup queues nothing next to the receiver\'s item', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'dun4');
    const record = env.api.getMockImplementation()!;
    env.api.mockImplementation(async (path, init) => (path === `/api/cast/session/${B}` ? Promise.reject(new Error('net')) : record(path, init)));
    tvPlaysA(env);
    expect(await env.engine.resume()).toBe(true);
    await flush();
    await env.advance(PROGRESS_MS);
    expect(env.queuePosts()).toEqual([]);
  });

  it('stop during the queue lookup revokes the receiver\'s queued token too', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'dun4');
    env.lookups[B] = lookup(B, 'dun5', { next: true });
    const gate = deferred<void>();
    const record = env.api.getMockImplementation()!;
    env.api.mockImplementation(async (path, init) => (path === `/api/cast/session/${B}` && (init?.method ?? 'GET') === 'GET' ? record(path, init).then(async (r) => { await gate.promise; return r; }) : record(path, init)));
    tvPlaysA(env);
    const p = env.engine.resume();
    await settle();
    expect(get(env.out)?.itemId).toBe('dun4');
    await env.engine.stop();
    gate.resolve();
    await p;
    await flush();
    expect(env.deletes().sort()).toEqual([A, B].sort());
    expect(env.reports()).toEqual(['stop']);
  });

  it('a second engine does not resume while the first owns the cast; it takes over when the first leaves', async () => {
    const lock = fakeLock(), store = memStore(), lookups = {};
    const one = setup({ lock, store, lookups }), two = setup({ lock, store, lookups });
    one.lookups[A] = lookup(A, 'dun4');
    for (const env of [one, two]) tvPlaysA(env, { queue: [] });
    expect(await one.engine.resume()).toBe(true);
    expect(await two.engine.resume()).toBe(false);
    two.ready();
    await two.advance(DETACHED_AFTER_MS * 2);
    expect(get(two.out)).toBeNull(); // no bar, no "connection lost" while another tab owns the cast
    expect(two.calls.filter((c) => c.path.startsWith('/api/playback/') || c.init.method === 'DELETE' || c.path === '/api/cast/session')).toEqual([]);
    await one.advance(PROGRESS_MS);
    expect(one.reports()).toEqual(['progress']);
    one.pagehide(); // the owner tab goes: the other one picks the cast up
    await settle();
    expect(get(two.out)).toMatchObject({ state: 'playing', itemId: 'dun4' });
    expect(lock.held()).toBe(true);
    await two.engine.stop();
    expect(lock.held()).toBe(false);
  });

  it('Stop in the owner tab: the waiting tab does not re-adopt the stopped cast; one stop report, one DELETE', async () => {
    const lock = fakeLock(), store = memStore(), lookups = {};
    const one = setup({ lock, store, lookups }), two = setup({ lock, store, lookups });
    one.lookups[A] = lookup(A, 'dun4');
    for (const env of [one, two]) tvPlaysA(env, { queue: [] });
    expect(await one.engine.resume()).toBe(true);
    expect(await two.engine.resume()).toBe(false);
    const stop = deferred<null>();
    const record = one.api.getMockImplementation()!;
    one.api.mockImplementation(async (path, init) => (path === '/api/playback/stop' ? (await record(path, init), stop.promise) : record(path, init)));
    const stopping = one.engine.stop();
    await settle();
    expect(lock.held()).toBe(true); // the owner keeps the lock until its stop report and DELETE are through
    expect(two.calls).toEqual([]);
    stop.resolve(null);
    await stopping;
    await settle();
    expect(one.reports()).toEqual(['stop']);
    expect(one.deletes()).toEqual(['q1', A]); // q1: its own queue token the fake receiver refused earlier; then one DELETE for A
    expect([...one.reports(), ...two.reports()]).toEqual(['stop']);
    expect(get(two.out)).toBeNull();
    expect(two.reports()).toEqual([]);
    expect(two.queuePosts()).toEqual([]);
    expect(two.lookupsAsked()).toEqual([]); // the hint was gone: nothing to pick up
    expect(lock.held()).toBe(false);
    // the hint still there (no pre-check help): the lookup after the DELETE answers 404, the waiting tab changes nothing
    const lock2 = fakeLock(), store2 = memStore(), lookups2 = {};
    const a = setup({ lock: lock2, store: store2, lookups: lookups2 }), b = setup({ lock: lock2, store: store2, lookups: lookups2 });
    a.lookups[A] = lookup(A, 'dun4');
    for (const env of [a, b]) tvPlaysA(env, { queue: [] });
    await a.engine.resume();
    await b.engine.resume();
    const stoppedA = a.engine.stop();
    leaveHint(b); // e.g. written back by a late step
    await stoppedA;
    await settle();
    expect(b.lookupsAsked()).toEqual([A]);
    expect(get(b.out)).toBeNull();
    expect(b.reports()).toEqual([]);
    expect(lock2.held()).toBe(false);
  });

  it('a tab without auto-join shows no "connection lost" while another tab owns the cast; Reconnect there drops the bar silently', async () => {
    const lock = fakeLock(), store = memStore(), lookups = {};
    const one = setup({ lock, store, lookups }), two = setup({ lock, store, lookups });
    one.lookups[A] = lookup(A, 'dun4');
    tvPlaysA(one, { queue: [] });
    expect(await one.engine.resume()).toBe(true);
    two.state.set({ ...idle, connected: false, deviceName: '' });
    two.ready();
    await two.advance(DETACHED_AFTER_MS);
    await settle();
    expect(get(two.out)).toBeNull();
    expect(lock.waiting()).toBe(1); // it follows: it takes over when the owner goes
    // the bar was already up when the other tab became the owner
    const lock2 = fakeLock(), store2 = memStore(), lookups2 = {};
    const a = setup({ lock: lock2, store: store2, lookups: lookups2 }), b = setup({ lock: lock2, store: store2, lookups: lookups2 });
    a.lookups[A] = lookup(A, 'dun4');
    leaveHint(b);
    b.state.set({ ...idle, connected: false, deviceName: '' });
    b.ready();
    await b.advance(DETACHED_AFTER_MS);
    await settle();
    expect(get(b.out)?.state).toBe('detached');
    expect(lock2.held()).toBe(false); // the probe let it go again
    tvPlaysA(a, { queue: [] });
    expect(await a.engine.resume()).toBe(true);
    b.setRequest(async () => { tvPlaysA(b, { queue: [] }); return true; });
    b.engine.reconnect();
    await settle();
    expect(b.toast).not.toHaveBeenCalled();
    expect(get(b.out)).toBeNull();
    expect(b.hint()?.castId).toBe(A); // the owner's hint stays
    expect(b.calls.filter((c) => c.init.method === 'DELETE' || c.path.startsWith('/api/playback/'))).toEqual([]);
  });

  it('a tab that never auto-joined shows the detached bar once the owner tab closed', async () => {
    const lock = fakeLock(), store = memStore(), lookups = {};
    const one = setup({ lock, store, lookups }), two = setup({ lock, store, lookups });
    one.lookups[A] = lookup(A, 'dun4');
    tvPlaysA(one, { queue: [] });
    expect(await one.engine.resume()).toBe(true);
    two.state.set({ ...idle, connected: false, deviceName: '' });
    two.ready();
    await two.advance(DETACHED_AFTER_MS);
    await settle();
    expect(get(two.out)).toBeNull(); // follows while the owner is there
    one.pagehide();
    await settle();
    await two.advance(RESUME_WAIT_MS); // its resume finds nothing joined here
    await settle();
    await two.advance(DETACHED_AFTER_MS);
    await settle();
    expect(get(two.out)).toMatchObject({ state: 'detached', castId: A, device: 'Wohnzimmer-TV' });
    expect(two.calls.filter((c) => c.init.method === 'DELETE' || c.path.startsWith('/api/playback/'))).toEqual([]);
  });

  it('a hand-off in a tab without the lock still plays (the user cast from here); a second follower resume waits once', async () => {
    const lock = fakeLock();
    const one = setup({ lock }), two = setup({ lock });
    for (const env of [one, two]) { env.lookups[A] = lookup(A, 'dun4'); tvPlaysA(env, { queue: [] }); }
    expect(await one.engine.resume()).toBe(true);
    expect(await two.engine.resume()).toBe(false);
    expect(await two.engine.resume()).toBe(false);
    expect(lock.waiting()).toBe(1);
    two.engine.adopt(handoff({ cast: ci('c9') }));
    await flush();
    expect(get(two.out)?.itemId).toBe('film');
    one.pagehide();
    await settle();
    expect(lock.held()).toBe(true); // the waiting request went to the tab that casts now; it keeps it
    expect(get(two.out)?.itemId).toBe('film');
    await two.engine.stop();
    expect(lock.held()).toBe(false);
  });

  it('castLock: navigator.locks held until released, null when taken, everyone owns without the API', async () => {
    let cb: ((l: unknown) => unknown) | null = null;
    const opts: unknown[] = [];
    const locks = { request: (name: string, o: unknown, fn: (l: unknown) => unknown) => { opts.push([name, o]); cb = fn; return Promise.resolve(); } };
    const p = castLock(locks as unknown as LockManager, true);
    const held = cb!({ name: CAST_LOCK }) as Promise<void>;
    const release = await p;
    expect(opts).toEqual([[CAST_LOCK, { ifAvailable: true }]]);
    let done = false;
    void held.then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    release!();
    await flush();
    expect(done).toBe(true);
    const q = castLock(locks as unknown as LockManager, true);
    cb!(null);
    expect(await q).toBeNull();
    expect(typeof (await castLock(undefined, true))).toBe('function');
    expect(typeof (await castLock({ request: () => Promise.reject(new Error('opaque')) } as unknown as LockManager, false))).toBe('function');
  });

  it('resume onto the queued successor closes the predecessor once (one stop at its runtime, one DELETE)', async () => {
    const env = setup();
    writeHint(env.store, { castId: A, next: B, itemId: 'dun4', device: 'Wohnzimmer-TV', exp: T0 + 60 * 60_000, at: T0 - 60_000 });
    // `reported` is false by then: the ended episode's live record died ~45 s after the TV stopped fetching it
    env.lookups[A] = lookup(A, 'dun4', { reported: false, runtimeTicks: 30_000_000_000 });
    env.lookups[B] = lookup(B, 'dun5', { next: true, reported: true, title: 'Wrenfield Pier' });
    env.state.set(playing({ currentTime: 120, duration: 3000, contentId: contentOf(tB), queue: [] })); // the TV moved on with no page open
    expect(await env.engine.resume()).toBe(true);
    await flush();
    expect(env.reports()).toEqual(['stop']);
    expect(env.calls.find((c) => c.path === '/api/playback/stop')!.init.body).toEqual({
      itemId: 'dun4', playSessionId: 'ps-dun4', mediaSourceId: 'ms-dun4', positionTicks: 30_000_000_000, isPaused: false, playMethod: 'Transcode' });
    expect(env.deletes()).toEqual([A]);
    expect(get(env.out)).toMatchObject({ itemId: 'dun5', state: 'playing', castId: B });
    expect(env.hint()?.castId).toBe(B);
    expect(env.logs.some((l) => l.tag === 'queue' && /ended episode closed/.test(l.text))).toBe(true);
    // its token already gone (idle expiry): nothing to close
    const gone = setup();
    writeHint(gone.store, { castId: A, next: B, itemId: 'dun4', device: 'Wohnzimmer-TV', exp: T0 + 60 * 60_000, at: T0 - 60_000 });
    gone.lookups[B] = lookup(B, 'dun5', { next: true, reported: true });
    gone.state.set(playing({ contentId: contentOf(tB), queue: [] }));
    expect(await gone.engine.resume()).toBe(true);
    expect(gone.reports()).toEqual([]);
    expect(gone.deletes()).toEqual([]);
  });

  it('a resume that gives up after closing the ended episode: the next resume does not close it again', async () => {
    const env = setup();
    writeHint(env.store, { castId: A, next: B, itemId: 'dun4', device: 'Wohnzimmer-TV', exp: T0 + 60 * 60_000, at: T0 - 60_000 });
    env.lookups[A] = lookup(A, 'dun4', { reported: false, runtimeTicks: 30_000_000_000 });
    env.lookups[B] = lookup(B, 'dun5', { next: true, reported: true });
    const revoked = deferred<void>();
    const record = env.api.getMockImplementation()!;
    // the ended episode's DELETE has not landed yet (its lookup still answers 200 meanwhile)
    env.api.mockImplementation(async (path, init) => (path === `/api/cast/session/${A}` && init?.method === 'DELETE' ? (await revoked.promise, record(path, init)) : record(path, init)));
    env.state.set(playing({ contentId: contentOf(tB), queue: [] }));
    // the TV moves on while the item metadata loads: this resume gives up after closing the ended episode
    env.item.mockImplementationOnce(async () => { env.state.set(playing({ contentId: contentOf(tZ), queue: [] })); throw new Error('slow'); });
    expect(await env.engine.resume()).toBe(false);
    env.state.set(playing({ contentId: contentOf(tB), queue: [] }));
    expect(await env.engine.resume()).toBe(true);
    revoked.resolve();
    await flush();
    expect(env.reports()).toEqual(['stop']);
    expect(env.lookupsAsked().filter((id) => id === A)).toHaveLength(1);
    expect(env.deletes()).toEqual([A]);
  });

  it('a failed queue lookup: the hint keeps the receiver\'s queued token and Stop revokes it', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'dun4');
    const record = env.api.getMockImplementation()!;
    env.api.mockImplementation(async (path, init) => (path === `/api/cast/session/${B}` && (init?.method ?? 'GET') === 'GET' ? Promise.reject(new Error('net')) : record(path, init)));
    tvPlaysA(env);
    expect(await env.engine.resume()).toBe(true);
    await flush();
    expect(env.hint()).toMatchObject({ castId: A, next: B });
    await env.engine.stop();
    expect(env.deletes().sort()).toEqual([A, B].sort());
    expect(env.reports()).toEqual(['stop']);
  });

  it('a resume keeps the receiver\'s subtitle for the first renewal', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'dun4', { expiresAt: T0 + RENEW_BEFORE_MS + 5_000, subtitles: [{ index: 3, language: 'de', title: 'Deutsch' }, { index: 7, language: 'en', title: 'English' }] });
    env.cast.castActiveSubtitle.mockReturnValue(7);
    tvPlaysA(env, { queue: [] });
    expect(await env.engine.resume()).toBe(true);
    expect(get(env.out)?.subIndex).toBe(7);
    await env.advance(PROGRESS_MS);
    expect(env.loads.map((l) => l.sub)).toEqual([7]);
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

  it('detached stop revokes the queued successor named in the hint too', async () => {
    const env = setup();
    writeHint(env.store, { castId: A, next: B, itemId: 'dun4', device: 'Wohnzimmer-TV', exp: T0 + 60 * 60_000, at: T0 });
    env.state.set({ ...idle, connected: false, deviceName: '' });
    env.ready();
    await env.advance(DETACHED_AFTER_MS);
    await flush();
    await env.engine.stop();
    expect(env.order).toEqual([`DELETE /api/cast/session/${A}`, `DELETE /api/cast/session/${B}`]);
    expect(env.reports()).toEqual([]);
    expect(env.cast.castStop).not.toHaveBeenCalled();
  });

  it('detached stop during a reconnect lookup: no re-adoption, no toast, one DELETE', async () => {
    const env = setup();
    leaveHint(env);
    env.lookups[A] = lookup(A, 'dun4');
    env.state.set({ ...idle, connected: false, deviceName: '' });
    env.ready();
    await env.advance(DETACHED_AFTER_MS);
    await flush();
    const answer = deferred<CastLookup>();
    const record = env.api.getMockImplementation()!;
    env.api.mockImplementation(async (path, init) => (path === `/api/cast/session/${A}` && (init?.method ?? 'GET') === 'GET' ? (await record(path, init), answer.promise) : record(path, init)));
    env.setRequest(async () => { tvPlaysA(env, { queue: [] }); return true; });
    env.engine.reconnect();
    await settle();
    expect(env.lookupsAsked()).toEqual([A]);
    await env.engine.stop();
    answer.resolve(lookup(A, 'dun4')); // processed before the DELETE: still 200
    await settle();
    expect(get(env.out)).toBeNull();
    expect(env.toast).not.toHaveBeenCalled();
    expect(env.deletes()).toEqual([A]);
    expect(env.reports()).toEqual([]);
    expect(env.hint()).toBeNull();
    // the other order: the DELETE first, the lookup 404s
    const two = setup();
    leaveHint(two);
    two.state.set({ ...idle, connected: false, deviceName: '' });
    two.ready();
    await two.advance(DETACHED_AFTER_MS);
    await flush();
    two.setRequest(async () => { tvPlaysA(two, { queue: [] }); return true; });
    two.engine.reconnect();
    await two.engine.stop();
    await settle();
    expect(two.toast).not.toHaveBeenCalled();
    expect(get(two.out)).toBeNull();
  });

  it('bfcache restore after pagehide brings the detached bar back (or resumes when the SDK is still joined)', async () => {
    const env = setup();
    env.lookups[A] = lookup(A, 'dun4');
    tvPlaysA(env, { queue: [] });
    expect(await env.engine.resume()).toBe(true);
    env.pagehide();
    env.state.set({ ...idle, connected: false, deviceName: '' }); // castLeave disconnected this page
    env.restore();
    await env.advance(DETACHED_AFTER_MS);
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'detached', castId: A });
    const joined = setup();
    joined.lookups[A] = lookup(A, 'dun4');
    tvPlaysA(joined, { queue: [] });
    await joined.engine.resume();
    joined.pagehide();
    joined.restore();
    await settle();
    expect(get(joined.out)).toMatchObject({ state: 'playing', itemId: 'dun4' });
    const none = setup();
    none.restore();
    await none.advance(DETACHED_AFTER_MS);
    expect(get(none.out)).toBeNull();
    expect(none.calls).toEqual([]);
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
    await flush(); // the owner lock first
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
