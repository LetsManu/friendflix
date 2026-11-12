// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchError } from '../src/fetch.js';
import { PlaylistRefused, parseMedia, passthroughDriver } from '../src/passthrough.js';
import { PLAYLIST_MAX_BYTES, SEGMENT_MAX_BYTES } from '../src/probe.js';
import { Streams, type StartBody } from '../src/streams.js';
import { fakeFetch, flush, memoryStore, type Served } from './streams-helpers.js';

const NOW = Date.parse('2026-11-11T19:20:00.000Z');
const HOST = 'http://iptv.example.com';
const MASTER = `${HOST}/live/anna/geheim/101.m3u8`;
const ROOT = '/cache';

const body = (url = MASTER, maxBitrate = 10_000_000): StartBody => ({
  channelId: 'ch-nordlicht', input: { url, kind: 'hls', allowLan: false }, mode: 'passthrough', encoder: 'libx264', dvrSeconds: 7200, maxBitrate,
});

/** a provider media playlist: `n` 4-s segments from media sequence `seq` */
function media(seq: number, n: number, o: { pdt?: string; map?: string; ext?: string; disc?: number } = {}): string {
  const out = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', `#EXT-X-MEDIA-SEQUENCE:${seq}`];
  if (o.map) out.push(`#EXT-X-MAP:URI="${o.map}"`);
  for (let i = 0; i < n; i++) {
    if (o.disc === seq + i) out.push('#EXT-X-DISCONTINUITY');
    if (o.pdt && i === 0) out.push(`#EXT-X-PROGRAM-DATE-TIME:${o.pdt}`);
    out.push('#EXTINF:4.000,', `seg/${seq + i}.${o.ext ?? 'ts'}?token=geheim`);
  }
  return out.join('\n');
}

let routes: Map<string, Served>;
let ff: ReturnType<typeof fakeFetch>;
let mem: ReturnType<typeof memoryStore>;
let streams: Streams;
const logs: string[] = [];

/** every segment URL the fake provider knows answers 188 bytes */
function segments(base: string, from: number, to: number, ext = 'ts'): void {
  for (let s = from; s <= to; s++) routes.set(`${base}/seg/${s}.${ext}?token=geheim`, Buffer.alloc(188, s % 256));
}
const playlist = (key: string) => mem.files.get(`${ROOT}/${key}/index.m3u8`)?.toString('utf8') ?? '';
const uris = (text: string) => text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  routes = new Map();
  ff = fakeFetch(routes);
  mem = memoryStore();
  logs.length = 0;
  streams = new Streams({ root: ROOT, maxBytes: 1024 ** 3, drivers: { passthrough: passthroughDriver({ fetch: ff.fetch }) }, store: mem.store, log: (m) => logs.push(m) });
});
afterEach(async () => {
  await streams.close();
  vi.useRealTimers();
});

