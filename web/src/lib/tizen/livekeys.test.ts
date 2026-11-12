// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { normaliseTizenKey, registerLiveKeys, TIZEN_LIVE_KEYS, TIZEN_OPTIONAL_KEYS } from './livekeys';
import type { TizenLike } from './probe';

const CODES: Record<string, number> = {
  ChannelUp: 427, ChannelDown: 428, PreviousChannel: 10190, Info: 457, ColorF0Red: 403, ColorF3Blue: 406, ChannelList: 10073, Guide: 458,
  '0': 48, '1': 49, '2': 50, '3': 51, '4': 52, '5': 53, '6': 54, '7': 55, '8': 56, '9': 57,
};
function mk(o: { supported?: string[] | 'throws' | 'missing'; failOn?: string[]; codes?: Record<string, number> } = {}) {
  const registered: string[] = [];
  const codes = { ...CODES, ...(o.codes ?? {}) };
  const tvinputdevice: NonNullable<TizenLike['tvinputdevice']> = {
    registerKey: vi.fn((n: string) => { if (o.failOn?.includes(n)) throw new Error('no ' + n); registered.push(n); }),
    getKey: (n: string) => ({ code: codes[n] ?? 0 }),
  };
  if (o.supported === 'throws') tvinputdevice.getSupportedKeys = () => { throw new Error('x'); };
  else if (o.supported !== 'missing') {
    const list: string[] = o.supported ?? Object.keys(CODES);
    tvinputdevice.getSupportedKeys = () => list.map((name) => ({ name, code: codes[name] ?? 0 }));
  }
  return { tz: { tvinputdevice } as TizenLike, registered };
}
const FALLBACK = { 427: 'ChannelUp', 428: 'ChannelDown', 10190: 'PreviousChannel', 457: 'Info', 403: 'ColorF0Red', 406: 'ColorF3Blue', 10073: 'ChannelList', 458: 'Guide' };

describe('registerLiveKeys', () => {
  it('registers every key and maps codes from getKey', () => {
    const { tz, registered } = mk({ codes: { ChannelUp: 5001 } });
    const map = registerLiveKeys(tz);
    expect(registered).toEqual([...TIZEN_LIVE_KEYS, ...TIZEN_OPTIONAL_KEYS]);
    expect(map[5001]).toBe('ChannelUp'); // the code the TV reports, not the constant
    expect(map[427]).toBeUndefined();
    expect(map[10190]).toBe('PreviousChannel');
    expect(map[403]).toBe('ColorF0Red');
    expect(map[406]).toBe('ColorF3Blue');
    expect(map[457]).toBe('Info');
  });
  it('a throwing registerKey leaves the others registered', () => {
    const { tz, registered } = mk({ failOn: ['ChannelDown', '3'] });
    const map = registerLiveKeys(tz);
    expect(registered).toContain('ChannelUp');
    expect(registered).toContain('Info');
    expect(registered).toContain('ColorF3Blue');
    expect(registered).not.toContain('ChannelDown');
    expect(registered).not.toContain('3');
    expect(map[428]).toBeUndefined();
    expect(map[427]).toBe('ChannelUp');
  });
  it('no tizen object: the fallback map, nothing thrown', () => {
    expect(registerLiveKeys(undefined)).toEqual(FALLBACK);
    expect(registerLiveKeys({})).toEqual(FALLBACK);
  });
  it('ChannelList and Guide are registered only when supported', () => {
    const none = mk({ supported: ['ChannelUp', 'Info'] });
    const m1 = registerLiveKeys(none.tz);
    expect(none.registered).not.toContain('ChannelList');
    expect(none.registered).not.toContain('Guide');
    expect(m1[10073]).toBeUndefined();
    expect(normaliseTizenKey({ key: 'Unidentified', keyCode: 10073 }, m1)).toBe('Unidentified');
    const both = mk();
    const m2 = registerLiveKeys(both.tz);
    expect(both.registered).toContain('ChannelList');
    expect(both.registered).toContain('Guide');
    expect(normaliseTizenKey({ key: 'Unidentified', keyCode: 10073 }, m2)).toBe('ChannelList');
    expect(normaliseTizenKey({ key: 'Unidentified', keyCode: 458 }, m2)).toBe('Guide');
  });
  it('a throwing or missing getSupportedKeys skips the optional keys, nothing thrown', () => {
    for (const supported of ['throws', 'missing'] as const) {
      const { tz, registered } = mk({ supported });
      expect(() => registerLiveKeys(tz)).not.toThrow();
      expect(registered).not.toContain('ChannelList');
      expect(registered).not.toContain('Guide');
      expect(registered).toContain('ChannelUp');
    }
  });
  it('a getKey that throws or gives no code falls back to the constant for that key', () => {
    const tz: TizenLike = { tvinputdevice: { registerKey: () => undefined, getKey: () => { throw new Error('x'); } } };
    const map = registerLiveKeys(tz);
    expect(map[427]).toBe('ChannelUp');
    expect(map[457]).toBe('Info');
  });
});

describe('normaliseTizenKey', () => {
  const map = FALLBACK as Record<number, string>;
  it('Unidentified 427 is ChannelUp', () => { expect(normaliseTizenKey({ key: 'Unidentified', keyCode: 427 }, map)).toBe('ChannelUp'); });
  it('a real e.key is never overridden', () => {
    expect(normaliseTizenKey({ key: 'Enter', keyCode: 13 }, map)).toBe('Enter');
    expect(normaliseTizenKey({ key: '4', keyCode: 427 }, map)).toBe('4');
  });
  it('an unknown code keeps the key', () => { expect(normaliseTizenKey({ key: 'Unidentified', keyCode: 9999 }, map)).toBe('Unidentified'); });
});
