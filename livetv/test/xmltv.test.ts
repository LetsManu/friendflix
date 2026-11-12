// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FetchError } from '../src/fetch.js';
import { XmltvError, parseXmltv, type XmlItem } from '../src/xmltv.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
async function* chunks(b: Uint8Array, size = b.length || 1): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}
const FROM = Date.UTC(2026, 10, 11);
const TO = Date.UTC(2026, 10, 12);
type O = { from?: number; to?: number; channels?: Set<string>; maxProgrammes?: number; maxBytes?: number };
async function collect(input: Uint8Array | string | AsyncIterable<Uint8Array>, o: O = {}, size?: number): Promise<{ items: XmlItem[]; error?: string }> {
  const bytes = typeof input === 'string' ? chunks(Buffer.from(input), size) : input instanceof Uint8Array ? chunks(input, size) : input;
  const items: XmlItem[] = [];
  try {
    for await (const it of parseXmltv(bytes, { from: o.from ?? FROM, to: o.to ?? TO, maxProgrammes: o.maxProgrammes ?? 300_000, channels: o.channels, maxBytes: o.maxBytes })) items.push(it);
  } catch (e) {
    return { items, error: e instanceof XmltvError || e instanceof FetchError ? e.code : `other:${String(e)}` };
  }
  return { items };
}
const doc = (body: string) => `<?xml version="1.0"?>\n<tv>\n${body}\n</tv>\n`;
const prog = (start: string, stop: string, inner = '<title>Wetter am Hafen</title>', ch = 'nordlicht.de') => `<programme start="${start}" stop="${stop}" channel="${ch}">${inner}</programme>`;

const EXPECTED: XmlItem[] = [
  { t: 'channel', id: 'nordlicht.de', names: ['Nordlicht TV', 'Nordlicht HD'], icon: 'https://iptv.example.com/logo/nordlicht.png' },
  { t: 'channel', id: 'hafenkanal.de', names: ['Hafenkanal'] },
  { t: 'channel', id: 'sternwarte24.de', names: ['Sternwarte 24'] },
  {
    t: 'prog', ch: 'nordlicht.de', start: Date.UTC(2026, 10, 11, 19, 15), end: Date.UTC(2026, 10, 11, 20, 0), title: 'Die Leuchtturmwärter',
    subtitle: 'Sturm & Stille', desc: 'Anna Beispiel hütet den Leuchtturm <Nord>.', cats: ['Serie', 'Drama'], episode: 'S2E5', seriesId: 'EP01234567',
    isNew: true, rating: '12',
  },
  { t: 'prog', ch: 'nordlicht.de', start: Date.UTC(2026, 10, 11, 20, 0), end: Date.UTC(2026, 10, 11, 20, 15), title: 'Wetter am Hafen', episode: 'Folge 7', prevShown: true },
  { t: 'prog', ch: 'hafenkanal.de', start: Date.UTC(2026, 10, 11, 20, 0), end: Date.UTC(2026, 10, 11, 21, 0), title: 'Abenteuer Wattenmeer', seriesId: 'wattenmeer' },
  { t: 'prog', ch: 'sternwarte24.de', start: Date.UTC(2026, 10, 11, 22, 0), end: Date.UTC(2026, 10, 11, 23, 0), title: 'Sternstunde Physik' },
];

