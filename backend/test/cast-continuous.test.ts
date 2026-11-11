// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { airplayContinuousOn, castTtlSeconds, hashToken, joinedStopsSettled, revokeCasts } from '../src/cast.js';
import { ADMIN, cfg, makeEnv, type TestEnv } from './helpers.js';

const ID = 'a'.repeat(32);
const MS = 'b'.repeat(32);
type Sess = { cookies: Record<string, string>; csrf: string };
let n = 0;

/** Each describe owns its env: makeEnv resets the shared database, so two live envs in one file would invalidate each other's sessions. */
function useEnv(server?: 'plex') {
  const h = {
    env: undefined as unknown as TestEnv,
    admin: undefined as unknown as Sess,
    call: (method: string, url: string, body?: unknown) =>
      h.env.app.inject({ method: method as 'GET', url, cookies: h.admin.cookies, headers: { 'x-csrf-token': h.admin.csrf, 'x-forwarded-for': `10.2.0.${++n % 250}` }, payload: body as object }),
    put: (values: Record<string, unknown>) => h.call('PUT', '/api/admin/settings', { values }),
  };
  beforeAll(async () => {
    h.env = await makeEnv({
      'GET /Users/[^/]+/Items/[^/]+': () => ({ json: { Id: ID, Name: 'Film', Type: 'Movie', UserData: {} } }),
      'POST /Items/[^/]+/PlaybackInfo': () => ({
        json: { PlaySessionId: 'ps-12345678', MediaSources: [{ Id: MS, Container: 'mkv', SupportsDirectPlay: true, Bitrate: 4_000_000, RunTimeTicks: 7200 * 10_000_000, MediaStreams: [{ Index: 0, Type: 'Video', Height: 1080 }, { Index: 1, Type: 'Audio' }] }] },
      }),
    }, server ? { server } : {});
    h.admin = await h.env.login(ADMIN);
  });
  afterAll(() => h.env.close());
  return h;
}

describe('continuous AirPlay switch', () => {
  const h = useEnv();
  const session = (body: Record<string, unknown>) => h.call('POST', '/api/cast/session', { itemId: ID, ...body });

  it('config reports the switch', async () => {
    expect((await h.call('GET', '/api/cast/config')).json()).toEqual({ enabled: true, airplayContinuous: false });
    const was = h.env.ctx.cfg;
    try {
      h.env.ctx.cfg = { ...was, CAST_AIRPLAY_CONTINUOUS: 'true' };
      expect((await h.call('GET', '/api/cast/config')).json().airplayContinuous).toBe(true);
      expect(airplayContinuousOn(h.env.ctx)).toBe(true);
      // casting off wins over the switch
      h.env.ctx.cfg = { ...was, CAST_AIRPLAY_CONTINUOUS: 'true', CAST_ENABLED: 'false' };
      expect(airplayContinuousOn(h.env.ctx)).toBe(false);
      expect((await h.call('GET', '/api/cast/config')).json()).toEqual({ enabled: false, airplayContinuous: false });
    } finally { h.env.ctx.cfg = was; }
  });

  it('changed through the settings store without a restart', async () => {
    const r = await h.put({ CAST_AIRPLAY_CONTINUOUS: true });
    expect(r.statusCode, r.body).toBe(200);
    expect((await h.call('GET', '/api/cast/config')).json().airplayContinuous).toBe(true);
    expect((await h.put({ CAST_AIRPLAY_CONTINUOUS: false })).statusCode).toBe(200);
    expect((await h.call('GET', '/api/cast/config')).json().airplayContinuous).toBe(false);
  });

  it('continuous with the switch off is 400 continuous_off', async () => {
    const r = await session({ via: 'airplay', continuous: true });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'continuous_off' });
  });

  it('continuous for Chromecast is 400 bad_request', async () => {
    for (const via of [undefined, 'chromecast']) {
      const r = await session({ continuous: true, ...(via ? { via } : {}) });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'bad_request' });
    }
  });

  it('maxEpisodes without continuous AirPlay is 400 bad_request', async () => {
    for (const body of [{ maxEpisodes: 2 }, { via: 'chromecast', maxEpisodes: 2 }, { via: 'airplay', maxEpisodes: 2 }, { via: 'airplay', continuous: false, maxEpisodes: 2 }]) {
      const r = await session(body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json()).toEqual({ error: 'bad_request' });
    }
  });

  it('with the switch on a single token is still minted; maxEpisodes is 1 to 3', async () => {
    expect((await h.put({ CAST_AIRPLAY_CONTINUOUS: true })).statusCode).toBe(200);
    try {
      const r = await session({ via: 'airplay', continuous: true, maxEpisodes: 3 });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().contentUrl).toMatch(/\/media\/c\/[\w-]{43}\//);
      for (const maxEpisodes of [0, 4]) expect((await session({ via: 'airplay', continuous: true, maxEpisodes })).statusCode, String(maxEpisodes)).toBe(400);
    } finally { await h.put({ CAST_AIRPLAY_CONTINUOUS: false }); }
  });
});

