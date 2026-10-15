// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Config } from '../config.js';

/**
 * Field weights of the item index (RECO_W_* settings): how much each feature group counts when item vectors are combined
 * (taste profile and similarity, R2). The index itself stores raw features and IDF; the weights only apply on read.
 */
export interface RecoWeights { genres: number; tags: number; studios: number; people: number; text: number; numeric: number; collection: number }

export const DEFAULT_RECO_WEIGHTS: Readonly<RecoWeights> = { genres: 1, tags: 0.6, studios: 0.4, people: 0.8, text: 1, numeric: 0.3, collection: 1.5 };

export function recoWeights(cfg: Pick<Config, 'RECO_W_GENRES' | 'RECO_W_TAGS' | 'RECO_W_STUDIOS' | 'RECO_W_PEOPLE' | 'RECO_W_TEXT' | 'RECO_W_NUMERIC' | 'RECO_W_COLLECTION'>): RecoWeights {
  return {
    genres: cfg.RECO_W_GENRES, tags: cfg.RECO_W_TAGS, studios: cfg.RECO_W_STUDIOS, people: cfg.RECO_W_PEOPLE,
    text: cfg.RECO_W_TEXT, numeric: cfg.RECO_W_NUMERIC, collection: cfg.RECO_W_COLLECTION,
  };
}

// ---------------------------------------------------------------------------------------------------------------- R2 coefficients

/** Which engine answers "because you watched" (RECO_ENGINE): v1 = Jellyfin similar(), v2 = own taste model, shadow = v2 beside v1, v1 returned. */
export type RecoEngine = 'v1' | 'v2' | 'shadow';
export const recoEngine = (cfg: Pick<Config, 'RECO_ENGINE'>): RecoEngine => cfg.RECO_ENGINE;

/** The score recipe of one surface: coefficient per component (spec 4.5). Inputs of c, t and d arrive with R3; their weights are already here. */
export interface SurfaceWeights {
  /** a: content affinity cos(pos) - 0.5 cos(neg) */
  affinity: number;
  /** b: similarity to the seed */
  seed: number;
  /** c: item-item co-occurrence (R3) */
  cooccurrence: number;
  /** t: transition "people watch this next" (R3) */
  transition: number;
  /** d: friends' ratings and recommendations (R3, never for kids) */
  friends: number;
  /** e: Bayesian-smoothed community rating */
  quality: number;
  /** f: freshness (recently added to the library) */
  fresh: number;
  /** trending this week (R3); capped to `trendingCap` of the whole score on every surface */
  trending: number;
}

export type Surface = 'postplay' | 'because' | 'taste' | 'detail_similar' | 'home_rows';
export const SURFACES: readonly Surface[] = ['postplay', 'because', 'taste', 'detail_similar', 'home_rows'];

