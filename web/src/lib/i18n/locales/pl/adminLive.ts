// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/adminLive';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  ch: {
    orderPicked: '{name} podniesiony, pozycja {n} z {m}',
    orderMoved: 'Pozycja {n} z {m}',
    orderDropped: '{name} upuszczony na pozycji {n}',
    orderCancelled: 'Przenoszenie anulowane',
  },
};
export default dict;
