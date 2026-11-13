// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CastInfo } from './cast';

const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** Fake of the Cast Web Sender SDK globals (cast.framework + chrome.cast), recording what the sender does. */
function fakeSdk() {
  const ctxListeners = new Map<string, (e: { castState?: string; sessionState?: string }) => void>();
  let anyChange: () => void = () => undefined;
  const player = { isConnected: false, isPaused: true, isMediaLoaded: false, currentTime: 0, duration: 0, volumeLevel: 1, isMuted: false, playerState: null as string | null, mediaInfo: null as { contentId: string; customData?: unknown } | null };
  const controller = { playOrPause: vi.fn(), stop: vi.fn(), seek: vi.fn(), setVolumeLevel: vi.fn(), muteOrUnmute: vi.fn(), addEventListener: (_t: string, fn: () => void) => { anyChange = fn; } };
  const mediaSession = {
    editTracksInfo: vi.fn((_r: unknown, ok: () => void) => ok()),
    idleReason: null as string | null,
    currentItemId: undefined as number | undefined,
    items: [] as Array<{ itemId: number; media: { contentId: string; customData?: unknown } }>,
    queueInsertItems: vi.fn((r: any, ok: () => void, _err: (e: unknown) => void) => { for (const q of r.args[0]) mediaSession.items.push({ itemId: 100 + mediaSession.items.length, media: { contentId: q.args[0].args[0] } }); ok(); }),
    queueRemoveItems: vi.fn((_r: unknown, ok: () => void) => ok()),
    queueNext: vi.fn((ok: () => void) => ok()),
  };
  const session = { getCastDevice: () => ({ friendlyName: 'Living Room TV' }), loadMedia: vi.fn(async (_r: any): Promise<string | undefined> => undefined), media: mediaSession as typeof mediaSession | null, getMediaSession() { return this.media; } };
  const context = {
    setOptions: vi.fn(),
    addEventListener: (t: string, fn: (e: { castState?: string; sessionState?: string }) => void) => ctxListeners.set(t, fn),
    requestSession: vi.fn(async (): Promise<string | undefined> => undefined),
    current: null as typeof session | null,
    getCurrentSession() { return this.current; },
    endCurrentSession: vi.fn(),
  };
  class Rec { [k: string]: unknown; constructor(...args: unknown[]) { this.args = args; } }
  const framework = {
    CastContext: { getInstance: () => context },
    CastContextEventType: { CAST_STATE_CHANGED: 'caststatechanged', SESSION_STATE_CHANGED: 'sessionstatechanged' },
    SessionState: { SESSION_STARTED: 'SESSION_STARTED', SESSION_RESUMED: 'SESSION_RESUMED', SESSION_ENDED: 'SESSION_ENDED' },
    RemotePlayer: function RemotePlayer() { return player; },
    RemotePlayerController: function RemotePlayerController() { return controller; },
    RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
  };
  const chromeCast = {
    AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' },
    Image: class extends Rec {},
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
      MediaInfo: class extends Rec {}, LoadRequest: class extends Rec {}, MovieMediaMetadata: class extends Rec {}, TvShowMediaMetadata: class extends Rec {},
      Track: class extends Rec {}, EditTracksInfoRequest: class extends Rec {},
      QueueItem: class extends Rec {}, QueueInsertItemsRequest: class extends Rec {}, QueueRemoveItemsRequest: class extends Rec {},
      StreamType: { BUFFERED: 'BUFFERED' }, HlsSegmentFormat: { TS: 'ts' }, MetadataType: { MOVIE: 1, TV_SHOW: 2 }, TrackType: { TEXT: 'TEXT' }, TextTrackType: { SUBTITLES: 'SUBTITLES' },
    },
  };
  return {
    framework, chromeCast, player, controller, session, context, mediaSession,
    fire: (type: string, e: { castState?: string; sessionState?: string }) => ctxListeners.get(type)!(e),
    change: (patch: Partial<typeof player>) => { Object.assign(player, patch); anyChange(); },
  };
}

let ua: string;
let platform: string;
let classes: Set<string>;
let scripts: Array<{ src: string; async: boolean }>;
let win: Record<string, any>;
let castEnabled: boolean | 'error';
let airplayCont: boolean | undefined;
/** /api/cast/config `receiverAppId` ('' = not in the answer, as without CAST_RECEIVER_APP_ID) */
let appId = '';
const fetchMock = vi.fn(async (_url: string) => {
  if (castEnabled === 'error') return new Response('{}', { status: 500 });
  return new Response(JSON.stringify({ enabled: castEnabled, ...(appId ? { receiverAppId: appId } : {}), ...(airplayCont === undefined ? {} : { airplayContinuous: airplayCont }) }));
});
type Cast = typeof import('./cast');
let C: Cast;

beforeEach(async () => {
  ua = CHROME_UA;
  platform = 'Linux x86_64';
  classes = new Set();
  scripts = [];
  castEnabled = true;
  airplayCont = undefined;
  appId = '';
  fetchMock.mockClear();
  win = {};
  vi.stubGlobal('navigator', { get userAgent() { return ua; }, get platform() { return platform; }, maxTouchPoints: 0 });
  vi.stubGlobal('document', {
    documentElement: { classList: { contains: (c: string) => classes.has(c) } },
    createElement: () => ({ src: '', async: false }),
    head: { appendChild: (s: { src: string; async: boolean }) => scripts.push(s) },
  });
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { pathname: '/', href: 'https://friend.example.com/' });
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  C = await import('./cast');
});
afterEach(() => vi.unstubAllGlobals());

/** initCast + SDK "loaded" callback with a fake SDK installed */
async function connectSdk() {
  const sdk = fakeSdk();
  await C.initCast();
  win.cast = { framework: sdk.framework };
  win.chrome = { cast: sdk.chromeCast };
  win.__onGCastApiAvailable(true);
  return sdk;
}

describe('castCapableBrowser', () => {
  it('accepts desktop Chromium, rejects Firefox, Safari, every iOS browser and the TV mode', () => {
    expect(C.castCapableBrowser()).toBe(true);
    ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
    expect(C.castCapableBrowser()).toBe(false);
    ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1';
    expect(C.castCapableBrowser()).toBe(false);
    ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
    platform = 'MacIntel';
    expect(C.castCapableBrowser()).toBe(true);
    (navigator as { maxTouchPoints: number }).maxTouchPoints = 5; // iPadOS pretends to be a Mac
    expect(C.castCapableBrowser()).toBe(false);
    ua = CHROME_UA;
    platform = 'Linux';
    (navigator as { maxTouchPoints: number }).maxTouchPoints = 0;
    classes.add('tv');
    expect(C.castCapableBrowser()).toBe(false);
  });

  it('is false outside a browser', () => {
    vi.stubGlobal('navigator', undefined);
    expect(C.castCapableBrowser()).toBe(false);
  });
});

