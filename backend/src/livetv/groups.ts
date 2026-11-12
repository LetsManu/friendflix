// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import { auditInTx } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { HttpError } from '../users.js';
import { CHANNEL_SELECT } from './channels.js';
import { invalidateLivetvRights } from './rights.js';

/**
 * Channel groups and the per-person group exceptions (spec §8, §9.3). Groups an import creates arrive unreleased (no role, not
 * kid-friendly) and nobody sees them on the user side until the admin releases them; groups the admin creates start released.
 * Every write runs in one transaction with its audit entry and drops the cached channel sets afterwards (invalidateLivetvRights).
 */

/** one group as the admin sees it (F22; the web re-declares it in its own groups.ts, Task 25) */
export interface GroupView {
  id: string;
  name: string;
  kidFriendly: boolean;
  /** role keys that see the group, in catalogue order */
  roles: string[];
  released: boolean;
  position: number;
  /** channels whose effective group this is (missing channels not counted) */
  channels: number;
  /** provider group-titles mapped into it ("aus: …"), sorted */
  providerGroups: string[];
}

interface GroupRow { id: string; name: string; kid_friendly: boolean; released: boolean; position: number; roles: string[]; provider_groups: string[]; channels: number }

const VIEW_SQL = `
  select g.id, g.name, g.kid_friendly, g.released, g.position,
    coalesce((select array_agg(r.role order by ro.position, r.role) from livetv_group_roles r join roles ro on ro.key = r.role
               where r.group_id = g.id), '{}') as roles,
    coalesce((select array_agg(distinct m.provider_group order by m.provider_group) from livetv_group_map m where m.group_id = g.id), '{}') as provider_groups,
    coalesce(n.channels, 0)::int as channels
  from livetv_groups g
  left join (select x.group_id, count(*) as channels from (${CHANNEL_SELECT}) x where x.missing_since is null group by x.group_id) n
    on n.group_id = g.id`;

const toView = (r: GroupRow): GroupView => ({
  id: r.id, name: r.name, kidFriendly: r.kid_friendly, roles: r.roles, released: r.released, position: r.position,
  channels: r.channels, providerGroups: r.provider_groups,
});

/** every group, unreleased ones first, then by position; `pending` = the number of unreleased groups */
export async function listGroups(ctx: Pick<Ctx, 'db'>): Promise<{ groups: GroupView[]; pending: number }> {
  const rows = (await ctx.db.query<GroupRow>(`${VIEW_SQL} order by g.released, g.position, lower(g.name)`)).rows;
  return { groups: rows.map(toView), pending: rows.filter((r) => !r.released).length };
}

export async function groupView(ctx: Pick<Ctx, 'db'>, id: string): Promise<GroupView | null> {
  const r = (await ctx.db.query<GroupRow>(`${VIEW_SQL} where g.id = $1`, [id])).rows[0];
  return r ? toView(r) : null;
}

/** runs `fn` in one transaction; the cached channel sets are dropped after the commit (and also after a rollback: harmless) */
async function write<T>(ctx: Pick<Ctx, 'db'>, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'name_taken'); // livetv_groups_name (lower(name))
    throw e;
  } finally {
    c.release();
    invalidateLivetvRights();
  }
}

const tx = (c: pg.PoolClient) => ({ db: c as unknown as Ctx['db'] });

async function setRoles(c: pg.PoolClient, id: string, roles: readonly string[]): Promise<void> {
  await c.query('delete from livetv_group_roles where group_id = $1', [id]);
  if (roles.length) await c.query('insert into livetv_group_roles(group_id, role) select $1::uuid, unnest($2::text[]) on conflict do nothing', [id, [...roles]]);
}

export interface GroupInput { name: string; kidFriendly: boolean; roles: string[]; released: boolean }

