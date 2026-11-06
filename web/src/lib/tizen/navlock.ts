// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Inside the Tizen app the server page must not lead out of the app: a TV has no address bar and no way back from a foreign site.
 * A capturing click handler blocks http(s) links to any origin other than the page's own and the sign-in origin. The sign-in
 * origin comes from /api/version (`authOrigin`; the page fetches it itself because the app's local setup page lives on another
 * origin, so its localStorage is not shared) and from localStorage `ff.authOrigin` if present.
 */
export const AUTH_ORIGIN_KEY = 'ff.authOrigin';

/** true when `href` (resolved against `base`) is an http(s) link to an origin that is not allowed */
export function isBlockedLink(href: string | null | undefined, base: string, allowed: ReadonlyArray<string | null | undefined>): boolean {
  if (!href) return false;
  let u: URL;
  try { u = new URL(href, base); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return !allowed.includes(u.origin);
}

export interface NavLockOptions {
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  /** the page's own URL (default location.href); its origin is always allowed */
  base?: string;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, 'getItem'>;
}

/** installs the lock; returns the function that removes it */
export function installNavLock(o: NavLockOptions = {}): () => void {
  const doc = o.doc ?? document;
  const base = o.base ?? location.href;
  const own = new URL(base).origin;
  let auth: string | null = null;
  const stored = (): string | null => { try { return (o.storage ?? localStorage).getItem(AUTH_ORIGIN_KEY); } catch { return null; } };
  let gone = false;
  (o.fetchImpl ?? fetch)('/api/version', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { authOrigin?: unknown } | null) => { if (!gone && typeof j?.authOrigin === 'string') auth = j.authOrigin; })
    .catch(() => undefined);
  const onClick = (e: Event) => {
    const t = e.target as { closest?: (s: string) => { getAttribute(n: string): string | null } | null } | null;
    const a = typeof t?.closest === 'function' ? t.closest('a[href]') : null;
    if (!a) return;
    if (isBlockedLink(a.getAttribute('href'), base, [own, auth, stored()])) { e.preventDefault(); e.stopPropagation(); }
  };
  doc.addEventListener('click', onClick, true);
  return () => { gone = true; doc.removeEventListener('click', onClick, true); };
}