describe('castConfigEnabled', () => {
  it('asks the server once per page and remembers the answer', async () => {
    await expect(C.castConfigEnabled()).resolves.toBe(true);
    await expect(C.castConfigEnabled()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/cast/config');
  });

  it('a failed request is asked again next time', async () => {
    castEnabled = 'error';
    await expect(C.castConfigEnabled()).rejects.toThrow();
    castEnabled = false;
    await expect(C.castConfigEnabled()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('castConfigAirplayContinuous', () => {
  it('is false until /api/cast/config answered, then follows the answer', async () => {
    airplayCont = true;
    expect(C.castConfigAirplayContinuous()).toBe(false);
    await C.castConfigEnabled();
    expect(C.castConfigAirplayContinuous()).toBe(true);
  });

  it('stays false when the answer says off or lacks the field', async () => {
    airplayCont = false;
    await C.castConfigEnabled();
    expect(C.castConfigAirplayContinuous()).toBe(false);
    vi.resetModules();
    C = await import('./cast');
    airplayCont = undefined;
    await C.castConfigEnabled();
    expect(C.castConfigAirplayContinuous()).toBe(false);
  });
});

describe('continuousFields', () => {
  const on = { episode: true, autoplay: true, sleepAfter: false, maxEpisodes: 3 };
  it('is empty while the config is off, for a film, with autoplay off and with sleep-after', async () => {
    expect(C.continuousFields(on)).toEqual({});
    airplayCont = true;
    await C.castConfigEnabled();
    expect(C.continuousFields({ ...on, episode: false })).toEqual({});
    expect(C.continuousFields({ ...on, autoplay: false })).toEqual({});
    expect(C.continuousFields({ ...on, sleepAfter: true })).toEqual({});
    expect(C.continuousFields({ ...on, maxEpisodes: 2 })).toEqual({ continuous: true, maxEpisodes: 2 });
  });
});

describe('postAirPlayToken', () => {
  const posts: Array<Record<string, unknown>> = [];
  const answer = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
  beforeEach(() => { posts.length = 0; });
  it('continuous_off retries once without continuous', async () => {
    const replies = [answer(400, { error: 'continuous_off' }), answer(200, { castId: 'c' })];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => { posts.push(JSON.parse(init.body)); return replies.shift()!; }));
    await expect(C.postAirPlayToken({ itemId: 'i', via: 'airplay', continuous: true, maxEpisodes: 2 })).resolves.toMatchObject({ castId: 'c' });
    expect(posts).toEqual([{ itemId: 'i', via: 'airplay', continuous: true, maxEpisodes: 2 }, { itemId: 'i', via: 'airplay' }]);
  });
  it('any other error is thrown and a body without continuous is not retried', async () => {
    const f = vi.fn(async () => answer(400, { error: 'continuous_off' }));
    vi.stubGlobal('fetch', f);
    await expect(C.postAirPlayToken({ itemId: 'i', via: 'airplay' })).rejects.toMatchObject({ body: { error: 'continuous_off' } });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('the cast right (me.perms.cast)', () => {
  it('castAllowed follows the right; castCapableBrowser stays a pure browser check', async () => {
    const P = await import('./perms');
    expect(C.castAllowed()).toBe(true);
    P.perms.set(P.permsFrom({ cast: false }));
    expect(C.castAllowed()).toBe(false);
    expect(C.castCapableBrowser()).toBe(true);
  });
  it('initCast loads nothing without the right, and starts once it is given (not locked out)', async () => {
    const P = await import('./perms');
    P.perms.set(P.permsFrom({ cast: false }));
    await C.initCast();
    expect(scripts).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    P.perms.set(P.ALL_PERMS);
    await C.initCast();
    expect(scripts).toHaveLength(1);
  });
});

describe('initCast', () => {
  it('loads the SDK script once when the server offers casting', async () => {
    await C.initCast();
    await C.initCast();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.src).toContain('gstatic.com/cv/js/sender/v1/cast_sender.js');
    expect(scripts[0]!.async).toBe(true);
  });

  it('loads nothing when casting is off or the browser cannot cast', async () => {
    castEnabled = false;
    await C.initCast();
    expect(scripts).toHaveLength(0);
    vi.resetModules();
    C = await import('./cast');
    ua = 'Firefox/131.0';
    await C.initCast();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(scripts).toHaveLength(0);
  });

  it('retries on the next call after the config request failed (e.g. not logged in yet)', async () => {
    castEnabled = 'error';
    await C.initCast();
    expect(scripts).toHaveLength(0);
    castEnabled = true;
    await C.initCast();
    expect(scripts).toHaveLength(1);
  });

  it('configures the Default Media Receiver with origin-scoped auto join when the SDK reports ready', async () => {
    const sdk = await connectSdk();
    expect(sdk.context.setOptions).toHaveBeenCalledWith({ receiverApplicationId: 'CC1AD845', autoJoinPolicy: 'origin_scoped' });
  });

  it('does nothing when the SDK reports unavailable or its globals are missing', async () => {
    await C.initCast();
    win.__onGCastApiAvailable(false);
    win.__onGCastApiAvailable(true); // no globals installed
    expect(await C.requestCastSession()).toBe(false);
  });
});

describe('session and player state', () => {
  it('tracks device availability, session start/resume/end and emits events', async () => {
    const sdk = await connectSdk();
    const events: string[] = [];
    const off = C.onCastEvent((e) => events.push(e));
    sdk.fire('caststatechanged', { castState: 'NOT_CONNECTED' });
    expect(get(C.castState).available).toBe(true);
    sdk.fire('caststatechanged', { castState: 'NO_DEVICES_AVAILABLE' });
    expect(get(C.castState).available).toBe(false);

    sdk.context.current = sdk.session;
    Object.assign(sdk.player, { isConnected: true, playerState: 'PLAYING', currentTime: 12, duration: 3600, isPaused: false, volumeLevel: 0.5 });
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    expect(get(C.castState)).toMatchObject({ connected: true, deviceName: 'Living Room TV', state: 'playing', currentTime: 12, duration: 3600, paused: false, volume: 0.5 });
    expect(C.castConnected()).toBe(true);
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_RESUMED' });
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_ENDED' });
    expect(get(C.castState)).toMatchObject({ connected: false, deviceName: '', state: 'idle', loaded: false });
    expect(events).toEqual(['session-start', 'session-resume', 'session-end']); // resume starts nothing on its own
    off();
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    expect(events).toHaveLength(3);
  });

  it('emits media-end once when loaded media goes idle on the receiver', async () => {
    const sdk = await connectSdk();
    const events: string[] = [];
    C.onCastEvent((e) => events.push(e));
    sdk.context.current = sdk.session;
    sdk.change({ isConnected: true, isMediaLoaded: true, playerState: 'PLAYING' });
    expect(get(C.castState).loaded).toBe(true);
    sdk.change({ isMediaLoaded: false, playerState: 'IDLE' });
    sdk.change({ currentTime: 1 });
    expect(events).toEqual(['media-end']);
    // disconnecting is not "media finished"
    sdk.change({ isMediaLoaded: true, playerState: 'PLAYING' });
    sdk.context.current = null;
    sdk.change({ isConnected: false, isMediaLoaded: false, playerState: null });
    expect(events).toEqual(['media-end']);
    expect(get(C.castState)).toMatchObject({ connected: false, deviceName: '', state: 'idle' });
  });

  it('the receiver\'s idle reason comes with media-end, also when the SDK already dropped its media session', async () => {
    const sdk = await connectSdk();
    const seen: Array<string | null> = [];
    C.onCastEvent((e) => { if (e === 'media-end') seen.push(get(C.castState).idleReason); });
    sdk.context.current = sdk.session;
    sdk.change({ isConnected: true, isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: 'https://p/a.m3u8' } });
    expect(get(C.castState)).toMatchObject({ contentId: 'https://p/a.m3u8', idleReason: null });
    // the SDK updates the media object in place (IDLE / FINISHED), then forgets it
    sdk.mediaSession.idleReason = 'FINISHED';
    sdk.session.media = null;
    sdk.change({ isMediaLoaded: false, playerState: 'IDLE', mediaInfo: null });
    expect(seen).toEqual(['FINISHED']);
    // a new media: the old reason is gone
    sdk.session.media = { ...sdk.mediaSession, idleReason: null };
    sdk.change({ isMediaLoaded: true, playerState: 'PLAYING' });
    expect(get(C.castState).idleReason).toBeNull();
  });

  it('requestCastSession: true on success, false on cancel or error, false before the SDK is ready', async () => {
    expect(await C.requestCastSession()).toBe(false);
    const sdk = await connectSdk();
    expect(await C.requestCastSession()).toBe(true);
    sdk.context.requestSession.mockResolvedValueOnce('cancel');
    expect(await C.requestCastSession()).toBe(false);
    sdk.context.requestSession.mockRejectedValueOnce(new Error('session_error'));
    expect(await C.requestCastSession()).toBe(false);
  });
});

describe('loadOnCast', () => {
  const info: CastInfo = {
    castId: 'c', expiresAt: 0, playSessionId: 'ps', mediaSourceId: 'ms', runtimeTicks: 36_000_000_000, startTime: 95,
    contentUrl: 'https://p/media/c/TOKEN/Videos/x/master.m3u8', contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts',
    title: 'Pilot', seriesName: 'Show', imageUrl: 'https://p/img.jpg',
    subtitles: [{ index: 3, language: 'deu', title: 'Deutsch', url: 'https://p/s3.vtt' }, { index: 7, title: 'Unknown', url: 'https://p/s7.vtt' }],
  };

  it('is false without a session', async () => {
    expect(await C.loadOnCast(info)).toBe(false);
  });

  it('builds a buffered HLS load request with episode metadata, subtitle tracks and the active track', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    expect(await C.loadOnCast(info, 7)).toBe(true);
    const req = sdk.session.loadMedia.mock.calls[0]![0];
    const media = req.args[0];
    expect(media.args).toEqual([info.contentUrl, info.contentType]);
    expect(media).toMatchObject({ streamType: 'BUFFERED', hlsSegmentFormat: 'ts', duration: 3600 });
    expect(media.metadata).toMatchObject({ metadataType: 2, title: 'Pilot', seriesTitle: 'Show' });
    expect(media.metadata.images[0].args).toEqual(['https://p/img.jpg']);
    expect(media.tracks.map((t: any) => [t.args[0], t.language, t.name, t.trackContentId, t.trackContentType])).toEqual([
      [1, 'de', 'Deutsch', 'https://p/s3.vtt', 'text/vtt'],
      [2, 'und', 'Unknown', 'https://p/s7.vtt', 'text/vtt'],
    ]);
    expect(req).toMatchObject({ currentTime: 95, autoplay: true, activeTrackIds: [2] });
  });

  it('autoplay false loads paused', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    expect(await C.loadOnCast(info, -1, false)).toBe(true);
    expect(sdk.session.loadMedia.mock.calls[0]![0]).toMatchObject({ autoplay: false });
  });

  it('a movie without image or runtime, no active subtitle; a receiver error is false', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    const movie = { ...info, seriesName: undefined, imageUrl: undefined, runtimeTicks: undefined, subtitles: [] };
    expect(await C.loadOnCast(movie)).toBe(true);
    const req = sdk.session.loadMedia.mock.calls[0]![0];
    expect(req.args[0].metadata).toMatchObject({ metadataType: 1, title: 'Pilot' });
    expect(req.args[0].metadata.images).toBeUndefined();
    expect(req.args[0].duration).toBeUndefined();
    expect(req.activeTrackIds).toBeUndefined();
    sdk.session.loadMedia.mockResolvedValueOnce('load_failed');
    expect(await C.loadOnCast(movie)).toBe(false);
    sdk.session.loadMedia.mockRejectedValueOnce(new Error('x'));
    expect(await C.loadOnCast(movie)).toBe(false);
  });
});

describe('receiver queue (next episode)', () => {
  const next: CastInfo = {
    castId: 'n', expiresAt: 0, playSessionId: 'ps2', mediaSourceId: 'ms2', runtimeTicks: 18_000_000_000, startTime: 30,
    contentUrl: 'https://p/media/c/NEXT/Videos/y/master.m3u8', contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts',
    title: 'Second', seriesName: 'Show', subtitles: [{ index: 5, language: 'eng', title: 'English', url: 'https://p/s5.vtt' }],
  };

  it('is null without a session or when the receiver refuses', async () => {
    expect(await C.queueOnCast(next)).toBeNull();
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    sdk.mediaSession.queueInsertItems.mockImplementationOnce((_r: unknown, _ok: () => void, err: (e: unknown) => void) => err(new Error('INVALID_REQUEST')));
    expect(await C.queueOnCast(next)).toBeNull();
    // an SDK without the queue API (older sender, test fakes): null, never a page error
    delete (sdk.chromeCast.media as Record<string, unknown>).QueueItem;
    await expect(C.queueOnCast(next)).resolves.toBeNull();
  });

  it('queues the next title after the playing one (autoplay, preload, its resume position) and returns its queue item id', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    expect(await C.queueOnCast(next)).toBe(100);
    const req = sdk.mediaSession.queueInsertItems.mock.calls[0]![0];
    const item = req.args[0][0];
    expect(item).toMatchObject({ autoplay: true, startTime: 30, preloadTime: C.QUEUE_PRELOAD_S });
    expect(item.args[0].args).toEqual([next.contentUrl, next.contentType]);
    expect(item.args[0].metadata).toMatchObject({ title: 'Second', seriesTitle: 'Show' });
    C.castQueueNext();
    expect(sdk.mediaSession.queueNext).toHaveBeenCalledTimes(1);
    C.castQueueRemove(100);
    expect((sdk.mediaSession.queueRemoveItems.mock.calls[0] as any[])[0].args[0]).toEqual([100]);
  });

  it('subtitles follow the title the receiver plays (after it moved on to the queued one)', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    await C.loadOnCast({ ...next, contentUrl: 'https://p/first.m3u8', subtitles: [{ index: 5, title: 'X', url: 'x.vtt' }, { index: 6, title: 'Y', url: 'y.vtt' }] });
    await C.queueOnCast({ ...next, subtitles: [{ index: 9, title: 'Z', url: 'z.vtt' }, { index: 6, title: 'Y', url: 'y2.vtt' }] });
    sdk.change({ isConnected: true, isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: next.contentUrl } });
    C.castSetSubtitle(6);
    expect((sdk.mediaSession.editTracksInfo.mock.calls.at(-1) as any[])[0].args[0]).toEqual([2]);
  });
});

