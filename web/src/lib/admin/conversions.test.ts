// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api';
import { hasKey, setLocale, tr } from '#lib/i18n';
import { hwLabel, lastLine, measuredLine, priorityHint, runningSince, slotSegments, startError, type ConversionsView } from './conversions';

const view = (over: Partial<ConversionsView> = {}): ConversionsView => ({
  limit: 3, auto: 3, custom: null, priority: 'films', used: 0, running: [],
  bench: { jellyfin: null, livetv: null, recommended: null, stale: false, noRealtime: false },
  measure: { running: false, busy: null, last: null },
  ...over,
});
const run = (kind: ConversionsView['running'][number]['kind']): ConversionsView['running'][number] => ({ kind, hevc: false, label: 'Dunmoor', since: null, device: null });
const at = (h: number, min: number, dayShift = 0) => new Date(2026, 10, 12 + dayShift, h, min).toISOString();

afterEach(async () => { await setLocale('de'); });

describe('slotSegments', () => {
  it('fills film, live, record, other and leaves the rest free', () => {
    const v = view({ used: 2, running: [run('live'), run('film')] });
    expect(slotSegments(v)).toEqual([{ kind: 'film', over: false }, { kind: 'live', over: false }, { kind: 'free', over: false }]);
    const all = view({ limit: 5, used: 4, running: [run('download'), run('record'), run('live'), run('film')] });
    expect(slotSegments(all).map((s) => s.kind)).toEqual(['film', 'live', 'record', 'other', 'free']);
    expect(slotSegments(view({ limit: 2, used: 2, running: [run('reencode'), run('download')] })).map((s) => s.kind)).toEqual(['other', 'other']);
  });
  it('shows max(limit, used) segments; those beyond the limit are over', () => {
    const v = view({ used: 4, running: [run('film'), run('film'), run('live'), run('record')] });
    const s = slotSegments(v);
    expect(s).toHaveLength(4);
    expect(s.map((x) => x.over)).toEqual([false, false, false, true]);
    expect(s[3]).toEqual({ kind: 'record', over: true });
    expect(slotSegments(view({ limit: 1, used: 0 }))).toEqual([{ kind: 'free', over: false }]);
  });
});

describe('hwLabel', () => {
  it('names the encoders, the processor and an unknown one', async () => {
    expect(hwLabel('qsv')).toBe('Intel QSV');
    expect(hwLabel('vaapi')).toBe('VA-API');
    expect(hwLabel('nvenc')).toBe('NVIDIA NVENC');
    expect(hwLabel('amf')).toBe('AMD AMF');
    expect(hwLabel('videotoolbox')).toBe('VideoToolbox');
    expect(hwLabel('none')).toBe('Prozessor');
    expect(hwLabel('unknown')).toBe('–');
    expect(hwLabel('')).toBe('–');
    await setLocale('en');
    expect(hwLabel('none')).toBe('processor');
  });
});

describe('measuredLine', () => {
  const bench = { jellyfin: { speed: 4.6, hwAccel: 'qsv', at: at(3, 10) }, livetv: { speed: 4.4, encoder: 'h264_qsv', at: at(5, 0) }, recommended: 3, stale: false, noRealtime: false };
  const now = new Date(2026, 10, 12, 9, 0);

  it('German: speed, engine, Live-TV, recommendation, last check today', () => {
    expect(measuredLine(view({ bench }), now)).toBe('Gemessen 4,6× Echtzeit (Jellyfin, Intel QSV) · Live-TV 4,4× · empfohlen 3 · geprüft heute 03:10');
  });
  it('English', async () => {
    await setLocale('en');
    const line = measuredLine(view({ bench }), now);
    expect(line).toMatch(/^Measured 4\.6× real time \(Jellyfin, Intel QSV\) · Live TV 4\.4× · recommended 3 · checked today 0?3:10/);
  });
  it('an older check shows its date, not "today"; a missing live measurement is left out', () => {
    const line = measuredLine(view({ bench: { ...bench, livetv: null } }), new Date(2026, 10, 14, 9, 0));
    expect(line).toMatch(/^Gemessen 4,6× Echtzeit \(Jellyfin, Intel QSV\) · empfohlen 3 · geprüft /);
    expect(line).not.toContain('heute');
    expect(line).not.toContain('Live-TV');
  });
  it('never measured: the default is named; on a server that is not measured the line is empty', () => {
    expect(measuredLine(view({ auto: 2 }), now)).toBe('Noch nicht gemessen · bis dahin 2');
    expect(measuredLine(view({ measure: { running: false, busy: null, last: { outcome: 'unsupported', at: null } } }), now)).toBe('');
  });
  it('the check time is the Jellyfin record\'s even when Live TV was measured later; Live TV stands in without a Jellyfin record', () => {
    expect(measuredLine(view({ bench }), now)).toContain('geprüft heute 03:10');
    expect(measuredLine(view({ bench: { ...bench, jellyfin: null } }), now)).toBe('Live-TV 4,4× · empfohlen 3 · geprüft heute 05:00');
  });
  it('an unparsable time never shows NaN', () => {
    const line = measuredLine(view({ bench: { ...bench, jellyfin: { ...bench.jellyfin, at: 'x' }, livetv: null } }), now);
    expect(line).not.toMatch(/NaN|Invalid/);
  });
});

