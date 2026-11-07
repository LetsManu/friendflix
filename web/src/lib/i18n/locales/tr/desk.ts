// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/desk';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  row: {
    prev: 'Önceki sayfa',
    next: 'Sonraki sayfa',
    pages: 'Satır sayfaları',
    page: 'Sayfa {n}',
  },
};
export default dict;
