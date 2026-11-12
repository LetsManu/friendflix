// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { M3uError, entryKey, normName, parseM3u, parseShift, splitLines } from '../src/m3u.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
async function* chunks(b: Uint8Array, size = b.length || 1): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}
/** provider.m3u with a BOM and CRLF line ends, made here so the repository holds LF files only */
const crlfBom = () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(fixture('provider.m3u').toString('utf8').replaceAll('\n', '\r\n'))]);
const lines = (b: Uint8Array | string, size?: number) => splitLines(chunks(typeof b === 'string' ? Buffer.from(b) : b, size));
const parse = (b: Uint8Array | string, o: { max?: number; skipGroups?: ReadonlySet<string> } = {}) => parseM3u(lines(b), { max: o.max ?? 20_000, skipGroups: o.skipGroups });
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof M3uError ? e.code : `other:${String(e)}`));

/** a generated list: `n` live entries, the first `skipped` of them in group "Gesperrt" */
function bigList(n: number, skipped = 0): string {
  const out = ['#EXTM3U'];
  for (let i = 0; i < n; i++) out.push(`#EXTINF:-1 tvg-id="k${i}" group-title="${i < skipped ? 'Gesperrt' : 'Alle'}",Kanal Wolkenlos ${i}`, `http://iptv.example.com/live/${i}.ts`);
  return out.join('\n');
}