describe('remote controls', () => {
  it('are no-ops before the SDK is ready', () => {
    expect(() => { C.castPlayPause(); C.castPlay(); C.castPause(); C.castSeek(10); C.castSetVolume(1); C.castToggleMute(); C.castSetSubtitle(1); C.castStop(); }).not.toThrow();
  });

  it('drive the remote player controller', async () => {
    const sdk = await connectSdk();
    C.castPlayPause();
    expect(sdk.controller.playOrPause).toHaveBeenCalledTimes(1);
    sdk.player.isPaused = true;
    C.castPause(); // already paused
    C.castPlay();
    expect(sdk.controller.playOrPause).toHaveBeenCalledTimes(2);
    sdk.player.isPaused = false;
    C.castPlay(); // already playing
    C.castPause();
    expect(sdk.controller.playOrPause).toHaveBeenCalledTimes(3);
    C.castSeek(-5);
    expect(sdk.player.currentTime).toBe(0);
    expect(sdk.controller.seek).toHaveBeenCalled();
    C.castSetVolume(3);
    expect(sdk.player.volumeLevel).toBe(1);
    C.castSetVolume(-1);
    expect(sdk.player.volumeLevel).toBe(0);
    C.castToggleMute();
    expect(sdk.controller.muteOrUnmute).toHaveBeenCalled();
    C.castStop();
    expect(sdk.context.endCurrentSession).toHaveBeenCalledWith(true);
  });

  it('castSetSubtitle switches to the cast track of a subtitle index, or turns subtitles off', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    await C.loadOnCast({ castId: 'c', expiresAt: 0, playSessionId: 'p', mediaSourceId: 'm', startTime: 0, contentUrl: 'u', contentType: 't', hlsSegmentFormat: 'ts', title: 'x', subtitles: [{ index: 4, title: 'EN', language: 'eng', url: 'e.vtt' }] });
    C.castSetSubtitle(4);
    C.castSetSubtitle(-1);
    expect(sdk.mediaSession.editTracksInfo.mock.calls.map((c: any[]) => c[0].args[0])).toEqual([[1], []]);
  });
});

