// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import type { Db } from '../db.js';
import { requireAdmin } from '../session.js';
import { deriveTokens, TOKENS_VERSION, type BrandTokens } from './colors.js';
import { BRAND_IMAGE_KINDS, BRAND_IMAGE_MAX_BYTES, BRAND_IMAGE_MIMES, BrandImageError, sanitizeImage, sniffBrandImage, type BrandImageKind, type BrandImageMime } from './images.js';
import { BrandConflict, IMAGE_FIELDS, readBrand, readImage, resetBrand, saveBrand, storeImage, type BrandState } from './repo.js';
import { brandPatchSchema, type Brand, type PublicBrand } from './schema.js';

/**
 * Admin → Branding (branding plan Task 1).
 * - GET /api/public/brand: no session, no CSRF, open during setup (app.ts SETUP_OPEN_GET): the sign-in page shows the brand before
 *   anyone is signed in. The public fields only (built field by field, never the stored row), the derived tokens and the image URLs;
 *   ETag = rev + tokens version, revalidated on every load (`no-cache`).
 * - GET /api/public/brand/img/<sha256>.<png|webp>: the sanitized bytes, immutable (the name is the content hash), own CSP, nosniff.
 * - the admin routes write: GET / PUT (rev-checked) / POST reset, and the raw-body image upload (the livetv logo pattern: the admin
 *   check runs before the body is read, the body is parsed in this context only, 413 / 415 with fixed codes).
 * Nothing here logs a value, an image byte or an account id; audit rows carry field names (and an upload's kind) only.
 * A save is not announced on the settings bus: that channel carries the settings rev, which every instance compares with its own, and
 * nothing in the backend caches the brand (each request reads the row), so other instances and browsers see the new rev on their next read.
 */

const IMAGE_FILE_RE = /^([0-9a-f]{64})\.(png|webp)$/;
const EXT: Record<BrandImageMime, string> = { 'image/png': 'png', 'image/webp': 'webp' };
export const IMAGE_CACHE = 'public, max-age=31536000, immutable';

export const brandImageUrl = (hash: string, mime: BrandImageMime) => `/api/public/brand/img/${hash}.${EXT[mime]}`;

/** exactly the public fields, by name: a stray key in the stored JSON or a later private field never leaks */
export function publicBrand(b: Brand): PublicBrand {
  return {
    name: b.name, byline: b.byline, shortName: b.shortName, website: b.website, about: b.about, header: b.header, accent: b.accent,
    glow: b.glow, signInBg: b.signInBg, logo: b.logo, symbol: b.symbol, signInImage: b.signInImage,
  };
}

type ImageUrls = { logo?: string; symbol?: string; signIn?: string };

/** the URLs of the brand's images that exist (with the extension of their stored type) */
async function imageUrls(db: Db, b: Brand): Promise<ImageUrls> {
  const hashes = IMAGE_FIELDS.map(([f]) => b[f]).filter((h): h is string => h !== null);
  if (!hashes.length) return {};
  const r = await db.query<{ hash: string; mime: BrandImageMime }>('select hash, mime from brand_images where hash = any($1::text[])', [hashes]);
  const mime = new Map(r.rows.map((x) => [x.hash, x.mime]));
  const out: ImageUrls = {};
  for (const [field, kind] of IMAGE_FIELDS) {
    const h = b[field];
    const m = h === null ? undefined : mime.get(h);
    if (h !== null && m) out[kind] = brandImageUrl(h, m);
  }
  return out;
}

interface BrandAnswer { rev: number; brand: PublicBrand; tokens: BrandTokens; images: ImageUrls }

async function answer(db: Db, s: BrandState): Promise<BrandAnswer> {
  return { rev: s.rev, brand: publicBrand(s.brand), tokens: deriveTokens(s.brand.accent), images: await imageUrls(db, s.brand) };
}

const etagOf = (rev: number) => `"brand-${rev}-${TOKENS_VERSION}"`;

