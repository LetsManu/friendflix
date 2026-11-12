// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import {
  afterOrderSave, channelError, checkLogoFile, factsLine, forOrder, kindChip, nowLine, ORDER_MAX, orderFilter, overrideHint, queryString, shiftFromLine, TEST_MAX,
  type AdminChannel, type ChannelFilter,
} from './channels';

afterEach(async () => { await setLocale('de'); });

const F: ChannelFilter = { q: '', source: null, group: null, state: null, epg: null, error: false, sort: 'number', dir: 'asc', offset: 0 };
const ch = (over: Partial<AdminChannel> = {}): AdminChannel => ({
  id: 'c1', number: 1, name: 'Nordlicht TV', groupId: 'g1', sourceId: 's1', streamKind: 'hls', ingest: 'pull', logoHash: null, hidden: false, missing: false,
  epg: true, now: null, mode: null, probeError: null, overridden: {}, dupNumber: false, epgShift: { min: 0, from: 'none' }, ...over,
});

describe('orderFilter (Kanäle → Reihenfolge)', () => {
  it('needs one group or one source', () => {
    expect(orderFilter(F)).toBeNull();
    expect(orderFilter({ ...F, group: 'none' })).toBeNull(); // "Ohne Gruppe" is no group
    expect(orderFilter({ ...F, state: 'hidden', q: 'x', epg: 'no', error: true })).toBeNull();
  });
  it('keeps only the group and the source: sorted by number, from the start, never narrowed by the other filters of the list', () => {
    expect(orderFilter({ ...F, group: 'g-1', q: 'x', state: 'hidden', epg: 'no', error: true, sort: 'name', dir: 'desc', offset: 200 }))
      .toEqual({ ...F, group: 'g-1' });
    expect(orderFilter({ ...F, source: 's-1', q: 'x' })).toEqual({ ...F, source: 's-1' });
    expect(orderFilter({ ...F, source: 's-1', group: 'g-1' })).toEqual({ ...F, source: 's-1', group: 'g-1' });
  });
  it('asks for up to 500 rows', () => {
    expect(ORDER_MAX).toBe(500);
    expect(queryString({ ...F, group: 'g-1' }, ORDER_MAX)).toBe('group=g-1&sort=number&dir=asc&limit=500&offset=0');
  });
});

describe('forOrder / afterOrderSave', () => {
  it('turns "Ohne Gruppe" into no group and leaves everything else alone', () => {
    expect(forOrder({ ...F, group: 'none', source: 's-1' })).toEqual({ ...F, group: null, source: 's-1' });
    expect(forOrder({ ...F, group: 'g-1' })).toEqual({ ...F, group: 'g-1' });
  });
  it('lists the saved order with the numbers of the answer', () => {
    const rows = [ch({ id: 'a', number: 4 }), ch({ id: 'b', number: 7 }), ch({ id: 'c', number: 9 })];
    expect(afterOrderSave(rows, ['c', 'a', 'b'], 10).map((c) => [c.id, c.number])).toEqual([['c', 10], ['a', 11], ['b', 12]]);
    expect(afterOrderSave(rows, ['b', 'zz'], 1).map((c) => c.id)).toEqual(['b']); // an id that is gone is left out
  });
});

describe('queryString', () => {
  it('always names sort, direction, the page size and the offset', () => {
    expect(queryString(F)).toBe('sort=number&dir=asc&limit=100&offset=0');
  });
  it('sends only the filters that are set, in a fixed order', () => {
    expect(queryString({ ...F, q: 'Nordlicht TV', source: 's-1', group: 'none', state: 'hidden', epg: 'no', error: true, sort: 'name', dir: 'desc', offset: 200 }))
      .toBe('q=Nordlicht%20TV&source=s-1&group=none&state=hidden&epg=no&error=1&sort=name&dir=desc&limit=100&offset=200');
  });
  it('trims the search text and drops a blank one', () => {
    expect(queryString({ ...F, q: '  Hafen  ' })).toMatch(/^q=Hafen&/);
    expect(queryString({ ...F, q: '   ' })).not.toContain('q=');
  });
  it('encodes what needs it', () => {
    expect(queryString({ ...F, q: 'Bergblick & Sport/24' })).toMatch(/^q=Bergblick%20%26%20Sport%2F24&/);
  });
});

describe('overrideHint', () => {
  it('names the import value of a renamed channel', () => {
    expect(overrideHint(ch({ name: 'Nordlicht', overridden: { name: 'Nordlicht TV' } }))).toBe('geändert (Import: Nordlicht TV)');
  });
  it('has nothing to say about a channel without overrides', () => {
    expect(overrideHint(ch())).toBeNull();
  });
  it('own feeds have no import to compare with', () => {
    expect(overrideHint(ch({ overridden: { name: 'Hafenkanal' } }), { own: true })).toBeNull();
    expect(overrideHint(ch({ ingest: 'push', overridden: { name: 'Kanal Wolkenlos' } }))).toBeNull();
  });
  it('lists number and group too, the group by the name the caller knows', () => {
    const c = ch({ overridden: { name: 'Nordlicht TV', number: 12, group: 'g-sport' } });
    expect(overrideHint(c, { group: (id) => (id === 'g-sport' ? 'Sport' : null) })).toBe('geändert (Import: Nordlicht TV · Nr. 12 · Sport)');
    expect(overrideHint(ch({ overridden: { number: null, group: null } }))).toBe('geändert (Import: ohne Nummer · Ohne Gruppe)');
  });
  it('a replaced logo alone says so', () => {
    expect(overrideHint(ch({ overridden: { logo: true } }))).toBe('geändert (eigenes Logo)');
    expect(overrideHint(ch({ overridden: { name: 'Nordlicht TV', logo: true } }))).toBe('geändert (Import: Nordlicht TV; eigenes Logo)');
  });
  it('English', async () => {
    await setLocale('en');
    expect(overrideHint(ch({ overridden: { name: 'Nordlicht TV' } }))).toBe('changed (import: Nordlicht TV)');
  });
});

