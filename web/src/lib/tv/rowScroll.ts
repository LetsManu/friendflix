// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/** window.scrollY that puts a row's top (viewport coordinates) at `tileBottom` (viewport coordinates); never negative. */
export function rowScrollTarget(rowTop: number, scrollY: number, tileBottom: number): number {
  return Math.max(0, Math.round(rowTop - tileBottom + scrollY));
}
