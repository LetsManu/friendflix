// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { roleExists } from '../rolecat.js';
import { loadSession, requireAdmin } from '../session.js';
import { startLivetvJob, updaterView, type LivetvOp } from '../updater.js';
import { dropLivetvProof } from './client.js';
import { detectLivetv, enableBenchmark, livetvInstalled, livetvSystem } from './detect.js';
import { LivetvError } from './client.js';
import { gpuAdvice } from './gpu.js';
import {
  ChannelRefusal, LOGO_MAX_BYTES, LOGO_MIMES, MAX_BULK_TEST, adminChannel, bulkBody, bulkChannels, bulkTest, channelPatch, channelQuery, dropLogo, epgSearchQuery,
  listChannels, orderBody as channelOrderBody, orderChannels, patchChannel, importDueFor, readEpgPin, searchEpgChannels, setEpgPin, setLogo, testChannel,
} from './adminChannels.js';
import { liveStatus, readHwAccel, stopStream } from './status.js';
import { CHANNEL_SELECT, isOwnFeeds, toEffective, type EffectiveRow } from './channels.js';
import { isHomeRequest } from '../netaddr.js';
import { clearJoinMark, startOrJoin } from './streams.js';
import { adminStopKey, liveSidHash, mintLiveToken, revokeLiveToken } from './tokens.js';
import { epgSummary } from './epg.js';
import { refreshRunning, refreshSource, refreshSourceEpg } from './refresh.js';
import { createGroup, deleteGroup, groupView, listGroups, mergeGroups, orderGroups, releaseGroups, unknownGroups, updateGroup } from './groups.js';
import { FeedError, createFeed, deleteFeed, feedCreate, ingestView, reassignPort, regenerateCredentials, syncIngest } from './ownfeeds.js';
import { SourceRefusal, SourceTestError, anyTestBody, createSource, deleteSource, isGuide, listSources, sourceCreate, sourcePatch, testGuide, testSource, updateSource } from './sources.js';

/** the line for an install without the updater (spec §4.3); the page shows it with the compose commands */
const ENV_LINE = 'COMPOSE_PROFILES=livetv';
/** spec §4.1: the state is cached 10 s */
const MEMO_MS = 10_000;
/** the source test's single flight per admin; longer than its slowest call (the EPG count, 120 s) */
const TEST_LOCK_TTL_S = 150;
/** the channel test's single flight per admin; longer than a bulk test of 20 channels at 15 s each */
const CHANNEL_TEST_LOCK_TTL_S = 360;
/** a bulk body of 20 000 ids is about 780 KB (the app's default limit is 256 KB) */
const BULK_BODY_LIMIT = 1024 * 1024;
/** after a livetv job ended, detection is asked fresh for this long (1b review I4: the page settles on what the job did) */
const FRESH_AFTER_JOB_MS = 30_000;

/** a livetv job of the updater that finished less than FRESH_AFTER_JOB_MS ago: the cached detection may predate its stop / start */
function justFinished(job: { action: string; state: string; finishedAt: string | null } | null | undefined, now = Date.now()): boolean {
  if (!job || !job.action.startsWith('livetv-') || job.state === 'running' || !job.finishedAt) return false;
  const at = Date.parse(job.finishedAt);
  return Number.isFinite(at) && now - at < FRESH_AFTER_JOB_MS;
}

const disableBody = z.object({ removeImage: z.boolean(), removeCache: z.boolean() });
const startLiveBody = z.object({ startLive: z.boolean() }).strict();

// ---- channel groups (spec §9.3) ----
const id = z.guid();
const roleKeys = z.array(z.string().min(1).max(64)).max(50);
const groupName = z.string().trim().min(1).max(40);
const groupCreate = z.object({ name: groupName, kidFriendly: z.boolean().default(false), roles: roleKeys.default([]), released: z.boolean().default(true) }).strict();
const groupPatch = z.object({ name: groupName, kidFriendly: z.boolean(), roles: roleKeys, released: z.boolean() }).partial().strict();
const releaseBody = z.object({ ids: z.array(id).min(1).max(500), roles: roleKeys, kidFriendly: z.boolean() }).strict();
const orderBody = z.object({ ids: z.array(id).max(5000) }).strict();
const mergeBody = z.object({ ids: z.array(id).min(1).max(500), into: id }).strict();

