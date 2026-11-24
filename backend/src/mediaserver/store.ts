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
/** the backend's phases of a move (stage 2): the updater copies (`copying`), then the backend's own phases, then `done` or `failed` */
export type MovePhase = 'copying' | 'nfo' | 'verify' | 'switch' | 'requests' | 'done' | 'failed';
/** the Jellyfin a move came from (container name and Jellyfin version, never a container or server id) and when it moved */
export interface MigratedFrom { name: string; version: string | null; at: string }
/** the id check of a move (`verify`): linked users checked and missing on the new server, item ids sampled and missing */
export interface IdCheck { users: { total: number; missing: number }; items: { sampled: number; missing: number } }
/**
 * a move as the backend follows it: its phase, the code it failed with, the updater job of its copy, when it started, and whether the
 * request service could not be pointed at the new server (Admin and the Systemcheck show the manual step). `errorMeta`: the numbers of
 * a failed id check (`ids_mismatch`); `abortPending`: the move failed and the updater has not taken its abort yet (the tick sends it
 * again until it does). Both are absent when unset.
 */
export interface MoveRecord {
  phase: MovePhase; error: string | null; jobId: string | null; startedAt: string; requestsWarning: boolean; errorMeta?: IdCheck; abortPending?: true;
}
/** the request service's Jellyfin connection before the move (the way back restores it); its API key is not part of it */
export interface RequestsPrev { hostname: string; port: number; useSsl: boolean; urlBase: string }
export interface MediaManaged {
  kind: Kind | null; setup: SetupStep; setupError: string | null; adminUser: string | null; hasPassword: boolean;
  libraries: LibraryEntry[]; externalUrl: string | null; hasExternalKey: boolean; updatedAt: string | null;
  migratedFrom: MigratedFrom | null; move: MoveRecord | null; requestsPrev: RequestsPrev | null;
}

const KINDS: readonly Kind[] = ['ferrofin', 'jellyfin'];
const LIBRARY_TYPES: readonly LibraryType[] = ['movies', 'tvshows', 'music', 'mixed'];
const STEPS: readonly SetupStep[] = ['none', 'applying', 'first_run', 'api_key', 'libraries', 'hwaccel', 'finishing', 'done', 'failed'];
export const MOVE_PHASES: readonly MovePhase[] = ['copying', 'nfo', 'verify', 'switch', 'requests', 'done', 'failed'];
const SLUG_RE = /^[a-z0-9-]{1,40}$/;
/** a Docker container name (without the leading slash Docker reports) */
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VERSION_RE = /^[0-9A-Za-z.+_-]{1,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
const JOB_ID_RE = /^[0-9a-f]{16}$/;
/** a host name or address as the request service stores it: no space, no control character, no path */
const HOSTNAME_RE = /^[A-Za-z0-9.:[\]_-]{1,253}$/;
const URL_BASE_RE = /^(\/[A-Za-z0-9._~%-]+){0,10}$/;

const DEFAULTS: MediaManaged = {
  kind: null, setup: 'none', setupError: null, adminUser: null, hasPassword: false, libraries: [], externalUrl: null, hasExternalKey: false, updatedAt: null,
  migratedFrom: null, move: null, requestsPrev: null,
};

interface Row {
  kind: string | null; setup: string; setup_error: string | null; admin_user: string | null; admin_password_enc: string | null;
  libraries: unknown; external_url: string | null; external_key_enc: string | null; updated_at: Date;
  migrated_from: unknown; move: unknown; requests_prev: unknown;
}

type Obj = Record<string, unknown>;
const objOf = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : null);
const re = (v: unknown, r: RegExp): string | null => (typeof v === 'string' && r.test(v) ? v : null);

/** the stored stage 2 values, field by field: a required field that does not fit drops the value, an optional one reads as null */
function migratedFrom(raw: unknown): MigratedFrom | null {
  const o = objOf(raw);
  const name = re(o?.name, CONTAINER_NAME_RE), at = re(o?.at, ISO_RE);
  return o && name && at ? { name, version: re(o.version, VERSION_RE), at } : null;
}
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
function idCheck(raw: unknown): IdCheck | null {
  const u = objOf(objOf(raw)?.users), i = objOf(objOf(raw)?.items);
  const total = count(u?.total), missing = count(u?.missing), sampled = count(i?.sampled), gone = count(i?.missing);
  return total !== null && missing !== null && sampled !== null && gone !== null ? { users: { total, missing }, items: { sampled, missing: gone } } : null;
}
function moveRecord(raw: unknown): MoveRecord | null {
  const o = objOf(raw);
  const phase = MOVE_PHASES.find((p) => p === o?.phase), startedAt = re(o?.startedAt, ISO_RE);
  if (!o || !phase || !startedAt) return null;
  const errorMeta = idCheck(o.errorMeta);
  return {
    phase, error: re(o.error, CODE_RE), jobId: re(o.jobId, JOB_ID_RE), startedAt, requestsWarning: o.requestsWarning === true,
    ...(errorMeta ? { errorMeta } : {}), ...(o.abortPending === true ? { abortPending: true as const } : {}),
  };
}
function requestsPrev(raw: unknown): RequestsPrev | null {
  const o = objOf(raw);
  const hostname = re(o?.hostname, HOSTNAME_RE), urlBase = typeof o?.urlBase === 'string' ? re(o.urlBase, URL_BASE_RE) : null;
  const port = o?.port;
  if (!o || !hostname || urlBase === null || typeof o.useSsl !== 'boolean' || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname, port, useSsl: o.useSsl, urlBase };
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
  const r = await db.query<Row>(`select kind, setup, setup_error, admin_user, admin_password_enc, libraries, external_url, external_key_enc, updated_at,
    migrated_from, move, requests_prev from media_managed where id = 1`);
  const row = r.rows[0];
  if (!row) return { ...DEFAULTS, libraries: [] };
  return {
    kind: KINDS.find((k) => k === row.kind) ?? null, setup: STEPS.find((s) => s === row.setup) ?? 'none', setupError: row.setup_error,
    adminUser: row.admin_user, hasPassword: row.admin_password_enc !== null, libraries: libraries(row.libraries),
    externalUrl: row.external_url, hasExternalKey: row.external_key_enc !== null, updatedAt: row.updated_at.toISOString(),
    migratedFrom: migratedFrom(row.migrated_from), move: moveRecord(row.move), requestsPrev: requestsPrev(row.requests_prev),
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
  const json = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));
  if ('migratedFrom' in patch) set('migrated_from', json(patch.migratedFrom));
  if ('move' in patch) set('move', json(patch.move));
  if ('requestsPrev' in patch) set('requests_prev', json(patch.requestsPrev));
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
