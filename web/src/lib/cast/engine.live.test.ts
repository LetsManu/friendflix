// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api';
import { clock } from '#lib/live/api';
import { consumeAutoplay, noteInteraction } from '#lib/stillwatching';
import { barHasProgress, barLine1, barLine2, barThumb, castParts, liveLines } from './bar';
import { LiveCastError, PROGRESS_MS, RENEW_BEFORE_MS, type CastSession } from './engine';
import { flush, handoff, idle, liveAnswer, memStore, playing, settle, setup, T0, type Env } from '../../test-utils/fake-cast-engine';

/** Live channels on the Chromecast (Task 41, live TV spec §13): the engine's `loadLive`, the channel switch, re-adoption, the bar's live variant. */
const ORIGIN = 'https://friend.example.com';
const SIGNED = `${ORIGIN}/api/livetv/logos/4f2a9c0d1e3b5a7c?exp=1794560000000&sig=Zm9vYmFyYmF6cXV4LXNpZ25lZC1sb2dvLXVybA`;
const tf = (k: string, p?: Record<string, unknown>) => (p ? `${k}${JSON.stringify(p)}` : k);

beforeEach(() => { noteInteraction(T0); consumeAutoplay(); });

/** a TV is connected (the browser holds a cast session), nothing loaded yet */
const connected = (env: Env) => env.state.set({ ...idle });
/** the receiver reports the live channel it was given as playing */
const tvPlays = (env: Env, i = -1) => env.state.set(playing({ contentId: env.liveLoads.at(i)!.contentId, duration: 0, currentTime: 0 }));

