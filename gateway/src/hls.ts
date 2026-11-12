// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** HLS parsing helpers shared by gateway.ts and joined.ts (no imports: keeps the two free of a circular import). */

/**
 * `KEY=value` pairs of an HLS attribute list (quoted values may contain commas). A single linear scan, no regex: the list comes
 * from the upstream playlist, and a backtracking pattern would be quadratic on hostile input (long runs without `=`).
 */
export function hlsAttrs(list: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  while (i < list.length) {
    const eq = list.indexOf('=', i);
    if (eq === -1) break;
    const key = list.slice(i, eq).trim();
    let end: number;
    if (list[eq + 1] === '"') {
      const close = list.indexOf('"', eq + 2);
      end = close === -1 ? list.length : close + 1;
    } else {
      const comma = list.indexOf(',', eq + 1);
      end = comma === -1 ? list.length : comma;
    }
    if (/^[A-Z0-9-]+$/.test(key)) out.push([key, list.slice(eq + 1, end)]);
    const next = list.indexOf(',', end);
    if (next === -1) break;
    i = next + 1;
  }
  return out;
}
