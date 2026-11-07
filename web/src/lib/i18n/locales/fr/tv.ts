// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/tv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  rail: { label: 'Menu principal', profile: 'Changer de profil, {name}' },
  tile: { top10: 'Top 10 · n° {n}' },
  /** detail page (spec 3): the button list and the cast line */
  detail: { restart: 'Depuis le début', episodes: 'Épisodes et saisons', collection: 'Collection', with: 'Avec : {names}', actions: 'Actions' },
  /** detail sub-screens (spec 3): the Back hint, the seasons column, an empty grid */
  sub: { back: 'Retour', seasons: 'Saisons', none: 'Rien ici pour le moment.' },
};
export default dict;
