// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/desk';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  row: {
    prev: 'Previous page',
    next: 'Next page',
    pages: 'Row pages',
    page: 'Page {n}',
  },
};
export default dict;
