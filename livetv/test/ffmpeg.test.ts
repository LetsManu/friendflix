// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { FetchOptions, GuardDeps, GuardedResponse } from '../src/fetch.js';
import { audioFor, ffmpegArgs, scrubLine, videoArgs } from '../src/ffmpeg.js';
import { openInput } from '../src/inputs.js';
import { createRun } from '../src/run.js';
import { ENCODERS } from '../src/system.js';
import { fakeFetch, type Served } from './streams-helpers.js';

const KEY = '0123456789abcdef0123456789abcdef';
const DIR = `/cache/${KEY}`;
const TS = Buffer.alloc(376, 0x47);
const SRT_URL = 'srt://iptv.example.com:9000?streamid=geheim&passphrase=geheimgeheim';
const SRT_LITERAL = 'srt://192.0.2.40:9000?streamid=geheim&passphrase=geheimgeheim';

/** ruling 23: the output every remux and transcode ends with */
const output = (n: number) =>
  ['-f', 'segment', '-segment_time', '4', '-segment_format', 'mpegts', '-segment_list', 'pipe:1', '-segment_list_type', 'csv', '-segment_start_number', String(n), `${DIR}/%d.ts`];
/** `part` appears in `args` as one contiguous run */
const has = (args: readonly string[], part: readonly string[]): boolean =>
  part.length > 0 && args.some((_, i) => part.every((p, j) => args[i + j] === p));