describe('cast engine: live channels', () => {
  it('loadLive sends via chromecast and loads a LIVE stream', async () => {
    const env = setup();
    connected(env);
    await env.engine.loadLive('ch-nord');
    expect(env.watches()).toHaveLength(1);
    expect(env.watches()[0]).toMatchObject({ path: '/api/livetv/channels/ch-nord/watch', init: { method: 'POST', body: { via: 'chromecast' } } });
    expect(env.liveLoads).toEqual([{
      contentId: `${ORIGIN}/media/l/tok-ch-nord-1/index.m3u8`, contentType: 'application/x-mpegURL', streamType: 'LIVE',
      metadata: { title: 'Nordlicht TV', subtitle: 'Die Leuchtturmwärter', images: [] }, customData: { ui: { live: true } },
    }]);
    // nothing of the title machinery: no cast token, no playback report, no film load
    expect(env.tokenPosts()).toEqual([]);
    expect(env.reports()).toEqual([]);
    expect(env.loads).toEqual([]);
    const s = get(env.out)!;
    expect(s).toMatchObject({ kind: 'chromecast', device: 'Wohnzimmer-TV', itemId: 'ch-nord', title: 'Nordlicht TV', subtitle: 'Die Leuchtturmwärter', isEpisode: false,
      state: 'connecting', duration: 0, isLive: true,
      live: { channelId: 'ch-nord', number: 1, name: 'Nordlicht TV', now: 'Die Leuchtturmwärter', next: `${clock('2026-11-12T20:00:00.000Z')} Wetter am Hafen` } });
    tvPlays(env);
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'playing', paused: false, buffering: false });
    // play / pause drive the receiver; nothing is reported for a live channel
    env.engine.playPause();
    expect(env.cast.castPlayPause).toHaveBeenCalledTimes(1);
    await env.advance(PROGRESS_MS * 2);
    expect(env.reports()).toEqual([]);
    // a TV that is not connected: nothing is asked
    const off = setup();
    off.state.set({ ...idle, connected: false });
    await expect(off.engine.loadLive('ch-nord')).rejects.toMatchObject({ code: 'not_connected' });
    expect(off.watches()).toEqual([]);
  });

  it('every watch refusal rejects with its code and leaves the TV as it was', async () => {
    const refusals: Array<[number, Record<string, unknown>, string]> = [
      [503, { error: 'live_full', running: [] }, 'live_full'], [503, { error: 'provider_limit', max: 1, running: [] }, 'provider_limit'],
      [502, { error: 'channel_unreachable' }, 'channel_unreachable'], [409, { error: 'not_receiving' }, 'not_receiving'],
      [429, { error: 'max_streams', max: 2 }, 'max_streams'], [403, { error: 'forbidden' }, 'forbidden'], [404, { error: 'not_found' }, 'not_found'],
    ];
    for (const [status, body, code] of refusals) {
      const env = setup();
      connected(env);
      env.watchAnswers['ch-nord'] = () => Promise.reject(new ApiError(status, body));
      const err = await env.engine.loadLive('ch-nord').then(() => null, (e: unknown) => e);
      expect(err, code).toBeInstanceOf(LiveCastError);
      expect((err as LiveCastError).code).toBe(code);
      expect(env.liveLoads).toEqual([]);
      expect(get(env.out)).toBeNull();
    }
  });

  it('loadLive puts the answer\'s signed logo into the metadata', async () => {
    const env = setup();
    connected(env);
    env.watchAnswers['ch-nord'] = async () => liveAnswer('ch-nord', 'tok-a', { channel: { id: 'ch-nord', number: 1, name: 'Nordlicht TV', logo: SIGNED } });
    env.watchAnswers['ch-hafen'] = async () => liveAnswer('ch-hafen', 'tok-b', { channel: { id: 'ch-hafen', number: 4, name: 'Hafenkanal', logo: null } });
    await env.engine.loadLive('ch-nord');
    expect(env.liveLoads[0]!.metadata.images).toEqual([SIGNED]); // the exact string: never rebuilt or made relative
    expect(env.liveLoads[0]!.metadata.images[0]).toBe(SIGNED);
    await env.engine.loadLive('ch-hafen');
    expect(env.liveLoads[1]!.metadata.images).toEqual([]);
  });

  it('a channel switch mints a new token and loads again', async () => {
    const env = setup();
    connected(env);
    await env.engine.loadLive('ch-nord', { order: ['ch-nord', 'ch-hafen'] });
    tvPlays(env);
    await flush();
    await env.engine.zapLive(1);
    expect(env.watches().map((c) => c.path)).toEqual(['/api/livetv/channels/ch-nord/watch', '/api/livetv/channels/ch-hafen/watch']);
    expect(env.watches()[1]!.init.body).toEqual({ via: 'chromecast' });
    expect(env.liveLoads.map((m) => m.contentId)).toEqual([`${ORIGIN}/media/l/tok-ch-nord-1/index.m3u8`, `${ORIGIN}/media/l/tok-ch-hafen-2/index.m3u8`]);
    expect(env.liveLoads[1]!.metadata).toMatchObject({ title: 'Hafenkanal', subtitle: 'Wetter am Hafen' });
    expect(env.liveStops()).toEqual(['tok-ch-nord-1']); // the backend let it go with the mint (Task 32); ended here all the same
    expect(get(env.out)).toMatchObject({ itemId: 'ch-hafen', title: 'Hafenkanal', state: 'connecting', live: { channelId: 'ch-hafen', number: 4 } });
    tvPlays(env);
    await flush();
    expect(get(env.out)).toMatchObject({ state: 'playing' });
    // ▼ goes back; the order wraps around
    await env.engine.zapLive(1);
    expect(get(env.out)?.live?.channelId).toBe('ch-nord');
    // a refused switch: the channel before plays on, the refusal is a toast with the player's own text
    tvPlays(env);
    await flush();
    env.watchAnswers['ch-hafen'] = () => Promise.reject(new ApiError(503, { error: 'live_full', running: [] }));
    await env.engine.zapLive(-1);
    expect(get(env.out)).toMatchObject({ itemId: 'ch-nord', state: 'playing' });
    expect(env.toast).toHaveBeenCalledWith('error', expect.any(String));
    expect(env.liveLoads).toHaveLength(3);
    // Stop: the receiver stops, the token goes, the bar and the hint go
    await env.engine.stop();
    expect(env.cast.castStop).toHaveBeenCalled();
    expect(env.liveStops().at(-1)).toBe('tok-ch-nord-3');
    expect(get(env.out)).toBeNull();
    expect(env.hint()).toBeNull();
  });

  it('without an order the bar\'s ▲ reads the list (Alle, by number)', async () => {
    const env = setup();
    connected(env);
    env.liveList.list = { groups: [], favourites: [], recent: [], last: null, dvrSeconds: 1800, channels: [
      { id: 'ch-hafen', number: 4, name: 'Hafenkanal', logo: null, groupId: null, running: true, epg: 'none', favourite: false },
      { id: 'ch-nord', number: 1, name: 'Nordlicht TV', logo: null, groupId: null, running: true, epg: 'none', favourite: false },
    ] };
    await env.engine.loadLive('ch-nord');
    tvPlays(env);
    await flush();
    await env.engine.zapLive(1);
    expect(env.watches().map((c) => c.path.split('/')[4])).toEqual(['ch-nord', 'ch-hafen']);
  });

  it('the token is renewed before its 12-h cap', async () => {
    const env = setup();
    connected(env);
    env.watchAnswers['ch-nord'] = async () => liveAnswer('ch-nord', 'tok-old', { expiresAt: T0 + RENEW_BEFORE_MS + PROGRESS_MS * 2 + 1 });
    await env.engine.loadLive('ch-nord');
    tvPlays(env);
    await flush();
    delete env.watchAnswers['ch-nord'];
    await env.advance(PROGRESS_MS * 2);
    expect(env.watches()).toHaveLength(1);
    await env.advance(PROGRESS_MS);
    expect(env.watches()).toHaveLength(2);
    expect(env.liveLoads).toHaveLength(2);
    expect(env.liveStops()).toEqual(['tok-old']);
    expect(get(env.out)).toMatchObject({ itemId: 'ch-nord', state: 'playing' });
    expect(env.logs).toContainEqual(expect.objectContaining({ tag: 'renew', text: expect.stringMatching(/^live token renewed/) }));
  });

  it('a title on the TV is stopped first; a hand-off of a title ends the live cast', async () => {
    const env = setup();
    env.state.set(playing());
    env.engine.adopt(handoff({ started: true }));
    await flush();
    await env.engine.loadLive('ch-nord');
    await settle();
    expect(env.reports()).toEqual(['stop']);
    expect(env.deletes()).toContain('c1');
    expect(get(env.out)).toMatchObject({ itemId: 'ch-nord', isLive: true });
    env.engine.adopt(handoff({ started: false }));
    await flush();
    expect(env.liveStops()).toEqual(['tok-ch-nord-1']);
    expect(get(env.out)).toMatchObject({ itemId: 'film' });
    expect(get(env.out)?.live).toBeUndefined();
  });

  it('a live hint re-adopts', async () => {
    const store = memStore();
    const env = setup({ store });
    connected(env);
    await env.engine.loadLive('ch-hafen');
    tvPlays(env);
    await settle();
    const url = env.liveLoads[0]!.contentId;
    expect(env.hint()).toMatchObject({ kind: 'live', itemId: 'ch-hafen', device: 'Wohnzimmer-TV', live: { number: 4, name: 'Hafenkanal' } });
    // the hint never carries the token or the URL
    expect([...store.data.values()].join('')).not.toContain('tok-ch-hafen');
    // the tab closes: the TV plays on, nothing is revoked, the hint stays
    env.pagehide();
    await flush();
    expect(env.liveStops()).toEqual([]);
    expect(env.deps.leave).toHaveBeenCalled();
    expect(get(env.out)).toBeNull();
    expect(env.hint()?.kind).toBe('live');
    // a new page: the SDK joined, the receiver plays the channel
    const next = setup({ store });
    next.liveList.list = { groups: [], favourites: [], recent: [], last: null, dvrSeconds: 1800, channels: [
      { id: 'ch-hafen', number: 4, name: 'Hafenkanal', logo: null, groupId: null, running: true, epg: 'ok', favourite: false, now: { title: 'Wetter am Hafen', start: '2026-11-12T19:30:00.000Z', end: '2026-11-12T20:30:00.000Z' } },
    ] };
    next.state.set(playing({ contentId: url, duration: 0 }));
    expect(await next.engine.resume()).toBe(true);
    await settle();
    expect(get(next.out)).toMatchObject({ kind: 'chromecast', itemId: 'ch-hafen', title: 'Hafenkanal', subtitle: 'Wetter am Hafen', state: 'playing', isLive: true,
      live: { channelId: 'ch-hafen', number: 4, name: 'Hafenkanal', now: 'Wetter am Hafen' } });
    expect(next.lookupsAsked()).toEqual([]); // no film token lookup
    expect(next.watches()).toEqual([]); // the TV's token is kept, no new one
    // Stop ends the TV's token (taken from the receiver's URL)
    await next.engine.stop();
    expect(next.liveStops()).toEqual(['tok-ch-hafen-1']);
    expect(next.hint()).toBeNull();
    // a live channel the hint does not name (another device's): left alone, hint dropped
    const other = setup({ store: memStore() });
    other.state.set(playing({ contentId: `${ORIGIN}/media/l/tok-someone-else/index.m3u8` }));
    expect(await other.engine.resume()).toBe(false);
    expect(get(other.out)).toBeNull();
  });

  it('a live hint without an auto-join shows the detached bar with the channel; its Stop revokes nothing it does not hold', async () => {
    const store = memStore();
    const env = setup({ store });
    connected(env);
    await env.engine.loadLive('ch-nord');
    await settle();
    env.pagehide();
    const next = setup({ store });
    next.ready();
    await next.advance(10_000);
    await flush();
    expect(get(next.out)).toMatchObject({ state: 'detached', title: 'Nordlicht TV', isLive: true, live: { channelId: 'ch-nord', number: 1 } });
    expect(next.item).not.toHaveBeenCalled();
    await next.engine.stop();
    expect(get(next.out)).toBeNull();
    expect(next.hint()).toBeNull();
    expect(next.calls.filter((c) => c.init.method === 'DELETE')).toEqual([]);
  });

  it('the receiver stopping the channel or the session ending ends the cast and its token', async () => {
    const env = setup();
    connected(env);
    await env.engine.loadLive('ch-nord');
    tvPlays(env);
    await flush();
    env.emit('session-end');
    expect(get(env.out)).toBeNull();
    expect(env.liveStops()).toEqual(['tok-ch-nord-1']);
    expect(env.hint()).toBeNull();
  });

  it('the receiver that cannot load it: the token goes again, the call rejects', async () => {
    const env = setup();
    connected(env);
    env.setLiveLoad(async () => false);
    await expect(env.engine.loadLive('ch-nord')).rejects.toMatchObject({ code: 'load_failed' });
    expect(env.liveStops()).toEqual(['tok-ch-nord-1']);
    expect(get(env.out)).toBeNull();
  });
});

