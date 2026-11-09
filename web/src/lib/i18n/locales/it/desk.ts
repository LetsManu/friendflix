// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/desk';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  row: {
    prev: 'Pagina precedente',
    next: 'Pagina successiva',
    pages: 'Pagine della riga',
    page: 'Pagina {n}',
  },
  bar: {
    close: 'Chiudi ricerca',
  },
  search: {
    top: 'Risultati migliori',
    all: 'Tutti i risultati',
    sheet: 'Risultati della ricerca',
  },
  detail: {
    back: 'Indietro',
    extras: 'Trailer ed extra',
    continueEp: 'Continua S{s}·E{e}',
  },
};
export default dict;
