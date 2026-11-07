// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** TV detail page (spec section 3): which buttons the vertical list shows for a title, in their fixed order. */

export type TvButtonId = 'play' | 'restart' | 'episodes' | 'trailer' | 'more' | 'mylist' | 'rate' | 'langs' | 'collection' | 'extras' | 'story' | 'info';

export type TvButtonInput = {
  type: 'Movie' | 'Series' | 'Episode' | string;
  /** the title (a series: its next episode) was started and not finished */
  hasProgress: boolean;
  hasTrailer: boolean;
  /** something to play (a series without an episode has none) */
  hasPlayTarget: boolean;
  hasCollection: boolean;
  hasExtras: boolean;
  hasStory: boolean;
};

/**
 * Play / Resume, Restart (with progress), Episodes (series), Trailer, More like this, My List, Rate, Audio & subtitles,
 * Collection / Extras / Story so far (when present), More info. Without a play target there is nothing to play, restart
 * or pick languages for.
 */
export function tvDetailButtons(i: TvButtonInput): TvButtonId[] {
  const out: TvButtonId[] = [];
  const add = (on: boolean, id: TvButtonId) => { if (on) out.push(id); };
  add(i.hasPlayTarget, 'play');
  add(i.hasPlayTarget && i.hasProgress, 'restart');
  add(i.type === 'Series', 'episodes');
  add(i.hasTrailer, 'trailer');
  add(true, 'more');
  add(true, 'mylist');
  add(true, 'rate');
  add(i.hasPlayTarget, 'langs');
  add(i.hasCollection, 'collection');
  add(i.hasExtras, 'extras');
  add(i.hasStory, 'story');
  add(true, 'info');
  return out;
}
