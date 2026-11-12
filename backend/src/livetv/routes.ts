// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CAST_TOKEN_RE } from '../cast.js';
import type { Ctx } from '../ctx.js';
import { effectiveLimits } from '../limits.js';
import { clientAddress, isHomeRequest } from '../netaddr.js';
import { loadSession, requireUser } from '../session.js';
import { CHANNEL_SELECT, toEffective, type EffectiveRow } from './channels.js';
import { LivetvError, livetvBytes } from './client.js';
import { livetvInstalled } from './detect.js';
import { nowNext } from './epg.js';
import { readLogo } from './logos.js';
import { channelSet } from './rights.js';
import { clearJoinMark, receivingChannelIds, runningChannelIds, startOrJoin } from './streams.js';
import { beatLiveToken, deviceLiveSessions, endLiveToken, LIVE_CAP_S, liveSidHash, mintLiveToken, revokeLiveToken } from './tokens.js';
import { addFavourite, favouriteIds, recentIds, recordRecent, removeFavourite, setFavouriteOrder, RECENT_MAX } from './userdata.js';

/** a logo never changes under its hash (sha256 of the bytes): the browser keeps it a week without asking again */
const LOGO_CACHE = 'private, max-age=604800, immutable';
const HASH_RE = /^[0-9a-f]{64}$/;
const EXP_RE = /^[0-9]{1,15}$/;

// ---- signed logo URLs for the cast receiver (F11, ruling 22) ----

const logoKey = (ctx: Pick<Ctx, 'encKey'>) => createHmac('sha256', ctx.encKey).update('friendflix livetv logo v1').digest();
const logoSig = (ctx: Pick<Ctx, 'encKey'>, hash: string, exp: number) => createHmac('sha256', logoKey(ctx)).update(`${hash}|${exp}`).digest('base64url');

/**
 * The logo of a channel as a cast receiver can load it: absolute (`PUBLIC_URL` origin; the receiver cannot resolve a relative URL) and
 * signed (it sends no cookie): `<origin>/api/livetv/logos/<hash>?exp=<ms>&sig=<hmac>`, HMAC (label `friendflix livetv logo v1`, key
 * derived from APP_ENC_KEY, like castSubtitlePath) over the hash and the expiry. Valid until `exp` (epoch ms).
 */
export function logoUrl(ctx: Pick<Ctx, 'encKey' | 'cfg'>, hash: string, exp: number): string {
  let origin = '';
  try { origin = ctx.cfg.PUBLIC_URL ? new URL(ctx.cfg.PUBLIC_URL).origin : ''; } catch { /* no public URL yet: a path only */ }
  const e = Math.floor(exp);
  return `${origin}/api/livetv/logos/${hash}?exp=${e}&sig=${logoSig(ctx, hash, e)}`;
}

