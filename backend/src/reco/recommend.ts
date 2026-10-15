// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import type { ItemDto } from '../media/types.js';
import { recoShadowOverlap, recoShadowRuns, recoShadowScoreDelta } from '../metrics.js';
import type { JfUser } from '../types.js';
import { gatherCandidates, resolveVisible, SOURCES, type CandidateSource, type SourceName } from './candidates.js';
import { tasteProfile, type RecoProfile } from './profile.js';
import { mmr, type RankItem } from './rank.js';
import { filterReason, scoreCandidate, type Marks, type ScoreParts, type Scored } from './score.js';
import { loadIndex } from './vectors.js';
import { recoCoefficients, recoWeights, type Surface } from './weights.js';

/**
 * Recommendation engine v2, R2: recommend() ties the steps together (taste profile -> candidates -> score -> MMR). It always resolves
 * titles with the viewer's token (so library permissions and the kids age cap of the media server apply), applies the kids age cap
 * itself as well, and never runs social sources for a kids profile.
 */

export interface RecoItem { item: ItemDto; score: number; sources: SourceName[]; parts: ScoreParts }
export interface RecoResult {
  surface: Surface;
  /** the taste profile had too few interactions: the quality prior carried the ranking */
  cold: boolean;
  items: RecoItem[];
  /** v2 score of every candidate that survived the filters, before re-ranking (shadow mode compares v1's titles against it) */
  pool: Map<string, number>;
}
export interface RecommendOptions { seed?: string; surface: Surface; limit: number; now?: number; sources?: readonly CandidateSource[] }

const rootItem = async (ctx: Pick<Ctx, 'jf'>, user: JfUser, id: string): Promise<ItemDto | undefined> => {
  const it = await ctx.jf.item(user, id).catch(() => null);
  if (!it) return undefined;
  if (it.type === 'Episode' && it.seriesId) return (await ctx.jf.item(user, it.seriesId).catch(() => null)) ?? undefined;
  return it;
};

async function loadMarks(ctx: Pick<Ctx, 'db'>, profileId: string): Promise<Marks> {
  const [t, d, w] = await Promise.all([
    ctx.db.query<{ item_id: string }>('select item_id from thumbs where profile_id=$1 and value=-1', [profileId]),
    ctx.db.query<{ item_id: string }>('select item_id from dropped where profile_id=$1', [profileId]),
    ctx.db.query<{ item_id: string }>('select item_id from watchlist where profile_id=$1', [profileId]),
  ]);
  const ids = (r: { rows: Array<{ item_id: string }> }) => new Set(r.rows.map((x) => x.item_id));
  return { thumbsDown: ids(t), dropped: ids(d), watchlist: ids(w) };
}

export async function recommend(ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf'>, user: JfUser, profile: RecoProfile, o: RecommendOptions): Promise<RecoResult> {
  const now = o.now ?? Date.now();
  const c = recoCoefficients(ctx.cfg);
  const w = recoWeights(ctx.cfg);
  const index = await loadIndex(ctx, w, now);
  const [taste, marks, seed] = await Promise.all([
    tasteProfile(ctx, user, profile, index, c, w, now),
    loadMarks(ctx, profile.id),
    o.seed ? rootItem(ctx, user, o.seed) : Promise.resolve(undefined),
  ]);
  const cands = await gatherCandidates({ ctx, user, profile, taste, index, c, surface: o.surface, ...(seed ? { seed } : {}) }, o.sources ?? SOURCES);

  // titles the sources did not bring resolved are looked up with the viewer's token; invisible ones drop out here
  const missing = [...cands.values()].filter((x) => !x.item).map((x) => x.id);
  const found = missing.length ? await resolveVisible(ctx, user, missing) : new Map<string, ItemDto>();
  const sc = { surface: o.surface, c, taste, index, profile, marks, ...(seed ? { seed } : {}), now };
  const scored: Scored[] = [];
  for (const cand of cands.values()) {
    const item = cand.item ?? found.get(cand.id);
    if (!item || filterReason(item, sc)) continue;
    scored.push(scoreCandidate(cand, item, sc));
  }

  const ranked = mmr<Scored & RankItem>(
    scored.map((s) => Object.assign(s, { franchise: s.row?.collection_id ?? null, genre: s.row?.genres[0] ?? s.item.genres[0]?.trim().toLowerCase() ?? null })),
    o.limit, c,
  );
  return {
    surface: o.surface, cold: taste.cold, pool: new Map(scored.map((s) => [s.id, s.score])),
    items: ranked.map((s) => ({ item: s.item, score: s.score, sources: s.sources, parts: s.parts })),
  };
}

// ------------------------------------------------------------------------------------------------------------------------ shadow

export const SHADOW_TOP = 10;
const shadowRuns = new Set<Promise<void>>();
/** Resolves when no shadow comparison is running in this process (tests). */
export async function shadowIdle(): Promise<void> {
  while (shadowRuns.size) await Promise.all([...shadowRuns]);
}

/** Share of the v1 top list that the v2 top list also holds (0 when v1 is empty). */
export function overlap(v1: readonly string[], v2: readonly string[], n = SHADOW_TOP): number {
  const a = v1.slice(0, n);
  if (!a.length) return 0;
  const b = new Set(v2.slice(0, n));
  return a.filter((id) => b.has(id)).length / a.length;
}

/**
 * Mean v2 score of the v2 list minus the mean v2 score of the v1 titles that v2 also scored (positive = v2 prefers its own list).
 * Titles v2 never saw as candidates do not count; null when none of v1's titles was scored.
 */
export function scoreDelta(v1: readonly string[], v2: readonly RecoItem[], pool: ReadonlyMap<string, number>, n = SHADOW_TOP): number | null {
  const own = v2.slice(0, n);
  const theirs = v1.slice(0, n).map((id) => pool.get(id)).filter((x): x is number => x !== undefined);
  if (!own.length || !theirs.length) return null;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  return mean(own.map((i) => i.score)) - mean(theirs);
}

/**
 * Shadow mode: runs v2 for the same seed as v1 and records the overlap of the two top-10 lists and the score delta as metrics. Titles,
 * profiles and users appear nowhere (labels: surface, result). Never throws; the caller does not wait for it. Runs once per profile,
 * user-data version and seed (kv guard), so the extra work is not repeated on every request.
 */
export function shadowCompare(ctx: Pick<Ctx, 'cfg' | 'db' | 'kv' | 'jf'>, user: JfUser, profile: RecoProfile, o: { seed: string; surface: Surface; v1: readonly string[]; guardKey: string }): Promise<void> {
  const run = (async () => {
    try {
      if (!(await ctx.kv.setnx(`reco:shadow:${o.guardKey}`, '1', 600).catch(() => true))) return;
      const r = await recommend(ctx, user, profile, { seed: o.seed, surface: o.surface, limit: SHADOW_TOP });
      recoShadowOverlap.observe({ surface: o.surface }, overlap(o.v1, r.items.map((i) => i.item.id)));
      const d = scoreDelta(o.v1, r.items, r.pool);
      if (d !== null) recoShadowScoreDelta.observe({ surface: o.surface }, d);
      recoShadowRuns.inc({ surface: o.surface, result: 'ok' });
    } catch {
      recoShadowRuns.inc({ surface: o.surface, result: 'error' }); // no message: it could carry a server URL
    }
  })();
  shadowRuns.add(run);
  void run.finally(() => shadowRuns.delete(run));
  return run;
}
