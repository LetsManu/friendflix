// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CAST_MAX_BITRATE, airplayContinuousOn, type JoinedItem, CAST_MAX_HEIGHT, CAST_REPORT_RE, castEnabled, castReceiverAppId, castReportToken, castSubtitlePath, castTtlSeconds, castPredecessor, castLookup, castNextTtlSeconds, castPinned, CastUnpinnedError, createCast, resolveCastSubtitle, revokeCast, verifyCastReport } from '../cast.js';
import type { Ctx } from '../ctx.js';
import { receiverCaps } from '../media/clientCaps.js';
import { MediaError, type HevcGate, type ItemDto, type PlaybackDto, type TrackList } from '../media/types.js';
import { bindHevcGrant, hevcGate as gateHevc, noteHevcFailure } from '../hevcenc.js';
import { countLive } from '../live.js';
import { clientAddress, isHomeRequest } from '../netaddr.js';
import { playbackReport } from './media.js';
import { loadPrefs } from './prefs.js';
import { effectiveLimits } from '../limits.js';
import { remoteBitrateCap } from '../roles.js';
import { loadSession, requireUser } from '../session.js';
import { id32 as itemId } from './_shared.js';
import type { JfUser } from '../types.js';

const psId = z.string().regex(/^[\w-]{8,64}$/);

/** a joined AirPlay stream carries at most this much runtime from the start position on (the token's absolute cap is 6 h) */
const JOINED_MAX_TICKS = 6 * 3600 * 10_000_000;
const hlsSubOf = (hlsUrl: string) => new URL(hlsUrl, 'http://x').searchParams.get('SubtitleMethod') === 'Hls';
interface JoinedPart { item: ItemDto; info: PlaybackDto; runtimeTicks: number; sub?: number }

/** what a track choice stands for in another episode: the subtitle language and whether it was that language's forced track */
interface SubChoice { lang?: string; forced: boolean }
/** a subtitle index was its language's forced track (the episode's first forced text track of that language) */
const forcedIn = (tl: TrackList, lang: string, index: number) => tl.subtitles.find((t) => t.language === lang)?.forcedIndex === index;
/**
 * The one lookup that carries a subtitle choice into another episode (a joined stream's later part, a re-mint from a later episode):
 * that language's forced text track when the choice was forced (else its full one), else its full one; none (image-only, missing): undefined.
 */
const subtitleFor = (tl: TrackList, c: SubChoice): number | undefined => {
  if (!c.lang) return undefined;
  const t = tl.subtitles.find((x) => x.language === c.lang);
  return c.forced ? t?.forcedIndex ?? t?.index : t?.index;
};
/** the languages behind `tracksOf`'s audio / subtitle indices (unknown index or a server without stream indices: none) */
function choiceOf(tl: TrackList, audioIndex?: number, subIndex?: number): { audioLang?: string; sub: SubChoice } {
  const lang = (kind: 'audio' | 'subtitle', index?: number) => (index === undefined ? undefined : tl.indexed?.find((s) => s.kind === kind && s.index === index)?.language);
  const subLang = lang('subtitle', subIndex), audioLang = lang('audio', audioIndex);
  return { ...(audioLang ? { audioLang } : {}), sub: { ...(subLang ? { lang: subLang } : {}), forced: subLang !== undefined && forcedIn(tl, subLang, subIndex!) } };
}
/** how far back `tracksOf` may lie: a joined stream carries at most three episodes, so its first part is at most two before */
const TRACKS_BACK = 3;
/**
 * `tracksOf` (the episode a re-mint's track indices belong to) is an episode of `item`'s series the profile can see, at most TRACKS_BACK
 * episodes before it (or `item` itself). Its tracks are only looked up after this.
 */
async function tracksOfOk(ctx: Ctx, jfUser: JfUser, tracksOf: string, item: ItemDto): Promise<boolean> {
  if (tracksOf === item.id) return true;
  if (item.type !== 'Episode' || !item.seriesId) return false;
  const t = await ctx.jf.item(jfUser, tracksOf).catch(() => null); // the profile must be able to see it
  if (!t || t.id !== tracksOf || t.type !== 'Episode' || t.seriesId !== item.seriesId) return false;
  let cur = t.id;
  for (let k = 0; k < TRACKS_BACK; k++) {
    const nx = await ctx.jf.nextEpisode(jfUser, item.seriesId, cur).catch(() => null);
    if (!nx) return false;
    if (nx.id === item.id) return true;
    cur = nx.id;
  }
  return false;
}