describe('own receiver (CAST_RECEIVER_APP_ID)', () => {
  const info: CastInfo = {
    castId: 'c'.repeat(32), expiresAt: 0, playSessionId: 'ps', mediaSourceId: 'ms', startTime: 0,
    contentUrl: 'https://p/media/c/TOKEN/Videos/x/master.m3u8', contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', title: 'Pilot', subtitles: [],
    report: 'cmVwb3J0LXRva2VuLWNsYWltcw.' + 'S'.repeat(43),
  };
  /** the session with the custom channel methods of the real SDK */
  const withChannel = (sdk: ReturnType<typeof fakeSdk>) => {
    const sent: unknown[] = [];
    let onMsg: ((ns: string, m: string) => void) | null = null;
    Object.assign(sdk.session, {
      sendMessage: vi.fn(async (ns: string, m: unknown) => { sent.push([ns, m]); }),
      addMessageListener: vi.fn((_ns: string, fn: (ns: string, m: string) => void) => { onMsg = fn; }),
    });
    sdk.context.current = sdk.session;
    return { sent, rx: (m: string) => onMsg?.(C.CAST_NS, m) };
  };

  it('without an app ID: the Default Media Receiver, no receiver flag, no customData, nothing sent on a channel', async () => {
    const sdk = await connectSdk();
    const ch = withChannel(sdk);
    expect(sdk.context.setOptions.mock.calls[0]![0]).toEqual({ receiverApplicationId: 'CC1AD845', autoJoinPolicy: 'origin_scoped' });
    expect(C.castCustomReceiver()).toBe(false);
    const b = { itemId: 'x', via: undefined };
    expect(C.castBody(b)).toBe(b);
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    expect(await C.loadOnCast(info)).toBe(true);
    expect(sdk.session.loadMedia.mock.calls[0]![0].args[0].customData).toBeUndefined();
    C.castSendMessage({ t: 'x' });
    expect(ch.sent).toEqual([]);
    expect((sdk.session as unknown as { addMessageListener: ReturnType<typeof vi.fn> }).addMessageListener).not.toHaveBeenCalled();
  });

  it('with an app ID: starts that receiver, asks for the report token and hands it over on the private channel only', async () => {
    appId = 'A1B2C3D4';
    const sdk = await connectSdk();
    const ch = withChannel(sdk);
    expect(sdk.context.setOptions.mock.calls[0]![0]).toMatchObject({ receiverApplicationId: 'A1B2C3D4' });
    expect(C.castCustomReceiver()).toBe(true);
    expect(C.castBody({ itemId: 'x' })).toEqual({ itemId: 'x', receiver: true });
    expect(C.castBody({ itemId: 'x', via: 'airplay' })).toEqual({ itemId: 'x', via: 'airplay' }); // AirPlay never
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    expect(await C.loadOnCast(info)).toBe(true);
    const media = sdk.session.loadMedia.mock.calls[0]![0].args[0];
    expect(media.customData).toEqual({ ff: { castId: info.castId } });
    expect(JSON.stringify(media)).not.toContain(info.report!); // never in metadata other senders can read
    expect(ch.sent).toEqual([[C.CAST_NS, { t: 'caps?' }], [C.CAST_NS, { t: 'tok', castId: info.castId, rt: info.report }]]); // the session start asks for the caps
    // a queued one gets its token too; autoplay false (waits for "still watching?")
    expect(await C.queueOnCast({ ...info, castId: 'd'.repeat(32), contentUrl: 'https://p/n.m3u8' }, false)).toBe(100);
    expect(sdk.mediaSession.queueInsertItems.mock.calls[0]![0].args[0][0]).toMatchObject({ autoplay: false });
    expect(ch.sent).toHaveLength(3);
    // receiver messages reach the listeners (bad JSON / shapes are dropped)
    const got: unknown[] = [];
    const off = C.onReceiverMessage((m) => got.push(m));
    ch.rx('{"t":"interaction"}'); ch.rx('nope'); ch.rx('{"x":1}');
    off();
    ch.rx('{"t":"cancel"}');
    expect(got).toEqual([{ t: 'interaction' }]);
  });

  it('an invalid app ID in the answer falls back to the Default Media Receiver', async () => {
    appId = 'nothex!!';
    const sdk = await connectSdk();
    expect(sdk.context.setOptions.mock.calls[0]![0]).toMatchObject({ receiverApplicationId: 'CC1AD845' });
  });
});

