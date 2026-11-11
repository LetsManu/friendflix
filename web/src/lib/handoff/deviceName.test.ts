// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tr } from '#lib/i18n';
import { castLabel, cleanName, deviceName } from './deviceName';

// the same file the backend test reads
const vectors = JSON.parse(readFileSync(new URL('../../../../test-vectors/device-names.json', import.meta.url), 'utf8')) as { input: string; ok: boolean; normalized?: string | null }[];

describe('deviceName', () => {
  it('custom name wins', () => {
    expect(deviceName({ kind: 'webos', name: 'Wohnzimmer', label: 'Fernseher (TV-Modus)' }, tr)).toBe('Wohnzimmer');
  });
  it('kind names', () => {
    const n = (kind: 'tizen' | 'webos' | 'firetv' | 'desktop' | 'android') => deviceName({ kind, name: null, label: 'x' }, tr);
    expect([n('tizen'), n('webos'), n('firetv'), n('desktop'), n('android')]).toEqual(['Samsung-Fernseher', 'LG-Fernseher', 'Fire TV', 'Windows-App', 'Android-App']);
  });
  it('web and unknown kinds use the label', () => {
    expect(deviceName({ kind: 'web', name: null, label: 'Safari auf iPhone' }, tr)).toBe('Safari auf iPhone');
    expect(deviceName({ kind: null, label: 'Chrome auf Linux' }, tr)).toBe('Chrome auf Linux');
    expect(deviceName({ kind: null, name: null, label: null }, tr)).toBe('unbekannt');
    expect(deviceName({}, tr)).toBe('unbekannt');
  });
});

describe('castLabel', () => {
  it('names the sender', () => {
    expect(castLabel('airplay', 'Safari auf iPhone', tr)).toBe('AirPlay (Safari auf iPhone)');
    expect(castLabel('chromecast', 'Annas iPhone', tr)).toBe('Chromecast (Annas iPhone)');
  });
});

describe('cleanName', () => {
  it('mirrors the server (shared vectors)', () => {
    expect(vectors.length).toBeGreaterThan(30);
    for (const v of vectors) {
      const r = cleanName(v.input);
      expect(r.ok, JSON.stringify(v.input)).toBe(v.ok);
      if (v.ok && r.ok) expect(r.name, JSON.stringify(v.input)).toBe(v.normalized ?? null);
    }
  });
});
