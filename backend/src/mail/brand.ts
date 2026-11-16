// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { deriveTokens } from '../brand/colors.js';
import { readBrand, readImage } from '../brand/repo.js';
import type { Ctx } from '../ctx.js';

/** the largest symbol that travels inline (spec "Logo"); a bigger or non-PNG one is replaced by the letter tile */
export const MAX_INLINE_SYMBOL_BYTES = 200 * 1024;

/** the brand as the mail layout needs it */
export interface MailBrand {
  name: string;
  byline: string;
  website: string;
  /** the contrast-safe fill of the accent (the accent bar, the button, the letter tile) */
  fill: string;
  /** first character of the name, upper-cased: the letter tile when there is no inline symbol */
  letter: string;
  symbol: { cid: 'brand-symbol'; png: Buffer } | null;
  /** legal links; Branding stage B adds the fields */
  legal: { imprint?: string; privacy?: string; help?: string };
}

export async function mailBrand(ctx: Pick<Ctx, 'db'>): Promise<MailBrand> {
  const { brand } = await readBrand(ctx.db);
  const img = brand.symbol ? await readImage(ctx.db, brand.symbol) : null;
  const symbol = img && img.mime === 'image/png' && img.bytes.length <= MAX_INLINE_SYMBOL_BYTES ? { cid: 'brand-symbol' as const, png: img.bytes } : null;
  const first = [...brand.name][0] ?? '?';
  return {
    name: brand.name, byline: brand.byline, website: brand.website,
    fill: deriveTokens(brand.accent).accFill, letter: first.toUpperCase(), symbol, legal: {},
  };
}
