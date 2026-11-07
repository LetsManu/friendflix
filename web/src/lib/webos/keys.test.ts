// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { lgKeyName, normaliseLgKey } from './keys';

describe('lgKeyName', () => {
  it('maps the LG remote key codes', () => {
    const table: Array<[number, string]> = [
      [415, 'MediaPlay'], [19, 'MediaPause'], [10252, 'MediaPlayPause'], [413, 'MediaStop'],
      [417, 'MediaFastForward'], [412, 'MediaRewind'], [403, 'ColorF0Red'], [404, 'ColorF1Green'], [406, 'ColorF3Blue'],
    ];
    for (const [code, name] of table) expect(lgKeyName(code)).toBe(name);
  });
  it('returns null for anything else', () => { expect(lgKeyName(13)).toBeNull(); });
});

describe('normaliseLgKey', () => {
  it('keyCode only, key Unidentified', () => { expect(normaliseLgKey({ key: 'Unidentified', keyCode: 415 })).toBe('MediaPlay'); });
  it('keeps e.key for unmapped codes', () => { expect(normaliseLgKey({ key: 'Enter', keyCode: 13 })).toBe('Enter'); });
});
