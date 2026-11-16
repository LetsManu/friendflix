// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The brand name for the service worker (branding Task 3): a push without a title shows the instance's name. The page keeps the last
 * fetched name in the small `ff-meta` cache (Cache Storage is shared with the worker, localStorage is not; like lib/sw/locale.ts).
 */
import { META_CACHE } from './locale';

export const BRAND_NAME_URL = '/__ff/brand-name';
/** the name the worker shows when nothing was remembered (an older page, blocked storage) */
export const FALLBACK_NAME = 'FriendFlix';
/** the backend's limit (24) with room; anything longer, empty or with control characters is not a remembered name */
const MAX = 64;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Page side: remember the brand name (best effort; no Cache Storage → nothing happens). */
export async function rememberBrandName(name: string): Promise<void> {
  try {
    if (typeof caches === 'undefined' || !name || name.length > MAX) return;
    const c = await caches.open(META_CACHE);
    await c.put(BRAND_NAME_URL, new Response(name, { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
  } catch { /* private mode / storage blocked */ }
}

/** Worker side: the remembered brand name, or FriendFlix. */
export async function brandName(): Promise<string> {
  try {
    if (typeof caches === 'undefined') return FALLBACK_NAME;
    const r = await (await caches.open(META_CACHE)).match(BRAND_NAME_URL);
    const v = r ? (await r.text()).trim() : '';
    return v && v.length <= MAX && !CONTROL.test(v) ? v : FALLBACK_NAME;
  } catch { return FALLBACK_NAME; }
}
