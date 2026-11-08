// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { detailTabs } from './tabs';

describe('detailTabs', () => {
  it('always has details', () => {
    expect(detailTabs({ series: false, similar: 0, extras: 0 })).toEqual(['details']);
  });
  it('lists every tab in order', () => {
    expect(detailTabs({ series: true, similar: 3, extras: 1 })).toEqual(['episodes', 'more', 'extras', 'details']);
  });
  it('skips episodes for movies, more without similar, extras without extras', () => {
    expect(detailTabs({ series: false, similar: 2, extras: 0 })).toEqual(['more', 'details']);
    expect(detailTabs({ series: false, similar: 0, extras: 2 })).toEqual(['extras', 'details']);
    expect(detailTabs({ series: true, similar: 0, extras: 0 })).toEqual(['episodes', 'details']);
  });
});
