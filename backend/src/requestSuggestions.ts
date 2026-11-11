// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Noch nicht bei uns": titles the profile might like that are NOT in the library, each with a wish state. Seeds are the profile's strongest
 * taste anchors (the titles the v2 engine seeds from: recent watches, thumbs, ratings); for each of a few seeds the request service
 * names recommended titles. Titles already in the library (by TMDB id, admin lookup, same for every viewer) or reported available by the
 * request service are dropped, as is adult material and, for a role with an age cap, everything without a known rating within the cap.
 * The list is cached per profile for 6 hours; the wish state is overlaid live from the account's own requests made after the list was built (older ones are already in the service's state, a declined or deleted one must be wishable again), the quota is never cached.
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
import { effectiveLanguage, type Language } from './i18n.js';
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
/** anchors of the asked type looked at to find the seeds (a seed needs a TMDB id: the media server's, else found by name and year) */
export const SUGGEST_ANCHORS = 12;
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

/** Counts of one build (no titles, no ids): why a list is as long as it is. Logged once per build, shown to admins as `debug`. */
export interface SuggestStats {
  anchors: number; seeds: number; seedsWithoutTmdb: number; seedsFoundByName: number; recommendations: number;
  inLibrary: number; lookupFailures: number; ageFiltered: number; final: number;
}
interface Cached { builtAt?: string; stats?: SuggestStats; items: Array<Omit<Suggestion, 'request'> & { state: WishState }> }

