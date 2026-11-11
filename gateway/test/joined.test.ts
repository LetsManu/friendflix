// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Continuous AirPlay: one joined VOD stream for a multi-item AirPlay token (ported from the spike branch's joinedSpike tests).
 * A fake Jellyfin 10.10 (playlists generated exactly like DynamicHlsPlaylistGenerator.CreateMainPlaylist,
 * DynamicHlsHelper master + AddSubtitles, SubtitleController.GetSubtitlePlaylist / AddVttTimeMap), real MPEG-TS segments
 * from ffmpeg (three short episodes, each with its own timestamps starting near 0 = what Jellyfin's -copyts transcode emits),
 * a fake backend authz, and the REAL gateway. ffmpeg / ffprobe then play the joined stream through the gateway as an HLS client.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type JoinedSegment } from '../src/gateway.js';
import { joinPlaylists } from '../src/joined.js';

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
/** async (the gateway runs in this process: a sync spawn would block it); no proxy for the loopback gateway */
const run = (cmd: string, args: string[]) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
  const env: NodeJS.ProcessEnv = { ...process.env, no_proxy: '127.0.0.1,localhost', NO_PROXY: '127.0.0.1,localhost' };
  for (const k of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) delete env[k];
  execFile(cmd, args, { env, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
});
const SEG = 3; // Jellyfin's segment length for a video transcode
const TOKEN = 'jf-media-token';
const CT_JOIN = 'J'.repeat(43);
const CT_ONE = 'O'.repeat(43);
const CT_FOREIGN = 'F'.repeat(43); // joined token whose 2nd item's variant carries an absolute foreign URI
const CT_LONG = 'L'.repeat(43); // joined token of three full-length episodes (940 segments each)
const CT_WARM = 'W'.repeat(43); // a fresh joined token of the three short episodes (its own build, its own warm-up)
const CT_NOSUB = 'N'.repeat(43); // joined token whose episodes carry no subtitle track
const CT_IMG = 'I'.repeat(43); // a poster token (never has a joined stream)
const CT_DOWN = 'D'.repeat(43); // the backend fails for this one
const hex = (c: string) => c.repeat(32);
type Ep = { id: string; ms: string; ps: string; dur: number; sub: number; lang: string; pattern: string };
// Saltwater Almanac S2 E1-E3 (fictional), deliberately odd runtimes (last segment shorter than SEG)
const EP: Ep[] = [
  { id: hex('1'), ms: hex('a'), ps: 'ps-night-market', dur: 20, sub: 3, lang: 'ger', pattern: 'testsrc' },
  { id: hex('2'), ms: hex('b'), ps: 'ps-toll-keeper', dur: 14.5, sub: 3, lang: 'ger', pattern: 'testsrc2' },
  { id: hex('3'), ms: hex('c'), ps: 'ps-glass-tides', dur: 17, sub: 4, lang: 'ger', pattern: 'smptebars' },
];
// Saltwater Almanac S3 E1-E3: 47 min each = 940 segments of 3 s (no media bytes, playlists only)
const LONG: Ep[] = [
  { id: hex('4'), ms: hex('e'), ps: 'ps-long-one', dur: 940 * SEG, sub: 3, lang: 'ger', pattern: '' },
  { id: hex('5'), ms: hex('f'), ps: 'ps-long-two', dur: 940 * SEG, sub: 3, lang: 'ger', pattern: '' },
  { id: hex('6'), ms: hex('0'), ps: 'ps-long-three', dur: 940 * SEG, sub: 3, lang: 'ger', pattern: '' },
];
const OTHER = { id: hex('9'), ms: hex('d'), ps: 'ps-other' };
const work = mkdtempSync(join(tmpdir(), 'ff-joined-'));
const upstreamLog: string[] = [];
const segEvents: JoinedSegment[] = [];
let jf: Server, be: Server, gw: Server, gwPort = 0;

const q = (ep: Ep) =>
  `DeviceId=jfdev&MediaSourceId=${ep.ms}&VideoCodec=h264&AudioCodec=aac&PlaySessionId=${ep.ps}&SegmentContainer=ts&MinSegments=1&BreakOnNonKeyFrames=false&TranscodingMaxAudioChannels=2&MaxStreamingBitrate=8000000&AudioBitrate=192000&AudioChannels=2&VideoBitrate=7808000&MaxHeight=1080&MaxWidth=1920&Level=41&MaxVideoBitDepth=8&RequireAvc=true&EnableTrickplay=false&SubtitleStreamIndex=${ep.sub}&SubtitleMethod=Hls`;