describe('cast bar: the live variant', () => {
  const live: CastSession = { kind: 'chromecast', device: 'Wohnzimmer-TV', itemId: 'ch-hafen', title: 'Hafenkanal', subtitle: 'Wetter am Hafen', posterId: 'ch-hafen', isEpisode: false,
    position: 0, duration: 0, paused: false, buffering: false, state: 'playing', audioTracks: [], subtitles: [], subIndex: -1, autoplay: false,
    live: { channelId: 'ch-hafen', number: 4, name: 'Hafenkanal', now: 'Wetter am Hafen', next: '21:30 Abenteuer Wattenmeer' }, isLive: true };
  const film: CastSession = { ...live, itemId: 'film', title: 'Dunmoor', subtitle: '', posterId: 'film', duration: 1800, position: 60, live: undefined, isLive: undefined };

  it('the live bar has no scrubber and shows the LIVE pill', () => {
    expect(castParts(live, true)).toEqual({ scrubber: false, livePill: true, channelKeys: true });
    expect(castParts(live, false)).toEqual({ scrubber: false, livePill: true, channelKeys: false }); // the app's live cast: no ▲/▼
    expect(castParts(film, true)).toEqual({ scrubber: true, livePill: false, channelKeys: false });
    expect(barHasProgress(live)).toBe(false);
    expect(barThumb(live)).toBeNull();
    expect(barLine1(live, undefined, tf)).toBe('4 Hafenkanal');
    expect(barLine2(live, 0, tf)).toMatchObject({ text: 'Wetter am Hafen · player.castBar.on{"device":"Wohnzimmer-TV"}', device: 'Wohnzimmer-TV' });
    expect(liveLines(live.live!, tf)).toEqual({ now: 'live.now: Wetter am Hafen', next: 'live.next: 21:30 Abenteuer Wattenmeer' });
    expect(liveLines({ channelId: 'x', number: null, name: 'Sternwarte 24' }, tf)).toEqual({ now: 'live.liveOnly', next: '' });
    // the components draw it that way: the scrubber only for a title, the LIVE pill and the channel keys for a channel
    const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const f of ['./CastBarExpanded.svelte', './RemoteScreen.svelte']) {
      const src = read(f);
      expect(src, f).toMatch(/\{#if cp\??\.scrubber\}\s*<CastScrubber/);
      expect(src, f).toContain("<span class=\"lpill\">{$t('live.player.live')}</span>");
      expect(src, f).toContain('castEngine.zapLive(1)');
      expect(src, f).toContain('castEngine.zapLive(-1)');
    }
    const bar = read('./CastBar.svelte');
    expect(bar).toContain("{#if cp.livePill}<span class=\"lpill\">{$t('live.player.live')}</span>{/if}");
    expect(bar).toContain('source.zap?.(1)');
  });
});
