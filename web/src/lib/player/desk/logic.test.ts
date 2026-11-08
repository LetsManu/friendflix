// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CHIP_MS, DESK_PAUSE_MS, creditsBeat, deskPauseDue, deskPlayer } from './logic';

describe('deskPlayer', () => {
  it('only desktop, never TV or phone', () => {
    expect(deskPlayer({ desk: true, tv: false, phone: false })).toBe(true);
    expect(deskPlayer({ desk: true, tv: true, phone: false })).toBe(false);
    expect(deskPlayer({ desk: true, tv: false, phone: true })).toBe(false);
    expect(deskPlayer({ desk: false, tv: false, phone: false })).toBe(false);
  });
});

describe('deskPauseDue', () => {
  const base = { pausedAt: 1000, lastActive: 0, blocked: false };
  it('after 5 s since pause or the last activity, whichever is later', () => {
    expect(DESK_PAUSE_MS).toBe(5000);
    expect(deskPauseDue({ ...base, now: 5999 })).toBe(false);
    expect(deskPauseDue({ ...base, now: 6000 })).toBe(true);
    expect(deskPauseDue({ ...base, lastActive: 4000, now: 8999 })).toBe(false);
    expect(deskPauseDue({ ...base, lastActive: 4000, now: 9000 })).toBe(true);
  });
  it('never while blocked (menu, scrubbing, party, casting, error)', () => {
    expect(deskPauseDue({ ...base, now: 60_000, blocked: true })).toBe(false);
  });
});

describe('creditsBeat', () => {
  const base = { current: 100, start: 90, enteredAt: 1000, now: 1000, dismissed: false, kind: 'episode' as const, blocked: false };
  it('chip for the first 2 s after the credits start, then corner', () => {
    expect(CHIP_MS).toBe(2000);
    expect(creditsBeat(base)).toBe('chip');
    expect(creditsBeat({ ...base, now: 2999 })).toBe('chip');
    expect(creditsBeat({ ...base, now: 3000 })).toBe('corner');
    expect(creditsBeat({ ...base, enteredAt: null })).toBe('chip');
  });
  it('off before the credits, after Watch credits, without a next kind, while blocked, with an unknown start', () => {
    expect(creditsBeat({ ...base, current: 89 })).toBe('off');
    expect(creditsBeat({ ...base, dismissed: true })).toBe('off');
    expect(creditsBeat({ ...base, kind: 'none' })).toBe('off');
    expect(creditsBeat({ ...base, blocked: true })).toBe('off');
    expect(creditsBeat({ ...base, start: Infinity })).toBe('off');
  });
  it('a film reaches the corner too (suggestions instead of a countdown)', () => {
    expect(creditsBeat({ ...base, kind: 'movie', now: 4000 })).toBe('corner');
  });
});