/** port of DynamicHlsPlaylistGenerator.CreateMainPlaylist (10.10, equal-length segments of a transcode) */
function jfMain(ep: Ep, query: string, foreign = false): string {
  const total = Math.round(ep.dur * 1e7), len = SEG * 1e7;
  const segs: number[] = [];
  for (let t = total; t > 0; t -= len) segs.push(Math.min(t, len) / 1e7);
  const out = ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segs))}`, '#EXT-X-MEDIA-SEQUENCE:0'];
  let rt = 0;
  segs.forEach((d, i) => {
    const lt = Math.round(d * 1e7);
    out.push(`#EXTINF:${d.toFixed(6)}, nodesc`, `${foreign && i === 1 ? 'https://cdn.invalid/' : ''}hls1/main/${i}.ts?${query}&runtimeTicks=${rt}&actualSegmentLengthTicks=${lt}`);
    rt += lt;
  });
  out.push('#EXT-X-ENDLIST', '');
  return out.join('\n');
}
/** DynamicHlsHelper master with AddSubtitles (every text track listed, DEFAULT=YES on the requested one, LANGUAGE last) */
const jfMaster = (ep: Ep, query: string) => [
  '#EXTM3U',
  `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=NO,FORCED=NO,AUTOSELECT=YES,URI="${ep.ms}/Subtitles/2/subtitles.m3u8?SegmentLength=30&api_key=${TOKEN}",LANGUAGE="eng"`,
  `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Deutsch",DEFAULT=YES,FORCED=NO,AUTOSELECT=YES,URI="${ep.ms}/Subtitles/${ep.sub}/subtitles.m3u8?SegmentLength=30&api_key=${TOKEN}",LANGUAGE="${ep.lang}"`,
  '#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=8000000,VIDEO-RANGE=SDR,CODECS="avc1.640029,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=25,SUBTITLES="subs"',
  `main.m3u8?${query}&api_key=${TOKEN}`,
  '',
].join('\n');
/** SubtitleController.GetSubtitlePlaylist */
function jfSubs(ep: Ep): string {
  const rt = Math.round(ep.dur * 1e7), len = 30 * 1e7;
  const out = ['#EXTM3U', '#EXT-X-TARGETDURATION:30', '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let p = 0; p < rt; p += len) {
    const l = Math.min(rt - p, len);
    out.push(`#EXTINF:${l / 1e7},`, `stream.vtt?CopyTimestamps=true&AddVttTimeMap=true&StartPositionTicks=${p}&EndPositionTicks=${Math.min(rt, p + len)}&api_key=${TOKEN}`);
  }
  out.push('#EXT-X-ENDLIST', '');
  return out.join('\n');
}
const jfVtt = (n: number) => `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:04.000\nFolge ${n}: erste Zeile\n`;

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
const get = (path: string) => fetch(`http://127.0.0.1:${gwPort}${path}`);