describe('factsLine', () => {
  it('video, audio and what the stream needs', () => {
    expect(factsLine({ video: { codec: 'h264', width: 1920, height: 1080, fps: 25 }, audio: { codec: 'aac', channels: 2 }, needs: 'remux' }))
      .toBe('H.264 1920×1080 25 fps · AAC 2.0 · wird umverpackt');
  });
  it('names the other codecs, 5.1 and the other two modes', () => {
    expect(factsLine({ video: { codec: 'hevc', width: 3840, height: 2160, fps: 50 }, audio: { codec: 'eac3', channels: 6 }, needs: 'transcode' }))
      .toBe('H.265 3840×2160 50 fps · E-AC-3 5.1 · wird umgewandelt');
    expect(factsLine({ video: { codec: 'mpeg2video', width: 720, height: 576, fps: 25 }, audio: { codec: 'mp2', channels: 2 }, needs: 'passthrough' }))
      .toBe('MPEG-2 720×576 25 fps · MP2 2.0 · wird durchgereicht');
  });
  it('a fractional frame rate keeps its decimals', () => {
    expect(factsLine({ video: { codec: 'h264', width: 1280, height: 720, fps: 29.97 }, needs: null })).toBe('H.264 1280×720 29,97 fps');
  });
  it('leaves out what is missing and shows an unknown codec as it came', () => {
    expect(factsLine({ audio: { codec: 'weird', channels: 3 }, needs: 'remux' })).toBe('WEIRD 3 Kanäle · wird umverpackt');
    expect(factsLine({ needs: null })).toBe('');
  });
});

describe('kindChip', () => {
  it('HLS, TS, SRT and SRT empfangen for a push feed', () => {
    expect(kindChip(ch({ streamKind: 'hls' }))).toBe('adminLive.ch.kind.hls');
    expect(kindChip(ch({ streamKind: 'ts' }))).toBe('adminLive.ch.kind.ts');
    expect(kindChip(ch({ streamKind: 'srt' }))).toBe('adminLive.ch.kind.srt');
    expect(kindChip(ch({ streamKind: 'srt', ingest: 'push' }))).toBe('adminLive.ch.kind.push');
  });
});

describe('shiftFromLine', () => {
  it('says where the offset comes from', () => {
    expect(shiftFromLine({ epgShift: { min: 60, from: 'list' } })).toBe('+1 Std. · aus der Senderliste (tvg-shift)');
    expect(shiftFromLine({ epgShift: { min: -90, from: 'source' } })).toBe('−1,5 Std. · aus der Quelle');
    expect(shiftFromLine({ epgShift: { min: 30, from: 'channel' } })).toBe('+0,5 Std. · für diesen Sender festgelegt');
  });
  it('no offset at all is "keine"', () => {
    expect(shiftFromLine({ epgShift: { min: 0, from: 'none' } })).toBe('keine');
  });
});

describe('nowLine', () => {
  const at = (h: number, m: number) => new Date(2026, 10, 12, h, m).toISOString();
  it('title and the time range', () => {
    expect(nowLine({ title: 'Die Leuchtturmwärter', start: at(20, 15), end: at(21, 0) })).toBe('Die Leuchtturmwärter · 20:15–21:00');
  });
  it('no programme in words', () => {
    expect(nowLine(null)).toBe('Kein Programm verfügbar');
  });
});

describe('channelError', () => {
  it('words every code the Kanäle routes answer', () => {
    for (const c of ['test_running', 'no_stream_url', 'livetv_off', 'livetv_unreachable', 'address_refused', 'too_large', 'unsupported_type']) {
      const s = channelError(c);
      expect(s, c).not.toBe('Das hat nicht geklappt.');
      expect(s, c).not.toContain('adminLive');
    }
    expect(channelError('test_running')).toBe('Es läuft schon ein Stream-Test. Warte, bis er fertig ist.');
    expect(channelError('too_large')).toBe('Das Bild ist größer als 512 KB.');
  });
  it('never shows an unknown code', () => {
    expect(channelError('ECONNRESET iptv.example.com')).toBe('Das hat nicht geklappt.');
    expect(channelError(null)).toBe('Das hat nicht geklappt.');
  });
});

describe('checkLogoFile', () => {
  const file = (name: string, type: string, size: number) => ({ name, type, size });
  it('takes PNG, JPEG and WebP up to 512 KB', () => {
    expect(checkLogoFile(file('a.png', 'image/png', 1000))).toBeNull();
    expect(checkLogoFile(file('a.jpg', 'image/jpeg', 512 * 1024))).toBeNull();
    expect(checkLogoFile(file('a.webp', 'image/webp', 10))).toBeNull();
  });
  it('refuses SVG by type and by name, before anything is sent', () => {
    expect(checkLogoFile(file('logo.svg', 'image/svg+xml', 300))).toBe('svg');
    expect(checkLogoFile(file('logo.SVG', '', 300))).toBe('svg');
  });
  it('refuses more than 512 KB and other types', () => {
    expect(checkLogoFile(file('a.png', 'image/png', 512 * 1024 + 1))).toBe('too_large');
    expect(checkLogoFile(file('a.gif', 'image/gif', 100))).toBe('unsupported_type');
    expect(checkLogoFile(file('a.png', 'image/png', 0))).toBe('unsupported_type');
  });
});

describe('TEST_MAX', () => {
  it('is the backend limit of a bulk test', () => { expect(TEST_MAX).toBe(20); });
});