function signedLogoOk(ctx: Ctx, hash: string, exp: unknown, sig: unknown): boolean {
  if (!HASH_RE.test(hash) || typeof exp !== 'string' || !EXP_RE.test(exp) || typeof sig !== 'string' || sig.length > 100) return false;
  const e = Number(exp);
  if (e <= Date.now()) return false;
  const want = Buffer.from(logoSig(ctx, hash, e));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

const via = z.enum(['local', 'chromecast', 'airplay']);
const watchBody = z.object({ via: via.optional() }).strict();
const tokenBody = z.object({ token: z.string().regex(CAST_TOKEN_RE) }).strict();
const channelId = z.guid();
const lastBody = z.object({ id: channelId }).strict();
const favouritesBody = z.object({ ids: z.array(channelId).max(5000) }).strict();
/** a preview image is a few dozen KB; a bigger answer is not one */
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const PREVIEW_CACHE = 'private, max-age=60';
/** `{ error: 'invalid', field }` of a failed safeParse (never the input echoed) */
const invalid = (reply: FastifyReply, e: z.ZodError) => reply.code(400).send({ error: 'invalid', field: String(e.issues[0]?.path[0] ?? 'body') });

/**
 * The user side of Live TV (spec §10, `requireUser`; kids profiles allowed unless a route says otherwise): logos (Task 19, plus the signed
 * cast variant), watching, the heartbeat and stopping (Task 31), the channel list with its preview image, ordered favourites, *Zuletzt
 * gesehen* and the last channel (Task 33). Every route answers from the asking profile's own `channelSet`: a channel outside it is never
 * named, also not through its favourites, its recent entries or its preview.
 */
export function livetvRoutes(app: FastifyInstance, ctx: Ctx) {
  const userCheck = requireUser(ctx);
  const user = { preHandler: userCheck };

  // channel logos by hash (provider, XMLTV or an admin's upload); an unknown or malformed hash is a 404. With `exp` and `sig` (logoUrl,
  // F11) the signature is the credential and no cookie is needed; a wrong or expired one is a 403. Without them the session decides.
  const logoAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = (req.query ?? {}) as { exp?: unknown; sig?: unknown };
    if (q.exp === undefined && q.sig === undefined) return userCheck(req, reply);
    if (!signedLogoOk(ctx, String((req.params as { hash?: string }).hash ?? ''), q.exp, q.sig)) return reply.code(403).send({ error: 'forbidden' });
  };
  app.get('/api/livetv/logos/:hash', { preHandler: logoAuth }, async (req, reply) => {
    const logo = await readLogo(ctx, String((req.params as { hash?: string }).hash ?? ''));
    if (!logo) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', logo.mime).header('cache-control', LOGO_CACHE).header('content-security-policy', "default-src 'none'").send(logo.bytes);
  });

  /**
   * Watch a channel (spec §7.2): rights (the caller's own active profile), the account's `maxStreams` (this device's current live view
   * is replaced, not counted), start or join (streams.ts), then a token for `/media/l/<token>/index.m3u8`. The client keeps the last
   * channel itself (`PUT /api/livetv/last`).
   */
  app.post('/api/livetv/channels/:id/watch', { ...user, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!livetvInstalled(ctx)) return reply.code(404).send({ error: 'livetv_off' });
    const b = watchBody.safeParse(req.body ?? {});
    if (!b.success) return invalid(reply, b.error);
    const id = String((req.params as { id?: string }).id ?? '');
    const u = { id: req.user!.id, role: req.user!.role };
    const profile = { id: req.profile!.id, kids: Boolean(req.profile!.kids) };
    // the set of this profile (the cache trusts its caller: never another profile's), read-only
    if (!(await channelSet(ctx, u, profile)).has(id)) return reply.code(403).send({ error: 'forbidden' });
    const row = (await ctx.db.query<EffectiveRow>(`${CHANNEL_SELECT} where c.id = $1`, [id])).rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const ch = toEffective(row);
    const deviceId = req.session!.deviceId;
    if (!deviceId) return reply.code(403).send({ error: 'device_pending' });

    const limits = (await effectiveLimits(ctx, u))!;
    const prefix = `play:${u.id}:`;
    const own = new Set(await deviceLiveSessions(ctx, u.id, deviceId));
    const counted = (await ctx.kv.keys(prefix)).filter((k) => !own.has(k.slice(prefix.length))).length;
    if (counted >= limits.maxStreams) return reply.code(429).send({ error: 'max_streams', max: limits.maxStreams });

    const r = await startOrJoin(ctx, { userId: u.id, deviceId, role: u.role }, ch, profile);
    if ('status' in r) {
      const { status, ...body } = r;
      return reply.code(status).send(body);
    }
    const v = b.data.via ?? 'local';
    const minted = await mintLiveToken(ctx, {
      userId: u.id, profileId: profile.id, deviceId, sidHash: liveSidHash(req.sid!), channelId: ch.id, channelName: ch.name, kind: 'live', via: v,
      remote: !isHomeRequest(req, ctx.cfg.HOME_NETWORKS),
    });
    // the token's viewer key now keeps the stream (F9); the join marker would only hold off a later release of this channel
    await clearJoinMark(ctx, ch.id, { userId: u.id, deviceId });
    // a profile switch or sign-out that raced this request revoked the device's tokens before this one existed: take it back
    const after = await loadSession(ctx, req.sid);
    if (!after || (after.profileId && after.profileId !== profile.id)) {
      await revokeLiveToken(ctx, minted.hash);
      return reply.code(409).send({ error: 'profile_changed' });
    }
    const nn = (await nowNext(ctx, [ch.id])).get(ch.id);
    const logo = ch.logoHash
      ? (v === 'chromecast' ? logoUrl(ctx, ch.logoHash, Date.now() + LIVE_CAP_S * 1000) : `/api/livetv/logos/${ch.logoHash}`)
      : null;
    reply.header('cache-control', 'no-store');
    return {
      token: minted.token,
      url: `/media/l/${minted.token}/index.m3u8`,
      expiresAt: minted.expiresAt,
      dvrSeconds: ctx.cfg.LIVETV_DVR_MINUTES * 60,
      mode: r.mode,
      channel: { id: ch.id, number: ch.number, name: ch.name, logo },
      now: nn?.now ?? null,
      next: nn?.next ?? null,
    };
  });

  /** the player's heartbeat every 20 s while it is open (spec §7.2); the address re-pins a `local` token of this session (Review Focus 4) */
  app.post('/api/livetv/beat', { ...user, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = tokenBody.safeParse(req.body);
    if (!b.success) return invalid(reply, b.error);
    const r = await beatLiveToken(ctx, b.data.token, { userId: req.user!.id, sidHash: liveSidHash(req.sid!), ip: clientAddress(req) });
    reply.header('cache-control', 'no-store');
    if (!r.ok) return reply.code(410).send({ error: 'gone' });
    return { ok: true, expiresAt: r.expiresAt };
  });

  /** stop watching (player close, `pagehide` with keepalive): the caller's own token goes; the answer is the same for any token */
  app.delete('/api/livetv/watch', { ...user, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = tokenBody.safeParse(req.body);
    if (!b.success) return invalid(reply, b.error);
    await endLiveToken(ctx, b.data.token, req.user!.id);
    return reply.code(204).send();
  });

  // ---- the list, favourites, recently watched (Task 33) ----

  /** the asking account and its active profile, as every rights call wants them */
  const whoAsks = (req: FastifyRequest) => ({
    u: { id: req.user!.id, role: req.user!.role },
    profile: { id: req.profile!.id, kids: Boolean(req.profile!.kids) },
  });

  /**
   * The channels of this profile (spec §10): only its `channelSet`, also in `favourites`, `recent` and `last`. `ETag` = sha1 of the body, so
   * the client's 30-s refresh of now / next costs a 304 while nothing changed. `running` and `preview` come from livetv's stream list,
   * `receiving` (push feeds only) from its ingest list; a livetv that does not answer shows nothing running and nothing receiving.
   */
  app.get('/api/livetv/channels', { ...user, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!livetvInstalled(ctx)) return reply.code(404).send({ error: 'livetv_off' });
    const { u, profile } = whoAsks(req);
    const visible = await channelSet(ctx, u, profile);
    const idList = [...visible];
    const [rows, favs, rec, running, receiving] = await Promise.all([
      idList.length ? ctx.db.query<EffectiveRow>(`${CHANNEL_SELECT} where c.id = any($1::uuid[])`, [idList]).then((r) => r.rows.map(toEffective)) : [],
      favouriteIds(ctx, profile.id),
      recentIds(ctx, profile.id),
      runningChannelIds(ctx),
      receivingChannelIds(ctx),
    ]);
    const nn = await nowNext(ctx, idList);
    const groupIds = [...new Set(rows.flatMap((c) => (c.groupId ? [c.groupId] : [])))];
    // only groups the profile's channels are in: a group it may not see is never named
    const groups = groupIds.length
      ? (await ctx.db.query<{ id: string; name: string; position: number }>(
        'select id, name, position from livetv_groups where id = any($1::uuid[]) order by position, lower(name), id', [groupIds])).rows
      : [];
    const groupPos = new Map(groups.map((g) => [g.id, g.position] as const));
    const favourites = favs.filter((id) => visible.has(id));
    const fav = new Set(favourites);
    const recent = rec.filter((id) => visible.has(id)).slice(0, RECENT_MAX);

    const channels = rows
      .sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
      .map((c) => {
        const n = nn.get(c.id);
        const isRunning = running?.has(c.id) ?? false;
        return {
          id: c.id,
          number: c.number,
          name: c.name,
          logo: c.logoHash ? `/api/livetv/logos/${c.logoHash}` : null,
          groupId: c.groupId,
          ...(c.groupId && groupPos.has(c.groupId) ? { groupPos: groupPos.get(c.groupId) } : {}),
          running: isRunning,
          ...(c.ingest === 'push' ? { receiving: receiving?.has(c.id) ?? false } : {}),
          // ruling 58: a programme covers now / mapped but nothing covers now / not mapped
          epg: n?.now ? 'ok' : c.epg ? 'gap' : 'none',
          ...(isRunning ? { preview: `/api/livetv/channels/${c.id}/preview.jpg` } : {}),
          ...(n?.now ? { now: n.now } : {}),
          ...(n?.next ? { next: n.next } : {}),
          favourite: fav.has(c.id),
        };
      });
    const body = JSON.stringify({
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
      channels,
      favourites,
      recent,
      last: recent[0] ? { id: recent[0], previous: recent[1] ?? null } : null,
      dvrSeconds: ctx.cfg.LIVETV_DVR_MINUTES * 60,
    });
    const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
    reply.header('etag', etag).header('cache-control', 'private, no-cache').header('vary', 'cookie, x-ff-profile');
    const inm = String(req.headers['if-none-match'] ?? '');
    if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(body);
  });

  /** the newest image of a running channel (livetv keeps it); 404 for a channel that is not running or that this profile may not see */
  app.get('/api/livetv/channels/:id/preview.jpg', { ...user, config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const gone = () => reply.code(404).send({ error: 'not_found' });
    if (!livetvInstalled(ctx)) return gone();
    const id = channelId.safeParse((req.params as { id?: string }).id).data;
    if (!id) return gone();
    const { u, profile } = whoAsks(req);
    if (!(await channelSet(ctx, u, profile)).has(id)) return gone();
    if (!(await runningChannelIds(ctx))?.has(id)) return gone();
    try {
      const jpeg = await livetvBytes(ctx, `/v1/streams/${id}/preview.jpg`, { timeoutMs: 5_000, maxBytes: PREVIEW_MAX_BYTES });
      return reply.header('content-type', 'image/jpeg').header('cache-control', PREVIEW_CACHE).header('x-content-type-options', 'nosniff').send(jpeg);
    } catch (e) {
      if (e instanceof LivetvError) return gone(); // not running any more, or livetv does not answer: no image
      throw e;
    }
  });

  const write = { ...user, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  /** the complete order of the favourites this profile sees; the ones left out (e.g. hidden by a lost right) follow in their old order */
  app.put('/api/livetv/favourites', write, async (req, reply) => {
    if (!livetvInstalled(ctx)) return reply.code(404).send({ error: 'livetv_off' });
    const b = favouritesBody.safeParse(req.body);
    if (!b.success) return invalid(reply, b.error);
    const { u, profile } = whoAsks(req);
    if (!(await setFavouriteOrder(ctx, profile.id, b.data.ids, await channelSet(ctx, u, profile)))) return reply.code(400).send({ error: 'invalid', field: 'ids' });
    return { ok: true };
  });

  /** a new favourite goes last (`max(position) + 1`); a channel this profile may not see is a 403 */
  app.post('/api/livetv/favourites/:id', write, async (req, reply) => {
    if (!livetvInstalled(ctx)) return reply.code(404).send({ error: 'livetv_off' });
    const id = channelId.safeParse((req.params as { id?: string }).id).data;
    if (!id) return reply.code(404).send({ error: 'not_found' });
    const { u, profile } = whoAsks(req);
    if (!(await channelSet(ctx, u, profile)).has(id)) return reply.code(403).send({ error: 'forbidden' });
    await addFavourite(ctx, profile.id, id);
    return { ok: true };
  });

  /** the profile's own row goes (also a hidden favourite); another profile's favourites are never touched */
  app.delete('/api/livetv/favourites/:id', write, async (req, reply) => {
    const id = channelId.safeParse((req.params as { id?: string }).id).data;
    if (!id) return reply.code(404).send({ error: 'not_found' });
    await removeFavourite(ctx, req.profile!.id, id);
    return { ok: true };
  });

  /** records a watch in *Zuletzt gesehen* (the 10 newest stay); *last* = the newest, *previous* = the second newest the profile sees */
  app.put('/api/livetv/last', write, async (req, reply) => {
    if (!livetvInstalled(ctx)) return reply.code(404).send({ error: 'livetv_off' });
    const b = lastBody.safeParse(req.body);
    if (!b.success) return invalid(reply, b.error);
    const { u, profile } = whoAsks(req);
    if (!(await channelSet(ctx, u, profile)).has(b.data.id)) return reply.code(403).send({ error: 'forbidden' });
    await recordRecent(ctx, profile.id, b.data.id);
    return { ok: true };
  });
}
