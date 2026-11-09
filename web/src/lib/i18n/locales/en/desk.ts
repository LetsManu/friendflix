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
  bar: {
    close: 'Close search',
  },
  search: {
    top: 'Top results',
    all: 'All results',
    sheet: 'Search results',
  },
  detail: {
    back: 'Back',
    extras: 'Trailers & extras',
    continueEp: 'Continue S{s}·E{e}',
  },
};
export default dict;
