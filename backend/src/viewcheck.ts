// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Can this profile see it?" (spec §6.4 *Sicht prüfen*, plan ruling 1): what one profile of an account can see, computed for an admin and
 * never by impersonation (no FriendFlix session, no history, no user data written; on Jellyfin the probe may sign the profile's media
 * user in with the backend's own device, as every portal call does).
 *
 * - checkTitles / checkItem: films and series matching a search (MediaAdmin.findItems) or one title by id (MediaAdmin.findItem), found
 *   with the media server's ADMIN key and then opened as the profile's OWN identity (jfUserFor: its media server user, parental cap, kids
 *   policy). `visible` is that probe's answer, never the admin's. For a hidden hit, `why` is derived from the admin-key facts (library,
 *   rating / the adapter's age) and the profile's effective rights; the answer holds only what spec §4.2 lists (id, name, year, type,
 *   rating, library, visible, why). Without the seam method the service user (first active admin account) searches / opens the id and
 *   `why` is null.
 * - libraryCounts: per library visible (effective rights) and the number of films and series the profile sees (`seen`, its own
 *   identity) against the whole library (`total`, the service user), each read as the total of a one-row page (`limit: 1`), at most
 *   COUNT_PARALLEL at a time; cached 10 min per profile in KV `viewcnt:<pid>`. The cached answer carries the rights it was counted
 *   under: a role, override or kids change makes the next call count again; new or removed titles show after at most 10 minutes
 *   (accepted by ruling 1).
 * Every media server failure becomes 502 media_unavailable: no error, log line or answer ever carries the search query or the item id.
 */
import type { Ctx } from './ctx.js';
import { fetchLibraries } from './libraries.js';
import { MediaError, type FoundItem, type ItemDto, type MediaServer } from './media/types.js';
import { serviceUser } from './previews.js';
import { jfUserFor } from './profiles.js';
import { ratingAge } from './reco/score.js';
import { effectiveRights, type Rights } from './rights.js';
import type { JfUser, ProfileRow, UserRow } from './types.js';
import { HttpError } from './users.js';

type CheckCtx = Pick<Ctx, 'db' | 'roles' | 'jf' | 'kv'>;
/**
 * why a title is hidden: its library is not shared, its rating is above the cap, it has no (understood) age rating and the profile is a
 * kids profile (`unrated_kids`) or a grown-up's profile with an age cap (`unrated`: Plex hides those under any cap)
 */
export type CheckWhy = 'library' | 'rating' | 'unrated' | 'unrated_kids';
export interface CheckHit { id: string; name: string; year?: number; type: 'Movie' | 'Series'; visible: boolean; why: CheckWhy | null; rating: string | null; library: string }
export interface LibraryCount { id: string; name: string; visible: boolean; seen: number | null; total: number }

/** hits of one title search (spec §4.2) */
export const CHECK_HITS = 8;
/** library counts are cached this long per profile (seconds) */
export const VIEWCNT_TTL = 600;
/** count requests to the media server at once */
export const COUNT_PARALLEL = 4;
export const viewcntKey = (profileId: string) => `viewcnt:${profileId}`;

const unavailable = () => new HttpError(502, 'media_unavailable');
const lc = (s: string) => s.toLowerCase();
/** the server says this identity may not see the item / folder */
const denied = (e: unknown) => e instanceof MediaError && (e.status === 404 || e.status === 403);

/** a media server call of the check: any failure is 502 media_unavailable (the original error, which may quote a URL, is dropped) */
async function media<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw unavailable();
  }
}

/** `fn` over `items` with at most `limit` calls running at once; the answers keep the order of `items`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/**
 * Age of a rating for the `why`: the app's own reading (reco/score.ts: "FSK 12", "DE-6", "PG-13" …), also behind a lower-case country
 * prefix ("de/16", "us/PG-13"). null = unrated or not understood. An adapter with its own table sends FoundItem.age instead.
 */
export function ageOf(rating: string | null): number | null {
  return ratingAge(rating) ?? ratingAge(/^[a-z]{2}\/(.+)$/.exec(rating?.trim() ?? '')?.[1]);
}

/** whether the rights' library list includes `name` (matched case-insensitively, like the policy) */
const sharedLibrary = (rights: Rights, name: string) => rights.template.libraries === 'all' || rights.template.libraries.some((n) => lc(n) === lc(name));

/** why a hidden hit is hidden, from the admin-key facts and the profile's effective rights (kids overlay included); null = cannot tell */
function whyHidden(hit: Pick<FoundItem, 'library' | 'rating' | 'age'>, rights: Rights | undefined, profile: Pick<ProfileRow, 'kids'>): CheckWhy | null {
  if (!rights) return null;
  if (hit.library && !sharedLibrary(rights, hit.library)) return 'library';
  const age = hit.age !== undefined ? hit.age : ageOf(hit.rating);
  const cap = rights.template.maxParentalRating;
  if (age !== null && cap !== null && age > cap) return 'rating';
  if (age === null && profile.kids) return 'unrated_kids';
  if (age === null && cap !== null) return 'unrated';
  return null;
}

/** whether the profile's own identity can open the item: 404 / 403 = no; any other failure is 502 (never guessed as "hidden") */
async function canOpen(jf: MediaServer, who: JfUser, id: string): Promise<boolean> {
  try {
    await jf.item(who, id);
    return true;
  } catch (e) {
    if (denied(e)) return false;
    throw unavailable();
  }
}

async function svcUser(ctx: Pick<Ctx, 'db'>): Promise<UserRow> {
  const svc = await serviceUser(ctx);
  if (!svc) throw new HttpError(503, 'no_service_user');
  return svc;
}

