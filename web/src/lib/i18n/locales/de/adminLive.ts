// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Admin → Live-TV (live TV spec §9, §20). */
export default {
  ch: {
    /** Kanäle → Reihenfolge: the polite announcements of the keyboard and drag order (spec §9.2) */
    orderPicked: '{name} aufgenommen, Position {n} von {m}',
    orderMoved: 'Position {n} von {m}',
    orderDropped: '{name} abgelegt auf Position {n}',
    orderCancelled: 'Verschieben abgebrochen',
  },
} as const;
