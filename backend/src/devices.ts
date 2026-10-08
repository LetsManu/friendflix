import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { dropRemotePeers } from './routes/tv.js';

export const DEVICE_COOKIE = 'ff_dev';

const label = (ua: string) => {
  const os = /Windows|Android|iPhone|iPad|Mac OS X|Linux/.exec(ua)?.[0] ?? 'Gerät';
  const br = /Edg|Firefox|Chrome|Safari/.exec(ua)?.[0] ?? 'Browser';
  return `${br} auf ${os}`.slice(0, 60);
};

/** First device of a user is trusted automatically; every further device needs approval. */
export async function registerDevice(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, userId: string, secure: boolean) {
  let dev = req.cookies[DEVICE_COOKIE];
  if (!dev || !/^[\w-]{20,60}$/.test(dev)) dev = randomBytes(24).toString('base64url');
  reply.setCookie(DEVICE_COOKIE, dev, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 365 * 86400 });
  const existing = await ctx.db.query<{ approved: boolean }>('select approved from devices where user_id=$1 and device_id=$2', [userId, dev]);
  if (existing.rows[0]) {
    await ctx.db.query('update devices set last_seen=now() where user_id=$1 and device_id=$2', [userId, dev]);
    return { deviceId: dev, approved: existing.rows[0].approved };
  }
  const n = await ctx.db.query<{ c: string }>('select count(*) c from devices where user_id=$1 and approved', [userId]);
  const approved = Number(n.rows[0]!.c) === 0;
  await ctx.db.query('insert into devices(user_id, device_id, label, approved) values ($1,$2,$3,$4)', [userId, dev, label(String(req.headers['user-agent'] ?? '')), approved]);
  return { deviceId: dev, approved };
}

/** Deletes sessions of a user (optionally only one device, optionally keeping the current session). Returns the count. */
export async function revokeSessions(ctx: Ctx, userId: string, deviceId?: string, exceptSid?: string): Promise<number> {
  let n = 0;
  const gone = new Set<string>();
  for (const k of await ctx.kv.keys('sess:')) {
    if (exceptSid && k === `sess:${exceptSid}`) continue;
    const raw = await ctx.kv.get(k);
    if (!raw) continue;
    const s = JSON.parse(raw) as { userId: string; deviceId?: string };
    if (s.userId === userId && (!deviceId || s.deviceId === deviceId)) {
      await ctx.kv.del(k);
      gone.add(k.slice('sess:'.length));
      n++;
    }
  }
  if (gone.size) dropRemotePeers(userId, gone);
  return n;
}
