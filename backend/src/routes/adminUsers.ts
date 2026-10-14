// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Admin user management: the account list, single and bulk account actions (role, lock, access, sessions), the approval queue, invites. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { Where, likePattern, orderBy, pageQuery } from '../adminlist.js';
import type { Ctx } from '../ctx.js';
import { revokeSessions } from '../devices.js';
import { createInvite, deleteAuthentikInvitation } from '../invites.js';
import { INVITABLE_ROLES } from '../roles.js';
import { requireAdmin } from '../session.js';
import { HttpError, assertNotLastAdmin, getUserById, getUserBySub, lockUser, provisionUser, setAccessUntil, setRole, unlockUser } from '../users.js';
import { pendingNoticeKey } from './auth.js';

const uuid = z.guid();
/** ISO date-time with offset, or null (= no end) */
const accessUntil = z.iso.datetime({ offset: true }).nullable();
const toDate = (s: string | null) => (s === null ? null : new Date(s));
/** the approved person's /pending page may answer "approved" this long (as long as its cookie lives) */
const PENDING_NOTICE_TTL = 30 * 86400;

interface ApprovalRow { id: string; authentik_sub: string; email: string | null; name: string }

/**
 * Turns an approval request into an account: provisions it like an invite would (role, optional access-until), removes
 * the request and remembers it for the person's /pending page. Errors: 404 `not_found`, 409 `user_exists`.
 */
export async function approveRequest(ctx: Ctx, actor: string, id: string, role: string, until: Date | null): Promise<string> {
  const req = (await ctx.db.query<ApprovalRow>('select id, authentik_sub, email, name from approval_requests where id=$1', [id])).rows[0];
  if (!req) throw new HttpError(404, 'not_found');
  if (await getUserBySub(ctx, req.authentik_sub)) {
    await ctx.db.query('delete from approval_requests where id=$1', [id]);
    throw new HttpError(409, 'user_exists');
  }
  const user = await provisionUser(ctx, { sub: req.authentik_sub, email: req.email ?? undefined, name: req.name, groups: [] }, role, until);
  await ctx.db.query('delete from approval_requests where id=$1', [id]);
  await audit(ctx, actor, 'user.approved', user.id, { from: 'pending', to: role, accessUntil: until?.toISOString() ?? null, request: id });
  await ctx.kv.set(pendingNoticeKey(id), JSON.stringify({ sub: req.authentik_sub, email: req.email }), PENDING_NOTICE_TTL);
  return user.id;
}

export const bulkBody = z.object({
  ids: z.array(uuid).min(1).max(200),
  action: z.enum(['role', 'lock', 'unlock', 'revoke', 'access']),
  role: z.string().max(40).optional(),
  accessUntil: accessUntil.optional(),
}).refine((b) => b.action !== 'role' || b.role !== undefined, { path: ['role'] })
  .refine((b) => b.action !== 'access' || b.accessUntil !== undefined, { path: ['accessUntil'] });
export type BulkBody = z.infer<typeof bulkBody>;

/**
 * Applies one action to many accounts. All or nothing on validation and guards (unknown id, unknown role,
 * the actor locking/demoting themselves, last admin); then per user. `done` counts the accounts that changed.
 */
export async function bulkUsers(ctx: Ctx, actor: string, b: BulkBody): Promise<{ done: number }> {
  const ids = [...new Set(b.ids)];
  const rows = (await ctx.db.query<{ id: string; role: string; disabled: boolean }>('select id, role, disabled from users where id = any($1::uuid[])', [ids])).rows;
  if (rows.length !== ids.length) throw new HttpError(404, 'not_found');
  if (b.action === 'role' && !Object.hasOwn(ctx.roles, b.role!)) throw new HttpError(400, 'unknown_role');
  const demote = b.action === 'role' && b.role !== 'admin';
  if ((demote || b.action === 'lock') && ids.includes(actor)) throw new HttpError(400, 'cannot_lock_yourself_out');
  if (demote) await assertNotLastAdmin(ctx, ids, 'demote');
  if (b.action === 'lock') await assertNotLastAdmin(ctx, ids, 'lock');

  let done = 0;
  for (const u of rows) {
    switch (b.action) {
      case 'role':
        if (u.role === b.role) continue;
        await setRole(ctx, actor, u.id, b.role!);
        break;
      case 'lock':
        if (u.disabled) continue;
        await lockUser(ctx, actor, u.id, 'manual');
        break;
      case 'unlock':
        if (!u.disabled) continue;
        await unlockUser(ctx, actor, u.id);
        break;
      case 'revoke':
        await audit(ctx, actor, 'user.revoke_sessions', u.id, { sessions: await revokeSessions(ctx, u.id) });
        break;
      case 'access':
        await setAccessUntil(ctx, actor, u.id, toDate(b.accessUntil!));
        break;
    }
    done++;
  }
  return { done };
}

