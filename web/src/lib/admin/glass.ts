// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Dense glass admin (glass spec §7): which stat values count up. A tile counts only a plain number: a finite number, or a
 * string of digits with optional thousands separators as `fmtNumber` writes them in any locale (`'2.431'`, `'2,431'`,
 * `'2 431'`, with a narrow or plain no-break space too). Units, decimals, dashes and `null` do not count (`'3 GB'`, `'–'`).
 */
const GROUPED = /^\d{1,3}(?:([.,'   ])\d{3})?(?:\1\d{3})*$/;

export function countable(v: string | number | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (!GROUPED.test(s)) return null;
  return Number(s.replace(/\D/g, ''));
}
