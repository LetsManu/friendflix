import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { clearLive, setLive } from '../live.js';
import { loadSession } from '../session.js';
import { getUserById } from '../users.js';
import type { UserRow } from '../types.js';

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const checkSecret = (req: FastifyRequest, header: string, secret: string) => eq(String(req.headers[header] ?? ''), secret);

/** Jellyfin webhook plugin template (documented in README); values arrive as strings. */
const jfWebhook = z.object({
  type: z.string(),
  user: z.string().optional(),
  itemId: z.string().optional(),
  name: z.string().optional(),
  seriesName: z.string().optional(),
  positionTicks: z.coerce.number().optional(),
  runtimeTicks: z.coerce.number().optional(),
  isPaused: z.union([z.boolean(), z.string()]).optional(),
  deviceName: z.string().optional(),
});

export function internalRoutes(app: FastifyInstance, ctx: Ctx) {
  // Used by the gateway only (never routed by NPM). Returns the Jellyfin token of the session owner.
  app.post('/internal/authz', async (req, reply) => {
    if (!checkSecret(req, 'x-internal-secret', ctx.cfg.INTERNAL_SECRET)) return reply.code(403).send({ error: 'forbidden' });
    const sid = z.object({ sid: z.string().regex(/^[\w-]{20,80}$/) }).safeParse(req.body);
    if (!sid.success) return reply.code(400).send({ error: 'bad_request' });
    const s = await loadSession(ctx, sid.data.sid);
    if (!s || !s.deviceApproved) return reply.code(401).send({ error: 'unauthenticated' });
    const user = await getUserById(ctx, s.userId);
    if (!user || user.disabled) return reply.code(401).send({ error: 'unauthenticated' });
    const role = ctx.roles[user.role]!;
    return { userId: user.id, token: await ctx.jf.token(user), deviceId: ctx.jf.deviceId(user), maxBitrate: role.maxBitrate };
  });

  app.post('/internal/webhook/jellyfin', async (req, reply) => {
    if (!checkSecret(req, 'x-webhook-secret', ctx.cfg.WEBHOOK_SECRET)) return reply.code(403).send({ error: 'forbidden' });
    const b = jfWebhook.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const e = b.data;
    if (!e.user || !e.itemId) return { ok: true };
    const r = await ctx.db.query<UserRow>('select * from users where lower(jellyfin_username)=lower($1)', [e.user]);
    const user = r.rows[0];
    if (!user) return { ok: true };
    const ps = `wh-${(e.deviceName ?? 'dev').replace(/[^\w]/g, '').slice(0, 24)}`;
    if (e.type === 'PlaybackStop') await clearLive(ctx, user.id, ps);
    else if (e.type === 'PlaybackStart' || e.type === 'PlaybackProgress') {
      await setLive(ctx, {
        userId: user.id, userName: user.name, itemId: e.itemId, title: e.name ?? '', seriesName: e.seriesName,
        positionTicks: e.positionTicks ?? 0, runtimeTicks: e.runtimeTicks, isPaused: e.isPaused === true || e.isPaused === 'True' || e.isPaused === 'true',
        playSessionId: ps, updatedAt: Date.now(), source: 'jellyfin',
      });
    }
    return { ok: true };
  });
}

/** Fallback when the webhook plugin is not installed: poll GET /Sessions (every 10 s). */
export async function pollJellyfinSessions(ctx: Ctx) {
  const sessions = await ctx.jf.client.sessions();
  const active = sessions.filter((s) => s.NowPlayingItem && !String(s.DeviceId ?? '').startsWith('ff-'));
  if (!active.length) return;
  const r = await ctx.db.query<UserRow>('select * from users where jellyfin_user_id = any($1)', [active.map((s) => s.UserId)]);
  const byJf = new Map(r.rows.map((u) => [u.jellyfin_user_id.replace(/-/g, ''), u]));
  for (const s of active) {
    const u = byJf.get(String(s.UserId).replace(/-/g, ''));
    if (!u) continue;
    const it = s.NowPlayingItem;
    await setLive(ctx, {
      userId: u.id, userName: u.name, itemId: it.Id, title: it.Name, seriesName: it.SeriesName, type: it.Type,
      positionTicks: s.PlayState?.PositionTicks ?? 0, runtimeTicks: it.RunTimeTicks, isPaused: Boolean(s.PlayState?.IsPaused),
      playSessionId: `jf-${s.Id}`, updatedAt: Date.now(), source: 'jellyfin',
    }, 25);
  }
}