describe('parseM3u', () => {
  it('attributes and quoting: quoted, unquoted, #EXTGRP, the user agent of #EXTVLCOPT, kinds', async () => {
    const r = await parse(fixture('provider.m3u'));
    const [nordlicht, hafen, berg, kinder, kinderPlus, stern] = r.entries;
    expect(nordlicht).toEqual({
      key: 'nordlicht.de', name: 'Nordlicht TV HD', tvgId: 'nordlicht.de', tvgName: 'Nordlicht TV', chno: 1, group: 'DE | Sport',
      logo: 'https://iptv.example.com/logo/nordlicht.png', pos: 0, url: 'https://iptv.example.com/live/nordlicht/index.m3u8', kind: 'hls',
    });
    expect(hafen).toEqual({
      key: 'hafenkanal.de', name: 'Hafenkanal', tvgId: 'hafenkanal.de', chno: 2, group: 'DE | Sport', pos: 1,
      url: 'http://iptv.example.com/live/hafenkanal.ts', kind: 'ts', userAgent: 'Hafenkanal-Box/1.0',
    });
    expect(berg).toMatchObject({ name: 'Bergblick Sport', tvgName: 'Bergblick Sport', kind: 'srt', shiftMin: -90, pos: 2 });
    expect(berg!.key).toMatch(/^[0-9a-f]{32}$/);
    expect(kinder).toMatchObject({ name: 'Kinderinsel', group: 'Kinder', kind: 'ts', pos: 3 });
    expect(kinderPlus).toMatchObject({ group: 'Kinder', kind: 'hls', pos: 4 });
    expect(stern).toMatchObject({ name: 'Sternwarte 24', group: 'Nachrichten', pos: 5 });
    expect(r.entries).toHaveLength(6);
  });

  it('VOD entries are skipped and counted (/movie/, .mkv)', async () => {
    const r = await parse(fixture('provider.m3u'));
    expect(r.skipped).toEqual({ vod: 2, invalid: 0, overLimit: 0, groups: 0 });
    expect(r.entries.some((e) => e.group === 'Filme')).toBe(false);
    const more = await parse('#EXTM3U\n#EXTINF:-1,A\nhttp://iptv.example.com/series/a/b/1.ts\n#EXTINF:-1,B\nhttp://iptv.example.com/x/B.MP4\n#EXTINF:-1,C\nhttp://iptv.example.com/x/c.avi?x=1\n#EXTINF:-1,D\nhttp://iptv.example.com/x/d.mov\n');
    expect(more.skipped.vod).toBe(4);
    expect(more.listed).toBe(0);
  });

  it('the BOM/CRLF variant parses equal to the plain one, also when split into small chunks', async () => {
    const plain = await parse(fixture('provider.m3u'));
    expect(await parse(crlfBom())).toEqual(plain);
    expect(await parseM3u(lines(crlfBom(), 7), { max: 20_000 })).toEqual(plain);
  });

  it('no #EXTM3U header → not_m3u (also for an HTML page and an empty body)', async () => {
    expect(await codeOf(parse('#EXTINF:-1,Nordlicht TV\nhttp://iptv.example.com/live/1.ts\n'))).toBe('not_m3u');
    expect(await codeOf(parse('<html><body>Login</body></html>'))).toBe('not_m3u');
    expect(await codeOf(parse(''))).toBe('not_m3u');
    expect(await codeOf(parse('\n\n#EXTM3U\n'))).toBe('ok');
  });

  it('20 005 entries → the first 20 000 and overLimit 5; listed counts all', async () => {
    const r = await parse(bigList(20_005));
    expect(r.entries).toHaveLength(20_000);
    expect(r.entries.at(-1)!.tvgId).toBe('k19999');
    expect(r.skipped.overLimit).toBe(5);
    expect(r.listed).toBe(20_005);
    expect(r.groups).toEqual([{ name: 'Alle', channels: 20_005 }]);
  });

  it('a 9 KB line skips its entry (invalid 1), wherever it is in the entry', async () => {
    const long = 'x'.repeat(9 * 1024);
    const ok = '#EXTINF:-1,Hafenkanal\nhttp://iptv.example.com/live/2.ts\n';
    const inInfo = await parse(`#EXTM3U\n#EXTINF:-1 tvg-name="${long}",Nordlicht TV\nhttp://iptv.example.com/live/1.ts\n${ok}`);
    expect(inInfo.skipped.invalid).toBe(1);
    expect(inInfo.entries.map((e) => e.name)).toEqual(['Hafenkanal']);
    const inUrl = await parse(`#EXTM3U\n#EXTINF:-1,Nordlicht TV\nhttp://iptv.example.com/live/${long}.ts\n${ok}`);
    expect(inUrl.skipped.invalid).toBe(1);
    expect(inUrl.entries.map((e) => e.name)).toEqual(['Hafenkanal']);
    const inOpt = await parse(`#EXTM3U\n#EXTINF:-1,Nordlicht TV\n#EXTVLCOPT:http-user-agent=${long}\nhttp://iptv.example.com/live/1.ts\n${ok}`, { max: 10 });
    expect(inOpt.skipped.invalid).toBe(1);
    expect(inOpt.entries.map((e) => e.name)).toEqual(['Hafenkanal']);
    expect(inOpt.entries[0]!.pos).toBe(0);
  });

  it('broken entries count as invalid: no #EXTINF, a bad scheme, no name, garbage URL', async () => {
    const r = await parse('#EXTM3U\nhttp://iptv.example.com/live/0.ts\n#EXTINF:-1,Datei\nfile:///etc/passwd\n#EXTINF:-1,\nhttp://iptv.example.com/live/2.ts\n#EXTINF:-1,Kaputt\nhttp://[zz/\n#EXTINF:-1 tvg-name="Kanal Wolkenlos",\nhttp://iptv.example.com/live/4.ts\n');
    expect(r.skipped.invalid).toBe(4);
    expect(r.entries.map((e) => e.name)).toEqual(['Kanal Wolkenlos']);
  });

  it('a bad tvg-chno or an empty attribute is left out', async () => {
    const r = await parse('#EXTM3U\n#EXTINF:-1 tvg-chno="abc" tvg-id="" tvg-logo="" group-title="",Hafenkanal\nhttp://iptv.example.com/live/2.ts\n#EXTINF:-1 tvg-chno=7.5,Nordlicht TV\nhttp://iptv.example.com/live/1.ts\n');
    expect(r.entries[0]).toEqual({ key: entryKey({ name: 'Hafenkanal', url: 'http://iptv.example.com/live/2.ts' }), name: 'Hafenkanal', pos: 0, url: 'http://iptv.example.com/live/2.ts', kind: 'ts' });
    expect(r.entries[1]!.chno).toBeUndefined();
    expect(r.groups).toEqual([]);
  });

  it('credential path segments do not change the key (Review Focus 2)', async () => {
    const alt = fixture('xtream.m3u').toString('utf8');
    const neu = alt.replaceAll('/alt/', '/neu/').replace('anna:alt@', 'anna:neu@').replace('token=abc', 'token=xyz');
    const a = await parse(alt);
    const b = await parse(neu);
    expect(a.entries.map((e) => e.key)).toEqual(b.entries.map((e) => e.key));
    expect(a.entries.map((e) => e.url)).not.toEqual(b.entries.map((e) => e.url));
    expect(entryKey({ name: 'Nordlicht TV', url: 'http://iptv.example.com:8080/live/anna/alt/101.ts' }))
      .toBe(entryKey({ name: 'Nordlicht TV', url: 'http://iptv.example.com:8080/live/anna/neu/101.ts' }));
    // the documented derivation (ruling 18): normName | host | last path segment
    expect(a.entries[0]!.key).toBe(createHash('sha256').update('nordlichttv|iptv.example.com|101.ts').digest('hex').slice(0, 32));
    // another stream id or another host is another channel
    expect(entryKey({ name: 'Nordlicht TV', url: 'http://iptv.example.com/live/anna/alt/102.ts' })).not.toBe(entryKey({ name: 'Nordlicht TV', url: 'http://iptv.example.com/live/anna/alt/101.ts' }));
    expect(entryKey({ name: 'Nordlicht TV', url: 'http://192.0.2.10/live/anna/alt/101.ts' })).not.toBe(entryKey({ name: 'Nordlicht TV', url: 'http://iptv.example.com/live/anna/alt/101.ts' }));
    expect(entryKey({ tvgId: ' nordlicht.de ', name: 'x', url: 'http://iptv.example.com/1.ts' })).toBe('nordlicht.de');
  });

  it('the same derived key twice → :2, :3 (also for equal tvg-ids)', async () => {
    const e = '#EXTINF:-1,Nordlicht TV\nhttp://iptv.example.com/live/a/101.ts\n#EXTINF:-1,Nordlicht TV HD\nhttp://iptv.example.com/live/b/101.ts\n#EXTINF:-1,nordlicht-tv\nhttp://iptv.example.com/live/c/101.ts\n';
    const r = await parse(`#EXTM3U\n${e}#EXTINF:-1 tvg-id="x.de",A\nhttp://iptv.example.com/1.ts\n#EXTINF:-1 tvg-id="x.de",B\nhttp://iptv.example.com/2.ts\n`);
    const k = r.entries[0]!.key;
    expect(r.entries.map((x) => x.key)).toEqual([k, `${k}:2`, `${k}:3`, 'x.de', 'x.de:2']);
  });

  it('tvg-shift: the header is every entry\'s default, an entry\'s own value wins, bad values are ignored', async () => {
    const r = await parse('#EXTM3U tvg-shift="1"\n#EXTINF:-1,A\nhttp://iptv.example.com/1.ts\n#EXTINF:-1 tvg-shift="-1.5",B\nhttp://iptv.example.com/2.ts\n#EXTINF:-1 tvg-shift="20",C\nhttp://iptv.example.com/3.ts\n');
    expect(r.entries.map((e) => e.shiftMin)).toEqual([60, -90, 60]);
    const none = await parse('#EXTM3U\n#EXTINF:-1 tvg-shift="20",A\nhttp://iptv.example.com/1.ts\n#EXTINF:-1 tvg-shift=abc,B\nhttp://iptv.example.com/2.ts\n');
    expect(none.entries.map((e) => e.shiftMin)).toEqual([undefined, undefined]);
    expect(none.entries[0]).not.toHaveProperty('shiftMin');
  });

  it('groups and skipping: list order and counts, skipped groups dropped before the cap, positions kept', async () => {
    const all = await parse(fixture('provider.m3u'));
    expect(all.groups).toEqual([{ name: 'DE | Sport', channels: 3 }, { name: 'Kinder', channels: 2 }, { name: 'Nachrichten', channels: 1 }]);
    expect(all.listed).toBe(6);
    const some = await parse(fixture('provider.m3u'), { skipGroups: new Set(['Kinder']) });
    expect(some.entries).toHaveLength(4);
    expect(some.skipped).toEqual({ vod: 2, invalid: 0, overLimit: 0, groups: 2 });
    expect(some.entries.find((e) => e.group === 'Nachrichten')!.pos).toBe(5);
    expect(some.groups).toEqual(all.groups);
    expect(some.listed).toBe(6);
    // keys do not depend on the selection
    expect(some.entries.map((e) => e.key)).toEqual(all.entries.filter((e) => e.group !== 'Kinder').map((e) => e.key));
    const big = await parse(bigList(20_005, 10_000), { skipGroups: new Set(['Gesperrt']) });
    expect(big.entries).toHaveLength(10_005);
    expect(big.skipped).toEqual({ vod: 0, invalid: 0, overLimit: 0, groups: 10_000 });
    expect(big.entries[0]!.pos).toBe(10_000);
    expect(big.listed).toBe(20_005);
  });
});

