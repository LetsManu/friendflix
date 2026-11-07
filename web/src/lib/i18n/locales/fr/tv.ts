// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/tv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  rail: { label: 'Menu principal', profile: 'Changer de profil, {name}', account: 'Compte' },
  tile: { top10: 'Top 10 · n° {n}' },
  /** detail page (spec 3): the button list and the cast line */
  detail: { restart: 'Depuis le début', episodes: 'Épisodes et saisons', collection: 'Collection', with: 'Avec : {names}', actions: 'Actions' },
  /** detail sub-screens (spec 3): the Back hint, the seasons column, an empty grid */
  sub: { back: 'Retour', seasons: 'Saisons', none: 'Rien ici pour le moment.' },
  /** player (spec 4): the pause screen eyebrow, remaining time, the episode line under the title */
  player: { watching: 'Vous regardez', remaining: '−{time}', episode: 'S{s} E{e} · {name}' },
};
export default dict;
