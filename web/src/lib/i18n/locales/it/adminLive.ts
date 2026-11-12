// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/adminLive';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  ch: {
    orderPicked: '{name} preso, posizione {n} di {m}',
    orderMoved: 'Posizione {n} di {m}',
    orderDropped: '{name} rilasciato in posizione {n}',
    orderCancelled: 'Spostamento annullato',
  },
};
export default dict;
