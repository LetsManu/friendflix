// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { requirePerm } from '../permGuard.js';
import { requireAdmin, requireUser } from '../session.js';
import { livetvInstalled, livetvSystem } from './detect.js';
import { adminListRecordings, deleteRecording, effectiveStorage, getRecording, libraryModeAvailable, listRecordings, mayRecord, progKey, recordingView, recordSettings, seriesKeyOf, setKeep, setVisibility, visibleRecording, REC_STATES, type RecState } from './recordings.js';
import { expandRules, forecast, insertScheduled, programmeAt, releaseReservation, validTz, type RuleRow } from './recsched.js';
import { exportToLibrary, usage } from './recstore.js';
import { channelAllowed } from './rights.js';
import { LIVE_CAP_S, liveSidHash, mintRecToken } from './tokens.js';
import { isHomeRequest } from '../netaddr.js';

/**
 * The recording routes (spec §15.8, plan Phase 3 Task 4). User side (`requireUser`): the programme detail, scheduling with the conflict
 * forecast, the lists, keep / share / padding, delete, rules, progress. Every write needs `liveRecord` (403 `record_forbidden`; kids
 * profiles are refused by the kids overlay) and the channel in the profile's set (else 404). Admin side (`requireAdmin`, audited as
 * `livetv.rec.*` with ids and field names only): the metadata list, delete, delete all (typed "LÖSCHEN"), storage. No answer carries a
 * stream URL, a folder or a token.
 */
const uuid = z.guid();
const iso = z.iso.datetime({ offset: true });
const padBefore = z.number().int().min(0).max(30);
const padAfter = z.number().int().min(0).max(120);
const createBody = z.object({
  channelId: uuid, start: iso, end: iso.optional(), title: z.string().trim().min(1).max(200).optional(),
  padBefore: padBefore.optional(), padAfter: padAfter.optional(), force: z.boolean().optional(),
}).strict();
const patchBody = z.object({ keep: z.boolean().optional(), visibility: z.enum(['private', 'account', 'everyone']).optional(), padBefore: padBefore.optional(), padAfter: padAfter.optional() }).strict();
const progressBody = z.object({ positionS: z.number().int().min(0).max(7 * 86_400), played: z.boolean().optional() }).strict();
const seriesRule = z.object({
  kind: z.literal('series'), channelId: uuid.nullable(), seriesKey: z.string().trim().min(1).max(300), title: z.string().trim().min(1).max(200),
  onlyNew: z.boolean(), keepMax: z.number().int().min(1).max(100).nullable().optional(), padBefore: padBefore.optional(), padAfter: padAfter.optional(),
}).strict();
const timeRule = z.object({
  kind: z.literal('time'), channelId: uuid, weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7), startTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  durationMin: z.number().int().min(1).max(1440), tz: z.string().min(1).max(64).refine(validTz), title: z.string().trim().min(1).max(200),
  padBefore: padBefore.optional(), padAfter: padAfter.optional(),
}).strict();
const ruleBody = z.discriminatedUnion('kind', [seriesRule, timeRule]);
const rulePatch = z.object({
  onlyNew: z.boolean().optional(), keepMax: z.number().int().min(1).max(100).nullable().optional(), padBefore: padBefore.nullable().optional(), padAfter: padAfter.nullable().optional(),
  enabled: z.boolean().optional(), title: z.string().trim().min(1).max(200).optional(),
}).strict();
const deleteAllBody = z.object({ confirm: z.literal('LÖSCHEN') }).strict();
const playBody = z.object({ via: z.enum(['local', 'chromecast', 'airplay']).optional() }).strict();
const createLibraryBody = z.object({ name: z.string().trim().min(1).max(60).optional(), kind: z.enum(['homevideos', 'mixed']).optional() }).strict();
const MAX_SPAN_MS = 24 * 3_600_000;
/** an HD recording (about 6 Mbit/s) fills this many bytes an hour: the storage card's "noch ca. … h in HD" */
export const HD_BYTES_PER_HOUR = 2_700_000_000;