/**
 * Continuous AirPlay (spec device-handoff §5): the episode being cast plus up to two following ones (the series order, across seasons),
 * at most `max`, while the joined runtime from `startTicks` on stays within 6 h. null = a single token (the profile's autoplay is off,
 * the item is no episode of a series, no next episode, or a runtime is unknown). Each later episode gets ONE PlaybackInfo from its start,
 * with the first episode's bitrate / height, its audio language and the subtitle of the first episode's subtitle language (index from
 * the episode's own streams: its first text track of that language, forced when episode 1's is, else not forced; none = that
 * part carries no subtitle). Any failure of a later
 * episode's lookup ends the join there.
 */
async function joinedParts(ctx: Ctx, jfUser: JfUser, a: {
  userId: string; profileId: string; item: ItemDto; info: PlaybackDto; startTicks: number; max: number; maxBitrate: number; maxHeight: number; hlsSubIndex?: number;
}, log: { warn(o: unknown, msg?: string): void }): Promise<JoinedPart[] | null> {
  const { item, info } = a;
  if (a.max < 2 || item.type !== 'Episode' || !item.seriesId || !info.runtimeTicks) return null;
  if (!(await loadPrefs(ctx, a.userId, a.profileId)).autoplayNext) return null;
  const parts: JoinedPart[] = [{ item, info, runtimeTicks: info.runtimeTicks, ...(a.hlsSubIndex !== undefined ? { sub: a.hlsSubIndex } : {}) }];
  const audio = info.audioIndex !== undefined ? info.audioTracks.find((t) => t.index === info.audioIndex) : info.audioTracks.find((t) => t.isDefault) ?? info.audioTracks[0];
  const audioLang = audio?.language;
  const subLang = a.hlsSubIndex !== undefined ? info.subtitles.find((t) => t.index === a.hlsSubIndex)?.language : undefined;
  /** episode 1's chosen track is its language's forced one: later parts take theirs (else the full track); looked up once, on demand */
  let forced: boolean | undefined;
  let total = info.runtimeTicks;
  let cur = item;
  while (parts.length < a.max) {
    try {
      const nx = await ctx.jf.nextEpisode(jfUser, item.seriesId, cur.id);
      // the item's runtime decides (unknown: the join ends before it, no PlaybackInfo spent); trailing episodes are left out while the
      // joined runtime from the start position would pass 6 h
      if (!nx || !nx.runtimeTicks || total + nx.runtimeTicks - a.startTicks > JOINED_MAX_TICKS) break;
      if (subLang && forced === undefined) forced = forcedIn(await ctx.jf.tracks(jfUser, item.id), subLang, a.hlsSubIndex!);
      const sub = subLang ? subtitleFor(await ctx.jf.tracks(jfUser, nx.id), { lang: subLang, forced: Boolean(forced) }) : undefined;
      const ni = await ctx.jf.playbackInfo(jfUser, nx.id, {
        maxBitrate: a.maxBitrate, maxHeight: a.maxHeight, startTicks: 0, cast: true, ...(audioLang ? { audioLang } : {}), ...(sub !== undefined ? { hlsSubtitleIndex: sub } : {}),
      });
      const rt = ni.runtimeTicks ?? nx.runtimeTicks;
      if (total + rt - a.startTicks > JOINED_MAX_TICKS) break;
      // the rendition exists only when the URL the plan built asks for it (a track that is no text subtitle is never carried)
      parts.push({ item: nx, info: ni, runtimeTicks: rt, ...(sub !== undefined && hlsSubOf(ni.hlsUrl) ? { sub } : {}) });
      total += rt;
      cur = nx;
    } catch (e) {
      // any failure of a later part (refusal, timeout, a broken answer) only shortens the stream: episode 1's play session stays this
      // token's; logged without ids, URLs or the error's message
      log.warn({ ...(e instanceof MediaError ? { status: e.status } : { error: e instanceof Error ? e.name : 'unknown' }), part: parts.length + 1 }, 'cast: continuous AirPlay ends before a part that failed its lookup');
      break;
    }
  }
  return parts.length > 1 ? parts : null;
}

