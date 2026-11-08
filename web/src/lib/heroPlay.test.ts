// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { heroPlayHref, heroPlaysNative, listIdOf } from './heroPlay';

describe('hero play rules', () => {
  it('play target: explicit href wins, series go to their page, the rest to the player', () => {
    expect(heroPlayHref({ id: 'a', type: 'Movie' })).toBe('/watch/a');
    expect(heroPlayHref({ id: 's', type: 'Series' })).toBe('/item/s');
    expect(heroPlayHref({ id: 'a', type: 'Movie' }, '/watch/a?t=5')).toBe('/watch/a?t=5');
  });

  it('native playback only for playable titles that go to the player', () => {
    expect(heroPlaysNative({ id: 'a', type: 'Movie' }, '', true)).toBe(true);
    expect(heroPlaysNative({ id: 'a', type: 'Movie' }, '', false)).toBe(false);
    expect(heroPlaysNative({ id: 's', type: 'Series' }, '', true)).toBe(false);
    expect(heroPlaysNative({ id: 'b', type: 'BoxSet' }, '', true)).toBe(false);
    expect(heroPlaysNative({ id: 'a', type: 'Movie' }, '/watch/a?t=5', true)).toBe(true);
    expect(heroPlaysNative({ id: 'a', type: 'Movie' }, '/item/a', true)).toBe(false);
  });

  it('My list keeps episodes as their series', () => {
    expect(listIdOf({ id: 'e', seriesId: 's' })).toBe('s');
    expect(listIdOf({ id: 'm' })).toBe('m');
  });
});
