// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Data of the "Neu & demnächst" page that no other route offers: "Neue Folgen" (new episodes of shows the profile follows).
 * Everything goes through the neutral media-server seam with the viewer's own identity (library permissions and the kids age cap of the
 * server apply), so Jellyfin and Plex answer alike; nothing here sees or sends a media-server token.
 */
import type { Ctx } from './ctx.js';
import { inPool } from './discoverData.js';
import { homeGens } from './homegen.js';
import { NEW_DAYS, NEW_EPISODE_DAYS } from './fresh.js';
import type { ImageTags, ItemDto } from './media/types.js';
import { countFallback, recoProfileOf, withReason, type WithReason } from './reco/engine.js';
import { recommend } from './reco/recommend.js';
import { freshSource, friendsSource, trendingSource } from './reco/sources.js';
import type { JfUser } from './types.js';

const DAY = 86_400_000;
/** library items read per page of the "newest first" scan, and how many pages at most (a bulk import must not turn into a crawl) */
const PAGE = 200;
const MAX_PAGES = 5;
/** series checked for "has the profile watched it" per request, and entries answered */
export const NEW_EPISODES_CANDIDATES = 60;
export const NEW_EPISODES_MAX = 30;
/** cache lifetime (seconds) of one profile's answer; the key also carries the user-data version, so a watched episode shows up at once */
export const NEW_EPISODES_TTL = 300;

export interface NewEpisodeEntry {
  seriesId: string;
  seriesName: string;
  /** episodes of this series added within the window (the entry shows the newest) */
  newCount: number;
  /** the newest new episode */
  episode: {
    id: string; name: string; season: number; episode: number;
    /** ISO date the episode was added to the library */
    addedAt: string;
    /** image tags of the episode (`seriesPrimary` = the series poster) */
    imageTags?: ImageTags; image: boolean;
  };
}
interface Found extends NewEpisodeEntry { watched: boolean }

const ts = (i: ItemDto): number => (i.dateCreated ? Date.parse(i.dateCreated) : NaN);

/** Episodes of the last `days` days the viewer may see, grouped per series, newest series first. Never throws a partial scan away. */
export async function recentEpisodesBySeries(ctx: Pick<Ctx, 'jf'>, user: JfUser, now: number, days = NEW_EPISODE_DAYS): Promise<Array<NewEpisodeEntry & { newest: number }>> {
  const since = now - days * DAY;
  const groups = new Map<string, NewEpisodeEntry & { newest: number }>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await ctx.jf.addedItems(user, { start: page * PAGE, limit: PAGE });
    let older = false;
    for (const i of rows) {
      const t = ts(i);
      if (Number.isNaN(t)) continue;
      if (t < since) { older = true; continue; }
      if (t > now + DAY || i.type !== 'Episode' || !i.seriesId || i.indexNumber == null) continue; // bogus future date, film, or an unnumbered extra
      const g = groups.get(i.seriesId);
      const season = i.parentIndexNumber ?? 1;
      const entry = { id: i.id, name: i.name, season, episode: i.indexNumber, addedAt: new Date(t).toISOString(), ...(i.imageTags ? { imageTags: i.imageTags } : {}), image: i.image };
      if (!g) { groups.set(i.seriesId, { seriesId: i.seriesId, seriesName: i.seriesName ?? '', newCount: 1, episode: entry, newest: t }); continue; }
      g.newCount++;
      // newest by library date; episodes added in the same batch: the later one in the series
      if (t > g.newest || (t === g.newest && (season > g.episode.season || (season === g.episode.season && i.indexNumber > g.episode.episode)))) { g.episode = entry; g.newest = t; }
      if (!g.seriesName && i.seriesName) g.seriesName = i.seriesName;
    }
    if (older || rows.length < PAGE) break;
  }
  return [...groups.values()].sort((a, b) => b.newest - a.newest);
}

/** Has the profile played at least one episode of the series? (viewer's own user data) */
async function watchedAny(ctx: Pick<Ctx, 'jf'>, user: JfUser, seriesId: string): Promise<boolean> {
  try {
    return (await ctx.jf.items(user, { parentId: seriesId, types: 'Episode', filter: 'played', limit: 1 })).items.length > 0;
  } catch {
    return false; // not visible / lookup failed: not followed this time
  }
}

/**
 * "Neue Folgen": series that got an episode in the last 7 days and that the profile follows (watched at least one episode, or on the
 * Merkliste), newest first, one entry per series. The media part (scan + watched checks) is cached per profile and user-data version;
 * the watchlist is read live, so adding a show to the Merkliste shows it at once.
 */