/** a new group at the end of the order; roles must be known role keys (the caller checks) */
export async function createGroup(ctx: Pick<Ctx, 'db'>, actor: string, g: GroupInput): Promise<GroupView> {
  const id = await write(ctx, async (c) => {
    const id = (await c.query<{ id: string }>(
      `insert into livetv_groups(id, name, kid_friendly, released, position)
       values (gen_random_uuid(), $1, $2, $3, (select coalesce(max(position) + 1, 0) from livetv_groups)) returning id`,
      [g.name, g.kidFriendly, g.released])).rows[0]!.id;
    await setRoles(c, id, g.roles);
    await auditInTx(tx(c), actor, 'livetv.group.create', id, { fields: ['name', 'kidFriendly', 'roles', 'released'] });
    return id;
  });
  return (await groupView(ctx, id))!;
}

/** partial update; `released: false` = *Freigabe zurücknehmen* (the roles stay). null = no such group */
export async function updateGroup(ctx: Pick<Ctx, 'db'>, actor: string, id: string, p: Partial<GroupInput>): Promise<GroupView | null> {
  const found = await write(ctx, async (c) => {
    const cur = (await c.query('select 1 from livetv_groups where id = $1 for update', [id])).rowCount;
    if (!cur) return false;
    await c.query(
      `update livetv_groups set name = coalesce($2, name), kid_friendly = coalesce($3, kid_friendly), released = coalesce($4, released)
        where id = $1`,
      [id, p.name ?? null, p.kidFriendly ?? null, p.released ?? null]);
    if (p.roles) await setRoles(c, id, p.roles);
    const fields = (['name', 'kidFriendly', 'roles', 'released'] as const).filter((k) => p[k] !== undefined);
    await auditInTx(tx(c), actor, 'livetv.group.update', id, { fields });
    return true;
  });
  return found ? groupView(ctx, id) : null;
}

/** deletes a group: its provider maps go with it, channels that pointed at it fall back to *Ohne Gruppe* (admins only) */
export async function deleteGroup(ctx: Pick<Ctx, 'db'>, actor: string, id: string): Promise<boolean> {
  return write(ctx, async (c) => {
    if (!(await c.query('delete from livetv_groups where id = $1', [id])).rowCount) return false;
    await auditInTx(tx(c), actor, 'livetv.group.delete', id);
    return true;
  });
}

/** *Freigeben* (spec §9.3): released, with exactly these roles and this kid-friendly flag. Answers how many groups it changed. */
export async function releaseGroups(ctx: Pick<Ctx, 'db'>, actor: string, ids: readonly string[], roles: readonly string[], kidFriendly: boolean): Promise<number> {
  return write(ctx, async (c) => {
    const hit = (await c.query<{ id: string }>(
      'update livetv_groups set released = true, kid_friendly = $2 where id = any($1::uuid[]) returning id', [[...new Set(ids)], kidFriendly])).rows;
    for (const { id } of hit) await setRoles(c, id, roles);
    await auditInTx(tx(c), actor, 'livetv.group.release', undefined, { ids: hit.map((r) => r.id), roles: [...roles], kidFriendly });
    return hit.length;
  });
}

/** the given ids first in this order, every other group after them in its previous order */
export async function orderGroups(ctx: Pick<Ctx, 'db'>, actor: string, ids: readonly string[]): Promise<void> {
  await write(ctx, async (c) => {
    await c.query(
      `with wanted as (select id, min(n) as n from unnest($1::uuid[]) with ordinality as w(id, n) group by id),
            ranked as (select g.id, row_number() over (order by w.n nulls last, g.position, lower(g.name)) - 1 as pos
                         from livetv_groups g left join wanted w on w.id = g.id)
       update livetv_groups g set position = ranked.pos from ranked where ranked.id = g.id and g.position <> ranked.pos`,
      [[...ids]]);
    await auditInTx(tx(c), actor, 'livetv.group.order', undefined, { count: ids.length });
  });
}

/**
 * *Zusammenführen* (spec §9.3): the provider maps and the channel overrides of `ids` move to `into`, then those groups are deleted
 * (their roles, flags and per-person exceptions go with them; `into` keeps its own). null = `into` does not exist.
 */
