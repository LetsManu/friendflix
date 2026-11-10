// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Noch nicht bei uns": titles the profile might like that are NOT in the library, each with a wish state. Seeds are the profile's strongest
 * taste anchors (the titles the v2 engine seeds from: recent watches, thumbs, ratings); for each of a few seeds the request service
 * names recommended titles. Titles already in the library (by TMDB id, admin lookup, same for every viewer) or reported available by the
 * request service are dropped, as is adult material and, for a role with an age cap, everything without a known rating within the cap.
 * The list is cached per profile for 6 hours; the wish state is overlaid live from the account's own requests, the quota is never cached.
 * Nothing here sees a media-server token or the request-service key (the client holds it server-side).
 */
import type { Ctx } from './ctx.js';
import { inPool } from './discoverData.js';
import type { ItemDto } from './media/types.js';
import { recoProfileOf } from './reco/engine.js';
import { tasteProfile } from './reco/profile.js';
import { ratingAge } from './reco/score.js';
import { loadIndex } from './reco/vectors.js';
import { recoCoefficients, recoWeights } from './reco/weights.js';
import { effectiveRole } from './roles.js';
import { portalStatus, requestsClient } from './seerr/client.js';
import type { JfUser } from './types.js';

export type SuggestType = 'movie' | 'series';
export type WishState = 'none' | 'requested' | 'processing' | 'available';
export interface Suggestion {
  tmdbId: number; mediaType: 'movie' | 'tv'; title: string; year: number | null; poster: string | null; releaseDate?: string;
  reason: { seed: string }; request: { state: WishState };
}

/** seeds asked per answer, titles taken per seed, titles answered */
export const SUGGEST_SEEDS = 3;
export const SUGGEST_PER_SEED = 8;
export const SUGGEST_MAX = 12;
/** cache lifetime (seconds) of one profile's list; a short one when a seed failed, so the gap closes soon */
export const SUGGEST_TTL = 6 * 3600;
const PARTIAL_TTL = 120;
const PARALLEL = 4;

const WISH: Record<string, WishState> = { nicht_angefragt: 'none', abgelehnt: 'none', angefragt: 'requested', in_arbeit: 'processing', teilweise: 'processing', verfuegbar: 'available' };
const date = (x: unknown): string | undefined => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : undefined);

/** Official rating of a TMDB title from the request service's details: Germany first, then the US. */
function certificationOf(mediaType: 'movie' | 'tv', d: any): string | null {
  const pick = <T>(list: T[] | undefined, iso: (x: T) => string | undefined, val: (x: T) => string | undefined): string | null => {
    for (const c of ['DE', 'US']) {
      const v = (list ?? []).filter((x) => iso(x) === c).map(val).find((x) => Boolean(x));
      if (v) return v;
    }
    return null;
  };
  return mediaType === 'movie'
    ? pick<any>(d?.releases?.results, (x) => x.iso_3166_1, (x) => (x.release_dates ?? []).map((r: any) => r.certification).find((c: string) => c))
    : pick<any>(d?.contentRatings?.results, (x) => x.iso_3166_1, (x) => x.rating);
}

interface Cached { items: Array<Omit<Suggestion, 'request'> & { state: WishState }> }

/** Seeds: the profile's top taste anchors of the asked type (title, TMDB id); a seed the media server cannot name or has no TMDB id for is skipped. */
async function seedsFor(ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf'>, user: JfUser, profileId: string, type: SuggestType): Promise<Array<{ name: string; tmdbId: number }>> {
  const profile = await recoProfileOf(ctx, profileId);
  if (!profile || !ctx.jf.itemAbout) return [];
  const c = recoCoefficients(ctx.cfg);
  const w = recoWeights(ctx.cfg);
  const index = await loadIndex(ctx, w);
  const taste = await tasteProfile(ctx, user, profile, index, c, w);
  const want = type === 'movie' ? 'Movie' : 'Series';
  const anchors = (taste.anchors ?? []).filter((a) => index.rows.get(a.id)?.type === want).slice(0, SUGGEST_SEEDS + 2); // two spare for seeds without a TMDB id
  const out: Array<{ name: string; tmdbId: number }> = [];
  const resolved = await inPool(anchors, 2, async (a) => {
    try {
      const [item, about] = await Promise.all([ctx.jf.item(user, a.id) as Promise<ItemDto>, ctx.jf.itemAbout!(user, a.id)]);
      const n = Number(about.providerIds.tmdb);
      return Number.isInteger(n) && n > 0 && item.name ? { name: item.name, tmdbId: n } : null;
    } catch {
      return null;
    }
  });
  for (const r of resolved) if (r && out.length < SUGGEST_SEEDS) out.push(r);
  return out;
}