/** Runs account changes one at a time, so the last-admin guard and the change it guards cannot interleave with another request. */
function serialized() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function adminUserRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };
  const serial = serialized();

  // ?q= (name/email/login) &role= &status=active|locked|pending|expiring|deleting &lastActive=7|30|90
  // &sort=name|email|role|status|lastSeen|createdAt|accessUntil &dir= &limit= &offset=; without params: everyone (max 1000)
  // status=pending lists open approval requests in the same row shape (pending: true, role null)
  app.get('/api/admin/users', admin, async (req) => {
    const p = pageQuery.extend({
      role: z.string().max(40).optional(),
      status: z.enum(['active', 'locked', 'pending', 'expiring', 'deleting']).optional(),
      lastActive: z.enum(['7', '30', '90']).optional(),
    }).parse(req.query);
    const w = new Where();
    if (p.q) { const m = w.param(likePattern(p.q)); w.add(`(u.name ilike ${m} or coalesce(u.email,'') ilike ${m} or coalesce(u.jellyfin_username,'') ilike ${m})`); }
    if (p.role) w.add('u.role = ?', p.role);
    if (p.status === 'active') w.add('not u.disabled and u.deletion_at is null');
    if (p.status === 'locked') w.add('u.disabled');
    if (p.status === 'expiring') w.add("u.access_until between now() and now() + interval '7 days'");
    if (p.status === 'deleting') w.add('u.deletion_at is not null');
    if (p.lastActive) w.add("u.last_seen >= now() - make_interval(days => ?)", Number(p.lastActive));
    const base = p.status === 'pending'
      ? `select a.id, a.name, a.email, null::text role, false disabled, null::text jellyfin_username, null::int seerr_user_id, a.requested_at created_at,
                null::timestamptz last_seen, null::timestamptz access_until, null::text locked_reason, null::timestamptz deletion_at, 0 profiles, 0 devices, true pending
           from approval_requests a where a.rejected_at is null`
      : `select u.id, u.name, u.email, u.role, u.disabled, u.jellyfin_username, u.seerr_user_id, u.created_at,
                (select max(last_seen) from devices d where d.user_id = u.id) last_seen, u.access_until, u.locked_reason, u.deletion_at,
                (select count(*) from profiles x where x.user_id = u.id)::int profiles,
                (select count(*) from devices d where d.user_id = u.id)::int devices, false pending
           from users u`;
    const order = orderBy({ name: 'lower(u.name)', email: "lower(coalesce(u.email,''))", role: 'u.role', status: 'u.disabled', lastSeen: 'u.last_seen', createdAt: 'u.created_at', accessUntil: 'u.access_until' }, p.sort, p.dir, 'u.created_at, u.id');
    const total = Number((await ctx.db.query<{ c: string }>(`select count(*) c from (${base}) u ${w.sql}`, w.params)).rows[0]!.c);
    const r = await ctx.db.query(`select * from (${base}) u ${w.sql} ${order} limit ${p.limit ?? 1000} offset ${p.offset ?? 0}`, w.params);
    return { users: r.rows, total };
  });

  app.patch('/api/admin/users/:id', admin, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({ role: z.string().max(40).optional(), disabled: z.boolean().optional(), accessUntil: accessUntil.optional() }).parse(req.body);
    const actor = req.user!.id;
    return serial(async () => {
      const user = await getUserById(ctx, id);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      const demote = b.role !== undefined && b.role !== 'admin';
      if (id === actor && (b.disabled || demote)) return reply.code(400).send({ error: 'cannot_lock_yourself_out' });
      if (b.role !== undefined && !Object.hasOwn(ctx.roles, b.role)) return reply.code(400).send({ error: 'unknown_role' });
      if (demote) await assertNotLastAdmin(ctx, [id], 'demote');
      if (b.disabled) await assertNotLastAdmin(ctx, [id], 'lock');
      if (b.role !== undefined) await setRole(ctx, actor, id, b.role);
      if (b.disabled !== undefined && b.disabled !== user.disabled) await (b.disabled ? lockUser(ctx, actor, id, 'manual') : unlockUser(ctx, actor, id));
      if (b.accessUntil !== undefined) await setAccessUntil(ctx, actor, id, toDate(b.accessUntil));
      return { ok: true };
    });
  });

  app.post('/api/admin/users/bulk', admin, async (req) => {
    const b = bulkBody.parse(req.body);
    return serial(() => bulkUsers(ctx, req.user!.id, b));
  });

  // open approval requests (rejected ones are hidden; the expiry tick deletes them after 30 days)
  app.get('/api/admin/approvals', admin, async () => {
    const r = await ctx.db.query('select id, name, email, requested_at from approval_requests where rejected_at is null order by requested_at, id');
    return { requests: r.rows };
  });

  app.post('/api/admin/approvals/:id/approve', admin, async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({ role: z.enum([...INVITABLE_ROLES, 'admin']), accessUntil: accessUntil.optional() }).parse(req.body);
    // serialized: a double click must not provision the same person twice
    return serial(async () => ({ id: await approveRequest(ctx, req.user!.id, id, b.role, toDate(b.accessUntil ?? null)) }));
  });

  app.post('/api/admin/approvals/:id/reject', admin, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({ message: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    const r = await ctx.db.query<{ name: string }>(
      'update approval_requests set rejected_at=now(), reject_message=$2 where id=$1 and rejected_at is null returning name', [id, b.message || null]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(ctx, req.user!.id, 'user.rejected', id, { from: 'pending', to: 'rejected', name: r.rows[0]!.name, message: b.message || null });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/revoke-sessions', admin, async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const n = await revokeSessions(ctx, id);
    await audit(ctx, req.user!.id, 'user.revoke_sessions', id, { sessions: n });
    return { revoked: n };
  });

  // ---- invites: multi-use (maxUses), optional access days for the accounts they create ----
  app.post('/api/admin/invites', admin, async (req) => {
    const b = z.object({
      role: z.enum(INVITABLE_ROLES),
      ttlHours: z.number().int().min(1).max(24 * 14).default(48),
      note: z.string().max(100).optional(),
      /** false: the person already has an Authentik account, skip enrollment */
      enroll: z.boolean().default(true),
      /** how many accounts the invite may create */
      maxUses: z.number().int().min(1).max(50).default(1),
      /** access_until of each new account = now + accessDays; null = no end */
      accessDays: z.number().int().min(1).max(3650).nullable().default(null),
    }).parse(req.body);
    const inv = await createInvite(ctx, req.user!.id, b, req.log);
    await audit(ctx, req.user!.id, 'invite.create', inv.id, { role: b.role, authentik: inv.authentik, maxUses: b.maxUses, accessDays: b.accessDays });
    // token is shown exactly once
    return { id: inv.id, link: inv.link, enrollUrl: inv.enrollUrl, authentik: inv.authentik, expiresAt: inv.expiresAt, uses: inv.uses, maxUses: inv.maxUses };
  });

  // ?q= (note/role/first redeemer) &status=open|used|expired &sort=role|note|validUntil|status|createdAt &dir= &limit= &offset=; without params: the newest 100
  // used = all uses taken; used_by_name names the first account (see /uses for all of them)
  app.get('/api/admin/invites', admin, async (req) => {
    const p = pageQuery.extend({ status: z.enum(['open', 'used', 'expired']).optional(), role: z.string().max(40).optional() }).parse(req.query);
    const w = new Where();
    if (p.q) { const m = w.param(likePattern(p.q)); w.add(`(coalesce(i.note,'') ilike ${m} or i.role ilike ${m} or coalesce(u.name,'') ilike ${m})`); }
    if (p.role) w.add('i.role = ?', p.role);
    if (p.status === 'used') w.add('i.uses >= i.max_uses');
    else if (p.status === 'expired') w.add('i.uses < i.max_uses and i.expires_at < now()');
    else if (p.status === 'open') w.add('i.uses < i.max_uses and i.expires_at >= now()');
    const order = orderBy({ role: 'i.role', note: "lower(coalesce(i.note,''))", validUntil: 'i.expires_at', createdAt: 'i.created_at', status: "(case when i.uses >= i.max_uses then 2 when i.expires_at < now() then 1 else 0 end)" }, p.sort, p.dir, 'i.created_at desc, i.id');
    const from = 'from invites i left join users u on u.id = i.used_by';
    const total = Number((await ctx.db.query<{ c: string }>(`select count(*) c ${from} ${w.sql}`, w.params)).rows[0]!.c);
    const r = await ctx.db.query(
      `select i.id, i.role, i.note, i.created_at, i.expires_at, i.used_at, u.name used_by_name, i.uses, i.max_uses, i.access_days ${from} ${w.sql} ${order} limit ${p.limit ?? 100} offset ${p.offset ?? 0}`,
      w.params,
    );
    return { invites: r.rows, total };
  });

  // the accounts created from an invite, oldest first
  app.get('/api/admin/invites/:id/uses', admin, async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    if (!id.success || !(await ctx.db.query('select 1 from invites where id=$1', [id.data])).rowCount) return reply.code(404).send({ error: 'not_found' });
    const r = await ctx.db.query(
      'select u.id, u.name, u.email, u.role, u.disabled, iu.at from invite_uses iu join users u on u.id = iu.user_id where iu.invite_id=$1 order by iu.at, u.id',
      [id.data],
    );
    return { uses: r.rows };
  });

  // revoke: an unused invite is deleted; a partly used one is closed (max_uses = uses) so the accounts it made stay listed
  app.delete('/api/admin/invites/:id', admin, async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const r = await ctx.db.query<{ authentik_invite: string | null; uses: number; max_uses: number }>(
      `with d as (delete from invites where id=$1 and uses = 0 returning authentik_invite, uses, max_uses),
            c as (update invites n set max_uses = n.uses from invites o where n.id=$1 and o.id = n.id and n.uses > 0 and n.uses < n.max_uses
                  returning n.authentik_invite, n.uses, o.max_uses)
       select * from d union all select * from c`, [id]);
    const row = r.rows[0];
    if (row) {
      await deleteAuthentikInvitation(ctx, row.authentik_invite, req.log);
      await audit(ctx, req.user!.id, 'invite.revoke', id, { from: { uses: row.uses, maxUses: row.max_uses }, to: row.uses ? { uses: row.uses, maxUses: row.uses } : null });
    }
    return { ok: true };
  });
}
