// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CAST_MAX_BITRATE, CAST_MAX_HEIGHT, CAST_REPORT_RE, castEnabled, castReceiverAppId, castReportToken, castSubtitlePath, castTtlSeconds, castPredecessor, castLookup, castNextTtlSeconds, castPinned, CastUnpinnedError, createCast, resolveCastSubtitle, revokeCast, verifyCastReport } from '../cast.js';
import type { Ctx } from '../ctx.js';
import { receiverCaps } from '../media/clientCaps.js';
import { MediaError, type HevcGate } from '../media/types.js';
import { bindHevcGrant, hevcGate as gateHevc, noteHevcFailure } from '../hevcenc.js';
import { countLive } from '../live.js';
import { clientAddress, isHomeRequest } from '../netaddr.js';
import { playbackReport } from './media.js';
import { effectiveLimits } from '../limits.js';
import { remoteBitrateCap } from '../roles.js';
import { loadSession, requireUser } from '../session.js';
import { id32 as itemId } from './_shared.js';

const psId = z.string().regex(/^[\w-]{8,64}$/);

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
      /** FriendFlix's own receiver only: what it confirmed it plays (receiverCaps); anything malformed is ignored, never an error */
      caps: z.unknown().optional(),
      /** the sender's one automatic fallback after the receiver failed a stream with that feature, and the play session it replaces */
      fellBack: z.enum(['hevc', 'surround', 'both']).optional(),
      prevPs: psId.optional(),
    }).parse(req.body);
    // the queue is Chromecast only (an AirPlay token has a two-address pin, a queued token never takes a pin of its own)
    if (b.next && b.via === 'airplay') return reply.code(400).send({ error: 'bad_request' });
    const deviceId = req.session!.deviceId;
    if (!deviceId) return reply.code(403).send({ error: 'device_pending' });
    const role = (await effectiveLimits(ctx, req.user!))!;
    if (!role.transcoding) return reply.code(403).send({ error: 'transcoding_disabled' }); // Chromecast always needs a transcoded HLS stream
    // the queued next episode follows this device's running cast (resolved here, never taken from the client): it may be asked for
    // while that cast fills the stream limit (never beyond), and the gateway serves it only as that cast's successor (cast.ts nextOverlap)
    const pred = b.next ? await castPredecessor(ctx, req.user!.id, deviceId) : null;
    if (b.next && !pred) return reply.code(429).send({ error: 'max_streams', max: role.maxStreams });
    if (pred && b.after !== undefined && b.after !== pred.castId) return reply.code(409).send({ error: 'cast_mismatch' });
    // the queued token is pinned to its predecessor's address at mint: a predecessor nobody fetched yet has none, so nothing is minted
    if (pred && !(await castPinned(ctx, pred.hash))) return reply.code(409).send({ error: 'cast_unpinned' });
    const live = await countLive(ctx, req.user!.id);
    if (live >= role.maxStreams && !(pred && live === role.maxStreams)) return reply.code(429).send({ error: 'max_streams', max: role.maxStreams });
    let started: string | undefined;
    try {
      const item = await ctx.jf.item(req.jfUser!, b.itemId); // access check: the profile must be able to see the item
      const startTicks = b.startTicks ?? item.positionTicks;
      // the cast device streams over the same uplink as the sender: outside the home networks the remote cap applies
      const remote = !isHomeRequest(req, ctx.cfg.HOME_NETWORKS);
      const ceiling = remote ? remoteBitrateCap(role) : role.maxBitrate;
      const maxBitrate = Math.min(ceiling, CAST_MAX_BITRATE, b.maxBitrate ?? CAST_MAX_BITRATE);
      const maxHeight = Math.min(role.maxHeight ?? CAST_MAX_HEIGHT, CAST_MAX_HEIGHT);
      // `after` = the predecessor's play session (server-resolved), so the Plex stream limit lets the queued episode overlap only that one
      // HEVC / Dolby surround only for FriendFlix's own receiver (the Default Media Receiver and AirPlay never state them), on Jellyfin, and only
      // when the receiver confirmed something: otherwise the URL and the answer are exactly today's
      const own = Boolean(b.receiver) && (b.via ?? 'chromecast') === 'chromecast' && castReceiverAppId(ctx) !== '' && ctx.jf.kind === 'jellyfin';
      const clientCaps = own ? receiverCaps(b.caps) : null;
      const grantId = randomUUID();
      // a conversion for the receiver follows the player's rules: remote only, the server's HEVC gate (probe, limit, failure pause)
      const gate = (): Promise<HevcGate> => gateHevc(ctx, { userId: req.user!.id, deviceId, playSessionIdHint: grantId });
      // the receiver failed a stream that was a HEVC conversion: it counts against the server's HEVC state (as a player fallback does)
      if ((b.fellBack === 'hevc' || b.fellBack === 'both') && b.prevPs) {
        let prev: { video?: unknown } | null;
        try { prev = JSON.parse((await ctx.kv.get(`pbinfo:${req.user!.id}:${b.prevPs}`).catch(() => null)) ?? 'null'); } catch { prev = null; }
        if (prev?.video === 'hevc') await noteHevcFailure(ctx, deviceId);
      }
      const opts = {
        maxBitrate, maxHeight, startTicks, audioIndex: b.audioIndex, cast: true, ...(pred ? { after: pred.playSessionId } : {}),
        ...(clientCaps ? { clientCaps, remote, surround: ctx.cfg.SURROUND_AUDIO !== 'false', ...(ctx.cfg.HEVC_STREAMS > 0 ? { hevcGate: gate } : {}) } : {}),
      };
      let info = await ctx.jf.playbackInfo(req.jfUser!, b.itemId, opts);
      if (ctx.jf.preparePlayback) info = await ctx.jf.preparePlayback(req.jfUser!, info, opts);
      if (clientCaps) {
        await bindHevcGrant(ctx, grantId, info.delivery?.video === 'hevc' ? info.playSessionId : null); // a grant only lives on for a conversion
        // the server's HEVC count and the next fallback look at the fixed codes of this play session (as /api/playback/info writes them)
        if (info.delivery) await ctx.kv.set(`pbinfo:${req.user!.id}:${info.playSessionId}`, JSON.stringify({ video: info.delivery.video, audio: info.delivery.audio }), 6 * 3600).catch(() => undefined);
      }
      started = info.playSessionId;
      const ownTtl = castTtlSeconds(info.runtimeTicks, startTicks);
      // a queued token outlives the episode it follows (queued from the start of that episode)
      const ttl = pred ? castNextTtlSeconds(ownTtl, pred.exp) : ownTtl;
      const rec = {
        userId: req.user!.id, profileId: req.profile!.id, deviceId, itemId: b.itemId, mediaSourceId: info.mediaSourceId, playSessionId: info.playSessionId, maxBitrate, title: item.name, via: b.via ?? 'chromecast',
        ...(pred ? { afterPs: pred.playSessionId } : {}),
        runtimeTicks: info.runtimeTicks, ...(item.seriesName ? { seriesName: item.seriesName } : {}),
        subs: info.subtitles.map((s) => ({ index: s.index, ...(s.language ? { language: s.language } : {}), title: s.title })),
      } as const;
      const { ct, imgCt, castId, expiresAt } = await createCast(ctx, rec, ttl, Boolean(item.image), pred ?? undefined);
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
      // A profile switch (POST /api/profiles/:id/select) revokes this device's tokens, but one minted by a request that was already
      // past requireUser could land after that revoke: re-read the session (the old sid stays readable for a few seconds, already
      // acting as the new profile) and take the token back when the profile is no longer the one it was minted for.
      const after = await loadSession(ctx, req.sid);
      if (!after || (after.profileId && after.profileId !== rec.profileId)) {
        await revokeCast(ctx, req.user!.id, castId);
        await ctx.jf.stopEncoding(req.jfUser!, info.playSessionId).catch(() => undefined);
        return reply.code(409).send({ error: 'profile_changed' });
      }
      reply.header('Cache-Control', 'no-store');
      const fmp4 = new URL(info.hlsUrl, 'http://x').searchParams.get('SegmentContainer') === 'mp4';
      return {
        castId,
        expiresAt,
        playSessionId: info.playSessionId,
        mediaSourceId: info.mediaSourceId,
        runtimeTicks: info.runtimeTicks,
        startTime: Math.floor(startTicks / 10_000_000),
        contentUrl: abs(info.hlsUrl),
        contentType: 'application/x-mpegURL',
        // fMP4 when the plan carries HEVC or surround (SegmentContainer=mp4 in the URL the plan built); only a cast with receiver caps can have one
        ...(fmp4 ? { hlsSegmentFormat: 'fmp4', hlsVideoSegmentFormat: 'fmp4' } : { hlsSegmentFormat: 'ts' }),
        title: item.name,
        seriesName: item.seriesName,
        // the poster gets its own image-only token: the media token must never appear in a URL the receiver shows or fetches as an image
        imageUrl: imgCt ? absWith(imgCt, `/media/Items/${b.itemId}/Images/Primary?maxWidth=600`) : undefined,
        subtitles: info.subtitles.map((s) => ({ index: s.index, language: s.language, title: s.title, url: subUrl(s.url) })),
        ...(report ? { report } : {}),
        // what the stream carries, as fixed codes (never a URL or title); only with receiver caps, so any other answer stays as it was
        ...(clientCaps && info.delivery ? { delivery: info.delivery } : {}),
      };
    } catch (e) {
      if (e instanceof CastUnpinnedError) {
        // the pin vanished between the check above and the mint: nothing was minted; give the started stream back (Plex counts it from preparePlayback on)
        if (started) await ctx.jf.stopEncoding(req.jfUser!, started).catch(() => undefined);
        return reply.code(409).send({ error: 'cast_unpinned' });
      }
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

  // token-free lookup of this device's running cast by its public handle (re-adoption, Diagnose): account, profile and device must match
  app.get('/api/cast/session/:castId', { ...pre, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { castId } = z.object({ castId: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.params);
    if (!castEnabled(ctx)) return reply.code(404).send({ error: 'not_found' });
    const deviceId = req.session!.deviceId;
    const found = deviceId ? await castLookup(ctx, { userId: req.user!.id, profileId: req.profile!.id, deviceId }, castId) : null;
    return found ?? reply.code(404).send({ error: 'not_found' });
  });

  app.delete('/api/cast/session/:castId', pre, async (req, reply) => {
    const { castId } = z.object({ castId: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.params);
    return (await revokeCast(ctx, req.user!.id, castId)) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });
}
