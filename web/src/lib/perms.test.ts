// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { ALL_PERMS, deniedKeys, perms, permsFrom } from './perms';

describe('permsFrom', () => {
  it('missing perms = everything allowed', () => {
    expect(permsFrom(undefined)).toEqual(ALL_PERMS);
    expect(permsFrom(null)).toEqual(ALL_PERMS);
    expect(Object.values(permsFrom('x')).every(Boolean)).toBe(true);
  });
  it('only an explicit false turns a switch off', () => {
    const p = permsFrom({ cast: false });
    expect(p.cast).toBe(false);
    expect(Object.entries(p).filter(([, v]) => !v).map(([k]) => k)).toEqual(['cast']);
    expect(permsFrom({ cast: 'no', party: 0 }).cast).toBe(true);
    expect(permsFrom({ cast: 'no', party: 0 }).party).toBe(true);
  });
  it('the store starts all allowed; deniedKeys lists the off ones', () => {
    expect(get(perms)).toEqual(ALL_PERMS);
    expect(deniedKeys(permsFrom({ party: false, comments: false }))).toEqual(['party', 'comments']);
  });
});