describe('continuous AirPlay switch on Plex', () => {
  const h = useEnv('plex');

  it('is never offered, whatever the setting says', async () => {
    h.env.ctx.cfg = { ...h.env.ctx.cfg, CAST_AIRPLAY_CONTINUOUS: 'true' };
    expect(airplayContinuousOn(h.env.ctx)).toBe(false);
    expect((await h.call('GET', '/api/cast/config')).json()).toEqual({ enabled: true, airplayContinuous: false });
  });
});

describe('after the Plex block', () => {
  const h = useEnv();

  it('a fresh Jellyfin env is unaffected by the Plex one (each describe owns its database state)', async () => {
    expect((await h.call('GET', '/api/cast/config')).json()).toEqual({ enabled: true, airplayContinuous: false });
  });
});

/**
 * The joined AirPlay token (Task 16; ported from the spike's joinedSpike test): one token for the episode and up to two following
 * ones. Saltwater Almanac (fictional): S1 E10 is the last of its season, S2 E1-E3 follow; E3 is the series' last episode.
 */
describe('joined AirPlay token', () => {
  const SERIES = 'e'.repeat(32);
  const FILM = 'f'.repeat(32);
  type Stream = { Index: number; Language?: string; IsDefault?: boolean; IsForced?: boolean; Codec?: string };
  type Ep = {
    id: string; ms: string; ps: string; name: string; season: number; ix: number; rt: number; audio: Stream[]; subs: Stream[];
    /** the item lookup has no runtime / PlaybackInfo has none */
    noItemRt?: boolean; noPbRt?: boolean;
    /** PlaybackInfo refuses (Jellyfin ErrorCode -> 403 MediaError) / answers without a media source (a plain Error) */
    pbFail?: 'blocked' | 'nosource';
    /** PlaybackInfo lists the subtitles as image tracks while the item lookup lists them as text (no rendition is planned) */
    pbImageSubs?: boolean;
  };
  const ger = { Index: 1, Language: 'ger', IsDefault: true };
  const eng = { Index: 2, Language: 'eng' };
  const base = (): Ep[] => [
    { id: '1'.repeat(32), ms: 'a'.repeat(32), ps: 'ps-night-market', name: 'Night Market', season: 1, ix: 10, rt: 2832e7, audio: [ger, eng], subs: [{ Index: 3, Language: 'ger' }] },
    { id: '2'.repeat(32), ms: 'b'.repeat(32), ps: 'ps-toll-keeper', name: 'The Toll Keeper', season: 2, ix: 1, rt: 2643e7, audio: [ger, eng], subs: [{ Index: 3, Language: 'ger' }] },
    { id: '3'.repeat(32), ms: 'c'.repeat(32), ps: 'ps-glass-tides', name: 'Glass Tides', season: 2, ix: 2, rt: 2970e7, audio: [ger, { Index: 5, Language: 'eng' }], subs: [{ Index: 2, Language: 'eng' }, { Index: 4, Language: 'ger' }] },
    { id: '4'.repeat(32), ms: 'd'.repeat(32), ps: 'ps-low-water', name: 'Low Water', season: 2, ix: 3, rt: 2000e7, audio: [ger], subs: [] },
  ];
  let EPS = base();
  const streams = (e: Ep) => [
    { Index: 0, Type: 'Video', Codec: 'h264', Height: 1080 },
    ...e.audio.map((a) => ({ ...a, Type: 'Audio', Codec: 'aac', Channels: 2 })),
    ...e.subs.map((x) => ({ ...x, Type: 'Subtitle', Codec: x.Codec ?? 'srt', IsTextSubtitleStream: (x.Codec ?? 'srt') === 'srt' })),
  ];
  /** a later part's episode list fails at the network level (fetch TypeError, no MediaError) */
  let episodesThrow = false;
  const epDto = (e: Ep) => ({
    Id: e.id, Name: e.name, Type: 'Episode', SeriesId: SERIES, SeriesName: 'Saltwater Almanac', ParentIndexNumber: e.season, IndexNumber: e.ix, RunTimeTicks: e.noItemRt ? undefined : e.rt,
    ImageTags: { Primary: 'x' }, UserData: { PlaybackPositionTicks: 0 }, MediaSources: [{ Id: e.ms, MediaStreams: streams(e) }],
  });
  const H = { 'x-internal-secret': cfg.INTERNAL_SECRET };
  let env: TestEnv;
  let admin: Sess;
  beforeAll(async () => {
    env = await makeEnv({
      'GET /Users/[^/]+/Items/[^/]+': (u) => {
        if (u.pathname.endsWith(FILM)) return { json: { Id: FILM, Name: 'Film', Type: 'Movie', RunTimeTicks: 5400e7, UserData: {} } };
        return { json: epDto(EPS.find((e) => u.pathname.endsWith(e.id)) ?? EPS[0]!) };
      },
      [`GET /Shows/${SERIES}/Episodes`]: (u) => {
        if (episodesThrow) throw new TypeError('fetch failed');
        const i = EPS.findIndex((e) => e.id === u.searchParams.get('startItemId'));
        return { json: { Items: EPS.slice(i, i + Number(u.searchParams.get('limit') ?? 2)).map(epDto) } };
      },
      'POST /Items/[^/]+/PlaybackInfo': (u) => {
        if (u.pathname.includes(FILM)) return { json: { PlaySessionId: 'ps-film-0001', MediaSources: [{ Id: MS, Container: 'mkv', Bitrate: 4_000_000, RunTimeTicks: 5400e7, MediaStreams: [{ Index: 0, Type: 'Video', Height: 1080 }, { Index: 1, Type: 'Audio' }] }] } };
        const e = EPS.find((x) => u.pathname.includes(x.id))!;
        if (e.pbFail === 'blocked') return { json: { ErrorCode: 'NotAllowed' } };
        if (e.pbFail === 'nosource') return { json: { PlaySessionId: e.ps, MediaSources: [] } };
        const ms = streams(e).map((x) => (e.pbImageSubs && x.Type === 'Subtitle' ? { ...x, Codec: 'pgssub', IsTextSubtitleStream: false } : x));
        return { json: { PlaySessionId: e.ps, MediaSources: [{ Id: e.ms, Container: 'mkv', Bitrate: 4_000_000, RunTimeTicks: e.noPbRt ? undefined : e.rt, MediaStreams: ms }] } };
      },
      'DELETE /Videos/ActiveEncodings': () => ({ status: 204 }),
    });
    admin = await env.login(ADMIN);
    expect((await call('PUT', '/api/admin/settings', { values: { CAST_AIRPLAY_CONTINUOUS: true } })).statusCode).toBe(200);
  });
  afterAll(() => env.close());
  const call = (method: string, url: string, body?: unknown) =>
    env.app.inject({ method: method as 'GET', url, cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf, 'x-forwarded-for': `10.3.${Math.floor(++n / 250)}.${n % 250}` }, payload: body as object });
  const joined = async (body: Record<string, unknown> = {}) => {
    const r = await call('POST', '/api/cast/session', { itemId: EPS[0]!.id, via: 'airplay', continuous: true, ...body });
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    const ct = /\/media\/c\/([\w-]{43})\//.exec(j.contentUrl)![1]!;
    const rec = JSON.parse((await env.kv.get(`cast:${hashToken(ct)}`))!);
    return { j, ct, rec };
  };
  const pbCalls = (id: string) => env.jfCalls.filter((c) => c.method === 'POST' && c.path === `/Items/${id}/PlaybackInfo`).length;
  const q = (path: string) => new URL(path, 'http://x').searchParams;

  it('continuous picks the episode and the next two, across a season', async () => {
    const { j, ct, rec } = await joined();
    const [r1, r2, r3] = EPS.map((e) => e.rt / 1e7);
    expect(j.contentUrl).toBe(`https://portal.example.com/media/c/${ct}/joined/master.m3u8`);
    expect(j.contentUrl.endsWith('/joined/master.m3u8')).toBe(true);
    expect(j.runtimeTicks).toBe(EPS[0]!.rt + EPS[1]!.rt + EPS[2]!.rt);
    expect(j.joined).toEqual({
      subtitles: false,
      items: [
        { itemId: EPS[0]!.id, title: 'Night Market', season: 1, episode: 10, start: 0, duration: r1 },
        { itemId: EPS[1]!.id, title: 'The Toll Keeper', season: 2, episode: 1, start: r1, duration: r2 },
        { itemId: EPS[2]!.id, title: 'Glass Tides', season: 2, episode: 2, start: r1! + r2!, duration: r3 },
      ],
    });
    // the record's own fields are item 0; each item keeps its own media source, play session and HLS master (no credential)
    expect(rec.itemId).toBe(EPS[0]!.id);
    expect(rec.items.map((i: { itemId: string; mediaSourceId: string; playSessionId: string; runtimeTicks: number }) => [i.itemId, i.mediaSourceId, i.playSessionId, i.runtimeTicks]))
      .toEqual(EPS.slice(0, 3).map((e) => [e.id, e.ms, e.ps, e.rt]));
    expect(rec.items[0]).toMatchObject({ itemId: rec.itemId, mediaSourceId: rec.mediaSourceId, playSessionId: rec.playSessionId, runtimeTicks: rec.runtimeTicks });
    for (const [k, i] of (rec.items as Array<{ hlsPath: string }>).entries()) {
      expect(i.hlsPath).toMatch(new RegExp(`^/Videos/${EPS[k]!.id}/master\\.m3u8\\?`));
      expect(i.hlsPath).not.toMatch(/api_key|ApiKey|Token=|X-Emby|\/media\//i);
      expect(i.hlsPath).not.toContain(ct);
      expect(q(i.hlsPath).get('PlaySessionId')).toBe(EPS[k]!.ps);
      expect(q(i.hlsPath).has('StartTimeTicks')).toBe(false);
    }
    // TTL follows the joined runtime (+1 h, at most 6 h)
    const ttl = castTtlSeconds(EPS[0]!.rt + EPS[1]!.rt + EPS[2]!.rt, 0);
    expect(j.expiresAt - Date.now()).toBeGreaterThan((ttl - 60) * 1000);
    expect(j.expiresAt - Date.now()).toBeLessThanOrEqual(ttl * 1000);
    // the answer carries nothing beyond today's single-token fields: no per-item path, play session of a later part or token
    expect(JSON.stringify(j)).not.toMatch(/hlsPath|ps-toll-keeper|ps-glass-tides/);
  });

  it('maxEpisodes 2 gives two', async () => {
    const { j, rec } = await joined({ maxEpisodes: 2 });
    expect(j.joined.items.map((i: { itemId: string }) => i.itemId)).toEqual([EPS[0]!.id, EPS[1]!.id]);
    expect(rec.items).toHaveLength(2);
    expect(j.runtimeTicks).toBe(EPS[0]!.rt + EPS[1]!.rt);
    // maxEpisodes 1 = a single token
    const one = await call('POST', '/api/cast/session', { itemId: EPS[0]!.id, via: 'airplay', continuous: true, maxEpisodes: 1 });
    expect(one.json().joined).toBeUndefined();
    expect(one.json().contentUrl).toMatch(/\/Videos\/1{32}\/master\.m3u8\?/);
  });

  it('autoplay off, a film, or the last episode give a single token', async () => {
    const single = async (itemId: string) => {
      const r = await call('POST', '/api/cast/session', { itemId, via: 'airplay', continuous: true });
      expect(r.statusCode, r.body).toBe(200);
      const j = r.json();
      expect(j.joined).toBeUndefined();
      expect(j.contentUrl).toMatch(new RegExp(`/media/c/[\\w-]{43}/Videos/${itemId}/master\\.m3u8\\?`));
      const ct = /\/media\/c\/([\w-]{43})\//.exec(j.contentUrl)![1]!;
      expect(JSON.parse((await env.kv.get(`cast:${hashToken(ct)}`))!).items).toBeUndefined();
      return j;
    };
    expect((await call('PUT', '/api/prefs', { autoplayNext: false })).statusCode).toBe(200);
    try {
      const j = await single(EPS[0]!.id);
      expect(j.runtimeTicks).toBe(EPS[0]!.rt);
    } finally { expect((await call('PUT', '/api/prefs', { autoplayNext: true })).statusCode).toBe(200); }
    await single(FILM);
    await single(EPS[3]!.id);
  });

  it('cap keeps the joined runtime under 6 h', async () => {
    try {
      EPS[0]!.rt = 2.5 * 3600e7;
      EPS[1]!.rt = 3 * 3600e7; // 5.5 h, a third (0.825 h) would make 6.3 h
      let { j } = await joined();
      expect(j.joined.items).toHaveLength(2);
      expect(j.runtimeTicks).toBe(5.5 * 3600e7);
      expect(j.expiresAt - Date.now()).toBeLessThanOrEqual(6 * 3600 * 1000);
      // what is left from the start position counts: an hour in, the third fits (6.3 h - 1 h)
      ({ j } = await joined({ startTicks: 3600e7 }));
      expect(j.joined.items).toHaveLength(3);
      expect(j.startTime).toBe(3600);
      // the first episode alone over 6 h: a single token
      EPS[0]!.rt = 6.5 * 3600e7;
      const r = await call('POST', '/api/cast/session', { itemId: EPS[0]!.id, via: 'airplay', continuous: true });
      expect(r.json().joined).toBeUndefined();
    } finally { EPS = base(); }
  });

  it('audio and subtitle by language per episode', async () => {
    const before = EPS.map((e) => pbCalls(e.id));
    // episode 1: English audio (index 2, not the default), German subtitle index 3; episode 3 has English at index 5 and German subtitles at 4
    const { j, rec } = await joined({ audioIndex: 2, subtitleIndex: 3 });
    expect(j.joined.subtitles).toBe(true);
    expect(j.hlsSub).toBe(true);
    expect(rec.items.map((i: { hlsSubIndex?: number }) => i.hlsSubIndex)).toEqual([3, 3, 4]);
    const [p1, p2, p3] = (rec.items as Array<{ hlsPath: string }>).map((i) => q(i.hlsPath));
    expect([p1!.get('AudioStreamIndex'), p2!.get('AudioStreamIndex'), p3!.get('AudioStreamIndex')]).toEqual(['2', '2', '5']);
    expect([p1!.get('SubtitleStreamIndex'), p2!.get('SubtitleStreamIndex'), p3!.get('SubtitleStreamIndex')]).toEqual(['3', '3', '4']);
    expect(p3!.get('SubtitleMethod')).toBe('Hls');
    // one PlaybackInfo per episode, never a second one for the subtitle
    expect(EPS.slice(0, 3).map((e, k) => pbCalls(e.id) - before[k]!)).toEqual([1, 1, 1]);
  });

  it('a part without that subtitle -> joined.subtitles false', async () => {
    try {
      EPS[1]!.subs = [{ Index: 3, Language: 'eng' }];
      const { j, rec } = await joined({ subtitleIndex: 3 });
      expect(j.joined.items).toHaveLength(3);
      expect(j.joined.subtitles).toBe(false);
      expect(rec.items.map((i: { hlsSubIndex?: number }) => i.hlsSubIndex)).toEqual([3, undefined, 4]);
      expect(q(rec.items[1].hlsPath).has('SubtitleStreamIndex')).toBe(false);
    } finally { EPS = base(); }
  });

  it('scope lists each item as a tuple', async () => {
    const { ct, rec } = await joined({ subtitleIndex: 3 });
    const a = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: H, payload: { ct, client: '198.51.100.7' } });
    expect(a.statusCode, a.body).toBe(200);
    const scope = a.json().scope;
    expect(scope).toMatchObject({ itemId: EPS[0]!.id, mediaSourceId: EPS[0]!.ms, playSessionId: EPS[0]!.ps, hlsSub: true, hlsSubIndex: 3 });
    expect(scope.items).toEqual(EPS.slice(0, 3).map((e, k) => ({ itemId: e.id, mediaSourceId: e.ms, playSessionId: e.ps, hlsPath: rec.items[k].hlsPath, hlsSubIndex: k === 2 ? 4 : 3 })));
    for (const i of scope.items) expect(i).not.toHaveProperty('runtimeTicks');
    // a single token has no items in its scope
    const one = await call('POST', '/api/cast/session', { itemId: EPS[0]!.id, via: 'airplay' });
    const ct1 = /\/media\/c\/([\w-]{43})\//.exec(one.json().contentUrl)![1]!;
    const a1 = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: H, payload: { ct: ct1, client: '198.51.100.7' } });
    expect(a1.json().scope.items).toBeUndefined();
  });

  it('a joined token keeps its scope after the switch is turned off', async () => {
    const { ct } = await joined();
    expect((await call('PUT', '/api/admin/settings', { values: { CAST_AIRPLAY_CONTINUOUS: false } })).statusCode).toBe(200);
    try {
      expect(airplayContinuousOn(env.ctx)).toBe(false);
      const a = await env.app.inject({ method: 'POST', url: '/internal/authz', headers: H, payload: { ct, client: '198.51.100.8' } });
      expect(a.statusCode, a.body).toBe(200);
      expect(a.json().scope.items.map((i: { itemId: string }) => i.itemId)).toEqual(EPS.slice(0, 3).map((e) => e.id));
      // new requests get no joined token
      expect((await call('POST', '/api/cast/session', { itemId: EPS[0]!.id, via: 'airplay', continuous: true })).json()).toEqual({ error: 'continuous_off' });
    } finally { expect((await call('PUT', '/api/admin/settings', { values: { CAST_AIRPLAY_CONTINUOUS: true } })).statusCode).toBe(200); }
  });

  it("a forced track is not the language's subtitle of a later part", async () => {
    try {
      // episode 2 lists its forced German track first; episode 3 has only a forced one (the fallback)
      EPS[1]!.subs = [{ Index: 3, Language: 'ger', IsForced: true }, { Index: 6, Language: 'ger' }];
      EPS[2]!.subs = [{ Index: 2, Language: 'eng' }, { Index: 4, Language: 'ger', IsForced: true }];
      const { j, rec } = await joined({ subtitleIndex: 3 });
      expect(rec.items.map((i: { hlsSubIndex?: number }) => i.hlsSubIndex)).toEqual([3, 6, 4]);
      expect(q(rec.items[1].hlsPath).get('SubtitleStreamIndex')).toBe('6');
      expect(j.joined.subtitles).toBe(true);
      // an image-only language: no subtitle for that part (never burned in)
      EPS[2]!.subs = [{ Index: 4, Language: 'ger', Codec: 'pgssub' }];
      const img = await joined({ subtitleIndex: 3 });
      expect(img.rec.items.map((i: { hlsSubIndex?: number }) => i.hlsSubIndex)).toEqual([3, 6, undefined]);
      expect(q(img.rec.items[2].hlsPath).has('SubtitleStreamIndex')).toBe(false);
      expect(img.j.joined.subtitles).toBe(false);
    } finally { EPS = base(); }
  });

  it("later parts follow episode 1's forced choice", async () => {
    try {
      EPS[0]!.subs = [{ Index: 3, Language: 'ger', IsForced: true }, { Index: 6, Language: 'ger' }];
      EPS[1]!.subs = [{ Index: 3, Language: 'ger', IsForced: true }, { Index: 6, Language: 'ger' }];
      EPS[2]!.subs = [{ Index: 2, Language: 'eng' }, { Index: 4, Language: 'ger', IsForced: true }, { Index: 7, Language: 'ger' }];
      // episode 1 on its forced track: the later parts on theirs
      let { j, rec } = await joined({ subtitleIndex: 3 });
      expect(rec.items.map((i: { hlsSubIndex?: number }) => i.hlsSubIndex)).toEqual([3, 3, 4]);
      expect(j.joined.subtitles).toBe(true);
      // episode 1 on its full track: the later parts on theirs
      ({ j, rec } = await joined({ subtitleIndex: 6 }));
      expect(rec.items.map((i: { hlsSubIndex?: number }) => i.hlsSubIndex)).toEqual([6, 6, 7]);
      // forced, but a later part has no forced German track: its full one
      EPS[2]!.subs = [{ Index: 7, Language: 'ger' }];
      ({ rec } = await joined({ subtitleIndex: 3 }));
      expect(rec.items.map((i: { hlsSubIndex?: number }) => i.hlsSubIndex)).toEqual([3, 3, 7]);
    } finally { EPS = base(); }
  });

  it('a later part keeps its subtitle only when its HLS URL carries the rendition', async () => {
    try {
      EPS[2]!.pbImageSubs = true; // the lookup says text, the PlaybackInfo plan carries none
      const { j, rec } = await joined({ subtitleIndex: 3 });
      expect(rec.items.map((i: { hlsSubIndex?: number }) => i.hlsSubIndex)).toEqual([3, 3, undefined]);
      expect(j.joined.subtitles).toBe(false);
    } finally { EPS = base(); }
  });

  it('a later part that fails its lookup ends the join there, the token is still minted', async () => {
    const stops = () => env.jfCalls.filter((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings').length;
    for (const fail of ['blocked', 'nosource'] as const) {
      try {
        EPS[2]!.pbFail = fail;
        const before = stops();
        const { j, rec } = await joined();
        expect(j.joined.items.map((i: { itemId: string }) => i.itemId), fail).toEqual([EPS[0]!.id, EPS[1]!.id]);
        expect(rec.items.map((i: { playSessionId: string }) => i.playSessionId)).toEqual([EPS[0]!.ps, EPS[1]!.ps]);
        expect(j.runtimeTicks).toBe(EPS[0]!.rt + EPS[1]!.rt);
        expect(stops()).toBe(before); // episode 1's play session is the token's, nothing to give back
      } finally { EPS = base(); }
    }
    // the episode list itself fails at the network level (no MediaError): episode 1 alone, a single token
    episodesThrow = true;
    try {
      const r = await call('POST', '/api/cast/session', { itemId: EPS[0]!.id, via: 'airplay', continuous: true });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().joined).toBeUndefined();
      expect(r.json().playSessionId).toBe(EPS[0]!.ps);
      const ct = /\/media\/c\/([\w-]{43})\//.exec(r.json().contentUrl)![1]!;
      expect(JSON.parse((await env.kv.get(`cast:${hashToken(ct)}`))!).playSessionId).toBe(EPS[0]!.ps);
    } finally { episodesThrow = false; }
  });

  it('audio language of episode 1 without an audio choice: its default track, else its first', async () => {
    try {
      // default English in episode 1 -> English in episode 2 (index 2 there, not its default)
      EPS[0]!.audio = [{ Index: 1, Language: 'ger' }, { Index: 2, Language: 'eng', IsDefault: true }];
      let { rec } = await joined({ maxEpisodes: 2 });
      expect(q(rec.items[1].hlsPath).get('AudioStreamIndex')).toBe('2');
      // no default track: the first one (English)
      EPS[0]!.audio = [{ Index: 1, Language: 'eng' }, { Index: 2, Language: 'ger' }];
      ({ rec } = await joined({ maxEpisodes: 2 }));
      expect(q(rec.items[1].hlsPath).get('AudioStreamIndex')).toBe('2');
      // German first: episode 2's default German needs no index
      EPS[0]!.audio = [{ Index: 1, Language: 'ger' }, { Index: 2, Language: 'eng' }];
      ({ rec } = await joined({ maxEpisodes: 2 }));
      expect(q(rec.items[1].hlsPath).has('AudioStreamIndex')).toBe(false);
    } finally { EPS = base(); }
  });

  it('an unknown runtime: single token for episode 1, the join ends before a later one', async () => {
    try {
      EPS[0]!.noPbRt = true;
      const r = await call('POST', '/api/cast/session', { itemId: EPS[0]!.id, via: 'airplay', continuous: true });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().joined).toBeUndefined();
      EPS = base();
      EPS[2]!.noItemRt = true; // the item's runtime decides (no PlaybackInfo is spent on it)
      const before = pbCalls(EPS[2]!.id);
      const { j } = await joined();
      expect(j.joined.items).toHaveLength(2);
      expect(pbCalls(EPS[2]!.id)).toBe(before);
    } finally { EPS = base(); }
  });

  it('the poster token record carries no items', async () => {
    const { ct } = await joined();
    const media = hashToken(ct);
    const idx = await Promise.all((await env.kv.keys('castidx:')).map(async (k) => JSON.parse((await env.kv.get(k))!) as { hash: string; kind?: string; imgHash?: string }));
    const imgHash = idx.find((i) => i.hash === media)!.imgHash!;
    expect(imgHash).toBeTruthy();
    const img = JSON.parse((await env.kv.get(`cast:${imgHash}`))!);
    expect(img.kind).toBe('img');
    expect(img).not.toHaveProperty('items');
    expect(JSON.parse((await env.kv.get(`cast:${media}`))!).items).toHaveLength(3);
  });

  // last in this describe: it switches the session's profile
  it('the profile-switch race revokes a joined token too', async () => {
    const p = await call('POST', '/api/profiles', { name: 'Kind' });
    expect(p.statusCode, p.body).toBe(201);
    const pid = p.json().profile.id as string;
    // earlier tests' tokens use the same play session names: they go first, so the count below is this mint's alone
    for (const uid of new Set((await env.kv.keys('castidx:')).map((x) => x.split(':')[1]!))) await revokeCasts(env.ctx, uid);
    await joinedStopsSettled();
    const jf = env.ctx.jf as unknown as { playbackInfo: (...a: unknown[]) => Promise<unknown> };
    const orig = jf.playbackInfo;
    let k = 0;
    // the switch lands while the mint is in flight: after the last part's PlaybackInfo, before the token exists
    jf.playbackInfo = async (...a) => { const r = await orig.apply(env.ctx.jf, a); if (++k === 3) await call('POST', `/api/profiles/${pid}/select`, {}); return r; };
    const calls = env.jfCalls.length;
    try {
      const r = await call('POST', '/api/cast/session', { itemId: EPS[0]!.id, via: 'airplay', continuous: true });
      expect(k).toBe(3);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: 'profile_changed' });
    } finally { jf.playbackInfo = orig; }
    expect(await env.kv.keys('cast:')).toEqual([]);
    expect(await env.kv.keys('castidx:')).toEqual([]);
    const stopped = env.jfCalls.slice(calls).filter((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings').map((c) => new URLSearchParams(c.search).get('playSessionId'));
    expect(stopped).toEqual(expect.arrayContaining(EPS.slice(0, 3).map((e) => e.ps)));
    // once each: the revoke's own stop of a joined token covers every part (no second loop after it)
    for (const e of EPS.slice(0, 3)) expect(stopped.filter((x) => x === e.ps), e.ps).toHaveLength(1);
  });
});
