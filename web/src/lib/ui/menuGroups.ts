// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The groups of a menu's rows (menus glass spec, one anatomy): the ordinary rows first, then, after a divider, the tail: rows
 * that remove something (`tail`, white) and the destructive ones (`danger`, always last). Order is otherwise kept; empty groups
 * are dropped, so a menu has one or two groups.
 */
export function menuGroups<T extends { danger?: boolean; tail?: boolean }>(items: readonly T[]): T[][] {
  const head = items.filter((i) => !i.tail && !i.danger);
  const tail = [...items.filter((i) => i.tail && !i.danger), ...items.filter((i) => i.danger)];
  return [head, tail].filter((g) => g.length > 0);
}
