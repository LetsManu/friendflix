// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CAST_MAX_BITRATE, CAST_MAX_HEIGHT, CAST_REPORT_RE, castEnabled, castReceiverAppId, castReportToken, castSubtitlePath, castTtlSeconds, castPredecessor, createCast, resolveCastSubtitle, revokeCast, verifyCastReport } from '../cast.js';
import type { Ctx } from '../ctx.js';
import { MediaError } from '../media/types.js';
import { countLive } from '../live.js';
import { clientAddress, isHomeRequest } from '../netaddr.js';
import { playbackReport } from './media.js';
import { effectiveLimits } from '../limits.js';
import { remoteBitrateCap } from '../roles.js';
import { requireUser } from '../session.js';
import { id32 as itemId } from './_shared.js';

export function castRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };

  // receiverAppId only when FriendFlix's own receiver is configured: without it the sender keeps the Default Media Receiver
  app.get('/api/cast/config', pre, async () => {
    const receiverAppId = castReceiverAppId(ctx);
    return { enabled: castEnabled(ctx), ...(receiverAppId ? { receiverAppId } : {}) };
  });

  app.post('/api/cast/session', { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!castEnabled(ctx)) return reply.code(404).send({ error: 'cast_disabled' });
    const b = z.object({
      itemId,
      startTicks: z.number().int().min(0).optional(),
      audioIndex: z.number().int().min(0).optional(),
      maxBitrate: z.number().int().min(300_000).max(200_000_000).optional(),
      /** sender protocol: Chromecast (default) or Safari AirPlay (same token flow, two-address pin, see cast.ts) */
      via: z.enum(['chromecast', 'airplay']).optional(),
      /** the next episode for the receiver's queue (Chromecast): it follows this device's running cast, whose stream it replaces */
      next: z.boolean().optional(),
      /** with `next`: the castId of the cast it follows (must be this device's newest one) */
      after: z.string().regex(/^[0-9a-f]{32}$/).optional(),
      /** the sender casts to FriendFlix's own receiver: the answer carries its report token (`report`, see cast.ts castReportToken) */
      receiver: z.boolean().optional(),
    }).parse(req.body);
    const deviceId = req.session!.deviceId;
    if (!deviceId) return reply.code(403).send({ error: 'device_pending' });
    const role = (await effectiveLimits(ctx, req.user!))!;
    if (!role.transcoding) return reply.code(403).send({ error: 'transcoding_disabled' }); // Chromecast always needs a transcoded HLS stream
    // the queued next episode follows this device's running cast (resolved here, never taken from the client): it may be asked for
    // while that cast fills the stream limit (never beyond), and the gateway serves it only as that cast's successor (cast.ts nextOverlap)
    const pred = b.next ? await castPredecessor(ctx, req.user!.id, deviceId) : null;
    if (b.next && !pred) return reply.code(429).send({ error: 'max_streams', max: role.maxStreams });
    if (pred && b.after !== undefined && b.after !== pred.castId) return reply.code(409).send({ error: 'cast_mismatch' });
    const live = await countLive(ctx, req.user!.id);
    if (live >= role.maxStreams && !(pred && live === role.maxStreams)) return reply.code(429).send({ error: 'max_streams', max: role.maxStreams });
    try {
      const item = await ctx.jf.item(req.jfUser!, b.itemId); // access check: the profile must be able to see the item
      const startTicks = b.startTicks ?? item.positionTicks;
      // the cast device streams over the same uplink as the sender: outside the home networks the remote cap applies
      const remote = !isHomeRequest(req, ctx.cfg.HOME_NETWORKS);
      const ceiling = remote ? remoteBitrateCap(role) : role.maxBitrate;
      const maxBitrate = Math.min(ceiling, CAST_MAX_BITRATE, b.maxBitrate ?? CAST_MAX_BITRATE);
      const maxHeight = Math.min(role.maxHeight ?? CAST_MAX_HEIGHT, CAST_MAX_HEIGHT);
      const opts = { maxBitrate, maxHeight, startTicks, audioIndex: b.audioIndex, cast: true };
      let info = await ctx.jf.playbackInfo(req.jfUser!, b.itemId, opts);
      if (ctx.jf.preparePlayback) info = await ctx.jf.preparePlayback(req.jfUser!, info, opts);
      const ttl = castTtlSeconds(info.runtimeTicks, startTicks);
      const rec = {
        userId: req.user!.id, profileId: req.profile!.id, deviceId, itemId: b.itemId, mediaSourceId: info.mediaSourceId, playSessionId: info.playSessionId, maxBitrate, title: item.name, via: b.via ?? 'chromecast',
        ...(pred ? { afterPs: pred.playSessionId } : {}),
      } as const;
      const { ct, imgCt, castId, expiresAt } = await createCast(ctx, rec, ttl, Boolean(item.image));
      const report = b.receiver && rec.via === 'chromecast' && castReceiverAppId(ctx) ? castReportToken(ctx, rec, { castId, expiresAt }) : undefined;
      // Jellyfin returns /media/... URLs; the cast variant carries the token in the path: /media/c/<ct>/...
      const absWith = (t: string, u: string) => `${ctx.cfg.PUBLIC_URL.replace(/\/+$/, '')}/media/c/${t}${u.slice('/media'.length)}`;
      const abs = (u: string) => absWith(ct, u);
      const origin = ctx.cfg.PUBLIC_URL.replace(/\/+$/, '');
      // subtitles FriendFlix serves itself (/api/items/…/stream.vtt, capabilities.subtitleExtract) get a signed cast URL; Jellyfin: gateway path
      const subUrl = (u: string) => {
        const p = ctx.jf.capabilities.subtitleExtract ? castSubtitlePath(ctx, u, { userId: req.user!.id, castId, expiresAt }) : null;
        return p ? `${origin}${p}` : abs(u);
      };
      reply.header('Cache-Control', 'no-store');
      return {
        castId,
        expiresAt,
        playSessionId: info.playSessionId,
        mediaSourceId: info.mediaSourceId,
        runtimeTicks: info.runtimeTicks,
        startTime: Math.floor(startTicks / 10_000_000),
        contentUrl: abs(info.hlsUrl),
        contentType: 'application/x-mpegURL',
        hlsSegmentFormat: 'ts',
        title: item.name,
        seriesName: item.seriesName,
        // the poster gets its own image-only token: the media token must never appear in a URL the receiver shows or fetches as an image
        imageUrl: imgCt ? absWith(imgCt, `/media/Items/${b.itemId}/Images/Primary?maxWidth=600`) : undefined,
        subtitles: info.subtitles.map((s) => ({ index: s.index, language: s.language, title: s.title, url: subUrl(s.url) })),
        ...(report ? { report } : {}),
      };
    } catch (e) {
      if (e instanceof MediaError) return reply.code(e.status === 404 ? 404 : e.status === 403 ? 403 : 502).send({ error: 'jellyfin', status: e.status });
      throw e;
    }
  });

  // FriendFlix-served subtitle for the receiver (no cookie): the signed URL from castSubtitlePath() is the credential
  app.get('/api/cast/subtitle/:uid/:cid/:exp/:sig/:id/:ms/:index/stream.vtt', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('access-control-allow-origin', '*').header('cross-origin-resource-policy', 'cross-origin').header('cache-control', 'no-store');
    const p = z.object({
      uid: z.string().regex(/^[0-9a-f-]{36}$/), cid: z.string().regex(/^[0-9a-f]{32}$/), exp: z.coerce.number().int().positive(), sig: z.string().regex(/^[\w-]{43}$/),
      id: itemId, ms: z.string().regex(/^[\w-]{1,64}$/), index: z.coerce.number().int().min(0).max(999),
    }).safeParse(req.params);
    if (!ctx.jf.capabilities.subtitleExtract || !p.success) return reply.code(404).send({ error: 'not_found' });
    const { sig, id, ...rest } = p.data;
    const user = await resolveCastSubtitle(ctx, { ...rest, itemId: id }, sig);
    if (!user) return reply.code(404).send({ error: 'not_found' });
    try {
      await ctx.jf.item(user, p.data.id); // the profile must still see the item
      const res = await ctx.jf.subtitleStream(user, p.data.id, p.data.ms, p.data.index, 'vtt');
      if (!res.ok) return reply.code(404).send({ error: 'not_found' });
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > 10 * 1024 * 1024) return reply.code(502).send({ error: 'jellyfin', reason: 'too_large' });
      return reply.header('content-type', 'text/vtt; charset=utf-8').send(body);
    } catch (e) {
      if (e instanceof MediaError) return [400, 403, 404].includes(e.status) ? reply.code(404).send({ error: 'not_found' }) : reply.code(502).send({ error: 'jellyfin', status: e.status });
      throw e;
    }
  });

  /**
   * FriendFlix's own receiver reports the play session of the cast token it plays (no cookie: the report token is the credential,
   * see cast.ts verifyCastReport). The same report logic as /api/playback/* with the token's account, profile and device, so the
   * stream limit, kids rules and statistics apply unchanged. Off (404) without CAST_RECEIVER_APP_ID.
   */
  app.post('/api/cast/report', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!castReceiverAppId(ctx)) return reply.code(404).send({ error: 'not_found' });
    const p = z.object({
      rt: z.string().regex(CAST_REPORT_RE),
      event: z.enum(['start', 'progress', 'stop']),
      positionTicks: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      isPaused: z.boolean().default(false),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid' });
    const v = await verifyCastReport(ctx, p.data.rt, clientAddress(req));
    if (!v.ok) return reply.code(v.status).send({ error: v.error });
    const c = v.claims;
    try {
      const kind = p.data.event === 'start' ? 'Playing' : p.data.event === 'stop' ? 'Playing/Stopped' : 'Playing/Progress';
      const r = await playbackReport(ctx, kind, { itemId: c.i, playSessionId: c.ps, mediaSourceId: c.ms, positionTicks: p.data.positionTicks, isPaused: p.data.isPaused, playMethod: 'Transcode' },
        { user: v.user, jfUser: v.jfUser, profile: v.prof, deviceId: c.d });
      return 'error' in r ? reply.code(429).send(r) : r;
    } catch (e) {
      if (e instanceof MediaError) return reply.code(e.status === 404 || e.status === 403 ? 404 : 502).send({ error: 'jellyfin', status: e.status });
      throw e;
    }
  });

  app.delete('/api/cast/session/:castId', pre, async (req, reply) => {
    const { castId } = z.object({ castId: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.params);
    return (await revokeCast(ctx, req.user!.id, castId)) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });
}