beforeAll(async () => {
  if (HAVE_FFMPEG) {
    EP.forEach((ep, n) => {
      // what Jellyfin's -copyts HLS transcode emits: forced keyframes every SEG s, timestamps of each episode start near 0 (+ mpegts muxdelay)
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `${ep.pattern}=size=640x360:rate=25:duration=${ep.dur}`, '-f', 'lavfi', '-i', `sine=frequency=${440 * (n + 1)}:duration=${ep.dur}`,
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-force_key_frames', `expr:gte(t,n_forced*${SEG})`, '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
        '-f', 'hls', '-hls_time', String(SEG), '-hls_playlist_type', 'vod', '-hls_segment_type', 'mpegts', '-start_number', '0', '-hls_segment_filename', join(work, `e${n}_%d.ts`), join(work, `e${n}.m3u8`)]);
    });
  }
  jf = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    upstreamLog.push(u.pathname + u.search);
    if (!String(req.headers.authorization ?? '').includes(`Token="${TOKEN}"`) || u.searchParams.has('api_key')) { res.writeHead(401); return res.end(); }
    const ep = [...EP, ...LONG].find((e) => u.pathname.startsWith(`/Videos/${e.id}/`));
    if (!ep) { res.writeHead(404); return res.end(); }
    const n = EP.indexOf(ep);
    const ok = u.pathname.includes('/Subtitles/') || (u.searchParams.get('PlaySessionId') === ep.ps && u.searchParams.get('MediaSourceId') === ep.ms);
    if (!ok) { res.writeHead(400); return res.end('wrong session'); }
    const query = [...u.searchParams].filter(([k]) => !/^(runtimeTicks|actualSegmentLengthTicks)$/.test(k)).map(([k, v]) => `${k}=${v}`).join('&');
    const m3u8 = (t: string) => { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end(t); };
    if (u.pathname.endsWith('/master.m3u8')) return m3u8(jfMaster(ep, query));
    if (u.pathname.endsWith('/main.m3u8')) return m3u8(jfMain(ep, `${query}&api_key=${TOKEN}`, req.headers['x-test-foreign'] === '1'));
    if (u.pathname.endsWith('/subtitles.m3u8')) return m3u8(jfSubs(ep));
    if (u.pathname.endsWith('/stream.vtt')) { res.writeHead(200, { 'content-type': 'text/vtt' }); return res.end(jfVtt(n + 1)); }
    const seg = /\/hls1\/main\/(\d+)\.ts$/.exec(u.pathname);
    if (seg && HAVE_FFMPEG && n >= 0) {
      try { const b = readFileSync(join(work, `e${n}_${seg[1]}.ts`)); res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(b.length) }); return res.end(b); } catch { /* 404 */ }
    }
    res.writeHead(404); res.end();
  });
  be = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const j = JSON.parse(b) as { ct?: string };
      const item = (e: Ep) => ({ itemId: e.id, mediaSourceId: e.ms, playSessionId: e.ps, hlsPath: `/Videos/${e.id}/master.m3u8?${q(e)}`, hlsSubIndex: e.sub });
      const base = { userId: 'u1', token: TOKEN, deviceId: 'gw', maxBitrate: 8_000_000, kind: 'media' };
      const first = (e: Ep) => ({ itemId: e.id, mediaSourceId: e.ms, playSessionId: e.ps, hlsSub: true, hlsSubIndex: e.sub });
      if (j.ct === CT_JOIN || j.ct === CT_FOREIGN || j.ct === CT_WARM) return res.end(JSON.stringify({ ...base, scope: { ...first(EP[0]!), items: EP.map(item) } }));
      if (j.ct === CT_LONG) return res.end(JSON.stringify({ ...base, scope: { ...first(LONG[0]!), items: LONG.map(item) } }));
      if (j.ct === CT_ONE) return res.end(JSON.stringify({ ...base, scope: first(EP[0]!) }));
      if (j.ct === CT_NOSUB) return res.end(JSON.stringify({ ...base, scope: { itemId: EP[0]!.id, mediaSourceId: EP[0]!.ms, playSessionId: EP[0]!.ps, items: EP.map(({ sub: _s, ...e }) => ({ ...item({ ...e, sub: 0 }), hlsSubIndex: undefined })) } }));
      if (j.ct === CT_IMG) return res.end(JSON.stringify({ ...base, kind: 'img', scope: { ...first(EP[0]!), items: EP.map(item) } }));
      if (j.ct === CT_DOWN) { res.writeHead(500); return res.end('{}'); }
      res.writeHead(401); res.end('{}');
    });
  });
  const jfp = await listen(jf);
  const bep = await listen(be);
  const g = createGateway({
    upstreamUrl: `http://127.0.0.1:${jfp}`, backendUrl: `http://127.0.0.1:${bep}`, internalSecret: 's3cret-s3cret-s3cret',
    onJoinedSegment: (e) => segEvents.push(e),
    // CT_FOREIGN: the fake Jellyfin answers item 2's variant with one absolute URI (a hostile / broken upstream)
    fetchImpl: ((u: string, init: RequestInit) => fetch(u, String(u).includes(`/Videos/${EP[1]!.id}/main.m3u8`) && foreignNext.v ? { ...init, headers: { ...(init.headers as Record<string, string>), 'x-test-foreign': '1' } } : init)) as typeof fetch,
  });
  gw = g.server;
  gwPort = await listen(gw);
}, 120_000);
const foreignNext = { v: false };
afterAll(() => { jf?.close(); be?.close(); gw?.close(); rmSync(work, { recursive: true, force: true }); });