describe('passthrough', () => {
  it('picks the 6 Mbit/s H.264 variant under 10 Mbit/s; the served playlist names no provider host', async () => {
    routes.set(MASTER, [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=2500000,CODECS="avc1.4d401f,mp4a.40.2"', 'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=6000000,CODECS="avc1.640028,mp4a.40.2"', 'mid/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=12000000,CODECS="avc1.640032,mp4a.40.2"', 'high/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="hvc1.1.6.L120.90,mp4a.40.2"', 'hevc/index.m3u8',
    ].join('\n'));
    const base = `${HOST}/live/anna/geheim/mid`;
    routes.set(`${base}/index.m3u8`, media(50, 3));
    segments(base, 50, 52);
    const { streamKey, state } = streams.start(body());
    expect(streamKey).toMatch(/^[0-9a-f]{32}$/);
    expect(state).toBe('starting');
    await flush();
    expect(ff.calls.map((c) => c.url)).toEqual([MASTER, `${base}/index.m3u8`, ...[50, 51, 52].map((s) => `${base}/seg/${s}.ts?token=geheim`)]);
    expect(ff.calls.slice(0, 2).every((c) => c.maxBytes === PLAYLIST_MAX_BYTES)).toBe(true);
    expect(ff.calls.slice(2).every((c) => c.maxBytes === SEGMENT_MAX_BYTES)).toBe(true);
    const text = playlist(streamKey);
    expect(uris(text)).toEqual(['0.ts', '1.ts', '2.ts']);
    expect(text).not.toMatch(/iptv\.example\.com|geheim|seg\//);
    const [view] = streams.list();
    expect(view).toMatchObject({ channelId: 'ch-nordlicht', streamKey, mode: 'passthrough', state: 'running', bitrate: 6_000_000, errors: [], lastSegmentAt: NOW, since: NOW });
    expect(streams.file(streamKey, '1.ts')).toEqual({ path: `${ROOT}/${streamKey}/1.ts`, type: 'video/mp2t' });
    expect(mem.files.get(`${ROOT}/${streamKey}/1.ts`)).toEqual(Buffer.alloc(188, 51));
    expect(logs.join('\n')).not.toMatch(/iptv\.example|geheim|[0-9a-f]{32}/);
  });

  it('a provider media sequence that jumps back keeps local numbering monotonic', async () => {
    let phase = 1;
    routes.set(MASTER, () => (phase === 1 ? media(100, 3) : phase === 2 ? media(100, 6) : media(3, 3)));
    const base = `${HOST}/live/anna/geheim`;
    segments(base, 100, 105);
    segments(base, 3, 5);
    const { streamKey } = streams.start(body());
    await flush();
    expect(uris(playlist(streamKey))).toEqual(['0.ts', '1.ts', '2.ts']);
    phase = 2;
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    phase = 3;
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    const text = playlist(streamKey);
    expect(uris(text)).toEqual(['0.ts', '1.ts', '2.ts', '3.ts', '4.ts', '5.ts', '6.ts', '7.ts', '8.ts']);
    const l = text.split('\n');
    expect(l.filter((x) => x === '#EXT-X-DISCONTINUITY')).toHaveLength(1);
    const at = l.indexOf('#EXT-X-DISCONTINUITY');
    expect(l[at + 3]).toBe('6.ts');
    // the provider's segments 3…5 are the local 6…8
    expect(mem.files.get(`${ROOT}/${streamKey}/6.ts`)).toEqual(Buffer.alloc(188, 3));
    expect(streams.list()[0]!.errors).toEqual([]);
    expect(streams.list()[0]!.state).toBe('running');
  });

  it('a media sequence that skips ahead marks a discontinuity; a contiguous one does not', async () => {
    let seq = 10;
    routes.set(MASTER, () => media(seq, 3));
    segments(`${HOST}/live/anna/geheim`, 10, 30);
    const { streamKey } = streams.start(body());
    await flush();
    seq = 11;
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(playlist(streamKey)).not.toContain('#EXT-X-DISCONTINUITY\n');
    seq = 20;
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    const l = playlist(streamKey).split('\n');
    expect(uris(l.join('\n'))).toEqual(['0.ts', '1.ts', '2.ts', '3.ts', '4.ts', '5.ts', '6.ts']);
    expect(l[l.indexOf('#EXT-X-DISCONTINUITY') + 3]).toBe('4.ts');
  });

  it('pdt: the provider date-time is kept; without one it is arrival − duration on the clock', async () => {
    routes.set(MASTER, media(1, 2, { pdt: '2026-11-11T19:15:00.000Z' }));
    segments(`${HOST}/live/anna/geheim`, 1, 2);
    const a = streams.start(body());
    await flush();
    const text = playlist(a.streamKey);
    expect(text).toContain('#EXT-X-PROGRAM-DATE-TIME:2026-11-11T19:15:00.000Z\n#EXTINF:4.000,\n0.ts');
    // the next segment of the same playlist follows on from the provider's value
    expect(text).toContain('#EXT-X-PROGRAM-DATE-TIME:2026-11-11T19:15:04.000Z\n#EXTINF:4.000,\n1.ts');

    const other = `${HOST}/other.m3u8`;
    routes.set(other, media(7, 1));
    routes.set(`${HOST}/seg/7.ts?token=geheim`, Buffer.alloc(10));
    const b = streams.start({ ...body(other), channelId: 'ch-hafenkanal' });
    await flush();
    expect(playlist(b.streamKey)).toContain(`#EXT-X-PROGRAM-DATE-TIME:${new Date(NOW - 4000).toISOString()}\n`);
  });

  it('a fetch error starts the backoff 2, 4, 8, 15, 30, 30 s; the outage is reported with its seconds', async () => {
    let down = true;
    routes.set(MASTER, () => (down ? new FetchError('unreachable') : media(1, 1)));
    segments(`${HOST}/live/anna/geheim`, 1, 1);
    const { streamKey } = streams.start(body());
    await flush();
    // the gateway keeps fetching meanwhile (the 180-s safety net must not stop the stream)
    for (let i = 0; i < 6; i++) { streams.touch(streamKey); await vi.advanceTimersByTimeAsync(30_000); await flush(); }
    streams.touch(streamKey);
    const at = ff.calls.map((c) => c.at);
    const gaps = at.slice(1, 7).map((t, i) => (t - at[i]!) / 1000);
    expect(gaps).toEqual([2, 4, 8, 15, 30, 30]);
    let [view] = streams.list();
    expect(view!.state).toBe('reconnecting');
    expect(view!.errors).toEqual([{ at: NOW, code: 'input_lost' }]);
    down = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    [view] = streams.list();
    const backAt = ff.calls.at(-2)!.at;
    expect(view!.errors).toEqual([{ at: NOW, code: 'input_lost' }, { at: backAt, code: 'input_back', seconds: Math.round((backAt - NOW) / 1000) }]);
    expect(view!.state).toBe('running');
    expect(logs.join('\n')).toMatch(/ch-nordlicht input lost/);
    expect(logs.join('\n')).not.toMatch(/iptv\.example|geheim/);
  });

  it('the backoff starts again at 2 s for the next outage', async () => {
    let down = false;
    routes.set(MASTER, () => (down ? new FetchError('timeout') : media(1, 1)));
    segments(`${HOST}/live/anna/geheim`, 1, 1);
    streams.start(body());
    await flush();
    const step = async (d: boolean) => { down = d; await vi.advanceTimersByTimeAsync(2000); await flush(); };
    await step(true); // the poll at 2 s fails, retry in 2 s
    await step(false); // back at 4 s, next poll in 2 s
    await step(true); // fails again at 6 s: 2 s, not 4 s
    const failedAt = Date.now();
    await step(false);
    expect(ff.calls.at(-1)!.at - failedAt).toBe(2000);
    expect(streams.list()[0]!.errors).toEqual([
      { at: NOW + 2000, code: 'input_lost' }, { at: NOW + 4000, code: 'input_back', seconds: 2 },
      { at: NOW + 6000, code: 'input_lost' }, { at: NOW + 8000, code: 'input_back', seconds: 2 },
    ]);
  });

  it('a refused address or scheme fails the stream at once (no retry)', async () => {
    routes.set(MASTER, new FetchError('address_refused'));
    streams.start(body());
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ff.calls).toHaveLength(1);
    expect(streams.list()[0]!.state).toBe('failed');
    expect(logs.join('\n')).toContain('ch-nordlicht failed (address_refused)');
  });

  it('an input that is not HLS fails; a failed stream is started anew by the next start', async () => {
    const r = streams.start({ ...body(), input: { url: `${HOST}/101.ts`, kind: 'ts', allowLan: false } });
    await flush();
    expect(streams.list()[0]!.state).toBe('failed');
    const push = streams.start({ ...body(), input: { push: 'ch-nordlicht' } });
    expect(push.streamKey).not.toBe(r.streamKey);
    await flush();
    expect(streams.list().map((v) => v.state)).toEqual(['failed']);
  });

  it('fMP4: the init segment is stored as init-0.mp4 and the playlist maps it', async () => {
    routes.set(MASTER, media(1, 2, { map: 'init.mp4?token=geheim', ext: 'm4s' }));
    const base = `${HOST}/live/anna/geheim`;
    routes.set(`${base}/init.mp4?token=geheim`, Buffer.from('init'));
    segments(base, 1, 2, 'm4s');
    const { streamKey } = streams.start(body());
    await flush();
    const text = playlist(streamKey);
    expect(text).toContain('#EXT-X-VERSION:7');
    expect(text).toContain('#EXT-X-MAP:URI="init-0.mp4"');
    expect(uris(text)).toEqual(['0.m4s', '1.m4s']);
    expect(mem.files.get(`${ROOT}/${streamKey}/init-0.mp4`)).toEqual(Buffer.from('init'));
    expect(streams.file(streamKey, 'init-0.mp4')).toEqual({ path: `${ROOT}/${streamKey}/init-0.mp4`, type: 'video/mp4' });
    expect(streams.file(streamKey, 'init.mp4')).toBeNull();
    expect(streams.file(streamKey, 'init-1.mp4')).toBeNull();
    expect(streams.file(streamKey, '0.m4s')).toEqual({ path: `${ROOT}/${streamKey}/0.m4s`, type: 'video/mp4' });
    expect(streams.file(streamKey, '0.ts')).toBeNull();
  });

  it('a MAP change mid-stream is a new immutable init file and a discontinuity; the old init stays for seeking back', async () => {
    let phase = 1;
    routes.set(MASTER, () => (phase === 1 ? media(1, 2, { map: 'init-a.mp4', ext: 'm4s' }) : media(3, 2, { map: 'init-b.mp4', ext: 'm4s' })));
    const base = `${HOST}/live/anna/geheim`;
    routes.set(`${base}/init-a.mp4`, Buffer.from('A'));
    routes.set(`${base}/init-b.mp4`, Buffer.from('B'));
    segments(base, 1, 4, 'm4s');
    const { streamKey } = streams.start(body());
    await flush();
    phase = 2;
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    const body2 = playlist(streamKey).split('\n').filter((l) => /^#EXT-X-(MAP|DISCONTINUITY)$|^#EXT-X-(MAP|DISCONTINUITY):|\.m4s$/.test(l) && !l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE'));
    expect(body2).toEqual(['#EXT-X-MAP:URI="init-0.mp4"', '0.m4s', '1.m4s', '#EXT-X-DISCONTINUITY', '#EXT-X-MAP:URI="init-1.mp4"', '2.m4s', '3.m4s']);
    expect(mem.files.get(`${ROOT}/${streamKey}/init-0.mp4`)).toEqual(Buffer.from('A'));
    expect(mem.files.get(`${ROOT}/${streamKey}/init-1.mp4`)).toEqual(Buffer.from('B'));
    expect(streams.file(streamKey, 'init-0.mp4')).not.toBeNull();
    expect(streams.file(streamKey, '0.m4s')).not.toBeNull();
  });

  it('pdt without a provider value: arrival − duration starts a run, the rest of the run follows on 4 s apart', async () => {
    let phase = 1;
    routes.set(MASTER, () => (phase === 1 ? media(10, 3) : media(2, 3)));
    segments(`${HOST}/live/anna/geheim`, 10, 12);
    segments(`${HOST}/live/anna/geheim`, 2, 4);
    const { streamKey } = streams.start(body());
    await flush();
    const pdts = () => playlist(streamKey).split('\n').filter((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')).map((l) => Date.parse(l.slice(25)));
    expect(pdts()).toEqual([NOW - 4000, NOW, NOW + 4000]);
    // the sequence jumps back: a discontinuity, a new run from the clock again
    phase = 2;
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    const at = NOW + 2000;
    expect(pdts()).toEqual([NOW - 4000, NOW, NOW + 4000, at - 4000, at, at + 4000]);
  });

  it('a segment that already left the provider (404) is skipped with a discontinuity, no outage', async () => {
    routes.set(MASTER, media(1, 3));
    const base = `${HOST}/live/anna/geheim`;
    segments(base, 1, 3);
    routes.delete(`${base}/seg/2.ts?token=geheim`);
    const { streamKey } = streams.start(body());
    await flush();
    const l = playlist(streamKey).split('\n');
    expect(uris(l.join('\n'))).toEqual(['0.ts', '1.ts']);
    expect(l[l.indexOf('#EXT-X-DISCONTINUITY') + 3]).toBe('1.ts');
    expect(mem.files.get(`${ROOT}/${streamKey}/1.ts`)).toEqual(Buffer.alloc(188, 3));
    const [view] = streams.list();
    expect([view!.state, view!.errors]).toEqual(['running', []]);
    // the skipped segment is not asked for again on the next poll
    const n = ff.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(ff.calls.slice(n).map((c) => c.url)).toEqual([MASTER]);
  });

  it('a 404 on the last segment of a poll: the next poll\'s first segment taken carries the discontinuity', async () => {
    let phase = 1;
    routes.set(MASTER, () => (phase === 1 ? media(1, 3) : media(2, 3)));
    const base = `${HOST}/live/anna/geheim`;
    segments(base, 1, 4);
    routes.delete(`${base}/seg/3.ts?token=geheim`);
    const { streamKey } = streams.start(body());
    await flush();
    expect(uris(playlist(streamKey))).toEqual(['0.ts', '1.ts']);
    expect(playlist(streamKey)).not.toContain('#EXT-X-DISCONTINUITY\n');
    phase = 2;
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    const l = playlist(streamKey).split('\n');
    expect(uris(l.join('\n'))).toEqual(['0.ts', '1.ts', '2.ts']);
    expect(l.filter((x) => x === '#EXT-X-DISCONTINUITY')).toHaveLength(1);
    expect(l[l.indexOf('#EXT-X-DISCONTINUITY') + 3]).toBe('2.ts');
    expect(mem.files.get(`${ROOT}/${streamKey}/2.ts`)).toEqual(Buffer.alloc(188, 4));
    expect(streams.list()[0]!.errors).toEqual([]);
  });

  it('3 segments in a row gone (404) while the playlist loads are an outage with the backoff', async () => {
    let phase = 1;
    routes.set(MASTER, () => (phase === 1 ? media(1, 3) : media(2, 3)));
    const base = `${HOST}/live/anna/geheim`;
    segments(base, 4, 4);
    const { streamKey } = streams.start(body());
    await flush();
    let [view] = streams.list();
    expect([view!.state, view!.errors]).toEqual(['reconnecting', [{ at: NOW, code: 'input_lost' }]]);
    const failedAt = ff.calls.at(-1)!.at;
    phase = 2;
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(ff.calls.find((c) => c.at > failedAt)!.at - failedAt).toBe(2000);
    [view] = streams.list();
    expect(view!.state).toBe('running');
    expect(view!.errors).toEqual([{ at: NOW, code: 'input_lost' }, { at: NOW + 2000, code: 'input_back', seconds: 2 }]);
    const l = playlist(streamKey).split('\n');
    expect(uris(l.join('\n'))).toEqual(['0.ts']);
    expect(l).toContain('#EXT-X-DISCONTINUITY');
  });

  it('an init version that never got a segment is removed when the provider moves on', async () => {
    let phase = 1;
    routes.set(MASTER, () => (phase === 1 ? media(1, 1, { map: 'init-a.mp4', ext: 'm4s' }) : media(2, 1, { map: 'init-b.mp4', ext: 'm4s' })));
    const base = `${HOST}/live/anna/geheim`;
    routes.set(`${base}/init-a.mp4`, Buffer.from('A'));
    routes.set(`${base}/init-b.mp4`, Buffer.from('B'));
    segments(base, 2, 2, 'm4s');
    const { streamKey } = streams.start(body());
    await flush();
    expect(mem.files.has(`${ROOT}/${streamKey}/init-0.mp4`)).toBe(true);
    phase = 2;
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(mem.files.has(`${ROOT}/${streamKey}/init-0.mp4`)).toBe(false);
    expect(mem.files.get(`${ROOT}/${streamKey}/init-1.mp4`)).toEqual(Buffer.from('B'));
    const text = playlist(streamKey);
    expect(text).toContain('#EXT-X-MAP:URI="init-1.mp4"');
    expect(text).not.toContain('init-0.mp4');
  });

  it('an encrypted playlist fails with encrypted, byte ranges with invalid; neither is retried', async () => {
    const cases: Array<[string, string]> = [
      ['#EXT-X-KEY:METHOD=AES-128,URI="https://iptv.example.com/key"', 'encrypted'],
      ['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"', 'encrypted'],
      ['#EXT-X-BYTERANGE:1000@0', 'invalid'],
      ['#EXT-X-MAP:URI="init.mp4",BYTERANGE="700@0"', 'invalid'],
    ];
    for (const [tag, code] of cases) {
      const url = `${HOST}/${code}-${cases.findIndex((c) => c[0] === tag)}.m3u8`;
      routes.set(url, ['#EXTM3U', '#EXT-X-TARGETDURATION:4', tag, '#EXTINF:4,', 'seg/1.ts'].join('\n'));
      const channelId = `ch-${cases.findIndex((c) => c[0] === tag)}`;
      streams.start({ ...body(url), channelId });
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ff.calls.filter((c) => c.url === url)).toHaveLength(1);
      expect(streams.list().find((v) => v.channelId === channelId)!.state).toBe('failed');
      expect(logs.join('\n')).toContain(`${channelId} failed (${code})`);
    }
    // METHOD=NONE is a clear playlist
    routes.set(MASTER, ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-KEY:METHOD=NONE', '#EXTINF:4,', 'seg/1.ts?token=geheim'].join('\n'));
    segments(`${HOST}/live/anna/geheim`, 1, 1);
    streams.start(body());
    await flush();
    expect(streams.list().find((v) => v.channelId === 'ch-nordlicht')!.state).toBe('running');
    expect(logs.join('\n')).not.toMatch(/iptv\.example|geheim/);
  });

  it('a playlist that is not HLS counts as an outage and is retried; a stop ends the loop', async () => {
    routes.set(MASTER, '<html>Login</html>');
    streams.start(body());
    await flush();
    expect(streams.list()[0]!.state).toBe('reconnecting');
    await streams.stop('ch-nordlicht');
    const n = ff.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ff.calls).toHaveLength(n);
    expect(streams.list()).toEqual([]);
  });
});

describe('parseMedia', () => {
  it('reads target duration, sequence, maps, date-times and discontinuities', () => {
    const p = parseMedia([
      '#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:40', '#EXT-X-PROGRAM-DATE-TIME:2026-11-11T19:15:00.000+01:00',
      '#EXTINF:6,', 'a.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:5.5,title', 'b.ts', '#EXT-X-PROGRAM-DATE-TIME:kaputt', '#EXTINF:6,', 'c.ts', '#EXT-X-ENDLIST',
    ].join('\r\n'))!;
    expect(p.targetDuration).toBe(6);
    expect(p.mediaSequence).toBe(40);
    expect(p.segments).toEqual([
      { uri: 'a.ts', duration: 6, pdt: Date.parse('2026-11-11T18:15:00.000Z'), discontinuity: false, map: null },
      { uri: 'b.ts', duration: 5.5, discontinuity: true, map: null },
      { uri: 'c.ts', duration: 6, discontinuity: false, map: null },
    ]);
  });

  it('defaults and refusals', () => {
    expect(parseMedia('<html>')).toBeNull();
    expect(parseMedia('#EXTM3U\n#EXTINF:abc,\na.ts')).toBeNull();
    const p = parseMedia('#EXTM3U\na.ts')!;
    expect(p).toEqual({ targetDuration: 4, mediaSequence: 0, segments: [{ uri: 'a.ts', duration: 4, discontinuity: false, map: null }] });
    expect(() => parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXTINF:4,\na.ts')).toThrow(PlaylistRefused);
    expect(() => parseMedia('#EXTM3U\n#EXT-X-KEY:URI="k"\n#EXTINF:4,\na.ts')).toThrow('encrypted');
    expect(() => parseMedia('#EXTM3U\n#EXTINF:4,\n#EXT-X-BYTERANGE:10@0\na.ts')).toThrow('invalid');
    expect(parseMedia('﻿#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.ts')!.segments).toHaveLength(1);
  });
});
