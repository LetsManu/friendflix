// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { LiveChannel } from './api';
import { commitNumber, NUMBER_MAX_DIGITS, NUMBER_TIMEOUT_MS, typeDigit, type NumberState } from './numberEntry';

const ch = (id: string, number: number, groupPos = 0): LiveChannel =>
  ({ id, number, name: id, logo: null, groupId: 'g', running: false, epg: 'none', favourite: false, groupPos });
const list = [ch('nordlicht', 1), ch('hafen', 2), ch('kinder', 5), ch('berg12', 12), ch('dupB', 7, 2), ch('dupA', 7, 1), ch('lang', 12345)];
const start: NumberState = { digits: '', match: null, unique: false, zero: false };
const type = (...ds: number[]) => ds.reduce((s, d) => typeDigit(s, d, list), start);

describe('number entry', () => {
  it('constants', () => { expect(NUMBER_TIMEOUT_MS).toBe(2000); expect(NUMBER_MAX_DIGITS).toBe(5); });
  it('"1" matches channel 1 at once, "1","2" matches 12', () => {
    expect(type(1)).toMatchObject({ digits: '1', unique: true, zero: false, match: { id: 'nordlicht' } });
    expect(type(1, 2)).toMatchObject({ digits: '12', unique: true, match: { id: 'berg12' } });
  });
  it('no channel: no match', () => { expect(type(9, 9)).toMatchObject({ digits: '99', match: null, unique: false }); });
  it('a duplicate number matches the lowest group position and is not unique', () => {
    expect(type(7)).toMatchObject({ match: { id: 'dupA' }, unique: false });
  });
  it('a lone 0 is flagged zero; a second digit clears it', () => {
    expect(type(0)).toMatchObject({ digits: '0', zero: true, match: null });
    expect(type(0, 5)).toMatchObject({ digits: '05', zero: false, match: { id: 'kinder' } });
  });
  it('a sixth digit is ignored', () => {
    const s = type(1, 2, 3, 4, 5);
    expect(s.digits).toBe('12345');
    expect(s.match?.id).toBe('lang');
    expect(typeDigit(s, 6, list)).toEqual(s);
  });
  it('commit: a channel', () => { expect(commitNumber(type(1, 2), list)).toEqual({ kind: 'channel', channel: list[3] }); });
  it('commit: "0" 5 is channel 5, leading zeros ignored', () => { expect(commitNumber(type(0, 5), list)).toEqual({ kind: 'channel', channel: list[2] }); });
  it('commit: a lone 0 is last', () => { expect(commitNumber(type(0), list)).toEqual({ kind: 'last' }); });
  it('commit: no channel says so (German source text)', () => {
    expect(commitNumber(type(1, 3), list)).toEqual({ kind: 'none', text: 'Kein Sender 13' });
    expect(commitNumber(type(0, 0), list)).toEqual({ kind: 'none', text: 'Kein Sender 0' });
    // never grouped by the locale (bughunt M3): "1001", not "1.001"
    expect(commitNumber(type(1, 0, 0, 1), list)).toEqual({ kind: 'none', text: 'Kein Sender 1001' });
  });
  it('a channel without a number (an own feed) never matches typed digits', () => {
    const own = [...list, { ...ch('eigen', 0), number: null }];
    expect(typeDigit(start, 0, own)).toMatchObject({ zero: true, match: null });
  });
  it('commit: a duplicate goes to the lowest group position', () => {
    expect(commitNumber(type(7), list)).toMatchObject({ kind: 'channel', channel: { id: 'dupA' } });
  });
  it('commit with nothing typed is none with an empty text', () => { expect(commitNumber(start, list)).toEqual({ kind: 'none', text: '' }); });
});