/** If-None-Match names the current ETag (a proxy may have weakened it: W/ is ignored) */
function notModified(header: string | string[] | undefined, etag: string): boolean {
  const v = Array.isArray(header) ? header.join(',') : header;
  return !!v && v.split(',').some((t) => t.trim().replace(/^W\//, '') === etag || t.trim() === '*');
}

const putBody = z.object({ rev: z.number().int().min(0), brand: z.unknown() }).strict();

/** the first field a brand patch fails on (an unknown key names itself; a non-object is `brand`) */
function invalidField(brand: unknown): string | null {
  const r = brandPatchSchema.safeParse(brand);
  if (r.success) return null;
  const issue = r.error.issues[0]!;
  if (issue.code === 'unrecognized_keys') return String(issue.keys[0] ?? 'brand');
  return issue.path.length ? String(issue.path[0]) : 'brand';
}

const notFound = (reply: FastifyReply) => reply.code(404).header('cache-control', 'no-store').send({ error: 'not_found' });

export function brandRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- public ----
  app.get('/api/public/brand', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const s = await readBrand(ctx.db);
    const etag = etagOf(s.rev);
    reply.header('etag', etag).header('cache-control', 'no-cache');
    if (notModified(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return answer(ctx.db, s);
  });

  app.get('/api/public/brand/img/:file', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    // validated before any lookup: a lower-case sha256 and the extension of its stored type
    const m = IMAGE_FILE_RE.exec(String((req.params as { file?: string }).file ?? ''));
    if (!m) return notFound(reply);
    const img = await readImage(ctx.db, m[1]!);
    if (!img || EXT[img.mime] !== m[2]) return notFound(reply);
    return reply.header('content-type', img.mime).header('cache-control', IMAGE_CACHE).header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'").send(img.bytes);
  });

  // ---- admin ----
  const admin = { preHandler: requireAdmin(ctx) };
  const adminAnswer = async (s: BrandState) => ({ ...(await answer(ctx.db, s)), updatedAt: s.updatedAt });

  app.get('/api/admin/brand', admin, async () => adminAnswer(await readBrand(ctx.db)));

  app.put('/api/admin/brand', { ...admin, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = putBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const field = invalidField(body.data.brand);
    if (field) return reply.code(400).send({ error: 'invalid', field });
    try {
      return await adminAnswer(await saveBrand(ctx.db, req.user!.id, body.data.rev, brandPatchSchema.parse(body.data.brand)));
    } catch (e) {
      if (e instanceof BrandConflict) return reply.code(409).send({ error: 'brand_conflict', rev: e.rev });
      throw e;
    }
  });

  app.post('/api/admin/brand/reset', { ...admin, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) =>
    adminAnswer(await resetBrand(ctx.db, req.user!.id)));

  // the upload is a raw image body, parsed only in this context; anything else is 415, more than 2 MB is 413 (fixed codes)
  void app.register(async (sub) => {
    sub.addContentTypeParser([...BRAND_IMAGE_MIMES], { parseAs: 'buffer', bodyLimit: BRAND_IMAGE_MAX_BYTES }, (_req, body, done) => done(null, body));
    sub.setErrorHandler((err, _req, reply) => {
      const code = (err as { code?: string }).code;
      if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'too_large' });
      if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ error: 'unsupported_type' });
      throw err;
    });
    // the admin check runs before the body is read (onRequest): nobody else gets 2 MB parsed; the CSRF hook still runs (preHandler)
    sub.put('/api/admin/brand/image/:kind', {
      onRequest: requireAdmin(ctx), bodyLimit: BRAND_IMAGE_MAX_BYTES, config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const kind = String((req.params as { kind?: string }).kind ?? '') as BrandImageKind;
      if (!BRAND_IMAGE_KINDS.includes(kind)) return reply.code(404).send({ error: 'not_found' });
      const declared = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      // the magic bytes must agree with the declared type
      if (!Buffer.isBuffer(req.body) || sniffBrandImage(req.body) !== declared) return reply.code(415).send({ error: 'unsupported_type' });
      let img;
      try {
        img = sanitizeImage(req.body, kind);
      } catch (e) {
        if (!(e instanceof BrandImageError)) throw e;
        if (e.code === 'type') return reply.code(415).send({ error: 'unsupported_type' });
        if (e.code === 'size') return reply.code(413).send({ error: 'too_large' });
        return reply.code(400).send({ error: e.code });
      }
      if (await storeImage(ctx.db, img)) await audit(ctx, req.user!.id, 'brand.image', undefined, { kind });
      return { hash: img.hash, url: brandImageUrl(img.hash, img.mime), width: img.width, height: img.height };
    });
  });
}

