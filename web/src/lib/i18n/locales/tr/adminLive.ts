// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/adminLive';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  ch: {
    orderPicked: '{name} alındı, konum {n}/{m}',
    orderMoved: 'Konum {n}/{m}',
    orderDropped: '{name} {n}. konuma bırakıldı',
    orderCancelled: 'Taşıma iptal edildi',
  },
};
export default dict;
