import type { Item } from '#lib/api';

const DAY = 86_400_000;
/** "Neue Folgen" window in days */
export const NEW_EPISODES_DAYS = 14;

/** A series the viewer already started, with unwatched episodes, that received media within the last 14 days. */
export function hasNewEpisodes(item: Pick<Item, 'type' | 'lastAdded' | 'unplayedCount' | 'childCount' | 'playedPercentage'>, now: number): boolean {
  if (item.type !== 'Series' || !item.lastAdded || !((item.unplayedCount ?? 0) > 0)) return false;
  const t = Date.parse(item.lastAdded);
  if (!Number.isFinite(t) || t > now + DAY || now - t > NEW_EPISODES_DAYS * DAY) return false;
  const started = (item.playedPercentage ?? 0) > 0 || (item.childCount !== undefined && item.unplayedCount! < item.childCount);
  return started;
}
