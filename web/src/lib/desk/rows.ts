// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

type RowMetrics = { scroll: number; viewport: number; content: number };

export function rowPages(o: RowMetrics): { page: number; pages: number; canPrev: boolean; canNext: boolean } {
  const vp = Math.max(1, o.viewport);
  const pages = Math.max(1, Math.ceil(o.content / vp));
  const canNext = o.scroll < o.content - o.viewport - 1;
  // At the end of the row the last page is always reached, even when content is not a whole number of viewports.
  const page = canNext ? Math.min(pages - 1, Math.round(o.scroll / vp)) : pages - 1;
  return { page, pages, canPrev: o.scroll > 1, canNext };
}

/** Scroll offset one viewport left or right, clamped to the scrollable range. */
export function pageTarget(o: RowMetrics, dir: -1 | 1): number {
  const max = Math.max(0, o.content - o.viewport);
  return Math.min(max, Math.max(0, o.scroll + dir * o.viewport));
}
