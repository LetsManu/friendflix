// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The keyboard model of the role matrix (`role="grid"`, WAI-ARIA data grid, spec §8): arrows move one cell and stop at the
 * edges, Home / End go to the row's first / last cell, Ctrl+Home / Ctrl+End to the grid's first / last cell.
 */

export interface CellPos { r: number; c: number }

/** the key as moveCell names it: "Ctrl+" in front while Ctrl (or Cmd) is held */
export const gridKey = (e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey'>): string => (e.ctrlKey || e.metaKey ? `Ctrl+${e.key}` : e.key);

/** the cell after `key` in a rows × cols grid, or null when the key does not move the grid's focus (or the grid is empty) */
export function moveCell(pos: CellPos, key: string, rows: number, cols: number): CellPos | null {
  if (rows <= 0 || cols <= 0) return null;
  const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, v));
  const r = clamp(pos.r, rows), c = clamp(pos.c, cols);
  switch (key) {
    case 'ArrowRight': return { r, c: clamp(c + 1, cols) };
    case 'ArrowLeft': return { r, c: clamp(c - 1, cols) };
    case 'ArrowDown': return { r: clamp(r + 1, rows), c };
    case 'ArrowUp': return { r: clamp(r - 1, rows), c };
    case 'Home': return { r, c: 0 };
    case 'End': return { r, c: cols - 1 };
    case 'Ctrl+Home': return { r: 0, c: 0 };
    case 'Ctrl+End': return { r: rows - 1, c: cols - 1 };
    default: return null;
  }
}
