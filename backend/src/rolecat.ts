// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import { auditInTx } from './audit.js';
import type { Ctx } from './ctx.js';
import { DEFAULT_PERMS, PERM_KEYS } from './perms.js';
import { invalidateRights, roleRights } from './rights.js';
import { HttpError, setRole } from './users.js';
// roles.ts and rolecat.ts import each other (invalidateRoles clears the catalogue; the catalogue needs DEFAULT_ROLES): neither may use
// the other's exports at module load, only inside functions
import { DEFAULT_ROLES, LEGACY_COLUMNS, TEMPLATE_KEYS, invalidateRoles, legacyColumns, own, readTemplate } from './roles.js';

/**
 * The role catalogue (table `roles`, migration 47): which roles exist, their order, label, base and whether invites may offer them.
 * Built-ins are seeded by the migration, env roles (ROLE_TEMPLATES keys) are inserted by syncRoles at startup, admin roles by the
 * role editor. A role that left ROLE_TEMPLATES keeps its row (accounts may still hold it).
 */
export const ROLE_KEY_RE = /^[a-z][a-z0-9_-]{1,23}$/;
/** `order` would be shadowed by PUT /api/admin/roles/order */
export const RESERVED_ROLE_KEYS = ['order'] as const;

export interface RoleRow {
  key: string;
  /** null = the built-in / env label (catalogueLabel) */
  label: string | null;
  /** the built-in role whose code defaults apply below the role's own template */
  base: string;
  origin: 'code' | 'env' | 'admin';
  invitable: boolean;
  position: number;
  createdAt: string;
}

type CatCtx = Pick<Ctx, 'db' | 'roles'>;

const TTL_MS = 30_000;
const cache = new WeakMap<object, { at: number; rows: RoleRow[] }>();

const storable = (key: string) => ROLE_KEY_RE.test(key) && !(RESERVED_ROLE_KEYS as readonly string[]).includes(key);
const baseOf = (key: string) => (Object.hasOwn(DEFAULT_ROLES, key) ? key : 'friend');

async function storedRoles(ctx: CatCtx): Promise<RoleRow[]> {
  const c = cache.get(ctx);
  if (c && Date.now() - c.at <= TTL_MS) return c.rows;
  const r = await ctx.db.query<{ key: string; label: string | null; base: string; origin: RoleRow['origin']; invitable: boolean; position: number; created_at: Date }>(
    'select key, label, base, origin, invitable, position, created_at from roles order by position, key');
  const rows = r.rows.map((x) => ({ key: x.key, label: x.label, base: x.base, origin: x.origin, invitable: x.invitable, position: x.position, createdAt: x.created_at.toISOString() }));
  cache.set(ctx, { at: Date.now(), rows });
  return rows;
}

/**
 * Every role in catalogue order (position, key); the rows are cached ~30 s per ctx. A ctx.roles key without a row (syncRoles has not
 * run yet, or it cannot be stored: reserved or not a valid key) is appended in memory as an env role, so accounts holding it keep
 * working; only a storable one is offered to invites. Always a fresh list of fresh rows (callers may sort or change it).
 */
export async function listRoles(ctx: CatCtx): Promise<RoleRow[]> {
  const rows = (await storedRoles(ctx)).map((r) => ({ ...r }));
  const known = new Set(rows.map((r) => r.key));
  const extra = Object.keys(ctx.roles).filter((k) => !known.has(k));
  if (!extra.length) return rows;
  let pos = rows.reduce((m, r) => Math.max(m, r.position), -1);
  const at = new Date().toISOString();
  return [...rows, ...extra.map((key): RoleRow => ({ key, label: null, base: baseOf(key), origin: 'env', invitable: storable(key) && key !== 'admin', position: ++pos, createdAt: at }))];
}

export async function roleExists(ctx: CatCtx, key: string): Promise<boolean> {
  return (await listRoles(ctx)).some((r) => r.key === key);
}

/** the role keys invites and approvals may offer, in catalogue order (admin never) */
export async function invitableRoles(ctx: CatCtx): Promise<string[]> {
  return (await listRoles(ctx)).filter((r) => r.invitable && r.key !== 'admin').map((r) => r.key);
}

/** the configured label of a role (roleLabel() translates a built-in default): row label ← ROLE_TEMPLATES label ← built-in label of its base */
export async function catalogueLabel(ctx: CatCtx, key: string): Promise<string | undefined> {
  return (await roleLabelArgs(ctx, key))[1];
}

/**
 * The arguments of i18n roleLabel(lang, …) for a role: its own key with the configured label, or, for a role whose label falls back
 * to its base (an env role that left ROLE_TEMPLATES, label not set), the base key, so the built-in label is translated.
 */
export async function roleLabelArgs(ctx: CatCtx, key: string): Promise<[role: string, configured: string | undefined, builtinGerman: string | undefined]> {
  const row = (await listRoles(ctx)).find((r) => r.key === key);
  const label = row?.label ?? (row ? own(ctx.roles, key)?.label : undefined);
  if (label !== undefined || !row) return [key, label, own(DEFAULT_ROLES, key)?.label];
  const base = own(DEFAULT_ROLES, row.base)?.label;
  return [base ? row.base : key, base, base];
}

