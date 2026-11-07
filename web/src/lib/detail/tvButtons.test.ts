// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { tvDetailButtons } from './tvButtons';

const none = { hasProgress: false, hasTrailer: false, hasPlayTarget: true, hasCollection: false, hasExtras: false, hasStory: false };

describe('tvDetailButtons', () => {
  it('bare movie with a play target: play, more, my list, rate, languages, info', () => {
    expect(tvDetailButtons({ type: 'Movie', ...none })).toEqual(['play', 'more', 'mylist', 'rate', 'langs', 'info']);
  });

  it('movie with progress, trailer, collection and extras: everything in the spec order', () => {
    expect(tvDetailButtons({ type: 'Movie', ...none, hasProgress: true, hasTrailer: true, hasCollection: true, hasExtras: true }))
      .toEqual(['play', 'restart', 'trailer', 'more', 'mylist', 'rate', 'langs', 'collection', 'extras', 'info']);
  });

  it('series with progress and a story so far: episodes after restart, story before info', () => {
    expect(tvDetailButtons({ type: 'Series', ...none, hasProgress: true, hasStory: true }))
      .toEqual(['play', 'restart', 'episodes', 'more', 'mylist', 'rate', 'langs', 'story', 'info']);
  });

  it('no play target: no play, restart or languages (even with progress)', () => {
    const l = tvDetailButtons({ type: 'Series', ...none, hasPlayTarget: false, hasProgress: true });
    expect(l).not.toContain('play');
    expect(l).not.toContain('restart');
    expect(l).not.toContain('langs');
    expect(l).toEqual(['episodes', 'more', 'mylist', 'rate', 'info']);
  });

  it('episodes only for a series; a collection only counts for what has one', () => {
    expect(tvDetailButtons({ type: 'Episode', ...none })).not.toContain('episodes');
    expect(tvDetailButtons({ type: 'Movie', ...none, hasStory: true })).toContain('story');
  });
});