/** Every coefficient of the engine. Names are dotted paths; RECO_COEFFS overrides any of them (see recoCoefficients). */
export interface RecoCoefficients {
  /** taste signals (spec 4.3), weight before recency decay */
  signal: {
    thumbUp2: number; thumbUp1: number; thumbDown: number;
    star5: number; star4: number; star3: number; star2: number; star1: number;
    finishedMovie: number; seriesCompletion: number; rewatch: number; favorite: number; watchlist: number;
    abandonedEarly: number; dropped: number;
    /** half-life of the recency decay in days: w * 0.5^(age/halfLifeDays) (RECO_HALF_LIFE_DAYS) */
    halfLifeDays: number;
  };
  profile: {
    /** fewer weighted interactions than this = cold start */
    coldStart: number;
    /** early abandonment: stopped below this percentage ... */
    abandonPct: number;
    /** ... and not back for this many days */
    abandonDays: number;
    /** favorites carry no date: assumed age in days */
    favoriteAgeDays: number;
    /** a movie counts as a rewatch when its viewing time is at least this many runtimes on 2 or more days */
    rewatchFactor: number;
    /** how much of the watch history is read (1..200) */
    historyLimit: number;
    /** dimensions kept per stored taste vector */
    topDims: number;
    /** weight of the negative vector in the affinity: cos(pos) - negWeight * cos(neg) */
    negWeight: number;
    /** seconds the cached taste profile lives */
    cacheTtlSeconds: number;
  };
  candidates: {
    /** Jellyfin similar() candidates per seed */
    similar: number;
    /** nearest neighbours of the profile vector (spec: 200) */
    knn: number;
    /** same collection / shared creator candidates per seed */
    universe: number;
    /** a "creator" = one of the first N people of the index row (directors, writers, creators come before actors) */
    creatorSlots: number;
    /** cold-start filler: best quality prior titles */
    prior: number;
  };
  score: {
    /** Bayesian smoothing of the community rating: library mean pseudo-vote weight and the votes assumed when the server reports none */
    ratingPriorVotes: number; ratingAssumedVotes: number; ratingPriorMean: number;
    /** quality prior maps the smoothed rating from [floor, ceil] to [0, 1] */
    ratingFloor: number; ratingCeil: number;
    /** freshness: half-life in days of "added to the library" */
    freshHalfLifeDays: number;
    /** weight of Jellyfin's own similar() rank inside the seed similarity (rest = index cosine) */
    jfRankShare: number;
    /** trending may be at most this share of the score on every surface */
    trendingCap: number;
  };
  penalty: {
    played: number; playedRewatchFriendly: number; dropped: number; watchlist: number; nearDuplicate: number;
    /** a profile whose rewatch share of positive weight is at least this counts as rewatch-friendly */
    rewatchFriendlyShare: number;
  };
  rank: {
    /** MMR trade-off: lambda * relevance - (1 - lambda) * similarity to the already chosen */
    lambda: number;
    /** at most this many per franchise / collection per row */
    perFranchise: number;
    /** at most this share of a row (rounded up, at least 2) may have the same dominant genre */
    genreShare: number;
    /** cosine at or above which a title is a near-duplicate of a chosen one */
    duplicateCos: number;
  };
  surface: Record<Surface, SurfaceWeights>;
}

const SW = (affinity: number, seed: number, quality: number, fresh: number, cooccurrence = 0, transition = 0, friends = 0, trending = 0): SurfaceWeights =>
  ({ affinity, seed, cooccurrence, transition, friends, quality, fresh, trending });

export const DEFAULT_RECO_COEFFICIENTS: Readonly<RecoCoefficients> = {
  signal: {
    thumbUp2: 3, thumbUp1: 1.5, thumbDown: -4, star5: 2.5, star4: 1.5, star3: 0, star2: -1, star1: -2,
    finishedMovie: 1, seriesCompletion: 2, rewatch: 1, favorite: 1, watchlist: 0.5, abandonedEarly: -1, dropped: -2, halfLifeDays: 120,
  },
  profile: { coldStart: 5, abandonPct: 15, abandonDays: 14, favoriteAgeDays: 60, rewatchFactor: 1.6, historyLimit: 200, topDims: 400, negWeight: 0.5, cacheTtlSeconds: 6 * 3600 },
  candidates: { similar: 30, knn: 200, universe: 40, creatorSlots: 3, prior: 60 },
  score: { ratingPriorVotes: 25, ratingAssumedVotes: 25, ratingPriorMean: 6.5, ratingFloor: 4, ratingCeil: 9, freshHalfLifeDays: 120, jfRankShare: 0.3, trendingCap: 0.1 },
  penalty: { played: 0.8, playedRewatchFriendly: 0.25, dropped: 1.5, watchlist: 0.4, nearDuplicate: 0.5, rewatchFriendlyShare: 0.15 },
  rank: { lambda: 0.7, perFranchise: 2, genreShare: 0.5, duplicateCos: 0.92 },
  surface: {
    // post-play: what comes next; seed similarity and transitions lead
    postplay: SW(0.3, 0.5, 0.08, 0.05, 0.15, 0.6, 0, 0.05),
    because: SW(0.3, 0.55, 0.1, 0.05, 0.1, 0, 0, 0.05),
    // taste: no seed
    taste: SW(0.7, 0, 0.15, 0.1, 0.1, 0, 0.15, 0.05),
    detail_similar: SW(0.1, 0.8, 0.07, 0.03, 0.1, 0, 0, 0),
    home_rows: SW(0.6, 0.1, 0.15, 0.1, 0.1, 0, 0.15, 0.05),
  },
};

