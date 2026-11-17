// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { CATEGORIES, categoryOf, type Category } from './categories.js';
import { fromSql, parseGroupId, readSql, visibleSql, type GroupRef } from './feed.js';

/** What a read or a clear acts on: single entries, whole groups (feed group ids) and/or everything a filter shows. */
export type Selection = { ids?: number[]; groups?: string[]; category?: Category | 'unread' | 'all' };

/** The body of POST /read and /hide (strict: an unknown field is refused). */
export const selectionSchema = z.strictObject({
  ids: z.array(z.number().int().positive()).max(200).optional(),
  groups: z.array(z.string().min(1).max(4096)).max(50).optional(),
  category: z.enum(['all', 'unread', ...CATEGORIES]).optional(),
});

export const isEmptySelection = (s: Selection) => s.ids === undefined && s.groups === undefined && s.category === undefined;

/** Undo of a clear: kv `notes:undo:<token>`, 30 s. */
const UNDO_TTL_S = 30;
const undoKey = (token: string) => `notes:undo:${token}`;
const undoSchema = z.object({ personal: z.array(z.number().int()), broadcast: z.array(z.number().int()) });

/** A group id that does not name a group of this person (tampered, or handed out to someone else). */
export class InvalidGroupError extends Error {
  constructor() {
    super('invalid_group');
  }
}

/** Validates the selection's group ids for this person (InvalidGroupError otherwise). */
export function groupRefs(ctx: Pick<Ctx, 'encKey'>, userId: string, sel: Selection): GroupRef[] {
  return (sel.groups ?? []).map((id) => {
    const g = parseGroupId(ctx, userId, id);
    if (!g) throw new InvalidGroupError();
    return g;
  });
}

/**
 * The rows a selection names among the person's visible rows (`t`: id, user_id), as a CTE over fromSql() with `$1` = the user id.
 * ids: those rows; a group: its key's rows in its time range up to its maxId (never rows that arrived after the page was loaded);
 * a category: the rows it shows now (`all`, `unread` or the visible kinds of the category). Several parts add up.
 */
async function targetSql(ctx: Pick<Ctx, 'db' | 'encKey'>, userId: string, sel: Selection, extra = 'true') {
  const groups = groupRefs(ctx, userId, sel);
  const parts: string[] = [];
  const params: unknown[] = [userId];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (sel.ids?.length) parts.push(`n.id = any(${p(sel.ids)}::bigint[])`);
  if (groups.length) {
    parts.push(`exists (select 1 from unnest(${p(groups.map((g) => g.groupKey))}::text[], ${p(groups.map((g) => g.from))}::timestamptz[],
        ${p(groups.map((g) => g.to))}::timestamptz[], ${p(groups.map((g) => g.maxId))}::bigint[]) as g(gk, f, t, mx)
      where coalesce(n.group_key, n.kind || '|id:' || n.id) = g.gk and n.created_at >= g.f and n.created_at < g.t and n.id <= g.mx)`);
  }
  if (sel.category === 'all') parts.push('true');
  else if (sel.category === 'unread') parts.push(`not ${readSql()}`);
  else if (sel.category) {
    const kinds = (await ctx.db.query<{ kind: string }>(`select distinct n.kind from ${fromSql()} where ${visibleSql()}`, [userId])).rows
      .map((x) => x.kind).filter((k) => categoryOf(k) === sel.category);
    parts.push(`n.kind = any(${p(kinds)}::text[])`);
  }
  const where = parts.length ? parts.map((x) => `(${x})`).join(' or ') : 'false';
  return { cte: `t as (select n.id, n.user_id from ${fromSql()} where ${visibleSql()} and ${extra} and (${where}))`, params };
}

/**
 * Marks entries read. `null` is "everything" (today's POST /read): the watermark `users.notifications_read_at` and every personal
 * `read_at`. A selection reads its unread rows: personal ones on the row, broadcasts in the person's notification_state row.
 */
export async function markRead(ctx: Pick<Ctx, 'db' | 'encKey'>, userId: string, sel: Selection | null): Promise<void> {
  if (!sel) {
    await ctx.db.query('update notifications set read_at = now() where user_id = $1 and read_at is null', [userId]);
    await ctx.db.query('update users set notifications_read_at = now() where id = $1', [userId]);
    return;
  }
  const { cte, params } = await targetSql(ctx, userId, sel, `not ${readSql()}`);
  await ctx.db.query(
    `with ${cte},
     p as (update notifications set read_at = now() where user_id = $1 and read_at is null and id in (select id from t where user_id is not null) returning id)
     insert into notification_state(user_id, notification_id, read_at) select $1, id, now() from t where user_id is null
       on conflict (user_id, notification_id) do update set read_at = coalesce(notification_state.read_at, excluded.read_at)`,
    params,
  );
}

/**
 * Clears (hides) the selected visible rows for this person: personal ones on the row, broadcasts in their notification_state row
 * (the broadcast row itself is never touched). Returns an undo token valid for 30 s and the number of rows cleared.
 */
export async function hide(ctx: Pick<Ctx, 'db' | 'kv' | 'encKey'>, userId: string, sel: Selection): Promise<{ undo: string; n: number }> {
  const { cte, params } = await targetSql(ctx, userId, sel);
  const r = await ctx.db.query<{ personal: string[]; broadcast: string[] }>(
    `with ${cte},
     p as (update notifications set hidden_at = now() where user_id = $1 and hidden_at is null and id in (select id from t where user_id is not null) returning id),
     b as (insert into notification_state(user_id, notification_id, hidden_at) select $1, id, now() from t where user_id is null
             on conflict (user_id, notification_id) do update set hidden_at = excluded.hidden_at where notification_state.hidden_at is null
             returning notification_id)
     select array(select id from p) as personal, array(select notification_id from b) as broadcast`,
    params,
  );
  const row = r.rows[0]!;
  const undo = { personal: row.personal.map(Number), broadcast: row.broadcast.map(Number) };
  const token = randomBytes(16).toString('base64url');
  await ctx.kv.set(undoKey(token), JSON.stringify(undo), UNDO_TTL_S);
  return { undo: token, n: undo.personal.length + undo.broadcast.length };
}

/** Undoes a clear: the token's rows become visible again for this person. null when the token is unknown, used or expired. */
export async function unhide(ctx: Pick<Ctx, 'db' | 'kv'>, userId: string, token: string): Promise<{ n: number } | null> {
  const raw = await ctx.kv.take(undoKey(token));
  if (raw === null) return null;
  let undo: z.infer<typeof undoSchema>;
  try {
    undo = undoSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
  const r = await ctx.db.query<{ n: number }>(
    `with p as (update notifications set hidden_at = null where user_id = $1 and id = any($2::bigint[]) and hidden_at is not null returning id),
     b as (update notification_state set hidden_at = null where user_id = $1 and notification_id = any($3::bigint[]) and hidden_at is not null returning notification_id)
     select ((select count(*) from p) + (select count(*) from b))::int as n`,
    [userId, undo.personal, undo.broadcast],
  );
  return { n: r.rows[0]!.n };
}
