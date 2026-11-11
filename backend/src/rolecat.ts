// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
// roles.ts and rolecat.ts import each other (invalidateRoles clears the catalogue; the catalogue needs DEFAULT_ROLES): neither may use
// the other's exports at module load, only inside functions
import { DEFAULT_ROLES } from './roles.js';

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
  const own = row?.label ?? (row ? ctx.roles[key]?.label : undefined);
  if (own !== undefined || !row) return [key, own, DEFAULT_ROLES[key]?.label];
  const base = DEFAULT_ROLES[row.base]?.label;
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
