// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Phone browse helpers: home carousel picks, swipe target, chip bar tucking and the tab list. */
import type { Item } from '#lib/api';

/** most slides the home carousel shows */
export const CAROUSEL_MAX = 5;

/** same rule PosterCard uses: an episode borrows its series poster, everything else needs its own image */
function hasPoster(i: Item): boolean {
  return Boolean(i.type === 'Episode' ? i.seriesId : i.image);
}

/** hero first, then fresh-labelled candidates, then the rest; unique, poster-only, at most CAROUSEL_MAX */
export function carouselPicks(o: { hero: Item | null; candidates: Item[]; fresh: (id: string) => string | null }): Item[] {
  const labelled = o.candidates.filter((c) => o.fresh(c.id) !== null);
  const plain = o.candidates.filter((c) => o.fresh(c.id) === null);
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const i of [...(o.hero ? [o.hero] : []), ...labelled, ...plain]) {
    if (out.length >= CAROUSEL_MAX) break;
    if (seen.has(i.id) || !hasPoster(i)) continue;
    seen.add(i.id);
    out.push(i);
  }
  return out;
}

/** horizontal travel that counts as a swipe */
export const SWIPE_PX = 50;
/** release speed (px per ms) that counts as a flick */
export const FLICK_PX_PER_MS = 0.5;

/** slide index after a swipe gesture, clamped to the slides */
export function swipeTarget(o: { index: number; count: number; dx: number; vx: number }): number {
  let next = o.index;
  if (o.dx < -SWIPE_PX || o.vx < -FLICK_PX_PER_MS) next = o.index + 1;
  else if (o.dx > SWIPE_PX || o.vx > FLICK_PX_PER_MS) next = o.index - 1;
  return Math.max(0, Math.min(o.count - 1, next));
}

/** the header turns solid after this scroll depth */
export const TUCK_AFTER = 90;
export const SOLID_AFTER = 30;

/** chip bar hides when scrolling down past TUCK_AFTER and returns when scrolling up; small jitter keeps the state */
export function chipsTucked(o: { y: number; lastY: number; tucked: boolean }): boolean {
  if (o.y < TUCK_AFTER) return false;
  if (o.y > o.lastY + 4) return true;
  if (o.y < o.lastY - 4) return false;
  return o.tucked;
}

export type PhoneTab = { href: string; key: 'home' | 'new' | 'live' | 'myList' | 'downloads'; icon: string };

/** bottom tab bar entries: Live-TV between Neu and Merkliste only while the feature is on; Downloads only when the account may download */
export function phoneTabs(canDownload: boolean, live: boolean): PhoneTab[] {
  const tabs: PhoneTab[] = [
    { href: '/', key: 'home', icon: 'home' },
    { href: '/new', key: 'new', icon: 'star' },
  ];
  if (live) tabs.push({ href: '/live', key: 'live', icon: 'tv' });
  tabs.push({ href: '/watchlist', key: 'myList', icon: 'bookmark' });
  if (canDownload) tabs.push({ href: '/downloads', key: 'downloads', icon: 'download' });
  return tabs;
}
