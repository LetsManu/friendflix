// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ItemDto } from '../media/types.js';
import { buildTaste, type Signal } from './profile.js';
import { mmr } from './rank.js';
import { scoreCandidate, type Marks, type ScoreContext } from './score.js';
import { idf as idfOf, numStat } from './tfidf.js';
import { dot, itemVector, type FeatureRow, type Index, type SparseVec } from './vectors.js';
import { DEFAULT_RECO_WEIGHTS, recoCoefficients, type RecoCoefficients, type RecoWeights, type Surface } from './weights.js';

/**
 * Recommendation engine v2 for the offline evaluation (scripts/reco-eval.mjs, spec 4.7): the same taste maths, vectors, scoring and MMR
 * as the live engine, fed from a dataset instead of the database and the media server. Pure, no I/O. The script imports the compiled
 * file (`npm run build -w backend`). Differences to the live engine, by necessity: the item index is built from the dataset's own
 * item features (IDF over the dataset), "similar()" comes from the dataset's recorded answers (or is left out), and the signals are
 * what a dataset knows: played (+finished movie weight), liked (+thumbs-up weight), disliked (thumbs-down).
 */

export interface OfflineItem {
  id: string; genres?: string[]; tags?: string[]; studios?: string[]; people?: string[]; year?: number; runtime?: number; rating?: number; collection?: string;
  /** when the title was added (ms), for freshness; absent = unknown */
  added?: number;
}
export interface OfflineEvent { item: string; t: number; liked?: boolean; likedAt?: number }
export interface OfflineQuery { surface: 'home' | 'next'; history: readonly OfflineEvent[]; seed?: string; k: number; disliked?: ReadonlySet<string> }

const lower = (xs: readonly string[] | undefined) => (xs ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean);

/** Builds the index structures (rows, IDF, statistics, vectors) from dataset items. */
export function offlineIndex(items: readonly OfflineItem[], w: RecoWeights = DEFAULT_RECO_WEIGHTS): Index {
  const rows = new Map<string, FeatureRow>();
  for (const i of items) {
    rows.set(i.id, {
      item_id: i.id, type: 'Movie', genres: lower(i.genres), tags: lower(i.tags), studios: lower(i.studios), people: [...(i.people ?? [])], year: i.year ?? null, runtime_min: i.runtime ?? null,
      community_rating: i.rating ?? null, critic_rating: null, original_language: null, countries: [], collection_id: i.collection ?? null, series_status: null, overview_terms: {},
    });
  }
  const n = rows.size;
  const df = (pick: (r: FeatureRow) => string[]) => {
    const m = new Map<string, number>();
    for (const r of rows.values()) for (const v of new Set(pick(r))) m.set(v, (m.get(v) ?? 0) + 1);
    return new Map([...m].map(([k, d]) => [k, idfOf(n, d)]));
  };
  const all = [...rows.values()];
  const idf = { genre: df((r) => r.genres), tag: df((r) => r.tags), studio: df((r) => r.studios), person: df((r) => r.people) };
  const stats = { year: numStat(all.map((r) => r.year)), runtime_min: numStat(all.map((r) => r.runtime_min)), community_rating: numStat(all.map((r) => r.community_rating)), critic_rating: numStat([]) };
  const data = { idf, stats };
  const vecs = new Map<string, SparseVec>();
  const byCollection = new Map<string, string[]>();
  for (const [id, r] of rows) {
    vecs.set(id, itemVector(r, data, w));
    if (r.collection_id) (byCollection.get(r.collection_id) ?? byCollection.set(r.collection_id, []).get(r.collection_id)!).push(id);
  }
  return { rows, idf, stats, meanRating: stats.community_rating.n ? stats.community_rating.mean : 0, vecs, byCollection, builtAt: 0 };
}

const NO_MARKS: Marks = { thumbsDown: new Set(), dropped: new Set(), watchlist: new Set() };