describe('priorityHint', () => {
  it('has one text per option, the selected option decides', () => {
    expect(priorityHint('films')).toBe('adminConv.priority.hint.films');
    expect(priorityHint('live')).toBe('adminConv.priority.hint.live');
    expect(priorityHint('equal')).toBe('adminConv.priority.hint.equal');
    expect(tr(priorityHint('live'))).toBe('Filme & Serien lassen einen Platz für Live-TV frei (ab 2 Plätzen).');
    expect(tr(priorityHint('equal'))).toBe('Kein Platz wird freigehalten – wer zuerst kommt, bekommt ihn.');
  });
});

describe('runningSince', () => {
  it('is a dash while the backend sends no start time, never NaN', () => {
    const now = new Date(2026, 10, 12, 9, 0);
    expect(runningSince(null, now)).toBe('–');
    expect(runningSince('not a date', now)).toBe('–');
    expect(runningSince(at(9, 5), now)).toBe('–'); // in the future: clock skew
    expect(runningSince(at(8, 15), now)).toBe(tr('adminConv.since', { d: '45 Min.' }));
  });
});

describe('lastLine', () => {
  const now = new Date(2026, 10, 12, 9, 0);
  it('says how the last measurement ended, one text per outcome', () => {
    expect(lastLine(null, now)).toBeNull();
    for (const outcome of ['ok', 'failed', 'no_title', 'busy', 'no_user'] as const) {
      const l = lastLine({ outcome, at: at(3, 10) }, now)!;
      expect(l.tone, outcome).toBe(outcome === 'ok' ? 'ok' : 'warn');
      expect(l.text, outcome).toContain('03:10');
      expect(l.text).not.toMatch(/NaN|undefined|\{/);
    }
    expect(lastLine({ outcome: 'unsupported', at: null }, now)).toEqual({ tone: 'muted', text: 'Messung nur mit Jellyfin' });
    expect(lastLine({ outcome: 'failed', at: null }, now)!.text).not.toMatch(/NaN|undefined|\{/);
  });
});

describe('startError', () => {
  it('gives every refusal of POST /benchmark its own honest message', () => {
    const e = (status: number, body: unknown) => new ApiError(status, body);
    expect(startError(e(409, { error: 'running' }))).toBe('adminConv.err.running');
    expect(startError(e(409, { error: 'busy', reason: 'watching' }))).toBe('adminConv.busyMeasure');
    expect(startError(e(409, { error: 'busy', reason: 'unknown' }))).toBe('adminConv.err.busyUnknown');
    expect(startError(e(409, { error: 'no_user' }))).toBe('adminConv.err.noUser');
    expect(startError(e(409, { error: 'unsupported' }))).toBe('adminConv.err.unsupported');
    expect(startError(e(429, { error: 'rate_limited' }))).toBe('adminConv.err.tooMany');
    expect(startError(e(500, null))).toBeNull();
    expect(startError(new TypeError('offline'))).toBeNull();
  });
});

describe('copy', () => {
  it('every key the card uses exists, and no text names the old products', async () => {
    const keys = ['title', 'used', 'measured', 'recommended', 'remeasure', 'auto', 'custom', 'noRealtime', 'busyMeasure', 'free', 'over', 'stale', 'never', 'measuring', 'cpu',
      'kind.film', 'kind.live', 'kind.record', 'kind.else', 'priority.label', 'priority.films', 'priority.live', 'priority.equal', 'priority.hint.films', 'priority.hint.live', 'priority.hint.equal',
      'last.ok', 'last.failed', 'last.no_title', 'last.busy', 'last.no_user', 'last.unsupported', 'err.running', 'err.busyUnknown', 'err.noUser', 'err.unsupported', 'err.tooMany', 'err.locked'];
    for (const l of ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr']) {
      await setLocale(l);
      for (const k of keys) {
        expect(hasKey(`adminConv.${k}`), k).toBe(true);
        expect(tr(`adminConv.${k}` as never), `${l} ${k}`).not.toMatch(/netflix|seerr/i);
      }
    }
  });
});

describe('help texts say what the budget does', () => {
  it('the held slot is kept for the preferred kind; the limit and the card name downloads too', async () => {
    const want: Record<string, { preferred: RegExp; downloads: RegExp }> = {
      de: { preferred: /für die bevorzugte Seite frei/, downloads: /Downloads/ },
      en: { preferred: /free for the preferred side/, downloads: /downloads/ },
      es: { preferred: /para la parte preferida/, downloads: /descargas/ },
      fr: { preferred: /pour le côté prioritaire/, downloads: /téléchargements/ },
      it: { preferred: /per la parte con la priorità/, downloads: /download/ },
      pl: { preferred: /dla strony z pierwszeństwem/, downloads: /pobrania/ },
      tr: { preferred: /öncelikli taraf için/, downloads: /indirmeler/ },
    };
    for (const [l, w] of Object.entries(want)) {
      await setLocale(l);
      expect(tr('settings.keys.CONVERSION_PRIORITY.help' as never), l).toMatch(w.preferred);
      expect(tr('settings.keys.CONVERSION_PRIORITY.help' as never), l).not.toMatch(/other side|andere Seite/);
      expect(tr('settings.keys.CONVERSION_SLOTS.help' as never), l).toMatch(w.downloads);
      expect(tr('adminConv.intro' as never), l).toMatch(w.downloads);
    }
  });
});
