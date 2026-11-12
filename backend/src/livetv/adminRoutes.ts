// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../ctx.js';
import { requireAdmin } from '../session.js';
import { startLivetvJob, updaterView, type LivetvOp } from '../updater.js';
import { detectLivetv, enableBenchmark, livetvSystem } from './detect.js';
import { gpuAdvice } from './gpu.js';

/** the line for an install without the updater (spec §4.3); the page shows it with the compose commands */
const ENV_LINE = 'COMPOSE_PROFILES=livetv';
const JF_TIMEOUT_MS = 3_000;
/** spec §4.1: the state is cached 10 s */
const MEMO_MS = 10_000;

const disableBody = z.object({ removeImage: z.boolean(), removeCache: z.boolean() });

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
}