/**
 * Startup (after migrate): inserts every ROLE_TEMPLATES key without a row as an env role after the last position. Reserved keys and
 * keys the table cannot hold are skipped with one warning (no key in the log). Idempotent; several instances may run it at once.
 */
export async function syncRoles(ctx: CatCtx): Promise<{ added: string[] }> {
  const keys = Object.keys(ctx.roles);
  const skipped = keys.filter((k) => !storable(k));
  if (skipped.length) console.warn('role key skipped');
  const added: string[] = [];
  for (const key of keys.filter(storable)) {
    const r = await ctx.db.query(
      `insert into roles(key, base, origin, invitable, position)
       select $1, $2, 'env', true, coalesce(max(position), -1) + 1 from roles
       on conflict (key) do nothing returning key`, [key, baseOf(key)]);
    if (r.rowCount) added.push(key);
  }
  if (added.length) invalidateCatalogue(ctx);
  return { added };
}

export const invalidateCatalogue = (ctx: object) => void cache.delete(ctx);

const MARKS = /\p{M}/gu;

/**
 * The hidden key of a new role from its label: NFKD, ß/æ/ø transliterated, marks stripped, lower-case, runs of anything but [a-z0-9]
 * become `-`, at most 21 characters, starting with a letter (else `r-` first), `role` when nothing is left; reserved keys and keys in
 * `taken` get `-2`, `-3` … The result always matches ROLE_KEY_RE.
 */
export function slugKey(label: string, taken: ReadonlySet<string>): string {
  let k = label.normalize('NFKD').toLowerCase().replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(MARKS, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!k) k = 'role';
  else if (!/^[a-z]/.test(k) || k.length < 2) k = `r-${k}`;
  // the stem is cut after the prefix and leaves room for the suffix: the whole key stays within ROLE_KEY_RE's 24 characters
  const fit = (suffix: string) => `${k.slice(0, Math.min(21, 24 - suffix.length)).replace(/-+$/, '')}${suffix}`;
  const free = (c: string) => !taken.has(c) && !(RESERVED_ROLE_KEYS as readonly string[]).includes(c);
  if (free(fit(''))) return fit('');
  for (let n = 2; ; n++) if (free(fit(`-${n}`))) return fit(`-${n}`);
}

const lockRole = (c: pg.PoolClient, key: string) => c.query('select pg_advisory_xact_lock(hashtext($1))', [`role:${key}`]);

/**
 * Duplicates a role (spec §4.2): a new admin role holding a full snapshot of the source's effective template, switches and wish limit
 * (later edits of the source do not reach it). The source is read under its role lock. Admin rights belong to the key `admin`, so a
 * copy of admin has base `family`, the family switches (only admin's numbers are copied) and is invitable; every other copy keeps the source's base and invitable flag. Returns the new key.
 */
export async function createRole(ctx: Ctx, actor: string | null, label: string, from: string): Promise<string> {
  if (!(await roleExists(ctx, from))) throw new HttpError(404, 'not_found');
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    await lockRole(c, from);
    const tx = { db: c, roles: ctx.roles };
    const src = (await c.query<{ base: string; invitable: boolean }>('select base, invitable from roles where key=$1', [from])).rows[0];
    const rights = await roleRights(tx, from);
    if (!rights) throw new HttpError(404, 'not_found');
    const isAdmin = from === 'admin';
    const base = isAdmin ? 'family' : src?.base ?? (Object.hasOwn(DEFAULT_ROLES, from) ? from : 'friend');
    const invitable = isAdmin ? true : src?.invitable ?? true;
    const template = Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, rights.template[k]]));
    const perms = Object.fromEntries(PERM_KEYS.map((k) => [k, (isAdmin ? DEFAULT_PERMS.family : rights.perms)[k]]));
    const cols = Object.values(LEGACY_COLUMNS);
    let key = '';
    for (let attempt = 0; attempt < 5 && !key; attempt++) {
      const taken = new Set((await c.query<{ key: string }>('select key from roles')).rows.map((r) => r.key));
      for (const k of Object.keys(ctx.roles)) taken.add(k);
      const candidate = slugKey(label, taken);
      await c.query('savepoint ins');
      const ins = await c.query(
        `insert into roles(key, label, base, origin, invitable, position, created_by)
         select $1, $2, $3, 'admin', $4, coalesce(max(position), -1) + 1, $5 from roles on conflict (key) do nothing returning key`,
        [candidate, label, base, invitable, actor]);
      if (ins.rowCount) key = candidate;
      await c.query('release savepoint ins');
    }
    if (!key) throw new HttpError(409, 'key_conflict');
    await c.query(
      `insert into role_settings(role, requests_per_month, template, perms, ${cols.join(', ')}) values ($1, $2, $3, $4, ${cols.map((_, i) => `$${i + 5}`).join(', ')})`,
      [key, rights.template.requestsPerMonth, JSON.stringify(template), JSON.stringify(perms), ...legacyColumns(readTemplate(template))]);
    await auditInTx({ db: c }, actor, 'role.create', key, { from, label });
    await c.query('commit');
    invalidateRoles(ctx);
    invalidateRights();
    return key;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** 409 role_in_use: accounts or open invites still hold the role and no target was given */
