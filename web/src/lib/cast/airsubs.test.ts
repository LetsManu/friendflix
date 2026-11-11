// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { airSubBody, forgetSubsRefused, rememberSubsRefused, SUBS_REFUSED_KEY, SUBS_REFUSED_MS, subsRefusedRecently } from './airsubs';

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
};

describe('AirPlay subtitle refusal memory', () => {
  it('counts for 30 days, then expires', () => {
    const s = mem();
    expect(subsRefusedRecently(s, 1000)).toBe(false);
    rememberSubsRefused(s, 1000);
    expect(s.m.get(SUBS_REFUSED_KEY)).toBe('1000');
    expect(subsRefusedRecently(s, 1000 + SUBS_REFUSED_MS - 1)).toBe(true);
    expect(subsRefusedRecently(s, 1000 + SUBS_REFUSED_MS)).toBe(false);
  });
  it('picking again forgets it', () => {
    const s = mem({ [SUBS_REFUSED_KEY]: '5' });
    forgetSubsRefused(s);
    expect(subsRefusedRecently(s, 6)).toBe(false);
  });
  it('malformed, future-dated or blocked storage is no refusal', () => {
    expect(subsRefusedRecently(mem({ [SUBS_REFUSED_KEY]: 'x' }), 10)).toBe(false);
    expect(subsRefusedRecently(mem({ [SUBS_REFUSED_KEY]: '99' }), 10)).toBe(false);
    expect(subsRefusedRecently(null, 10)).toBe(false);
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(subsRefusedRecently(bad, 10)).toBe(false);
    expect(() => { rememberSubsRefused(bad, 1); forgetSubsRefused(bad); }).not.toThrow();
  });
});

describe('airSubBody (the token request of the Player and of the engine)', () => {
  const ok = mem();
  it('carries the chosen text track', () => {
    expect(airSubBody(3, false, ok, 1000, true)).toEqual({ subtitleIndex: 3 });
  });
  it('leaves the key out: off, noSubs (the fallback), no capability, fresh refusal', () => {
    expect(airSubBody(-1, false, ok, 1000, true)).toEqual({});
    expect(airSubBody(3, true, ok, 1000, true)).toEqual({});
    expect(airSubBody(3, false, ok, 1000, false)).toEqual({});
    expect(airSubBody(3, false, mem({ [SUBS_REFUSED_KEY]: '900' }), 1000, true)).toEqual({});
    expect(airSubBody(3, false, mem({ [SUBS_REFUSED_KEY]: String(1000 - SUBS_REFUSED_MS - 1) }), 1000, true)).toEqual({ subtitleIndex: 3 });
  });
});
