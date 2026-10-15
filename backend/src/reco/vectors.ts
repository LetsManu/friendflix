// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import type { Ctx } from '../ctx.js';
import { zscore, type NumStat } from './tfidf.js';
import type { RecoWeights } from './weights.js';

/**
 * Recommendation engine v2, R2: item vectors built from the item feature index (R1) and the sparse-vector maths on them.
 * The index stores raw features and IDF; the field weights (RECO_W_*) apply here, on read, so a changed weight needs no re-index.
 * Pure functions plus one cached loader (loadIndex).
 */

/** Sparse vector: dimension name -> value. Names carry a group prefix (g: genre, t: tag, s: studio, p: person, w: term, c: collection, n: numeric). */
export type SparseVec = Map<string, number>;

export function norm(v: SparseVec): number {
  let s = 0;
  for (const x of v.values()) s += x * x;
  return Math.sqrt(s);
}

/** L2-normalised copy (an all-zero vector stays empty). */
export function normalize(v: SparseVec): SparseVec {
  const n = norm(v);
  const out: SparseVec = new Map();
  if (n > 0) for (const [k, x] of v) if (x !== 0) out.set(k, x / n);
  return out;
}

/** dst += f * src */
export function addScaled(dst: SparseVec, src: SparseVec, f: number): void {
  if (!f) return;
  for (const [k, x] of src) dst.set(k, (dst.get(k) ?? 0) + f * x);
}

/** Dot product (iterates the smaller vector). For two normalised vectors this is the cosine. */
export function dot(a: SparseVec, b: SparseVec): number {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0;
  for (const [k, x] of a) {
    const y = b.get(k);
    if (y !== undefined) s += x * y;
  }
  return s;
}

/** Cosine of two arbitrary vectors; 0 when either is empty. */
export function cosine(a: SparseVec, b: SparseVec): number {
  const na = norm(a), nb = norm(b);
  return na > 0 && nb > 0 ? dot(a, b) / (na * nb) : 0;
}

/** The `n` largest dimensions by absolute value (a stored taste vector stays small), values rounded to 4 places. */
export function topDims(v: SparseVec, n: number): SparseVec {
  const best = [...v.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || (a[0] < b[0] ? -1 : 1)).slice(0, n);
  return new Map(best.map(([k, x]) => [k, Math.round(x * 10_000) / 10_000]));
}

export const vecToJson = (v: SparseVec): Record<string, number> => Object.fromEntries(v);
export const vecFromJson = (o: unknown): SparseVec => {
  const out: SparseVec = new Map();
  if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) if (typeof x === 'number' && Number.isFinite(x)) out.set(k, x);
  return out;
};

// ------------------------------------------------------------------------------------------------------------------ item vectors

/** One row of item_features as the engine reads it. */
export interface FeatureRow {
  item_id: string; type: 'Movie' | 'Series'; genres: string[]; tags: string[]; studios: string[]; people: string[];
  year: number | null; runtime_min: number | null; community_rating: number | null; critic_rating: number | null;
  original_language: string | null; countries: string[]; collection_id: string | null; series_status: 'continuing' | 'ended' | null;
  overview_terms: Record<string, number>;
}

export type IdfKind = 'genre' | 'tag' | 'studio' | 'person';
export interface IndexStats { year: NumStat; runtime_min: NumStat; community_rating: NumStat; critic_rating: NumStat }
/** IDF of a value the table does not know (a title added after the last nightly pass): as rare as a value seen once in a mid-sized library. */
export const UNKNOWN_IDF = 2;
const NUMERIC_CLAMP = 3;

export interface IndexData {
  rows: Map<string, FeatureRow>;
  idf: Record<IdfKind, Map<string, number>>;
  stats: IndexStats;
  /** mean community rating over the library (0 when no title has one) */
  meanRating: number;
}

/**
 * The vector of one item: per group (genres, tags, studios, people) the IDF-weighted indicator, L2-normalised and scaled by the group weight
 * (so a rare director outweighs the genre "Drama" and a long cast list does not drown a short genre list); the overview terms (already
 * TF-IDF, L2-normalised) times the text weight; the collection as one dimension; year / runtime / ratings as z-scores. The result is
 * L2-normalised, so dot() is the cosine.
 */