export class RoleInUse extends Error {
  // not an HttpError: users.ts imports this module, so no class here may extend one at load time
  readonly statusCode = 409;
  constructor(readonly accounts: number, readonly invites: number) { super('role_in_use'); }
}

/**
 * Deletes an admin role (spec §2). Built-ins and a role still in ROLE_TEMPLATES cannot be deleted. Accounts and open invites need
 * `moveTo`: one transaction (holding the role locks of both roles in key order, so a concurrent role write waits and then finds the role
 * gone) moves every invite of the role (open, used-up or expired: a released invite is reopened), then each account through setRole
 * (audited user.role), then removes the rows and audits role.delete. `admin` is never a target (admin is never invitable).
 * The account moves run on pool connections, each committed and audited on its own, and hold both role locks across the media server
 * calls. If one fails, earlier accounts stay moved while the role, its invites and the audit entry roll back (no role.delete entry);
 * a retry finishes the job. Redemptions take the role lock shared (provisionUser), so one either waits or sees the new invite role.
 * Runs in the caller's accountSerial (setRole needs it); it must not call accountSerial or writeRole itself.
 */
export async function deleteRole(ctx: Ctx, actor: string | null, key: string, moveTo?: string): Promise<{ accounts: number; invites: number }> {
  const cat = (await listRoles(ctx)).find((r) => r.key === key);
  if (!cat) throw new HttpError(404, 'not_found');
  if (cat.origin === 'code' || Object.hasOwn(DEFAULT_ROLES, key)) throw new HttpError(400, 'builtin_role');
  if (cat.origin === 'env' && Object.hasOwn(ctx.roles, key)) throw new HttpError(400, 'env_role');
  if (moveTo !== undefined && (moveTo === key || moveTo === 'admin' || !(await roleExists(ctx, moveTo)))) throw new HttpError(400, 'bad_target');
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    for (const k of [...new Set([key, ...(moveTo !== undefined ? [moveTo] : [])])].sort()) await lockRole(c, k);
    if (!(await c.query('select 1 from roles where key=$1 for update', [key])).rowCount) throw new HttpError(404, 'not_found'); // deleted while this waited
    if (moveTo !== undefined && !Object.hasOwn(ctx.roles, moveTo) && !(await c.query('select 1 from roles where key=$1', [moveTo])).rowCount) throw new HttpError(400, 'bad_target');
    const accountIds = async () => (await c.query<{ id: string }>('select id from users where role=$1', [key])).rows.map((r) => r.id);
    const ids = await accountIds();
    let moved = 0;
    const open = "role=$1 and uses < max_uses and expires_at >= now()";
    const invites = Number((await c.query<{ n: string }>(`select count(*) n from invites where ${open}`, [key])).rows[0]!.n);
    if ((ids.length || invites) && moveTo === undefined) throw new RoleInUse(ids.length, invites);
    if (moveTo !== undefined) {
      await c.query('update invites set role=$2 where role=$1', [key, moveTo]);
      // an account created meanwhile shows up in the next pass
      for (let pass = 0, todo = ids; todo.length; todo = await accountIds()) {
        if (++pass > 3) throw new RoleInUse(todo.length, invites);
        for (const id of todo) await setRole(ctx, actor, id, moveTo);
        moved += todo.length;
      }
    }
    await c.query('delete from role_settings where role=$1', [key]);
    await c.query('delete from roles where key=$1', [key]);
    await auditInTx({ db: c }, actor, 'role.delete', key, { moveTo: moveTo ?? null, accounts: moved, invites });
    await c.query('commit');
    return { accounts: moved, invites };
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
    invalidateRoles(ctx);
    invalidateRights();
  }
}

/** PUT /api/admin/roles/order: `keys` must be a permutation of every catalogue key; position = index. 400 bad_order otherwise. */
export async function orderRoles(ctx: Ctx, actor: string | null, keys: string[]): Promise<void> {
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    const have = (await c.query<{ key: string }>('select key from roles order by key for update')).rows.map((r) => r.key);
    if (new Set(keys).size !== keys.length || keys.length !== have.length || !keys.every((k) => have.includes(k))) throw new HttpError(400, 'bad_order');
    await c.query('update roles r set position = o.i - 1 from unnest($1::text[]) with ordinality as o(k, i) where r.key = o.k', [keys]);
    await auditInTx({ db: c }, actor, 'role.order', undefined, { keys });
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
    invalidateCatalogue(ctx);
  }
}