describe('own receiver: what it confirms it plays (HEVC, Dolby)', () => {
  const info: CastInfo = {
    castId: 'c'.repeat(32), expiresAt: 0, playSessionId: 'ps-wren-1', mediaSourceId: 'ms', startTime: 0,
    contentUrl: 'https://p/media/c/TOKEN/Videos/x/master.m3u8', contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', title: 'Wrenfield Pier', subtitles: [],
  };
  const wren: NonNullable<CastInfo['delivery']> = { video: 'copy', videoCodec: 'hevc', audio: 'copy', audioCodec: 'eac3', channels: 6, why: ['hevc_device', 'surround_device'] };
  const CAPS = { t: 'caps', v: 1, hevc: true, hevc10: false, surround: ['eac3', 'ac3'] };
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) });
  });
  /** a NEW session object (every session of the real SDK is one) with the custom channel; the receiver's messages go to `rx` */
  const withChannel = (sdk: ReturnType<typeof fakeSdk>, device = 'Living Room TV') => {
    const sent: Array<Record<string, unknown>> = [];
    let onMsg: ((ns: string, m: string) => void) | null = null;
    const sess = Object.assign(Object.create(sdk.session) as typeof sdk.session, {
      getCastDevice: () => ({ friendlyName: device }),
      sendMessage: vi.fn(async (_ns: string, m: Record<string, unknown>) => { sent.push(m); }),
      addMessageListener: vi.fn((_ns: string, fn: (ns: string, m: string) => void) => { onMsg = fn; }),
    });
    sdk.context.current = sess;
    return { sent, rx: (m: unknown) => onMsg?.(C.CAST_NS, typeof m === 'string' ? m : JSON.stringify(m)) };
  };

  it('asks for the caps when a session starts and sends none before the receiver answered', async () => {
    appId = 'A1B2C3D4';
    const sdk = await connectSdk();
    const ch = withChannel(sdk);
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    expect(ch.sent).toContainEqual({ t: 'caps?' });
    expect(C.castBody({ itemId: 'x' })).toEqual({ itemId: 'x', receiver: true }); // an unanswered receiver claims nothing
  });

  it('the cast request carries what the receiver confirmed (HEVC, Dolby), nothing for AirPlay, nothing when it claims nothing', async () => {
    appId = 'A1B2C3D4';
    const sdk = await connectSdk();
    const ch = withChannel(sdk);
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    ch.rx(CAPS);
    expect(C.castBody({ itemId: 'x' })).toEqual({ itemId: 'x', receiver: true, caps: { hevc: true, hevc10: false, surround: ['eac3', 'ac3'] } });
    expect(C.castBody({ itemId: 'x', via: 'airplay' })).toEqual({ itemId: 'x', via: 'airplay' });
    ch.rx({ t: 'caps', v: 1, hevc: false, hevc10: false, surround: [] });
    expect(C.castBody({ itemId: 'x' })).toEqual({ itemId: 'x', receiver: true });
    // a malformed or foreign answer is ignored (the last valid one stays), and a caps message is not an engine message
    const got: unknown[] = [];
    C.onReceiverMessage((m) => got.push(m));
    ch.rx({ t: 'caps', v: 2, hevc: true, hevc10: true, surround: ['dts'] });
    ch.rx('{"t":"caps","v":1,"hevc":"yes"}');
    expect(C.castBody({ itemId: 'x' })).toEqual({ itemId: 'x', receiver: true });
    expect(got).toEqual([]);
  });

  it('a new session starts from nothing (what the last TV confirmed says nothing about the next), also after the session ended', async () => {
    appId = 'A1B2C3D4';
    const sdk = await connectSdk();
    const ch = withChannel(sdk);
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    ch.rx(CAPS);
    expect(C.castBody({ itemId: 'x' })).toHaveProperty('caps');
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_ENDED' });
    expect(C.castBody({ itemId: 'x' })).toEqual({ itemId: 'x', receiver: true });
  });

  it('without the own receiver: no caps, no asking, a caps message from nowhere is never used', async () => {
    const sdk = await connectSdk();
    const ch = withChannel(sdk);
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    ch.rx(CAPS);
    expect(ch.sent).toEqual([]);
    const b = { itemId: 'x' };
    expect(C.castBody(b)).toBe(b);
    await expect(C.castCapsReady()).resolves.toBeUndefined();
  });

  it('castCapsReady: at once when known, when the receiver answers, and after 2 s at the latest (then not again this session)', async () => {
    vi.useFakeTimers();
    try {
      appId = 'A1B2C3D4';
      const sdk = await connectSdk();
      await expect(C.castCapsReady()).resolves.toBeUndefined(); // no session: nothing to wait for
      const ch = withChannel(sdk);
      sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
      let done = 0;
      void C.castCapsReady().then(() => done++);
      await vi.advanceTimersByTimeAsync(C.CAPS_WAIT_MS - 1);
      expect(done).toBe(0);
      ch.rx(CAPS); // answered in time
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(1);
      await expect(C.castCapsReady()).resolves.toBeUndefined();
      // a receiver that never answers: the request goes out after the wait without caps, the next one does not wait again
      sdk.fire('sessionstatechanged', { sessionState: 'SESSION_ENDED' });
      withChannel(sdk);
      sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
      let late = 0;
      void C.castCapsReady().then(() => late++);
      await vi.advanceTimersByTimeAsync(C.CAPS_WAIT_MS + 1);
      expect(late).toBe(1);
      expect(C.castBody({ itemId: 'x' })).toEqual({ itemId: 'x', receiver: true });
      let again = 0;
      void C.castCapsReady().then(() => again++);
      await vi.advanceTimersByTimeAsync(0);
      expect(again).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('a TV where HEVC / Dolby failed is asked without it (by device name, 30 days), also in the same session', async () => {
    appId = 'A1B2C3D4';
    const sdk = await connectSdk();
    const ch = withChannel(sdk);
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    ch.rx(CAPS);
    expect(C.castFellBack({ ...info, delivery: { ...wren, audio: 'surround' } })).toBe('both');
    expect(C.castBody({ itemId: 'x' })).toEqual({ itemId: 'x', receiver: true }); // nothing left to claim: a plain cast
    expect(JSON.parse(storage.get('ff-cast-avoid')!)).toMatchObject({ 'Living Room TV': { hevc: expect.any(Number), surround: expect.any(Number) } });
    // the next session on the same TV (the memory, not the session) keeps them out; another TV is not affected
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_ENDED' });
    const ch2 = withChannel(sdk);
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    ch2.rx(CAPS);
    expect(C.castBody({ itemId: 'x' })).toEqual({ itemId: 'x', receiver: true });
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_ENDED' });
    const ch3 = withChannel(sdk, 'Kitchen TV');
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    ch3.rx(CAPS);
    expect(C.castBody({ itemId: 'x' })).toHaveProperty('caps.hevc', true);
  });

  it('castFellBack names only what the stream carried; nothing (null) for a plain stream, without delivery or without the own receiver', async () => {
    appId = 'A1B2C3D4';
    const sdk = await connectSdk();
    withChannel(sdk);
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    expect(C.castFellBack({ ...info, delivery: { ...wren, videoCodec: 'h264', channels: 6 } })).toBe('surround');
    expect(C.castFellBack({ ...info, delivery: { ...wren, channels: 2 } })).toBe('hevc');
    expect(C.castFellBack({ ...info, delivery: { ...wren, videoCodec: 'h264', channels: 2 } })).toBeNull();
    expect(C.castFellBack(info)).toBeNull();
  });

  it('the Default Media Receiver never falls back and never writes the avoid memory', async () => {
    const sdk = await connectSdk();
    withChannel(sdk);
    expect(C.castFellBack({ ...info, delivery: wren })).toBeNull();
    expect(storage.has('ff-cast-avoid')).toBe(false);
  });

  it('a HEVC / surround stream is loaded as fMP4 (segment format and video segment format); every other stream stays TS exactly as before', async () => {
    appId = 'A1B2C3D4';
    const sdk = await connectSdk();
    withChannel(sdk);
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    // the fake SDK has no FMP4 constants: the documented literal values are used
    expect(await C.loadOnCast({ ...info, hlsSegmentFormat: 'fmp4', hlsVideoSegmentFormat: 'fmp4' })).toBe(true);
    const fmp4 = sdk.session.loadMedia.mock.calls[0]![0].args[0];
    expect([fmp4.hlsSegmentFormat, fmp4.hlsVideoSegmentFormat]).toEqual(['fmp4', 'fmp4']);
    expect(await C.loadOnCast(info)).toBe(true);
    const ts = sdk.session.loadMedia.mock.calls[1]![0].args[0];
    expect(ts.hlsSegmentFormat).toBe('ts');
    expect('hlsVideoSegmentFormat' in ts).toBe(false);
    // a queued episode carries its own format
    expect(await C.queueOnCast({ ...info, castId: 'd'.repeat(32), contentUrl: 'https://p/n.m3u8', hlsSegmentFormat: 'fmp4' })).toBe(100);
  });

  it('with the SDK\'s own constants the loaded media uses them', async () => {
    const sdk = await connectSdk();
    Object.assign(sdk.chromeCast.media, { HlsSegmentFormat: { TS: 'ts', FMP4: 'FMP4_SDK' }, HlsVideoSegmentFormat: { FMP4: 'VIDEO_FMP4_SDK' } });
    sdk.context.current = sdk.session;
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    await C.loadOnCast({ ...info, hlsSegmentFormat: 'fmp4' });
    const m = sdk.session.loadMedia.mock.calls[0]![0].args[0];
    expect([m.hlsSegmentFormat, m.hlsVideoSegmentFormat]).toEqual(['FMP4_SDK', 'VIDEO_FMP4_SDK']);
  });
});

describe('loadLiveOnCast', () => {
  it('sets no HLS segment format (livetv serves TS or fMP4 per stream mode)', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    const ok = await C.loadLiveOnCast({
      contentId: 'https://p/media/l/tok/index.m3u8', contentType: 'application/x-mpegURL', streamType: 'LIVE',
      metadata: { title: 'Ch', subtitle: 'Now', images: [] }, customData: { ui: { live: true } },
    });
    expect(ok).toBe(true);
    const media = sdk.session.loadMedia.mock.calls[0]![0].args[0];
    expect(media.streamType).toBe('LIVE');
    expect(media.hlsSegmentFormat).toBeUndefined();
    expect('hlsSegmentFormat' in media).toBe(false);
  });

  it('an fMP4 live stream tells the receiver so, like the film path (bughunt M2)', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    expect(await C.loadLiveOnCast({
      contentId: 'https://p/media/l/tok/index.m3u8', contentType: 'application/x-mpegURL', streamType: 'LIVE', hlsSegmentFormat: 'fmp4',
      metadata: { title: 'Ch', subtitle: '', images: [] }, customData: { ui: { live: true } },
    })).toBe(true);
    const media = sdk.session.loadMedia.mock.calls[0]![0].args[0];
    expect([media.hlsSegmentFormat, media.hlsVideoSegmentFormat]).toEqual(['fmp4', 'fmp4']);
    // with the SDK's own constants
    Object.assign(sdk.chromeCast.media, { HlsSegmentFormat: { TS: 'ts', FMP4: 'FMP4_SDK' }, HlsVideoSegmentFormat: { FMP4: 'VIDEO_FMP4_SDK' } });
    await C.loadLiveOnCast({
      contentId: 'https://p/media/l/tok2/index.m3u8', contentType: 'application/x-mpegURL', streamType: 'LIVE', hlsSegmentFormat: 'fmp4',
      metadata: { title: 'Ch', subtitle: '', images: [] }, customData: { ui: { live: true } },
    });
    const m2 = sdk.session.loadMedia.mock.calls[1]![0].args[0];
    expect([m2.hlsSegmentFormat, m2.hlsVideoSegmentFormat]).toEqual(['FMP4_SDK', 'VIDEO_FMP4_SDK']);
  });
});