describe('parseXmltv', () => {
  it('parses the guide: channels with names and icon, programmes with every field; out-of-window and invalid times skipped', async () => {
    expect(await collect(fixture('guide.xml'))).toEqual({ items: EXPECTED });
  });

  it('plain and gzip give the same items (gzip by magic bytes, any chunking)', async () => {
    expect(await collect(fixture('guide.xml.gz'))).toEqual({ items: EXPECTED });
    expect(await collect(fixture('guide.xml.gz'), {}, 5)).toEqual({ items: EXPECTED });
    expect(await collect(fixture('guide.xml'), {}, 3)).toEqual({ items: EXPECTED });
  });

  it('times: +0100 → UTC; the two 02:30 of the DST change are one hour apart; seconds may be left out', async () => {
    const r = await collect(doc([
      prog('20261111201500 +0100', '20261111210000 +0100'),
      prog('20261025023000 +0200', '20261025033000 +0200'),
      prog('20261025023000 +0100', '20261025033000 +0100'),
      prog('202611112015 -0030', '202611112100'),
    ].join('\n')), { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 11, 1) });
    const starts = r.items.map((i) => (i.t === 'prog' ? i.start : 0));
    expect(starts[0]).toBe(Date.UTC(2026, 10, 11, 19, 15));
    expect(starts[2]! - starts[1]!).toBe(3_600_000);
    expect(starts[3]).toBe(Date.UTC(2026, 10, 11, 20, 45));
  });

  it('skips programmes without a valid stop, with stop before start, or with impossible dates', async () => {
    const r = await collect(doc([
      prog('20261111201500 +0100', ''), prog('20261111201500 +0100', '20261111200000 +0100'), prog('20261311201500', '20261311211500'),
      prog('20261111201500 +2500', '20261111211500'), '<programme start="20261111201500" stop="20261111211500"><title>X</title></programme>',
      prog('20261111201500', '20261111211500', '<desc>kein Titel</desc>'),
    ].join('\n')));
    expect(r).toEqual({ items: [] });
  });

  it('programmes outside the window are skipped, overlapping ones kept', async () => {
    const r = await collect(doc([prog('20261110233000 +0000', '20261111003000 +0000'), prog('20261110220000 +0000', '20261110230000 +0000'), prog('20261112010000 +0000', '20261112020000 +0000')].join('')));
    expect(r.items).toHaveLength(1);
  });

  it('doctype.xml → doctype; a lone <!ENTITY> too; anything else after <! is invalid', async () => {
    expect((await collect(fixture('doctype.xml'))).error).toBe('doctype');
    expect((await collect('<?xml version="1.0"?><!ENTITY x "y"><tv></tv>')).error).toBe('doctype');
    expect((await collect('<tv><!ELEMENT x ANY></tv>')).error).toBe('invalid');
  });

  it('&custom; → invalid; the five predefined and numeric entities are fine; a bare & stays text', async () => {
    const r = await collect(fixture('entity.xml'));
    expect(r.error).toBe('invalid');
    expect(r.items).toEqual([{ t: 'channel', id: 'nordlicht.de', names: ['Nordlicht TV'] }]);
    const ok = await collect(doc(`<channel id="a&amp;b"><display-name>&lt;&gt;&amp;&quot;&apos;&#65;&#x42; Tom & Jerry</display-name></channel>`));
    expect(ok.items).toEqual([{ t: 'channel', id: 'a&b', names: ['<>&"\'AB Tom & Jerry'] }]);
    expect((await collect(doc('<channel id="x"><display-name>&#xD800;</display-name></channel>'))).error).toBe('invalid');
    expect((await collect(doc('<channel id="x"><display-name>&#99999999;</display-name></channel>'))).error).toBe('invalid');
    expect((await collect(doc('<channel id="&nbsp;"/>'))).error).toBe('invalid');
  });

  it('a 1 MB zero gzip → ratio', async () => {
    expect((await collect(gzipSync(Buffer.alloc(1024 * 1024)))).error).toBe('ratio');
  });

  it('more than maxBytes decompressed → too_big', async () => {
    const big = Buffer.from(doc(`<channel id="x"><display-name>${'Nordlicht '.repeat(10_000)}</display-name></channel>`));
    expect((await collect(big, { maxBytes: 50_000 })).error).toBe('too_big');
    expect((await collect(gzipSync(big), { maxBytes: 50_000 })).error).toBe('too_big');
  });

  it('broken input is invalid: a broken gzip, a cut-off document, another root, text outside the root, a giant token', async () => {
    const gz = fixture('guide.xml.gz');
    expect((await collect(Buffer.concat([gz.subarray(0, 20), Buffer.alloc(40, 7)]))).error).toBe('invalid');
    const cut = await collect(fixture('guide.xml').subarray(0, 900));
    expect(cut.error).toBe('invalid');
    expect(cut.items.length).toBeGreaterThan(0);
    expect((await collect('<html><body>Login</body></html>')).error).toBe('invalid');
    expect((await collect('Login required')).error).toBe('invalid');
    expect((await collect('<tv></tv>trailing')).error).toBe('invalid');
    expect((await collect('<tv></tvx>')).error).toBe('invalid');
    expect((await collect('<tv><a b="1></a></tv>')).error).toBe('invalid');
    expect((await collect(`<tv><desc>${'x'.repeat(2 * 1024 * 1024)}</desc></tv>`)).error).toBe('invalid');
    expect((await collect(`<tv><desc a="${'x'.repeat(2 * 1024 * 1024)}"/></tv>`)).error).toBe('invalid');
    expect((await collect(`<tv><desc><![CDATA[${'x'.repeat(2 * 1024 * 1024)}]]></desc></tv>`)).error).toBe('invalid');
    expect((await collect('')).error).toBe('invalid');
  });

  it('a failing source keeps its own code', async () => {
    async function* failing(): AsyncGenerator<Uint8Array> { yield Buffer.from('<tv>'); throw new FetchError('timeout'); }
    expect((await collect(failing())).error).toBe('timeout');
    async function* failingGz(): AsyncGenerator<Uint8Array> { yield gzipSync(Buffer.from('<tv>')).subarray(0, 12); throw new FetchError('too_big'); }
    expect((await collect(failingGz())).error).toBe('too_big');
  });

  it('maxProgrammes 3 stops after three and closes the source', async () => {
    let closed = false;
    async function* src(): AsyncGenerator<Uint8Array> {
      try {
        yield Buffer.from('<tv>');
        for (let i = 0; i < 10; i++) yield Buffer.from(prog(`2026111120${String(i).padStart(2, '0')}00 +0000`, `2026111120${String(i + 1).padStart(2, '0')}00 +0000`));
        yield Buffer.from('</tv>');
      } finally { closed = true; }
    }
    const r = await collect(src(), { maxProgrammes: 3 });
    expect(r.items.filter((i) => i.t === 'prog')).toHaveLength(3);
    expect(r.error).toBeUndefined();
    expect(closed).toBe(true);
  });

  it('title and sub-title cut at 200, description at 2 000, whitespace trimmed', async () => {
    const r = await collect(doc(prog('20261111201500 +0100', '20261111210000 +0100', `<title>  ${'T'.repeat(300)}</title><sub-title>${'S'.repeat(300)}</sub-title><desc>${'ü'.repeat(3000)}</desc>`)));
    const p = r.items[0] as Extract<XmlItem, { t: 'prog' }>;
    expect(p.title).toBe('T'.repeat(200));
    expect(p.subtitle).toBe('S'.repeat(200));
    expect(p.desc).toBe('ü'.repeat(2000));
  });

  it('the channels filter keeps the named channels and their programmes only', async () => {
    const r = await collect(fixture('guide.xml'), { channels: new Set(['hafenkanal.de']) });
    expect(r.items).toEqual([EXPECTED[1], EXPECTED[5]]);
  });

  it('icon: the first http(s) <icon src>; file: and data: icons → none', async () => {
    const r = await collect(doc([
      '<channel id="a"><display-name>Nordlicht TV</display-name><icon src="https://iptv.example.com/logo/nordlicht.png"/></channel>',
      '<channel id="b"><icon src="file:///etc/passwd"/><icon src="http://iptv.example.com/logo/hafen.png"/></channel>',
      '<channel id="c"><icon src="data:image/png;base64,AAAA"/><icon/></channel>',
    ].join('')));
    expect(r.items).toEqual([
      { t: 'channel', id: 'a', names: ['Nordlicht TV'], icon: 'https://iptv.example.com/logo/nordlicht.png' },
      { t: 'channel', id: 'b', names: [], icon: 'http://iptv.example.com/logo/hafen.png' },
      { t: 'channel', id: 'c', names: [] },
    ]);
  });

  it('episode numbers: xmltv_ns with totals, episode only; dd_progid without a dot; channel without id skipped', async () => {
    const r = await collect(doc([
      '<channel><display-name>Ohne Id</display-name></channel>',
      prog('20261111201500', '20261111210000', '<title>A</title><episode-num system="xmltv_ns">2/5 . 9/10 . 0/1</episode-num><episode-num system="dd_progid">SH01234567</episode-num>'),
      prog('20261111201500', '20261111210000', '<title>B</title><episode-num system="xmltv_ns">. 3 .</episode-num>'),
      prog('20261111201500', '20261111210000', '<title>C</title><episode-num system="xmltv_ns">..</episode-num><category> </category>'),
    ].join('')));
    expect(r.items).toEqual([
      { t: 'prog', ch: 'nordlicht.de', start: Date.UTC(2026, 10, 11, 20, 15), end: Date.UTC(2026, 10, 11, 21), title: 'A', episode: 'S3E10', seriesId: 'SH01234567' },
      { t: 'prog', ch: 'nordlicht.de', start: Date.UTC(2026, 10, 11, 20, 15), end: Date.UTC(2026, 10, 11, 21), title: 'B', episode: 'E4' },
      { t: 'prog', ch: 'nordlicht.de', start: Date.UTC(2026, 10, 11, 20, 15), end: Date.UTC(2026, 10, 11, 21), title: 'C' },
    ]);
  });
});
