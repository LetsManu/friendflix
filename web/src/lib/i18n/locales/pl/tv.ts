// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/tv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  rail: { label: 'Menu główne', profile: 'Zmień profil, {name}' },
  tile: { top10: 'Top 10 · #{n}' },
  /** detail page (spec 3): the button list and the cast line */
  detail: { restart: 'Od początku', episodes: 'Odcinki i sezony', collection: 'Kolekcja', with: 'Występują: {names}', actions: 'Akcje' },
};
export default dict;