export function offlineEngine(items: readonly OfflineItem[], similar: Readonly<Record<string, readonly string[]>> = {}, c: RecoCoefficients = recoCoefficients()) {
  const index = offlineIndex(items);
  const added = new Map(items.map((i) => [i.id, i.added]));
  const asItem = (id: string, seen: ReadonlySet<string>): ItemDto => {
    const r = index.rows.get(id);
    const a = added.get(id);
    return {
      id, name: '', type: 'Movie', genres: r?.genres ?? [], image: false, backdrop: false, logo: false, trailers: 0, played: seen.has(id), favorite: false, positionTicks: 0,
      ...(r?.community_rating != null ? { communityRating: r.community_rating } : {}), ...(a !== undefined ? { dateCreated: new Date(a).toISOString() } : {}),
    };
  };

  return {
    name: 'v2',
    recommend(q: OfflineQuery): string[] {
      const last = q.history.reduce((m, e) => Math.max(m, e.t), 0);
      const now = last + 86_400_000;
      const signals: Signal[] = [];
      for (const e of q.history) {
        signals.push({ item: e.item, kind: 'finishedMovie', weight: c.signal.finishedMovie, at: e.t });
        if (e.liked) signals.push({ item: e.item, kind: 'thumbUp1', weight: c.signal.thumbUp1, at: e.likedAt ?? e.t });
      }
      for (const id of q.disliked ?? []) signals.push({ item: id, kind: 'thumbDown', weight: c.signal.thumbDown, at: last });
      const seen = new Set(q.history.map((e) => e.item));
      const taste = buildTaste(signals, seen, { vec: (id) => index.vecs.get(id), row: (id) => index.rows.get(id) }, c, now);

      const surface: Surface = q.surface === 'next' ? 'postplay' : 'home_rows';
      const seedId = q.surface === 'next' ? q.seed : undefined;
      const seed = seedId ? asItem(seedId, seen) : undefined;
      const cands = new Map<string, { id: string; sources: Set<'similar' | 'universe' | 'taste_nn' | 'prior'>; jfRank?: number; signals: Record<string, number> }>();
      const add = (id: string, src: 'similar' | 'universe' | 'taste_nn' | 'prior', jfRank?: number) => {
        if (!index.rows.has(id) || id === seedId) return;
        let x = cands.get(id);
        if (!x) cands.set(id, (x = { id, sources: new Set(), signals: {} }));
        x.sources.add(src);
        if (jfRank !== undefined) x.jfRank = Math.max(x.jfRank ?? 0, jfRank);
      };
      if (seedId) {
        const list = (similar[seedId] ?? []).filter((id) => id !== seedId).slice(0, c.candidates.similar);
        list.forEach((id, n) => add(id, 'similar', list.length > 1 ? 1 - n / (list.length - 1) : 1));
        const row = index.rows.get(seedId);
        if (row?.collection_id) for (const id of index.byCollection.get(row.collection_id) ?? []) add(id, 'universe');
        // without recorded similar() answers the seed's nearest neighbours stand in for them
        if (!list.length && index.vecs.get(seedId)) {
          const sv = index.vecs.get(seedId)!;
          [...index.vecs].filter(([id]) => id !== seedId).map(([id, v]) => [id, dot(sv, v)] as const).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, c.candidates.similar).forEach(([id], n, a) => add(id, 'similar', a.length > 1 ? 1 - n / (a.length - 1) : 1));
        }
      }
      if (!taste.cold && taste.pos.size) {
        [...index.vecs].filter(([id]) => !seen.has(id)).map(([id, v]) => [id, dot(taste.pos, v)] as const).filter(([, s]) => s > 0)
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, c.candidates.knn).forEach(([id]) => add(id, 'taste_nn'));
      }
      if (taste.cold && !seedId) {
        [...index.rows.values()].filter((r) => r.community_rating !== null).sort((a, b) => b.community_rating! - a.community_rating! || (a.item_id < b.item_id ? -1 : 1))
          .slice(0, c.candidates.prior).forEach((r) => add(r.item_id, 'prior'));
      }
      const marks: Marks = { ...NO_MARKS, thumbsDown: new Set(q.disliked ?? []) };
      const sc: ScoreContext = { surface, c, taste, index, profile: { kids: false, kids_max_rating: 12 }, marks, ...(seed ? { seed } : {}), now };
      const scored = [...cands.values()].filter((x) => !marks.thumbsDown.has(x.id)).map((x) => scoreCandidate(x, asItem(x.id, seen), sc));
      return mmr(scored.map((s) => Object.assign(s, { franchise: s.row?.collection_id ?? null, genre: s.row?.genres[0] ?? null })), q.k, c).map((s) => s.id);
    },
  };
}
