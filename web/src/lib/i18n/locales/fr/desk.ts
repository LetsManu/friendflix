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
};
export default dict;