export async function newEpisodes(ctx: Pick<Ctx, 'db' | 'kv' | 'jf'>, user: JfUser, profileId: string, now = Date.now()): Promise<NewEpisodeEntry[]> {
  const ver = await ctx.jf.userDataVersion(user).catch(() => 0);
  const key = `newep:${user.jellyfin_user_id}:${profileId}:${ver}`;
  let found: Found[] | null = null;
  const hit = await ctx.kv.get(key).catch(() => null);
  if (hit) { try { found = JSON.parse(hit) as Found[]; } catch { /* recompute */ } }
  if (!found) {
    const groups = (await recentEpisodesBySeries(ctx, user, now)).slice(0, NEW_EPISODES_CANDIDATES);
    const marks = await inPool(groups, 4, (g) => watchedAny(ctx, user, g.seriesId));
    found = groups.map(({ newest: _n, ...g }, i): Found => ({ ...g, watched: marks[i]! }));
    await ctx.kv.set(key, JSON.stringify(found), NEW_EPISODES_TTL).catch(() => undefined);
  }
  const listed = found.some((f) => !f.watched)
    ? new Set((await ctx.db.query<{ item_id: string }>('select item_id from watchlist where profile_id=$1 and item_id = any($2::text[])', [profileId, found.map((f) => f.seriesId)])).rows.map((r) => r.item_id))
    : new Set<string>();
  return found.filter((f) => f.watched || listed.has(f.seriesId)).slice(0, NEW_EPISODES_MAX).map(({ watched: _w, ...e }) => e);
}

// ---------------------------------------------------------------- "Für dich neu"

export type NewType = 'movie' | 'series';
const TYPE_OF: Record<NewType, string> = { movie: 'Movie', series: 'Series' };
/** "recent" = added to the library within this many days: the window of the badges "Neue Serie" / "Neu" (fresh.ts NEW_DAYS) */
export const FOR_YOU_DAYS = NEW_DAYS;
export const FOR_YOU_MAX = 20;
export const FOR_YOU_TTL = 600;
/** candidates ranked before the filter: far more than the fresh source brings (40), so no fresh title is cut by the ranking */
const FOR_YOU_POOL = 100;

export interface ForYouResult {
  /** which engine answered: 'v2' = ranked by the taste model with a reason per item; 'v1' = newest titles, no reasons */
  engine: 'v1' | 'v2';
  /** `reason` = { seed: {id,name} | null, traits: ["kind" | "kind:value"] } like every v2 row (the client words it); null on the v1 answer */
  items: Array<ItemDto & { reason: WithReason['reason'] | null }>;
}

const recentEnough = (i: ItemDto, now: number): boolean => {
  const t = ts(i);
  return !Number.isNaN(t) && t <= now + DAY && now - t <= FOR_YOU_DAYS * DAY;
};
/** in-flight v2 computations by cache key (concurrent callers share one recommend()) */
const running = new Map<string, Promise<WithReason[]>>();

/** v1 / failure answer: the newest titles of the window (viewer's token), without reasons. */
async function newestPlain(ctx: Pick<Ctx, 'jf'>, user: JfUser, type: NewType | undefined, now: number): Promise<ForYouResult> {
  const types = type ? TYPE_OF[type] : 'Movie,Series';
  const r = await ctx.jf.items(user, { types, sort: 'DateCreated', desc: true, limit: 60 });
  return { engine: 'v1', items: r.items.filter((i) => !i.played && recentEnough(i, now)).slice(0, FOR_YOU_MAX).map((i) => ({ ...i, reason: null })) };
}

/**
 * "Für dich neu": titles added within the last 14 days (never an old series that only got a new episode), ranked by the v2 recommendation
 * engine for the profile, each with its reason. Candidates are the engine's `fresh` source plus the friends / trending signals that
 * source titles already carry; for a kids profile the engine never runs the social sources, and its age cap applies. The v2 list is cached
 * like the home rows (user-data version + home generation, 10 min) and filtered by type afterwards. Engine v1 / shadow, or a failing v2 run,
 * answers with the plain newest titles and no reasons.
 */
export async function newForYou(ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf'>, user: JfUser, profileId: string, type?: NewType, now = Date.now()): Promise<ForYouResult> {
  const profile = ctx.cfg.RECO_ENGINE === 'v2' ? await recoProfileOf(ctx, profileId) : undefined;
  if (!profile) return newestPlain(ctx, user, type, now);
  try {
    const ver = await ctx.jf.userDataVersion(user).catch(() => 0);
    const key = `newforyou:${user.jellyfin_user_id}:${profileId}:${ver}:${await homeGens(ctx, profileId)}`;
    let list: WithReason[] | null = null;
    const hit = await ctx.kv.get(key).catch(() => null);
    if (hit) { try { list = JSON.parse(hit) as WithReason[]; } catch { /* recompute */ } }
    if (!list) {
      let run = running.get(key);
      if (!run) {
        run = recommend(ctx, user, profile, { surface: 'home_rows', limit: FOR_YOU_POOL, row: 'top_picks', explore: false, now, sources: [freshSource, friendsSource, trendingSource] })
          .then((r) => r.items.filter((x) => x.sources.includes('fresh') && recentEnough(x.item, now)).slice(0, FOR_YOU_POOL).map(withReason));
        running.set(key, run);
        void run.then((l) => ctx.kv.set(key, JSON.stringify(l), FOR_YOU_TTL).catch(() => undefined), () => undefined).finally(() => running.delete(key));
      }
      list = await run;
    }
    const wanted = type ? TYPE_OF[type] : null;
    return { engine: 'v2', items: list.filter((i) => !wanted || i.type === wanted).slice(0, FOR_YOU_MAX) };
  } catch {
    countFallback('home');
    return newestPlain(ctx, user, type, now);
  }
}