const joinedTimeline = (parts: JoinedPart[]) => {
  let start = 0;
  return parts.map((p) => {
    const duration = p.runtimeTicks / 10_000_000;
    const out = {
      itemId: p.item.id, title: p.item.name,
      ...(p.item.parentIndexNumber !== undefined ? { season: p.item.parentIndexNumber } : {}), ...(p.item.indexNumber !== undefined ? { episode: p.item.indexNumber } : {}),
      start, duration,
    };
    start += duration;
    return out;
  });
};

export function castRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };

  // receiverAppId only when FriendFlix's own receiver is configured: without it the sender keeps the Default Media Receiver
  app.get('/api/cast/config', pre, async () => {
    const receiverAppId = castReceiverAppId(ctx);
    return { enabled: castEnabled(ctx), ...(receiverAppId ? { receiverAppId } : {}), airplayContinuous: airplayContinuousOn(ctx) };
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
      /** AirPlay only: the text subtitle track to carry in the stream as one WebVTT rendition (omitted = off); needs capabilities.castHlsSubtitles */
      subtitleIndex: z.number().int().min(0).max(999).optional(),
      /** AirPlay only, admin switch CAST_AIRPLAY_CONTINUOUS: one stream for this and the next episodes (the joined path follows) */
      continuous: z.boolean().optional(),
      /** with `continuous`: how many episodes the stream carries at most */
      maxEpisodes: z.number().int().min(1).max(3).optional(),
      /**
       * AirPlay only: the episode `audioIndex` / `subtitleIndex` belong to (a re-mint of continuous AirPlay from a later episode). Another
       * item than `itemId`: they are mapped to `itemId`'s own tracks by language; it must be an earlier episode of that series (else 400)
       */
      tracksOf: itemId.optional(),
    }).parse(req.body);
    // continuous play is AirPlay's way (`maxEpisodes` only means something with it), and only while the admin switch is on
    if ((b.continuous || b.maxEpisodes !== undefined) && !(b.continuous && b.via === 'airplay')) return reply.code(400).send({ error: 'bad_request' });
    if (b.continuous && !airplayContinuousOn(ctx)) return reply.code(400).send({ error: 'continuous_off' });
    // a subtitle rendition in the stream is AirPlay's way (Chromecast side-loads WebVTT itself)
    if (b.subtitleIndex !== undefined && b.via !== 'airplay') return reply.code(400).send({ error: 'bad_request' });
    // the queue is Chromecast only (an AirPlay token has a two-address pin, a queued token never takes a pin of its own)
    if (b.next && b.via === 'airplay') return reply.code(400).send({ error: 'bad_request' });
    if (b.tracksOf !== undefined && b.via !== 'airplay') return reply.code(400).send({ error: 'bad_request' });
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
      // a re-mint from a later episode: the indices are `tracksOf`'s; this episode gets its own tracks of the same languages (spec §5.4 f), none
      // of that language: its default audio / no subtitle (never another track by number)
      let audioIndex = b.audioIndex, audioLang: string | undefined, subtitleIndex = b.subtitleIndex;
      if (b.tracksOf !== undefined && b.tracksOf !== b.itemId) {
        if (!(await tracksOfOk(ctx, req.jfUser!, b.tracksOf, item))) return reply.code(400).send({ error: 'bad_request' });
        if (b.audioIndex !== undefined || b.subtitleIndex !== undefined) {
          const c = choiceOf(await ctx.jf.tracks(req.jfUser!, b.tracksOf), b.audioIndex, b.subtitleIndex);
          audioIndex = undefined; audioLang = c.audioLang;
          subtitleIndex = c.sub.lang ? subtitleFor(await ctx.jf.tracks(req.jfUser!, b.itemId), c.sub) : undefined;
        }
      }
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
      // A queued token's stream starts only when the receiver moves on (up to an episode later): no 30 s grant can cover it, so it is never an
      // HEVC conversion (copy / remux and surround stay as planned).
      const gate = (): Promise<HevcGate> => (pred ? Promise.resolve({ ok: false, why: 'h264_busy' }) : gateHevc(ctx, { userId: req.user!.id, deviceId, playSessionIdHint: grantId }));
      // the receiver failed a stream that was a HEVC conversion: it counts against the server's HEVC state (as a player fallback does)
      if ((b.fellBack === 'hevc' || b.fellBack === 'both') && b.prevPs) {
        let prev: { video?: unknown } | null;
        try { prev = JSON.parse((await ctx.kv.get(`pbinfo:${req.user!.id}:${b.prevPs}`).catch(() => null)) ?? 'null'); } catch { prev = null; }
        // counted once per account (a sender-supplied name or id could make one phone look like many devices and pause HEVC for everyone), and the
        // record is consumed: the same play session never counts twice
        if (prev?.video === 'hevc') {
          await ctx.kv.del(`pbinfo:${req.user!.id}:${b.prevPs}`).catch(() => undefined);
          await noteHevcFailure(ctx, `cast:${req.user!.id}`);
        }
      }
      // a server that cannot emit the rendition ignores the field (no error, nothing recorded); an AirPlay token has no queue, so no `pred` here
      const hlsSubtitleIndex = subtitleIndex !== undefined && ctx.jf.capabilities.castHlsSubtitles ? subtitleIndex : undefined;
      const opts = {
        maxBitrate, maxHeight, startTicks, audioIndex, ...(audioLang ? { audioLang } : {}), cast: true, ...(pred ? { after: pred.playSessionId } : {}),
        ...(hlsSubtitleIndex !== undefined ? { hlsSubtitleIndex } : {}),
        ...(clientCaps ? { clientCaps, remote, surround: ctx.cfg.SURROUND_AUDIO !== 'false', ...(ctx.cfg.HEVC_STREAMS > 0 ? { hevcGate: gate } : {}) } : {}),
      };
      let info = await ctx.jf.playbackInfo(req.jfUser!, b.itemId, opts);
      if (ctx.jf.preparePlayback) info = await ctx.jf.preparePlayback(req.jfUser!, info, opts);
      if (clientCaps) {
        await bindHevcGrant(ctx, grantId, info.delivery?.video === 'hevc' ? info.playSessionId : null); // a grant only lives on for a conversion
        // the server's HEVC count and the next fallback look at the fixed codes of this play session (as /api/playback/info writes them).
        // Side effect: these sessions also pass the ownership check of /api/playback/warm/stop (the user's own sessions only).
        if (info.delivery) await ctx.kv.set(`pbinfo:${req.user!.id}:${info.playSessionId}`, JSON.stringify({ video: info.delivery.video, audio: info.delivery.audio }), 6 * 3600).catch(() => undefined);
      }
      started = info.playSessionId;
      // the rendition exists only when the HLS URL the server plan built asks for it (a track that is not a text subtitle is not carried)
      const hlsSub = hlsSubtitleIndex !== undefined && hlsSubOf(info.hlsUrl);
      // continuous AirPlay: one token (one stream) for this and the following episodes; `b.continuous` already passed the admin switch above
      const parts = b.continuous
        ? await joinedParts(ctx, req.jfUser!, {
          userId: req.user!.id, profileId: req.profile!.id, item, info, startTicks, max: b.maxEpisodes ?? 3, maxBitrate, maxHeight, ...(hlsSub ? { hlsSubIndex: hlsSubtitleIndex } : {}),
        }, req.log)
        : null;
      const items: JoinedItem[] | undefined = parts?.map((p) => ({
        itemId: p.item.id, mediaSourceId: p.info.mediaSourceId, playSessionId: p.info.playSessionId, runtimeTicks: p.runtimeTicks,
        hlsPath: p.info.hlsUrl.slice('/media'.length), ...(p.sub !== undefined ? { hlsSubIndex: p.sub } : {}), title: p.item.name,
      }));
      const joinedTicks = parts?.reduce((n, p) => n + p.runtimeTicks, 0);
      const ownTtl = castTtlSeconds(joinedTicks ?? info.runtimeTicks, startTicks);
      // a queued token outlives the episode it follows (queued from the start of that episode)
      const ttl = pred ? castNextTtlSeconds(ownTtl, pred.exp) : ownTtl;
      const rec = {
        userId: req.user!.id, profileId: req.profile!.id, deviceId, itemId: b.itemId, mediaSourceId: info.mediaSourceId, playSessionId: info.playSessionId, maxBitrate, title: item.name, via: b.via ?? 'chromecast',
        ...(pred ? { afterPs: pred.playSessionId } : {}),
        ...(hlsSub ? { hlsSub: true, hlsSubIndex: hlsSubtitleIndex } : {}),
        runtimeTicks: info.runtimeTicks, ...(item.seriesName ? { seriesName: item.seriesName } : {}),
        subs: info.subtitles.map((s) => ({ index: s.index, ...(s.language ? { language: s.language } : {}), title: s.title })),
        ...(items ? { items } : {}),
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
        await revokeCast(ctx, req.user!.id, castId); // a joined token's revoke stops every part's encoding itself (stopJoined)
        if (!items) await ctx.jf.stopEncoding(req.jfUser!, info.playSessionId).catch(() => undefined);
        return reply.code(409).send({ error: 'profile_changed' });
      }
      reply.header('Cache-Control', 'no-store');
      const fmp4 = new URL(info.hlsUrl, 'http://x').searchParams.get('SegmentContainer') === 'mp4';
      return {
        castId,
        expiresAt,
        playSessionId: info.playSessionId,
        mediaSourceId: info.mediaSourceId,
        // a joined stream: its whole runtime; `startTime` stays the offset in its first episode (= in the joined stream)
        runtimeTicks: joinedTicks ?? info.runtimeTicks,
        startTime: Math.floor(startTicks / 10_000_000),
        contentUrl: parts ? abs('/media/joined/master.m3u8') : abs(info.hlsUrl),
        // the joined timeline in stream seconds (start = the runtimes before it); `subtitles` = every part carries the subtitle rendition
        ...(parts ? { joined: { items: joinedTimeline(parts), subtitles: parts.every((p) => p.sub !== undefined) } } : {}),
        contentType: 'application/x-mpegURL',
        // fMP4 when the plan carries HEVC or surround (SegmentContainer=mp4 in the URL the plan built); only a cast with receiver caps can have one
        ...(fmp4 ? { hlsSegmentFormat: 'fmp4', hlsVideoSegmentFormat: 'fmp4' } : { hlsSegmentFormat: 'ts' }),
        title: item.name,
        seriesName: item.seriesName,
        // the poster gets its own image-only token: the media token must never appear in a URL the receiver shows or fetches as an image
        imageUrl: imgCt ? absWith(imgCt, `/media/Items/${b.itemId}/Images/Primary?maxWidth=600`) : undefined,
        subtitles: info.subtitles.map((s) => ({ index: s.index, language: s.language, title: s.title, url: subUrl(s.url) })),
        ...(report ? { report } : {}),
        // AirPlay: the stream carries the requested subtitle as a WebVTT rendition (the sender shows no side-loaded track for it)
        ...(hlsSub ? { hlsSub: true } : {}),
        // AirPlay: this episode's own audio tracks and what the stream carries of its tracks (a re-mint from a later episode maps the choice):
        // the sender's menus and its next re-mint follow these
        ...(rec.via === 'airplay' ? {
          audioTracks: info.audioTracks.map((t) => ({ index: t.index, ...(t.language ? { language: t.language } : {}), title: t.title, isDefault: t.isDefault })),
          ...(info.audioIndex !== undefined ? { audioIndex: info.audioIndex } : {}), ...(hlsSub ? { subtitleIndex: hlsSubtitleIndex } : {}),
        } : {}),
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
        { user: v.user, jfUser: v.jfUser, profile: v.prof, deviceId: c.d, via: 'chromecast' });
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