type Reply = { code(n: number): { send(b: unknown): unknown } };
/** Zod safeParse with the fixed refusal `{ error: 'invalid', field }` (the input is never echoed) */
function parse<T>(schema: z.ZodType<T>, body: unknown, reply: Reply): T | undefined {
  const p = schema.safeParse(body ?? {});
  if (p.success) return p.data;
  reply.code(400).send({ error: 'invalid', field: String(p.error.issues[0]?.path[0] ?? 'body') });
  return undefined;
}

/**
 * Admin -> Live-TV, the enable card and the off dialog (spec §4.2-§4.5): the state the page polls (detection, the updater's livetv
 * facts, GPU advice) and enable / disable through the updater. Without a usable own-stack updater the answer is a fixed 409 code with
 * the env line, and the page shows the manual steps. Writes are admin only, 3 per 2 minutes for the whole portal, audited with
 * field names only.
 */
export function livetvAdminRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };
  // hook preHandler: the limiter runs after requireAdmin, so nobody but an admin can use up the portal-wide budget
  const limited = { ...admin, config: { rateLimit: { max: 3, timeWindow: '2 minutes', keyGenerator: () => 'livetv', hook: 'preHandler' as const } } };

  /** Jellyfin's hardware acceleration, read at most every 10 s (the page polls every 3 s while a job runs, the status tab every 5 s) */
  let hwMemo: { at: number; v: string | null } | undefined;
  async function jellyfinHwAccel(): Promise<string | null> {
    if (hwMemo && Date.now() - hwMemo.at < MEMO_MS) return hwMemo.v;
    const v = await readHwAccel(ctx);
    hwMemo = { at: Date.now(), v };
    return v;
  }

  /** remembers what the admin asked for (LIVETV_WANTED); an env-locked or failing store must not stop the action itself */
  async function want(value: boolean, actor: string, log: { warn(o: object, m: string): void }): Promise<void> {
    try { await ctx.settings.save({ LIVETV_WANTED: value ? 'true' : 'false' }, actor); } catch { log.warn({ key: 'LIVETV_WANTED' }, 'livetv wanted flag not stored'); }
  }

  app.get('/api/admin/livetv/state', admin, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const view = await updaterView(ctx);
    const job = view.present && 'status' in view ? view.status.job : null;
    // a job that just ended changed the container on purpose: no grace for a missed check (bughunt M1)
    const det = await detectLivetv(ctx, justFinished(job) ? 0 : MEMO_MS, { strict: justFinished(job) });
    // the media server is asked only when there is something to compare it with
    const jellyfin = det.installed ? await jellyfinHwAccel() : null;
    const status = view.present && 'status' in view ? view.status : null;
    const sys = det.installed ? await livetvSystem(ctx) : null;
    return {
      installed: det.installed, reachable: det.reachable, version: det.version,
      wanted: ctx.cfg.LIVETV_WANTED === 'true', offerHidden: ctx.cfg.LIVETV_OFFER_HIDDEN === 'true',
      updater: {
        available: status !== null, stack: status?.stack ?? null, job: status?.job ?? null,
        // an updater that answers but refuses our signature or answers garbage: the page says so instead of the .env steps
        error: view.present && 'error' in view ? view.error : null,
        // state: absent | disabled | enabled | stop_failed; error: why an update turned it off on its own (null = none); null = an updater from before livetv
        livetv: status?.livetv ? { state: status.livetv.state, container: status.livetv.container, error: status.livetv.error } : null,
      },
      envLine: ENV_LINE,
      // the measurement launched when livetv first appeared after enabling: started (= launched; its result shows on the conversions
      // card), or why it was refused (the admin can press Neu messen)
      benchmark: enableBenchmark(ctx),
      gpu: {
        jellyfin,
        livetv: sys ? { driver: sys.gpu.driver, devices: sys.gpu.devices.length } : null,
        advice: sys && jellyfin !== null ? gpuAdvice(jellyfin, sys) : null,
      },
    };
  });

  /**
   * the updater job for `op`, or the fixed refusal (and the env line where the admin has to do it by hand). LIVETV_WANTED changes only
   * when the updater accepted the job: a refusal leaves it as it was (`wanted` in the answer says what it is now) and is audited as such.
   */
  async function run(op: LivetvOp, actor: string, reply: { code(n: number): { send(b: unknown): unknown } }, log: { warn(o: object, m: string): void }, action: string, meta: Record<string, unknown>) {
    const refuse = async (status: number, error: string, extra: Record<string, unknown> = {}) => {
      await audit(ctx, actor, action, undefined, { ...meta, outcome: error });
      return reply.code(status).send({ error, ...extra, wanted: ctx.cfg.LIVETV_WANTED === 'true' });
    };
    // one signed status read per request (1b review M14): startLivetvJob gets this view
    const view = await updaterView(ctx);
    if (!view.present) return refuse(409, 'no_updater', { envLine: ENV_LINE });
    // there, but it refuses the signature (an updater with another INTERNAL_SECRET or from before a key change) or answers garbage
    if (!('status' in view)) return refuse(502, view.error === 'unauthorized' ? 'unauthorized' : 'updater_error');
    const r = await startLivetvJob(ctx, op, actor, view);
    if (r.ok && 'job' in r) {
      // from now on the name `livetv` may stop resolving to livetv: no signed call on the strength of an earlier proof
      if (op.op !== 'enable') dropLivetvProof(ctx);
      await want(op.op === 'enable', actor, log);
      await audit(ctx, actor, action, undefined, { ...meta, outcome: 'started' });
      // what is stored now, read back: an env-locked or failing store keeps the old value, and the answer must not claim otherwise
      return reply.code(202).send({ job: r.job, wanted: ctx.cfg.LIVETV_WANTED === 'true' });
    }
    if (r.ok) return refuse(409, 'foreign_stack', { envLine: ENV_LINE }); // a Portainer redeploy is not an enable
    log.warn({ op: op.op, error: r.error }, 'livetv job refused');
    if (r.error === 'foreign_stack') return refuse(409, 'foreign_stack', { envLine: ENV_LINE });
    if (r.error === 'not_available') return refuse(409, 'no_updater', { envLine: ENV_LINE });
    return refuse(r.status, r.error);
  }

  app.post('/api/admin/livetv/enable', limited, async (req, reply) => {
    const actor = req.user!.id;
    return run({ op: 'enable' }, actor, reply, req.log, 'livetv.enable', {});
  });

  app.post('/api/admin/livetv/disable', limited, async (req, reply) => {
    const p = disableBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid', field: String(p.error.issues[0]?.path[0] ?? 'body') });
    const { removeImage, removeCache } = p.data;
    // the cache volume goes with the image only (the updater's one data-deleting op is `remove`)
    if (removeCache && !removeImage) return reply.code(400).send({ error: 'invalid', field: 'removeCache' });
    const actor = req.user!.id;
    return run(removeImage ? { op: 'remove', data: removeCache } : { op: 'disable' }, actor, reply, req.log, 'livetv.disable', { removeImage, removeCache });
  });

  // ---- Gruppen & Rechte (spec §8, §9.3): every write drops the cached channel sets (groups.ts) and is audited livetv.group.* ----

  /**
   * the role keys, deduplicated, or a 400 when one is not a role. livetv_group_roles references the roles table, so a role known only
   * from ROLE_TEMPLATES without a stored row cannot be granted either (the same 400, not a foreign-key 500).
   */
  async function knownRoles(roles: readonly string[], reply: Reply): Promise<string[] | undefined> {
    const keys = [...new Set(roles)];
    const stored = new Set((await ctx.db.query<{ key: string }>('select key from roles where key = any($1::text[])', [keys])).rows.map((r) => r.key));
    for (const k of keys) {
      if (!stored.has(k) || !(await roleExists(ctx, k))) { reply.code(400).send({ error: 'invalid', field: 'roles' }); return undefined; }
    }
    return keys;
  }
  /** the `:id` path parameter as a uuid (groups, sources, channels); undefined when it is none */
  const paramId = (req: { params: unknown }) => id.safeParse((req.params as { id?: string }).id).data;

  app.get('/api/admin/livetv/groups', admin, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return listGroups(ctx);
  });

  // a group the admin creates starts released unless the body says otherwise (spec §8)
  app.post('/api/admin/livetv/groups', admin, async (req, reply) => {
    const b = parse(groupCreate, req.body, reply);
    if (!b) return reply;
    const roles = await knownRoles(b.roles, reply);
    if (!roles) return reply;
    return reply.code(201).send(await createGroup(ctx, req.user!.id, { ...b, roles }));
  });

  // { released: true } with roles in one call: POST /groups/release; static routes win over /:id
  app.post('/api/admin/livetv/groups/release', admin, async (req, reply) => {
    const b = parse(releaseBody, req.body, reply);
    if (!b) return reply;
    const roles = await knownRoles(b.roles, reply);
    if (!roles) return reply;
    return { released: await releaseGroups(ctx, req.user!.id, b.ids, roles, b.kidFriendly) };
  });

  app.put('/api/admin/livetv/groups/order', admin, async (req, reply) => {
    const b = parse(orderBody, req.body, reply);
    if (!b) return reply;
    await orderGroups(ctx, req.user!.id, b.ids);
    return { ok: true };
  });

  app.post('/api/admin/livetv/groups/merge', admin, async (req, reply) => {
    const b = parse(mergeBody, req.body, reply);
    if (!b) return reply;
    // `into` among `ids` is dropped; with nothing else left the merge would change nothing: refused, not audited
    const ids = b.ids.filter((g) => g !== b.into);
    if (!ids.length) return reply.code(400).send({ error: 'invalid', field: 'ids' });
    if ((await unknownGroups(ctx, ids)).length) return reply.code(400).send({ error: 'invalid', field: 'ids' });
    const g = await mergeGroups(ctx, req.user!.id, ids, b.into);
    return g ?? reply.code(404).send({ error: 'not_found' });
  });

  // partial; { released: false } = Freigabe zurücknehmen (roles kept)
  app.patch('/api/admin/livetv/groups/:id', admin, async (req, reply) => {
    const gid = paramId(req);
    if (!gid) return reply.code(404).send({ error: 'not_found' });
    const b = parse(groupPatch, req.body, reply);
    if (!b) return reply;
    const roles = b.roles === undefined ? undefined : await knownRoles(b.roles, reply);
    if (b.roles !== undefined && !roles) return reply;
    const g = await updateGroup(ctx, req.user!.id, gid, { ...b, ...(roles ? { roles } : {}) });
    return g ?? reply.code(404).send({ error: 'not_found' });
  });

  app.get('/api/admin/livetv/groups/:id', admin, async (req, reply) => {
    const gid = paramId(req);
    const g = gid ? await groupView(ctx, gid) : null;
    return g ?? reply.code(404).send({ error: 'not_found' });
  });

  app.delete('/api/admin/livetv/groups/:id', admin, async (req, reply) => {
    const gid = paramId(req);
    if (!gid || !(await deleteGroup(ctx, req.user!.id, gid))) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ---- Quellen (spec §9.1): provider URLs are secrets (F13). Bodies carrying them are never logged with an error (app.ts
  // SENSITIVE_BODY), refusals are fixed codes with the field name, answers carry only the masked hints. ----

  /** a refusal that is not a schema failure keeps its own code: `lan_required`, `refused` (Global Constraint *Errors*) */
  const refused = (e: unknown, reply: Reply) => {
    if (e instanceof SourceRefusal) return reply.code(400).send({ error: e.code, field: e.field });
    throw e;
  };

  app.get('/api/admin/livetv/sources', admin, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return listSources(ctx);
  });

  app.post('/api/admin/livetv/sources', admin, async (req, reply) => {
    const b = parse(sourceCreate, req.body, reply);
    if (!b) return reply;
    try {
      return reply.code(201).send(await createSource(ctx, req.user!.id, b));
    } catch (e) { return refused(e, reply); }
  });

  // Prüfen: asks livetv, never the provider (spec §3.4); a static route, so it wins over /:id. One test per admin at a time (each can
  // hold a provider download in livetv for up to two minutes): a second one while it runs answers 409 test_running. A body with
  // `kind: 'guide'` tests a guide link (`{ epgChannels, samples }`).
  app.post('/api/admin/livetv/sources/test', admin, async (req, reply) => {
    const b = parse(anyTestBody, req.body, reply);
    if (!b) return reply;
    reply.header('cache-control', 'no-store');
    const lock = `ltv:srctest:${req.user!.id}`;
    const token = randomUUID();
    if (!(await ctx.kv.setnx(lock, token, TEST_LOCK_TTL_S))) return reply.code(409).send({ error: 'test_running' });
    try {
      if (b.kind === 'guide') return await testGuide(ctx, b);
      const { kind: _kind, ...list } = b;
      return await testSource(ctx, list);
    } catch (e) {
      if (e instanceof SourceTestError) {
        if (e.status === 404) return reply.code(404).send({ error: 'not_found' });
        // livetv itself was not reached: not the provider's fault, so not the 422 of a provider failure
        if (e.status === null) return reply.code(503).send({ error: 'livetv_unreachable' });
        return reply.code(422).send({ error: e.code });
      }
      return refused(e, reply);
    } finally {
      await ctx.kv.delIfEquals(lock, token).catch(() => undefined); // a lost delete only blocks this admin until the ttl ends
    }
  });

  app.patch('/api/admin/livetv/sources/:id', admin, async (req, reply) => {
    const sid = paramId(req);
    if (!sid) return reply.code(404).send({ error: 'not_found' });
    const b = parse(sourcePatch, req.body, reply);
    if (!b) return reply;
    try {
      const s = await updateSource(ctx, req.user!.id, sid, b);
      // switching a source on or off adds or withdraws its push feeds in livetv (Task 20)
      if (s && b.enabled !== undefined && (await ctx.db.query("select 1 from livetv_channels where source_id = $1 and ingest = 'push' limit 1", [sid])).rowCount) {
        await syncIngest(ctx, req.log);
      }
      return s ?? reply.code(404).send({ error: 'not_found' });
    } catch (e) { return refused(e, reply); }
  });

  /**
   * *Aktualisieren*: starts the refresh and answers 202 `{ started: true }` at once; the page polls `GET /sources` for `state`
   * (lastRefreshAt, lastError, counts). A refresh already running for the source is not started again (`{ started: false }`; the single
   * flight in refresh.ts also covers the race). A disabled guide answers 409 `disabled`. The own-feeds source has no list (409 `no_list`); while livetv is not installed nothing
   * could be fetched (409 `livetv_off`, nothing recorded on the source).
   */
  app.post('/api/admin/livetv/sources/:id/refresh', admin, async (req, reply) => {
    const sid = paramId(req);
    const s = sid ? (await ctx.db.query<{ kind: string; enabled: boolean }>('select kind, enabled from livetv_sources where id = $1', [sid])).rows[0] : undefined;
    if (!sid || !s) return reply.code(404).send({ error: 'not_found' });
    if (isOwnFeeds(s.kind)) return reply.code(409).send({ error: 'no_list' });
    if (!livetvInstalled(ctx)) return reply.code(409).send({ error: 'livetv_off' });
    if (isGuide(s.kind) && !s.enabled) return reply.code(409).send({ error: 'disabled' }); // a disabled guide is not refreshed
    if (await refreshRunning(ctx, sid)) return reply.code(202).send({ started: false });
    await audit(ctx, req.user!.id, 'livetv.source.refresh', sid, { fields: [] });
    const log = req.log;
    // failures are recorded on the source (fixed code, event, notice); only an unexpected error is logged, by its name only
    void refreshSource(ctx, sid, 'admin').catch((e: unknown) => { log.warn({ sourceId: sid, error: e instanceof Error ? e.name : 'unknown' }, 'livetv source refresh failed'); });
    return reply.code(202).send({ started: true });
  });

  // the Phase 1 guide counts (spec §9.4): "398 von 412 Sendern mit Programm · 14 ohne"
  app.get('/api/admin/livetv/epg/summary', admin, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return epgSummary(ctx);
  });

  app.delete('/api/admin/livetv/sources/:id', admin, async (req, reply) => {
    const sid = paramId(req);
    const r = sid ? await deleteSource(ctx, req.user!.id, sid) : null;
    if (!r) return reply.code(404).send({ error: 'not_found' });
    // push feeds went with it (counted in the delete's transaction): livetv must stop accepting their credentials (Task 20)
    if (r.push) await syncIngest(ctx, req.log);
    return { channels: r.channels };
  });

  // ---- Eigene Streams (spec §3.5, §9.1): pull URLs and push credentials are secrets (F13). Bodies are never logged with an error
  // (app.ts SENSITIVE_BODY), the push credentials are answered once (no-store) and never again: later answers carry port and hint. ----

  const feedRefused = (e: unknown, reply: Reply) => {
    if (e instanceof FeedError) return reply.code(e.status).send(e.body);
    throw e;
  };

  app.post('/api/admin/livetv/channels', admin, async (req, reply) => {
    const b = parse(feedCreate, req.body, reply);
    if (!b) return reply;
    reply.header('cache-control', 'no-store');
    try {
      return reply.code(201).send(await createFeed(ctx, req.user!.id, b, req.log));
    } catch (e) { return feedRefused(e, reply); }
  });

  // the Eigene Streams card: host, port range and the state of each push feed (never a credential)
  app.get('/api/admin/livetv/ingest', admin, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return ingestView(ctx);
  });


  // Zugangsdaten neu erzeugen: the same one-time answer with new values
  app.post('/api/admin/livetv/channels/:id/push-credentials', admin, async (req, reply) => {
    const cid = paramId(req);
    if (!cid) return reply.code(404).send({ error: 'not_found' });
    reply.header('cache-control', 'no-store');
    try {
      return await regenerateCredentials(ctx, req.user!.id, cid, req.log);
    } catch (e) { return feedRefused(e, reply); }
  });

  // Neuen Port zuweisen (spec §19): a port that left LIVETV_SRT_PORTS; the credentials stay
  app.post('/api/admin/livetv/channels/:id/push-port', admin, async (req, reply) => {
    const cid = paramId(req);
    if (!cid) return reply.code(404).send({ error: 'not_found' });
    try {
      return await reassignPort(ctx, req.user!.id, cid, req.log);
    } catch (e) { return feedRefused(e, reply); }
  });

  // own feeds only (a provider channel comes back with the next import; it is hidden instead)
  app.delete('/api/admin/livetv/channels/:id', admin, async (req, reply) => {
    const cid = paramId(req);
    if (!cid) return reply.code(404).send({ error: 'not_found' });
    try {
      return { ok: true, ...(await deleteFeed(ctx, req.user!.id, cid, req.log)) };
    } catch (e) { return feedRefused(e, reply); }
  });

  // ---- Kanäle (spec §9.2): stream URLs never leave the backend (F13); answers carry AdminChannel only, refusals fixed codes ----

  const channelRefused = (e: unknown, reply: Reply) => {
    if (e instanceof ChannelRefusal) return reply.code(e.status).send(e.body);
    throw e;
  };

  // accepted for Phase 1: the single flight is per admin, not per provider; a per-provider limit comes with Task 42
  /** one stream test per admin at a time (a probe may hold a provider connection for up to 10 s; a bulk test runs 20 of them) */
  async function testLocked<T>(actor: string, reply: FastifyReply, fn: (signal: AbortSignal) => Promise<T>): Promise<T | Reply> {
    const lock = `ltv:chtest:${actor}`;
    const token = randomUUID();
    if (!(await ctx.kv.setnx(lock, token, CHANNEL_TEST_LOCK_TTL_S))) {
      reply.code(409).send({ error: 'test_running' });
      return reply;
    }
    // a client that went away stops the tests still to run. The response's close (not the request's, which fires once the body is
    // read) marks a disconnect; after a sent answer writableFinished is true and nothing is aborted.
    const ac = new AbortController();
    const gone = () => { if (!reply.raw.writableFinished) ac.abort(); };
    reply.raw.once('close', gone);
    try {
      return await fn(ac.signal);
    } finally {
      reply.raw.off('close', gone);
      await ctx.kv.delIfEquals(lock, token).catch(() => undefined);
    }
  }

  app.get('/api/admin/livetv/channels', admin, async (req, reply) => {
    const q = parse(channelQuery, req.query, reply);
    if (!q) return reply;
    reply.header('cache-control', 'no-store');
    return listChannels(ctx, q);
  });

  // one row of the list (the own-feeds card reads it after a push change); never more than a list row carries
  app.get('/api/admin/livetv/channels/:id', admin, async (req, reply) => {
    const cid = paramId(req);
    const c = cid ? await adminChannel(ctx, cid) : null;
    reply.header('cache-control', 'no-store');
    return c ?? reply.code(404).send({ error: 'not_found' });
  });

  // static routes (bulk, order) win over /:id
  app.post('/api/admin/livetv/channels/bulk', { ...admin, bodyLimit: BULK_BODY_LIMIT }, async (req, reply) => {
    const b = parse(bulkBody, req.body, reply);
    if (!b) return reply;
    reply.header('cache-control', 'no-store');
    try {
      if (b.action === 'test') {
        if (new Set(b.ids).size > MAX_BULK_TEST) return reply.code(400).send({ error: 'invalid', field: 'ids' });
        return await testLocked(req.user!.id, reply, (signal) => bulkTest(ctx, req.user!.id, b.ids, signal));
      }
      return await bulkChannels(ctx, req.user!.id, b, req.log);
    } catch (e) { return channelRefused(e, reply); }
  });

  app.put('/api/admin/livetv/channels/order', admin, async (req, reply) => {
    const b = parse(channelOrderBody, req.body, reply);
    if (!b) return reply;
    reply.header('cache-control', 'no-store');
    try {
      return await orderChannels(ctx, req.user!.id, b.ids);
    } catch (e) { return channelRefused(e, reply); }
  });

  app.patch('/api/admin/livetv/channels/:id', admin, async (req, reply) => {
    const cid = paramId(req);
    if (!cid) return reply.code(404).send({ error: 'not_found' });
    const b = parse(channelPatch, req.body, reply);
    if (!b) return reply;
    reply.header('cache-control', 'no-store');
    try {
      return (await patchChannel(ctx, req.user!.id, cid, b, req.log)) ?? reply.code(404).send({ error: 'not_found' });
    } catch (e) { return channelRefused(e, reply); }
  });

  // admin only; checks the channel and its source, never the viewing rights or the group's release (F10)
  /**
   * The preview of a stream test (Task 42, F10): the channel can start, so it starts (or joins) like a watch and the admin gets a test
   * token of their own device. Only the channel and its source were checked (testChannel); the viewing rights and the group's release
   * are not asked, and the test token lets the live authz skip them too. A refusal (budget, provider limit, unreachable, no device) is
   * no error here: the answer then carries the facts only.
   */
  async function testPreview(req: FastifyRequest, id: string): Promise<{ url: string; token: string } | null> {
    const deviceId = req.session!.deviceId;
    if (!deviceId || !req.profile) return null;
    try {
      const row = (await ctx.db.query<EffectiveRow>(`${CHANNEL_SELECT} where c.id = $1`, [id])).rows[0];
      if (!row) return null;
      const ch = toEffective(row); // after the test: it carries the fresh probe, so the expected mode is the tested one
      const who = { userId: req.user!.id, deviceId, role: req.user!.role };
      await ctx.kv.del(adminStopKey(ch.id)); // *Neu starten* (stop, then this test start): the admin's own start lifts the stop marker
      const r = await startOrJoin(ctx, who, ch, { id: req.profile.id, kids: Boolean(req.profile.kids) });
      if ('status' in r) return null;
      const minted = await mintLiveToken(ctx, {
        userId: who.userId, profileId: req.profile.id, deviceId, sidHash: liveSidHash(req.sid!), channelId: ch.id, channelName: ch.name,
        kind: 'live', via: 'local', remote: !isHomeRequest(req, ctx.cfg.HOME_NETWORKS), test: true,
      });
      await clearJoinMark(ctx, ch.id, { userId: who.userId, deviceId });
      // the watch route's check: a profile switch that raced the mint revoked the device's tokens before this one existed (no rights check, F10)
      const after = await loadSession(ctx, req.sid);
      if (!after || (after.profileId && after.profileId !== req.profile.id)) {
        await revokeLiveToken(ctx, minted.hash);
        return null;
      }
      return { url: `/media/l/${minted.token}/index.m3u8`, token: minted.token };
    } catch (e) {
      req.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'livetv test preview not started'); // never the token, never a URL
      return null;
    }
  }

  app.post('/api/admin/livetv/channels/:id/test', admin, async (req, reply) => {
    const cid = paramId(req);
    if (!cid) return reply.code(404).send({ error: 'not_found' });
    reply.header('cache-control', 'no-store');
    try {
      return await testLocked(req.user!.id, reply, async (signal) => {
        const facts = await testChannel(ctx, req.user!.id, cid, signal);
        if (!facts.ok || signal.aborted) return facts;
        const preview = await testPreview(req, cid);
        return preview ? { ...facts, preview } : facts;
      });
    } catch (e) { return channelRefused(e, reply); }
  });

  /**
   * *Programm zuordnen…* (spec §10's Phase 2 route, brought forward by the extra guides): `{ sourceId, xmlId }` pins the channel by hand,
   * `{ none: true }` = no programme, `null` = automatic again. A mapping to an XMLTV channel its guide has no programmes of yet (the
   * guide's import filter did not hold it) imports that guide's EPG in the background at once (its single flight), instead of at its
   * next refresh.
   */
  app.put('/api/admin/livetv/channels/:id/epg', admin, async (req, reply) => {
    const cid = paramId(req);
    if (!cid) return reply.code(404).send({ error: 'not_found' });
    const b = readEpgPin(req.body === undefined ? {} : req.body);
    if (!b.ok) return reply.code(400).send({ error: 'invalid', field: b.field });
    reply.header('cache-control', 'no-store');
    try {
      const c = await setEpgPin(ctx, req.user!.id, cid, b.value);
      if (!c) return reply.code(404).send({ error: 'not_found' });
      const due = livetvInstalled(ctx) ? await importDueFor(ctx, cid) : null;
      if (due) {
        const log = req.log;
        void refreshSourceEpg(ctx, due).catch((e: unknown) => { log.warn({ sourceId: due, error: e instanceof Error ? e.name : 'unknown' }, 'livetv pin import failed'); });
      }
      return c;
    } catch (e) { return channelRefused(e, reply); }
  });

  // the picker's search over one guide's XMLTV channels (at most 50, by name)
  app.get('/api/admin/livetv/epg/channels', admin, async (req, reply) => {
    const q = parse(epgSearchQuery, req.query, reply);
    if (!q) return reply;
    reply.header('cache-control', 'no-store');
    try {
      return await searchEpgChannels(ctx, q);
    } catch (e) { return channelRefused(e, reply); }
  });

  app.delete('/api/admin/livetv/channels/:id/logo', admin, async (req, reply) => {
    const cid = paramId(req);
    const c = cid ? await dropLogo(ctx, req.user!.id, cid) : null;
    reply.header('cache-control', 'no-store');
    return c ?? reply.code(404).send({ error: 'not_found' });
  });

  // the upload is a raw image body (ruling 32: no multipart plugin), parsed only in this context; anything else is 415, more than
  // 512 KB is 413, both with fixed codes instead of the framework's messages
  void app.register(async (sub) => {
    sub.addContentTypeParser([...LOGO_MIMES], { parseAs: 'buffer', bodyLimit: LOGO_MAX_BYTES }, (_req, body, done) => done(null, body));
    sub.setErrorHandler((err, _req, reply) => {
      const code = (err as { code?: string }).code;
      if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'too_large' });
      if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ error: 'unsupported_type' });
      throw err;
    });
    // the admin check runs before the body is read (onRequest): nobody else gets 512 KB parsed; the CSRF hook still runs (preHandler)
    sub.put('/api/admin/livetv/channels/:id/logo', { onRequest: requireAdmin(ctx), bodyLimit: LOGO_MAX_BYTES }, async (req, reply) => {
      const cid = paramId(req);
      if (!cid) return reply.code(404).send({ error: 'not_found' });
      const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      reply.header('cache-control', 'no-store');
      if (!Buffer.isBuffer(req.body) || !(LOGO_MIMES as readonly string[]).includes(type)) return reply.code(415).send({ error: 'unsupported_type' });
      try {
        return (await setLogo(ctx, req.user!.id, cid, type, req.body)) ?? reply.code(404).send({ error: 'not_found' });
      } catch (e) { return channelRefused(e, reply); }
    });
  });

  // ---- Live-Status (spec §9.5): one answer for the tab; never a URL, a stream key or a stream id ----

  app.get('/api/admin/livetv/status', admin, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return liveStatus(ctx, jellyfinHwAccel);
  });

  // *Stoppen* (the web then stops the viewers and refuses a restart for 60 s; *Neu starten* is this stop plus the channel test start); audited with the channel id only
  app.post('/api/admin/livetv/streams/:channelId/stop', admin, async (req, reply) => {
    const cid = id.safeParse((req.params as { channelId?: string }).channelId).data;
    if (!cid) return reply.code(404).send({ error: 'not_found' });
    try {
      await stopStream(ctx, cid, req.log);
    } catch (e) {
      if (e instanceof LivetvError) return reply.code(503).send({ error: 'livetv_unreachable' });
      throw e;
    }
    await audit(ctx, req.user!.id, 'livetv.stream.stop', cid, { fields: [] });
    return { ok: true };
  });

  // ---- TV startet mit Live-TV (spec §11.3, ruling 14): the switch of a paired TV in Admin -> Geräte ----

  /**
   * `PATCH /api/admin/devices/:userId/:deviceId { startLive }`: TVs only (device ids of paired TVs start with `tv-`), else 400 `not_tv`;
   * a device that does not exist is a 404. Audited as `device.start_live` with the person as target and the new value, never the device id.
   */
  app.patch('/api/admin/devices/:userId/:deviceId', admin, async (req, reply) => {
    const p = req.params as { userId?: string; deviceId?: string };
    const b = parse(startLiveBody, req.body, reply);
    if (!b) return;
    const userId = id.safeParse(p.userId).data;
    const deviceId = z.string().min(3).max(80).safeParse(p.deviceId).data;
    if (!userId || !deviceId) return reply.code(404).send({ error: 'not_found' });
    if (!deviceId.startsWith('tv-')) return reply.code(400).send({ error: 'not_tv' });
    const r = await ctx.db.query('update devices set start_live = $3 where user_id = $1 and device_id = $2', [userId, deviceId, b.startLive]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(ctx, req.user!.id, 'device.start_live', userId, { startLive: b.startLive });
    return { ok: true };
  });
}
