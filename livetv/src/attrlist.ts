// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A linear scanner for the `name=value` lists of provider playlists (M2: the regexes it replaces were quadratic on a long run of
 * name characters without `=`). It finds every `name=value` the old `/(name)=("quoted"|bare)/g` found, in the same order and with the
 * same values, but looks at each character a bounded number of times:
 * - a run of name characters is read once; when no `=` follows it, the scan goes on after the run (no start inside it could match);
 * - a value starting with `"` is the text up to the next `"` (the quotes are reported apart); with no closing quote it is a bare value;
 * - a bare value is the run of characters `bare` accepts (possibly empty).
 * Lines longer than ATTR_LINE_MAX are refused before scanning by the callers (`pickVariant` skips them; M3U lines are capped already).
 */
export const ATTR_LINE_MAX = 8 * 1024;

export interface AttrPair { name: string; value: string; quoted: boolean }

export function scanAttrs(s: string, isName: (c: string) => boolean, isBare: (c: string) => boolean): AttrPair[] {
  const out: AttrPair[] = [];
  // the position of the next `"` at or after i (memoised: a missing closing quote is searched for once)
  let nextQuote = -2;
  const quoteFrom = (i: number) => {
    if (nextQuote === -1 || nextQuote >= i) return nextQuote;
    nextQuote = s.indexOf('"', i);
    return nextQuote;
  };
  let i = 0;
  while (i < s.length) {
    if (!isName(s[i]!)) { i++; continue; }
    let j = i;
    while (j < s.length && isName(s[j]!)) j++;
    if (s[j] !== '=') { i = j; continue; }
    const name = s.slice(i, j);
    const v = j + 1;
    if (s[v] === '"') {
      const close = quoteFrom(v + 1);
      if (close !== -1) {
        out.push({ name, value: s.slice(v + 1, close), quoted: true });
        i = close + 1;
        continue;
      }
    }
    let e = v;
    while (e < s.length && isBare(s[e]!)) e++;
    out.push({ name, value: s.slice(v, e), quoted: false });
    i = e > v ? e : v;
  }
  return out;
}
