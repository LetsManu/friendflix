import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { revokeSessions } from '../devices.js';
import { createInvite } from '../invites.js';
import { INVITABLE_ROLES } from '../roles.js';
import { requireAdmin, requireUser } from '../session.js';
import { applyRole, getUserById } from '../users.js';

const uuid = z.string().uuid();

export function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };

  app.get('/api/admin/status', admin, async () => {
    const { listLive } = await import('../live.js');
    const { parties } = await import('./party.js');
    const n = async (sql: string) => Number((await ctx.db.query<{ n: string }>(sql)).rows[0]?.n ?? 0);
    return {
      users: await n('select count(*) n from users where not disabled'),
      pendingDevices: await n('select count(*) n from devices where not approved'),
      openInvites: await n('select count(*) n from invites where used_at is null and expires_at > now()'),
      pendingPolls: await n("select count(*) n from polls where status='needs_approval'"),
      activeStreams: (await listLive(ctx)).length,
      partyRooms: parties.rooms.size,
      jellyfin: await ctx.jf.client.ping(),
    };
  });

  app.get('/api/admin/roles', admin, async () => ({ roles: ctx.roles, invitable: INVITABLE_ROLES }));

  app.get('/api/admin/users', admin, async () => {
    const r = await ctx.db.query(
      `select u.id, u.name, u.email, u.role, u.disabled, u.jellyfin_username, u.seerr_user_id, u.created_at,
              (select max(last_seen) from devices d where d.user_id = u.id) last_seen
         from users u order by u.created_at`,
    );
    return { users: r.rows };
  });

  app.patch('/api/admin/users/:id', admin, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({ role: z.string().optional(), disabled: z.boolean().optional() }).parse(req.body);
    const user = await getUserById(ctx, id);
    if (!user) return reply.code(404).send({ error: 'not_found' });
    if (id === req.user!.id && (b.disabled || (b.role && b.role !== 'admin'))) return reply.code(400).send({ error: 'cannot_lock_yourself_out' });
    if (b.role && b.role !== user.role) {
      if (!ctx.roles[b.role]) return reply.code(400).send({ error: 'unknown_role' });
      await applyRole(ctx, user.jellyfin_user_id, b.role); // re-apply template to the Jellyfin account
      await ctx.db.query('update users set role=$1 where id=$2', [b.role, id]);
      await audit(ctx, req.user!.id, 'user.role', id, { from: user.role, to: b.role });
    }
    if (b.disabled !== undefined && b.disabled !== user.disabled) {
      await ctx.jf.client.setPolicy(user.jellyfin_user_id, { IsDisabled: b.disabled });
      await ctx.db.query('update users set disabled=$1 where id=$2', [b.disabled, id]);
      if (b.disabled) await revokeSessions(ctx, id);
      await audit(ctx, req.user!.id, b.disabled ? 'user.disable' : 'user.enable', id);
    }
    return { ok: true };
  });

  app.post('/api/admin/invites', admin, async (req) => {
    const b = z.object({ role: z.enum(INVITABLE_ROLES), ttlHours: z.number().int().min(1).max(24 * 14).default(48), note: z.string().max(100).optional() }).parse(req.body);
    const inv = await createInvite(ctx, req.user!.id, b);
    await audit(ctx, req.user!.id, 'invite.create', inv.id, { role: b.role });
    return { id: inv.id, link: inv.link, enrollUrl: inv.enrollUrl, expiresAt: inv.expiresAt }; // token is shown exactly once
  });

  app.get('/api/admin/invites', admin, async () => {
    const r = await ctx.db.query(
      `select i.id, i.role, i.note, i.expires_at, i.used_at, u.name used_by_name
         from invites i left join users u on u.id = i.used_by order by i.created_at desc limit 100`,
    );
    return { invites: r.rows };
  });

  app.delete('/api/admin/invites/:id', admin, async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    await ctx.db.query('delete from invites where id=$1 and used_at is null', [id]);
    await audit(ctx, req.user!.id, 'invite.revoke', id);
    return { ok: true };
  });

  app.get('/api/admin/audit', admin, async (req) => {
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse((req.query as { limit?: string }).limit);
    const r = await ctx.db.query(
      'select a.id, a.at, a.action, a.target, a.meta, u.name actor from audit_log a left join users u on u.id = a.actor order by a.id desc limit $1',
      [limit],
    );
    return { entries: r.rows };
  });

  app.get('/api/admin/devices', admin, async () => {
    const r = await ctx.db.query('select d.user_id, d.device_id, d.label, d.approved, d.last_seen, u.name from devices d join users u on u.id=d.user_id order by d.approved, d.last_seen desc limit 300');
    return { devices: r.rows };
  });
  app.post('/api/admin/devices/approve', admin, async (req) => {
    const b = z.object({ userId: uuid, deviceId: z.string().min(10).max(80) }).parse(req.body);
    await ctx.db.query('update devices set approved=true where user_id=$1 and device_id=$2', [b.userId, b.deviceId]);
    await audit(ctx, req.user!.id, 'device.approve', b.userId, { by: 'admin' });
    return { ok: true };
  });

  // ---- own devices ----
  app.get('/api/devices', { preHandler: requireUser(ctx, { allowPendingDevice: true }) }, async (req) => {
    const r = await ctx.db.query('select device_id, label, approved, created_at, last_seen from devices where user_id=$1 order by created_at', [req.user!.id]);
    return { devices: r.rows.map((d) => ({ ...d, id: d.device_id, current: d.device_id === req.session!.deviceId })) };
  });
  app.post('/api/devices/:id/approve', { preHandler: requireUser(ctx) }, async (req) => {
    const id = z.string().min(10).max(80).parse((req.params as { id: string }).id);
    await ctx.db.query('update devices set approved=true where user_id=$1 and device_id=$2', [req.user!.id, id]);
    await audit(ctx, req.user!.id, 'device.approve', req.user!.id, { by: 'self' });
    return { ok: true };
  });
  app.delete('/api/devices/:id', { preHandler: requireUser(ctx) }, async (req, reply) => {
    const id = z.string().min(10).max(80).parse((req.params as { id: string }).id);
    if (id === req.session!.deviceId) return reply.code(400).send({ error: 'current_device' });
    await ctx.db.query('delete from devices where user_id=$1 and device_id=$2', [req.user!.id, id]);
    await revokeSessions(ctx, req.user!.id, id);
    await audit(ctx, req.user!.id, 'device.remove', req.user!.id);
    return { ok: true };
  });
}

/** Anonymous but token-protected: lets the invite landing page show what will be created. */
export function inviteRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/invite/:token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { lookupInvite } = await import('../invites.js');
    const inv = await lookupInvite(ctx, (req.params as { token: string }).token);
    if (!inv) return reply.code(404).send({ error: 'invalid_or_expired' });
    const flow = ctx.cfg.AUTHENTIK_URL && inv.authentik_invite && ctx.cfg.AUTHENTIK_ENROLL_FLOW
      ? `${ctx.cfg.AUTHENTIK_URL.replace(/\/$/, '')}/if/flow/${ctx.cfg.AUTHENTIK_ENROLL_FLOW}/?itoken=${inv.authentik_invite}`
      : undefined;
    return { role: inv.role, roleLabel: ctx.roles[inv.role]?.label ?? inv.role, expiresAt: inv.expires_at, enrollUrl: flow };
  });
}
