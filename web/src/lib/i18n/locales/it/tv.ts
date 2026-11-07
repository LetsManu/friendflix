// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/tv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  rail: { label: 'Menu principale', profile: 'Cambia profilo, {name}' },
  tile: { top10: 'Top 10 · n. {n}' },
  /** detail page (spec 3): the button list and the cast line */
  detail: { restart: 'Dall’inizio', episodes: 'Episodi e stagioni', collection: 'Collezione', with: 'Con: {names}', actions: 'Azioni' },
  /** detail sub-screens (spec 3): the Back hint, the seasons column, an empty grid */
  sub: { back: 'Indietro', seasons: 'Stagioni', none: 'Al momento qui non c’è niente.' },
  /** player (spec 4): the pause screen eyebrow, remaining time, the episode line under the title, the seek-preview label */
  player: { watching: 'Stai guardando', remaining: '−{time}', episode: 'S{s} E{e} · {name}', preview: 'Anteprima' },
};
export default dict;