describe('resume plumbing', () => {
  it('emits session-resume on SESSION_RESUMED and for a session present at setup', async () => {
    const sdk = await connectSdk();
    const events: string[] = [];
    C.onCastEvent((e) => events.push(e));
    sdk.context.current = sdk.session;
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_RESUMED' });
    expect(events).toEqual(['session-resume']);

    // a session the SDK auto-joined before setup() ran
    vi.resetModules();
    C = await import('./cast');
    const early: string[] = [];
    C.onCastEvent((e) => early.push(e));
    const sdk2 = fakeSdk();
    sdk2.context.current = sdk2.session;
    await C.initCast();
    win.cast = { framework: sdk2.framework };
    win.chrome = { cast: sdk2.chromeCast };
    win.__onGCastApiAvailable(true);
    expect(early).toEqual(['session-resume']);
    expect(get(C.castState).deviceName).toBe('Living Room TV');
  });

  it('whenCastReady runs after the setup (after its session-resume), at once once ready, never without the SDK', async () => {
    const seen: string[] = [];
    C.onCastEvent((e) => seen.push(e));
    C.whenCastReady(() => seen.push('ready'));
    C.whenCastReady(() => { throw new Error('one waiter'); });
    C.whenCastReady(() => seen.push('ready 2'));
    await C.initCast();
    win.__onGCastApiAvailable(false); // unavailable: nobody is told it is ready
    expect(seen).toEqual([]);
    const sdk = fakeSdk();
    sdk.context.current = sdk.session;
    win.cast = { framework: sdk.framework };
    win.chrome = { cast: sdk.chromeCast };
    win.__onGCastApiAvailable(true);
    expect(seen).toEqual(['session-resume', 'ready', 'ready 2']);
    C.whenCastReady(() => seen.push('late'));
    expect(seen.at(-1)).toBe('late');
  });

  it('castState carries the own receiver castId and the queued items', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    const id = 'cd'.repeat(16), nextId = 'ef'.repeat(16);
    sdk.mediaSession.items.push(
      { itemId: 1, media: { contentId: 'https://p/a.m3u8', customData: { ff: { castId: id } } } },
      { itemId: 2, media: { contentId: 'https://p/b.m3u8', customData: { ff: { castId: nextId } } } },
      { itemId: 3, media: { contentId: 'https://p/c.m3u8' } },
    );
    sdk.mediaSession.currentItemId = 1;
    sdk.change({ isConnected: true, isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: 'https://p/a.m3u8', customData: { ff: { castId: id } } } });
    const s = get(C.castState);
    expect(s.castId).toBe(id);
    expect(s.queue).toEqual([{ itemId: 2, contentId: 'https://p/b.m3u8', castId: nextId }, { itemId: 3, contentId: 'https://p/c.m3u8', castId: '' }]);
    // not 32 hex: ignored
    sdk.change({ mediaInfo: { contentId: 'https://p/a.m3u8', customData: { ff: { castId: 'nope' } } } });
    expect(get(C.castState).castId).toBe('');
  });

  it('an unknown currentItemId gives an empty queue, never the playing item', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    sdk.mediaSession.items.push({ itemId: 1, media: { contentId: 'https://p/a.m3u8' } }, { itemId: 2, media: { contentId: 'https://p/b.m3u8' } });
    sdk.mediaSession.currentItemId = 9;
    sdk.change({ isConnected: true, isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: 'https://p/c.m3u8' } });
    expect(get(C.castState).queue).toEqual([]);
  });

  it('the first queue item counts as playing without a current item id', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    sdk.mediaSession.items.push({ itemId: 1, media: { contentId: 'https://p/a.m3u8' } }, { itemId: 2, media: { contentId: 'https://p/b.m3u8' } });
    sdk.change({ isConnected: true, isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: 'https://p/a.m3u8' } });
    expect(get(C.castState).queue.map((q) => q.contentId)).toEqual(['https://p/b.m3u8']);
  });

  it('castAdoptTracks lets castSetSubtitle pick the right track id', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    C.castAdoptTracks('https://p/a.m3u8', [{ index: 3 }, { index: 7 }]);
    C.castSetSubtitle(7);
    expect(sdk.mediaSession.editTracksInfo.mock.calls[0]![0]).toMatchObject({ args: [[2]] });
    C.castSetSubtitle(-1);
    expect(sdk.mediaSession.editTracksInfo.mock.calls[1]![0]).toMatchObject({ args: [[]] });
  });

  it('castActiveSubtitle: the subtitle index the receiver shows (from the adopted track map), -1 for none or no session', async () => {
    expect(C.castActiveSubtitle()).toBe(-1);
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    C.castAdoptTracks('https://p/a.m3u8', [{ index: 3 }, { index: 7 }]);
    expect(C.castActiveSubtitle()).toBe(-1);
    (sdk.mediaSession as unknown as { activeTrackIds: number[] }).activeTrackIds = [2];
    expect(C.castActiveSubtitle()).toBe(7);
    (sdk.mediaSession as unknown as { activeTrackIds: number[] }).activeTrackIds = [9];
    expect(C.castActiveSubtitle()).toBe(-1);
  });

  it('castAdoptTracks of a title that is not the playing one waits for it to play', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    sdk.change({ isConnected: true, isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: 'https://p/a.m3u8' } });
    C.castAdoptTracks('https://p/b.m3u8', [{ index: 5 }]);
    C.castSetSubtitle(5); // the playing title has no track 5
    expect(sdk.mediaSession.editTracksInfo.mock.calls[0]![0]).toMatchObject({ args: [[]] });
    sdk.change({ mediaInfo: { contentId: 'https://p/b.m3u8' } }); // the queued title took over
    C.castSetSubtitle(5);
    expect(sdk.mediaSession.editTracksInfo.mock.calls[1]![0]).toMatchObject({ args: [[1]] });
  });

  it('castLeave disconnects without stopping the receiver', async () => {
    const sdk = await connectSdk();
    C.castLeave();
    expect(sdk.context.endCurrentSession).toHaveBeenCalledTimes(1);
    expect(sdk.context.endCurrentSession).toHaveBeenCalledWith(false);
    C.castStop();
    expect(sdk.context.endCurrentSession).toHaveBeenLastCalledWith(true);
  });

  it('writes session and receiver-error entries to the cast log, never a URL', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    sdk.change({ isConnected: true, isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: 'https://friend.example.com/media/c/T/x.m3u8' } });
    sdk.mediaSession.idleReason = 'ERROR';
    sdk.change({ isMediaLoaded: false, playerState: 'IDLE' });
    sdk.change({ currentTime: 3 }); // the same error is not logged twice
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_ENDED' });
    const log = JSON.parse(store.get('ff-castlog')!) as Array<{ tag: string; level: string; text: string }>;
    expect(log.map((e) => `${e.tag}:${e.level}`)).toEqual(['session:info', 'receiver:error', 'session:info']);
    expect(log[0]!.text).toContain('Living Room TV');
    expect(JSON.stringify(log)).not.toContain('friend.example.com');
    expect(JSON.parse(store.get('ff-castlog-devices')!)).toEqual(['Living Room TV']);
    // no session to name: the log says so, the fallback is never remembered as a device
    sdk.context.current = null;
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_RESUMED' });
    expect(JSON.parse(store.get('ff-castlog')!).at(-1).text).toContain('unknown device');
    expect(JSON.parse(store.get('ff-castlog-devices')!)).toEqual(['Living Room TV']);
  });
});

