// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Pure parts of the TV focus tile: the settle debounce and the text model of one title. */
import type { Item } from '#lib/api';
import { cardTag } from '#lib/badges';
import { remainingLabel } from '#lib/detail/format';
import type { Badge } from '#lib/fresh';
import { fmtDuration, type TFn } from '#lib/i18n';
import { reasonText } from '#lib/reason';

/** focus must rest this long on a card before the tile shows it */
export const TILE_DELAY_MS = 300;
/** focus must rest this long on one title before its trailer starts in the tile */
export const TILE_TRAILER_MS = 1500;

/** Trailing debounce: `onSettle` gets the last pushed value after `delayMs` of quiet; pushing the value that is already pending changes nothing. */
export function createSettle<T>(delayMs: number, onSettle: (v: T) => void): { push(v: T): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { v: T } | null = null;
  return {
    push(v) {
      if (pending && pending.v === v) return;
      if (timer) clearTimeout(timer);
      pending = { v };
      timer = setTimeout(() => { timer = null; pending = null; onSettle(v); }, delayMs);
    },
    cancel() { if (timer) clearTimeout(timer); timer = null; pending = null; },
  };
}

export type TileInfo = { title: string; logoId: string | null; backdropId: string | null; meta: string[]; synopsis: string; labels: string[]; reason: string; resume: string };

/** Everything the tile prints for `item`. `badge` = the server badge of the title (undefined = not known, no label). */
export function tileInfo(item: Item, t: TFn, badge?: Badge | null, now = Date.now()): TileInfo {
  const meta: string[] = [];
  if (item.genres?.[0]) meta.push(item.genres[0]);
  if (item.year) meta.push(String(item.year));
  if (item.type === 'Series') { if (item.childCount) meta.push(t('home.meta.seasons', { n: item.childCount })); }
  else if (item.runtimeTicks) meta.push(fmtDuration(item.runtimeTicks / 10_000_000));
  if (item.rating) meta.push(item.rating);
  const tag = cardTag(badge, item, now);
  const left = remainingLabel(item.positionTicks, item.runtimeTicks);
  const code = item.type === 'Episode' && left ? t('detail.view.episodeCode', { s: String(item.parentIndexNumber ?? '?'), e: String(item.indexNumber ?? '?') }) : '';
  return {
    title: item.type === 'Episode' && item.seriesName ? item.seriesName : item.name,
    logoId: item.logo ? (item.type === 'Episode' && item.seriesId ? item.seriesId : item.id) : null,
    backdropId: item.backdrop ? item.id : null,
    meta,
    synopsis: item.overview ?? '',
    labels: tag ? [t(tag.key, tag.kind === 'leaving' ? { n: tag.n } : undefined)] : [],
    reason: reasonText(item.reason, t),
    resume: [code, left].filter(Boolean).join(' · '),
  };
}

/** May the tile start a trailer by itself? Pure so the guard can be tested. */
export function trailerAllowed(o: { hoverTrailers: boolean; autoplay: boolean; hidden: boolean; saveData: boolean }): boolean {
  return !!o.hoverTrailers && !!o.autoplay && !o.hidden && !o.saveData;
}
