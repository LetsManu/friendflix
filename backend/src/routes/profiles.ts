import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { hashPin, verifyPin } from '../crypto.js';
import { MAX_PROFILES, ProfileError, createProfile, deleteProfile, getProfile, listProfiles, publicProfile } from '../profiles.js';
import { COOKIE, rand, requireUser, saveSession } from '../session.js';
import { forgetAuth } from './internal.js';
import { renamePeerSid } from './tv.js';

const PIN_FAIL_TTL = 15 * 60;
const PIN_MAX_FAILS = 5;

const name = z.string().trim().min(1).max(20);
const avatar = z.string().regex(/^[a-z0-9-]{1,20}$/);
const pin = z.string().regex(/^\d{4}$/);
const uuid = z.guid();

export function profileRoutes(app: FastifyInstance, ctx: Ctx) {
  const secure = ctx.cfg.PUBLIC_URL.startsWith('https://');
  const pre = { preHandler: requireUser(ctx, { allowNoProfile: true }) };

  const send = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ProfileError) return reply.code(e.status).send({ error: e.code });
    throw e;
  };
  const ownerActive = (req: FastifyRequest) => Boolean(req.profile?.is_owner);

  app.get('/api/profiles', pre, async (req) => ({
    profiles: (await listProfiles(ctx, req.user!.id)).map((p) => ({ ...publicProfile(p), hasPin: Boolean(p.pin_hash), active: p.id === req.profile?.id })),
    max: MAX_PROFILES,
    activeId: req.profile?.id ?? null,
  }));

  app.post('/api/profiles', { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = z.object({ name, avatar: avatar.optional(), pin: pin.nullish() }).parse(req.body);
    if (!ownerActive(req)) return reply.code(403).send({ error: 'owner_required' });
    try {
      const p = await createProfile(ctx, req.user!, { name: b.name, avatar: b.avatar, pin: b.pin });
      await audit(ctx, req.user!.id, 'profile.create', p.id, { name: p.name });
      return reply.code(201).send({ profile: { ...publicProfile(p), hasPin: Boolean(p.pin_hash), active: false } });
    } catch (e) {
      return send(reply, e);
    }
  });

  /** owner profile manages everyone, every other profile only itself */
  const manageable = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const p = await getProfile(ctx, req.user!.id, id);
    if (!p) { reply.code(404).send({ error: 'not_found' }); return null; }
    if (!ownerActive(req) && req.profile?.id !== p.id) { reply.code(403).send({ error: 'forbidden' }); return null; }
    return p;
  };

  app.patch('/api/profiles/:id', pre, async (req, reply) => {
    const b = z.object({ name: name.optional(), avatar: avatar.optional() }).parse(req.body);
    const p = await manageable(req, reply);
    if (!p) return;
    try {
      const r = await ctx.db.query(
        'update profiles set name=coalesce($2,name), avatar=coalesce($3,avatar) where id=$1 returning *',
        [p.id, b.name ?? null, b.avatar ?? null],
      );
      const u = r.rows[0] as typeof p;
      return { profile: { ...publicProfile(u), hasPin: Boolean(u.pin_hash), active: u.id === req.profile?.id } };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'name_taken' });
      throw e;
    }
  });

  /** Counts a wrong PIN; true = now locked. */
  const wrongPin = async (profileId: string) => (await ctx.kv.incr(`pinfail:${profileId}`, PIN_FAIL_TTL)) >= PIN_MAX_FAILS;
  const locked = async (profileId: string) => Number((await ctx.kv.get(`pinfail:${profileId}`)) ?? 0) >= PIN_MAX_FAILS;

  app.put('/api/profiles/:id/pin', { ...pre, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ pin: pin.nullable(), currentPin: pin.optional() }).parse(req.body);
    const p = await manageable(req, reply);
    if (!p) return;
    // changing a PIN needs the current one, except for the owner profile managing another profile
    if (p.pin_hash && req.profile!.id === p.id) {
      if (await locked(p.id)) return reply.code(429).send({ error: 'pin_locked' });
      if (!b.currentPin || !verifyPin(b.currentPin, p.pin_hash)) {
        if (await wrongPin(p.id)) return reply.code(429).send({ error: 'pin_locked' });
        return reply.code(403).send({ error: b.currentPin ? 'pin_wrong' : 'pin_required' });
      }
      await ctx.kv.del(`pinfail:${p.id}`);
    }
    await ctx.db.query('update profiles set pin_hash=$2 where id=$1', [p.id, b.pin ? hashPin(b.pin) : null]);
    await audit(ctx, req.user!.id, b.pin ? 'profile.pin_set' : 'profile.pin_clear', p.id);
    return { ok: true, hasPin: Boolean(b.pin) };
  });

  app.delete('/api/profiles/:id', pre, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    if (!ownerActive(req)) return reply.code(403).send({ error: 'owner_required' });
    const p = await getProfile(ctx, req.user!.id, id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    try {
      await deleteProfile(ctx, p);
    } catch (e) {
      return send(reply, e);
    }
    await audit(ctx, req.user!.id, 'profile.delete', p.id, { name: p.name });
    return { ok: true };
  });

  app.post('/api/profiles/:id/select', { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({ pin: pin.optional() }).parse(req.body ?? {});
    const p = await getProfile(ctx, req.user!.id, id);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (p.pin_hash) {
      if (await locked(p.id)) return reply.code(429).send({ error: 'pin_locked' });
      if (!b.pin) return reply.code(403).send({ error: 'pin_required' });
      if (!verifyPin(b.pin, p.pin_hash)) {
        if (await wrongPin(p.id)) return reply.code(429).send({ error: 'pin_locked' });
        return reply.code(403).send({ error: 'pin_wrong' });
      }
      await ctx.kv.del(`pinfail:${p.id}`);
    }
    // The gateway caches the media token per sid: rotate the sid so the previous profile's token can never be served again.
    const oldSid = req.sid!;
    const newSid = rand();
    const s = { ...req.session!, profileId: p.id, touchedAt: Date.now() };
    await saveSession(ctx, newSid, s);
    await ctx.kv.del(`sess:${oldSid}`);
    forgetAuth(oldSid);
    renamePeerSid(req.user!.id, oldSid, newSid);
    const maxAge = Math.max(60, Math.floor(((s.createdAt ?? Date.now()) + (s.ttl ?? ctx.cfg.SESSION_TTL_SECONDS) * 1000 - Date.now()) / 1000));
    reply.setCookie(COOKIE, newSid, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge });
    await audit(ctx, req.user!.id, 'profile.select', p.id);
    return { ok: true, profile: { ...publicProfile(p), hasPin: Boolean(p.pin_hash), active: true }, csrfToken: s.csrf };
  });
}
