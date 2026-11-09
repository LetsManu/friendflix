// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/desk';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  row: {
    prev: 'Page précédente',
    next: 'Page suivante',
    pages: 'Pages de la rangée',
    page: 'Page {n}',
  },
  bar: {
    close: 'Fermer la recherche',
  },
  search: {
    top: 'Meilleurs résultats',
    all: 'Tous les résultats',
    sheet: 'Résultats de recherche',
  },
  detail: {
    back: 'Retour',
    extras: 'Bandes-annonces et bonus',
    continueEp: 'Reprendre S{s}·É{e}',
  },
};
export default dict;
