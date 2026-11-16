// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { dayKey, DAY_CLAIM_TTL_S } from './adminAlerts.js';
import type { Ctx } from './ctx.js';
import { m } from './i18n.js';
import { notifyAdmins } from './notify.js';
import { getSystemcheck } from './syscheck/engine.js';
import { CHECK_GROUPS, type CheckId } from './syscheck/types.js';

/**
 * The Systemcheck admin alert (mail stage C, see adminAlerts.ts). Its own module because it reads the Systemcheck engine, which reaches
 * health.ts and updater.ts; only server.ts imports it, so neither of those imports the engine back through the alerts.
 */
const SYSCHECK_TICK = 'alerts:syscheck:tick';
const SYSCHECK_TICK_TTL_S = 840;
const SYSCHECK_PREV = 'alerts:syscheck:prev';
const SYSCHECK_PREV_TTL_S = 86_400;

/** the downloads and previews disk lines: the storage alert (diskAlerts, *Speicherplatz*) tells them, the Systemcheck alert does not */
const STORAGE_LINES: ReadonlySet<string> = new Set<CheckId>(['core.disk.downloads', 'core.disk.previews']);

async function previousProblems(ctx: Pick<Ctx, 'kv'>): Promise<Set<string>> {
  try {
    const v = JSON.parse((await ctx.kv.get(SYSCHECK_PREV)) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * 15-minute timer, one instance per run. A server line *turns* problem when it is one now and was not in the previous run; each line
 * alerts at most once per server-local day (a flapping line), a problem that stays never repeats (a run in which its check did not
 * answer, `unknown`, keeps it), and all lines turning in one run make one notice naming their groups (an outage flips several at once).
 * The downloads and previews disk lines are left out: the storage alert owns them. Returns the lines alerted in this run.
 */
export async function syscheckAlertTick(ctx: Ctx, now: Date = new Date()): Promise<CheckId[]> {
  if (!(await ctx.kv.setnx(SYSCHECK_TICK, '1', SYSCHECK_TICK_TTL_S))) return [];
  const claimed: string[] = [];
  try {
    const result = await getSystemcheck(ctx);
    const server = result.lines.filter((l) => l.runs === 'server' && !STORAGE_LINES.has(l.id));
    const problems = server.filter((l) => l.status === 'problem');
    const prev = await previousProblems(ctx);
    const kept = server.filter((l) => l.status === 'unknown' && prev.has(l.id));
    const day = dayKey(now);
    const turned: typeof problems = [];
    for (const l of problems) {
      if (prev.has(l.id)) continue;
      const claim = `alerts:syscheck:${l.id}:${day}`;
      if (!(await ctx.kv.setnx(claim, '1', DAY_CLAIM_TTL_S))) continue;
      claimed.push(claim);
      turned.push(l);
    }
    if (turned.length) {
      const groups = CHECK_GROUPS.filter((g) => turned.some((l) => l.group === g));
      const ids = turned.map((l) => l.id).sort();
      await notifyAdmins(ctx, {
        kind: 'syscheck_problem', title: m('notify.syscheck.problem.title', { n: turned.length }),
        body: m('notify.syscheck.problem.body', { groups: { join: groups.map((g) => m(`syscheck.group.${g}`)), sep: ', ' } }),
        link: '/admin/status', dedupe: `syscheck-${day}-${ids.join(',')}`, mail: 'syscheck',
      });
    }
    await ctx.kv.set(SYSCHECK_PREV, JSON.stringify([...problems, ...kept].map((l) => l.id)), SYSCHECK_PREV_TTL_S);
    return turned.map((l) => l.id);
  } catch (e) {
    await Promise.all([SYSCHECK_TICK, ...claimed].map((k) => ctx.kv.del(k).catch(() => undefined)));
    throw e;
  }
}