/** admin-key hits -> the answer: each probed as the profile, the reason for hidden ones */
async function answer(ctx: CheckCtx, jf: MediaServer, user: UserRow, profile: ProfileRow, found: FoundItem[]): Promise<CheckHit[]> {
  const who = jfUserFor(user, profile);
  const hits = found.slice(0, CHECK_HITS);
  const [visible, rights] = await Promise.all([Promise.all(hits.map((h) => canOpen(jf, who, h.id))), hits.length ? effectiveRights(ctx, user, profile) : undefined]);
  return hits.map((h, i) => ({
    id: h.id, name: h.name, ...(h.year !== undefined ? { year: h.year } : {}), type: h.type,
    visible: visible[i]!, why: visible[i] ? null : whyHidden(h, rights, profile), rating: h.rating, library: h.library,
  }));
}

/** service-user hits (no seam method) -> the answer: probed as the profile, no reason and no library */
async function answerPlain(jf: MediaServer, user: UserRow, profile: ProfileRow, items: ItemDto[]): Promise<CheckHit[]> {
  const who = jfUserFor(user, profile);
  const hits = items.filter((i) => i.type === 'Movie' || i.type === 'Series').slice(0, CHECK_HITS);
  const visible = await Promise.all(hits.map((h) => canOpen(jf, who, h.id)));
  return hits.map((h, i) => ({
    id: h.id, name: h.name, ...(h.year !== undefined ? { year: h.year } : {}), type: h.type as 'Movie' | 'Series',
    visible: visible[i]!, why: null, rating: h.rating ?? null, library: '',
  }));
}

/** Films and series matching `query` (at most CHECK_HITS) and whether `profile` of `user` can open each, with the reason when not. */
export async function checkTitles(ctx: CheckCtx, user: UserRow, profile: ProfileRow, query: string): Promise<CheckHit[]> {
  const jf = ctx.jf;
  const admin = jf.admin;
  if (admin.findItems) return answer(ctx, jf, user, profile, await media(() => admin.findItems!(query, CHECK_HITS)));
  // an adapter without findItems: the service user searches (sees what an admin account sees); no admin facts, so no reason
  const svc = await svcUser(ctx);
  const r = await media(() => jf.items(svc, { q: query, types: 'Movie,Series', limit: CHECK_HITS }));
  return answerPlain(jf, user, profile, r.items);
}

/** The film or series `itemId` (no hit when unknown or another kind of item) and whether `profile` of `user` can open it. */
export async function checkItem(ctx: CheckCtx, user: UserRow, profile: ProfileRow, itemId: string): Promise<CheckHit[]> {
  const jf = ctx.jf;
  const admin = jf.admin;
  if (admin.findItem) {
    const found = await media(() => admin.findItem!(itemId));
    return found ? answer(ctx, jf, user, profile, [found]) : [];
  }
  const svc = await svcUser(ctx);
  const item = await jf.item(svc, itemId).catch((e: unknown) => {
    if (denied(e)) return null;
    throw unavailable();
  });
  return item ? answerPlain(jf, user, profile, [item]) : [];
}

/** the rights a count was made under: another value means the cached counts are stale */
const countSig = (user: UserRow, profile: ProfileRow, rights: Rights | undefined) => JSON.stringify([
  user.role, rights?.template.libraries ?? null, rights?.template.maxParentalRating ?? null, Boolean(profile.kids), profile.kids_max_rating,
  jfUserFor(user, profile).jellyfin_user_id,
]);

/** Per library of the media server: shared with the profile (effective rights), films + series it sees, and the library's whole count. */
export async function libraryCounts(ctx: CheckCtx, user: UserRow, profile: ProfileRow): Promise<LibraryCount[]> {
  const rights = await effectiveRights(ctx, user, profile);
  const sig = countSig(user, profile, rights);
  const key = viewcntKey(profile.id);
  const cached = await ctx.kv.get(key).catch(() => null);
  if (cached) {
    try {
      const c = JSON.parse(cached) as { sig?: unknown; libraries?: unknown };
      if (c.sig === sig && Array.isArray(c.libraries)) return c.libraries as LibraryCount[];
    } catch { /* a broken entry is counted again */ }
  }
  const libs = await fetchLibraries(ctx);
  if (!libs) throw unavailable();
  const jf = ctx.jf;
  const svc = await svcUser(ctx);
  const who = jfUserFor(user, profile);
  // the total of a one-row page; `deniedIsZero`: the profile's identity may not open the library (its policy drifted from the rights):
  // it sees nothing there, which is what the panel should show, not a failure of the whole panel
  const count = async (u: JfUser, parentId: string, deniedIsZero: boolean): Promise<number> => {
    try {
      return (await jf.items(u, { parentId, types: 'Movie,Series', limit: 1 })).total;
    } catch (e) {
      if (deniedIsZero && denied(e)) return 0;
      throw unavailable();
    }
  };
  const jobs = libs.flatMap((l) => {
    const visible = rights !== undefined && sharedLibrary(rights, l.name);
    return [{ l, visible, as: 'total' as const }, ...(visible ? [{ l, visible, as: 'seen' as const }] : [])];
  });
  const answers = await mapLimit(jobs, COUNT_PARALLEL, (j) => (j.as === 'total' ? count(svc, j.l.id, false) : count(who, j.l.id, true)));
  const libraries = libs.map((l): LibraryCount => {
    const at = (as: 'total' | 'seen') => jobs.findIndex((j) => j.l === l && j.as === as);
    const seen = at('seen');
    return { id: l.id, name: l.name, visible: seen >= 0, seen: seen >= 0 ? answers[seen]! : null, total: answers[at('total')]! };
  });
  await ctx.kv.set(key, JSON.stringify({ sig, libraries }), VIEWCNT_TTL).catch(() => undefined);
  return libraries;
}