const J = `/media/c/${CT_JOIN}/joined`;
const S = `/media/c/${CT_JOIN}/s`;
const uriLines = (t: string) => t.split('\n').filter((l) => l && !l.startsWith('#'));
/** upstream video segment requests since `from` (a build's fire-and-forget subtitle warm-up may still land in between) */
const segLog = (from: number) => upstreamLog.slice(from).filter((l) => l.includes('/hls1/'));

describe('joinPlaylists (pure)', () => {
  const part = (n: number, d = 3) => ({ text: ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${d}`, ...Array.from({ length: n }, (_, i) => [`#EXTINF:${d}.000000, nodesc`, `hls1/main/${i}.ts?x=1`]).flat(), '#EXT-X-ENDLIST'].join('\n'), prefix: '../Videos/a/' });
  it('one discontinuity per boundary, one ENDLIST, max target duration, timeline from EXTINF sums', () => {
    const r = joinPlaylists([part(2), part(1, 6), part(3)])!;
    expect(r.text.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(2);
    expect(r.text.match(/#EXT-X-ENDLIST/g)).toHaveLength(1);
    expect(r.text).toContain('#EXT-X-TARGETDURATION:6');
    expect(r.parts.map(({ start, duration, segments }) => ({ start, duration, segments: segments.length }))).toEqual([{ start: 0, duration: 6, segments: 2 }, { start: 6, duration: 6, segments: 1 }, { start: 12, duration: 9, segments: 3 }]);
    // prefixed URIs; every part's original segment URIs resolved against its playlist path, query included
    expect(uriLines(r.text)[0]).toBe('../Videos/a/hls1/main/0.ts?x=1');
    expect(r.parts[2]!.segments).toEqual(['/Videos/a/hls1/main/0.ts?x=1', '/Videos/a/hls1/main/1.ts?x=1', '/Videos/a/hls1/main/2.ts?x=1']);
  });
  it('shortUris: ../s/<part>/<n>.ts per video segment, the original kept in segments[n]', () => {
    const r = joinPlaylists([part(2), { ...part(2), prefix: '../Videos/b/' }], { shortUris: true })!;
    expect(uriLines(r.text)).toEqual(['../s/0/0.ts', '../s/0/1.ts', '../s/1/0.ts', '../s/1/1.ts']);
    expect(r.parts[1]!.segments).toEqual(['/Videos/b/hls1/main/0.ts?x=1', '/Videos/b/hls1/main/1.ts?x=1']);
  });
  it.each([
    ['no ENDLIST', '#EXTM3U\n#EXTINF:3,\na.ts'],
    ['fMP4 map', '#EXTM3U\n#EXT-X-MAP:URI="i.mp4"\n#EXTINF:3,\na.ts\n#EXT-X-ENDLIST'],
    ['absolute URI', '#EXTM3U\n#EXTINF:3,\nhttps://cdn.invalid/a.ts\n#EXT-X-ENDLIST'],
    ['root path', '#EXTM3U\n#EXTINF:3,\n/Videos/x/a.ts\n#EXT-X-ENDLIST'],
    ['escape', '#EXTM3U\n#EXTINF:3,\n../../x/a.ts\n#EXT-X-ENDLIST'],
    ['URI without EXTINF', '#EXTM3U\na.ts\n#EXT-X-ENDLIST'],
    ['unknown tag', '#EXTM3U\n#EXT-X-FOO:1\n#EXTINF:3,\na.ts\n#EXT-X-ENDLIST'],
    ['a master', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmain.m3u8\n#EXT-X-ENDLIST'],
  ])('refuses a part with %s', (_n, text) => {
    expect(joinPlaylists([part(1), { text, prefix: '../Videos/b/' }])).toBeNull();
    expect(joinPlaylists([part(1), { text, prefix: '../Videos/b/' }], { shortUris: true })).toBeNull();
  });
});

describe('joined route through the real gateway', () => {
  it('master: one variant, the kept subtitle rendition, nothing else', async () => {
    const r = await get(`${J}/master.m3u8`);
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toBe([
      '#EXTM3U', '#EXT-X-VERSION:3',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Deutsch",LANGUAGE="ger",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="subs.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=8000000,CODECS="avc1.640029,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=25,SUBTITLES="subs"',
      'main.m3u8', '',
    ].join('\n'));
  });
  it('main: three parts, two discontinuities, short URIs inside the token path, no credential', async () => {
    const t = await (await get(`${J}/main.m3u8`)).text();
    expect(t.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(2);
    expect(t).not.toMatch(/api_key|jf-media-token/i);
    const uris = uriLines(t);
    expect(uris).toHaveLength(7 + 5 + 6);
    for (const u of uris) expect(new URL(u, `https://h${J}/`).pathname.startsWith(`/media/c/${CT_JOIN}/s/`)).toBe(true);
    const total = [...t.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((n, m) => n + Number(m[1]), 0);
    expect(total).toBeCloseTo(20 + 14.5 + 17, 5);
  });
  it('subs: same boundaries as the video, per-item track index kept (item 3 uses track 4)', async () => {
    const t = await (await get(`${J}/subs.m3u8`)).text();
    expect(t.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(2);
    const parts = t.split('#EXT-X-DISCONTINUITY').map((p) => [...p.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((n, m) => n + Number(m[1]), 0));
    expect(parts.map((d) => Math.round(d * 1000) / 1000)).toEqual([20, 14.5, 17]);
    expect(t).toContain(`../Videos/${EP[2]!.id}/${EP[2]!.ms}/Subtitles/4/stream.vtt?`);
  });
  it('builds once per token: 9 upstream playlist requests (3 masters, 3 variants, 3 subtitle playlists), then cached', async () => {
    const n0 = upstreamLog.length;
    await get(`${J}/master.m3u8`); await get(`${J}/main.m3u8`); await get(`${J}/subs.m3u8`);
    expect(upstreamLog.length - n0).toBe(0); // built by the first test already
    expect(upstreamLog.filter((l) => /\.m3u8/.test(l))).toHaveLength(9);
  });
  it('every segment and subtitle URI of the joined playlists is served to the joined token', async () => {
    for (const name of ['main', 'subs']) {
      const t = await (await get(`${J}/${name}.m3u8`)).text();
      for (const u of uriLines(t)) {
        const r = await get(new URL(u, `http://x${J}/`).pathname + new URL(u, `http://x${J}/`).search);
        expect(r.status, u).toBe(HAVE_FFMPEG || name === 'subs' ? 200 : 404);
        await r.arrayBuffer();
      }
    }
  });
});

describe('scope of a joined token', () => {
  const seg = (e: { id: string; ms: string }, ps: string) => `/media/c/${CT_JOIN}/Videos/${e.id}/hls1/main/0.ts?MediaSourceId=${e.ms}&PlaySessionId=${ps}&runtimeTicks=0&actualSegmentLengthTicks=30000000`;
  it('an item outside the list is refused', async () => expect((await get(seg(OTHER, OTHER.ps))).status).toBe(403));
  it('a listed item with another listed item\'s play session is refused (tuple, never a mix)', async () => expect((await get(seg(EP[0]!, EP[1]!.ps))).status).toBe(403));
  it('a listed item with its own play session passes', async () => expect((await get(seg(EP[1]!, EP[1]!.ps))).status).toBe(HAVE_FFMPEG ? 200 : 404));
  it('subtitle paths only for the track of THAT item', async () => {
    const vtt = (e: Ep, n: number) => `/media/c/${CT_JOIN}/Videos/${e.id}/${e.ms}/Subtitles/${n}/stream.vtt?CopyTimestamps=true&AddVttTimeMap=true&StartPositionTicks=0&EndPositionTicks=10`;
    expect((await get(vtt(EP[2]!, 3))).status).toBe(403);
    expect((await get(vtt(EP[2]!, 4))).status).toBe(200);
    expect((await get(vtt(EP[0]!, 4))).status).toBe(403);
  });
  it('no burn-in selector: a segment URL naming another subtitle track of its item is refused', async () => {
    expect((await get(`${seg(EP[0]!, EP[0]!.ps)}&SubtitleStreamIndex=2&SubtitleMethod=Hls`)).status).toBe(403);
    expect((await get(`${seg(EP[0]!, EP[0]!.ps)}&SubtitleStreamIndex=3&SubtitleMethod=Encode`)).status).toBe(403);
  });
  it('a single-item token has no joined stream', async () => expect((await get(`/media/c/${CT_ONE}/joined/main.m3u8`)).status).toBe(403));
  it('a query on the joined route is refused (nothing from the receiver shapes it)', async () => expect((await get(`${J}/main.m3u8?x=1`)).status).toBe(403));
  it('one part with a URI outside the token path fails the whole joined stream', async () => {
    foreignNext.v = true;
    try { expect((await get(`/media/c/${CT_FOREIGN}/joined/main.m3u8`)).status).toBe(502); } finally { foreignNext.v = false; }
  });
});

describe('short segment URIs, tuple scope, events, warm-up', () => {
  it('short segment URIs keep main.m3u8 small', async () => {
    const r = await get(`/media/c/${CT_LONG}/joined/main.m3u8`);
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(uriLines(t)).toHaveLength(3 * 940);
    expect(Buffer.byteLength(t)).toBeLessThan(200 * 1024);
    // the same three parts with Jellyfin's full segment URIs would not be: what the short URIs save on the LG
    const full = LONG.map((e) => jfMain(e, q(e)).length).reduce((a, b) => a + b, 0);
    expect(full).toBeGreaterThan(1024 * 1024);
  });
  it('s/<part>/<n>.ts expands to that part\'s own path and query', async () => {
    const n0 = upstreamLog.length;
    const r = await get(`${S}/1/2.ts`);
    expect(r.status).toBe(HAVE_FFMPEG ? 200 : 404);
    await r.arrayBuffer();
    const sent = segLog(n0);
    expect(sent).toHaveLength(1);
    const u = new URL(sent[0]!, 'http://x');
    expect(u.pathname).toBe(`/Videos/${EP[1]!.id}/hls1/main/2.ts`);
    expect(u.searchParams.get('PlaySessionId')).toBe(EP[1]!.ps);
    expect(u.searchParams.get('MediaSourceId')).toBe(EP[1]!.ms);
    expect(u.searchParams.get('SubtitleStreamIndex')).toBe('3');
    expect(u.searchParams.get('runtimeTicks')).toBe(String(2 * SEG * 1e7));
    expect(u.searchParams.has('api_key')).toBe(false);
    // the third part's own tuple and track
    const n1 = upstreamLog.length;
    await (await get(`${S}/2/0.ts`)).arrayBuffer();
    const u3 = new URL(segLog(n1)[0]!, 'http://x');
    expect(u3.pathname).toBe(`/Videos/${EP[2]!.id}/hls1/main/0.ts`);
    expect([u3.searchParams.get('PlaySessionId'), u3.searchParams.get('SubtitleStreamIndex')]).toEqual([EP[2]!.ps, '4']);
  });
  it('unknown part or index is 404', async () => {
    const n0 = upstreamLog.length;
    for (const p of ['3/0', '0/7', '1/5', '2/6', '0/999999', '99/0']) expect((await get(`${S}/${p}.ts`)).status, p).toBe(404);
    expect(segLog(n0)).toEqual([]);
    // anything but the canonical short form never reaches the lookup
    for (const p of ['00/0.ts', '0/01.ts', '0/-1.ts', '0/0.mp4', '0/0', 'x/0.ts', '0/../0.ts', '0/%2e%2e/0.ts', '0/0.ts/']) expect((await get(`${S}/${p}`)).status, p).toBe(403);
    expect(segLog(n0)).toEqual([]);
  });
  it('a single-item token gets 403 on /joined and /s', async () => {
    for (const p of ['joined/master.m3u8', 'joined/main.m3u8', 'joined/subs.m3u8', 's/0/0.ts']) {
      expect((await get(`/media/c/${CT_ONE}/${p}`)).status, p).toBe(403);
      // control: the same paths serve the joined token
      const r = await get(`/media/c/${CT_JOIN}/${p}`);
      expect(r.status, p).toBe(HAVE_FFMPEG || !p.startsWith('s/') ? 200 : 404);
      await r.arrayBuffer();
    }
  });
  it('a query on /joined is 403', async () => {
    for (const p of [`${J}/master.m3u8?a=1`, `${J}/subs.m3u8?api_key=x`, `${S}/0/0.ts?PlaySessionId=${EP[0]!.ps}`]) {
      expect((await get(p)).status, p).toBe(403);
      const r = await get(p.split('?')[0]!); // control: without the query
      expect(r.status, p).toBe(HAVE_FFMPEG || !p.startsWith(S) ? 200 : 404);
      await r.arrayBuffer();
    }
  });
  it('item 2\'s path with item 1\'s play session is 403', async () => {
    const path = (e: Ep, ms: string, ps: string) => `/media/c/${CT_JOIN}/Videos/${e.id}/hls1/main/0.ts?MediaSourceId=${ms}&PlaySessionId=${ps}&runtimeTicks=0`;
    // control: item 2's own tuple passes
    const own = await get(path(EP[1]!, EP[1]!.ms, EP[1]!.ps));
    expect(own.status).toBe(HAVE_FFMPEG ? 200 : 404);
    await own.arrayBuffer();
    expect((await get(path(EP[1]!, EP[1]!.ms, EP[0]!.ps))).status).toBe(403);
    expect((await get(path(EP[1]!, EP[0]!.ms, EP[1]!.ps))).status).toBe(403);
    expect((await get(`/media/c/${CT_JOIN}/Videos/${EP[1]!.id}/master.m3u8?MediaSourceId=${EP[1]!.ms}&PlaySessionId=${EP[2]!.ps}`)).status).toBe(403);
    expect((await get(`/media/c/${CT_JOIN}/Videos/${EP[1]!.id}/${EP[0]!.ms}/Subtitles/3/stream.vtt?CopyTimestamps=true&AddVttTimeMap=true&StartPositionTicks=0&EndPositionTicks=10`)).status).toBe(403);
  });
  it('onJoinedSegment reports the segment\'s runtimeTicks', async () => {
    segEvents.length = 0;
    await (await get(`${S}/1/2.ts`)).arrayBuffer();
    await (await get(`${S}/0/6.ts`)).arrayBuffer();
    expect(segEvents).toEqual([
      { ct: CT_JOIN, part: 1, itemId: EP[1]!.id, positionTicks: 2 * SEG * 1e7 },
      { ct: CT_JOIN, part: 0, itemId: EP[0]!.id, positionTicks: 6 * SEG * 1e7 },
    ]);
    // refused and direct-path fetches report nothing
    segEvents.length = 0;
    await get(`${S}/9/0.ts`);
    await get(`/media/c/${CT_ONE}/s/0/0.ts`);
    await (await get(`/media/c/${CT_JOIN}/Videos/${EP[1]!.id}/hls1/main/0.ts?MediaSourceId=${EP[1]!.ms}&PlaySessionId=${EP[1]!.ps}&runtimeTicks=0`)).arrayBuffer();
    expect(segEvents).toEqual([]);
  });
  it('no api_key or media token in any emitted playlist', async () => {
    for (const ct of [CT_JOIN, CT_LONG]) {
      for (const name of ['master', 'main', 'subs']) {
        const r = await get(`/media/c/${ct}/joined/${name}.m3u8`);
        expect(r.status).toBe(200);
        expect(r.headers.get('cache-control')).toBe('no-store');
        const t = await r.text();
        expect(t, name).not.toMatch(/api_key|apikey|x-emby-token|x-mediabrowser-token|jf-media-token|DeviceId=/i);
        expect(t, name).not.toContain(ct);
        for (const u of uriLines(t)) expect(u, name).toMatch(/^(main\.m3u8|subs\.m3u8|\.\.\/s\/\d+\/\d+\.ts|\.\.\/Videos\/[0-9a-f]{32}\/[0-9a-f]{32}\/Subtitles\/\d+\/stream\.vtt\?[\w=&]+)$/);
      }
    }
  });
  it('subtitle warm-up fetches parts 2 and 3 once', async () => {
    const vttOf = (e: Ep, from: number) => upstreamLog.slice(from).filter((l) => l.startsWith(`/Videos/${e.id}/${e.ms}/Subtitles/${e.sub}/stream.vtt?`) && l.includes('StartPositionTicks=0&'));
    const n0 = upstreamLog.length;
    expect((await get(`/media/c/${CT_WARM}/joined/master.m3u8`)).status).toBe(200);
    await vi.waitFor(() => { expect(vttOf(EP[1]!, n0)).toHaveLength(1); expect(vttOf(EP[2]!, n0)).toHaveLength(1); });
    for (const name of ['master', 'main', 'subs', 'master']) await (await get(`/media/c/${CT_WARM}/joined/${name}.m3u8`)).arrayBuffer();
    await new Promise((r) => setTimeout(r, 100));
    expect(vttOf(EP[0]!, n0)).toHaveLength(0);
    expect(vttOf(EP[1]!, n0)).toHaveLength(1);
    expect(vttOf(EP[2]!, n0)).toHaveLength(1);
    for (const l of upstreamLog.slice(n0)) expect(l).not.toMatch(/api_key/i);
  });
});

describe('edge answers of the joined routes', () => {
  it('a stream without subtitles: no rendition, subs.m3u8 is 404, no subtitle selector reaches the upstream', async () => {
    const b0 = upstreamLog.length;
    const master = await (await get(`/media/c/${CT_NOSUB}/joined/master.m3u8`)).text();
    expect(master).not.toMatch(/SUBTITLES/);
    // its build: masters and variants without the minted subtitle selectors (hlsPath carries them; no track = no burn-in), no subtitle playlist
    const built = upstreamLog.slice(b0).filter((l) => l.includes('.m3u8'));
    expect(built).toHaveLength(6);
    for (const l of built) expect(l).not.toMatch(/SubtitleStreamIndex|SubtitleMethod|subtitles\.m3u8/i);
    expect((await get(`/media/c/${CT_NOSUB}/joined/subs.m3u8`)).status).toBe(404);
    const n0 = upstreamLog.length;
    await (await get(`/media/c/${CT_NOSUB}/s/1/0.ts`)).arrayBuffer();
    const sent = segLog(n0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(/SubtitleStreamIndex|SubtitleMethod/i);
  });
  it('a poster token gets 403, an unknown token 401, a failing backend 503', async () => {
    for (const p of ['joined/master.m3u8', 's/0/0.ts']) {
      expect((await get(`/media/c/${CT_IMG}/${p}`)).status, p).toBe(403);
      expect((await get(`/media/c/${'U'.repeat(43)}/${p}`)).status, p).toBe(401);
      expect((await get(`/media/c/${CT_DOWN}/${p}`)).status, p).toBe(503);
    }
  });
  it('a short segment of a stream whose build failed is 502', async () => {
    foreignNext.v = true;
    try { expect((await get(`/media/c/${CT_FOREIGN}/s/0/0.ts`)).status).toBe(502); } finally { foreignNext.v = false; }
  });
});

describe.runIf(HAVE_FFMPEG)('an HLS client plays the joined stream through the gateway (ffmpeg)', () => {
  it('decodes all three episodes end to end; positions per segment come from Jellyfin\'s runtimeTicks', async () => {
    segEvents.length = 0;
    const url = `http://127.0.0.1:${gwPort}${J}/master.m3u8`;
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=index,codec_type,codec_name', '-of', 'json', url]);
    expect(probe.status, probe.stderr).toBe(0);
    const info = JSON.parse(probe.stdout) as { format: { duration: string }; streams: Array<{ codec_type: string; codec_name: string }> };
    expect(Number(info.format.duration)).toBeCloseTo(51.5, 0);
    // ffmpeg's HLS demuxer does not open EXT-X-MEDIA subtitle renditions: video + audio from the master, the WebVTT playlist on its own below
    expect(info.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort()).toEqual(['audio:aac', 'video:h264']);
    const subs = await run('ffmpeg', ['-v', 'warning', '-i', `http://127.0.0.1:${gwPort}${J}/subs.m3u8`, '-f', 'webvtt', '-']);
    expect(subs.status, subs.stderr).toBe(0);
    // the cue of each episode, each in its own discontinuity domain (cue at 1-4 s of every episode, X-TIMESTAMP-MAP per segment)
    expect(subs.stdout.match(/Folge \d: erste Zeile/g)).toEqual(['Folge 1: erste Zeile', 'Folge 2: erste Zeile', 'Folge 3: erste Zeile']);
    segEvents.length = 0;
    const play = await run('ffmpeg', ['-v', 'warning', '-i', url, '-map', '0:v', '-map', '0:a', '-f', 'null', '-']);
    expect(play.status, play.stderr).toBe(0);
    // every segment once, in order; position = Jellyfin's runtimeTicks (exact), = index x 3 s for a transcode
    const seen = segEvents.map((e) => `${e.part}:${e.positionTicks}`);
    expect(seen).toEqual(EP.flatMap((ep, p) => Array.from({ length: Math.ceil(ep.dur / SEG) }, (_, i) => `${p}:${i * SEG * 1e7}`)));
    // no frame lost at the boundaries: 25 fps x (20 + 14.5 + 17) s
    const frames = await run('ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', url]);
    expect(frames.stdout.trim().split(/\s+/).map(Number), frames.stderr).toContain(500 + 363 + 425);
  }, 120_000);
});
