// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/tv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  rail: { label: 'Menu główne', profile: 'Zmień profil, {name}' },
  tile: { top10: 'Top 10 · #{n}' },
  /** detail page (spec 3): the button list and the cast line */
  detail: { restart: 'Od początku', episodes: 'Odcinki i sezony', collection: 'Kolekcja', with: 'Występują: {names}', actions: 'Akcje' },
  /** detail sub-screens (spec 3): the Back hint, the seasons column, an empty grid */
  sub: { back: 'Wstecz', seasons: 'Sezony', none: 'Na razie nic tu nie ma.' },
  /** player (spec 4): the pause screen eyebrow, remaining time, the episode line under the title, the seek-preview label */
  player: { watching: 'Oglądasz', remaining: '−{time}', episode: 'S{s} O{e} · {name}', preview: 'Podgląd' },
};
export default dict;
