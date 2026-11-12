// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/adminLive';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  ch: {
    orderPicked: '{name} picked up, position {n} of {m}',
    orderMoved: 'Position {n} of {m}',
    orderDropped: '{name} dropped at position {n}',
    orderCancelled: 'Move cancelled',
  },
};
export default dict;