const invalid = (reply: FastifyReply, e: z.ZodError) => reply.code(400).send({ error: 'invalid', field: String(e.issues[0]?.path[0] ?? 'body') });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const who = (req: FastifyRequest) => ({ user: { id: req.user!.id, role: req.user!.role }, profile: { id: req.profile!.id, kids: Boolean(req.profile!.kids) } });
const actorOf = (req: FastifyRequest) => ({ userId: req.user!.id, profileId: req.profile!.id, admin: req.user!.role === 'admin' && !req.profile!.kids });
const idParam = (req: FastifyRequest) => uuid.safeParse((req.params as { id?: string }).id).data ?? null;

function ruleView(r: RuleRow) {
  return {
    id: r.id, kind: r.kind, channelId: r.channel_id, seriesKey: r.series_key, title: r.title, onlyNew: r.only_new, keepMax: r.keep_max,
    padBefore: r.pad_before_s === null ? null : Math.round(r.pad_before_s / 60), padAfter: r.pad_after_s === null ? null : Math.round(r.pad_after_s / 60),
    weekdays: r.weekdays, startTime: r.start_time ? r.start_time.slice(0, 5) : null, durationMin: r.duration_min, tz: r.tz, enabled: r.enabled,
  };
}

export function recordingRoutes(app: FastifyInstance, ctx: Ctx) {
  const user = { preHandler: requireUser(ctx) };
  const writeLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };
  const write = { preHandler: [requireUser(ctx), requirePerm(ctx, 'liveRecord', 'record_forbidden')], config: writeLimit };
  const read = { ...user, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
  const off = (reply: FastifyReply) => reply.code(404).send({ error: 'livetv_off' });

  /** the programme detail (spec §15.7 / Phase 2b's sheet): the guide entry with the channel's offset applied, and what this profile planned for it */
  app.get('/api/livetv/programme/:channelId/:start', read, async (req, reply) => {
    if (!livetvInstalled(ctx)) return off(reply);
    const p = req.params as { channelId?: string; start?: string };
    const channelId = uuid.safeParse(p.channelId).data;
    const start = iso.safeParse(p.start).success ? Date.parse(p.start!) : NaN;
    if (!channelId || !Number.isFinite(start)) return notFound(reply);
    const { user: u, profile } = who(req);
    if (!(await channelAllowed(ctx, u, profile, channelId))) return notFound(reply);
    const prog = await programmeAt(ctx, channelId, start);
    if (!prog) return notFound(reply);
    const seriesKey = seriesKeyOf({ title: prog.title, series_key: prog.seriesKey });
    const rec = (await ctx.db.query<{ id: string; state: RecState }>(
      "select id, state from livetv_recordings where profile_id = $1 and channel_id = $2 and start_at = $3 and state <> 'cancelled' order by created_at desc limit 1",
      [profile.id, channelId, new Date(start)])).rows[0];
    const rule = (await ctx.db.query<{ id: string }>(
      "select id from livetv_recording_rules where profile_id = $1 and kind = 'series' and series_key = $2 and (channel_id is null or channel_id = $3) limit 1",
      [profile.id, seriesKey, channelId])).rows[0];
    return {
      channelId, start: new Date(prog.start).toISOString(), end: new Date(prog.end).toISOString(), title: prog.title,
      ...(prog.subtitle ? { subtitle: prog.subtitle } : {}), ...(prog.description ? { description: prog.description } : {}), ...(prog.episode ? { episode: prog.episode } : {}),
      seriesKey, ...(prog.categories?.length ? { categories: prog.categories } : {}),
      ...(rec ? { recording: { id: rec.id, state: rec.state } } : {}), ...(rule ? { rule: { id: rule.id } } : {}),
      canRecord: await mayRecord(ctx, u, profile),
    };
  });

  /** schedule one recording: a programme at `start` (EPG, it follows its programme), else `end` + `title` (time-based) */
  app.post('/api/livetv/recordings', write, async (req, reply) => {
    if (!livetvInstalled(ctx)) return off(reply);
    const b = createBody.safeParse(req.body);
    if (!b.success) return invalid(reply, b.error);
    const { user: u, profile } = who(req);
    if (!(await mayRecord(ctx, u, profile))) return reply.code(403).send({ error: 'record_forbidden' });
    if (!(await channelAllowed(ctx, u, profile, b.data.channelId))) return notFound(reply);
    const start = Date.parse(b.data.start);
    const prog = await programmeAt(ctx, b.data.channelId, start);
    let end: number;
    if (prog) end = prog.end;
    else if (b.data.end && b.data.title) end = Date.parse(b.data.end);
    else return notFound(reply);
    if (!(end > start) || end - start > MAX_SPAN_MS) return reply.code(400).send({ error: 'invalid', field: 'end' });
    if (end <= Date.now()) return reply.code(400).send({ error: 'invalid', field: 'start' });
    const existing = async () => (await ctx.db.query<{ id: string }>(
      "select id from livetv_recordings where profile_id = $1 and channel_id = $2 and start_at = $3 and state in ('scheduled','starting','recording')", [profile.id, b.data.channelId, new Date(start)])).rows[0];
    const dup = await existing();
    if (dup) return reply.code(200).send({ recording: await recordingView(ctx, u, profile, dup.id) });
    const s = recordSettings(ctx);
    const pad = { padBeforeS: b.data.padBefore !== undefined ? b.data.padBefore * 60 : s.padBeforeS, padAfterS: b.data.padAfter !== undefined ? b.data.padAfter * 60 : s.padAfterS };
    const fc = await forecast(ctx, { channelId: b.data.channelId, from: start - pad.padBeforeS * 1000, to: end + pad.padAfterS * 1000 });
    if (fc.conflict && !b.data.force) return reply.code(409).send({ error: 'conflict', forecast: fc });
    const name = (await ctx.db.query<{ name: string }>('select coalesce(name_override, import_name) as name from livetv_channels where id = $1', [b.data.channelId])).rows[0]?.name ?? '';
    const id = await insertScheduled(ctx, {
      profileId: profile.id, userId: u.id, ruleId: null, channelId: b.data.channelId, channelName: name, ...pad, start, end,
      ...(prog
        ? { title: prog.title, subtitle: prog.subtitle, description: prog.description, episode: prog.episode, seriesKey: seriesKeyOf({ title: prog.title, series_key: prog.seriesKey }), followEpg: true, progKey: progKey(prog) }
        : { title: b.data.title!, followEpg: false }),
    });
    const got = id ?? (await existing())?.id;
    if (!got) return reply.code(409).send({ error: 'conflict', forecast: fc });
    return reply.code(id ? 201 : 200).send({ recording: await recordingView(ctx, u, profile, got), ...(fc.conflict ? { forecast: fc } : {}) });
  });

  app.get('/api/livetv/recordings', read, async (req, reply) => {
    if (!livetvInstalled(ctx)) return off(reply);
    const q = req.query as { state?: string };
    const state = q.state === 'done' || q.state === 'scheduled' || q.state === 'all' ? q.state : 'all';
    const { user: u, profile } = who(req);
    const recordings = await listRecordings(ctx, u, profile, { state });
    const rules = profile.kids ? [] : (await ctx.db.query<RuleRow>('select * from livetv_recording_rules where profile_id = $1 order by created_at', [profile.id])).rows.map(ruleView);
    reply.header('cache-control', 'no-store');
    return { recordings, rules };
  });

  app.get('/api/livetv/recordings/:id', read, async (req, reply) => {
    const id = idParam(req);
    if (!id) return notFound(reply);
    const { user: u, profile } = who(req);
    const v = await recordingView(ctx, u, profile, id);
    return v ? { recording: v } : notFound(reply);
  });

  /** *Behalten*, *Teilen…* (owner or admin), padding (owner, while scheduled) */
  app.patch('/api/livetv/recordings/:id', write, async (req, reply) => {
    const id = idParam(req);
    if (!id) return notFound(reply);
    const b = patchBody.safeParse(req.body);
    if (!b.success) return invalid(reply, b.error);
    const { user: u, profile } = who(req);
    const a = actorOf(req);
    const r = await getRecording(ctx, id);
    // a recording this profile cannot see is unknown to it (an admin may share any)
    if (!r || r.state === 'cancelled' || (!a.admin && !(await visibleRecording(ctx, u, profile, id)))) return notFound(reply);
    if (r.profile_id !== profile.id && !a.admin) return reply.code(403).send({ error: 'forbidden' });
    if ((b.data.padBefore !== undefined || b.data.padAfter !== undefined)) {
      if (r.profile_id !== profile.id) return reply.code(403).send({ error: 'forbidden' });
      const u2 = await ctx.db.query(
        "update livetv_recordings set pad_before_s = coalesce($2, pad_before_s), pad_after_s = coalesce($3, pad_after_s) where id = $1 and state = 'scheduled'",
        [id, b.data.padBefore !== undefined ? b.data.padBefore * 60 : null, b.data.padAfter !== undefined ? b.data.padAfter * 60 : null]);
      if (!u2.rowCount) return reply.code(409).send({ error: 'not_scheduled' });
    }
    if (b.data.keep !== undefined) await setKeep(ctx, a, id, b.data.keep);
    if (b.data.visibility !== undefined) {
      await setVisibility(ctx, a, id, b.data.visibility);
      if (r.profile_id !== profile.id) await audit(ctx, a.userId, 'livetv.rec.share', id, { fields: ['visibility'] });
    }
    const v = await recordingView(ctx, u, profile, id);
    return { recording: v ?? null };
  });

  app.delete('/api/livetv/recordings/:id', write, async (req, reply) => {
    const id = idParam(req);
    if (!id) return notFound(reply);
    const { user: u, profile } = who(req);
    const r = await visibleRecording(ctx, u, profile, id);
    if (!r) return notFound(reply);
    if (r.profile_id !== profile.id) return reply.code(403).send({ error: 'forbidden' });
    await deleteRecording(ctx, id, 'owner');
    if (r.channel_id) await releaseReservation(ctx, r.channel_id).catch(() => undefined);
    return reply.code(204).send();
  });

  /** *Behalten → in Bibliothek* (mode `both`, spec §15.3): the owner's finished recording is copied into the Jellyfin library and kept */
  app.post('/api/livetv/recordings/:id/library', write, async (req, reply) => {
    const id = idParam(req);
    if (!id) return notFound(reply);
    const { user: u, profile } = who(req);
    const r = await visibleRecording(ctx, u, profile, id);
    if (!r || r.profile_id !== profile.id) return notFound(reply);
    if (effectiveStorage(ctx) !== 'both' || !recordSettings(ctx).libraryId) return reply.code(409).send({ error: 'not_available' });
    if (r.state !== 'done' && r.state !== 'partial') return reply.code(409).send({ error: 'not_ready' });
    const res = await exportToLibrary(ctx, id, { keep: true });
    if (res !== 'exported') return reply.code(res === 'failed' ? 502 : 409).send({ error: res === 'failed' ? 'export_failed' : 'not_available' });
    return { recording: await recordingView(ctx, u, profile, id) };
  });

  /**
   * Plays a recording this profile sees (kids too, spec §15.7): a `rec` token for `/media/r/<token>/index.m3u8` (plan: a POST, it mints a
   * credential). 404 not visible; 409 `not_ready` while nothing is recorded; 409 `in_library` once it lives only in the Jellyfin library.
   */
  app.post('/api/livetv/recordings/:id/play', { ...user, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = idParam(req);
    if (!id) return notFound(reply);
    const b = playBody.safeParse(req.body ?? {});
    if (!b.success) return invalid(reply, b.error);
    const { user: u, profile } = who(req);
    const r = await visibleRecording(ctx, u, profile, id);
    if (!r) return notFound(reply);
    if (r.storage === 'library' && r.library_path !== null) return reply.code(409).send({ error: 'in_library' });
    if (r.state === 'scheduled' || r.state === 'starting' || Number(r.bytes) === 0) return reply.code(409).send({ error: 'not_ready' });
    const deviceId = req.session!.deviceId;
    if (!deviceId) return reply.code(403).send({ error: 'device_pending' });
    const growing = r.state === 'recording';
    const HOUR_MS = 3_600_000;
    const capMs = growing ? r.end_at.getTime() + r.pad_after_s * 1000 + HOUR_MS - Date.now() : (r.duration_s ?? 0) * 1000 + HOUR_MS;
    const minted = await mintRecToken(ctx, {
      userId: u.id, profileId: profile.id, deviceId, sidHash: liveSidHash(req.sid!), recordingId: r.id, channelId: r.channel_id ?? '', channelName: r.channel_name,
      via: b.data.via ?? 'local', remote: !isHomeRequest(req, ctx.cfg.HOME_NETWORKS),
    }, Math.min(LIVE_CAP_S, Math.ceil(capMs / 1000)));
    const pos = (await ctx.db.query<{ position_s: number }>('select position_s from livetv_recording_progress where profile_id = $1 and recording_id = $2', [profile.id, id])).rows[0];
    reply.header('cache-control', 'no-store');
    return {
      token: minted.token, url: `/media/r/${minted.token}/index.m3u8`, growing, segments: r.segments ?? 'ts', durationS: r.duration_s, positionS: pos?.position_s ?? 0,
      expiresAt: minted.expiresAt,
    };
  });

  /** progress of a recording this profile sees (kids too); the owner's ≥ 90 % (or `played`) marks it watched (retention) */
  app.post('/api/livetv/recordings/:id/progress', { ...user, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = idParam(req);
    if (!id) return notFound(reply);
    const b = progressBody.safeParse(req.body);
    if (!b.success) return invalid(reply, b.error);
    const { user: u, profile } = who(req);
    const r = await visibleRecording(ctx, u, profile, id);
    if (!r) return notFound(reply);
    await ctx.db.query(
      `insert into livetv_recording_progress(profile_id, recording_id, position_s) values ($1, $2, $3)
       on conflict (profile_id, recording_id) do update set position_s = excluded.position_s, updated_at = now()`, [profile.id, id, b.data.positionS]);
    const watched = b.data.played === true || (r.duration_s !== null && r.duration_s > 0 && b.data.positionS >= 0.9 * r.duration_s);
    if (watched && r.profile_id === profile.id && r.state !== 'recording') await ctx.db.query('update livetv_recordings set watched_at = coalesce(watched_at, now()) where id = $1', [id]);
    return { ok: true };
  });

  // ---- rules ----

  app.get('/api/livetv/rules', read, async (req, reply) => {
    if (!livetvInstalled(ctx)) return off(reply);
    if (req.profile!.kids) return { rules: [] };
    return { rules: (await ctx.db.query<RuleRow>('select * from livetv_recording_rules where profile_id = $1 order by created_at', [req.profile!.id])).rows.map(ruleView) };
  });

  app.post('/api/livetv/rules', write, async (req, reply) => {
    if (!livetvInstalled(ctx)) return off(reply);
    const b = ruleBody.safeParse(req.body);
    if (!b.success) return invalid(reply, b.error);
    const { user: u, profile } = who(req);
    if (!(await mayRecord(ctx, u, profile))) return reply.code(403).send({ error: 'record_forbidden' });
    const r = b.data;
    if (r.channelId && !(await channelAllowed(ctx, u, profile, r.channelId))) return notFound(reply);
    if (r.kind === 'series') {
      const dup = (await ctx.db.query<RuleRow>(
        "select * from livetv_recording_rules where profile_id = $1 and kind = 'series' and series_key = $2 and channel_id is not distinct from $3", [profile.id, r.seriesKey, r.channelId])).rows[0];
      if (dup) return reply.code(200).send({ rule: ruleView(dup), forecast: null });
    }
    const id = randomUUID();
    await ctx.db.query(
      `insert into livetv_recording_rules(id, profile_id, user_id, kind, channel_id, series_key, title, weekdays, start_time, duration_min, tz, only_new, keep_max, pad_before_s, pad_after_s)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [id, profile.id, u.id, r.kind, r.channelId, r.kind === 'series' ? r.seriesKey : null, r.title, r.kind === 'time' ? [...new Set(r.weekdays)].sort() : null,
        r.kind === 'time' ? r.startTime : null, r.kind === 'time' ? r.durationMin : null, r.kind === 'time' ? r.tz : null, r.kind === 'series' ? r.onlyNew : true,
        r.kind === 'series' ? r.keepMax ?? null : null, r.padBefore !== undefined ? r.padBefore * 60 : null, r.padAfter !== undefined ? r.padAfter * 60 : null]);
    await expandRules(ctx, Date.now(), { ruleId: id });
    const first = (await ctx.db.query<{ channel_id: string; start_at: Date; end_at: Date; pad_before_s: number; pad_after_s: number; id: string }>(
      "select id, channel_id, start_at, end_at, pad_before_s, pad_after_s from livetv_recordings where rule_id = $1 and state = 'scheduled' order by start_at limit 1", [id])).rows[0];
    const fc = first ? await forecast(ctx, { channelId: first.channel_id, from: first.start_at.getTime() - first.pad_before_s * 1000, to: first.end_at.getTime() + first.pad_after_s * 1000, exceptId: first.id }) : null;
    const row = (await ctx.db.query<RuleRow>('select * from livetv_recording_rules where id = $1', [id])).rows[0]!;
    return reply.code(201).send({ rule: ruleView(row), forecast: fc });
  });

  app.patch('/api/livetv/rules/:id', write, async (req, reply) => {
    const id = idParam(req);
    if (!id) return notFound(reply);
    const b = rulePatch.safeParse(req.body);
    if (!b.success) return invalid(reply, b.error);
    const d = b.data;
    const r = (await ctx.db.query<RuleRow>(
      `update livetv_recording_rules set only_new = coalesce($3, only_new), keep_max = case when $4::boolean then $5::int else keep_max end,
         pad_before_s = case when $6::boolean then $7::int else pad_before_s end, pad_after_s = case when $8::boolean then $9::int else pad_after_s end,
         enabled = coalesce($10, enabled), title = coalesce($11, title)
       where id = $1 and profile_id = $2 returning *`,
      [id, req.profile!.id, d.onlyNew ?? null, d.keepMax !== undefined, d.keepMax ?? null, d.padBefore !== undefined, d.padBefore == null ? null : d.padBefore * 60,
        d.padAfter !== undefined, d.padAfter == null ? null : d.padAfter * 60, d.enabled ?? null, d.title ?? null])).rows[0];
    if (!r) return notFound(reply);
    if (r.enabled) await expandRules(ctx, Date.now(), { ruleId: id });
    return { rule: ruleView(r) };
  });

  /** the rule goes; its planned airings are cancelled, its finished recordings stay */
  app.delete('/api/livetv/rules/:id', write, async (req, reply) => {
    const id = idParam(req);
    if (!id) return notFound(reply);
    const own = (await ctx.db.query('select 1 from livetv_recording_rules where id = $1 and profile_id = $2', [id, req.profile!.id])).rowCount;
    if (!own) return notFound(reply);
    await ctx.db.query("update livetv_recordings set state = 'cancelled' where rule_id = $1 and state = 'scheduled'", [id]);
    await ctx.db.query('delete from livetv_recording_rules where id = $1', [id]);
    return reply.code(204).send();
  });

}

/** Admin → Aufnahmen (spec §9.6), registered from adminRoutes.ts */
export function recordingAdminRoutes(app: FastifyInstance, ctx: Ctx) {
  const writeLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };
  const admin = { preHandler: requireAdmin(ctx) };
  app.get('/api/admin/livetv/recordings', admin, async (req) => {
    const q = req.query as { state?: string; limit?: string; offset?: string };
    const state = q.state === 'active' || (REC_STATES as readonly string[]).includes(q.state ?? '') ? (q.state as RecState | 'active') : undefined;
    return adminListRecordings(ctx, { ...(state ? { state } : {}), limit: Number(q.limit) || 50, offset: Number(q.offset) || 0 });
  });

  app.delete('/api/admin/livetv/recordings/:id', { ...admin, config: writeLimit }, async (req, reply) => {
    const id = idParam(req);
    if (!id) return notFound(reply);
    const r = await getRecording(ctx, id);
    const res = await deleteRecording(ctx, id, 'admin');
    if (res === 'not_found') return notFound(reply);
    if (r?.channel_id) await releaseReservation(ctx, r.channel_id).catch(() => undefined);
    await audit(ctx, req.user!.id, 'livetv.rec.delete', id, { fields: [] });
    return reply.code(204).send();
  });

  /** *Alle Aufnahmen löschen…* (spec §15.9): the only way to empty the recordings volume from FriendFlix */
  app.post('/api/admin/livetv/recordings/delete-all', { ...admin, config: writeLimit }, async (req, reply) => {
    const b = deleteAllBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid', field: 'confirm' });
    const ids = (await ctx.db.query<{ id: string }>("select id from livetv_recordings where state <> 'cancelled' or delete_after is not null")).rows.map((r) => r.id);
    let deleted = 0;
    let pending = 0;
    for (const id of ids) {
      const r = await deleteRecording(ctx, id, 'admin');
      if (r === 'pending') pending++;
      else if (r !== 'not_found') deleted++;
    }
    await audit(ctx, req.user!.id, 'livetv.rec.delete_all', undefined, { n: ids.length });
    return { deleted, pending };
  });

  app.get('/api/admin/livetv/recordings/storage', admin, async () => {
    const used = await usage(ctx);
    const limitBytes = recordSettings(ctx).limitBytes;
    const sys = await livetvSystem(ctx);
    const freeBytes = sys?.recordings?.freeBytes ?? null;
    const room = Math.max(0, Math.min(limitBytes - used, freeBytes ?? Number.MAX_SAFE_INTEGER));
    return { usedBytes: used, limitBytes, freeBytes, hoursLeftHd: Math.floor(room / HD_BYTES_PER_HOUR), library: sys?.library ?? null };
  });

  /**
   * The Jellyfin libraries with their folders (spec §15.3 *Choosing the library*): the one whose folders hold
   * LIVETV_RECORD_LIBRARY_JF_PATH `fits`. Without the media server's library seam (Plex) the library modes are not offered.
   */
  app.get('/api/admin/livetv/recordings/libraries', admin, async (_req, reply) => {
    const s = recordSettings(ctx);
    if (!libraryModeAvailable(ctx)) return { supported: false, jfPath: s.libraryJfPath, selected: s.libraryId, libraries: [] };
    const want = s.libraryJfPath.replace(/\/+$/, '');
    let list: Array<{ id: string; name: string; paths: string[] }>;
    try { list = await ctx.jf.admin.libraryFolders!(); } catch { return reply.code(502).send({ error: 'media_unreachable' }); }
    return {
      supported: true, jfPath: s.libraryJfPath, selected: s.libraryId,
      libraries: list.map((l) => ({ ...l, fits: l.paths.some((p) => p.replace(/\/+$/, '') === want) })),
    };
  });

  /** *Bibliothek „Aufnahmen“ anlegen*: a home-videos library on the recordings folder (as Jellyfin sees it) */
  app.post('/api/admin/livetv/recordings/libraries', { ...admin, config: writeLimit }, async (req, reply) => {
    const b = createLibraryBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'invalid', field: String(b.error.issues[0]?.path[0] ?? 'body') });
    if (!libraryModeAvailable(ctx) || !ctx.jf.admin.createLibrary) return reply.code(409).send({ error: 'not_available' });
    let created: { id: string | null };
    try { created = await ctx.jf.admin.createLibrary(b.data.name ?? 'Aufnahmen', recordSettings(ctx).libraryJfPath, b.data.kind ?? 'homevideos'); } catch {
      return reply.code(502).send({ error: 'media_unreachable' });
    }
    await audit(ctx, req.user!.id, 'livetv.rec.library_create', created.id ?? undefined, { fields: ['name', 'kind'] });
    return reply.code(201).send(created);
  });
}
