// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { roleExists } from '../rolecat.js';
import { requireAdmin } from '../session.js';
import { startLivetvJob, updaterView, type LivetvOp } from '../updater.js';
import { detectLivetv, enableBenchmark, livetvSystem } from './detect.js';
import { gpuAdvice } from './gpu.js';
import { isOwnFeeds } from './channels.js';
import { refreshSource } from './refresh.js';
import { createGroup, deleteGroup, groupView, listGroups, mergeGroups, orderGroups, releaseGroups, unknownGroups, updateGroup } from './groups.js';
import { SourceRefusal, SourceTestError, createSource, deleteSource, listSources, sourceCreate, sourcePatch, sourceTestBody, testSource, updateSource } from './sources.js';

/** the line for an install without the updater (spec §4.3); the page shows it with the compose commands */
const ENV_LINE = 'COMPOSE_PROFILES=livetv';
const JF_TIMEOUT_MS = 3_000;
/** spec §4.1: the state is cached 10 s */
const MEMO_MS = 10_000;
/** the source test's single flight per admin; longer than its slowest call (the EPG count, 120 s) */
const TEST_LOCK_TTL_S = 150;

const disableBody = z.object({ removeImage: z.boolean(), removeCache: z.boolean() });

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

  /** Jellyfin's hardware acceleration, read at most every 10 s (the page polls every 3 s while a job runs) */
  let hwMemo: { at: number; v: string | null } | undefined;
  async function jellyfinHwAccel(): Promise<string | null> {
    if (hwMemo && Date.now() - hwMemo.at < MEMO_MS) return hwMemo.v;
    const v = await readHwAccel();
    hwMemo = { at: Date.now(), v };
    return v;
  }
  /** ('none' when off); null = unknown (Plex, unreachable, slow) */
  async function readHwAccel(): Promise<string | null> {
    const read = ctx.jf.admin.encoderSettings?.bind(ctx.jf.admin);
    if (!read) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const e = await Promise.race([read(), new Promise<null>((res) => { timer = setTimeout(() => res(null), JF_TIMEOUT_MS); timer.unref?.(); })]);
      return e?.hwAccel ?? null;
    } catch { return null; } finally { clearTimeout(timer); }
  }

  /** remembers what the admin asked for (LIVETV_WANTED); an env-locked or failing store must not stop the action itself */
  async function want(value: boolean, actor: string, log: { warn(o: object, m: string): void }): Promise<void> {
    try { await ctx.settings.save({ LIVETV_WANTED: value ? 'true' : 'false' }, actor); } catch { log.warn({ key: 'LIVETV_WANTED' }, 'livetv wanted flag not stored'); }
  }

  app.get('/api/admin/livetv/state', admin, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const [det, view] = await Promise.all([detectLivetv(ctx, MEMO_MS), updaterView(ctx)]);
    // the media server is asked only when there is something to compare it with
    const jellyfin = det.installed ? await jellyfinHwAccel() : null;
    const status = view.present && 'status' in view ? view.status : null;
    const sys = det.installed ? await livetvSystem(ctx) : null;
    return {
      installed: det.installed, reachable: det.reachable, version: det.version,
      wanted: ctx.cfg.LIVETV_WANTED === 'true', offerHidden: ctx.cfg.LIVETV_OFFER_HIDDEN === 'true',
      updater: {
        available: status !== null, stack: status?.stack ?? null, job: status?.job ?? null,
        // state: absent | disabled | enabled | stop_failed; error: why an update turned it off on its own (null = none); null = an updater from before livetv
        livetv: status?.livetv ? { state: status.livetv.state, container: status.livetv.container, error: status.livetv.error } : null,
      },
      envLine: ENV_LINE,
      // the measurement started when livetv first appeared after enabling: started, or why it was refused (the admin can press Neu messen)
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
    const view = await updaterView(ctx);
    if (!view.present || !('status' in view)) return refuse(409, 'no_updater', { envLine: ENV_LINE });
    const r = await startLivetvJob(ctx, op, actor);
    if (r.ok && 'job' in r) {
      await want(op.op === 'enable', actor, log);
      await audit(ctx, actor, action, undefined, { ...meta, outcome: 'started' });
      return reply.code(202).send({ job: r.job, wanted: op.op === 'enable' });
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
  const groupId = (req: { params: unknown }) => id.safeParse((req.params as { id?: string }).id).data;

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
    const gid = groupId(req);
    if (!gid) return reply.code(404).send({ error: 'not_found' });
    const b = parse(groupPatch, req.body, reply);
    if (!b) return reply;
    const roles = b.roles === undefined ? undefined : await knownRoles(b.roles, reply);
    if (b.roles !== undefined && !roles) return reply;
    const g = await updateGroup(ctx, req.user!.id, gid, { ...b, ...(roles ? { roles } : {}) });
    return g ?? reply.code(404).send({ error: 'not_found' });
  });

  app.get('/api/admin/livetv/groups/:id', admin, async (req, reply) => {
    const gid = groupId(req);
    const g = gid ? await groupView(ctx, gid) : null;
    return g ?? reply.code(404).send({ error: 'not_found' });
  });

  app.delete('/api/admin/livetv/groups/:id', admin, async (req, reply) => {
    const gid = groupId(req);
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
  // hold a provider download in livetv for up to two minutes): a second one while it runs answers 409 test_running.
  app.post('/api/admin/livetv/sources/test', admin, async (req, reply) => {
    const b = parse(sourceTestBody, req.body, reply);
    if (!b) return reply;
    reply.header('cache-control', 'no-store');
    const lock = `ltv:srctest:${req.user!.id}`;
    const token = randomUUID();
    if (!(await ctx.kv.setnx(lock, token, TEST_LOCK_TTL_S))) return reply.code(409).send({ error: 'test_running' });
    try {
      return await testSource(ctx, b);
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
    const sid = groupId(req);
    if (!sid) return reply.code(404).send({ error: 'not_found' });
    const b = parse(sourcePatch, req.body, reply);
    if (!b) return reply;
    try {
      const s = await updateSource(ctx, req.user!.id, sid, b);
      return s ?? reply.code(404).send({ error: 'not_found' });
    } catch (e) { return refused(e, reply); }
  });

  /**
   * *Aktualisieren*: starts the refresh and answers 202 at once; the page polls `GET /sources` for `state` (lastRefreshAt, lastError,
   * counts). A refresh already running for the source is not started twice (single flight in refresh.ts). The own-feeds source has no
   * list (409 `no_list`).
   */
  app.post('/api/admin/livetv/sources/:id/refresh', admin, async (req, reply) => {
    const sid = groupId(req);
    const s = sid ? (await ctx.db.query<{ kind: string }>('select kind from livetv_sources where id = $1', [sid])).rows[0] : undefined;
    if (!sid || !s) return reply.code(404).send({ error: 'not_found' });
    if (isOwnFeeds(s.kind)) return reply.code(409).send({ error: 'no_list' });
    await audit(ctx, req.user!.id, 'livetv.source.refresh', sid, { fields: [] });
    const log = req.log;
    // failures are recorded on the source (fixed code, event, notice); only an unexpected error is logged, by its name only
    void refreshSource(ctx, sid, 'admin').catch((e: unknown) => { log.warn({ sourceId: sid, error: e instanceof Error ? e.name : 'unknown' }, 'livetv source refresh failed'); });
    return reply.code(202).send({ started: true });
  });

  app.delete('/api/admin/livetv/sources/:id', admin, async (req, reply) => {
    const sid = groupId(req);
    const r = sid ? await deleteSource(ctx, req.user!.id, sid) : null;
    return r ?? reply.code(404).send({ error: 'not_found' });
  });
}