describe('castTestClip', () => {
  const CLIP = 'https://friend.example.com/cast-test/clip.mp4';
  afterEach(() => vi.useRealTimers());

  it('measures the first frame and ends the session it opened', async () => {
    vi.useFakeTimers();
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    sdk.change({ isConnected: true, playerState: 'IDLE' });
    const p = C.castTestClip(CLIP, 'FriendFlix test', { endAfter: true });
    const req = sdk.session.loadMedia.mock.calls[0]![0];
    expect(req.args[0].args).toEqual([CLIP, 'video/mp4']);
    expect(req.autoplay).toBe(true);
    await vi.advanceTimersByTimeAsync(1900);
    sdk.change({ isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: CLIP } });
    await expect(p).resolves.toEqual({ ok: true, firstFrameMs: 1900 });
    expect(sdk.context.endCurrentSession).not.toHaveBeenCalled();
    sdk.mediaSession.idleReason = 'FINISHED';
    sdk.change({ isMediaLoaded: false, playerState: 'IDLE' });
    expect(sdk.context.endCurrentSession).toHaveBeenCalledTimes(1);
    expect(sdk.context.endCurrentSession).toHaveBeenCalledWith(true);
  });

  it('does not end a later real cast after something else took over the receiver', async () => {
    vi.useFakeTimers();
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    sdk.change({ isConnected: true, playerState: 'IDLE' });
    const p = C.castTestClip(CLIP, 't', { endAfter: true });
    sdk.change({ isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: CLIP } });
    await p;
    sdk.change({ mediaInfo: { contentId: 'https://friend.example.com/media/c/T/x.m3u8' } }); // a real title was loaded
    sdk.mediaSession.idleReason = 'FINISHED';
    sdk.change({ isMediaLoaded: false, playerState: 'IDLE', mediaInfo: null });
    expect(sdk.context.endCurrentSession).not.toHaveBeenCalled();
  });

  it('a clip the caller did not open leaves no watch timer behind', async () => {
    vi.useFakeTimers();
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    sdk.change({ isConnected: true, playerState: 'IDLE' });
    const p = C.castTestClip(CLIP, 't');
    sdk.change({ isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: CLIP } });
    expect(await p).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops watching the clip when the TV stopped it, and after 60 s', async () => {
    vi.useFakeTimers();
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    sdk.change({ isConnected: true, playerState: 'IDLE' });
    const p = C.castTestClip(CLIP, 't', { endAfter: true });
    sdk.change({ isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: CLIP } });
    await p;
    sdk.mediaSession.idleReason = 'CANCELLED';
    sdk.change({ isMediaLoaded: false, playerState: 'IDLE' });
    sdk.mediaSession.idleReason = 'FINISHED';
    sdk.change({ currentTime: 1 });
    expect(sdk.context.endCurrentSession).not.toHaveBeenCalled();
    const p2 = C.castTestClip(CLIP, 't', { endAfter: true });
    sdk.change({ isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: CLIP } });
    await p2;
    await vi.advanceTimersByTimeAsync(60_000);
    sdk.change({ isMediaLoaded: false, playerState: 'IDLE' });
    expect(sdk.context.endCurrentSession).not.toHaveBeenCalled();
  });

  it('sends the TV an absolute URL for a relative path', async () => {
    vi.stubGlobal('location', { pathname: '/', href: 'https://friend.example.com/diagnose' });
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    void C.castTestClip('/cast-test/clip.mp4', 't');
    const req = sdk.session.loadMedia.mock.calls[0]![0];
    expect(req.args[0].args[0]).toBe('https://friend.example.com/cast-test/clip.mp4');
  });

  it('leaves the session alone when the caller did not open it', async () => {
    vi.useFakeTimers();
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    sdk.change({ isConnected: true, playerState: 'IDLE' });
    const p = C.castTestClip(CLIP, 'FriendFlix test');
    sdk.change({ isMediaLoaded: true, playerState: 'PLAYING', mediaInfo: { contentId: CLIP } });
    await expect(p).resolves.toMatchObject({ ok: true });
    sdk.mediaSession.idleReason = 'FINISHED';
    sdk.change({ isMediaLoaded: false, playerState: 'IDLE' });
    expect(sdk.context.endCurrentSession).not.toHaveBeenCalled();
  });

  it('gives up after 20 s, on a load error and without a session', async () => {
    vi.useFakeTimers();
    await expect(C.castTestClip(CLIP, 't')).resolves.toEqual({ ok: false, firstFrameMs: null });
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    sdk.change({ isConnected: true, playerState: 'IDLE' });
    const slow = C.castTestClip(CLIP, 't');
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(slow).resolves.toEqual({ ok: false, firstFrameMs: null });
    sdk.session.loadMedia.mockResolvedValueOnce('load_failed');
    await expect(C.castTestClip(CLIP, 't')).resolves.toEqual({ ok: false, firstFrameMs: null });
    sdk.session.loadMedia.mockRejectedValueOnce(new Error('x'));
    await expect(C.castTestClip(CLIP, 't')).resolves.toEqual({ ok: false, firstFrameMs: null });
  });

  it('fails when the session ends or the receiver errors before the first frame', async () => {
    const sdk = await connectSdk();
    sdk.context.current = sdk.session;
    sdk.change({ isConnected: true, playerState: 'IDLE' });
    const ended = C.castTestClip(CLIP, 't');
    sdk.fire('sessionstatechanged', { sessionState: 'SESSION_ENDED' });
    await expect(ended).resolves.toEqual({ ok: false, firstFrameMs: null });
    sdk.change({ isConnected: true, playerState: 'IDLE' });
    const errored = C.castTestClip(CLIP, 't');
    sdk.mediaSession.idleReason = 'ERROR';
    sdk.change({ isMediaLoaded: false, playerState: 'IDLE' });
    await expect(errored).resolves.toEqual({ ok: false, firstFrameMs: null });
  });
});
