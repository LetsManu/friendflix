// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import type { Request } from '@playwright/test';

/**
 * Admin → Branding (backend/src/brand/routes.ts): GET / PUT /api/admin/brand, POST …/reset, PUT …/image/:kind. The admin routes work
 * on the same answer the public route serves (`brand`, mocks/api.ts st.brand), so a save shows up in GET /api/public/brand.
 * Not an admin: 403. Specs can force a conflict (409 brand_conflict, after another admin's save), a 400 for one field, or an upload's
 * error answer (the backend's codes: 413 too_large, 415 unsupported_type, 400 dimensions / corrupt).
 * The answers have the backend's shape (routes.ts adminAnswer): rev, brand, tokens, images by kind (logo, symbol, signIn), updatedAt;
 * an upload answers hash, url, width, height.
 */
export interface BrandAdminMock {
  /** PUT bodies */
  puts: Array<{ rev: number; brand: Record<string, unknown> }>;
  /** POST reset bodies */
  resets: unknown[];
  /** image uploads: kind, content-type, size and the PNG header's dimensions (0 when not a PNG) */
  uploads: Array<{ kind: string; type: string; bytes: number; width: number; height: number }>;
  /** the next PUT or reset answers 409: another admin saved meanwhile (this name, the rev goes up by one) */
  conflict: string | null;
  /** the next PUT answers 400 invalid for this field */
  invalidField: string | null;
  /** the next image upload answers this error (after recording it) */
  uploadError: { status: 400 | 413 | 415; error: 'too_large' | 'unsupported_type' | 'dimensions' | 'corrupt' } | null;
  /** the next PUT or reset first saves this brand as another admin would (the rev goes up), then answers 409 */
  conflictBrand: Record<string, unknown> | null;
  /** the next GET /api/admin/brand answers 500 (the reload after a 409 fails) */
  getFails: boolean;
}

export const brandAdminState = (): BrandAdminMock => ({ puts: [], resets: [], uploads: [], conflict: null, invalidField: null, uploadError: null, conflictBrand: null, getFails: false });

const DEFAULT_TOKENS = { acc: '#ff4f6d', accHover: '#e63e5c', accFill: '#d6325a', accFillHover: '#c9304d', accText: '#ff4f6d', accLight: '#ff8aa0', accLine: '#ff9cad', adjusted: { text: false, fill: true } };
const BLUE = { acc: '#4c9dff', accHover: '#2d8cff', accFill: '#006ff4', accFillHover: '#0063db', accText: '#4c9dff', accLight: '#89bfff', accLine: '#99c7ff', adjusted: { text: false, fill: true } };
const DEFAULT_FIELDS = { name: 'FriendFlix', byline: '', shortName: '', website: '', about: '', header: 'wordmark', accent: '#ff4f6d', glow: 'accentViolet', signInBg: 'posters', logo: null, symbol: null, signInImage: null };
const IMAGE_FIELDS: Array<[string, string]> = [['logo', 'logo'], ['symbol', 'symbol'], ['signInImage', 'signIn']];

type Answer = { rev: number; brand: Record<string, unknown>; tokens: Record<string, unknown>; images: Record<string, string> };
type J = (b: unknown, status?: number) => Promise<void>;

const tokensFor = (accent: unknown, prev: Record<string, unknown>) => (accent === '#4c9dff' ? structuredClone(BLUE) : accent === '#ff4f6d' ? structuredClone(DEFAULT_TOKENS) : prev);
const imagesFor = (b: Record<string, unknown>) => Object.fromEntries(IMAGE_FIELDS.filter(([f]) => typeof b[f] === 'string').map(([f, k]) => [k, `/api/public/brand/img/${b[f]}.png`]));
const admin = (a: Answer) => ({ ...structuredClone(a), updatedAt: '2026-11-15T10:00:00Z' });

/** the brand admin routes; null for any other path */
export function brandAdminRoute(st: { brand: Record<string, unknown>; brandAdmin: BrandAdminMock; asAdmin: boolean }, m: string, p: string, req: Request, body: () => any, J: J): Promise<void> | null {
  if (!p.startsWith('/api/admin/brand')) return null;
  if (!st.asAdmin) return J({ error: 'forbidden' }, 403);
  const a = st.brand as unknown as Answer;
  const s = st.brandAdmin;
  const conflict = () => {
    a.rev += 1;
    a.brand = { ...a.brand, ...(s.conflict !== null ? { name: s.conflict } : {}), ...(s.conflictBrand ?? {}) };
    s.conflict = null;
    s.conflictBrand = null;
    return J({ error: 'brand_conflict', rev: a.rev }, 409);
  };
  const conflicting = () => s.conflict !== null || s.conflictBrand !== null;
  if (p === '/api/admin/brand' && m === 'GET') {
    if (s.getFails) { s.getFails = false; return J({ error: 'internal' }, 500); }
    return J(admin(a));
  }
  if (p === '/api/admin/brand' && m === 'PUT') {
    const b = body();
    s.puts.push(b);
    if (typeof b.rev !== 'number') return J({ error: 'bad_request' }, 400);
    if (conflicting()) return conflict();
    if (b.rev !== a.rev) return J({ error: 'brand_conflict', rev: a.rev }, 409);
    if (s.invalidField) { const field = s.invalidField; s.invalidField = null; return J({ error: 'invalid', field }, 400); }
    const changed = Object.keys(b.brand ?? {}).some((k) => JSON.stringify(a.brand[k]) !== JSON.stringify(b.brand[k]));
    a.brand = { ...a.brand, ...b.brand };
    a.tokens = tokensFor(a.brand.accent, a.tokens);
    a.images = imagesFor(a.brand);
    if (changed) a.rev += 1;
    return J(admin(a));
  }
  if (p === '/api/admin/brand/reset' && m === 'POST') {
    const b = body();
    s.resets.push(b);
    if (typeof b.rev !== 'number') return J({ error: 'bad_request' }, 400);
    if (conflicting()) return conflict();
    if (b.rev !== a.rev) return J({ error: 'brand_conflict', rev: a.rev }, 409);
    a.brand = { ...DEFAULT_FIELDS };
    a.tokens = structuredClone(DEFAULT_TOKENS);
    a.images = {};
    a.rev += 1;
    return J(admin(a));
  }
  const mm = p.match(/^\/api\/admin\/brand\/image\/([A-Za-z]+)$/);
  if (mm && m === 'PUT') {
    const kind = mm[1]!;
    if (!['symbol', 'logo', 'signIn'].includes(kind)) return J({ error: 'not_found' }, 404);
    const buf = req.postDataBuffer() ?? Buffer.alloc(0);
    const type = req.headers()['content-type'] ?? '';
    const png = buf.length > 24 && buf.subarray(1, 4).toString('latin1') === 'PNG';
    const width = png ? buf.readUInt32BE(16) : 0, height = png ? buf.readUInt32BE(20) : 0;
    s.uploads.push({ kind, type, bytes: buf.length, width, height });
    if (s.uploadError) { const { status, error } = s.uploadError; s.uploadError = null; return J({ error }, status); }
    if (type !== 'image/png' && type !== 'image/webp') return J({ error: 'unsupported_type' }, 415);
    const hash = createHash('sha256').update(buf).digest('hex');
    return J({ hash, url: `/api/public/brand/img/${hash}.png`, width, height });
  }
  return J({ error: 'not_found' }, 404);
}
