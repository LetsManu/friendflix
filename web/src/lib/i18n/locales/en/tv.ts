// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/tv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  rail: { label: 'Main menu', profile: 'Switch profile, {name}' },
  tile: { top10: 'Top 10 · #{n}' },
  /** detail page (spec 3): the button list and the cast line */
  detail: { restart: 'Start over', episodes: 'Episodes & seasons', collection: 'Collection', with: 'With: {names}', actions: 'Actions' },
  /** detail sub-screens (spec 3): the Back hint, the seasons column, an empty grid */
  sub: { back: 'Back', seasons: 'Seasons', none: 'Nothing here right now.' },
};
export default dict;
