// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/adminLive';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  ch: {
    orderPicked: '{name} levantado, posición {n} de {m}',
    orderMoved: 'Posición {n} de {m}',
    orderDropped: '{name} soltado en la posición {n}',
    orderCancelled: 'Movimiento cancelado',
  },
};
export default dict;