export function itemVector(row: FeatureRow, data: Pick<IndexData, 'idf' | 'stats'>, w: RecoWeights): SparseVec {
  const v: SparseVec = new Map();
  const group = (prefix: string, kind: IdfKind, values: readonly string[], weight: number) => {
    if (weight <= 0 || !values.length) return;
    const g: SparseVec = new Map();
    for (const val of values) g.set(prefix + val, data.idf[kind].get(val) ?? UNKNOWN_IDF);
    addScaled(v, normalize(g), weight);
  };
  group('g:', 'genre', row.genres, w.genres);
  group('t:', 'tag', row.tags, w.tags);
  group('s:', 'studio', row.studios, w.studios);
  group('p:', 'person', row.people, w.people);
  if (w.text > 0) for (const [t, x] of Object.entries(row.overview_terms)) v.set('w:' + t, x * w.text);
  if (w.collection > 0 && row.collection_id) v.set('c:' + row.collection_id, w.collection);
  if (w.numeric > 0) {
    const n = (name: string, x: number | null, s: NumStat) => {
      const z = Math.max(-NUMERIC_CLAMP, Math.min(NUMERIC_CLAMP, zscore(x, s)));
      if (z !== 0) v.set('n:' + name, (z / NUMERIC_CLAMP) * w.numeric * 0.5);
    };
    n('year', row.year, data.stats.year);
    n('runtime', row.runtime_min, data.stats.runtime_min);
    n('rating', row.community_rating, data.stats.community_rating);
    n('critic', row.critic_rating, data.stats.critic_rating);
  }
  return normalize(v);
}

// ----------------------------------------------------------------------------------------------------------------------- loader

export interface Index extends IndexData {
  /** item_id -> normalised vector */
  vecs: Map<string, SparseVec>;
  /** collection_id -> item ids */
  byCollection: Map<string, string[]>;
  builtAt: number;
}

const TTL_MS = 5 * 60_000;
const cache = new WeakMap<object, { sig: string; at: number; index: Index }>();

/** Forgets the in-process index of this ctx (tests, and after a weight change in the same process). */
export function resetIndexCache(ctx: Pick<Ctx, 'db'>): void {
  cache.delete(ctx.db);
}

export const weightsSignature = (w: RecoWeights): string => createHash('sha1').update(JSON.stringify(w)).digest('hex').slice(0, 10);

const EMPTY_STAT: NumStat = { mean: 0, std: 0, n: 0 };

/**
 * The whole index in memory (rows, IDF, statistics, item vectors), rebuilt after 5 minutes or when the weights change. A library of
 * tens of thousands of titles is a few tens of MB; the nearest-neighbour search runs over it in-process. Empty index = empty maps.
 */
export async function loadIndex(ctx: Pick<Ctx, 'db'>, w: RecoWeights, now = Date.now()): Promise<Index> {
  const sig = weightsSignature(w);
  const hit = cache.get(ctx.db);
  if (hit && hit.sig === sig && now - hit.at < TTL_MS) return hit.index;
  const [rows, idf, stats] = await Promise.all([
    ctx.db.query<FeatureRow>('select item_id, type, genres, tags, studios, people, year, runtime_min, community_rating, critic_rating, original_language, countries, collection_id, series_status, overview_terms from item_features'),
    ctx.db.query<{ kind: string; value: string; idf: number }>("select kind, value, idf from item_feature_idf where kind <> 'term'"),
    ctx.db.query<{ name: string; mean: number; std: number; n: number }>('select name, mean, std, n from item_feature_stats'),
  ]);
  const idfs: Record<IdfKind, Map<string, number>> = { genre: new Map(), tag: new Map(), studio: new Map(), person: new Map() };
  for (const r of idf.rows) idfs[r.kind as IdfKind]?.set(r.value, Number(r.idf));
  const st = new Map(stats.rows.map((r) => [r.name, { mean: Number(r.mean), std: Number(r.std), n: r.n }]));
  const data: IndexData = {
    rows: new Map(rows.rows.map((r) => [r.item_id, r])),
    idf: idfs,
    stats: { year: st.get('year') ?? EMPTY_STAT, runtime_min: st.get('runtime_min') ?? EMPTY_STAT, community_rating: st.get('community_rating') ?? EMPTY_STAT, critic_rating: st.get('critic_rating') ?? EMPTY_STAT },
    meanRating: 0,
  };
  data.meanRating = data.stats.community_rating.n > 0 ? data.stats.community_rating.mean : 0;
  const vecs = new Map<string, SparseVec>();
  const byCollection = new Map<string, string[]>();
  for (const [id, r] of data.rows) {
    vecs.set(id, itemVector(r, data, w));
    if (r.collection_id) (byCollection.get(r.collection_id) ?? byCollection.set(r.collection_id, []).get(r.collection_id)!).push(id);
  }
  const index: Index = { ...data, vecs, byCollection, builtAt: now };
  cache.set(ctx.db, { sig, at: now, index });
  return index;
}
