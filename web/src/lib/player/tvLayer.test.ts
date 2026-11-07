// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { PAUSE_SCREEN_MS, pauseScreenDue, playerBack, tvPlayerButtons } from './tvLayer';

describe('playerBack: open menu -> seek preview -> controls -> leave', () => {
  it.each([
    ['overlay', 'controls', false],
    ['seek', 'controls', false],
    ['controls', 'none', false],
    ['none', 'none', true],
  ] as const)('%s -> %s (leave %s)', (from, next, leave) => {
    expect(playerBack(from)).toEqual({ next, leave });
  });
});

describe('pauseScreenDue', () => {
  it('after 8 s paused without a key', () => {
    expect(PAUSE_SCREEN_MS).toBe(8000);
    expect(pauseScreenDue(0, 0, 7999, false)).toBe(false);
    expect(pauseScreenDue(0, 0, 8000, false)).toBe(true);
  });
  it('a key restarts the wait', () => {
    expect(pauseScreenDue(0, 5000, 8000, false)).toBe(false);
    expect(pauseScreenDue(0, 5000, 13000, false)).toBe(true);
  });
  it('calm mode: never', () => {
    expect(pauseScreenDue(0, 0, 8000, true)).toBe(false);
    expect(pauseScreenDue(0, 0, 1e9, true)).toBe(false);
  });
});

describe('tvPlayerButtons', () => {
  it('an episode with a next one: all five in order', () => {
    expect(tvPlayerButtons({ isEpisode: true, hasNext: true })).toEqual(['episodes', 'next', 'tracks', 'speed', 'quality']);
  });
  it('the last episode: no next', () => {
    expect(tvPlayerButtons({ isEpisode: true, hasNext: false })).toEqual(['episodes', 'tracks', 'speed', 'quality']);
  });
  it('a film', () => {
    expect(tvPlayerButtons({ isEpisode: false, hasNext: false })).toEqual(['tracks', 'speed', 'quality']);
  });
});