export async function mergeGroups(ctx: Pick<Ctx, 'db'>, actor: string, ids: readonly string[], into: string): Promise<GroupView | null> {
  const from = [...new Set(ids)].filter((id) => id !== into);
  const found = await write(ctx, async (c) => {
    if (!(await c.query('select 1 from livetv_groups where id = $1 for update', [into])).rowCount) return false;
    await c.query('update livetv_group_map set group_id = $2 where group_id = any($1::uuid[])', [from, into]);
    await c.query('update livetv_channels set group_override = $2 where group_override = any($1::uuid[])', [from, into]);
    const gone = (await c.query<{ id: string }>('delete from livetv_groups where id = any($1::uuid[]) returning id', [from])).rows.map((r) => r.id);
    await auditInTx(tx(c), actor, 'livetv.group.merge', into, { ids: gone });
    return true;
  });
  return found ? groupView(ctx, into) : null;
}

/** the ids among `ids` that are not a group */
export async function unknownGroups(ctx: Pick<Ctx, 'db'>, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const known = new Set((await ctx.db.query<{ id: string }>('select id from livetv_groups where id = any($1::uuid[])', [[...ids]])).rows.map((r) => r.id));
  return ids.filter((id) => !known.has(id));
}

// ---- per-person exceptions (livetv_group_users) ----

export interface GroupRef { id: string; name: string }
export interface UserGroups { allow: GroupRef[]; deny: GroupRef[] }

/** the account's exceptions: groups added (allow) and removed (deny), each in group order */
export async function userGroups(ctx: Pick<Ctx, 'db'>, userId: string): Promise<UserGroups> {
  const rows = (await ctx.db.query<{ id: string; name: string; allow: boolean }>(
    `select g.id, g.name, u.allow from livetv_group_users u join livetv_groups g on g.id = u.group_id
      where u.user_id = $1 order by g.released, g.position, lower(g.name)`, [userId])).rows;
  return {
    allow: rows.filter((r) => r.allow).map(({ id, name }) => ({ id, name })),
    deny: rows.filter((r) => !r.allow).map(({ id, name }) => ({ id, name })),
  };
}

/** replaces the account's exceptions (the caller checked: no overlap, every id a group) */
export async function setUserGroups(ctx: Pick<Ctx, 'db'>, actor: string, userId: string, allow: readonly string[], deny: readonly string[]): Promise<UserGroups> {
  await write(ctx, async (c) => {
    await c.query('delete from livetv_group_users where user_id = $1', [userId]);
    await c.query(
      `insert into livetv_group_users(group_id, user_id, allow)
       select a.id, $1::uuid, true from unnest($2::uuid[]) a(id) union all select d.id, $1::uuid, false from unnest($3::uuid[]) d(id)`,
      [userId, [...new Set(allow)], [...new Set(deny)]]);
    await auditInTx(tx(c), actor, 'user.livetv_groups', userId, { allow: [...new Set(allow)], deny: [...new Set(deny)] });
  });
  return userGroups(ctx, userId);
}

/** role key -> names of the released groups that role sees (the admin role: every released group), in group order; for the role matrix */
export async function roleGroupNames(ctx: Pick<Ctx, 'db'>): Promise<Map<string, string[]>> {
  const rows = (await ctx.db.query<{ name: string; roles: string[] }>(
    `select g.name, coalesce((select array_agg(r.role) from livetv_group_roles r where r.group_id = g.id), '{}') as roles
       from livetv_groups g where g.released order by g.position, lower(g.name)`)).rows;
  const out = new Map<string, string[]>([['admin', rows.map((r) => r.name)]]);
  for (const r of rows) {
    for (const role of r.roles) {
      if (role === 'admin') continue;
      let list = out.get(role);
      if (!list) out.set(role, (list = []));
      list.push(r.name);
    }
  }
  return out;
}