/** the value after `flag` */
const after = (args: readonly string[], flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
/** the arguments that carry data (input, output path, filter and option values) and every option name */
const carrying = (args: readonly string[]) => args.filter((x) => x.length >= 3 && (x.startsWith('-') || /[/:=,]/.test(x)));

type ArgsIn = Parameters<typeof ffmpegArgs>[0];
const args = (o: Partial<ArgsIn> = {}): string[] =>
  ffmpegArgs({ mode: 'transcode', input: { kind: 'pipe' }, encoder: 'libx264', audio: 'copy', srcHeight: 1080, dir: DIR, startNumber: 0, ...o });

function guard(answer = ['192.0.2.40']): GuardDeps & { lookups: string[] } {
  const lookups: string[] = [];
  return { lookups, own: [], lookup: async (h) => { lookups.push(h); return answer; } };
}

/** reads `src` until `n` bytes arrived (or it ends), then closes it */
async function read(src: AsyncIterable<Uint8Array>, n: number): Promise<Buffer> {
  const it = src[Symbol.asyncIterator]();
  const parts: Buffer[] = [];
  let got = 0;
  while (got < n) {
    const r = await it.next();
    if (r.done) break;
    parts.push(Buffer.from(r.value));
    got += r.value.length;
  }
  await it.return?.();
  return Buffer.concat(parts);
}

describe('ffmpegArgs', () => {
  it('transcode args per encoder', () => {
    // audio: AAC and MP3 are copied, anything else (MP2, AC-3) becomes stereo AAC
    expect([audioFor('aac'), audioFor('mp3'), audioFor('mp2'), audioFor('ac3')]).toEqual(['copy', 'copy', 'aac', 'aac']);
    for (const encoder of ENCODERS) {
      const a = args({ encoder, audio: audioFor('mp2') });
      expect([encoder, has(a, ['-c:v', encoder])]).toEqual([encoder, true]);
      const parts = [
        ['-profile:v', 'high'], ['-b:v', '6M'], ['-maxrate', '6M'], ['-bufsize', '12M'], ['-force_key_frames', 'expr:gte(t,n_forced*2)'],
        ['-c:a', 'aac', '-ac', '2', '-b:a', '160k'], ['-segment_time', '4'],
      ];
      for (const part of parts) expect([encoder, part, has(a, part)]).toEqual([encoder, part, true]);
      expect(a).not.toContain('copy');
      expect(a.slice(0, 3)).toEqual(['-hide_banner', '-loglevel', 'error']);
      expect(a.slice(-output(0).length)).toEqual(output(0));
      // the video part is the one the benchmark measures
      const v = videoArgs(encoder, 1080);
      expect(has(v, ['-c:v', encoder])).toBe(true);
      expect(has(a, v)).toBe(true);
      // a 4K source is scaled to at most 1080 lines, at the 1080-line rate
      const uhd = args({ encoder, srcHeight: 2160 });
      expect(uhd.some((x) => x.includes('1080'))).toBe(true);
      expect(after(uhd, '-b:v')).toBe('6M');
    }
    expect(has(args({ encoder: 'libx264' }), ['-c:v', 'libx264', '-preset', 'veryfast'])).toBe(true);
    // NVENC and QSV flag only IDR frames as key frames: the forced 2-s keyframes must be IDR, or segments are not cut every 4 s
    expect(has(args({ encoder: 'h264_nvenc' }), ['-forced-idr', '1'])).toBe(true);
    expect(has(args({ encoder: 'h264_qsv' }), ['-forced_idr', '1'])).toBe(true);
    // a source of at most 720 lines gets 3M; equal maxrate, twice the bufsize; an unknown height counts as large
    const rates: Array<[number | null, string, string]> = [[720, '3M', '6M'], [576, '3M', '6M'], [721, '6M', '12M'], [1080, '6M', '12M'], [null, '6M', '12M']];
    for (const [srcHeight, rate, buf] of rates) {
      const a = args({ srcHeight });
      expect([srcHeight, after(a, '-b:v'), after(a, '-maxrate'), after(a, '-bufsize')]).toEqual([srcHeight, rate, rate, buf]);
    }
  });

  it('remux copies the video; head and segment output are the same as for transcode', () => {
    const a = ffmpegArgs({ mode: 'remux', input: { kind: 'pipe' }, encoder: 'h264_nvenc', audio: 'copy', srcHeight: 1080, dir: DIR, startNumber: 17 });
    expect(a.slice(0, 3)).toEqual(['-hide_banner', '-loglevel', 'error']);
    expect(has(a, ['-c:v', 'copy'])).toBe(true);
    expect(has(a, ['-c:a', 'copy'])).toBe(true);
    for (const x of ['-b:v', '-maxrate', '-bufsize', '-force_key_frames', '-preset', ...ENCODERS]) expect([x, a.includes(x)]).toEqual([x, false]);
    expect(a.slice(-output(17).length)).toEqual(output(17));
    const aac = ffmpegArgs({ mode: 'remux', input: { kind: 'pipe' }, encoder: 'libx264', audio: 'aac', srcHeight: null, dir: DIR, startNumber: 0 });
    expect(has(aac, ['-c:v', 'copy'])).toBe(true);
    expect(has(aac, ['-c:a', 'aac', '-ac', '2', '-b:a', '160k'])).toBe(true);
  });
});

describe('inputs', () => {
  it('http inputs reach ffmpeg only through stdin', async () => {
    const seen: Array<{ url: string; o: FetchOptions }> = [];
    const fetch = async (url: string, o: FetchOptions): Promise<GuardedResponse> => {
      seen.push({ url, o });
      return { status: 200, url, headers: {}, body: (async function* () { yield TS; })() };
    };
    const url = 'http://iptv.example.com/live/anna/geheim/101.ts';
    const { ffInput } = await openInput({ url, kind: 'ts', userAgent: 'Hafenkanal-Box/1.0', allowLan: false }, { guard: guard(), fetch });
    if (ffInput.kind !== 'pipe') throw new Error('an HTTP input must be a pipe');
    // fetched by livetv (guardedFetch in production), with the source's user agent and LAN rule
    expect(seen.map((s) => [s.url, s.o.userAgent, s.o.allowLan])).toEqual([[url, 'Hafenkanal-Box/1.0', false]]);
    expect(await read(ffInput.stdin, TS.length)).toEqual(TS);
    for (const mode of ['remux', 'transcode'] as const) {
      const a = ffmpegArgs({ mode, input: { kind: 'pipe' }, encoder: 'libx264', audio: 'copy', srcHeight: 1080, dir: DIR, startNumber: 0 });
      expect(has(a, ['-protocol_whitelist', 'pipe'])).toBe(true);
      expect(has(a, ['-i', 'pipe:0'])).toBe(true);
      expect(a.indexOf('-protocol_whitelist')).toBeLessThan(a.indexOf('-i'));
      expect(a.join(' ')).not.toMatch(/https?:|iptv\.example\.com|geheim|srt/);
    }
  });

  it('an HLS input is read by livetv and reaches ffmpeg as one byte stream', async () => {
    const base = 'http://iptv.example.com/live/anna/geheim';
    const a = Buffer.alloc(188, 1);
    const b = Buffer.alloc(188, 2);
    const routes = new Map<string, Served>([
      [`${base}/103.m3u8`, ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:7', '#EXTINF:4.000,', 'seg/7.ts?token=geheim', '#EXTINF:4.000,', 'seg/8.ts?token=geheim'].join('\n')],
      [`${base}/seg/7.ts?token=geheim`, a],
      [`${base}/seg/8.ts?token=geheim`, b],
    ]);
    const ff = fakeFetch(routes);
    const { ffInput } = await openInput({ url: `${base}/103.m3u8`, kind: 'hls', allowLan: false }, { guard: guard(), fetch: ff.fetch });
    if (ffInput.kind !== 'pipe') throw new Error('an HLS input must be a pipe');
    expect(await read(ffInput.stdin, 376)).toEqual(Buffer.concat([a, b]));
    expect(ff.calls.slice(0, 3).map((c) => c.url)).toEqual([`${base}/103.m3u8`, `${base}/seg/7.ts?token=geheim`, `${base}/seg/8.ts?token=geheim`]);
  });

  it('srt inputs carry the IP literal', async () => {
    const g = guard(['192.0.2.40']);
    const fetch = async (): Promise<GuardedResponse> => { throw new Error('an SRT input is never fetched'); };
    const { ffInput } = await openInput({ url: SRT_URL, kind: 'srt', allowLan: false }, { guard: g, fetch });
    expect(ffInput).toEqual({ kind: 'srt', url: SRT_LITERAL });
    expect(g.lookups).toEqual(['iptv.example.com']);
    const a = ffmpegArgs({ mode: 'remux', input: ffInput, encoder: 'libx264', audio: 'copy', srcHeight: 1080, dir: DIR, startNumber: 0 });
    expect(has(a, ['-protocol_whitelist', 'srt,udp'])).toBe(true);
    expect(has(a, ['-i', SRT_LITERAL])).toBe(true);
    expect(a.indexOf('-protocol_whitelist')).toBeLessThan(a.indexOf('-i'));
    expect(a).not.toContain('pipe:0');
    expect(a.join(' ')).not.toContain('iptv.example.com');
    // the address guard decides before ffmpeg ever sees the input
    await expect(openInput({ url: 'srt://10.0.0.5:9000', kind: 'srt', allowLan: false }, { guard: g, fetch })).rejects.toMatchObject({ code: 'address_refused' });
    await expect(openInput({ url: SRT_URL, kind: 'srt', allowLan: true }, { guard: guard(['127.0.0.1']), fetch })).rejects.toMatchObject({ code: 'address_refused' });
  });
});

describe('scrubLine', () => {
  it('scrubLine table', () => {
    const table: Array<[string, string]> = [
      ['Error opening input http://iptv.example.com/live/anna/geheim/101.ts: Server returned 403 Forbidden', 'Error opening input <input> Server returned 403 Forbidden'],
      ['[srt @ 0x55d1c0] Connection to srt://192.0.2.40:9000?streamid=geheim failed', '[srt @ 0x55d1c0] Connection to <input> failed'],
      ['auth failed: password=geheim', 'auth failed: password=•••'],
      ['token=abc&user=anna key=k1 pass=x', 'token=•••&user=••• key=••• pass=•••'],
      ['https://iptv.example.com/a?token=abc and token=abc', '<input> and token=•••'],
      ['Conversion failed!', 'Conversion failed!'],
      ['[segment @ 0x55d1c2] Opening pipe:1 for writing', '[segment @ 0x55d1c2] Opening pipe:1 for writing'],
      // names around the keyword, more keywords, `:` as well as `=`
      ['login failed for username=anna', 'login failed for username=•••'],
      ['passwd=geheim', 'passwd=•••'],
      ['password: geheim', 'password: •••'],
      ['secret=s3cr3t pwd=x auth=y', 'secret=••• pwd=••• auth=•••'],
      ['passphrase=geheimgeheim streamid=#!::r=live', 'passphrase=••• streamid=•••'],
      ['X-Api-Key: abc123', 'X-Api-Key: •••'],
      // userinfo without a scheme
      ['Connecting to anna:geheim@192.0.2.10:8080', 'Connecting to •••@192.0.2.10:8080'],
      // a quoted URL with a space in it
      ["Opening 'srt://192.0.2.40:9000?streamid=ab cd' failed", "Opening '<input>' failed"],
    ];
    for (const [line, want] of table) expect([line, scrubLine(line)]).toEqual([line, want]);
  });
});

describe('ffmpeg stderr', () => {
  it('no log line contains iptv.example.com or an ffmpeg argument', async () => {
    const a = ffmpegArgs({ mode: 'transcode', input: { kind: 'srt', url: SRT_LITERAL }, encoder: 'libx264', audio: 'aac', srcHeight: 1080, dir: DIR, startNumber: 3 });
    // node stands in for ffmpeg and writes what a failing ffmpeg writes: its input, a provider URL, a segment path
    const script = `
const argv = process.argv.slice(1);
const input = argv[argv.indexOf('-i') + 1];
const out = argv[argv.length - 1];
process.stderr.write('[srt @ 0x55d1c0] Connection to ' + input + ' failed: Input/output error\\n');
process.stderr.write('[http @ 0x55d1c1] HTTP error 403: http://iptv.example.com/live/anna/geheim/101.ts password=geheim\\n');
process.stderr.write("[segment @ 0x55d1c2] Failed to open segment '" + out.replace('%d', '7') + "'\\n");
process.stderr.write('Conversion failed!');
process.exit(1);
`;
    const logs: string[] = [];
    const run = createRun({ ffmpeg: process.execPath });
    const r = await run('ffmpeg', ['-e', script, '--', ...a], { timeoutMs: 5_000, stderrLog: { channelId: 'ch-hafenkanal', log: (m) => logs.push(m) } });
    expect(r.code).toBe(1);
    // one log line per stderr line (the last one without its newline too), each naming the channel
    expect(logs).toHaveLength(4);
    for (const l of logs) expect(l).toContain('ch-hafenkanal');
    expect(logs[0]).toContain('Connection to');
    expect(logs[1]).toContain('password=•••');
    expect(logs[2]).toContain('Failed to open segment');
    expect(logs[3]).toContain('Conversion failed!');
    const text = logs.join('\n');
    expect(text).not.toMatch(/iptv\.example\.com|192\.0\.2\.40|geheim|streamid|passphrase/);
    // R4: no raw path — neither the stream key (the credential of /s/) nor the cache directory of an expanded segment name
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('/cache');
    expect(text).not.toContain(a.join(' '));
    const data = carrying(a);
    expect(data).toEqual(expect.arrayContaining([SRT_LITERAL, `${DIR}/%d.ts`, '-protocol_whitelist']));
    for (const x of data) expect([x, text.includes(x)]).toEqual([x, false]);
  });
});