/** Flat dotted names of every coefficient (what RECO_COEFFS may contain), e.g. "signal.thumbUp2" or "surface.because.seed". */
export const COEFFICIENT_NAMES: readonly string[] = (() => {
  const out: string[] = [];
  const walk = (o: object, p: string) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number') out.push(p + k);
      else walk(v as object, `${p}${k}.`);
    }
  };
  walk(DEFAULT_RECO_COEFFICIENTS, '');
  return out;
})();

/** Overrides are clamped to this range: a typo cannot turn a score into infinity. */
const OVERRIDE_LIMIT = 1000;

/** Parses RECO_COEFFS: a JSON object of dotted name -> number. Unknown names and non-finite values are ignored (never throws, never logs the text). */
export function parseCoeffOverrides(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw) return out;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return out; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  const known = new Set(COEFFICIENT_NAMES);
  for (const [k, v] of Object.entries(o)) {
    if (known.has(k) && typeof v === 'number' && Number.isFinite(v)) out.set(k, Math.max(-OVERRIDE_LIMIT, Math.min(OVERRIDE_LIMIT, v)));
  }
  return out;
}

/**
 * The coefficients in force: spec defaults, then RECO_HALF_LIFE_DAYS, then the RECO_COEFFS overrides. Returns a fresh object every call
 * (callers may keep it), already validated: the lambda lies in [0, 1], counts are at least 1.
 */
export function recoCoefficients(cfg?: Partial<Pick<Config, 'RECO_COEFFS' | 'RECO_HALF_LIFE_DAYS'>>): RecoCoefficients {
  const c = structuredClone(DEFAULT_RECO_COEFFICIENTS) as RecoCoefficients;
  if (typeof cfg?.RECO_HALF_LIFE_DAYS === 'number' && cfg.RECO_HALF_LIFE_DAYS > 0) c.signal.halfLifeDays = cfg.RECO_HALF_LIFE_DAYS;
  for (const [name, value] of parseCoeffOverrides(cfg?.RECO_COEFFS)) {
    const path = name.split('.');
    let node: Record<string, any> = c as unknown as Record<string, any>;
    for (const p of path.slice(0, -1)) node = node[p];
    node[path[path.length - 1]!] = value;
  }
  c.signal.halfLifeDays = Math.max(1, c.signal.halfLifeDays);
  c.rank.lambda = Math.max(0, Math.min(1, c.rank.lambda));
  c.rank.perFranchise = Math.max(1, Math.round(c.rank.perFranchise));
  c.rank.genreShare = Math.max(0.1, Math.min(1, c.rank.genreShare));
  c.profile.historyLimit = Math.max(1, Math.min(200, Math.round(c.profile.historyLimit)));
  c.profile.coldStart = Math.max(0, Math.round(c.profile.coldStart));
  c.profile.topDims = Math.max(10, Math.round(c.profile.topDims));
  c.score.trendingCap = Math.max(0, Math.min(0.5, c.score.trendingCap));
  c.score.ratingFloor = Math.min(c.score.ratingFloor, c.score.ratingCeil - 0.1);
  c.candidates.knn = Math.max(1, Math.round(c.candidates.knn));
  c.candidates.similar = Math.max(1, Math.round(c.candidates.similar));
  return c;
}
