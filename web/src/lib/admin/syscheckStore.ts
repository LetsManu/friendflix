// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Systemcheck answer this tab saw last (module + sessionStorage): Admin → Status renders it at once and revalidates. Kept apart from
 * syscheck.ts so the logout path, which runs on every page, can forget it without pulling in the admin code.
 */
import type { SystemcheckResult } from './syscheck';

const STORE_KEY = 'ff-syscheck';
let last: SystemcheckResult | null = null;
const atOf = (r: SystemcheckResult | null): number => (r ? Date.parse(r.at) : NaN);
/** a stored or received answer of the right shape, every line with an id and a status (codes only: nothing in it is secret) */
const validResult = (r: unknown): r is SystemcheckResult =>
  !!r && typeof r === 'object' && typeof (r as SystemcheckResult).at === 'string' && Array.isArray((r as SystemcheckResult).lines)
  && (r as SystemcheckResult).lines.every((l) => !!l && typeof l === 'object' && typeof l.id === 'string' && typeof l.status === 'string')
  && !!(r as SystemcheckResult).counts && typeof (r as SystemcheckResult).counts === 'object';

/** true when `next` may replace `cur`: an answer never gives way to an older one (a slow cached read after a fresh run) */
export const isNewer = (next: SystemcheckResult, cur: SystemcheckResult | null): boolean => !cur || !(atOf(next) < atOf(cur));

/** Keeps the latest answer for this tab (module + sessionStorage): the next visit renders it at once and revalidates. */
export function rememberSystemcheck(r: SystemcheckResult): void {
  if (!validResult(r) || !isNewer(r, last)) return;
  last = r;
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(r)); } catch { /* private mode, quota, no storage */ }
}
/** the last answer this tab saw (null on a cold start) */
export function cachedSystemcheck(): SystemcheckResult | null {
  if (last) return last;
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? 'null');
    if (validResult(v)) last = v;
  } catch { /* nothing stored, unreadable, or no storage */ }
  return last;
}
/** Forgets the remembered answer (logout, tests). */
export function forgetSystemcheck(): void {
  last = null;
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* no storage */ }
}
