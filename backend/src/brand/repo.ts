// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import { auditInTx } from '../audit.js';
import type { Db } from '../db.js';
import { HttpError, InvalidField } from '../users.js';
import { dimensionsOk, type BrandImageKind, type BrandImageMime, type SanitizedImage } from './images.js';
import { BRAND_KEYS, brandFromStored, DEFAULT_BRAND, type Brand } from './schema.js';

/**
 * The brand row and the image store (migration 56). Every write runs in one transaction with the row locked: the rev check, the change,
 * its audit entry (field names only, never values or bytes) and the clean-up of unreferenced images commit together or not at all.
 */

export interface BrandState { rev: number; brand: Brand; updatedAt: string | null }

/** the brand fields that hold an image hash, with the kind whose size rules the image must meet */
export const IMAGE_FIELDS: ReadonlyArray<readonly ['logo' | 'symbol' | 'signInImage', BrandImageKind]> = [['logo', 'logo'], ['symbol', 'symbol'], ['signInImage', 'signIn']];

/** images no brand refers to are deleted after this long (an upload waits for the save that sets it) */
export const UNREFERENCED_IMAGE_TTL = '1 hour';

/** a save against an older rev: someone else saved in between (409 brand_conflict, with the current rev) */
export class BrandConflict extends HttpError {
  constructor(readonly rev: number) { super(409, 'brand_conflict'); }
}

export async function readBrand(db: Db): Promise<BrandState> {
  const r = await db.query<{ data: unknown; rev: string; updated_at: Date | null }>('select data, rev, updated_at from brand where id = 1');
  const row = r.rows[0];
  if (!row) return { rev: 0, brand: { ...DEFAULT_BRAND }, updatedAt: null };
  return { rev: Number(row.rev), brand: brandFromStored(row.data), updatedAt: row.updated_at?.toISOString() ?? null };
}

async function inTx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await (db as pg.Pool).connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** the locked current row (created with the defaults when there is none yet) */
async function lockBrand(c: pg.PoolClient): Promise<{ rev: number; brand: Brand }> {
  await c.query(`insert into brand(id, data, rev) values (1, $1, 0) on conflict (id) do nothing`, [JSON.stringify(DEFAULT_BRAND)]);
  const r = await c.query<{ data: unknown; rev: string }>('select data, rev from brand where id = 1 for update');
  return { rev: Number(r.rows[0]!.rev), brand: brandFromStored(r.rows[0]!.data) };
}

const changedFields = (a: Brand, b: Brand) => BRAND_KEYS.filter((k) => a[k] !== b[k]).sort();

/** stores `next` when it differs (rev + 1, audit `action` with the changed field names), then drops unreferenced images */
async function write(c: pg.PoolClient, actor: string, cur: { rev: number; brand: Brand }, next: Brand, action: string): Promise<BrandState> {
  const fields = changedFields(cur.brand, next);
  if (!fields.length) {
    const r = await c.query<{ updated_at: Date | null }>('select updated_at from brand where id = 1');
    return { rev: cur.rev, brand: cur.brand, updatedAt: r.rows[0]?.updated_at?.toISOString() ?? null };
  }
  const r = await c.query<{ rev: string; updated_at: Date }>(
    'update brand set data = $1, rev = rev + 1, updated_at = now(), updated_by = $2 where id = 1 returning rev, updated_at', [JSON.stringify(next), actor]);
  await auditInTx({ db: c }, actor, action, undefined, { fields });
  const keep = IMAGE_FIELDS.map(([f]) => next[f]).filter((h): h is string => h !== null);
  await c.query(`delete from brand_images where created_at < now() - interval '${UNREFERENCED_IMAGE_TTL}' and not (hash = any($1::text[]))`, [keep]);
  return { rev: Number(r.rows[0]!.rev), brand: next, updatedAt: r.rows[0]!.updated_at.toISOString() };
}

/**
 * Saves the changed fields of an admin's PUT (a validated patch) against the rev the admin's page loaded. An image field must name a
 * stored image whose size suits its kind (InvalidField otherwise); a stale rev throws BrandConflict.
 */
export async function saveBrand(db: Db, actor: string, rev: number, patch: Partial<Brand>): Promise<BrandState> {
  return inTx(db, async (c) => {
    const cur = await lockBrand(c);
    if (cur.rev !== rev) throw new BrandConflict(cur.rev);
    const next: Brand = { ...cur.brand, ...patch };
    for (const [field, kind] of IMAGE_FIELDS) {
      const hash = next[field];
      if (hash === null || hash === cur.brand[field]) continue;
      const img = await c.query<{ width: number; height: number }>('select width, height from brand_images where hash = $1', [hash]);
      const row = img.rows[0];
      if (!row || !dimensionsOk(kind, row.width, row.height)) throw new InvalidField(field);
    }
    return write(c, actor, cur, next, 'brand.update');
  });
}

/** back to the defaults (audited as brand.reset with the fields that changed) */
export async function resetBrand(db: Db, actor: string): Promise<BrandState> {
  return inTx(db, async (c) => write(c, actor, await lockBrand(c), { ...DEFAULT_BRAND }, 'brand.reset'));
}

/**
 * Stores a sanitized image once per hash. The same bytes again only renew its age, so an old unreferenced copy is not cleaned up
 * before the save that sets it. true = it was new.
 */
export async function storeImage(db: Db, img: SanitizedImage): Promise<boolean> {
  const r = await db.query<{ inserted: boolean }>(
    `insert into brand_images(hash, mime, width, height, bytes) values ($1, $2, $3, $4, $5)
     on conflict (hash) do update set created_at = now() returning (xmax = 0) as inserted`,
    [img.hash, img.mime, img.width, img.height, img.bytes]);
  return r.rows[0]?.inserted === true;
}

export async function readImage(db: Db, hash: string): Promise<{ mime: BrandImageMime; bytes: Buffer } | null> {
  const r = await db.query<{ mime: BrandImageMime; bytes: Buffer }>('select mime, bytes from brand_images where hash = $1', [hash]);
  return r.rows[0] ?? null;
}
