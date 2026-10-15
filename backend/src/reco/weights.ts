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
