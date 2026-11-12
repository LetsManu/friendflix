// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hasKey, setLocale } from '#lib/i18n';
import { EVENT_CODES, bitrateText, cacheLine, eventText, inputText, levelWord, matchLine, modeText, type LiveEvent } from './status';

afterEach(async () => { await setLocale('de'); });

const GB = 1024 ** 3;
const ev = (over: Partial<LiveEvent> = {}): LiveEvent => ({ at: 1_700_000_000_000, level: 'warn', code: 'input_lost', ...over });

describe('EVENT_CODES (F20)', () => {
  it('EVENT_CODES mirrors the backend list', () => {
    expect([...EVENT_CODES]).toEqual([
      'source_refresh_failed', 'ingest_sync_pending', 'stopped_by_admin', 'start_refused_full', 'start_failed', 'input_lost', 'input_back', 'push_rejected', 'released_on_switch',
    ]);
    // and the file it mirrors says the same, in the same order
    const src = readFileSync(fileURLToPath(new URL('../../../../../backend/src/livetv/events.ts', import.meta.url)), 'utf8');
    const list = src.slice(src.indexOf('LIVE_EVENT_CODES = ['), src.indexOf('] as const'));
    expect([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...EVENT_CODES]);
  });
});

describe('cacheLine', () => {
  it('says used of max in GB with one decimal where needed', async () => {
    expect(cacheLine({ usedBytes: 3.1 * GB, maxBytes: 6 * GB })).toBe('3,1 von 6 GB');
    expect(cacheLine({ usedBytes: 0, maxBytes: 6 * GB })).toBe('0 von 6 GB');
    expect(cacheLine({ usedBytes: 12 * GB, maxBytes: 12 * GB })).toBe('12 von 12 GB');
    await setLocale('en');
    expect(cacheLine({ usedBytes: 3.1 * GB, maxBytes: 6 * GB })).toBe('3.1 of 6 GB');
  });
  it('shows a dash while livetv cannot tell (no maximum)', () => {
    expect(cacheLine({ usedBytes: 0, maxBytes: 0 })).toBe('–');
  });
});

describe('eventText', () => {
  it('has a key and a German text for every code, and none falls back to the raw code', () => {
    for (const code of EVENT_CODES) {
      expect(hasKey(`adminLive.ev.${code}`), code).toBe(true);
      const text = eventText(ev({ code, n: 3, reason: 'timeout' }));
      expect(text, code).not.toBe('');
      expect(text, code).not.toContain(code);
      expect(text, code).not.toMatch(/adminLive|\{[a-z]+\}/);
      const bare = eventText(ev({ code }));
      expect(bare, code).not.toMatch(/adminLive|\{[a-z]+\}|undefined|NaN/);
      expect(bare, code).not.toContain(code);
    }
  });
  it('words the codes of the spec', () => {
    expect(eventText(ev({ code: 'input_lost', n: 12 }))).toBe('Eingang verloren · 12 s bis zur Wiederverbindung');
    expect(eventText(ev({ code: 'input_lost' }))).toBe('Eingang verloren');
    expect(eventText(ev({ code: 'start_refused_full' }))).toBe('Start abgelehnt: alle Plätze belegt');
    expect(eventText(ev({ code: 'push_rejected' }))).toBe('Verbindung abgelehnt: falsche Kennung oder Passphrase');
    expect(eventText(ev({ code: 'released_on_switch' }))).toBe('Beim Umschalten sofort beendet (Platz oder Verbindung gebraucht)');
  });
  it('source_refresh_failed names the source and the reason through adminLive.src.err', () => {
    expect(eventText(ev({ code: 'source_refresh_failed', reason: 'unreachable' }), { source: 'Anbieter A' })).toBe('Quelle Anbieter A: Aktualisierung fehlgeschlagen (Nicht erreichbar)');
    expect(eventText(ev({ code: 'source_refresh_failed', reason: 'timeout' }), { source: 'Anbieter A' })).toContain('(Zeitüberschreitung)');
    expect(eventText(ev({ code: 'source_refresh_failed', reason: 'unreachable' }))).toContain('Aktualisierung fehlgeschlagen (Nicht erreichbar)');
    // an unknown reason is never shown as text
    expect(eventText(ev({ code: 'source_refresh_failed', reason: 'weird_code' }))).not.toContain('weird_code');
  });
  it('is translated', async () => {
    await setLocale('en');
    expect(eventText(ev({ code: 'start_refused_full' }))).toBe('Start refused: all slots are taken');
  });
});

describe('levelWord / inputText / modeText / bitrateText', () => {
  it('the level is a word (with an icon on the page)', () => {
    expect(levelWord('info')).toBe('Info');
    expect(levelWord('warn')).toBe('Warnung');
    expect(levelWord('error')).toBe('Fehler');
  });
  it('input states: läuft / verbinde neu (3) / gestört', () => {
    expect(inputText('ok', 0)).toBe('läuft');
    expect(inputText('reconnecting', 3)).toBe('verbinde neu (3)');
    expect(inputText('reconnecting', 0)).toBe('verbinde neu');
    expect(inputText('failed', 5)).toBe('gestört');
  });
  it('the mode chip and the bitrate', () => {
    expect(modeText('passthrough')).toBe('Direkt');
    expect(modeText('remux')).toBe('Umgepackt');
    expect(modeText('transcode')).toBe('Umgewandelt');
    expect(bitrateText(4_200_000)).toBe('4,2 Mbit/s');
    expect(bitrateText(500_000)).toBe('0,5 Mbit/s');
    expect(bitrateText(null)).toBe('–');
  });
});

describe('matchLine', () => {
  it('"398 von 412 Sendern mit Programm · 14 ohne"', async () => {
    expect(matchLine({ total: 412, matched: 398, unmatched: 14 })).toBe('398 von 412 Sendern mit Programm · 14 ohne');
    expect(matchLine({ total: 3, matched: 3, unmatched: 0 })).toBe('3 von 3 Sendern mit Programm · 0 ohne');
    await setLocale('en');
    expect(matchLine({ total: 412, matched: 398, unmatched: 14 })).toBe('398 of 412 channels with a programme · 14 without');
  });
});
