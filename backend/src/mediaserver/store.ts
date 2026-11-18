// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import { decrypt, encrypt } from '../crypto.js';
import type { Db } from '../db.js';

/**
 * The backend's half of managed mode (migration 60, spec "Backend storage"): one row. The admin password and the external server's
 * key are stored encrypted (crypto.encrypt) and never leave this module except through adminPassword() / externalKey().
 */

export type Kind = 'ferrofin' | 'jellyfin';
export type LibraryType = 'movies' | 'tvshows' | 'music' | 'mixed';
export type SetupStep = 'none' | 'applying' | 'first_run' | 'api_key' | 'libraries' | 'hwaccel' | 'finishing' | 'done' | 'failed';
export interface LibraryEntry { slug: string; name: string; type: LibraryType; rel: string; created: boolean }
export interface MediaManaged {
  kind: Kind | null; setup: SetupStep; setupError: string | null; adminUser: string | null; hasPassword: boolean;
  libraries: LibraryEntry[]; externalUrl: string | null; hasExternalKey: boolean; updatedAt: string | null;
}

const KINDS: readonly Kind[] = ['ferrofin', 'jellyfin'];
const LIBRARY_TYPES: readonly LibraryType[] = ['movies', 'tvshows', 'music', 'mixed'];
const STEPS: readonly SetupStep[] = ['none', 'applying', 'first_run', 'api_key', 'libraries', 'hwaccel', 'finishing', 'done', 'failed'];
const SLUG_RE = /^[a-z0-9-]{1,40}$/;

const DEFAULTS: MediaManaged = {
  kind: null, setup: 'none', setupError: null, adminUser: null, hasPassword: false, libraries: [], externalUrl: null, hasExternalKey: false, updatedAt: null,
};

interface Row {
  kind: string | null; setup: string; setup_error: string | null; admin_user: string | null; admin_password_enc: string | null;
  libraries: unknown; external_url: string | null; external_key_enc: string | null; updated_at: Date;
}

/** the stored libraries, field by field (a row written by another build never reaches a caller with a bad shape) */
function libraries(raw: unknown): LibraryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): LibraryEntry[] => {
    const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
    const type = LIBRARY_TYPES.find((t) => t === o.type);
    if (typeof o.slug !== 'string' || !SLUG_RE.test(o.slug) || typeof o.name !== 'string' || !type) return [];
    return [{ slug: o.slug, name: o.name, type, rel: typeof o.rel === 'string' ? o.rel : '', created: o.created === true }];
  });
}

export async function readManaged(db: Db): Promise<MediaManaged> {
  const r = await db.query<Row>('select kind, setup, setup_error, admin_user, admin_password_enc, libraries, external_url, external_key_enc, updated_at from media_managed where id = 1');
  const row = r.rows[0];
  if (!row) return { ...DEFAULTS, libraries: [] };
  return {
    kind: KINDS.find((k) => k === row.kind) ?? null, setup: STEPS.find((s) => s === row.setup) ?? 'none', setupError: row.setup_error,
    adminUser: row.admin_user, hasPassword: row.admin_password_enc !== null, libraries: libraries(row.libraries),
    externalUrl: row.external_url, hasExternalKey: row.external_key_enc !== null, updatedAt: row.updated_at.toISOString(),
  };
}

export type ManagedPatch = Partial<Omit<MediaManaged, 'hasPassword' | 'hasExternalKey' | 'updatedAt'>> & { adminPassword?: string | null; externalKey?: string | null };

/** upserts the one row; only the fields the patch names change (null clears one) */
export async function writeManaged(ctx: Pick<Ctx, 'db' | 'encKey'>, patch: ManagedPatch): Promise<void> {
  const cols: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown): void => { cols.push(col); vals.push(v); };
  if ('kind' in patch) set('kind', patch.kind ?? null);
  if ('setup' in patch && patch.setup !== undefined) set('setup', patch.setup);
  if ('setupError' in patch) set('setup_error', patch.setupError ?? null);
  if ('adminUser' in patch) set('admin_user', patch.adminUser ?? null);
  if ('adminPassword' in patch) set('admin_password_enc', patch.adminPassword == null ? null : encrypt(ctx.encKey, patch.adminPassword));
  if ('libraries' in patch && patch.libraries !== undefined) set('libraries', JSON.stringify(patch.libraries));
  if ('externalUrl' in patch) set('external_url', patch.externalUrl ?? null);
  if ('externalKey' in patch) set('external_key_enc', patch.externalKey == null ? null : encrypt(ctx.encKey, patch.externalKey));
  const names = cols.length ? `, ${cols.join(', ')}` : '';
  const params = cols.length ? `, ${cols.map((_, i) => `$${i + 1}`).join(', ')}` : '';
  const update = [...cols.map((c) => `${c} = excluded.${c}`), 'updated_at = now()'].join(', ');
  await ctx.db.query(`insert into media_managed(id${names}) values (1${params}) on conflict (id) do update set ${update}`, vals);
}

async function secret(ctx: Pick<Ctx, 'db' | 'encKey'>, col: 'admin_password_enc' | 'external_key_enc'): Promise<string | null> {
  const r = await ctx.db.query<{ v: string | null }>(`select ${col} as v from media_managed where id = 1`);
  const v = r.rows[0]?.v;
  if (!v) return null;
  try { return decrypt(ctx.encKey, v); } catch { return null; }
}
export const adminPassword = (ctx: Pick<Ctx, 'db' | 'encKey'>): Promise<string | null> => secret(ctx, 'admin_password_enc');

/**
 * Stores `candidate` as the administrator password only while none is stored, and answers the stored one: two first runs at once
 * both send the password the server was (or will be) created with. A stored value that cannot be decrypted is replaced.
 */
export async function claimAdminPassword(ctx: Pick<Ctx, 'db' | 'encKey'>, user: string, candidate: string): Promise<string> {
  await ctx.db.query(`insert into media_managed(id, admin_user, admin_password_enc) values (1, $1, $2)
    on conflict (id) do update set admin_user = excluded.admin_user, admin_password_enc = excluded.admin_password_enc, updated_at = now()
    where media_managed.admin_password_enc is null`, [user, encrypt(ctx.encKey, candidate)]);
  const stored = await adminPassword(ctx);
  if (stored) return stored;
  await writeManaged(ctx, { adminUser: user, adminPassword: candidate });
  return candidate;
}
export const externalKey = (ctx: Pick<Ctx, 'db' | 'encKey'>): Promise<string | null> => secret(ctx, 'external_key_enc');

const UMLAUTS: Record<string, string> = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' };

/** the folder slug of a library name: lower case, umlauts transliterated, anything else non [a-z0-9] a dash, at most 40; clashes get -2, -3 … */
export function slugFor(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[äöüß]/g, (c) => UMLAUTS[c]!).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'bibliothek';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const s = `${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(s)) return s;
  }
}

/** whether FriendFlix data depends on the current media server's ids (a user, or a profile linked to a media server user): then a fresh managed server is refused (Controller's call 10) */
export async function idsInUse(db: Db): Promise<boolean> {
  const r = await db.query<{ used: boolean }>(
    "select (exists (select 1 from users where jellyfin_user_id <> '') or exists (select 1 from profiles where jellyfin_user_id is not null and jellyfin_user_id <> '')) as used");
  return r.rows[0]?.used === true;
}
