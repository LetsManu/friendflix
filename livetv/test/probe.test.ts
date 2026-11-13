// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { GuardDeps } from '../src/fetch.js';
import { attrList, pickVariant, probe, type StreamInput } from '../src/probe.js';
import type { Run, RunResult } from '../src/run.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

// A local server stands in for the provider; `dial` maps every checked address onto it.
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }))); });
async function serve(routes: Record<string, (res: http.ServerResponse) => void>): Promise<{ port: number; paths: string[] }> {
  const paths: string[] = [];
  const srv = http.createServer((req, res) => {
    paths.push(req.url ?? '');
    // match the request path against the declared routes (no property lookup by a request-controlled name)
    const path = (req.url ?? '').split('?')[0]!;
    const h = Object.entries(routes).find(([p]) => p === path)?.[1];
    if (h) h(res);
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return { port: (srv.address() as AddressInfo).port, paths };
}
function guard(answer = ['192.0.2.30']): GuardDeps & { lookups: string[] } {
  const lookups: string[] = [];
  return { lookups, own: [], lookup: async (h) => { lookups.push(h); return answer; }, dial: () => '127.0.0.1' };
}

/** a fake ffprobe: records each call, drains stdin, answers `stdout` (or the result `answer` builds) */
type Call = { cmd: string; args: string[]; timeoutMs: number; stdin: number };
function fakeRun(stdout: Buffer | string, answer?: (o: { timeoutMs: number }) => RunResult | undefined): Run & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (cmd, args, o) => {
    let n = 0;
    if (o.stdin) for await (const c of o.stdin) n += c.length;
    calls.push({ cmd, args, timeoutMs: o.timeoutMs, stdin: n });
    return answer?.(o) ?? { code: 0, stdout: Buffer.from(stdout), stderr: '' };
  }) as Run & { calls: Call[] };
  run.calls = calls;
  return run;
}

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2"',
  'uhd/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
  'fhd/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="hvc1.2.4.L123.B0,mp4a.40.2"',
  'hevc/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
  'hd/index.m3u8',
].join('\n');
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:812\n#EXTINF:4.0,\nseg-812.ts?sig=1\n#EXTINF:4.0,\nseg-813.ts\n';