describe('parseShift', () => {
  it('hours with decimals → whole minutes inside −12…+14 h, else undefined', () => {
    expect(parseShift('1')).toBe(60);
    expect(parseShift('-1.5')).toBe(-90);
    expect(parseShift('+2')).toBe(120);
    expect(parseShift('0.25')).toBe(15);
    expect(parseShift('-12')).toBe(-720);
    expect(parseShift('14')).toBe(840);
    expect(parseShift('20')).toBeUndefined();
    expect(parseShift('-12.5')).toBeUndefined();
    expect(parseShift('abc')).toBeUndefined();
    expect(parseShift('')).toBeUndefined();
    expect(parseShift('1e1')).toBeUndefined();
    expect(parseShift(undefined)).toBeUndefined();
  });
});

describe('normName', () => {
  it('lowercase, no marks, alphanumerics only, a trailing quality tag dropped', () => {
    expect(normName('Nordlicht TV HD')).toBe('nordlichttv');
    expect(normName('Nordlicht TV')).toBe('nordlichttv');
    expect(normName('Bergblick Sport FHD')).toBe('bergblicksport');
    expect(normName('Kanal Wolkenlos UHD')).toBe('kanalwolkenlos');
    expect(normName('Sternwarte 24 4K')).toBe('sternwarte24');
    expect(normName('Hafen_Kanal')).toBe('hafenkanal');
    expect(normName('Die Leuchtturmwärter')).toBe('dieleuchtturmwarter');
    expect(normName('Kinderinsel ①')).toBe('kinderinsel1');
  });
});

describe('splitLines', () => {
  it('splits on LF, drops a CR, decodes UTF-8 across chunk borders, cuts a long line after the limit', async () => {
    const out: string[] = [];
    for await (const l of splitLines(chunks(Buffer.from('ä\r\nb\n\nlang-zeile\nende'), 1), 6)) out.push(l);
    expect(out).toEqual(['ä', 'b', '', 'lang-ze', 'ende']);
  });
});