const norm = (x: unknown): string => String(x ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const SEED_ID_TTL = 30 * 86400;
const SEED_MISS_TTL = 86400;

/** TMDB id of a library title that carries none: the request service's search by name, accepted only for an equal title (or original title) and a first release year within one year. */
async function findTmdbByName(ctx: Pick<Ctx, 'kv' | 'cfg'>, seerr: ReturnType<typeof requestsClient>, id: string, mt: 'movie' | 'tv', names: string[], year: number | undefined, lang: Language): Promise<number | null> {
  const key = `reqseed:${mt}:${id}`;
  const hit = await ctx.kv.get(key).catch(() => null);
  if (hit) return Number(hit) > 0 ? Number(hit) : null;
  const want = new Set(names.map(norm).filter(Boolean));
  if (!want.size) return null;
  const r = await seerr.search(names[0]!, 1, lang); // a failing search is not cached: it is tried again with the next build
  const found = r.results.find((x) => {
    if (!x || x.mediaType !== mt || !Number.isInteger(x.id)) return false;
    if (![x.title, x.name, x.originalTitle, x.originalName].some((n) => want.has(norm(n)))) return false;
    const y = Number(String(x.releaseDate ?? x.firstAirDate ?? '').slice(0, 4));
    return !year || !y || Math.abs(y - year) <= 1;
  });
  const n = found ? (found.id as number) : 0;
  await ctx.kv.set(key, String(n), n ? SEED_ID_TTL : SEED_MISS_TTL).catch(() => undefined);
  return n || null;
}

/** Seeds: the profile's top taste anchors of the asked type (title, TMDB id). A seed without a TMDB id from the media server (anime libraries often carry only TVDB / AniDB ids) is looked up by name and year; one the media server cannot name is skipped. */
async function seedsFor(ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf'>, user: JfUser, profileId: string, type: SuggestType, seerr: ReturnType<typeof requestsClient>, lang: Language, stats: SuggestStats): Promise<Array<{ name: string; tmdbId: number }>> {
  const profile = await recoProfileOf(ctx, profileId);
  if (!profile || !ctx.jf.itemAbout) return [];
  const c = recoCoefficients(ctx.cfg);
  const w = recoWeights(ctx.cfg);
  const index = await loadIndex(ctx, w);
  const taste = await tasteProfile(ctx, user, profile, index, c, w);
  const want = type === 'movie' ? 'Movie' : 'Series';
  const mt: 'movie' | 'tv' = type === 'movie' ? 'movie' : 'tv';
  const anchors = (taste.anchors ?? []).filter((a) => index.rows.get(a.id)?.type === want).slice(0, SUGGEST_ANCHORS);
  stats.anchors = anchors.length;
  const out: Array<{ name: string; tmdbId: number }> = [];
  // two at a time, strongest first, until there are enough seeds
  for (let i = 0; i < anchors.length && out.length < SUGGEST_SEEDS; i += 2) {
    const got = await inPool(anchors.slice(i, i + 2), 2, async (a) => {
      try {
        const [item, about] = await Promise.all([ctx.jf.item(user, a.id) as Promise<ItemDto>, ctx.jf.itemAbout!(user, a.id)]);
        if (!item.name) return null;
        const n = Number(about.providerIds.tmdb);
        if (Number.isInteger(n) && n > 0) return { name: item.name, tmdbId: n };
        stats.seedsWithoutTmdb++;
        const year = item.year ?? (Number((about.premiereDate ?? '').slice(0, 4)) || undefined);
        const found = await findTmdbByName(ctx, seerr, a.id, mt, [item.name, about.originalTitle ?? ''].filter(Boolean), year, lang);
        if (!found) return null;
        stats.seedsFoundByName++;
        return { name: item.name, tmdbId: found };
      } catch {
        return null;
      }
    });
    for (const r of got) if (r && out.length < SUGGEST_SEEDS) out.push(r);
  }
  return out;
}

async function build(ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf' | 'seerr'>, user: JfUser, profileId: string, type: SuggestType, ageCap: number | null, lang: Language): Promise<{ list: Cached; complete: boolean }> {
  const builtAt = new Date().toISOString();
  const seerr = requestsClient(ctx);
  const mt: 'movie' | 'tv' = type === 'movie' ? 'movie' : 'tv';
  const stats: SuggestStats = { anchors: 0, seeds: 0, seedsWithoutTmdb: 0, seedsFoundByName: 0, recommendations: 0, inLibrary: 0, lookupFailures: 0, ageFiltered: 0, final: 0 };
  const seeds = await seedsFor(ctx, user, profileId, type, seerr, lang, stats);
  stats.seeds = seeds.length;
  let complete = true;
  const perSeed = await inPool(seeds, 2, async (s) => {
    try {
      return (await seerr.recommendations(mt, s.tmdbId, lang)).results.filter((x) => x && Number.isInteger(x.id) && !x.adult).slice(0, SUGGEST_PER_SEED).map((x) => ({ x, seed: s.name }));
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
  stats.recommendations = pool.length;
  const candidates = pool.filter((e) => WISH[portalStatus(e.x.mediaInfo?.status, e.x.mediaInfo?.requests?.[0]?.status)] !== 'available');
  const inLibrary = await inPool(candidates, PARALLEL, async (e) => {
    try { return Boolean(await ctx.jf.findByTmdb(e.x.id, mt)); } catch { complete = false; stats.lookupFailures++; return true; } // unknown = do not offer
  });
  let rest = candidates.filter((_e, i) => !inLibrary[i]);
  stats.inLibrary = inLibrary.filter(Boolean).length - stats.lookupFailures;
  if (ageCap !== null) {
    // a role with an age cap: only titles whose rating is known and within the cap (the request service lists no ratings in its lists)
    const ok = await inPool(rest, PARALLEL, async (e) => {
      try {
        const age = ratingAge(certificationOf(mt, await seerr.details(mt, e.x.id, lang)));
        return age !== null && age <= ageCap;
      } catch { complete = false; return false; }
    });
    stats.ageFiltered = ok.filter((x) => !x).length;
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
  stats.final = items.length;
  return { list: { builtAt, stats, items }, complete: complete && items.length > 0 }; // an empty list is not kept for hours: the library or the taste may change
}

/** One profile's suggestions (cached 6 h per profile, type and age cap), with the wish state overlaid from the account's own requests. */
export async function requestSuggestions(ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf' | 'seerr' | 'roles'>, user: JfUser, account: { id: string; role: string }, profileId: string, type: SuggestType): Promise<Suggestion[]> {
  return (await requestSuggestionsDetailed(ctx, user, account, profileId, type)).items;
}

/** The same with the counts of the build behind the list (`fresh`: built by this call, not read from the cache). */
export async function requestSuggestionsDetailed(ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf' | 'seerr' | 'roles'>, user: JfUser, account: { id: string; role: string }, profileId: string, type: SuggestType): Promise<{ items: Suggestion[]; stats: SuggestStats | null; fresh: boolean }> {
  requestsClient(ctx); // no request service: 404 requests_disabled, before anything is read
  const cap = (await effectiveRole(ctx, account.role))?.maxParentalRating ?? null;
  const lang = await effectiveLanguage(ctx, profileId);
  const key = `reqsug:${profileId}:${type}:${cap ?? 'x'}:${lang}`; // titles come in the viewer's language
  let list: Cached | null = null;
  const hit = await ctx.kv.get(key).catch(() => null);
  if (hit) { try { list = JSON.parse(hit) as Cached; } catch { /* recompute */ } }
  let fresh = false;
  if (!list) {
    fresh = true;
    const b = await build(ctx, user, profileId, type, cap, lang);
    list = b.list;
    await ctx.kv.set(key, JSON.stringify(list), b.complete ? SUGGEST_TTL : PARTIAL_TTL).catch(() => undefined);
  }
  const mine = list.items.length
    ? (await ctx.db.query<{ tmdb_id: number; media_type: string }>('select tmdb_id, media_type from seerr_requests where user_id=$1 and tmdb_id = any($2::int[]) and created_at >= $3', [account.id, list.items.map((i) => i.tmdbId), list.builtAt ?? '1970-01-01'])).rows
    : [];
  const asked = new Set(mine.map((r) => `${r.media_type}:${r.tmdb_id}`));
  const items = list.items.map(({ state, ...i }): Suggestion => ({ ...i, request: { state: state === 'none' && asked.has(`${i.mediaType}:${i.tmdbId}`) ? 'requested' : state } }));
  return { items, stats: list.stats ?? null, fresh };
}
