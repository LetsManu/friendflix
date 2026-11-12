// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/adminLive';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  ch: {
    orderPicked: '{name} saisi, position {n} sur {m}',
    orderMoved: 'Position {n} sur {m}',
    orderDropped: '{name} déposé en position {n}',
    orderCancelled: 'Déplacement annulé',
  },
};
export default dict;
