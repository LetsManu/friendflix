// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/desk';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  row: {
    prev: 'Poprzednia strona',
    next: 'Następna strona',
    pages: 'Strony rzędu',
    page: 'Strona {n}',
  },
  detail: {
    back: 'Wstecz',
    extras: 'Zwiastuny i dodatki',
    continueEp: 'Kontynuuj S{s}·O{e}',
  },
};
export default dict;
