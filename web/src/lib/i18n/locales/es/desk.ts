// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/desk';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  row: {
    prev: 'Página anterior',
    next: 'Página siguiente',
    pages: 'Páginas de la fila',
    page: 'Página {n}',
  },
  bar: {
    close: 'Cerrar búsqueda',
  },
  detail: {
    back: 'Atrás',
    extras: 'Tráileres y extras',
    continueEp: 'Continuar T{s}·E{e}',
  },
};
export default dict;
