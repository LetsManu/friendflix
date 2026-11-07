// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/tv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  rail: { label: 'Menu principale', profile: 'Cambia profilo, {name}' },
  tile: { top10: 'Top 10 · n. {n}' },
  /** detail page (spec 3): the button list and the cast line */
  detail: { restart: 'Dall’inizio', episodes: 'Episodi e stagioni', collection: 'Collezione', with: 'Con: {names}', actions: 'Azioni' },
};
export default dict;