describe('pickVariant', () => {
  it('the highest bandwidth ≤ max, H.264 preferred over a higher HEVC variant', () => {
    expect(pickVariant(MASTER, 10_000_000)).toEqual({ uri: 'fhd/index.m3u8', bandwidth: 6_000_000, codecs: 'avc1.640028,mp4a.40.2' });
    expect(pickVariant(MASTER, 5_000_000)).toEqual({ uri: 'hd/index.m3u8', bandwidth: 3_000_000, codecs: 'avc1.4d401f,mp4a.40.2' });
    expect(pickVariant(MASTER, 20_000_000)!.uri).toBe('uhd/index.m3u8');
  });

  it('without an H.264 variant the highest fitting one; without CODECS codecs is null', () => {
    const m = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="hvc1.2.4.L123.B0"\nhevc.m3u8\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2000000\r\nlow.m3u8\n';
    expect(pickVariant(m, 10_000_000)).toEqual({ uri: 'hevc.m3u8', bandwidth: 8_000_000, codecs: 'hvc1.2.4.L123.B0' });
    expect(pickVariant(m, 3_000_000)).toEqual({ uri: 'low.m3u8', bandwidth: 2_000_000, codecs: null });
  });

  it('when every variant is above max the lowest; a media playlist or garbage → null', () => {
    expect(pickVariant(MASTER, 1_000_000)!.uri).toBe('hd/index.m3u8');
    expect(pickVariant(MEDIA, 10_000_000)).toBeNull();
    expect(pickVariant('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=abc\nx.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n#EXTINF:1\n', 10_000_000)).toBeNull();
  });

  it('M2: a 64 KB #EXT-X-STREAM-INF line is skipped in well under 50 ms; the other variants still count', () => {
    for (const junk of ['A'.repeat(64 * 1024), 'A-'.repeat(32 * 1024), `BANDWIDTH=${'9'.repeat(64 * 1024)}`, 'X="'.repeat(22_000)]) {
      const m = `#EXTM3U\n#EXT-X-STREAM-INF:${junk}\nhuge.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.4d401f"\nok.m3u8\n`;
      const t = performance.now();
      const v = pickVariant(m, 10_000_000);
      expect(performance.now() - t).toBeLessThan(50);
      expect(v).toEqual({ uri: 'ok.m3u8', bandwidth: 2_000_000, codecs: 'avc1.4d401f' });
    }
  });

  it('M2: an attribute list just under the cap is scanned in linear time', () => {
    const near = 'A'.repeat(8 * 1024 - 64);
    const t = performance.now();
    for (let i = 0; i < 20; i++) attrList(`BANDWIDTH=1000,${near}`);
    attrList('A-'.repeat(4000));
    attrList('A="'.repeat(2700));
    expect(performance.now() - t).toBeLessThan(50);
    const m = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,${near}\nnear.m3u8\n`;
    expect(pickVariant(m, 10_000_000)).toEqual({ uri: 'near.m3u8', bandwidth: 1000, codecs: null });
  });

  it('attrList finds what the old regex found (same names, values, order)', () => {
    const old = (s: string) => {
      const out = new Map<string, string>();
      for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out.set(m[1]!, m[2]!.replace(/^"|"$/g, ''));
      return out;
    };
    const cases = [
      'BANDWIDTH=6000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080',
      'PROGRAM-ID=1,BANDWIDTH=2000000', 'URI="init.mp4",BYTERANGE="1@0"', 'A=,B="",C="x', 'C="x,D=1', 'x=1,Y=2,aZ=3', 'K==v,L="a"b",M=',
      'A"B=1,C=2"', '=1,,A=1=2,B', 'TYPE=AUDIO,GROUP-ID="aac",NAME="Deutsch",DEFAULT=YES,URI="a.m3u8"', 'A=1"', 'Q="a"="b"',
    ];
    for (const c of cases) expect([c, [...attrList(c)]]).toEqual([c, [...old(c)]]);
  });
});

describe('probe', () => {
  it('HLS with H.264: master → variant → first segment piped to ffprobe → passthrough; no URL in the arguments', async () => {
    const seg = Buffer.alloc(300_000, 0x47);
    const s = await serve({
      '/live/nordlicht/master.m3u8': (res) => res.end(MASTER),
      '/live/nordlicht/fhd/index.m3u8': (res) => res.end(MEDIA),
      '/live/nordlicht/fhd/seg-812.ts': (res) => res.end(seg),
    });
    const run = fakeRun(fixture('ffprobe-h264-aac.json'));
    const r = await probe({ url: `http://iptv.example.com:${s.port}/live/nordlicht/master.m3u8?token=geheim`, kind: 'hls', userAgent: 'Hafenkanal-Box/1.0', allowLan: false }, { run, guard: guard() });
    expect(r).toEqual({ ok: true, video: { codec: 'h264', width: 1920, height: 1080, fps: 25 }, audio: { codec: 'aac', channels: 2 }, needs: 'passthrough' });
    expect(s.paths).toEqual(['/live/nordlicht/master.m3u8?token=geheim', '/live/nordlicht/fhd/index.m3u8', '/live/nordlicht/fhd/seg-812.ts?sig=1']);
    expect(run.calls).toHaveLength(1);
    const c = run.calls[0]!;
    expect(c.cmd).toBe('ffprobe');
    expect(c.stdin).toBe(seg.length);
    expect(c.args).toContain('pipe:0');
    expect(c.args.join(' ')).toContain('-protocol_whitelist pipe');
    // L5: TS segments are demuxed as MPEG-TS only, never a format guessed from the provider's bytes
    expect(c.args.join(' ')).toContain('-f mpegts -format_whitelist mpegts -i pipe:0');
    expect(c.args.some((a) => /http|iptv\.example|geheim/.test(a))).toBe(false);
    expect(c.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('HLS: a media playlist is probed directly; fMP4 gets its init segment first', async () => {
    const s = await serve({
      '/m.m3u8': (res) => res.end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg-1.m4s\n'),
      '/init.mp4': (res) => res.end(Buffer.alloc(1000)),
      '/seg-1.m4s': (res) => res.end(Buffer.alloc(5000)),
    });
    const run = fakeRun(fixture('ffprobe-hevc.json'));
    const r = await probe({ url: `http://iptv.example.com:${s.port}/m.m3u8`, kind: 'hls', allowLan: false }, { run, guard: guard() });
    expect(r).toEqual({ ok: true, video: { codec: 'hevc', width: 3840, height: 2160, fps: 50 }, audio: { codec: 'eac3', channels: 6 }, needs: 'transcode' });
    expect(run.calls[0]!.stdin).toBe(6000);
    // L5: fMP4 (init + segment) is demuxed as MP4 only
    expect(run.calls[0]!.args.join(' ')).toContain('-f mov -format_whitelist mov -i pipe:0');
  });

  it('direct URLs and ADTS HLS are probed with the format the run uses', async () => {
    const s = await serve({
      '/radio.mp3': (res) => res.end(Buffer.alloc(500)),
      '/r.m3u8': (res) => res.end('#EXTM3U\n#EXTINF:4,\nseg-1.aac\n'),
      '/seg-1.aac': (res) => res.end(Buffer.alloc(300)),
    });
    const o = { allowLan: false } as const;
    const run = fakeRun(fixture('ffprobe-h264-aac.json'));
    await probe({ url: `http://iptv.example.com:${s.port}/radio.mp3`, kind: 'ts', ...o }, { run, guard: guard() });
    await probe({ url: `http://iptv.example.com:${s.port}/r.m3u8`, kind: 'hls', ...o }, { run, guard: guard() });
    expect(run.calls[0]!.args.join(' ')).toContain('-f mp3 -format_whitelist mp3 -i pipe:0');
    expect(run.calls[1]!.args.join(' ')).toContain('-f aac -format_whitelist aac -i pipe:0');
  });

  it('HLS behind a redirect: relative variant and segment URIs resolve against the redirected URL', async () => {
    const s = await serve({
      '/get/nordlicht.m3u8': (res) => { res.writeHead(302, { location: '/cdn/edge7/nordlicht/master.m3u8?sig=abc' }); res.end(); },
      '/cdn/edge7/nordlicht/master.m3u8': (res) => res.end(MASTER),
      '/cdn/edge7/nordlicht/fhd/index.m3u8': (res) => { res.writeHead(302, { location: '/cdn/edge9/fhd/live.m3u8' }); res.end(); },
      '/cdn/edge9/fhd/live.m3u8': (res) => res.end(MEDIA),
      '/cdn/edge9/fhd/seg-812.ts': (res) => res.end(Buffer.alloc(1000)),
    });
    const run = fakeRun(fixture('ffprobe-h264-aac.json'));
    const r = await probe({ url: `http://iptv.example.com:${s.port}/get/nordlicht.m3u8`, kind: 'hls', allowLan: false }, { run, guard: guard() });
    expect(r).toMatchObject({ ok: true, needs: 'passthrough' });
    expect(s.paths).toEqual([
      '/get/nordlicht.m3u8', '/cdn/edge7/nordlicht/master.m3u8?sig=abc', '/cdn/edge7/nordlicht/fhd/index.m3u8', '/cdn/edge9/fhd/live.m3u8', '/cdn/edge9/fhd/seg-812.ts?sig=1',
    ]);
    expect(run.calls[0]!.stdin).toBe(1000);
  });

  it('HLS: an init segment whose media segment fails is closed at once, not at the timeout', async () => {
    let initClosed: () => void = () => {};
    const closed = new Promise<void>((r) => { initClosed = r; });
    const s = await serve({
      '/m.m3u8': (res) => res.end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg-1.m4s\n'),
      // the init segment never ends: only closing it from our side ends the response
      '/init.mp4': (res) => { res.on('close', () => initClosed()); res.writeHead(200); res.write(Buffer.alloc(100)); },
      '/seg-1.m4s': (res) => { res.statusCode = 403; res.end(); },
    });
    const run = fakeRun(fixture('ffprobe-h264-aac.json'));
    const t = Date.now();
    expect((await probe({ url: `http://iptv.example.com:${s.port}/m.m3u8`, kind: 'hls', allowLan: false }, { run, guard: guard() })).error).toBe('denied');
    await closed;
    expect(Date.now() - t).toBeLessThan(3_000);
    expect(run.calls).toHaveLength(0);
  });

  it('HLS failures answer fixed codes: denied, unreachable, not a playlist, no segment', async () => {
    const s = await serve({
      '/denied.m3u8': (res) => { res.statusCode = 403; res.end(); },
      '/html.m3u8': (res) => res.end('<html>Login</html>'),
      '/empty.m3u8': (res) => res.end('#EXTM3U\n#EXT-X-ENDLIST\n'),
      '/master.m3u8': (res) => res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nfile:///etc/passwd\n'),
    });
    const run = fakeRun(fixture('ffprobe-h264-aac.json'));
    const go = (p: string) => probe({ url: `http://iptv.example.com:${s.port}${p}`, kind: 'hls', allowLan: false }, { run, guard: guard() });
    expect(await go('/denied.m3u8')).toEqual({ ok: false, needs: 'transcode', error: 'denied' });
    expect((await go('/missing.m3u8')).error).toBe('unreachable');
    expect((await go('/html.m3u8')).error).toBe('invalid');
    expect((await go('/empty.m3u8')).error).toBe('invalid');
    expect((await go('/master.m3u8')).error).toBe('invalid');
    expect(run.calls).toHaveLength(0);
  });

  it('a refused address, a bad URL or a wrong scheme never reaches ffprobe', async () => {
    const run = fakeRun('{}');
    expect((await probe({ url: 'http://iptv.example.com/x.ts', kind: 'ts', allowLan: false }, { run, guard: guard(['10.0.0.5']) })).error).toBe('address_refused');
    expect((await probe({ url: 'http://backend/x.ts', kind: 'ts', allowLan: false }, { run, guard: guard() })).error).toBe('address_refused');
    expect((await probe({ url: 'nicht eine url', kind: 'ts', allowLan: false }, { run, guard: guard() })).error).toBe('invalid');
    expect((await probe({ url: 'file:///etc/passwd', kind: 'ts', allowLan: false }, { run, guard: guard() })).error).toBe('invalid');
    expect((await probe({ url: 'http://iptv.example.com/x', kind: 'srt', allowLan: false }, { run, guard: guard() })).error).toBe('invalid');
    expect((await probe({ url: 'srt://iptv.example.com:9000', kind: 'ts', allowLan: false }, { run, guard: guard() })).error).toBe('invalid');
    expect(run.calls).toHaveLength(0);
  });

  it('TS: the first 4 MB are piped → H.264 remux; H.264 with MP2 audio is still remux', async () => {
    const s = await serve({
      '/live/hafenkanal.ts': (res) => {
        res.writeHead(200, { 'content-type': 'video/mp2t' });
        const block = Buffer.alloc(1024 * 1024, 0x47);
        for (let i = 0; i < 6; i++) res.write(block);
        // then the stream stays open, like a live channel
      },
    });
    const url = `http://iptv.example.com:${s.port}/live/hafenkanal.ts`;
    const run = fakeRun(fixture('ffprobe-h264-aac.json'));
    expect(await probe({ url, kind: 'ts', allowLan: false }, { run, guard: guard() })).toMatchObject({ ok: true, needs: 'remux' });
    expect(run.calls[0]!.stdin).toBe(4 * 1024 * 1024);
    expect(run.calls[0]!.args).toContain('pipe:0');
    expect(run.calls[0]!.args.some((a) => a.includes('http'))).toBe(false);
    const mp2 = fakeRun(fixture('ffprobe-h264-mp2.json'));
    expect(await probe({ url, kind: 'ts', allowLan: false }, { run: mp2, guard: guard() })).toEqual({
      ok: true, video: { codec: 'h264', width: 1280, height: 720, fps: 50 }, audio: { codec: 'mp2', channels: 2 }, needs: 'remux',
    });
    const hevc = fakeRun(fixture('ffprobe-hevc.json'));
    expect((await probe({ url, kind: 'ts', allowLan: false }, { run: hevc, guard: guard() })).needs).toBe('transcode');
  });

  it('TS: a source that fails while piping and gives ffprobe no video answers the source\'s code', async () => {
    const s = await serve({ '/cut.ts': (res) => { res.writeHead(200, { 'content-length': '100000' }); res.write(Buffer.alloc(10)); setTimeout(() => res.destroy(), 20); } });
    const run = fakeRun('{"streams":[]}');
    expect((await probe({ url: `http://iptv.example.com:${s.port}/cut.ts`, kind: 'ts', allowLan: false }, { run, guard: guard() })).error).toBe('unreachable');
  });

  it('SRT: ffprobe gets the checked IP literal and srt,udp only; a private address needs allowLan', async () => {
    const run = fakeRun(fixture('ffprobe-h264-aac.json'));
    const g = guard(['192.0.2.30']);
    const r = await probe({ url: 'srt://iptv.example.com:9000?streamid=bergblick&passphrase=geheim123456', kind: 'srt', allowLan: false }, { run, guard: g });
    expect(r).toMatchObject({ ok: true, needs: 'remux' });
    expect(g.lookups).toEqual(['iptv.example.com']);
    const args = run.calls[0]!.args;
    expect(args).toContain('srt://192.0.2.30:9000?streamid=bergblick&passphrase=geheim123456');
    expect(args.join(' ')).toContain('-protocol_whitelist srt,udp');
    expect(args.join(' ')).not.toContain('iptv.example.com');
    expect((await probe({ url: 'srt://iptv.example.com:9000', kind: 'srt', allowLan: false }, { run, guard: guard(['192.168.1.5']) })).error).toBe('address_refused');
    expect((await probe({ url: 'srt://iptv.example.com:9000', kind: 'srt', allowLan: true }, { run, guard: guard(['192.168.1.5']) })).ok).toBe(true);
    expect((await probe({ url: 'srt://[2001:db8::30]:9000', kind: 'srt', allowLan: false }, { run, guard: guard() })).ok).toBe(true);
    expect(run.calls.at(-1)!.args).toContain('srt://[2001:db8::30]:9000');
  });

  it('SRT: an unreachable caller (ffprobe fails) → unreachable; a failed lookup → unreachable', async () => {
    const run = fakeRun('', () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'Connection setup failure' }));
    expect((await probe({ url: 'srt://iptv.example.com:9000', kind: 'srt', allowLan: false }, { run, guard: guard() })).error).toBe('unreachable');
    expect((await probe({ url: 'srt://iptv.example.com:9000', kind: 'srt', allowLan: false }, { run, guard: guard([]) })).error).toBe('unreachable');
  });

  it('a 12 s ffprobe → timeout (the budget is 10 s)', async () => {
    const run = fakeRun('', (o) => (o.timeoutMs < 12_000 ? { code: -1, stdout: Buffer.alloc(0), stderr: '' } : undefined));
    const r = await probe({ url: 'srt://192.0.2.30:9000', kind: 'srt', allowLan: false }, { run, guard: guard() });
    expect(r).toEqual({ ok: false, needs: 'transcode', error: 'timeout' });
    expect(run.calls[0]!.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('no video stream, unreadable output or a crashing runner → no_video / invalid', async () => {
    const input: StreamInput = { url: 'srt://192.0.2.30:9000', kind: 'srt', allowLan: false };
    expect(await probe(input, { run: fakeRun('{"streams":[{"codec_type":"audio","codec_name":"aac","channels":2}]}'), guard: guard() })).toEqual({ ok: false, needs: 'transcode', error: 'no_video' });
    expect((await probe(input, { run: fakeRun('not json'), guard: guard() })).error).toBe('no_video');
    expect((await probe(input, { run: fakeRun('{"streams":[{"codec_type":"video"}]}'), guard: guard() })).error).toBe('no_video');
    const throwing = (async () => { throw new Error('boom'); }) as unknown as Run;
    expect((await probe(input, { run: throwing, guard: guard() })).error).toBe('invalid');
  });

  it('{ push } → invalid until the ingest exists', async () => {
    const run = fakeRun('{}');
    expect(await probe({ push: 'ch-1' }, { run, guard: guard() })).toEqual({ ok: false, needs: 'transcode', error: 'invalid' });
    expect(run.calls).toHaveLength(0);
  });
});
