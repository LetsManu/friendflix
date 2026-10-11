import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { castEnabled, castTtlSeconds, createCast, revokeCast } from '../cast.js';
import type { Ctx } from '../ctx.js';
import { JellyfinError } from '../jellyfin/client.js';
import { countLive } from '../live.js';
import { effectiveRole } from '../roles.js';
import { requireUser } from '../session.js';

const itemId = z.string().transform((s) => s.replace(/-/g, '').toLowerCase()).pipe(z.string().regex(/^[0-9a-f]{32}$/));
/** the Chromecast stream is capped well below the role limit: the Default Media Receiver decodes H.264 up to level 4.1 */
export const CAST_MAX_BITRATE = 20_000_000;
export const CAST_MAX_HEIGHT = 1080;

export function castRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };

  app.get('/api/cast/config', pre, async () => ({ enabled: castEnabled(ctx) }));

  app.post('/api/cast/session', { ...pre, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!castEnabled(ctx)) return reply.code(404).send({ error: 'cast_disabled' });
    const b = z.object({
      itemId,
      startTicks: z.number().int().min(0).optional(),
      audioIndex: z.number().int().min(0).optional(),
      maxBitrate: z.number().int().min(300_000).max(200_000_000).optional(),
    }).parse(req.body);
    const deviceId = req.session!.deviceId;
    if (!deviceId) return reply.code(403).send({ error: 'device_pending' });
    const role = (await effectiveRole(ctx, req.user!.role))!;
    if (!role.transcoding) return reply.code(403).send({ error: 'transcoding_disabled' }); // Chromecast always needs a transcoded HLS stream
    if ((await countLive(ctx, req.user!.id)) >= role.maxStreams) return reply.code(429).send({ error: 'max_streams', max: role.maxStreams });
    try {
      const item = await ctx.jf.item(req.jfUser!, b.itemId); // access check: the profile must be able to see the item
      const startTicks = b.startTicks ?? item.positionTicks;
      const maxBitrate = Math.min(role.maxBitrate, CAST_MAX_BITRATE, b.maxBitrate ?? CAST_MAX_BITRATE);
      const maxHeight = Math.min(role.maxHeight ?? CAST_MAX_HEIGHT, CAST_MAX_HEIGHT);
      const info = await ctx.jf.playbackInfo(req.jfUser!, b.itemId, { maxBitrate, maxHeight, startTicks, audioIndex: b.audioIndex, cast: true });
      const ttl = castTtlSeconds(info.runtimeTicks, startTicks);
      const { ct, castId, expiresAt } = await createCast(ctx, {
        userId: req.user!.id, profileId: req.profile!.id, deviceId, itemId: b.itemId, mediaSourceId: info.mediaSourceId, playSessionId: info.playSessionId, maxBitrate,
      }, ttl);
      // Jellyfin returns /media/... URLs; the cast variant carries the token in the path: /media/c/<ct>/...
      const abs = (u: string) => `${ctx.cfg.PUBLIC_URL.replace(/\/+$/, '')}/media/c/${ct}${u.slice('/media'.length)}`;
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
        imageUrl: item.image ? abs(`/media/Items/${b.itemId}/Images/Primary?maxWidth=600`) : undefined,
        subtitles: info.subtitles.map((s) => ({ index: s.index, language: s.language, title: s.title, url: abs(s.url) })),
      };
    } catch (e) {
      if (e instanceof JellyfinError) return reply.code(e.status === 404 ? 404 : e.status === 403 ? 403 : 502).send({ error: 'jellyfin', status: e.status });
      throw e;
    }
  });

  app.delete('/api/cast/session/:castId', pre, async (req, reply) => {
    const { castId } = z.object({ castId: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.params);
    return (await revokeCast(ctx, req.user!.id, castId)) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });
}
