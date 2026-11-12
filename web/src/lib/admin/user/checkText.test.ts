// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import { summarySentences } from './checkText';
import type { RightsRow } from './rights';

afterEach(async () => { await setLocale('de'); });

const row = (key: string, value: unknown): RightsRow => ({ key, value, roleValue: value, override: null, source: 'role' });
/** a guest: age cap 12, one stream, 4 Mbit/s away, no downloads, no requests / party / comments / cast */
const guest = [
  row('maxParentalRating', 12), row('maxStreams', 1), row('remoteMaxBitrate', 4_000_000), row('download', false),
  row('requests', false), row('cast', false), row('party', false), row('partySchedule', false), row('comments', false),
];
/** a family member: no cap, may cast and download, may not request */
const family = [
  row('maxParentalRating', null), row('maxStreams', 4), row('remoteMaxBitrate', null), row('download', true),
  row('requests', false), row('cast', true), row('party', true), row('partySchedule', true), row('comments', true),
];

describe('summarySentences', () => {
  it('guest, German: one sentence per field', async () => {
    await setLocale('de');
    expect(summarySentences('Clara', guest, { visible: 1, total: 3 }, null)).toEqual([
      'Clara sieht 1 von 3 Bibliotheken.',
      'Titel bis FSK 12.',
      'Bis zu 1 gleichzeitiger Stream.',
      'Unterwegs höchstens 4 Mbit/s.',
      'Darf nicht herunterladen.',
      'Darf nicht: Wünsche, Übertragen, Watch-Partys, geplante Partys und Kommentare.',
    ]);
  });
  it('guest, English: plural of the streams and the list format follow the language', async () => {
    await setLocale('en');
    const s = summarySentences('Clara', guest, { visible: 1, total: 3 }, null);
    expect(s[0]).toBe('Clara sees 1 of 3 libraries.');
    expect(s[1]).toBe('Titles rated up to 12.');
    expect(s[2]).toBe('Up to 1 stream at once.');
    expect(s[3]).toBe('Away from home at most 4 Mbit/s.');
    expect(s[4]).toBe('May not download.');
    expect(s[5]).toBe('May not: requests, casting, watch parties, scheduled parties and comments.');
    expect(summarySentences('Clara', [...guest.filter((r) => r.key !== 'maxStreams'), row('maxStreams', 3)], { visible: 1, total: 3 }, null)[2]).toBe('Up to 3 streams at once.');
  });
  it('no limits: all libraries, no age limit, no remote line; allowed and refused rights are two sentences', async () => {
    await setLocale('de');
    expect(summarySentences('Anna', family, { visible: 3, total: 3 }, null)).toEqual([
      'Anna sieht alle Bibliotheken.',
      'Keine Altersgrenze.',
      'Bis zu 4 gleichzeitige Streams.',
      'Darf herunterladen.',
      'Darf: Übertragen, Watch-Partys, geplante Partys und Kommentare.',
      'Darf nicht: Wünsche.',
    ]);
  });
  it('a kids profile: its own sentence replaces the age line, comments and parties are not listed again', async () => {
    await setLocale('de');
    const kids = [row('maxParentalRating', 6), row('maxStreams', 2), row('remoteMaxBitrate', null), row('download', false), row('requests', false), row('cast', true), row('party', false), row('partySchedule', false), row('comments', false)];
    const s = summarySentences('Kinder', kids, { visible: 2, total: 3 }, { maxRating: 6 });
    expect(s).toContain('Kinderprofil: ab 6, Titel ohne Freigabe sind ausgeblendet, keine Kommentare, keine Partys.');
    expect(s.join(' ')).not.toMatch(/Altersgrenze|Titel bis|Kommentare\.$/);
    expect(s).toContain('Darf: Übertragen.');
    expect(s).toContain('Darf nicht: Wünsche.');
    await setLocale('en');
    expect(summarySentences('Kids', kids, { visible: 2, total: 3 }, { maxRating: 6 })).toContain('Kids profile: from 6, unrated titles are hidden, no comments, no parties.');
  });
  it('a kids profile without any limit says so, it never guesses one', async () => {
    await setLocale('de');
    const kids = [row('maxParentalRating', null), row('party', false), row('comments', false)];
    const s = summarySentences('Kinder', kids, { visible: 3, total: 3 }, { maxRating: null });
    expect(s).toContain('Kinderprofil ohne Altersgrenze: Titel ohne Freigabe sind ausgeblendet, keine Kommentare, keine Partys.');
    expect(s.join(' ')).not.toMatch(/ab \d/);
    await setLocale('en');
    expect(summarySentences('Kids', kids, { visible: 3, total: 3 }, { maxRating: null })).toContain('Kids profile without an age limit: unrated titles are hidden, no comments, no parties.');
  });
});
