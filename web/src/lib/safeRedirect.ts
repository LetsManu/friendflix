// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one check for redirect targets that come from outside (`?next=`, a sign-in flow's `next`): only a path on this
 * site passes. String prefix tests alone are not enough, because the URL parser drops tabs and newlines and folds dot
 * segments (`/\t/evil.example.com` and `/.//evil.example.com` both end up as `//evil.example.com`), so the value is
 * parsed the way the browser will parse it and the result is checked again.
 */

/** a stand-in origin: the value is resolved against it and must stay on it */
const BASE = 'https://friendflix.invalid';
/** control characters (tab, newline, NUL, DEL …), space and backslash: never in a path we send people to */
const BAD_CHAR = /[\u0000-\u0020\u007f\\]/;

/** `raw` as a same-origin path (with its query and fragment) when it is one, else `fallback` */
export function safeRedirect(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || BAD_CHAR.test(raw)) return fallback;
  let u: URL;
  try { u = new URL(raw, BASE); } catch { return fallback; }
  if (u.origin !== BASE || u.username || u.password) return fallback;
  const out = u.pathname + u.search + u.hash;
  // the parsed path must still be a plain path: dot segments can turn `/.//host` into `//host`
  return out.startsWith('/') && !out.startsWith('//') && !BAD_CHAR.test(out) ? out : fallback;
}