async function build(ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf' | 'seerr'>, user: JfUser, profileId: string, type: SuggestType, ageCap: number | null): Promise<{ list: Cached; complete: boolean }> {
  const seerr = requestsClient(ctx);
  const mt: 'movie' | 'tv' = type === 'movie' ? 'movie' : 'tv';
  const seeds = await seedsFor(ctx, user, profileId, type);
  let complete = true;
  const perSeed = await inPool(seeds, 2, async (s) => {
    try {
      return (await seerr.recommendations(mt, s.tmdbId)).results.filter((x) => x && Number.isInteger(x.id) && !x.adult).slice(0, SUGGEST_PER_SEED).map((x) => ({ x, seed: s.name }));
    } catch {
      complete = false;
      return [];
    }
  });
  // round robin over the seeds, so one seed does not take every slot; one entry per TMDB id; never a seed itself
  const seedIds = new Set(seeds.map((s) => s.tmdbId));
  const seen = new Set<number>();
  const pool: Array<{ x: any; seed: string }> = [];
  for (let i = 0; i < SUGGEST_PER_SEED; i++) {
    for (const l of perSeed) {
      const e = l[i];
      if (e && !seen.has(e.x.id) && !seedIds.has(e.x.id)) { seen.add(e.x.id); pool.push(e); }
    }
  }
  const candidates = pool.filter((e) => WISH[portalStatus(e.x.mediaInfo?.status, e.x.mediaInfo?.requests?.[0]?.status)] !== 'available');
  const inLibrary = await inPool(candidates, PARALLEL, async (e) => {
    try { return Boolean(await ctx.jf.findByTmdb(e.x.id, mt)); } catch { complete = false; return true; } // unknown = do not offer
  });
  let rest = candidates.filter((_e, i) => !inLibrary[i]);
  if (ageCap !== null) {
    // a role with an age cap: only titles whose rating is known and within the cap (the request service lists no ratings in its lists)
    const ok = await inPool(rest, PARALLEL, async (e) => {
      try {
        const age = ratingAge(certificationOf(mt, await seerr.details(mt, e.x.id)));
        return age !== null && age <= ageCap;
      } catch { complete = false; return false; }
    });
    rest = rest.filter((_e, i) => ok[i]);
  }
  const today = new Date().toISOString().slice(0, 10);
  const items = rest.slice(0, SUGGEST_MAX).map(({ x, seed }): Cached['items'][number] => {
    const released = date(x.releaseDate ?? x.firstAirDate);
    const year = Number((released ?? '').slice(0, 4));
    return {
      tmdbId: x.id as number, mediaType: mt, title: String(x.title ?? x.name ?? ''), year: year > 0 ? year : null,
      poster: typeof x.posterPath === 'string' && x.posterPath ? `/api/seerr/image${x.posterPath}` : null,
      ...(released && released > today ? { releaseDate: released } : {}), reason: { seed },
      state: WISH[portalStatus(x.mediaInfo?.status, x.mediaInfo?.requests?.[0]?.status)] ?? 'none',
    };
  }).filter((i) => i.title);
  return { list: { items }, complete };
}

/** One profile's suggestions (cached 6 h per profile, type and age cap), with the wish state overlaid from the account's own requests. */
export async function requestSuggestions(ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf' | 'seerr' | 'roles'>, user: JfUser, account: { id: string; role: string }, profileId: string, type: SuggestType): Promise<Suggestion[]> {
  requestsClient(ctx); // no request service: 404 requests_disabled, before anything is read
  const cap = (await effectiveRole(ctx, account.role))?.maxParentalRating ?? null;
  const key = `reqsug:${profileId}:${type}:${cap ?? 'x'}`;
  let list: Cached | null = null;
  const hit = await ctx.kv.get(key).catch(() => null);
  if (hit) { try { list = JSON.parse(hit) as Cached; } catch { /* recompute */ } }
  if (!list) {
    const b = await build(ctx, user, profileId, type, cap);
    list = b.list;
    await ctx.kv.set(key, JSON.stringify(list), b.complete ? SUGGEST_TTL : PARTIAL_TTL).catch(() => undefined);
  }
  const mine = list.items.length
    ? (await ctx.db.query<{ tmdb_id: number; media_type: string }>('select tmdb_id, media_type from seerr_requests where user_id=$1 and tmdb_id = any($2::int[])', [account.id, list.items.map((i) => i.tmdbId)])).rows
    : [];
  const asked = new Set(mine.map((r) => `${r.media_type}:${r.tmdb_id}`));
  return list.items.map(({ state, ...i }) => ({ ...i, request: { state: state === 'none' && asked.has(`${i.mediaType}:${i.tmdbId}`) ? 'requested' : state } }));
}
